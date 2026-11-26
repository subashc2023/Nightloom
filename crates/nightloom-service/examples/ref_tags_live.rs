//! Manual check for nightshift item 993b: do real turns write the typed
//! `<event>` / `<email>` / `<doc>` tags, with ids the connector returned?
//!
//! Three turns, each read-only (a Chat over a Claude Code declaration, so
//! the chat policy and the connector-writes refusal are registered; `auto`
//! denies what it cannot approve), on the model given (default `haiku`):
//!
//! 1. Home's scan — Home's connectors (`home::reach::apply`), its message
//!    built by `home::scan_message` from a scratch home's facts.
//! 2. A main chat with the rail's connectors on (not Home's).
//! 3. An aside of turn 2 (`AgentSpec::aside`: its fork, nothing persisted).
//!
//! Each turn's system prompt is `agent_prompt_with` with the engine note
//! and `connectors: true`, so it carries `REF_NOTE`. Everything is written
//! under the scratch folder (`$1`); his real Nightloom home is never read
//! or written. Prints, per turn, the tags found — their kind, attribute
//! names and whether their `id` appears in a tool result of that turn —
//! never a value, a reply or a tool result (those hold his mail).
//!
//! `cargo run -p nightloom-service --example ref_tags_live -- <scratch> [model] [chat-only]`

use nightloom_core::ChatKind;
use nightloom_service::turn::TurnEvent;
use nightloom_service::{AgentSpec, ClaudeCodeAgent, EngineLayers, PromptConfig, home};
use tokio_util::sync::CancellationToken;

struct Seen {
    calls: Vec<String>,
    denied: Vec<String>,
    results: String,
}

async fn turn(spec: AgentSpec, message: &str, out: &std::path::Path) -> (Seen, Option<String>) {
    let agent = ClaudeCodeAgent::new(spec);
    let cancel = CancellationToken::new();
    let mut seen = Seen {
        calls: Vec::new(),
        denied: Vec::new(),
        results: String::new(),
    };
    let done = agent
        .run_turn(message, &cancel, &mut |e| match e {
            TurnEvent::ToolCall { name, .. } => seen.calls.push(name),
            TurnEvent::ToolDenied { name, .. } => seen.denied.push(name),
            TurnEvent::ToolResult { content, .. } => {
                seen.results.push_str(&content);
                seen.results.push('\n');
            }
            _ => {}
        })
        .await
        .expect("the turn");
    std::fs::write(out, &done.text).expect("write the reply");
    println!(
        "  model {:?} · usage {:?} · cost {:?} · error {}",
        done.model, done.usage, done.cost_usd, done.is_error
    );
    println!("  tool calls: {:?}", seen.calls);
    println!("  denied: {:?}", seen.denied);
    report(&done.text, &seen.results);
    (seen, done.session_id)
}

/// The tags in `reply`, outside code fences: kind, attribute names, and
/// whether the id is one a tool returned this turn.
fn report(reply: &str, results: &str) {
    let mut fenced = false;
    let mut n = 0;
    for line in reply.lines() {
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        let mut rest = line;
        while let Some(at) = ["<event ", "<email ", "<doc "]
            .iter()
            .filter_map(|t| rest.find(t).map(|i| (i, *t)))
            .min()
        {
            let (i, t) = at;
            let kind = &t[1..t.len() - 1];
            let tail = &rest[i..];
            let Some(end) = tail.find('>') else { break };
            let head = &tail[..end];
            let closed = tail.contains(&format!("</{kind}>"));
            let mut names = Vec::new();
            let mut id = None;
            let mut s = head;
            while let Some(eq) = s.find("=\"") {
                let name = s[..eq].rsplit([' ', '<']).next().unwrap_or("").to_string();
                let v = &s[eq + 2..];
                let close = v.find('"').unwrap_or(v.len());
                if name == "id" {
                    id = Some(v[..close].to_string());
                }
                names.push(name);
                s = &v[(close + 1).min(v.len())..];
            }
            let real = id
                .as_deref()
                .is_some_and(|v| !v.is_empty() && results.contains(v));
            println!(
                "  tag {kind}: closed {closed} · id in a tool result {real} · attrs {names:?}"
            );
            n += 1;
            rest = &tail[end..];
        }
    }
    println!("  tags: {n}");
}

