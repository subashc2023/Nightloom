//! What an aside changed on disk (nightshift item 775, 2026-11-16).
//!
//! An aside is a fork of the chat's session, and under the chat's
//! permissions it may edit files. The main chat never sees the fork, so
//! its picture of those files goes stale: his ask was "is there any way
//! to like send thsoe updates to the main agent in the next message?".
//! This module is the part that knows what changed; the window carries it
//! to the main chat as a short note at the end of his next message.
//!
//! Two sources, merged by path:
//!
//! - **The aside's own edit calls** (`Edit`, `MultiEdit`, `Write`,
//!   `NotebookEdit`) that succeeded — their paths and, for an edit, the
//!   lines it took out and put in ([`Collector`]).
//! - **A before/after look at the workspace** for what a shell command
//!   (`Bash`) did, which no input names ([`Snapshot`]): in a git work tree
//!   the files `git status` lists, each with its size and mtime, and their
//!   `git diff --numstat` against HEAD; elsewhere a capped walk of sizes
//!   and mtimes. The "after" look is taken only when the aside ran a shell
//!   command. The aside holds the chat's agent while it runs (it waits for
//!   the chat's turn, `ask_aside`), so nothing of the chat's own runs in
//!   between and what moved is the aside's — or something outside
//!   Nightloom, which is why such a file is "seen changed", not "changed".
use crate::turn::TurnEvent;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant, UNIX_EPOCH};

/// How a file came to be listed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum How {
    /// An `Edit` / `MultiEdit` / `NotebookEdit` call.
    Edited,
    /// A `Write` call: the whole file written.
    Written,
    /// Seen changed (or new) after a shell command.
    Shell,
    /// Seen gone after a shell command.
    Deleted,
}

/// One changed file, as the window lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Change {
    /// Relative to the workspace when inside it, else absolute.
    pub path: String,
    /// Lines put in and taken out, when known.
    pub added: Option<u64>,
    pub removed: Option<u64>,
    pub how: How,
}

const EDIT_TOOLS: [&str; 4] = ["Edit", "MultiEdit", "Write", "NotebookEdit"];

/// Lines in a piece of text, as a diff counts them.
fn lines(s: &str) -> u64 {
    if s.is_empty() {
        0
    } else {
        s.lines().count() as u64
    }
}

/// The aside's edit calls, collected from its stream.
#[derive(Debug, Default)]
pub struct Collector {
    calls: HashMap<String, (String, serde_json::Value)>,
    edits: BTreeMap<String, (u64, u64, How)>,
    shell: bool,
}

impl Collector {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether the aside ran a shell command (the "after" look is wanted).
    pub fn ran_shell(&self) -> bool {
        self.shell
    }

    /// One event of the aside's stream.
    pub fn on_event(&mut self, e: &TurnEvent) {
        match e {
            TurnEvent::ToolCall { id, name, input } => {
                if name == "Bash" {
                    self.shell = true;
                }
                if EDIT_TOOLS.contains(&name.as_str()) {
                    self.calls.insert(id.clone(), (name.clone(), input.clone()));
                }
            }
            TurnEvent::ToolResult {
                tool_use_id,
                is_error,
                ..
            } => {
                let Some((name, input)) = self.calls.remove(tool_use_id) else {
                    return;
                };
                if !*is_error {
                    self.record(&name, &input);
                }
            }
            _ => {}
        }
    }

    fn record(&mut self, name: &str, input: &serde_json::Value) {
        let s = |k: &str| input.get(k).and_then(|v| v.as_str()).unwrap_or("");
        let path = match name {
            "NotebookEdit" => s("notebook_path"),
            _ => s("file_path"),
        };
        if path.is_empty() {
            return;
        }
        let (added, removed, how) = match name {
            "Edit" => (lines(s("new_string")), lines(s("old_string")), How::Edited),
            "MultiEdit" => {
                let mut a = 0;
                let mut r = 0;
                for e in input
                    .get("edits")
                    .and_then(|v| v.as_array())
                    .into_iter()
                    .flatten()
                {
                    let t = |k: &str| e.get(k).and_then(|v| v.as_str()).unwrap_or("");
                    a += lines(t("new_string"));
                    r += lines(t("old_string"));
                }
                (a, r, How::Edited)
            }
            "Write" => (lines(s("content")), 0, How::Written),
            _ => (lines(s("new_source")), 0, How::Edited),
        };
        let entry = self.edits.entry(path.to_string()).or_insert((0, 0, how));
        entry.0 += added;
        entry.1 += removed;
        // A file written whole at any point reads as written.
        if how == How::Written {
            entry.2 = How::Written;
        }
    }

