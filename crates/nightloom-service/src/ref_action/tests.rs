//! Item 993d's tests: the call a click becomes, the one-time pass, and —
//! blocker 2304 — that a model's own call to a send goes nowhere in any
//! position without his click.

use super::*;
use crate::agent::ask;
use crate::agent::{AskMode, AskSpec, connector_writes, send_guard};
use nightloom_core::ChatKind;
use std::path::PathBuf;

const GMAIL: &str = "claude.ai Gmail 2117773e";
const CAL: &str = "claude.ai Google Calendar";

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("nl-ref-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn event() -> Item {
    Item {
        kind: "event".into(),
        id: "_60q30abc".into(),
        src: CAL.into(),
        cal: Some("primary".into()),
        name: "COAST Meeting".into(),
    }
}

fn email() -> Item {
    Item {
        kind: "email".into(),
        id: "19a0f3".into(),
        src: GMAIL.into(),
        cal: None,
        name: "Speaker confirmation".into(),
    }
}

fn accept(note: &str) -> Act {
    Act::Rsvp {
        answer: "accepted".into(),
        note: note.into(),
    }
}

fn stdin(tool: &str, input: &Value) -> String {
    json!({ "tool_name": tool, "tool_use_id": "t1", "permission_mode": "dontAsk", "tool_input": input })
        .to_string()
}

#[test]
fn an_answer_is_one_respond_call_on_the_links_own_calendar() {
    let call = call_for(&event(), &accept("")).unwrap();
    assert_eq!(
        call.tool,
        "mcp__claude_ai_Google_Calendar__respond_to_event"
    );
    assert_eq!(
        call.input,
        json!({ "eventId": "_60q30abc", "calendarId": "primary", "responseStatus": "accepted" })
    );
    assert_eq!(call.words_key, None);
    assert!(call.sends && send_guard::sends(&call.tool));

    let mut bare = event();
    bare.cal = None;
    let call = call_for(&bare, &accept("  running late  ")).unwrap();
    assert_eq!(
        call.input,
        json!({ "eventId": "_60q30abc", "responseStatus": "accepted", "responseComment": "running late" })
    );
    assert_eq!(call.words_key, Some("responseComment"));
}

#[test]
fn a_saved_reply_is_one_draft_under_the_message_and_never_a_send() {
    let act = Act::SaveDraft {
        mode: "reply".into(),
        to: "Priya S.".into(),
        body: "Thanks —\nsee you there.".into(),
    };
    let call = call_for(&email(), &act).unwrap();
    assert_eq!(call.tool, "mcp__claude_ai_Gmail_2117773e__create_draft");
    assert_eq!(
        call.input,
        json!({ "replyToMessageId": "19a0f3", "body": "Thanks —\nsee you there." })
    );
    assert!(!call.sends && !send_guard::sends(&call.tool));

    let fwd = Act::SaveDraft {
        mode: "forward".into(),
        to: " sam@example.com ".into(),
        body: "FYI".into(),
    };
    let call = call_for(&email(), &fwd).unwrap();
    assert_eq!(
        call.input,
        json!({ "to": ["sam@example.com"], "subject": "Fwd: Speaker confirmation", "body": "FYI" })
    );
}

#[test]
fn what_cannot_be_a_call_is_refused_with_the_reason() {
    // The wrong kind of item, an answer that is not one, an empty body.
    assert!(call_for(&email(), &accept("")).is_err());
    assert!(
        call_for(
            &event(),
            &Act::Rsvp {
                answer: "needsAction".into(),
                note: String::new()
            }
        )
        .is_err()
    );
    let empty = Act::SaveDraft {
        mode: "reply".into(),
        to: String::new(),
        body: "  ".into(),
    };
    assert!(call_for(&email(), &empty).is_err());
    // A source that is not one of his connectors: no tool is named from it.
    for src in ["", "claude.ai ", "nightloom", "Gmail", "openalex"] {
        let mut it = event();
        it.src = src.into();
        assert!(call_for(&it, &accept("")).is_err(), "{src}");
    }
    // An id that is not one.
    for id in ["", "a b", "a\nb"] {
        let mut it = event();
        it.id = id.into();
        assert!(call_for(&it, &accept("")).is_err(), "{id:?}");
    }
    // A forward's draft goes to a full address or to nobody yet.
    for to in [
        "Sam",
        "sam@",
        "a@b",
        "a@b.c, d@e.f",
        "Sam <sam@example.com>",
    ] {
        let act = Act::SaveDraft {
            mode: "forward".into(),
            to: to.into(),
            body: "x".into(),
        };
        assert!(call_for(&email(), &act).is_err(), "{to}");
    }
}

