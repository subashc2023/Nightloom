//! Importing a claude.ai account export.
//!
//! A Claude project and a Nightloom project turn out to be the same four
//! things, which is what makes this a mapping rather than a translation:
//!
//! | claude.ai | Nightloom |
//! |---|---|
//! | the project | a folder, registered |
//! | its custom instructions (`prompt_template`) | `<root>/AGENTS.md` |
//! | its knowledge documents (`docs`) | the project's docspace |
//! | its conversations | the project's session logs |
//!
//! The last two live under `~/.nightloom/projects/<id>/`, keyed off the folder
//! this import creates — see [`crate::project`] for why Nightloom's own data
//! is not written into the user's folder.
//!
//! Nothing new is stored to make that work. The preamble already walks for
//! `AGENTS.md`, the docspace is already indexed into the system prompt, and
//! both shells already list the session logs in a folder — so an imported
//! project is an ordinary project the moment it is written, and `nightloom
//! --continue` inside it resumes a conversation that happened on the web.
//!
//! The account's *memory* maps the same way, onto the two note stores that
//! already exist (see [`import_memories`] for the table): the summary of the
//! user goes to the vault as [`BACKGROUND_NOTE`] and the user memory gets a
//! paragraph pointing at it (it was the user memory itself until 2026-09-15
//! — biography loaded into every chat, which is what the vault is for), the
//! global memory files go to the vault, and a project's summary and files
//! go under its `AGENTS.md` and docspace. One thing beyond that is new: a
//! project summary longer than [`MEMORY_INLINE_LIMIT`] is not inlined,
//! because `AGENTS.md` is loaded on every turn and the export's summaries
//! run to 13k characters.
//!
//! ## The export is the only way in
//!
//! There is no Projects API and no per-project export: the account-wide
//! privacy export (Settings → Privacy → Export Data, which arrives as a zip by
//! email) is the whole of the programmatic surface. It is read out of the zip
//! directly, because "unzip it first" is a step that goes wrong on a 400 MB
//! archive and buys nothing.
//!
//! **The projects moved, and neither layout is documented.** They used to be
//! one `projects.json` holding an array; current exports ship a `projects/`
//! directory with one file per project instead, each holding the object that
//! used to be one element of that array. Both are read, because both are in
//! circulation — but the array is preferred and the directory read *only*
//! when it is absent, since an archive carrying both would otherwise import
//! every project twice. Getting this wrong fails in the worst available
//! shape, which is why it went unnoticed: no project parses, so no
//! instructions and no documents are written, and every conversation falls
//! through to the unfiled path that exists for chats with no project link.
//! Nothing errors. It reads as an account whose projects were all deleted.
//!
//! ## Two decisions worth defending
//!
//! **Conversations are linked by id or not at all.** The export does not
//! reliably carry the link — `project_uuid` is present on some accounts'
//! conversations and absent on others — and the obvious workaround, matching a
//! conversation to a project by keyword similarity on its name, is what the
//! other tools in this space do. It is not available here. Filing a chat under
//! the wrong project is not a near miss: the projection reads the docspace of
//! whatever folder it lands in, so a mis-filed conversation comes back with
//! another project's notes in its system prompt. An unlinked conversation is
//! reported as unfiled and imported only if asked for, which is a gap the user
//! can see rather than a mistake they cannot.
//!
//! **claude.ai's tool calls are flattened to text, never replayed as tool
//! blocks.** This is the safety-critical half. A `tool_use` in an exported
//! conversation is a call to *claude.ai's* tools — artifacts, web search, the
//! analysis sandbox — none of which are on a Nightloom request. Recorded as a
//! [`ContentBlock::ToolUse`] it would be one of two invalid shapes on the very
//! next turn: unpaired, which is the orphan a provider 400s on (the same
//! failure [`nightloom_core::orphan_marker`] exists for), or paired but naming
//! a tool that was never advertised. Neither is recoverable by the model. So
//! the call and its result become text — an artifact keeps its content whole,
//! because the artifact is usually the thing the conversation was *for*, and a
//! machine-generated result is capped like any other tool output.
//!
//! Thinking is kept, and kept *unsigned*, which needs no special handling
//! because the invariant already exists: adapters replay only a reasoning token
//! they issued themselves, and Anthropic drops unsigned thinking rather than
//! sending it. So imported reasoning renders in the transcript and can never be
//! forged onto the wire.
//!
//! ## Reading is total
//!
//! One malformed conversation does not fail an import of nine hundred, on the
//! same argument [`nightloom_core::Session::load`] makes about a session log:
//! this is somebody's history and the failure worth surviving is a record this
//! build does not recognise. Every element is parsed on its own and what could
//! not be read is counted and reported.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer};

use nightloom_core::{ContentBlock, Session, SessionEvent, Usage};

use crate::project::{AGENTS_DIR, MEMORY_DIR, Registry, read_note, write_note};
use crate::tools::Root;

/// Bytes of one flattened tool *result* kept in the transcript.
///
/// Results are machine output — a web search returning forty pages of scraped
/// text is the ordinary case — and an import that carried them whole would
/// spend the window of every future turn in that session on them. Artifacts are
/// deliberately not capped by this: an artifact is the thing the user was
/// making, and truncating it would be throwing away the deliverable to save
/// space on the scaffolding.
const TOOL_RESULT_LIMIT: usize = 4096;

/// Filenames looked for, at any depth, in a zip or a folder.
const CONVERSATIONS: &str = "conversations.json";
const PROJECTS: &str = "projects.json";
/// The directory current exports ship *instead of* [`PROJECTS`], holding one
/// file per project rather than one array of them.
const PROJECTS_DIR: &str = "projects";
/// The directory holding the account's memory, one `<account uuid>.json`.
const MEMORIES_DIR: &str = "memories";

/// Longest project memory kept in `AGENTS.md` itself, in characters.
///
/// The export's per-project summaries run to 13k characters, and `AGENTS.md`
/// is loaded on every turn of every chat in the project. The always-loaded
/// layer is capped here (~1,000 tokens) and the full text goes to
/// `.agents/memory/summary.md` on demand either way; a summary over the cap
/// gets a pointer to it and a line in the report asking for a condensed
/// version, which is a judgement this import does not make for the user.
pub const MEMORY_INLINE_LIMIT: usize = 4000;
/// The heading a project's memory is appended under in `AGENTS.md`, and what
/// a second run looks for to know it has already been appended.
const MEMORY_HEADING: &str = "## Memory (imported from claude.ai";
// Where a project's memory files land, under the docspace, is
// `project::MEMORY_DIR` — the folder the dream also files into, so the two
// writers cannot drift apart.
/// The full project memory, kept on demand beside the other memory files.
const MEMORY_SUMMARY: &str = "summary.md";

/// The vault note the export's summary of the user is written to.
///
/// Not `~/.nightloom/AGENTS.md`, since 2026-09-15 (nightshift backlog 055).
/// That file is read whole into every conversation, and the export's
/// summary is biography — work context, personal context, what is top of
/// mind, a history — which a fitness question pays for and a research
/// question pays for the other way round. So the summary goes to the vault
/// as one note, read when a question needs it, and the always-loaded file
/// keeps instructions only plus a paragraph saying where the background is.
pub const BACKGROUND_NOTE: &str = "background.md";
/// The heading of the pointer paragraph in the user memory, and what a
/// second import looks for to know the paragraph is already there.
pub const BACKGROUND_HEADING: &str = "## Background, on demand";
/// The pointer paragraph itself: the one rule the vault index cannot carry,
/// and the one caveat an index line cannot.
///
/// Until 2026-09-15 this was word for word the hand edit of 2026-09-14 —
/// a folder list, the `@kb/` addressing, "use the index to pick", and how
/// to read a note on the Claude Code engine. Every one of those is already
/// in the prompt: the vault index lists the folders and root notes with a
/// line each and says how a note is reached, and the engine note says what
/// `@kb/<name>` is on Claude Code. So the paragraph paid for the same map
/// twice on every turn of every chat (nightshift backlog 060, blocker 064).
/// What is left is what nothing else says — that the background is not
/// here and is read one note at a time — and the staleness of
/// [`BACKGROUND_NOTE`], which no index line can carry.
pub const BACKGROUND_POINTER: &str = "## Background, on demand

Nothing about Swaraag — his history, work, projects, people — is loaded
here. It lives in the knowledge vault, listed in this prompt's vault index;
read the one note a question needs, not all of them. A fitness question does
not need his research context, and the other way round.

`@kb/background.md` is the long summary from the claude.ai export: who he is
and what he has worked on, partly out of date.";
/// The section headings the export's summary of the user carries — the
/// biographical ones, which is to say the ones that must never end up in
/// the always-loaded file. The importer warns when a user memory still has
/// them (an import from before the split), and the dream's proposal tool
/// holds back a proposal that would add one (`crate::proposal`).
pub const EXPORT_MEMORY_HEADINGS: [&str; 4] = [
    "Work context",
    "Personal context",
    "Top of mind",
    "Brief history",
];

/// Whether `line`, as a heading, is one of [`EXPORT_MEMORY_HEADINGS`].
///
/// The export writes them bold (`**Work context**`); a model asked for a
/// replacement writes them as Markdown headings (`## Work context`) as
/// often as not. So the line is stripped of heading marks, emphasis and a
/// trailing colon on both ends and compared without case, and a heading
/// with more words in it (`## Work context, spring`) does not match — the
/// guard is for the export's sections coming back, not for the word.
pub fn is_export_memory_heading(line: &str) -> bool {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return false;
    }
    let core = trimmed
        .trim_start_matches(|c: char| c == '#' || c == '*' || c == '_' || c.is_whitespace())
        .trim_end_matches(|c: char| c == '*' || c == '_' || c == ':' || c.is_whitespace());
    // A bare line of prose that happens to read "Top of mind" is a heading
    // only if it was marked as one; a paragraph is not.
    if core == trimmed {
        return false;
    }
    EXPORT_MEMORY_HEADINGS
        .iter()
        .any(|h| h.eq_ignore_ascii_case(core))
}

// ---------------------------------------------------------------------------
// The export's own shapes
// ---------------------------------------------------------------------------

/// A project as claude.ai exports it.
#[derive(Debug, Clone, Deserialize)]
pub struct ExportedProject {
    #[serde(default, deserialize_with = "null_as_default")]
    pub uuid: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub name: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub description: String,
    /// The project's custom instructions, under the name the export gives them.
    #[serde(default, deserialize_with = "null_as_default")]
    pub prompt_template: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub docs: Vec<ExportedDoc>,
}

/// One knowledge document attached to a project.
#[derive(Debug, Clone, Deserialize)]
pub struct ExportedDoc {
    #[serde(default, deserialize_with = "null_as_default")]
    pub filename: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub content: String,
}

/// A conversation, with the fields this import can act on.
///
/// Unknown fields are ignored rather than rejected — the export format has
/// changed at least twice and will again, and a new key on a conversation is
/// not a reason to refuse somebody's history.
#[derive(Debug, Clone, Deserialize)]
pub struct ExportedConversation {
    pub uuid: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub name: String,
    #[serde(default)]
    pub created_at: Option<DateTime<Utc>>,
    /// Last activity. Becomes the log file's modification time; see
    /// [`stamp`] for why that is not cosmetic.
    #[serde(default)]
    pub updated_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub model: Option<String>,
    /// Present on some accounts and not others; see the module docs on why a
    /// missing one is never guessed at.
    #[serde(default)]
    pub project_uuid: Option<String>,
    /// The same link, nested, as newer exports write it.
    #[serde(default)]
    pub project: Option<ProjectRef>,
    #[serde(default)]
    pub current_leaf_message_uuid: Option<String>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub chat_messages: Vec<ExportedMessage>,
}

