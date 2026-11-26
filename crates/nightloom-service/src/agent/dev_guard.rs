//! A dev home never resumes his real Claude Code sessions (nightshift item
//! 1011).
//!
//! What happened (2026-11-26): the verify sweep's seed copies his chats into
//! a scratch `NIGHTLOOM_HOME` and keeps each chat's Claude Code session id.
//! A send from that dev home ran `claude --resume <id>`, and the CLI
//! appended the test turn to **his** session file under
//! `~/.claude/projects/<his real folder>/<id>.jsonl` — five of his sessions,
//! trimmed back from backups by hand.
//!
//! The guard, on a dev scratch home only (a debug build with
//! `NIGHTLOOM_HOME` set — the desktop's `is_dev_scratch_home`, item 1002):
//! a session id whose file lies under the CLI's projects root in a folder
//! that is not one of this home's own is **foreign**, and nothing resumes,
//! forks or copies it. A release build, or a debug build on the default
//! home, never looks.
//!
//! "This home's own" folders are the CLI folders ([`project_folder`]) of the
//! home itself, its projects folder and every workspace its registry names —
//! each folder or any folder beneath it. The real home's workspaces (the
//! registry at `$HOME/.nightloom`) are never own, even when a copied
//! registry still names them: when an own root and a real root both cover a
//! folder, the longer (nearer) one decides, and a tie is real.
//!
//! The refusal is the turn's error, said in full (blocker 2338: refuse
//! rather than start a fresh session, which would write a new file into his
//! folder every turn when the chat's cwd is his).

use super::cli_session::{project_folder, projects_dir};
use std::path::{Path, PathBuf};

/// Whether this process runs on a dev scratch home: a debug build with
/// `NIGHTLOOM_HOME` set. Release builds are never one.
pub fn dev_scratch_home() -> bool {
    cfg!(debug_assertions) && crate::project::named_home()
}

/// The guard's view of the disk: the CLI's projects root and the folders
/// counted as this home's own, and as the real home's.
#[derive(Debug, Clone)]
pub struct Scope {
    projects: PathBuf,
    own: Vec<String>,
    real: Vec<String>,
}

fn folders(roots: &[PathBuf]) -> Vec<String> {
    let mut out = Vec::new();
    for root in roots {
        for p in [root.clone(), crate::project::normalize(root)] {
            let f = project_folder(&p);
            if !f.is_empty() && !out.contains(&f) {
                out.push(f);
            }
        }
    }
    out
}

/// The length of the longest root in `roots` covering `folder` (the folder
/// itself, or one beneath it: `<root>-…`), if any does.
fn cover(roots: &[String], folder: &str) -> Option<usize> {
    roots
        .iter()
        .filter(|r| {
            folder == r.as_str()
                || folder
                    .strip_prefix(r.as_str())
                    .is_some_and(|rest| rest.starts_with('-'))
        })
        .map(String::len)
        .max()
}

impl Scope {
    /// A scope over `projects` (the CLI's projects root), with `own` the
    /// home's own roots and `real` the real home's workspaces.
    pub fn new(projects: impl Into<PathBuf>, own: &[PathBuf], real: &[PathBuf]) -> Self {
        Self {
            projects: projects.into(),
            own: folders(own),
            real: folders(real),
        }
    }

    /// Whether the CLI folder named `folder` is this home's own.
    pub fn owns_folder(&self, folder: &str) -> bool {
        match (cover(&self.own, folder), cover(&self.real, folder)) {
            (Some(o), Some(r)) => o > r,
            (Some(_), None) => true,
            _ => false,
        }
    }

