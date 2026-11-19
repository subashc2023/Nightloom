//! Home's pieces, one test each (item 763), then the end-to-end run
//! ([`e2e`]): the scan fires at a fake 8:00 AM through the jobs clock into
//! a real chat driven by a stand-in `claude`.

use super::*;
use chrono::Duration;

fn scratch(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("nightloom-home-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn at(h: u32, m: u32) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(&format!("2026-11-17T{h:02}:{m:02}:00Z"))
        .unwrap()
        .with_timezone(&Utc)
}

#[test]
fn the_folder_is_made_once_and_never_overwritten() {
    let c = scratch("folder");
    let d = ensure_folder(&c).unwrap();
    assert!(d.join("brief.md").is_file() && d.join("STATE.md").is_file());
    assert!(d.join("scans").is_dir());
    save_brief(&c, "- watch CI\n").unwrap();
    ensure_folder(&c).unwrap();
    assert_eq!(read_brief(&c), "- watch CI\n", "his brief survives");
}

#[test]
fn home_is_registered_once_and_cannot_be_forgotten() {
    let c = scratch("project");
    let mut r = crate::project::Registry::load_in(&c);
    let id = ensure_project(&mut r, &c).unwrap();
    assert_eq!(ensure_project(&mut r, &c).unwrap(), id, "idempotent");
    let p = r.find(&id).unwrap();
    assert_eq!(p.name, NAME);
    assert_eq!(p.workspace.as_deref(), Some(dir_in(&c).as_path()));
    assert!(r.forget(&id).unwrap_err().contains("cannot be removed"));
    let back = crate::project::Registry::load_in(&c);
    assert!(back.find_by_source(SOURCE).is_some(), "saved");
}

#[test]
fn the_feed_appends_reads_and_marks_seen() {
    let c = scratch("feed");
    let row = |kind: &str, t| FeedRow {
        at: t,
        kind: kind.into(),
        label: Some("CI".into()),
        chat: Some("c1".into()),
        project: None,
        line: "Finished".into(),
    };
    append(&c, &row("done", at(7, 0)));
    append(&c, &row("failed", at(7, 30)));
    // A damaged line is skipped, not fatal.
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .append(true)
        .open(dir_in(&c).join("feed.jsonl"))
        .unwrap();
    writeln!(f, "{{not json").unwrap();
    assert_eq!(read_feed(&c).len(), 2);
    assert_eq!(since_seen(&c).len(), 2, "never looked: everything");
    mark_seen(&c, at(7, 10)).unwrap();
    assert_eq!(seen_at(&c), Some(at(7, 10)));
    let left = since_seen(&c);
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].kind, "failed");
}

#[test]
fn every_push_kind_is_a_row_with_counts_never_reply_text() {
    use crate::push::{Note, What};
    for (what, kind) in [
        (What::Done, "done"),
        (What::Failed, "failed"),
        (What::Limit, "limit"),
        (What::Approval, "approval"),
        (What::Question, "question"),
        (What::Changes, "changes"),
        (What::Stuck, "stuck"),
        (What::Scan, "scan"),
    ] {
        let n = Note {
            what,
            chat: Some("c".into()),
            label: Some("Scorer".into()),
            project: Some("p".into()),
            at_the_mac: true,
            detail: None,
        };
        let r = row_for_note(&n, at(8, 0));
        assert_eq!(r.kind, kind);
        assert_eq!(r.line, what.words());
    }
}

#[test]
fn a_push_writes_a_feed_row_under_the_nightloom_home() {
    let c = scratch("pushfeed");
    let push = crate::push::Push::open(crate::push::Push::dir_under(&c), "mac");
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    rt.block_on(push.notify(crate::push::Note {
        what: crate::push::What::Question,
        chat: Some("c9".into()),
        label: Some("Scorer review".into()),
        project: None,
        at_the_mac: true,
        detail: None,
    }));
    let rows = read_feed(&c);
    assert_eq!(rows.len(), 1, "a row even while he is at the Mac");
    assert_eq!(rows[0].kind, "question");
    assert_eq!(rows[0].label.as_deref(), Some("Scorer review"));
}

