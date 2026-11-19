//! A hidden git snapshot of the chat's folder at each turn's start and end,
//! so Rewind can put the files back too (nightshift item 765; the 762
//! survey's draft 2, after T3 Code's "restore files too / keep files").
//!
//! A snapshot is a commit of the whole work tree as it is on disk — tracked
//! files with their edits, and untracked ones the repository does not
//! ignore — built in a throwaway index, so his index, HEAD, branches and
//! stash are never touched. It is kept under
//! `refs/nightloom/turns/<chat>/<log index>/{start,end}`: not a branch, not
//! a tag, not in `git log` or `git branch` (only `--all` lists it). The
//! log index is the turn's user message's, which a rewind names.
//!
//! Guards: the whole snapshot has [`BUDGET`] (5 s) or it is dropped and the
//! turn goes on (T3 Code's most-voted bug was a 30 s hang here); a file
//! over [`BIG`] is left out (its blob would sit in his `.git` once per
//! turn) and named in the commit's message; a folder that is not in a git
//! repository has no snapshot, and Rewind says so.
//!
//! Restoring ([`plan`], [`checkout`]) touches only what the rewound turns
//! changed, and of that only what is still as the last of them left it:
//! a file he or another chat changed since is left alone and listed.

use std::collections::BTreeSet;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

/// The most a turn's snapshot may take before it is dropped.
pub const BUDGET: Duration = Duration::from_secs(5);
/// A file larger than this is not snapshotted.
pub const BIG: u64 = 50 * 1024 * 1024;
const REFS: &str = "refs/nightloom/turns";

/// Which end of a turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edge {
    Start,
    End,
}

impl Edge {
    fn name(self) -> &'static str {
        match self {
            Edge::Start => "start",
            Edge::End => "end",
        }
    }
}

/// Why a snapshot was not taken.
#[derive(Debug, PartialEq, Eq)]
pub enum Skip {
    /// Not inside a git repository (or git is not installed).
    NotGit,
    /// Over [`BUDGET`].
    Slow,
    /// git refused; its words.
    Failed(String),
}

/// The repository's top folder holding `dir`, if it is in one.
pub fn repo_root(dir: &Path) -> Option<PathBuf> {
    let out = git(
        dir,
        &["rev-parse", "--show-toplevel"],
        &[],
        None,
        deadline(BUDGET),
    )
    .ok()?;
    let top = out.trim();
    (!top.is_empty()).then(|| PathBuf::from(top))
}

fn deadline(d: Duration) -> Instant {
    Instant::now() + d
}

/// Run git in `dir`, killed at `until`. Its stdout, or why it failed.
fn git(
    dir: &Path,
    args: &[&str],
    env: &[(&str, &Path)],
    stdin: Option<&[u8]>,
    until: Instant,
) -> Result<String, Skip> {
    let mut cmd = Command::new("git");
    // A throwaway index copied from a split one would write a new
    // `sharedindex.*` into his `.git` (and may expire old ones): never.
    cmd.arg("-C")
        .arg(dir)
        .args(["-c", "core.splitIndex=false"])
        .args(args);
    // Never a prompt, a pager, an editor or a lock on his index.
    cmd.env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_AUTHOR_NAME", "Nightloom")
        .env("GIT_AUTHOR_EMAIL", "nightloom@localhost")
        .env("GIT_COMMITTER_NAME", "Nightloom")
        .env("GIT_COMMITTER_EMAIL", "nightloom@localhost");
    for (k, v) in env {
        cmd.env(k, v);
    }
    cmd.stdin(if stdin.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|_| Skip::NotGit)?;
    let mut out_pipe = child.stdout.take().expect("piped");
    let mut err_pipe = child.stderr.take().expect("piped");
    // The pipes are read on threads that report by channel, so the
    // deadline also covers a helper git started (a filter, a hook, a
    // daemon) that keeps them open after git itself has exited.
    let (tx, rx) = std::sync::mpsc::channel::<(bool, Vec<u8>)>();
    let tx_err = tx.clone();
    std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = out_pipe.read_to_end(&mut b);
        let _ = tx.send((true, b));
    });
    std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = err_pipe.read_to_end(&mut b);
        let _ = tx_err.send((false, b));
    });
    if let (Some(bytes), Some(mut pipe)) = (stdin, child.stdin.take()) {
        let bytes = bytes.to_vec();
        std::thread::spawn(move || {
            let _ = pipe.write_all(&bytes);
        });
    }
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if Instant::now() >= until => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(Skip::Slow);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(e) => return Err(Skip::Failed(e.to_string())),
        }
    };
    let (mut out, mut err) = (None, None);
    while out.is_none() || err.is_none() {
        // A little grace past the deadline for pipes already at their end.
        let left = until
            .saturating_duration_since(Instant::now())
            .max(Duration::from_millis(100));
        match rx.recv_timeout(left) {
            Ok((true, b)) => out = Some(b),
            Ok((false, b)) => err = Some(b),
            Err(_) => return Err(Skip::Slow),
        }
    }
    let (out, err) = (out.unwrap_or_default(), err.unwrap_or_default());
    if status.success() {
        Ok(String::from_utf8_lossy(&out).into_owned())
    } else {
        let words = String::from_utf8_lossy(&err).trim().to_string();
        if words.contains("not a git repository") {
            Err(Skip::NotGit)
        } else {
            Err(Skip::Failed(words))
        }
    }
}