impl ExportedConversation {
    /// The project this conversation belongs to, by id, from whichever of the
    /// two shapes the export used.
    pub fn project_id(&self) -> Option<&str> {
        self.project_uuid
            .as_deref()
            .or(self.project.as_ref().and_then(|p| p.uuid.as_deref()))
            .filter(|id| !id.is_empty())
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProjectRef {
    #[serde(default)]
    pub uuid: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExportedMessage {
    #[serde(default, deserialize_with = "null_as_default")]
    pub uuid: String,
    /// `"human"` or `"assistant"`.
    #[serde(default, deserialize_with = "null_as_default")]
    pub sender: String,
    /// The flat rendering, kept by the export alongside `content`. Used only
    /// when `content` is absent, which older exports do.
    #[serde(default, deserialize_with = "null_as_default")]
    pub text: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub content: Vec<ExportedBlock>,
    #[serde(default)]
    pub created_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub index: Option<i64>,
    #[serde(default)]
    pub parent_message_uuid: Option<String>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub attachments: Vec<ExportedAttachment>,
    #[serde(default, deserialize_with = "null_as_default")]
    pub files: Vec<ExportedFile>,
}

/// A content block, tagged the way the export tags them.
///
/// [`ExportedBlock::Other`] is the same device as
/// [`nightloom_core::SessionEvent::Unknown`] and exists for the same reason:
/// the list of block kinds grows on claude.ai's schedule, not on this
/// project's, and an unrecognised one should cost a line in the report rather
/// than the conversation it appeared in.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExportedBlock {
    Text {
        #[serde(default, deserialize_with = "null_as_default")]
        text: String,
    },
    Thinking {
        #[serde(default, deserialize_with = "null_as_default")]
        thinking: String,
    },
    VoiceNote {
        #[serde(default)]
        title: Option<String>,
        #[serde(default, deserialize_with = "null_as_default")]
        text: String,
    },
    ToolUse {
        #[serde(default, deserialize_with = "null_as_default")]
        name: String,
        #[serde(default, deserialize_with = "null_as_default")]
        input: serde_json::Value,
    },
    ToolResult {
        #[serde(default, deserialize_with = "null_as_default")]
        name: String,
        #[serde(default, deserialize_with = "null_as_default")]
        content: Vec<ToolResultPart>,
        #[serde(default, deserialize_with = "null_as_default")]
        is_error: bool,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ToolResultPart {
    #[serde(default)]
    pub text: Option<String>,
}

/// A file the user attached to a message.
///
/// `extracted_content` is the text claude.ai pulled out of it at upload time,
/// and it is all the export carries — the original bytes are not in the
/// archive. So an attachment becomes text or a named marker, never a
/// [`ContentBlock::Document`]; inventing a document block would mean writing a
/// log that claims to hold bytes it does not have.
#[derive(Debug, Clone, Deserialize)]
pub struct ExportedAttachment {
    #[serde(default, deserialize_with = "null_as_default")]
    pub file_name: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub file_type: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub extracted_content: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExportedFile {
    #[serde(default, deserialize_with = "null_as_default")]
    pub file_name: String,
}

/// The account's memory, as claude.ai exports it in `memories/<account>.json`.
///
/// Three layers: one summary of the user across every conversation, one
/// summary per project, and the memory files claude.ai keeps behind both
/// (`/profile.md`, `/projects/<uuid>/overview.md`, …). Not a `Deserialize`
/// because it is read a field at a time — see [`parse_memories_file`].
#[derive(Debug, Clone, Default)]
pub struct ExportedMemories {
    pub conversations_memory: String,
    /// Keyed by project uuid. A `BTreeMap` so two runs report in one order.
    pub project_memories: BTreeMap<String, String>,
    pub memory_files: Vec<ExportedMemoryFile>,
}

impl ExportedMemories {
    pub fn is_empty(&self) -> bool {
        self.conversations_memory.trim().is_empty()
            && self.project_memories.is_empty()
            && self.memory_files.is_empty()
    }
}

/// One of the memory files behind the summaries.
#[derive(Debug, Clone, Deserialize)]
pub struct ExportedMemoryFile {
    /// `/profile.md` for the user's own, `/projects/<uuid>/<rest>` for a
    /// project's. With the leading slash, as the export writes it.
    #[serde(default, deserialize_with = "null_as_default")]
    pub path: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub content: String,
}

impl ExportedMemoryFile {
    /// Where this file belongs: `(None, rest)` for the vault, `(Some(uuid),
    /// rest)` for a project's memory directory. `None` for a path with
    /// nothing after the project uuid, which names no file.
    fn destination(&self) -> Option<(Option<&str>, &str)> {
        let path = self.path.trim().trim_start_matches('/');
        if path.is_empty() {
            return None;
        }
        match path.strip_prefix(&format!("{PROJECTS_DIR}/")) {
            Some(rest) => {
                let (uuid, rest) = rest.split_once('/')?;
                if uuid.is_empty() || rest.is_empty() {
                    return None;
                }
                Some((Some(uuid), rest))
            }
            None => Some((None, path)),
        }
    }
}

/// Read a `null` as the field's default.
///
/// `#[serde(default)]` covers a field that is *absent*, not one that is present
/// and null — a distinction the export does not observe. A real archive
/// carries `"filename": null` on an attachment whose name was lost, and one of
/// those failed the entire conversation it appeared in: six chats out of 1,817,
/// each otherwise perfectly readable, dropped over a missing filename nothing
/// downstream needed. The argument the module makes about one bad record not
/// costing the other nine hundred applies inside a record too, so every field
/// that has a sensible empty value takes one rather than refusing.
///
/// `Option` fields are left alone: null is already what they are for.
fn null_as_default<'de, D, T>(de: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(de)?.unwrap_or_default())
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// A parsed export, and what could not be parsed.
#[derive(Debug, Default)]
pub struct Export {
    pub projects: Vec<ExportedProject>,
    pub conversations: Vec<ExportedConversation>,
    /// The account's memory, empty when the archive carried none.
    pub memories: ExportedMemories,
    /// Records this build could not read. Counted rather than fatal.
    pub unreadable: usize,
    pub warnings: Vec<String>,
}

/// The parts of an export a reader collects, in either layout.
///
/// A struct rather than a map keyed by filename, because the precedence rule
/// is the whole point: `projects` and `project_files` are two spellings of
/// one thing and are never both read.
#[derive(Default)]
struct ExportFiles {
    conversations: Option<Vec<u8>>,
    /// `projects.json` — every project in one array, the older layout.
    projects: Option<Vec<u8>>,
    /// `projects/*.json` — one project per file, kept with its name so a
    /// warning can say which of twenty could not be read.
    project_files: Vec<(String, Vec<u8>)>,
    /// `memories/*.json` — the account's memory, named by account uuid like
    /// the projects are by theirs.
    memory_files: Vec<(String, Vec<u8>)>,
}

impl ExportFiles {
    /// Whether nothing an export is made of was found. Memory alone does not
    /// count: it is an addition to an export, not one by itself.
    fn is_empty(&self) -> bool {
        self.conversations.is_none() && self.projects.is_none() && self.project_files.is_empty()
    }

    /// Sort one file into the export it belongs to.
    ///
    /// `in_projects` — whether the file's directory is the `projects/` one —
    /// is the only thing that identifies a per-project file. They are named
    /// by uuid, so there is nothing in the name to match on. `in_memories` is
    /// the same test for the `memories/` directory.
    fn take(&mut self, name: &str, in_projects: bool, in_memories: bool, bytes: Vec<u8>) {
        // Unzipping on a Mac and re-zipping the folder is an ordinary thing
        // to have happened, and `__MACOSX/projects/._p.json` is not a project.
        if name.starts_with('.') {
            return;
        }
        if name == CONVERSATIONS {
            self.conversations = Some(bytes);
        } else if in_projects && name.ends_with(".json") {
            self.project_files.push((name.to_string(), bytes));
        } else if in_memories && name.ends_with(".json") {
            self.memory_files.push((name.to_string(), bytes));
        } else if name == PROJECTS {
            self.projects = Some(bytes);
        }
    }

    /// Order the per-project files by name, so two runs of the same import
    /// read them in the same order — a directory listing arrives in whatever
    /// order the filesystem or the archive happened to give.
    fn sorted(mut self) -> Self {
        self.project_files.sort_by(|a, b| a.0.cmp(&b.0));
        self.memory_files.sort_by(|a, b| a.0.cmp(&b.0));
        self
    }
}

/// Whether a file's directory is one that identifies its contents by
/// position — `projects/` or `memories/` — as `(in_projects, in_memories)`.
fn directory_kind(dir: &str) -> (bool, bool) {
    (dir == PROJECTS_DIR, dir == MEMORIES_DIR)
}

/// Whether a file, by name and directory, is one an export is made of.
fn is_export_file(name: &str, in_projects: bool, in_memories: bool) -> bool {
    name == CONVERSATIONS
        || name == PROJECTS
        || ((in_projects || in_memories) && name.ends_with(".json"))
}

/// Read an export from the zip Anthropic emails, or from a folder it was
/// already unpacked into.
///
/// Both are accepted because both are what people have: the zip is what
/// arrives, and a folder is what is left after someone opened it to look.
/// Files are found by path *segment* rather than by full path, since the
/// archive has shipped both flat and inside a dated directory.
pub fn read_export(path: &Path) -> Result<Export, String> {
    let files = if path.is_dir() {
        read_dir_files(path)?
    } else if path.is_file() {
        read_zip_files(path)?
    } else {
        return Err(format!("{} does not exist", path.display()));
    };

    if files.is_empty() {
        return Err(format!(
            "no {CONVERSATIONS}, {PROJECTS} or {PROJECTS_DIR}/ in {} — point this at the \
             zip Anthropic emailed you, or at a folder it was unpacked into",
            path.display()
        ));
    }

    let mut export = Export::default();
    match &files.projects {
        // The array, when the archive still carries one.
        Some(raw) => export.projects = parse_array(raw, "projects", "project", &mut export),
        // Otherwise the directory that replaced it, one project per file.
        None => {
            for (name, raw) in &files.project_files {
                let parsed = parse_project_file(raw, name, &mut export);
                export.projects.extend(parsed);
            }
        }
    }
    if let Some(raw) = &files.conversations {
        export.conversations = parse_array(raw, "conversations", "conversation", &mut export);
    }
    // One file per account, so one file — but read every one found, since an
    // archive holding two would otherwise silently keep whichever sorted last.
    for (name, raw) in &files.memory_files {
        parse_memories_file(raw, name, &mut export);
    }
    Ok(export)
}

/// Walk a folder for the files an export is made of.
///
/// Two directory levels and no further: the archive unpacks flat or into one
/// dated directory, and `projects/` and `memories/` are then one level below
/// that. A deeper walk would start reading whatever else is in the folder
/// someone pointed at.
fn read_dir_files(dir: &Path) -> Result<ExportFiles, String> {
    let mut out = ExportFiles::default();
    let mut stack = vec![(dir.to_path_buf(), 0usize)];
    while let Some((current, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };
        let (in_projects, in_memories) = directory_kind(
            current
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default(),
        );
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if depth < 2 {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if !is_export_file(name, in_projects, in_memories) {
                continue;
            }
            let Ok(bytes) = fs::read(&path) else {
                continue;
            };
            out.take(name, in_projects, in_memories, bytes);
        }
    }
    Ok(out.sorted())
}

fn read_zip_files(path: &Path) -> Result<ExportFiles, String> {
    let file = fs::File::open(path).map_err(|e| format!("cannot open {}: {e}", path.display()))?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| format!("{} is not a readable zip: {e}", path.display()))?;
    let mut out = ExportFiles::default();
    for i in 0..zip.len() {
        let mut entry = match zip.by_index(i) {
            Ok(e) => e,
            Err(e) => return Err(format!("cannot read {}: {e}", path.display())),
        };
        if !entry.is_file() {
            continue;
        }
        // Split for its last two segments and never written to disk, so the
        // entry name is read as a label rather than as a path.
        let full = entry.name().to_string();
        let mut segments = full.rsplit('/');
        let name = segments.next().unwrap_or_default().to_string();
        let (in_projects, in_memories) = directory_kind(segments.next().unwrap_or_default());
        if !is_export_file(&name, in_projects, in_memories) {
            continue;
        }
        let mut buf = Vec::new();
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("cannot read {name} out of the archive: {e}"))?;
        out.take(&name, in_projects, in_memories, buf);
    }
    Ok(out.sorted())
}

/// Parse a top-level array, element by element.
///
/// Element-wise on purpose: `serde_json::from_slice::<Vec<T>>` fails the whole
/// file on one bad record, which for an account export means losing every
/// conversation because of one.
fn parse_array<T: DeserializeOwned>(
    raw: &[u8],
    key: &str,
    what: &str,
    export: &mut Export,
) -> Vec<T> {
    let value: serde_json::Value = match serde_json::from_slice(raw) {
        Ok(v) => v,
        Err(e) => {
            export.warnings.push(format!("{key}.json is not JSON: {e}"));
            return Vec::new();
        }
    };
    // Shipped as a bare array, and as an object wrapping one.
    let items = match value {
        serde_json::Value::Array(items) => items,
        serde_json::Value::Object(mut map) => {
            match map.remove(key).or_else(|| map.remove("data")) {
                Some(serde_json::Value::Array(items)) => items,
                _ => {
                    export
                        .warnings
                        .push(format!("{key}.json holds no array of {key}"));
                    return Vec::new();
                }
            }
        }
        _ => {
            export
                .warnings
                .push(format!("{key}.json holds no array of {key}"));
            return Vec::new();
        }
    };

    parse_items(items, what, export)
}

/// Parse one file out of a `projects/` directory.
///
/// Each holds the single object that used to be one element of the
/// `projects.json` array. An array is read too: the layout has changed once
/// already, and tolerating both costs one match arm against a reader that
/// silently imports nothing.
fn parse_project_file(raw: &[u8], name: &str, export: &mut Export) -> Vec<ExportedProject> {
    let value: serde_json::Value = match serde_json::from_slice(raw) {
        Ok(v) => v,
        Err(e) => {
            export
                .warnings
                .push(format!("{PROJECTS_DIR}/{name} is not JSON: {e}"));
            return Vec::new();
        }
    };
    let what = format!("project from {PROJECTS_DIR}/{name}");
    match value {
        serde_json::Value::Array(items) => parse_items(items, &what, export),
        object => parse_items(vec![object], &what, export),
    }
}

/// Parse one file out of a `memories/` directory into `export.memories`.
///
/// A field at a time, for the reason the arrays are read an element at a
/// time: a null or a wrong type in one project's summary should cost that
/// summary, not the user's profile and the seventy files beside it. Keys this
/// build does not know are ignored, like everywhere else in the archive.
fn parse_memories_file(raw: &[u8], name: &str, export: &mut Export) {
    let value: serde_json::Value = match serde_json::from_slice(raw) {
        Ok(v) => v,
        Err(e) => {
            export
                .warnings
                .push(format!("{MEMORIES_DIR}/{name} is not JSON: {e}"));
            return;
        }
    };
    let serde_json::Value::Object(mut map) = value else {
        export
            .warnings
            .push(format!("{MEMORIES_DIR}/{name} holds no memory object"));
        return;
    };
    if let Some(serde_json::Value::String(text)) = map.remove("conversations_memory") {
        export.memories.conversations_memory = text;
    }
    if let Some(serde_json::Value::Object(projects)) = map.remove("project_memories") {
        for (uuid, text) in projects {
            match text {
                serde_json::Value::String(text) => {
                    export.memories.project_memories.insert(uuid, text);
                }
                // A project with no summary is exported as null, and is fine.
                serde_json::Value::Null => {}
                _ => {
                    export.unreadable += 1;
                    if export.warnings.len() < 20 {
                        export.warnings.push(format!(
                            "skipped the memory of project {uuid} in {MEMORIES_DIR}/{name}: not text"
                        ));
                    }
                }
            }
        }
    }
    if let Some(serde_json::Value::Array(items)) = map.remove("memory_files") {
        let what = format!("memory file from {MEMORIES_DIR}/{name}");
        let files: Vec<ExportedMemoryFile> = parse_items(items, &what, export);
        export.memories.memory_files.extend(files);
    }
}

/// Parse elements one at a time, counting what could not be read.
fn parse_items<T: DeserializeOwned>(
    items: Vec<serde_json::Value>,
    what: &str,
    export: &mut Export,
) -> Vec<T> {
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        match serde_json::from_value(item) {
            Ok(parsed) => out.push(parsed),
            Err(e) => {
                export.unreadable += 1;
                if export.warnings.len() < 20 {
                    export.warnings.push(format!("skipped a {what}: {e}"));
                }
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Importing
// ---------------------------------------------------------------------------

/// What to import and where to put it.
pub struct ImportOptions {
    /// Folder the project folders are created under, if the user wants
    /// folders at all.
    ///
    /// `None` is the ordinary case and the reason a project stopped being a
    /// folder: a claude.ai project is instructions, documents and
    /// conversations, and creating an empty directory to hold no code was
    /// something this module did only because identity was a hash of a path.
    /// Give it a path when the imported project is somewhere you also intend
    /// to keep code.
    pub into: Option<PathBuf>,
    /// Import conversations belonging to no project, into one folder of their
    /// own. Off by default: for most accounts these are the bulk of the
    /// export and have nothing to do with any project.
    pub unfiled: bool,
    /// Import only projects whose name or id contains one of these, case
    /// insensitively. Empty means all of them.
    pub only: Vec<String>,
}

impl ImportOptions {
    /// Import into projects with no folder.
    pub fn new() -> Self {
        Self {
            into: None,
            unfiled: false,
            only: Vec::new(),
        }
    }

    /// Also give each imported project a folder under `into`.
    pub fn into_folder(mut self, into: impl Into<PathBuf>) -> Self {
        self.into = Some(into.into());
        self
    }
}

impl Default for ImportOptions {
    fn default() -> Self {
        Self::new()
    }
}

/// What one project's import did.
#[derive(Debug, Clone, Default)]
pub struct ProjectOutcome {
    pub name: String,
    /// The project this became, so a caller can open it without a lookup.
    pub id: String,
    /// The folder it was given, when it was given one.
    pub root: Option<PathBuf>,
    /// Whether `AGENTS.md` was written. False when the project had no
    /// instructions, or when the folder already had a file of that name.
    pub instructions: bool,
    pub notes: usize,
    /// Conversations written as session logs.
    pub imported: usize,
    /// Conversations already present, from an earlier run of this import.
    pub already: usize,
    /// Messages left out because they were superseded branches of an edited
    /// conversation.
    pub superseded: usize,
    pub warnings: Vec<String>,
}

/// What a whole import did.
#[derive(Debug, Clone, Default)]
pub struct ImportReport {
    pub projects: Vec<ProjectOutcome>,
    /// Conversations carrying no project link, which are never guessed into
    /// one. Imported into their own folder when [`ImportOptions::unfiled`] is
    /// set, and otherwise only counted.
    pub unfiled: usize,
    pub unreadable: usize,
    pub warnings: Vec<String>,
    /// Memory files written: the user memory, vault notes, project summaries
    /// and per-project memory files, together.
    pub memory_written: usize,
    /// The vault note the export's summary of the user went to
    /// ([`BACKGROUND_NOTE`]), when this run wrote it. Named in the report
    /// because it is the one memory file a user would look for in the
    /// always-loaded file and not find there.
    pub background_note: Option<PathBuf>,
    /// Memory files already present with different content and left alone.
    pub memory_left_alone: usize,
    /// Project summaries appended to a project's `AGENTS.md`, whether inline
    /// or as a pointer.
    pub memory_inlined: usize,
    /// Project summaries over [`MEMORY_INLINE_LIMIT`], as `(project name,
    /// characters)`: their `AGENTS.md` carries a pointer rather than the
    /// text, and somebody has to write the short version.
    pub needs_condensing: Vec<(String, usize)>,
}

impl ImportReport {
    pub fn imported(&self) -> usize {
        self.projects.iter().map(|p| p.imported).sum()
    }

    pub fn already(&self) -> usize {
        self.projects.iter().map(|p| p.already).sum()
    }

    /// Whether the export's memory produced anything worth a line.
    pub fn touched_memory(&self) -> bool {
        self.memory_written > 0
            || self.memory_left_alone > 0
            || self.memory_inlined > 0
            || !self.needs_condensing.is_empty()
    }

    /// One line saying what happened, for a shell to print.
    pub fn summary(&self) -> String {
        let mut parts = vec![format!(
            "{} project(s), {} conversation(s)",
            self.projects.len(),
            self.imported()
        )];
        if self.already() > 0 {
            parts.push(format!("{} already present", self.already()));
        }
        if self.unfiled > 0 {
            parts.push(format!("{} unfiled", self.unfiled));
        }
        if self.unreadable > 0 {
            parts.push(format!("{} unreadable", self.unreadable));
        }
        if self.memory_written > 0 {
            parts.push(format!("{} memory file(s)", self.memory_written));
        }
        if self.memory_left_alone > 0 {
            parts.push(format!(
                "{} memory file(s) left alone",
                self.memory_left_alone
            ));
        }
        if !self.needs_condensing.is_empty() {
            parts.push(format!(
                "{} project memor(ies) to condense",
                self.needs_condensing.len()
            ));
        }
        parts.join(", ")
    }
}

/// Write an export's projects into `opts.into`.
///
/// Creates one project per claude.ai project and leaves each a working one:
/// instructions where the preamble looks for them, knowledge in the docspace,
/// conversations in the session log directory.
///
/// Takes the registry rather than leaving registration to the caller, which
/// is not a convenience — a project's id decides where its store is, so
/// nothing can be written until the project exists. It is also what makes a
/// second run of an import add the chats you have had since rather than a
/// second copy of every project: an existing entry is found by
/// [`Registry::find_by_source`] and written into again.
pub fn import(
    export: &Export,
    opts: &ImportOptions,
    registry: &mut Registry,
) -> Result<ImportReport, String> {
    if let Some(into) = &opts.into {
        fs::create_dir_all(into).map_err(|e| format!("cannot create {}: {e}", into.display()))?;
    }

    let mut report = ImportReport {
        unreadable: export.unreadable,
        warnings: export.warnings.clone(),
        ..Default::default()
    };

    // Group by the id the conversation carries, never by resemblance.
    let mut by_project: HashMap<&str, Vec<&ExportedConversation>> = HashMap::new();
    let mut unfiled: Vec<&ExportedConversation> = Vec::new();
    for conv in &export.conversations {
        match conv.project_id() {
            Some(id) => by_project.entry(id).or_default().push(conv),
            None => unfiled.push(conv),
        }
    }
    report.unfiled = unfiled.len();

    // The link is in the archive or it is nowhere — `project_uuid` is absent
    // from some accounts' conversations entirely, and a name is never guessed
    // into one. Said out loud because of the shape it leaves: every project
    // imported with its instructions and its documents, and every chat in a
    // pile beside them, which is indistinguishable from a filing bug.
    if !export.projects.is_empty() && by_project.is_empty() && !export.conversations.is_empty() {
        // First, not appended: every other line in this list is one record
        // that could not be read, and both shells clip the list — the desktop
        // to three. This one is about the import as a whole.
        report.warnings.insert(
            0,
            format!(
                "none of the {} conversation(s) in this export record which project they \
                 belonged to, so all of them are unfiled — that link is not in the \
                 archive and cannot be recovered from it",
                export.conversations.len()
            ),
        );
    }

    let mut slugs: HashSet<String> = HashSet::new();
    for project in &export.projects {
        if !wanted(project, &opts.only) {
            continue;
        }
        let conversations = by_project
            .get(project.uuid.as_str())
            .cloned()
            .unwrap_or_default();
        let outcome = import_project(project, &conversations, opts, registry, &mut slugs)?;
        report.projects.push(outcome);
    }

    if opts.unfiled && !unfiled.is_empty() && opts.only.is_empty() {
        let holder = ExportedProject {
            uuid: String::new(),
            name: "Unfiled chats".to_string(),
            // Deliberately empty. A description becomes `AGENTS.md`, which is
            // model instructions — and "these belonged to no project" is a
            // label for the user, not something to tell a model on every turn.
            description: String::new(),
            prompt_template: String::new(),
            docs: Vec::new(),
        };
        let outcome = import_project(&holder, &unfiled, opts, registry, &mut slugs)?;
        report.projects.push(outcome);
        report.unfiled = 0;
    }

    // After the projects, because a project's memory is filed under the
    // registry entry the loop above just made or found.
    import_memories(export, opts, registry, &mut report);

    Ok(report)
}

fn wanted(project: &ExportedProject, only: &[String]) -> bool {
    if only.is_empty() {
        return true;
    }
    let name = project.name.to_lowercase();
    only.iter().any(|want| {
        let want = want.trim().to_lowercase();
        !want.is_empty() && (name.contains(&want) || project.uuid == want)
    })
}

fn import_project(
    project: &ExportedProject,
    conversations: &[&ExportedConversation],
    opts: &ImportOptions,
    registry: &mut Registry,
    slugs: &mut HashSet<String>,
) -> Result<ProjectOutcome, String> {
    let name = if project.name.trim().is_empty() {
        "Untitled project"
    } else {
        project.name.trim()
    };
    // The uuid, not the name: two claude.ai projects can share a name, and
    // one renamed here is still the one that was imported. An export with no
    // uuid — the synthesized holder for unfiled chats — gets a fixed source
    // for the same reason, so a second import adds to it rather than making
    // "Unfiled chats" twice.
    let source = if project.uuid.is_empty() {
        crate::project::UNFILED_SOURCE.to_string()
    } else {
        format!("claude:{}", project.uuid)
    };

    let existing = registry.find_by_source(&source).cloned();
    let project_entry = match existing {
        Some(entry) => entry,
        None => {
            let workspace = match &opts.into {
                Some(into) => {
                    let root = into.join(unique_slug(name, &project.uuid, slugs));
                    fs::create_dir_all(&root)
                        .map_err(|e| format!("cannot create {}: {e}", root.display()))?;
                    Some(crate::project::normalize(&root))
                }
                None => None,
            };
            registry.create(name, workspace, Some(source))?
        }
    };

    let root = project_entry.workspace_dir();
    let sessions = project_entry.session_dir();
    let notes = project_entry.notes_dir();
    fs::create_dir_all(&sessions)
        .map_err(|e| format!("cannot create {}: {e}", sessions.display()))?;
    fs::create_dir_all(&notes).map_err(|e| format!("cannot create {}: {e}", notes.display()))?;

    let mut outcome = ProjectOutcome {
        name: name.to_string(),
        id: project_entry.id.clone(),
        root: project_entry.workspace.clone(),
        ..Default::default()
    };

    outcome.instructions = write_instructions(&root, name, project, &mut outcome.warnings);

    // Exports repeat a document when it was re-uploaded; the first copy with
    // content wins, which is what the filename means to the user anyway.
    let mut seen: HashSet<&str> = HashSet::new();
    for doc in &project.docs {
        let filename = doc.filename.trim();
        if filename.is_empty() || doc.content.is_empty() || !seen.insert(filename) {
            continue;
        }
        // Never overwritten. The docspace is a working directory that the
        // user and the model both edit, so a second run of an import must not
        // be able to undo a week of notes — and re-importing *is* the ordinary
        // case, since a new export is how you pick up chats you have had
        // since. A note whose content is unchanged is not worth a word.
        let name = note_name(filename);
        match read_note(&notes, &name) {
            Ok(existing) if existing == doc.content => {}
            Ok(_) => outcome
                .warnings
                .push(format!("{name} has been edited here and was left alone")),
            Err(_) => match write_note(&notes, &name, &doc.content) {
                Ok(_) => outcome.notes += 1,
                Err(e) => outcome.warnings.push(format!("note {filename}: {e}")),
            },
        }
    }

    for conv in conversations {
        match write_conversation(&sessions, conv) {
            Ok(Some(superseded)) => {
                outcome.imported += 1;
                outcome.superseded += superseded;
            }
            Ok(None) => outcome.already += 1,
            Err(e) => outcome
                .warnings
                .push(format!("conversation {}: {e}", conv.uuid)),
        }
    }

    Ok(outcome)
}

/// Write the project's instructions where the preamble already looks.
///
/// An existing `AGENTS.md` is never overwritten. Importing into a folder that
/// already has one means the folder is somebody's actual project, and silently
/// replacing the instructions it works under would be the single most damaging
/// thing this whole feature could do.
fn write_instructions(
    root: &Path,
    name: &str,
    project: &ExportedProject,
    warnings: &mut Vec<String>,
) -> bool {
    let instructions = project.prompt_template.trim();
    let description = project.description.trim();
    if instructions.is_empty() && description.is_empty() {
        return false;
    }
    let mut body = format!("# {name}\n");
    if !description.is_empty() {
        body.push_str(&format!("\n{description}\n"));
    }
    if !instructions.is_empty() {
        body.push_str(&format!("\n## Project instructions\n\n{instructions}\n"));
    }
    let path = root.join("AGENTS.md");
    // An existing file is left alone either way, but only one of the two cases
    // is worth saying out loud. Re-importing is the ordinary way to pick up
    // new chats, and a warning that fires on every run for a file this import
    // wrote itself is noise that teaches people to skip the warnings that
    // matter.
    match fs::read_to_string(&path) {
        Ok(existing) if existing == body => return false,
        Ok(_) => {
            warnings.push("AGENTS.md has been edited here and was left alone".to_string());
            return false;
        }
        Err(_) => {}
    }

    match fs::write(&path, body) {
        Ok(()) => true,
        Err(e) => {
            warnings.push(format!("cannot write AGENTS.md: {e}"));
            false
        }
    }
}

/// Write the export's memory where each layer of it belongs.
///
/// | export | destination |
/// |---|---|
/// | `conversations_memory` | the vault's `background.md`, whole; the user memory gets the pointer paragraph |
/// | global `memory_files` | the vault, at the file's own path |
/// | `project_memories[uuid]` | `<workspace>/.agents/memory/summary.md`, whole, and a section of `AGENTS.md` |
/// | `/projects/<uuid>/…` files | `<workspace>/.agents/memory/…` |
///
/// The same never-overwrite rule as the docspace, everywhere but one place:
/// nothing on disk is replaced, a file that differs is said out loud, and
/// one that is byte-identical is not mentioned. The exception is
/// `background.md`, which is the export's text and not the user's, and is
/// replaced by a re-import — see [`write_background`]. A project is found
/// by the `claude:<uuid>` source the import registers it under; a uuid with
/// no project here is a warning, since the export can hold memory for a
/// project that did not parse or was filtered out.
fn import_memories(
    export: &Export,
    opts: &ImportOptions,
    registry: &Registry,
    report: &mut ImportReport,
) {
    let memories = &export.memories;
    if memories.is_empty() {
        return;
    }

    // The vault may not exist yet on this machine; it is created rather than
    // reported, being the default location of a feature that has simply not
    // been used. Resolved lazily, by whichever of the two writers below
    // needs it first.
    let mut vault: Option<PathBuf> = None;

    // The export's summary of the user: to the vault as one note, read on
    // demand, and never into the file the preamble reads whole in every
    // project and in a chat with none. That file gets the paragraph saying
    // where the background went, once (backlog 055, 2026-09-15).
    let text = memories.conversations_memory.trim();
    if !text.is_empty() {
        match (
            crate::knowledge::vault_dir(),
            crate::prompt::user_instruction_path(),
        ) {
            (Some(dir), Some(path)) => {
                write_background(&dir, text, report);
                ensure_background_pointer(&path, report);
                vault = Some(dir);
            }
            _ => report
                .warnings
                .push("no home directory, so the export's summary of you was left out".to_string()),
        }
    }

    // Sort the files by where they go, and the vault ones out first.
    let mut per_project: BTreeMap<&str, Vec<(&str, &str)>> = BTreeMap::new();
    for file in &memories.memory_files {
        if file.content.is_empty() {
            continue;
        }
        let Some((uuid, rest)) = file.destination() else {
            report.warnings.push(format!(
                "memory file {:?} names no file and was left out",
                file.path
            ));
            continue;
        };
        let Some(uuid) = uuid else {
            let dir = match &vault {
                Some(dir) => dir,
                None => match crate::knowledge::vault_dir() {
                    Some(dir) => vault.insert(dir),
                    None => {
                        report.warnings.push(format!(
                            "no home directory, so memory file {rest} was left out"
                        ));
                        continue;
                    }
                },
            };
            match contained(dir, rest) {
                Ok(path) => write_memory(&path, &file.content, &format!("vault {rest}"), report),
                Err(e) => report.warnings.push(format!("memory file {rest}: {e}")),
            };
            continue;
        };
        per_project
            .entry(uuid)
            .or_default()
            .push((rest, &file.content));
    }

    // `--only` narrows the projects, so it narrows their memory too; the
    // user memory and the vault are not a project's and were written above.
    let wanted_uuids: Option<HashSet<&str>> = (!opts.only.is_empty()).then(|| {
        export
            .projects
            .iter()
            .filter(|p| wanted(p, &opts.only))
            .map(|p| p.uuid.as_str())
            .collect()
    });
    let uuids: BTreeSet<&str> = memories
        .project_memories
        .keys()
        .map(String::as_str)
        .chain(per_project.keys().copied())
        .collect();
    for uuid in uuids {
        if wanted_uuids.as_ref().is_some_and(|w| !w.contains(uuid)) {
            continue;
        }
        let Some(project) = registry.find_by_source(&format!("claude:{uuid}")) else {
            report.warnings.push(format!(
                "memory for project {uuid} has no project here to go under and was left out"
            ));
            continue;
        };
        let memory_dir = project.notes_dir().join(MEMORY_DIR);
        if let Some(text) = memories
            .project_memories
            .get(uuid)
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            write_memory(
                &memory_dir.join(MEMORY_SUMMARY),
                &format!("{text}\n"),
                &format!(
                    "{}: {}/{MEMORY_DIR}/{MEMORY_SUMMARY}",
                    project.name, AGENTS_DIR
                ),
                report,
            );
            append_memory_section(&project.workspace_dir(), &project.name, text, report);
        }
        for (rest, content) in per_project.get(uuid).into_iter().flatten() {
            let label = format!("{}: {}/{MEMORY_DIR}/{rest}", project.name, AGENTS_DIR);
            match contained(&memory_dir, rest) {
                Ok(path) => write_memory(&path, content, &label, report),
                Err(e) => report.warnings.push(format!("{label}: {e}")),
            }
        }
    }
}

/// Resolve a memory file's path under its directory, refusing one that
/// lands outside it. The export is a zip that arrived by email, and a path
/// in it is a label until [`Root`] has said where it lands.
fn contained(dir: &Path, rest: &str) -> Result<PathBuf, String> {
    let root = Root::new(dir);
    let path = root.resolve(rest)?;
    if path == root.path() {
        return Err("that is the memory directory itself, not a file".to_string());
    }
    Ok(path)
}

/// Write one memory file, never over one that is already there.
///
/// Same two cases as the docspace, and only one of them worth a word: a file
/// that differs was edited here, or written by a dream, and is left alone
/// out loud; one that is byte-identical is what a second run of the same
/// export finds everywhere and is not mentioned. An empty file counts as
/// absent — there is nothing in it to protect.
fn write_memory(path: &Path, body: &str, label: &str, report: &mut ImportReport) {
    match fs::read_to_string(path) {
        Ok(existing) if existing == body => return,
        Ok(existing) if !existing.trim().is_empty() => {
            report.memory_left_alone += 1;
            report
                .warnings
                .push(format!("{label} has been edited here and was left alone"));
            return;
        }
        Ok(_) | Err(_) => {}
    }
    if let Some(parent) = path.parent()
        && let Err(e) = fs::create_dir_all(parent)
    {
        report
            .warnings
            .push(format!("{label}: cannot create {}: {e}", parent.display()));
        return;
    }
    match fs::write(path, body) {
        Ok(()) => report.memory_written += 1,
        Err(e) => report.warnings.push(format!("{label}: cannot write: {e}")),
    }
}

/// The vault note for the export's summary of the user, as a whole file:
/// frontmatter in the vault's own style, a header saying what it is and
/// what a re-import does to it, then the export's text untouched.
///
/// `date` is the import's, not the export's — the archive does not say when
/// it was made, only its folder name does, and a folder name is a label.
/// The same text on the same day is the same file byte for byte, which is
/// what lets a second run write nothing.
fn background_note(text: &str, date: &str) -> String {
    format!(
        "---\n\
         name: background\n\
         description: Who the user is and what they have worked on — the claude.ai export's \
         summary of them, imported {date}; read on demand, never loaded into every chat\n\
         sources: [claude.ai export, {date}]\n\
         aliases: []\n\
         ---\n\
         \n\
         # Background (on demand)\n\
         \n\
         The claude.ai export's summary of the user, imported {date}. The always-loaded\n\
         memory (`~/.nightloom/AGENTS.md`) holds instructions only and points here: a\n\
         question that needs who the user is or what they have worked on reads this\n\
         note, and one that does not never pays for it. A re-import never replaces this\n\
         file once it exists, so corrections made here survive.\n\
         \n\
         {text}\n"
    )
}

/// Write the export's summary of the user to the vault as [`BACKGROUND_NOTE`].
///
/// Written once. It was going to be the one memory file a re-import
/// replaces — the export's own text under the importer's header — until he
/// said he would correct what is wrong in it by hand (nightshift backlog
/// 058); from then on it is his the moment it exists, like every other
/// note, and a re-import that finds it different says so and keeps it.
/// Byte-identical is not mentioned, as everywhere.
fn write_background(vault: &Path, text: &str, report: &mut ImportReport) {
    let path = vault.join(BACKGROUND_NOTE);
    let body = background_note(text, &Utc::now().format("%Y-%m-%d").to_string());
    // Never over an existing note: the first import wrote it, and he said
    // he would correct what is wrong in it by hand (nightshift backlog 058,
    // 2026-09-14). A re-import that replaced the file would undo that
    // silently; it warns and keeps his instead.
    if path.is_file() {
        if fs::read_to_string(&path).is_ok_and(|existing| existing != body) {
            report.warnings.push(format!(
                "vault {BACKGROUND_NOTE}: kept the existing note (it may carry his edits); the export's version was not written"
            ));
        }
        return;
    }
    if let Err(e) = fs::create_dir_all(vault) {
        report.warnings.push(format!(
            "vault {BACKGROUND_NOTE}: cannot create {}: {e}",
            vault.display()
        ));
        return;
    }
    match fs::write(&path, body) {
        Ok(()) => {
            report.memory_written += 1;
            report.background_note = Some(path);
        }
        Err(e) => report
            .warnings
            .push(format!("vault {BACKGROUND_NOTE}: cannot write: {e}")),
    }
}

/// Make sure the user memory carries the "Background, on demand" paragraph,
/// and nothing else about it.
///
/// A file with the heading already is left exactly as it is — the check is
/// the heading line, so the paragraph cannot pile up run after run. A file
/// without it gets the paragraph appended, below whatever is there: the
/// standing instructions and the other instructions are the user's, and an
/// importer that moved them would be an editor nobody asked for. A missing
/// or blank file becomes the paragraph alone, which is a user memory that
/// says where to look and instructs nothing — the export's own instruction
/// sections are in `background.md` for the user to lift from, not seeded
/// here, because which of them are still true is their call (nightshift
/// blocker 061).
///
/// A file that still carries the export's biographical sections — an import
/// from before the split — is not edited either, but it is said out loud,
/// on every run until they are gone, since the sections cost every turn.
fn ensure_background_pointer(path: &Path, report: &mut ImportReport) {
    let existing = match fs::read_to_string(path) {
        Ok(existing) => existing,
        Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
        Err(e) => {
            report
                .warnings
                .push(format!("the user memory: cannot read: {e}"));
            return;
        }
    };
    let leftover: Vec<&str> = existing
        .lines()
        .filter(|line| is_export_memory_heading(line))
        .map(str::trim)
        .collect();
    if !leftover.is_empty() {
        report.warnings.push(format!(
            "the user memory still carries the export's background sections ({}); they are \
             loaded into every chat, and belong in the vault's {BACKGROUND_NOTE}",
            leftover.join(", ")
        ));
    }
    if existing
        .lines()
        .any(|line| line.trim() == BACKGROUND_HEADING)
    {
        return;
    }
    let mut body = if existing.trim().is_empty() {
        String::new()
    } else {
        let mut body = existing;
        if !body.ends_with('\n') {
            body.push('\n');
        }
        body.push('\n');
        body
    };
    body.push_str(BACKGROUND_POINTER);
    body.push('\n');
    if let Some(parent) = path.parent()
        && let Err(e) = fs::create_dir_all(parent)
    {
        report.warnings.push(format!(
            "the user memory: cannot create {}: {e}",
            parent.display()
        ));
        return;
    }
    match write_whole(path, &body) {
        Ok(()) => report.memory_written += 1,
        Err(e) => report
            .warnings
            .push(format!("the user memory: cannot write: {e}")),
    }
}

/// Replace an always-loaded file whole: a process-named temp file beside
/// it, then a rename. `fs::write` truncates before it writes, and the two
/// files this rewrites — a project's `AGENTS.md`, the user's — are read
/// into every conversation; a quit between the truncate and the write
/// would leave one empty.
fn write_whole(path: &Path, body: &str) -> io::Result<()> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = path.with_file_name(format!("{name}.{}.tmp", std::process::id()));
    fs::write(&tmp, body)?;
    fs::rename(&tmp, path).inspect_err(|_| {
        fs::remove_file(&tmp).ok();
    })
}

/// Append a project's memory to its `AGENTS.md`, under a dated heading.
///
/// Appended rather than written, because the file usually exists already —
/// [`write_instructions`] made it from the project's custom instructions a
/// moment ago, or the user has one of their own — and nothing above the
/// heading is touched. The heading is also the idempotency check: a second
/// import finds it and adds nothing, so the same memory cannot pile up run
/// after run.
///
/// A summary over [`MEMORY_INLINE_LIMIT`] is not inlined. The section then
/// points at the full text in `.agents/memory/summary.md`, and the project is
/// listed as needing a condensed version — on every run until the pointer is
/// replaced, since a nag that stops after one report is one that gets missed.
fn append_memory_section(root: &Path, name: &str, text: &str, report: &mut ImportReport) {
    let chars = text.chars().count();
    let pointer = format!(
        "The full project memory imported from claude.ai is in {AGENTS_DIR}/{MEMORY_DIR}/\
         {MEMORY_SUMMARY} ({chars} characters). A condensed version belongs here, under \
         {MEMORY_INLINE_LIMIT} characters."
    );
    let path = root.join("AGENTS.md");
    let existing = match fs::read_to_string(&path) {
        Ok(existing) => existing,
        // Absent is the ordinary case for a project that had no instructions.
        Err(e) if e.kind() == io::ErrorKind::NotFound => format!("# {name}\n"),
        Err(e) => {
            report
                .warnings
                .push(format!("{name}: cannot read AGENTS.md: {e}"));
            return;
        }
    };
    if existing
        .lines()
        .any(|line| line.starts_with(MEMORY_HEADING))
    {
        if existing.contains("A condensed version belongs here") {
            report.needs_condensing.push((name.to_string(), chars));
        }
        return;
    }
    let section = if chars <= MEMORY_INLINE_LIMIT {
        text
    } else {
        report.needs_condensing.push((name.to_string(), chars));
        pointer.as_str()
    };
    let mut body = existing;
    if !body.ends_with('\n') {
        body.push('\n');
    }
    body.push_str(&format!(
        "\n{MEMORY_HEADING} {})\n\n{section}\n",
        Utc::now().format("%Y-%m-%d")
    ));
    match write_whole(&path, &body) {
        Ok(()) => report.memory_inlined += 1,
        Err(e) => report
            .warnings
            .push(format!("{name}: cannot write AGENTS.md: {e}")),
    }
}

/// `Ok(Some(superseded))` on a fresh import, `Ok(None)` when the log was
/// already there from an earlier run.
fn write_conversation(dir: &Path, conv: &ExportedConversation) -> Result<Option<usize>, String> {
    let created = conv.created_at.unwrap_or_else(Utc::now);
    let mut session = match Session::with_log_as(dir, &conv.uuid, created) {
        Ok(s) => s,
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };

    let title = conv.name.trim();
    if !title.is_empty() {
        session.record(SessionEvent::Title {
            text: title.to_string(),
            at: created,
            by: None,
        });
    }

    let (messages, superseded) = live_path(conv);
    let model = conv
        .model
        .clone()
        .unwrap_or_else(|| "claude.ai".to_string());
    for message in &messages {
        let at = message.created_at.unwrap_or(created);
        match message.sender.as_str() {
            "human" => session.record(SessionEvent::UserMessage {
                text: user_text(message),
                images: Vec::new(),
                documents: Vec::new(),
                at,
            }),
            "assistant" => session.record(SessionEvent::AssistantMessage {
                model: model.clone(),
                blocks: assistant_blocks(message),
                stop_reason: None,
                // The export carries no token counts. Zeros are the honest
                // answer and `None` on the cost is the load-bearing half:
                // a recorded 0.0 would claim the conversation was free.
                usage: Usage::default(),
                cost: None,
                // Nor when its request went out or what cache it left: an
                // import is history, and any entry it had is long gone.
                sent_at: None,
                cache_ttl: None,
                at,
            }),
            other => {
                return Err(format!("unknown sender {other:?}"));
            }
        }
    }

    let last = conv
        .updated_at
        .or_else(|| messages.last().and_then(|m| m.created_at))
        .unwrap_or(created);
    drop(session);
    stamp(&dir.join(format!("{}.jsonl", conv.uuid)), last);
    Ok(Some(superseded))
}

/// Give the written log the conversation's own modification time.
///
/// Not cosmetic, and not covered by recording the right timestamp *inside* the
/// log: [`crate::store`] lists and sorts sessions on the file's mtime, and
/// `--continue` resumes whichever log is newest. Left alone, an import stamps
/// every conversation with the moment it ran — so a year of history lists as
/// one afternoon in both shells, and `nightloom --continue` in the imported
/// folder reopens whichever chat the import happened to write last instead of
/// the one the user was actually in.
///
/// A failure here is ignored on purpose. The conversation is already safely on
/// disk, and a filesystem that will not take a timestamp (a network share, a
/// container mount) is not a reason to report an import that succeeded as one
/// that did not.
fn stamp(path: &Path, at: DateTime<Utc>) {
    if let Ok(file) = fs::OpenOptions::new().write(true).open(path) {
        let _ = file.set_modified(std::time::SystemTime::from(at));
    }
}

/// The messages that are actually in the conversation, and how many were left
/// out.
///
/// A claude.ai conversation is a tree, not a list: editing a message branches
/// it, and the export ships every branch with `current_leaf_message_uuid`
/// naming the one that survived. Importing all of them in index order would
/// interleave both sides of an edit into one transcript, which reads as the
/// user asking the same question twice and getting two different answers.
///
/// So the live path is walked back from the leaf, and anything off it is
/// counted rather than written. Where the export gives no leaf — older ones do
/// not — index order is the whole conversation, which is correct for the
/// unedited case and is all that can be known for the rest.
fn live_path(conv: &ExportedConversation) -> (Vec<&ExportedMessage>, usize) {
    let Some(leaf) = conv
        .current_leaf_message_uuid
        .as_deref()
        .filter(|l| !l.is_empty())
    else {
        return (ordered(conv), 0);
    };
    let by_uuid: HashMap<&str, &ExportedMessage> = conv
        .chat_messages
        .iter()
        .map(|m| (m.uuid.as_str(), m))
        .collect();
    let Some(&last) = by_uuid.get(leaf) else {
        return (ordered(conv), 0);
    };

    let mut path = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    let mut cursor = Some(last);
    while let Some(message) = cursor {
        if !seen.insert(message.uuid.as_str()) {
            break; // A cycle cannot happen in a well-formed export, and a
            // malformed one must not hang the import.
        }
        path.push(message);
        cursor = message
            .parent_message_uuid
            .as_deref()
            .filter(|p| !p.is_empty())
            .and_then(|p| by_uuid.get(p).copied());
    }
    path.reverse();
    let superseded = conv.chat_messages.len().saturating_sub(path.len());
    (path, superseded)
}

/// Every message, in the order the conversation happened.
///
/// The export already lists them in order, so the file's own order is the
/// default and `index` is only allowed to override it when *every* message
/// carries one. The tempting third signal, `created_at`, is deliberately not
/// used as a tiebreak: its granularity is coarse enough that a fast exchange
/// can tie, and a stable sort on a tied key silently reorders the pair. That
/// is not a hypothetical — it turned `user, assistant, user` into `user, user,
/// assistant` on the first fixture that had two messages in the same second,
/// which is a conversation no provider will accept on replay and a transcript
/// nobody can read.
fn ordered(conv: &ExportedConversation) -> Vec<&ExportedMessage> {
    let mut all: Vec<&ExportedMessage> = conv.chat_messages.iter().collect();
    if all.iter().all(|m| m.index.is_some()) {
        all.sort_by_key(|m| m.index.unwrap_or_default());
    }
    all
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/// What the user said, plus what they attached.
fn user_text(message: &ExportedMessage) -> String {
    let mut parts = Vec::new();
    let body = flatten(message);
    if !body.trim().is_empty() {
        parts.push(body);
    }
    for attachment in &message.attachments {
        let name = blank_as(&attachment.file_name, "attachment");
        if attachment.extracted_content.trim().is_empty() {
            parts.push(format!(
                "[attachment: {name} — the export does not include its contents]"
            ));
        } else {
            let kind = if attachment.file_type.trim().is_empty() {
                String::new()
            } else {
                format!(" ({})", attachment.file_type.trim())
            };
            parts.push(format!(
                "[attachment: {name}{kind}]\n{}",
                attachment.extracted_content
            ));
        }
    }
    for file in &message.files {
        parts.push(format!(
            "[file: {} — the export does not include its contents]",
            blank_as(&file.file_name, "file")
        ));
    }
    if parts.is_empty() {
        // Structure is preserved and only the content goes, the same way an
        // elided event still projects a block: dropping the turn instead would
        // leave two user messages adjacent, which is a 400 on replay.
        return "[this message is empty in the export]".to_string();
    }
    parts.join("\n\n")
}

fn assistant_blocks(message: &ExportedMessage) -> Vec<ContentBlock> {
    let mut blocks = Vec::new();
    for block in &message.content {
        match block {
            ExportedBlock::Thinking { thinking } if !thinking.trim().is_empty() => {
                // Unsigned deliberately: no adapter replays a reasoning token
                // it did not issue, so this renders and never reaches a wire.
                blocks.push(ContentBlock::Thinking {
                    text: thinking.clone(),
                    signature: None,
                });
            }
            other => {
                let text = render(other);
                if !text.trim().is_empty() {
                    blocks.push(ContentBlock::Text { text });
                }
            }
        }
    }
    if blocks.is_empty() {
        let fallback = message.text.trim();
        blocks.push(ContentBlock::Text {
            text: if fallback.is_empty() {
                "[this message is empty in the export]".to_string()
            } else {
                fallback.to_string()
            },
        });
    }
    blocks
}

/// Every block of a message as one string, for the roles that take text.
fn flatten(message: &ExportedMessage) -> String {
    if message.content.is_empty() {
        return message.text.clone();
    }
    message
        .content
        .iter()
        .map(render)
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// One exported block as text.
///
/// Tool calls land here rather than in a [`ContentBlock::ToolUse`]; the module
/// docs say why at length. The short version is that they name tools no
/// Nightloom request carries, so replaying them is invalid on the next turn
/// whether or not their results came with them.
fn render(block: &ExportedBlock) -> String {
    match block {
        ExportedBlock::Text { text } => text.clone(),
        ExportedBlock::Thinking { thinking } => thinking.clone(),
        ExportedBlock::VoiceNote { title, text } => match title.as_deref().map(str::trim) {
            Some(title) if !title.is_empty() => format!("[voice note: {title}]\n{text}"),
            _ => format!("[voice note]\n{text}"),
        },
        ExportedBlock::ToolUse { name, input } => render_tool_use(name, input),
        ExportedBlock::ToolResult {
            name,
            content,
            is_error,
        } => {
            let body: String = content
                .iter()
                .filter_map(|part| part.text.as_deref())
                .collect::<Vec<_>>()
                .join("\n");
            if body.trim().is_empty() {
                return String::new();
            }
            let label = if *is_error { "failed" } else { "result" };
            let name = blank_as(name, "tool");
            format!("[{name} {label}]\n{}", clip(&body, TOOL_RESULT_LIMIT))
        }
        ExportedBlock::Other => String::new(),
    }
}

/// An artifact keeps its content whole; anything else is named and summarized.
fn render_tool_use(name: &str, input: &serde_json::Value) -> String {
    let field = |key: &str| input.get(key).and_then(|v| v.as_str()).unwrap_or_default();
    if name == "artifacts" {
        let content = field("content");
        if content.is_empty() {
            // An `update` command carries a diff rather than a document.
            let command = blank_as(field("command"), "updated");
            return format!(
                "[artifact {command}: {}]",
                blank_as(field("title"), "untitled")
            );
        }
        let title = blank_as(field("title"), "untitled");
        let language = field("language");
        return format!("[artifact: {title}]\n```{language}\n{content}\n```");
    }
    let name = blank_as(name, "tool");
    let query = ["query", "command", "prompt", "code"]
        .iter()
        .map(|key| field(key))
        .find(|value| !value.is_empty())
        .unwrap_or_default();
    if query.is_empty() {
        format!("[used {name}]")
    } else {
        format!("[used {name}: {}]", clip(query.trim(), 300))
    }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

fn blank_as<'a>(value: &'a str, fallback: &'a str) -> &'a str {
    let value = value.trim();
    if value.is_empty() { fallback } else { value }
}

/// Clip to `limit` bytes on a character boundary, saying what was cut.
///
/// The notice names the full size for the reason every other truncation notice
/// in this workspace does: a body that simply stops reads as a body that ended
/// there.
fn clip(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut end = limit;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!(
        "{}\n[cut: kept {end} of {} bytes]",
        &text[..end],
        text.len()
    )
}

/// The docspace is markdown by convention, and a file with no extension is one
/// nobody's editor knows what to do with.
fn note_name(filename: &str) -> String {
    let name = filename.trim().replace('\\', "/");
    let base = name.rsplit('/').next().unwrap_or(&name);
    if base.contains('.') {
        base.to_string()
    } else {
        format!("{base}.md")
    }
}

/// A folder name for a project title, unique within this run.
///
/// The slugging itself is [`crate::project::slug`], shared with the desktop's
/// New project form so the folder an import makes and the folder the form
/// previews are spelled by one rule. What this adds is the importer's two
/// needs: a title of pure punctuation still gets a folder, and two projects
/// with one title get two.
fn unique_slug(name: &str, uuid: &str, taken: &mut HashSet<String>) -> String {
    let slug = crate::project::slug(name);
    let mut slug = if slug.is_empty() {
        "project".to_string()
    } else {
        slug
    };
    if taken.contains(&slug) {
        let suffix: String = uuid
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .take(6)
            .collect();
        slug = if suffix.is_empty() {
            format!("{slug}-2")
        } else {
            format!("{slug}-{suffix}")
        };
        let mut n = 2;
        while taken.contains(&slug) {
            slug = format!("{slug}-{n}");
            n += 1;
        }
    }
    taken.insert(slug.clone());
    slug
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::test_dir;
    use serde_json::json;

    /// Write a two-file export into a folder and read it back, so the tests
    /// exercise the reader as well as the mapping.
    fn export_of(
        name: &str,
        projects: serde_json::Value,
        conversations: serde_json::Value,
    ) -> (PathBuf, Export) {
        let dir = test_dir(&format!("import-src-{name}"));
        fs::write(
            dir.join(PROJECTS),
            serde_json::to_vec_pretty(&projects).unwrap(),
        )
        .unwrap();
        fs::write(
            dir.join(CONVERSATIONS),
            serde_json::to_vec_pretty(&conversations).unwrap(),
        )
        .unwrap();
        let export = read_export(&dir).unwrap();
        (dir, export)
    }

    fn message(uuid: &str, sender: &str, text: &str) -> serde_json::Value {
        json!({
            "uuid": uuid,
            "sender": sender,
            "text": text,
            "content": [{ "type": "text", "text": text }],
            "created_at": "2025-03-04T05:06:07Z",
        })
    }

    fn one_project() -> serde_json::Value {
        json!([{
            "uuid": "p-1",
            "name": "Thesis Research",
            "description": "Everything for the dissertation.",
            "prompt_template": "Always cite a source.",
            "docs": [
                { "filename": "outline.md", "content": "# Outline\n\nChapter one." },
                { "filename": "sources", "content": "Barthes, 1967." },
                { "filename": "outline.md", "content": "a duplicate upload" },
            ],
        }])
    }

    /// Import with a registry kept in `into`, so a second run of the same
    /// test sees the projects the first run made — which is what makes the
    /// idempotence tests test anything.
    fn run_with(export: &Export, opts: ImportOptions, into: &Path) -> ImportReport {
        let mut registry = Registry::load_from(into.join("projects.json"));
        import(export, &opts, &mut registry).unwrap()
    }

    fn run(export: &Export, into: &Path) -> ImportReport {
        run_with(export, ImportOptions::new().into_folder(into), into)
    }

    fn sessions_of(outcome: &ProjectOutcome) -> PathBuf {
        crate::project::store_dir(&outcome.id).join(crate::project::SESSIONS_DIR)
    }

    fn workspace_of(outcome: &ProjectOutcome) -> PathBuf {
        outcome.root.clone().unwrap_or_else(|| {
            crate::project::store_dir(&outcome.id).join(crate::project::WORKSPACE_DIR)
        })
    }

    fn notes_of(outcome: &ProjectOutcome) -> PathBuf {
        workspace_of(outcome).join(crate::project::AGENTS_DIR)
    }

    fn session_of(outcome: &ProjectOutcome, uuid: &str) -> Session {
        Session::load(sessions_of(outcome).join(format!("{uuid}.jsonl"))).unwrap()
    }

    fn assistant_blocks_of(session: &Session) -> Vec<ContentBlock> {
        session
            .events()
            .iter()
            .filter_map(|e| match e {
                SessionEvent::AssistantMessage { blocks, .. } => Some(blocks.clone()),
                _ => None,
            })
            .flatten()
            .collect()
    }

    #[test]
    fn a_project_becomes_a_folder_with_its_instructions_notes_and_chats() {
        let (_src, export) = export_of(
            "a-project-becomes",
            one_project(),
            json!([{
                "uuid": "c-1",
                "name": "Framing chapter two",
                "project_uuid": "p-1",
                "created_at": "2025-03-04T05:06:07Z",
                "model": "claude-opus-4",
                "chat_messages": [
                    message("m-1", "human", "How should chapter two open?"),
                    message("m-2", "assistant", "With the counterexample."),
                ],
            }]),
        );

        let into = test_dir("import-out");
        let report = run(&export, &into);
        assert_eq!(report.projects.len(), 1);
        let project = &report.projects[0];
        assert_eq!(project.imported, 1);
        assert!(project.instructions);
        // The duplicate upload of outline.md is one note, not two.
        assert_eq!(project.notes, 2);

        let agents = fs::read_to_string(workspace_of(project).join("AGENTS.md")).unwrap();
        assert!(agents.contains("Always cite a source."), "{agents}");
        assert!(
            agents.contains("Everything for the dissertation."),
            "{agents}"
        );

        let notes = notes_of(project);
        assert_eq!(
            fs::read_to_string(notes.join("outline.md")).unwrap(),
            "# Outline\n\nChapter one."
        );
        // An extensionless knowledge doc becomes markdown, which is what the
        // docspace is by convention.
        assert!(notes.join("sources.md").exists());

        let session = session_of(project, "c-1");
        assert_eq!(session.title(), Some("Framing chapter two"));
        assert_eq!(session.messages().len(), 2);
        // The conversation's own timestamp, not the moment it was imported.
        let created = match &session.events()[0] {
            SessionEvent::SessionCreated { at, .. } => *at,
            other => panic!("expected SessionCreated, got {other:?}"),
        };
        assert_eq!(created.to_rfc3339(), "2025-03-04T05:06:07+00:00");
    }

    /// The whole idempotency argument is the filename, so a second run must be
    /// a no-op rather than a second copy of every chat.
    #[test]
    fn importing_the_same_export_twice_adds_nothing() {
        let (_src, export) = export_of(
            "twice",
            one_project(),
            json!([{
                "uuid": "c-1",
                "name": "First",
                "project_uuid": "p-1",
                "created_at": "2025-03-04T05:06:07Z",
                "chat_messages": [message("m-1", "human", "hello")],
            }]),
        );
        let into = test_dir("import-twice");

        let first = run(&export, &into);
        assert_eq!((first.imported(), first.already()), (1, 0));

        let second = run(&export, &into);
        assert_eq!((second.imported(), second.already()), (0, 1));

        let sessions = fs::read_dir(sessions_of(&second.projects[0]))
            .unwrap()
            .count();
        assert_eq!(sessions, 1);
    }

    /// The case that forced a project to stop being a folder: a claude.ai
    /// project is instructions, documents and conversations, and nothing here
    /// should have to invent a directory to hold no code.
    #[test]
    fn a_project_can_be_imported_without_a_folder_at_all() {
        let (_src, export) = export_of(
            "folderless",
            one_project(),
            json!([{
                "uuid": "c-1",
                "name": "Chapter one",
                "project_uuid": "p-1",
                "created_at": "2024-05-01T09:00:00Z",
                "updated_at": "2024-05-01T09:10:00Z",
                "chat_messages": [message("m-1", "human", "hello")],
            }]),
        );

        let into = test_dir("import-folderless");
        let mut registry = Registry::load_from(into.join("projects.json"));
        let report = import(&export, &ImportOptions::new(), &mut registry).unwrap();

        let outcome = &report.projects[0];
        assert!(outcome.root.is_none(), "no folder was asked for");
        // Nothing was written under the directory the registry happens to
        // live in: an import with no `--into` creates no folders anywhere the
        // user can trip over.
        assert!(!into.join("thesis").exists());

        // And it is a working project regardless — instructions where the
        // preamble looks, notes in the docspace, the chat in the log dir.
        let project = registry.find_by_source("claude:p-1").unwrap().clone();
        assert!(project.workspace.is_none());
        assert!(project.workspace_dir().join("AGENTS.md").is_file());
        assert!(project.notes_dir().join("outline.md").is_file());
        assert!(project.session_dir().join("c-1.jsonl").is_file());

        // A second run adds what is new rather than a second project.
        let again = import(&export, &ImportOptions::new(), &mut registry).unwrap();
        assert_eq!((again.imported(), again.already()), (0, 1));
        assert_eq!(registry.projects().len(), 1);

        fs::remove_dir_all(project.store_dir()).ok();
        fs::remove_dir_all(&into).ok();
    }

    /// The safety-critical one. A `tool_use` in an export names one of
    /// claude.ai's own tools, which is on no Nightloom request — recorded as a
    /// tool block it would be an orphan or a call to a tool that was never
    /// advertised, and every provider 400s on both.
    #[test]
    fn claude_ai_tool_calls_never_become_replayable_tool_blocks() {
        let (_src, export) = export_of(
            "tools",
            one_project(),
            json!([{
                "uuid": "c-1",
                "name": "Built a thing",
                "project_uuid": "p-1",
                "created_at": "2025-03-04T05:06:07Z",
                "chat_messages": [
                    message("m-1", "human", "write me a sorter"),
                    {
                        "uuid": "m-2",
                        "sender": "assistant",
                        "created_at": "2025-03-04T05:06:08Z",
                        "content": [
                            { "type": "text", "text": "Here it is." },
                            {
                                "type": "tool_use",
                                "name": "artifacts",
                                "input": {
                                    "command": "create",
                                    "title": "Quicksort",
                                    "language": "python",
                                    "content": "def sort(xs): return sorted(xs)",
                                },
                            },
                            {
                                "type": "tool_use",
                                "name": "web_search",
                                "input": { "query": "stable sort python" },
                            },
                            {
                                "type": "tool_result",
                                "name": "web_search",
                                "is_error": false,
                                "content": [{ "type": "text", "text": "Timsort is stable." }],
                            },
                        ],
                    },
                ],
            }]),
        );

        let into = test_dir("import-tools");
        let report = run(&export, &into);
        let session = session_of(&report.projects[0], "c-1");
        let blocks = assistant_blocks_of(&session);

        assert!(
            !blocks.iter().any(|b| matches!(
                b,
                ContentBlock::ToolUse { .. } | ContentBlock::ToolResult { .. }
            )),
            "an imported conversation must carry no tool blocks: {blocks:?}"
        );

        let text = blocks
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        // The artifact is what the conversation was for, so it survives whole.
        assert!(text.contains("def sort(xs): return sorted(xs)"), "{text}");
        assert!(text.contains("[artifact: Quicksort]"), "{text}");
        // The search is named rather than replayed, and its result kept.
        assert!(
            text.contains("[used web_search: stable sort python]"),
            "{text}"
        );
        assert!(text.contains("Timsort is stable."), "{text}");
    }

    /// Imported reasoning renders but can never be forged onto a wire: no
    /// adapter replays a signature it did not issue.
    #[test]
    fn imported_thinking_is_kept_and_left_unsigned() {
        let (_src, export) = export_of(
            "thinking",
            one_project(),
            json!([{
                "uuid": "c-1",
                "name": "Thought about it",
                "project_uuid": "p-1",
                "created_at": "2025-03-04T05:06:07Z",
                "chat_messages": [
                    message("m-1", "human", "why?"),
                    {
                        "uuid": "m-2",
                        "sender": "assistant",
                        "created_at": "2025-03-04T05:06:08Z",
                        "content": [
                            { "type": "thinking", "thinking": "Let me weigh the two." },
                            { "type": "text", "text": "Because of the second one." },
                        ],
                    },
                ],
            }]),
        );

        let into = test_dir("import-thinking");
        let report = run(&export, &into);
        let blocks = assistant_blocks_of(&session_of(&report.projects[0], "c-1"));
        let thinking: Vec<_> = blocks
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Thinking { text, signature } => Some((text.as_str(), signature)),
                _ => None,
            })
            .collect();
        assert_eq!(thinking.len(), 1);
        assert_eq!(thinking[0].0, "Let me weigh the two.");
        assert!(
            thinking[0].1.is_none(),
            "imported thinking must be unsigned"
        );
    }

    /// Resemblance is not a link. A conversation with no project id is
    /// reported, never filed under the project whose name it happens to echo.
    #[test]
    fn a_conversation_with_no_project_link_is_never_guessed_into_one() {
        let (_src, export) = export_of(
            "unlinked",
            one_project(),
            json!([{
                "uuid": "c-loose",
                // Named exactly like the project, which is precisely the bait.
                "name": "Thesis Research",
                "created_at": "2025-03-04T05:06:07Z",
                "chat_messages": [message("m-1", "human", "hello")],
            }]),
        );

        let into = test_dir("import-unlinked");
        let report = run(&export, &into);
        assert_eq!(report.unfiled, 1);
        assert_eq!(report.projects[0].imported, 0);

        // And it is importable on request, into a folder of its own.
        let into = test_dir("import-unlinked-on");
        let mut opts = ImportOptions::new().into_folder(&into);
        opts.unfiled = true;
        let report = run_with(&export, opts, &into);
        assert_eq!(report.unfiled, 0);
        assert_eq!(report.projects.len(), 2);
        assert_eq!(report.projects[1].imported, 1);
    }

    /// A claude.ai conversation is a tree: editing a message branches it.
    /// Importing every branch in index order would read as the same question
    /// asked twice with two different answers.
    #[test]
    fn an_edited_conversation_imports_only_the_surviving_branch() {
        let (_src, export) = export_of(
            "branch",
            one_project(),
            json!([{
                "uuid": "c-1",
                "name": "Edited",
                "project_uuid": "p-1",
                "created_at": "2025-03-04T05:06:07Z",
                "current_leaf_message_uuid": "m-3b",
                "chat_messages": [
                    { "uuid": "m-1", "sender": "human", "index": 0,
                      "created_at": "2025-03-04T05:06:07Z",
                      "content": [{ "type": "text", "text": "first ask" }] },
                    { "uuid": "m-2a", "sender": "assistant", "index": 1,
                      "parent_message_uuid": "m-1",
                      "created_at": "2025-03-04T05:06:08Z",
                      "content": [{ "type": "text", "text": "abandoned answer" }] },
                    { "uuid": "m-2b", "sender": "assistant", "index": 1,
                      "parent_message_uuid": "m-1",
                      "created_at": "2025-03-04T05:06:09Z",
                      "content": [{ "type": "text", "text": "kept answer" }] },
                    { "uuid": "m-3b", "sender": "human", "index": 2,
                      "parent_message_uuid": "m-2b",
                      "created_at": "2025-03-04T05:06:10Z",
                      "content": [{ "type": "text", "text": "follow up" }] },
                ],
            }]),
        );

        let into = test_dir("import-branch");
        let report = run(&export, &into);
        assert_eq!(report.projects[0].superseded, 1);

        let session = session_of(&report.projects[0], "c-1");
        let text: Vec<String> = session
            .events()
            .iter()
            .filter_map(|e| match e {
                SessionEvent::UserMessage { text, .. } => Some(text.clone()),
                SessionEvent::AssistantMessage { blocks, .. } => Some(
                    blocks
                        .iter()
                        .filter_map(|b| match b {
                            ContentBlock::Text { text } => Some(text.clone()),
                            _ => None,
                        })
                        .collect(),
                ),
                _ => None,
            })
            .collect();
        assert_eq!(text, vec!["first ask", "kept answer", "follow up"]);
    }

    /// Reading is total, for the reason loading a session log is: this is
    /// somebody's history and one record a build cannot parse must not cost
    /// them the other nine hundred.
    #[test]
    fn one_unreadable_conversation_does_not_fail_the_rest() {
        let (_src, export) = export_of(
            "torn",
            one_project(),
            json!([
                { "this": "has no uuid at all" },
                {
                    "uuid": "c-good",
                    "name": "Fine",
                    "project_uuid": "p-1",
                    "created_at": "2025-03-04T05:06:07Z",
                    "chat_messages": [message("m-1", "human", "hello")],
                },
            ]),
        );
        assert_eq!(export.unreadable, 1);
        assert_eq!(export.conversations.len(), 1);

        let into = test_dir("import-torn");
        let report = run(&export, &into);
        assert_eq!(report.projects[0].imported, 1);
        assert_eq!(report.unreadable, 1);
    }

    /// An unrecognised block kind costs a line, never the conversation — the
    /// same device `SessionEvent::Unknown` is.
    #[test]
    fn an_unknown_block_kind_does_not_lose_the_message_around_it() {
        let (_src, export) = export_of(
            "unknown-block",
            one_project(),
            json!([{
                "uuid": "c-1",
                "name": "Future",
                "project_uuid": "p-1",
                "created_at": "2025-03-04T05:06:07Z",
                "chat_messages": [
                    message("m-1", "human", "hello"),
                    {
                        "uuid": "m-2",
                        "sender": "assistant",
                        "created_at": "2025-03-04T05:06:08Z",
                        "content": [
                            { "type": "something_invented_next_year", "payload": 12 },
                            { "type": "text", "text": "still here" },
                        ],
                    },
                ],
            }]),
        );

        let into = test_dir("import-unknown-block");
        let report = run(&export, &into);
        let blocks = assistant_blocks_of(&session_of(&report.projects[0], "c-1"));
        assert_eq!(blocks.len(), 1);
        assert!(matches!(&blocks[0], ContentBlock::Text { text } if text == "still here"));
    }

    /// A message the export left empty keeps its place rather than vanishing:
    /// dropping it would put two user turns next to each other, which is a 400
    /// on replay. Same argument elision makes.
    #[test]
    fn an_empty_message_keeps_its_turn() {
        let (_src, export) = export_of(
            "empty",
            one_project(),
            json!([{
                "uuid": "c-1",
                "name": "Empty",
                "project_uuid": "p-1",
                "created_at": "2025-03-04T05:06:07Z",
                "chat_messages": [
                    message("m-1", "human", "hello"),
                    { "uuid": "m-2", "sender": "assistant", "content": [],
                      "created_at": "2025-03-04T05:06:08Z" },
                    message("m-3", "human", "still there?"),
                ],
            }]),
        );

        let into = test_dir("import-empty");
        let report = run(&export, &into);
        let session = session_of(&report.projects[0], "c-1");
        let roles: Vec<&str> = session
            .events()
            .iter()
            .filter_map(|e| match e {
                SessionEvent::UserMessage { .. } => Some("user"),
                SessionEvent::AssistantMessage { .. } => Some("assistant"),
                _ => None,
            })
            .collect();
        assert_eq!(roles, vec!["user", "assistant", "user"]);
        assert!(!assistant_blocks_of(&session).is_empty());
    }

    /// Both shells sort a session list by the log file's mtime, and
    /// `--continue` opens the newest — so an import that left every file
    /// stamped with the moment it ran would flatten a year of history into one
    /// afternoon and hijack `--continue` in the bargain.
    #[test]
    fn an_imported_log_keeps_the_conversation_s_own_modification_time() {
        let (_src, export) = export_of(
            "mtime",
            one_project(),
            json!([{
                "uuid": "c-1",
                "name": "Old chat",
                "project_uuid": "p-1",
                "created_at": "2024-06-01T10:00:00Z",
                "updated_at": "2024-06-01T10:45:00Z",
                "chat_messages": [message("m-1", "human", "hello")],
            }]),
        );

        let into = test_dir("import-mtime");
        let report = run(&export, &into);
        let log = sessions_of(&report.projects[0]).join("c-1.jsonl");
        let modified = fs::metadata(&log).unwrap().modified().unwrap();
        let expected: std::time::SystemTime = "2024-06-01T10:45:00Z"
            .parse::<DateTime<Utc>>()
            .unwrap()
            .into();
        let drift = modified
            .duration_since(expected)
            .or_else(|_| expected.duration_since(modified))
            .unwrap();
        assert!(
            drift.as_secs() < 2,
            "log is stamped {modified:?}, wanted {expected:?}"
        );
    }

    /// Re-importing is the ordinary way to pick up chats you have had since
    /// the last export, so it must not be able to undo work done in the
    /// docspace in between.
    #[test]
    fn re_importing_does_not_overwrite_an_edited_note_or_agents_md() {
        let (_src, export) = export_of(
            "preserve",
            one_project(),
            json!([{
                "uuid": "c-1",
                "name": "First",
                "project_uuid": "p-1",
                "created_at": "2025-03-04T05:06:07Z",
                "chat_messages": [message("m-1", "human", "hello")],
            }]),
        );
        let into = test_dir("import-preserve");

        let first = run(&export, &into);
        let root = workspace_of(&first.projects[0]);
        assert!(first.projects[0].instructions);
        assert!(first.projects[0].warnings.is_empty());

        // The user edits both, as they are meant to.
        let note = notes_of(&first.projects[0]).join("outline.md");
        fs::write(&note, "# Outline\n\nMy own rewrite.").unwrap();
        fs::write(root.join("AGENTS.md"), "my own instructions").unwrap();

        let second = run(&export, &into);
        assert_eq!(
            fs::read_to_string(&note).unwrap(),
            "# Outline\n\nMy own rewrite."
        );
        assert_eq!(
            fs::read_to_string(root.join("AGENTS.md")).unwrap(),
            "my own instructions"
        );
        // And both are said out loud rather than silently skipped.
        assert_eq!(
            second.projects[0].warnings.len(),
            2,
            "{:?}",
            second.projects[0].warnings
        );
    }

    /// An untouched re-import is quiet: warning about files this import wrote
    /// itself is what teaches people to skip the warnings that matter.
    #[test]
    fn an_untouched_re_import_says_nothing() {
        let (_src, export) = export_of(
            "quiet",
            one_project(),
            json!([{
                "uuid": "c-1",
                "name": "First",
                "project_uuid": "p-1",
                "created_at": "2025-03-04T05:06:07Z",
                "chat_messages": [message("m-1", "human", "hello")],
            }]),
        );
        let into = test_dir("import-quiet");
        run(&export, &into);
        let second = run(&export, &into);
        assert!(
            second.projects[0].warnings.is_empty(),
            "{:?}",
            second.projects[0].warnings
        );
        assert_eq!(second.projects[0].already, 1);
    }

    /// The zip is what arrives in the email, so it is what the reader takes.
    #[test]
    fn an_export_is_read_straight_out_of_the_zip() {
        use std::io::Write as _;

        let dir = test_dir("import-zip");
        let path = dir.join("data.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        // Nested, as the archive has shipped, and matched on the basename.
        zip.start_file("data-2025-03-04/projects.json", options)
            .unwrap();
        zip.write_all(&serde_json::to_vec(&one_project()).unwrap())
            .unwrap();
        zip.start_file("data-2025-03-04/conversations.json", options)
            .unwrap();
        zip.write_all(
            &serde_json::to_vec(&json!([{
                "uuid": "c-1",
                "name": "From a zip",
                "project_uuid": "p-1",
                "created_at": "2025-03-04T05:06:07Z",
                "chat_messages": [message("m-1", "human", "hello")],
            }]))
            .unwrap(),
        )
        .unwrap();
        zip.finish().unwrap();

        let export = read_export(&path).unwrap();
        assert_eq!(export.projects.len(), 1);
        assert_eq!(export.conversations.len(), 1);

        let into = test_dir("import-zip-out");
        let report = run(&export, &into);
        assert_eq!(report.imported(), 1);
    }

    /// The layout current exports actually ship: no `projects.json` anywhere,
    /// and one file per project in a `projects/` directory beside the
    /// conversations. Against a reader that knew only the array, this parsed
    /// zero projects, wrote no instructions and no documents, and sent every
    /// conversation down the unfiled path — with nothing raised anywhere.
    #[test]
    fn projects_ship_as_a_directory_of_one_file_each() {
        use std::io::Write as _;

        let dir = test_dir("import-projects-dir");
        let path = dir.join("data.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);

        // One object per file — the element the array used to hold.
        zip.start_file("data-2026-08-19/projects/p-1.json", options)
            .unwrap();
        zip.write_all(&serde_json::to_vec(&one_project()[0]).unwrap())
            .unwrap();
        zip.start_file("data-2026-08-19/projects/p-2.json", options)
            .unwrap();
        zip.write_all(
            &serde_json::to_vec(&json!({
                "uuid": "p-2",
                "name": "Recipes",
                "prompt_template": "Metric units.",
                "docs": [],
            }))
            .unwrap(),
        )
        .unwrap();
        // A Mac's resource fork sits in the same directory and is not a project.
        zip.start_file("__MACOSX/projects/._p-1.json", options)
            .unwrap();
        zip.write_all(b"not json").unwrap();
        zip.start_file("data-2026-08-19/conversations.json", options)
            .unwrap();
        zip.write_all(
            &serde_json::to_vec(&json!([{
                "uuid": "c-1",
                "name": "Chapter one",
                "project_uuid": "p-1",
                "created_at": "2026-08-19T05:06:07Z",
                "chat_messages": [message("m-1", "human", "hello")],
            }]))
            .unwrap(),
        )
        .unwrap();
        zip.finish().unwrap();

        let export = read_export(&path).unwrap();
        assert_eq!(export.projects.len(), 2, "{:?}", export.warnings);
        assert_eq!(export.unreadable, 0, "{:?}", export.warnings);
        let thesis = &export.projects[0];
        assert_eq!(thesis.uuid, "p-1");
        // The half the reporter noticed missing: instructions and documents.
        assert_eq!(thesis.prompt_template, "Always cite a source.");
        assert_eq!(thesis.docs.len(), 3);

        let into = test_dir("import-projects-dir-out");
        let report = run(&export, &into);
        assert_eq!(report.projects.len(), 2);
        assert!(report.projects[0].instructions);
        assert_eq!(report.imported(), 1);
    }

    /// `#[serde(default)]` answers a field that is missing, not one that is
    /// present and null, and a real export writes `"filename": null` on an
    /// attachment whose name was lost. That failed the whole conversation:
    /// six otherwise readable chats out of 1,817 dropped over a name nothing
    /// downstream needed.
    #[test]
    fn a_null_where_a_string_was_expected_does_not_cost_the_conversation() {
        let mut msg = message("m-1", "human", "what is in this file?");
        msg["attachments"] = json!([{
            "file_name": null,
            "file_type": null,
            "extracted_content": "the contents",
        }]);
        msg["files"] = json!([{ "file_name": null }]);
        let (_src, export) = export_of(
            "nulls",
            json!([{
                "uuid": "p-1",
                "name": "Nulls",
                "prompt_template": null,
                "description": null,
                "docs": [{ "filename": null, "content": null }],
            }]),
            json!([{
                "uuid": "c-1",
                "name": null,
                "project_uuid": "p-1",
                "created_at": "2025-03-04T05:06:07Z",
                "chat_messages": [msg],
            }]),
        );

        assert_eq!(export.unreadable, 0, "{:?}", export.warnings);
        assert_eq!(export.conversations.len(), 1);
        assert_eq!(export.projects.len(), 1);

        let into = test_dir("import-nulls-out");
        let report = run(&export, &into);
        assert_eq!(report.unfiled, 0);
        assert_eq!(report.imported(), 1);
    }

    /// The same layout after somebody unzipped it to look, which puts
    /// `projects/` two directories below the one they point at.
    #[test]
    fn a_projects_directory_is_found_in_an_unpacked_folder() {
        let dir = test_dir("import-unpacked");
        let dated = dir.join("data-2026-08-19");
        fs::create_dir_all(dated.join(PROJECTS_DIR)).unwrap();
        fs::write(
            dated.join(PROJECTS_DIR).join("p-1.json"),
            serde_json::to_vec_pretty(&one_project()[0]).unwrap(),
        )
        .unwrap();
        fs::write(
            dated.join(CONVERSATIONS),
            serde_json::to_vec_pretty(&json!([])).unwrap(),
        )
        .unwrap();

        let export = read_export(&dir).unwrap();
        assert_eq!(export.projects.len(), 1, "{:?}", export.warnings);
        assert_eq!(export.projects[0].name, "Thesis Research");
    }

    /// An archive carrying both layouts must import every project once. The
    /// array is the one read, and the directory is not also walked.
    #[test]
    fn the_array_wins_when_an_export_carries_both_layouts() {
        use std::io::Write as _;

        let dir = test_dir("import-both-layouts");
        let path = dir.join("data.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        zip.start_file("projects.json", options).unwrap();
        zip.write_all(&serde_json::to_vec(&one_project()).unwrap())
            .unwrap();
        zip.start_file("projects/p-1.json", options).unwrap();
        zip.write_all(&serde_json::to_vec(&one_project()[0]).unwrap())
            .unwrap();
        zip.finish().unwrap();

        let export = read_export(&path).unwrap();
        assert_eq!(export.projects.len(), 1);
        assert_eq!(export.projects[0].uuid, "p-1");
    }

    /// Restoring the projects cannot restore the filing: some accounts export
    /// no link at all, and what that leaves — every project imported with its
    /// instructions, every chat in a pile beside them — is indistinguishable
    /// from a filing bug unless it is said out loud.
    #[test]
    fn an_export_with_no_project_link_says_so() {
        let (_src, export) = export_of(
            "no-link",
            one_project(),
            json!([{
                "uuid": "c-1",
                "name": "Belongs to nothing",
                "created_at": "2026-08-19T05:06:07Z",
                "chat_messages": [message("m-1", "human", "hello")],
            }]),
        );
        let into = test_dir("import-no-link");
        let report = run(&export, &into);
        assert_eq!(report.unfiled, 1);
        assert!(
            report
                .warnings
                .iter()
                .any(|w| w.contains("cannot be recovered")),
            "{:?}",
            report.warnings
        );
    }

    /// An existing `AGENTS.md` means the folder is somebody's real project,
    /// and replacing the instructions it works under is the most damaging
    /// thing this feature could do.
    #[test]
    fn an_existing_agents_md_is_left_alone() {
        let (_src, export) = export_of("agents", one_project(), json!([]));
        let into = test_dir("import-agents");
        let root = into.join("Thesis-Research");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("AGENTS.md"), "mine, do not touch").unwrap();

        let report = run(&export, &into);
        assert!(!report.projects[0].instructions);
        assert_eq!(
            fs::read_to_string(root.join("AGENTS.md")).unwrap(),
            "mine, do not touch"
        );
        assert!(!report.projects[0].warnings.is_empty());
    }

    /// Two projects with the same name are two folders, not one folder with
    /// both their chats in it.
    #[test]
    fn projects_sharing_a_name_get_separate_folders() {
        let (_src, export) = export_of(
            "collide",
            json!([
                { "uuid": "p-1", "name": "Notes", "docs": [], "prompt_template": "one" },
                { "uuid": "p-2", "name": "Notes", "docs": [], "prompt_template": "two" },
            ]),
            json!([]),
        );
        let into = test_dir("import-collide");
        let report = run(&export, &into);
        assert_eq!(report.projects.len(), 2);
        assert_ne!(report.projects[0].root, report.projects[1].root);
    }

    /// A conversation id becomes a filename, and an export is a zip that
    /// arrived by email.
    #[test]
    fn a_conversation_id_cannot_escape_the_sessions_directory() {
        let (_src, export) = export_of(
            "escape",
            one_project(),
            json!([{
                "uuid": "../../escaped",
                "name": "Nope",
                "project_uuid": "p-1",
                "created_at": "2025-03-04T05:06:07Z",
                "chat_messages": [message("m-1", "human", "hello")],
            }]),
        );
        let into = test_dir("import-escape");
        let report = run(&export, &into);
        assert_eq!(report.projects[0].imported, 0);
        assert!(!report.projects[0].warnings.is_empty());
        assert!(!into.join("escaped.jsonl").exists());
    }

    // ---- memories ------------------------------------------------------

    /// A zip in the current layout — `projects/` directory, no chats — plus
    /// the `memories/<account>.json` the same archives now carry.
    fn memories_zip(name: &str, memories: serde_json::Value) -> PathBuf {
        use std::io::Write as _;

        let dir = test_dir(&format!("import-memories-{name}"));
        let path = dir.join("data.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        zip.start_file("data-2026-08-19/projects/p-1.json", options)
            .unwrap();
        zip.write_all(&serde_json::to_vec(&one_project()[0]).unwrap())
            .unwrap();
        zip.start_file("data-2026-08-19/projects/p-2.json", options)
            .unwrap();
        zip.write_all(
            &serde_json::to_vec(&json!({
                "uuid": "p-2",
                "name": "Recipes",
                "prompt_template": "",
                "docs": [],
            }))
            .unwrap(),
        )
        .unwrap();
        zip.start_file("data-2026-08-19/conversations.json", options)
            .unwrap();
        zip.write_all(b"[]").unwrap();
        zip.start_file("data-2026-08-19/memories/acct-1.json", options)
            .unwrap();
        zip.write_all(&serde_json::to_vec(&memories).unwrap())
            .unwrap();
        zip.finish().unwrap();
        path
    }

    /// The user memory is one file for the whole process, so every test
    /// that carries one carries this text, and the never-overwrite rule
    /// then reads it as byte-identical rather than edited.
    const USER_MEMORY: &str = "Prefers short answers and metric units.";

    fn long_summary() -> String {
        "Recipes are kept in metric. ".repeat(200)
    }

    fn memories_fixture(vault_tag: &str) -> serde_json::Value {
        json!({
            "conversations_memory": USER_MEMORY,
            "project_memories": {
                "p-1": "Chapter one is drafted; chapter two is outlined.",
                "p-2": long_summary(),
                "p-gone": "a project the export does not carry",
                "p-null": null,
            },
            "memory_files": [
                { "path": "/profile.md", "content": "---\nname: profile\n---\nA reader.\n", "updated_at": "2026-08-19T00:00:00Z" },
                { "path": format!("/areas/{vault_tag}.md"), "content": "An area.\n" },
                { "path": "/projects/p-1/index.md", "content": "# Thesis memory\n" },
                { "path": "/projects/p-1/people/amanda.md", "content": "Amanda advises.\n" },
                { "path": "/projects/p-2/overview.md", "content": "Metric.\n" },
                { "path": "/projects/p-1", "content": "names no file" },
                { "path": "/empty.md", "content": "" },
            ],
            "account_uuid": "acct-1",
        })
    }

    fn user_memory_path() -> PathBuf {
        crate::prompt::user_instruction_path().unwrap()
    }

    fn vault() -> PathBuf {
        crate::knowledge::vault_dir().unwrap()
    }

    #[test]
    fn the_account_s_memory_is_read_out_of_the_zip() {
        let path = memories_zip("read", memories_fixture("read"));
        let export = read_export(&path).unwrap();
        assert_eq!(export.projects.len(), 2, "{:?}", export.warnings);
        let memories = &export.memories;
        assert_eq!(memories.conversations_memory, USER_MEMORY);
        // The null summary is a project with no memory, not a bad record.
        assert_eq!(memories.project_memories.len(), 3);
        assert_eq!(memories.memory_files.len(), 7);
        assert_eq!(export.unreadable, 0, "{:?}", export.warnings);
    }

    /// One field at a time: a summary that is not text costs that summary.
    #[test]
    fn a_bad_project_memory_does_not_cost_the_rest() {
        let path = memories_zip(
            "bad-record",
            json!({
                "conversations_memory": null,
                "project_memories": { "p-1": 42, "p-2": "fine" },
                "memory_files": [
                    { "path": "/profile.md", "content": "ok" },
                    "not an object",
                ],
            }),
        );
        let export = read_export(&path).unwrap();
        assert_eq!(export.memories.conversations_memory, "");
        assert_eq!(export.memories.project_memories.len(), 1);
        assert_eq!(export.memories.memory_files.len(), 1);
        assert_eq!(export.unreadable, 2);
    }

    #[test]
    fn memory_lands_in_its_five_places() {
        let path = memories_zip("places", memories_fixture("places"));
        let export = read_export(&path).unwrap();
        let into = test_dir("import-memories-places-out");
        let report = run(&export, &into);
        assert_eq!(report.projects.len(), 2, "{:?}", report.warnings);

        // 1. The user's summary: in the vault, on demand, and never in the
        //    always-loaded file — which points at it instead.
        let background = fs::read_to_string(vault().join(BACKGROUND_NOTE)).unwrap();
        assert!(background.starts_with("---\nname: background\n"));
        assert!(background.ends_with(&format!("\n{USER_MEMORY}\n")));
        let user_memory = fs::read_to_string(user_memory_path()).unwrap();
        assert!(!user_memory.contains(USER_MEMORY));
        assert_eq!(user_memory.matches(BACKGROUND_HEADING).count(), 1);
        assert!(user_memory.contains(BACKGROUND_POINTER));
        // 2. Global files in the vault, at their own paths, `.md` and all.
        assert_eq!(
            fs::read_to_string(vault().join("profile.md")).unwrap(),
            "---\nname: profile\n---\nA reader.\n"
        );
        assert_eq!(
            fs::read_to_string(vault().join("areas").join("places.md")).unwrap(),
            "An area.\n"
        );
        // 3. The project summary, whole, on demand.
        let thesis = workspace_of(&report.projects[0]);
        let recipes = workspace_of(&report.projects[1]);
        let summary = |root: &Path| root.join(AGENTS_DIR).join(MEMORY_DIR).join(MEMORY_SUMMARY);
        assert_eq!(
            fs::read_to_string(summary(&thesis)).unwrap(),
            "Chapter one is drafted; chapter two is outlined.\n"
        );
        assert_eq!(
            fs::read_to_string(summary(&recipes)).unwrap(),
            format!("{}\n", long_summary().trim())
        );
        // 4. The short summary inline in AGENTS.md, under the instructions
        //    the import wrote a moment earlier; the long one as a pointer.
        let thesis_agents = fs::read_to_string(thesis.join("AGENTS.md")).unwrap();
        assert!(thesis_agents.starts_with("# Thesis Research\n"));
        assert!(thesis_agents.contains("## Project instructions\n\nAlways cite a source.\n"));
        assert!(thesis_agents.contains(&format!(
            "\n{MEMORY_HEADING} {})\n\nChapter one is drafted; chapter two is outlined.\n",
            Utc::now().format("%Y-%m-%d")
        )));
        // Recipes had no instructions, so this AGENTS.md is new.
        let recipes_agents = fs::read_to_string(recipes.join("AGENTS.md")).unwrap();
        assert!(recipes_agents.starts_with("# Recipes\n"));
        assert!(recipes_agents.contains(MEMORY_HEADING));
        assert!(!recipes_agents.contains("Recipes are kept in metric."));
        assert!(recipes_agents.contains(
            "The full project memory imported from claude.ai is in .agents/memory/summary.md"
        ));
        assert_eq!(
            report.needs_condensing,
            vec![("Recipes".to_string(), long_summary().trim().chars().count())]
        );
        // 5. Per-project files under `.agents/memory/`, directories made.
        assert_eq!(
            fs::read_to_string(thesis.join(AGENTS_DIR).join(MEMORY_DIR).join("index.md")).unwrap(),
            "# Thesis memory\n"
        );
        assert_eq!(
            fs::read_to_string(
                thesis
                    .join(AGENTS_DIR)
                    .join(MEMORY_DIR)
                    .join("people")
                    .join("amanda.md")
            )
            .unwrap(),
            "Amanda advises.\n"
        );
        assert_eq!(
            fs::read_to_string(
                recipes
                    .join(AGENTS_DIR)
                    .join(MEMORY_DIR)
                    .join("overview.md")
            )
            .unwrap(),
            "Metric.\n"
        );

        // 1 vault + 2 summaries + 3 project files are this test's own; the
        // user memory's pointer, `background.md` and `profile.md` are shared
        // with the other memory tests in this process, and whichever ran
        // first wrote them.
        assert!(
            (6..=9).contains(&report.memory_written),
            "{} written, {:?}",
            report.memory_written,
            report.warnings
        );
        assert_eq!(report.memory_left_alone, 0);
        assert_eq!(report.memory_inlined, 2);
        // The uuid with no project and the path naming no file are warnings.
        assert!(report.warnings.iter().any(|w| w.contains("p-gone")));
        assert!(report.warnings.iter().any(|w| w.contains("names no file")));
        assert!(report.summary().contains("memory file(s)"));
        assert!(
            report
                .summary()
                .contains("1 project memor(ies) to condense")
        );
    }

    /// A second run of the same export writes nothing and appends nothing,
    /// and a memory file edited here is left alone out loud.
    #[test]
    fn re_importing_memory_adds_nothing_and_overwrites_nothing() {
        let path = memories_zip("again", memories_fixture("again"));
        let export = read_export(&path).unwrap();
        let into = test_dir("import-memories-again-out");
        let first = run(&export, &into);
        assert_eq!(first.memory_inlined, 2, "{:?}", first.warnings);

        let thesis = workspace_of(&first.projects[0]);
        let summary = thesis
            .join(AGENTS_DIR)
            .join(MEMORY_DIR)
            .join(MEMORY_SUMMARY);
        fs::write(&summary, "condensed by hand").unwrap();

        let second = run(&export, &into);
        assert_eq!(second.memory_written, 0, "{:?}", second.warnings);
        assert_eq!(second.memory_inlined, 0);
        assert_eq!(second.memory_left_alone, 1);
        assert!(
            second
                .warnings
                .iter()
                .any(|w| w.contains("summary.md has been edited here and was left alone")),
            "{:?}",
            second.warnings
        );
        assert_eq!(fs::read_to_string(&summary).unwrap(), "condensed by hand");
        // The heading appears once, not once per run.
        let agents = fs::read_to_string(thesis.join("AGENTS.md")).unwrap();
        assert_eq!(agents.matches(MEMORY_HEADING).count(), 1);
        // The oversized one is still listed, its pointer not yet replaced.
        assert_eq!(second.needs_condensing.len(), 1);

        // Replace the pointer with a condensed version and the nag stops.
        let recipes = workspace_of(&first.projects[1]).join("AGENTS.md");
        fs::write(
            &recipes,
            format!("# Recipes\n\n{MEMORY_HEADING} 2026-08-19)\n\nMetric, always.\n"),
        )
        .unwrap();
        let third = run(&export, &into);
        assert!(third.needs_condensing.is_empty());
        assert_eq!(third.memory_inlined, 0);
    }

    /// A memory file's path is a label from a zip that arrived by email.
    #[test]
    fn a_memory_file_cannot_escape_its_directory() {
        let path = memories_zip(
            "escape",
            json!({
                "conversations_memory": USER_MEMORY,
                "project_memories": {},
                "memory_files": [
                    { "path": "/../escaped-global.md", "content": "no" },
                    { "path": "/projects/p-1/../../escaped-project.md", "content": "no" },
                ],
            }),
        );
        let export = read_export(&path).unwrap();
        let into = test_dir("import-memories-escape-out");
        let report = run(&export, &into);
        // Only the user's summary (the vault note and the pointer), which
        // are byte-identical from the other tests or freshly written here —
        // never one of the two files.
        assert!(report.memory_written <= 2, "{:?}", report.warnings);
        assert_eq!(
            report
                .warnings
                .iter()
                .filter(|w| w.contains("escaped"))
                .count(),
            2,
            "{:?}",
            report.warnings
        );
        assert!(!vault().parent().unwrap().join("escaped-global.md").exists());
        let thesis = workspace_of(&report.projects[0]);
        assert!(!thesis.join("escaped-project.md").exists());
        assert!(!thesis.join(AGENTS_DIR).join("escaped-project.md").exists());
    }

    /// `--only` narrows the projects and so their memory; the user memory
    /// and the vault are nobody's project and are written regardless.
    #[test]
    fn only_narrows_project_memory_but_not_the_user_s() {
        let path = memories_zip("only", memories_fixture("only"));
        let export = read_export(&path).unwrap();
        let into = test_dir("import-memories-only-out");
        let mut opts = ImportOptions::new().into_folder(&into);
        opts.only = vec!["recipes".to_string()];
        let report = run_with(&export, opts, &into);
        assert_eq!(report.projects.len(), 1);
        assert_eq!(report.projects[0].name, "Recipes");
        assert!(vault().join("areas").join("only.md").exists());
        let recipes = workspace_of(&report.projects[0]);
        assert!(
            recipes
                .join(AGENTS_DIR)
                .join(MEMORY_DIR)
                .join("overview.md")
                .exists()
        );
        // Thesis was not imported, and its memory is not a warning either —
        // it was asked to be left out.
        assert!(
            !report
                .warnings
                .iter()
                .any(|w| w.contains("memory for project p-1")),
            "{:?}",
            report.warnings
        );
        assert!(!into.join("Thesis-Research").exists());
    }

    /// The `memories/` directory is found in an unpacked folder too.
    #[test]
    fn memories_are_found_in_an_unpacked_folder() {
        let dir = test_dir("import-memories-folder");
        let data = dir.join("data-2026-08-19");
        fs::create_dir_all(data.join(PROJECTS_DIR)).unwrap();
        fs::create_dir_all(data.join(MEMORIES_DIR)).unwrap();
        fs::write(
            data.join(PROJECTS_DIR).join("p-1.json"),
            serde_json::to_vec(&one_project()[0]).unwrap(),
        )
        .unwrap();
        fs::write(data.join(CONVERSATIONS), b"[]").unwrap();
        fs::write(
            data.join(MEMORIES_DIR).join("acct-1.json"),
            serde_json::to_vec(&json!({
                "project_memories": { "p-1": "From a folder." },
                "memory_files": [],
            }))
            .unwrap(),
        )
        .unwrap();
        let export = read_export(&dir).unwrap();
        assert_eq!(export.memories.project_memories.len(), 1);
        assert_eq!(export.memories.project_memories["p-1"], "From a folder.");
    }

    // ---- the user's summary: vault note + pointer (backlog 055) ----------
    //
    // The user memory and the vault are one pair of paths for the whole
    // test process, so the rules that need a file in a known prior state
    // are exercised on the two writers directly, with paths of their own.

    /// The export's summary as it actually ships: instructions top and
    /// bottom, the four biographical sections between.
    const EXPORT_SUMMARY: &str = "## Standing instructions\n\nBe terse.\n\n\
        **Work context**\n\nA freshman.\n\n**Personal context**\n\nLifts.\n\n\
        **Top of mind**\n\nFinals.\n\n**Brief history**\n\nMoved west.\n\n\
        **Other instructions**\n\n- No em dashes.";

    #[test]
    fn the_summary_becomes_a_vault_note_and_the_memory_a_pointer() {
        let dir = test_dir("import-background-fresh");
        let vault = dir.join("knowledge");
        let memory = dir.join("AGENTS.md");
        let mut report = ImportReport::default();

        write_background(&vault, EXPORT_SUMMARY, &mut report);
        ensure_background_pointer(&memory, &mut report);

        let note = fs::read_to_string(vault.join(BACKGROUND_NOTE)).unwrap();
        let today = Utc::now().format("%Y-%m-%d").to_string();
        assert!(note.starts_with("---\nname: background\n"));
        assert!(note.contains(&format!("sources: [claude.ai export, {today}]\n")));
        assert!(note.contains("# Background (on demand)\n"));
        assert!(note.ends_with(&format!("\n{EXPORT_SUMMARY}\n")));
        assert_eq!(report.background_note, Some(vault.join(BACKGROUND_NOTE)));

        // A memory that did not exist is the paragraph alone — and none of
        // the export's sections, instructions included (blocker 061).
        let text = fs::read_to_string(&memory).unwrap();
        assert_eq!(text, format!("{BACKGROUND_POINTER}\n"));
        assert!(!text.contains("Work context"));
        assert!(!text.contains("Be terse."));
        assert_eq!(report.memory_written, 2);
        assert!(report.warnings.is_empty(), "{:?}", report.warnings);
    }

    /// A second run changes nothing: the note is byte-identical and not
    /// counted, the paragraph is found by its heading and not added again.
    #[test]
    fn re_importing_the_summary_is_idempotent() {
        let dir = test_dir("import-background-again");
        let vault = dir.join("knowledge");
        let memory = dir.join("AGENTS.md");
        let mut first = ImportReport::default();
        write_background(&vault, EXPORT_SUMMARY, &mut first);
        ensure_background_pointer(&memory, &mut first);
        let note_before = fs::read_to_string(vault.join(BACKGROUND_NOTE)).unwrap();
        let memory_before = fs::read_to_string(&memory).unwrap();

        let mut second = ImportReport::default();
        write_background(&vault, EXPORT_SUMMARY, &mut second);
        ensure_background_pointer(&memory, &mut second);
        assert_eq!(second.memory_written, 0, "{:?}", second.warnings);
        assert_eq!(second.background_note, None);
        assert_eq!(
            fs::read_to_string(vault.join(BACKGROUND_NOTE)).unwrap(),
            note_before
        );
        assert_eq!(fs::read_to_string(&memory).unwrap(), memory_before);
        assert_eq!(memory_before.matches(BACKGROUND_HEADING).count(), 1);
    }

    /// The note is the export's, so a newer export — or a hand edit — is
    /// replaced rather than left alone; the never-overwrite rule is for
    /// what the user wrote, and the header says so.
    #[test]
    fn the_background_note_is_written_once_and_his_edits_survive_a_reimport() {
        let dir = test_dir("import-background-keep");
        let vault = dir.join("knowledge");
        let mut report = ImportReport::default();
        write_background(&vault, "An older export.", &mut report);
        assert_eq!(report.memory_written, 1);
        fs::write(vault.join(BACKGROUND_NOTE), "edited by hand\n").unwrap();

        let mut again = ImportReport::default();
        write_background(&vault, "A newer export.", &mut again);
        assert_eq!(again.memory_written, 0);
        assert_eq!(again.warnings.len(), 1, "{:?}", again.warnings);
        assert!(again.warnings[0].contains("kept the existing note"));
        assert_eq!(
            fs::read_to_string(vault.join(BACKGROUND_NOTE)).unwrap(),
            "edited by hand\n"
        );
    }

    /// The instructions already in the file are the user's: the paragraph
    /// goes below them, byte for byte above, and a file that has it is not
    /// touched at all — wherever in the file it sits.
    #[test]
    fn the_pointer_is_appended_once_and_the_instructions_are_untouched() {
        let dir = test_dir("import-background-pointer");
        let memory = dir.join("AGENTS.md");
        let theirs =
            "## Standing instructions\n\nBe terse.\n\n**Other instructions**\n\n- No em dashes.";
        fs::write(&memory, theirs).unwrap();

        let mut report = ImportReport::default();
        ensure_background_pointer(&memory, &mut report);
        let text = fs::read_to_string(&memory).unwrap();
        assert_eq!(text, format!("{theirs}\n\n{BACKGROUND_POINTER}\n"));
        assert_eq!(report.memory_written, 1);
        // Replaced by a rename: nothing beside it.
        assert!(
            !fs::read_dir(&dir)
                .unwrap()
                .flatten()
                .any(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
        );

        // Already there, in the middle as the hand split put it: nothing.
        let split = format!(
            "## Standing instructions\n\nBe terse.\n\n{BACKGROUND_POINTER}\n\n\
             **Other instructions**\n\n- No em dashes.\n"
        );
        fs::write(&memory, &split).unwrap();
        let mut again = ImportReport::default();
        ensure_background_pointer(&memory, &mut again);
        assert_eq!(fs::read_to_string(&memory).unwrap(), split);
        assert_eq!(again.memory_written, 0);
        assert!(again.warnings.is_empty(), "{:?}", again.warnings);
    }

    /// A memory the old importer filled — the export's sections between the
    /// instructions — is not edited, but the sections are named on every
    /// run, since each of them is paid for on every turn.
    #[test]
    fn leftover_background_sections_are_named_not_removed() {
        let dir = test_dir("import-background-leftover");
        let memory = dir.join("AGENTS.md");
        fs::write(&memory, format!("{EXPORT_SUMMARY}\n")).unwrap();
        let mut report = ImportReport::default();
        ensure_background_pointer(&memory, &mut report);
        let text = fs::read_to_string(&memory).unwrap();
        assert!(text.starts_with(EXPORT_SUMMARY));
        assert!(text.ends_with(&format!("{BACKGROUND_POINTER}\n")));
        let warning = report
            .warnings
            .iter()
            .find(|w| w.contains("still carries the export's background sections"))
            .unwrap_or_else(|| panic!("{:?}", report.warnings));
        assert!(warning.contains(
            "**Work context**, **Personal context**, **Top of mind**, **Brief history**"
        ));
        assert!(warning.contains(BACKGROUND_NOTE));
    }

    #[test]
    fn export_headings_match_bold_and_hash_forms_only() {
        for line in [
            "**Work context**",
            "## Personal context",
            "# Top of mind",
            "  ### brief history  ",
            "__Work context__",
            "**Top of mind:**",
        ] {
            assert!(is_export_memory_heading(line), "{line:?}");
        }
        for line in [
            "Work context",
            "## Work context, spring quarter",
            "## Standing instructions",
            "**Other instructions**",
            "The work context is thin.",
            "",
            "##",
        ] {
            assert!(!is_export_memory_heading(line), "{line:?}");
        }
    }
}
