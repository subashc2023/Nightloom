//! The desktop shell's unit tests, moved out of `main.rs` unchanged (item
//! 642); `use super::*` still reads the crate root, as before.

use super::*;

/// An aside's timing line ends on how it ended and the counts of what
/// it carried, never names (item 404).
#[test]
fn an_aside_outcome_names_counts_only() {
    assert_eq!(aside_outcome("ok", 0, 0, 0), "ok");
    assert_eq!(aside_outcome("ok", 1, 0, 0), "ok, 1 image");
    assert_eq!(
        aside_outcome("stopped", 2, 1, 3),
        "stopped, 2 images, 1 document, 3 files"
    );
}

/// Thinking, redacted thinking and calls go to the window as the
/// aside's turn events (item 403); text keeps its own `aside-delta`,
/// and the rest (usage, init) is not drawn.
#[test]
fn an_aside_forwards_what_the_reply_draws() {
    assert!(aside_drawn(&TurnEvent::ThinkingDelta { text: "x".into() }));
    assert!(aside_drawn(&TurnEvent::RedactedThinking));
    assert!(aside_drawn(&TurnEvent::ToolCall {
        id: "1".into(),
        name: "Read".into(),
        input: serde_json::json!({}),
    }));
    assert!(aside_drawn(&TurnEvent::ToolOutput {
        tool_use_id: "t".into(),
        lines: vec!["tick 1".into()],
    }));
    assert!(!aside_drawn(&TurnEvent::TextDelta { text: "x".into() }));
    assert!(!aside_drawn(&TurnEvent::RoundLimit { rounds: 2 }));
}

/// A thread bound, unbound or switched is taken at once on the Claude
/// Code engine (backlog 271); the same thread with a rewritten Start
/// here is not — it waits for the cold moment like a changed file.
#[test]
fn a_thread_rebinding_is_taken_now_and_a_rewritten_start_here_is_not() {
    let seg =
        |name: &str, text: &str| nightloom_core::Segment::new(SegmentKind::Thread, name, text);
    let held = |segs: Vec<nightloom_core::Segment>| prompt_hold::Hold {
        segments: segs,
        ..prompt_hold::Hold::default()
    };
    let fresh = |segs: Vec<nightloom_core::Segment>| {
        let mut p = SystemPrompt::new();
        for s in segs {
            p.push(s);
        }
        p
    };
    let a = held(vec![seg("thread/a", "old front")]);
    assert!(!thread_rebound(
        Some(&a),
        &fresh(vec![seg("thread/a", "new front")])
    ));
    assert!(thread_rebound(Some(&a), &fresh(vec![seg("thread/b", "b")])));
    assert!(thread_rebound(Some(&a), &fresh(vec![])));
    assert!(thread_rebound(
        Some(&held(vec![])),
        &fresh(vec![seg("thread/a", "x")])
    ));
    assert!(
        !thread_rebound(None, &fresh(vec![seg("thread/a", "x")])),
        "no hold: all taken anyway"
    );
}

/// A fresh, empty log directory per test, so "unchanged" means "still
/// empty" and one test's log is never another's.
/// Item 261: the connect's read of the open chat never stats a folder
/// (the disk is asked afterwards, on a blocking thread, under a stage
/// of its own), and the disk half keeps what `extra_folders` kept —
/// order, one of each, no home, no missing folder.
#[test]
fn a_connect_reads_the_chat_without_the_disk_and_checks_folders_apart() {
    let dir = empty_log_dir("open-chat-folders");
    let real = dir.join("real");
    std::fs::create_dir_all(&real).unwrap();
    let gone = dir.join("gone");
    let mut session = Session::new();
    session.record_folders([real.clone(), gone, real.clone()]);
    let open = open_chat_of(Some(&session), None, ChatMode::Normal, ChatKind::Build);
    assert!(open.granted.is_empty());
    assert!(!open.candidates.1.is_empty());
    let granted = existing_folders(open.candidates.clone());
    assert_eq!(granted, vec![(real.clone(), "chat")]);
    assert_eq!(granted, extra_folders(None, Some(&session)));
    // The home is never an extra folder.
    assert!(existing_folders((Some(real.clone()), vec![(real, "project")])).is_empty());
}

/// 300 review 3: a project the phone names that the registry no longer
/// knows is `Missing` (the project scopes refuse it; the Vault, Memory
/// and models scopes never look), and a known one is found by its id.
#[test]
fn a_forgotten_project_is_missing_not_the_open_one() {
    let home = empty_log_dir("named-project");
    let ws = home.join("garden");
    std::fs::create_dir_all(&ws).unwrap();
    let mut registry = Registry::load_from(home.join("projects.json"));
    let garden = registry.create("Garden", Some(ws), None).unwrap();
    match named_project(registry.projects(), &garden.id) {
        NamedProject::Named(Some(p)) => assert_eq!(p.id, garden.id),
        _ => panic!("Garden is registered"),
    }
    match named_project(registry.projects(), "gone") {
        NamedProject::Missing(id) => assert_eq!(id, "gone"),
        _ => panic!("an unknown id is missing"),
    }
}

fn empty_log_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nightloom-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn files_in(dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    v.sort();
    v
}

