//! Projects: a named thing you come back to, the chats held in it, and the
//! notes they share.
//!
//! A project is **not** a folder. It has an identity of its own — an id, a
//! name — and *may* point at a working directory. The distinction was forced
//! by the importer: a claude.ai project is instructions, documents and
//! conversations, with no code anywhere in it, and while identity was derived
//! from a path the import had to invent an empty directory per project purely
//! so there was something to hash. A model that makes you fabricate the thing
//! it claims to be about is the wrong model.
//!
//! Three more things fall out of the separation, each of which was previously
//! impossible rather than merely awkward: moving or renaming a folder stops
//! orphaning a year of chats (repoint `workspace`), two projects can share one
//! folder when there are two workstreams in it, and a project can exist with
//! no folder at all.
//!
//! ## Where things live
//!
//! ```text
//! <workspace>/AGENTS.md      instructions      (yours, usually committed)
//! <workspace>/.agents/       the docspace      (yours, committable)
//! ~/.nightloom/projects/<id>/sessions/   the chats
//! ```
//!
//! The split is **about the code / about you**. Notes describe the codebase,
//! so they sit with it: a teammate can read them, a diff can review them, and
//! the file tools reach them by a plain relative path because they are inside
//! the tree those tools are already rooted at. Chats are personal history and
//! a repository is not the place for them, whatever `.gitignore` says.
//!
//! A project with no workspace gets one made for it at
//! `~/.nightloom/projects/<id>/workspace/`, so the *rule* is the same in both
//! cases: instructions and notes are inside the workspace, chats are a
//! sibling of it and never in it. That is what keeps the docspace reachable
//! without the file tools needing a second permitted tree, and what keeps a
//! transcript from ever being inside the tree it could be searched from.
//!
//! [`migrate`] moves a folder laid out the old way — `.nightloom/sessions`
//! into the store, `.nightloom/notes` into `.agents` — the first time it is
//! opened.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::tools::Root;

/// The dot directory: `<root>/.nightloom` in a project (where `mcp.json`
/// lives) and `~/.nightloom` in the user's home (where everything else does).
pub const DOT_DIR: &str = ".nightloom";
/// Subdirectory of `~/.nightloom` holding one directory per project.
pub const PROJECTS_DIR: &str = "projects";
/// The docspace, inside the workspace: `<workspace>/.agents`.
///
/// Named for the convention `AGENTS.md` already established beside it rather
/// than for this program. A directory of markdown that a team might read, a
/// reviewer might comment on and a repository might carry is a different
/// object from a directory of session logs, and only one of them is clutter.
pub const AGENTS_DIR: &str = ".agents";
/// The docspace's name *before* it became `.agents` inside the workspace.
/// Read by [`migrate`] and written by nothing.
pub const NOTES_DIR: &str = "notes";
/// The project's memory folder inside the docspace: `<workspace>/.agents/memory`.
///
/// Two writers land here and have to agree on the name: the claude.ai
/// import puts a project's memory files under it, and the dream files the
/// observations recorded while working in the project into it. The vault
/// keeps what is true across projects; this keeps what is true of one.
pub const MEMORY_DIR: &str = "memory";
/// Subdirectory of a project's store standing in for a workspace when the
/// project has no folder.
pub const WORKSPACE_DIR: &str = "workspace";
/// Subdirectory of a project's store holding its session logs.
pub const SESSIONS_DIR: &str = "sessions";

/// Registry filename, in the user's config dir.
const REGISTRY_FILE: &str = "projects.json";
/// Where a repointed projects folder is recorded, beside `projects.json` —
/// the vault's `knowledge.json` shape: one key, absent means the default.
/// Not `projects.json`, which the registry already is.
const PROJECTS_FOLDER_FILE: &str = "projects-folder.json";
/// The folder new projects go in when nothing is configured and the registry
/// gives no hint: `~/Documents/Nightloom/projects`.
const DEFAULT_PROJECTS_FOLDER: [&str; 3] = ["Documents", "Nightloom", "projects"];
/// Longest folder name made from a project's name.
pub const SLUG_LIMIT: usize = 60;

/// Notes listed at most. A docspace is meant to be read, and an index of a
/// thousand files is not one — past this the listing is cut.
const NOTE_LIMIT: usize = 200;
/// How deep the notes walk goes. Enough for a folder or two of organization,
/// shallow enough that a repo checked out inside the docspace cannot turn the
/// index into a filesystem crawl.
const NOTE_DEPTH: usize = 4;
/// Bytes read from a note to derive its one-line summary.
const SUMMARY_PROBE: usize = 512;

/// Something the user named and wants to come back to.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    /// Stable for the life of the project and derived from nothing.
    ///
    /// It used to be an FNV-1a over the folder's path, which made `add`
    /// idempotent for free and cost more than it bought: a renamed folder
    /// became a different project and orphaned every chat in it, two projects
    /// could not share a directory, and a project could not exist without
    /// one. Idempotence is now a lookup by workspace, which is the question
    /// actually being asked. Ids already written by the old scheme are kept
    /// as-is — they were only ever opaque handles, and re-deriving them would
    /// orphan exactly what this change exists to stop orphaning.
    pub id: String,
    pub name: String,
    /// The folder this project is about, if it is about one.
    ///
    /// `None` for a project with no code — an imported claude.ai project is
    /// the case that forced this, being instructions, documents and
    /// conversations and nothing else. Read `root` too, which is what this
    /// field was called when it was mandatory.
    #[serde(default, alias = "root")]
    pub workspace: Option<PathBuf>,
    /// Where this project came from, when it did not come from the file
    /// dialog. `"claude:<uuid>"` for an import.
    ///
    /// Provenance rather than decoration: it is what makes re-importing an
    /// export idempotent now that identity is not a hash of a path. Matching
    /// on the *name* instead would be the mistake this module already refuses
    /// to make about conversations — two claude.ai projects can share a name,
    /// and a project can be renamed here without ceasing to be the one that
    /// was imported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// The other folders this project's content lives in (nightshift
    /// backlog 143, 2026-09-17): "a project is not a folder" was already
    /// true above, and this is its other half — *what the project is
    /// about* is one thing, *where its files are* is a list. Each is a
    /// further tree the file tools may reach (`Root::with_extra`, as
    /// `@<name>/…`) and the CLI is granted (`--add-dir`) for every chat in
    /// the project; a chat can add its own on top (`SessionEvent::Folders`).
    /// The home folder stays the one place notes and `AGENTS.md` live.
    /// Absent from every registry written before the field existed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extra_folders: Vec<PathBuf>,
    pub created: DateTime<Utc>,
    /// Bumped by [`Registry::touch`], so the picker can lead with what the
    /// user was last working on.
    pub last_opened: DateTime<Utc>,
}

impl Project {
    /// `~/.nightloom/projects/<id>` — what Nightloom keeps for this project.
    pub fn store_dir(&self) -> PathBuf {
        store_dir(&self.id)
    }

    /// The directory the file tools are rooted at and the preamble walks.
    ///
    /// A project with no folder gets one inside its store, so that everything
    /// downstream — tool rooting, `AGENTS.md` discovery, the docspace index —
    /// has exactly one case to handle instead of two.
    pub fn workspace_dir(&self) -> PathBuf {
        self.workspace
            .clone()
            .unwrap_or_else(|| self.store_dir().join(WORKSPACE_DIR))
    }

    /// The shared docspace: `<workspace>/.agents`.
    ///
    /// Inside the workspace, which is the whole point rather than a detail.
    /// The model reaches a note with a plain relative path, `grep` finds one
    /// in an ordinary walk, and a team can read what the last conversation
    /// left behind — none of which is true of a directory in someone's home.
    pub fn notes_dir(&self) -> PathBuf {
        self.workspace_dir().join(AGENTS_DIR)
    }

    /// The project's memory folder: `<workspace>/.agents/memory`.
    ///
    /// A folder inside the docspace rather than beside it, so the preamble's
    /// index and `grep` reach a consolidated note the same way they reach a
    /// hand-written one, and a repository that carries the docspace carries
    /// the project's memory with it.
    pub fn memory_dir(&self) -> PathBuf {
        self.notes_dir().join(MEMORY_DIR)
    }

    /// Where this project's chats are logged.
    ///
    /// A *sibling* of the workspace and never inside it, for two reasons that
    /// point the same way: a transcript inside the searched tree feeds the
    /// conversation back into its own greps, and a chat log is not something
    /// to leave in somebody's repository.
    pub fn session_dir(&self) -> PathBuf {
        self.store_dir().join(SESSIONS_DIR)
    }

    /// `<workspace>/.nightloom` — where `mcp.json` is looked for. `None` for a
    /// project with no folder, which has no repo-local config to read.
    pub fn dot_dir(&self) -> Option<PathBuf> {
        self.workspace.as_ref().map(|w| w.join(DOT_DIR))
    }

    /// Whether the folder is still there. A project whose folder was moved is
    /// reported as missing rather than dropped from the registry: an unplugged
    /// external drive is not a decision to forget a project. A project with no
    /// folder is never missing — there is nothing to be missing.
    pub fn exists(&self) -> bool {
        match &self.workspace {
            Some(root) => root.is_dir(),
            None => true,
        }
    }

    /// Whether this is the holder a claude.ai import made for the chats that
    /// belonged to no project — "Unfiled chats" (nightshift backlog 102).
    /// Its chats are unfiled even though the folder consolidation (114) gave
    /// it a folder, so a New chat in it is a Chat, not Claude Code. By
    /// source, never by name: he may rename it.
    pub fn is_unfiled_holder(&self) -> bool {
        self.source.as_deref() == Some(UNFILED_SOURCE)
    }
}

/// The `source` of the project a claude.ai import makes for its unfiled chats.
pub const UNFILED_SOURCE: &str = "claude:unfiled";

/// The named folders this user has, persisted in `~/.nightloom/projects.json`.
///
/// In the user's config dir rather than per-project, for the obvious reason
/// that a list of projects cannot live inside one of them.
#[derive(Debug, Clone)]
pub struct Registry {
    path: Option<PathBuf>,
    projects: Vec<Project>,
    /// Why this run may not write the file, when it may not: the file is
    /// there but could not be read (a full disk, iCloud stalled after sleep),
    /// so the empty list in memory is not what it holds, and saving it would
    /// wipe the projects (backlog 219). The next run reads it again.
    save_blocked: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct RegistryFile {
    #[serde(default = "schema_version")]
    version: u32,
    #[serde(default)]
    projects: Vec<Project>,
}

fn schema_version() -> u32 {
    1
}

impl Registry {
    /// Load from the user's config dir. A missing, unreadable or corrupt file
    /// is an empty registry, not an error — the first run has no projects, and
    /// a bad file should not make the app unusable. But an empty registry is
    /// never written over projects it could not see: see [`Registry::load_from`].
    pub fn load() -> Self {
        match config_dir().map(|d| d.join(REGISTRY_FILE)) {
            Some(path) => Self::load_from(path),
            None => Self {
                path: None,
                projects: Vec::new(),
                save_blocked: None,
            },
        }
    }