    /// Everything that changed: the edit calls, then what the shell moved
    /// (`before` and `after` both present) that no call names.
    pub fn finish(self, workspace: &Path, shell: Option<(&Snapshot, &Snapshot)>) -> Vec<Change> {
        let mut out: Vec<Change> = Vec::new();
        let mut seen: Vec<PathBuf> = Vec::new();
        for (path, (added, removed, how)) in self.edits {
            let abs = absolute(workspace, &path);
            seen.push(abs.clone());
            out.push(Change {
                path: shown(workspace, &abs),
                added: Some(added),
                removed: if how == How::Written {
                    None
                } else {
                    Some(removed)
                },
                how,
            });
        }
        if let Some((before, after)) = shell {
            for c in before.diff(after) {
                let abs = absolute(workspace, &c.path);
                if seen.contains(&abs) {
                    continue;
                }
                out.push(Change {
                    path: shown(workspace, &abs),
                    ..c
                });
            }
        }
        out
    }
}

fn absolute(workspace: &Path, p: &str) -> PathBuf {
    let p = Path::new(p);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        workspace.join(p)
    }
}

fn shown(workspace: &Path, abs: &Path) -> String {
    abs.strip_prefix(workspace)
        .map(|r| r.display().to_string())
        .unwrap_or_else(|_| abs.display().to_string())
}

/// One file's look: size, mtime (ns) and, in git, its numstat against HEAD.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Look {
    size: u64,
    mtime: u128,
    numstat: Option<(u64, u64)>,
    untracked: bool,
}

/// The workspace at one moment: the files worth comparing, by absolute path.
#[derive(Debug, Clone, Default)]
pub struct Snapshot {
    files: BTreeMap<PathBuf, Look>,
    /// In git, only the dirty files are listed: a file listed before and
    /// not after was committed or reverted, and its mtime tells which.
    git: bool,
}

/// The cap on a walk outside git: past it there is no shell tracking.
const WALK_MAX: usize = 20_000;
const WALK_TIME: Duration = Duration::from_secs(2);
const SKIP_DIRS: [&str; 5] = ["node_modules", "target", "dist", "build", "__pycache__"];

fn stat(p: &Path) -> Option<(u64, u128)> {
    let m = std::fs::metadata(p).ok()?;
    let mtime = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_nanos());
    Some((m.len(), mtime))
}

fn git(ws: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let out = Command::new("git")
        .arg("-C")
        .arg(ws)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .ok()?;
    out.status.success().then_some(out.stdout)
}

impl Snapshot {
    /// A look at `ws`, or `None` when it cannot be taken (a walk past its cap).
    pub fn take(ws: &Path) -> Option<Snapshot> {
        if let Some(top) = git(ws, &["rev-parse", "--show-toplevel"]) {
            let top = PathBuf::from(String::from_utf8_lossy(&top).trim().to_string());
            return Some(Self::take_git(ws, &top));
        }
        Self::take_walk(ws)
    }

    fn take_git(ws: &Path, top: &Path) -> Snapshot {
        // Git names paths from its top, which it gives canonical (on macOS
        // `/private/var/…` for a `/var/…` workspace): a path under the
        // workspace is put back in the workspace's own spelling, so the
        // edit calls' paths and these match.
        let ws_c = ws.canonicalize().unwrap_or_else(|_| ws.to_path_buf());
        let top_c = top.canonicalize().unwrap_or_else(|_| top.to_path_buf());
        let at = |rel: &str| -> PathBuf {
            let abs = top_c.join(rel);
            match abs.strip_prefix(&ws_c) {
                Ok(r) => ws.join(r),
                Err(_) => abs,
            }
        };
        let mut files = BTreeMap::new();
        let status = git(
            ws,
            &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        )
        .unwrap_or_default();
        let mut parts = status.split(|b| *b == 0).filter(|p| !p.is_empty());
        while let Some(rec) = parts.next() {
            if rec.len() < 4 {
                continue;
            }
            let code = &rec[..2];
            let rel = String::from_utf8_lossy(&rec[3..]).to_string();
            // A rename's record is followed by its old path.
            if code[0] == b'R' || code[0] == b'C' {
                parts.next();
            }
            let abs = at(&rel);
            let (size, mtime) = stat(&abs).unwrap_or((0, 0));
            files.insert(
                abs,
                Look {
                    size,
                    mtime,
                    numstat: None,
                    untracked: code == b"??",
                },
            );
        }
        let numstat = git(ws, &["diff", "--numstat", "-z", "HEAD"]).unwrap_or_default();
        for rec in numstat.split(|b| *b == 0).filter(|p| !p.is_empty()) {
            let s = String::from_utf8_lossy(rec);
            let mut f = s.splitn(3, '\t');
            let (Some(a), Some(r), Some(rel)) = (f.next(), f.next(), f.next()) else {
                continue;
            };
            if let (Ok(a), Ok(r)) = (a.parse::<u64>(), r.parse::<u64>())
                && let Some(look) = files.get_mut(&at(rel))
            {
                look.numstat = Some((a, r));
            }
        }
        Snapshot { files, git: true }
    }

