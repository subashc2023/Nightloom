//! Proposals: the dream's suggested edits to the always-loaded files.
//!
//! Two files are read *whole* into every conversation's system prompt — a
//! project's `AGENTS.md` and the user's `~/.nightloom/AGENTS.md` — which is
//! exactly why the dream may not touch them. Every other note the pass files
//! is read on demand and can be wrong quietly; a line in one of these shapes
//! every turn from the next chat on, and a consolidation pass that rewrote
//! it unattended would be the one writer whose mistake nobody reviewed
//! before it took effect. So the pass **proposes**: it writes a file beside
//! the store, the app shows the proposal as a diff against the current
//! text, and the user loads it into the editor as a draft — still theirs to
//! edit or revert — and saves it, or dismisses it. Nothing here opens either
//! `AGENTS.md` for writing, and `dream.rs` pins that with a byte-for-byte
//! test.
//!
//! One proposal is one JSON file, `<store>/proposals/<stamp>.json`, where
//! the store is `~/.nightloom/projects/<id>/` for a project and
//! `~/.nightloom/` for the user. A proposal the user acted on is **moved,
//! never deleted**: `proposals/dismissed/` or `proposals/applied/` (the
//! latter carrying a hash of what was actually saved, which may differ from
//! what was proposed — the draft was editable). What the dream suggested
//! and what the user did with it is information, the same argument the
//! supersede-don't-erase rule makes for notes.
//!
//! **The user's memory is instructions only (2026-09-15, nightshift backlog
//! 055).** A proposal for `~/.nightloom/AGENTS.md` that would add one of
//! the claude.ai export's biographical sections is not offered at all: it
//! is written under `proposals/held/` with a [`Held`] note saying why, the
//! model is told to file the facts in the vault instead, and the pending
//! queue never sees it. The prompt (`dream::compose_instruction`) says the
//! rule first; the guard is the cheap check behind the prompt.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Utc};
use nightloom_core::ToolDef;
use nightloom_core::tool::{CancellationToken, Effect, Tool};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::project::PROJECTS_DIR;

/// Subdirectory of a store holding its pending proposals.
pub const PROPOSALS_DIR: &str = "proposals";
/// Where a dismissed proposal goes, under [`PROPOSALS_DIR`].
pub const DISMISSED_DIR: &str = "dismissed";
/// Where an applied proposal goes, under [`PROPOSALS_DIR`].
pub const APPLIED_DIR: &str = "applied";
/// Where a proposal the guard held back goes, under [`PROPOSALS_DIR`] —
/// filed with a note, never offered as a draft. See [`Held`].
pub const HELD_DIR: &str = "held";

/// The most a proposed replacement may be. The preamble reads the file it
/// replaces under the same per-file ceiling (`prompt::FILE_LIMIT`), so a
/// proposal past it would be truncated in every prompt it shaped — better
/// refused with a sentence the model can act on. The instruction asks for
/// far less (about 4,000 characters); this is the hard stop, not the goal.
pub const TEXT_LIMIT: usize = 32 * 1024;

/// Which always-loaded file a proposal is for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProposalTarget {
    /// `<workspace>/AGENTS.md` of the registered project `id`. The name is
    /// carried so a shell can say whose instructions without a registry
    /// lookup; the id is what the store is keyed on.
    Project { id: String, name: String },
    /// `~/.nightloom/AGENTS.md`: user memory, read everywhere.
    User,
}

impl ProposalTarget {
    /// The store a proposal for this target lives beside, under `config`:
    /// the project's directory, or the config dir itself for the user.
    /// Built from the passed config rather than `project::store_dir` so a
    /// job handed its config (a test, a dream over a temp home) files beside
    /// the registry it read; in production the two agree.
    pub fn store_in(&self, config: &Path) -> PathBuf {
        match self {
            ProposalTarget::Project { id, .. } => config.join(PROJECTS_DIR).join(id),
            ProposalTarget::User => config.to_path_buf(),
        }
    }

    /// "Lanternfish's instructions" / "your memory" — the phrase every shell
    /// uses, so the CLI line and the toast agree.
    pub fn described(&self) -> String {
        match self {
            ProposalTarget::Project { name, .. } => format!("{name}'s instructions"),
            ProposalTarget::User => "your memory".into(),
        }
    }
}