/// Item 220: while a turn holds the open chat, `connect_agent` reads it
/// from the log on disk instead of waiting for the turn — and the log
/// gives the same answers the held chat does.
#[tokio::test]
async fn a_connect_reads_a_chat_whose_turn_is_running_from_its_log_without_waiting() {
    let dir = empty_log_dir("open-chat-busy");
    let chats = chats::Chats::default();
    let (mut held, _) = chats
        .lock_or_start(ChatMode::Normal, ChatKind::Build, &dir)
        .await
        .unwrap();
    held.record_prompt_layers([SegmentKind::UserMemory]);
    held.record_agent_session(AGENT, "cli-session-1");
    held.record_kind(ChatKind::Chat, Some(dir.clone()));
    let from_held = open_chat_of(Some(&held), None, ChatMode::Normal, ChatKind::Build);

    // The turn holds the chat: taking it would wait.
    let target = chats.target();
    assert!(target.try_lock().is_err());
    let path = store::find_by_prefix(&dir, target.id().unwrap()).unwrap();
    let loaded = Session::load(path).unwrap();
    let from_disk = open_chat_of(Some(&loaded), None, ChatMode::Normal, ChatKind::Build);

    assert_eq!(from_held.off, vec![SegmentKind::UserMemory]);
    assert_eq!(from_disk.off, vec![SegmentKind::UserMemory]);
    assert_eq!(from_disk.off, from_held.off);
    assert_eq!(from_disk.edits, from_held.edits);
    assert_eq!(from_disk.kind, from_held.kind);
    assert_eq!(from_disk.declared, from_held.declared);
    assert_eq!(from_disk.kind_workspace, from_held.kind_workspace);
    assert_eq!(from_disk.mode, from_held.mode);
    assert_eq!(from_disk.hold_id, from_held.hold_id);
    assert_eq!(from_disk.resume.as_deref(), Some("cli-session-1"));
    assert!(from_disk.has_cli && from_held.has_cli);
    drop(held);
    assert!(target.try_lock().is_ok());
}

/// A dream or a capture routes by the `provider` string (nightshift
/// backlog 070): the engine's name goes to the CLI with the rail's
/// binary and safe mode, the Settings alias, and this binary as the
/// server; a provider's name goes to the provider layer; anything else
/// is refused rather than guessed at. The commands themselves need a
/// Tauri `State`; this is the pure half they branch on.
#[test]
fn a_pass_routes_to_the_agent_by_the_engines_name_and_carries_the_rails_settings() {
    assert_eq!(pass_engine("claude-code").unwrap(), PassEngine::Agent);
    assert!(matches!(
        pass_engine("anthropic").unwrap(),
        PassEngine::Provider(ProviderKind::Anthropic)
    ));
    assert!(pass_engine("not-an-engine").is_err());

    let pass = pass_spec(
        Some("  /opt/claude ".into()),
        Some(" haiku ".into()),
        Some(true),
    )
    .unwrap();
    assert_eq!(pass.binary, "/opt/claude");
    assert_eq!(pass.model.as_deref(), Some("haiku"));
    assert!(pass.safe_mode);
    assert!(pass.use_subscription);
    assert_eq!(pass.server.len(), 2);
    assert_eq!(
        pass.server[0],
        std::env::current_exe().unwrap().to_string_lossy()
    );
    assert_eq!(pass.server[1], "--mcp-serve");

    // Blank is the default binary and the CLI's default model, as on
    // `connect_agent`.
    let pass = pass_spec(Some("".into()), Some("".into()), None).unwrap();
    assert_eq!(pass.binary, AGENT_BINARY);
    assert!(pass.model.is_none());
    assert!(!pass.safe_mode);
}

// New chat is a state, not a file (nightshift backlog 061): the pure
// halves of `new_session`, `session_mode` and the first message's
// `ensure_session`, driven the way the commands drive them. The
// commands themselves need a Tauri `State`, which needs a window; what
// they add is three lock-and-copy lines each.
#[test]
fn a_pending_incognito_chat_writes_nothing_until_its_first_turn() {
    let dir = empty_log_dir("pending-incognito");
    // `new_session(incognito)`: no session, the kind recorded.
    let mut session: Option<Session> = None;
    let pending = ChatMode::Incognito;
    assert!(files_in(&dir).is_empty(), "New chat created a file");
    // In between, the shell reports the pending kind — so the engine
    // built now has no writers.
    assert_eq!(mode_of(session.as_ref(), pending), ChatMode::Incognito);
    // Clicking New chat again is the same state again.
    session = None;
    assert!(
        files_in(&dir).is_empty(),
        "a second New chat created a file"
    );

    // The first turn creates the log, in that kind.
    let created = ensure_session(&mut session, pending, ChatKind::Build, &dir).unwrap();
    let id = created.id.clone();
    let files = files_in(&dir);
    assert_eq!(files.len(), 1, "the first turn creates exactly one log");
    assert_eq!(files[0], dir.join(format!("{id}.jsonl")));
    let text = std::fs::read_to_string(&files[0]).unwrap();
    let first: serde_json::Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
    assert_eq!(first["event"], "session_created");
    assert_eq!(first["mode"], "incognito");
    assert_eq!(first["id"], id);
    // Once the log exists, its first line is the answer, whatever is
    // pending.
    assert_eq!(
        mode_of(session.as_ref(), ChatMode::Normal),
        ChatMode::Incognito
    );
    // A second turn records into the same log rather than a new one.
    let again = ensure_session(&mut session, pending, ChatKind::Build, &dir).unwrap();
    assert_eq!(again.id, id);
    assert_eq!(files_in(&dir).len(), 1);
}

