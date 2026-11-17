//! Item 766's end-to-end check: a known fake secret goes through the card
//! the way the window sends it (`store_secret`, then a bare Allow), the
//! stand-in CLI echoes it every way a real one could (a command's output,
//! the model's prose split across deltas, the final text), and then every
//! store is grepped for it: the chat's log, `search_chats` over it, what
//! the window and the phone were sent, the turn's timing log, the chat's
//! ask folder (decision, waiting and stored-path files) and the CLI's own
//! session file after the turn's scrub. Every count must be 0; the value
//! exists only in its one 0600 file.

use std::path::Path;
use std::sync::{Arc, Mutex};

use nightloom_core::tool::{CancellationToken, Tool};
use nightloom_core::{ChatKind, ChatMode, Session};

use crate::agent::ask::{Answer, AskGate};
use crate::agent::{AgentSpec, ClaudeCodeAgent};
use crate::agent_turn::{
    AgentTurnEnd, AgentTurnRun, ApprovalPrompt, ProjectGrant, TurnEnv, run_agent_turn,
};
use crate::secret::{STORED_FILE, Store};
use crate::turn::{TurnEvent, TurnInput};
use crate::turn_timing::{self, TurnTiming};

/// The fake secret. Long and odd enough to appear nowhere by chance.
const FAKE: &str = "ghp_FAKE766secretZq9xW2";

/// A stand-in `claude` that asks for GITHUB_TOKEN, and on the resume
/// leaks it four ways: a command's output, the model's words split across
/// two deltas, the assistant message and the result text.
fn leaking_stand_in(root: &Path, ask_dir: &Path) -> String {
    let (head, tail) = FAKE.split_at(9);
    let body = format!(
        r##"#!/bin/sh
D="{d}"
A="{a}"
printf '%s\n' '{{"type":"system","subtype":"init","cwd":"x","tools":[],"mcp_servers":[],"model":"claude-haiku-4-5","permissionMode":"default","session_id":"s-766"}}'
if [ ! -f "$D/asked" ]; then
  touch "$D/asked"
  printf '%s\n' '{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"toolu_s","name":"mcp__nightloom__request_secret","input":{{"name":"GITHUB_TOKEN","why":"to push the branch"}}}}]}},"parent_tool_use_id":null}}'
  printf '%s\n' '{{"type":"result","subtype":"success","stop_reason":"tool_deferred","terminal_reason":"tool_deferred","is_error":false,"num_turns":1,"result":"","permission_denials":[],"session_id":"s-766","deferred_tool_use":{{"id":"toolu_s","name":"mcp__nightloom__request_secret","input":{{"name":"GITHUB_TOKEN","why":"to push the branch"}}}}}}'
  exit 0
fi
cp "$A/decision.json" "$D/decision-seen.json" 2>/dev/null
printf '%s\n' '{{"type":"user","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"toolu_s","content":"Stored","is_error":false}}]}},"parent_tool_use_id":null}}'
printf '%s\n' '{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"toolu_b","name":"Bash","input":{{"command":"echo token"}}}}]}},"parent_tool_use_id":null}}'
printf '%s\n' '{{"type":"user","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"toolu_b","content":"token={fake}","is_error":false}}]}},"parent_tool_use_id":null}}'
printf '%s\n' '{{"type":"stream_event","event":{{"type":"content_block_delta","index":0,"delta":{{"type":"text_delta","text":"It was {head}"}}}},"parent_tool_use_id":null,"session_id":"s-766"}}'
printf '%s\n' '{{"type":"stream_event","event":{{"type":"content_block_delta","index":0,"delta":{{"type":"text_delta","text":"{tail} all along"}}}},"parent_tool_use_id":null,"session_id":"s-766"}}'
printf '%s\n' '{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"text","text":"It was {fake} all along"}}]}},"parent_tool_use_id":null}}'
printf '%s\n' '{{"type":"result","subtype":"success","is_error":false,"num_turns":2,"result":"It was {fake} all along","session_id":"s-766","stop_reason":"end_turn","usage":{{"input_tokens":3,"output_tokens":2}}}}'
"##,
        d = root.display(),
        a = ask_dir.display(),
        fake = FAKE,
    );
    let path = root.join("claude-leaking");
    std::fs::write(&path, body).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path.to_string_lossy().into_owned()
}

/// The window, as far as this check needs it: every event it was sent,
/// serialised as the IPC sends it, and the card answered as the secret
/// card answers — the value to the store first, then a bare Allow.
struct CardEnv {
    ask: Arc<AskGate>,
    store: Store,
    sent: Mutex<Vec<String>>,
    cards: Mutex<Vec<String>>,
    timing: Arc<TurnTiming>,
}