#[test]
fn a_pass_covers_exactly_its_call_and_nothing_near_it() {
    let call = call_for(&event(), &accept("see you")).unwrap();
    let pass = Pass::of(&call, Utc::now());
    // His words are not in the pass, only their hash.
    assert!(!serde_json::to_string(&pass).unwrap().contains("see you"));
    assert!(pass.covers(&call.tool, &call.input));
    let with = |k: &str, v: Value| {
        let mut i = call.input.clone();
        i[k] = v;
        i
    };
    let near = [
        with("eventId", json!("_60q30abd")),
        with("calendarId", json!("other@example.com")),
        with("responseStatus", json!("declined")),
        with("responseComment", json!("see you!")),
        with("responseComment", json!(["see you"])),
        with("notificationLevel", json!("ALL")),
        json!({ "eventId": "_60q30abc", "calendarId": "primary", "responseStatus": "accepted" }),
        json!("accepted"),
        Value::Null,
    ];
    for input in &near {
        assert!(!pass.covers(&call.tool, input), "{input}");
    }
    for tool in [
        "mcp__claude_ai_Google_Calendar__update_event",
        "mcp__claude_ai_Google_Calendar_2__respond_to_event",
        "mcp__claude_ai_Gmail__reply",
        "respond_to_event",
    ] {
        assert!(!pass.covers(tool, &call.input), "{tool}");
    }
}

/// Blocker 2304, the pass's half: with no click there is no pass, and the
/// hook refuses every call — each send, a draft, a read.
#[test]
fn with_no_pass_every_call_is_refused() {
    let dir = tmp("nopass");
    for tool in [
        "mcp__claude_ai_Gmail__send_message",
        "mcp__claude_ai_Gmail__reply",
        "mcp__claude_ai_Gmail__forward",
        "mcp__claude_ai_Google_Calendar__respond_to_event",
        "mcp__claude_ai_Gmail__create_draft",
        "mcp__claude_ai_Gmail__get_message",
        "mcp__nightloom__search_chats",
    ] {
        let r = decide(
            &dir,
            &stdin(tool, &json!({ "messageId": "19a0f3", "body": "hi" })),
            Utc::now(),
        );
        assert_eq!(r.decision(), "deny", "{tool}");
    }
    assert_eq!(decide(&dir, "not json", Utc::now()).decision(), "deny");
}

#[test]
fn a_pass_lets_its_one_call_through_once_and_only_in_time() {
    let dir = tmp("pass");
    let call = call_for(&event(), &accept("see you")).unwrap();
    let now = Utc::now();
    mint(&dir, &call, now).unwrap();

    // Anything but the call: refused, and the pass is not spent by it.
    let mut other = call.input.clone();
    other["responseStatus"] = json!("declined");
    for (tool, input) in [
        (call.tool.as_str(), &other),
        ("mcp__claude_ai_Gmail__send_message", &call.input),
        ("mcp__claude_ai_Google_Calendar__get_event", &call.input),
    ] {
        assert_eq!(
            decide(&dir, &stdin(tool, input), now).decision(),
            "deny",
            "{tool}"
        );
    }
    assert!(dir.join(PASS_FILE).exists());

    // A subagent's call, even the right one.
    let sub =
        json!({ "tool_name": call.tool, "agent_id": "a1", "tool_input": call.input }).to_string();
    assert_eq!(decide(&dir, &sub, now).decision(), "deny");

    // The call: once.
    let line = stdin(&call.tool, &call.input);
    assert_eq!(decide(&dir, &line, now).decision(), "allow");
    assert!(!dir.join(PASS_FILE).exists(), "spent");
    assert_eq!(decide(&dir, &line, now).decision(), "deny", "never twice");

    // Out of time: refused, and the pass is gone.
    mint(&dir, &call, now).unwrap();
    let late = now + chrono::Duration::seconds(PASS_SECS);
    assert_eq!(decide(&dir, &line, late).decision(), "deny");
    assert!(!dir.join(PASS_FILE).exists());
}