/// One proposed replacement for an always-loaded file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Proposal {
    /// Schema version, `1`.
    pub v: u32,
    /// When it was proposed — the last call, when a turn replaced its own.
    pub at: DateTime<Utc>,
    pub target: ProposalTarget,
    /// The model's one paragraph on what changed and which observations
    /// asked for it. Shown above the diff.
    pub why: String,
    /// The full replacement text. A whole file rather than a patch: the
    /// user reads a diff either way, and a patch against a file they may
    /// have edited since is one that fails to apply at the worst moment.
    pub text: String,
    /// `true` when the dream proposed it — the only writer today, kept as a
    /// field so a second source (the capture pass, a chat) can be told apart
    /// later without a schema change.
    pub from_dream: bool,
    /// Set when the proposal was applied and moved aside; see [`applied`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied: Option<Applied>,
    /// Set when the proposal was dismissed and moved aside; see [`dismiss`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dismissed_at: Option<DateTime<Utc>>,
    /// Set when the guard held the proposal back instead of offering it;
    /// see [`Held`]. Such a file is written under `held/` from the start
    /// and never sits in the pending queue.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub held: Option<Held>,
}

/// Why a proposal for the user's memory was filed under [`HELD_DIR`] rather
/// than offered.
///
/// The user's `~/.nightloom/AGENTS.md` is instructions only — how the model
/// should behave, everywhere — since 2026-09-15 (nightshift backlog 055):
/// facts about the user live in the vault and are read on demand. The
/// prompt says so; this is the cheap check behind it. A replacement that
/// grows one of the claude.ai export's biographical headings (`Work
/// context`, `Personal context`, `Top of mind`, `Brief history` —
/// `import::EXPORT_MEMORY_HEADINGS`) is the export's shape coming back
/// through the dream, and it is kept as a record with the reason rather
/// than shown as a diff the user would have to decline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Held {
    pub at: DateTime<Utc>,
    /// One sentence naming the headings, for whoever reads the record.
    pub why: String,
}

/// What was saved when a proposal was applied. The hash is of the text the
/// user actually saved, not the proposed text: the draft was editable, and
/// the difference between the two is the user's edit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Applied {
    pub at: DateTime<Utc>,
    /// `fnv1a64:<hex>` over the saved bytes.
    pub hash: String,
}

/// A pending proposal as a shell lists it: its file's stem (the handle every
/// other operation takes) and its content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Entry {
    pub id: String,
    pub proposal: Proposal,
}

/// `<store>/proposals`.
pub fn dir_in(store: &Path) -> PathBuf {
    store.join(PROPOSALS_DIR)
}

/// The file a new proposal is written to: a stamp that sorts in time order
/// and is legal on every filesystem — RFC 3339 with `-` where it has `:`,
/// since a colon is not a Windows filename.
fn stamp(at: DateTime<Utc>) -> String {
    at.format("%Y-%m-%dT%H-%M-%S%.3fZ").to_string()
}

/// A handle is a file stem, nothing more: anything that could leave the
/// proposals folder is refused rather than resolved.
fn check_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.contains('/')
        || id.contains('\\')
        || id.contains("..")
        || id.starts_with('.')
    {
        return Err(format!("not a proposal id: {id:?}"));
    }
    Ok(())
}

fn path_of(store: &Path, id: &str) -> Result<PathBuf, String> {
    check_id(id)?;
    Ok(dir_in(store).join(format!("{id}.json")))
}

/// Write `proposal` to `path`, creating the folder. Written whole — one
/// small JSON document — so a reader never sees half of one.
fn write_at(path: &Path, proposal: &Proposal) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(proposal).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| format!("could not write {}: {e}", path.display()))
}

fn read_at(path: &Path) -> Result<Proposal, String> {
    let bytes =
        std::fs::read(path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("{} is not a proposal: {e}", path.display()))
}

