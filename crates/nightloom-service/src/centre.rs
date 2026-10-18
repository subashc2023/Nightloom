//! What the notification centre reads (2026-09-16, nightshift backlog 069).
//!
//! The centre lists five kinds of thing that wait on the user — proposals
//! to the always-loaded files, notes a dream changed, a morning page not
//! yet read, blockers open, a release installed — and none of them is a
//! record of its own. Every one is *derived* from something that already
//! exists on disk: the proposal stores, the dream's own commits, the
//! Nightshift rows, the running binary. A store of notifications would be a
//! second copy of those facts that could drift from the first; what the
//! frontend keeps is only "dismissed", the way it keeps the read morning
//! pages. This module is the two sources the frontend cannot reach on its
//! own — proposals across every project, and the dream's commits with their
//! diffs and a per-file revert — plus the build stamp.
//!
//! Git runs as the `git` binary, the way `dream.rs` snapshots and
//! `nightshift/git.rs` diff: the repositories are the user's, the commands
//! are plain, and `git` is on the path wherever a dream could have
//! committed.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::project::{AGENTS_DIR, Registry};
use crate::prompt::INSTRUCTION_FILE;
use crate::proposal;

/// The project a notice belongs to; `None` on a notice means the user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectRef {
    pub id: String,
    pub name: String,
}

/// One pending proposal, with the project whose store it sits in — the
/// frontend's own `list_proposals` only reaches the open project's, and a
/// daily pass dreams for every project with observations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProposalNotice {
    pub project: Option<ProjectRef>,
    pub entry: proposal::Entry,
}

/// Every pending proposal under `config`: the user's store, then each
/// registered project's, each newest first as `proposal::list_in` orders
/// them. A project whose store has no `proposals/` folder simply has none.
pub fn proposals_in(config: &Path) -> Vec<ProposalNotice> {
    let mut out: Vec<ProposalNotice> = proposal::list_in(config)
        .into_iter()
        .map(|entry| ProposalNotice {
            project: None,
            entry,
        })
        .collect();
    for p in Registry::load_in(config).projects() {
        let store = proposal::ProposalTarget::Project {
            id: p.id.clone(),
            name: p.name.clone(),
        }
        .store_in(config);
        out.extend(
            proposal::list_in(&store)
                .into_iter()
                .map(|entry| ProposalNotice {
                    project: Some(ProjectRef {
                        id: p.id.clone(),
                        name: p.name.clone(),
                    }),
                    entry,
                }),
        );
    }
    out
}

/// The subject every after-dream snapshot carries (`dream::run_with`):
/// `nightloom: dream — consolidated N observations`. The pre-dream
/// snapshot (`nightloom: pre-dream snapshot`) is the user's own uncommitted
/// work and is deliberately not listed — it is not something the dream did.
pub const DREAM_SUBJECT: &str = "nightloom: dream —";

/// One file a dream's commit touched, from `--numstat`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChangedFile {
    /// Repository-relative, as git prints it.
    pub path: String,
    pub added: usize,
    pub removed: usize,
}

/// One after-dream commit: where it is, when, and what it changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DreamCommit {
    /// `None` for the vault.
    pub project: Option<ProjectRef>,
    /// The repository the commit is in — the vault, or the project's
    /// workspace (whose `.agents/` alone the dream commits).
    pub repo: PathBuf,
    /// Full sha; the frontend keys "dismissed" on it.
    pub hash: String,
    /// The author date, RFC 3339 as `git log --format=%aI` prints it.
    pub at: String,
    pub subject: String,
    pub files: Vec<ChangedFile>,
}