/// The one-shot process: Haiku, no built-in tools, nothing that prompts,
/// and every MCP call sent to the pass hook — no `echo` refusal of the
/// sends beside it, which would refuse the approved call too.
#[test]
fn the_action_process_sends_every_mcp_call_to_the_pass_hook() {
    let dir = PathBuf::from("/logs/ref-actions/a1");
    let spec = spec_for(
        &PassSpec::new("claude", Vec::new()),
        Path::new("/tmp/scratch"),
        vec!["/app/nightloom-desktop".into(), "--permission-hook".into()],
        &dir,
        vec!["claude.ai Google Drive".into()],
    );
    let a = spec.args("go");
    let at = |flag: &str| a.iter().position(|x| x == flag).map(|i| a[i + 1].clone());
    assert_eq!(at("--model").as_deref(), Some(MODEL));
    assert_eq!(at("--permission-mode").as_deref(), Some("dontAsk"));
    assert_eq!(at("--tools").as_deref(), Some(""));
    assert!(a.iter().any(|x| x == "--no-session-persistence"));
    assert!(
        a.iter().any(|x| x == "mcp__claude_ai_Google_Drive"),
        "{a:?}"
    );
    let v: Value = serde_json::from_str(&at("--settings").unwrap()).unwrap();
    let pre = v["hooks"]["PreToolUse"].as_array().unwrap();
    assert_eq!(pre.len(), 1, "{v}");
    assert_eq!(pre[0]["matcher"], PASS_MATCHER);
    let command = pre[0]["hooks"][0]["command"].as_str().unwrap();
    assert!(
        command.contains("--permission-hook") && command.contains(PASS_ARG),
        "{command}"
    );
    assert!(command.contains("/logs/ref-actions/a1"), "{command}");
    assert!(command.ends_with(ask::FAIL_CLOSED), "{command}");
}

#[test]
fn the_receipt_is_read_from_the_tools_own_result() {
    let ok = [Seen::Result {
        content: "{\"id\":\"x\"}".into(),
        is_error: false,
    }];
    assert_eq!(receipt(&accept(""), &ok, true).outcome, "done");
    let gone = [Seen::Result {
        content: "Error: Event not found: _60q30abc".into(),
        is_error: true,
    }];
    assert_eq!(receipt(&accept(""), &gone, true).outcome, "not_found");
    let bad = [Seen::Result {
        content: "Error: rate limited\n  try later".into(),
        is_error: true,
    }];
    let r = receipt(&accept(""), &bad, true);
    assert_eq!(r.outcome, "error");
    assert_eq!(r.text, "the connector said: Error: rate limited try later");
    // Refused and never run: nothing was sent, and the receipt says so.
    let denied = [Seen::Denied {
        reason: NOT_THE_CALL.into(),
    }];
    let r = receipt(&accept(""), &denied, false);
    assert_eq!(r.outcome, "error");
    assert!(r.text.contains("nothing was sent"), "{}", r.text);
    assert!(
        receipt(&accept(""), &[], false)
            .text
            .contains("nothing was sent")
    );
    // The hook's refusal comes back as a failed result in its own words.
    assert_eq!(
        Seen::of_result(&format!("Error: {NOT_THE_CALL}"), true),
        Seen::Denied {
            reason: format!("Error: {NOT_THE_CALL}")
        }
    );
    assert!(matches!(Seen::of_result("ok", false), Seen::Result { .. }));
    // A result while the pass is unspent is not the approved call's.
    assert_eq!(receipt(&accept(""), &ok, false).outcome, "error");
    // The pass was spent and no result came back: said as unknown, never as sent.
    let r = receipt(&accept(""), &[], true);
    assert_eq!(r.outcome, "error");
    assert!(r.text.contains("may or may not"), "{}", r.text);
}