/// Every pending proposal in `store`, newest first. A file that does not
/// parse is skipped rather than fatal — one hand-edited or half-written
/// file must not hide the rest — and the subfolders (dismissed, applied,
/// held) are not walked: they are the record, not the queue.
pub fn list_in(store: &Path) -> Vec<Entry> {
    let dir = dir_in(store);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out: Vec<Entry> = entries
        .flatten()
        .filter(|e| e.path().is_file())
        .filter_map(|e| {
            let path = e.path();
            let id = path.file_stem()?.to_str()?.to_string();
            if path.extension().and_then(|x| x.to_str()) != Some("json") {
                return None;
            }
            let proposal = read_at(&path).ok()?;
            Some(Entry { id, proposal })
        })
        .collect();
    // By time, then by name for two written in the same millisecond.
    out.sort_by(|a, b| {
        b.proposal
            .at
            .cmp(&a.proposal.at)
            .then_with(|| b.id.cmp(&a.id))
    });
    out
}

/// One pending proposal by handle.
pub fn read(store: &Path, id: &str) -> Result<Proposal, String> {
    read_at(&path_of(store, id)?)
}

/// Move a pending proposal under `dismissed/`, stamped. Returns where it
/// went. A move rather than a delete: what the pass suggested and was turned
/// down is worth keeping — it is the record a later pass would need to stop
/// suggesting the same thing.
pub fn dismiss(store: &Path, id: &str) -> Result<PathBuf, String> {
    let from = path_of(store, id)?;
    let mut proposal = read_at(&from)?;
    proposal.dismissed_at = Some(Utc::now());
    let to = dir_in(store).join(DISMISSED_DIR).join(format!("{id}.json"));
    move_to(&from, &to, &proposal)?;
    Ok(to)
}

/// Move a pending proposal under `applied/`, recording a hash of `saved` —
/// the text the user actually wrote to the file, which the draft let them
/// change first. Returns where it went.
pub fn applied(store: &Path, id: &str, saved: &str) -> Result<PathBuf, String> {
    let from = path_of(store, id)?;
    let mut proposal = read_at(&from)?;
    proposal.applied = Some(Applied {
        at: Utc::now(),
        hash: content_hash(saved),
    });
    let to = dir_in(store).join(APPLIED_DIR).join(format!("{id}.json"));
    move_to(&from, &to, &proposal)?;
    Ok(to)
}

/// Write the updated record at `to`, then remove `from` — in that order, so
/// a failure between the two leaves a duplicate rather than a hole.
fn move_to(from: &Path, to: &Path, proposal: &Proposal) -> Result<(), String> {
    write_at(to, proposal)?;
    std::fs::remove_file(from).map_err(|e| format!("could not remove {}: {e}", from.display()))
}

/// `fnv1a64:<hex>` over the text. FNV-1a because the crate has no hashing
/// dependency and `project.rs` already relies on the same function for ids;
/// the hash exists to say "this is what was saved", not to resist anyone.
pub fn content_hash(text: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("fnv1a64:{hash:016x}")
}

// ---- the tool ---------------------------------------------------------------

const PROPOSE_DESC: &str = "Propose a full replacement for the always-loaded instruction file of \
     the folder you are consolidating into — the project's AGENTS.md, or the user's memory \
     file (~/.nightloom/AGENTS.md) when you are filing into the vault. Its current text is \
     quoted in your instructions. Call this only when an observation in this batch contradicts \
     something the file says or establishes something every conversation should know from its \
     first turn; never to restate what the notes here already hold, which are read on demand. \
     The file is read whole into every conversation's system prompt, so keep the replacement \
     under about 4,000 characters. You cannot write the file: the proposal is shown to the user \
     in the app as a diff against the current text, and only they apply it. At most one \
     proposal per pass — a second call replaces the first. The user's memory file is \
     instructions only: how to behave, everywhere. Facts about the user — who they are, what \
     they work on, what happened — belong in the vault's profile.md, a topic note or \
     background.md, never in this file; a replacement that adds a Work context, Personal \
     context, Top of mind or Brief history section is held back and not shown.";

/// The `propose_instructions` tool, available only inside a dream turn
/// (`dream::prepare` adds it; `tools::builtin_in` never does). Holds the
/// store it writes beside, the target the proposal names, the file's text
/// as the pass was shown it (so the guard can tell a heading the proposal
/// *adds* from one the file already had), and the paths of what it wrote
/// this turn, so a second call overwrites rather than files a second
/// proposal.
pub struct ProposeInstructions {
    store: PathBuf,
    target: ProposalTarget,
    current: Option<String>,
    slot: Arc<Mutex<SlotState>>,
}

