//! Manual check for nightshift item 993d: the card's one-shot action
//! process (`ref_action::spec_for`, Haiku, `dontAsk`, the pass hook) run
//! for real — against a **read-only** Calendar tool (`list_events`), never
//! a send. Everything Nightloom writes goes under the scratch folder (`$1`);
//! his real Nightloom home is never read or written. Prints only names,
//! flags, lengths and figures — never a tool result (that holds his data).
//!
//! Scenarios: `exact` (the pass covers the message's call), `mismatch` (the
//! pass is for `pageSize` 3, the message asks for 4), `twice` (the message
//! asks for the approved call two times: the second must be refused).
//!
//! `cargo run -p nightloom-service --example ref_action_live -- <scratch> [exact|mismatch|twice|all]`
//! The same binary is the hook: `ref_action_live --permission-hook <dir> --ref-pass`.

use nightloom_service::ref_action::{self, Act, Call, Seen};
use nightloom_service::{ClaudeCodeAgent, PassSpec, TurnEvent, home};
use serde_json::json;
use tokio_util::sync::CancellationToken;

fn call(tool: &str, page: i64) -> Call {
    Call {
        tool: tool.to_string(),
        input: json!({
            "startTime": "2026-11-26T00:00:00",
            "endTime": "2026-11-27T00:00:00",
            "pageSize": page,
            "fullText": "Nightloom ref-action probe — café “quoted” 3:30 ✓",
        }),
        words_key: Some("fullText"),
        sends: false,
    }
}

async fn run(
    name: &str,
    scratch: &std::path::Path,
    tool: &str,
    blocked: Vec<String>,
    binary: &str,
) {
    let exe = std::env::current_exe().unwrap();
    let dir = scratch.join("ref-actions").join(name);
    let _ = std::fs::remove_dir_all(&dir);
    let work = scratch.join("work");
    std::fs::create_dir_all(&work).unwrap();
    let approved = call(tool, 3);
    let asked = if name == "mismatch" {
        call(tool, 4)
    } else {
        approved.clone()
    };
    let mut message = ref_action::message(&asked);
    if name == "twice" {
        message = message
            .replace("exactly once", "exactly two times, one after the other")
            .replace(
                "Make no other tool call.",
                "Make no other tool call; make the second call even if the first one worked.",
            );
    }
    let mut pass = PassSpec::new(binary.to_string(), Vec::new());
    // `NL_SAFE=1`: the rail's safe mode, as `ref_act` passes it.
    pass.safe_mode = std::env::var("NL_SAFE").as_deref() == Ok("1");
    let spec = ref_action::spec_for(
        &pass,
        &work,
        vec![
            exe.to_string_lossy().into_owned(),
            "--permission-hook".into(),
        ],
        &dir,
        blocked,
    );
    ref_action::mint(&dir, &approved, chrono::Utc::now()).unwrap();
    let started = std::time::Instant::now();
    let mut seen: Vec<Seen> = Vec::new();
    let mut calls: Vec<String> = Vec::new();
    let mut denied: Vec<String> = Vec::new();
    let mut results: Vec<String> = Vec::new();
    let cancel = CancellationToken::new();
    let out = ClaudeCodeAgent::new(spec)
        .run_turn(message.as_str(), &cancel, &mut |e| match e {
            TurnEvent::ToolCall { name, input, .. } => calls.push(format!(
                "{} exact_args={} same_as_approved={}",
                name.rsplit("__").next().unwrap_or(""),
                input == asked.input,
                input == approved.input
            )),
            TurnEvent::ToolDenied { name, reason, .. } => {
                denied.push(format!(
                    "{} reason_len={}",
                    name.rsplit("__").next().unwrap_or(""),
                    reason.len()
                ));
                if name == tool {
                    seen.push(Seen::Denied { reason });
                }
            }
            TurnEvent::ToolResult {
                name,
                content,
                is_error,
                ..
            } => {
                let s = Seen::of_result(&content, is_error);
                results.push(format!(
                    "{} is_error={} len={} as={}",
                    name.rsplit("__").next().unwrap_or(""),
                    is_error,
                    content.len(),
                    match &s {
                        Seen::Denied { .. } => "refusal",
                        Seen::Result { .. } => "connector",
                    }
                ));
                if name == tool {
                    seen.push(s);
                }
            }
            _ => {}
        })
        .await;
    let secs = started.elapsed().as_secs_f64();
    let spent = ref_action::spent(&dir);
    let act = Act::SaveDraft {
        mode: "reply".into(),
        to: String::new(),
        body: "x".into(),
    };
    let receipt = ref_action::receipt(&act, &seen, spent);
    println!("== {name}: {secs:.1} s, pass spent {spent}");
    match &out {
        Ok(o) => println!(
            "  model {:?} · cost {:?} · error {} · usage {:?} · reply {:?}",
            o.model,
            o.cost_usd,
            o.is_error,
            o.usage,
            o.text.chars().take(40).collect::<String>()
        ),
        Err(e) => println!("  turn error: {e}"),
    }
    println!("  calls: {calls:?}");
    println!("  denied events: {denied:?}");
    println!("  results: {results:?}");
    println!(
        "  receipt: {} ({})",
        receipt.outcome,
        if receipt.outcome == "done" {
            receipt.text.as_str()
        } else {
            "text withheld"
        }
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::main]
async fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.first().map(String::as_str) == Some("--permission-hook") {
        nightloom_service::agent::ask::run_hook(&argv[1..]).expect("hook");
        return;
    }
    let scratch = std::path::PathBuf::from(argv.first().expect("scratch folder"));
    assert!(
        !scratch.starts_with(dirs_home().join(".nightloom")),
        "never his real home"
    );
    std::fs::create_dir_all(&scratch).unwrap();
    let which = argv.get(1).cloned().unwrap_or_else(|| "all".into());
    let binary = nightloom_service::resolve_binary("claude");
    let reach = home::reach::check(&scratch, std::path::Path::new(&binary), chrono::Utc::now());
    println!(
        "check: {} servers, error {:?}",
        reach.connectors.len(),
        reach.error
    );
    let accounts = home::reach::accounts(&scratch);
    let cal = accounts
        .iter()
        .find(|a| {
            a.claude_ai
                && a.service.contains("Calendar")
                && a.status == home::reach::Status::Connected
        })
        .expect("a connected Calendar account");
    let tool = format!(
        "{}__list_events",
        nightloom_service::agent::connectors::server_rule(&cal.connector)
    );
    println!("tool: {}", tool.split("__").nth(1).unwrap_or(""));
    let blocked: Vec<String> = accounts
        .iter()
        .filter(|a| a.claude_ai && a.connector != cal.connector)
        .map(|a| a.connector.clone())
        .collect();
    for name in ["exact", "mismatch", "twice"] {
        if which == "all" || which == name {
            run(name, &scratch, &tool, blocked.clone(), &binary).await;
        }
    }
}

fn dirs_home() -> std::path::PathBuf {
    std::path::PathBuf::from(std::env::var("HOME").unwrap_or_default())
}
