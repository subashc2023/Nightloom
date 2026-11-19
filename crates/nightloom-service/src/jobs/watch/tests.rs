use super::*;
use serde_json::json;

fn scratch() -> PathBuf {
    std::env::temp_dir().join(format!("nightloom-watch-{}", uuid::Uuid::new_v4()))
}

#[test]
fn the_note_is_named_from_the_topic_and_never_twice() {
    assert_eq!(
        note_name("Sparse autoencoders & feature splitting?", &[]),
        "watch-sparse-autoencoders-feature-splitting.md"
    );
    assert_eq!(note_name("  ", &[]), "watch-topic.md");
    let taken = vec!["watch-ace.md".to_string(), "watch-ace-2.md".to_string()];
    assert_eq!(note_name("ACE", &taken), "watch-ace-3.md");
}

#[test]
fn a_watch_needs_a_topic_and_keeps_its_pages_once() {
    assert!(Watch::default().cleaned().is_err());
    let w = Watch {
        topic: " ACE ".into(),
        sources: vec!["https://a.org".into(), " ".into(), "https://a.org".into()],
        note: String::new(),
    }
    .cleaned()
    .unwrap();
    assert_eq!(w.topic, "ACE");
    assert_eq!(w.sources, vec!["https://a.org".to_string()]);
}

#[test]
fn the_run_text_holds_his_words_the_sources_the_note_and_the_shape() {
    let w = Watch {
        topic: "concept extrapolation".into(),
        sources: vec!["https://aligned.ai/blog".into()],
        note: "watch-x.md".into(),
    };
    let t = run_text(
        "Keep my note current.",
        &w,
        "## 2026-11-17 — old\n- a claim",
        "2026-11-18 8:00 AM",
    );
    assert!(t.starts_with("Keep my note current."));
    assert!(t.contains("search=concept+extrapolation"));
    assert!(t.contains("- https://aligned.ai/blog"));
    assert!(t.contains("- a claim"));
    assert!(t.contains(NOTHING_NEW));
    // The jobs' reply finder matches the run by his words.
    assert!(t.contains("Keep my note current."));
    let fresh = run_text("x", &w, "", "d");
    assert!(fresh.contains("The note is new"));
}

#[test]
fn only_pages_opened_with_webfetch_after_the_runs_message_count() {
    let log = vec![
        json!({"event": "user_message", "text": "watch it"}),
        json!({"event": "assistant_message", "blocks": [{"type": "tool_use", "name": "WebFetch", "input": {"url": "https://old.org/a"}}]}),
        json!({"event": "user_message", "text": "watch it\n\nblock"}),
        json!({"event": "assistant_message", "blocks": [
            {"type": "tool_use", "name": "WebFetch", "input": {"url": "http://WWW.Arxiv.org/abs/1#v2"}},
            {"type": "tool_use", "name": "WebSearch", "input": {"query": "https://search.org"}}
        ]}),
    ];
    assert_eq!(
        opened_in(&log, "watch it"),
        vec!["https://arxiv.org/abs/1".to_string()]
    );
}

#[test]
fn an_entry_tags_opened_links_external_and_the_rest_unverified() {
    let opened = vec!["https://arxiv.org/abs/2511.1".to_string()];
    let reply = "A new preprint extends ACE to images.\n\
- Smith et al. extend it to images — https://arxiv.org/abs/2511.1.\n\
- A blog says it was retracted — https://blog.example/x\n\
- Someone said so\n\
Some trailing prose.";
    let e = entry(reply, &opened, "2026-11-18 8:00 AM");
    assert!(e.changed);
    assert_eq!(e.headline, "A new preprint extends ACE to images.");
    assert_eq!((e.verified, e.unverified), (1, 2));
    assert!(
        e.text
            .starts_with("\n## 2026-11-18 8:00 AM — A new preprint")
    );
    assert!(e.text.contains("https://arxiv.org/abs/2511.1. `external`"));
    assert!(
        e.text
            .contains("blog.example/x `unverified: not opened in this run`")
    );
    assert!(e.text.contains("Someone said so `unverified: no link`"));
    assert!(!e.text.contains("trailing prose"));
}

#[test]
fn nothing_new_is_one_line_and_no_change() {
    let e = entry("Nothing new.", &[], "2026-11-18 8:00 AM");
    assert!(!e.changed);
    assert_eq!(e.text, "- 2026-11-18 8:00 AM — Nothing new.\n");
    // Claims with no opened page are recorded but are not a change.
    let e = entry("Big news.\n- x — https://a.org", &[], "d");
    assert!(!e.changed);
    assert!(e.text.contains("Nothing verified"));
}

#[test]
fn appending_never_rewrites_what_is_there() {
    let d = scratch();
    let p = d.join("watch-ace.md");
    let one = entry("Nothing new.", &[], "day 1");
    append(&p, "Watch — ACE", "ACE", &one).unwrap();
    let first = std::fs::read_to_string(&p).unwrap();
    assert!(first.starts_with("# Research watch — Watch — ACE"));
    let two = entry("Nothing new.", &[], "day 2");
    append(&p, "Watch — ACE", "ACE", &two).unwrap();
    let both = std::fs::read_to_string(&p).unwrap();
    assert!(both.starts_with(&first));
    assert!(both.ends_with("- day 2 — Nothing new.\n"));
    assert_eq!(both.matches("# Research watch").count(), 1);
    assert_eq!(tail(&p), both);
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn an_unfiled_watch_keeps_its_note_in_the_homes_watch_folder() {
    let d = scratch();
    let w = Watch {
        topic: "x".into(),
        sources: vec![],
        note: "../../etc/passwd".into(),
    };
    let p = note_path(&d, None, &w);
    assert_eq!(p.parent().unwrap(), d.join("watch"));
    assert!(!p.to_string_lossy().contains(".."));
}

#[test]
fn a_watch_runs_turn_end_push_is_held_until_it_ends() {
    quiet_started("c-794");
    assert!(is_quiet("c-794"));
    quiet_ended("c-794");
    assert!(!is_quiet("c-794"));
}

#[test]
fn the_stamp_is_his_clock_in_12_hours() {
    let at = chrono::DateTime::parse_from_rfc3339("2026-11-18T16:05:00Z")
        .unwrap()
        .with_timezone(&Utc);
    let la = jiff::tz::TimeZone::get("America/Los_Angeles").unwrap();
    assert_eq!(stamp(at, &la), "2026-11-18 8:05 AM");
}