fn spec_with(dir: &std::path::Path, model: &str, prompt: Option<String>) -> AgentSpec {
    let mut spec = AgentSpec::new(dir);
    spec.model = Some(model.to_string());
    spec.permission_mode = Some(AgentSpec::headless_permission_mode(true).into());
    spec.auto_compact = false;
    spec.apply_kind(ChatKind::Build);
    spec.apply_kind_policy(ChatKind::Chat, ChatKind::Build);
    assert!(spec.refuses_mcp_writers(), "held read-only");
    spec.append_system_prompt = prompt;
    spec
}

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let scratch = std::path::PathBuf::from(args.next().expect("a scratch folder"));
    let model = args.next().unwrap_or_else(|| "haiku".to_string());
    // `chat-only` skips the scan (turns 2 and 3 alone).
    let scan = args.next().as_deref() != Some("chat-only");
    let dir = home::ensure_folder(&scratch).expect("the scratch home");
    std::fs::write(
        dir.join("AGENTS.md"),
        "A scratch folder for a Nightloom check. Answer briefly.",
    )
    .expect("write");
    let prompt = nightloom_service::agent_prompt_with(
        &PromptConfig {
            identity: false,
            environment: false,
            project_instructions: true,
            cwd: dir.clone(),
            ..PromptConfig::default()
        },
        None,
        EngineLayers {
            engine_note: true,
            pacing: true,
            subagents: true,
            connectors: true,
            ..EngineLayers::NONE
        },
    )
    .render_flat();
    assert!(
        prompt
            .as_deref()
            .is_some_and(|p| p.contains(nightloom_service::prompt::REF_NOTE)),
        "the prompt carries REF_NOTE"
    );
    // A measurement aid: `NL_REF_LAST=1` repeats REF_NOTE at the very end
    // of the prompt, to tell placement from wording.
    let prompt = match std::env::var("NL_REF_LAST").as_deref() {
        Ok("1") => prompt.map(|p| format!("{p}\n\n{}", nightloom_service::prompt::REF_NOTE)),
        _ => prompt,
    };
    let binary = std::path::PathBuf::from(nightloom_service::resolve_binary("claude"));
    let now = chrono::Utc::now();
    let reach = home::reach::check(&scratch, &binary, now);
    println!(
        "check: {} servers, error {:?}",
        reach.connectors.len(),
        reach.error
    );
    let accounts = home::reach::scan_accounts(&scratch);
    println!("accounts to read: {}", accounts.len());

    if scan {
        println!("turn 1 — Home's scan");
        let facts = home::collect(&scratch, &[], &[], now);
        let message = home::scan_message(&facts, !accounts.is_empty());
        let mut spec = spec_with(&dir, &model, prompt.clone());
        home::reach::apply(Some(Some(home::SOURCE)), Some(&scratch), &mut spec);
        assert!(spec.claude_ai_connectors);
        turn(spec, &message, &scratch.join("reply-1-scan.md")).await;
    }

    println!("turn 2 — a main chat with connectors on");
    let mut spec = spec_with(&dir, &model, prompt.clone());
    spec.claude_ai_connectors = true;
    let chat = spec.clone();
    let ask = "What is on my calendar in the next three days, which emails from the last two \
               days look like they need me, and what Drive files did I edit most recently? \
               Read only; a few lines each.";
    let (_, session) = turn(spec, ask, &scratch.join("reply-2-chat.md")).await;

    println!("turn 3 — an aside of turn 2");
    let Some(session) = session else {
        println!("  no session id from turn 2; no aside");
        return;
    };
    let mut parent = chat.clone();
    parent.resume = Some(session);
    let aside = parent.aside().expect("an aside");
    turn(
        aside,
        "Of the events and emails you just listed, which one should I deal with first? Name it.",
        &scratch.join("reply-3-aside.md"),
    )
    .await;
    println!("turn 4 — the ask rule still holds in a connectors-on chat");
    turn(
        chat,
        "I want to block two hours tomorrow to study. Before you suggest anything, ask me \
         whether I prefer the morning or the afternoon.",
        &scratch.join("reply-4-ask.md"),
    )
    .await;
    let reply = std::fs::read_to_string(scratch.join("reply-4-ask.md")).unwrap_or_default();
    println!(
        "  ends with an <ask> block: {}",
        reply.contains("<ask>") && reply.trim_end().ends_with("</ask>")
    );
}
