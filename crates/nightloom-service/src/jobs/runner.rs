//! The Mac's background jobs runner (nightshift item 781): jobs run on time
//! with Nightloom quit.
//!
//! A launchd agent (`~/Library/LaunchAgents/`, [`plist`]) starts the app's
//! own binary as `nightloom-desktop --jobs-runner` every minute. Each start
//! is cheap when nothing is due: it reads `jobs.json` and exits
//! ([`due_now`]). When a job is due it takes the Nightloom home's holder
//! lock — so it never runs beside the app, which holds the same lock for
//! its whole life (`serve::HomeLock`) — and runs the jobs' clock over the
//! windowless host (`serve::ServeHost::new_mac_runner`) until no run is in
//! flight and none is due, then lets the lock go. While the app is open
//! the lock is taken and the runner exits at once: the app's own clock
//! runs the jobs.
//!
//! **An approval mid-run** cannot be answered (the runner has no listener;
//! the phone reaches the Mac through the app), so such a run is ended and
//! recorded as having no reply; the job runs again at its next time.
//!
//! **The app opened mid-run:** the app finds the runner holding the home,
//! asks it to yield ([`ask_to_yield`]), says so in a note that closes
//! itself, and opens once the lock is free. The runner starts nothing new
//! once asked and exits when its runs end (blocker 2061: waiting, not
//! stopping the run, is the default taken).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, Utc};

use super::{Job, Jobs};
use crate::remote::Host;

/// Who holds the home while the runner runs (the lock file's text).
pub const RUNNER_WHO: &str = "the Nightloom jobs runner";
/// The flag launchd starts the app's binary with.
pub const FLAG: &str = "--jobs-runner";
/// The launchd agent's label (and its plist's name).
pub const LABEL: &str = "com.nightloom.jobs-runner";
/// How often launchd starts it.
pub const EVERY_SECS: u32 = 60;
/// The file the app writes to ask a running runner to finish up.
const YIELD_FILE: &str = "runner-yield";

/// Whether any of the jobs kept under `jobs_dir` wants the clock now: a
/// run in flight, a Run now, or a run due (not paused, not waiting on a
/// retry). Stand-in copies (the away server's) never. A file that does not
/// read wants nothing.
pub fn due_now(jobs_dir: &Path, now: DateTime<Utc>) -> bool {
    let jobs: Vec<Job> = std::fs::read(jobs_dir.join("jobs.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    jobs.iter().any(|j| {
        !j.stand_in
            && (j.running.is_some()
                || j.run_now
                || (!j.paused && j.next_run <= now && j.retry_at.is_none_or(|at| at <= now)))
    })
}

/// The app asks the runner to start nothing new and let go.
pub fn ask_to_yield(config: &Path) {
    let _ = std::fs::write(config.join(YIELD_FILE), b"the app is opening\n");
}

/// The app holds the home: an old ask is spent.
pub fn clear_yield(config: &Path) {
    let _ = std::fs::remove_file(config.join(YIELD_FILE));
}

fn yield_asked(config: &Path) -> bool {
    config.join(YIELD_FILE).exists()
}

/// Whether the lock file names the runner as its holder.
pub fn runner_holds(config: &Path) -> bool {
    std::fs::read_to_string(config.join(crate::serve::LOCK_FILE))
        .is_ok_and(|t| t.starts_with(RUNNER_WHO))
}

/// What one start of the runner did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ran {
    /// Nothing was due; the lock was not touched.
    NothingDue,
    /// The app (or `nightloom serve`) holds the home; its clock runs them.
    HomeHeld,
    /// The clock ran this many ticks.
    Ticked(u32),
}

/// One start of the runner on `config`'s home. `make_host` builds the
/// windowless host once the lock is held; `now` is the clock (a test's
/// fake time); `every` the pause between ticks.
pub async fn run(
    config: &Path,
    make_host: impl FnOnce() -> Arc<dyn Host>,
    now: impl Fn() -> DateTime<Utc>,
    every: std::time::Duration,
) -> Ran {
    let jobs_dir = Jobs::dir_under(config);
    if !due_now(&jobs_dir, now()) {
        return Ran::NothingDue;
    }
    let Ok(lock) = crate::serve::HomeLock::take(config, RUNNER_WHO) else {
        return Ran::HomeHeld;
    };
    let host = make_host();
    let Some(jobs) = host.jobs() else {
        return Ran::NothingDue;
    };
    let mut ticks = 0;
    loop {
        let yielding = yield_asked(config);
        if yielding {
            jobs.finish_ended(host.as_ref(), now()).await;
        } else {
            jobs.tick(host.as_ref(), now()).await;
        }
        ticks += 1;
        // Nobody can answer an approval here (the runner has no listener;
        // the phone reaches the Mac only through the app): a run that
        // stopped on one is ended, not left to hold the home for hours.
        if jobs.any_running() && !host.state().await.pending.is_empty() {
            let _ = host.cancel(None).await;
        }
        if !jobs.any_running() && (yielding || !due_now(&jobs_dir, now())) {
            break;
        }
        // A run that cannot start retries a minute on: the next launchd
        // start picks it up, so this start ends when only waiting is left.
        if !jobs.any_running() && ticks > 1 {
            break;
        }
        tokio::time::sleep(every).await;
    }
    clear_yield(config);
    drop(lock);
    Ran::Ticked(ticks)
}

/// Where the agent's plist goes.
pub fn plist_path(user_home: &Path) -> PathBuf {
    user_home
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{LABEL}.plist"))
}

fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The launchd agent: `exe --jobs-runner` every [`EVERY_SECS`], in the
/// background, its output to `<config>/logs/jobs-runner.log`. `path` is the
/// PATH its turns see (launchd's own is only the system folders, where
/// `claude` is not). Pure.
pub fn plist(exe: &Path, config: &Path, path: &str) -> String {
    let log = config.join("logs").join("jobs-runner.log");
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>{exe}</string>
		<string>{FLAG}</string>
	</array>
	<key>StartInterval</key>
	<integer>{EVERY_SECS}</integer>
	<key>RunAtLoad</key>
	<false/>
	<key>ProcessType</key>
	<string>Background</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>{path}</string>
	</dict>
	<key>StandardOutPath</key>
	<string>{log}</string>
	<key>StandardErrorPath</key>
	<string>{log}</string>
</dict>
</plist>
"#,
        exe = xml(&exe.to_string_lossy()),
        path = xml(path),
        log = xml(&log.to_string_lossy()),
    )
}

/// Whether the app at `exe` installs the agent: only an app inside a
/// `.app` bundle that is not a build folder's (a dev build must never
/// point his agent at itself), on the default home (`NIGHTLOOM_HOME`
/// unset). Pure.
pub fn installs_from(exe: &Path, nightloom_home_set: bool) -> bool {
    let s = exe.to_string_lossy();
    !nightloom_home_set
        && s.contains(".app/Contents/MacOS/")
        && !s.contains("/target/")
        && !s.contains("/local/")
}

#[cfg(test)]
mod tests;