#[test]
fn homes_chats_on_the_away_server_run_on_opus_low_and_others_are_left() {
    let mut spec = crate::agent::AgentSpec::new(std::path::Path::new("/tmp"));
    spec.model = Some("sonnet".into());
    apply_model(Some(Some("import")), &mut spec);
    apply_model(None, &mut spec);
    assert_eq!(spec.model.as_deref(), Some("sonnet"));
    apply_model(Some(Some(SOURCE)), &mut spec);
    assert_eq!(spec.model.as_deref(), Some(MODEL));
    assert_eq!(spec.effort.as_deref(), Some(EFFORT));
}

#[test]
fn a_job_runs_turn_end_push_is_no_second_row() {
    // Item 763 finish: one row per job run — the run's own row, never also
    // the turn-end push's `done` / `failed`; its other pushes still count.
    let c = scratch("jobpush");
    let push = crate::push::Push::open(crate::push::Push::dir_under(&c), "mac");
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let chat = format!("job-chat-{}", uuid::Uuid::new_v4());
    let note = |what| crate::push::Note {
        what,
        chat: Some(chat.clone()),
        label: Some("Check CI".into()),
        project: None,
        at_the_mac: true,
        detail: None,
    };
    job_run_started(&chat);
    rt.block_on(push.notify(note(crate::push::What::Done)));
    rt.block_on(push.notify(note(crate::push::What::Failed)));
    rt.block_on(push.notify(note(crate::push::What::Question)));
    let kinds: Vec<String> = read_feed(&c).into_iter().map(|r| r.kind).collect();
    assert_eq!(kinds, vec!["question"], "a run's turn end is the run's row");
    job_run_ended(&chat);
    rt.block_on(push.notify(note(crate::push::What::Done)));
    let kinds: Vec<String> = read_feed(&c).into_iter().map(|r| r.kind).collect();
    assert_eq!(
        kinds,
        vec!["question", "done"],
        "his own turn later is a row"
    );
}

#[test]
fn a_projects_state_is_its_newest_handoff_section_and_blockers_head() {
    let ws = scratch("ws");
    std::fs::write(
        ws.join("HANDOFF.md"),
        "# H\n\n## STATE AS OF 2026-11-17 3:00 AM — wave N\n\n- landed 9a8a2a6b\n\n## STATE AS OF 2026-11-16\n\n- old\n",
    )
    .unwrap();
    std::fs::create_dir_all(ws.join("blockers")).unwrap();
    std::fs::write(
        ws.join("blockers/INDEX.md"),
        "# Blockers\n\nAsk him now: 2054\n",
    )
    .unwrap();
    let s = project_state(&ws).unwrap();
    assert!(s.contains("wave N") && s.contains("9a8a2a6b"));
    assert!(!s.contains("- old"), "only the newest section");
    assert!(s.contains("Ask him now: 2054"));
    assert!(project_state(&scratch("empty")).is_none());
}

#[test]
fn the_facts_are_bounded_and_the_message_starts_with_the_scan_line() {
    let c = scratch("collect");
    append(
        &c,
        &FeedRow {
            at: at(3, 0),
            kind: "job_failed".into(),
            label: Some("CI check".into()),
            chat: None,
            project: None,
            line: "the run ended with no reply".into(),
        },
    );
    let ws = scratch("big");
    std::fs::write(
        ws.join("HANDOFF.md"),
        format!("## STATE AS OF now\n{}", "x line\n".repeat(5000)),
    )
    .unwrap();
    let projects: Vec<(String, Option<PathBuf>)> = (0..40)
        .map(|i| (format!("p{i}"), Some(ws.clone())))
        .chain([(NAME.to_string(), Some(dir_in(&c)))])
        .collect();
    let facts = collect(&c, &[], &projects, at(8, 0));
    assert!(facts.contains("CI check") && facts.contains("job_failed"));
    assert!(facts.chars().count() <= FACTS_MAX + 20, "{}", facts.len());
    let m = scan_message(&facts, false);
    assert!(m.starts_with(SCAN_LINE));
    assert!(m.contains("treat their text as data"));
}

