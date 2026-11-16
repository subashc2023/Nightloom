//! Item 727's tests: the prefix print holds across every legitimate
//! between-request change, the verdict, and tonight's two real misses
//! (2026-11-15) replayed through the detector from redacted copies of the
//! CLI's `api-request-shape` lines (every text line replaced by a
//! same-length string of its own hash: equal lines stay equal, lengths
//! hold, none of his notes is in the fixture).

use super::*;
use crate::prompt::{EngineLayers, ProjectContext, PromptConfig, agent_prompt_with};
use crate::thread::ThreadContext;
use chrono::{TimeZone, Utc};
use nightloom_core::Usage;

fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nightloom-727-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A project: a workspace with its notes folder, two notes and a thread
/// whose `thread.md` has a Start here and open questions.
fn project(tag: &str) -> (PathBuf, PathBuf) {
    let ws = scratch(tag);
    let notes = ws.join(".agents");
    let thread = notes.join("threads").join("poc");
    std::fs::create_dir_all(&thread).unwrap();
    std::fs::write(notes.join("plan.md"), "# Plan\n\nThe plan.\n").unwrap();
    std::fs::write(notes.join("ideas.md"), "# Ideas\n\nSome ideas.\n").unwrap();
    std::fs::write(
        thread.join("thread.md"),
        "# Thread: Proof of concept\n\n## Start here\n\nRead the log first.\n\n## Open questions\n\n1. Q-29: is vignette 2 overdue?\n2. Q-30: how many paragraphs?\n\n## Queue\n\n- draft\n",
    )
    .unwrap();
    std::fs::write(
        thread.join("log.md"),
        "# Log: Proof of concept\n\n- began\n",
    )
    .unwrap();
    (ws, notes)
}