    /// Load the registry kept under a given config dir — what a job handed
    /// its config dir explicitly (the dream, a test on a temp dir) calls
    /// instead of [`Registry::load`], which asks the environment.
    pub fn load_in(config: &Path) -> Self {
        Self::load_from(config.join(REGISTRY_FILE))
    }

    /// Three ways to find no projects, and only the first may be saved over
    /// as it stands (backlog 219, after his app opened empty on a full disk):
    ///
    /// - no file: the first run, an empty registry;
    /// - a file that cannot be read: empty for this run, and no save this run
    ///   — the projects are still in it, and the next run reads them;
    /// - a file read but not parsed (cut short, emptied): moved aside to
    ///   `projects.json.broken-<time>`, kept, and the registry starts empty.
    ///   A move that fails blocks saving too, since the file is then the only
    ///   copy of whatever it holds.
    pub fn load_from(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let (projects, save_blocked) = match fs::read_to_string(&path) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => (Vec::new(), None),
            Err(e) => (
                Vec::new(),
                Some(format!(
                    "{} could not be read ({e}), so this run will not write over it — \
                     quit and reopen Nightloom to read it again",
                    path.display()
                )),
            ),
            Ok(raw) => match serde_json::from_str::<RegistryFile>(&raw) {
                Ok(f) => (f.projects, None),
                Err(_) => (Vec::new(), set_aside_broken(&path).err()),
            },
        };
        Self {
            path: Some(path),
            projects,
            save_blocked,
        }
    }

    /// Newest-opened first, which is the order a picker wants.
    pub fn projects(&self) -> Vec<Project> {
        let mut out = self.projects.clone();
        out.sort_by_key(|p| std::cmp::Reverse(p.last_opened));
        out
    }

    pub fn find(&self, id: &str) -> Option<&Project> {
        self.projects.iter().find(|p| p.id == id)
    }

    /// The project pointed at this folder, if one is.
    ///
    /// What both shells ask instead of hashing the path: the CLI to find out
    /// whose chats belong to the directory it was run in, the desktop to keep
    /// the file dialog from making a second project out of one folder.
    /// First match wins — the design permits two projects on one folder, and
    /// the one the picker lands on is simply the older of them.
    pub fn find_by_workspace(&self, root: impl AsRef<Path>) -> Option<&Project> {
        let root = normalize(root.as_ref());
        self.projects
            .iter()
            .find(|p| p.workspace.as_deref() == Some(root.as_path()))
    }

    /// Register a folder, or return the existing entry for it.
    ///
    /// Idempotent by *workspace* rather than by a hash of it: picking the same
    /// folder from the file dialog twice is not two projects, and erroring
    /// would be a worse answer than "you are already here". An explicit
    /// `name` on a second add renames. Deliberately making a second project
    /// on the same folder goes through [`Registry::create`], which is a
    /// different question and deserves a different call.
    pub fn add(&mut self, root: impl AsRef<Path>, name: Option<String>) -> Result<Project, String> {
        let root = normalize(root.as_ref());
        if !root.is_dir() {
            return Err(format!("{} is not a folder", root.display()));
        }
        let now = Utc::now();
        if let Some(existing) = self
            .projects
            .iter_mut()
            .find(|p| p.workspace.as_deref() == Some(root.as_path()))
        {
            if let Some(name) = name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()) {
                existing.name = name;
            }
            existing.last_opened = now;
            let out = existing.clone();
            self.save()?;
            return Ok(out);
        }
        let name = name
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| default_name(&root));
        self.create(name, Some(root), None)
    }

    /// The project an observation's `source` names, if one is registered.
    ///
    /// `remember` stamps an observation with the project's name when a
    /// project is open and with the workspace's folder name when none is
    /// (the CLI always sends the folder name — it has no open project). So
    /// the match is by name first, exact and then case-insensitive, and by
    /// the workspace's folder name last, so a terminal chat in a registered
    /// folder files into that project rather than into the vault. First
    /// match wins in registry order; two projects with one name is a state
    /// the registry permits and this does not try to disambiguate.
    pub fn find_by_name(&self, source: &str) -> Option<&Project> {
        let source = source.trim();
        if source.is_empty() {
            return None;
        }
        self.projects
            .iter()
            .find(|p| p.name == source)
            .or_else(|| {
                self.projects
                    .iter()
                    .find(|p| p.name.eq_ignore_ascii_case(source))
            })
            .or_else(|| {
                self.projects.iter().find(|p| {
                    p.workspace
                        .as_deref()
                        .and_then(Path::file_name)
                        .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(source))
                })
            })
    }

    /// The project imported from a given source, if one was.
    pub fn find_by_source(&self, source: &str) -> Option<&Project> {
        self.projects
            .iter()
            .find(|p| p.source.as_deref() == Some(source))
    }

    /// Make a project, whether or not it has a folder.
    ///
    /// Never idempotent — every call is a new project with a new id. That is
    /// what a second workstream on one folder needs, and what an import needs
    /// once it has established, via [`Registry::find_by_source`], that this is
    /// not a project it already made.
    pub fn create(
        &mut self,
        name: impl Into<String>,
        workspace: Option<PathBuf>,
        source: Option<String>,
    ) -> Result<Project, String> {
        let name = name.into().trim().to_string();
        if name.is_empty() {
            return Err("a project needs a name".to_string());
        }
        let now = Utc::now();
        let project = Project {
            id: new_id(),
            name,
            workspace,
            source,
            extra_folders: Vec::new(),
            created: now,
            last_opened: now,
        };
        // The stand-in workspace has to exist before anything roots a tool at
        // it or walks it for `AGENTS.md`; a real one was checked by `add`.
        if project.workspace.is_none() {
            let dir = project.workspace_dir();
            fs::create_dir_all(&dir)
                .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        }
        self.projects.push(project.clone());
        self.save()?;
        Ok(project)
    }

    pub fn rename(&mut self, id: &str, name: &str) -> Result<Project, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("a project needs a name".to_string());
        }
        let project = self
            .projects
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| format!("no project {id}"))?;
        project.name = name.to_string();
        let out = project.clone();
        self.save()?;
        Ok(out)
    }

    /// Replace a project's extra folders (nightshift backlog 143) — the
    /// whole list, so removing one is setting the list without it, as the
    /// prompt-layer edits are. Deduplicated in order; the home folder is
    /// dropped from it (it is not extra); a folder that is not a directory
    /// is refused, since a grant on nothing is a promise the tools break.
    pub fn set_extra_folders(
        &mut self,
        id: &str,
        folders: Vec<PathBuf>,
    ) -> Result<Project, String> {
        let project = self
            .projects
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| format!("no project {id}"))?;
        let home = project.workspace_dir();
        let mut kept: Vec<PathBuf> = Vec::new();
        for f in folders {
            if !f.is_dir() {
                return Err(format!("{} is not a folder", f.display()));
            }
            if f == home || kept.contains(&f) {
                continue;
            }
            kept.push(f);
        }
        project.extra_folders = kept;
        let out = project.clone();
        self.save()?;
        Ok(out)
    }

    /// Drop a project from the registry.
    ///
    /// Forgets, never deletes: the folder, its notes and its chats are all
    /// still there, and a registry entry is the one part of a project that
    /// Nightloom actually owns. Deleting a user's directory because they
    /// tidied a list would be indefensible.
    pub fn forget(&mut self, id: &str) -> Result<(), String> {
        let before = self.projects.len();
        self.projects.retain(|p| p.id != id);
        if self.projects.len() == before {
            return Err(format!("no project {id}"));
        }
        self.save()?;
        Ok(())
    }

    /// Record that a project was opened, for picker ordering.
    pub fn touch(&mut self, id: &str) {
        if let Some(p) = self.projects.iter_mut().find(|p| p.id == id) {
            p.last_opened = Utc::now();
            // Ordering only: see `save`. A picker that lists projects in a
            // stale order is not worth failing an open over.
            let _ = self.save();
        }
    }

    /// Write the registry, saying whether it landed.
    ///
    /// Two kinds of caller, and the difference is whether the user asked for
    /// the change. Ordering metadata — [`Registry::touch`] — is cosmetic, and
    /// failing "open project" because the config dir is read-only would be the
    /// wrong trade; that one still ignores the result. But a rename or a forget
    /// is a change the user made and watched succeed, and reporting success for
    /// one that reverts at the next start is the kind of quiet wrong this
    /// codebase spends its effort avoiding elsewhere.
    fn save(&self) -> Result<(), String> {
        let Some(path) = &self.path else {
            // No path is an in-memory registry, which is not a failure.
            return Ok(());
        };
        if let Some(why) = &self.save_blocked {
            return Err(format!(
                "the change was made for this run but not saved — {why}"
            ));
        }
        let file = RegistryFile {
            version: schema_version(),
            projects: self.projects.clone(),
        };
        let json = serde_json::to_string_pretty(&file)
            .map_err(|e| format!("cannot serialize the project registry: {e}"))?;
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        // Through a temp file and a rename: a write that fails (a full disk)
        // leaves the old file whole instead of empty (backlog 219).
        crate::nightshift::write_atomic(path, &json)
            .map_err(|e| format!("the change was made for this run but not saved — {e}"))
    }
}

/// Move a registry file that did not parse to `<name>.broken-<time>` beside
/// it, so the projects it may still hold survive the next save. A rename, not
/// a copy: it needs no free space, which is when files break.
fn set_aside_broken(path: &Path) -> Result<(), String> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| REGISTRY_FILE.to_string());
    let stamp = Utc::now().format("%Y%m%d-%H%M%S");
    let aside = path.with_file_name(format!("{name}.broken-{stamp}"));
    fs::rename(path, &aside).map_err(|e| {
        format!(
            "{} could not be read as a project list and could not be moved aside ({e}), \
             so this run will not write over it",
            path.display()
        )
    })
}