#[async_trait::async_trait]
impl TurnEnv for CardEnv {
    fn event(&self, _chat: &str, event: &TurnEvent) {
        self.sent
            .lock()
            .unwrap()
            .push(serde_json::to_string(event).unwrap());
    }
    fn notice(&self, text: String) {
        self.sent.lock().unwrap().push(text);
    }
    fn approval(&self, prompt: &ApprovalPrompt<'_>) {
        self.cards
            .lock()
            .unwrap()
            .push(serde_json::to_string(prompt.input).unwrap());
        let chat = prompt.chat.unwrap_or_default().to_string();
        let (ask, store, id) = (self.ask.clone(), self.store.clone(), prompt.id.to_string());
        tokio::spawn(async move {
            store.put(&chat, "GITHUB_TOKEN", FAKE).unwrap();
            ask.answer(
                &id,
                Answer::Allow {
                    updated_input: None,
                    plan_then: None,
                    grant: None,
                },
            );
        });
    }
    async fn grant_to_project(&self, _dir: &Path) -> ProjectGrant {
        ProjectGrant::NoProject
    }
    fn timing(&self) -> Option<Arc<TurnTiming>> {
        Some(self.timing.clone())
    }
}

/// Every file under `dir`, and how many hold `needle`.
fn hits_under(dir: &Path, needle: &str) -> (usize, Vec<String>) {
    let mut files = 0;
    let mut hits = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else {
                files += 1;
                let bytes = std::fs::read(&p).unwrap_or_default();
                if String::from_utf8_lossy(&bytes).contains(needle) {
                    hits.push(p.display().to_string());
                }
            }
        }
    }
    (files, hits)
}

#[tokio::test]
async fn a_secret_typed_on_the_card_is_in_no_store_but_its_own_file() {
    let root = std::env::temp_dir().join(format!("nightloom-766-{}", uuid::Uuid::new_v4()));
    let logs = root.join("sessions");
    std::fs::create_dir_all(&logs).unwrap();
    let mut session = Session::start(&logs, ChatMode::Normal, ChatKind::Build).unwrap();
    let ask_dir = logs.join("ask").join(&session.id);
    let mut spec = AgentSpec::new(&root);
    spec.binary = leaking_stand_in(&root, &ask_dir);
    let mut agent = ClaudeCodeAgent::new(spec);
    agent.set_ask_dir(ask_dir.clone());
    let ask = Arc::new(AskGate::new());
    let timing_log = root.join("turn-timing.log");
    let env = CardEnv {
        ask: ask.clone(),
        // The store the turn reads: the same default one the app uses.
        store: Store::default(),
        sent: Mutex::default(),
        cards: Mutex::default(),
        timing: TurnTiming::begin(turn_timing::DESKTOP, None, Some(timing_log.clone())),
    };
    let chat = session.id.clone();
    let cancel = CancellationToken::new();
    let end = run_agent_turn(
        AgentTurnRun {
            agent: &mut agent,
            session: &mut session,
            chat_id: &chat,
            input: TurnInput::from("push the branch"),
            spoken: false,
            wire_note: None,
            council: None,
            cancel: &cancel,
            ask_dir: Some(ask_dir.clone()),
            ask: &ask,
        },
        &env,
    )
    .await;
    let Ok(AgentTurnEnd::Done { outcome, .. }) = end else {
        panic!("{:?}", end.err());
    };

    // The card asked once, naming the secret and never holding a value.
    let cards = env.cards.lock().unwrap().clone();
    assert_eq!(cards.len(), 1, "{cards:?}");
    assert!(cards[0].contains("GITHUB_TOKEN"));
    // The hook was handed a bare allow.
    let decision = std::fs::read_to_string(root.join("decision-seen.json")).unwrap();
    assert!(decision.contains(r#""decision":"allow""#), "{decision}");
    assert!(!decision.contains(FAKE));
    // The tool will find the path the shell noted.
    let stored = std::fs::read_to_string(ask_dir.join(STORED_FILE)).unwrap();
    assert!(stored.contains("GITHUB_TOKEN"), "{stored}");

    // 1. The chat's log (and everything else under the logs folder: the
    //    ask folder's decision, waiting and stored-path files).
    let (files, hits) = hits_under(&logs, FAKE);
    assert!(
        files >= 2,
        "the log and the ask folder were written: {files}"
    );
    assert!(hits.is_empty(), "the value is in {hits:?}");
    // …and it says where the value was.
    let log = std::fs::read_to_string(session.log_path().unwrap()).unwrap();
    assert!(log.contains("[secret GITHUB_TOKEN]"), "{log}");

    // 2. search_chats over that log.
    let search = crate::tools::SearchChats::new(crate::tools::ChatDirs {
        active: logs.clone(),
        all: vec![crate::tools::ChatDir {
            name: "766".into(),
            dir: logs.clone(),
        }],
    });
    let found = search
        .call(serde_json::json!({"query": FAKE}), &cancel)
        .await
        .unwrap_or_else(|e| e);
    // The answer echoes the query; it must find no chat.
    assert!(found.starts_with("no chats"), "{found}");
    let found = search
        .call(serde_json::json!({"query": "all along"}), &cancel)
        .await
        .unwrap_or_else(|e| e);
    assert!(found.contains("all along"), "the chat is found: {found}");
    assert!(!found.contains(FAKE), "{found}");

    // 3. What the window and the phone were sent, deltas joined.
    let sent = env.sent.lock().unwrap().clone();
    assert!(!sent.is_empty());
    let mut live = String::new();
    for s in &sent {
        assert!(!s.contains(FAKE), "sent: {s}");
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(s)
            && v["type"] == "text_delta"
        {
            live.push_str(v["text"].as_str().unwrap_or_default());
        }
    }
    assert!(!live.contains(FAKE), "live text: {live}");
    assert!(live.contains("[secret GITHUB_TOKEN]"), "live text: {live}");

    // 4. The turn's own text, as the window and a hand-off read it.
    assert!(!outcome.text.contains(FAKE), "{}", outcome.text);

    // 5. The app's turn-timing log.
    let timing = std::fs::read_to_string(&timing_log).unwrap_or_default();
    assert!(!timing.is_empty(), "the timing line was written");
    assert!(!timing.contains(FAKE));

    // The one place it is: its own file, 0600.
    let path = Store::default().path(&chat, "GITHUB_TOKEN");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), FAKE);
    Store::default().forget_chat(&chat);
    assert!(!path.exists());
    let _ = std::fs::remove_dir_all(&root);
}

