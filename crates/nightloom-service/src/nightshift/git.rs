//! Git, as the Review page needs it: what a unit changed, what a shift
//! changed, and undoing a shift — always shown as a diff first, never
//! automatic (§6, §12.5).
//!
//! Runs the `git` binary rather than linking a library, the way `dream.rs`
//! does for the vault: the repository is the user's, the operations are four
//! plain commands, and a library would be a large dependency for the sake of
//! not needing `git` on the path — which the runner needs anyway.

use serde::Serialize;
use std::path::Path;
use std::process::Command;

fn run(root: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
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
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Whether `root` is inside a git work tree.
pub fn is_repo(root: &Path) -> bool {
    run(root, &["rev-parse", "--is-inside-work-tree"])
        .map(|s| s.trim() == "true")
        .unwrap_or(false)
}

/// `git init` for a fresh contract root. Refuses to re-initialise.
pub fn init(root: &Path) -> Result<(), String> {
    if is_repo(root) {
        return Ok(());
    }
    run(root, &["init", "-q"]).map(|_| ())
}

/// The full sha of `HEAD`.
pub fn head(root: &Path) -> Result<String, String> {
    run(root, &["rev-parse", "HEAD"]).map(|s| s.trim().to_string())
}

/// What one commit changed: `git diff <sha>^..<sha>`, falling back to
/// `git show` for a root commit, which has no parent to diff against.
pub fn diff_commit(root: &Path, sha: &str) -> Result<String, String> {
    check_ref(sha)?;
    match run(root, &["diff", &format!("{sha}^..{sha}")]) {
        Ok(d) => Ok(d),
        Err(_) => run(root, &["show", "--format=%H%n%s%n", "--patch", sha]),
    }
}

/// What a range changed: `git diff <from>..<to>`.
pub fn diff_range(root: &Path, from: &str, to: &str) -> Result<String, String> {
    check_ref(from)?;
    check_ref(to)?;
    run(root, &["diff", &format!("{from}..{to}")])
}

/// `--stat` for the same range, for a summary line above the patch.
pub fn stat_range(root: &Path, from: &str, to: &str) -> Result<String, String> {
    check_ref(from)?;
    check_ref(to)?;
    run(root, &["diff", "--stat", &format!("{from}..{to}")])
}

/// A ref the user typed or a file supplied: a sha, `HEAD`, or a branch name,
/// never something starting with `-` that git would read as an option.
fn check_ref(r: &str) -> Result<(), String> {
    if r.is_empty() || r.starts_with('-') || r.chars().any(char::is_whitespace) {
        return Err(format!("{r:?} is not a git ref"));
    }
    Ok(())
}

/// What a revert would do, shown before it is done.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RevertPreview {
    /// The commit the shift started from.
    pub target: String,
    pub head: String,
    /// Commits between the two — what would be discarded.
    pub commits: usize,
    /// `git diff <target>..HEAD`: the work a revert throws away.
    pub diff: String,
    pub stat: String,
    /// Uncommitted changes in the tree. A revert refuses while true, because
    /// `reset --hard` would take those too and nobody was shown them.
    pub dirty: bool,
}

pub fn revert_preview(root: &Path, target: &str) -> Result<RevertPreview, String> {
    check_ref(target)?;
    let head = head(root)?;
    let commits = run(root, &["rev-list", "--count", &format!("{target}..HEAD")])?
        .trim()
        .parse::<usize>()
        .unwrap_or(0);
    let dirty = !run(root, &["status", "--porcelain"])?.trim().is_empty();
    Ok(RevertPreview {
        target: target.to_string(),
        head,
        commits,
        diff: diff_range(root, target, "HEAD")?,
        stat: stat_range(root, target, "HEAD")?,
        dirty,
    })
}

/// `git reset --hard <target>`, only with `confirm` and only on a clean
/// tree with no live shift. Returns the preview of what was discarded so
/// the caller can show it after the fact too. The commits are not gone from
/// the repository — `git reflog` has them — but that is a terminal's job.
pub fn revert(root: &Path, target: &str, confirm: bool) -> Result<RevertPreview, String> {
    if !confirm {
        return Err("a revert needs confirmation after the diff has been shown".into());
    }
    super::launch::ensure_not_live(root)?;
    let preview = revert_preview(root, target)?;
    if preview.dirty {
        return Err(
            "the tree has uncommitted changes; commit or stash them first so the revert discards only what was shown".into(),
        );
    }
    run(root, &["reset", "--hard", "-q", target])?;
    Ok(preview)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A throwaway repo with two commits, or `None` when `git` is missing.
    fn repo() -> Option<(std::path::PathBuf, String, String)> {
        let dir = std::env::temp_dir().join(format!(
            "nightloom-git-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        if Command::new("git").arg("--version").output().is_err() {
            return None;
        }
        let g = |args: &[&str]| {
            let out = Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args([
                    "-c",
                    "user.name=t",
                    "-c",
                    "user.email=t@t",
                    "-c",
                    "commit.gpgsign=false",
                ])
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        g(&["init", "-q"]);
        fs::write(dir.join("a.md"), "one\n").unwrap();
        g(&["add", "a.md"]);
        g(&["commit", "-q", "-m", "first"]);
        let first = head(&dir).unwrap();
        fs::write(dir.join("a.md"), "one\ntwo\n").unwrap();
        g(&["add", "a.md"]);
        g(&["commit", "-q", "-m", "second"]);
        let second = head(&dir).unwrap();
        Some((dir, first, second))
    }

    #[test]
    fn diffs_by_sha_and_by_range_show_the_change() {
        let Some((dir, first, second)) = repo() else {
            return;
        };
        assert!(is_repo(&dir));
        let d = diff_commit(&dir, &second).unwrap();
        assert!(d.contains("+two"), "{d}");
        // A root commit has no parent; the fallback still shows its content.
        let d0 = diff_commit(&dir, &first).unwrap();
        assert!(d0.contains("+one"), "{d0}");
        let r = diff_range(&dir, &first, "HEAD").unwrap();
        assert!(r.contains("+two"));
        assert!(stat_range(&dir, &first, "HEAD").unwrap().contains("a.md"));
        assert!(diff_commit(&dir, "--output=/tmp/x").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn revert_shows_first_refuses_without_confirm_or_on_a_dirty_tree_then_resets() {
        let Some((dir, first, second)) = repo() else {
            return;
        };
        let p = revert_preview(&dir, &first).unwrap();
        assert_eq!(p.commits, 1);
        assert_eq!(p.head, second);
        assert!(!p.dirty);
        assert!(p.diff.contains("+two"));
        assert!(revert(&dir, &first, false).is_err());
        fs::write(dir.join("b.md"), "loose\n").unwrap();
        assert!(
            revert(&dir, &first, true)
                .unwrap_err()
                .contains("uncommitted")
        );
        fs::remove_file(dir.join("b.md")).unwrap();
        let done = revert(&dir, &first, true).unwrap();
        assert_eq!(done.commits, 1);
        assert_eq!(head(&dir).unwrap(), first);
        assert_eq!(fs::read_to_string(dir.join("a.md")).unwrap(), "one\n");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn init_makes_a_repo_and_is_idempotent() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("nightloom-git-init-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        assert!(!is_repo(&dir));
        init(&dir).unwrap();
        assert!(is_repo(&dir));
        init(&dir).unwrap();
        let _ = fs::remove_dir_all(&dir);
    }
}