/// Overrides [`config_dir`] for the life of the process. See [`set_config_dir`].
static CONFIG_OVERRIDE: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// Point every path derived from the user's home somewhere else.
///
/// Set once per process and honoured ahead of `NIGHTLOOM_HOME` and the home
/// directory both. It exists for the test suite, which now writes session
/// logs and notes under the config dir and must not put them in the
/// developer's real `~/.nightloom` — an env var could not do that job, being
/// process-global state that parallel tests race on. Returns whether this
/// call was the one that set it.
pub fn set_config_dir(path: impl Into<PathBuf>) -> bool {
    CONFIG_OVERRIDE.set(path.into()).is_ok()
}

/// `~/.nightloom`: the user's own `AGENTS.md`, the project registry, and one
/// directory per project holding its chats and notes.
///
/// `NIGHTLOOM_HOME` overrides the location outright — for a portable install,
/// or to file it under whatever directory the user's other agent tools share.
/// It is taken as the directory itself, not as a home to append `.nightloom`
/// to, since somebody setting it has picked the path they want.
///
/// `None` when neither it nor `HOME` nor `USERPROFILE` is set, which is a real
/// state in a stripped environment and reads as "no user config".
pub fn config_dir() -> Option<PathBuf> {
    if let Some(path) = CONFIG_OVERRIDE.get() {
        return Some(path.clone());
    }
    if let Some(explicit) = std::env::var("NIGHTLOOM_HOME")
        .ok()
        .filter(|h| !h.is_empty())
    {
        return Some(PathBuf::from(explicit));
    }
    let home = std::env::var("HOME")
        .ok()
        .filter(|h| !h.is_empty())
        .or_else(|| std::env::var("USERPROFILE").ok().filter(|h| !h.is_empty()))?;
    Some(Path::new(&home).join(DOT_DIR))
}

/// A folder's name, or its full path when it has none (a drive root).
fn default_name(root: &Path) -> String {
    root.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| root.display().to_string())
}

/// A folder name for a project's name: `Value Generalization` becomes
/// `Value-Generalization`.
///
/// Letters, digits, `-` and `_` are kept; every other run of characters
/// becomes one `-`; leading and trailing dashes go; the result is cut at
/// [`SLUG_LIMIT`]. One rule for the two writers that turn a name into a
/// folder — the claude.ai importer and the desktop's New project form — so
/// an imported project and a typed one sit side by side spelled the same way.
///
/// **Empty when nothing survives** (a name of punctuation). The importer
/// substitutes `project`; the form disables Create and says why, since a
/// folder the user did not name is not what they asked for.
pub fn slug(name: &str) -> String {
    let mut slug = String::new();
    let mut gap = false;
    for ch in name.chars() {
        if ch.is_alphanumeric() || ch == '-' || ch == '_' {
            if gap && !slug.is_empty() {
                slug.push('-');
            }
            gap = false;
            slug.push(ch);
        } else {
            gap = true;
        }
        if slug.chars().count() > SLUG_LIMIT {
            break;
        }
    }
    // Cut after the loop rather than in it: a gap and its letter land as
    // two characters at once, and the importer's in-loop check let a long
    // name run one past the limit.
    let cut: String = slug.chars().take(SLUG_LIMIT).collect();
    cut.trim_matches('-').to_string()
}

// ---- the projects folder ----

/// The one-key file recording a repointed projects folder. The vault's
/// `knowledge.json` shape, for the same reasons: absent means the default,
/// and the path is kept as chosen so a folder on an unmounted drive survives
/// being read and written back.
#[derive(Serialize, Deserialize)]
struct ProjectsFolderFile {
    #[serde(default = "schema_version")]
    version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dir: Option<PathBuf>,
}

/// Where a new project's folder goes when the form is not told otherwise.
///
/// The setting if one is recorded, else [`default_projects_folder`]. `None`
/// only when there is no user config dir at all.
pub fn projects_folder(registry: &Registry) -> Option<PathBuf> {
    config_dir().map(|config| projects_folder_in(&config, registry))
}

/// The projects folder for a given config dir — the override if one is
/// recorded, else the default worked out from the registry.
pub fn projects_folder_in(config: &Path, registry: &Registry) -> PathBuf {
    read_projects_folder(config).unwrap_or_else(|| default_projects_folder(registry))
}

/// Whether new projects go where they would with nothing configured. The
/// Settings pane says so, and it is what Reset to default switches off.
pub fn is_default_projects_folder_in(config: &Path) -> bool {
    read_projects_folder(config).is_none()
}

fn read_projects_folder(config: &Path) -> Option<PathBuf> {
    let text = fs::read_to_string(config.join(PROJECTS_FOLDER_FILE)).ok()?;
    let parsed: ProjectsFolderFile = serde_json::from_str(&text).ok()?;
    parsed.dir.filter(|d| !d.as_os_str().is_empty())
}

/// The folder new projects go in when nothing is configured.
///
/// The registry is the hint: the parent of the most recently *created*
/// project whose workspace sits in a folder literally named `projects` —
/// which is where a claude.ai import put its projects, and where the user
/// has been keeping them since. A project registered from some other place
/// (a repository checked out elsewhere) says nothing about where new ones
/// should go, so it is skipped rather than allowed to move the default.
/// With no such project: `~/Documents/Nightloom/projects`.
pub fn default_projects_folder(registry: &Registry) -> PathBuf {
    let hinted = registry
        .projects
        .iter()
        .filter_map(|p| {
            let parent = p.workspace.as_deref()?.parent()?;
            (parent.file_name()? == "projects").then(|| (p.created, parent.to_path_buf()))
        })
        .max_by_key(|(created, _)| *created)
        .map(|(_, parent)| parent);
    hinted.unwrap_or_else(|| {
        let base = home_dir().unwrap_or_else(std::env::temp_dir);
        DEFAULT_PROJECTS_FOLDER
            .iter()
            .fold(base, |dir, part| dir.join(part))
    })
}

/// Point new projects at `dir`, or back at the default with `None`.
///
/// Writes only the setting. **Moves nothing**: the projects already made are
/// registered by their own paths and stay where they are, and a folder is
/// not a migration.
pub fn set_projects_folder(dir: Option<&Path>) -> Result<(), String> {
    let config =
        config_dir().ok_or_else(|| "no user config directory to record it in".to_string())?;
    set_projects_folder_in(&config, dir)
}

pub fn set_projects_folder_in(config: &Path, dir: Option<&Path>) -> Result<(), String> {
    let path = config.join(PROJECTS_FOLDER_FILE);
    // Back to the default is the absence of the file, as the vault does it.
    let Some(dir) = dir else {
        return match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("cannot clear {}: {e}", path.display())),
        };
    };
    if dir.as_os_str().is_empty() {
        return Err("the projects folder cannot be empty".to_string());
    }
    fs::create_dir_all(config).map_err(|e| format!("cannot create {}: {e}", config.display()))?;
    let file = ProjectsFolderFile {
        version: schema_version(),
        dir: Some(normalize(dir)),
    };
    let text = serde_json::to_string_pretty(&file)
        .map_err(|e| format!("cannot encode the projects folder: {e}"))?;
    fs::write(&path, text).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// `$HOME` (or `%USERPROFILE%`), for the default projects folder. Not the
/// config dir's parent: `NIGHTLOOM_HOME` moves the config dir, not Documents.
fn home_dir() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .filter(|h| !h.is_empty())
        .or_else(|| std::env::var("USERPROFILE").ok().filter(|h| !h.is_empty()))
        .map(PathBuf::from)
}

/// Where a new project's folder would go for a given name: the slug, and
/// the path under the projects folder. What the form shows live as the name
/// is typed, computed here rather than in the webview so the preview and the
/// folder Create makes cannot disagree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct NewProjectPath {
    /// `<projects folder>/<slug>`; empty when the slug is.
    pub path: PathBuf,
    /// Empty when the name has no letter or digit in it — the form's reason
    /// for disabling Create.
    pub slug: String,
    /// The projects folder the path was made under.
    pub folder: PathBuf,
}

impl NewProjectPath {
    pub fn resolve(name: &str, folder: &Path) -> Self {
        let slug = slug(name);
        let path = if slug.is_empty() {
            PathBuf::new()
        } else {
            folder.join(&slug)
        };
        Self {
            path,
            slug,
            folder: folder.to_path_buf(),
        }
    }
}

/// Where the New project form puts the folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NewProjectFolder {
    /// `<projects folder>/<slug>` — made by Create, and refused if something
    /// non-empty is already there.
    Resolved(PathBuf),
    /// A folder the user chose through the picker for "I already have work
    /// somewhere". Existing files are the point, so they are no error.
    Picked(PathBuf),
}

impl Registry {
    /// The New project form's Create: make the folder, write `AGENTS.md`
    /// when instructions were given, register under the typed name.
    ///
    /// Everything is checked before anything is written, so a refusal leaves
    /// no half-made project behind: a resolved folder that already holds
    /// files is refused (it is somebody's work — Open project… is for that),
    /// a picked folder already registered is refused by name (opening it is
    /// one row away in ⌘P, and a second project on the folder is a thing
    /// nobody asks for by accident), and instructions are never written over
    /// an `AGENTS.md` a picked folder already has.
    pub fn new_project(
        &mut self,
        name: &str,
        folder: NewProjectFolder,
        instructions: Option<&str>,
    ) -> Result<Project, String> {
        let name = name.trim();
        if name.is_empty() {
            return Err("a project needs a name".to_string());
        }
        let (dir, picked) = match folder {
            NewProjectFolder::Resolved(dir) => (dir, false),
            NewProjectFolder::Picked(dir) => (dir, true),
        };
        if dir.as_os_str().is_empty() {
            return Err(
                "the name needs at least one letter or digit to make a folder from".to_string(),
            );
        }
        let dir = normalize(&dir);
        if dir.is_file() {
            return Err(format!("{} is a file, not a folder", dir.display()));
        }
        if !picked
            && dir.is_dir()
            && fs::read_dir(&dir)
                .map(|mut d| d.next().is_some())
                .unwrap_or(true)
        {
            return Err(format!(
                "{} already exists and is not empty — Open project… opens a folder you already have, or choose another name",
                dir.display()
            ));
        }
        if let Some(existing) = self.find_by_workspace(&dir) {
            return Err(format!(
                "{} is already the project \"{}\" — Open project… opens it",
                dir.display(),
                existing.name
            ));
        }
        let instructions = instructions.map(str::trim).filter(|t| !t.is_empty());
        let agents = dir.join(crate::prompt::INSTRUCTION_FILE);
        if instructions.is_some() && agents.exists() {
            return Err(format!(
                "{} already has an AGENTS.md — clear the instructions here and edit that one after opening",
                dir.display()
            ));
        }
        fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
        // Normalized again now that it exists: `normalize` canonicalizes only
        // a path that is there, and the registry compares canonical paths
        // (`/var/…` is `/private/var/…` on macOS once it can be resolved).
        let dir = normalize(&dir);
        let agents = dir.join(crate::prompt::INSTRUCTION_FILE);
        if let Some(text) = instructions {
            let mut text = text.to_string();
            text.push('\n');
            fs::write(&agents, text)
                .map_err(|e| format!("cannot write {}: {e}", agents.display()))?;
        }
        self.create(name, Some(dir), None)
    }
}

