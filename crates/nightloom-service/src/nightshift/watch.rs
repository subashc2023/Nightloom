//! A debounced watcher over a contract root.
//!
//! The runner rewrites `status.json` at every phase change and at least once
//! a minute, appends to `run.log` continuously, and commits between passes;
//! the GUI has no other way to learn any of that than the files changing.
//! Polling would be a stat storm forever; this is one OS subscription per
//! open project, coalesced so a burst of writes is one re-read.

use notify::{RecursiveMode, Watcher as _};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// A running watch. Dropping it stops the subscription and the thread.
pub struct ChangeWatcher {
    _watcher: notify::RecommendedWatcher,
}

/// Paths under the root that are noise: git's own churn during a commit,
/// and this module's own temp files.
fn interesting(root: &Path, path: &Path) -> bool {
    let rel = path.strip_prefix(root).unwrap_or(path);
    let mut comps = rel.components();
    if comps.any(|c| c.as_os_str() == ".git" || c.as_os_str() == "__pycache__") {
        return false;
    }
    !path
        .file_name()
        .map(|n| n.to_string_lossy().ends_with(".tmp"))
        .unwrap_or(false)
}

/// Watch `root` recursively; `on_change` receives the changed paths (deduplicated,
/// root-relative) once the tree has been quiet for `debounce`, or every
/// `max_latency` during a sustained burst such as a unit appending to
/// `run.log`. The callback runs on the watcher's own thread.
pub fn watch(
    root: &Path,
    debounce: Duration,
    max_latency: Duration,
    on_change: impl Fn(Vec<String>) + Send + 'static,
) -> Result<ChangeWatcher, String> {
    if !root.is_dir() {
        return Err(format!("{} is not a directory", root.display()));
    }
    let root = root.to_path_buf();
    let (tx, rx) = mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(tx).map_err(|e| e.to_string())?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    std::thread::Builder::new()
        .name("nightshift-watch".into())
        .spawn(move || {
            let mut pending: Vec<PathBuf> = Vec::new();
            let mut first: Option<Instant> = None;
            loop {
                let wait = match first {
                    None => Duration::from_secs(3600),
                    Some(t) => {
                        let since = t.elapsed();
                        if since >= max_latency {
                            Duration::ZERO
                        } else {
                            debounce.min(max_latency - since)
                        }
                    }
                };
                match rx.recv_timeout(wait) {
                    Ok(Ok(event)) => {
                        // An open or a close-without-write is a read, not a
                        // change. inotify reports opens (`IN_OPEN` is in
                        // notify's mask) and the recursive registration
                        // itself opens every subdirectory to list it, so
                        // without this the first batch on Linux is the tree's
                        // directories. FSEvents and Windows never emit these.
                        if matches!(event.kind, notify::EventKind::Access(_)) {
                            continue;
                        }
                        for p in event.paths {
                            if interesting(&root, &p) && !pending.contains(&p) {
                                pending.push(p);
                            }
                        }
                        if !pending.is_empty() && first.is_none() {
                            first = Some(Instant::now());
                        }
                    }
                    Ok(Err(_)) => {}
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if !pending.is_empty() {
                            let paths = pending
                                .drain(..)
                                .map(|p| super::rel_display(&root, &p))
                                .collect();
                            first = None;
                            on_change(paths);
                        } else {
                            first = None;
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        })
        .map_err(|e| format!("could not start the watch thread: {e}"))?;
    Ok(ChangeWatcher { _watcher: watcher })
}

#[cfg(test)]
mod tests {
    use super::super::testutil::scratch;
    use super::*;
    use std::fs;
    use std::sync::{Arc, Mutex};

    #[test]
    fn a_write_arrives_once_and_git_churn_does_not() {
        let ws = scratch();
        let seen: Arc<Mutex<Vec<Vec<String>>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let w = watch(
            &ws,
            Duration::from_millis(150),
            Duration::from_secs(2),
            move |paths| sink.lock().unwrap().push(paths),
        )
        .unwrap();
        // Let the subscription settle before writing.
        std::thread::sleep(Duration::from_millis(300));
        fs::create_dir_all(ws.join(".git")).unwrap();
        fs::write(ws.join(".git/index"), "x").unwrap();
        fs::write(ws.join("state/status.tmp"), "x").unwrap();
        fs::write(ws.join("state/run.lock"), "1\n").unwrap();
        fs::write(ws.join("state/run.lock"), "2\n").unwrap();
        // Wait for the batch that carries the write, not merely the first
        // batch: a backend may deliver other events first.
        let deadline = Instant::now() + Duration::from_secs(8);
        let has_write =
            |b: &Vec<Vec<String>>| b.iter().flatten().any(|p| p.ends_with("state/run.lock"));
        while Instant::now() < deadline {
            if has_write(&seen.lock().unwrap()) {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let batches = seen.lock().unwrap().clone();
        assert!(!batches.is_empty(), "no change event arrived");
        let flat: Vec<&String> = batches.iter().flatten().collect();
        assert!(has_write(&batches), "{flat:?}");
        assert!(!flat.iter().any(|p| p.contains(".git")), "{flat:?}");
        assert!(!flat.iter().any(|p| p.ends_with(".tmp")), "{flat:?}");
        drop(w);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn a_missing_root_is_refused() {
        assert!(
            watch(
                Path::new("/nightloom-no-such-dir"),
                Duration::from_millis(10),
                Duration::from_millis(10),
                |_| {}
            )
            .is_err()
        );
    }
}