    fn take_walk(ws: &Path) -> Option<Snapshot> {
        let started = Instant::now();
        let mut files = BTreeMap::new();
        let mut stack = vec![ws.to_path_buf()];
        while let Some(dir) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&dir) else {
                continue;
            };
            for e in rd.flatten() {
                if files.len() >= WALK_MAX || started.elapsed() > WALK_TIME {
                    return None;
                }
                let name = e.file_name();
                let name = name.to_string_lossy();
                if name.starts_with('.') {
                    continue;
                }
                let Ok(ft) = e.file_type() else { continue };
                if ft.is_dir() {
                    if !SKIP_DIRS.contains(&name.as_ref()) {
                        stack.push(e.path());
                    }
                } else if ft.is_file()
                    && let Some((size, mtime)) = stat(&e.path())
                {
                    files.insert(
                        e.path(),
                        Look {
                            size,
                            mtime,
                            numstat: None,
                            untracked: false,
                        },
                    );
                }
            }
        }
        Some(Snapshot { files, git: false })
    }

    /// What moved between `self` (before) and `after`, paths absolute.
    pub fn diff(&self, after: &Snapshot) -> Vec<Change> {
        let mut out = Vec::new();
        for (p, now) in &after.files {
            let was = self.files.get(p);
            if was.is_some_and(|w| w.size == now.size && w.mtime == now.mtime) {
                continue;
            }
            let (added, removed) = match (was, now.numstat) {
                // Clean before (or not listed): its diff against HEAD is the aside's.
                (None, Some((a, r))) => (Some(a), Some(r)),
                // New since the look before: all its lines are put in.
                (None, None) if now.untracked || !self.git => {
                    let n = std::fs::read_to_string(p).ok().map(|t| lines(&t));
                    (n, n.map(|_| 0))
                }
                _ => (None, None),
            };
            out.push(Change {
                path: p.display().to_string(),
                added,
                removed,
                how: How::Shell,
            });
        }
        for (p, w) in &self.files {
            if after.files.contains_key(p) {
                continue;
            }
            match stat(p) {
                None => out.push(Change {
                    path: p.display().to_string(),
                    added: None,
                    removed: None,
                    how: How::Deleted,
                }),
                // In git: no longer dirty — reverted (mtime moved) or committed.
                Some((size, mtime)) if self.git && (size != w.size || mtime != w.mtime) => out
                    .push(Change {
                        path: p.display().to_string(),
                        added: None,
                        removed: None,
                        how: How::Shell,
                    }),
                Some(_) => {}
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nl-aside-changes-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn call(c: &mut Collector, id: &str, name: &str, input: serde_json::Value, ok: bool) {
        c.on_event(&TurnEvent::ToolCall {
            id: id.into(),
            name: name.into(),
            input,
        });
        c.on_event(&TurnEvent::ToolResult {
            tool_use_id: id.into(),
            name: name.into(),
            content: String::new(),
            is_error: !ok,
        });
    }

    #[test]
    fn edit_calls_are_listed_with_their_lines_and_a_failed_one_is_not() {
        let ws = Path::new("/w");
        let mut c = Collector::new();
        call(
            &mut c,
            "1",
            "Edit",
            json!({"file_path": "/w/src/a.ts", "old_string": "x\ny", "new_string": "x\ny\nz"}),
            true,
        );
        call(
            &mut c,
            "2",
            "Edit",
            json!({"file_path": "/w/src/a.ts", "old_string": "q", "new_string": ""}),
            true,
        );
        call(
            &mut c,
            "3",
            "Write",
            json!({"file_path": "/w/new.md", "content": "a\nb\n"}),
            true,
        );
        call(
            &mut c,
            "4",
            "Edit",
            json!({"file_path": "/w/failed.rs", "old_string": "a", "new_string": "b"}),
            false,
        );
        call(
            &mut c,
            "5",
            "Read",
            json!({"file_path": "/w/read.rs"}),
            true,
        );
        assert!(!c.ran_shell());
        let out = c.finish(ws, None);
        assert_eq!(
            out,
            vec![
                Change {
                    path: "new.md".into(),
                    added: Some(2),
                    removed: None,
                    how: How::Written
                },
                Change {
                    path: "src/a.ts".into(),
                    added: Some(3),
                    removed: Some(3),
                    how: How::Edited
                },
            ]
        );
    }

    #[test]
    fn a_path_outside_the_workspace_stays_absolute_and_multiedit_sums() {
        let mut c = Collector::new();
        call(
            &mut c,
            "1",
            "MultiEdit",
            json!({"file_path": "/elsewhere/n.txt", "edits": [
                {"old_string": "a", "new_string": "b\nc"},
                {"old_string": "d\ne", "new_string": "f"}
            ]}),
            true,
        );
        let out = c.finish(Path::new("/w"), None);
        assert_eq!(out[0].path, "/elsewhere/n.txt");
        assert_eq!((out[0].added, out[0].removed), (Some(3), Some(3)));
    }

    #[test]
    fn a_shell_change_outside_git_is_seen_by_the_walk() {
        let ws = scratch("walk");
        std::fs::write(ws.join("kept.txt"), "same").unwrap();
        std::fs::write(ws.join("gone.txt"), "x").unwrap();
        std::fs::write(ws.join("moved.txt"), "one").unwrap();
        std::fs::create_dir_all(ws.join("node_modules")).unwrap();
        let before = Snapshot::take(&ws).expect("a small folder is walked");
        assert!(!before.git);
        std::fs::remove_file(ws.join("gone.txt")).unwrap();
        std::fs::write(ws.join("moved.txt"), "one\ntwo\nthree").unwrap();
        std::fs::write(ws.join("made.txt"), "a\nb").unwrap();
        std::fs::write(ws.join("node_modules/skip.js"), "x").unwrap();
        let after = Snapshot::take(&ws).unwrap();
        let mut c = Collector::new();
        call(&mut c, "1", "Bash", json!({"command": "…"}), true);
        assert!(c.ran_shell());
        let mut out = c.finish(&ws, Some((&before, &after)));
        out.sort_by(|a, b| a.path.cmp(&b.path));
        let got: Vec<(&str, How, Option<u64>)> = out
            .iter()
            .map(|c| (c.path.as_str(), c.how, c.added))
            .collect();
        assert_eq!(
            got,
            vec![
                ("gone.txt", How::Deleted, None),
                ("made.txt", How::Shell, Some(2)),
                ("moved.txt", How::Shell, None),
            ]
        );
        let _ = std::fs::remove_dir_all(&ws);
    }

    #[test]
    fn a_shell_change_in_git_carries_its_numstat_and_an_edit_wins_its_path() {
        let ws = scratch("git");
        let g = |args: &[&str]| {
            let ok = Command::new("git")
                .arg("-C")
                .arg(&ws)
                .args(args)
                .output()
                .unwrap()
                .status
                .success();
            assert!(ok, "git {args:?}");
        };
        g(&["init", "-q"]);
        g(&["config", "user.email", "t@t"]);
        g(&["config", "user.name", "t"]);
        std::fs::write(ws.join("a.txt"), "1\n2\n3\n").unwrap();
        std::fs::write(ws.join("b.txt"), "x\n").unwrap();
        std::fs::write(ws.join("dirty.txt"), "d\n").unwrap();
        g(&["add", "."]);
        g(&["commit", "-qm", "init"]);
        std::fs::write(ws.join("dirty.txt"), "d\ne\n").unwrap();
        let before = Snapshot::take(&ws).unwrap();
        assert!(before.git);
        // The shell: a.txt +1 −1, b.txt edited by a call too, a new file.
        std::fs::write(ws.join("a.txt"), "1\n2\nthree\n").unwrap();
        std::fs::write(ws.join("b.txt"), "y\n").unwrap();
        std::fs::write(ws.join("new.txt"), "n1\nn2\n").unwrap();
        let after = Snapshot::take(&ws).unwrap();
        let mut c = Collector::new();
        call(&mut c, "1", "Bash", json!({"command": "…"}), true);
        let b = ws.join("b.txt").display().to_string();
        call(
            &mut c,
            "2",
            "Edit",
            json!({"file_path": b, "old_string": "x", "new_string": "y"}),
            true,
        );
        let mut out = c.finish(&ws, Some((&before, &after)));
        out.sort_by(|a, b| a.path.cmp(&b.path));
        let got: Vec<(&str, How, Option<u64>, Option<u64>)> = out
            .iter()
            .map(|c| (c.path.as_str(), c.how, c.added, c.removed))
            .collect();
        assert_eq!(
            got,
            vec![
                ("a.txt", How::Shell, Some(1), Some(1)),
                ("b.txt", How::Edited, Some(1), Some(1)),
                ("new.txt", How::Shell, Some(2), Some(0)),
            ]
        );
        let _ = std::fs::remove_dir_all(&ws);
    }
}