/// What one turn's tool has written: the proposal on offer, and the last
/// one the guard held back. Two paths rather than one flag, because the
/// dream reports the first and a test reads the second.
#[derive(Debug, Default)]
struct SlotState {
    written: Option<PathBuf>,
    held: Option<PathBuf>,
}

/// What the dream inspects after the turn: did the model propose, and where
/// the file is. A clone of the tool's own slot, so the answer is the tool's
/// and not a directory listing that could pick up an older proposal.
#[derive(Debug, Clone)]
pub struct ProposalSlot(Arc<Mutex<SlotState>>);

impl ProposalSlot {
    /// The proposal this turn wrote and is offering, if it wrote one. A
    /// held proposal is not one: it is filed, not offered.
    pub fn path(&self) -> Option<PathBuf> {
        self.0.lock().unwrap().written.clone()
    }

    /// The proposal the guard held back this turn, if any — the record
    /// under [`HELD_DIR`] with its [`Held`] note.
    pub fn held(&self) -> Option<PathBuf> {
        self.0.lock().unwrap().held.clone()
    }
}

impl ProposeInstructions {
    pub fn new(store: PathBuf, target: ProposalTarget) -> (Self, ProposalSlot) {
        let slot = Arc::new(Mutex::new(SlotState::default()));
        (
            Self {
                store,
                target,
                current: None,
                slot: slot.clone(),
            },
            ProposalSlot(slot),
        )
    }

    /// Tell the tool what the always-loaded file says now — the same text
    /// the instruction quotes — so the guard judges what a proposal adds.
    /// Without it, every export heading in a proposal counts as added.
    pub fn against(mut self, current: Option<&str>) -> Self {
        self.current = current.map(str::to_string);
        self
    }
}

/// The export's biographical headings a proposal for the user's memory
/// carries that the file does not have yet, as the lines were written.
/// Empty for any other target — a project's `AGENTS.md` has its own rules,
/// and the section names are the export's shape for the *user*.
pub fn background_headings_added(
    target: &ProposalTarget,
    text: &str,
    current: Option<&str>,
) -> Vec<String> {
    if *target != ProposalTarget::User {
        return Vec::new();
    }
    let already: Vec<String> = current
        .unwrap_or_default()
        .lines()
        .filter(|l| crate::import::is_export_memory_heading(l))
        .map(heading_key)
        .collect();
    text.lines()
        .filter(|l| crate::import::is_export_memory_heading(l))
        .filter(|l| !already.contains(&heading_key(l)))
        .map(|l| l.trim().to_string())
        .collect()
}

/// `**Work context**` and `## work context` are the same heading for the
/// purpose of "did the file already have it".
fn heading_key(line: &str) -> String {
    line.trim()
        .trim_matches(|c: char| c == '#' || c == '*' || c == '_' || c == ':' || c.is_whitespace())
        .to_ascii_lowercase()
}

#[async_trait::async_trait]
impl Tool for ProposeInstructions {
    /// `Mutating`, honestly: it writes a file the app will show. The dream
    /// runs with no approver, so the effect gates nothing there; it is the
    /// right answer should the tool ever reach a chat that has one, because
    /// a proposal the user did not ask for is exactly what a gate is for.
    fn effect(&self) -> Effect {
        Effect::Mutating
    }

