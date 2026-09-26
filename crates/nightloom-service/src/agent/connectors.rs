//! His claude.ai connectors (Google Drive, Claude Docs, Gmail, …) and
//! Nightloom's Claude Code processes (nightshift backlog 235, blocker 490,
//! 2026-09-26).
//!
//! The CLI loads every connector his claude.ai account has connected into
//! each `claude -p` it is started as, as `mcp__claude_ai_<Name>__<tool>`.
//! A Nightloom chat that could not write a local file reached for them
//! instead — `mcp__claude_ai_Google_Drive__create_file` with the hand-off
//! text, then `mcp__claude_ai_Claude_Docs__batch` — and only the CLI's
//! permission layer stopped it (blocker 490). His answer: hidden by
//! default; "in theory it would be nice to be able to allow them to see
//! drive and docs etc., if I enable it, but by default no."
//!
//! **What the CLI honours**, measured 2026-09-26 on 2.1.283, one Haiku turn
//! each, reading the `system/init` event (nightshift
//! `notes/runner-design/morning-M-report-2026-09-26.md`, section 235):
//!
//! | spelling | `mcp__claude_ai_*` tools | connectors in `mcp_servers` |
//! |---|---|---|
//! | plain | 19 | 4 (2 connected, 2 needs-auth) |
//! | `ENABLE_CLAUDEAI_MCP_SERVERS=false` in the environment | 0 | 0 |
//! | `--settings '{"disableClaudeAiConnectors":true}'` | 0 | 0 |
//! | `--disallowedTools 'mcp__claude_ai_*'` | 0 | 4, still connected |
//! | `--disallowedTools mcp__claude_ai_Google_Drive` | Docs' 8 only | 4 |
//!
//! His own user-level MCP server (`openalex`) stayed in every row, which is
//! why this is not `--strict-mcp-config`: that drops his servers too.
//!
//! **Off is the environment variable** ([`env`]). It stops the connectors
//! at the source — the CLI never fetches the list, so nothing connects —
//! and an environment variable reaches every process Nightloom starts
//! through [`AgentSpec::env_set`](super::AgentSpec::env_set): a chat, its
//! council seats, the checkpoint fork, a dream, a capture, a note edit, a
//! chat name, a nightshift unit, `/usage`, and any `claude` a Bash call
//! starts underneath. The CLI's own subagents run inside the same process
//! and share its MCP connections (`inferred`, not measured with a spawn).
//! The setting would have worked too, but it lives in the one `--settings`
//! JSON, which several callers are tested to send without.
//!
//! **On lets them through, less any he unticked** ([`disallowed`]): a
//! server-level `--disallowedTools` rule per blocked connector, the name
//! read from the init event's `mcp_servers` (`claude.ai Google Drive`).
//! Flipping either on a running chat changes its tool list, so the next
//! turn re-writes the cached prefix once.

/// The CLI's switch: read through its falsy test (`0`, `false`, `no`,
/// `off`), so `false` turns the connectors off.
pub const ENV_VAR: &str = "ENABLE_CLAUDEAI_MCP_SERVERS";

/// The prefix every connector's name carries in the init event's
/// `mcp_servers` (`claude.ai Google Drive`).
pub const SERVER_PREFIX: &str = "claude.ai ";

/// The environment the rule needs: `ENABLE_CLAUDEAI_MCP_SERVERS=false`
/// when the connectors are off, nothing when they are on (the CLI's own
/// default then applies).
pub fn env(allowed: bool) -> Option<(&'static str, String)> {
    (!allowed).then(|| (ENV_VAR, "false".to_string()))
}

/// Whether an init event's server name is one of his claude.ai connectors.
pub fn is_connector(server: &str) -> bool {
    server.starts_with(SERVER_PREFIX)
}

/// The CLI's server-level tool rule for a connector: `claude.ai Google
/// Drive` → `mcp__claude_ai_Google_Drive` — every character that is not a
/// letter, digit, `_` or `-` becomes `_`, which is how the init event's
/// tool names spell it (`mcp__claude_ai_Google_Drive__create_file`).
pub fn server_rule(server: &str) -> String {
    let norm: String = server
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("mcp__{norm}")
}

/// The `--disallowedTools` rules for the connectors he blocked, when they
/// are allowed at all. Empty when off (the environment already hides every
/// one) and for names that are not connectors, so a stale or hand-edited
/// list can never hide one of his own servers.
pub fn disallowed(allowed: bool, blocked: &[String]) -> Vec<String> {
    if !allowed {
        return Vec::new();
    }
    let mut rules: Vec<String> = blocked
        .iter()
        .map(|s| s.trim())
        .filter(|s| is_connector(s))
        .map(server_rule)
        .collect();
    rules.sort();
    rules.dedup();
    rules
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn off_is_the_environment_variable_and_on_is_nothing() {
        assert_eq!(env(false), Some((ENV_VAR, "false".to_string())));
        assert_eq!(env(true), None);
    }

    #[test]
    fn a_connector_name_becomes_the_cli_server_rule() {
        assert_eq!(
            server_rule("claude.ai Google Drive"),
            "mcp__claude_ai_Google_Drive"
        );
        assert_eq!(
            server_rule("claude.ai Claude Docs"),
            "mcp__claude_ai_Claude_Docs"
        );
    }

    #[test]
    fn only_connectors_are_blocked_and_only_when_allowed() {
        let blocked = vec![
            "claude.ai Google Drive".to_string(),
            "openalex".to_string(),
            "claude.ai Google Drive".to_string(),
        ];
        assert_eq!(
            disallowed(true, &blocked),
            vec!["mcp__claude_ai_Google_Drive".to_string()]
        );
        assert!(disallowed(false, &blocked).is_empty());
    }
}