/// The spec a chat's connection builds: the same assembly
/// `connect_agent_body` runs (no user files: memory and the model's file
/// off, no vault), rendered onto `--append-system-prompt`.
fn spec_for(ws: &Path, notes: &Path, thread: Option<&str>) -> AgentSpec {
    let prompt = agent_prompt_with(
        &PromptConfig {
            identity: false,
            environment: false,
            project_instructions: true,
            user_memory: false,
            model: None,
            chat_instructions: false,
            project: Some(ProjectContext {
                name: "Proof".into(),
                notes_dir: notes.to_path_buf(),
            }),
            knowledge: None,
            thread: thread.and_then(|s| ThreadContext::new(notes, s)),
            cwd: ws.to_path_buf(),
            custom: None,
            edits: BTreeMap::new(),
        },
        None,
        EngineLayers {
            engine_note: true,
            pacing: true,
            subagents: true,
            reusable: false,
            subagent_model: Default::default(),
            subagent_rules: None,
            limits: None,
            cli_agents_md: false,
            incognito: false,
        },
    );
    let mut s = AgentSpec::new(ws.to_path_buf());
    s.model = Some("opus".into());
    s.resume = Some("sess-1".into());
    s.append_system_prompt = prompt.render_flat();
    s.mcp_config =
        Some(r#"{"mcpServers":{"nightloom":{"command":"nl","args":["mcp-serve"]}}}"#.into());
    s
}

/// The print's cache-relevant half.
fn cache_print(spec: &AgentSpec) -> BTreeMap<String, String> {
    print_of(&parts_of(spec))
        .into_iter()
        .filter(|(k, _)| CACHE_PARTS.contains(&k.as_str()))
        .collect()
}

fn assert_holds(before: &AgentSpec, after: &AgentSpec, what: &str) {
    let (a, b) = (cache_print(before), cache_print(after));
    let names = changed(&a, &b, None);
    if !names.is_empty() {
        let (pa, pb) = (parts_of(before), parts_of(after));
        let n = &names[0];
        let (w, now) = line_diff(&pa[n], &pb[n]);
        panic!("{what}: the prefix print changed in {names:?}\n was: {w:#?}\n now: {now:#?}");
    }
}

fn set_mtime(path: &Path, secs_ago: u64) {
    let t = std::time::SystemTime::now() - std::time::Duration::from_secs(secs_ago);
    let f = std::fs::File::options().write(true).open(path).unwrap();
    f.set_modified(t).unwrap();
}

#[test]
fn fnv_is_the_published_function() {
    assert_eq!(fnv64(""), "cbf29ce484222325");
    assert_eq!(fnv64("a"), "af63dc4c8601ec8c");
}

#[test]
fn the_print_leaves_out_the_prompt_and_the_session_plumbing() {
    let (ws, notes) = project("plumbing");
    let s = spec_for(&ws, &notes, Some("poc"));
    let mut other = s.clone();
    other.resume = Some("sess-2".into());
    other.fork_session = true;
    other.no_session_persistence = true;
    other.max_turns = Some(1);
    assert_eq!(print_of(&parts_of(&s)), print_of(&parts_of(&other)));
    let parts = parts_of(&s);
    for name in [
        "append",
        "model",
        "mcp",
        "mcp_servers",
        "tools",
        "argv",
        "settings",
    ] {
        assert!(
            parts.contains_key(name),
            "{name} missing from {:?}",
            parts.keys()
        );
    }
    assert_eq!(parts["mcp_servers"], "nightloom");
    assert!(!parts["argv"].contains("sess-1"));
}

#[test]
fn the_print_holds_when_nothing_changed_and_time_passes() {
    let (ws, notes) = project("time");
    let a = spec_for(&ws, &notes, Some("poc"));
    // Past a second: anything stamped with the clock would move.
    std::thread::sleep(std::time::Duration::from_millis(1100));
    let b = spec_for(&ws, &notes, Some("poc"));
    assert_holds(&a, &b, "time passing");
}

#[test]
#[ignore = "fixed by 725 (nightshift backlog 725: the notes listing rides the cached prefix)"]
fn the_print_holds_when_a_note_grows() {
    let (ws, notes) = project("grows");
    let a = spec_for(&ws, &notes, Some("poc"));
    let log = notes.join("threads/poc/log.md");
    let mut text = std::fs::read_to_string(&log).unwrap();
    text.push_str(&"- another line of the log\n".repeat(60));
    std::fs::write(&log, text).unwrap();
    let b = spec_for(&ws, &notes, Some("poc"));
    assert_holds(&a, &b, "a note written (size)");
}

#[test]
#[ignore = "fixed by 725 (nightshift backlog 725: the notes listing is sorted by mtime, so a rewrite re-orders it)"]
fn the_print_holds_when_a_note_is_rewritten_at_its_size() {
    let (ws, notes) = project("same-size");
    let a = spec_for(&ws, &notes, Some("poc"));
    std::fs::write(notes.join("ideas.md"), "# Ideas\n\nSome IDEAS.\n").unwrap();
    let b = spec_for(&ws, &notes, Some("poc"));
    assert_holds(&a, &b, "a note rewritten at its size (mtime)");
}

#[test]
#[ignore = "fixed by 725 (nightshift backlog 725: the notes listing rides the cached prefix)"]
fn the_print_holds_when_the_listing_order_changes() {
    let (ws, notes) = project("order");
    for (i, f) in [
        "plan.md",
        "ideas.md",
        "threads/poc/thread.md",
        "threads/poc/log.md",
    ]
    .iter()
    .enumerate()
    {
        set_mtime(&notes.join(f), 1000 + 100 * i as u64);
    }
    let a = spec_for(&ws, &notes, Some("poc"));
    // The oldest note becomes the newest: any listing by recency re-orders.
    set_mtime(&notes.join("threads/poc/log.md"), 0);
    let b = spec_for(&ws, &notes, Some("poc"));
    assert_holds(&a, &b, "a note touched (order)");
}

#[test]
#[ignore = "fixed by 725 (nightshift backlog 725: the notes listing rides the cached prefix)"]
fn the_print_holds_when_a_new_note_is_written() {
    let (ws, notes) = project("new-file");
    let a = spec_for(&ws, &notes, Some("poc"));
    std::fs::write(notes.join("findings.md"), "# Findings\n\nOne.\n").unwrap();
    let b = spec_for(&ws, &notes, Some("poc"));
    assert_holds(&a, &b, "a new note");
}

#[test]
#[ignore = "fixed by 725 (nightshift backlog 725: the thread's open questions ride the cached prefix)"]
fn the_print_holds_when_the_threads_open_questions_change() {
    let (ws, notes) = project("questions");
    let a = spec_for(&ws, &notes, Some("poc"));
    let file = notes.join("threads/poc/thread.md");
    let text = std::fs::read_to_string(&file)
        .unwrap()
        .replace("1. Q-29: is vignette 2 overdue?\n2. Q-30", "1. Q-30");
    std::fs::write(&file, text).unwrap();
    let b = spec_for(&ws, &notes, Some("poc"));
    assert_holds(&a, &b, "the thread's open questions");
}

#[test]
#[ignore = "fixed by 725 (nightshift backlog 725: one chat's notes bust every chat's prefix in the project)"]
fn the_print_holds_when_a_second_chat_in_the_project_writes_notes() {
    let (ws, notes) = project("second-chat");
    // Chat A, bound to the thread, as it was built; chat B, in the same
    // project, writes the thread's log and a new note; A is built again
    // (a reconnect, the app's start) and pings or sends.
    let a = spec_for(&ws, &notes, Some("poc"));
    let _b = spec_for(&ws, &notes, None);
    let log = notes.join("threads/poc/log.md");
    let mut text = std::fs::read_to_string(&log).unwrap();
    text.push_str(&"- chat B was here\n".repeat(40));
    std::fs::write(&log, text).unwrap();
    std::fs::write(notes.join("b-notes.md"), "# B\n\nB's note.\n").unwrap();
    let a_again = spec_for(&ws, &notes, Some("poc"));
    assert_holds(&a, &a_again, "a second chat writing notes");
}

#[test]
fn the_print_holds_for_a_ping_an_aside_and_a_rewind() {
    let (ws, notes) = project("forks");
    let s = spec_for(&ws, &notes, Some("poc"));
    assert_holds(&s, &s.keep_warm_ping().unwrap(), "a keep-warm ping");
    assert_holds(&s, &s.aside().unwrap(), "an aside");
    assert_holds(
        &s,
        &s.aside_with(None, None).unwrap(),
        "an aside on the chat's model",
    );
    // A rewind resumes a fork of the session: only the id moves.
    let mut rewound = s.clone();
    rewound.resume = Some("sess-fork".into());
    assert_holds(&s, &rewound, "a rewind");
    // A turn after a keep-warm ping: nothing was rebuilt in between.
    let again = spec_for(&ws, &notes, Some("poc"));
    assert_holds(&s, &again, "the turn after a ping");
    // What does differ for a fork is outside the cached parts, by design:
    // the aside's `dontAsk` (measured to read the cache, item 081 M3).
    let (p, f) = (
        print_of(&parts_of(&s)),
        print_of(&parts_of(&s.aside().unwrap())),
    );
    assert!(
        changed(&p, &f, None)
            .iter()
            .all(|n| !CACHE_PARTS.contains(&n.as_str()))
    );
}

#[test]
fn an_aside_on_another_model_changes_the_print() {
    let (ws, notes) = project("model");
    let s = spec_for(&ws, &notes, None);
    let other = s.aside_with(Some("sonnet"), None).unwrap();
    assert_eq!(
        changed(&cache_print(&s), &cache_print(&other), None),
        vec!["model".to_string()]
    );
}

#[test]
fn prints_are_recorded_beside_the_chat_with_their_texts() {
    let (ws, notes) = project("record");
    let dir = scratch("record-ask");
    let s = spec_for(&ws, &notes, None);
    record_print(&dir, Kind::Turn, 1_000, &parts_of(&s)).unwrap();
    record_print(
        &dir,
        Kind::Ping,
        2_000,
        &parts_of(&s.keep_warm_ping().unwrap()),
    )
    .unwrap();
    let lines = read_prints(&dir);
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[1].kind, Kind::Ping);
    let h = &lines[0].print["append"];
    assert_eq!(
        part_text(&dir, h).as_deref(),
        s.append_system_prompt.as_deref()
    );
}

