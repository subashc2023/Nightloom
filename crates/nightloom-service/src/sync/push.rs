//! Up: the Mac's snapshot to the away server (item 268 step 3, §4.2).
//!
//! What goes, and nothing else (blocker 651): user memory
//! (`<config>/AGENTS.md`), the vault, and for each project marked
//! "available away" its `AGENTS.md`, its chat logs, and the Claude Code
//! session file each log currently resumes. An unmarked project sends
//! nothing — not a name, not a count. An incognito chat is not sent even
//! from a marked project: its mode promises that no other reader sees it.
//!
//! The manifest goes first; the server answers with what it lacks; only
//! those files follow, one `PUT` each.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use nightloom_core::{ChatMode, Session};
use serde::Serialize;

use super::manifest::{self, Entry, HashCache, Manifest};
use super::mirror::ManifestReply;
use super::{Client, MirrorProject, PROJECTS_FILE};
use crate::agent::cli_session;
use crate::agent_turn::AGENT;
use crate::project::{PROJECTS_DIR, Project, SESSIONS_DIR};

/// Where a file of the snapshot comes from.
#[derive(Debug, Clone)]
pub enum Source {
    File(PathBuf),
    /// Made for the snapshot (the marked projects' list).
    Bytes(Vec<u8>),
}

/// One file of the snapshot, hashed.
#[derive(Debug, Clone)]
pub struct Outgoing {
    pub entry: Entry,
    pub source: Source,
}

/// What the Mac has, for [`collect`].
#[derive(Debug, Clone)]
pub struct MacSnapshot {
    /// `~/.nightloom`.
    pub config: PathBuf,
    /// The vault (`knowledge::vault_dir_in(config)`).
    pub vault: PathBuf,
    /// The projects marked "available away" — the caller filters, and
    /// [`collect`] checks the mark again.
    pub projects: Vec<Project>,
    /// The CLI's projects folder (`cli_session::projects_dir()`).
    pub claude_projects: PathBuf,
}

/// What one log says that the push needs, kept by (size, mtime) so a log
/// is parsed again only when it changed.
#[derive(Debug, Clone)]
struct LogFacts {
    mode: ChatMode,
    cli: Option<String>,
}

/// The hashes and log facts of earlier pushes, for the life of the app.
#[derive(Debug, Default)]
pub struct PushCache {
    hashes: HashCache,
    logs: BTreeMap<PathBuf, (u64, Option<SystemTime>, LogFacts)>,
}

impl PushCache {
    fn facts(&mut self, log: &Path) -> Option<LogFacts> {
        let meta = fs::metadata(log).ok()?;
        let key = (meta.len(), meta.modified().ok());
        if let Some((len, m, f)) = self.logs.get(log)
            && (*len, *m) == key
            && key.1.is_some()
        {
            return Some(f.clone());
        }
        let session = Session::load(log).ok()?;
        let facts = LogFacts {
            mode: session.mode(),
            cli: session
                .agent_session()
                .filter(|(agent, _)| *agent == AGENT)
                .map(|(_, id)| id.to_string()),
        };
        self.logs
            .insert(log.to_path_buf(), (key.0, key.1, facts.clone()));
        Some(facts)
    }
}