    fn def(&self) -> ToolDef {
        ToolDef {
            name: "propose_instructions".into(),
            description: PROPOSE_DESC.into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "The full replacement text of the file, not a patch."
                    },
                    "why": {
                        "type": "string",
                        "description": "One paragraph: what changed, and which observations asked for it."
                    }
                },
                "required": ["text", "why"]
            }),
        }
    }

    async fn call(&self, input: Value, _cancel: &CancellationToken) -> Result<String, String> {
        let text = input["text"]
            .as_str()
            .filter(|t| !t.trim().is_empty())
            .ok_or_else(|| "missing required argument: text".to_string())?;
        if text.len() > TEXT_LIMIT {
            return Err(format!(
                "the replacement is {} bytes; the file is read whole into every prompt and is \
                 capped at {} — cut it to what every conversation needs on its first turn",
                text.len(),
                TEXT_LIMIT
            ));
        }
        let why = input["why"]
            .as_str()
            .map(str::trim)
            .filter(|w| !w.is_empty())
            .ok_or_else(|| "missing required argument: why".to_string())?;
        let now = Utc::now();
        let mut proposal = Proposal {
            v: 1,
            at: now,
            target: self.target.clone(),
            why: why.to_string(),
            text: text.to_string(),
            from_dream: true,
            applied: None,
            dismissed_at: None,
            held: None,
        };
        // The slot is held across the write so two calls racing (which a
        // turn never does — tools run one at a time — but a lock is cheaper
        // than the argument) cannot both decide they are the first.
        let mut slot = self.slot.lock().unwrap();

        // The guard: a replacement for the user's memory that grows one of
        // the export's biographical sections is filed under held/ with the
        // reason, and the model is told what to do instead. An earlier
        // proposal this turn offered stays on offer — the refused text was
        // meant to replace it, and a refusal is not a replacement.
        let added = background_headings_added(&self.target, text, self.current.as_deref());
        if !added.is_empty() {
            let why = format!(
                "held back, not offered: the replacement adds {} to the user's memory, which is \
                 instructions only — facts about the user go to the vault (profile.md, a topic \
                 note, background.md) and are read on demand",
                added.join(", ")
            );
            proposal.held = Some(Held {
                at: now,
                why: why.clone(),
            });
            let path = slot.held.clone().unwrap_or_else(|| {
                dir_in(&self.store)
                    .join(HELD_DIR)
                    .join(format!("{}.json", stamp(now)))
            });
            write_at(&path, &proposal)?;
            slot.held = Some(path);
            return Ok(format!(
                "Not proposed — {why}. The text was filed as a record and will not be shown to \
                 the user. If the instructions themselves need changing, call again with a \
                 replacement that carries no section about who the user is; file the facts \
                 in the vault with the file tools instead.",
            ));
        }

        let replaced = slot.written.is_some();
        let path = slot
            .written
            .clone()
            .unwrap_or_else(|| dir_in(&self.store).join(format!("{}.json", stamp(now))));
        write_at(&path, &proposal)?;
        slot.written = Some(path);
        Ok(format!(
            "Proposed{}. The user will see it in the app as a diff against the current file \
             and decide; nothing was written to the file itself.",
            if replaced {
                " — replacing this pass's earlier proposal"
            } else {
                ""
            }
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::test_dir;

    fn project() -> ProposalTarget {
        ProposalTarget::Project {
            id: "abc".into(),
            name: "Lanternfish".into(),
        }
    }

    async fn propose(tool: &ProposeInstructions, text: &str, why: &str) -> Result<String, String> {
        tool.call(
            json!({ "text": text, "why": why }),
            &CancellationToken::new(),
        )
        .await
    }

    #[test]
    fn the_store_is_beside_the_registry_that_was_read() {
        let config = Path::new("/cfg");
        assert_eq!(
            project().store_in(config),
            PathBuf::from("/cfg/projects/abc")
        );
        assert_eq!(ProposalTarget::User.store_in(config), PathBuf::from("/cfg"));
        assert_eq!(project().described(), "Lanternfish's instructions");
        assert_eq!(ProposalTarget::User.described(), "your memory");
    }

    #[tokio::test]
    async fn the_tool_writes_a_well_formed_file_under_the_store() {
        let store = test_dir("proposal-write");
        let (tool, slot) = ProposeInstructions::new(store.clone(), project());
        assert!(slot.path().is_none());
        let reply = propose(
            &tool,
            "# Lanternfish\n\nUse tokio.\n",
            "Observation 2 says tokio.",
        )
        .await
        .unwrap();
        assert!(reply.contains("nothing was written to the file itself"));
        assert!(!reply.contains("replacing"));

        let path = slot.path().expect("the slot knows the file");
        assert_eq!(path.parent().unwrap(), dir_in(&store));
        assert_eq!(path.extension().unwrap(), "json");
        // The stamp has no colon: a Windows filename cannot.
        assert!(!path.file_name().unwrap().to_str().unwrap().contains(':'));

        let listed = list_in(&store);
        assert_eq!(listed.len(), 1);
        let p = &listed[0].proposal;
        assert_eq!(p.v, 1);
        assert_eq!(p.target, project());
        assert_eq!(p.text, "# Lanternfish\n\nUse tokio.\n");
        assert_eq!(p.why, "Observation 2 says tokio.");
        assert!(p.from_dream);
        assert!(p.applied.is_none() && p.dismissed_at.is_none());
        // The serialized target is tagged, so a reader can tell the kinds
        // apart without the Rust type.
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["target"]["kind"], "project");
        assert_eq!(raw["target"]["name"], "Lanternfish");
    }

    #[tokio::test]
    async fn a_second_call_in_one_turn_replaces_the_first() {
        let store = test_dir("proposal-replace");
        let (tool, slot) = ProposeInstructions::new(store.clone(), ProposalTarget::User);
        propose(&tool, "first", "one").await.unwrap();
        let first = slot.path().unwrap();
        let reply = propose(&tool, "second", "two").await.unwrap();
        assert!(reply.contains("replacing"));
        assert_eq!(slot.path().unwrap(), first);
        let listed = list_in(&store);
        assert_eq!(listed.len(), 1, "one file, not two");
        assert_eq!(listed[0].proposal.text, "second");
        assert_eq!(listed[0].proposal.target, ProposalTarget::User);
    }

    #[tokio::test]
    async fn empty_text_a_missing_why_and_an_oversized_text_are_refused() {
        let store = test_dir("proposal-refuse");
        let (tool, slot) = ProposeInstructions::new(store.clone(), ProposalTarget::User);
        let err = propose(&tool, "   ", "why").await.unwrap_err();
        assert!(err.contains("text"), "{err}");
        let err = tool
            .call(json!({ "text": "fine" }), &CancellationToken::new())
            .await
            .unwrap_err();
        assert!(err.contains("why"), "{err}");
        let big = "x".repeat(TEXT_LIMIT + 1);
        let err = propose(&tool, &big, "why").await.unwrap_err();
        assert!(err.contains("capped"), "{err}");
        assert!(slot.path().is_none(), "nothing was written");
        assert!(list_in(&store).is_empty());
    }

    #[test]
    fn list_in_orders_newest_first_and_skips_what_does_not_parse() {
        let store = test_dir("proposal-list");
        let dir = dir_in(&store);
        std::fs::create_dir_all(&dir).unwrap();
        let mut p = Proposal {
            v: 1,
            at: Utc::now(),
            target: ProposalTarget::User,
            why: "old".into(),
            text: "old".into(),
            from_dream: true,
            applied: None,
            dismissed_at: None,
            held: None,
        };
        p.at = "2026-09-13T00:00:00Z".parse().unwrap();
        write_at(&dir.join("older.json"), &p).unwrap();
        p.at = "2026-09-14T00:00:00Z".parse().unwrap();
        p.why = "new".into();
        write_at(&dir.join("newer.json"), &p).unwrap();
        std::fs::write(dir.join("broken.json"), "{ not json").unwrap();
        std::fs::write(dir.join("notes.txt"), "not a proposal").unwrap();
        // The record folders are not the queue.
        std::fs::create_dir_all(dir.join(DISMISSED_DIR)).unwrap();
        write_at(&dir.join(DISMISSED_DIR).join("gone.json"), &p).unwrap();

        let ids: Vec<String> = list_in(&store).into_iter().map(|e| e.id).collect();
        assert_eq!(ids, ["newer", "older"]);
        assert_eq!(read(&store, "newer").unwrap().why, "new");
        assert!(list_in(&store.join("nowhere")).is_empty());
    }

    #[test]
    fn dismiss_and_applied_move_the_file_rather_than_delete_it() {
        let store = test_dir("proposal-move");
        let dir = dir_in(&store);
        std::fs::create_dir_all(&dir).unwrap();
        let p = Proposal {
            v: 1,
            at: Utc::now(),
            target: ProposalTarget::User,
            why: "w".into(),
            text: "proposed".into(),
            from_dream: true,
            applied: None,
            dismissed_at: None,
            held: None,
        };
        write_at(&dir.join("a.json"), &p).unwrap();
        write_at(&dir.join("b.json"), &p).unwrap();

        let to = dismiss(&store, "a").unwrap();
        assert_eq!(to, dir.join(DISMISSED_DIR).join("a.json"));
        assert!(!dir.join("a.json").exists());
        let moved = read_at(&to).unwrap();
        assert!(moved.dismissed_at.is_some());
        assert_eq!(moved.text, "proposed");

        // The user edited the draft before saving; the hash is of what
        // they saved, and the proposed text is still in the record.
        let to = applied(&store, "b", "proposed, then edited").unwrap();
        assert_eq!(to, dir.join(APPLIED_DIR).join("b.json"));
        assert!(!dir.join("b.json").exists());
        let moved = read_at(&to).unwrap();
        let a = moved.applied.expect("applied record");
        assert_eq!(a.hash, content_hash("proposed, then edited"));
        assert_ne!(a.hash, content_hash("proposed"));
        assert!(a.hash.starts_with("fnv1a64:"));
        assert_eq!(moved.text, "proposed");

        assert!(list_in(&store).is_empty());
        // A handle that is not a stem is refused, not resolved.
        assert!(read(&store, "../a").is_err());
        assert!(dismiss(&store, "dismissed/a").is_err());
        assert!(read(&store, "missing").is_err());
    }

    /// What counts as an added section: the export's four, in either
    /// spelling, for the user's file only, and not one the file already had.
    #[test]
    fn added_background_headings_are_the_export_s_and_the_user_s_only() {
        let user = ProposalTarget::User;
        let text = "# Me\n\n## Work context\n\nA freshman.\n\n**Top of mind**\n\nFinals.\n";
        assert_eq!(
            background_headings_added(&user, text, None),
            ["## Work context", "**Top of mind**"]
        );
        // Already in the file, in the other spelling: not added.
        assert_eq!(
            background_headings_added(&user, text, Some("**work context**\n")),
            ["**Top of mind**"]
        );
        assert!(background_headings_added(&user, "# Me\n\nBe terse.\n", None).is_empty());
        // A project's AGENTS.md has no such rule.
        assert!(background_headings_added(&project(), text, None).is_empty());
    }

    /// The held path end to end at the tool: the record lands under
    /// `held/` with its note, the queue stays empty, the slot says held and
    /// not written, and the reply tells the model what to do instead. An
    /// earlier offered proposal is not withdrawn by a refused replacement.
    #[tokio::test]
    async fn a_biographical_proposal_for_the_user_is_held_with_a_note() {
        let store = test_dir("proposal-held");
        let (tool, slot) = ProposeInstructions::new(store.clone(), ProposalTarget::User);
        let tool = tool.against(Some("# Me\n\nBe terse.\n"));

        let reply = propose(&tool, "# Me\n\n**Brief history**\n\nMoved west.\n", "w")
            .await
            .unwrap();
        assert!(reply.starts_with("Not proposed"), "{reply}");
        assert!(reply.contains("**Brief history**"));
        assert!(reply.contains("file the facts in the vault"));
        assert!(list_in(&store).is_empty());
        assert!(slot.path().is_none());
        let held = slot.held().expect("a held record");
        assert_eq!(held.parent().unwrap(), dir_in(&store).join(HELD_DIR));
        let record = read_at(&held).unwrap();
        assert_eq!(record.target, ProposalTarget::User);
        assert_eq!(record.text, "# Me\n\n**Brief history**\n\nMoved west.\n");
        let note = record.held.expect("held note");
        assert!(note.why.contains("**Brief history**"));
        assert!(note.why.contains("instructions only"));

        // Offered, then a refused replacement: the offer stands.
        propose(&tool, "# Me\n\nBe terse and metric.\n", "w")
            .await
            .unwrap();
        assert!(slot.path().is_some());
        let reply = propose(&tool, "# Me\n\n## Personal context\n\nLifts.\n", "w")
            .await
            .unwrap();
        assert!(reply.starts_with("Not proposed"));
        assert_eq!(list_in(&store).len(), 1);
        assert_eq!(
            list_in(&store)[0].proposal.text,
            "# Me\n\nBe terse and metric.\n"
        );
        // One held record per turn, the later text.
        assert_eq!(
            read_at(&slot.held().unwrap()).unwrap().text,
            "# Me\n\n## Personal context\n\nLifts.\n"
        );
        assert_eq!(
            std::fs::read_dir(dir_in(&store).join(HELD_DIR))
                .unwrap()
                .count(),
            1
        );
    }
}
