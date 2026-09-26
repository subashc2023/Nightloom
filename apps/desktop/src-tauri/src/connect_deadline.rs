//! A connect never hangs silently (nightshift item 220, agent H,
//! 2026-09-25).
//!
//! The installed app sat at "connecting…" for over forty minutes: the
//! window's `connect_agent` promise never settled, with no `claude` child,
//! no pipe and every runtime worker parked. Whatever it waited on, nothing
//! said so — the rail stayed locked and no log named the wait. So the
//! command runs under a deadline here: it records which step it is on
//! ([`Stage::set`] before each wait), and at [`CONNECT_TIMEOUT`] it gives
//! up with an error that names that step — shown on the rail — and appends
//! the same line to `<config dir>/logs/connect.log`, since the installed
//! app's stderr is `/dev/null`. Since item 222 every connect appends one
//! line there, on time or not: its total and the ms each step took.
//!
//! Dropping the connect at the deadline releases every lock it held (tokio
//! guards drop with the future). What it had already done stays done: the
//! prompt hold it saved, the pending view it set. The next connect writes
//! both again.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How long a connect may take. A healthy one is well under a second plus
/// the `claude --version` probe (0.1 s measured); twenty seconds is long
/// enough for a cold disk and short enough that he is not left guessing.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// The step a connect is on, readable from outside the future, and when
/// each step began — the timing line (item 222) is built from these.
#[derive(Clone)]
pub struct Stage(Arc<Mutex<Vec<(&'static str, Instant)>>>);

impl Stage {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(vec![("starting", Instant::now())])))
    }

    /// Say what the next wait is for.
    pub fn set(&self, what: &'static str) {
        self.marks().push((what, Instant::now()));
    }

    pub fn get(&self) -> &'static str {
        self.marks().last().map(|m| m.0).unwrap_or("starting")
    }

    fn marks(&self) -> std::sync::MutexGuard<'_, Vec<(&'static str, Instant)>> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Milliseconds spent on each step up to `end`, in the order each was
    /// first reached; a step reached twice is summed.
    pub fn durations(&self, end: Instant) -> Vec<(&'static str, u128)> {
        let marks = self.marks();
        let mut out: Vec<(&'static str, u128)> = Vec::new();
        for (i, (name, at)) in marks.iter().enumerate() {
            let until = marks.get(i + 1).map(|m| m.1).unwrap_or(end);
            let ms = until.saturating_duration_since(*at).as_millis();
            match out.iter_mut().find(|(n, _)| n == name) {
                Some(slot) => slot.1 += ms,
                None => out.push((name, ms)),
            }
        }
        out
    }
}

/// The one line every connect writes (item 222): its outcome, total ms and
/// ms per step, e.g. `ok total 412 ms; starting 0 ms, the open project … 3 ms`.
pub fn timing_line(stage: &Stage, started: Instant, end: Instant, outcome: &str) -> String {
    let stages = stage
        .durations(end)
        .iter()
        .map(|(name, ms)| format!("{name} {ms} ms"))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "{outcome} total {} ms; {stages}",
        end.saturating_duration_since(started).as_millis()
    )
}

/// Run `connect` under `limit`. On time, its result; past it, an error
/// naming the stage it was on, also written to the connect log.
pub async fn run<T>(
    stage: &Stage,
    limit: Duration,
    log: Option<&Path>,
    connect: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    let started = Instant::now();
    let (result, late) = match tokio::time::timeout(limit, connect).await {
        Ok(result) => (result, false),
        Err(_) => (Err(timed_out(stage.get(), limit)), true),
    };
    // One line per connect, whatever its outcome (item 222): the timeout's
    // message as before, and now the time each step took.
    let outcome = match &result {
        Ok(_) => "ok".to_string(),
        Err(e) if late => format!("{e} (elapsed {:.1} s)", started.elapsed().as_secs_f64()),
        Err(e) => format!("error: {e}"),
    };
    let line = format!(
        "{} connect_agent: {}",
        chrono::Utc::now().to_rfc3339(),
        timing_line(stage, started, Instant::now(), &outcome)
    );
    if result.is_err() {
        eprintln!("{line}");
    }
    if let Some(path) = log {
        append(path, &line);
    }
    result
}

/// What the rail shows when a connect ran out of time.
pub fn timed_out(stage: &str, limit: Duration) -> String {
    format!(
        "Connecting gave up after {} s, still waiting on {stage}. Nothing was changed; \
         try again, and if it happens again the wait is recorded in ~/.nightloom/logs/connect.log.",
        limit.as_secs()
    )
}

