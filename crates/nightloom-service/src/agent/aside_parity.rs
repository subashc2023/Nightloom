//! The aside parity test (nightshift item 919, his bug 2026-11-23: asides
//! missing what the main chat has, "one too many times" — items 698, 699,
//! 732, 768, 774, 775, 776, 777, 786 each fixed one feature with a test of
//! that feature alone, and the next miss reached him).
//!
//! **Nothing here is a hand-written list of capabilities.** The main chat's
//! capabilities are read from what the code builds for it — a chat with
//! every per-chat piece on (the Ask position, Playwright on the app's
//! browser, Nightloom's server, a session) — and from the code itself:
//!
//! 1. every `PreToolUse` hook matcher in the chat's `--settings`;
//! 2. every flag on the chat's command line;
//! 3. every MCP server in the chat's `--mcp-config`, and every flag of each;
//! 4. every field of [`AgentSpec`], parsed from this module's source.
//!
//! Each must have its counterpart in the aside the window asks (the spec
//! [`AgentSpec::aside`] builds, seated by [`AgentSpec::seat_aside`]), or a
//! row in the exemption tables below saying why not. A new hook, flag,
//! server or spec field fails here until someone decides what an aside does
//! with it. The window's half — components, controls and transcript-source
//! fields gated to the chat — is `apps/desktop/src/lib/asideParity919.test.ts`.

use super::*;
use serde_json::Value;
use std::collections::BTreeSet;

/// Hook matchers the chat has and an aside does not, and why.
const EXEMPT_HOOKS: &[(&str, &str)] = &[];

/// Command-line flags the chat has and an aside does not (or the other
/// way), and why. Both directions are listed: an aside's extra flag is as
/// much a decision as a missing one.
const EXEMPT_FLAGS: &[(&str, &str)] = &[
    (
        "--fork-session",
        "aside only: it forks the chat's session so the chat's history never sees it (081)",
    ),
    (
        "--no-session-persistence",
        "aside only: the fork keeps no session file (081)",
    ),
];

/// MCP server flags that may differ between the chat and an aside, and why.
const EXEMPT_SERVER_FLAGS: &[(&str, &str, &str)] = &[];

/// Every field of [`AgentSpec`], and what an aside does with it. A field
/// missing here fails the test: a new per-chat setting needs its aside
/// behaviour decided.
const FIELDS: &[(&str, &str)] = &[
    ("binary", "same"),
    ("workspace", "same"),
    ("model", "same, or the aside's own pick (283)"),
    ("effort", "same, or the aside's own pick (283)"),
    ("fallback_model", "same"),
    ("tools", "same: the cached prefix (081)"),
    ("allowed_tools", "same"),
    (
        "permission_mode",
        "the chat's class's mode (774, 802): dontAsk / auto / plan",
    ),
    ("system_prompt", "same: the cached prefix"),
    ("append_system_prompt", "same: the cached prefix"),
    ("system_prompt_snapshot_off", "same"),
    ("safe_mode", "same"),
    ("auto_memory", "same"),
    ("auto_compact", "same"),
    ("prompt_suggestions", "same"),
    ("resume", "same: the aside forks it"),
    ("fork_session", "on: the aside forks"),
    ("max_budget_usd", "same"),
    ("subagent_limits", "same"),
    ("max_turns", "same (2026-11-12: the chat's, unbounded)"),
    ("use_subscription", "same"),
    ("add_dirs", "same"),
    (
        "mcp_config",
        "same servers; Playwright on the aside's own browser (919)",
    ),
    ("no_session_persistence", "on: the fork keeps no file"),
    (
        "ask",
        "Aside mode; seated, its own directory and cards (919)",
    ),
    ("brief", "none: one question, no subagent brief (081)"),
    ("chat_policy", "same"),
    ("born_chat", "same"),
    ("fork_mode", "same"),
    ("claude_ai_connectors", "same"),
    ("home_gated_writes", "same"),
    ("home_chat", "same"),
    ("claude_ai_blocked", "same"),
    (
        "browser",
        "same (Claude in Chrome, shared; the agent lock serialises)",
    ),
    (
        "playwright",
        "same gate; seated, waits for the aside's card (919)",
    ),
    ("folder_side", "on: add_folder is refused in words"),
    ("side_cache_mark", "on: marks the chat's prefix"),
    ("aside_cards", "on when seated (919)"),
    ("incognito", "same"),
    ("denied_reads", "same"),
    ("extra_args", "same"),
];

const CHAT_DIR: &str = "/logs/ask/chat-3";
const CHAT_SOCKET: &str = "/s/cb-chat.sock";
const ASIDE_SOCKET: &str = "/s/cb-aside.sock";

