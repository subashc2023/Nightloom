//! Playwright as Claude's own browser, behind an approval card (nightshift
//! backlog 367, blocker 1413).
//!
//! Every Claude Code chat gets Microsoft's Playwright MCP server
//! (`@playwright/mcp`, a browser-automation server) in the `--mcp-config`
//! JSON beside Nightloom's own, driving **WebKit** — never Chrome, whose
//! updater trips macOS App Management — headless and with an in-memory
//! profile. The model's prompt says nothing about whether it may use it:
//! the tools are always listed (so the cached prefix never moves), and a
//! `PreToolUse` hook on [`MATCHER`] gates every call **in every position**,
//! bypass included — measured on CLI 2.1.300 (nightshift
//! `notes/runner-design/wave9-367-report.md`, M1–M2): a `defer` from this
//! hook pauses a call under `bypassPermissions` with no prompt tool named,
//! and `--resume` with the hook answering `allow` runs it.
//!
//! The hook is the Ask position's own (`<binary> --permission-hook <dir>`,
//! [`super::ask::decide`]), so the card and the round trip are the Ask
//! position's: the call defers, the window shows a card, the answer is
//! written to the chat's ask directory and the session resumes. What
//! differs is what the answers mean, kept in the same `rules.json`:
//!
//! | card | decision for this call | what stays |
//! |---|---|---|
//! | **Allow once** | allow | `playwright_reply: "allow"` — every Playwright call runs unasked until this reply ends |
//! | **Allow for this chat** | allow | `playwright_chat: true` — every call in this chat, until the chat's switch turns it off |
//! | **Deny** | deny, "The user declined Playwright for now." | `playwright_reply: "deny"` — refused unasked until this reply ends |
//!
//! The turn clears `playwright_reply` when it ends ([`AskDir::end_reply`]),
//! and at its start in case a crash left one behind.
//!
//! A call that cannot show a card is never deferred: a subagent's (the CLI
//! drops a deferral at depth — `ask::decide`'s doc), an aside's or a
//! checkpoint fork's (`side`), and an ephemeral chat's (no session to
//! resume, no ask directory): each runs when the chat or the reply already
//! allows it and is refused in words otherwise.

use super::ask::AskDir;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// The server's name in the MCP config, and so the middle of every tool
/// name: `mcp__playwright__browser_navigate`.
pub const SERVER_NAME: &str = "playwright";

/// Every Playwright tool, as the CLI names it.
pub const TOOL_PREFIX: &str = "mcp__playwright__";

/// The gate's `PreToolUse` matcher.
pub const MATCHER: &str = "mcp__playwright__.*";

/// The pinned package version: npm's `latest` on 2026-10-15, published
/// 2026-09-28 (`external`, `npm view @playwright/mcp time`).
pub const PINNED_VERSION: &str = "0.0.83";

/// What the model reads when he denies — his words for the button
/// (blocker 1413).
pub const DECLINED: &str = "The user declined Playwright for now.";

/// A subagent's call, not covered by the chat or the reply.
pub const SUBAGENT_REFUSED: &str = "a subagent cannot use Playwright until the user allows it: each first use asks the user, which only the main conversation can do — make the call from there, or report what you would have done";

/// An aside's or a checkpoint fork's call, not covered.
pub const SIDE_REFUSED: &str = "Playwright needs the user's approval first, which a side process cannot ask for — leave the browsing to the main conversation";

/// An ephemeral chat's call: nowhere to pause, nothing to resume.
pub const NO_CARD_REFUSED: &str = "Playwright needs the user's approval, which this ephemeral chat cannot ask for — answer without the browser";

/// Whether `tool` is one of Playwright's.
pub fn is_playwright(tool: &str) -> bool {
    tool.starts_with(TOOL_PREFIX)
}

/// Where the package and node live.
#[derive(Debug, Clone, PartialEq)]
pub struct Install {
    /// The node binary that runs the server.
    pub node: PathBuf,
    /// `node_modules/@playwright/mcp/cli.js`.
    pub cli: PathBuf,
}