// ---- Item 993e: a reply, a reply to all, a forward, sent from his click. ----

fn send(mode: &str, to: &str, body: &str) -> Act {
    Act::Send {
        mode: mode.into(),
        to: to.into(),
        body: body.into(),
    }
}

#[test]
fn a_sent_reply_is_one_reply_call_and_a_forward_goes_only_to_his_address() {
    let reply = call_for(&email(), &send("reply", "Priya S.", "Thanks —\nsee you.")).unwrap();
    assert_eq!(reply.tool, "mcp__claude_ai_Gmail_2117773e__reply");
    assert_eq!(
        reply.input,
        json!({ "messageId": "19a0f3", "replyAll": false, "body": "Thanks —\nsee you." })
    );
    assert_eq!(reply.words_key, Some("body"));
    assert!(reply.sends);
    // The name on the button is never an address: a reply goes where Gmail says.
    assert!(reply.input.get("to").is_none());

    let all = call_for(
        &email(),
        &send("replyAll", "Priya S. and everyone on it", "Yes."),
    )
    .unwrap();
    assert_eq!(all.tool, "mcp__claude_ai_Gmail_2117773e__reply");
    assert_eq!(all.input["replyAll"], json!(true));

    let fwd = call_for(&email(), &send("forward", " sam@example.com ", "FYI")).unwrap();
    assert_eq!(fwd.tool, "mcp__claude_ai_Gmail_2117773e__forward");
    assert_eq!(
        fwd.input,
        json!({ "messageId": "19a0f3", "to": ["sam@example.com"], "forwardText": "FYI" })
    );
    assert_eq!(fwd.words_key, Some("forwardText"));
    assert!(fwd.sends);
    for tool in [&reply.tool, &fwd.tool] {
        assert!(send_guard::sends(tool), "{tool}");
    }
}

#[test]
fn a_send_with_no_body_no_recipient_or_the_wrong_item_is_no_call() {
    for act in [
        send("reply", "Priya", ""),
        send("reply", "Priya", " \n "),
        send("forward", "", "FYI"),
        send("forward", "Sam", "FYI"),
        send("forward", "a@b.c, d@e.f", "FYI"),
        send("forward", "Sam <sam@example.com>", "FYI"),
        send("send", "sam@example.com", "FYI"),
        send("reply", "Priya", &"x".repeat(MAX_WORDS + 1)),
    ] {
        assert!(call_for(&email(), &act).is_err(), "{act:?}");
    }
    assert!(call_for(&event(), &send("reply", "Priya", "hi")).is_err());
    let mut it = email();
    it.id = "a b".into();
    assert!(call_for(&it, &send("reply", "Priya", "hi")).is_err());
    let mut it = email();
    it.src = "openalex".into();
    assert!(call_for(&it, &send("reply", "Priya", "hi")).is_err());
}

/// The spec's check: a pass minted for one body refuses a send whose body
/// differs — by a word, a space, a line — and stays unspent for the right one.
#[test]
fn a_pass_for_one_body_refuses_a_send_whose_body_differs() {
    for act in [
        send("reply", "Priya", "See you at 3."),
        send("replyAll", "everyone on it", "See you at 3."),
        send("forward", "sam@example.com", "See you at 3."),
    ] {
        let dir = tmp("body");
        let call = call_for(&email(), &act).unwrap();
        let now = Utc::now();
        let pass = mint(&dir, &call, now).unwrap();
        // The words are not in the pass file, only their hash.
        let file = std::fs::read_to_string(dir.join(PASS_FILE)).unwrap();
        assert!(!file.contains("See you at 3."), "{file}");
        assert!(pass.words_sha256.len() == 64);
        let key = call.words_key.unwrap();
        for other in [
            "See you at 4.",
            "See you at 3. ",
            "See you at 3.\n",
            "see you at 3.",
            "",
        ] {
            let mut input = call.input.clone();
            input[key] = json!(other);
            assert_eq!(
                decide(&dir, &stdin(&call.tool, &input), now).decision(),
                "deny",
                "{other:?}"
            );
            assert!(dir.join(PASS_FILE).exists(), "a refusal spends nothing");
        }
        // His words with one key more (a cc, a signature) are not the call either.
        for (k, v) in [
            ("cc", json!(["x@example.com"])),
            ("includeSignature", json!(true)),
        ] {
            let mut input = call.input.clone();
            input[k] = v;
            assert_eq!(
                decide(&dir, &stdin(&call.tool, &input), now).decision(),
                "deny"
            );
        }
        // A reply's pass is not a reply-all's, nor a forward to someone else.
        let mut wider = call.input.clone();
        if key == "body" {
            wider["replyAll"] = json!(wider["replyAll"] != json!(true));
        } else {
            wider["to"] = json!(["eve@example.com"]);
        }
        assert_eq!(
            decide(&dir, &stdin(&call.tool, &wider), now).decision(),
            "deny"
        );
        // The words that were on screen: let through, once.
        let line = stdin(&call.tool, &call.input);
        assert_eq!(decide(&dir, &line, now).decision(), "allow");
        assert_eq!(decide(&dir, &line, now).decision(), "deny");
    }
}

