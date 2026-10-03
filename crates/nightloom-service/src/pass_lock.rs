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
use std::time::{Duration, Instant};

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

/// How long [`take`] keeps asking before it calls the lock held, and how
/// often. Any `Command` spawn in this process forks, and until the child
/// execs it holds a copy of every open fd — a just-released lock's
/// included — so a pass that starts right after another one ends can read
/// the lock as held for that instant. Under CPU load the instant is long
/// enough to see: the capture test's second pass was refused that way
/// (nightshift backlog 168, 2026-09-23, 1 run in 2 under 12 busy
/// processes). Re-asking for half a second covers it; a pass that loses
/// to a real one waits that long before its sentence (blocker 303).
const RE_ASK_FOR: Duration = Duration::from_millis(500);
const RE_ASK_EVERY: Duration = Duration::from_millis(50);

/// Take the lock, or the sentence for the pass that lost — after asking
/// again for [`RE_ASK_FOR`], so a fork's instant is not read as another
/// Nightloom's pass. Blocks for at most that long.
pub fn take(config: &Path) -> Result<PassLock, String> {
    let deadline = Instant::now() + RE_ASK_FOR;
    loop {
        if let Some(lock) = try_take(config)? {
            return Ok(lock);
        }
        if Instant::now() >= deadline {
            return Err(HELD_ELSEWHERE.to_string());
        }
        std::thread::sleep(RE_ASK_EVERY);
    }
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
    ///
    /// Both halves re-ask for up to two seconds after the release — the
    /// same-process re-take and the other process's take — rather than
    /// read one instant as the answer. The re-take was one read until
    /// nightshift backlog 168 (2026-09-23): under a 12-process CPU load the
    /// fork-to-exec window is wide enough that it read "held" in 2 runs of 2.
    #[test]
    fn a_second_taker_and_another_process_are_refused_until_the_first_lets_go() {
        let config = temp_config("second");
        let first = take(&config).unwrap();
        let asked = Instant::now();
        assert_eq!(take(&config).unwrap_err(), HELD_ELSEWHERE);
        assert!(
            asked.elapsed() >= RE_ASK_FOR,
            "a held lock is asked again before the sentence"
        );
        assert!(try_take(&config).unwrap().is_none());
        drop(first);
        // Another thread's fork may still hold the released lock for an
        // instant (see above): ask again for up to two seconds.
        let mut again = take(&config);
        for _ in 0..20 {
            if again.is_ok() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
            again = take(&config);
        }
        drop(again.unwrap());
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
        // The other tests in this binary spawn processes too (the centre
        // tests run git); a fork on another thread between our drop and
        // the child's exec inherits the lock's fd and holds it for that
        // instant (2026-09-17: 1 run in 3 read "held" here). Ask again
        // for up to two seconds rather than read one instant as the answer.
        let mut stdout = String::new();
        for _ in 0..20 {
            let out = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "pass_lock::tests::helper_try_take_from_env",
                    "--nocapture",
                ])
                .env("NIGHTLOOM_PASS_LOCK_DIR", &config)
                .output()
                .unwrap();
            stdout = String::from_utf8_lossy(&out.stdout).into_owned();
            if stdout.contains("PASS_LOCK: free") {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
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
