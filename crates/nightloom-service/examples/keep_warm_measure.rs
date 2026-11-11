//! Item 582's measurement: the keep-warm ping on a real throwaway chat,
//! through the same code the app runs (`keep_warm::Registry`, `ping`).
//! Three model turns on Haiku: (1) a chat turn that writes a context of
//! about 90k tokens; (2) the switch on, the interval shortened by the
//! test-only setting, one ping fires; (3) a turn in the chat, whose cache
//! read should be about its context. Prints each turn's usage.
//!
//! `cargo run -p nightloom-service --example keep_warm_measure -- <scratch dir>`

use nightloom_core::{Session, SessionEvent};
use nightloom_service::keep_warm::{self, Mode, Policy, Registry};
use nightloom_service::{AgentSpec, ClaudeCodeAgent, Recorder};
use std::path::Path;
use tokio_util::sync::CancellationToken;

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

async fn turn(agent: &mut ClaudeCodeAgent, session: &mut Session, prompt: &str, label: &str) {
    session.record_user(prompt);
    let cancel = CancellationToken::new();
    let mut rec = Recorder::new(session, "claude-code");
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
    let u = outcome.usage;
    println!(
        "{label}: model {:?} session {:?} | prompt {} = cache_read {} + cache_write {} (1h {:?}, 5m {:?}) + uncached {} | output {} | cost {:?} | error {}",
        outcome.model,
        outcome.session_id,
        u.input_tokens,
        u.cache_read_tokens.unwrap_or(0),
        u.cache_write_tokens.unwrap_or(0),
        u.cache_write_1h_tokens,
        u.cache_write_5m_tokens,
        u.input_tokens
            .saturating_sub(u.cache_read_tokens.unwrap_or(0) + u.cache_write_tokens.unwrap_or(0)),
        u.output_tokens,
        outcome.cost_usd,
        outcome.is_error,
    );
}

/// The CLI's session files for the scratch folder, by name.
fn cli_files(scratch: &Path) -> Vec<String> {
    let Some(projects) = nightloom_service::usage::claude_dir().map(|d| d.join("projects")) else {
        return Vec::new();
    };
    let tail = scratch.file_name().unwrap().to_string_lossy().to_string();
    let mut out = Vec::new();
    for dir in std::fs::read_dir(projects).into_iter().flatten().flatten() {
        if !dir.file_name().to_string_lossy().ends_with(&tail) {
            continue;
        }
        for f in std::fs::read_dir(dir.path())
            .into_iter()
            .flatten()
            .flatten()
        {
            out.push(f.file_name().to_string_lossy().to_string());
        }
    }
    out.sort();
    out
}

#[tokio::main]
async fn main() {
    let scratch = std::path::PathBuf::from(std::env::args().nth(1).expect("a scratch dir"));
    std::fs::create_dir_all(&scratch).unwrap();
    let scratch = scratch.canonicalize().unwrap();
    let logs = scratch.join("logs");
    std::fs::create_dir_all(&logs).unwrap();
    let mut session = Session::with_log(&logs).unwrap();
    let chat = session.id.clone();
    let ask = logs.join("ask").join(&chat);

    let mut spec = AgentSpec::new(scratch.clone());
    spec.model = Some("haiku".into());
    spec.permission_mode = Some("dontAsk".into());
    let mut agent = ClaudeCodeAgent::new(spec);

    let filler: String = (1..2000)
        .map(|i| {
            format!(
                "Line {i}: the quick brown fox jumps over the lazy dog, item {}.\n",
                i * 7 % 1000
            )
        })
        .collect();
    turn(
        &mut agent,
        &mut session,
        &format!("{filler}\nReply with only: ok"),
        "turn 1 (the chat's own turn)",
    )
    .await;
    let reply = keep_warm::reply_of(&session).expect("a reply with a send time");
    println!("reply as the schedule reads it: {reply:?}");
    let files_before = cli_files(&scratch);
    println!("CLI session files before the ping: {files_before:?}");

    // The switch on; the interval shortened by the test-only setting.
    let policy = Policy::from_parts(None, Some("20"));
    println!("policy: {policy:?}");
    let reg = Registry::default();
    reg.set_mode(
        &chat,
        &ask,
        Mode::On,
        Some((agent.spec().clone(), reply)),
        now_ms(),
    );
    let st = reg.status(&chat, None, &policy, now_ms());
    println!(
        "switched on: scheduled {} next ping in {:?} s",
        st.scheduled,
        st.next_ping_ms.map(|t| (t - now_ms()) / 1000)
    );
    let mut fired = false;
    for _ in 0..120 {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        let jobs = reg.due(&policy, now_ms(), |_| false);
        if let Some(job) = jobs.into_iter().next() {
            let sent = now_ms();
            println!(
                "ping due {} s after the reply's send",
                (sent - reply.sent_ms) / 1000
            );
            let result = keep_warm::ping(&job.spec, &job.cancel).await;
            println!("turn 2 (the ping): {result:?}");
            reg.done(&job, sent, result);
            fired = true;
            break;
        }
    }
    assert!(fired, "no ping fired");
    let st = reg.status(&chat, None, &policy, now_ms());
    println!(
        "after the ping: touched {:?} spent {:?} why {:?}",
        st.touched_ms.is_some(),
        st.spent,
        st.why
    );
    println!("ping lines on disk: {:?}", keep_warm::read_pings(&ask));
    let files_after = cli_files(&scratch);
    println!(
        "CLI session files after the ping: {files_after:?} (same as before: {})",
        files_after == files_before
    );

    // His next message: the ping in flight (none) stops, then the turn.
    reg.sent(&chat, Some(&ask), now_ms());
    turn(
        &mut agent,
        &mut session,
        "Reply with only: ok",
        "turn 3 (the chat again)",
    )
    .await;
    let after = keep_warm::reply_of(&session).unwrap();
    println!("the chat's context now: {} tokens", after.context);
    let texts: Vec<String> = session
        .events()
        .iter()
        .filter_map(|e| match e {
            SessionEvent::UserMessage { text, .. } => Some(
                text.chars()
                    .rev()
                    .take(30)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect(),
            ),
            _ => None,
        })
        .collect();
    println!(
        "the chat's log holds {} user messages (tails): {texts:?}",
        texts.len()
    );
    println!("CLI session files at the end: {:?}", cli_files(&scratch));
}
