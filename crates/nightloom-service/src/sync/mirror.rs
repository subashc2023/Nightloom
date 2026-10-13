//! The away server's half of the sync: the mirror the Mac writes into, and
//! the outbox of chats started on the server.
//!
//! What this side writes, and nothing more:
//! - under `<home>/mirror/`: the files the Mac sends, verified against the
//!   hash it sent with them, written whole (temp file + rename) and left
//!   read-only (0444) so nothing on the server appends to one by accident;
//!   their index `mirror/.index.json`; and the removal of a copy the Mac's
//!   manifest no longer names (a chat deleted on the Mac, a project no
//!   longer marked — he unmarks it and the server's copy goes).
//! - `<home>/sync/acked.json`, and the mode bits of a server chat's log
//!   once the Mac has taken it down (0444: read-only from then on).
//!
//! `store::list` leaves its `.listing.json` cache in any sessions folder it
//! lists, the mirror's included; that dotfile is the server's derived data,
//! never a mirrored file, and the manifest never names it.

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use nightloom_core::Session;
use serde::{Deserialize, Serialize};

use super::manifest::{self, Entry, Manifest};
use super::{Layout, fork};
use crate::agent::cli_session;
use crate::agent_turn::AGENT;
use crate::project::{PROJECTS_DIR, SESSIONS_DIR};

/// The mirror's index of what the Mac sent: path, size, hash.
const INDEX_FILE: &str = ".index.json";
/// The chats the Mac has taken down.
const ACKED_FILE: &str = "acked.json";

/// The server's answer to a manifest.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestReply {
    /// The paths the Mac should send now.
    pub need: Vec<String>,
    /// How many copies were dropped because the Mac no longer names them.
    pub removed: usize,
}

/// One chat started on the server and not yet taken down by the Mac.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboxEntry {
    /// The chat's id (its log's file stem).
    pub chat: String,
    /// The project it was started in, `None` for an unfiled chat. The Mac
    /// files it there; a project the Mac does not know lands in unfiled.
    pub project: Option<String>,
    pub log_size: u64,
    pub log_sha256: String,
    /// The CLI session file its log names, when there is one on the server.
    pub cli: Option<OutboxCli>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OutboxCli {
    pub session_id: String,
    pub size: u64,
    pub sha256: String,
}

/// The Mac's acknowledgement: these chats are now on the Mac.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AckRequest {
    pub chats: Vec<String>,
}

/// Why a file was refused.
#[derive(Debug, thiserror::Error)]
pub enum PutError {
    #[error("{0} is not a path the mirror keeps")]
    Path(String),
    #[error("the file's hash does not match the one sent with it")]
    Hash,
    #[error("{0}")]
    Io(#[from] io::Error),
}

/// Answers "is this chat running a turn now" — `serve`'s turn slot.
pub type Busy = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// The server's sync state for one Nightloom home.
pub struct SyncServer {
    layout: Layout,
    /// The server's CLI projects folder, where its chats' session files are.
    claude_projects: PathBuf,
    busy: Busy,
    /// One writer at a time on the index and the acked list.
    lock: Mutex<()>,
}

impl std::fmt::Debug for SyncServer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SyncServer")
            .field("home", &self.layout.home())
            .finish()
    }
}

impl SyncServer {
    /// For the home `serve` runs on; `claude_projects` is
    /// `cli_session::projects_dir()` there. No chat counts as busy until
    /// [`SyncServer::with_busy`] says how to ask.
    pub fn new(home: impl Into<PathBuf>, claude_projects: impl Into<PathBuf>) -> Self {
        Self {
            layout: Layout::new(home),
            claude_projects: claude_projects.into(),
            busy: Arc::new(|_| false),
            lock: Mutex::new(()),
        }
    }

    /// How to tell a chat that is running a turn: it stays in the outbox's
    /// shadow until its turn ends.
    pub fn with_busy(mut self, busy: Busy) -> Self {
        self.busy = busy;
        self
    }

    pub fn layout(&self) -> &Layout {
        &self.layout
    }

    pub fn claude_projects(&self) -> &Path {
        &self.claude_projects
    }

    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn index_path(&self) -> PathBuf {
        self.layout.root().join(INDEX_FILE)
    }

    fn read_index(&self) -> Manifest {
        fs::read(self.index_path())
            .ok()
            .and_then(|raw| serde_json::from_slice(&raw).ok())
            .unwrap_or_default()
    }

    fn write_index(&self, index: &Manifest) -> io::Result<()> {
        fs::create_dir_all(self.layout.root())?;
        let body = serde_json::to_vec(index).map_err(io::Error::other)?;
        write_whole(&self.index_path(), &body, false)
    }

