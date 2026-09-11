//! The live-shift lock and the launcher.
//!
//! `state/run.lock` holds the pid of the running shift (§10: one live shift
//! per project). Everything the GUI writes checks it first, because a write
//! that races the runner is the one way this module can corrupt state the
//! runner depends on.
//!
//! Only the *readers* here compile everywhere. Whether a pid is alive is
//! answered per OS — `kill -0` on macOS, `/proc` on Linux, unknown
//! elsewhere — and launching a shift is macOS only, because the launch line
//! is `caffeinate -dis bash bin/nightshift.sh …` and `caffeinate` exists
//! nowhere else. A platform that cannot tell whether the pid is alive treats
//! a lock file as live: the cost of being wrong that way is a refused edit,
//! the other way is a corrupted shift.

use serde::Serialize;
use std::fs;
use std::path::Path;

/// What `state/run.lock` says, and whether that pid is still running.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Lock {
    /// The pid in the file, or `None` when the file exists but holds none.
    pub pid: Option<u32>,
    /// `Some(true)` running, `Some(false)` dead (a stale lock from a shift
    /// that was killed), `None` when this platform cannot say.
    pub alive: Option<bool>,
}

impl Lock {
    /// Whether writers must stand back. Unknown counts as live.
    pub fn blocks_writes(&self) -> bool {
        self.alive != Some(false)
    }
}

/// The lock, or `None` when there is no lock file.
pub fn read_lock(root: &Path) -> Option<Lock> {
    let text = fs::read_to_string(root.join("state").join("run.lock")).ok()?;
    let pid = text.trim().parse::<u32>().ok();
    let alive = pid.and_then(pid_alive);
    Some(Lock { pid, alive })
}

/// A shift is live: the lock exists and its pid is alive, or cannot be
/// checked.
pub fn is_live(root: &Path) -> bool {
    read_lock(root).is_some_and(|l| l.blocks_writes())
}

/// The guard every writer calls.
pub fn ensure_not_live(root: &Path) -> Result<(), String> {
    match read_lock(root) {
        None => Ok(()),
        Some(l) if !l.blocks_writes() => Ok(()),
        Some(Lock {
            pid: Some(pid),
            alive: Some(true),
        }) => Err(format!(
            "a shift is live (pid {pid}); wait for it to finish before editing this project"
        )),
        Some(Lock { pid, .. }) => Err(format!(
            "state/run.lock exists (pid {}) and this platform cannot tell whether the shift is still running; remove the lock if the shift is over",
            pid.map(|p| p.to_string())
                .unwrap_or_else(|| "unreadable".into())
        )),
    }
}

/// Whether `pid` is a running process, where the OS lets a plain user ask.
#[cfg(target_os = "macos")]
pub fn pid_alive(pid: u32) -> Option<bool> {
    // `kill -0` sends no signal and reports whether the pid exists. A pid
    // owned by another user answers EPERM, which is also "exists" — but the
    // lock was written by the same user that runs this app.
    std::process::Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .ok()
        .map(|s| s.success())
}

