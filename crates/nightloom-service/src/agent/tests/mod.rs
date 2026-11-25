use super::*;

mod modes;
mod turns;

use modes::{asking, matcher_of};

/// Two asides at once (backlog 176): × on one stops that one only, and
/// an exchange that ended is no longer reachable — its `seq` cancels
/// nothing. Before this the app had one token for every aside.
#[test]
fn a_cancel_stops_the_aside_it_names_and_no_other() {
    let cancels = AsideCancels::default();
    let first = cancels.begin(1);
    let second = cancels.begin(2);
    assert_eq!(cancels.len(), 2);
    assert!(cancels.cancel(2));
    assert!(second.token().is_cancelled());
    assert!(!first.token().is_cancelled(), "the other aside runs on");
    drop(second);
    assert_eq!(cancels.len(), 1);
    assert!(!cancels.cancel(2), "an ended aside is not reachable");
    assert!(!first.token().is_cancelled());
    assert!(cancels.cancel(1));
    assert!(first.token().is_cancelled());
    drop(first);
    assert!(cancels.is_empty());
}

/// A reused `seq` cancels the registration it replaces, and the old
/// guard's drop leaves the new one in place.
#[test]
fn a_replaced_aside_is_cancelled_and_its_guard_leaves_the_new_one() {
    let cancels = AsideCancels::default();
    let old = cancels.begin(7);
    let new = cancels.begin(7);
    assert!(old.token().is_cancelled());
    drop(old);
    assert_eq!(cancels.len(), 1);
    assert!(cancels.cancel(7));
    assert!(new.token().is_cancelled());
}

/// Backlog 341: a Send now's row says the step was stopped only when
/// the CLI aborted it before taking the message; a CLI that ignored
/// `priority: "now"` reads "after <call>" as any other.
#[test]
fn a_send_now_says_stopping_only_on_an_aborted_call() {
    // Measured (promote2): the Bash aborted, the first command's
    // result, then the message started.
    assert_eq!(
        delivered_after(true, Some("Bash"), true, Some("Bash")),
        "at once, stopping Bash"
    );
    // No abort seen: nothing was stopped.
    assert_eq!(
        delivered_after(true, None, false, Some("Bash")),
        "after Bash"
    );
    assert_eq!(
        delivered_after(true, None, true, Some("Bash")),
        "after the reply"
    );
    assert_eq!(delivered_after(true, None, false, None), "at the start");
    // A plain message never claims a stop, abort or not.
    assert_eq!(
        delivered_after(false, Some("Bash"), false, Some("Bash")),
        "after Bash"
    );
    assert!(is_aborted(
        "<error>Command was aborted before completion</error>",
        true
    ));
    assert!(!is_aborted("exit code 1", true));
    assert!(!is_aborted("the job was aborted", false));
}

fn spec() -> AgentSpec {
    AgentSpec::new("/work")
}

/// Since items 697 + 698 every `--settings` carries the chart plugin's
/// off switch: "nothing else to set" is now a JSON with that key alone.
fn settings_hold_only_the_plugin_switch(a: &[String]) -> bool {
    let Some(i) = a.iter().position(|x| x == "--settings") else {
        return false;
    };
    let s: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
    s.as_object()
        .is_some_and(|o| o.len() == 1 && o.contains_key("enabledPlugins"))
}

/// Items 697 + 698: the CLI's chart plugin is off in every shape that
/// reads the chat's cache — the turn, the stdin turn, the aside, the
/// keep-warm ping, the checkpoint fork — so its racy prompt line can
/// never make one shape's prefix differ from another's.
#[test]
fn the_cli_chart_plugin_is_off_in_every_shape() {
    let plugins_of = |a: &[String]| -> serde_json::Value {
        let i = a
            .iter()
            .position(|x| x == "--settings")
            .expect("--settings");
        let s: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
        s["enabledPlugins"].clone()
    };
    let want = serde_json::json!({ "cc-plugin-easel@builtin": false, "easel@builtin": false });
    let mut chat = spec();
    chat.resume = Some("parent-1".into());
    chat.fork_mode = true;
    assert_eq!(plugins_of(&spec().args("hi")), want);
    assert_eq!(plugins_of(&chat.args("hi")), want);
    assert_eq!(plugins_of(&chat.stdin_args()), want);
    assert_eq!(plugins_of(&chat.aside().unwrap().args("q")), want);
    assert_eq!(plugins_of(&chat.keep_warm_ping().unwrap().args("q")), want);
    assert_eq!(plugins_of(&chat.checkpoint_fork().unwrap().args("t")), want);
    // The --settings the turn and its side shapes send differ only in
    // what a side process must not run (hooks), never in this key.
    assert_eq!(
        plugins_of(&chat.args("hi")),
        plugins_of(&chat.aside().unwrap().args("q"))
    );
}

/// Backlog 235: every spec starts with his claude.ai connectors off —
/// the CLI's switch in the environment, on the turn and on the
/// checkpoint fork alike, and no tool rule on argv. On drops the
/// variable, and the connectors he unticked become server rules.
#[test]
fn claude_ai_connectors_are_off_unless_the_chat_says_on() {
    let has_off = |env: &[(String, String)]| {
        env.iter()
            .any(|(k, v)| k == connectors::ENV_VAR && v == "false")
    };
    let env_of = |s: &AgentSpec| -> Vec<(String, String)> {
        s.env_set()
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect()
    };
    let off = spec();
    assert!(!off.claude_ai_connectors);
    assert!(has_off(&env_of(&off)));
    assert!(!off.args("hi").iter().any(|x| x == "--disallowedTools"));
    // A pass (dream, capture, note edit, chat name) has no switch at all.
    let pass = PassSpec::new("claude", Vec::new()).spec_in("/w");
    assert!(has_off(&env_of(&pass)));
    // The checkpoint fork runs with the same environment as its turn.
    let mut resumed = spec();
    resumed.resume = Some("s-1".into());
    assert!(has_off(&resumed.fork_spec().unwrap().env));
    // Blocked names mean nothing while off.
    let mut still_off = spec();
    still_off.claude_ai_blocked = vec!["claude.ai Google Drive".into()];
    assert!(
        !still_off
            .args("hi")
            .iter()
            .any(|x| x == "--disallowedTools")
    );

    let mut on = spec();
    on.claude_ai_connectors = true;
    assert!(!has_off(&env_of(&on)));
    assert!(!on.env_set().iter().any(|(k, _)| *k == connectors::ENV_VAR));
    assert!(!on.args("hi").iter().any(|x| x == "--disallowedTools"));
    on.claude_ai_blocked = vec!["claude.ai Google Drive".into(), "openalex".into()];
    let a = on.args("hi");
    let i = a.iter().position(|x| x == "--disallowedTools").unwrap();
    assert_eq!(a[i + 1], "mcp__claude_ai_Google_Drive", "{a:?}");
    assert!(a[i + 2].starts_with("--"), "{a:?}");
    assert!(!a.iter().any(|x| x == "mcp__openalex"), "{a:?}");
    // The fork is the chat's prefix, so it hides the same connectors.
    on.resume = Some("s-1".into());
    assert!(
        on.fork_spec()
            .unwrap()
            .argv
            .iter()
            .any(|x| x == "mcp__claude_ai_Google_Drive")
    );
}

/// Item 758: a new session's reminders go in its first user message —
/// the switch on a process that starts a session, its forks and its
/// warm process alike — and never on a session that began without it,
/// which switching would re-render and re-write in full.
#[test]
fn a_new_session_sends_its_reminders_in_the_user_message() {
    let caps = |s: &AgentSpec| -> Option<String> {
        s.env_set()
            .into_iter()
            .find(|(k, _)| *k == flat::CAPS_ENV)
            .map(|(_, v)| v)
    };
    let fresh = spec();
    assert!(fresh.flat_reminders());
    assert!(caps(&fresh).unwrap().ends_with(flat::MID_CONV_OFF));
    // The waiting process carries it, so the first turn can take it.
    let key = warm::Key::of(&fresh, &fresh.stdin_args());
    assert!(
        key.differs_in(&warm::Key::of(&fresh, &fresh.stdin_args()))
            .is_empty()
    );
    // A session this machine never marked (every chat before 758).
    let mut old = spec();
    old.resume = Some("never-marked-758".into());
    assert!(!old.flat_reminders());
    assert_eq!(caps(&old), None);
    assert!(
        !old.fork_spec()
            .unwrap()
            .env
            .iter()
            .any(|(k, _)| k == flat::CAPS_ENV)
    );
}

/// Backlog 353: the Browser switch is off on every spec and says so on
/// argv (`--no-chrome`), on every shape; on is `--chrome` and never both.
/// The checkpoint fork carries the chat's spelling.
#[test]
fn browser_is_no_chrome_unless_the_chat_says_on() {
    let has = |a: &[String], f: &str| a.iter().any(|x| x == f);
    let off = spec();
    assert!(!off.browser);
    for a in [off.args("hi"), off.stdin_args(), off.resume_args()] {
        assert!(has(&a, "--no-chrome"), "{a:?}");
        assert!(!has(&a, "--chrome"), "{a:?}");
    }
    // A pass (dream, capture, note edit, chat name) has no switch at all.
    let pass = PassSpec::new("claude", Vec::new()).spec_in("/w");
    assert!(has(&pass.args("hi"), "--no-chrome"));
    assert!(!has(&pass.args("hi"), "--chrome"));

    let mut on = spec();
    on.browser = true;
    for a in [on.args("hi"), on.stdin_args(), on.resume_args()] {
        assert!(has(&a, "--chrome"), "{a:?}");
        assert!(!has(&a, "--no-chrome"), "{a:?}");
    }
    // Under safe mode too: measured, `--strict-mcp-config` keeps it.
    on.safe_mode = true;
    assert!(has(&on.args("hi"), "--chrome"));
    on.resume = Some("s-1".into());
    assert!(has(&on.fork_spec().unwrap().argv, "--chrome"));
    let mut off_resumed = spec();
    off_resumed.resume = Some("s-1".into());
    assert!(has(&off_resumed.fork_spec().unwrap().argv, "--no-chrome"));
}

