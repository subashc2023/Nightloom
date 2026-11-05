//! Panics written to a file the app keeps (nightshift item 486, 2026-10-30).
//!
//! The release crashed at 11:27 AM on 2026-10-30 with an abort out of the
//! main event loop, and the panic's message went to stderr — which a
//! Finder-launched app sends nowhere. So every panic now appends a record to
//! `<config dir>/logs/panic.log` (`~/.nightloom/logs/panic.log`): the time,
//! the thread's name, the message, where it was raised, and a backtrace.
//! The previous hook still runs after, so a terminal launch prints as before.
//!
//! The same file takes the Objective-C exceptions [`crate::event_guard`]
//! catches in event dispatch, through [`note`].
//!
//! Nothing from the environment or the command line is written: a panic
//! message is the code's own text, and a backtrace is symbols and paths.

use std::io::Write;
use std::path::{Path, PathBuf};

/// Past this size the log moves to `panic.log.1` (one generation kept), so a
/// panic in a loop cannot fill the disk.
const ROTATE_AT_BYTES: u64 = 1024 * 1024;

/// `<config dir>/logs/panic.log`, or `None` with no config dir.
pub fn log_path() -> Option<PathBuf> {
    nightloom_service::project::config_dir().map(|c| c.join("logs").join("panic.log"))
}

/// Install the hook. Called first thing in `main`.
pub fn install() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(path) = log_path() {
            let message = payload_text(info.payload());
            let location = info
                .location()
                .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
                .unwrap_or_else(|| "unknown location".to_string());
            let thread = std::thread::current();
            let backtrace = std::backtrace::Backtrace::force_capture();
            let record = record(
                chrono::Utc::now(),
                "panic",
                thread.name().unwrap_or("<unnamed>"),
                &message,
                &location,
                &backtrace.to_string(),
            );
            append(&path, &record);
        }
        previous(info);
    }));
}

/// Append a non-panic record (an Objective-C exception caught in event
/// dispatch) to the same log.
pub fn note(kind: &str, message: &str, location: &str) {
    if let Some(path) = log_path() {
        let thread = std::thread::current();
        let backtrace = std::backtrace::Backtrace::force_capture();
        let record = record(
            chrono::Utc::now(),
            kind,
            thread.name().unwrap_or("<unnamed>"),
            message,
            location,
            &backtrace.to_string(),
        );
        append(&path, &record);
    }
}

fn payload_text(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}

/// One record: a header line, the message, then the backtrace, then a blank
/// line. `kind` is `panic` or `objc-exception`.
pub fn record(
    at: chrono::DateTime<chrono::Utc>,
    kind: &str,
    thread: &str,
    message: &str,
    location: &str,
    backtrace: &str,
) -> String {
    format!(
        "=== {} {kind} on thread '{thread}' at {location}\n{message}\n{}\n\n",
        at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        backtrace.trim_end()
    )
}

/// Append `record` to `path`, creating the folder, rotating past
/// [`ROTATE_AT_BYTES`]. Every failure is swallowed: this runs inside a panic
/// hook, where a second panic aborts.
pub fn append(path: &Path, record: &str) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > ROTATE_AT_BYTES {
            let _ = std::fs::rename(path, path.with_extension("log.1"));
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = f.write_all(record.as_bytes());
        let _ = f.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_record_carries_the_time_thread_message_location_and_backtrace() {
        let at = chrono::DateTime::parse_from_rfc3339("2026-10-30T18:27:17.789Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let r = record(at, "panic", "main", "boom", "src/main.rs:1:2", "0: frame\n");
        assert_eq!(
            r,
            "=== 2026-10-30T18:27:17.789Z panic on thread 'main' at src/main.rs:1:2\nboom\n0: frame\n\n"
        );
    }

    #[test]
    fn records_append_and_the_log_rotates_past_its_cap() {
        let dir = std::env::temp_dir().join(format!("nightloom-panic-log-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("logs").join("panic.log");
        append(&path, "one\n");
        append(&path, "two\n");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "one\ntwo\n");

        let big = "x".repeat(ROTATE_AT_BYTES as usize + 1);
        append(&path, &big);
        append(&path, "after\n");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "after\n");
        let rotated = std::fs::read_to_string(path.with_extension("log.1")).unwrap();
        assert!(rotated.starts_with("one\ntwo\n"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_panic_payload_reads_as_text() {
        let s: Box<dyn std::any::Any + Send> = Box::new("static");
        assert_eq!(payload_text(s.as_ref()), "static");
        let s: Box<dyn std::any::Any + Send> = Box::new(String::from("owned"));
        assert_eq!(payload_text(s.as_ref()), "owned");
        let s: Box<dyn std::any::Any + Send> = Box::new(7u8);
        assert_eq!(payload_text(s.as_ref()), "<non-string panic payload>");
    }
}