/// A commit of the work tree at `root` as it is now, in a throwaway index.
/// Returns the commit's id. Files over [`BIG`] keep whatever the index had
/// (the old version, or nothing) and are named in the message.
pub fn snapshot_commit(root: &Path, until: Instant) -> Result<String, Skip> {
    let tmp = tempfile_dir()?;
    let index = tmp.join("index");
    // His index, copied: its stat cache spares hashing unchanged files.
    if let Ok(real) = git(
        root,
        &["rev-parse", "--git-path", "index"],
        &[],
        None,
        until,
    ) {
        let real = root.join(real.trim());
        let _ = std::fs::copy(&real, &index);
    }
    let env: [(&str, &Path); 1] = [("GIT_INDEX_FILE", &index)];
    let list = git(
        root,
        &["ls-files", "-z", "-m", "-d", "-o", "--exclude-standard"],
        &env,
        None,
        until,
    );
    let list = match list {
        Ok(l) => l,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(e);
        }
    };
    let mut keep = Vec::new();
    let mut big = Vec::new();
    for p in list.split('\0').filter(|p| !p.is_empty()) {
        // A nested repository is listed as a folder: not ours to copy.
        if p.ends_with('/') {
            continue;
        }
        match std::fs::symlink_metadata(root.join(p)) {
            Ok(m) if m.is_file() && m.len() > BIG => big.push(p.to_string()),
            _ => keep.push(p.to_string()),
        }
    }
    let result = (|| {
        if !keep.is_empty() {
            let mut input = keep.join("\0");
            input.push('\0');
            git(
                root,
                &["update-index", "-z", "--add", "--remove", "--stdin"],
                &env,
                Some(input.as_bytes()),
                until,
            )?;
        }
        let tree = git(root, &["write-tree"], &env, None, until)?;
        let mut msg = String::from("Nightloom turn snapshot (item 765)\n");
        if !big.is_empty() {
            msg.push_str("\nNot copied, over 50 MB:\n");
            for b in &big {
                msg.push_str(&format!("big: {b}\n"));
            }
        }
        let commit = git(
            root,
            &["commit-tree", tree.trim(), "-m", &msg],
            &[],
            None,
            until,
        )?;
        Ok(commit.trim().to_string())
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

fn tempfile_dir() -> Result<PathBuf, Skip> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "nightloom-snap-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).map_err(|e| Skip::Failed(e.to_string()))?;
    Ok(dir)
}

fn ref_name(chat: &str, index: usize, edge: Edge) -> String {
    let chat: String = chat
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    format!("{REFS}/{chat}/{index}/{}", edge.name())
}

/// Snapshot `workspace` for `chat`'s turn whose message is at log `index`,
/// within [`BUDGET`].
pub fn snapshot_turn(workspace: &Path, chat: &str, index: usize, edge: Edge) -> Result<(), Skip> {
    let until = deadline(BUDGET);
    let root = repo_root(workspace).ok_or(Skip::NotGit)?;
    let commit = snapshot_commit(&root, until)?;
    git(
        &root,
        &["update-ref", &ref_name(chat, index, edge), &commit],
        &[],
        None,
        until,
    )?;
    Ok(())
}

/// One file the rewound turns changed.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Changed {
    /// Relative to the repository's top folder.
    pub path: String,
    /// `added`, `modified` or `deleted` by the turns.
    pub how: &'static str,
    /// Changed again after the last rewound turn ended (by him, another
    /// chat, or a turn whose end was not saved): left alone by a restore.
    pub since: bool,
}

