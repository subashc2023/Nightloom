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

use super::Config;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

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

/// The runner script, relative to the runner root.
pub const RUNNER: &str = "bin/nightshift.sh";

/// The directory holding `bin/`: `runner` from `nightshift.json` when set
/// (§3, blocker 024: one install, named by path), else the contract root
/// itself. A relative `runner` is taken from the contract root.
pub fn runner_root(root: &Path, config: &Config) -> PathBuf {
    match config.runner.as_deref() {
        Some(r) if !r.trim().is_empty() => root.join(r),
        _ => root.to_path_buf(),
    }
}

/// The absolute path of the script to run.
pub fn runner_script(root: &Path, config: &Config) -> PathBuf {
    runner_root(root, config).join(RUNNER)
}

/// Whether there is a runner to launch for this root.
pub fn runner_present(root: &Path, config: &Config) -> bool {
    runner_script(root, config).is_file()
}

/// Launch a shift: `caffeinate -dis bash <runner>/bin/nightshift.sh --plan
/// <plan>` with the contract root as the working directory — that is how
/// the script tells the contract root from its own install (§3). Detached
/// from this process (its own process group, no inherited stdio) so closing
/// Nightloom does not end the night. Returns the pid of the `caffeinate`
/// wrapper; the runner writes its own pid into the lock.
///
/// Refused when the lock says a shift is live, when the plan is not inside
/// this root, and when the runner script is not where `nightshift.json`
/// says it is.
#[cfg(target_os = "macos")]
pub fn launch(root: &Path, config: &Config, plan_rel: &str) -> Result<u32, String> {
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    ensure_not_live(root)?;
    let script = runner_script(root, config);
    if !script.is_file() {
        return Err(format!(
            "no runner at {}; set `runner` in nightshift.json to the directory holding {RUNNER}, or install it there",
            script.display()
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
        .arg("-dis")
        .arg("bash")
        .arg(&script)
        .arg("--plan")
        .arg(plan_rel)
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
pub fn launch(_root: &Path, _config: &Config, _plan_rel: &str) -> Result<u32, String> {
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
        let config = Config::default();
        assert!(!runner_present(&ws, &config));
        let err = launch(&ws, &config, "shifts/x/plan.json").unwrap_err();
        assert!(err.contains("macOS") || err.contains(RUNNER), "{err}");
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn the_runner_is_looked_for_where_the_config_says() {
        let ws = scratch();
        // No key: the root's own bin/.
        let own = Config::default();
        assert_eq!(runner_root(&ws, &own), ws);
        assert_eq!(runner_script(&ws, &own), ws.join(RUNNER));
        // An absolute key wins over the root.
        let install = ws.join("elsewhere");
        fs::create_dir_all(install.join("bin")).unwrap();
        let pointed = Config {
            runner: Some(install.to_string_lossy().into_owned()),
            ..Config::default()
        };
        assert_eq!(runner_root(&ws, &pointed), install);
        assert!(!runner_present(&ws, &pointed));
        fs::write(install.join(RUNNER), "#!/bin/bash\n").unwrap();
        assert!(runner_present(&ws, &pointed));
        assert!(!runner_present(&ws, &own));
        // A relative key is taken from the root; an empty one means none.
        let relative = Config {
            runner: Some("elsewhere".into()),
            ..Config::default()
        };
        assert!(runner_present(&ws, &relative));
        let empty = Config {
            runner: Some("  ".into()),
            ..Config::default()
        };
        assert_eq!(runner_root(&ws, &empty), ws);
        // The refusal names the path it looked at.
        let err = launch(&ws, &own, "shifts/x/plan.json").unwrap_err();
        assert!(
            err.contains("macOS") || err.contains(&ws.join(RUNNER).display().to_string()),
            "{err}"
        );
        let _ = fs::remove_dir_all(&ws);
    }
}