    /// The foreign file of session `id`, if one exists: `<id>.jsonl` in a
    /// project folder that is not this home's own. A session with no file
    /// anywhere is not foreign — there is nothing of his to append to.
    pub fn foreign(&self, id: &str) -> Option<PathBuf> {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return None;
        }
        let name = format!("{id}.jsonl");
        std::fs::read_dir(&self.projects)
            .ok()?
            .flatten()
            .find_map(|entry| {
                let folder = entry.file_name().to_string_lossy().into_owned();
                let file = entry.path().join(&name);
                (file.is_file() && !self.owns_folder(&folder)).then_some(file)
            })
    }

    /// Whether `file` is a session file in a foreign folder of the projects
    /// root (what a copy beside it would land in).
    pub fn foreign_file(&self, file: &Path) -> bool {
        let Some(dir) = file.parent() else {
            return false;
        };
        let under_root = dir.parent().is_some_and(|p| {
            p == self.projects
                || crate::project::normalize(p) == crate::project::normalize(&self.projects)
        });
        under_root
            && dir
                .file_name()
                .is_some_and(|f| !self.owns_folder(&f.to_string_lossy()))
    }

    /// The scope for a dev home at `home` over the CLI root `projects`, the
    /// real home being `real_home` (`$HOME/.nightloom`): own roots are the
    /// home, its projects folder and its registry's workspaces; real roots
    /// the real home and its registry's workspaces.
    pub fn for_home(projects: impl Into<PathBuf>, home: &Path, real_home: Option<&Path>) -> Self {
        let registry = crate::project::Registry::load_in(home);
        let mut own = vec![crate::project::projects_folder_at(home, &registry)];
        own.extend(registry.projects().into_iter().filter_map(|p| p.workspace));
        own.push(home.to_path_buf());
        let mut real = Vec::new();
        if let Some(real_home) = real_home.filter(|r| *r != home) {
            real.extend(
                crate::project::Registry::load_in(real_home)
                    .projects()
                    .into_iter()
                    .filter_map(|p| p.workspace),
            );
            real.push(real_home.to_path_buf());
        }
        Self::new(projects, &own, &real)
    }

    /// The live scope for this process: `None` unless this is a dev scratch
    /// home ([`dev_scratch_home`]) with a CLI projects root.
    #[cfg_attr(test, allow(dead_code))]
    fn live() -> Option<Self> {
        if !dev_scratch_home() {
            return None;
        }
        let projects = projects_dir()?;
        let home = crate::project::config_dir()?;
        let real_home = std::env::var_os("HOME")
            .filter(|h| !h.is_empty())
            .map(|h| Path::new(&h).join(crate::project::DOT_DIR));
        Some(Self::for_home(projects, &home, real_home.as_deref()))
    }
}

#[cfg(test)]
thread_local! {
    static TEST_SCOPE: std::cell::RefCell<Option<Scope>> = const { std::cell::RefCell::new(None) };
}

/// Set `scope` as this thread's guard until the returned value drops
/// (tests only: the live scope is never read under `cargo test`, so no
/// test opens the real `~/.claude`). A `tokio::test` runs on one thread,
/// so an async turn sees it too.
#[cfg(test)]
#[must_use]
pub fn test_scope(scope: Scope) -> TestScope {
    TEST_SCOPE.with(|s| *s.borrow_mut() = Some(scope));
    TestScope
}

/// Clears [`test_scope`]'s scope on drop.
#[cfg(test)]
pub struct TestScope;

#[cfg(test)]
impl Drop for TestScope {
    fn drop(&mut self) {
        TEST_SCOPE.with(|s| *s.borrow_mut() = None);
    }
}

fn current() -> Option<Scope> {
    #[cfg(test)]
    {
        TEST_SCOPE.with(|s| s.borrow().clone())
    }
    #[cfg(not(test))]
    {
        Scope::live()
    }
}

/// The foreign file of session `id` on this home, if it is one: `None`
/// everywhere but a dev scratch home.
pub fn foreign_resume(id: &str) -> Option<PathBuf> {
    current()?.foreign(id)
}

/// Whether `file` (a CLI session file) lies in a foreign folder on this
/// home: `false` everywhere but a dev scratch home.
pub fn foreign_file(file: &Path) -> bool {
    current().is_some_and(|s| s.foreign_file(file))
}