#[test]
fn the_pending_kind_decides_what_the_first_turn_creates() {
    let dir = empty_log_dir("pending-kinds");
    // Normal: an unmarked log.
    let mut normal = None;
    let s = ensure_session(&mut normal, ChatMode::Normal, ChatKind::Build, &dir).unwrap();
    assert_eq!(s.mode(), ChatMode::Normal);
    let text = std::fs::read_to_string(dir.join(format!("{}.jsonl", s.id))).unwrap();
    assert!(
        !text.lines().next().unwrap().contains("\"mode\""),
        "a normal log is unmarked"
    );
    // Ephemeral: no log at all, and `session_mode` still says so.
    let mut ephemeral = None;
    let s = ensure_session(&mut ephemeral, ChatMode::Ephemeral, ChatKind::Build, &dir).unwrap();
    assert_eq!(s.mode(), ChatMode::Ephemeral);
    assert!(s.log_path().is_none());
    assert_eq!(files_in(&dir).len(), 1, "an ephemeral chat added no file");
    assert_eq!(
        mode_of(ephemeral.as_ref(), ChatMode::Normal),
        ChatMode::Ephemeral
    );
    // No session and nothing pending is an ordinary chat, as before.
    assert_eq!(mode_of(None, ChatMode::Normal), ChatMode::Normal);
}

/// The kind rides beside the mode (nightshift backlog 102): pending
/// while there is no chat, on the first line once there is, and a
/// Chat's folder is the neutral one whatever was resolved for it.
#[test]
fn the_pending_kind_decides_what_the_first_turn_is_for() {
    let dir = empty_log_dir("pending-chat-kind");
    let mut session: Option<Session> = None;
    assert_eq!(kind_of(session.as_ref(), ChatKind::Chat), ChatKind::Chat);
    assert_eq!(kind_of(None, ChatKind::Build), ChatKind::Build);
    let s = ensure_session(&mut session, ChatMode::Normal, ChatKind::Chat, &dir).unwrap();
    assert_eq!(s.kind(), ChatKind::Chat);
    let text = std::fs::read_to_string(dir.join(format!("{}.jsonl", s.id))).unwrap();
    assert!(text.lines().next().unwrap().contains("\"kind\":\"chat\""));
    // Once the log exists its first line answers, whatever is pending.
    assert_eq!(kind_of(session.as_ref(), ChatKind::Build), ChatKind::Chat);

    // A Build chat keeps the folder resolved for it. The Chat branch
    // is not driven here: `chat_dir` creates the neutral folder under
    // the real config dir, which a test must not touch.
    let resolved = dir.clone();
    assert_eq!(chat_workspace(ChatKind::Build, resolved.clone()), resolved);
}

/// The Chat policy on the API engine (nightshift backlog 144): a call
/// `reads_only` would drop from a born Chat is refused with the reason
/// the model reads, whatever the inner policy would say; a reader, the
/// web and a `Session` call pass to the inner policy, or are allowed
/// outright when approval is off. Once switched, the policy's verdict
/// is the same one the CLI's hook gives (`CHAT_POLICY_REASON`).
#[tokio::test]
async fn the_kind_policy_refuses_the_writers_and_passes_the_readers() {
    use nightloom_service::agent::CHAT_POLICY_REASON;
    use nightloom_service::approval::AutoApprove;
    let input = serde_json::json!({});
    let call = |name: &'static str, effect: Effect| PendingCall {
        id: "c1",
        name,
        input: &input,
        effect,
    };
    let refusing = Arc::new(AutoApprove::from_fn(|_| Decision::Deny("inner".into())));
    let over_inner = KindPolicy {
        inner: Some(refusing.clone()),
    };
    assert_eq!(
        over_inner.approve(&call("bash", Effect::Mutating)).await,
        Decision::Deny(CHAT_POLICY_REASON.into())
    );
    assert_eq!(
        over_inner
            .approve(&call("write_file", Effect::Mutating))
            .await,
        Decision::Deny(CHAT_POLICY_REASON.into())
    );
    // The web is a reader for this purpose, as it is for `reads_only`,
    // and goes to the inner policy — which here refuses.
    assert_eq!(
        over_inner
            .approve(&call("web_fetch", Effect::Mutating))
            .await,
        Decision::Deny("inner".into())
    );
    // Readers and session calls: `AutoApprove` allows them without
    // asking its inner policy.
    assert_eq!(
        over_inner
            .approve(&call("read_file", Effect::ReadOnly))
            .await,
        Decision::Allow
    );
    assert_eq!(
        over_inner.approve(&call("remember", Effect::Session)).await,
        Decision::Allow
    );
    let approval_off = KindPolicy { inner: None };
    assert_eq!(
        approval_off.approve(&call("bash", Effect::Mutating)).await,
        Decision::Deny(CHAT_POLICY_REASON.into())
    );
    assert_eq!(
        approval_off
            .approve(&call("web_search", Effect::Mutating))
            .await,
        Decision::Allow
    );
}