/// Backlog 353, blocker 1414: a Chat with the Browser on refuses the
/// browser's tools by a deny hook beside the policy's (which lets every
/// `mcp__` tool through); without the browser there is no such entry.
#[test]
fn a_chat_refuses_the_browser_tools_by_hook() {
    let entries = |s: &AgentSpec| -> Vec<serde_json::Value> {
        let a = s.args("hi");
        let Some(i) = a.iter().position(|x| x == "--settings") else {
            return Vec::new();
        };
        let v: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
        v["hooks"]["PreToolUse"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    };
    let mut chat = spec();
    chat.chat_policy = true;
    assert!(
        !entries(&chat)
            .iter()
            .any(|e| e["matcher"] == BROWSER_TOOLS_MATCHER)
    );
    chat.browser = true;
    let pre = entries(&chat);
    let e = pre
        .iter()
        .find(|e| e["matcher"] == BROWSER_TOOLS_MATCHER)
        .expect("browser deny entry");
    let command = e["hooks"][0]["command"].as_str().unwrap();
    let reply = command.trim_start_matches("echo ").trim_matches('\'');
    let v: serde_json::Value = serde_json::from_str(reply).unwrap();
    assert_eq!(v["hookSpecificOutput"]["permissionDecision"], "deny");
    assert_eq!(
        v["hookSpecificOutput"]["permissionDecisionReason"],
        BROWSER_UNDER_CHAT_POLICY_REASON
    );
    assert!(!reply.contains(['&', '|', '<', '>', '^', '%']), "{reply}");
    // Not a Chat: the browser's calls go to the Ask hook like any MCP
    // tool, with no deny of their own.
    let mut code = spec();
    code.browser = true;
    assert!(
        !entries(&code)
            .iter()
            .any(|e| e["matcher"] == BROWSER_TOOLS_MATCHER)
    );
    assert!(regex_like_matches(
        ask::MATCHER,
        "mcp__claude-in-chrome__navigate"
    ));

    // Review: beside the Ask hook, a Chat's Ask entry no longer names
    // the browser's tools — both entries matching would show an
    // approval card for a call the deny entry has already refused
    // (backlog 147). Nightloom's own server still asks.
    chat.ask = Some(AskSpec {
        hook: vec!["/app/nightloom-desktop".into(), "--permission-hook".into()],
        dir: PathBuf::from("/logs/ask/chat-1"),
        mode: AskMode::Ask,
        subagents_auto: true,
    });
    let pre = entries(&chat);
    let asks: Vec<&str> = pre
        .iter()
        .filter_map(|e| e["matcher"].as_str())
        .filter(|m| {
            *m != CHAT_POLICY_MATCHER
                && *m != BROWSER_TOOLS_MATCHER
                && *m != PREVIEW_TOOL_MATCHER
                && *m != connector_writes::MATCHER
                && *m != connector_writes::KNOWN_WRITES_MATCHER
                && *m != connector_writes::CARD_MATCHER
        })
        .collect();
    assert_eq!(
        asks,
        [format!(
            "WebFetch|WebSearch|mcp__(?!claude-in-chrome__|playwright__|nightloom__preview|nightloom__add_folder|nightloom__request_secret|nightloom__ask_user_to_drive|{}).*",
            connector_writes::ASK_EXCLUSION_WITH_CARD
        )],
        "{pre:?}"
    );
    // Item 430: the preview is the policy's to refuse, not the Ask
    // card's; the rest of Nightloom's server still asks.
    assert!(!regex_like_matches(asks[0], "mcp__nightloom__preview"));
    // (Item 783: `remember` is the read-only entry's to ask about.)
    assert!(asks[0].contains("nightloom__remember$"));
    assert!(regex_like_matches(asks[0], "mcp__nightloom__send_file"));
    assert!(regex_like_matches(
        PREVIEW_TOOL_MATCHER,
        "mcp__nightloom__preview"
    ));
    chat.browser = false;
    let pre = entries(&chat);
    assert!(
        pre.iter()
            .any(|e| e["matcher"]
                == format!(
                    "WebFetch|WebSearch|mcp__(?!playwright__|nightloom__preview|nightloom__add_folder|nightloom__request_secret|nightloom__ask_user_to_drive|{}).*",
                    connector_writes::ASK_EXCLUSION_WITH_CARD
                )),
        "{pre:?}"
    );
}

/// The Ask matcher's `mcp__.*` alternative covers a browser tool name.
/// Understands the two shapes the matchers use: `prefix.*`, and
/// `prefix(?!a|b).*` (a negative lookahead after the prefix).
fn regex_like_matches(matcher: &str, name: &str) -> bool {
    // Split on `|` outside parentheses.
    let mut alts: Vec<String> = vec![String::new()];
    let mut depth = 0;
    for c in matcher.chars() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            '|' if depth == 0 => {
                alts.push(String::new());
                continue;
            }
            _ => {}
        }
        alts.last_mut().unwrap().push(c);
    }
    alts.iter().any(|alt| match alt.strip_suffix(".*") {
        Some(p) => match p.split_once("(?!") {
            Some((head, negs)) => {
                // Several lookaheads in a row read as one alternation
                // (item 613's second one).
                let negs = negs.replace(")(?!", "|");
                name.starts_with(head)
                    && !negs
                        .trim_end_matches(')')
                        .split('|')
                        .any(|n| name[head.len()..].starts_with(n))
            }
            None => name.starts_with(p),
        },
        None => alt == name,
    })
}

/// Every turn needs these three together: `stream-json` is what this
/// module parses, `--verbose` is what the CLI requires beside it, and
/// partial messages are what make the reply stream rather than land.
#[test]
fn streaming_flags_are_always_present() {
    let a = spec().args("hi");
    assert_eq!(a[0], "-p");
    assert_eq!(a[1], "hi");
    for flag in [
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--forward-subagent-text",
    ] {
        assert!(a.iter().any(|x| x == flag), "missing {flag} in {a:?}");
    }
    // On every shape, the resume included: a subagent may be mid-turn
    // when a deferred call is resumed.
    assert!(
        spec()
            .stdin_args()
            .iter()
            .any(|x| x == "--forward-subagent-text")
    );
    assert!(
        spec()
            .resume_args()
            .iter()
            .any(|x| x == "--forward-subagent-text")
    );
}

/// The empty tool set is an empty string, not an omitted flag — omitted
/// leaves the CLI's whole default set switched on.
#[test]
fn no_tools_is_an_empty_string_argument() {
    let mut s = spec();
    s.tools = Some(vec![]);
    let a = s.args("hi");
    let i = a.iter().position(|x| x == "--tools").expect("--tools");
    assert_eq!(a[i + 1], "");
}

/// The record switch (nightshift backlog 174): absent by default, the
/// CLI's own default; `off` only when a chat has taken a newer layer.
#[test]
fn the_prompt_snapshot_goes_off_only_when_asked() {
    assert!(
        !spec()
            .args("hi")
            .iter()
            .any(|x| x == "--system-prompt-snapshot")
    );
    let mut s = spec();
    s.system_prompt_snapshot_off = true;
    let a = s.args("hi");
    let i = a
        .iter()
        .position(|x| x == "--system-prompt-snapshot")
        .expect("the flag");
    assert_eq!(a[i + 1], "off");
}

/// Item 543's check 6: a chat bound to a research thread mid-chat is
/// resumed with the thread's layer on the flag **and** the snapshot off
/// — the pair `connect_agent` sets after `prompt_hold::resolve` takes
/// the Thread layer (the desktop's
/// `a_thread_bound_mid_chat_is_taken_now_and_turns_the_snapshot_off`).
/// With the snapshot on, the CLI would reuse the prompt recorded on the
/// conversation's first turn and the layer would never reach it (174).
#[test]
fn a_thread_bound_mid_chat_reaches_the_resumed_cli() {
    let mut s = spec();
    s.resume = Some("cli-session-1".into());
    s.append_system_prompt = Some("preamble\n\nTHREAD alpha: start here".into());
    s.system_prompt_snapshot_off = true;
    let a = s.args("next message");
    let at = |flag: &str| a.iter().position(|x| x == flag).map(|i| a[i + 1].clone());
    assert_eq!(at("--resume").as_deref(), Some("cli-session-1"));
    assert!(at("--append-system-prompt").is_some_and(|p| p.contains("THREAD alpha: start here")));
    assert_eq!(at("--system-prompt-snapshot").as_deref(), Some("off"));
}

#[test]
fn a_named_tool_set_is_passed_variadically() {
    let mut s = spec();
    s.tools = Some(vec!["Read".into(), "Grep".into()]);
    s.allowed_tools = vec!["Read".into()];
    let a = s.args("hi");
    let i = a.iter().position(|x| x == "--tools").unwrap();
    assert_eq!(&a[i + 1..i + 3], ["Read", "Grep"]);
    let j = a.iter().position(|x| x == "--allowedTools").unwrap();
    assert_eq!(a[j + 1], "Read");
}