/// What a restore of the rewound turns' files would do.
#[derive(Clone, Debug, Serialize, Default)]
pub struct Plan {
    /// The chat's folder is in a git repository.
    pub git: bool,
    /// The repository's top folder.
    pub root: Option<String>,
    /// The snapshot before the first rewound turn, and after the last
    /// one that saved its end. `None` when either is missing.
    pub start: Option<String>,
    pub end: Option<String>,
    /// The snapshot of the folder now, taken by the plan: a restore's
    /// changes can be undone back to it.
    pub now: Option<String>,
    pub files: Vec<Changed>,
    /// Why there is nothing to restore, in a sentence, when there is not.
    pub note: Option<String>,
}

fn rev(root: &Path, name: &str, until: Instant) -> Option<String> {
    git(
        root,
        &["rev-parse", "--verify", "--quiet", name],
        &[],
        None,
        until,
    )
    .ok()
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
}

/// The turns' indices with a saved `edge`, for `chat`.
fn saved(root: &Path, chat: &str, edge: Edge, until: Instant) -> Vec<usize> {
    let prefix = ref_name(chat, 0, edge);
    let prefix = prefix
        .trim_end_matches(&format!("0/{}", edge.name()))
        .to_string();
    let out = git(
        root,
        &["for-each-ref", "--format=%(refname)", &prefix],
        &[],
        None,
        until,
    )
    .unwrap_or_default();
    let mut v: Vec<usize> = out
        .lines()
        .filter_map(|l| l.strip_prefix(&prefix))
        .filter_map(|rest| rest.strip_suffix(&format!("/{}", edge.name())))
        .filter_map(|n| n.parse().ok())
        .collect();
    v.sort_unstable();
    v
}

fn diff(root: &Path, a: &str, b: &str, until: Instant) -> Result<Vec<(char, String)>, Skip> {
    let out = git(
        root,
        &[
            "diff-tree",
            "-r",
            "-z",
            "--no-renames",
            "--name-status",
            a,
            b,
        ],
        &[],
        None,
        until,
    )?;
    let mut parts = out.split('\0').filter(|s| !s.is_empty());
    let mut v = Vec::new();
    while let (Some(st), Some(p)) = (parts.next(), parts.next()) {
        v.push((st.chars().next().unwrap_or('M'), p.to_string()));
    }
    Ok(v)
}

/// What rewinding `chat` to the turn whose message is at log `first`
/// would restore. `first` is the first rewound user message.
pub fn plan(workspace: &Path, chat: &str, first: usize) -> Plan {
    let until = deadline(Duration::from_secs(30));
    let Some(root) = repo_root(workspace) else {
        return Plan {
            note: Some(
                "This folder is not in a git repository, so its files cannot be restored.".into(),
            ),
            ..Plan::default()
        };
    };
    let mut p = Plan {
        git: true,
        root: Some(root.to_string_lossy().into_owned()),
        ..Plan::default()
    };
    let start = rev(&root, &ref_name(chat, first, Edge::Start), until);
    let end = saved(&root, chat, Edge::End, until)
        .into_iter()
        .rfind(|&i| i >= first)
        .and_then(|i| rev(&root, &ref_name(chat, i, Edge::End), until));
    let (Some(start), Some(end)) = (start, end) else {
        p.note = Some(
            "No file snapshot for this turn (it ran before snapshots, or its snapshot was skipped), so its files cannot be restored."
                .into(),
        );
        return p;
    };
    let now = match snapshot_commit(&root, until) {
        Ok(c) => c,
        Err(e) => {
            p.note = Some(format!("Could not read the folder as it is now: {e:?}"));
            return p;
        }
    };
    let changed = match diff(&root, &start, &end, until) {
        Ok(c) => c,
        Err(e) => {
            p.note = Some(format!("Could not compare the snapshots: {e:?}"));
            return p;
        }
    };
    let since: BTreeSet<String> = diff(&root, &end, &now, until)
        .unwrap_or_default()
        .into_iter()
        .map(|(_, p)| p)
        .collect();
    p.files = changed
        .into_iter()
        .map(|(st, path)| Changed {
            since: since.contains(&path),
            how: match st {
                'A' => "added",
                'D' => "deleted",
                _ => "modified",
            },
            path,
        })
        .collect();
    if p.files.is_empty() {
        p.note = Some("The rewound turns changed no files.".into());
    }
    p.start = Some(start);
    p.end = Some(end);
    p.now = Some(now);
    p
}

