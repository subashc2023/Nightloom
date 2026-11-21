//! Claude Code's own memory, versioned (nightshift item 751, from item
//! 736's survey §3 item 5).
//!
//! The Claude Code CLI keeps a memory folder per working folder —
//! `~/.claude/projects/<dir>/memory/` (`MEMORY.md` and the notes it
//! indexes) — and writes it on its own, from any session: the terminal,
//! the Claude desktop app, a chat Nightloom runs. Nothing recorded what
//! it changed or when, so a belief that appeared there had no history to
//! show. This module gives it one **without ever writing his files**: each
//! [`sync`] copies every memory folder into a git repository Nightloom owns
//! (`<config>/claude-memory/<dir>/…`), and a copy that differs from the last
//! one becomes a commit. The bell lists those commits as "Claude Code's
//! memory changed", with the diff — the same card a dream's commit gets,
//! minus the Revert: the files are his and the CLI's, and a restore would
//! be a write to them.
//!
//! Read-only on the source is the module's one rule: [`sync`] opens a
//! memory file only to read it, and every write lands under the history
//! folder. A test pins that the source tree is byte-for-byte and
//! mtime-for-mtime what it was.
//!
//! The first sync is a baseline (subject [`BASELINE`]) and is not listed —
//! a card saying fifty files "changed" on the day the feature arrived
//! would be noise. Changes between two syncs fold into one commit; the
//! desktop syncs when the bell refreshes (after a pass, on opening the
//! panel) and on a ten-minute clock, so a commit is "what changed in those
//! minutes", dated when it was seen.

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::centre::ChangedFile;
use crate::project::Registry;

/// The history folder's name under the config dir.
pub const HISTORY_DIR: &str = "claude-memory";
/// The subject of every listed commit.
pub const SUBJECT: &str = "nightloom: claude memory —";
/// The first sync's subject: everything as it was, not a change.
pub const BASELINE: &str = "nightloom: claude memory baseline";
/// A file larger than this is not copied (memory notes are a few KB; a
/// large file there is not a note, and git is not the place for it).
const MAX_FILE: u64 = 1024 * 1024;
/// How deep below a memory folder files are copied.
const MAX_DEPTH: usize = 3;

/// The history repository for `config`.
pub fn history_dir(config: &Path) -> PathBuf {
    config.join(HISTORY_DIR)
}

/// What one sync did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct SyncOutcome {
    /// Memory folders read.
    pub folders: usize,
    /// Files copied in (new or changed) and taken out (gone at the source).
    pub changed: usize,
    pub removed: usize,
    /// The commit made, short hash; `None` when nothing changed.
    pub commit: Option<String>,
}

/// One listed commit: a change to Claude Code's memory, seen by a sync.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MemoryCommit {
    pub hash: String,
    /// When the sync saw it, RFC 3339.
    pub at: String,
    pub subject: String,
    /// Paths are `<dir>/<file>`, `<dir>` the CLI's folder name.
    pub files: Vec<ChangedFile>,
    /// Each distinct `<dir>` in `files`, named for a person: a registered
    /// project whose folder it is, else the folder's last two parts.
    pub places: Vec<String>,
}