/// A main chat with every per-chat piece on.
fn full_chat() -> AgentSpec {
    let hook = vec!["hook".to_string(), "--permission-hook".to_string()];
    let mut s = AgentSpec::new("/work");
    s.model = Some("opus".into());
    s.resume = Some("sess-1".into());
    s.browser = true;
    s.ask = Some(AskSpec {
        hook: hook.clone(),
        dir: PathBuf::from(CHAT_DIR),
        mode: AskMode::Ask,
        subagents_auto: true,
    });
    s.playwright = Some(own_browser::PlaywrightGate {
        hook,
        dir: PathBuf::from(CHAT_DIR),
        side: false,
        no_card: false,
        wait: false,
    });
    s.mcp_config = Some(
        serde_json::json!({ "mcpServers": {
            "playwright": { "command": "node", "args": [
                "cli.js", "--browser", "webkit", "--endpoint", CHAT_SOCKET, "--output-dir", "/o"
            ]},
            "nightloom": { "command": "nl", "args": ["--mcp-serve", "--budget-dir", CHAT_DIR] }
        }})
        .to_string(),
    );
    s
}

/// The aside the window asks: [`AgentSpec::aside`], seated.
fn seated_aside(chat: &AgentSpec) -> AgentSpec {
    let mut a = chat.aside().expect("the chat has a session");
    a.seat_aside(&AsideSeat {
        dir: AsideSeat::dir_for(std::path::Path::new(CHAT_DIR), "u1"),
        endpoint: Some(PathBuf::from(ASIDE_SOCKET)),
    });
    a
}

fn settings(args: &[String]) -> Value {
    args.iter()
        .position(|x| x == "--settings")
        .and_then(|i| serde_json::from_str(&args[i + 1]).ok())
        .unwrap_or(Value::Null)
}

fn matchers(args: &[String]) -> BTreeSet<String> {
    settings(args)["hooks"]["PreToolUse"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| e["matcher"].as_str().map(str::to_string))
        .collect()
}

fn flags(args: &[String]) -> BTreeSet<String> {
    args.iter()
        .filter(|a| a.starts_with("--"))
        .cloned()
        .collect()
}

/// Each server's flags, `--endpoint` and `--headless` included.
fn servers(args: &[String]) -> Vec<(String, BTreeSet<String>)> {
    let Some(cfg) = args
        .iter()
        .position(|x| x == "--mcp-config")
        .and_then(|i| serde_json::from_str::<Value>(&args[i + 1]).ok())
    else {
        return Vec::new();
    };
    cfg["mcpServers"]
        .as_object()
        .into_iter()
        .flatten()
        .map(|(name, e)| {
            let f = e["args"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|a| a.as_str())
                .filter(|a| a.starts_with("--"))
                .map(str::to_string)
                .collect();
            (name.clone(), f)
        })
        .collect()
}

/// Every gap between the chat's line and the aside's, as sentences.
fn gaps(chat: &[String], aside: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let aside_m = matchers(aside);
    for m in matchers(chat) {
        if !aside_m.contains(&m) && !EXEMPT_HOOKS.iter().any(|(x, _)| *x == m) {
            out.push(format!("hook `{m}`: the chat has it, the aside does not"));
        }
    }
    let (cf, af) = (flags(chat), flags(aside));
    for f in cf.symmetric_difference(&af) {
        if !EXEMPT_FLAGS.iter().any(|(x, _)| x == f) {
            let side = if cf.contains(f) {
                "the chat"
            } else {
                "the aside"
            };
            out.push(format!("flag `{f}`: only {side} has it"));
        }
    }
    let aside_s = servers(aside);
    for (name, cflags) in servers(chat) {
        let Some((_, aflags)) = aside_s.iter().find(|(n, _)| *n == name) else {
            out.push(format!(
                "MCP server `{name}`: the chat has it, the aside does not"
            ));
            continue;
        };
        for f in cflags.symmetric_difference(aflags) {
            if !EXEMPT_SERVER_FLAGS
                .iter()
                .any(|(s, x, _)| *s == name && x == f)
            {
                let side = if cflags.contains(f) {
                    "the chat's"
                } else {
                    "the aside's"
                };
                out.push(format!(
                    "MCP server `{name}` flag `{f}`: only {side} has it"
                ));
            }
        }
    }
    out
}

#[test]
fn an_aside_has_every_hook_flag_and_server_the_chat_has() {
    let chat = full_chat();
    let aside = seated_aside(&chat);
    let g = gaps(&chat.args("q"), &aside.args("q"));
    assert!(
        g.is_empty(),
        "aside parity gaps (decide each, item 919):\n{}",
        g.join("\n")
    );
}