/// Write `paths` (relative to `root`) as they are in commit `from`, without
/// touching his index or HEAD. Returns the paths that could not be written,
/// with git's words.
pub fn checkout(root: &Path, from: &str, paths: &[String]) -> Vec<(String, String)> {
    let until = deadline(Duration::from_secs(60));
    let Ok(tmp) = tempfile_dir() else {
        return paths
            .iter()
            .map(|p| (p.clone(), "no temporary folder".into()))
            .collect();
    };
    let index = tmp.join("index");
    let env: [(&str, &Path); 1] = [("GIT_INDEX_FILE", &index)];
    let mut failed = Vec::new();
    match git(root, &["read-tree", from], &env, None, until) {
        Err(e) => failed.extend(paths.iter().map(|p| (p.clone(), format!("{e:?}")))),
        Ok(_) => {
            for p in paths {
                let out = git(
                    root,
                    &["checkout-index", "-f", "-q", "--", p],
                    &env,
                    None,
                    until,
                );
                if let Err(e) = out {
                    failed.push((
                        p.clone(),
                        match e {
                            Skip::Failed(w) => w,
                            other => format!("{other:?}"),
                        },
                    ));
                }
            }
        }
    }
    let _ = std::fs::remove_dir_all(&tmp);
    failed
}

/// The files that differ now from commit `guard`, or `None` when the
/// folder could not be read. A restore leaves these alone.
pub fn changed_since(root: &Path, guard: &str) -> Option<BTreeSet<String>> {
    let until = deadline(Duration::from_secs(30));
    let now = snapshot_commit(root, until).ok()?;
    Some(
        diff(root, guard, &now, until)
            .ok()?
            .into_iter()
            .map(|(_, p)| p)
            .collect(),
    )
}

/// Which of `paths` commit `from` holds (the rest it does not have: a
/// restore to it moves them aside rather than writing them).
pub fn present_in(root: &Path, from: &str, paths: &[String]) -> BTreeSet<String> {
    if paths.is_empty() {
        return BTreeSet::new();
    }
    let mut args = vec![
        "ls-tree",
        "-r",
        "-z",
        "--name-only",
        "--full-tree",
        from,
        "--",
    ];
    args.extend(paths.iter().map(String::as_str));
    git(root, &args, &[], None, deadline(Duration::from_secs(30)))
        .unwrap_or_default()
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect()
}

/// A fresh snapshot of `root` now, for a restore's undo.
pub fn now(root: &Path) -> Option<String> {
    snapshot_commit(root, deadline(Duration::from_secs(30))).ok()
}

/// The folders whose snapshot ran over [`BUDGET`] this run: not
/// snapshotted again until Nightloom restarts (a folder slow once is slow
/// every turn), and said once.
static SLOW: std::sync::Mutex<BTreeSet<PathBuf>> = std::sync::Mutex::new(BTreeSet::new());

fn slow() -> std::sync::MutexGuard<'static, BTreeSet<PathBuf>> {
    SLOW.lock().unwrap_or_else(|p| p.into_inner())
}

/// How long a turn's snapshots are kept. A rewind further back has no
/// file restore; the snapshots' objects become his `git gc`'s to drop.
pub const KEEP: Duration = Duration::from_secs(14 * 24 * 60 * 60);