/// The refusal, said in full: what was refused, why, and what to do.
pub fn refusal(id: &str, file: &Path) -> String {
    let folder = file
        .parent()
        .and_then(Path::file_name)
        .map(|f| f.to_string_lossy().into_owned())
        .unwrap_or_default();
    format!(
        "dev home: this chat's Claude Code session {id} belongs to a folder outside this home ({folder}), so it was not resumed — a dev build never writes into a real Claude Code session (item 1011). Start a new chat in one of this home's own folders."
    )
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::fs;

    /// A temp dir removed on drop.
    pub(crate) struct Tmp(PathBuf);
    impl Tmp {
        fn new() -> Self {
            let d = std::env::temp_dir().join(format!("nightloom-1011-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&d).unwrap();
            Self(d)
        }
        pub(crate) fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// A temp CLI projects root with his real folder (`real`) and the dev
    /// home's own (`own`), each holding one session.
    pub(crate) fn layout() -> (Tmp, Scope, PathBuf, PathBuf) {
        let tmp = Tmp::new();
        let projects = tmp.path().join("claude/projects");
        let real_ws = tmp.path().join("Nightloom/projects/ICS-51");
        let own_ws = tmp.path().join("local/w-verify/.vws/ICS-51");
        let home = tmp.path().join("local/w-verify/.vh");
        for d in [&real_ws, &own_ws, &home] {
            fs::create_dir_all(d).unwrap();
        }
        let real_dir = projects.join(project_folder(&real_ws));
        let own_dir = projects.join(project_folder(&own_ws));
        fs::create_dir_all(&real_dir).unwrap();
        fs::create_dir_all(&own_dir).unwrap();
        fs::write(real_dir.join("bf71e603-aaaa.jsonl"), "{}\n").unwrap();
        fs::write(own_dir.join("0e1-own.jsonl"), "{}\n").unwrap();
        let scope = Scope::new(&projects, &[own_ws, home], &[real_ws]);
        (tmp, scope, real_dir, own_dir)
    }

    #[test]
    fn a_session_in_his_real_folder_is_foreign() {
        let (_t, scope, real_dir, _) = layout();
        assert_eq!(
            scope.foreign("bf71e603-aaaa"),
            Some(real_dir.join("bf71e603-aaaa.jsonl"))
        );
    }

    #[test]
    fn a_session_in_the_homes_own_folder_resumes() {
        let (_t, scope, _, _) = layout();
        assert_eq!(scope.foreign("0e1-own"), None);
    }

    #[test]
    fn a_session_with_no_file_anywhere_is_not_foreign() {
        let (_t, scope, _, _) = layout();
        assert_eq!(scope.foreign("never-made"), None);
        assert_eq!(scope.foreign("../etc"), None, "not an id");
    }

    #[test]
    fn a_subfolder_of_an_own_root_is_own_and_a_sibling_is_not() {
        let (_t, scope, _, own_dir) = layout();
        let own = own_dir.file_name().unwrap().to_string_lossy().into_owned();
        assert!(scope.owns_folder(&own));
        assert!(scope.owns_folder(&format!("{own}-sub-dir")));
        assert!(
            !scope.owns_folder(&format!("{own}x")),
            "a sibling, not a child"
        );
        assert!(!scope.owns_folder("-Users-someone-else"));
    }

    #[test]
    fn a_copied_registry_naming_his_real_workspace_does_not_make_it_own() {
        let (t, _, real_dir, _) = layout();
        let real_ws = t.path().join("Nightloom/projects/ICS-51");
        // The dev home's registry still names his real workspace (a seed
        // that did not remap): the real home's claim wins the tie.
        let scope = Scope::new(
            t.path().join("claude/projects"),
            std::slice::from_ref(&real_ws),
            std::slice::from_ref(&real_ws),
        );
        assert_eq!(
            scope.foreign("bf71e603-aaaa"),
            Some(real_dir.join("bf71e603-aaaa.jsonl"))
        );
    }

    #[test]
    fn an_own_root_nested_inside_a_real_root_is_own() {
        let tmp = Tmp::new();
        let real = tmp.path().join("Nightloom");
        let own = tmp.path().join("Nightloom/local/w-1/.vws/A");
        let scope = Scope::new(
            tmp.path().join("p"),
            std::slice::from_ref(&own),
            std::slice::from_ref(&real),
        );
        assert!(scope.owns_folder(&project_folder(&own)));
        assert!(!scope.owns_folder(&project_folder(&real.join("ICS"))));
    }

    #[test]
    fn a_copy_beside_his_file_is_foreign_and_beside_an_own_file_is_not() {
        let (_t, scope, real_dir, own_dir) = layout();
        assert!(scope.foreign_file(&real_dir.join("bf71e603-aaaa.jsonl")));
        assert!(!scope.foreign_file(&own_dir.join("0e1-own.jsonl")));
        assert!(!scope.foreign_file(Path::new("/elsewhere/x/y.jsonl")));
    }

    #[test]
    fn without_a_scope_nothing_is_foreign() {
        // Under `cargo test` the live scope is never read: no thread scope,
        // no guard, and the real `~/.claude` is not opened.
        assert_eq!(foreign_resume("bf71e603-aaaa"), None);
        assert!(!foreign_file(Path::new("/x/y/z.jsonl")));
    }

    #[test]
    fn a_spec_never_puts_a_foreign_session_on_its_argv() {
        let (t, scope, _, _) = layout();
        let _g = test_scope(scope);
        let mut spec = super::super::AgentSpec::new(t.path());
        spec.resume = Some("bf71e603-aaaa".into());
        spec.fork_session = true;
        for argv in [spec.args("hi"), spec.stdin_args(), spec.resume_args()] {
            assert!(!argv.iter().any(|a| a == "--resume"), "{argv:?}");
            assert!(!argv.iter().any(|a| a == "--fork-session"), "{argv:?}");
            assert!(!argv.iter().any(|a| a == "bf71e603-aaaa"), "{argv:?}");
        }
        // Its own session still resumes, and the fork still forks.
        spec.resume = Some("0e1-own".into());
        let argv = spec.args("hi");
        assert!(
            argv.windows(2).any(|w| w == ["--resume", "0e1-own"]),
            "{argv:?}"
        );
        assert!(argv.iter().any(|a| a == "--fork-session"), "{argv:?}");
    }

    #[test]
    fn a_side_spec_of_a_foreign_chat_drops_the_resume_too() {
        let (t, scope, _, _) = layout();
        let _g = test_scope(scope);
        let mut chat = super::super::AgentSpec::new(t.path());
        chat.resume = Some("bf71e603-aaaa".into());
        // An aside and a keep-warm ping fork the chat's session.
        for side in [chat.aside(), chat.keep_warm_ping()].into_iter().flatten() {
            let argv = side.stdin_args();
            assert!(!argv.iter().any(|a| a == "--resume"), "{argv:?}");
        }
    }

    #[test]
    fn a_checkpoint_fork_with_no_session_refuses_rather_than_runs() {
        let (t, _, _, _) = layout();
        let spec = super::super::fork::ForkSpec {
            binary: "/nonexistent/claude".into(),
            argv: vec!["-p".into(), String::new()],
            workspace: t.path().to_path_buf(),
            env: Vec::new(),
            env_remove: Vec::new(),
        };
        let err = super::super::fork::run_fork(t.path(), &spec, "u", "task", 300).unwrap_err();
        assert!(err.to_string().contains("item 1011"), "{err}");
    }

    /// The registry-built scope: the seed's remapped workspace is own, his
    /// real one (named by the real home's registry) is not — even when
    /// the dev home's copied registry still names it.
    #[test]
    fn a_scope_built_from_the_registries_tells_his_folders_from_the_homes() {
        let t = Tmp::new();
        let home = t.path().join("w-verify/.vh");
        let real_home = t.path().join("real/.nightloom");
        let own_ws = t.path().join("w-verify/.vws/STATS-67");
        let his_ws = t.path().join("Nightloom/projects/ICS-51");
        for d in [&home, &real_home, &own_ws, &his_ws] {
            fs::create_dir_all(d).unwrap();
        }
        let reg = |ws: &[&Path]| {
            let projects: Vec<_> = ws
                .iter()
                .enumerate()
                .map(|(i, w)| serde_json::json!({"id": format!("p{i}"), "name": "x", "workspace": w, "created": "2026-11-26T00:00:00Z", "last_opened": "2026-11-26T00:00:00Z"}))
                .collect();
            serde_json::json!({"version": 1, "projects": projects}).to_string()
        };
        fs::write(home.join("projects.json"), reg(&[&own_ws, &his_ws])).unwrap();
        fs::write(real_home.join("projects.json"), reg(&[&his_ws])).unwrap();
        let scope = Scope::for_home(t.path().join("p"), &home, Some(&real_home));
        assert!(scope.owns_folder(&project_folder(&own_ws)));
        assert!(scope.owns_folder(&project_folder(&home.join("projects/a/sessions"))));
        assert!(!scope.owns_folder(&project_folder(&his_ws)));
        assert!(!scope.owns_folder(&project_folder(&real_home)));
    }

    #[test]
    fn the_refusal_names_the_session_and_the_folder() {
        let m = refusal("s-1", Path::new("/p/-Users-x-ICS-51/s-1.jsonl"));
        assert!(m.contains("s-1") && m.contains("-Users-x-ICS-51"), "{m}");
        assert!(m.contains("not resumed"), "{m}");
    }
}
