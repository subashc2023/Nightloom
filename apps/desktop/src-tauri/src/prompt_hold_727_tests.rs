//! Item 727's six "fixed by 725" cases, run through 725's fix (the
//! connect's hold, [`resolve`]) rather than the bare prompt assembly: the
//! nightloom-service copies built the prompt fresh on every connect, which
//! is exactly what the hold exists to stop, so they could never pass
//! there. Each case connects a chat once (no hold yet: the fresh prompt is
//! taken and becomes the hold), changes the notes the way a chat's own
//! writes do, connects again on a warm cache and checks that the print of
//! the cached parts (`nightloom_service::cache_miss`) did not move.

use super::*;
use nightloom_service::AgentSpec;
use nightloom_service::cache_miss::{CACHE_PARTS, changed, line_diff, parts_of, print_of};
use nightloom_service::prompt::{EngineLayers, ProjectContext, PromptConfig, agent_prompt_with};
use nightloom_service::thread::ThreadContext;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

fn scratch(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "nightloom-727-hold-{tag}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A project: a workspace with its notes folder, two notes and a thread
/// whose `thread.md` has a Start here and open questions (727's fixture).
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

/// One chat as the connect sees it: its project, its thread and its hold.
struct Chat {
    ws: PathBuf,
    notes: PathBuf,
    thread: Option<&'static str>,
    hold: Option<Hold>,
    /// The cache reads cold at the next connect.
    cold: bool,
}

impl Chat {
    fn new(ws: &Path, notes: &Path, thread: Option<&'static str>) -> Self {
        Chat {
            ws: ws.to_path_buf(),
            notes: notes.to_path_buf(),
            thread,
            hold: None,
            cold: false,
        }
    }

    /// A connect (warm unless `cold`): the fresh assembly `connect_agent_body`
    /// runs (no user files), laid against the chat's hold, on the flag.
    fn connect(&mut self) -> AgentSpec {
        let fresh = agent_prompt_with(
            &PromptConfig {
                identity: false,
                environment: false,
                project_instructions: true,
                user_memory: false,
                model: None,
                chat_instructions: false,
                project: Some(ProjectContext {
                    name: "Proof".into(),
                    notes_dir: self.notes.clone(),
                }),
                knowledge: None,
                thread: self.thread.and_then(|s| ThreadContext::new(&self.notes, s)),
                cwd: self.ws.clone(),
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
        let ask = Ask {
            cold: self.cold,
            auto: true,
            now: Vec::new(),
        };
        let has_cli = self.hold.is_some();
        let r = resolve(&fresh, self.hold.as_ref(), has_cli, &ask);
        self.hold = Some(r.hold);
        let mut s = AgentSpec::new(self.ws.clone());
        s.model = Some("opus".into());
        s.resume = Some("sess-1".into());
        s.append_system_prompt = r.prompt.render_flat();
        s.mcp_config =
            Some(r#"{"mcpServers":{"nightloom":{"command":"nl","args":["mcp-serve"]}}}"#.into());
        s
    }
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
fn the_print_holds_when_a_note_grows() {
    let (ws, notes) = project("grows");
    let mut chat = Chat::new(&ws, &notes, Some("poc"));
    let a = chat.connect();
    let log = notes.join("threads/poc/log.md");
    let mut text = std::fs::read_to_string(&log).unwrap();
    text.push_str(&"- another line of the log\n".repeat(60));
    std::fs::write(&log, text).unwrap();
    let b = chat.connect();
    assert_holds(&a, &b, "a note written (size)");
}

#[test]
fn the_print_holds_when_a_note_is_rewritten_at_its_size() {
    let (ws, notes) = project("same-size");
    let mut chat = Chat::new(&ws, &notes, Some("poc"));
    let a = chat.connect();
    std::fs::write(notes.join("ideas.md"), "# Ideas\n\nSome IDEAS.\n").unwrap();
    let b = chat.connect();
    assert_holds(&a, &b, "a note rewritten at its size (mtime)");
}

#[test]
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
    let mut chat = Chat::new(&ws, &notes, Some("poc"));
    let a = chat.connect();
    // The oldest note becomes the newest: any listing by recency re-orders.
    set_mtime(&notes.join("threads/poc/log.md"), 0);
    let b = chat.connect();
    assert_holds(&a, &b, "a note touched (order)");
}

#[test]
fn the_print_holds_when_a_new_note_is_written() {
    let (ws, notes) = project("new-file");
    let mut chat = Chat::new(&ws, &notes, Some("poc"));
    let a = chat.connect();
    std::fs::write(notes.join("findings.md"), "# Findings\n\nOne.\n").unwrap();
    let b = chat.connect();
    assert_holds(&a, &b, "a new note");
}

#[test]
fn the_print_holds_when_the_threads_open_questions_change() {
    let (ws, notes) = project("questions");
    let mut chat = Chat::new(&ws, &notes, Some("poc"));
    let a = chat.connect();
    let file = notes.join("threads/poc/thread.md");
    let text = std::fs::read_to_string(&file)
        .unwrap()
        .replace("1. Q-29: is vignette 2 overdue?\n2. Q-30", "1. Q-30");
    std::fs::write(&file, text).unwrap();
    let b = chat.connect();
    assert_holds(&a, &b, "the thread's open questions");
}

#[test]
fn the_print_holds_when_a_second_chat_in_the_project_writes_notes() {
    let (ws, notes) = project("second-chat");
    // Chat A, bound to the thread, as it was built; chat B, in the same
    // project, writes the thread's log and a new note; A is built again
    // (a reconnect, the app's start) and pings or sends.
    let mut chat_a = Chat::new(&ws, &notes, Some("poc"));
    let a = chat_a.connect();
    let _b = Chat::new(&ws, &notes, None).connect();
    let log = notes.join("threads/poc/log.md");
    let mut text = std::fs::read_to_string(&log).unwrap();
    text.push_str(&"- chat B was here\n".repeat(40));
    std::fs::write(&log, text).unwrap();
    std::fs::write(notes.join("b-notes.md"), "# B\n\nB's note.\n").unwrap();
    let a_again = chat_a.connect();
    assert_holds(&a, &a_again, "a second chat writing notes");
}

/// The control: a cold connect takes the new text and the print moves,
/// so the cases above pass because of the hold, not because the change
/// never reached the prompt.
#[test]
fn a_cold_connect_takes_the_new_notes_and_the_print_moves() {
    let (ws, notes) = project("cold-control");
    let mut chat = Chat::new(&ws, &notes, Some("poc"));
    let a = chat.connect();
    std::fs::write(notes.join("findings.md"), "# Findings\n\nOne.\n").unwrap();
    chat.cold = true;
    let b = chat.connect();
    assert!(
        !changed(&cache_print(&a), &cache_print(&b), None).is_empty(),
        "a cold connect should take the new notes listing"
    );
}