/// The spec's check, the pass's side: a model turn (no click, so no pass)
/// cannot fire a reply, a reply to all or a forward in the action process —
/// refused in code by the hook, whatever the arguments.
#[test]
fn a_model_turn_cannot_fire_reply_reply_all_or_forward() {
    let dir = tmp("model");
    for act in [
        send("reply", "Priya", "hi"),
        send("replyAll", "everyone", "hi"),
        send("forward", "sam@example.com", "hi"),
    ] {
        let call = call_for(&email(), &act).unwrap();
        let r = decide(&dir, &stdin(&call.tool, &call.input), Utc::now());
        assert_eq!(r.decision(), "deny", "{}", call.tool);
    }
    // A pass for one mail is not a pass for another kind of send.
    let reply = call_for(&email(), &send("reply", "Priya", "hi")).unwrap();
    mint(&dir, &reply, Utc::now()).unwrap();
    let fwd = call_for(&email(), &send("forward", "sam@example.com", "hi")).unwrap();
    assert_eq!(
        decide(&dir, &stdin(&fwd.tool, &fwd.input), Utc::now()).decision(),
        "deny"
    );
}

#[test]
fn a_sent_mail_says_who_it_went_to() {
    let ok = [Seen::Result {
        content: "{\"id\":\"m2\",\"threadId\":\"t1\"}".into(),
        is_error: false,
    }];
    let r = receipt(&send("reply", "Priya S.", "hi"), &ok, true);
    assert_eq!((r.outcome, r.text.as_str()), ("done", "Sent to Priya S."));
    let r = receipt(&send("forward", "sam@example.com", "hi"), &ok, true);
    assert_eq!(r.text, "Forwarded to sam@example.com");
    let r = receipt(&send("reply", "", "hi"), &ok, true);
    assert_eq!(r.text, "Sent");
    // Never "sent" without the tool's own success.
    let r = receipt(&send("reply", "Priya S.", "hi"), &[], true);
    assert!(r.text.contains("may or may not"), "{}", r.text);
    let denied = [Seen::Denied {
        reason: NOT_THE_CALL.into(),
    }];
    let r = receipt(&send("reply", "Priya S.", "hi"), &denied, false);
    assert!(r.text.contains("nothing was sent"), "{}", r.text);
}

// ---- Blocker 2304: a model turn, no click — no position lets a send run. ----

const SENDS: &[&str] = &[
    "mcp__claude_ai_Gmail__send_message",
    "mcp__claude_ai_Gmail_2117773e__reply",
    "mcp__claude_ai_Gmail__forward",
    "mcp__claude_ai_Google_Calendar__respond_to_event",
    "mcp__claude_ai_Google_Calendar__create_event",
    "mcp__claude_ai_Google_Calendar__update_event",
    "mcp__claude_ai_Google_Calendar__delete_event",
    "mcp__claude_ai_Google_Drive__share_file",
];

fn hook() -> Vec<String> {
    vec!["/app/nightloom-desktop".into(), "--permission-hook".into()]
}

