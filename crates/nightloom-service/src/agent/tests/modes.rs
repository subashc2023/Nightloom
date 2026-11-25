use super::*;

pub(super) fn asking(mode: AskMode) -> AgentSpec {
    let mut s = spec();
    s.permission_mode = Some("auto".into());
    s.ask = Some(AskSpec {
        hook: vec!["hook".into(), "--permission-hook".into()],
        dir: PathBuf::from("/logs/ask/chat-3"),
        mode,
        subagents_auto: true,
    });
    s
}

/// The `PreToolUse` entries of a spec's one `--settings` JSON.
/// Item 872: Home's own Reminders writer is asked about only on the
/// read-only chat's card. A chat of Home's that is not held read-only
/// refuses it by its own entry, in every position; a held one adds
/// nothing (its read-only entries gate or refuse it); no other
/// project's chat changes at all.
#[test]
fn homes_reminders_writer_is_refused_where_homes_chat_is_not_held_read_only() {
    let tool = "mcp__nightloom__update_reminders";
    let own = |s: &AgentSpec| -> Vec<serde_json::Value> {
        pre_entries(s)
            .into_iter()
            .filter(|e| e["matcher"] == connector_writes::HOME_OWN_WRITER_MATCHER)
            .collect()
    };
    let mut bypass = spec();
    bypass.permission_mode = Some("bypassPermissions".into());
    for (name, mut s) in [
        ("bypass", bypass),
        ("auto", asking(AskMode::Auto)),
        ("ask", asking(AskMode::Ask)),
        ("plan", asking(AskMode::Plan)),
    ] {
        assert!(own(&s).is_empty(), "{name}: not Home's chat");
        s.home_chat = true;
        let entries = own(&s);
        assert_eq!(entries.len(), 1, "{name}");
        let command = entries[0]["hooks"][0]["command"].as_str().unwrap();
        assert!(command.starts_with("echo "), "{name}: {command}");
        assert!(
            command.contains("\"permissionDecision\":\"deny\""),
            "{name}"
        );
        assert_eq!(entries[0]["matcher"], format!("^{tool}$"), "{name}");
    }
    let reply = connector_writes::HOME_OWN_WRITER_UNHELD;
    assert!(
        !reply.contains(['&', '|', '<', '>', '^', '%', '\'']),
        "{reply}"
    );
    // Held read-only: the hold's own entries decide it, and one of
    // them names the tool — the asking entry with a card to show, the
    // refusal without.
    let mut held = asking(AskMode::Ask);
    held.chat_policy = true;
    held.home_chat = true;
    held.home_gated_writes = true;
    assert!(own(&held).is_empty());
    let pre = pre_entries(&held);
    assert!(
        pre.iter()
            .any(|e| e["matcher"] == connector_writes::HOME_GATED_MATCHER),
        "{pre:?}"
    );
    let mut no_card = spec();
    no_card.chat_policy = true;
    no_card.home_chat = true;
    no_card.home_gated_writes = true;
    assert!(own(&no_card).is_empty());
    let pre = pre_entries(&no_card);
    assert!(
        pre.iter()
            .any(|e| e["matcher"] == connector_writes::MATCHER),
        "{pre:?}"
    );
    assert!(
        !pre.iter()
            .any(|e| e["matcher"] == connector_writes::HOME_GATED_MATCHER),
        "{pre:?}"
    );
}

