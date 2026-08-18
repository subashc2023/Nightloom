//! Session-log discovery: listing, prefix lookup, most-recent — everything a
//! shell needs to offer "resume". Loading and appending stay on
//! `nightloom_core::Session`.

use chrono::{DateTime, Utc};
use nightloom_core::SessionEvent;
use serde::Serialize;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("cannot read {}: {source}", path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("no session matching {prefix:?} in {}", dir.display())]
    NotFound { prefix: String, dir: PathBuf },
    #[error("session prefix {prefix:?} is ambiguous: {}", ids.join(", "))]
    Ambiguous { prefix: String, ids: Vec<String> },
    #[error("no session logs in {}", dir.display())]
    Empty { dir: PathBuf },
}

/// One session log, summarized for a picker listing.
#[derive(Debug, Clone, Serialize)]
pub struct SessionSummary {
    pub id: String,
    pub path: PathBuf,
    pub modified: DateTime<Utc>,
    pub user_turns: usize,
    pub first_user: Option<String>,
}

fn io_err(path: &Path) -> impl FnOnce(io::Error) -> StoreError {
    let path = path.to_path_buf();
    move |source| StoreError::Io { path, source }
}

fn log_files(log_dir: &Path) -> Result<Vec<PathBuf>, StoreError> {
    let entries = fs::read_dir(log_dir).map_err(io_err(log_dir))?;
    let mut paths = Vec::new();
    for entry in entries {
        let path = entry.map_err(io_err(log_dir))?.path();
        if path.extension().is_some_and(|e| e == "jsonl") {
            paths.push(path);
        }
    }
    Ok(paths)
}

/// Light-weight scan of one log: enough for a listing without reopening the
/// file for append the way `Session::load` does.
fn summarize(path: &Path) -> Result<SessionSummary, StoreError> {
    let modified = fs::metadata(path)
        .and_then(|m| m.modified())
        .map_err(io_err(path))?;
    let content = fs::read_to_string(path).map_err(io_err(path))?;
    let mut id = None;
    let mut user_turns = 0;
    let mut first_user = None;
    for line in content.lines().filter(|l| !l.trim().is_empty()) {
        // Unknown or malformed lines shouldn't sink the whole listing; future
        // SessionEvent variants show up here before this crate learns them.
        let Ok(event) = serde_json::from_str::<SessionEvent>(line) else {
            continue;
        };
        match event {
            SessionEvent::SessionCreated { id: found, .. } => id = Some(found),
            SessionEvent::UserMessage { text, .. } => {
                if first_user.is_none() {
                    first_user = Some(text);
                }
                user_turns += 1;
            }
            _ => {}
        }
    }
    let id = id
        .or_else(|| path.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_default();
    Ok(SessionSummary {
        id,
        path: path.to_path_buf(),
        modified: modified.into(),
        user_turns,
        first_user,
    })
}

/// Every session log in the dir, newest first. A missing dir is an empty
/// listing, not an error — no session has been recorded yet.
pub fn list(log_dir: &Path) -> Result<Vec<SessionSummary>, StoreError> {
    if !log_dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut sessions = Vec::new();
    for path in log_files(log_dir)? {
        sessions.push(summarize(&path)?);
    }
    sessions.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(sessions)
}

/// Resolve a session ID or unique ID prefix to its log file.
pub fn find_by_prefix(log_dir: &Path, prefix: &str) -> Result<PathBuf, StoreError> {
    let mut matches: Vec<PathBuf> = log_files(log_dir)?
        .into_iter()
        .filter(|p| {
            p.file_stem()
                .and_then(|s| s.to_str())
                .is_some_and(|s| s.starts_with(prefix))
        })
        .collect();
    match matches.len() {
        0 => Err(StoreError::NotFound {
            prefix: prefix.into(),
            dir: log_dir.to_path_buf(),
        }),
        1 => Ok(matches.remove(0)),
        _ => {
            matches.sort();
            Err(StoreError::Ambiguous {
                prefix: prefix.into(),
                ids: matches
                    .iter()
                    .filter_map(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned()))
                    .collect(),
            })
        }
    }
}

/// The most recently modified session log in the dir.
pub fn latest(log_dir: &Path) -> Result<PathBuf, StoreError> {
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for path in log_files(log_dir)? {
        let modified = fs::metadata(&path)
            .and_then(|m| m.modified())
            .map_err(io_err(&path))?;
        if best.as_ref().is_none_or(|(t, _)| modified > *t) {
            best = Some((modified, path));
        }
    }
    match best {
        Some((_, path)) => Ok(path),
        None => Err(StoreError::Empty {
            dir: log_dir.to_path_buf(),
        }),
    }
}

/// Collapse text to a single line, truncated to at most `max` chars.
pub fn one_line(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        flat
    } else {
        let cut: String = flat.chars().take(max).collect();
        format!("{cut}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir_with(names: &[&str]) -> PathBuf {
        // Unique enough for a test dir without pulling in uuid.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("nightloom-store-test-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        for name in names {
            fs::write(dir.join(format!("{name}.jsonl")), "").unwrap();
        }
        dir
    }

    #[test]
    fn prefix_matching() {
        let dir = dir_with(&["aabbccdd-1111", "aabbeeff-2222", "99887766-3333"]);

        let found = find_by_prefix(&dir, "9988").unwrap();
        assert_eq!(found.file_stem().unwrap(), "99887766-3333");

        let full = find_by_prefix(&dir, "aabbccdd-1111").unwrap();
        assert_eq!(full.file_stem().unwrap(), "aabbccdd-1111");

        assert!(matches!(
            find_by_prefix(&dir, "aabb"),
            Err(StoreError::Ambiguous { ids, .. }) if ids.len() == 2
        ));
        assert!(matches!(
            find_by_prefix(&dir, "zzzz"),
            Err(StoreError::NotFound { .. })
        ));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_dir_lists_empty() {
        let dir = std::env::temp_dir().join("nightloom-store-test-does-not-exist");
        assert!(list(&dir).unwrap().is_empty());
    }

    #[test]
    fn one_line_truncates_and_flattens() {
        assert_eq!(one_line("a\nb\tc", 60), "a b c");
        assert_eq!(one_line("abcdef", 3), "abc…");
    }
}
