//! Each note's one-line gist, kept by the file's size and modification time
//! (item 978), so the notes index opens only the notes that changed.
//!
//! Why: every connect builds the system prompt, whose project-notes and
//! knowledge sections list up to 200 notes each with a summary read from the
//! head of the file ([`crate::project::list_notes`]). His projects live in
//! iCloud-synced Documents, where each open is a File Provider round trip;
//! on a launch's cold first read that was the launch connect's whole wait —
//! median 1.6 s, worst 20 s, over 15 launches of 2026-11-19 → 11-25 (622's
//! third review; the stage was billed to "the chat's folders on disk"
//! because no stage was set around the prompt). The same walk with stats
//! only takes ~66 ms cold (item 865). So: stat every note as before, and
//! open one only when its size or modification time differ from what was
//! kept. Kept in memory and, in the app, in `<config>/cache/note-summaries.json`
//! ([`keep_on_disk`]), so the first connect after a launch finds them too.
//!
//! A file whose bytes change without its size or modification time changing
//! keeps its old gist until either does — the same bet `make` places.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// What is kept for one note: the identity it was read at, and its gist.
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
struct Kept {
    path: PathBuf,
    len: u64,
    modified_ns: i128,
    summary: Option<String>,
    kind: Option<String>,
}

#[derive(Default)]
struct Cache {
    loaded: bool,
    dirty: bool,
    by_path: HashMap<PathBuf, Kept>,
}

static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

/// Past this many entries the cache starts over: a bound on the file, not a
/// working limit (25 projects × ≤ 200 notes, plus the vault, is ~5,200).
const MAX_ENTRIES: usize = 20_000;

/// Where the gists are kept on disk, once the app says so ([`keep_on_disk`]).
static ON_DISK: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Keep the gists across launches in `<config>/cache/note-summaries.json`.
/// Called by the desktop app at launch; nothing else does, so a test (of
/// any crate) never reads or writes the real home's cache — kept in memory
/// only there.
pub fn keep_on_disk() {
    if let Some(c) = crate::project::config_dir() {
        let _ = ON_DISK.set(c.join("cache").join("note-summaries.json"));
    }
}

fn file() -> Option<PathBuf> {
    ON_DISK.get().cloned()
}

fn modified_ns(meta: &std::fs::Metadata) -> Option<i128> {
    let t = meta.modified().ok()?;
    Some(match t.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_nanos() as i128,
        Err(e) => -(e.duration().as_nanos() as i128),
    })
}

/// Read the file once, the first time it is known (a walk before
/// [`keep_on_disk`] does not use it up); what memory has already wins.
fn load(cache: &mut Cache) {
    if cache.loaded {
        return;
    }
    let Some(path) = file() else { return };
    cache.loaded = true;
    load_from(cache, &path);
}

fn load_from(cache: &mut Cache, path: &Path) {
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    if let Ok(list) = serde_json::from_str::<Vec<Kept>>(&text) {
        for k in list {
            cache.by_path.entry(k.path.clone()).or_insert(k);
        }
    }
}

/// The gist of the note at `path` whose metadata is `meta`: the kept one
/// when the file's size and modification time are the ones it was read at,
/// else `read(path)` — kept for next time.
pub(crate) fn summary(
    path: &Path,
    meta: &std::fs::Metadata,
    read: impl FnOnce(&Path) -> (Option<String>, Option<String>),
) -> (Option<String>, Option<String>) {
    let Some(modified_ns) = modified_ns(meta) else {
        return read(path);
    };
    let len = meta.len();
    if let Ok(mut g) = CACHE.lock() {
        let cache = g.get_or_insert_with(Cache::default);
        load(cache);
        if let Some(k) = cache.by_path.get(path)
            && k.len == len
            && k.modified_ns == modified_ns
        {
            return (k.summary.clone(), k.kind.clone());
        }
    }
    let (summary, kind) = read(path);
    if let Ok(mut g) = CACHE.lock() {
        let cache = g.get_or_insert_with(Cache::default);
        if cache.by_path.len() >= MAX_ENTRIES {
            cache.by_path.clear();
        }
        cache.by_path.insert(
            path.to_path_buf(),
            Kept {
                path: path.to_path_buf(),
                len,
                modified_ns,
                summary: summary.clone(),
                kind: kind.clone(),
            },
        );
        cache.dirty = true;
    }
    (summary, kind)
}