/// Item 872 step 5: `ask_user_to_drive` meets one decider — its own
/// gate — in every position, Home's held read-only chat included: the
/// Ask hook's `mcp__` alternative, the read-only chat's refusals and
/// its asking entries all leave it out. Every `PreToolUse` matcher on
/// the line is run through `node`, as the CLI runs them; the brief's
/// hook (every tool, the budget's) is the one other entry it meets.
#[test]
fn the_drive_ask_meets_only_its_own_gate_in_every_position() {
    let tool = "mcp__nightloom__ask_user_to_drive";
    let brief = BriefSpec {
        hook: vec!["hook".into(), "--subagent-hook".into()],
        dir: PathBuf::from("/logs/ask/chat-3"),
        text: "x".into(),
    };
    let mut bypass = spec();
    bypass.permission_mode = Some("bypassPermissions".into());
    let mut chat = asking(AskMode::Ask);
    chat.chat_policy = true;
    let mut held = asking(AskMode::Ask);
    held.chat_policy = true;
    held.home_chat = true;
    held.home_gated_writes = true;
    let mut home_open = asking(AskMode::Ask);
    home_open.home_chat = true;
    for (name, mut s) in [
        ("bypass", bypass),
        ("auto", asking(AskMode::Auto)),
        ("ask", asking(AskMode::Ask)),
        ("plan", asking(AskMode::Plan)),
        ("a read-only chat", chat),
        ("Home's read-only chat", held),
        ("a chat of Home's not held", home_open),
        ("with Playwright", with_playwright(asking(AskMode::Ask))),
    ] {
        s.brief = Some(brief.clone());
        let pre = pre_entries(&s);
        let matchers: Vec<String> = pre
            .iter()
            .map(|e| e["matcher"].as_str().unwrap_or(".*").to_string())
            .collect();
        let script = format!(
            "const m={m};console.log(JSON.stringify(m.map(x=>new RegExp('^(?:'+x+')$').test({t})||new RegExp(x).test({t}))));",
            m = serde_json::to_string(&matchers).unwrap(),
            t = serde_json::to_string(tool).unwrap(),
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
        let hit: Vec<bool> = serde_json::from_slice(&out.stdout).unwrap();
        let met: Vec<&str> = matchers
            .iter()
            .zip(hit)
            .filter(|(m, hit)| *hit && m.as_str() != brief::BRIEF_MATCHER)
            .map(|(m, _)| m.as_str())
            .collect();
        assert_eq!(met, [crate::home::drive::GATE_MATCHER], "{name}");
    }
}

fn pre_entries(s: &AgentSpec) -> Vec<serde_json::Value> {
    let a = s.args("hi");
    let Some(i) = a.iter().position(|x| x == "--settings") else {
        return Vec::new();
    };
    let v: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
    v["hooks"]["PreToolUse"]
        .as_array()
        .cloned()
        .unwrap_or_default()
}

fn with_playwright(mut s: AgentSpec) -> AgentSpec {
    s.playwright = Some(own_browser::PlaywrightGate {
        hook: vec!["/app/nl".into(), "--permission-hook".into()],
        dir: PathBuf::from("/logs/ask/chat-3"),
        side: false,
        no_card: false,
        wait: false,
    });
    s
}

/// Backlog 367: Playwright's gate is on the line in every position —
/// bypass (no Ask at all), Auto, Ask, Plan, the Chat policy — as the
/// chat's hook on the chat's directory, and it is the only entry that
/// matches a Playwright tool, so no second hook races it.
#[test]
fn the_playwright_gate_is_registered_in_every_position() {
    let mut bypass = with_playwright(spec());
    bypass.permission_mode = Some("bypassPermissions".into());
    let mut chat = with_playwright(asking(AskMode::Ask));
    chat.chat_policy = true;
    chat.browser = true;
    let positions = [
        ("bypass", bypass),
        ("auto", with_playwright(asking(AskMode::Auto))),
        ("ask", with_playwright(asking(AskMode::Ask))),
        ("plan", with_playwright(asking(AskMode::Plan))),
        ("chat policy", chat),
    ];
    for (name, s) in positions {
        let pre = pre_entries(&s);
        let matching: Vec<&serde_json::Value> = pre
            .iter()
            .filter(|e| {
                let m = e["matcher"].as_str().unwrap_or("");
                // The brief's entry matches every tool and decides
                // nothing about permission; none is set here.
                regex_like_matches(m, "mcp__playwright__browser_navigate")
                    && m != CHAT_POLICY_MATCHER
            })
            .collect();
        assert_eq!(matching.len(), 1, "{name}: {pre:?}");
        assert_eq!(matching[0]["matcher"], own_browser::MATCHER, "{name}");
        assert_eq!(
            matching[0]["hooks"][0]["command"],
            format!(
                "'/app/nl' '--permission-hook' '/logs/ask/chat-3' {}",
                own_browser::FAIL_CLOSED
            ),
            "{name}"
        );
    }
    // Without the server there is no gate.
    assert!(pre_entries(&spec()).is_empty());
    // The Ask matcher still asks about every other MCP tool.
    assert!(regex_like_matches(ask::MATCHER, "mcp__nightloom__remember"));
    assert!(!regex_like_matches(
        ask::MATCHER,
        "mcp__playwright__browser_click"
    ));
}

fn with_brief(mut s: AgentSpec) -> AgentSpec {
    s.brief = Some(brief::BriefSpec {
        hook: vec!["/app/nl".into(), "--subagent-hook".into()],
        dir: PathBuf::from("/logs/ask/chat-3"),
        text: String::new(),
    });
    s
}

/// Item 613: `add_folder`'s gate is on the line in every position, as
/// this binary's permission hook on the chat's directory, and the only
/// permission entry that matches the tool — the Ask hook leaves it out.
/// A side process's gate carries `--side`; no directory, no gate.
#[test]
fn the_add_folder_gate_is_registered_in_every_position() {
    let mut bypass = with_brief(spec());
    bypass.permission_mode = Some("bypassPermissions".into());
    let mut chat = with_brief(asking(AskMode::Ask));
    chat.chat_policy = true;
    chat.browser = true;
    let mut chat_plain = with_brief(asking(AskMode::Ask));
    chat_plain.chat_policy = true;
    let positions = [
        ("bypass", bypass),
        ("auto", with_brief(asking(AskMode::Auto))),
        ("ask", with_brief(asking(AskMode::Ask))),
        ("plan", with_brief(asking(AskMode::Plan))),
        ("chat policy, browser", chat),
        ("chat policy", chat_plain),
    ];
    let tool = "mcp__nightloom__add_folder";
    for (name, s) in positions {
        let pre = pre_entries(&s);
        let gates: Vec<&serde_json::Value> = pre
            .iter()
            .filter(|e| {
                let m = e["matcher"].as_str().unwrap_or("");
                let cmd = e["hooks"][0]["command"].as_str().unwrap_or("");
                regex_like_matches(m, tool) && cmd.contains("--permission-hook")
            })
            .collect();
        assert_eq!(gates.len(), 1, "{name}: {pre:?}");
        assert_eq!(gates[0]["matcher"], crate::tools::add_folder::GATE_MATCHER);
        assert_eq!(
            gates[0]["hooks"][0]["command"],
            format!("'/app/nl' '--permission-hook' '/logs/ask/chat-3' {FOLDER_GATE_FAIL_CLOSED}"),
            "{name}"
        );
    }
    let mut side = with_brief(asking(AskMode::Auto));
    side.folder_side = true;
    let entry = side.folder_gate_entry().unwrap();
    assert!(
        entry["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains("'--side'")
    );
    assert!(spec().folder_gate_entry().is_none());
    let mut pointless = with_brief(spec());
    if let Some(b) = &mut pointless.brief {
        b.dir = PathBuf::new();
    }
    assert!(pointless.folder_gate_entry().is_none());
    // Every other MCP tool still asks under Ask.
    assert!(regex_like_matches(ask::MATCHER, "mcp__nightloom__remember"));
    assert!(!regex_like_matches(ask::MATCHER, tool));
}

/// An aside and a checkpoint fork keep the gate but never defer
/// (`--side`); an ephemeral chat's gate refuses outright.
#[test]
fn side_processes_and_ephemeral_chats_never_defer_playwright() {
    let mut s = with_playwright(asking(AskMode::Auto));
    s.resume = Some("sess".into());
    let aside = s.aside().unwrap();
    let cmd = |s: &AgentSpec| {
        pre_entries(s)
            .into_iter()
            .find(|e| e["matcher"] == own_browser::MATCHER)
            .unwrap()["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .to_string()
    };
    assert!(cmd(&aside).contains("'--side' ||"));
    let fork = s.checkpoint_fork().unwrap();
    assert!(cmd(&fork).contains("'--side' ||"));
    assert!(!cmd(&s).contains("--side"));
    let mut eph = with_playwright(spec());
    eph.apply_mode(ChatMode::Ephemeral);
    assert!(cmd(&eph).contains("\"deny\""));
}

fn mode_of(a: &[String]) -> String {
    let i = a.iter().position(|x| x == "--permission-mode").unwrap();
    a[i + 1].clone()
}

pub(super) fn matcher_of(a: &[String]) -> String {
    let i = a.iter().position(|x| x == "--settings").unwrap();
    let v: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
    v["hooks"]["PreToolUse"][0]["matcher"]
        .as_str()
        .unwrap()
        .to_string()
}

/// The Plan position is the Ask position under `plan` mode: the same
/// hook on the same matcher, the same prompt tool, and `plan` in
/// place of `default` — whatever mode the shell would have sent.
#[test]
fn the_plan_position_is_the_ask_position_in_plan_mode() {
    let a = asking(AskMode::Plan).args("hi");
    assert_eq!(mode_of(&a), "plan");
    assert!(!a.iter().any(|x| x == "auto"), "{a:?}");
    assert_eq!(matcher_of(&a), ask::MATCHER);
    assert!(a.iter().any(|x| x == "--permission-prompt-tool"));
    let b = asking(AskMode::Ask).args("hi");
    assert_eq!(mode_of(&b), "default");
    assert_eq!(matcher_of(&b), matcher_of(&a));
    assert!(ClaudeCodeAgent::new(asking(AskMode::Plan)).planning());
    assert!(!ClaudeCodeAgent::new(asking(AskMode::Ask)).planning());
}

/// Approve → Ask: the resume goes out in `plan` still (the tool
/// errors "not in plan mode" under any other, measured), and only
/// after it does the chat become Ask.
#[test]
fn approving_a_plan_into_ask_keeps_plan_mode_for_the_resume_then_asks() {
    let mut agent = ClaudeCodeAgent::new(asking(AskMode::Plan));
    agent.plan_approved(PlanThen::Ask);
    let r = agent.spec().resume_args();
    assert_eq!(mode_of(&r), "plan");
    assert_eq!(matcher_of(&r), ask::MATCHER);
    agent.plan_exited();
    assert!(!agent.planning());
    let a = agent.spec().args("next");
    assert_eq!(mode_of(&a), "default");
    assert_eq!(matcher_of(&a), ask::MATCHER, "the hook stays: Ask");
}

/// Approve → Auto: one resume in `auto` with the hook narrowed to
/// the plan tool — a resume with no hook at all is refused by the
/// CLI (`tool_deferred_unavailable`, measured) — and then the Auto
/// position proper: ~~no hook, no prompt tool, `auto`~~ since backlog
/// 294 (2026-10-03), `auto` with the hook on the question alone.
#[test]
fn approving_a_plan_into_auto_narrows_the_hook_for_one_resume_then_drops_it() {
    let mut agent = ClaudeCodeAgent::new(asking(AskMode::Plan));
    agent.plan_approved(PlanThen::Auto);
    let r = agent.spec().resume_args();
    assert_eq!(mode_of(&r), "auto");
    assert_eq!(matcher_of(&r), "ExitPlanMode");
    assert!(r.iter().any(|x| x == "--permission-prompt-tool"), "{r:?}");
    agent.plan_exited();
    assert_eq!(agent.spec().ask.as_ref().unwrap().mode, AskMode::Auto);
    let a = agent.spec().args("next");
    assert_eq!(mode_of(&a), AgentSpec::headless_permission_mode(true));
    assert!(a.iter().any(|x| x == "--permission-prompt-tool"), "{a:?}");
    assert_eq!(matcher_of(&a), ask::AUTO_MATCHER);
    // Neither call does anything on a connection that is not asking,
    // nor on one in the Ask position (a plan the model entered on its
    // own): the chat stays where the rail shows it.
    let mut plain = ClaudeCodeAgent::new(spec());
    plain.plan_approved(PlanThen::Auto);
    plain.plan_exited();
    assert!(plain.spec().ask.is_none() && plain.spec().permission_mode.is_none());
    let mut asking_chat = ClaudeCodeAgent::new(asking(AskMode::Ask));
    asking_chat.plan_approved(PlanThen::Auto);
    assert_eq!(mode_of(&asking_chat.spec().resume_args()), "default");
    asking_chat.plan_exited();
    assert_eq!(mode_of(&asking_chat.spec().args("next")), "default");
}

/// Every `PreToolUse` entry on the line: (matcher, command).
fn pre_tool_use(a: &[String]) -> Vec<(String, String)> {
    let Some(i) = a.iter().position(|x| x == "--settings") else {
        return Vec::new();
    };
    let v: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
    v["hooks"]["PreToolUse"]
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .map(|e| {
                    (
                        e["matcher"].as_str().unwrap_or_default().to_string(),
                        e["hooks"][0]["command"]
                            .as_str()
                            .unwrap_or_default()
                            .to_string(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The Auto position (nightshift backlog 294): `auto`, the prompt tool
/// named so the CLI offers `AskUserQuestion`, the Ask hook on that
/// tool alone — so nothing else pauses — and the plan tools refused in
/// words by a second entry. The same on the resume shape, which is how
/// his answer travels back.
#[test]
fn the_auto_position_asks_the_models_question_and_nothing_else() {
    let s = asking(AskMode::Auto);
    for a in [s.args("hi"), s.resume_args()] {
        assert_eq!(mode_of(&a), "auto");
        let i = a
            .iter()
            .position(|x| x == "--permission-prompt-tool")
            .expect("prompt tool");
        assert_eq!(a[i + 1], ask::PROMPT_TOOL);
        let entries = pre_tool_use(&a);
        let ask_entries: Vec<_> = entries
            .iter()
            .filter(|(_, c)| c.contains("--permission-hook"))
            .collect();
        assert_eq!(ask_entries.len(), 1, "{entries:?}");
        assert_eq!(ask_entries[0].0, "AskUserQuestion");
        let plan = entries
            .iter()
            .find(|(m, _)| m == ask::PLAN_TOOLS_MATCHER)
            .expect("plan refusal");
        assert!(plan.1.contains("\"deny\""), "{plan:?}");
        assert!(plan.1.contains(ask::PLAN_TOOLS_ON_AUTO), "{plan:?}");
        // Quoted for the shell: no single quote inside the reply.
        assert!(!ask::PLAN_TOOLS_ON_AUTO.contains('\''));
    }
    // None of the tools that pause under Ask is in the Auto matcher.
    for tool in ask::MATCHER.split('|').filter(|t| *t != ask::QUESTION_TOOL) {
        assert!(
            !ask::AUTO_MATCHER.split('|').any(|m| m == tool),
            "{tool} would pause on Auto"
        );
    }
    // Not planning, and Ask stays Ask: no plan refusal there.
    assert!(!ClaudeCodeAgent::new(asking(AskMode::Auto)).planning());
    let b = asking(AskMode::Ask).args("hi");
    assert!(
        !pre_tool_use(&b)
            .iter()
            .any(|(m, _)| m == ask::PLAN_TOOLS_MATCHER)
    );
}

/// The CLI's tool text by permission mode (CLI 2.1.326, Opus 5.5,
/// measured 2026-11-16): two classes. A side process must stay in its
/// chat's class, or its first request reads none of the chat's cache.
fn tool_text_class(mode: &str) -> u8 {
    match mode {
        "default" | "dontAsk" => 1,
        "auto" | "plan" | "bypassPermissions" => 2,
        other => panic!("unmeasured mode {other}"),
    }
}

/// An aside of an Auto chat (backlog 294; item 758's follow-up,
/// 2026-11-16): ~~`dontAsk`, no hook of any kind~~ — `auto`, as the
/// chat's checkpoint fork, since `dontAsk` sends other tool text and
/// the aside read none of the cache. Still no Ask hook (a question has
/// no card waiting), the prompt tool still named, the plan refusal
/// kept; the same for the keep-warm ping, which is an aside.
#[test]
fn an_aside_of_an_auto_chat_asks_nothing() {
    let mut s = asking(AskMode::Auto);
    s.resume = Some("sess-1".into());
    let chat = s.args("turn");
    for side in [s.aside().unwrap(), s.keep_warm_ping().unwrap()] {
        assert_eq!(side.ask.as_ref().unwrap().mode, AskMode::AutoFork);
        let a = side.args("q");
        assert_eq!(mode_of(&a), "auto");
        assert_eq!(
            tool_text_class(&mode_of(&a)),
            tool_text_class(&mode_of(&chat))
        );
        assert!(a.iter().any(|x| x == "--permission-prompt-tool"), "{a:?}");
        let entries = pre_tool_use(&a);
        assert!(
            !entries.iter().any(|(_, c)| c.contains("--permission-hook")),
            "{entries:?}"
        );
        assert!(entries.iter().any(|(m, _)| m == ask::PLAN_TOOLS_MATCHER));
    }
    // And the Ask chat's aside is as it was — in the chat's class.
    let mut s = asking(AskMode::Ask);
    s.resume = Some("sess-1".into());
    let a = s.aside().unwrap().args("q");
    assert_eq!(mode_of(&a), "dontAsk");
    assert_eq!(
        tool_text_class(&mode_of(&a)),
        tool_text_class(&mode_of(&s.args("turn")))
    );
    assert!(pre_tool_use(&a).is_empty());
}

/// The CLI's mode for a command line: its flag, or the CLI's own
/// default when none is sent.
fn mode_or_default(a: &[String]) -> String {
    match a.iter().position(|x| x == "--permission-mode") {
        Some(i) => a[i + 1].clone(),
        None => "default".into(),
    }
}

/// Every chat mode's aside and keep-warm ping sit in the chat's
/// measured tool-text class (item 774, blocker 2037, 2026-11-16), carry
/// no Ask hook, and can do nothing the chat could not: a Plan chat's in
/// `plan`; an approval-off chat's aside in `plan` and its ping in
/// `bypassPermissions`; an Ask chat's and a default one's in `dontAsk`.
#[test]
fn every_chat_modes_aside_and_ping_stay_in_the_chats_tool_class() {
    // (chat, the aside's mode, the ping's mode)
    let mut chats: Vec<(AgentSpec, &str, &str)> = Vec::new();
    for (mode, side) in [
        (AskMode::Ask, "dontAsk"),
        (AskMode::Plan, "plan"),
        (AskMode::Auto, "auto"),
        (AskMode::ExitingToAuto, "auto"),
    ] {
        chats.push((asking(mode), side, side));
    }
    for (mode, aside, ping) in [
        (None, "dontAsk", "dontAsk"),
        (Some("default"), "dontAsk", "dontAsk"),
        (Some("dontAsk"), "dontAsk", "dontAsk"),
        (Some("auto"), "plan", "auto"),
        (Some("bypassPermissions"), "plan", "bypassPermissions"),
    ] {
        let mut s = spec();
        s.permission_mode = mode.map(Into::into);
        chats.push((s, aside, ping));
    }
    for (mut s, aside_mode, ping_mode) in chats {
        s.resume = Some("sess-1".into());
        let chat = s.args("turn");
        let class = tool_text_class(&mode_or_default(&chat));
        let aside = s.aside().unwrap();
        let ping = s.keep_warm_ping().unwrap();
        for (side, want, what) in [(&aside, aside_mode, "aside"), (&ping, ping_mode, "ping")] {
            let a = side.args("q");
            assert_eq!(mode_of(&a), want, "{what} of {chat:?}");
            assert_eq!(tool_text_class(&mode_of(&a)), class, "{what} of {chat:?}");
            let entries = pre_tool_use(&a);
            assert!(
                !entries.iter().any(|(_, c)| c.contains("--permission-hook")),
                "{what}: {entries:?}"
            );
            // The prompt tool is named exactly when the chat names it.
            assert_eq!(
                a.iter().any(|x| x == "--permission-prompt-tool"),
                s.ask.is_some(),
                "{what}: {a:?}"
            );
        }
        assert_eq!(ping.max_turns, Some(1));
        assert_eq!(aside.max_turns, s.max_turns);
    }
    // A Plan chat's side process is the PlanAside position, not Plan:
    // nothing to approve, so `planning()` is off on it.
    let mut s = asking(AskMode::Plan);
    s.resume = Some("sess-1".into());
    let side = s.aside().unwrap();
    assert_eq!(side.ask.as_ref().unwrap().mode, AskMode::PlanAside);
    assert!(!ClaudeCodeAgent::new(side).planning());
}

/// The model the CLI runs for `--model <m>` in a mode (CLI 2.1.326,
/// measured 2026-11-17, wave O): Haiku runs as Sonnet 5.5 under `plan`
/// and as itself in every other mode.
fn runs_as(model: Option<&str>, mode: &str) -> String {
    match model {
        Some(m) if m.to_ascii_lowercase().contains("haiku") && mode == "plan" => "sonnet".into(),
        Some(m) => m.into(),
        None => "default".into(),
    }
}

/// A Haiku chat's aside runs the chat's model (item 802): `--model
/// haiku` under `plan` runs Sonnet 5.5, so an approval-off or no-hook
/// Auto Haiku chat's aside keeps `dontAsk` (Haiku) rather than taking
/// `plan` (Sonnet, none of the chat's cache); a Haiku chat that runs
/// `plan` itself keeps a `plan` aside. Other models are unchanged.
#[test]
fn a_haiku_chats_aside_runs_haiku() {
    for model in ["haiku", "claude-haiku-5-5", "Haiku"] {
        for (mode, want) in [
            (None, "dontAsk"),
            (Some("default"), "dontAsk"),
            (Some("dontAsk"), "dontAsk"),
            (Some("auto"), "dontAsk"),
            (Some("bypassPermissions"), "dontAsk"),
            (Some("plan"), "plan"),
        ] {
            let mut s = spec();
            s.model = Some(model.into());
            s.permission_mode = mode.map(Into::into);
            s.resume = Some("sess-1".into());
            let chat = s.args("turn");
            let a = s.aside().unwrap().args("q");
            assert_eq!(mode_of(&a), want, "{model} {mode:?}");
            assert_eq!(
                runs_as(Some(model), &mode_of(&a)),
                runs_as(Some(model), &mode_or_default(&chat)),
                "{model} {mode:?}"
            );
        }
        // Ask-hook chats: each side process runs the chat's model.
        for mode in [
            AskMode::Ask,
            AskMode::Plan,
            AskMode::Auto,
            AskMode::ExitingToAuto,
        ] {
            let mut s = asking(mode);
            s.model = Some(model.into());
            s.resume = Some("sess-1".into());
            let chat = s.args("turn");
            let a = s.aside().unwrap().args("q");
            assert_eq!(
                runs_as(Some(model), &mode_of(&a)),
                runs_as(Some(model), &mode_or_default(&chat)),
                "{model} {mode:?}"
            );
        }
    }
    // An aside he points at Haiku from an approval-off Opus chat runs
    // Haiku too, and one pointed at Opus from a Haiku chat takes `plan`.
    let mut s = spec();
    s.model = Some("opus".into());
    s.permission_mode = Some("bypassPermissions".into());
    s.resume = Some("sess-1".into());
    assert_eq!(
        mode_of(&s.aside_with(Some("haiku"), None).unwrap().args("q")),
        "dontAsk"
    );
    assert_eq!(
        mode_of(&s.aside_with(None, None).unwrap().args("q")),
        "plan"
    );
    s.model = Some("haiku".into());
    assert_eq!(
        mode_of(&s.aside_with(Some("opus"), None).unwrap().args("q")),
        "plan"
    );
    // Not Haiku: as 2037 set it.
    for model in [None, Some("opus"), Some("claude-fable-5-2")] {
        assert_eq!(AgentSpec::side_permission_mode(Some("auto"), model), "plan");
        assert_eq!(
            AgentSpec::side_permission_mode(Some("bypassPermissions"), model),
            "plan"
        );
        assert_eq!(
            AgentSpec::side_permission_mode(Some("default"), model),
            "dontAsk"
        );
    }
}

/// A checkpoint fork of an Auto chat stays on `auto` (as before 294),
/// with no Ask hook — a question there has no card to wait on — and
/// the plan refusal kept.
#[test]
fn a_checkpoint_fork_of_an_auto_chat_stays_on_auto_without_the_ask_hook() {
    let mut s = asking(AskMode::Auto);
    s.resume = Some("sess-1".into());
    let f = s.checkpoint_fork().unwrap();
    assert_eq!(f.ask.as_ref().unwrap().mode, AskMode::AutoFork);
    let a = f.args("");
    assert_eq!(mode_of(&a), "auto");
    assert!(a.iter().any(|x| x == "--permission-prompt-tool"));
    let entries = pre_tool_use(&a);
    assert!(
        !entries.iter().any(|(_, c)| c.contains("--permission-hook")),
        "{entries:?}"
    );
    assert!(entries.iter().any(|(m, _)| m == ask::PLAN_TOOLS_MATCHER));
}

/// Wave O (2026-11-17; 2037's left-out): a checkpoint fork, of every
/// chat mode, sends the chat's own request flags — the permission mode
/// in the chat's tool-text class and nothing else changed but the
/// settings JSON (hooks, not the request) and the fork's own flags.
/// ~~A Plan chat's and an approved plan's (ExitingToAuto) forks ran
/// `dontAsk`~~, which on Opus 5.5 sends other Bash text, and on a
/// Haiku chat runs Haiku where `plan` runs Sonnet, so the fork missed.
#[test]
fn every_chat_modes_checkpoint_fork_sends_the_chats_request_flags() {
    // Everything but the prompt, the settings JSON and the fork's flags.
    fn request_flags(a: &[String]) -> Vec<String> {
        let mut out = Vec::new();
        let mut it = a.iter();
        while let Some(x) = it.next() {
            match x.as_str() {
                "-p" | "--settings" => {
                    it.next();
                }
                "--fork-session" | "--no-session-persistence" => {}
                "--permission-mode" => {
                    it.next();
                }
                _ => out.push(x.clone()),
            }
        }
        out
    }
    let mut chats: Vec<(AgentSpec, &str)> = Vec::new();
    for (mode, fork) in [
        (AskMode::Ask, "dontAsk"),
        (AskMode::Plan, "plan"),
        (AskMode::Auto, "auto"),
        (AskMode::ExitingToAuto, "auto"),
    ] {
        chats.push((asking(mode), fork));
    }
    // No Ask hook: the fork keeps the chat's mode, as before.
    for mode in [
        None,
        Some("default"),
        Some("dontAsk"),
        Some("auto"),
        Some("bypassPermissions"),
    ] {
        let mut s = spec();
        s.permission_mode = mode.map(Into::into);
        chats.push((s, mode.unwrap_or("")));
    }
    for (mut s, want) in chats {
        s.resume = Some("sess-1".into());
        s.brief = Some(BriefSpec {
            hook: vec!["hook".into()],
            dir: PathBuf::from("/chat"),
            text: "brief".into(),
        });
        let chat = s.args("turn");
        let f = s.checkpoint_fork().unwrap();
        let a = f.args("");
        assert_eq!(
            mode_or_default(&a),
            if want.is_empty() { "default" } else { want },
            "{chat:?}"
        );
        assert_eq!(
            tool_text_class(&mode_or_default(&a)),
            tool_text_class(&mode_or_default(&chat)),
            "{chat:?}"
        );
        assert_eq!(request_flags(&a), request_flags(&chat), "{chat:?}");
        assert!(f.brief.is_some(), "the budget hook rides in the fork");
        // No Ask hook: nothing points at the chat's card directory.
        let entries = pre_tool_use(&a);
        assert!(
            !entries.iter().any(|(_, c)| c.contains("/logs/ask/chat-3")),
            "{entries:?}"
        );
    }
    // A Plan chat's fork has nothing to approve: `planning()` is off.
    let mut s = asking(AskMode::Plan);
    s.resume = Some("sess-1".into());
    let f = s.checkpoint_fork().unwrap();
    assert_eq!(f.ask.as_ref().unwrap().mode, AskMode::PlanAside);
    assert!(!ClaudeCodeAgent::new(f).planning());
}

/// Beside the Chat policy (backlog 147's narrowing), the Auto position
/// registers no Ask entry — the policy refuses the question, as it
/// does under Ask (blocker 1032) — and no second plan refusal.
#[test]
fn under_the_chat_policy_the_auto_position_adds_no_hook() {
    let mut s = asking(AskMode::Auto);
    s.apply_kind_policy(ChatKind::Chat, ChatKind::Build);
    let entries = pre_tool_use(&s.args("hi"));
    // (Item 783: the one hook entry there is the read-only chat's own,
    // on the connector actions and `remember` — never the question.)
    assert!(
        entries
            .iter()
            .filter(|(_, c)| c.contains("--permission-hook"))
            .all(|(m, c)| m == connector_writes::CARD_MATCHER && c.contains(ask::READ_ONLY_ARG)),
        "{entries:?}"
    );
    assert!(!entries.iter().any(|(m, _)| m == ask::PLAN_TOOLS_MATCHER));
    assert!(entries.iter().any(|(m, _)| m == CHAT_POLICY_MATCHER));
}