// ---- Edits on the Claude Code engine (nightshift backlog 062) ----

/// A CLI session file in the measured shape with dummy content — never
/// a real one (those carry his instructions files and e-mail). One
/// turn: "first" answered "one".
fn cli_fixture(sid: &str) -> String {
    let node = |uuid: &str, parent: Option<&str>, kind: &str, extra: serde_json::Value| {
        let mut o = serde_json::json!({
            "parentUuid": parent, "isSidechain": false, "type": kind, "uuid": uuid,
            "timestamp": "t", "userType": "external", "cwd": "/private/tmp/x",
            "sessionId": sid, "version": cli_session::MEASURED_VERSION, "gitBranch": "main"
        });
        for (k, v) in extra.as_object().unwrap() {
            o[k] = v.clone();
        }
        o.to_string()
    };
    [
            node("u1", None, "user", serde_json::json!({"message": {"role": "user", "content": "first"}})),
            node("s1", Some("u1"), "assistant", serde_json::json!({"message": {"id": "msg_1", "role": "assistant", "content": [{"type": "text", "text": "one"}]}})),
            serde_json::json!({"type": "last-prompt", "lastPrompt": "first", "leafUuid": "s1", "sessionId": sid}).to_string(),
        ]
        .join("\n")
            + "\n"
}

/// Item 252: a reply is matched against the CLI's copy without the
/// subagents' narratives, which the CLI never had; a text block is
/// counted without them; and a narrative itself is the window's alone.
#[test]
fn the_cli_reads_a_reply_without_its_subagent_narratives() {
    use nightloom_core::ContentBlock;
    let mut session = Session::new();
    session.record_user("go");
    session.record_assistant(
        "m",
        vec![
            ContentBlock::Text {
                text: "<subagent parent=\"t0\">\nsteps\n</subagent>".into(),
            },
            ContentBlock::Text { text: "one".into() },
            ContentBlock::ToolUse {
                id: "t1".into(),
                name: "Read".into(),
                input: serde_json::json!({}),
                signature: None,
            },
            ContentBlock::Text { text: "two".into() },
        ],
        Some("tool_use".into()),
        nightloom_core::Usage::default(),
    );
    assert_eq!(
        cli_target(&session, 2).unwrap(),
        Target::Assistant {
            from_last: 0,
            text: "onetwo".into()
        }
    );
    assert!(is_narrative_block(&session, 2, 0));
    assert!(!is_narrative_block(&session, 2, 1));
    assert!(cli_block(&session, 2, 0).is_err());
    assert_eq!(cli_block(&session, 2, 1).unwrap(), Block::Text(0));
    assert_eq!(cli_block(&session, 2, 3).unwrap(), Block::Text(1));
    assert_eq!(
        cli_block(&session, 2, 2).unwrap(),
        Block::ToolUse("t1".into())
    );
}

/// The sequence `edit_message("save")` runs on this engine, minus the
/// Tauri `State`: the CLI file is copied with the new text under a new
/// id, the log gets its marker and the new handle, and the original
/// file is byte-identical afterwards. Then the sequence `rewind` runs.
#[test]
fn an_edit_on_claude_code_records_a_new_agent_session_and_leaves_the_old_file_alone() {
    let dir = empty_log_dir("cli-edit");
    let projects = dir.join("projects");
    let cwd = Path::new("/private/tmp/x");
    let folder = projects.join(cli_session::project_folder(cwd));
    std::fs::create_dir_all(&folder).unwrap();
    let sid = "aaaaaaaa-0000-0000-0000-000000000001";
    let original = folder.join(format!("{sid}.jsonl"));
    std::fs::write(&original, cli_fixture(sid)).unwrap();
    let before = std::fs::read(&original).unwrap();

    let mut session = Session::with_log(&dir).unwrap();
    session.record_user("first");
    session.record_assistant(
        "claude-haiku-4-5",
        vec![nightloom_core::ContentBlock::Text { text: "one".into() }],
        Some("end_turn".into()),
        nightloom_core::Usage::default(),
    );
    session.record_agent_session(AGENT, sid);

    // edit_message("save") on the user turn.
    let target = cli_target(&session, 1).unwrap();
    assert_eq!(
        target,
        Target::User {
            from_last: 0,
            text: "first".into()
        }
    );
    let CliChange::Resume(new_id) = edit_cli_file(&projects, cwd, sid, |cli| {
        cli.rewrite(&target, "first, edited").map(Some)
    })
    .unwrap() else {
        panic!("a rewrite is a copy");
    };
    session.edit(1, "first, edited").unwrap();
    session.record_agent_session(AGENT, &new_id);

    assert_ne!(new_id, sid);
    assert_eq!(session.agent_session(), Some((AGENT, new_id.as_str())));
    assert_eq!(session.messages()[0].text(), "first, edited");
    assert_eq!(
        std::fs::read(&original).unwrap(),
        before,
        "the original changed"
    );
    let copy = std::fs::read_to_string(folder.join(format!("{new_id}.jsonl"))).unwrap();
    assert!(copy.contains("first, edited"));
    assert!(!copy.contains(sid));
    assert_eq!(files_in(&folder).len(), 2);

    // The assistant reply is addressed by the turn it answers and its text.
    assert_eq!(
        cli_target(&session, 2).unwrap(),
        Target::Assistant {
            from_last: 0,
            text: "one".into()
        }
    );

    // rewind(1): a cut before the only turn leaves the CLI nothing to
    // resume, so no copy is written and the agent lets go of the id.
    let from_last = turns_after(&session, 1).unwrap();
    assert!(matches!(
        edit_cli_file(&projects, cwd, &new_id, |cli| cli.truncate(from_last)).unwrap(),
        CliChange::Fresh
    ));
    assert_eq!(std::fs::read(&original).unwrap(), before);
    assert_eq!(
        files_in(&folder).len(),
        2,
        "no copy for a cut that leaves nothing"
    );

    // A chat with no CLI session behind it edits by marker alone.
    let mut plain = Session::new();
    plain.record_user("q");
    assert!(matches!(
        edit_on_cli(&plain, cwd, |cli| cli.truncate(0)).unwrap(),
        CliChange::Untouched
    ));

    std::fs::remove_dir_all(&dir).ok();
}