// ---- the verdict ----

#[test]
fn the_verdict_follows_cachecheck_and_the_two_explanations() {
    let min = 60_000;
    assert_eq!(judge(80, 100, Some(min), true, None), Verdict::Hit);
    assert_eq!(judge(79, 100, Some(min), true, None), Verdict::Unexplained);
    assert_eq!(judge(0, 0, Some(min), true, None), Verdict::Unjudged);
    assert_eq!(judge(10, 100, None, true, None), Verdict::Unjudged);
    assert_eq!(judge(10, 100, Some(61 * min), true, None), Verdict::Expired);
    assert_eq!(
        judge(10, 100, Some(59 * min), true, None),
        Verdict::Unexplained
    );
    assert_eq!(judge(10, 100, Some(6 * min), false, None), Verdict::Expired);
    assert_eq!(
        judge(10, 100, Some(min), true, Some("a edit marker")),
        Verdict::Chosen("a edit marker".into())
    );
}

fn reply(s: &mut Session, read: u64, write: u64, input: u64, sent_ms: i64) {
    s.record_assistant_timed(
        "claude-opus-5-5",
        Vec::new(),
        Some("end_turn".into()),
        Usage {
            input_tokens: input,
            output_tokens: 10,
            cache_read_tokens: Some(read),
            cache_write_tokens: Some(write),
            ..Default::default()
        },
        None,
        Utc.timestamp_millis_opt(sent_ms).unwrap(),
        Some(CacheTtl::OneHour),
    );
}

