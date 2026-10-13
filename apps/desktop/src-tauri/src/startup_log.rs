//! Where a launch spends its time (nightshift item 220, 2026-09-26).
//!
//! The window opened empty and "not connected" for 7–86 s on 2026-09-25,
//! and the window's own timings could not say whether a slow step was the
//! command's work or its wait in the queue before it ran. So the three
//! commands a launch waits on — the last project's reopen (`open_project`),
//! the engine connect (`connect_agent` / `connect`) and the vault location
//! read (`knowledge_info`) — plus the project list write one line each to
//! `<config dir>/logs/startup.log`: when the command began (wall clock and
//! ms since the process started), its name and how long it ran. The window
//! adds its own view of each launch step through [`startup_mark`]; set side
//! by side, the two tell work from queueing.
//!
//! A line per call, not only at launch: the same commands run when he
//! switches project or reconnects, and a slow one then is the same fault.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Instant;

static LAUNCH: OnceLock<Instant> = OnceLock::new();

/// Note the process start; `main` calls this first so every later line's
/// `+N ms` counts from launch rather than from the first command.
pub fn mark_launch() {
    let _ = LAUNCH.get_or_init(Instant::now);
}

fn since_launch(at: Instant) -> u128 {
    at.saturating_duration_since(*LAUNCH.get_or_init(Instant::now))
        .as_millis()
}

/// `<config dir>/logs/startup.log`, or `None` with no config dir.
pub fn log_path() -> Option<PathBuf> {
    nightloom_service::project::config_dir().map(|c| c.join("logs").join("startup.log"))
}

/// One line: `<start, UTC> +<ms since launch> ms <who> <name> <ms> ms[ <detail>]`.
pub fn line(
    wall: chrono::DateTime<chrono::Utc>,
    since_launch_ms: u128,
    who: &str,
    name: &str,
    ms: u128,
    detail: &str,
) -> String {
    let mut out = format!(
        "{} +{since_launch_ms} ms {who} {name} {ms} ms",
        wall.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    );
    if !detail.is_empty() {
        out.push(' ');
        out.push_str(detail);
    }
    out
}

/// Run `fut` and append its line to `log` (the startup log in the app;
/// a scratch file in the tests). The result is passed through untouched.
pub async fn timed_to<T, E>(
    log: Option<&Path>,
    name: &str,
    fut: impl Future<Output = Result<T, E>>,
) -> Result<T, E> {
    let wall = chrono::Utc::now();
    let started = Instant::now();
    let result = fut.await;
    let ms = started.elapsed().as_millis();
    let detail = if result.is_ok() { "" } else { "(error)" };
    if let Some(path) = log {
        append(
            path,
            &line(wall, since_launch(started), "rust", name, ms, detail),
        );
    }
    result
}

/// [`timed_to`] the startup log.
pub async fn timed<T, E>(name: &str, fut: impl Future<Output = Result<T, E>>) -> Result<T, E> {
    let log = log_path();
    timed_to(log.as_deref(), name, fut).await
}

/// The window's own timing of a launch step (`init` in `state.svelte.ts`):
/// how long the step took as the window saw it, queueing included.
#[tauri::command]
pub fn startup_mark(step: String, ms: f64, detail: Option<String>) {
    if let Some(path) = log_path() {
        let now = Instant::now();
        let took = if ms.is_finite() && ms > 0.0 {
            ms as u128
        } else {
            0
        };
        // The line is stamped with when the step began, as the Rust lines are.
        let began = now
            .checked_sub(std::time::Duration::from_millis(took as u64))
            .unwrap_or(now);
        let wall = chrono::Utc::now() - chrono::Duration::milliseconds(took as i64);
        append(
            &path,
            &line(
                wall,
                since_launch(began),
                "window",
                &step,
                took,
                detail.as_deref().unwrap_or(""),
            ),
        );
    }
}

/// A dispatch that holds the IPC thread this long gets a line.
pub const SLOW_DISPATCH_MS: u128 = 50;

/// Wrap the invoke handler: a command whose dispatch itself takes
/// [`SLOW_DISPATCH_MS`] or more — a synchronous command, which runs on the
/// thread every other call arrives on — gets a `dispatch` line, since every
/// call behind it waits that long before it starts. An async command's
/// dispatch only spawns it, so it never shows here; its own line does.
pub fn timed_dispatch<R: tauri::Runtime>(
    inner: impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(tauri::ipc::Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke: tauri::ipc::Invoke<R>| {
        let name = invoke.message.command().to_string();
        let wall = chrono::Utc::now();
        let started = Instant::now();
        let handled = inner(invoke);
        let ms = started.elapsed().as_millis();
        if ms >= SLOW_DISPATCH_MS
            && let Some(path) = log_path()
        {
            append(
                &path,
                &line(wall, since_launch(started), "dispatch", &name, ms, ""),
            );
        }
        handled
    }
}

fn append(path: &Path, line: &str) {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(f, "{line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nightloom-startup-log-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("logs").join("startup.log")
    }

    #[test]
    fn a_line_names_the_command_its_start_and_its_time() {
        let wall = chrono::DateTime::parse_from_rfc3339("2026-09-26T08:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        assert_eq!(
            line(wall, 1234, "rust", "open_project", 6800, ""),
            "2026-09-26T08:00:00.000Z +1234 ms rust open_project 6800 ms"
        );
        assert_eq!(
            line(wall, 5, "window", "openProject", 7, "(deadline)"),
            "2026-09-26T08:00:00.000Z +5 ms window openProject 7 ms (deadline)"
        );
    }

    #[tokio::test]
    async fn a_timed_command_appends_one_line_and_passes_its_result_through() {
        let log = scratch("timed");
        let ok: Result<u8, String> = timed_to(Some(&log), "knowledge_info", async {
            tokio::time::sleep(Duration::from_millis(30)).await;
            Ok(7)
        })
        .await;
        assert_eq!(ok, Ok(7));
        let err: Result<u8, String> = timed_to(Some(&log), "open_project", async {
            Err("gone".to_string())
        })
        .await;
        assert_eq!(err, Err("gone".to_string()));
        let text = std::fs::read_to_string(&log).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2, "{text}");
        assert!(lines[0].contains(" rust knowledge_info "), "{}", lines[0]);
        let ms: u128 = lines[0]
            .split(" knowledge_info ")
            .nth(1)
            .and_then(|r| r.split(' ').next())
            .and_then(|n| n.parse().ok())
            .unwrap();
        assert!(ms >= 30, "{ms}");
        assert!(lines[1].ends_with("(error)"), "{}", lines[1]);
    }
}