/// The sequence `remove_message` then `restore_message` runs on the
/// Claude Code engine (nightshift backlog 064), minus the Tauri
/// `State`: the removal copies the file without the turn, the restore
/// copies *that* file with the turn put back from the original, the
/// log records a new handle each time, and neither earlier file
/// changes. Then the log half of `unrewind`: the id in force before a
/// rewind is the one to resume once it is lifted.
#[test]
fn a_restore_on_claude_code_records_a_new_agent_session_and_leaves_both_files_alone() {
    let dir = empty_log_dir("cli-restore");
    let projects = dir.join("projects");
    let cwd = Path::new("/private/tmp/x");
    let folder = projects.join(cli_session::project_folder(cwd));
    std::fs::create_dir_all(&folder).unwrap();
    let sid = "aaaaaaaa-0000-0000-0000-000000000002";
    let original = folder.join(format!("{sid}.jsonl"));
    std::fs::write(&original, cli_fixture(sid)).unwrap();
    let original_bytes = std::fs::read(&original).unwrap();

    let mut session = Session::with_log(&dir).unwrap();
    session.record_user("first"); // 1
    session.record_assistant(
        "claude-haiku-4-5",
        vec![nightloom_core::ContentBlock::Text { text: "one".into() }],
        Some("end_turn".into()),
        nightloom_core::Usage::default(),
    ); // 2
    session.record_agent_session(AGENT, sid); // 3

    // remove_message(2): the reply dropped from a copy.
    let target = cli_target(&session, 2).unwrap();
    let CliChange::Resume(removed_id) =
        edit_cli_file(&projects, cwd, sid, |cli| cli.remove(&target).map(Some)).unwrap()
    else {
        panic!("a removal is a copy");
    };
    session.elide([2]).unwrap(); // 4
    session.record_agent_session(AGENT, &removed_id); // 5
    let removed_path = folder.join(format!("{removed_id}.jsonl"));
    let removed_bytes = std::fs::read(&removed_path).unwrap();
    assert!(!String::from_utf8_lossy(&removed_bytes).contains("\"one\""));

    // restore_message(2): the original is the id before the marker.
    assert_eq!(agent_session_before(&session, 4).as_deref(), Some(sid));
    let target = cli_target(&session, 2).unwrap();
    let CliChange::Resume(restored_id) =
        restore_cli_file(&projects, cwd, &removed_id, sid, &target, None).unwrap()
    else {
        panic!("a restore is a copy");
    };
    session.unelide([2]).unwrap(); // 6
    session.record_agent_session(AGENT, &restored_id); // 7

    assert_ne!(restored_id, removed_id);
    assert_ne!(restored_id, sid);
    assert_eq!(session.agent_session(), Some((AGENT, restored_id.as_str())));
    assert!(!session.elide_flags()[2]);
    assert_eq!(
        std::fs::read(&original).unwrap(),
        original_bytes,
        "the original changed"
    );
    assert_eq!(
        std::fs::read(&removed_path).unwrap(),
        removed_bytes,
        "the removed copy changed"
    );
    assert_eq!(files_in(&folder).len(), 3);
    let restored = std::fs::read_to_string(folder.join(format!("{restored_id}.jsonl"))).unwrap();
    assert!(restored.contains("\"one\""), "the reply is back");
    assert!(
        !restored.contains(sid) && !restored.contains(&removed_id),
        "one id throughout"
    );
    let parsed = CliSession::parse(&restored).unwrap();
    assert_eq!(parsed.prompt_count(), 1);

    // A turn removed while the chat had no CLI session behind it — the
    // marker before any handle — needs no file work on restore.
    let mut plain = Session::new();
    plain.record_user("q"); // 1
    plain.record_assistant("m", vec![], None, nightloom_core::Usage::default()); // 2
    plain.elide([2]).unwrap(); // 3
    plain.record_agent_session(AGENT, sid); // 4
    assert!(matches!(
        restore_on_cli(&plain, cwd, 2, None).unwrap(),
        CliChange::Untouched
    ));

    // unrewind: the rewind recorded a new handle after its marker; the
    // one to go back to is the latest before it.
    session.record_user("second"); // 8
    session.record_agent_session(AGENT, "after-second"); // 9
    session.rewind(8).unwrap(); // 10
    session.record_agent_session(AGENT, "truncated-copy"); // 11
    assert_eq!(session.agent_session(), Some((AGENT, "truncated-copy")));
    session.unrewind(10).unwrap(); // 12
    assert_eq!(
        agent_session_before(&session, 10).as_deref(),
        Some("after-second"),
        "the id in force before the rewind, live again"
    );
    assert_eq!(
        session.agent_session(),
        Some((AGENT, "truncated-copy")),
        "the copy's line is later and still live, which is why unrewind records a fresh one"
    );

    std::fs::remove_dir_all(&dir).ok();
}

