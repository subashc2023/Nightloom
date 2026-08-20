//! Projects: a named folder, the chats held in it, and the notes they share.
//!
//! A project is deliberately *not* a new storage system. It is a folder the
//! user picked. The folder stays the unit of *identity* — what a chat is
//! about, what the file tools are rooted at, where `AGENTS.md` and `mcp.json`
//! are found — while everything Nightloom itself writes lives in the user's
//! home:
//!
//! * `<root>/AGENTS.md` — instructions, already discovered by the preamble's
//!   directory walk. Nothing here has to do anything for that to work.
//! * `<root>/.nightloom/mcp.json` — server config, and the only thing left in
//!   the folder. It is *configuration*: written by hand, usually checked in,
//!   and copied between projects on purpose.
//! * `~/.nightloom/projects/<id>/sessions/` — the project's chats.
//! * `~/.nightloom/projects/<id>/notes/` — the docspace: plain files every
//!   chat in the project can read and write, indexed into the system prompt so
//!   a new conversation starts knowing what the previous ones left behind.
//!
//! The split is between **config and data**. A folder someone works in is
//! theirs; a repo is not a place to leave chat logs, gitignored or not, and a
//! year of conversations scattered one-directory-per-checkout is a history
//! nobody can look through. Keying the store by the id — an FNV-1a over the
//! case-folded canonical path — is what keeps the folder as the identity
//! anyway: `nightloom --continue` in a folder still resumes the conversation
//! the desktop app was having there, because both derive the same id from the
//! same path without either consulting a registry.
//!
//! Two costs, both real and both accepted. The history no longer travels with
//! the work — copying the folder copies the code and not the chats — and the
//! docspace is no longer inside the workspace the file tools are rooted at,
//! which is why [`Root`] grew a second tree rather than the docspace growing
//! tools of its own. Moving the folder orphans its store, the same way it
//! already orphaned its registry entry.
//!
//! [`migrate`] moves a pre-move `<root>/.nightloom/{sessions,notes}` into the
//! store the first time the project is opened.

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
/// Subdirectory of [`DOT_DIR`] holding the shared notes.
pub const NOTES_DIR: &str = "notes";
/// Subdirectory of [`DOT_DIR`] holding this project's session logs.
pub const SESSIONS_DIR: &str = "sessions";

/// Registry filename, in the user's config dir.
const REGISTRY_FILE: &str = "projects.json";

/// Notes listed at most. A docspace is meant to be read, and an index of a
/// thousand files is not one — past this the listing is cut.
const NOTE_LIMIT: usize = 200;
/// How deep the notes walk goes. Enough for a folder or two of organization,
/// shallow enough that a repo checked out inside the docspace cannot turn the
/// index into a filesystem crawl.
const NOTE_DEPTH: usize = 4;
/// Bytes read from a note to derive its one-line summary.
const SUMMARY_PROBE: usize = 512;

/// A folder the user named and wants to come back to.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    /// Derived from the normalized path, not random: adding the same folder
    /// twice is the same project rather than a duplicate entry, and an id
    /// written into a config file last month still resolves today.
    pub id: String,
    pub name: String,
    pub root: PathBuf,
    pub created: DateTime<Utc>,
    /// Bumped by [`Registry::touch`], so the picker can lead with what the
    /// user was last working on.
    pub last_opened: DateTime<Utc>,
}

impl Project {
    /// `<root>/.nightloom` — project *configuration* (`mcp.json`), and the
    /// pre-move location of the store that [`migrate`] empties.
    pub fn dot_dir(&self) -> PathBuf {
        self.root.join(DOT_DIR)
    }

    /// `~/.nightloom/projects/<id>` — everything Nightloom writes for this
    /// project.
    pub fn store_dir(&self) -> PathBuf {
        store_dir(&self.id, &self.root)
    }

    /// Where this project's chats are logged.
    pub fn session_dir(&self) -> PathBuf {
        self.store_dir().join(SESSIONS_DIR)
    }

    /// The shared docspace.
    pub fn notes_dir(&self) -> PathBuf {
        self.store_dir().join(NOTES_DIR)
    }