/// The folder the package is installed into by default:
/// `~/.local/share/nightloom/playwright-mcp` — outside the app bundle (a
/// signed bundle keeps no `node_modules`) and outside `~/.nightloom` (his
/// data). Set `NIGHTLOOM_PLAYWRIGHT_DIR` to move it. WebKit itself lives
/// in Playwright's own cache (`~/Library/Caches/ms-playwright` on macOS).
pub fn default_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("NIGHTLOOM_PLAYWRIGHT_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(d));
    }
    home().map(|h| h.join(".local/share/nightloom/playwright-mcp"))
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

/// Find the install, or `None` — then the chat simply has no Playwright
/// (nothing is listed, nothing to gate). `node` is looked for where a Mac
/// app launched from the Finder can find it, since its `PATH` is the
/// system's: `NIGHTLOOM_NODE`, then Homebrew's two prefixes, then the
/// newest nvm install, then `PATH`.
pub fn locate() -> Option<Install> {
    let dir = default_dir()?;
    let cli = dir.join("node_modules/@playwright/mcp/cli.js");
    if !cli.is_file() {
        return None;
    }
    Some(Install {
        node: find_node()?,
        cli,
    })
}

fn find_node() -> Option<PathBuf> {
    if let Some(n) = std::env::var_os("NIGHTLOOM_NODE").filter(|n| !n.is_empty()) {
        let n = PathBuf::from(n);
        return n.is_file().then_some(n);
    }
    for p in ["/opt/homebrew/bin/node", "/usr/local/bin/node"] {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(p);
        }
    }
    if let Some(n) = home().and_then(|h| newest_nvm_node(&h.join(".nvm/versions/node"))) {
        return Some(n);
    }
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|d| d.join("node"))
            .find(|n| n.is_file())
    })
}

/// The highest `vX.Y.Z/bin/node` under nvm's versions folder.
fn newest_nvm_node(versions: &Path) -> Option<PathBuf> {
    let mut found: Vec<(Vec<u64>, PathBuf)> = std::fs::read_dir(versions)
        .ok()?
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let parts: Option<Vec<u64>> = name
                .trim_start_matches('v')
                .split('.')
                .map(|p| p.parse().ok())
                .collect();
            let node = e.path().join("bin/node");
            Some((parts?, node)).filter(|(_, n)| n.is_file())
        })
        .collect();
    found.sort();
    found.pop().map(|(_, n)| n)
}

/// The server's entry for `--mcp-config`: WebKit, headless, a profile kept
/// in memory, its screenshots and snapshots under `output_dir`.
pub fn server_entry(install: &Install, output_dir: &Path) -> Value {
    serde_json::json!({
        "command": install.node.to_string_lossy(),
        "args": [
            install.cli.to_string_lossy(),
            "--browser", "webkit",
            "--headless",
            "--isolated",
            "--output-dir", output_dir.to_string_lossy(),
        ]
    })
}

/// Give a chat Playwright (backlog 367): its server into `servers` (the
/// `mcpServers` object of the chat's `--mcp-config`) and its gate onto
/// `spec`, the hook being `hook` (`[<this binary>, "--permission-hook"]`).
/// Nothing when the install is not found — the chat then has no Playwright
/// tools to gate. Returns whether it was added.
pub fn add_to(
    spec: &mut super::AgentSpec,
    servers: &mut serde_json::Map<String, Value>,
    hook: Vec<String>,
) -> bool {
    let Some(install) = locate() else {
        return false;
    };
    let out = default_dir()
        .map(|d| d.join("output"))
        .unwrap_or_else(|| std::env::temp_dir().join("nightloom-playwright"));
    servers.insert(SERVER_NAME.into(), server_entry(&install, &out));
    spec.playwright = Some(PlaywrightGate {
        hook,
        dir: PathBuf::new(),
        side: false,
        no_card: false,
    });
    true
}

/// The gate on a spec: the hook and the chat's ask directory, pointed per
/// turn as the Ask position's is.
#[derive(Debug, Clone, PartialEq)]
pub struct PlaywrightGate {
    /// `[<this binary>, "--permission-hook"]`.
    pub hook: Vec<String>,
    /// The chat's ask directory; empty until a turn points it.
    pub dir: PathBuf,
    /// An aside's or a checkpoint fork's process: never defer.
    pub side: bool,
    /// An ephemeral chat: no card, no directory — every call refused.
    pub no_card: bool,
}