#[test]
fn a_turn_is_read_off_the_log_against_the_reply_before_it() {
    let mut s = Session::new();
    s.record_user("one");
    reply(&mut s, 0, 70_000, 70_000, 1_000_000);
    let before = assistant_count(&s);
    s.record_user("two");
    reply(&mut s, 12_781, 61_000, 74_000, 1_900_000);
    reply(&mut s, 74_000, 500, 74_600, 1_950_000);
    let t = turn_read(&s, before).unwrap();
    assert_eq!(
        (t.read, t.context, t.at_ms, t.last_ms),
        (12_781, 70_000, Some(1_900_000), Some(1_000_000))
    );
    assert!(t.one_hour && !t.rewound && t.chosen.is_none());
    // The chat's first turn has nothing to read against.
    assert!(turn_read(&s, 0).is_none());
}

#[test]
fn a_compaction_between_replies_is_his_choice() {
    let mut s = Session::new();
    s.record_user("one");
    reply(&mut s, 0, 70_000, 70_000, 1_000_000);
    let before = assistant_count(&s);
    s.record_compaction("summary");
    s.record_user("two");
    reply(&mut s, 0, 5_000, 5_000, 1_900_000);
    let t = turn_read(&s, before);
    // A compaction supersedes what came before it, so either there is no
    // live reply to judge against, or the marker names the choice.
    assert!(t.as_ref().is_none_or(|t| t.chosen.is_some()), "{t:?}");
}

// ---- the shapes ----

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("fixtures/cache-miss")
        .join(name)
}

fn ms(iso: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(iso)
        .unwrap()
        .timestamp_millis()
}