    /// Whether the folder is still there. A project whose folder was moved is
    /// reported as missing rather than dropped from the registry: an unplugged
    /// external drive is not a decision to forget a project.
    pub fn exists(&self) -> bool {
        self.root.is_dir()
    }
}

/// The named folders this user has, persisted in `~/.nightloom/projects.json`.
///
/// In the user's config dir rather than per-project, for the obvious reason
/// that a list of projects cannot live inside one of them.
#[derive(Debug, Clone)]
pub struct Registry {
    path: Option<PathBuf>,
    projects: Vec<Project>,
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
    /// Load from the user's config dir. A missing or unreadable file is an
    /// empty registry, not an error — the first run has no projects, and a
    /// corrupt file should not make the app unusable when the recovery is to
    /// pick the folder again.
    pub fn load() -> Self {
        match config_dir().map(|d| d.join(REGISTRY_FILE)) {
            Some(path) => Self::load_from(path),
            None => Self {
                path: None,
                projects: Vec::new(),
            },
        }
    }

    pub fn load_from(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let projects = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<RegistryFile>(&raw).ok())
            .map(|f| f.projects)
            .unwrap_or_default();
        Self {
            path: Some(path),
            projects,
        }
    }

    /// Newest-opened first, which is the order a picker wants.
    pub fn projects(&self) -> Vec<Project> {
        let mut out = self.projects.clone();
        out.sort_by(|a, b| b.last_opened.cmp(&a.last_opened));
        out
    }

    pub fn find(&self, id: &str) -> Option<&Project> {
        self.projects.iter().find(|p| p.id == id)
    }

    /// Register a folder, or return the existing entry for it.
    ///
    /// Idempotent because the id is derived from the path: picking the same
    /// folder from the file dialog twice is not two projects, and erroring
    /// would be a worse answer than "you are already here". An explicit
    /// `name` on a second add renames.
    pub fn add(&mut self, root: impl AsRef<Path>, name: Option<String>) -> Result<Project, String> {
        let root = normalize(root.as_ref());
        if !root.is_dir() {
            return Err(format!("{} is not a folder", root.display()));
        }
        let id = path_id(&root);
        let now = Utc::now();
        if let Some(existing) = self.projects.iter_mut().find(|p| p.id == id) {
            if let Some(name) = name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty()) {
                existing.name = name;
            }
            existing.last_opened = now;
            let out = existing.clone();
            self.save();
            return Ok(out);
        }
        let project = Project {
            id,
            name: name
                .map(|n| n.trim().to_string())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| default_name(&root)),
            root,
            created: now,
            last_opened: now,
        };
        self.projects.push(project.clone());
        self.save();
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
        self.save();
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
        self.save();
        Ok(())
    }

    /// Record that a project was opened, for picker ordering.
    pub fn touch(&mut self, id: &str) {
        if let Some(p) = self.projects.iter_mut().find(|p| p.id == id) {
            p.last_opened = Utc::now();
            self.save();
        }
    }

    /// Best-effort persist. A registry that cannot be written still works for
    /// this run, and failing "open project" because the config dir is
    /// read-only would be the wrong trade.
    fn save(&self) {
        let Some(path) = &self.path else { return };
        let file = RegistryFile {
            version: schema_version(),
            projects: self.projects.clone(),
        };
        let Ok(json) = serde_json::to_string_pretty(&file) else {
            return;
        };
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(path, json);
    }
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

/// `~/.nightloom/projects/<id>`, the directory holding everything Nightloom
/// writes for one project.
///
/// `root` is only the fallback: with no home directory — a real state in a
/// stripped environment, and the one `config_dir` already reports as `None` —
/// the store goes back into the folder, because a project with nowhere to put
/// its chats would otherwise have to fail rather than degrade.
pub fn store_dir(id: &str, root: &Path) -> PathBuf {
    match config_dir() {
        Some(home) => home.join(PROJECTS_DIR).join(id),
        None => root.join(DOT_DIR),
    }
}