fn asking(mode: AskMode, dir: &Path) -> AgentSpec {
    let mut s = AgentSpec::new("/work");
    s.claude_ai_connectors = true;
    s.ask = Some(AskSpec {
        hook: hook(),
        dir: dir.to_path_buf(),
        mode,
        subagents_auto: true,
    });
    s
}

/// The `PreToolUse` entries of `spec`'s settings: (matcher, command).
fn entries(spec: &AgentSpec) -> Vec<(String, String)> {
    let a = spec.args("hi");
    let i = a.iter().position(|x| x == "--settings").expect("settings");
    let v: Value = serde_json::from_str(&a[i + 1]).unwrap();
    v["hooks"]["PreToolUse"]
        .as_array()
        .map(|pre| {
            pre.iter()
                .map(|e| {
                    (
                        e["matcher"].as_str().unwrap_or("").to_string(),
                        e["hooks"][0]["command"].as_str().unwrap_or("").to_string(),
                    )
                })
                .collect()
        })
        .unwrap_or_default()
}

/// For each name, which of `matchers` match it, by the CLI's own regex
/// engine. `None` where `node` is not on the PATH.
fn js_matches(matchers: &[String], names: &[&str]) -> Option<Vec<Vec<bool>>> {
    let script = format!(
        "const m={m}.map(x=>new RegExp(x));console.log(JSON.stringify({n}.map(x=>m.map(r=>r.test(x)))));",
        m = serde_json::to_string(matchers).unwrap(),
        n = serde_json::to_string(names).unwrap(),
    );
    match std::process::Command::new("node")
        .arg("-e")
        .arg(&script)
        .output()
    {
        Ok(o) if o.status.success() => Some(serde_json::from_slice(&o.stdout).unwrap()),
        Ok(o) => panic!("node failed: {}", String::from_utf8_lossy(&o.stderr)),
        Err(e) => {
            eprintln!("SKIPPED: node not runnable here ({e})");
            None
        }
    }
}

/// Every position a chat, an aside, a fork or a job can be in, with his
/// connectors on: each send is met by a refusal (an `echo` deny) or by the
/// hook that asks him — never by nothing. The hook's own answer with no
/// click is the next test.
#[test]
fn no_position_lets_a_models_own_send_run() {
    let dir = PathBuf::from("/logs/ask/chat-1");
    let mut specs: Vec<(String, AgentSpec, bool)> = Vec::new();
    // No hook program at all: a job, a dream, a headless run on either
    // side of the approval switch.
    for mode in [
        None,
        Some("auto"),
        Some("bypassPermissions"),
        Some("dontAsk"),
    ] {
        let mut s = AgentSpec::new("/work");
        s.claude_ai_connectors = true;
        s.permission_mode = mode.map(str::to_string);
        specs.push((format!("no hook, {mode:?}"), s, false));
    }
    for mode in [
        AskMode::Auto,
        AskMode::AutoFork,
        AskMode::ExitingToAuto,
        AskMode::Aside,
        AskMode::PlanAside,
    ] {
        specs.push((format!("{mode:?}"), asking(mode, &dir), false));
    }
    // The two asking positions, and an aside seated on one: the card.
    for mode in [AskMode::Ask, AskMode::Plan] {
        specs.push((format!("{mode:?}"), asking(mode, &dir), true));
    }
    let mut seated = asking(AskMode::Aside, &dir);
    seated.aside_cards = true;
    specs.push(("a seated aside".into(), seated, true));
    // An asking position whose directory is not pointed yet: refused.
    specs.push((
        "Ask, no directory".into(),
        asking(AskMode::Ask, Path::new("")),
        false,
    ));
    // Read-only chats, by policy and by birth, with and without the hook,
    // and Home's (whose invitation answer asks on its own card).
    for (kind, declared) in [
        (ChatKind::Chat, ChatKind::Build),
        (ChatKind::Chat, ChatKind::Chat),
    ] {
        for with_hook in [false, true] {
            for home in [false, true] {
                let mut s = if with_hook {
                    asking(AskMode::Auto, &dir)
                } else {
                    let mut s = AgentSpec::new("/work");
                    s.claude_ai_connectors = true;
                    s
                };
                s.apply_kind(kind);
                s.apply_kind_policy(kind, declared);
                s.home_gated_writes = home;
                s.home_chat = home;
                specs.push((
                    format!("read-only {declared:?} hook={with_hook} home={home}"),
                    s,
                    false,
                ));
            }
        }
    }

    for (what, spec, card) in &specs {
        let es = entries(spec);
        let matchers: Vec<String> = es.iter().map(|(m, _)| m.clone()).collect();
        let Some(hits) = js_matches(&matchers, SENDS) else {
            return;
        };
        for (name, row) in SENDS.iter().zip(hits) {
            let met: Vec<&(String, String)> = es
                .iter()
                .zip(&row)
                .filter(|(_, hit)| **hit)
                .map(|(e, _)| e)
                .collect();
            let refused = met.iter().any(|(_, c)| {
                c.starts_with("echo ") && c.contains("\"permissionDecision\":\"deny\"")
            });
            let asked = met
                .iter()
                .any(|(_, c)| c.contains("--permission-hook") && !c.contains(PASS_ARG));
            let gated = spec.home_gated_writes
                && spec.sends_home_card()
                && connector_writes::home_gated(name);
            if *card || gated {
                assert!(
                    asked && !refused,
                    "{what}: {name} asks him on its card: {met:?}"
                );
            } else {
                assert!(refused, "{what}: {name} is refused: {met:?}");
            }
            assert!(
                !met.iter().any(|(_, c)| c.contains(PASS_ARG)),
                "{what}: no pass hook outside the card's own process"
            );
        }
    }
}

