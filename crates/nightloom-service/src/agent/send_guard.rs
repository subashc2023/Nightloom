//! The sends: connector tools that reach other people and cannot be taken
//! back — a mail sent, replied to or forwarded, an answer to an invitation
//! (nightshift item 993d; blocker 2304, his words: "no autonomous decisions
//! made on sending forwarding replying none of that. should be expclitly
//! blocked").
//!
//! **The rule, in code and in every position:** one of these runs only on
//! his own click, for that one call —
//!
//! - his click in an item's card (`crate::ref_action`): a one-time pass,
//!   read only by the card's own one-shot process;
//! - his answer on this very call's approval card (the Ask and Plan
//!   positions, [`super::ask::decide_send`]; Home's gated card for an
//!   invitation, `connector_writes::HOME_GATED_MATCHER`).
//!
//! Nothing else lets one through: no standing rule ("Allow for this chat",
//! an every-chat allow), no *subagents run on auto*, no classifier (the
//! Auto position), no bypass. Where his connectors are loaded and no card
//! of his can answer — Auto, bypass, a fork, a job, a process with no hook
//! program — the call is refused by an `echo` entry on [`MATCHER`], so no
//! program of Nightloom's has to be found for the refusal to hold. (A
//! process with the connectors off has none of their tools to call, and
//! its settings carry no entry; a send tool on a server of his own, in a
//! position that does not ask, is the one case this leaves to that
//! position.) A read-only chat already
//! refuses every one of these by `connector_writes` (they are known
//! writes), and that stands.
//!
//! By the tool's own name, on any server but Nightloom's: a `reply` or a
//! `send_message` on a connector not yet seen is still a send.
//!
//! **Beyond mail (993d review, blocker 2346, default applied under his
//! 2304 rule — "for all things that cannot be reverted and affect other
//! ppl"):** an event created, changed or deleted (Calendar mails its
//! guests an invitation, an update or a cancellation) and a file shared
//! (Drive tells the person) are sends too. The name cannot say whether an
//! event has guests, so every one is held: an Auto chat with his
//! connectors on no longer makes events or shares files by itself.
//!
//! **A nested `claude` (blocker 2347):** where the sends are refused, a
//! chat with the shell could still start `claude -p …` itself — a process
//! with his connectors and none of these hooks. [`CLAUDE_IN_SHELL`] refuses
//! a `Bash` call that runs `claude`. **It is a string match over the
//! call's input, not airtight**: `c""laude`, a variable, a script file, an
//! alias or another language's `exec` all pass it. It closes the plain
//! spellings (`claude -p`, `claude --print`, `/path/to/claude`, `npx
//! @anthropic-ai/claude-code`) and is meant as a tripwire, not a wall.

/// The tool names (after the server's `__`) that send, `|`-joined.
macro_rules! send_tools {
    () => {
        "send_message|send_email|send_mail|send_draft|send|reply|reply_all|forward|respond_to_event|create_event|update_event|delete_event|share_file"
    };
}

/// The `PreToolUse` matcher (a JavaScript pattern, the CLI's): one of the
/// sends, on any server but Nightloom's own.
pub const MATCHER: &str = concat!(
    "^mcp__(?!nightloom__)(?:(?!__).)+__(?:",
    send_tools!(),
    ")$"
);

/// The sends, as words.
pub const SEND_TOOLS: &str = send_tools!();

/// Whether `name` is one of the sends — [`MATCHER`] in Rust.
pub fn sends(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("mcp__") else {
        return false;
    };
    if rest.starts_with("nightloom__") {
        return false;
    }
    let Some(i) = rest.find("__") else {
        return false;
    };
    i > 0 && SEND_TOOLS.split('|').any(|t| t == &rest[i + 2..])
}

/// What the model reads where no card of his can answer. No `'` (the
/// reply is single-quoted for the shell) and none of `cmd`'s `&|<>^%`.
pub const REFUSED: &str = "Not done: mail, invitation answers, events (their guests are told) and shared files reach other people, so they go out only on his own click, never by a decision of yours. Say what you would send or change and for whom; he can do it from the card of that item in the reply, or approve it in a chat set to Ask.";

/// What a subagent or a side process reads in an asking chat: its call
/// cannot wait on a card.
pub const NO_CARD: &str = "Not done: mail, invitation answers, events and shared files reach other people, so they go out only on his own click, and only the main conversation can ask him. Report what you would send or change and for whom.";

/// The `Bash` tool's matcher for [`CLAUDE_IN_SHELL`].
pub const SHELL_MATCHER: &str = "^Bash$";