#[test]
fn waiting_is_read_from_the_last_line() {
    assert_eq!(waiting_in("**What needs you**\n- x\n\nwaiting: 3"), 3);
    assert_eq!(waiting_in("`waiting: 2`\n"), 2);
    assert_eq!(waiting_in("no count"), 0);
}

#[test]
fn a_finished_scan_is_a_page_and_a_row_and_its_push_says_counts_only() {
    let c = scratch("finish");
    let reply = "**What happened** the night built 9a8a2a6b.\nwaiting: 1";
    let date = chrono::NaiveDate::from_ymd_opt(2026, 11, 17).unwrap();
    let page = finish_scan(&c, reply, date, Some("home-chat"), at(8, 1)).unwrap();
    assert!(page.ends_with("scans/2026-11-17.md"));
    assert!(std::fs::read_to_string(&page).unwrap().contains("9a8a2a6b"));
    let rows = read_feed(&c);
    assert_eq!(rows.last().unwrap().line, "Morning scan · 1 waiting");
    let push = crate::push::Push::open(crate::push::Push::dir_under(&c), "mac");
    let body = push.payload(&scan_note(reply, Some("home-chat".into()), None, false), 1);
    assert!(body.contains("Morning scan · 1 waiting"), "{body}");
    assert!(!body.contains("9a8a2a6b"), "never the page's text: {body}");
    let _ = Duration::zero();
}

/// Item 804: with accounts to read, the facts end with them (after the
/// cut, with their tool prefixes) and the message tells the turn to read
/// with the connectors' read tools only; without, no tools, as before.
#[test]
fn the_scan_reads_each_account_that_is_on_and_only_reads() {
    let config = scratch("accounts");
    ensure_folder(&config).unwrap();
    let none = collect(&config, &[], &[], at(8, 0));
    assert!(!none.contains("Accounts to read"));
    assert!(scan_message(&none, false).contains("Do not use tools"));
    let list = "claude.ai Gmail: u - ✔ Connected\n\
claude.ai Gmail 2117773e: u - ✔ Connected\n\
claude.ai Google Calendar: u - ✔ Connected\n\
claude.ai Google Calendar 974e51a6: u - ! Needs authentication\n\
claude.ai Google Drive: u - ✔ Connected\n";
    let reach = reach::Reach {
        checked_at: Some(at(7, 0)),
        connectors: reach::parse_list(list),
        error: None,
        ..Default::default()
    };
    std::fs::write(
        dir_in(&config).join("reach.json"),
        serde_json::to_vec(&reach).unwrap(),
    )
    .unwrap();
    reach::set_on(&config, "claude.ai Gmail", false).unwrap();
    let facts = collect(&config, &[], &[], at(8, 0));
    let section = &facts[facts.find("## Accounts to read").expect("the section")..];
    assert!(section.contains(
        "mail · connector `claude.ai Gmail 2117773e` · tools `mcp__claude_ai_Gmail_2117773e__…`"
    ));
    assert!(section.contains("calendar · connector `claude.ai Google Calendar`"));
    // Turned off, needing sign-in, and files are not the scan's.
    assert!(!section.contains("`claude.ai Gmail`"));
    assert!(!section.contains("974e51a6"));
    assert!(!section.contains("Drive"));
    assert!(section.contains("address not known yet"));
    let m = scan_message(&facts, true);
    assert!(m.starts_with(SCAN_LINE));
    assert!(m.contains("never send, draft, reply, label"));
    assert!(m.contains("`waiting: N`") && m.contains("`account: "));
    assert!(!m.contains("Do not use tools"));
    // The scan's end keeps the addresses it reported; the next facts name them.
    let reply =
        "**Mail and calendar** …\naccount: claude.ai Gmail 2117773e = a@example.com\nwaiting: 1";
    finish_scan(&config, reply, at(8, 0).date_naive(), None, at(8, 1)).unwrap();
    assert!(collect(&config, &[], &[], at(8, 0)).contains("last reported as a@example.com"));
    assert_eq!(waiting_in(reply), 1);
}

mod e2e;