/// The hook's extra argument for a side process.
pub const SIDE_ARG: &str = "--side";

/// What follows the hook on its command line: the gate fails closed. The
/// CLI runs a call whose hook exits non-zero with any code but 2 (a
/// "non-blocking error"), so a hook that could not run — its binary gone
/// (127), its input unreadable (1) — would let Playwright run unasked in
/// any position, bypass included; exit 2 blocks the call and hands the
/// model the line on stderr (review of 367, 2026-10-15).
pub const FAIL_CLOSED: &str =
    "|| { echo 'Playwright was not used: its approval check could not run.' >&2; exit 2; }";

impl PlaywrightGate {
    /// The `PreToolUse` entry for the one `--settings` JSON. With no
    /// directory to read (an ephemeral chat, or a spec no turn has pointed)
    /// the entry is a fixed refusal by `echo`, like the Chat policy's —
    /// never the hook on an empty path, which would read no rules and
    /// defer a call nothing can resume.
    pub fn hook_entry(&self) -> Value {
        if self.no_card || self.dir.as_os_str().is_empty() {
            let reply = serde_json::json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": NO_CARD_REFUSED,
                }
            })
            .to_string();
            return serde_json::json!({
                "matcher": MATCHER,
                "hooks": [{ "type": "command", "command": super::chat_policy_command(&reply) }]
            });
        }
        let mut words: Vec<String> = self
            .hook
            .iter()
            .map(|w| super::ask::shell_quote(w))
            .collect();
        words.push(super::ask::shell_quote(&self.dir.to_string_lossy()));
        if self.side {
            words.push(super::ask::shell_quote(SIDE_ARG));
        }
        words.push(FAIL_CLOSED.to_string());
        serde_json::json!({
            "matcher": MATCHER,
            "hooks": [{ "type": "command", "command": words.join(" ") }]
        })
    }
}

/// The text the card shows as the model's reason: the model's last run of
/// text before the call, as it streamed — a tool call or result starts a
/// new run, and an empty run never replaces the one before it (on CLI
/// 2.1.300 the model wrote its reason, then loaded the tool's schema by
/// `ToolSearch`, then called it: M1).
#[derive(Debug, Default, Clone)]
pub struct ReasonTracker {
    last: String,
    current: String,
    fresh: bool,
}

/// The most of the reason the card is given, from its end.
const REASON_MAX: usize = 1200;

impl ReasonTracker {
    pub fn push(&mut self, e: &crate::TurnEvent) {
        match e {
            crate::TurnEvent::TextDelta { text } => {
                if self.fresh {
                    self.current.clear();
                    self.fresh = false;
                }
                self.current.push_str(text);
                if !self.current.trim().is_empty() {
                    self.last.clone_from(&self.current);
                }
            }
            crate::TurnEvent::ToolCall { .. } | crate::TurnEvent::ToolResult { .. } => {
                self.fresh = true;
            }
            _ => {}
        }
    }

    /// The reason, trimmed, its last [`REASON_MAX`] characters.
    pub fn reason(&self) -> Option<String> {
        let t = self.last.trim();
        if t.is_empty() {
            return None;
        }
        let n = t.chars().count();
        Some(if n > REASON_MAX {
            format!("…{}", t.chars().skip(n - REASON_MAX).collect::<String>())
        } else {
            t.to_string()
        })
    }
}

/// The per-chat switch, from the window: on is "Allow for this chat".
pub fn set_for_chat(dir: &Path, on: bool) -> std::io::Result<()> {
    AskDir::new(dir).set_playwright_chat(on)
}

