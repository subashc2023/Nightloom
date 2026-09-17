//! One pass at a time, across processes (nightshift backlog 133, 2026-09-17;
//! review B's FB4).
//!
//! The desktop kept a dream, a capture or a tidy from overlapping with a
//! `tokio::sync::Mutex` of its own — one per process. The dev app beside
//! the installed app (or the CLI's `nightloom dream` at the same hour)
//! each had their own, so both ran a dream over the one vault: every
//! observation consolidated twice, two proposals for one file, a
//! pre-dream snapshot that committed the other dream's half-written
//! notes under its name.
//!
//! This is the lock they share: an advisory lock on `pass.lock` under the
//! config folder (`std::fs::File::try_lock`, `flock` on macOS and Linux,
//! `LockFileEx` on Windows), taken by [`dream::run`], [`capture::run`] and
//! the tidy for the pass's length and released when the guard drops —
//! including on a panic, and by the OS when the process dies, so a crash
//! never leaves it held. The loser gets a sentence to show and runs
//! nothing.
//!
//! [`dream::run`]: crate::dream::run
//! [`capture::run`]: crate::capture::run

use std::fs::{self, File};
use std::path::Path;

/// The lock file's name under the config folder.
pub const LOCK_FILE: &str = "pass.lock";

/// What a second pass is told.
pub const HELD_ELSEWHERE: &str = "a dream, a capture or a tidy is already running in another Nightloom (the other app, or the CLI) — wait for it to finish";

/// The pass's hold on the lock. Dropping it releases the lock.
#[derive(Debug)]
pub struct PassLock {
    _file: File,
}

/// Take the lock, or `Ok(None)` when another process holds it. An `Err`
/// is the file system refusing (the config folder unwritable), which is
/// a different problem from a second pass.
pub fn try_take(config: &Path) -> Result<Option<PassLock>, String> {
    fs::create_dir_all(config)
        .map_err(|e| format!("could not create {}: {e}", config.display()))?;
    let path = config.join(LOCK_FILE);
    let file = File::options()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(&path)
        .map_err(|e| format!("could not open {}: {e}", path.display()))?;
    match file.try_lock() {
        Ok(()) => Ok(Some(PassLock { _file: file })),
        Err(fs::TryLockError::WouldBlock) => Ok(None),
        Err(fs::TryLockError::Error(e)) => Err(format!("could not lock {}: {e}", path.display())),
    }
}

/// Take the lock, or the sentence for the pass that lost.
pub fn take(config: &Path) -> Result<PassLock, String> {
    try_take(config)?.ok_or_else(|| HELD_ELSEWHERE.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_config(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("nightloom-pass-lock-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// One test, in order, rather than two in parallel: a `Command` spawn
    /// in one thread forks, and until the child execs it holds a copy of
    /// every open fd — this lock's included — so a lock released in the
    /// other thread at that instant read as still held (seen: 1 run in 3).
    /// Harmless in the app (the pass holds the lock across its own
    /// spawns anyway); in the suite it made the two tests race.
    #[test]
    fn a_second_taker_and_another_process_are_refused_until_the_first_lets_go() {
        let config = temp_config("second");
        let first = take(&config).unwrap();
        assert_eq!(take(&config).unwrap_err(), HELD_ELSEWHERE);
        assert!(try_take(&config).unwrap().is_none());
        drop(first);
        let again = take(&config).unwrap();
        drop(again);
        let _ = fs::remove_dir_all(&config);

        // The lock is a process's, not a handle's: another *process* must
        // be refused. A child runs this same test binary's helper.
        let config = temp_config("process");
        let held = take(&config).unwrap();
        let out = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "pass_lock::tests::helper_try_take_from_env",
                "--nocapture",
            ])
            .env("NIGHTLOOM_PASS_LOCK_DIR", &config)
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(stdout.contains("PASS_LOCK: held"), "{stdout}");
        drop(held);
        let out = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "pass_lock::tests::helper_try_take_from_env",
                "--nocapture",
            ])
            .env("NIGHTLOOM_PASS_LOCK_DIR", &config)
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(stdout.contains("PASS_LOCK: free"), "{stdout}");
        let _ = fs::remove_dir_all(&config);
    }

    /// Not a test of anything on its own: the child the test above runs.
    #[test]
    fn helper_try_take_from_env() {
        let Ok(dir) = std::env::var("NIGHTLOOM_PASS_LOCK_DIR") else {
            return;
        };
        match try_take(Path::new(&dir)).unwrap() {
            Some(_) => println!("PASS_LOCK: free"),
            None => println!("PASS_LOCK: held"),
        }
    }
}