/// A `claude` started from the shell, as a POSIX extended regular
/// expression over the hook's stdin (the call's JSON): `claude` or
/// `claude-code` in a command's place — at the start, after `;` `&` `|`
/// `(` a quote, a backquote, `$(`, an escaped newline or tab, or after
/// `sudo` `env` `exec` `nohup` `time` `command` `xargs` `npx` `bunx`
/// `pnpx` (with variable assignments and flags between) — maybe behind a
/// path, and followed by a space, a separator, a quote or the end. A
/// string match, not airtight (the module's note).
pub const CLAUDE_IN_SHELL: &str = concat!(
    "(^|[;&|(`\"']|\\$\\(|\\\\[nt]|",
    "(sudo|env|exec|nohup|time|command|xargs|npx|bunx|pnpx)[[:space:]]+",
    "([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+|-[^[:space:]]*[[:space:]]+)*)",
    "[[:space:]]*",
    "([^[:space:];&|`\"'()]*/)?",
    "claude(-code)?",
    "([[:space:];&|)`\"']|\\\\|$)"
);

/// What the model reads when the shell would start `claude`.
pub const NO_NESTED_CLAUDE: &str = "Not run: starting Claude Code from the shell is refused here, because a nested claude would carry his connectors past the rule that mail, invitation answers, events and shares go out only on his own click. Do the work in this conversation instead.";

/// The hook command for [`SHELL_MATCHER`]: `grep` the call's JSON for
/// [`CLAUDE_IN_SHELL`] and print the refusal on a hit; otherwise print
/// nothing (no decision). `None` on Windows, which has no `grep`
/// (`inferred`; the entry is left out there).
pub fn shell_command() -> Option<String> {
    #[cfg(windows)]
    {
        None
    }
    #[cfg(not(windows))]
    {
        let reply = serde_json::json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": NO_NESTED_CLAUDE,
            }
        })
        .to_string();
        Some(format!(
            "grep -qE {} && echo {} || true",
            sh_quote(CLAUDE_IN_SHELL),
            sh_quote(&reply)
        ))
    }
}