/// The asking hook with no click: a send is deferred for its card — never
/// allowed by a standing rule, by *subagents run on auto* or by the
/// position — and only this very call's answer lets it run, once.
#[test]
fn the_asking_hook_never_answers_a_send_from_a_rule() {
    for tool in SENDS {
        for mode in [
            "default",
            "plan",
            "auto",
            "bypassPermissions",
            "dontAsk",
            "acceptEdits",
        ] {
            let dir = tmp("ask");
            let home = tmp("home");
            // "Allow for this chat", as an earlier card may have left it.
            std::fs::write(
                dir.join(ask::RULES_FILE),
                json!({ "allow": [tool], "subagents_auto": true }).to_string(),
            )
            .unwrap();
            let line = |id: &str, agent: Option<&str>| {
                let mut v = json!({
                    "tool_name": tool, "tool_use_id": id, "permission_mode": mode,
                    "tool_input": { "messageId": "19a0f3", "body": "hi" }
                });
                if let Some(a) = agent {
                    v["agent_id"] = json!(a);
                }
                v.to_string()
            };
            let r = ask::decide_under(&dir, Some(&home), &line("t1", None), false);
            assert_eq!(r.decision(), "defer", "{tool} under {mode}");
            let sub = ask::decide_under(&dir, Some(&home), &line("t1", Some("a1")), false);
            assert_eq!(sub.decision(), "deny", "a subagent's {tool} under {mode}");
            let side = ask::decide_under(&dir, Some(&home), &line("t1", None), true);
            assert_eq!(
                side.decision(),
                "deny",
                "a side process's {tool} under {mode}"
            );
            // Another call's answer is not this call's.
            std::fs::write(
                dir.join(ask::DECISION_FILE),
                json!({ "tool_use_id": "t0", "decision": "allow" }).to_string(),
            )
            .unwrap();
            assert_eq!(
                ask::decide_under(&dir, Some(&home), &line("t1", None), false).decision(),
                "defer"
            );
            // His click on this call's card: once.
            std::fs::write(
                dir.join(ask::DECISION_FILE),
                json!({ "tool_use_id": "t1", "decision": "allow" }).to_string(),
            )
            .unwrap();
            assert_eq!(
                ask::decide_under(&dir, Some(&home), &line("t1", None), false).decision(),
                "allow"
            );
            assert_eq!(
                ask::decide_under(&dir, Some(&home), &line("t1", None), false).decision(),
                "defer",
                "the answer was consumed"
            );
        }
    }
}