/// Absolute, canonical where possible, and without Windows' verbatim prefix.
///
/// Canonicalizing is what makes the id stable across the several spellings of
/// one folder — a trailing `.`, a different case, a path through a symlink all
/// have to be the same project, or the registry fills with duplicates that
/// each list a different subset of the same chats. Stripping the verbatim
/// prefix afterwards is not cosmetic: that form is shown in the UI, handed to
/// the file tools as a root, and compared against paths the model types, none
/// of which would ever match it.
pub fn normalize(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    strip_verbatim(fs::canonicalize(&absolute).unwrap_or(absolute))
}

/// Undo `canonicalize`'s `\\?\` (and `\\?\UNC\`) prefixes on Windows; a no-op
/// everywhere else, since no other platform produces them.
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    let verbatim_unc = concat!(r"\\", r"?\UNC\");
    let verbatim = concat!(r"\\", r"?\");
    if let Some(rest) = text.strip_prefix(verbatim_unc) {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(verbatim) {
        return PathBuf::from(rest.to_string());
    }
    path
}

/// FNV-1a over the path, hand-rolled rather than taken from `DefaultHasher`.
///
/// The id is written to a config file and has to mean the same thing next
/// week: `DefaultHasher`'s output is explicitly not guaranteed stable across
/// releases, so persisting it would silently orphan every project on a
/// toolchain bump. Case is folded because Windows and macOS both treat
/// `C:\Dev` and `C:\dev` as one directory, and two entries for it would each
/// see the same files.
fn path_id(root: &Path) -> String {
    let text = root.to_string_lossy().to_lowercase().replace('\\', "/");
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// `~/.nightloom/projects/<id>`, the directory holding what Nightloom keeps
/// for one project.
///
/// Falls back to a temp-adjacent path only when there is no home at all, which
/// `config_dir` already reports as `None` and which is a real state in a
/// stripped environment. Degrading beats failing: a project that cannot find
/// somewhere to log a chat should still hold a conversation.
pub fn store_dir(id: &str) -> PathBuf {
    let base = config_dir().unwrap_or_else(|| std::env::temp_dir().join(DOT_DIR));
    base.join(PROJECTS_DIR).join(id)
}

/// The store for a folder that no project claims.
///
/// The CLI runs wherever it is run, usually in a folder nobody has registered,
/// and its chats have to go somewhere that is still *that folder's* chats
/// tomorrow. So an unclaimed folder gets an ad-hoc store keyed by its path —
/// the old identity scheme, kept for exactly the case it was right for. Once a
/// project claims the folder, [`Registry::find_by_workspace`] answers instead
/// and this is not consulted.
pub fn store_for(root: &Path) -> PathBuf {
    store_dir(&path_id(&normalize(root)))
}

/// A fresh project id.
///
/// A uuid rather than a slug of the name, because two claude.ai projects can
/// share a name and are still two projects.
fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// What [`migrate`] moved.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Migrated {
    pub sessions: usize,
    pub notes: usize,
    /// Files left behind because something of that name was already in the
    /// store, or because the move itself failed. Named rather than counted:
    /// the whole point of not overwriting is that the user can go and look.
    pub skipped: Vec<String>,
}

impl Migrated {
    pub fn is_empty(&self) -> bool {
        self.sessions == 0 && self.notes == 0 && self.skipped.is_empty()
    }

    /// One line for a shell to print, or `None` when nothing moved.
    pub fn summary(&self) -> Option<String> {
        if self.is_empty() {
            return None;
        }
        let mut parts = Vec::new();
        if self.sessions > 0 {
            parts.push(format!("{} session log(s)", self.sessions));
        }
        if self.notes > 0 {
            parts.push(format!("{} note(s)", self.notes));
        }
        let moved = if parts.is_empty() {
            "nothing".to_string()
        } else {
            parts.join(" and ")
        };
        let mut line =
            format!("moved {moved} out of .nightloom/ — chats to ~/.nightloom, notes to .agents/");
        if !self.skipped.is_empty() {
            line.push_str(&format!(
                "; left {} in place ({})",
                self.skipped.len(),
                self.skipped.join(", ")
            ));
        }
        Some(line)
    }
}

/// Move a folder laid out the old way: `.nightloom/sessions` into the store,
/// `.nightloom/notes` into `.agents`.
///
/// Idempotent and cheap to call — one `stat` when there is nothing to do — so
/// a shell can run it every time it opens a folder rather than remembering
/// whether it has. Three rules, all of them the conservative reading:
///
/// * **Nothing already at the destination is overwritten.** A name that
///   collides is left where it is and reported, on the same argument the
///   importer makes: a docspace is a working directory, and a migration that
///   could undo a week of notes would be worse than no migration.
/// * **`mcp.json` and anything else in `.nightloom/` stays.** Only the two
///   directories that moved are touched, and the dot directory itself is
///   removed only if the OS agrees it is empty.
/// * **A file that cannot be moved is left, not lost.** `rename` across
///   volumes fails, so a copy-then-remove fallback runs; if the copy fails the
///   original stays put and lands in `skipped`.
///
/// Keyed on the *folder*, not on a `Project`, because it has to run for a
/// folder nobody has registered — which is every folder the CLI is run in.
pub fn migrate(root: &Path) -> Migrated {
    let mut out = Migrated::default();
    let legacy = root.join(DOT_DIR);
    if !legacy.is_dir() {
        return out;
    }
    let store = store_for(root);
    // The two halves go to different places, which is the whole shape of the
    // layout: chats out of the folder entirely, notes back into it under the
    // name they should have had.
    for (sub, to, counter) in [
        (SESSIONS_DIR, store.join(SESSIONS_DIR), &mut out.sessions),
        (NOTES_DIR, root.join(AGENTS_DIR), &mut out.notes),
    ] {
        let from = legacy.join(sub);
        if !from.is_dir() {
            continue;
        }
        if fs::create_dir_all(&to).is_err() {
            out.skipped.push(format!("{sub}/"));
            continue;
        }
        move_tree(&from, &to, sub, counter, &mut out.skipped);
        // Only when the OS agrees it is empty — a subdirectory the user made
        // in their own notes folder is theirs, and so is whatever was left
        // behind by a collision.
        let _ = fs::remove_dir(&from);
    }
    let _ = fs::remove_dir(&legacy);
    out
}

/// Move every file under `from` into `to`, preserving relative layout.
fn move_tree(from: &Path, to: &Path, label: &str, moved: &mut usize, skipped: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(from) else {
        skipped.push(format!("{label}/"));
        return;
    };
    for entry in entries.flatten() {
        let source = entry.path();
        let Some(name) = source.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        let target = to.join(&name);
        // The entry's own type, not what it points at (review 2026-09-17
        // FC-f, nightshift backlog 134): `is_dir` follows a symlink, and a
        // link to a directory elsewhere would have had *that* directory's
        // files moved into the project. A link is moved whole — `rename`
        // moves the link, not its target — or, across volumes, left where
        // it is and named in `skipped`, since a copy would follow it.
        let Ok(kind) = entry.file_type() else {
            skipped.push(format!("{label}/{name}"));
            continue;
        };
        if kind.is_symlink() {
            if target.symlink_metadata().is_ok() {
                skipped.push(format!("{label}/{name}"));
            } else if fs::rename(&source, &target).is_ok() {
                *moved += 1;
            } else {
                skipped.push(format!("{label}/{name}"));
            }
            continue;
        }
        if kind.is_dir() {
            if fs::create_dir_all(&target).is_err() {
                skipped.push(format!("{label}/{name}/"));
                continue;
            }
            move_tree(&source, &target, &format!("{label}/{name}"), moved, skipped);
            let _ = fs::remove_dir(&source);
            continue;
        }
        if target.exists() {
            skipped.push(format!("{label}/{name}"));
            continue;
        }
        // `rename` is atomic and cheap on one volume and fails across two,
        // which a home directory on a different drive from the work is.
        if fs::rename(&source, &target).is_ok() {
            *moved += 1;
            continue;
        }
        match fs::copy(&source, &target) {
            Ok(_) => {
                // The copy is the migration; failing to remove the original
                // leaves a duplicate, which is the safe direction to fail in.
                let _ = fs::remove_file(&source);
                *moved += 1;
            }
            Err(_) => {
                let _ = fs::remove_file(&target);
                skipped.push(format!("{label}/{name}"));
            }
        }
    }
}

// ---- the docspace ----

/// One file in a project's notes directory.
#[derive(Debug, Clone, Serialize)]
pub struct Note {
    /// Path relative to the notes directory, always with `/` separators, so a
    /// note names the same file whichever platform wrote it down.
    pub name: String,
    pub bytes: u64,
    pub modified: DateTime<Utc>,
    /// First heading or first non-empty line. `None` for a file that is not
    /// UTF-8 text, which is still listed rather than hidden — something the
    /// user dropped in the folder is theirs to see.
    pub summary: Option<String>,
}

/// Every note in the docspace, name-sorted.
///
/// A missing directory is an empty list. The docspace is created on first
/// write, not on project creation: a project nobody has written a note in
/// should not have an empty folder planted in it.
pub fn list_notes(dir: &Path) -> Vec<Note> {
    let mut out = Vec::new();
    walk_notes(dir, dir, 0, &mut out);
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out.truncate(NOTE_LIMIT);
    out
}

/// Ceiling on the counting walk. Far above [`NOTE_LIMIT`] because counting is
/// a `read_dir` and a metadata check per entry with none of the 512-byte
/// summary probes, and because the number this produces is *stated* — one that
/// stops early has to say so rather than quietly shrink the vault.
const COUNT_LIMIT: usize = 50_000;

/// How many notes sit in each folder, keyed by the folder prefix (`""` for the
/// vault root, else `people/`). The `bool` is whether the walk saw everything.
///
/// This exists because [`list_notes`] cannot answer the question. It stops at
/// [`NOTE_LIMIT`] **mid-walk**, in whatever order the filesystem handed
/// directories back, so its length is not the size of the vault and whole
/// folders can be absent from it with nothing saying so. That was survivable
/// while the index was a flat list openly admitting it was cut. It stopped
/// being survivable the moment the index began stating a total and a count per
/// folder, because a wrong number in a system prompt is not a shorter answer
/// than a missing one — it is a fact the model has no reason to doubt and no
/// way to check. Measured: a vault of 204 notes reported 200 and omitted an
/// entire folder from the map.
pub fn note_counts(dir: &Path) -> (BTreeMap<String, usize>, bool) {
    let mut counts = BTreeMap::new();
    let mut seen = 0usize;
    let exhaustive = walk_counts(dir, dir, 0, &mut counts, &mut seen);
    (counts, exhaustive)
}

fn walk_counts(
    base: &Path,
    dir: &Path,
    depth: usize,
    counts: &mut BTreeMap<String, usize>,
    seen: &mut usize,
) -> bool {
    if depth > NOTE_DEPTH {
        // The depth bound is the same one `list_notes` walks under, so a note
        // deeper than the index ever reaches is not one this count should
        // claim either. Not a truncation of the walk — a definition of it.
        return true;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return true;
    };
    for entry in entries.flatten() {
        if *seen >= COUNT_LIMIT {
            return false;
        }
        if hidden(&entry) {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            if !walk_counts(base, &path, depth + 1, counts, seen) {
                return false;
            }
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        let Ok(relative) = path.strip_prefix(base) else {
            continue;
        };
        let name = relative.to_string_lossy().replace('\\', "/");
        let prefix = match name.rfind('/') {
            Some(cut) => name[..=cut].to_string(),
            None => String::new(),
        };
        *counts.entry(prefix).or_insert(0) += 1;
        *seen += 1;
    }
    true
}

/// Whether a directory entry is machinery rather than a note.
///
/// Dot-entries are excluded from both walks: `.git` once the vault is under
/// version control (which the dream pass itself recommends), `.obsidian` and
/// `.trash` in a real Obsidian vault, `.DS_Store`. Found on a screenshot, not
/// in review — the first `git init`-ed vault listed forty entries of git
/// plumbing as notes, and an Obsidian vault had been quietly indexing its
/// workspace config into the system prompt all along. The file tools can
/// still *reach* a hidden path when asked by name; it is the index and the
/// counts that must not present machinery as knowledge.
fn hidden(entry: &fs::DirEntry) -> bool {
    entry.file_name().to_string_lossy().starts_with('.')
}

fn walk_notes(base: &Path, dir: &Path, depth: usize, out: &mut Vec<Note>) {
    if depth > NOTE_DEPTH || out.len() >= NOTE_LIMIT {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    // In name order, not the filesystem's: APFS hands entries back sorted
    // and ext4 does not, so which notes survive the cap mid-walk differed
    // between a Mac and CI's Linux runner (the vault-folders test) — and a
    // listing that depends on the disk's hash order is not a listing.
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        if hidden(&entry) {
            continue;
        }
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            walk_notes(base, &path, depth + 1, out);
            continue;
        }
        if !meta.is_file() {
            continue;
        }
        let Ok(relative) = path.strip_prefix(base) else {
            continue;
        };
        out.push(Note {
            name: relative.to_string_lossy().replace('\\', "/"),
            bytes: meta.len(),
            modified: meta
                .modified()
                .map(DateTime::<Utc>::from)
                .unwrap_or_else(|_| Utc::now()),
            summary: summarize(&path),
        });
        if out.len() >= NOTE_LIMIT {
            return;
        }
    }
}

/// A note's one-line gist: its first Markdown heading if it has one, else its
/// first non-empty line. Read from the head of the file only — the index has
/// to stay cheap enough to build on every connect.
fn summarize(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut buf = vec![0u8; SUMMARY_PROBE];
    let read = fs::File::open(path).ok()?.read(&mut buf).ok()?;
    summary_of(&String::from_utf8_lossy(&buf[..read]))
}

/// A note's one-line summary from its opening bytes: the front matter's
/// `description:` when it has one, else the first heading or non-empty
/// line after it. Backlog 217: every note in his vault opens with a `---`
/// front-matter fence, and the index listed each one as `— ---`.
/// A fence still open at the end of the probe yields its description or
/// nothing — never a front-matter key read as prose.
pub(crate) fn summary_of(text: &str) -> Option<String> {
    let mut lines = text.lines().map(str::trim).skip_while(|l| l.is_empty());
    let mut first = lines.next()?;
    if first == "---" {
        let mut description = None;
        let mut closed = false;
        for line in lines.by_ref() {
            if line == "---" || line == "..." {
                closed = true;
                break;
            }
            if let Some(v) = line.strip_prefix("description:") {
                let v = v.trim().trim_matches(|c| c == '"' || c == '\'');
                if !v.is_empty() {
                    description = Some(v.to_string());
                }
            }
        }
        if let Some(d) = description {
            return Some(d.chars().take(120).collect());
        }
        if !closed {
            return None;
        }
        first = lines.find(|l| !l.is_empty() && !is_rule(l))?;
    }
    let line = first.trim_start_matches('#').trim();
    if line.is_empty() || is_rule(line) {
        return None;
    }
    Some(line.chars().take(120).collect())
}

/// A Markdown thematic break (`---`, `***`, `___`, three or more): a
/// divider, never a summary.
fn is_rule(line: &str) -> bool {
    let t: String = line.chars().filter(|c| !c.is_whitespace()).collect();
    t.len() >= 3 && ['-', '*', '_'].iter().any(|&m| t.chars().all(|c| c == m))
}

/// Resolve a note name against the docspace, refusing anything outside it.
///
/// Reuses the file tools' [`Root`] rather than checking the name here: the
/// containment argument is subtle (lexical normalization *and* a symlink check
/// on the deepest existing ancestor), it is already written down once, and a
/// second hand-rolled version of it is exactly the thing that ends up missing
/// one of the two halves.
fn note_path(dir: &Path, name: &str) -> Result<PathBuf, String> {
    let root = Root::new(dir);
    let path = root.resolve(name.trim())?;
    if path == root.path() {
        return Err("that is the notes folder itself, not a note".to_string());
    }
    Ok(path)
}

/// The file a note name names under `dir`, checked as every note command
/// checks it — for the note editor (nightshift backlog 151), whose model
/// is given this one path and no other.
pub fn note_file(dir: &Path, name: &str) -> Result<PathBuf, String> {
    note_path(dir, name)
}

pub fn read_note(dir: &Path, name: &str) -> Result<String, String> {
    let path = note_path(dir, name)?;
    fs::read_to_string(&path).map_err(|e| format!("cannot read {name}: {e}"))
}

/// Write a note, creating the docspace and any subdirectory on the way.
pub fn write_note(dir: &Path, name: &str, content: &str) -> Result<Note, String> {
    let path = note_path(dir, name)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    fs::write(&path, content).map_err(|e| format!("cannot write {name}: {e}"))?;
    let meta = fs::metadata(&path).map_err(|e| format!("cannot stat {name}: {e}"))?;
    Ok(Note {
        name: name.trim().replace('\\', "/"),
        bytes: meta.len(),
        modified: meta
            .modified()
            .map(DateTime::<Utc>::from)
            .unwrap_or_else(|_| Utc::now()),
        summary: summarize(&path),
    })
}

pub fn delete_note(dir: &Path, name: &str) -> Result<(), String> {
    let path = note_path(dir, name)?;
    fs::remove_file(&path).map_err(|e| format!("cannot delete {name}: {e}"))
}

/// Open a path in the platform's file manager.
///
/// Here rather than in a shell because both shells want it and neither should
/// be writing per-OS process spawning of its own. Not a tool: nothing the
/// model asks for opens a window on the user's desktop.
pub fn reveal(path: &Path) -> io::Result<()> {
    let program = if cfg!(target_os = "windows") {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    // `explorer` exits non-zero even when it succeeded, so the status is
    // deliberately not checked on any platform — spawning is the whole test.
    std::process::Command::new(program).arg(path).spawn()?;
    Ok(())
}

/// Show one file in the platform's file manager, selected — `open -R` on
/// macOS, `explorer /select,` on Windows. Linux file managers have no common
/// "select this file" verb, so the parent folder opens instead.
///
/// Distinct from `reveal`, which opens a *folder* (and creates it when it is
/// missing): a file card's Reveal must never create anything, and `open` on
/// a file path would launch its application rather than show it.
pub fn reveal_file(path: &Path) -> io::Result<()> {
    if cfg!(target_os = "macos") {
        std::process::Command::new("open")
            .arg("-R")
            .arg(path)
            .spawn()?;
    } else if cfg!(target_os = "windows") {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path.display()))
            .spawn()?;
    } else {
        let parent = path.parent().unwrap_or(path);
        std::process::Command::new("xdg-open").arg(parent).spawn()?;
    }
    Ok(())
}

/// Open a web page in the user's browser. `https://` only: the string comes
/// from a model's reply, and the platform openers will happily launch a
/// `file:` or a custom scheme, which is not what a link card is for.
pub fn open_url(url: &str) -> io::Result<()> {
    if !url.starts_with("https://") {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "only https:// links open from a card",
        ));
    }
    let program = if cfg!(target_os = "windows") {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    std::process::Command::new(program).arg(url).spawn()?;
    Ok(())
}