/// `s` single-quoted for `sh`.
#[cfg(not(windows))]
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SENDS: &[&str] = &[
        "mcp__claude_ai_Gmail__send_message",
        "mcp__claude_ai_Gmail__reply",
        "mcp__claude_ai_Gmail__forward",
        "mcp__claude_ai_Gmail_2117773e__reply",
        "mcp__claude_ai_Google_Calendar__respond_to_event",
        "mcp__2117773e-1eb9-41d3-b80c-93e38c29d7ba__send_message",
        "mcp__someserver__send",
        "mcp__claude_ai_Slack__send_message",
        "mcp__claude_ai_Google_Calendar__create_event",
        "mcp__claude_ai_Google_Calendar__update_event",
        "mcp__claude_ai_Google_Calendar__delete_event",
        "mcp__974e51a6-301c-40bc-bf37-bdfd1f4cd8e7__create_event",
        "mcp__claude_ai_Google_Drive__share_file",
    ];

    const NOT_SENDS: &[&str] = &[
        "mcp__claude_ai_Gmail__create_draft",
        "mcp__claude_ai_Gmail__get_message",
        "mcp__claude_ai_Gmail__search_threads",
        "mcp__claude_ai_Gmail__reply_later_list",
        "mcp__claude_ai_Google_Calendar__get_event",
        "mcp__claude_ai_Google_Calendar__list_events",
        "mcp__claude_ai_Google_Calendar__suggest_time",
        "mcp__claude_ai_Google_Drive__get_file_permissions",
        "mcp__claude_ai_Google_Drive__create_file",
        "mcp__nightloom__create_event",
        "mcp__nightloom__send_file",
        "mcp__nightloom__send_feedback",
        "mcp__nightloom__reply",
        "mcp____reply",
        "reply",
        "Bash",
    ];

    #[test]
    fn mail_sends_and_invitation_answers_are_sends_and_nothing_else_is() {
        for n in SENDS {
            assert!(sends(n), "{n}");
        }
        for n in NOT_SENDS {
            assert!(!sends(n), "{n}");
        }
    }

    /// Every send the read-only chat's table names is a send here, so the
    /// two lists cannot drift apart on Gmail's or Calendar's own tools.
    #[test]
    fn the_connector_tables_senders_are_all_sends() {
        for (_, name, _) in crate::agent::connector_writes::TABLE {
            let tool = name.rsplit("__").next().unwrap_or("");
            if matches!(
                tool,
                "send_message" | "reply" | "forward" | "respond_to_event"
            ) {
                assert!(sends(name), "{name}");
                assert!(
                    crate::agent::connector_writes::known_write(name),
                    "a read-only chat refuses it too: {name}"
                );
            }
        }
    }

    /// The JavaScript pattern the CLI reads agrees with [`sends`]. Skipped,
    /// loudly, where `node` is not on the PATH.
    #[test]
    fn the_cli_pattern_agrees_with_sends_in_javascript() {
        let names: Vec<&str> = SENDS.iter().chain(NOT_SENDS).copied().collect();
        let script = format!(
            "const m=new RegExp({m});console.log(JSON.stringify({n}.map(x=>m.test(x))));",
            m = serde_json::to_string(MATCHER).unwrap(),
            n = serde_json::to_string(&names).unwrap(),
        );
        let out = match std::process::Command::new("node")
            .arg("-e")
            .arg(&script)
            .output()
        {
            Ok(o) if o.status.success() => o,
            Ok(o) => panic!("node failed: {}", String::from_utf8_lossy(&o.stderr)),
            Err(e) => {
                eprintln!("SKIPPED: node not runnable here ({e})");
                return;
            }
        };
        let got: Vec<bool> = serde_json::from_slice(&out.stdout).unwrap();
        for (name, hit) in names.iter().zip(got) {
            assert_eq!(hit, sends(name), "matcher on {name}");
        }
    }

    /// The shell tripwire, run as the CLI runs it (`sh -c`, the call's
    /// JSON on stdin): a `claude` started from the shell is refused, the
    /// word in a path, a message or a file name is not. Skipped, loudly,
    /// where `sh` or `grep` is missing.
    #[cfg(not(windows))]
    #[test]
    fn the_shell_tripwire_refuses_a_nested_claude_and_little_else() {
        let command = shell_command().expect("a command off Windows");
        let run = |cmd: &str| -> Option<bool> {
            use std::io::Write;
            let stdin = serde_json::json!({
                "tool_name": "Bash",
                "tool_use_id": "t1",
                "cwd": "/Users/x/Projects/Nightloom",
                "transcript_path": "/Users/x/.claude/projects/-Users-x-claude-notes/s.jsonl",
                "tool_input": { "command": cmd, "description": "Run it" }
            })
            .to_string();
            let mut child = std::process::Command::new("sh")
                .arg("-c")
                .arg(&command)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .spawn()
                .ok()?;
            child.stdin.take()?.write_all(stdin.as_bytes()).ok()?;
            let out = child.wait_with_output().ok()?;
            assert!(out.status.success(), "the hook exits 0: {cmd}");
            let text = String::from_utf8_lossy(&out.stdout);
            if text.trim().is_empty() {
                return Some(false);
            }
            let v: serde_json::Value = serde_json::from_str(text.trim()).expect("one JSON reply");
            assert_eq!(v["hookSpecificOutput"]["permissionDecision"], "deny");
            assert_eq!(
                v["hookSpecificOutput"]["permissionDecisionReason"],
                NO_NESTED_CLAUDE
            );
            Some(true)
        };
        let refused = [
            "claude -p 'send the mail'",
            "claude --print hi",
            "claude",
            "/usr/local/bin/claude -p x",
            "~/.local/bin/claude -p x",
            "cd /tmp && claude -p x",
            "ls; claude -p x",
            "echo hi | claude -p",
            "(claude -p x)",
            "out=$(claude -p x)",
            "env FOO=1 claude -p x",
            "nohup claude -p x &",
            "sudo -E claude -p x",
            "npx @anthropic-ai/claude-code -p x",
            "npx -y @anthropic-ai/claude-code -p x",
            "bash -c \"claude -p x\"",
            "sh -c 'claude -p x'",
            "true\nclaude -p x",
            "`claude -p x`",
        ];
        let let_through = [
            "ls ~/.claude",
            "cat ~/.claude/settings.json",
            "grep -rn claude src",
            "which -a node",
            "git commit -m 'claude: notes'",
            "ls /tmp/claude-scratch",
            "cargo test -p nightloom-service",
            "npm run check",
            "rg claudette",
            "echo claude_ai_Gmail",
        ];
        for cmd in refused {
            let Some(hit) = run(cmd) else {
                eprintln!("SKIPPED: sh not runnable here");
                return;
            };
            assert!(hit, "refused: {cmd}");
        }
        for cmd in let_through {
            assert_eq!(run(cmd), Some(false), "let through: {cmd}");
        }
    }

    /// The window's list (`apps/desktop/src/lib/sendGuard.ts`, which hides
    /// a standing allow on a send's card) is this one.
    #[test]
    fn the_windows_send_list_is_this_one() {
        let ts = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../apps/desktop/src/lib/sendGuard.ts");
        let Ok(text) = std::fs::read_to_string(&ts) else {
            eprintln!("SKIPPED: {} not here", ts.display());
            return;
        };
        assert!(
            text.contains(&format!("SEND_TOOLS = \"{SEND_TOOLS}\";")),
            "sendGuard.ts must name exactly {SEND_TOOLS}"
        );
    }

    #[test]
    fn the_refusals_survive_the_shell_quoting() {
        for s in [REFUSED, NO_CARD, NO_NESTED_CLAUDE] {
            assert!(!s.contains(['\'', '&', '|', '<', '>', '^', '%']), "{s}");
        }
    }
}