#[test]
fn shapes_are_read_and_diffed_by_block() {
    let shapes = read_shapes(&fixture("turn-53146e33.jsonl"));
    assert_eq!(shapes.len(), 3);
    // 4fe1 -> c4b8: deferred tools added mid-turn (no miss); c4b8 -> 5c66:
    // system block 2 (the file list and open questions).
    let d = diff_shapes(&shapes[0].shape, &shapes[1].shape).unwrap();
    assert_eq!(d.changed, vec!["tools".to_string()]);
    let d = diff_shapes(&shapes[1].shape, &shapes[2].shape).unwrap();
    assert_eq!(d.part, "system block 2");
    assert_eq!(d.changed, vec!["system block 2".to_string()]);
    // Two lines came in (re-sized, re-ordered), two went; the open
    // question's lines likewise.
    assert!(!d.was.is_empty() && !d.now.is_empty(), "{d:?}");
    assert!(d.was.len() <= DIFF_LINES && d.now.len() <= DIFF_LINES);
    let bytes: usize = d.was.iter().chain(&d.now).map(String::len).sum();
    assert!(bytes <= DIFF_BYTES);
    assert!(diff_shapes(&shapes[2].shape, &shapes[2].shape).is_none());
}

/// Tonight's turn miss: chat 8e2f20a1, CLI session 53146e33, the 11:31:40 PM
/// turn read 12,781 of 73,956, 15 min after the reply before it.
#[test]
fn tonights_turn_miss_is_unexplained_in_system_block_2() {
    let req = Request {
        kind: Kind::Turn,
        chat: "8e2f20a1-a261-41f7-8d06-420b367f6255".into(),
        project: Some("513c3418-df79-48f9-976d-cdae760ee6cc".into()),
        at_ms: ms("2026-11-16T07:31:40.000Z"),
        read: 12_781,
        context: 73_956,
        last_ms: Some(ms("2026-11-16T07:16:00.000Z")),
        one_hour: true,
        cost_usd: Some(1.02),
        chosen: None,
        cli_file: Some(fixture("turn-53146e33.jsonl")),
        ask_dir: None,
    };
    let rec = examine(&req).expect("an unexplained miss");
    assert_eq!(rec.part, "system block 2");
    assert_eq!(rec.how, "the CLI's request shapes");
    assert_eq!(rec.kind, Kind::Turn);
    assert_eq!(rec.gap, "15 min");
    assert!(!rec.was.is_empty() && !rec.now.is_empty());
    // The same turn an hour and a half later is an expired cache, not a bug.
    let late = Request {
        last_ms: Some(req.at_ms - 90 * 60_000),
        ..req.clone()
    };
    assert!(examine(&late).is_none());
    // And a hit is nothing to log.
    let hit = Request {
        read: 73_000,
        ..req
    };
    assert!(examine(&hit).is_none());
}

/// Tonight's ping miss: chat e1f2156b, its keep-warm ping at 11:54:43 PM
/// read 12,779 of 316,953, 55 min after its last request (inside the
/// hour). A ping keeps no session file, so the shape is its parent's
/// (0cc14df3) and the part is located from where the read stopped.
#[test]
fn tonights_ping_miss_is_unexplained_in_system_block_2() {
    let req = Request {
        kind: Kind::Ping,
        chat: "e1f2156b-66d1-4890-89be-35d613b29812".into(),
        project: Some("513c3418-df79-48f9-976d-cdae760ee6cc".into()),
        at_ms: 1_794_815_683_267,
        read: 12_779,
        context: 316_953,
        last_ms: Some(ms("2026-11-16T06:59:40.000Z")),
        one_hour: true,
        cost_usd: Some(4.8407318),
        chosen: None,
        cli_file: Some(fixture("ping-parent-0cc14df3.jsonl")),
        ask_dir: None,
    };
    let rec = examine(&req).expect("an unexplained miss");
    assert_eq!(rec.part, "system block 2", "{rec:?}");
    assert!(rec.how.starts_with("where the read stopped"), "{}", rec.how);
    assert_eq!(rec.gap, "55 min");
    assert_eq!(rec.cli_session.as_deref(), Some("ping-parent-0cc14df3"));
}