/// Leaving `tools` unset must not smuggle the flag in — that is the
/// difference between the CLI's defaults and a tool set we chose.
/// Backlog 307: a NUL anywhere in argv aborts the spawn ("nul byte found
/// in provided data"), so none survives into it, from any field.
#[test]
fn no_argument_carries_a_nul() {
    let mut s = spec();
    s.append_system_prompt = Some("files/a.pptx — PK\u{3}\u{4}\0\0 tail".into());
    s.system_prompt = Some("x\0y".into());
    let a = s.args("hi\0there");
    assert!(a.iter().all(|x| !x.contains('\0')), "{a:?}");
    assert!(
        a.iter().any(|x| x == "files/a.pptx — PK\u{3}\u{4} tail"),
        "{a:?}"
    );
    assert!(a.iter().any(|x| x == "xy"), "{a:?}");
}

#[test]
fn unset_tools_omits_the_flag() {
    assert!(!spec().args("hi").iter().any(|x| x == "--tools"));
}

#[test]
fn optional_flags_appear_only_when_set() {
    let bare = spec().args("hi");
    for flag in [
        "--model",
        "--setting-sources",
        "--resume",
        "--max-budget-usd",
        "--system-prompt",
    ] {
        assert!(
            !bare.iter().any(|x| x == flag),
            "{flag} leaked into {bare:?}"
        );
    }
    let mut s = spec();
    s.model = Some("haiku".into());
    s.safe_mode = true;
    s.resume = Some("abc".into());
    s.max_budget_usd = Some(0.5);
    s.system_prompt = Some("be terse".into());
    let a = s.args("hi");
    for flag in [
        "--model",
        "--setting-sources",
        "--resume",
        "--max-budget-usd",
        "--system-prompt",
    ] {
        assert!(a.iter().any(|x| x == flag), "missing {flag}");
    }
}

/// An ephemeral chat's turn names a session id but saved nothing under
/// it: `follow_on` must not adopt it, or the next turn resumes a
/// session that does not exist.
#[test]
fn follow_on_does_not_adopt_an_unsaved_session() {
    let mut s = spec();
    s.no_session_persistence = true;
    let mut agent = ClaudeCodeAgent::new(s);
    let outcome = AgentOutcome {
        session_id: Some("unsaved".into()),
        ..Default::default()
    };
    agent.follow_on(&outcome);
    assert_eq!(agent.spec().resume, None);
    let mut agent = ClaudeCodeAgent::new(spec());
    agent.follow_on(&outcome);
    assert_eq!(agent.spec().resume.as_deref(), Some("unsaved"));
}

/// Approval on is `auto`, not `dontAsk`: the classifier decides, and a
/// headless run it cannot approve is denied rather than left waiting.
/// Off is still the CLI's "run everything".
#[test]
fn approval_on_is_auto_mode_and_off_is_bypass() {
    let mut s = spec();
    s.permission_mode = Some(AgentSpec::headless_permission_mode(true).into());
    let a = s.args("hi");
    let i = a.iter().position(|x| x == "--permission-mode").unwrap();
    assert_eq!(a[i + 1], "auto");
    assert!(!a.iter().any(|x| x == "dontAsk"), "{a:?}");

    s.permission_mode = Some(AgentSpec::headless_permission_mode(false).into());
    let a = s.args("hi");
    let i = a.iter().position(|x| x == "--permission-mode").unwrap();
    assert_eq!(a[i + 1], "bypassPermissions");
}

/// Caller-supplied arguments go last so they can override.
#[test]
fn add_dirs_become_add_dir_flags() {
    let mut s = AgentSpec::new(PathBuf::from("/w"));
    s.add_dirs = vec![PathBuf::from("/vault"), PathBuf::from("/other")];
    let a = s.args("hi");
    let joined = a.join(" ");
    assert!(
        joined.contains("--add-dir /vault --add-dir /other"),
        "{a:?}"
    );
    // The CLI's own flags come first; a directory grant is never the
    // thing that pushes `-p` off the front.
    assert_eq!(a[0], "-p");
}

/// The card's grant (backlog 143, pass 2): a folder granted mid-turn is
/// on the very next argv — the resume's — once, however often it is
/// granted.
#[test]
fn a_granted_dir_is_on_the_next_argv_once() {
    let mut s = AgentSpec::new(PathBuf::from("/w"));
    s.add_dirs = vec![PathBuf::from("/vault")];
    let mut agent = ClaudeCodeAgent::new(s);
    agent.grant_dir(PathBuf::from("/elsewhere"));
    agent.grant_dir(PathBuf::from("/elsewhere"));
    agent.grant_dir(PathBuf::from("/vault"));
    let a = agent.spec.resume_args();
    let joined = a.join(" ");
    assert!(
        joined.contains("--add-dir /vault --add-dir /elsewhere"),
        "{a:?}"
    );
    assert_eq!(joined.matches("--add-dir").count(), 2, "{a:?}");
}

/// A turn with attachments drops the prompt from argv and says where
/// it is coming from instead. The first argument is still `-p`: the
/// stdin shape is print mode too, not an interactive session that
/// happens to be fed a pipe.
#[test]
fn stdin_args_replace_the_prompt_with_the_input_format() {
    let a = spec().stdin_args();
    assert_eq!(&a[..3], ["-p", "--input-format", "stream-json"]);
    assert!(!a.iter().any(|x| x == "hi"));
    for flag in [
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
    ] {
        assert!(a.iter().any(|x| x == flag), "missing {flag} in {a:?}");
    }
}

/// Everything after the prompt is the same vector either way — the
/// resume id, the model, the tool set, the directory grants. One
/// tail, not two, is what makes every flag test above hold for the
/// stdin shape without being written twice.
#[test]
fn the_stdin_shape_carries_every_flag_the_argv_shape_does() {
    let mut s = spec();
    s.model = Some("opus".into());
    s.tools = Some(vec![]);
    s.resume = Some("sess-9".into());
    s.safe_mode = true;
    s.add_dirs = vec![PathBuf::from("/vault")];
    s.extra_args = vec!["--x".into()];
    let argv = s.args("hi");
    let stdin = s.stdin_args();
    // `-p hi` versus `-p --input-format stream-json`, then identical.
    // …plus the receipts flag the stdin shape alone carries (328).
    assert_eq!(stdin[3], "--replay-user-messages");
    assert_eq!(argv[2..], stdin[4..]);
}

/// The stdin line is the Agent SDK's user message: a `user` line whose
/// Messages-API `content` is the block list, caption first, images
/// before documents, every source base64. Asserted on the parsed JSON,
/// since the CLI reads the frame and not the spelling.
#[test]
fn the_stdin_line_is_one_user_message_with_the_blocks_in_log_order() {
    let input = TurnInput {
        text: "what colour".into(),
        images: vec![nightloom_core::ImageInput {
            media_type: "image/png".into(),
            data: "AAAA".into(),
        }],
        documents: vec![nightloom_core::DocumentInput {
            media_type: "application/pdf".into(),
            name: "notes.pdf".into(),
            data: "BBBB".into(),
        }],
    };
    let line = protocol::user_line(&input);
    assert!(line.ends_with('\n'), "NDJSON needs the frame");
    assert_eq!(line.matches('\n').count(), 1, "one line, not several");
    let v: serde_json::Value = serde_json::from_str(&line).unwrap();
    assert_eq!(v["type"], "user");
    assert_eq!(v["message"]["role"], "user");
    assert!(v["parent_tool_use_id"].is_null());
    let content = v["message"]["content"].as_array().unwrap();
    assert_eq!(content.len(), 3);
    assert_eq!(content[0]["type"], "text");
    assert_eq!(content[0]["text"], "what colour");
    assert_eq!(content[1]["type"], "image");
    assert_eq!(content[1]["source"]["type"], "base64");
    assert_eq!(content[1]["source"]["media_type"], "image/png");
    assert_eq!(content[1]["source"]["data"], "AAAA");
    assert_eq!(content[2]["type"], "document");
    assert_eq!(content[2]["source"]["media_type"], "application/pdf");
    assert_eq!(content[2]["source"]["data"], "BBBB");
    assert_eq!(content[2]["title"], "notes.pdf");
}

/// A text attachment goes to the CLI as text, as it goes to every
/// provider (item 277), never as a `document` of a text type.
#[test]
fn a_text_attachment_rides_the_stdin_line_as_text() {
    let input = TurnInput {
        text: "run it".into(),
        images: Vec::new(),
        documents: vec![nightloom_core::DocumentInput {
            media_type: "text/x-python".into(),
            name: "fib.py".into(),
            data: "cHJpbnQoMSk=".into(),
        }],
    };
    let v: serde_json::Value = serde_json::from_str(&protocol::user_line(&input)).unwrap();
    let content = v["message"]["content"].as_array().unwrap();
    assert_eq!(content[1]["type"], "text");
    assert_eq!(
        content[1]["text"],
        "<attached-file name=\"fib.py\">\nprint(1)\n</attached-file>"
    );
}

/// A text-only turn is untouched by all of this: `-p <prompt>`, no
/// `--input-format`. That is the shape every caller outside the desktop
/// still uses, and the one the resume path was tested on.
#[test]
fn a_text_only_turn_never_asks_for_stdin_input() {
    let a = spec().args("hi");
    assert!(!a.iter().any(|x| x == "--input-format"), "{a:?}");
    assert_eq!(&a[..2], ["-p", "hi"]);
}