/// Drop the repository's turn snapshots (every chat's) older than `keep`.
/// How many it dropped.
pub fn prune(root: &Path, keep: Duration) -> usize {
    let until = deadline(Duration::from_secs(600));
    let cutoff = std::time::SystemTime::now()
        .checked_sub(keep)
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs());
    let list = git(
        root,
        &[
            "for-each-ref",
            "--format=%(refname) %(committerdate:unix)",
            REFS,
        ],
        &[],
        None,
        until,
    )
    .unwrap_or_default();
    let old: Vec<&str> = list
        .lines()
        .filter_map(|l| l.rsplit_once(' '))
        .filter(|(_, t)| t.parse::<u64>().is_ok_and(|t| t < cutoff))
        .map(|(r, _)| r)
        .collect();
    if old.is_empty() {
        return 0;
    }
    let input: String = old.iter().map(|r| format!("delete {r}\n")).collect();
    git(
        root,
        &["update-ref", "--stdin"],
        &[],
        Some(input.as_bytes()),
        until,
    )
    .map_or(0, |_| old.len())
}

/// The folders pruned this run, and when: at most once a day each.
static PRUNED: std::sync::Mutex<std::collections::BTreeMap<PathBuf, Instant>> =
    std::sync::Mutex::new(std::collections::BTreeMap::new());

fn prune_due(workspace: &Path) -> bool {
    let mut m = PRUNED.lock().unwrap_or_else(|p| p.into_inner());
    let due = m
        .get(workspace)
        .is_none_or(|t| t.elapsed() > Duration::from_secs(24 * 60 * 60));
    if due {
        m.insert(workspace.to_path_buf(), Instant::now());
    }
    due
}

