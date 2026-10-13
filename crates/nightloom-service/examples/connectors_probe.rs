//! Manual check for nightshift backlog 235: does a turn Nightloom starts see
//! his claude.ai connectors? Three real Haiku turns through
//! [`ClaudeCodeAgent`] — the chat's spawn path, environment and argv built by
//! [`AgentSpec`] — each printing what the CLI's `system/init` event listed:
//! the switch off (the default), on, and on with Google Drive unticked.
//!
//! An example rather than a test because each turn spends a real (tiny)
//! turn against the subscription.
//!
//! `cargo run -p nightloom-service --example connectors_probe`

use nightloom_service::turn::TurnEvent;
use nightloom_service::{AgentSpec, ClaudeCodeAgent};
use tokio_util::sync::CancellationToken;

async fn probe(label: &str, on: bool, blocked: &[&str]) {
    let dir = std::env::temp_dir().join("nl-connectors-probe");
    std::fs::create_dir_all(&dir).unwrap();
    let mut spec = AgentSpec::new(&dir);
    spec.model = Some("haiku".into());
    spec.permission_mode = Some("dontAsk".into());
    spec.max_turns = Some(1);
    spec.claude_ai_connectors = on;
    spec.claude_ai_blocked = blocked.iter().map(|s| s.to_string()).collect();
    let agent = ClaudeCodeAgent::new(spec);
    let cancel = CancellationToken::new();
    let mut seen: Option<(Vec<String>, Vec<String>)> = None;
    agent
        .run_turn("Reply with the word ok.", &cancel, &mut |e| {
            if let TurnEvent::AgentInit {
                tools, mcp_servers, ..
            } = e
            {
                seen = Some((
                    tools.clone(),
                    mcp_servers.iter().map(|s| s.name.clone()).collect(),
                ));
            }
        })
        .await
        .unwrap();
    let (tools, servers) = seen.expect("no init event");
    let claude_ai: Vec<&String> = tools
        .iter()
        .filter(|t| t.starts_with("mcp__claude_ai_"))
        .collect();
    let mut by_server: Vec<&str> = claude_ai
        .iter()
        .filter_map(|t| t.split("__").nth(1))
        .collect();
    by_server.dedup();
    println!(
        "{label}: {} tools, {} mcp__claude_ai_* ({by_server:?}); servers {servers:?}",
        tools.len(),
        claude_ai.len()
    );
}

#[tokio::main]
async fn main() {
    probe("off (default)", false, &[]).await;
    probe("on", true, &[]).await;
    probe("on, Drive unticked", true, &["claude.ai Google Drive"]).await;
}