/// A CLI session file with a tool round, in the measured shape with
/// dummy content: "first" answered by thinking, "let me look", a
/// `Read` call, its result, and "two".
fn cli_tool_fixture(sid: &str) -> String {
    let node = |uuid: &str, parent: Option<&str>, kind: &str, extra: serde_json::Value| {
        let mut o = serde_json::json!({
            "parentUuid": parent, "isSidechain": false, "type": kind, "uuid": uuid,
            "timestamp": "t", "userType": "external", "cwd": "/private/tmp/x",
            "sessionId": sid, "version": cli_session::MEASURED_VERSION, "gitBranch": "main"
        });
        for (k, v) in extra.as_object().unwrap() {
            o[k] = v.clone();
        }
        o.to_string()
    };
    let reply = |uuid: &str, parent: &str, msg: &str, block: serde_json::Value| {
        node(
            uuid,
            Some(parent),
            "assistant",
            serde_json::json!({"message": {"id": msg, "role": "assistant", "content": [block]}}),
        )
    };
    [
            node("u1", None, "user", serde_json::json!({"message": {"role": "user", "content": "first"}})),
            reply("s1", "u1", "msg_1", serde_json::json!({"type": "thinking", "thinking": "look", "signature": "sig"})),
            reply("s2", "s1", "msg_1", serde_json::json!({"type": "text", "text": "let me look"})),
            reply("s3", "s2", "msg_1", serde_json::json!({"type": "tool_use", "id": "toolu_1", "name": "Read", "input": {"file_path": "a.txt"}})),
            node("r1", Some("s3"), "user", serde_json::json!({"message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": "contents"}]}})),
            reply("s4", "r1", "msg_2", serde_json::json!({"type": "text", "text": "two"})),
            serde_json::json!({"type": "last-prompt", "lastPrompt": "first", "leafUuid": "s4", "sessionId": sid}).to_string(),
        ]
        .join("\n")
            + "\n"
}