/// Home's read-only chat: an invitation answer waits for its own card with
/// no standing allow read, and the mail sends never reach a card at all.
#[test]
fn homes_read_only_hook_never_answers_a_send_unasked() {
    let dir = tmp("home-ask");
    let home = tmp("home");
    std::fs::write(
        dir.join(ask::RULES_FILE),
        json!({ "allow": SENDS, "subagents_auto": true }).to_string(),
    )
    .unwrap();
    for tool in SENDS {
        let line = json!({
            "tool_name": tool, "tool_use_id": "t1", "permission_mode": "auto",
            "tool_input": { "eventId": "e", "responseStatus": "accepted" }
        })
        .to_string();
        let r = ask::decide_read_only(&dir, Some(&home), &line, false);
        if connector_writes::home_gated(tool) {
            assert_eq!(r.decision(), "defer", "{tool}");
        } else {
            // Not this entry's to decide: the `echo` refusal beside it does.
            assert!(connector_writes::known_write(tool), "{tool}");
            assert_ne!(r.decision(), "allow", "{tool}");
        }
    }
}

/// 993d review: the action's process is stopped once its pass can no
/// longer let anything through — not before, and not long after.
#[tokio::test(start_paused = true)]
async fn the_action_is_stopped_at_its_deadline_and_not_before() {
    assert!(TURN_SECS > PASS_SECS as u64, "the pass ends first");
    assert!(
        TURN_SECS <= PASS_SECS as u64 + 30,
        "and the turn soon after"
    );
    let cancel = tokio_util::sync::CancellationToken::new();
    let timer = stop_at_deadline(&cancel);
    tokio::time::sleep(std::time::Duration::from_secs(TURN_SECS - 1)).await;
    assert!(!cancel.is_cancelled(), "still running a second before");
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    assert!(cancel.is_cancelled(), "stopped at the deadline");
    timer.await.unwrap();

    // A turn that ends first aborts the timer: nothing is cancelled later.
    let cancel = tokio_util::sync::CancellationToken::new();
    let timer = stop_at_deadline(&cancel);
    timer.abort();
    tokio::time::sleep(std::time::Duration::from_secs(TURN_SECS * 2)).await;
    assert!(!cancel.is_cancelled());
}

/// 993d review: under the rail's safe mode a click is refused before a
/// pass exists (safe mode's `--strict-mcp-config` drops his connectors).
#[test]
fn safe_mode_is_refused_before_anything_is_minted() {
    assert_eq!(refuse_under_safe_mode(true), Err(SAFE_MODE.to_string()));
    assert_eq!(refuse_under_safe_mode(false), Ok(()));
    assert!(SAFE_MODE.contains("nothing was sent"));
}

/// Blocker 2347: the shell tripwire stands beside the send refusal — in
/// every position that refuses sends with his connectors on — and nowhere
/// a card asks or the connectors are off.
#[test]
fn the_nested_claude_tripwire_stands_where_sends_are_refused() {
    let dir = PathBuf::from("/logs/ask/chat-1");
    let has = |spec: &AgentSpec| {
        entries(spec)
            .iter()
            .any(|(m, _)| m == send_guard::SHELL_MATCHER)
    };
    let expect = cfg!(not(windows));
    let mut bare = AgentSpec::new("/work");
    bare.claude_ai_connectors = true;
    bare.permission_mode = Some("bypassPermissions".into());
    assert_eq!(has(&bare), expect, "bypass, no hook");
    for mode in [AskMode::Auto, AskMode::AutoFork, AskMode::ExitingToAuto] {
        assert_eq!(has(&asking(mode, &dir)), expect, "{mode:?}");
    }
    for mode in [AskMode::Ask, AskMode::Plan] {
        assert!(!has(&asking(mode, &dir)), "{mode:?} asks on its card");
    }
    let mut off = asking(AskMode::Auto, &dir);
    off.claude_ai_connectors = false;
    let a = off.args("hi");
    let hooked = a
        .iter()
        .position(|x| x == "--settings")
        .is_some_and(|i| a[i + 1].contains(send_guard::SHELL_MATCHER));
    assert!(!hooked, "connectors off: no entry");
}