/// The detector catches what reached him: the aside as it was before 919
/// (unseated — headless browser of its own, no Ask hook) fails.
#[test]
fn the_unseated_aside_of_before_919_is_caught() {
    let chat = full_chat();
    let before = chat.aside().unwrap();
    let g = gaps(&chat.args("q"), &before.args("q"));
    eprintln!("before 919, the aside's gaps:\n{}", g.join("\n"));
    assert!(
        g.iter()
            .any(|l| l.contains("`playwright` flag `--endpoint`")),
        "{g:#?}"
    );
    assert!(
        g.iter()
            .any(|l| l.contains(&format!("hook `{}`", ask::MATCHER))),
        "{g:#?}"
    );
}

/// A seated aside's browser is its own, never the chat's page, and its
/// cards wait in its own directory.
#[test]
fn the_seated_aside_has_its_own_browser_and_directory() {
    let chat = full_chat();
    let aside = seated_aside(&chat);
    let cfg = aside.mcp_config.clone().unwrap();
    assert!(
        cfg.contains(ASIDE_SOCKET) && !cfg.contains(CHAT_SOCKET),
        "{cfg}"
    );
    let s = settings(&aside.args("q")).to_string();
    assert!(s.contains("asides/u1") && s.contains(ask::WAIT_ARG), "{s}");
    assert!(
        !s.contains(&format!("{CHAT_DIR}'")),
        "the chat's directory: {s}"
    );
    // The keep-warm ping is never seated: no card would be watched.
    let ping = chat.keep_warm_ping().unwrap().args("q");
    assert!(!settings(&ping).to_string().contains(ask::WAIT_ARG));
}

/// Every field of [`AgentSpec`], read from this module's source, has its
/// aside behaviour decided in [`FIELDS`], and every row names a field.
#[test]
fn every_spec_field_has_its_aside_behaviour_decided() {
    let src = include_str!("mod.rs");
    let body = src
        .split_once("pub struct AgentSpec {")
        .and_then(|(_, rest)| rest.split_once("\n}\n"))
        .map(|(b, _)| b)
        .expect("AgentSpec's body");
    let fields: Vec<&str> = body
        .lines()
        .filter_map(|l| l.strip_prefix("    pub "))
        .filter_map(|l| l.split_once(':').map(|(n, _)| n))
        .collect();
    assert!(fields.len() > 30, "the scan reads the struct: {fields:?}");
    let missing: Vec<&&str> = fields
        .iter()
        .filter(|f| !FIELDS.iter().any(|(n, _)| n == *f))
        .collect();
    assert!(
        missing.is_empty(),
        "AgentSpec fields with no aside decision (add a row to FIELDS in aside_parity.rs): {missing:?}"
    );
    let stale: Vec<&str> = FIELDS
        .iter()
        .map(|(n, _)| *n)
        .filter(|n| !fields.contains(n))
        .collect();
    assert!(stale.is_empty(), "rows naming no field: {stale:?}");
}

/// The aside's hook (item 919): a call the chat would defer waits, the
/// card's file appears, his Allow in the aside's directory runs it, and a
/// Deny refuses it in his words; a gone CLI ends the wait refused.
#[test]
fn an_aside_call_waits_for_its_card() {
    use std::time::Duration;
    let d = std::env::temp_dir().join(format!("nl-919-wait-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    let line = |id: &str| {
        serde_json::json!({
            "tool_name": "Bash", "tool_use_id": id, "permission_mode": "dontAsk",
            "tool_input": { "command": "touch x" }
        })
        .to_string()
    };
    let call = |id: &str| ask::DeferredCall {
        id: id.into(),
        name: "Bash".into(),
        input: serde_json::json!({ "command": "touch x" }),
    };
    for (id, answer, want) in [
        (
            "t1",
            ask::Answer::Allow {
                updated_input: None,
                plan_then: None,
                grant: None,
            },
            "allow",
        ),
        (
            "t2",
            ask::Answer::Deny {
                reason: "not now".into(),
            },
            "deny",
        ),
    ] {
        let (d2, input) = (d.clone(), line(id));
        let waiter = std::thread::spawn(move || {
            ask::decide_waiting(
                &d2,
                None,
                &input,
                Duration::from_millis(10),
                Duration::from_secs(20),
                &|| true,
            )
        });
        let mut seen = None;
        for _ in 0..500 {
            seen = ask::aside_pending(&d);
            if seen.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(seen, Some(call(id)), "the card's file");
        ask::AskDir::new(&d).write(&call(id), &answer).unwrap();
        let r = waiter.join().unwrap();
        assert_eq!(r.decision(), want);
        assert!(ask::aside_pending(&d).is_none(), "the card's file goes");
        // Nothing stays for the next call, and nothing lands in a chat's rules.
        assert!(!ask::AskDir::new(&d).allowed().contains(&"Bash".to_string()));
    }
    let r = ask::decide_waiting(
        &d,
        None,
        &line("t3"),
        Duration::from_millis(10),
        Duration::from_secs(20),
        &|| false,
    );
    assert_eq!(
        (r.decision(), r.reason()),
        ("deny", Some(ask::ASIDE_UNANSWERED))
    );
}