    /// The Mac's manifest in: the paths it should send (missing here, or a
    /// different copy, or a file the index names that is gone from disk),
    /// and every copy it no longer names removed.
    pub fn apply_manifest(&self, local: &Manifest) -> io::Result<ManifestReply> {
        let _g = self.guard();
        for e in &local.entries {
            if !Layout::allowed(&e.path) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("{} is not a path the mirror keeps", e.path),
                ));
            }
        }
        let root = self.layout.root();
        let mut index = self.read_index();
        // A copy the index names but the disk lost is not had.
        index
            .entries
            .retain(|e| manifest::join(&root, &e.path).is_some_and(|p| p.is_file()));
        let need = manifest::changed(local, &index);
        let gone = manifest::gone(local, &index);
        for rel in &gone {
            if let Some(path) = manifest::join(&root, rel) {
                match fs::remove_file(&path) {
                    Ok(()) => prune_empty(&root, &path),
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e),
                }
            }
        }
        let gone_set: BTreeSet<&str> = gone.iter().map(String::as_str).collect();
        index
            .entries
            .retain(|e| !gone_set.contains(e.path.as_str()));
        self.write_index(&index)?;
        Ok(ManifestReply {
            need,
            removed: gone.len(),
        })
    }

    /// One file from the Mac: checked against its hash, written whole
    /// under the mirror, read-only, and indexed.
    pub fn put(&self, rel: &str, sha256: &str, bytes: &[u8]) -> Result<(), PutError> {
        if !Layout::allowed(rel) {
            return Err(PutError::Path(rel.to_string()));
        }
        if manifest::sha256_hex(bytes) != sha256.trim().to_ascii_lowercase() {
            return Err(PutError::Hash);
        }
        let path = manifest::join(&self.layout.root(), rel)
            .ok_or_else(|| PutError::Path(rel.to_string()))?;
        let _g = self.guard();
        write_whole(&path, bytes, true)?;
        let mut index = self.read_index();
        index.entries.retain(|e| e.path != rel);
        index.entries.push(Entry {
            path: rel.to_string(),
            size: bytes.len() as u64,
            sha256: sha256.trim().to_ascii_lowercase(),
        });
        self.write_index(&index)?;
        Ok(())
    }

    /// Every server chat's log: `(project, path)`, `None` for unfiled.
    fn own_logs(&self) -> Vec<(Option<String>, PathBuf)> {
        let home = self.layout.home();
        let mut out = Vec::new();
        if let Ok(projects) = fs::read_dir(home.join(PROJECTS_DIR)) {
            for p in projects.flatten() {
                let id = p.file_name().to_string_lossy().into_owned();
                for log in logs_in(&p.path().join(SESSIONS_DIR)) {
                    out.push((Some(id.clone()), log));
                }
            }
        }
        for log in logs_in(&home.join("unfiled").join(SESSIONS_DIR)) {
            out.push((None, log));
        }
        out
    }

    fn find_own(&self, chat: &str) -> Option<(Option<String>, PathBuf)> {
        if !crate::store::is_log_id(chat) {
            return None;
        }
        let name = format!("{chat}.jsonl");
        self.own_logs()
            .into_iter()
            .find(|(_, p)| p.file_name().is_some_and(|n| n.to_string_lossy() == name))
    }

    /// The CLI session file a server log names, if it is on disk.
    fn cli_file_of(&self, log: &Path) -> Option<(String, PathBuf)> {
        let session = Session::load(log).ok()?;
        let (agent, sid) = session.agent_session()?;
        if agent != AGENT {
            return None;
        }
        let cwd = session
            .kind_workspace()
            .map(Path::to_path_buf)
            .unwrap_or_default();
        let path = cli_session::find(&self.claude_projects, &cwd, sid).ok()?;
        Some((sid.to_string(), path))
    }

    /// The chats started on the server that the Mac has not taken down,
    /// less any running a turn now (they wait for the next pass).
    pub fn outbox(&self) -> io::Result<Vec<OutboxEntry>> {
        let acked = read_acked(&self.layout.state());
        let mut out = Vec::new();
        for (project, log) in self.own_logs() {
            let chat = log
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            if acked.contains(&chat) || (self.busy)(&chat) {
                continue;
            }
            let (log_size, log_sha256) = manifest::hash_file(&log)?;
            let cli = self.cli_file_of(&log).and_then(|(sid, path)| {
                let (size, sha256) = manifest::hash_file(&path).ok()?;
                Some(OutboxCli {
                    session_id: sid,
                    size,
                    sha256,
                })
            });
            out.push(OutboxEntry {
                chat,
                project,
                log_size,
                log_sha256,
                cli,
            });
        }
        out.sort_by(|a, b| a.chat.cmp(&b.chat));
        Ok(out)
    }

    /// An outbox chat's log, as bytes.
    pub fn outbox_log(&self, chat: &str) -> io::Result<Vec<u8>> {
        let (_, log) = self.find_own(chat).ok_or_else(|| not_found(chat))?;
        fs::read(log)
    }

    /// An outbox chat's CLI session file, as bytes.
    pub fn outbox_cli(&self, chat: &str) -> io::Result<Vec<u8>> {
        let (_, log) = self.find_own(chat).ok_or_else(|| not_found(chat))?;
        let (_, path) = self
            .cli_file_of(&log)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no CLI session file"))?;
        fs::read(path)
    }

    /// The Mac has these chats now: each log goes read-only and its id on
    /// the acked list, so it leaves the outbox and a later send to it from
    /// the phone forks it ([`Layout::needs_fork`]). A chat running a turn
    /// is not acknowledged (the Mac's copy would be a turn behind). Returns
    /// how many were.
    pub fn ack(&self, chats: &[String]) -> io::Result<usize> {
        let _g = self.guard();
        let state = self.layout.state();
        let mut acked = read_acked(&state);
        let mut n = 0;
        for chat in chats {
            if (self.busy)(chat) {
                continue;
            }
            let Some((_, log)) = self.find_own(chat) else {
                continue;
            };
            set_read_only(&log)?;
            if acked.insert(chat.clone()) {
                n += 1;
            }
        }
        fs::create_dir_all(&state)?;
        let body = serde_json::to_vec_pretty(&acked).map_err(io::Error::other)?;
        write_whole(&state.join(ACKED_FILE), &body, false)?;
        Ok(n)
    }

    /// Fork a mirrored chat (or a server chat the Mac already took down)
    /// into a new server-owned chat in the same project, its turns to run
    /// in `cwd`: what `serve`'s send path calls before a turn when
    /// [`Layout::needs_fork`] says so. The phone is then pointed at the
    /// returned chat.
    pub fn fork(
        &self,
        project: Option<&str>,
        source_log: &Path,
        cwd: &Path,
    ) -> Result<fork::Forked, String> {
        let home = self.layout.home();
        let dest_sessions = match project {
            Some(p) => home.join(PROJECTS_DIR).join(p).join(SESSIONS_DIR),
            None => home.join("unfiled").join(SESSIONS_DIR),
        };
        let source_claude = if source_log.starts_with(self.layout.root()) {
            self.layout.claude()
        } else {
            self.claude_projects.clone()
        };
        fork::fork(&fork::ForkPlan {
            source_log: source_log.to_path_buf(),
            source_claude,
            dest_sessions,
            dest_claude: self.claude_projects.clone(),
            cwd: cwd.to_path_buf(),
        })
    }
}