/// The CLI's own session file, which the turn above could not reach (the
/// stand-in writes none and the real one lives under `~/.claude`): the
/// same scrub over a copy shaped like a real session.
#[test]
fn the_cli_session_file_and_its_helpers_are_scrubbed_of_the_value() {
    let root = std::env::temp_dir().join(format!("nightloom-766-cli-{}", uuid::Uuid::new_v4()));
    let folder = root.join("-Users-x-project");
    std::fs::create_dir_all(folder.join("s-766").join("subagents")).unwrap();
    let line = |content: &str| {
        serde_json::json!({
            "type": "user",
            "sessionId": "s-766",
            "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "toolu_b", "content": content}
            ]}
        })
        .to_string()
    };
    std::fs::write(
        folder.join("s-766.jsonl"),
        format!("{}\n{}\n", line(&format!("token={FAKE}")), line("ok")),
    )
    .unwrap();
    std::fs::write(
        folder.join("s-766").join("subagents").join("agent-a.jsonl"),
        line(FAKE),
    )
    .unwrap();
    let file = crate::agent::cli_session::find(&root, Path::new("/Users/x/project"), "s-766")
        .expect("found as the turn finds it");
    let scrub = crate::secret::Scrub::default();
    let store = Store::at(root.join("store"));
    store.put("c", "GITHUB_TOKEN", FAKE).unwrap();
    scrub.add(store.get("c", "GITHUB_TOKEN").unwrap());
    assert_eq!(crate::secret::scrub_cli_files(&scrub, &file), 2);
    let (files, hits) = hits_under(&folder, FAKE);
    assert_eq!(files, 2);
    assert!(hits.is_empty(), "{hits:?}");
    let _ = std::fs::remove_dir_all(&root);
}

// ---- merge round T review, 2026-11-17 ----