/// Snapshot a turn's edge off the async runtime. `Some(sentence)` when the
/// turn should be told it was skipped (once per slow folder per run).
pub async fn snapshot_edge(
    workspace: PathBuf,
    chat: String,
    index: usize,
    edge: Edge,
) -> Option<String> {
    if slow().contains(&workspace) {
        return None;
    }
    let ws = workspace.clone();
    let r = tokio::task::spawn_blocking(move || snapshot_turn(&ws, &chat, index, edge))
        .await
        .ok()?;
    if r.is_ok() && edge == Edge::Start && prune_due(&workspace) {
        // Off the turn's path, and never killed: a ref deletion cut short
        // could leave a lock on his refs.
        std::thread::spawn(move || {
            if let Some(root) = repo_root(&workspace) {
                prune(&root, KEEP);
            }
        });
        return None;
    }
    match r {
        Err(Skip::Slow) => {
            slow().insert(workspace);
            Some(
                "File snapshots are off for this folder until Nightloom restarts: one took over 5 s, so Rewind cannot restore this turn's files."
                    .into(),
            )
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sh(dir: &Path, args: &[&str]) {
        let ok = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .unwrap();
        assert!(
            ok.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&ok.stderr)
        );
    }

    fn out(dir: &Path, args: &[&str]) -> String {
        let o = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        String::from_utf8_lossy(&o.stdout).into_owned()
    }

    fn repo(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nightloom-765-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        sh(&d, &["init", "-q"]);
        std::fs::write(d.join("kept.txt"), "v1\n").unwrap();
        std::fs::write(d.join("gone.txt"), "here\n").unwrap();
        std::fs::write(d.join(".gitignore"), "ignored/\n").unwrap();
        sh(&d, &["add", "kept.txt", "gone.txt", ".gitignore"]);
        sh(&d, &["commit", "-q", "-m", "base"]);
        d
    }

    #[test]
    fn a_rewind_restores_what_the_turns_changed_and_leaves_his_repo_alone() {
        let d = repo("restore");
        // His own uncommitted edit, before the turn: kept through it all.
        std::fs::write(d.join("dirty.txt"), "his\n").unwrap();
        let head = out(&d, &["rev-parse", "HEAD"]);
        snapshot_turn(&d, "chat-1", 4, Edge::Start).unwrap();
        // The turn: edits one, deletes one, makes one, writes an ignored one.
        std::fs::write(d.join("kept.txt"), "v2\n").unwrap();
        std::fs::remove_file(d.join("gone.txt")).unwrap();
        std::fs::write(d.join("new.txt"), "made\n").unwrap();
        std::fs::create_dir_all(d.join("ignored")).unwrap();
        std::fs::write(d.join("ignored/x"), "build\n").unwrap();
        snapshot_turn(&d, "chat-1", 4, Edge::End).unwrap();
        // After the turn he edits the new file himself.
        std::fs::write(d.join("new.txt"), "his now\n").unwrap();

        let p = plan(&d, "chat-1", 4);
        assert!(p.git && p.note.is_none(), "{p:?}");
        let got: Vec<_> = p
            .files
            .iter()
            .map(|c| (c.path.as_str(), c.how, c.since))
            .collect();
        assert_eq!(
            got,
            [
                ("gone.txt", "deleted", false),
                ("kept.txt", "modified", false),
                ("new.txt", "added", true)
            ]
        );
        let root = PathBuf::from(p.root.unwrap());
        let failed = checkout(
            &root,
            p.start.as_deref().unwrap(),
            &["kept.txt".into(), "gone.txt".into()],
        );
        assert!(failed.is_empty(), "{failed:?}");
        assert_eq!(std::fs::read_to_string(d.join("kept.txt")).unwrap(), "v1\n");
        assert_eq!(
            std::fs::read_to_string(d.join("gone.txt")).unwrap(),
            "here\n"
        );
        assert_eq!(
            std::fs::read_to_string(d.join("new.txt")).unwrap(),
            "his now\n"
        );
        assert_eq!(
            std::fs::read_to_string(d.join("dirty.txt")).unwrap(),
            "his\n"
        );
        // HEAD, his index and branches untouched; the refs are hidden.
        assert_eq!(out(&d, &["rev-parse", "HEAD"]), head);
        assert_eq!(
            out(&d, &["status", "--porcelain"]),
            "?? dirty.txt\n?? new.txt\n"
        );
        assert_eq!(
            out(&d, &["branch", "--format=%(refname)"]).lines().count(),
            1
        );
        assert!(!out(&d, &["log", "--oneline"]).contains("Nightloom"));
        assert!(out(&d, &["stash", "list"]).is_empty());
        // The restore can be undone back to the plan's "now".
        let failed = checkout(&root, p.now.as_deref().unwrap(), &["kept.txt".into()]);
        assert!(failed.is_empty());
        assert_eq!(std::fs::read_to_string(d.join("kept.txt")).unwrap(), "v2\n");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn no_git_and_no_snapshot_each_say_so() {
        let d = std::env::temp_dir().join(format!("nightloom-765-plain-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        // The temp folder may sit inside a repository on some machines.
        if repo_root(&d).is_none() {
            assert_eq!(snapshot_turn(&d, "c", 0, Edge::Start), Err(Skip::NotGit));
            let p = plan(&d, "c", 0);
            assert!(!p.git && p.note.unwrap().contains("not in a git repository"));
        }
        let r = repo("none");
        let p = plan(&r, "c", 3);
        assert!(p.git && p.files.is_empty());
        assert!(p.note.unwrap().contains("No file snapshot"));
        let _ = std::fs::remove_dir_all(&r);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_big_file_is_left_out_and_named() {
        let d = repo("big");
        let f = std::fs::File::create(d.join("huge.bin")).unwrap();
        f.set_len(BIG + 1).unwrap();
        let c = snapshot_commit(&d, deadline(BUDGET)).unwrap();
        let msg = out(&d, &["log", "-1", "--format=%B", &c]);
        assert!(msg.contains("big: huge.bin"), "{msg}");
        let tree = out(&d, &["ls-tree", "-r", "--name-only", &c]);
        assert!(!tree.contains("huge.bin"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_split_index_gets_no_new_shared_index_from_a_snapshot() {
        let d = repo("split");
        sh(&d, &["config", "core.splitIndex", "true"]);
        sh(&d, &["update-index", "--split-index"]);
        let shared = || {
            std::fs::read_dir(d.join(".git"))
                .unwrap()
                .filter_map(|e| e.ok())
                .filter(|e| e.file_name().to_string_lossy().starts_with("sharedindex."))
                .count()
        };
        let before = shared();
        assert!(before >= 1);
        std::fs::write(d.join("kept.txt"), "v2\n").unwrap();
        std::fs::write(d.join("new.txt"), "new\n").unwrap();
        snapshot_turn(&d, "c", 1, Edge::Start).unwrap();
        assert_eq!(shared(), before);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_helper_holding_gits_pipes_open_cannot_outlast_the_deadline() {
        let d = repo("hold");
        let t = Instant::now();
        let r = git(
            &d,
            &["-c", "alias.hold=!sleep 4 & true", "hold"],
            &[],
            None,
            t + Duration::from_millis(500),
        );
        assert_eq!(r, Err(Skip::Slow));
        assert!(t.elapsed() < Duration::from_secs(2), "{:?}", t.elapsed());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn snapshots_older_than_two_weeks_are_pruned() {
        let d = repo("prune");
        snapshot_turn(&d, "c", 2, Edge::Start).unwrap();
        // One from two months ago, as its commit date says.
        let tree = out(&d, &["write-tree"]);
        let o = Command::new("git")
            .arg("-C")
            .arg(&d)
            .args(["commit-tree", tree.trim(), "-m", "old"])
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .env("GIT_COMMITTER_DATE", "@1000000000 +0000")
            .output()
            .unwrap();
        let old = String::from_utf8_lossy(&o.stdout).trim().to_string();
        sh(&d, &["update-ref", &ref_name("other", 1, Edge::End), &old]);
        assert_eq!(prune(&d, KEEP), 1);
        let refs = out(&d, &["for-each-ref", "--format=%(refname)", REFS]);
        assert_eq!(refs.trim(), ref_name("c", 2, Edge::Start));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_merge_in_progress_is_snapshotted_and_left_unmerged() {
        let d = repo("merge");
        sh(&d, &["checkout", "-q", "-b", "side"]);
        std::fs::write(d.join("kept.txt"), "side\n").unwrap();
        sh(&d, &["commit", "-q", "-am", "side"]);
        sh(&d, &["checkout", "-q", "-"]);
        std::fs::write(d.join("kept.txt"), "main\n").unwrap();
        sh(&d, &["commit", "-q", "-am", "main"]);
        // The merge stops on a conflict; his index holds it unmerged.
        let _ = Command::new("git")
            .arg("-C")
            .arg(&d)
            .args(["merge", "-q", "side"])
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .unwrap();
        let status = out(&d, &["status", "--porcelain"]);
        assert_eq!(status, "UU kept.txt\n");
        let index = std::fs::read(d.join(".git/index")).unwrap();
        snapshot_turn(&d, "c", 1, Edge::Start).unwrap();
        assert_eq!(std::fs::read(d.join(".git/index")).unwrap(), index);
        assert_eq!(out(&d, &["status", "--porcelain"]), status);
        assert!(d.join(".git/MERGE_HEAD").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_snapshot_past_its_deadline_is_dropped() {
        let d = repo("slow");
        assert_eq!(snapshot_commit(&d, Instant::now()), Err(Skip::Slow));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_end_is_the_last_saved_turn_at_or_after_the_rewind() {
        let d = repo("two");
        snapshot_turn(&d, "c", 2, Edge::Start).unwrap();
        std::fs::write(d.join("kept.txt"), "t1\n").unwrap();
        snapshot_turn(&d, "c", 2, Edge::End).unwrap();
        snapshot_turn(&d, "c", 10, Edge::Start).unwrap();
        std::fs::write(d.join("kept.txt"), "t2\n").unwrap();
        std::fs::write(d.join("b.txt"), "t2\n").unwrap();
        snapshot_turn(&d, "c", 10, Edge::End).unwrap();
        let p = plan(&d, "c", 2);
        let got: Vec<_> = p
            .files
            .iter()
            .map(|c| (c.path.as_str(), c.how, c.since))
            .collect();
        assert_eq!(
            got,
            [("b.txt", "added", false), ("kept.txt", "modified", false)]
        );
        // Rewinding only the second turn.
        let p = plan(&d, "c", 10);
        assert_eq!(p.files.len(), 2);
        let failed = checkout(
            Path::new(p.root.as_deref().unwrap()),
            p.start.as_deref().unwrap(),
            &["kept.txt".into()],
        );
        assert!(failed.is_empty());
        assert_eq!(std::fs::read_to_string(d.join("kept.txt")).unwrap(), "t1\n");
        let _ = std::fs::remove_dir_all(&d);
    }
}