/// The newest `limit` dream commits per target: the vault's repository, then
/// each registered project's workspace restricted to its `.agents/` and its
/// `AGENTS.md` (which the dream writes since backlog 344). A
/// folder that is not a repository, or has no such commit, contributes
/// nothing — the pass reported "no rollback" at the time, and there is no
/// diff to show now.
pub fn dream_commits_in(config: &Path, vault: &Path, limit: usize) -> Vec<DreamCommit> {
    let mut out = commits_in(vault, &[], limit, None);
    for p in Registry::load_in(config).projects() {
        let Some(workspace) = p.workspace.clone() else {
            continue;
        };
        let project = || {
            Some(ProjectRef {
                id: p.id.clone(),
                name: p.name.clone(),
            })
        };
        // `.agents` with its own history (backlog 372): its commits, whole;
        // and the workspace's for `AGENTS.md`, when the workspace is a
        // repository too.
        let agents = workspace.join(AGENTS_DIR);
        if crate::history::is_repo(&agents) {
            out.extend(commits_in(&agents, &[], limit, project()));
            out.extend(commits_in(
                &workspace,
                &[Path::new(INSTRUCTION_FILE)],
                limit,
                project(),
            ));
            continue;
        }
        out.extend(commits_in(
            &workspace,
            &[Path::new(AGENTS_DIR), Path::new(INSTRUCTION_FILE)],
            limit,
            Some(ProjectRef {
                id: p.id.clone(),
                name: p.name.clone(),
            }),
        ));
    }
    out
}

/// The repository a `repo` from the window may mean: the vault, or a
/// registered project's workspace — the same set `dream_commits_in` lists
/// — canonicalised; anything else is refused. The two commands that run
/// git (`dream_diff`, `revert_dream_file`) took the path as given, so a
/// wrong or hostile caller inside the webview could run `checkout` in
/// any repository on the machine (review 2026-09-17 FB3, backlog 133).
pub fn dream_repo(config: &Path, vault: &Path, repo: &Path) -> Result<PathBuf, String> {
    let asked = fs::canonicalize(repo)
        .map_err(|e| format!("{} is not a folder here: {e}", repo.display()))?;
    let mut allowed = Vec::new();
    if let Ok(v) = fs::canonicalize(vault) {
        allowed.push(v);
    }
    for p in Registry::load_in(config).projects() {
        if let Some(w) = p.workspace.as_deref()
            && let Ok(w) = fs::canonicalize(w)
        {
            // Its `.agents`, when that is its own repository (backlog 372).
            if let Ok(a) = fs::canonicalize(w.join(AGENTS_DIR))
                && crate::history::is_repo(&a)
            {
                allowed.push(a);
            }
            allowed.push(w);
        }
    }
    if allowed.contains(&asked) {
        Ok(asked)
    } else {
        Err(format!(
            "{} is not the vault or a project's folder — nothing is reverted there",
            repo.display()
        ))
    }
}

fn git(repo: &Path, args: &[&str], pathspec: Option<&Path>) -> Result<String, String> {
    match pathspec {
        Some(p) => git_paths(repo, args, &[p]),
        None => git_paths(repo, args, &[]),
    }
}

