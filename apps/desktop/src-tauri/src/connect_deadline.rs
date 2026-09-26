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
//! app's stderr is `/dev/null`.
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

/// The step a connect is on, readable from outside the future.
#[derive(Clone)]
pub struct Stage(Arc<Mutex<&'static str>>);

impl Stage {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new("starting")))
    }

    /// Say what the next wait is for.
    pub fn set(&self, what: &'static str) {
        *self.0.lock().unwrap_or_else(|p| p.into_inner()) = what;
    }

    pub fn get(&self) -> &'static str {
        *self.0.lock().unwrap_or_else(|p| p.into_inner())
    }
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
    match tokio::time::timeout(limit, connect).await {
        Ok(result) => result,
        Err(_) => {
            let message = timed_out(stage.get(), limit);
            let line = format!(
                "{} connect_agent: {message} (elapsed {:.1} s)",
                chrono::Utc::now().to_rfc3339(),
                started.elapsed().as_secs_f64()
            );
            eprintln!("{line}");
            if let Some(path) = log {
                append(path, &line);
            }
            Err(message)
        }
    }
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
    async fn a_connect_on_time_passes_its_result_through_and_logs_nothing() {
        let log = scratch("ontime").join("connect.log");
        let stage = Stage::new();
        let ok = run(&stage, SHORT, Some(&log), async {
            tokio::time::sleep(Duration::from_millis(5)).await;
            Ok::<_, String>(7)
        })
        .await;
        assert_eq!(ok, Ok(7));
        let err = run(&stage, SHORT, Some(&log), async {
            Err::<(), _>("not found".to_string())
        })
        .await;
        assert_eq!(err, Err("not found".to_string()));
        assert!(!log.exists());
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