fn not_found(chat: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::NotFound,
        format!("no server chat {chat} in the outbox"),
    )
}

/// The acked list, or empty.
pub(crate) fn read_acked(state: &Path) -> BTreeSet<String> {
    fs::read(state.join(ACKED_FILE))
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default()
}

/// `*.jsonl` directly in `dir`, not dotfiles.
fn logs_in(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.extension().is_some_and(|x| x == "jsonl")
                && p.file_name()
                    .is_some_and(|n| !n.to_string_lossy().starts_with('.'))
        })
        .collect();
    out.sort();
    out
}

/// Write `bytes` at `path` whole: a temp file beside it, then a rename
/// (which replaces an older copy, read-only or not, since the rename
/// needs only the folder's permission). `read_only` leaves it 0444.
fn write_whole(path: &Path, bytes: &[u8], read_only: bool) -> io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::other("a file with no folder"))?;
    fs::create_dir_all(dir)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(".{name}.{}.tmp", uuid::Uuid::new_v4()));
    fs::write(&tmp, bytes)?;
    if read_only && let Err(e) = set_read_only(&tmp) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

fn set_read_only(path: &Path) -> io::Result<()> {
    let mut perms = fs::metadata(path)?.permissions();
    perms.set_readonly(true);
    fs::set_permissions(path, perms)
}

/// Remove the folders a removal left empty, up to (not including) `root`.
fn prune_empty(root: &Path, removed: &Path) {
    let mut at = removed.parent();
    while let Some(dir) = at {
        if dir == root || !dir.starts_with(root) || fs::remove_dir(dir).is_err() {
            break;
        }
        at = dir.parent();
    }
}