/// [`git`] with any number of pathspecs (none: the whole repository).
fn git_paths(repo: &Path, args: &[&str], pathspec: &[&Path]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(repo).args(args);
    if !pathspec.is_empty() {
        cmd.arg("--").args(pathspec);
    }
    let out = cmd.output().map_err(|e| format!("git did not run: {e}"))?;
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

fn commits_in(
    repo: &Path,
    pathspec: &[&Path],
    limit: usize,
    project: Option<ProjectRef>,
) -> Vec<DreamCommit> {
    if !repo.join(".git").exists() {
        return Vec::new();
    }
    let n = limit.to_string();
    // `--grep` is a regex; the em dash is literal either way, but
    // `--fixed-strings` says so. The subject is checked again below, so a
    // commit merely *mentioning* the phrase in its body is not listed.
    let log = match git_paths(
        repo,
        &[
            "log",
            "-n",
            &n,
            "--fixed-strings",
            "--grep",
            DREAM_SUBJECT,
            "--format=%H%x1f%aI%x1f%s",
        ],
        pathspec,
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    log.lines()
        .filter_map(|line| {
            let mut parts = line.split('\x1f');
            let hash = parts.next()?.trim().to_string();
            let at = parts.next()?.trim().to_string();
            let subject = parts.next()?.trim().to_string();
            if hash.is_empty() || !subject.starts_with(DREAM_SUBJECT) {
                return None;
            }
            let files = numstat(repo, &hash, pathspec);
            Some(DreamCommit {
                project: project.clone(),
                repo: repo.to_path_buf(),
                hash,
                at,
                subject,
                files,
            })
        })
        .collect()
}

/// `git show --numstat` for one commit: `added\tremoved\tpath`, a `-` on a
/// binary file, which counts as zero.
fn numstat(repo: &Path, hash: &str, pathspec: &[&Path]) -> Vec<ChangedFile> {
    let Ok(out) = git_paths(repo, &["show", "--numstat", "--format=", hash], pathspec) else {
        return Vec::new();
    };
    out.lines()
        .filter_map(|l| {
            let mut parts = l.splitn(3, '\t');
            let added = parts.next()?.trim().parse().unwrap_or(0);
            let removed = parts.next()?.trim().parse().unwrap_or(0);
            let path = parts.next()?.trim().to_string();
            if path.is_empty() {
                return None;
            }
            Some(ChangedFile {
                path,
                added,
                removed,
            })
        })
        .collect()
}

/// A sha the frontend handed back: never something git would read as an
/// option, never a range.
fn check_ref(r: &str) -> Result<(), String> {
    if r.is_empty()
        || r.starts_with('-')
        || r.contains("..")
        || r.chars().any(|c| c.is_whitespace() || c == ':')
    {
        return Err(format!("{r:?} is not a git ref"));
    }
    Ok(())
}

/// A repository-relative path the frontend handed back, from a listing this
/// module produced: relative, no `..`, not an option, not pathspec magic —
/// a leading `:` is still magic after `--`, and `:!x` matches every file
/// but `x`.
fn check_path(p: &str) -> Result<(), String> {
    let path = Path::new(p);
    if p.is_empty()
        || p.starts_with('-')
        || p.starts_with(':')
        // `has_root`, not `is_absolute`: on Windows `/tmp/x` has a root but
        // no drive, so it is not "absolute" — and git would still resolve
        // it outside the repository.
        || path.has_root()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(format!("{p:?} is not a path in the repository"));
    }
    Ok(())
}

/// What one dream commit changed — the whole commit, or one of its files.
/// `git diff <hash>^..<hash>`, falling back to `git show` for a root
/// commit, which has no parent to diff against.
pub fn dream_diff(repo: &Path, hash: &str, file: Option<&str>) -> Result<String, String> {
    check_ref(hash)?;
    if let Some(f) = file {
        check_path(f)?;
    }
    let pathspec = file.map(Path::new);
    match git(repo, &["diff", &format!("{hash}^..{hash}")], pathspec) {
        Ok(d) => Ok(d),
        Err(_) => git(repo, &["show", "--format=", "--patch", hash], pathspec),
    }
}

/// Put one file back the way it was before a dream's commit, and commit
/// that: `git checkout <hash>^ -- <file>` for a file the dream amended,
/// `git rm` for one it created, then a commit carrying only that path. A
/// commit rather than a dirty tree because the vault's history is the
/// rollback (`docs/service-data.md`, "Git is the rollback"), and a revert
/// that is itself a commit reads in `git log` as what it was: the user's
/// decision, dated, after the dream's. Returns the sentence the toast
/// shows.
pub fn revert_dream_file(repo: &Path, hash: &str, file: &str) -> Result<String, String> {
    check_ref(hash)?;
    check_path(file)?;
    if !repo.join(".git").exists() {
        return Err(format!("{} is not a git repository", repo.display()));
    }
    let parent = format!("{hash}^");
    let path = Path::new(file);
    // Only the dream commits; an editor save is a plain write. So an edit
    // he made to this note since the dream is on disk and nowhere in git,
    // and `checkout <parent> -- file` would overwrite it silently. Refuse
    // while the file has uncommitted changes — the next dream's pre-dream
    // snapshot commits them, and the revert is still there to click.
    let dirty = git(repo, &["status", "--porcelain"], Some(path))?;
    if !dirty.trim().is_empty() {
        return Err(format!(
            "{file} has been edited since the dream and that edit is not committed; \
             reverting now would lose it"
        ));
    }
    // Did the file exist before the dream? `cat-file -e` answers without
    // printing it; a root commit has no parent, which reads as "no".
    let existed = git(repo, &["cat-file", "-e", &format!("{parent}:{file}")], None).is_ok();
    // Already as it was — a second click on the same Revert: the file at
    // HEAD is the file before the dream (or gone, when the dream added
    // it). Said so before the later-commits check below, which the revert
    // commit itself would otherwise trip.
    let now_exists = git(repo, &["cat-file", "-e", &format!("HEAD:{file}")], None).is_ok();
    let already = if existed {
        now_exists && git(repo, &["diff", "--quiet", &parent, "HEAD"], Some(path)).is_ok()
    } else {
        !now_exists
    };
    if already {
        return Ok(format!("{file} was already as it was before the dream"));
    }
    // Commits after the dream that touched this file — a later dream's,
    // a tidy's, a pre-dream snapshot of his own edit — would go with the
    // checkout of the dream's parent, silently (review 2026-09-17, FB1's
    // follow-on; blocker 204's default: refuse and name them, rather
    // than revert through them or only the dream's own change).
    let later = git(
        repo,
        &["log", "--format=%h %s", &format!("{hash}..HEAD")],
        Some(path),
    )?;
    let later: Vec<&str> = later.lines().filter(|l| !l.trim().is_empty()).collect();
    if !later.is_empty() {
        let n = later.len();
        return Err(format!(
            "{file} changed again in {n} later commit{} ({}); reverting this dream would undo those too — revert the newer one first, or edit the note by hand",
            if n == 1 { "" } else { "s" },
            later.join("; ")
        ));
    }
    if existed {
        git(repo, &["checkout", &parent], Some(path))?;
    } else {
        git(repo, &["rm", "-q", "--ignore-unmatch"], Some(path))?;
    }
    let short: String = hash.chars().take(7).collect();
    let message = format!("nightloom: reverted {file} from dream {short}");
    // Nothing to commit when the file was already back (a second click on
    // the same Revert): say so rather than fail.
    let staged = git(repo, &["status", "--porcelain"], Some(path))?;
    if staged.trim().is_empty() {
        return Ok(format!("{file} was already as it was before the dream"));
    }
    git(repo, &["commit", "-q", "-m", &message], Some(path))?;
    Ok(if existed {
        format!("{file} restored to before the dream and committed")
    } else {
        format!("{file} (added by the dream) removed and committed")
    })
}

// ---- what the dream applied where git cannot roll it back (backlog 344) ----

/// One `AGENTS.md` write the dream made that no git commit carries — the
/// user's `~/.nightloom/AGENTS.md` (the config folder is not a repository),
/// or a project's whose workspace is not one. Shown beside the dream
/// commits as *Show the diff*, with a Revert that restores the copy kept
/// from before ([`proposal::revert_applied`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppliedNotice {
    /// `None` for the user's own file.
    pub project: Option<ProjectRef>,
    pub entry: proposal::Entry,
    /// The file that was written.
    pub file: PathBuf,
}