/// Write the kept gists out if a walk added any. Best-effort, whole by
/// rename; called once at the end of each walk that reads notes.
pub(crate) fn flush() {
    let Some(path) = file() else { return };
    let list: Vec<Kept> = {
        let Ok(mut g) = CACHE.lock() else { return };
        let Some(cache) = g.as_mut() else { return };
        if !cache.dirty {
            return;
        }
        cache.dirty = false;
        cache.by_path.values().cloned().collect()
    };
    write_to(&path, &list);
}

/// Write `list` to `path` whole: to a temporary file of this writer's own,
/// then renamed over, so a reader sees the old file or the new one.
fn write_to(path: &Path, list: &[Kept]) {
    static WRITES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let Ok(text) = serde_json::to_string(list) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let n = WRITES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_extension(format!("json.{}.{n}.tmp", std::process::id()));
    if std::fs::write(&tmp, text).is_ok() && std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "nightloom-note-summaries-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// A note read once is not opened again while its size and time hold;
    /// a change to either reads it afresh.
    #[test]
    fn a_kept_gist_is_reused_until_the_file_changes() {
        let d = scratch("reuse");
        let note = d.join("a.md");
        std::fs::write(&note, "# One\n").unwrap();
        let reads = Cell::new(0);
        let read = |p: &Path| {
            reads.set(reads.get() + 1);
            let t = std::fs::read_to_string(p).unwrap();
            (Some(t.trim().trim_start_matches("# ").to_string()), None)
        };
        let meta = std::fs::metadata(&note).unwrap();
        assert_eq!(summary(&note, &meta, read).0.as_deref(), Some("One"));
        let meta = std::fs::metadata(&note).unwrap();
        assert_eq!(summary(&note, &meta, read).0.as_deref(), Some("One"));
        assert_eq!(reads.get(), 1, "an unchanged note was opened again");
        std::fs::write(&note, "# Two, longer\n").unwrap();
        let meta = std::fs::metadata(&note).unwrap();
        assert_eq!(
            summary(&note, &meta, read).0.as_deref(),
            Some("Two, longer")
        );
        assert_eq!(reads.get(), 2);
        // Same size, a new modification time: read again too.
        std::fs::write(&note, "# Six, longer\n").unwrap();
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(7);
        std::fs::File::open(&note)
            .unwrap()
            .set_modified(later)
            .unwrap();
        let meta = std::fs::metadata(&note).unwrap();
        assert_eq!(
            summary(&note, &meta, read).0.as_deref(),
            Some("Six, longer")
        );
        assert_eq!(reads.get(), 3);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// What one launch wrote, the next reads back; memory's own entry wins.
    #[test]
    fn the_gists_survive_a_launch_on_disk() {
        let d = scratch("disk");
        let file = d.join("cache").join("note-summaries.json");
        let kept = |p: &str, s: &str| Kept {
            path: PathBuf::from(p),
            len: 3,
            modified_ns: 42,
            summary: Some(s.to_string()),
            kind: None,
        };
        write_to(&file, &[kept("/n/a.md", "A"), kept("/n/b.md", "B")]);
        let mut next = Cache::default();
        next.by_path
            .insert(PathBuf::from("/n/b.md"), kept("/n/b.md", "B, newer"));
        load_from(&mut next, &file);
        assert_eq!(
            next.by_path[Path::new("/n/a.md")].summary.as_deref(),
            Some("A")
        );
        assert_eq!(
            next.by_path[Path::new("/n/b.md")].summary.as_deref(),
            Some("B, newer")
        );
        let leftovers = std::fs::read_dir(file.parent().unwrap()).unwrap().count();
        assert_eq!(leftovers, 1, "no temporary file left behind");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Unless the app asked for it, nothing is written to (or read from)
    /// the home's cache file.
    #[test]
    fn tests_never_touch_the_home_cache() {
        assert!(file().is_none());
        flush();
    }
}