/// The sequences `edit_message` with a block, `remove_block` and
/// `restore_block` run on the Claude Code engine (nightshift backlog
/// 066), minus the Tauri `State`: the block edit copies the file with
/// that text node changed under a new id and the original stays
/// byte-identical; the reply is still found afterwards by the text it
/// reads now; the pair removal copies the file without the call's node
/// and its result's; the restore puts both back from the original.
#[test]
fn a_block_edit_on_claude_code_records_a_new_id_and_leaves_the_original_alone() {
    let dir = empty_log_dir("cli-block-edit");
    let projects = dir.join("projects");
    let cwd = Path::new("/private/tmp/x");
    let folder = projects.join(cli_session::project_folder(cwd));
    std::fs::create_dir_all(&folder).unwrap();
    let sid = "aaaaaaaa-0000-0000-0000-000000000003";
    let original = folder.join(format!("{sid}.jsonl"));
    std::fs::write(&original, cli_tool_fixture(sid)).unwrap();
    let before = std::fs::read(&original).unwrap();

    use nightloom_core::ContentBlock;
    let mut session = Session::with_log(&dir).unwrap();
    session.record_user("first"); // 1
    session.record_assistant(
        "claude-haiku-4-5",
        vec![
            ContentBlock::Thinking {
                text: "look".into(),
                signature: Some("sig".into()),
            },
            ContentBlock::Text {
                text: "let me look".into(),
            },
            ContentBlock::ToolUse {
                id: "toolu_1".into(),
                name: "Read".into(),
                input: serde_json::json!({"file_path": "a.txt"}),
                signature: None,
            },
        ],
        Some("tool_use".into()),
        nightloom_core::Usage::default(),
    ); // 2
    session.record_tool_result(&ContentBlock::ToolResult {
        tool_use_id: "toolu_1".into(),
        name: "Read".into(),
        content: "contents".into(),
        is_error: false,
    }); // 3
    session.record_assistant(
        "claude-haiku-4-5",
        vec![ContentBlock::Text { text: "two".into() }],
        Some("end_turn".into()),
        nightloom_core::Usage::default(),
    ); // 4
    session.record_agent_session(AGENT, sid); // 5

    // edit_message(2, "looking now", "save", block: 1): the reply's
    // text block, addressed by its count among the text nodes.
    let target = cli_target(&session, 2).unwrap();
    assert_eq!(
        target,
        Target::Assistant {
            from_last: 0,
            text: "let me look".into()
        }
    );
    assert_eq!(cli_block(&session, 2, 1).unwrap(), Block::Text(0));
    assert_eq!(
        cli_block(&session, 2, 2).unwrap(),
        Block::ToolUse("toolu_1".into())
    );
    assert!(
        cli_block(&session, 2, 0).is_err(),
        "thinking has no address"
    );
    let CliChange::Resume(edited_id) = edit_cli_file(&projects, cwd, sid, |cli| {
        cli.rewrite_block(&target, 0, "looking now").map(Some)
    })
    .unwrap() else {
        panic!("a rewrite is a copy");
    };
    session.edit_block(2, 1, "looking now").unwrap(); // 6
    session.record_agent_session(AGENT, &edited_id); // 7
    assert_ne!(edited_id, sid);
    assert_eq!(
        std::fs::read(&original).unwrap(),
        before,
        "the original changed"
    );
    let copy = std::fs::read_to_string(folder.join(format!("{edited_id}.jsonl"))).unwrap();
    assert!(copy.contains("looking now") && !copy.contains("let me look"));
    assert!(copy.contains("toolu_1"), "the call stays");
    assert!(!copy.contains(sid));
    assert_eq!(files_in(&folder).len(), 2);
    // The reply is addressed by what it says now, on both sides.
    assert_eq!(
        cli_target(&session, 2).unwrap(),
        Target::Assistant {
            from_last: 0,
            text: "looking now".into()
        }
    );
    let parsed = CliSession::parse(&copy).unwrap();
    assert!(
        parsed
            .rewrite_block(&cli_target(&session, 2).unwrap(), 0, "again")
            .is_ok(),
        "the edited copy locates the reply by its new text"
    );

    // remove_block(2, 2): the call and its result out of a copy of
    // the edited copy.
    let target = cli_target(&session, 2).unwrap();
    let which = cli_block(&session, 2, 2).unwrap();
    let CliChange::Resume(removed_id) = edit_cli_file(&projects, cwd, &edited_id, |cli| {
        cli.remove_block(&target, &which).map(Some)
    })
    .unwrap() else {
        panic!("a removal is a copy");
    };
    session.elide_block(2, 2).unwrap(); // 8
    session.record_agent_session(AGENT, &removed_id); // 9
    let removed = std::fs::read_to_string(folder.join(format!("{removed_id}.jsonl"))).unwrap();
    assert!(
        !removed.contains("toolu_1"),
        "the call and its result are gone"
    );
    assert!(removed.contains("looking now") && removed.contains("\"two\""));
    assert_eq!(
        session.messages().len(),
        3,
        "the log projects the pair gone too"
    );
    // The reply still reads the same to both histories: a removed call
    // leaves no mark in the text.
    assert_eq!(
        cli_target(&session, 2).unwrap(),
        Target::Assistant {
            from_last: 0,
            text: "looking now".into()
        }
    );

    // restore_block(2, 2): the original for a block marker is the id
    // before that marker — the edited copy — and both nodes come back.
    assert_eq!(
        agent_session_before(&session, 8).as_deref(),
        Some(edited_id.as_str())
    );
    let CliChange::Resume(restored_id) = restore_cli_file(
        &projects,
        cwd,
        &removed_id,
        &edited_id,
        &cli_target(&session, 2).unwrap(),
        Some(&which),
    )
    .unwrap() else {
        panic!("a restore is a copy");
    };
    session.unelide_block(2, 2).unwrap(); // 10
    session.record_agent_session(AGENT, &restored_id); // 11
    let restored = std::fs::read_to_string(folder.join(format!("{restored_id}.jsonl"))).unwrap();
    assert!(restored.contains("toolu_1"));
    let parsed = CliSession::parse(&restored).unwrap();
    assert_eq!(parsed.prompt_count(), 1);
    assert!(
        restored.contains("looking now"),
        "the edit survives the restore"
    );
    assert_eq!(session.messages().len(), 4);
    assert_eq!(std::fs::read(&original).unwrap(), before);
    assert_eq!(files_in(&folder).len(), 4);

    std::fs::remove_dir_all(&dir).ok();
}

/// One provider turn at a time (backlog 159, A4): a second is refused
/// in words while the first runs, the running one names its chat and
/// its own Stop token for its prompts (A4 review: not the shared one,
/// which another chat's turn overwrites), and the slot is free again
/// when it ends. A compaction's claim is refused in its own words.
#[test]
fn one_provider_turn_at_a_time_named_by_its_chat() {
    let slot = std::sync::Mutex::new(None);
    let turn = ProviderTurn::claim(&slot, PROVIDER_TURN_BUSY).expect("the first claims");
    assert!(
        slot.lock()
            .unwrap()
            .as_ref()
            .is_some_and(|r| r.chat.is_empty() && r.cancel.is_none())
    );
    let second = ProviderTurn::claim(&slot, PROVIDER_TURN_BUSY);
    assert!(second.is_err_and(|e| e.contains("another chat")));
    let compaction = ProviderTurn::claim(&slot, "compact this one when it ends");
    assert!(compaction.is_err_and(|e| e.contains("compact")));
    let token = CancellationToken::new();
    turn.name("chat-a", &token);
    {
        let held = slot.lock().unwrap();
        let run = held.as_ref().expect("named");
        assert_eq!(run.chat, "chat-a");
        token.cancel();
        assert!(
            run.cancel.as_ref().is_some_and(|t| t.is_cancelled()),
            "the turn's own token"
        );
    }
    drop(turn);
    assert!(slot.lock().unwrap().is_none());
    assert!(ProviderTurn::claim(&slot, PROVIDER_TURN_BUSY).is_ok());
}