/// The store and the file of an applied record's target: the user's
/// (`project` `None`) or a registered project's.
fn applied_target(
    config: &Path,
    project: Option<&str>,
) -> Result<(PathBuf, PathBuf, Option<ProjectRef>), String> {
    match project {
        None => Ok((config.to_path_buf(), config.join(INSTRUCTION_FILE), None)),
        Some(id) => {
            let registry = Registry::load_in(config);
            let p = registry
                .find(id)
                .ok_or_else(|| format!("no project {id:?} is registered"))?;
            let target = proposal::ProposalTarget::Project {
                id: p.id.clone(),
                name: p.name.clone(),
            };
            Ok((
                target.store_in(config),
                p.workspace_dir().join(INSTRUCTION_FILE),
                Some(ProjectRef {
                    id: p.id.clone(),
                    name: p.name.clone(),
                }),
            ))
        }
    }
}

/// The newest `limit` dream-applied writes per store that no commit
/// carries and that were not reverted: the user's, then each project's.
pub fn applied_in(config: &Path, limit: usize) -> Vec<AppliedNotice> {
    let open = |e: &proposal::Entry| {
        e.proposal
            .applied
            .as_ref()
            .is_some_and(|a| a.commit.is_none() && a.reverted_at.is_none())
    };
    let mut out = Vec::new();
    let mut targets: Vec<Option<String>> = vec![None];
    targets.extend(
        Registry::load_in(config)
            .projects()
            .into_iter()
            .map(|p| Some(p.id)),
    );
    for t in targets {
        let Ok((store, file, project)) = applied_target(config, t.as_deref()) else {
            continue;
        };
        out.extend(
            proposal::applied_by_dream_in(&store)
                .into_iter()
                .filter(open)
                .take(limit)
                .map(|entry| AppliedNotice {
                    project: project.clone(),
                    entry,
                    file: file.clone(),
                }),
        );
    }
    out
}