/// `<config dir>/logs/connect.log`, or `None` with no config dir.
pub fn log_path() -> Option<PathBuf> {
    nightloom_service::project::config_dir().map(|c| c.join("logs").join("connect.log"))
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
    use crate::chats::Chats;
    use nightloom_core::{ChatKind, ChatMode};

    /// Short, so the tests run in real time without a paused clock.
    const SHORT: Duration = Duration::from_millis(100);

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nightloom-connect-deadline-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn a_connect_that_never_finishes_fails_at_the_deadline_naming_its_wait() {
        let log = scratch("never").join("logs").join("connect.log");
        let stage = Stage::new();
        let s = stage.clone();
        let err = run(&stage, SHORT, Some(&log), async move {
            s.set("the open chat's lock");
            std::future::pending::<Result<(), String>>().await
        })
        .await
        .unwrap_err();
        assert!(err.contains("the open chat's lock"), "{err}");
        let written = std::fs::read_to_string(&log).unwrap();
        assert!(written.contains("the open chat's lock"), "{written}");
        assert!(timed_out("x", CONNECT_TIMEOUT).contains("after 20 s"));
    }

    #[tokio::test]
    async fn a_connect_on_time_passes_its_result_through_and_logs_one_timing_line() {
        // ~~logs nothing~~ — since item 222 (2026-09-25) every connect
        // writes one line: its outcome, total ms and ms per step.
        let log = scratch("ontime").join("connect.log");
        let stage = Stage::new();
        let s = stage.clone();
        let ok = run(&stage, SHORT, Some(&log), async move {
            s.set("the open project (the workspaces lock)");
            tokio::time::sleep(Duration::from_millis(5)).await;
            Ok::<_, String>(7)
        })
        .await;
        assert_eq!(ok, Ok(7));
        let err = run(&Stage::new(), SHORT, Some(&log), async {
            Err::<(), _>("not found".to_string())
        })
        .await;
        assert_eq!(err, Err("not found".to_string()));
        let written = std::fs::read_to_string(&log).unwrap();
        let lines: Vec<&str> = written.lines().collect();
        assert_eq!(lines.len(), 2, "{written}");
        assert!(
            lines[0].contains("connect_agent: ok total "),
            "{}",
            lines[0]
        );
        assert!(lines[0].contains("; starting "), "{}", lines[0]);
        assert!(
            lines[0].contains("the open project (the workspaces lock) "),
            "{}",
            lines[0]
        );
        assert!(
            lines[1].contains("connect_agent: error: not found total "),
            "{}",
            lines[1]
        );
    }

    #[test]
    fn a_step_reached_twice_is_summed_and_kept_in_first_order() {
        let stage = Stage::new();
        let t0 = Instant::now();
        {
            let mut m = stage.marks();
            m.clear();
            m.push(("a", t0));
            m.push(("b", t0 + Duration::from_millis(10)));
            m.push(("a", t0 + Duration::from_millis(30)));
        }
        let d = stage.durations(t0 + Duration::from_millis(35));
        assert_eq!(d, vec![("a", 15), ("b", 20)]);
        assert_eq!(
            timing_line(&stage, t0, t0 + Duration::from_millis(35), "ok"),
            "ok total 35 ms; a 15 ms, b 20 ms"
        );
    }

    /// The shape of the item-136 family: a turn holds the open chat's log,
    /// and a connect needs it. Before this module the connect waited as long
    /// as the holder did — forever, if the holder never finished; now it
    /// comes back at the deadline, and the holder's lock is untouched.
    #[tokio::test]
    async fn a_connect_behind_a_held_chat_lock_comes_back_and_leaves_the_holder_alone() {
        let dir = scratch("held");
        let chats = Chats::default();
        let (held, _) = chats
            .lock_or_start(ChatMode::Normal, ChatKind::Build, &dir)
            .await
            .unwrap();
        let stage = Stage::new();
        let s = stage.clone();
        let err = run(&stage, SHORT, None, async {
            s.set("the open chat's lock");
            let open = chats.lock_focused().await;
            Ok::<_, String>(open.as_ref().is_some())
        })
        .await
        .unwrap_err();
        assert!(err.contains("the open chat's lock"), "{err}");
        drop(held);
        // Released by its holder, the chat is lockable at once.
        assert!(chats.try_lock_focused().is_ok());
    }
}