#[test]
fn mcp_config_is_passed_inline_and_survives_safe_mode() {
    let mut s = AgentSpec::new(PathBuf::from("/w"));
    s.mcp_config = Some(r#"{"mcpServers":{"nightloom":{}}}"#.into());
    let a = s.args("hi");
    let i = a.iter().position(|x| x == "--mcp-config").expect("flag");
    assert_eq!(a[i + 1], r#"{"mcpServers":{"nightloom":{}}}"#);
    s.safe_mode = true;
    let a = s.args("hi");
    assert!(a.iter().any(|x| x == "--strict-mcp-config"), "{a:?}");
    assert!(a.iter().any(|x| x == "--mcp-config"), "{a:?}");
}

#[test]
fn extra_args_are_appended() {
    let mut s = spec();
    s.extra_args = vec!["--add-dir".into(), "/other".into()];
    let a = s.args("hi");
    assert_eq!(&a[a.len() - 2..], ["--add-dir", "/other"]);
}

#[test]
fn follow_on_resumes_the_session_the_turn_opened() {
    let mut agent = ClaudeCodeAgent::new(spec());
    assert!(agent.spec().resume.is_none());
    let outcome = AgentOutcome {
        session_id: Some("sess-1".into()),
        ..Default::default()
    };
    agent.follow_on(&outcome);
    assert_eq!(agent.spec().resume.as_deref(), Some("sess-1"));
    assert!(agent.spec().args("hi").iter().any(|x| x == "sess-1"));
}

/// An aside's own model and effort (backlog 283): `None` keeps the
/// chat's, a value replaces it, an empty string sends no flag; the
/// throwaway flags stay either way.
#[test]
fn an_aside_may_pick_its_own_model_and_effort() {
    let mut s = spec();
    s.model = Some("opus".into());
    s.effort = Some("high".into());
    s.resume = Some("sess-9".into());
    let kept = s.aside_with(None, None).unwrap();
    assert_eq!(kept.model.as_deref(), Some("opus"));
    assert_eq!(kept.effort.as_deref(), Some("high"));
    let own = s.aside_with(Some("haiku"), Some("low")).unwrap();
    assert_eq!(own.model.as_deref(), Some("haiku"));
    assert_eq!(own.effort.as_deref(), Some("low"));
    let a = own.args("q");
    let i = a.iter().position(|x| x == "--model").unwrap();
    assert_eq!(a[i + 1], "haiku");
    assert!(a.iter().any(|x| x == "--fork-session"), "{a:?}");
    let bare = s.aside_with(Some(""), Some(" ")).unwrap();
    assert_eq!(bare.model, None);
    assert_eq!(bare.effort, None);
    assert!(
        spec().aside_with(Some("haiku"), None).is_none(),
        "no session, no aside"
    );
}

#[test]
fn side_requests_mark_the_chats_prefix_and_turns_do_not() {
    // Aside-cache research 2026-11-23: the tether switch rides an
    // aside, its model/effort variant and a keep-warm ping; never the
    // chat's own turn, and not the checkpoint fork (a working fork).
    let mut s = asking(AskMode::Auto);
    s.resume = Some("sess-9".into());
    let off = |x: &AgentSpec| {
        x.env_set()
            .iter()
            .any(|(k, v)| *k == TETHER_OFF_ENV && v == "false")
    };
    assert!(!off(&s), "the chat's own turn keeps the tether");
    assert!(off(&s.aside().unwrap()));
    assert!(off(&s.aside_with(Some("haiku"), Some("low")).unwrap()));
    assert!(off(&s.keep_warm_ping().unwrap()));
    assert!(!off(&s.checkpoint_fork().unwrap()));
    let mut plain = spec();
    plain.resume = Some("sess-9".into());
    assert!(off(&plain.aside().unwrap()), "a chat without the Ask hook");
    assert!(off(&plain.keep_warm_ping().unwrap()));
}

/// Item 959: an aside on another model marks the chat's prefix on that
/// model only where its tool text is the chat's there.
#[test]
fn an_other_model_aside_marks_the_chat_on_its_model_in_the_chats_class() {
    // An Ask chat (`default`) and its `dontAsk` aside: one class on
    // Sonnet (959 run S2), Opus, Fable and Haiku.
    let mut s = asking(AskMode::Ask);
    s.resume = Some("sess-9".into());
    s.model = Some("haiku".into());
    for m in ["sonnet", "opus", "claude-opus-5-5", "fable", "haiku"] {
        let side = s.aside_with(Some(m), None).unwrap();
        assert!(s.side_marks_chat_on_its_model(&side), "{m}");
    }
    // An Auto chat's aside stays `auto`: Opus and Fable match, Sonnet's
    // `auto` was never measured, so nothing is claimed there.
    let mut a = asking(AskMode::Auto);
    a.resume = Some("sess-9".into());
    assert!(a.side_marks_chat_on_its_model(&a.aside_with(Some("opus"), None).unwrap()));
    assert!(a.side_marks_chat_on_its_model(&a.aside_with(Some("fable"), None).unwrap()));
    assert!(!a.side_marks_chat_on_its_model(&a.aside_with(Some("sonnet"), None).unwrap()));
    // A chat without the hook in `plan` on Haiku runs Sonnet: no claim.
    let mut p = spec();
    p.resume = Some("sess-9".into());
    p.permission_mode = Some("plan".into());
    assert!(!p.side_marks_chat_on_its_model(&p.aside_with(Some("haiku"), None).unwrap()));
    // No tether switch, no mark; no model name, no claim.
    let mut side = s.aside_with(Some("opus"), None).unwrap();
    side.side_cache_mark = false;
    assert!(!s.side_marks_chat_on_its_model(&side));
    assert_eq!(AgentSpec::tool_text_class(None, Some("default")), None);
    assert_eq!(
        AgentSpec::tool_text_class(Some("opus"), Some("acceptEdits")),
        None
    );
}

/// An aside is the chat's own command line — model, tools, servers,
/// prompt tool, system prompt — plus the four flags that make it a
/// harmless throwaway on the warm cache, and minus the hook. Without a
/// session there is no aside.
#[test]
fn an_aside_keeps_the_prefix_and_adds_the_throwaway_flags() {
    assert!(spec().aside().is_none(), "nothing to ask beside");
    let mut s = asking(AskMode::Plan);
    s.model = Some("opus".into());
    s.mcp_config = Some("{\"mcpServers\":{}}".into());
    s.append_system_prompt = Some("preamble".into());
    s.resume = Some("sess-3".into());
    let aside = s.aside().expect("a session to ask beside");
    let a = aside.args("what did we decide?");
    for (flag, value) in [
        ("--resume", "sess-3"),
        ("--model", "opus"),
        ("--mcp-config", "{\"mcpServers\":{}}"),
        ("--append-system-prompt", "preamble"),
        ("--permission-prompt-tool", ask::PROMPT_TOOL),
        // ~~`dontAsk`~~ — a Plan chat's aside stays in `plan` (item
        // 774, blocker 2037, 2026-11-16): the chat's tool text on Opus.
        ("--permission-mode", "plan"),
    ] {
        let i = a
            .iter()
            .position(|x| x == flag)
            .unwrap_or_else(|| panic!("{flag} in {a:?}"));
        assert_eq!(a[i + 1], value, "{flag}");
    }
    for flag in ["--fork-session", "--no-session-persistence"] {
        assert!(a.iter().any(|x| x == flag), "{flag} in {a:?}");
    }
    // No turn cap of its own (2026-11-12, his ask): it runs like main.
    assert!(!a.iter().any(|x| x == "--max-turns"), "{a:?}");
    // No hook: a deferral would park the aside on a prompt (the
    // settings object may still carry the chat's other switches). And
    // the tools are untouched — `--tools ""` is what goes cold.
    if let Some(i) = a.iter().position(|x| x == "--settings") {
        assert!(!a[i + 1].contains("hooks"), "{}", a[i + 1]);
    }
    assert!(!a.iter().any(|x| x == "--tools"), "{a:?}");
    let with_hook = s.args("real turn");
    let i = with_hook.iter().position(|x| x == "--settings").unwrap();
    assert!(
        with_hook[i + 1].contains("hooks"),
        "the chat itself keeps its hook"
    );
    // The chat's own spec is as it was.
    assert_eq!(s.max_turns, None);
    assert!(!s.fork_session && !s.no_session_persistence);
    assert_eq!(s.ask.as_ref().unwrap().mode, AskMode::Plan);
}

/// Effort and the fallback model are two flags, each only when set,
/// passed through as spelled: the levels and the aliases are the
/// CLI's to validate.
#[test]
fn effort_and_fallback_model_are_passed_through_when_set() {
    let bare = spec().args("hi");
    for flag in ["--effort", "--fallback-model"] {
        assert!(!bare.iter().any(|x| x == flag), "{flag} in {bare:?}");
    }
    let mut s = spec();
    s.effort = Some("xhigh".into());
    s.fallback_model = Some("sonnet,haiku".into());
    let a = s.args("hi");
    let i = a.iter().position(|x| x == "--effort").unwrap();
    assert_eq!(a[i + 1], "xhigh");
    let j = a.iter().position(|x| x == "--fallback-model").unwrap();
    assert_eq!(a[j + 1], "sonnet,haiku");
    // On the resume shape too: a deferred call's resume is a turn.
    assert!(s.resume_args().iter().any(|x| x == "--effort"));
}

/// A fork by flag rides on `--resume` and lasts one turn: asked for
/// with nothing to resume it is refused, sent it follows the id, and
/// once the CLI has named the fork the next turn resumes that plainly.
#[test]
fn a_flag_fork_follows_the_resume_id_for_one_turn() {
    let mut agent = ClaudeCodeAgent::new(spec());
    agent.fork_on_next_turn();
    assert!(!agent.spec().fork_session, "nothing to fork");
    assert!(
        !agent
            .spec()
            .args("hi")
            .iter()
            .any(|x| x == "--fork-session")
    );
    agent.set_resume(Some("parent-1".into()));
    agent.fork_on_next_turn();
    let a = agent.spec().args("hi");
    let i = a.iter().position(|x| x == "--resume").unwrap();
    assert_eq!(&a[i + 1..i + 3], ["parent-1", "--fork-session"]);
    // The CLI answers with the fork's id (measured: a new one).
    agent.follow_on(&AgentOutcome {
        session_id: Some("fork-2".into()),
        ..Default::default()
    });
    let a = agent.spec().args("next");
    assert!(a.iter().any(|x| x == "fork-2"));
    assert!(!a.iter().any(|x| x == "--fork-session"), "{a:?}");
}

/// The default has to be the subscription. An inherited key bills the
/// API silently, which is the one failure this module cannot detect
/// after the fact.
#[test]
fn subscription_is_the_default() {
    assert!(spec().use_subscription);
}

/// Safe mode is three flags and none of them is `--safe-mode`.
///
/// `--safe-mode` discards the `--mcp-config` server with the host's
/// (measured 2026-09-14, nightshift blocker 058), so Nightloom's tools
/// vanished with it. An empty `--setting-sources` drops the host's
/// settings — CLAUDE.md, hooks, allowlist — and `--strict-mcp-config`
/// keeps every server but the one on the command line off; both are
/// load-bearing and the empty string is the value, not an omission.
/// The old `--safe-mode` coming back would restore the bug silently.
#[test]
fn safe_mode_is_no_setting_sources_plus_strict_mcp_config() {
    let mut s = spec();
    s.safe_mode = true;
    let a = s.args("hi");
    assert!(!a.iter().any(|x| x == "--safe-mode"), "{a:?}");
    let i = a
        .iter()
        .position(|x| x == "--setting-sources")
        .expect("flag");
    assert_eq!(a[i + 1], "", "the value is the empty list");
    assert!(a.iter().any(|x| x == "--strict-mcp-config"));
    assert!(a.iter().any(|x| x == "--disable-slash-commands"));
}

/// And only under safe mode: without it the host's own servers are
/// exactly what the user is asking to keep.
#[test]
fn strict_mcp_config_is_not_sent_unasked() {
    assert!(!spec().args("hi").iter().any(|x| x == "--strict-mcp-config"));
}

/// An incognito chat confines the CLI to the measured read-only list —
/// `--tools` with five names, never `--disallowedTools` — and does not
/// ask for `--no-session-persistence`; an ephemeral one does both. The
/// rail's "no tools" is left alone by either.
/// A Chat (nightshift backlog 102) gets the same five read-only tools
/// an incognito chat does, keeps "no tools" as no tools, and a Build
/// chat is untouched; the folder is not the method's business.
#[test]
fn a_chat_kind_narrows_to_the_read_only_tools_and_build_changes_nothing() {
    let mut s = spec();
    s.apply_kind(ChatKind::Build);
    assert!(!s.args("hi").iter().any(|x| x == "--tools"));

    s.apply_kind(ChatKind::Chat);
    let a = s.args("hi");
    let i = a.iter().position(|x| x == "--tools").expect("--tools");
    assert_eq!(&a[i + 1..i + 7], READ_ONLY_TOOLS);
    assert_eq!(s.workspace, spec().workspace);

    let mut none = spec();
    none.tools = Some(Vec::new());
    none.apply_kind(ChatKind::Chat);
    assert_eq!(none.tools.as_deref(), Some(&[][..]));
}

/// The policy half of a kind (nightshift backlog 144): a Chat over a
/// Claude Code declaration leaves `--tools` alone and registers the
/// refusing hook in the one `--settings` JSON — beside the Ask hook's
/// entry when there is one, never a second `--settings` — with the
/// lookahead matcher and the reason the model reads. Every other
/// pairing registers nothing.
#[test]
fn a_chat_over_a_build_declaration_is_a_deny_hook_not_a_narrower_tool_list() {
    let mut s = spec();
    s.apply_kind(ChatKind::Build);
    s.apply_kind_policy(ChatKind::Chat, ChatKind::Build);
    assert!(s.chat_policy);
    let a = s.args("hi");
    assert!(!a.iter().any(|x| x == "--tools"), "{a:?}");
    assert!(!a.iter().any(|x| x == "--disallowedTools"), "{a:?}");
    assert_eq!(a.iter().filter(|x| *x == "--settings").count(), 1);
    let i = a.iter().position(|x| x == "--settings").unwrap();
    let v: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
    let pre = v["hooks"]["PreToolUse"].as_array().unwrap();
    // The policy's deny, the preview's beside it (item 430), and the
    // connector writes' (item 759).
    assert_eq!(pre.len(), 3);
    assert_eq!(pre[0]["matcher"], CHAT_POLICY_MATCHER);
    assert_eq!(pre[1]["matcher"], PREVIEW_TOOL_MATCHER);
    assert_eq!(pre[2]["matcher"], connector_writes::MATCHER);
    let command = pre[0]["hooks"][0]["command"].as_str().unwrap();
    assert!(command.starts_with("echo "), "{command}");
    let reply: serde_json::Value = serde_json::from_str(
        command
            .trim_start_matches("echo ")
            .trim_start_matches('\'')
            .trim_end_matches('\''),
    )
    .unwrap();
    assert_eq!(reply["hookSpecificOutput"]["permissionDecision"], "deny");
    assert_eq!(
        reply["hookSpecificOutput"]["permissionDecisionReason"],
        CHAT_POLICY_REASON
    );

    // Beside the Ask hook: two entries in one array, one `--settings`.
    s.ask = Some(AskSpec {
        hook: vec!["/app/nightloom-desktop".into(), "--permission-hook".into()],
        dir: PathBuf::from("/logs/ask/chat-1"),
        mode: AskMode::Ask,
        subagents_auto: true,
    });
    s.auto_memory = false;
    let a = s.args("hi");
    assert_eq!(a.iter().filter(|x| *x == "--settings").count(), 1);
    let i = a.iter().position(|x| x == "--settings").unwrap();
    let v: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
    let pre = v["hooks"]["PreToolUse"].as_array().unwrap();
    assert_eq!(pre.len(), 5, "{v}");
    // Narrowed beside the policy (backlog 147): see the next test.
    assert_eq!(
        pre[0]["matcher"],
        ask_matcher_under_chat_policy(ask::MATCHER, false)
    );
    assert_eq!(pre[1]["matcher"], CHAT_POLICY_MATCHER);
    assert_eq!(pre[2]["matcher"], PREVIEW_TOOL_MATCHER);
    // Item 783: with the Ask hook there, Nightloom's own note writes
    // stay refused and the connector actions (and `remember`) ask.
    assert_eq!(pre[3]["matcher"], connector_writes::KNOWN_WRITES_MATCHER);
    assert_eq!(pre[4]["matcher"], connector_writes::CARD_MATCHER);
    assert!(
        pre[4]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains(ask::READ_ONLY_ARG)
    );
    assert_eq!(v["autoMemoryEnabled"], false);

    // The other pairings: nothing to refuse. (A born Chat, Chat over
    // Chat, refuses the MCP writers: its own test, item 759.)
    for (kind, declared) in [
        (ChatKind::Build, ChatKind::Build),
        (ChatKind::Build, ChatKind::Chat),
    ] {
        let mut s = spec();
        // Fork mode's own `env` entry aside (backlog 104), which rides
        // the same JSON: off here so the policy is what is tested.
        s.fork_mode = false;
        s.apply_kind_policy(kind, declared);
        assert!(!s.chat_policy, "{kind:?} over {declared:?}");
        assert!(settings_hold_only_the_plugin_switch(&s.args("hi")));
    }
    // The matcher itself is JavaScript's (a negative lookahead the
    // `regex` crate cannot compile); the CLI was measured reading it —
    // Bash refused, Read run, in one turn (the report's step 11).
}

/// Item 759: a born Chat (Chat over Chat) keeps its five readers and
/// gets the MCP denies — the preview's, the browser's when it is on,
/// and the connector writes' — but not the policy's own entry; its
/// Ask hook's `mcp__` alternative leaves out what they refuse, and
/// the rest of the Ask matcher is untouched.
#[test]
fn a_born_chat_refuses_the_mcp_writers_but_keeps_its_readers() {
    let mut s = spec();
    s.fork_mode = false;
    s.apply_kind(ChatKind::Chat);
    s.apply_kind_policy(ChatKind::Chat, ChatKind::Chat);
    assert!(!s.chat_policy);
    assert!(s.born_chat);
    let pre_of = |s: &AgentSpec| -> Vec<serde_json::Value> {
        let a = s.args("hi");
        let i = a.iter().position(|x| x == "--settings").unwrap();
        let v: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
        v["hooks"]["PreToolUse"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    };
    let pre = pre_of(&s);
    let m: Vec<&str> = pre.iter().filter_map(|e| e["matcher"].as_str()).collect();
    assert_eq!(m, [PREVIEW_TOOL_MATCHER, connector_writes::MATCHER]);
    s.browser = true;
    let pre = pre_of(&s);
    let m: Vec<&str> = pre.iter().filter_map(|e| e["matcher"].as_str()).collect();
    assert_eq!(
        m,
        [
            PREVIEW_TOOL_MATCHER,
            BROWSER_TOOLS_MATCHER,
            connector_writes::MATCHER
        ]
    );
    s.ask = Some(AskSpec {
        hook: vec!["/app/nightloom-desktop".into(), "--permission-hook".into()],
        dir: PathBuf::from("/logs/ask/chat-1"),
        mode: AskMode::Ask,
        subagents_auto: true,
    });
    let pre = pre_of(&s);
    let expected = ask::MATCHER.replace(ask::MCP_ALTERNATIVE, &ask_mcp_less(true));
    assert_eq!(pre[0]["matcher"], expected);
    assert!(expected.starts_with("Bash|Write|"));

    // The turn-time hold tightens a spec made for another chat.
    let mut agent = ClaudeCodeAgent::new(spec());
    assert!(agent.hold_to_kind_policy(ChatKind::Chat, ChatKind::Chat));
    assert!(agent.spec().born_chat && !agent.spec().chat_policy);
    assert!(!agent.hold_to_kind_policy(ChatKind::Chat, ChatKind::Chat));
}

/// Under the Chat policy the Ask hook no longer names a withdrawn
/// tool (nightshift backlog 147): the CLI runs every matching entry,
/// so a `Bash` both hooks matched would raise a prompt the policy's
/// deny had already settled. The plan exit's matcher, all withdrawn,
/// registers no Ask entry at all. And the deny's echo carries nothing
/// `cmd.exe` would read as its own, so the unquoted Windows form holds.
#[test]
fn under_the_chat_policy_the_ask_hook_names_only_what_the_policy_leaves() {
    let narrowed = ask_matcher_under_chat_policy(ask::MATCHER, false);
    // The preview's tool is out too (item 430): the policy refuses it.
    assert_eq!(
        narrowed,
        format!(
            "WebFetch|WebSearch|mcp__(?!playwright__|nightloom__preview|nightloom__add_folder|nightloom__request_secret|nightloom__ask_user_to_drive|{}).*",
            connector_writes::ASK_EXCLUSION_WITH_CARD
        )
    );
    for withdrawn in [
        "Bash",
        "Write",
        "Edit",
        "MultiEdit",
        "NotebookEdit",
        "ExitPlanMode",
    ] {
        assert!(!narrowed.split('|').any(|t| t == withdrawn), "{withdrawn}");
    }
    assert_eq!(
        ask_matcher_under_chat_policy(ask::EXIT_PLAN_MATCHER, false),
        ""
    );

    let mut s = spec();
    s.apply_kind(ChatKind::Build);
    s.apply_kind_policy(ChatKind::Chat, ChatKind::Build);
    s.ask = Some(AskSpec {
        hook: vec!["/app/nightloom-desktop".into(), "--permission-hook".into()],
        dir: PathBuf::from("/logs/ask/chat-1"),
        mode: AskMode::Ask,
        subagents_auto: true,
    });
    let a = s.args("hi");
    let i = a.iter().position(|x| x == "--settings").unwrap();
    let v: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
    let pre = v["hooks"]["PreToolUse"].as_array().unwrap();
    assert_eq!(pre.len(), 5, "{v}");
    assert_eq!(pre[0]["matcher"], narrowed);
    assert_eq!(pre[1]["matcher"], CHAT_POLICY_MATCHER);
    assert_eq!(pre[2]["matcher"], PREVIEW_TOOL_MATCHER);
    // Item 783: the connector actions and `remember` ask.
    assert_eq!(pre[3]["matcher"], connector_writes::KNOWN_WRITES_MATCHER);
    assert_eq!(pre[4]["matcher"], connector_writes::CARD_MATCHER);
    // The one resume that leaves plan mode: only the deny is registered.
    s.ask.as_mut().unwrap().mode = AskMode::ExitingToAuto;
    let a = s.args("hi");
    let i = a.iter().position(|x| x == "--settings").unwrap();
    let v: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
    let pre = v["hooks"]["PreToolUse"].as_array().unwrap();
    assert_eq!(pre.len(), 4, "{v}");
    assert_eq!(pre[0]["matcher"], CHAT_POLICY_MATCHER);
    assert_eq!(pre[1]["matcher"], PREVIEW_TOOL_MATCHER);
    assert_eq!(pre[2]["matcher"], connector_writes::KNOWN_WRITES_MATCHER);
    assert_eq!(pre[3]["matcher"], connector_writes::CARD_MATCHER);
    // Item 845: Home's read-only chat — its mail and calendar writers
    // leave the refusal for their own asking entry, last.
    let mut h = s.clone();
    h.home_gated_writes = true;
    let a = h.args("hi");
    let i = a.iter().position(|x| x == "--settings").unwrap();
    let v: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
    let pre = v["hooks"]["PreToolUse"].as_array().unwrap();
    assert_eq!(pre.len(), 5, "{v}");
    assert_eq!(
        pre[2]["matcher"],
        connector_writes::KNOWN_WRITES_MATCHER_HOME
    );
    assert_eq!(pre[3]["matcher"], connector_writes::CARD_MATCHER);
    assert_eq!(pre[4]["matcher"], connector_writes::HOME_GATED_MATCHER);
    assert!(
        pre[4]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains(ask::READ_ONLY_ARG)
    );
    // Without the policy, the matcher is untouched.
    let mut plain = spec();
    plain.ask = s.ask.clone();
    plain.ask.as_mut().unwrap().mode = AskMode::Ask;
    assert_eq!(matcher_of(&plain.args("hi")), ask::MATCHER);

    let command = pre[0]["hooks"][0]["command"].as_str().unwrap();
    let reply = command.trim_start_matches("echo ").trim_matches('\'');
    assert!(
        !reply.contains(['&', '|', '<', '>', '^', '%']),
        "cmd.exe would read one of these as its own: {reply}"
    );
    assert!(!reply.contains('\''), "{reply}");
}

/// Backlog 405: an incognito chat's CLI loads no settings file (so not
/// his `CLAUDE.md`), no other MCP server, no skill and no auto memory;
/// is granted no folder; has neither connectors nor Chrome; and refuses
/// reads of every folder it was given, in the one `--settings` JSON.
#[test]
fn apply_incognito_drops_his_files_and_denies_his_folders() {
    let mut s = spec();
    s.add_dirs = vec![PathBuf::from("/vault")];
    s.browser = true;
    s.claude_ai_connectors = true;
    s.apply_mode(ChatMode::Incognito);
    s.apply_incognito(vec![
        PathBuf::from("/Users/x/.nightloom"),
        PathBuf::from("/Users/x/.claude"),
    ]);
    let a = s.args("hi");
    let joined = a.join(" ");
    assert!(!a.iter().any(|x| x == "--add-dir"), "{a:?}");
    let i = a.iter().position(|x| x == "--setting-sources").unwrap();
    assert_eq!(a[i + 1], "");
    assert!(a.iter().any(|x| x == "--strict-mcp-config"));
    assert!(a.iter().any(|x| x == "--disable-slash-commands"));
    assert!(a.iter().any(|x| x == "--no-chrome"));
    assert!(!joined.contains("--chrome "), "{joined}");
    let i = a.iter().position(|x| x == "--settings").unwrap();
    let v: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
    assert_eq!(v["autoMemoryEnabled"], false);
    let deny: Vec<&str> = v["permissions"]["deny"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r.as_str().unwrap())
        .collect();
    for want in [
        "Read(//Users/x/.nightloom/**)",
        "Read(//Users/x/.nightloom)",
        "Read(//Users/x/.claude/**)",
    ] {
        assert!(deny.contains(&want), "{want} not in {deny:?}");
    }
    // Only one `--settings` (the CLI keeps the last).
    assert_eq!(a.iter().filter(|x| *x == "--settings").count(), 1);
    // A normal chat is untouched.
    let normal = spec().args("hi");
    assert!(!normal.iter().any(|x| x == "--setting-sources"));
    assert!(!normal.join(" ").contains("permissions"));
}

#[test]
fn incognito_is_the_read_only_tool_list_and_ephemeral_adds_no_persistence() {
    let mut s = spec();
    s.apply_mode(ChatMode::Normal);
    let a = s.args("hi");
    assert!(!a.iter().any(|x| x == "--tools"));
    assert!(!a.iter().any(|x| x == "--no-session-persistence"));

    let mut s = spec();
    s.apply_mode(ChatMode::Incognito);
    let a = s.args("hi");
    let i = a.iter().position(|x| x == "--tools").expect("--tools");
    assert_eq!(&a[i + 1..i + 7], READ_ONLY_TOOLS);
    for writer in ["Write", "Edit", "NotebookEdit", "Bash"] {
        assert!(!a.iter().any(|x| x == writer), "{writer} in {a:?}");
    }
    assert!(!a.iter().any(|x| x == "--disallowedTools"), "{a:?}");
    assert!(!a.iter().any(|x| x == "--no-session-persistence"), "{a:?}");

    let mut s = spec();
    s.ask = Some(AskSpec {
        hook: vec!["hook".into()],
        dir: PathBuf::from("/x"),
        mode: AskMode::Ask,
        subagents_auto: true,
    });
    s.apply_mode(ChatMode::Ephemeral);
    let a = s.args("hi");
    let i = a.iter().position(|x| x == "--tools").expect("--tools");
    assert_eq!(&a[i + 1..i + 7], READ_ONLY_TOOLS);
    assert!(a.iter().any(|x| x == "--no-session-persistence"), "{a:?}");
    // No resume, no Ask: the hook is not registered on an ephemeral chat
    // (a `--settings` JSON, when a chat's auto-compact switch puts one
    // there, must not carry it either).
    assert!(s.ask.is_none());
    assert!(!a.iter().any(|x| x.contains("hooks")), "{a:?}");
    // Before the caller's own trailing arguments, like every other flag.
    s.extra_args = vec!["--x".into()];
    let a = s.args("hi");
    assert_eq!(a.last().map(String::as_str), Some("--x"));

    let mut s = spec();
    s.tools = Some(vec![]);
    s.apply_mode(ChatMode::Incognito);
    let a = s.args("hi");
    let i = a.iter().position(|x| x == "--tools").unwrap();
    assert_eq!(a[i + 1], "", "no tools stays no tools");
}

/// The Ask position is three flags on top of everything else, and it
/// wins over the mode the shell would otherwise send: Manual, the
/// hook registered inline (so safe mode cannot drop it), and a prompt
/// tool named so the question and plan tools are offered at all.
#[test]
fn the_ask_position_is_manual_mode_plus_the_hook_plus_a_prompt_tool() {
    let mut s = spec();
    s.permission_mode = Some("auto".into());
    s.ask = Some(AskSpec {
        hook: vec!["/app/nightloom-desktop".into(), "--permission-hook".into()],
        dir: PathBuf::from("/logs/ask/chat-1"),
        mode: AskMode::Ask,
        subagents_auto: true,
    });
    let a = s.args("hi");
    let i = a.iter().position(|x| x == "--permission-mode").unwrap();
    assert_eq!(a[i + 1], "default");
    assert!(!a.iter().any(|x| x == "auto"), "{a:?}");
    let i = a
        .iter()
        .position(|x| x == "--settings")
        .expect("--settings");
    let v: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
    assert_eq!(
        v["hooks"]["PreToolUse"][0]["hooks"][0]["command"],
        format!(
            "'/app/nightloom-desktop' '--permission-hook' '/logs/ask/chat-1' {}",
            ask::FAIL_CLOSED
        )
    );
    let i = a
        .iter()
        .position(|x| x == "--permission-prompt-tool")
        .expect("prompt tool");
    assert_eq!(a[i + 1], ask::PROMPT_TOOL);
    // And it survives safe mode beside the other flags.
    s.safe_mode = true;
    let a = s.args("hi");
    assert!(a.iter().any(|x| x == "--settings"));
    assert!(a.iter().any(|x| x == "--setting-sources"));
    // Off, none of it leaks — checked by content, since a chat's
    // auto-compact switch (backlog 086) may put a `--settings` there.
    let bare = spec().args("hi");
    assert!(
        !bare.iter().any(|x| x == "--permission-prompt-tool"),
        "{bare:?}"
    );
    assert!(!bare.iter().any(|x| x.contains("hooks")), "{bare:?}");
}

/// The memory switch (nightshift backlog 088): off is
/// `autoMemoryEnabled: false` in `--settings`, and with the Ask hook
/// on it shares the hook's JSON — one `--settings`, since the CLI keeps
/// only the last. On sends nothing, as the CLI's default is on.
#[test]
fn auto_memory_off_rides_in_the_one_settings_json() {
    let mut s = spec();
    s.auto_memory = false;
    let a = s.args("hi");
    assert_eq!(a.iter().filter(|x| *x == "--settings").count(), 1);
    let i = a.iter().position(|x| x == "--settings").unwrap();
    let v: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
    assert_eq!(v["autoMemoryEnabled"], false);
    assert!(v.get("hooks").is_none());

    s.ask = Some(AskSpec {
        hook: vec!["/app/nightloom-desktop".into(), "--permission-hook".into()],
        dir: PathBuf::from("/logs/ask/chat-1"),
        mode: AskMode::Ask,
        subagents_auto: true,
    });
    let a = s.args("hi");
    assert_eq!(a.iter().filter(|x| *x == "--settings").count(), 1, "{a:?}");
    let i = a.iter().position(|x| x == "--settings").unwrap();
    let v: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
    assert_eq!(v["autoMemoryEnabled"], false);
    assert!(v["hooks"]["PreToolUse"][0]["hooks"][0]["command"].is_string());

    // Memory on, no hook, compaction off (a chat's shape, backlog 086):
    // the JSON carries the auto-compact switch and nothing else.
    let mut s = spec();
    s.auto_compact = false;
    let a = s.args("hi");
    let i = a.iter().position(|x| x == "--settings").unwrap();
    let v: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
    assert_eq!(v["autoCompactEnabled"], false);
    assert!(v.get("autoMemoryEnabled").is_none());
    assert!(v.get("hooks").is_none());
    // The default — a dream's or a capture's shape (review F4,
    // 2026-09-16) — leaves compaction to the CLI: no `--settings` at all.
    assert!(spec().auto_compact);
    // — once fork mode's `env` entry (backlog 104), which is on by
    // default and rides the same JSON, is off.
    let mut plain = spec();
    plain.fork_mode = false;
    assert!(settings_hold_only_the_plugin_switch(&plain.args("hi")));
}

/// Backlog 435: every process Nightloom starts carries `NIGHTLOOM=1` —
/// a chat turn, a pass (dream, capture, chat name) and the checkpoint
/// fork alike — so his `notify.sh` hook can stay quiet on them.
#[test]
fn every_process_carries_the_nightloom_marker() {
    let marked = |env: &[(String, String)]| {
        env.iter()
            .any(|(k, v)| k == NIGHTLOOM_MARKER_ENV && v == "1")
    };
    let env_of = |s: &AgentSpec| -> Vec<(String, String)> {
        s.env_set()
            .into_iter()
            .map(|(k, v)| (k.to_string(), v))
            .collect()
    };
    assert!(marked(&env_of(&spec())));
    let pass = PassSpec::new("claude", Vec::new()).spec_in("/w");
    assert!(marked(&env_of(&pass)));
    let mut resumed = spec();
    resumed.resume = Some("s-1".into());
    assert!(marked(&resumed.fork_spec().unwrap().env));
    assert!(!spec().env_removed().contains(&NIGHTLOOM_MARKER_ENV));
}

/// Fork mode (backlog 104, pass 3): on by default, it puts
/// `CLAUDE_CODE_FORK_SUBAGENT=1` in the one `--settings` JSON's `env`
/// and in the process environment, and the `checkpoint` roster entry
/// on `--agents`; off, none of the three. The checkpoint fork's spec
/// keeps the prefix (model, tools, MCP, prompt, roster), forks the
/// session with no file of its own, runs as an aside under Ask, and
/// its written command line has the task slot empty and no uuid.
#[test]
fn fork_mode_rides_the_settings_env_and_the_agents_roster() {
    let on = spec();
    assert!(on.fork_mode);
    let a = on.args("hi");
    let i = a.iter().position(|x| x == "--settings").unwrap();
    let v: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
    assert_eq!(v["env"]["CLAUDE_CODE_FORK_SUBAGENT"], "1");
    let j = a.iter().position(|x| x == "--agents").unwrap();
    let roster: serde_json::Value = serde_json::from_str(&a[j + 1]).unwrap();
    assert!(roster[fork::CHECKPOINT_AGENT]["description"].is_string());
    assert!(
        on.env_set()
            .iter()
            .any(|(k, v)| *k == "CLAUDE_CODE_FORK_SUBAGENT" && v == "1")
    );
    let mut off = spec();
    off.fork_mode = false;
    let a = off.args("hi");
    assert!(!a.iter().any(|x| x == "--agents"), "{a:?}");
    assert!(settings_hold_only_the_plugin_switch(&a), "{a:?}");
    assert!(
        !off.env_set()
            .iter()
            .any(|(k, _)| *k == "CLAUDE_CODE_FORK_SUBAGENT")
    );
    // The removed keys are the subscription's guard, on both paths.
    assert!(on.env_removed().contains(&"ANTHROPIC_API_KEY"));

    // No session, no fork; fork mode off, no fork.
    assert!(spec().checkpoint_fork().is_none());
    let mut s = asking(AskMode::Ask);
    s.resume = Some("sess-3".into());
    s.model = Some("opus".into());
    s.fork_mode = false;
    assert!(s.checkpoint_fork().is_none());
    s.fork_mode = true;
    s.brief = Some(BriefSpec {
        hook: vec!["hook".into()],
        dir: PathBuf::from("/chat"),
        text: "brief".into(),
    });
    let f = s.checkpoint_fork().unwrap();
    assert!(f.fork_session && f.no_session_persistence);
    assert_eq!(f.ask.as_ref().unwrap().mode, AskMode::Aside);
    assert!(f.brief.is_some(), "the budget hook rides in the fork");
    assert_eq!(f.max_turns, None);
    let fa = f.args("task");
    for (flag, value) in [
        ("--resume", "sess-3"),
        ("--model", "opus"),
        ("--permission-mode", "dontAsk"),
        ("--permission-prompt-tool", ask::PROMPT_TOOL),
    ] {
        let i = fa.iter().position(|x| x == flag).unwrap();
        assert_eq!(fa[i + 1], value, "{flag}");
    }
    assert!(fa.iter().any(|x| x == "--fork-session"));
    assert!(fa.iter().any(|x| x == "--agents"), "the roster stays");
    assert!(
        !fa.iter().any(|x| x == "--resume-session-at"),
        "the hook adds the uuid"
    );
    // The chat's own spec is as it was.
    assert!(!s.fork_session && !s.no_session_persistence);
    assert_eq!(s.ask.as_ref().unwrap().mode, AskMode::Ask);

    let fs = s.fork_spec().unwrap();
    assert_eq!(&fs.argv[..2], ["-p", ""]);
    assert_eq!(fs.workspace, s.workspace);
    assert!(fs.env.iter().any(|(k, _)| k == "CLAUDE_CODE_FORK_SUBAGENT"));
    assert!(fs.env_remove.iter().any(|k| k == "ANTHROPIC_API_KEY"));
}

/// A call refused by a Stop is remembered against its session until a
/// turn lands (review F1, 2026-09-16); without a session there is no
/// resume to deliver it on, so nothing is kept.
#[test]
fn a_refused_call_is_kept_for_the_next_turn_and_cleared_when_one_lands() {
    let mut agent = ClaudeCodeAgent::new(spec());
    let call = DeferredCall {
        id: "toolu_1".into(),
        name: "Edit".into(),
        input: serde_json::json!({}),
    };
    agent.note_refused(None, call.clone());
    assert!(
        agent.refused.is_none(),
        "no session: nothing to deliver it on"
    );
    agent.note_refused(Some("sess-1"), call.clone());
    assert_eq!(
        agent.refused.as_ref().map(|(s, c)| (s.as_str(), &c.id)),
        Some(("sess-1", &call.id))
    );
    agent.follow_on(&AgentOutcome {
        session_id: Some("sess-1".into()),
        ..AgentOutcome::default()
    });
    assert!(
        agent.refused.is_none(),
        "delivered with the turn that landed"
    );
}

/// The chat's directory is set after connect, once the chat exists,
/// and only on a connection that is asking.
#[test]
fn the_ask_dir_follows_the_open_chat() {
    let mut agent = ClaudeCodeAgent::new(spec());
    agent.set_ask_dir(PathBuf::from("/logs/ask/x"));
    assert!(agent.spec().ask.is_none(), "not asking: nothing to point");
    let mut s = spec();
    s.ask = Some(AskSpec {
        hook: vec!["hook".into()],
        dir: PathBuf::from("/placeholder"),
        mode: AskMode::Ask,
        subagents_auto: true,
    });
    let mut agent = ClaudeCodeAgent::new(s);
    agent.set_ask_dir(PathBuf::from("/logs/ask/chat-2"));
    assert_eq!(
        agent.spec().ask.as_ref().unwrap().dir,
        PathBuf::from("/logs/ask/chat-2")
    );
    let a = agent.spec().args("hi");
    let i = a.iter().position(|x| x == "--settings").unwrap();
    assert!(a[i + 1].contains("/logs/ask/chat-2"), "{}", a[i + 1]);
}

/// The subagent brief's hook (backlog 152) is a `PreToolUse` entry on
/// `Agent|Task` in the one `--settings` JSON: registered in the Auto
/// position (no Ask hook) and beside the Ask hook's entry alike, only
/// once the shell has pointed it at the chat's directory, never under
/// the Chat policy, never on an aside; and pointing it writes the
/// brief file.
#[test]
fn the_brief_hook_rides_every_position_but_the_chat_policy_and_asides() {
    let dir = std::env::temp_dir().join(format!("nightloom-152b-{}", uuid::Uuid::new_v4()));
    let brief = BriefSpec {
        hook: vec!["hook".into(), "--subagent-hook".into()],
        dir: PathBuf::new(),
        text: "<nightloom-subagent-brief>\nx\n</nightloom-subagent-brief>".into(),
    };
    let entries = |a: &[String]| -> Vec<serde_json::Value> {
        let Some(i) = a.iter().position(|x| x == "--settings") else {
            return Vec::new();
        };
        let v: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
        v["hooks"]["PreToolUse"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    };
    let brief_entries = |a: &[String]| {
        entries(a)
            .into_iter()
            .filter(|e| e["matcher"] == brief::BRIEF_MATCHER)
            .count()
    };
    // Auto position, brief set but not yet pointed: nothing registered.
    let mut s = spec();
    s.permission_mode = Some("auto".into());
    s.brief = Some(brief.clone());
    assert_eq!(brief_entries(&s.args("hi")), 0);
    // Pointed: one entry, the command quoted, and the file written.
    let mut agent = ClaudeCodeAgent::new(s);
    agent.set_ask_dir(dir.clone());
    assert_eq!(
        std::fs::read_to_string(dir.join(brief::BRIEF_FILE)).unwrap(),
        brief.text
    );
    let a = agent.spec().args("hi");
    assert_eq!(brief_entries(&a), 1);
    // Beside it only `add_folder`'s, `request_secret`'s and
    // `ask_user_to_drive`'s own gates (items 613, 766, 872): no Ask hook.
    assert_eq!(entries(&a).len(), 4, "no Ask hook in Auto");
    assert_eq!(
        entries(&a)[1]["matcher"],
        crate::tools::add_folder::GATE_MATCHER
    );
    assert_eq!(entries(&a)[2]["matcher"], crate::secret::GATE_MATCHER);
    assert_eq!(entries(&a)[3]["matcher"], crate::home::drive::GATE_MATCHER);
    // The drive gate fails closed, on the same hook and directory.
    let gate = entries(&a)[3]["hooks"][0]["command"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        gate.starts_with(&format!("'hook' '--permission-hook' '{}'", dir.display())),
        "{gate}"
    );
    assert!(gate.ends_with(DRIVE_GATE_FAIL_CLOSED), "{gate}");
    let cmd = entries(&a)[0]["hooks"][0]["command"].clone();
    assert_eq!(cmd, format!("'hook' '--subagent-hook' '{}'", dir.display()));
    // Nightshift 561: the same command on each user message, no matcher.
    let i = a.iter().position(|x| x == "--settings").unwrap();
    let v: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
    let prompt = v["hooks"][brief::PROMPT_EVENT].as_array().unwrap();
    assert_eq!(prompt.len(), 1, "{prompt:?}");
    assert!(prompt[0].get("matcher").is_none(), "{prompt:?}");
    assert_eq!(prompt[0]["hooks"][0]["command"], cmd);
    // Ask position: beside the Ask hook's entry, the Ask one first.
    let mut s = asking(AskMode::Ask);
    s.brief = Some(brief.clone());
    let mut agent = ClaudeCodeAgent::new(s);
    agent.set_ask_dir(dir.clone());
    let a = agent.spec().args("hi");
    let e = entries(&a);
    assert_eq!(e.len(), 5, "{e:?}");
    assert_eq!(e[0]["matcher"], ask::MATCHER);
    assert_eq!(e[1]["matcher"], brief::BRIEF_MATCHER);
    assert_eq!(e[2]["matcher"], crate::tools::add_folder::GATE_MATCHER);
    assert_eq!(e[3]["matcher"], crate::secret::GATE_MATCHER);
    assert_eq!(e[4]["matcher"], crate::home::drive::GATE_MATCHER);
    // The aside of that chat carries no hook at all.
    let mut s = asking(AskMode::Ask);
    s.brief = Some(brief.clone());
    s.resume = Some("sid".into());
    let aside = s.aside().unwrap();
    assert!(aside.brief.is_none());
    // ~~Under the Chat policy the entry is withheld~~ — since pass 2
    // of backlog 165 it rides there too, beside the policy's own: the
    // hook is the budget's on every tool, and the policy's deny on
    // `Agent` still wins (backlog 147's measurement).
    let mut s = spec();
    s.chat_policy = true;
    s.brief = Some(BriefSpec {
        dir: dir.clone(),
        ..brief.clone()
    });
    let a = s.args("hi");
    assert_eq!(brief_entries(&a), 1);
    assert_eq!(
        entries(&a).len(),
        7,
        "the policy's own entry, the preview's deny (item 430), the connector writes' (759), the budget's, add_folder's gate (613), request_secret's (766) and ask_user_to_drive's (872)"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// Pointing the ask directory at a chat writes the *Subagents run on
/// auto* switch into its rules (backlog 152), so the hook — another
/// process — reads the rail's position; and flipping it rewrites.
#[test]
fn the_ask_dir_carries_the_subagent_switch() {
    let dir = std::env::temp_dir().join(format!("nightloom-152-{}", uuid::Uuid::new_v4()));
    let mut s = spec();
    s.ask = Some(AskSpec {
        hook: vec!["hook".into()],
        dir: PathBuf::from("/placeholder"),
        mode: AskMode::Ask,
        subagents_auto: false,
    });
    let mut agent = ClaudeCodeAgent::new(s);
    agent.set_ask_dir(dir.clone());
    assert!(!AskDir::new(&dir).subagents_auto());
    agent.spec.ask.as_mut().unwrap().subagents_auto = true;
    agent.set_ask_dir(dir.clone());
    assert!(AskDir::new(&dir).subagents_auto());
    let _ = std::fs::remove_dir_all(&dir);
}

/// A deferred resume is `-p` with no prompt and no input format — the
/// one shape the CLI accepts without a message — and then the same
/// tail as every other turn, `--resume` included.
#[test]
fn the_resume_shape_has_no_prompt_and_carries_the_tail() {
    let mut s = spec();
    s.model = Some("haiku".into());
    s.resume = Some("sess-7".into());
    s.safe_mode = true;
    let r = s.resume_args();
    assert_eq!(r[0], "-p");
    assert_eq!(r[1], "--output-format", "nothing between -p and the tail");
    assert!(!r.iter().any(|x| x == "--input-format"), "{r:?}");
    let i = r.iter().position(|x| x == "--resume").unwrap();
    assert_eq!(r[i + 1], "sess-7");
    // Same tail as the argv shape.
    let argv = s.args("hi");
    assert_eq!(argv[2..], r[1..]);
}
