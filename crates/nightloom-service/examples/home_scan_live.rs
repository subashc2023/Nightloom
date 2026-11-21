//! Manual check for nightshift item 804: one real morning scan, as Home
//! would run it, that reads his mail and calendars — read only.
//!
//! - The Nightloom home it writes to is a scratch folder (`$1`): his brief
//!   and feed are copied in, `claude mcp list` fills its `reach.json`, the
//!   page and the account names land under it. His real home is only read.
//! - The agent is the scan's: Home's model and effort, held read-only (a
//!   Chat over a Claude Code declaration, so the connector-writes refusal
//!   is registered), his connectors on by `home::reach::apply`.
//! - Prints the connectors the CLI listed, every tool call's name (never
//!   its input or result), every refusal, the reply and the usage.
//!
//! An example rather than a test: it spends a real turn on the plan and
//! reads his real accounts.
//!
//! `cargo run -p nightloom-service --example home_scan_live -- <scratch> [model] [effort]`

use nightloom_core::ChatKind;
use nightloom_service::home;
use nightloom_service::turn::TurnEvent;
use nightloom_service::{AgentSpec, ClaudeCodeAgent};
use tokio_util::sync::CancellationToken;

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let scratch = std::path::PathBuf::from(args.next().expect("a scratch folder"));
    let model = args.next().unwrap_or_else(|| home::MODEL.to_string());
    let effort = args.next().unwrap_or_else(|| home::EFFORT.to_string());
    let real = nightloom_service::project::config_dir().expect("a Nightloom home");
    let dir = home::ensure_folder(&scratch).expect("the scratch home");
    for name in ["brief.md", "feed.jsonl", "seen.json"] {
        let from = home::dir_in(&real).join(name);
        if from.exists() {
            std::fs::copy(&from, dir.join(name)).expect("copy");
        }
    }
    let binary = std::path::PathBuf::from(nightloom_service::resolve_binary("claude"));
    let now = chrono::Utc::now();
    let reach = home::reach::check(&scratch, &binary, now);
    println!(
        "check: {} servers, error {:?}",
        reach.connectors.len(),
        reach.error
    );
    for a in home::reach::accounts(&scratch) {
        println!(
            "  {:?} · {} · {:?} · on {} · scan {}",
            a.kind, a.connector, a.status, a.on, a.in_scan
        );
    }
    let jobs = nightloom_service::jobs::Jobs::open_in(
        nightloom_service::jobs::Jobs::dir_under(&real),
        None,
    );
    let projects: Vec<(String, Option<std::path::PathBuf>)> =
        nightloom_service::project::Registry::load_in(&real)
            .projects()
            .into_iter()
            .filter(|p| p.source.as_deref() != Some(home::SOURCE))
            .map(|p| (p.name, p.workspace))
            .collect();
    let facts = home::collect(&scratch, &jobs.list(), &projects, now);
    let with = !home::reach::scan_accounts(&scratch).is_empty();
    let message = home::scan_message(&facts, with);
    std::fs::write(scratch.join("scan-message.txt"), &message).expect("write");
    println!("message: {} characters, accounts {with}", message.len());

    let mut spec = AgentSpec::new(&dir);
    spec.model = Some(model);
    spec.effort = Some(effort);
    spec.permission_mode = Some(AgentSpec::headless_permission_mode(true).into());
    spec.auto_compact = false;
    spec.apply_kind(ChatKind::Build);
    spec.apply_kind_policy(ChatKind::Chat, ChatKind::Build);
    assert!(spec.refuses_mcp_writers(), "held read-only");
    home::reach::apply(Some(Some(home::SOURCE)), Some(&scratch), &mut spec);
    assert!(spec.claude_ai_connectors);
    let agent = ClaudeCodeAgent::new(spec);
    let cancel = CancellationToken::new();
    let mut calls: Vec<String> = Vec::new();
    let mut denied: Vec<String> = Vec::new();
    let mut errors = 0usize;
    let mut servers: Vec<String> = Vec::new();
    let mut tools = 0usize;
    let out = agent
        .run_turn(message.as_str(), &cancel, &mut |e| match e {
            TurnEvent::AgentInit {
                tools: t,
                mcp_servers,
                model,
                ..
            } => {
                tools = t.len();
                servers = mcp_servers.iter().map(|s| s.name.clone()).collect();
                println!("init: model {model:?}, {tools} tools");
            }
            TurnEvent::ToolCall { name, .. } => calls.push(name),
            TurnEvent::ToolDenied { name, reason, .. } => denied.push(format!(
                "{name}: {}",
                reason.chars().take(120).collect::<String>()
            )),
            TurnEvent::ToolResult { is_error: true, .. } => errors += 1,
            _ => {}
        })
        .await
        .expect("the turn");
    println!("servers in init: {servers:?}");
    println!("tool calls ({}):", calls.len());
    for c in &calls {
        println!("  {c}");
    }
    println!("tool results that were errors: {errors}");
    println!("denied ({}): {denied:?}", denied.len());
    println!(
        "usage: {:?} · cost {:?} · rounds {:?} · error {}",
        out.usage, out.cost_usd, out.rounds, out.is_error
    );
    println!("model: {:?}", out.model);
    let date = now.with_timezone(&chrono::Local).date_naive();
    let page =
        home::finish_scan(&scratch, &out.text, date, None, chrono::Utc::now()).expect("page");
    println!("page: {}", page.display());
    println!("waiting: {}", home::waiting_in(&out.text));
    println!("names learned: {}", home::reach::names(&scratch).len());
}
