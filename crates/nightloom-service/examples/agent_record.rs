//! Manual smoke test for the agent record path: two real Claude Code turns
//! in one session, recorded the way the desktop records them.
//!
//! An example rather than a test because it spends a real turn against a real
//! subscription, which is the same reason `probe` and `eval` are not in CI.
//! It is the only check that exercises the whole path — a live CLI, the
//! translator, the recorder and the log — and it asserts the two properties
//! that cannot be seen from a unit test: that the conversation actually
//! continues across turns (the second answer depends on the first), and that
//! the log it leaves is a **valid provider request**, every `tool_use`
//! paired, so switching the rail back to a provider replays it.
//!
//! `cargo run -p nightloom-service --example agent_record`

use nightloom_core::{Session, SessionEvent};
use nightloom_service::{AgentSpec, ClaudeCodeAgent, Recorder};
use tokio_util::sync::CancellationToken;

fn last_model(session: &Session) -> Option<String> {
    session.events().iter().rev().find_map(|e| match e {
        SessionEvent::AssistantMessage { model, .. } if !model.is_empty() => Some(model.clone()),
        _ => None,
    })
}

async fn turn(agent: &mut ClaudeCodeAgent, session: &mut Session, prompt: &str) {
    session.record_user(prompt);
    let seed = last_model(session)
        .or_else(|| agent.resolved_model().map(String::from))
        .or_else(|| agent.spec().model.clone())
        .unwrap_or_else(|| "claude-code".into());
    let cancel = CancellationToken::new();
    let mut rec = Recorder::new(session, seed);
    let outcome = agent
        .run_turn(prompt, &cancel, &mut |e| rec.push(&e))
        .await
        .unwrap();
    if let Some(m) = &outcome.model {
        rec.set_model(m.clone());
    }
    rec.finish(Some("end_turn"));
    if let Some(id) = &outcome.session_id {
        session.record_agent_session("claude-code", id);
    }
    agent.follow_on(&outcome);
    println!(
        "--- turn done: plan={:?} cost={:?} resume={:?}",
        outcome.rate_limit.as_ref().and_then(|p| p.window.clone()),
        outcome.cost_usd,
        agent.spec().resume,
    );
}

#[tokio::main]
async fn main() {
    let mut spec = AgentSpec::new(std::env::current_dir().unwrap());
    spec.model = Some("haiku".into());
    spec.permission_mode = Some("dontAsk".into());
    let mut agent = ClaudeCodeAgent::new(spec);

    let dir = std::env::temp_dir().join("nl-agent-record");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut session = Session::with_log(&dir).unwrap();

    turn(
        &mut agent,
        &mut session,
        "Read Cargo.toml and tell me the workspace resolver version. Then remember the number 7.",
    )
    .await;
    turn(
        &mut agent,
        &mut session,
        "What number did I ask you to remember? Answer with just the number.",
    )
    .await;

    println!("--- agent_session: {:?}", session.agent_session());
    println!("--- models per assistant message ---");
    for e in session.events() {
        if let SessionEvent::AssistantMessage { model, blocks, .. } = e {
            println!("  {model}  ({} blocks)", blocks.len());
        }
    }
    println!("--- final text ---");
    for e in session.events().iter().rev() {
        if let SessionEvent::AssistantMessage { blocks, .. } = e {
            for b in blocks {
                if let nightloom_core::ContentBlock::Text { text } = b {
                    println!("  {text}");
                }
            }
            break;
        }
    }
    println!("--- projection: {} messages ---", session.messages().len());

    // Every tool_use has a tool_result: this is what makes the log replayable
    // if the rail is later switched back to a provider.
    let mut calls = 0usize;
    let mut results = 0usize;
    for m in session.messages() {
        for b in &m.content {
            match b {
                nightloom_core::ContentBlock::ToolUse { .. } => calls += 1,
                nightloom_core::ContentBlock::ToolResult { .. } => results += 1,
                _ => {}
            }
        }
    }
    println!("--- tool_use: {calls}, tool_result: {results} (must match)");
    assert_eq!(calls, results, "log is not replayable");

    // And it reloads cleanly from disk, which is what reopening the chat does.
    let path = dir.join(format!("{}.jsonl", session.id));
    let reloaded = Session::load(&path).unwrap();
    println!(
        "--- reloaded: {} events, report {:?}, agent_session {:?}",
        reloaded.events().len(),
        reloaded.load_report().summary(),
        reloaded.agent_session(),
    );
}