#[cfg(target_os = "linux")]
pub fn pid_alive(pid: u32) -> Option<bool> {
    Some(Path::new("/proc").join(pid.to_string()).is_dir())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn pid_alive(_pid: u32) -> Option<bool> {
    None
}

/// The runner script, relative to the root.
pub const RUNNER: &str = "bin/nightshift.sh";

/// Whether the root carries a runner to launch.
pub fn runner_present(root: &Path) -> bool {
    root.join(RUNNER).is_file()
}

/// Launch a shift: `caffeinate -dis bash bin/nightshift.sh --plan <plan>`,
/// detached from this process (its own process group, no inherited stdio)
/// so closing Nightloom does not end the night. Returns the pid of the
/// `caffeinate` wrapper; the runner writes its own pid into the lock.
///
/// Refused when the lock says a shift is live, when the plan is not inside
/// this root, and when the root has no runner.
#[cfg(target_os = "macos")]
pub fn launch(root: &Path, plan_rel: &str) -> Result<u32, String> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    ensure_not_live(root)?;
    if !runner_present(root) {
        return Err(format!(
            "{} has no {RUNNER}; install the runner there before launching",
            root.display()
        ));
    }
    let plan = super::confined(root, plan_rel)?;
    if !plan.is_file() {
        return Err(format!("no plan at {}", plan.display()));
    }
    // A GUI process launched from the Dock inherits a PATH without the
    // user's shell additions, and `claude` lives in one of those. Prepend the
    // usual places rather than fail on the first turn.
    let mut path = std::env::var("PATH").unwrap_or_default();
    if let Some(home) = std::env::var_os("HOME") {
        let home = std::path::PathBuf::from(home);
        for extra in [home.join(".local/bin"), home.join(".claude/local")] {
            let s = extra.to_string_lossy().into_owned();
            if !path.split(':').any(|p| p == s) {
                path = format!("{s}:{path}");
            }
        }
    }
    for extra in ["/opt/homebrew/bin", "/usr/local/bin"] {
        if !path.split(':').any(|p| p == extra) {
            path = format!("{extra}:{path}");
        }
    }
    let child = Command::new("caffeinate")
        .args(["-dis", "bash", RUNNER, "--plan", plan_rel])
        .current_dir(root)
        .env("PATH", path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|e| format!("could not start the runner: {e}"))?;
    Ok(child.id())
}

#[cfg(not(target_os = "macos"))]
pub fn launch(_root: &Path, _plan_rel: &str) -> Result<u32, String> {
    Err("launching a shift is only supported on macOS (the launch line needs caffeinate); start it from a terminal there".into())
}

#[cfg(test)]
mod tests {
    use super::super::testutil::scratch;
    use super::*;

    #[test]
    fn no_lock_file_means_not_live() {
        let ws = scratch();
        assert_eq!(read_lock(&ws), None);
        assert!(!is_live(&ws));
        assert!(ensure_not_live(&ws).is_ok());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn our_own_pid_is_live_where_the_platform_can_tell() {
        let ws = scratch();
        fs::write(
            ws.join("state/run.lock"),
            format!("{}\n", std::process::id()),
        )
        .unwrap();
        let lock = read_lock(&ws).unwrap();
        assert_eq!(lock.pid, Some(std::process::id()));
        assert_ne!(lock.alive, Some(false));
        assert!(lock.blocks_writes());
        assert!(is_live(&ws));
        assert!(ensure_not_live(&ws).is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn a_stale_lock_frees_writers_where_the_platform_can_tell() {
        let ws = scratch();
        // Larger than any real pid on the systems CI runs on.
        fs::write(ws.join("state/run.lock"), "4194304\n").unwrap();
        let lock = read_lock(&ws).unwrap();
        match pid_alive(4194304) {
            Some(false) => {
                assert!(!lock.blocks_writes());
                assert!(ensure_not_live(&ws).is_ok());
            }
            _ => {
                assert!(lock.blocks_writes());
                assert!(ensure_not_live(&ws).unwrap_err().contains("cannot tell"));
            }
        }
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn an_unreadable_pid_blocks_writers() {
        let ws = scratch();
        fs::write(ws.join("state/run.lock"), "not a pid\n").unwrap();
        let lock = read_lock(&ws).unwrap();
        assert_eq!(lock.pid, None);
        assert!(lock.blocks_writes());
        assert!(ensure_not_live(&ws).is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn launching_without_a_runner_or_off_macos_is_refused_before_anything_runs() {
        let ws = scratch();
        assert!(!runner_present(&ws));
        let err = launch(&ws, "shifts/x/plan.json").unwrap_err();
        assert!(err.contains("macOS") || err.contains(RUNNER), "{err}");
        let _ = fs::remove_dir_all(&ws);
    }
}