/// A stand-in `claude` for an aside or a seat: it repeats the value in its
/// thinking and in its prose, each split across two deltas, and in its
/// result.
fn repeating_stand_in(root: &Path) -> String {
    let (head, tail) = FAKE.split_at(9);
    let body = format!(
        r##"#!/bin/sh
read line
printf '%s\n' '{{"type":"system","subtype":"init","cwd":"x","tools":[],"mcp_servers":[],"model":"claude-haiku-4-5","permissionMode":"default","session_id":"s-766a"}}'
printf '%s\n' '{{"type":"stream_event","event":{{"type":"content_block_delta","index":0,"delta":{{"type":"thinking_delta","thinking":"the file says {head}"}}}},"parent_tool_use_id":null,"session_id":"s-766a"}}'
printf '%s\n' '{{"type":"stream_event","event":{{"type":"content_block_delta","index":0,"delta":{{"type":"thinking_delta","thinking":"{tail} then"}}}},"parent_tool_use_id":null,"session_id":"s-766a"}}'
printf '%s\n' '{{"type":"stream_event","event":{{"type":"content_block_delta","index":1,"delta":{{"type":"text_delta","text":"The token is {head}"}}}},"parent_tool_use_id":null,"session_id":"s-766a"}}'
printf '%s\n' '{{"type":"stream_event","event":{{"type":"content_block_delta","index":1,"delta":{{"type":"text_delta","text":"{tail}"}}}},"parent_tool_use_id":null,"session_id":"s-766a"}}'
printf '%s\n' '{{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"The token is {fake}","session_id":"s-766a","stop_reason":"end_turn","usage":{{"input_tokens":3,"output_tokens":2}}}}'
cat >/dev/null
exit 0
"##,
        fake = FAKE,
    );
    let path = root.join("claude-repeating");
    std::fs::write(&path, body).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path.to_string_lossy().into_owned()
}

