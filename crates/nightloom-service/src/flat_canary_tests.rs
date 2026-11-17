//! Item 758's canary: a CLI without the switch's strings is a notice, a
//! flat chat's second request under 95% is a notice, and the healthy cases
//! are none.

use super::*;
use std::collections::BTreeMap;

fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("nightloom-758c-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A bundle-shaped text holding what 2.1.326's does, padded so the strings
/// sit past the first chunk and one straddles a chunk boundary.
fn bundle(with_env: bool, with_cap: bool) -> Vec<u8> {
    let mut b = vec![b'x'; (1 << 20) - 10];
    if with_env {
        b.extend_from_slice(b"function Pbi(e){let a=s.CLAUDE_CODE_MODEL_CAPABILITIES;}");
    }
    b.extend(std::iter::repeat_n(b'y', 3 << 20));
    if with_cap {
        b.extend_from_slice(b"L$=[...GR,\"mid_conv_system\"];");
    }
    // A near miss that must not count for the capability.
    b.extend_from_slice(b"rejected_with_mid_conv_system tengu_mid_conv_system_fallback_retry");
    b
}

#[test]
fn a_bundle_holding_both_strings_raises_nothing() {
    let missing = missing_in(&bundle(true, true)[..]).unwrap();
    assert!(missing.is_empty(), "{missing:?}");
    assert_eq!(bundle_notice(Some("2.1.326"), &missing, 0), None);
}

#[test]
fn a_bundle_missing_a_string_is_a_notice_naming_758_and_the_version() {
    let missing = missing_in(&bundle(true, false)[..]).unwrap();
    assert_eq!(missing, vec!["\"mid_conv_system\""]);
    let a = bundle_notice(Some("2.1.400"), &missing, 0).unwrap();
    assert_eq!(a.kind, AlarmKind::Bundle);
    assert_eq!(a.item, 758);
    assert!(
        a.title.contains("758") && a.title.contains("2.1.400"),
        "{}",
        a.title
    );
    assert!(a.detail.contains("mid_conv_system"), "{}", a.detail);
    assert_eq!(a.id, "758:bundle:2.1.400");

    let none = missing_in(&bundle(false, false)[..]).unwrap();
    assert_eq!(none.len(), 2);
    let a = bundle_notice(None, &none, 0).unwrap();
    assert!(a.title.contains("an unknown version"), "{}", a.title);
}

#[test]
fn a_string_split_across_two_chunks_is_found() {
    // CLAUDE_CODE_MODEL_CAPABILITIES straddling the 1 MiB boundary.
    let mut b = vec![b'x'; (1 << 20) - 12];
    b.extend_from_slice(b"CLAUDE_CODE_MODEL_CAPABILITIES \"mid_conv_system\"");
    assert!(missing_in(&b[..]).unwrap().is_empty());
}

#[test]
fn the_bundle_check_reads_a_cli_file_and_its_link() {
    let d = scratch("bundle");
    let good = d.join("good");
    let bad = d.join("bad");
    std::fs::write(&good, bundle(true, true)).unwrap();
    std::fs::write(&bad, bundle(false, true)).unwrap();
    let link = d.join("claude");
    std::os::unix::fs::symlink(&bad, &link).unwrap();
    assert!(bundle_missing(&good).unwrap().1.unwrap().is_empty());
    let (real, found) = bundle_missing(&link).unwrap();
    assert_eq!(real, bad.canonicalize().unwrap());
    assert_eq!(found.unwrap(), vec![crate::agent::flat::CAPS_ENV]);
    assert!(bundle_missing(&d.join("absent")).is_none());
    let _ = std::fs::remove_dir_all(&d);
}

const T0: i64 = 1_763_330_000_000;

fn second(read: u64, context: u64) -> Request {
    Request {
        kind: Kind::Turn,
        chat: "chat-1".into(),
        project: None,
        at_ms: T0 + 60_000,
        read,
        context,
        last_ms: Some(T0),
        one_hour: true,
        cost_usd: None,
        chosen: None,
        cli_file: None,
        ask_dir: None,
    }
}

const FLAT_SECOND: Context = Context {
    flat: true,
    nth: 2,
    parts_changed: false,
};

#[test]
fn a_flat_chats_second_request_under_95_percent_is_a_notice() {
    // The pre-fix figure: 23,165 of 32,533.
    let a = cache_alarm(&second(23_165, 32_533), FLAT_SECOND, Some("2.1.400")).unwrap();
    assert_eq!(a.kind, AlarmKind::Cache);
    assert_eq!(a.id, "758:cache:2.1.400");
    assert!(
        a.title.contains("no longer honour the 758 switch"),
        "{}",
        a.title
    );
    assert!(
        a.detail.contains("23165 of 32533") && a.detail.contains("71%"),
        "{}",
        a.detail
    );
    assert_eq!(a.chat.as_deref(), Some("chat-1"));
    // A ping counts too.
    let mut ping = second(30_000, 32_533);
    ping.kind = Kind::Ping;
    assert!(cache_alarm(&ping, FLAT_SECOND, None).is_some());
}

#[test]
fn a_read_of_95_percent_or_more_or_another_case_raises_nothing() {
    // Measured with the switch: 32,668 of 32,672.
    assert_eq!(
        cache_alarm(&second(32_668, 32_672), FLAT_SECOND, None),
        None
    );
    assert_eq!(cache_alarm(&second(95, 100), FLAT_SECOND, None), None);
    let low = second(23_165, 32_533);
    // Not flat (every chat before 758), not the second request.
    let off = Context {
        flat: false,
        ..FLAT_SECOND
    };
    assert_eq!(cache_alarm(&low, off, None), None);
    for nth in [1, 3, 9] {
        assert_eq!(
            cache_alarm(&low, Context { nth, ..FLAT_SECOND }, None),
            None
        );
    }
    // Nightloom's own parts changed: another bug's, not the switch's.
    let moved = Context {
        parts_changed: true,
        ..FLAT_SECOND
    };
    assert_eq!(cache_alarm(&low, moved, None), None);
    // The cache had expired; he chose the change; a rewind.
    let mut late = low.clone();
    late.at_ms = T0 + 2 * cache_miss::ONE_HOUR_MS;
    assert_eq!(cache_alarm(&late, FLAT_SECOND, None), None);
    let mut chose = low.clone();
    chose.chosen = Some("an edit marker".into());
    assert_eq!(cache_alarm(&chose, FLAT_SECOND, None), None);
    let mut rewind = low.clone();
    rewind.kind = Kind::Rewind;
    assert_eq!(cache_alarm(&rewind, FLAT_SECOND, None), None);
}

fn print(system: &str) -> BTreeMap<String, String> {
    let mut parts = BTreeMap::new();
    parts.insert("system".to_string(), system.to_string());
    parts.insert("argv".to_string(), "--resume x".to_string());
    parts
}

#[test]
fn the_context_is_read_off_the_mark_and_the_chats_prints() {
    let d = scratch("cx");
    let ask = d.join("ask");
    let marks = d.join("flat-sessions");
    crate::agent::flat::mark_in(&marks, "sess-flat").unwrap();
    cache_miss::record_print(&ask, Kind::Turn, T0 - 1_000, &print("a")).unwrap();
    cache_miss::record_print(&ask, Kind::Turn, T0 + 59_000, &print("a")).unwrap();
    let mut req = second(23_165, 32_533);
    req.ask_dir = Some(ask.clone());
    req.cli_file = Some(d.join("sess-flat.jsonl"));
    let cx = context_of(&req, &marks);
    assert!(cx.flat && cx.nth == 2 && !cx.parts_changed, "{cx:?}");
    assert!(cache_alarm(&req, cx, None).is_some());
    // An unmarked session is not judged.
    req.cli_file = Some(d.join("sess-old.jsonl"));
    assert!(!context_of(&req, &marks).flat);
    // A third request, and a second whose own parts moved.
    cache_miss::record_print(&ask, Kind::Ping, T0 + 120_000, &print("b")).unwrap();
    req.cli_file = Some(d.join("sess-flat.jsonl"));
    req.at_ms = T0 + 120_000;
    let cx = context_of(&req, &marks);
    assert_eq!(cx.nth, 3);
    assert!(cx.parts_changed);
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn the_version_is_the_session_files_newest() {
    let d = scratch("ver");
    let f = d.join("s.jsonl");
    std::fs::write(
        &f,
        "{\"type\":\"user\",\"version\":\"2.1.325\"}\n{\"type\":\"summary\"}\n{\"type\":\"assistant\",\"version\":\"2.1.326\"}\nnot json \"version\"\n",
    )
    .unwrap();
    assert_eq!(version_in(&f).as_deref(), Some("2.1.326"));
    assert_eq!(version_in(&d.join("absent.jsonl")), None);
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn an_alarm_is_logged_once_per_id() {
    let d = scratch("log");
    let log = d.join("logs").join(LOG_FILE);
    let a = cache_alarm(&second(1, 100), FLAT_SECOND, Some("2.1.400")).unwrap();
    assert!(raise_in(&log, &a).unwrap());
    assert!(!raise_in(&log, &a).unwrap());
    let b = bundle_notice(Some("2.1.400"), &["x"], 0).unwrap();
    assert!(raise_in(&log, &b).unwrap());
    assert_eq!(read_log(&log), vec![a, b]);
    let _ = std::fs::remove_dir_all(&d);
}

/// Against the CLI installed on this machine: its file still holds both
/// strings. Reads the file only — no model call, no token. Ignored by
/// default (CI has no CLI): `cargo test -p nightloom-service flat_canary --
/// --ignored the_installed_cli`.
#[test]
#[ignore = "reads the installed Claude Code CLI"]
fn the_installed_cli_still_holds_the_switch() {
    let bin = PathBuf::from(crate::resolve_binary("claude"));
    let (real, found) = bundle_missing(&bin).expect("claude on PATH");
    let missing = found.expect("the CLI's file reads");
    assert!(
        missing.is_empty(),
        "item 758: {} lacks {missing:?}; re-match the switch",
        real.display()
    );
}