/// Every file of the snapshot, hashed; `skipped` gets a sentence for each
/// file that could not be read (sent next time it can be).
pub fn collect(
    snap: &MacSnapshot,
    cache: &mut PushCache,
    skipped: &mut Vec<String>,
) -> Vec<Outgoing> {
    let mut out = Vec::new();
    fn add_file(
        rel: String,
        path: PathBuf,
        out: &mut Vec<Outgoing>,
        cache: &mut PushCache,
        skipped: &mut Vec<String>,
    ) {
        if !super::Layout::allowed(&rel) {
            skipped.push(format!(
                "{} has a name the mirror cannot keep",
                path.display()
            ));
            return;
        }
        match cache.hashes.hash(&path) {
            Ok((size, sha256)) => out.push(Outgoing {
                entry: Entry {
                    path: rel,
                    size,
                    sha256,
                },
                source: Source::File(path),
            }),
            Err(e) => skipped.push(format!("{}: {e}", path.display())),
        }
    }

    let agents = snap.config.join("AGENTS.md");
    if agents.is_file() {
        add_file("AGENTS.md".into(), agents, &mut out, cache, skipped);
    }
    // The model list (item 272): no file on the Mac, none on the server,
    // and the server's pickers fall back to the built-in list.
    let models = snap.config.join(super::MODEL_LIST_FILE);
    if models.is_file() {
        add_file(
            super::MODEL_LIST_FILE.into(),
            models,
            &mut out,
            cache,
            skipped,
        );
    }
    for (rel, path) in walk(&snap.vault) {
        add_file(format!("knowledge/{rel}"), path, &mut out, cache, skipped);
    }

    let mut listed = Vec::new();
    for p in snap.projects.iter().filter(|p| p.available_away) {
        listed.push(MirrorProject {
            id: p.id.clone(),
            name: p.name.clone(),
        });
        let base = format!("{PROJECTS_DIR}/{}", p.id);
        let memory = p.workspace_dir().join("AGENTS.md");
        if memory.is_file() {
            add_file(
                format!("{base}/AGENTS.md"),
                memory,
                &mut out,
                cache,
                skipped,
            );
        }
        let Ok(entries) = fs::read_dir(p.session_dir()) else {
            continue;
        };
        let mut logs: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|l| {
                l.is_file()
                    && l.extension().is_some_and(|x| x == "jsonl")
                    && l.file_name()
                        .is_some_and(|n| !n.to_string_lossy().starts_with('.'))
            })
            .collect();
        logs.sort();
        for log in logs {
            let Some(facts) = cache.facts(&log) else {
                skipped.push(format!("{} could not be read", log.display()));
                continue;
            };
            if facts.mode != ChatMode::Normal {
                continue;
            }
            let name = log
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            add_file(
                format!("{base}/{SESSIONS_DIR}/{name}"),
                log.clone(),
                &mut out,
                cache,
                skipped,
            );
            if let Some(sid) = facts.cli {
                // A chat whose CLI file is gone (cleaned up by the CLI) still
                // goes; a fork of it starts from the log alone.
                if let Ok(file) = cli_session::find(&snap.claude_projects, &p.workspace_dir(), &sid)
                {
                    let folder = file
                        .parent()
                        .and_then(Path::file_name)
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    add_file(
                        format!("claude/{folder}/{sid}.jsonl"),
                        file,
                        &mut out,
                        cache,
                        skipped,
                    );
                }
            }
        }
    }
    listed.sort_by(|a, b| a.id.cmp(&b.id));
    let body = serde_json::to_vec_pretty(&listed).unwrap_or_default();
    out.push(Outgoing {
        entry: Entry {
            path: PROJECTS_FILE.into(),
            size: body.len() as u64,
            sha256: manifest::sha256_hex(&body),
        },
        source: Source::Bytes(body),
    });
    // One entry per path (two logs naming one CLI file send it once).
    let mut seen = std::collections::BTreeSet::new();
    out.retain(|o| seen.insert(o.entry.path.clone()));
    out
}

/// Every file under `dir`, as (`/`-separated relative path, path); hidden
/// files and folders skipped.
fn walk(dir: &Path) -> Vec<(String, PathBuf)> {
    let mut out = Vec::new();
    if !dir.is_dir() {
        return out;
    }
    for entry in walkdir::WalkDir::new(dir)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| e.depth() == 0 || !e.file_name().to_string_lossy().starts_with('.'))
        .flatten()
    {
        if !entry.file_type().is_file() {
            continue;
        }
        if let Ok(rel) = entry.path().strip_prefix(dir) {
            let rel: Vec<String> = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect();
            out.push((rel.join("/"), entry.path().to_path_buf()));
        }
    }
    out.sort();
    out
}

/// What a push did.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct PushReport {
    /// Files in the snapshot.
    pub files: usize,
    /// Files sent this time.
    pub sent: usize,
    /// Bytes sent this time.
    pub bytes: u64,
    /// Server copies dropped (no longer in the snapshot).
    pub removed: usize,
    /// Files that could not be read or sent, in words.
    pub skipped: Vec<String>,
}

/// Send the snapshot: the manifest, then each file the server asks for.
/// A file that changed between hashing and sending is sent with the hash
/// of what was read, so the server's index is never wrong about it; the
/// next manifest catches up.
pub async fn send(
    client: &Client,
    outgoing: Vec<Outgoing>,
    mut skipped: Vec<String>,
) -> Result<PushReport, String> {
    let manifest = Manifest {
        entries: outgoing.iter().map(|o| o.entry.clone()).collect(),
    };
    let reply: ManifestReply = client.post_json("manifest", &manifest).await?;
    let need: std::collections::BTreeSet<String> = reply.need.into_iter().collect();
    let mut report = PushReport {
        files: outgoing.len(),
        removed: reply.removed,
        ..PushReport::default()
    };
    for o in outgoing
        .into_iter()
        .filter(|o| need.contains(&o.entry.path))
    {
        let bytes = match &o.source {
            Source::Bytes(b) => b.clone(),
            Source::File(p) => match tokio::fs::read(p).await {
                Ok(b) => b,
                Err(e) => {
                    skipped.push(format!("{}: {e}", p.display()));
                    continue;
                }
            },
        };
        let sha = manifest::sha256_hex(&bytes);
        let len = bytes.len() as u64;
        client.put_file(&o.entry.path, &sha, bytes).await?;
        report.sent += 1;
        report.bytes += len;
    }
    report.skipped = skipped;
    Ok(report)
}