#[test]
fn a_ping_names_nightlooms_own_part_when_its_print_changed() {
    let (ws, notes) = project("ping-print");
    let dir = scratch("ping-print-ask");
    let s = spec_for(&ws, &notes, Some("poc"));
    record_print(&dir, Kind::Turn, 1_000_000, &parts_of(&s)).unwrap();
    // The spec was rebuilt with a different prompt before the ping.
    let mut rebuilt = s.clone();
    rebuilt.append_system_prompt = Some(format!(
        "{}\nextra line",
        s.append_system_prompt.clone().unwrap()
    ));
    record_print(
        &dir,
        Kind::Ping,
        1_000_000 + 55 * 60_000,
        &parts_of(&rebuilt.keep_warm_ping().unwrap()),
    )
    .unwrap();
    let req = Request {
        kind: Kind::Ping,
        chat: "c".into(),
        project: None,
        at_ms: 1_000_000 + 55 * 60_000,
        read: 100,
        context: 10_000,
        last_ms: Some(1_000_000),
        one_hour: true,
        cost_usd: None,
        chosen: None,
        cli_file: None,
        ask_dir: Some(dir.clone()),
    };
    let rec = examine(&req).unwrap();
    assert_eq!(rec.part, "appended system prompt");
    assert_eq!(rec.how, "Nightloom's prefix print");
    assert_eq!(rec.now, vec!["extra line".to_string()]);
    // Unchanged prints and no shape: unknown, said so.
    let same = scratch("ping-same-ask");
    record_print(&same, Kind::Turn, 1_000_000, &parts_of(&s)).unwrap();
    record_print(
        &same,
        Kind::Ping,
        req.at_ms,
        &parts_of(&s.keep_warm_ping().unwrap()),
    )
    .unwrap();
    let rec = examine(&Request {
        ask_dir: Some(same),
        ..req
    })
    .unwrap();
    assert_eq!(rec.part, "unknown");
    assert!(rec.how.contains("unchanged"), "{}", rec.how);
}

#[test]
fn records_append_as_one_line_each() {
    let dir = scratch("log");
    let log = dir.join("logs").join(LOG_FILE);
    let req = Request {
        kind: Kind::Turn,
        chat: "8e2f20a1".into(),
        project: None,
        at_ms: ms("2026-11-16T07:31:40.000Z"),
        read: 12_781,
        context: 73_956,
        last_ms: Some(ms("2026-11-16T07:16:00.000Z")),
        one_hour: true,
        cost_usd: None,
        chosen: None,
        cli_file: Some(fixture("turn-53146e33.jsonl")),
        ask_dir: None,
    };
    let rec = examine(&req).unwrap();
    append(&log, &rec).unwrap();
    append(&log, &rec).unwrap();
    let text = std::fs::read_to_string(&log).unwrap();
    assert_eq!(text.lines().count(), 2);
    let back: Record = serde_json::from_str(text.lines().next().unwrap()).unwrap();
    assert_eq!(back, rec);
    assert!(text.lines().all(|l| l.len() < 4096));
}

#[test]
fn a_reordered_listing_shows_the_positions_that_moved() {
    let (w, n) = line_diff("a\nb\nc", "b\na\nc");
    assert_eq!(
        (w, n),
        (
            vec!["a".to_string(), "b".into()],
            vec!["b".to_string(), "a".into()]
        )
    );
    assert_eq!(
        line_diff("a\nb", "a\nb"),
        (Vec::<String>::new(), Vec::<String>::new())
    );
}

#[test]
fn the_project_is_read_off_the_chats_folder() {
    let p = Path::new("/h/.nightloom/projects/513c/sessions/ask/8e2f");
    assert_eq!(project_of(p).as_deref(), Some("513c"));
    assert_eq!(project_of(Path::new("/a/b")), None);
}