/// Copy every `<claude>/projects/*/memory/` into the history folder and
/// commit what changed. `claude` is the CLI's folder (`~/.claude`); passed
/// in so a test never reads the real one.
pub fn sync(config: &Path, claude: &Path) -> Result<SyncOutcome, String> {
    let history = history_dir(config);
    let fresh = !crate::history::is_repo(&history);
    if fresh {
        if crate::history::enclosing_repo(&history).is_some() {
            return Err(format!(
                "{} is inside another repository; Claude Code's memory is not versioned there",
                history.display()
            ));
        }
        crate::history::start(&history)?;
    }
    let mut out = SyncOutcome::default();
    // Every source file, as `<dir>/<relative path>`.
    let mut seen: BTreeSet<PathBuf> = BTreeSet::new();
    let projects = claude.join("projects");
    if let Ok(entries) = fs::read_dir(&projects) {
        let mut dirs: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.join("memory").is_dir())
            .collect();
        dirs.sort();
        for dir in dirs {
            let Some(name) = dir.file_name().map(PathBuf::from) else {
                continue;
            };
            // A folder name that is not a plain segment is never a path
            // under the history folder.
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            out.folders += 1;
            copy_tree(
                &dir.join("memory"),
                &history.join(&name),
                &name,
                0,
                &mut seen,
                &mut out,
            );
        }
    }
    // Files whose source is gone: taken out of the copy (git keeps them).
    let mut copied = Vec::new();
    list_tree(&history, &history, 0, &mut copied);
    for rel in copied {
        if !seen.contains(&rel) {
            let _ = fs::remove_file(history.join(&rel));
            out.removed += 1;
        }
    }
    git(&history, &["add", "-A"])?;
    let staged = Command::new("git")
        .arg("-C")
        .arg(&history)
        .args(["diff", "--cached", "--quiet"])
        .status()
        .map_err(|e| format!("git did not run: {e}"))?;
    if staged.success() {
        return Ok(out);
    }
    let subject = if fresh {
        BASELINE.to_string()
    } else {
        let names: BTreeSet<String> = git(&history, &["diff", "--cached", "--name-only"])?
            .lines()
            .filter_map(|l| l.split('/').next().map(str::to_string))
            .collect();
        let n = git(&history, &["diff", "--cached", "--name-only"])?
            .lines()
            .count();
        format!(
            "{SUBJECT} {n} file{} in {}",
            if n == 1 { "" } else { "s" },
            names.into_iter().collect::<Vec<_>>().join(", ")
        )
    };
    git(&history, &["commit", "-q", "-m", &subject])?;
    out.commit = Some(git(&history, &["rev-parse", "--short", "HEAD"])?);
    Ok(out)
}

/// Copy `src` into `dst` file by file, writing only what differs, and
/// record each relative path (under `prefix`) in `seen`. Reads only.
fn copy_tree(
    src: &Path,
    dst: &Path,
    prefix: &Path,
    depth: usize,
    seen: &mut BTreeSet<PathBuf>,
    out: &mut SyncOutcome,
) {
    if depth > MAX_DEPTH {
        return;
    }
    let Ok(entries) = fs::read_dir(src) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let rel = prefix.join(&name);
        if kind.is_dir() {
            copy_tree(&entry.path(), &dst.join(&name), &rel, depth + 1, seen, out);
            continue;
        }
        // Symlinks are not followed: a link out of the memory folder is not
        // memory, and following one would read anywhere.
        if !kind.is_file() {
            continue;
        }
        if entry.metadata().map(|m| m.len()).unwrap_or(u64::MAX) > MAX_FILE {
            continue;
        }
        let Ok(bytes) = fs::read(entry.path()) else {
            continue;
        };
        seen.insert(rel);
        let target = dst.join(&name);
        if fs::read(&target).ok().as_deref() == Some(bytes.as_slice()) {
            continue;
        }
        if fs::create_dir_all(dst).is_ok() && fs::write(&target, &bytes).is_ok() {
            out.changed += 1;
        }
    }
}

/// Every file under `dir` (the history folder), relative to `root`,
/// skipping `.git`.
fn list_tree(root: &Path, dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > MAX_DEPTH + 1 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_name() == ".git" {
            continue;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if kind.is_dir() {
            list_tree(root, &path, depth + 1, out);
        } else if let Ok(rel) = path.strip_prefix(root) {
            out.push(rel.to_path_buf());
        }
    }
}

fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let identity = [
        "-c",
        "user.name=Nightloom",
        "-c",
        "user.email=nightloom@localhost",
    ];
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        // The history folder is Nightloom's own; its commits are always
        // signed "Nightloom", never with his identity, and never through
        // his hooks or signing setup.
        .args(identity)
        .args([
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
        ])
        .args(args)
        .output()
        .map_err(|e| format!("git did not run: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            format!("git {} failed", args.join(" "))
        } else {
            err
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The newest `limit` change commits (the baseline and the first commit
/// are not changes), newest first.
pub fn commits(config: &Path, limit: usize) -> Vec<MemoryCommit> {
    let history = history_dir(config);
    if !crate::history::is_repo(&history) {
        return Vec::new();
    }
    let n = limit.to_string();
    let Ok(log) = git(
        &history,
        &[
            "log",
            "-n",
            &n,
            "--fixed-strings",
            "--grep",
            SUBJECT,
            "--format=%H%x1f%aI%x1f%s",
        ],
    ) else {
        return Vec::new();
    };
    let registry = Registry::load_in(config);
    log.lines()
        .filter_map(|line| {
            let mut parts = line.split('\x1f');
            let hash = parts.next()?.trim().to_string();
            let at = parts.next()?.trim().to_string();
            let subject = parts.next()?.trim().to_string();
            if !subject.starts_with(SUBJECT) {
                return None;
            }
            let files = numstat(&history, &hash);
            let mut places: Vec<String> = Vec::new();
            for f in &files {
                if let Some(dir) = f.path.split('/').next() {
                    let place = place_name(&registry, dir);
                    if !places.contains(&place) {
                        places.push(place);
                    }
                }
            }
            Some(MemoryCommit {
                hash,
                at,
                subject,
                files,
                places,
            })
        })
        .collect()
}

fn numstat(repo: &Path, hash: &str) -> Vec<ChangedFile> {
    let Ok(out) = git(repo, &["show", "--numstat", "--format=", hash]) else {
        return Vec::new();
    };
    out.lines()
        .filter_map(|l| {
            let mut parts = l.splitn(3, '\t');
            let added = parts.next()?.trim().parse().unwrap_or(0);
            let removed = parts.next()?.trim().parse().unwrap_or(0);
            let path = parts.next()?.trim().to_string();
            (!path.is_empty()).then_some(ChangedFile {
                path,
                added,
                removed,
            })
        })
        .collect()
}

/// The CLI names a folder by its path with every `/` and `.` made `-`
/// (`/Users/me/code/app` → `-Users-me-code-app`). A registered project
/// whose workspace encodes to `dir` is named by its name; anything else by
/// the folder's last two parts as encoded.
pub fn place_name(registry: &Registry, dir: &str) -> String {
    for p in registry.projects() {
        if let Some(w) = p.workspace.as_deref()
            && encode(w) == dir
        {
            return p.name.clone();
        }
    }
    let parts: Vec<&str> = dir.split('-').filter(|s| !s.is_empty()).collect();
    match parts.len() {
        0 => dir.to_string(),
        1 => parts[0].to_string(),
        n => format!("{}-{}", parts[n - 2], parts[n - 1]),
    }
}

/// A path as the CLI names its folder under `~/.claude/projects`.
pub fn encode(path: &Path) -> String {
    path.to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// One commit's patch, whole or for one file. The repository is fixed —
/// never a path from the window.
pub fn diff(config: &Path, hash: &str, file: Option<&str>) -> Result<String, String> {
    // Every CLI folder name starts with `-`, which the shared check refuses
    // as an option; `./` makes it a path and changes nothing else.
    let file = file.map(|f| {
        if f.starts_with('-') {
            format!("./{f}")
        } else {
            f.to_string()
        }
    });
    crate::centre::dream_diff(&history_dir(config), hash, file.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "nl-claude-memory-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// Every file under `dir` with its bytes and mtime.
    fn snapshot(dir: &Path) -> Vec<(PathBuf, Vec<u8>, SystemTime)> {
        let mut files = Vec::new();
        list_tree(dir, dir, 0, &mut files);
        files.sort();
        files
            .into_iter()
            .map(|rel| {
                let p = dir.join(&rel);
                let m = fs::metadata(&p).unwrap().modified().unwrap();
                (rel, fs::read(&p).unwrap(), m)
            })
            .collect()
    }

    /// The baseline is not a card; an edit, a new note and a removed note
    /// are one card with the diff; the source is never written.
    #[test]
    fn a_change_to_claude_memory_is_a_commit_with_a_diff_and_the_source_is_untouched() {
        let root = scratch("change");
        let config = root.join("config");
        let claude = root.join("claude");
        let mem = claude
            .join("projects")
            .join("-Users-me-code-app")
            .join("memory");
        fs::create_dir_all(&mem).unwrap();
        fs::write(mem.join("MEMORY.md"), "- [Stack](stack.md) — tokio\n").unwrap();
        fs::write(mem.join("stack.md"), "We use tokio.\n").unwrap();
        fs::write(mem.join("old.md"), "Gone soon.\n").unwrap();
        // A session log beside the memory folder is not memory.
        fs::write(
            claude
                .join("projects")
                .join("-Users-me-code-app")
                .join("s.jsonl"),
            "{}\n",
        )
        .unwrap();

        let first = sync(&config, &claude).unwrap();
        assert_eq!(first.folders, 1);
        assert!(first.commit.is_some(), "the baseline is committed");
        assert!(
            commits(&config, 10).is_empty(),
            "the baseline is not a card"
        );

        let again = sync(&config, &claude).unwrap();
        assert_eq!(again.commit, None, "nothing changed, nothing committed");

        fs::write(mem.join("stack.md"), "We use tokio and axum.\n").unwrap();
        fs::write(mem.join("new.md"), "A new belief.\n").unwrap();
        fs::remove_file(mem.join("old.md")).unwrap();
        let before = snapshot(&claude);
        let changed = sync(&config, &claude).unwrap();
        assert_eq!(
            snapshot(&claude),
            before,
            "the source tree is never written"
        );
        assert_eq!((changed.changed, changed.removed), (2, 1));

        let listed = commits(&config, 10);
        assert_eq!(listed.len(), 1);
        let c = &listed[0];
        assert!(c.subject.starts_with(SUBJECT), "{}", c.subject);
        let mut paths: Vec<&str> = c.files.iter().map(|f| f.path.as_str()).collect();
        paths.sort();
        assert_eq!(
            paths,
            [
                "-Users-me-code-app/new.md",
                "-Users-me-code-app/old.md",
                "-Users-me-code-app/stack.md"
            ]
        );
        assert_eq!(c.places, ["code-app"]);
        let d = diff(&config, &c.hash, Some("-Users-me-code-app/stack.md")).unwrap();
        assert!(d.contains("-We use tokio."), "{d}");
        assert!(d.contains("+We use tokio and axum."), "{d}");
        assert!(
            !history_dir(&config)
                .join("-Users-me-code-app/s.jsonl")
                .exists()
        );
    }

    /// A folder made after the baseline is a change like any other.
    #[test]
    fn a_new_memory_folder_after_the_baseline_is_listed() {
        let root = scratch("newdir");
        let config = root.join("config");
        let claude = root.join("claude");
        fs::create_dir_all(claude.join("projects")).unwrap();
        sync(&config, &claude).unwrap();
        let mem = claude.join("projects").join("-tmp-x").join("memory");
        fs::create_dir_all(&mem).unwrap();
        fs::write(mem.join("MEMORY.md"), "- one\n").unwrap();
        sync(&config, &claude).unwrap();
        let listed = commits(&config, 10);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].files[0].path, "-tmp-x/MEMORY.md");
        assert_eq!(listed[0].files[0].added, 1);
    }

    #[test]
    fn a_registered_workspace_is_named_by_its_project() {
        assert_eq!(
            encode(Path::new("/Users/me/Nightloom/nightshift-code")),
            "-Users-me-Nightloom-nightshift-code"
        );
        let r = Registry::load_in(&scratch("reg"));
        assert_eq!(
            place_name(&r, "-Users-me-Nightloom-nightshift-code"),
            "nightshift-code"
        );
    }
}