/// A file a reply named that turned out to exist (nightshift backlog 078):
/// the path as the card should open it, and its size for the label.
#[derive(Debug, Clone, Serialize)]
pub struct NamedFile {
    pub path: String,
    pub size: u64,
}

/// Which of a reply's path candidates are real files. One answer per
/// candidate, in order, `None` for anything that is not an existing regular
/// file — a folder, a broken link, a path the model made up. `~/` is
/// expanded here because the frontend has no home directory to expand it
/// with. Nothing is read but the metadata.
pub fn named_files(paths: &[String]) -> Vec<Option<NamedFile>> {
    let home = home_dir();
    paths
        .iter()
        .map(|p| {
            let expanded = match (p.strip_prefix("~/"), &home) {
                (Some(rest), Some(h)) => h.join(rest),
                (Some(_), None) => return None,
                (None, _) => PathBuf::from(p),
            };
            if !expanded.is_absolute() {
                return None;
            }
            let meta = fs::metadata(&expanded).ok()?;
            if !meta.is_file() {
                return None;
            }
            Some(NamedFile {
                path: expanded.to_string_lossy().into_owned(),
                size: meta.len(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn temp_dir(label: &str) -> PathBuf {
        // Same reason as `tools::test_dir`: a store path is derived from the
        // config dir, and a test must not write into the real one.
        set_config_dir(std::env::temp_dir().join(format!("nightloom-home-{}", std::process::id())));
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "nightloom-project-{label}-{}-{n}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn named_files_answers_only_for_a_real_regular_file() {
        // The card's rule (nightshift backlog 078): a folder, a missing path
        // and a relative path all stay text; only a file that exists gets a
        // card, with its size.
        let dir = temp_dir("named");
        let file = dir.join("report.md");
        fs::write(&file, "hello").unwrap();
        let answers = named_files(&[
            file.to_string_lossy().into_owned(),
            dir.to_string_lossy().into_owned(),
            dir.join("made-up.md").to_string_lossy().into_owned(),
            "notes/relative.md".to_string(),
        ]);
        assert_eq!(answers.len(), 4);
        let found = answers[0].as_ref().expect("the file exists");
        assert_eq!(found.size, 5);
        assert_eq!(Path::new(&found.path), file);
        assert!(answers[1].is_none(), "a folder is not a file card");
        assert!(answers[2].is_none(), "a made-up path stays text");
        assert!(
            answers[3].is_none(),
            "a relative path is the frontend's to resolve"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn chats_live_outside_the_folder_and_notes_live_in_it() {
        let dir = temp_dir("layout");
        let mut reg = Registry::load_from(dir.join("registry.json"));
        let project = reg.add(&dir, None).unwrap();

        // The split the whole design turns on: a transcript is never inside
        // the tree the file tools are rooted at, and a note always is.
        assert!(!project.session_dir().starts_with(&dir));
        assert_eq!(project.workspace_dir(), normalize(&dir));
        assert_eq!(project.notes_dir(), normalize(&dir).join(AGENTS_DIR));
        assert!(project.notes_dir().starts_with(project.workspace_dir()));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_project_needs_no_folder() {
        let dir = temp_dir("folderless");
        let mut reg = Registry::load_from(dir.join("registry.json"));
        // What an imported claude.ai project is: a name, some documents and
        // some conversations, and no code anywhere.
        let project = reg.create("Thesis", None, None).unwrap();

        assert!(project.workspace.is_none());
        assert!(project.exists(), "nothing to be missing");
        // It still gets a workspace, so everything downstream — tool rooting,
        // AGENTS.md discovery, the notes index — has one case and not two.
        assert!(project.workspace_dir().is_dir());
        assert_eq!(
            project.notes_dir(),
            project.workspace_dir().join(AGENTS_DIR)
        );
        assert!(!project.session_dir().starts_with(project.workspace_dir()));
        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(project.store_dir()).ok();
    }

    #[test]
    fn two_projects_can_share_one_folder_but_the_picker_makes_only_one() {
        let dir = temp_dir("share");
        let mut reg = Registry::load_from(dir.join("registry.json"));

        // The file dialog is idempotent: picking the same folder twice is one
        // project, which is what the path-derived id used to buy for free.
        let first = reg.add(&dir, None).unwrap();
        let again = reg.add(&dir, None).unwrap();
        assert_eq!(first.id, again.id);

        // Asking for a second one deliberately is a different call, and gets
        // a project of its own — impossible while identity was the path.
        let second = reg
            .create("Second workstream", Some(normalize(&dir)), None)
            .unwrap();
        assert_ne!(first.id, second.id);
        assert_ne!(first.session_dir(), second.session_dir());
        assert_eq!(
            reg.find_by_workspace(&dir).map(|p| p.id.clone()),
            Some(first.id)
        );
        fs::remove_dir_all(&dir).ok();
    }

    /// A registry written before projects had an identity of their own.
    #[test]
    fn an_old_entry_keeps_its_id_and_its_folder() {
        let dir = temp_dir("legacy-registry");
        let path = dir.join("projects.json");
        let entry = Project {
            id: "b7815b022ba43238".to_string(),
            name: "Old".to_string(),
            workspace: Some(normalize(&dir)),
            source: None,
            extra_folders: Vec::new(),
            created: Utc::now(),
            last_opened: Utc::now(),
        };
        // Written under the old field name, which is the point of the test.
        let raw = serde_json::to_string(&entry)
            .unwrap()
            .replace("workspace", "root");
        fs::write(&path, format!(r#"{{"version":1,"projects":[{raw}]}}"#)).unwrap();

        let reg = Registry::load_from(&path);
        let project = &reg.projects()[0];
        // The id is kept rather than re-derived: it addresses a store full of
        // chats, and regenerating it would orphan exactly what this change
        // exists to stop orphaning.
        assert_eq!(project.id, "b7815b022ba43238");
        assert_eq!(
            project.workspace.as_deref(),
            Some(normalize(&dir).as_path())
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn migration_moves_the_old_layout_and_leaves_config_alone() {
        let dir = temp_dir("migrate");
        let legacy = dir.join(DOT_DIR);
        fs::create_dir_all(legacy.join(SESSIONS_DIR)).unwrap();
        fs::create_dir_all(legacy.join(NOTES_DIR).join("sub")).unwrap();
        fs::write(
            legacy.join(SESSIONS_DIR).join("a.jsonl"),
            "{}
",
        )
        .unwrap();
        fs::write(legacy.join(NOTES_DIR).join("plan.md"), "# plan").unwrap();
        fs::write(legacy.join(NOTES_DIR).join("sub").join("deep.md"), "deep").unwrap();
        fs::write(legacy.join("mcp.json"), "{}").unwrap();

        let moved = migrate(&dir);
        assert_eq!(moved.sessions, 1);
        assert_eq!(moved.notes, 2, "a nested note is still a note");
        assert!(moved.skipped.is_empty(), "{:?}", moved.skipped);

        // The two halves go different ways: chats out of the folder, notes
        // back into it under the name they should have had.
        let store = store_for(&dir);
        assert!(store.join(SESSIONS_DIR).join("a.jsonl").is_file());
        assert_eq!(
            fs::read_to_string(dir.join(AGENTS_DIR).join("sub").join("deep.md")).unwrap(),
            "deep"
        );
        // Configuration stays in the folder, and so therefore does the dot
        // directory holding it.
        assert!(legacy.join("mcp.json").is_file());
        assert!(!legacy.join(SESSIONS_DIR).exists());

        // Idempotent: a second open must not report a migration that already
        // happened, or every launch would announce one.
        assert!(migrate(&dir).is_empty());
        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(&store).ok();
    }

    #[test]
    fn migration_never_overwrites_what_is_already_in_the_store() {
        let dir = temp_dir("migrate-collide");
        let legacy = dir.join(DOT_DIR);
        fs::create_dir_all(legacy.join(NOTES_DIR)).unwrap();
        fs::write(legacy.join(NOTES_DIR).join("plan.md"), "old").unwrap();

        fs::create_dir_all(dir.join(AGENTS_DIR)).unwrap();
        fs::write(dir.join(AGENTS_DIR).join("plan.md"), "current").unwrap();

        let moved = migrate(&dir);
        assert_eq!(moved.notes, 0);
        assert_eq!(moved.skipped, vec!["notes/plan.md".to_string()]);
        // Both copies survive: the newer one where it was, the older one
        // where the user can still go and find it.
        assert_eq!(
            fs::read_to_string(dir.join(AGENTS_DIR).join("plan.md")).unwrap(),
            "current"
        );
        assert_eq!(
            fs::read_to_string(legacy.join(NOTES_DIR).join("plan.md")).unwrap(),
            "old"
        );
        fs::remove_dir_all(&dir).ok();
    }

    /// A symlinked directory in the old notes folder is moved as a link
    /// (review 2026-09-17 FC-f, backlog 134), never followed: the files it
    /// points at stay where they are, and the link still points at them.
    /// Unix only: the symlink call is.
    #[cfg(unix)]
    #[test]
    fn migration_moves_a_symlink_whole_and_never_follows_it() {
        let dir = temp_dir("migrate-symlink");
        let elsewhere = temp_dir("migrate-symlink-target");
        fs::write(elsewhere.join("secret.md"), "not the project's").unwrap();
        let legacy = dir.join(DOT_DIR);
        fs::create_dir_all(legacy.join(NOTES_DIR)).unwrap();
        fs::write(legacy.join(NOTES_DIR).join("plan.md"), "# plan").unwrap();
        std::os::unix::fs::symlink(&elsewhere, legacy.join(NOTES_DIR).join("linked")).unwrap();

        let moved = migrate(&dir);
        assert_eq!(moved.notes, 2, "the note and the link itself");
        assert!(moved.skipped.is_empty(), "{:?}", moved.skipped);
        let linked = dir.join(AGENTS_DIR).join("linked");
        assert!(linked.symlink_metadata().unwrap().file_type().is_symlink());
        assert_eq!(fs::read_link(&linked).unwrap(), elsewhere);
        // The target's files were not moved: still there, and not copied
        // into the project as its own.
        assert_eq!(
            fs::read_to_string(elsewhere.join("secret.md")).unwrap(),
            "not the project's"
        );
        assert!(!legacy.join(NOTES_DIR).exists());
        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(&elsewhere).ok();
    }

    #[test]
    fn migration_is_free_when_there_is_nothing_to_move() {
        let dir = temp_dir("migrate-none");
        assert!(migrate(&dir).is_empty());
        assert!(migrate(&dir).summary().is_none());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_same_folder_spelled_differently_is_one_project() {
        let dir = temp_dir("same");
        let mut reg = Registry::load_from(dir.join("registry.json"));

        let a = reg.add(&dir, Some("First".into())).unwrap();
        let b = reg.add(dir.join("."), None).unwrap();

        assert_eq!(a.id, b.id);
        assert_eq!(reg.projects().len(), 1);
        // A second add without a name must not clobber the one already given.
        assert_eq!(b.name, "First");
    }

    #[test]
    fn forgetting_a_project_leaves_every_file_alone() {
        let dir = temp_dir("forget");
        let mut reg = Registry::load_from(dir.join("registry.json"));
        let project = reg.add(&dir, None).unwrap();
        write_note(&project.notes_dir(), "plan.md", "# Plan\nstep one").unwrap();

        reg.forget(&project.id).unwrap();

        assert!(reg.projects().is_empty());
        assert!(project.notes_dir().join("plan.md").is_file());
    }

    /// A project's extra folders (nightshift backlog 143): the whole list
    /// replaced, the home folder and a duplicate dropped, a missing folder
    /// refused, absent from the file when empty, and back after a reload.
    #[test]
    fn extra_folders_are_a_list_the_registry_keeps_beside_the_home_folder() {
        let dir = temp_dir("extra-folders");
        let path = dir.join("projects.json");
        let home = dir.join("home");
        let notes = dir.join("notes");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&notes).unwrap();
        let id = {
            let mut reg = Registry::load_from(&path);
            let p = reg.add(&home, None).unwrap();
            assert!(p.extra_folders.is_empty());
            assert!(!fs::read_to_string(&path).unwrap().contains("extra_folders"));
            let err = reg
                .set_extra_folders(&p.id, vec![dir.join("missing")])
                .unwrap_err();
            assert!(err.contains("not a folder"), "{err}");
            let set = reg
                .set_extra_folders(&p.id, vec![notes.clone(), p.workspace_dir(), notes.clone()])
                .unwrap();
            assert_eq!(set.extra_folders, vec![notes.clone()]);
            assert!(reg.set_extra_folders("nope", vec![]).is_err());
            p.id
        };
        let reloaded = Registry::load_from(&path);
        assert_eq!(
            reloaded.find(&id).unwrap().extra_folders,
            vec![notes.clone()]
        );
        let mut reg = Registry::load_from(&path);
        assert!(
            reg.set_extra_folders(&id, vec![])
                .unwrap()
                .extra_folders
                .is_empty()
        );
        assert!(!fs::read_to_string(&path).unwrap().contains("extra_folders"));
    }

    /// Backlog 219: a save that cannot write (a full disk) leaves the old
    /// file whole. The temp file's name is taken by a folder, so the write
    /// fails the way a full disk makes it fail: before the rename.
    #[test]
    fn a_save_that_fails_leaves_the_old_registry_whole() {
        let dir = temp_dir("save-fails");
        let path = dir.join("projects.json");
        let home = dir.join("home");
        fs::create_dir_all(&home).unwrap();
        let mut reg = Registry::load_from(&path);
        let p = reg.add(&home, None).unwrap();
        let before = fs::read(&path).unwrap();

        let tmp = dir.join(format!(".projects.json.{}.tmp", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();
        let err = reg.rename(&p.id, "Renamed").unwrap_err();
        assert!(err.contains("not saved"), "{err}");
        assert_eq!(fs::read(&path).unwrap(), before);
        fs::remove_dir_all(&dir).ok();
    }

    /// Backlog 219: a registry that is there but cannot be read loads empty
    /// and is never written over this run. A folder in its place stands in
    /// for the read error a full disk or a stalled iCloud gives.
    #[test]
    fn an_unreadable_registry_is_never_saved_over() {
        let dir = temp_dir("unreadable");
        let path = dir.join("projects.json");
        fs::create_dir_all(&path).unwrap();
        let home = dir.join("home");
        fs::create_dir_all(&home).unwrap();

        let mut reg = Registry::load_from(&path);
        assert!(reg.projects().is_empty());
        let err = reg.add(&home, None).unwrap_err();
        assert!(err.contains("will not write over it"), "{err}");
        assert!(path.is_dir());
        fs::remove_dir_all(&dir).ok();
    }

    /// Backlog 219: a registry cut short is moved aside, kept, and the next
    /// save writes a fresh one instead of over it.
    #[test]
    fn a_broken_registry_is_moved_aside_and_kept() {
        let dir = temp_dir("broken");
        let path = dir.join("projects.json");
        let cut = "{\"version\": 1, \"projects\": [{\"id\": \"a\", \"na";
        fs::write(&path, cut).unwrap();
        let home = dir.join("home");
        fs::create_dir_all(&home).unwrap();

        let mut reg = Registry::load_from(&path);
        assert!(reg.projects().is_empty());
        let kept: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with("projects.json.broken-"))
            .collect();
        assert_eq!(kept.len(), 1, "{kept:?}");
        assert_eq!(fs::read_to_string(dir.join(&kept[0])).unwrap(), cut);

        reg.add(&home, None).unwrap();
        assert_eq!(Registry::load_from(&path).projects().len(), 1);
        fs::remove_dir_all(&dir).ok();
    }

    /// No file is the first run: empty, and saving works.
    #[test]
    fn a_missing_registry_is_empty_and_saves() {
        let dir = temp_dir("missing");
        let path = dir.join("projects.json");
        let home = dir.join("home");
        fs::create_dir_all(&home).unwrap();
        let mut reg = Registry::load_from(&path);
        assert!(reg.projects().is_empty());
        reg.add(&home, None).unwrap();
        assert_eq!(Registry::load_from(&path).projects().len(), 1);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_registry_round_trips_through_its_file() {
        let dir = temp_dir("round-trip");
        let path = dir.join("projects.json");
        let id = {
            let mut reg = Registry::load_from(&path);
            reg.add(&dir, Some("Kept".into())).unwrap().id
        };

        let reloaded = Registry::load_from(&path);
        let project = reloaded.find(&id).expect("id survives a reload");
        assert_eq!(project.name, "Kept");
        assert_eq!(
            project.workspace.as_deref(),
            Some(normalize(&dir).as_path())
        );
    }

    /// A registry shaped like the one on the machine this was built on: a
    /// claude.ai import's projects under one `projects` folder, plus a
    /// repository registered from elsewhere and *created later*.
    fn a_registry_like_his(projects_folder: &Path, elsewhere: &Path) -> Registry {
        let imported = [
            "Sophism",
            "Muton",
            "Baldi-Miller-Research",
            "I-C-SCI-45C",
            "Sigma-Pi",
            "Research-Exploration",
            "Calendar",
            "Summer-2026",
            "ARENA-8-0",
            "Resume",
            "Mu-Sigma",
            "AI-Safety-Collective-at-Irvine",
            "Knowledge-Building-Exploration",
            "SPAR-Applications",
            "Value-Generalization",
            "Calisthenics",
            "Unfiled-chats",
        ];
        let import_day = "2026-08-21T21:25:38Z".parse::<DateTime<Utc>>().unwrap();
        let later = "2026-09-11T16:13:53Z".parse::<DateTime<Utc>>().unwrap();
        let mut projects: Vec<Project> = imported
            .iter()
            .map(|slug| Project {
                id: new_id(),
                name: slug.replace('-', " "),
                workspace: Some(projects_folder.join(slug)),
                source: Some(format!("claude:{slug}")),
                extra_folders: Vec::new(),
                created: import_day,
                last_opened: import_day,
            })
            .collect();
        projects.push(Project {
            id: new_id(),
            name: "Nightshift (value generalization)".into(),
            workspace: Some(elsewhere.to_path_buf()),
            source: None,
            extra_folders: Vec::new(),
            created: later,
            last_opened: later,
        });
        Registry {
            path: None,
            projects,
            save_blocked: None,
        }
    }

    /// Backlog 102 (walk 2026-09-25): his "Unfiled chats" has a folder since
    /// the consolidation, and a New chat in it came up Claude Code. It is
    /// known by its import source — renamed or not — and no other is.
    #[test]
    fn the_unfiled_holder_is_known_by_its_source_not_its_folder_or_name() {
        let at = "2026-08-21T21:25:38Z".parse::<DateTime<Utc>>().unwrap();
        let holder = |name: &str, source: Option<&str>| Project {
            id: new_id(),
            name: name.into(),
            workspace: Some(PathBuf::from("/tmp/projects/Unfiled-chats")),
            source: source.map(str::to_string),
            extra_folders: Vec::new(),
            created: at,
            last_opened: at,
        };
        assert!(holder("Unfiled chats", Some("claude:unfiled")).is_unfiled_holder());
        assert!(holder("Loose ends", Some(UNFILED_SOURCE)).is_unfiled_holder());
        assert!(!holder("Unfiled chats", None).is_unfiled_holder());
        assert!(!holder("Value Generalization", Some("claude:0b1c")).is_unfiled_holder());
    }

    #[test]
    fn the_default_projects_folder_is_where_the_last_created_project_under_a_projects_folder_sits()
    {
        let base = PathBuf::from("/Users/swaraagsistla/Documents/ComputerScience/Nightloom");
        let reg = a_registry_like_his(&base.join("projects"), &base.join("nightshift-code"));

        // Seventeen workspaces under `.../Nightloom/projects`, and one newer
        // project registered from a repository beside it. The repository is
        // the most recently created project, and it must not move the
        // default: its parent is not a `projects` folder, so it says nothing
        // about where new ones go.
        assert_eq!(default_projects_folder(&reg), base.join("projects"));

        // No setting recorded: the default is what the pane shows, marked
        // as the default.
        let config = temp_dir("projects-folder-default");
        assert_eq!(projects_folder_in(&config, &reg), base.join("projects"));
        assert!(is_default_projects_folder_in(&config));
        fs::remove_dir_all(&config).ok();
    }

    #[test]
    fn a_newer_project_under_a_projects_folder_moves_the_default() {
        let old = PathBuf::from("/old/projects");
        let mut reg = a_registry_like_his(&old, Path::new("/repos/thing"));
        let newer = "2026-09-14T23:58:07Z".parse::<DateTime<Utc>>().unwrap();
        reg.projects.push(Project {
            id: new_id(),
            name: "Neural (MCP test)".into(),
            workspace: Some(PathBuf::from("/new/projects/Neural-MCP-test")),
            source: None,
            extra_folders: Vec::new(),
            created: newer,
            last_opened: newer,
        });
        // Most recently *created* wins, not most recently opened: where the
        // user last made a project is where they are keeping them now.
        assert_eq!(
            default_projects_folder(&reg),
            PathBuf::from("/new/projects")
        );
    }

    #[test]
    fn with_no_hint_the_default_is_documents_nightloom_projects() {
        let reg = Registry {
            path: None,
            projects: Vec::new(),
            save_blocked: None,
        };
        let got = default_projects_folder(&reg);
        assert!(
            got.ends_with(Path::new("Documents/Nightloom/projects")),
            "{}",
            got.display()
        );
    }

    #[test]
    fn the_projects_folder_setting_is_one_file_beside_the_registry() {
        let config = temp_dir("projects-folder-setting");
        let reg = Registry {
            path: None,
            projects: Vec::new(),
            save_blocked: None,
        };
        let chosen = config.join("elsewhere");
        fs::create_dir_all(&chosen).unwrap();

        set_projects_folder_in(&config, Some(&chosen)).unwrap();
        assert!(config.join(PROJECTS_FOLDER_FILE).is_file());
        assert_eq!(projects_folder_in(&config, &reg), normalize(&chosen));
        assert!(!is_default_projects_folder_in(&config));

        // Reset is the absence of the file, as the vault does it.
        set_projects_folder_in(&config, None).unwrap();
        assert!(!config.join(PROJECTS_FOLDER_FILE).exists());
        assert!(is_default_projects_folder_in(&config));
        // And resetting twice is not an error.
        set_projects_folder_in(&config, None).unwrap();

        // An unreadable file costs the setting, not the feature.
        fs::write(config.join(PROJECTS_FOLDER_FILE), "{not json").unwrap();
        assert!(is_default_projects_folder_in(&config));
        fs::remove_dir_all(&config).ok();
    }

    #[test]
    fn a_name_slugs_the_way_the_importer_spells_folders() {
        assert_eq!(slug("Value Generalization"), "Value-Generalization");
        assert_eq!(slug("I&C SCI 45C"), "I-C-SCI-45C");
        assert_eq!(slug("ARENA 8.0"), "ARENA-8-0");
        assert_eq!(slug("  Baldi / Miller Research  "), "Baldi-Miller-Research");
        assert_eq!(slug("snake_case-kept"), "snake_case-kept");
        // Nothing survives: the form's disabled-Create case.
        assert_eq!(slug("..."), "");
        assert_eq!(slug(""), "");
        assert_eq!(slug("!!!").len(), 0);
        // Cut at the limit, and a dash left at the cut is trimmed.
        let long: String = "ab ".repeat(40);
        assert!(slug(&long).chars().count() <= SLUG_LIMIT);
        assert!(!slug(&long).ends_with('-'));
    }

    #[test]
    fn the_resolved_path_is_the_slug_under_the_projects_folder() {
        let folder = Path::new("/somewhere/projects");
        let r = NewProjectPath::resolve("Value Generalization", folder);
        assert_eq!(r.slug, "Value-Generalization");
        assert_eq!(r.path, folder.join("Value-Generalization"));
        assert_eq!(r.folder, folder);
        // No slug, no path — the form shows the reason instead of a folder.
        let none = NewProjectPath::resolve("???", folder);
        assert!(none.slug.is_empty());
        assert!(none.path.as_os_str().is_empty());
    }

    #[test]
    fn create_makes_the_folder_writes_the_instructions_and_registers_by_name() {
        let dir = temp_dir("new-project");
        let mut reg = Registry::load_from(dir.join("registry.json"));
        let folder = dir.join("projects");
        let target = NewProjectPath::resolve("Value Generalization", &folder).path;

        let project = reg
            .new_project(
                "Value Generalization",
                NewProjectFolder::Resolved(target.clone()),
                Some("  Be terse.\nCite sources.  "),
            )
            .unwrap();

        assert_eq!(project.name, "Value Generalization");
        assert_eq!(
            project.workspace.as_deref(),
            Some(normalize(&target).as_path())
        );
        assert!(target.is_dir());
        assert_eq!(
            fs::read_to_string(target.join("AGENTS.md")).unwrap(),
            "Be terse.\nCite sources.\n"
        );
        assert_eq!(
            reg.find_by_workspace(&target).map(|p| p.id.as_str()),
            Some(project.id.as_str())
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn create_writes_no_agents_file_when_no_instructions_were_given() {
        let dir = temp_dir("new-project-bare");
        let mut reg = Registry::load_from(dir.join("registry.json"));
        let target = dir.join("projects").join("Bare");
        reg.new_project(
            "Bare",
            NewProjectFolder::Resolved(target.clone()),
            Some("   "),
        )
        .unwrap();
        assert!(target.is_dir());
        assert!(!target.join("AGENTS.md").exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn create_refuses_a_resolved_folder_that_already_holds_work() {
        let dir = temp_dir("new-project-taken");
        let mut reg = Registry::load_from(dir.join("registry.json"));
        let target = dir.join("projects").join("Taken");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("notes.txt"), "someone's work").unwrap();

        let err = reg
            .new_project("Taken", NewProjectFolder::Resolved(target.clone()), None)
            .unwrap_err();
        assert!(err.contains("not empty"), "{err}");
        assert!(reg.projects().is_empty(), "nothing registered on a refusal");
        assert!(target.join("notes.txt").is_file(), "and nothing touched");

        // An *empty* folder of that name is fine — nothing is lost by using it.
        let empty = dir.join("projects").join("Empty");
        fs::create_dir_all(&empty).unwrap();
        reg.new_project("Empty", NewProjectFolder::Resolved(empty), None)
            .unwrap();
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_picked_folder_may_hold_work_but_not_another_project_or_agents_file() {
        let dir = temp_dir("new-project-picked");
        let mut reg = Registry::load_from(dir.join("registry.json"));
        let picked = dir.join("existing-work");
        fs::create_dir_all(&picked).unwrap();
        fs::write(picked.join("main.rs"), "fn main() {}").unwrap();

        // Existing files are the point of picking a folder.
        let project = reg
            .new_project(
                "Existing",
                NewProjectFolder::Picked(picked.clone()),
                Some("hi"),
            )
            .unwrap();
        assert_eq!(
            project.workspace.as_deref(),
            Some(normalize(&picked).as_path())
        );
        assert!(picked.join("AGENTS.md").is_file());

        // Picking it again is refused by the project's name — Open project…
        // is the row for that, and a second project on one folder is a
        // deliberate act the form does not perform.
        let err = reg
            .new_project("Again", NewProjectFolder::Picked(picked.clone()), None)
            .unwrap_err();
        assert!(err.contains("Existing"), "{err}");
        assert_eq!(reg.projects().len(), 1);

        // Instructions never overwrite an AGENTS.md that is already there.
        let other = dir.join("has-agents");
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("AGENTS.md"), "mine").unwrap();
        let err = reg
            .new_project(
                "Other",
                NewProjectFolder::Picked(other.clone()),
                Some("theirs"),
            )
            .unwrap_err();
        assert!(err.contains("AGENTS.md"), "{err}");
        assert_eq!(fs::read_to_string(other.join("AGENTS.md")).unwrap(), "mine");
        assert_eq!(reg.projects().len(), 1);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn create_needs_a_name_that_makes_a_folder() {
        let dir = temp_dir("new-project-noslug");
        let mut reg = Registry::load_from(dir.join("registry.json"));
        let err = reg
            .new_project("???", NewProjectFolder::Resolved(PathBuf::new()), None)
            .unwrap_err();
        assert!(err.contains("letter or digit"), "{err}");
        assert!(
            reg.new_project("  ", NewProjectFolder::Resolved(dir.join("x")), None)
                .is_err()
        );
        assert!(reg.projects().is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_note_cannot_be_written_outside_the_docspace() {
        let dir = temp_dir("escape");
        let notes = dir.join("notes");

        let err = write_note(&notes, "../escaped.md", "nope").unwrap_err();
        assert!(err.contains("outside"), "unexpected message: {err}");
        assert!(!dir.join("escaped.md").exists());
    }

    #[test]
    fn the_index_reports_names_with_forward_slashes_and_a_summary() {
        let dir = temp_dir("index");
        let notes = dir.join("notes");
        write_note(&notes, "TASKS.md", "# Auth rewrite\n- [ ] one\n").unwrap();
        write_note(&notes, "deep/why.md", "\n\nBecause the table was wrong.\n").unwrap();

        let listed = list_notes(&notes);

        let names: Vec<&str> = listed.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, vec!["TASKS.md", "deep/why.md"]);
        assert_eq!(listed[0].summary.as_deref(), Some("Auth rewrite"));
        assert_eq!(
            listed[1].summary.as_deref(),
            Some("Because the table was wrong.")
        );
    }

    /// Backlog 217: a note that opens with front matter is summarised by its
    /// `description:`, or by the first real line after the fence — never as
    /// `---`, and never as a front-matter key.
    #[test]
    fn front_matter_is_not_a_summary() {
        let with_description = "---\ntitle: x\ndescription: \"Why the cache is keyed by path\"\ntags: [a]\n---\n# Heading\n";
        assert_eq!(
            summary_of(with_description).as_deref(),
            Some("Why the cache is keyed by path")
        );
        let without = "\n---\ntitle: x\ntags: [a]\n---\n\n# The real title\nbody\n";
        assert_eq!(summary_of(without).as_deref(), Some("The real title"));
        // A fence the probe never saw closed: nothing rather than a key.
        assert_eq!(summary_of("---\ntitle: x\ntags: [a, b"), None);
        // Only a fence and a rule: nothing.
        assert_eq!(summary_of("---\n---\n***\n"), None);
        assert_eq!(summary_of("***\n"), None);
        // The plain cases are unchanged.
        assert_eq!(
            summary_of("# Auth rewrite\n").as_deref(),
            Some("Auth rewrite")
        );
        assert_eq!(
            summary_of("\n\nplain line\n").as_deref(),
            Some("plain line")
        );
        // Through the index, from a file.
        let dir = temp_dir("front-matter");
        let notes = dir.join("notes");
        write_note(&notes, "fm.md", with_description).unwrap();
        assert_eq!(
            list_notes(&notes)[0].summary.as_deref(),
            Some("Why the cache is keyed by path")
        );
    }

    #[test]
    fn a_missing_docspace_is_an_empty_index_not_an_error() {
        let dir = temp_dir("missing");
        assert!(list_notes(&dir.join("notes")).is_empty());
        // Nothing was created just by asking.
        assert!(!dir.join("notes").exists());
    }

    /// A vault under version control, or an Obsidian vault with its config
    /// folder, must not have its machinery listed or counted as notes. Found
    /// live: the first `git init`-ed vault listed forty entries of git
    /// plumbing the moment the dream pass's own advice was followed.
    #[test]
    fn dot_entries_are_machinery_not_notes() {
        let dir = temp_dir("dotted");
        let notes = dir.join("notes");
        write_note(&notes, "real.md", "# A note\n").unwrap();
        fs::create_dir_all(notes.join(".git/hooks")).unwrap();
        fs::write(notes.join(".git/config"), "[core]\n").unwrap();
        fs::write(notes.join(".git/hooks/pre-commit"), "#!/bin/sh\n").unwrap();
        fs::create_dir_all(notes.join(".obsidian")).unwrap();
        fs::write(notes.join(".obsidian/workspace.json"), "{}\n").unwrap();
        fs::write(notes.join(".DS_Store"), "junk").unwrap();

        let listed = list_notes(&notes);
        let names: Vec<&str> = listed.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, vec!["real.md"]);

        let (counts, exhaustive) = note_counts(&notes);
        assert!(exhaustive);
        assert_eq!(counts.values().sum::<usize>(), 1);
    }
}
