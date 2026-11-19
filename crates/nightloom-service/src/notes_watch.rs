//! The notes folders followed from outside Nightloom (item 869).
//!
//! The Notes panel re-read its folders only after a turn, after Nightloom's
//! own writes and after a phone write, so a file copied in by Finder or a
//! script, moved to the Trash, renamed, or brought down by iCloud stayed
//! wrong until the next turn ("cannot read …: No such file or directory").
//! This is one OS subscription per folder (FSEvents on macOS), coalesced so
//! a burst — a folder dragged in, a sync landing — is one re-read, and never
//! later than [`MAX_LATENCY`] during a long one. No polling: an idle folder
//! costs nothing.

use crate::nightshift::watch::{self, ChangeWatcher};
use std::path::Path;
use std::time::Duration;

/// Quiet time before a batch is handed on: short enough that the list
/// follows "within about a second", long enough that a copy's create and
/// its writes arrive as one.
pub const DEBOUNCE: Duration = Duration::from_millis(250);

/// The longest a sustained burst waits before a re-read anyway.
pub const MAX_LATENCY: Duration = Duration::from_secs(1);

/// Watch a notes folder recursively; `on_change` runs (on the watcher's own
/// thread) once per coalesced batch of outside or inside changes. Dropping
/// the returned watcher stops it. A folder that does not exist is refused —
/// the caller re-asks when the list is next read.
pub fn watch_notes(
    dir: &Path,
    on_change: impl Fn() + Send + 'static,
) -> Result<ChangeWatcher, String> {
    watch::watch(dir, DEBOUNCE, MAX_LATENCY, move |_paths| on_change())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Instant;

    fn scratch() -> std::path::PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let d = std::env::temp_dir().join(format!(
            "nightloom-869-{}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst),
            rand_tag()
        ));
        fs::create_dir_all(d.join("files/lectures")).unwrap();
        // Canonical: FSEvents reports /private/var for /var.
        d.canonicalize().unwrap()
    }

    fn rand_tag() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }

    /// Wait until `calls` passes `above`; the time it took, or None.
    fn arrives(calls: &AtomicUsize, above: usize, within: Duration) -> Option<Duration> {
        let t = Instant::now();
        while t.elapsed() < within {
            if calls.load(Ordering::SeqCst) > above {
                return Some(t.elapsed());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        None
    }

    /// His case (item 869): a PDF copied in, a .txt moved out to a Trash
    /// elsewhere, a rename — each reaches the list within ~1 s, and the
    /// listing then shows the folder as it is.
    #[test]
    fn an_outside_add_remove_and_rename_each_reach_the_list_within_a_second() {
        let dir = scratch();
        let lectures = dir.join("files/lectures");
        fs::write(lectures.join("MIPS (1).txt"), "old").unwrap();
        let trash = scratch();
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let w = watch_notes(&dir, move || {
            c.fetch_add(1, Ordering::SeqCst);
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(400));
        let settle = |calls: &AtomicUsize| {
            // Let any trailing batch land before the next step's baseline.
            std::thread::sleep(Duration::from_millis(400));
            calls.load(Ordering::SeqCst)
        };
        let budget = Duration::from_millis(1600);

        let before = settle(&calls);
        fs::write(lectures.join("MIPS.pdf"), b"%PDF-1.4").unwrap();
        let add = arrives(&calls, before, budget).expect("an outside add was never reported");

        let before = settle(&calls);
        fs::rename(lectures.join("MIPS (1).txt"), trash.join("MIPS (1).txt")).unwrap();
        let gone = arrives(&calls, before, budget).expect("a move to the Trash was never reported");

        let before = settle(&calls);
        fs::rename(
            lectures.join("MIPS.pdf"),
            lectures.join("MIPS-Architecture.pdf"),
        )
        .unwrap();
        let renamed = arrives(&calls, before, budget).expect("a rename was never reported");

        eprintln!("869 measured: add {add:?}, move-out {gone:?}, rename {renamed:?}");
        let names: Vec<String> = crate::project::list_note_tree(&dir)
            .notes
            .into_iter()
            .map(|n| n.name)
            .collect();
        assert_eq!(
            names,
            vec!["files/lectures/MIPS-Architecture.pdf".to_string()]
        );
        drop(w);
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&trash);
    }

    #[test]
    fn a_missing_folder_is_refused_not_a_panic() {
        assert!(watch_notes(Path::new("/nightloom-869-no-such-dir"), || {}).is_err());
    }
}
