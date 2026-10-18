//! Version history for a memory folder (backlog 372): a project's `.agents`
//! and the vault are git repositories, so every dream commits before and
//! after and the Centre can show and revert what it changed.
//!
//! [`start`] is the one place Nightloom runs `git init`. It is called when
//! the New project form makes a project, and by a dream on a folder that has
//! no history yet (the dream then says so). A project whose workspace is
//! already a repository — someone's code — is left alone: its `.agents/` is
//! committed there by pathspec, as before, and a second repository nested
//! inside it would turn the notes into an opaque gitlink in the outer one.
//!
//! The first commit stages with `git add -A` run inside the folder itself:
//! the folder is Nightloom's own (memory notes, its listings), so everything
//! in it belongs in the history. (The practices guard's ban on `add -A` is
//! for agents working in his repositories; this is the app's own folder.)

use std::path::Path;
use std::process::Command;

/// The first commit's message.
pub const FIRST_COMMIT: &str = "nightloom: memory history begins";

/// Whether `dir` is the top of a repository. `.git` may be a file (a
/// worktree or submodule), so the check is existence, as the dream's is.
pub fn is_repo(dir: &Path) -> bool {
    dir.join(".git").exists()
}

/// `git init` `dir` (created if missing), stage everything in it and make a
/// first commit — an empty one when the folder is empty, so HEAD exists and
/// the next snapshot has something to diff against. Returns the short hash.
///
/// A machine with no git identity configured still gets its commit: the
/// author is then "Nightloom", set on this command alone, never in his
/// config.
pub fn start(dir: &Path) -> Result<String, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let identity = has_identity(dir);
    let git = |args: &[&str]| -> Result<String, String> {
        let mut cmd = Command::new("git");
        cmd.arg("-C").arg(dir);
        if !identity {
            cmd.args([
                "-c",
                "user.name=Nightloom",
                "-c",
                "user.email=nightloom@localhost",
            ]);
        }
        let out = cmd
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
    };
    git(&["init", "-q"])?;
    git(&["add", "-A"])?;
    git(&["commit", "-q", "--allow-empty", "-m", FIRST_COMMIT])?;
    git(&["rev-parse", "--short", "HEAD"])
}

/// [`start`] unless `dir` already has history; `Ok(None)` when it had —
/// or when it sits inside another repository (wave 10 review): a project
/// whose folder is a subfolder of someone's code, or a vault kept inside a
/// repository, is that repository's to version; a repository nested in it
/// would turn the notes into an opaque gitlink, the case [`start`]'s callers
/// already skip for a folder that is a repository's top.
pub fn ensure(dir: &Path) -> Result<Option<String>, String> {
    if is_repo(dir) || enclosing_repo(dir).is_some() {
        return Ok(None);
    }
    start(dir).map(Some)
}

/// The nearest folder above `dir` that is a repository's top, by the same
/// existence test as [`is_repo`]; `None` when there is none.
pub fn enclosing_repo(dir: &Path) -> Option<&Path> {
    dir.ancestors().skip(1).find(|a| is_repo(a))
}

/// Whether git would find an author for a commit in `dir`.
fn has_identity(dir: &Path) -> bool {
    let set = |key: &str| {
        Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["config", key])
            .output()
            .is_ok_and(|o| o.status.success() && !o.stdout.trim_ascii().is_empty())
    };
    set("user.email") && set("user.name")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "nl-history-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A folder with notes in it: a repository whose first commit carries
    /// every file, nothing left untracked.
    #[test]
    fn start_commits_what_is_there() {
        let d = scratch("notes");
        std::fs::create_dir_all(d.join("memory")).unwrap();
        std::fs::write(d.join("memory").join("stack.md"), "tokio\n").unwrap();
        let hash = start(&d).unwrap();
        assert!(is_repo(&d));
        assert_eq!(git(&d, &["rev-parse", "--short", "HEAD"]), hash);
        assert_eq!(git(&d, &["log", "--format=%s"]), FIRST_COMMIT);
        assert_eq!(git(&d, &["ls-files"]), "memory/stack.md");
        assert_eq!(git(&d, &["status", "--porcelain"]), "");
    }

    /// An empty (or missing) folder still gets a first commit, so HEAD
    /// exists; a second `ensure` changes nothing.
    #[test]
    fn an_empty_folder_gets_an_empty_first_commit_once() {
        let d = scratch("empty").join(".agents");
        let first = ensure(&d).unwrap().expect("started");
        assert_eq!(git(&d, &["rev-list", "--count", "HEAD"]), "1");
        assert_eq!(ensure(&d).unwrap(), None);
        assert_eq!(git(&d, &["rev-parse", "--short", "HEAD"]), first);
    }

    /// A memory folder inside someone's repository — a project picked as a
    /// subfolder of their code — gets no repository of its own: nothing is
    /// nested in theirs (wave 10 review).
    #[test]
    fn a_folder_inside_another_repository_is_left_to_it() {
        let code = scratch("code");
        git(&code, &["init", "-q"]);
        let agents = code.join("apps").join("web").join(".agents");
        assert_eq!(enclosing_repo(&agents), Some(code.as_path()));
        assert_eq!(ensure(&agents).unwrap(), None);
        assert!(!is_repo(&agents));
        assert!(!agents.exists(), "nothing made inside their repository");
    }
}