/// Backlog 159, A3 (found live): a Stop for a New chat's first turn,
/// sent before the turn registered, is held by its turn key and taken
/// once by that turn; a chat id is never a turn key; the held set is
/// bounded.
#[test]
fn an_early_stop_is_held_for_its_turn_key_and_taken_once() {
    let stops = std::sync::Mutex::new(std::collections::HashSet::new());
    assert!(is_turn_key("turn:abc-1"));
    assert!(!is_turn_key("635e8ee0-1234"));
    assert!(!take_early_stop(&stops, "turn:abc-1"));
    hold_early_stop(&stops, "turn:abc-1");
    assert!(take_early_stop(&stops, "turn:abc-1"));
    assert!(!take_early_stop(&stops, "turn:abc-1"), "taken once");
    for i in 0..100 {
        hold_early_stop(&stops, &format!("turn:x-{i}"));
    }
    assert!(stops.lock().unwrap().len() <= 32);
}

/// `turns_after` counts live user turns past the one an event belongs
/// to, which is the address a CLI node is found by.
#[test]
fn turns_after_counts_from_the_newest_live_turn() {
    let mut s = Session::new();
    s.record_user("a"); // 1
    s.record_assistant("m", vec![], None, nightloom_core::Usage::default()); // 2
    s.record_user("b"); // 3
    s.record_user("c"); // 4
    assert_eq!(turns_after(&s, 1).unwrap(), 2);
    assert_eq!(
        turns_after(&s, 2).unwrap(),
        2,
        "the reply belongs to turn a"
    );
    assert_eq!(turns_after(&s, 3).unwrap(), 1);
    assert_eq!(turns_after(&s, 4).unwrap(), 0);
    assert!(turns_after(&s, 0).is_err(), "the creation line is no turn");
    s.rewind(4).unwrap();
    assert_eq!(
        turns_after(&s, 1).unwrap(),
        1,
        "a rewound turn no longer counts"
    );
}

/// The file card's Open (backlog 136, blocker 205): a document opens, a
/// file the OS would run is refused by extension or executable bit.
#[test]
fn open_file_refuses_what_the_os_would_run() {
    let dir = empty_log_dir("open-file");
    let doc = dir.join("notes.md");
    std::fs::write(&doc, "# hi\n").unwrap();
    assert_eq!(launchable(&doc), None);
    for name in [
        "Installer.pkg",
        "run.command",
        "Tool.app",
        "x.sh",
        "link.webloc",
        "setup.exe",
    ] {
        let p = dir.join(name);
        std::fs::write(&p, "").unwrap();
        assert!(launchable(&p).is_some(), "{name}");
        let err = open_file(p.to_string_lossy().into_owned()).unwrap_err();
        assert!(err.contains("Reveal"), "{err}");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let bin = dir.join("built");
        std::fs::write(&bin, "").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(launchable(&bin), Some("marked executable"));
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// Batch review 2026-09-23, finding 1: with a web tab's page added to
/// the window (backlog 172), tauri's `get_webview_window` lookup
/// returns `None` — it requires the window's only webview to share its
/// label — so zoom and the usage banner's click silently failed. The
/// window and the main webview are looked up on their own; this keeps
/// the combined lookup out of the crate.
#[test]
fn no_lookup_of_the_main_webview_window_while_web_tabs_exist() {
    let banned = ["get_webview", "_window("].concat();
    for (name, text) in [
        ("main.rs", include_str!("main.rs")),
        ("webtab.rs", include_str!("webtab.rs")),
        // The command groups moved out of main.rs (item 642).
        ("commands/agent.rs", include_str!("commands/agent.rs")),
        ("commands/aside.rs", include_str!("commands/aside.rs")),
        (
            "commands/attachments.rs",
            include_str!("commands/attachments.rs"),
        ),
        ("commands/chat.rs", include_str!("commands/chat.rs")),
        ("commands/cli.rs", include_str!("commands/cli.rs")),
        ("commands/connect.rs", include_str!("commands/connect.rs")),
        ("commands/context.rs", include_str!("commands/context.rs")),
        ("commands/edits.rs", include_str!("commands/edits.rs")),
        ("commands/memory.rs", include_str!("commands/memory.rs")),
        ("commands/menu.rs", include_str!("commands/menu.rs")),
        ("commands/mod.rs", include_str!("commands/mod.rs")),
        ("commands/notes.rs", include_str!("commands/notes.rs")),
        ("commands/projects.rs", include_str!("commands/projects.rs")),
        (
            "commands/providers.rs",
            include_str!("commands/providers.rs"),
        ),
        ("commands/sessions.rs", include_str!("commands/sessions.rs")),
        ("commands/steer.rs", include_str!("commands/steer.rs")),
        ("commands/system.rs", include_str!("commands/system.rs")),
        ("commands/threads.rs", include_str!("commands/threads.rs")),
        ("commands/turns.rs", include_str!("commands/turns.rs")),
        ("commands/usage.rs", include_str!("commands/usage.rs")),
    ] {
        assert!(
            !text.contains(&banned),
            "{name} looks up the main webview window, which a web tab hides"
        );
    }
}