/// The store for a folder, without consulting the registry.
///
/// This is what makes the CLI and the desktop agree on where a folder's chats
/// are while only one of them has a registry: the id is derived from the path,
/// so `nightloom --continue` run in a folder opens the same directory the
/// desktop app writes for it, and neither has to have heard of the other.
pub fn store_for(root: &Path) -> PathBuf {
    let root = normalize(root);
    let id = path_id(&root);
    store_dir(&id, &root)
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
        let mut line = format!("moved {moved} out of .nightloom/ into ~/.nightloom");
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

/// Move a pre-move `<root>/.nightloom/{sessions,notes}` into the home store.
///
/// Idempotent and cheap to call — one `stat` when there is nothing to do — so
/// a shell can run it every time it opens a project rather than remembering
/// whether it has. Three rules, all of them the conservative reading:
///
/// * **Nothing already in the store is overwritten.** A name that collides is
///   left where it is and reported, on the same argument the importer makes:
///   a docspace is a working directory, and a migration that could undo a
///   week of notes would be worse than no migration.
/// * **`mcp.json` and anything else in `.nightloom/` stays.** Only the two
///   directories that moved are touched, and the dot directory itself is
///   removed only if the OS agrees it is empty.
/// * **A file that cannot be moved is left, not lost.** `rename` across
///   volumes fails, so a copy-then-remove fallback runs; if the copy fails the
///   original stays put and lands in `skipped`.
pub fn migrate(root: &Path) -> Migrated {
    let mut out = Migrated::default();
    let legacy = root.join(DOT_DIR);
    if !legacy.is_dir() {
        return out;
    }
    let store = store_for(root);
    // With no home directory the store *is* the legacy directory; there is
    // nowhere to move anything to, and moving a file onto itself would be a
    // deletion with extra steps.
    if store == legacy {
        return out;
    }
    for (sub, counter) in [
        (SESSIONS_DIR, &mut out.sessions),
        (NOTES_DIR, &mut out.notes),
    ] {
        let from = legacy.join(sub);
        if !from.is_dir() {
            continue;
        }
        let to = store.join(sub);
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
        if source.is_dir() {
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

fn walk_notes(base: &Path, dir: &Path, depth: usize, out: &mut Vec<Note>) {
    if depth > NOTE_DEPTH || out.len() >= NOTE_LIMIT {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
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
    let text = String::from_utf8_lossy(&buf[..read]);
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| l.trim_start_matches('#').trim())?;
    if line.is_empty() {
        return None;
    }
    Some(line.chars().take(120).collect())
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
    fn the_store_is_outside_the_folder_and_keyed_by_it() {
        let dir = temp_dir("store");
        let store = store_for(&dir);
        assert!(
            !store.starts_with(&dir),
            "{} is inside the project folder",
            store.display()
        );
        // The CLI derives this without a registry and the desktop derives it
        // with one; if the two ever disagreed, `--continue` in a folder would
        // open a different conversation from the one the app was having.
        let mut reg = Registry::load_from(dir.join("registry.json"));
        let project = reg.add(&dir, None).unwrap();
        assert_eq!(project.store_dir(), store);
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

        let store = store_for(&dir);
        assert!(store.join(SESSIONS_DIR).join("a.jsonl").is_file());
        assert_eq!(
            fs::read_to_string(store.join(NOTES_DIR).join("sub").join("deep.md")).unwrap(),
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

        let store = store_for(&dir);
        fs::create_dir_all(store.join(NOTES_DIR)).unwrap();
        fs::write(store.join(NOTES_DIR).join("plan.md"), "current").unwrap();

        let moved = migrate(&dir);
        assert_eq!(moved.notes, 0);
        assert_eq!(moved.skipped, vec!["notes/plan.md".to_string()]);
        // Both copies survive: the newer one where it was, the older one
        // where the user can still go and find it.
        assert_eq!(
            fs::read_to_string(store.join(NOTES_DIR).join("plan.md")).unwrap(),
            "current"
        );
        assert_eq!(
            fs::read_to_string(legacy.join(NOTES_DIR).join("plan.md")).unwrap(),
            "old"
        );
        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(&store).ok();
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
        assert_eq!(project.root, normalize(&dir));
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

    #[test]
    fn a_missing_docspace_is_an_empty_index_not_an_error() {
        let dir = temp_dir("missing");
        assert!(list_notes(&dir.join("notes")).is_empty());
        // Nothing was created just by asking.
        assert!(!dir.join("notes").exists());
    }
}