/// An aside and a council seat are live views too: what their cards are
/// sent, joined as the cards join it, and their final text never hold a
/// value — even one learned for an agent no turn has run on since launch.
#[tokio::test]
async fn an_aside_and_a_seat_never_show_or_return_the_value() {
    let root = std::env::temp_dir().join(format!("nightloom-766-aside-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let store = Store::at(root.join("store"));
    store.put("chat-a", "GITHUB_TOKEN", FAKE).unwrap();
    let mut spec = AgentSpec::new(&root);
    spec.binary = repeating_stand_in(&root);
    spec.resume = Some("s-766".into());
    let agent = ClaudeCodeAgent::new(spec.clone());
    // No turn has run: the aside's caller loads the chat's values.
    agent.learn_secrets_from(&store, "chat-a");
    let cancel = CancellationToken::new();

    for seat in [false, true] {
        let (mut said, mut thought) = (String::new(), String::new());
        let mut sink = |e: TurnEvent| {
            let wire = serde_json::to_string(&e).unwrap();
            assert!(!wire.contains(FAKE), "sent: {wire}");
            match e {
                TurnEvent::TextDelta { text } => said.push_str(&text),
                TurnEvent::ThinkingDelta { text } => thought.push_str(&text),
                _ => {}
            }
        };
        let out = if seat {
            agent
                .run_with(&spec, "what is the token", &cancel, &mut sink)
                .await
                .unwrap()
        } else {
            agent
                .ask_aside(
                    "what is the token".into(),
                    None,
                    None,
                    None,
                    &cancel,
                    &mut sink,
                )
                .await
                .expect("a session to ask beside")
                .unwrap()
        };
        assert_eq!(said, "The token is [secret GITHUB_TOKEN]", "seat {seat}");
        assert_eq!(
            thought, "the file says [secret GITHUB_TOKEN] then",
            "seat {seat}"
        );
        assert_eq!(
            out.text, "The token is [secret GITHUB_TOKEN]",
            "seat {seat}"
        );
    }
    let _ = std::fs::remove_dir_all(&root);
}

/// A stand-in `claude` that writes the value in its prose, split across
/// two deltas, and then calls Claude's own browser — whose card quotes
/// the model's words before the call.
fn browser_stand_in(root: &Path) -> String {
    let (head, tail) = FAKE.split_at(9);
    let body = format!(
        r##"#!/bin/sh
D="{d}"
printf '%s\n' '{{"type":"system","subtype":"init","cwd":"x","tools":[],"mcp_servers":[],"model":"claude-haiku-4-5","permissionMode":"default","session_id":"s-766b"}}'
if [ ! -f "$D/asked" ]; then
  touch "$D/asked"
  printf '%s\n' '{{"type":"stream_event","event":{{"type":"content_block_delta","index":0,"delta":{{"type":"text_delta","text":"I will sign in with {head}"}}}},"parent_tool_use_id":null,"session_id":"s-766b"}}'
  printf '%s\n' '{{"type":"stream_event","event":{{"type":"content_block_delta","index":0,"delta":{{"type":"text_delta","text":"{tail} now"}}}},"parent_tool_use_id":null,"session_id":"s-766b"}}'
  printf '%s\n' '{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"toolu_p","name":"mcp__playwright__browser_click","input":{{"element":"Sign in"}}}}]}},"parent_tool_use_id":null}}'
  printf '%s\n' '{{"type":"result","subtype":"success","stop_reason":"tool_deferred","terminal_reason":"tool_deferred","is_error":false,"num_turns":1,"result":"","permission_denials":[],"session_id":"s-766b","deferred_tool_use":{{"id":"toolu_p","name":"mcp__playwright__browser_click","input":{{"element":"Sign in"}}}}}}'
  exit 0
fi
printf '%s\n' '{{"type":"result","subtype":"success","is_error":false,"num_turns":2,"result":"ok","session_id":"s-766b","stop_reason":"end_turn","usage":{{"input_tokens":3,"output_tokens":2}}}}'
"##,
        d = root.display(),
    );
    let path = root.join("claude-browser");
    std::fs::write(&path, body).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    path.to_string_lossy().into_owned()
}

/// The window for the check below: it keeps each card's reason and
/// declines the call.
struct ReasonEnv {
    ask: Arc<AskGate>,
    reasons: Mutex<Vec<Option<String>>>,
    sent: Mutex<Vec<String>>,
}

#[async_trait::async_trait]
impl TurnEnv for ReasonEnv {
    fn event(&self, _chat: &str, event: &TurnEvent) {
        self.sent
            .lock()
            .unwrap()
            .push(serde_json::to_string(event).unwrap());
    }
    fn notice(&self, _text: String) {}
    fn approval(&self, prompt: &ApprovalPrompt<'_>) {
        self.reasons.lock().unwrap().push(prompt.reason.clone());
        let (ask, id) = (self.ask.clone(), prompt.id.to_string());
        tokio::spawn(async move {
            ask.answer(
                &id,
                Answer::Deny {
                    reason: "not now".into(),
                },
            );
        });
    }
    async fn grant_to_project(&self, _dir: &Path) -> ProjectGrant {
        ProjectGrant::NoProject
    }
}

/// The browser card's reason is the model's words joined from the deltas
/// as they arrived; a value the stream split in two is whole again there,
/// and must be scrubbed before the window and the phone draw the card.
#[tokio::test]
async fn the_browser_cards_reason_never_holds_a_value_split_across_deltas() {
    let root = std::env::temp_dir().join(format!("nightloom-766-reason-{}", uuid::Uuid::new_v4()));
    let logs = root.join("sessions");
    std::fs::create_dir_all(&logs).unwrap();
    let mut session = Session::start(&logs, ChatMode::Normal, ChatKind::Build).unwrap();
    let chat = session.id.clone();
    // He typed it on a card earlier in this chat (the turn loads it).
    Store::default().put(&chat, "GITHUB_TOKEN", FAKE).unwrap();
    let ask_dir = logs.join("ask").join(&session.id);
    let mut spec = AgentSpec::new(&root);
    spec.binary = browser_stand_in(&root);
    let mut agent = ClaudeCodeAgent::new(spec);
    agent.set_ask_dir(ask_dir.clone());
    let ask = Arc::new(AskGate::new());
    let env = ReasonEnv {
        ask: ask.clone(),
        reasons: Mutex::default(),
        sent: Mutex::default(),
    };
    let cancel = CancellationToken::new();
    let end = run_agent_turn(
        AgentTurnRun {
            agent: &mut agent,
            session: &mut session,
            chat_id: &chat,
            input: TurnInput::from("sign in"),
            spoken: false,
            wire_note: None,
            council: None,
            cancel: &cancel,
            ask_dir: Some(ask_dir.clone()),
            ask: &ask,
        },
        &env,
    )
    .await;
    Store::default().forget_chat(&chat);
    assert!(end.is_ok(), "{:?}", end.err());
    let reasons = env.reasons.lock().unwrap().clone();
    assert_eq!(reasons.len(), 1, "{reasons:?}");
    let reason = reasons[0].clone().expect("the card quotes the model");
    assert!(!reason.contains(FAKE), "{reason}");
    assert_eq!(reason, "I will sign in with [secret GITHUB_TOKEN] now");
    for s in env.sent.lock().unwrap().iter() {
        assert!(!s.contains(FAKE), "sent: {s}");
    }
    let (_, hits) = hits_under(&logs, FAKE);
    assert!(hits.is_empty(), "{hits:?}");
    let _ = std::fs::remove_dir_all(&root);
}
