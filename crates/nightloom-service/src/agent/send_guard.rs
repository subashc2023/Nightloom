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

/// The tool names (after the server's `__`) that send, `|`-joined.
macro_rules! send_tools {
    () => {
        "send_message|send_email|send_mail|send_draft|send|reply|reply_all|forward|respond_to_event"
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
pub const REFUSED: &str = "Not sent: mail and invitation answers go out only on his own click, never by a decision of yours. Say what you would send and to whom; he can send it from the card of that item in the reply, or approve it in a chat set to Ask.";

/// What a subagent or a side process reads in an asking chat: its call
/// cannot wait on a card.
pub const NO_CARD: &str = "Not sent: mail and invitation answers go out only on his own click, and only the main conversation can ask him. Report what you would send and to whom.";

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
    ];

    const NOT_SENDS: &[&str] = &[
        "mcp__claude_ai_Gmail__create_draft",
        "mcp__claude_ai_Gmail__get_message",
        "mcp__claude_ai_Gmail__search_threads",
        "mcp__claude_ai_Gmail__reply_later_list",
        "mcp__claude_ai_Google_Calendar__get_event",
        "mcp__claude_ai_Google_Calendar__update_event",
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

    #[test]
    fn the_refusals_survive_the_shell_quoting() {
        for s in [REFUSED, NO_CARD] {
            assert!(!s.contains(['\'', '&', '|', '<', '>', '^', '%']), "{s}");
        }
    }
}