/// Whether the chat allows Playwright without asking.
pub fn for_chat(dir: &Path) -> bool {
    AskDir::new(dir).playwright_chat()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_server_is_webkit_headless_and_isolated_never_chrome() {
        let e = server_entry(
            &Install {
                node: "/n/node".into(),
                cli: "/p/cli.js".into(),
            },
            Path::new("/out"),
        );
        let args: Vec<String> = e["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a.as_str().unwrap().to_string())
            .collect();
        let i = args.iter().position(|a| a == "--browser").unwrap();
        assert_eq!(args[i + 1], "webkit");
        assert!(args.contains(&"--headless".to_string()));
        assert!(args.contains(&"--isolated".to_string()));
        assert!(!args.iter().any(|a| a.contains("chrom")));
        assert_eq!(e["command"], "/n/node");
    }

    #[test]
    fn the_reason_is_the_last_text_before_the_call_across_a_tool_search() {
        use crate::TurnEvent;
        let mut r = ReasonTracker::default();
        r.push(&TurnEvent::TextDelta {
            text: "I'll open the page ".into(),
        });
        r.push(&TurnEvent::TextDelta {
            text: "to read its title.".into(),
        });
        r.push(&TurnEvent::ToolCall {
            id: "1".into(),
            name: "ToolSearch".into(),
            input: Value::Null,
        });
        r.push(&TurnEvent::ToolResult {
            tool_use_id: "1".into(),
            name: "ToolSearch".into(),
            content: String::new(),
            is_error: false,
        });
        assert_eq!(
            r.reason().as_deref(),
            Some("I'll open the page to read its title.")
        );
        r.push(&TurnEvent::TextDelta {
            text: "Now the form.".into(),
        });
        assert_eq!(r.reason().as_deref(), Some("Now the form."));
    }

    #[test]
    fn a_gate_with_no_directory_refuses_by_echo_and_a_side_one_says_so() {
        let mut g = PlaywrightGate {
            hook: vec!["/bin/nl".into(), "--permission-hook".into()],
            dir: PathBuf::new(),
            side: false,
            no_card: false,
        };
        let e = g.hook_entry();
        assert_eq!(e["matcher"], MATCHER);
        let cmd = e["hooks"][0]["command"].as_str().unwrap();
        assert!(cmd.contains("\"deny\"") && cmd.contains("ephemeral"));
        g.dir = "/logs/ask/c1".into();
        let cmd = g.hook_entry()["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(
            cmd,
            format!("'/bin/nl' '--permission-hook' '/logs/ask/c1' {FAIL_CLOSED}")
        );
        g.side = true;
        let cmd = g.hook_entry()["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(cmd.ends_with(&format!("'--side' {FAIL_CLOSED}")));
        g.no_card = true;
        assert!(
            g.hook_entry()["hooks"][0]["command"]
                .as_str()
                .unwrap()
                .contains("\"deny\"")
        );
    }

    /// The gate fails closed (review of 367): a hook that cannot run —
    /// here its binary is missing, exit 127 — exits 2, the CLI's "block",
    /// never another code, which the CLI would treat as a non-blocking
    /// error and run the call.
    #[cfg(unix)]
    #[test]
    fn a_hook_that_cannot_run_blocks_the_call() {
        let g = PlaywrightGate {
            hook: vec![
                "/nonexistent/nightloom-desktop".into(),
                "--permission-hook".into(),
            ],
            dir: "/logs/ask/c1".into(),
            side: false,
            no_card: false,
        };
        let cmd = g.hook_entry()["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .to_string();
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(&cmd)
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(2), "{cmd}");
        assert!(String::from_utf8_lossy(&out.stderr).contains("Playwright was not used"));
        // A hook that answered exits 0 and is passed through as it was.
        let ok = format!("true {FAIL_CLOSED}");
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(&ok)
            .output()
            .unwrap();
        assert_eq!(out.status.code(), Some(0));
    }

    #[test]
    fn newest_nvm_node_picks_the_highest_version() {
        let root = std::env::temp_dir().join(format!("nl-nvm-{}", std::process::id()));
        for v in ["v18.20.1", "v20.19.2", "v9.0.0"] {
            let bin = root.join(v).join("bin");
            std::fs::create_dir_all(&bin).unwrap();
            std::fs::write(bin.join("node"), b"").unwrap();
        }
        assert_eq!(newest_nvm_node(&root), Some(root.join("v20.19.2/bin/node")));
        let _ = std::fs::remove_dir_all(&root);
    }
}