/// What a dream-applied write changed, as a unified diff of the copy from
/// before against the text written — `git diff --no-index`, which needs no
/// repository (an absent "before" diffs against `/dev/null`).
pub fn applied_diff(config: &Path, project: Option<&str>, id: &str) -> Result<String, String> {
    let (store, file, _) = applied_target(config, project)?;
    let (before, after) = proposal::applied_sides(&store, id, &file)?;
    let left = before.unwrap_or_else(|| PathBuf::from("/dev/null"));
    let out = Command::new("git")
        .args(["diff", "--no-index", "--"])
        .arg(&left)
        .arg(&after)
        .output()
        .map_err(|e| format!("git did not run: {e}"))?;
    // Exit 1 is "they differ", the expected answer; 0 is "the same".
    match out.status.code() {
        Some(0) | Some(1) => Ok(String::from_utf8_lossy(&out.stdout).into_owned()),
        _ => Err(String::from_utf8_lossy(&out.stderr).trim().to_string()),
    }
}

/// Revert a dream-applied write from its copy; the sentence is the toast.
pub fn revert_applied(config: &Path, project: Option<&str>, id: &str) -> Result<String, String> {
    let (store, file, _) = applied_target(config, project)?;
    proposal::revert_applied(&store, id, &file)
}

/// When the running binary was last written — the one fact that changes on
/// every release roll and on nothing else, so "a release was installed" is
/// "this stamp differs from the one the window last saw". RFC 3339, or
/// `None` where the OS will not say.
pub fn exe_modified() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let modified = std::fs::metadata(exe).ok()?.modified().ok()?;
    let at: chrono::DateTime<chrono::Utc> = modified.into();
    Some(at.to_rfc3339())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// A throwaway repo, or `None` when `git` is missing.
    fn repo() -> Option<PathBuf> {
        let dir = std::env::temp_dir().join(format!(
            "nightloom-centre-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        if git(&dir, &["init", "-q"], None).is_err() {
            return None;
        }
        git(&dir, &["config", "user.email", "t@example.com"], None).unwrap();
        git(&dir, &["config", "user.name", "t"], None).unwrap();
        // Git for Windows defaults `core.autocrlf=true`, so a checkout
        // rewrote `one\n` as `one\r\n` and the revert test's exact compare
        // failed on every CI push (runs 16596f5 through b6a9c07). The
        // fixture pins the repo's own setting; the product does what git does.
        git(&dir, &["config", "core.autocrlf", "false"], None).unwrap();
        Some(dir)
    }

    fn commit_all(dir: &Path, message: &str) -> String {
        git(dir, &["add", "-A"], None).unwrap();
        git(dir, &["commit", "-q", "-m", message], None).unwrap();
        git(dir, &["rev-parse", "HEAD"], None)
            .unwrap()
            .trim()
            .to_string()
    }

    #[test]
    fn lists_only_after_dream_commits_with_their_files() {
        let Some(dir) = repo() else { return };
        fs::write(dir.join("a.md"), "one\n").unwrap();
        commit_all(&dir, "nightloom: pre-dream snapshot");
        fs::write(dir.join("a.md"), "one\ntwo\n").unwrap();
        fs::write(dir.join("b.md"), "new\n").unwrap();
        let dream = commit_all(&dir, "nightloom: dream — consolidated 2 observations");
        fs::write(dir.join("a.md"), "hand edit\n").unwrap();
        commit_all(
            &dir,
            "my own commit mentioning nightloom: dream — in the body",
        );

        let commits = commits_in(&dir, &[], 10, None);
        assert_eq!(commits.len(), 1, "{commits:?}");
        assert_eq!(commits[0].hash, dream);
        assert!(commits[0].project.is_none());
        let mut files: Vec<_> = commits[0].files.iter().map(|f| f.path.as_str()).collect();
        files.sort();
        assert_eq!(files, ["a.md", "b.md"]);
        let a = commits[0].files.iter().find(|f| f.path == "a.md").unwrap();
        assert_eq!((a.added, a.removed), (1, 0));

        let diff = dream_diff(&dir, &dream, Some("b.md")).unwrap();
        assert!(diff.contains("+new"), "{diff}");
        assert!(!diff.contains("+two"), "{diff}");
        let whole = dream_diff(&dir, &dream, None).unwrap();
        assert!(whole.contains("+two") && whole.contains("+new"), "{whole}");
    }

    #[test]
    fn revert_restores_an_amended_file_and_removes_an_added_one_as_commits() {
        let Some(dir) = repo() else { return };
        fs::write(dir.join("a.md"), "one\n").unwrap();
        commit_all(&dir, "start");
        fs::write(dir.join("a.md"), "one\ntwo\n").unwrap();
        fs::write(dir.join("b.md"), "new\n").unwrap();
        let dream = commit_all(&dir, "nightloom: dream — consolidated 1 observations");

        let said = revert_dream_file(&dir, &dream, "a.md").unwrap();
        assert!(said.contains("restored"), "{said}");
        assert_eq!(fs::read_to_string(dir.join("a.md")).unwrap(), "one\n");
        assert!(dir.join("b.md").exists());
        // Committed, tree clean, the subject says what happened.
        assert!(
            git(&dir, &["status", "--porcelain"], None)
                .unwrap()
                .trim()
                .is_empty()
        );
        let subject = git(&dir, &["log", "-1", "--format=%s"], None).unwrap();
        assert!(
            subject.starts_with("nightloom: reverted a.md from dream"),
            "{subject}"
        );

        let again = revert_dream_file(&dir, &dream, "a.md").unwrap();
        assert!(again.contains("already"), "{again}");

        let said = revert_dream_file(&dir, &dream, "b.md").unwrap();
        assert!(said.contains("removed"), "{said}");
        assert!(!dir.join("b.md").exists());
        assert!(
            git(&dir, &["status", "--porcelain"], None)
                .unwrap()
                .trim()
                .is_empty()
        );

        // The revert commits are not dream commits.
        assert_eq!(commits_in(&dir, &[], 10, None).len(), 1);
    }

    #[test]
    fn refuses_options_ranges_and_paths_outside_the_repo() {
        let Some(dir) = repo() else { return };
        assert!(dream_diff(&dir, "--output=x", None).is_err());
        assert!(dream_diff(&dir, "HEAD..HEAD~1", None).is_err());
        assert!(revert_dream_file(&dir, "HEAD", "../etc/passwd").is_err());
        assert!(revert_dream_file(&dir, "HEAD", "-f").is_err());
        assert!(revert_dream_file(&dir, "HEAD", "/tmp/x").is_err());
        // Pathspec magic survives `--`; `:!x` would check out everything else.
        assert!(revert_dream_file(&dir, "HEAD", ":!a.md").is_err());
        assert!(dream_diff(&dir, "HEAD", Some(":(top)a.md")).is_err());
    }

    #[test]
    fn revert_refuses_a_file_with_uncommitted_edits() {
        let Some(dir) = repo() else { return };
        fs::write(dir.join("a.md"), "one\n").unwrap();
        commit_all(&dir, "start");
        fs::write(dir.join("a.md"), "one\ntwo\n").unwrap();
        let dream = commit_all(&dir, "nightloom: dream — consolidated 1 observations");
        // His own edit after the dream: saved, not committed.
        fs::write(dir.join("a.md"), "one\ntwo\nmine\n").unwrap();

        let err = revert_dream_file(&dir, &dream, "a.md").unwrap_err();
        assert!(err.contains("not committed"), "{err}");
        // Nothing touched: the edit is still on disk and nothing was committed.
        assert_eq!(
            fs::read_to_string(dir.join("a.md")).unwrap(),
            "one\ntwo\nmine\n"
        );
        let head = git(&dir, &["rev-parse", "HEAD"], None).unwrap();
        assert_eq!(head.trim(), dream);
    }

    #[test]
    fn revert_refuses_a_file_a_later_commit_changed_again() {
        let Some(dir) = repo() else { return };
        fs::write(dir.join("a.md"), "one\n").unwrap();
        commit_all(&dir, "start");
        fs::write(dir.join("a.md"), "one\ntwo\n").unwrap();
        let dream = commit_all(&dir, "nightloom: dream — consolidated 1 observations");
        fs::write(dir.join("a.md"), "one\ntwo\nthree\n").unwrap();
        commit_all(&dir, "nightloom: pre-dream snapshot");
        let err = revert_dream_file(&dir, &dream, "a.md").unwrap_err();
        assert!(err.contains("1 later commit"), "{err}");
        assert!(err.contains("pre-dream snapshot"), "{err}");
        assert_eq!(
            fs::read_to_string(dir.join("a.md")).unwrap(),
            "one\ntwo\nthree\n"
        );
        // Another file's later commit does not stand in the way.
        fs::write(dir.join("b.md"), "x\n").unwrap();
        let dream2 = commit_all(&dir, "nightloom: dream — consolidated 1 observations");
        fs::write(dir.join("a.md"), "again\n").unwrap();
        commit_all(&dir, "nightloom: tidy");
        let said = revert_dream_file(&dir, &dream2, "b.md").unwrap();
        assert!(said.contains("removed"), "{said}");
    }

    #[test]
    fn a_repo_from_the_window_must_be_the_vault_or_a_projects_folder() {
        let Some(vault) = repo() else { return };
        let Some(project) = repo() else { return };
        let Some(elsewhere) = repo() else { return };
        let config =
            std::env::temp_dir().join(format!("nightloom-centre-cfg-{}", std::process::id()));
        fs::create_dir_all(&config).unwrap();
        let mut reg = Registry::load_in(&config);
        reg.add(&project, Some("p".into())).unwrap();
        assert_eq!(
            dream_repo(&config, &vault, &vault).unwrap(),
            fs::canonicalize(&vault).unwrap()
        );
        assert_eq!(
            dream_repo(&config, &vault, &project).unwrap(),
            fs::canonicalize(&project).unwrap()
        );
        let err = dream_repo(&config, &vault, &elsewhere).unwrap_err();
        assert!(err.contains("not the vault or a project's folder"), "{err}");
        assert!(dream_repo(&config, &vault, Path::new("/nonexistent/x")).is_err());
        let _ = fs::remove_dir_all(&config);
    }

    /// A project whose `.agents` is its own repository (backlog 372): the
    /// dream's commits there are listed with that folder as their repo, and
    /// the window may name it for a diff or a revert.
    #[test]
    fn a_projects_own_agents_history_is_listed_and_allowed() {
        let Some(vault) = repo() else { return };
        let workspace = std::env::temp_dir().join(format!(
            "nightloom-centre-ws-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let agents = workspace.join(AGENTS_DIR);
        fs::create_dir_all(agents.join("memory")).unwrap();
        crate::history::start(&agents).unwrap();
        fs::write(agents.join("memory").join("stack.md"), "tokio\n").unwrap();
        let dream = commit_all(&agents, "nightloom: dream — consolidated 1 observations");
        let config = workspace.with_extension("cfg");
        fs::create_dir_all(&config).unwrap();
        Registry::load_in(&config)
            .add(&workspace, Some("p".into()))
            .unwrap();

        let commits = dream_commits_in(&config, &vault, 5);
        assert_eq!(commits.len(), 1, "{commits:?}");
        assert_eq!(commits[0].hash, dream);
        assert_eq!(commits[0].project.as_ref().unwrap().name, "p");
        assert_eq!(
            fs::canonicalize(&commits[0].repo).unwrap(),
            fs::canonicalize(&agents).unwrap()
        );
        assert_eq!(commits[0].files[0].path, "memory/stack.md");
        assert_eq!(
            dream_repo(&config, &vault, &agents).unwrap(),
            fs::canonicalize(&agents).unwrap()
        );
    }

    #[test]
    fn a_folder_that_is_not_a_repo_lists_nothing() {
        let dir =
            std::env::temp_dir().join(format!("nightloom-centre-plain-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        assert!(commits_in(&dir, &[], 5, None).is_empty());
        assert!(revert_dream_file(&dir, "abc", "a.md").is_err());
    }

    /// The user's file has no git (backlog 344): a dream's write is listed
    /// from its record, its diff is the copy against the text written, an
    /// edit since refuses the Revert, and a Revert restores the copy and
    /// takes the row away.
    #[test]
    fn a_write_no_commit_carries_is_listed_diffed_and_reverted_from_its_copy() {
        let config = crate::tools::test_dir("centre-applied");
        let file = config.join(INSTRUCTION_FILE);
        fs::write(&file, "# Me\n\nBe terse.\n").unwrap();
        let p = proposal::Proposal {
            v: 1,
            at: chrono::Utc::now(),
            target: proposal::ProposalTarget::User,
            why: "Observation 1.".into(),
            text: "# Me\n\nBe expansive.\n".into(),
            from_dream: true,
            applied: None,
            dismissed_at: None,
            held: None,
            screened: None,
        };
        let dir = proposal::dir_in(&config);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("p1.json"), serde_json::to_string(&p).unwrap()).unwrap();
        proposal::apply_now(&config, "p1", &file).unwrap();
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            "# Me\n\nBe expansive.\n"
        );

        let listed = applied_in(&config, 10);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].entry.id, "p1");
        assert!(listed[0].project.is_none());
        assert_eq!(listed[0].file, file);

        let diff = applied_diff(&config, None, "p1").unwrap();
        assert!(diff.contains("-Be terse."), "{diff}");
        assert!(diff.contains("+Be expansive."), "{diff}");

        // His edit since the dream: Revert would lose it, so it refuses.
        fs::write(&file, "# Me\n\nBe expansive. Metric.\n").unwrap();
        let err = revert_applied(&config, None, "p1").unwrap_err();
        assert!(err.contains("edited since"), "{err}");
        fs::write(&file, "# Me\n\nBe expansive.\n").unwrap();

        let said = revert_applied(&config, None, "p1").unwrap();
        assert!(said.contains("restored"), "{said}");
        assert_eq!(fs::read_to_string(&file).unwrap(), "# Me\n\nBe terse.\n");
        assert!(applied_in(&config, 10).is_empty());
        // The record stays, marked; nothing was deleted.
        let record = proposal::read_applied(&config, "p1").unwrap();
        assert!(record.applied.unwrap().reverted_at.is_some());
        assert!(revert_applied(&config, Some("nope"), "p1").is_err());
    }
}
