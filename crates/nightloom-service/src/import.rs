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
//! ## The export is the only way in
//!
//! There is no Projects API and no per-project export: the account-wide
//! privacy export (Settings → Privacy → Export Data, which arrives as a zip by
//! email) is the whole of the programmatic surface. It holds the projects and
//! the conversations, and this module reads both out of the zip directly,
//! because "unzip it first" is a step that goes wrong on a 400 MB archive and
//! buys nothing.
//!
//! The archive's own layout has moved twice and is not a contract. The
//! conversations have stayed one `conversations.json`, but the projects, which
//! used to be one `projects.json`, now ship as a `projects/` directory holding
//! one file per project. Reading only the single file meant a current export
//! parsed zero projects and filed every conversation as unfiled -- a silent,
//! total failure of the half of this feature that has a project in it, so the
//! reader takes either shape and concatenates the shards when the single file
//! is absent.
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

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde::de::DeserializeOwned;

use nightloom_core::{ContentBlock, Session, SessionEvent, Usage};

use crate::project::{Registry, read_note, write_note};

/// Bytes of one flattened tool *result* kept in the transcript.
///
/// Results are machine output — a web search returning forty pages of scraped
/// text is the ordinary case — and an import that carried them whole would
/// spend the window of every future turn in that session on them. Artifacts are
/// deliberately not capped by this: an artifact is the thing the user was
/// making, and truncating it would be throwing away the deliverable to save
/// space on the scaffolding.
const TOOL_RESULT_LIMIT: usize = 4096;

/// Longest folder name generated from a project title.
const SLUG_LIMIT: usize = 60;

/// Filenames looked for, at any depth, in a zip or a folder.
const CONVERSATIONS: &str = "conversations.json";
const PROJECTS: &str = "projects.json";
/// Directory the current export shards the projects into, one file each.
const PROJECTS_DIR: &str = "projects";

// ---------------------------------------------------------------------------
// The export's own shapes
// ---------------------------------------------------------------------------

/// A project as claude.ai exports it.
#[derive(Debug, Clone, Deserialize)]
pub struct ExportedProject {
    #[serde(default)]
    pub uuid: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// The project's custom instructions, under the name the export gives them.
    #[serde(default)]
    pub prompt_template: String,
    #[serde(default)]
    pub docs: Vec<ExportedDoc>,
}

/// One knowledge document attached to a project.
#[derive(Debug, Clone, Deserialize)]
pub struct ExportedDoc {
    #[serde(default)]
    pub filename: String,
    #[serde(default)]
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
    #[serde(default)]
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
    #[serde(default)]
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
    #[serde(default)]
    pub uuid: String,
    /// `"human"` or `"assistant"`.
    #[serde(default)]
    pub sender: String,
    /// The flat rendering, kept by the export alongside `content`. Used only
    /// when `content` is absent, which older exports do.
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub content: Vec<ExportedBlock>,
    #[serde(default)]
    pub created_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub index: Option<i64>,
    #[serde(default)]
    pub parent_message_uuid: Option<String>,
    #[serde(default)]
    pub attachments: Vec<ExportedAttachment>,
    #[serde(default)]
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
        #[serde(default)]
        text: String,
    },
    Thinking {
        #[serde(default)]
        thinking: String,
    },
    VoiceNote {
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        text: String,
    },
    ToolUse {
        #[serde(default)]
        name: String,
        #[serde(default)]
        input: serde_json::Value,
    },
    ToolResult {
        #[serde(default)]
        name: String,
        #[serde(default)]
        content: Vec<ToolResultPart>,
        #[serde(default)]
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
    #[serde(default)]
    pub file_name: String,
    #[serde(default)]
    pub file_type: String,
    #[serde(default)]
    pub extracted_content: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExportedFile {
    #[serde(default)]
    pub file_name: String,
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// A parsed export, and what could not be parsed.
#[derive(Debug, Default)]
pub struct Export {
    pub projects: Vec<ExportedProject>,
    pub conversations: Vec<ExportedConversation>,
    /// Records this build could not read. Counted rather than fatal.
    pub unreadable: usize,
    pub warnings: Vec<String>,
}

/// Read an export from the zip Anthropic emails, or from a folder it was
/// already unpacked into.
///
/// Both are accepted because both are what people have: the zip is what
/// arrives, and a folder is what is left after someone opened it to look. The
/// two `.json` files are found by basename at any depth, since the archive has
/// been shipped both flat and inside a dated directory.
pub fn read_export(path: &Path) -> Result<Export, String> {
    let mut files = if path.is_dir() {
        read_dir_files(path)?
    } else if path.is_file() {
        read_zip_files(path)?
    } else {
        return Err(format!("{} does not exist", path.display()));
    };
    // Neither a zip's entry order nor a directory listing is guaranteed, and
    // the shards decide the order the projects are imported in.
    files.project_shards.sort_by(|a, b| a.0.cmp(&b.0));

    if files.is_empty() {
        return Err(format!(
            "no {CONVERSATIONS}, {PROJECTS} or {PROJECTS_DIR}/ in {} — point this at \
             the zip Anthropic emailed you, or at a folder it was unpacked into",
            path.display()
        ));
    }

    let mut export = Export::default();
    match &files.projects {
        Some(raw) => export.projects = parse_array(raw, "projects", "project", &mut export),
        // The current export has no `projects.json` at all: concatenating the
        // shards is the whole of the difference, since one file holds what one
        // element of that array held. Only when it is absent, so an archive
        // carrying both is read the way it always was rather than having every
        // project counted twice.
        None => {
            for (label, raw) in &files.project_shards {
                let shard = parse_projects_shard(raw, label, &mut export);
                export.projects.extend(shard);
            }
        }
    }
    if let Some(raw) = &files.conversations {
        export.conversations = parse_array(raw, "conversations", "conversation", &mut export);
    }
    Ok(export)
}

/// The bytes an export was found to hold, before any of it is parsed.
///
/// A struct rather than a map keyed by filename because the shards are a list
/// and the other two are not, and a map would have to encode that in its keys.
#[derive(Debug, Default)]
struct ExportFiles {
    projects: Option<Vec<u8>>,
    conversations: Option<Vec<u8>>,
    /// `projects/<name>.json`, carrying its label for the warnings a bad one
    /// produces — "skipped a project" names nothing when there are ninety
    /// files it could have come from.
    project_shards: Vec<(String, Vec<u8>)>,
}

impl ExportFiles {
    fn is_empty(&self) -> bool {
        self.projects.is_none() && self.conversations.is_none() && self.project_shards.is_empty()
    }
}

fn read_dir_files(dir: &Path) -> Result<ExportFiles, String> {
    let mut out = ExportFiles::default();
    // Two levels: the archive ships flat or inside one dated directory, and a
    // deeper walk would start reading whatever else is in the folder someone
    // pointed at. `projects/` is a third level in the dated case, so it is
    // descended into by name wherever it turns up — the depth is carried per
    // directory rather than counted per pop, or a second directory beside the
    // dated one would push the budget past whichever was visited first.
    let mut stack = vec![(dir.to_path_buf(), 0usize)];
    while let Some((current, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };
        let sharded = current.file_name().and_then(|n| n.to_str()) == Some(PROJECTS_DIR);
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            if path.is_dir() {
                if depth < 1 || (depth < 2 && name == PROJECTS_DIR) {
                    stack.push((path.clone(), depth + 1));
                }
            } else if name == PROJECTS
                && let Ok(bytes) = fs::read(&path)
            {
                out.projects = Some(bytes);
            } else if name == CONVERSATIONS
                && let Ok(bytes) = fs::read(&path)
            {
                out.conversations = Some(bytes);
            } else if sharded
                && name.ends_with(".json")
                && let Ok(bytes) = fs::read(&path)
            {
                out.project_shards.push((shard_label(name), bytes));
            }
        }
    }
    Ok(out)
}

/// How a shard is named in a warning: enough to find the file, and nothing
/// that could be mistaken for a path this import will open.
fn shard_label(name: &str) -> String {
    format!("{PROJECTS_DIR}/{name}")
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
        // Matched on the last two segments and never written to disk, so the
        // entry name is read as a label rather than as a path. Owned before
        // the read, which needs the entry back mutably.
        let mut segments = entry.name().rsplit('/');
        let name = segments.next().unwrap_or_default().to_string();
        let parent = segments.next().unwrap_or_default().to_string();
        let sharded = parent == PROJECTS_DIR && name != PROJECTS && name.ends_with(".json");
        if !sharded && name != CONVERSATIONS && name != PROJECTS {
            continue;
        }
        let mut buf = Vec::new();
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("cannot read {name} out of the archive: {e}"))?;
        if sharded {
            out.project_shards.push((shard_label(&name), buf));
        } else if name == PROJECTS {
            out.projects = Some(buf);
        } else {
            out.conversations = Some(buf);
        }
    }
    Ok(out)
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

/// Parse one `projects/<name>.json`.
///
/// A shard holds the project object itself, which is what one element of
/// `projects.json` was. An array is read too, since the shards are being
/// concatenated anyway and a file holding two costs nothing to accept, and so
/// are the wrapper shapes the single file ships in — read as a project,
/// `{"projects": [...]}` would parse into one with every field defaulted,
/// which imports as a nameless empty project rather than as nothing.
fn parse_projects_shard(raw: &[u8], label: &str, export: &mut Export) -> Vec<ExportedProject> {
    let value: serde_json::Value = match serde_json::from_slice(raw) {
        Ok(v) => v,
        Err(e) => {
            export.warnings.push(format!("{label} is not JSON: {e}"));
            return Vec::new();
        }
    };
    match value {
        serde_json::Value::Array(items) => parse_items(items, "project", export),
        serde_json::Value::Object(mut map) => {
            let wrapper = ["projects", "data"]
                .into_iter()
                .find(|key| matches!(map.get(*key), Some(serde_json::Value::Array(_))));
            match wrapper.and_then(|key| map.remove(key)) {
                Some(serde_json::Value::Array(items)) => parse_items(items, "project", export),
                _ => parse_items(vec![serde_json::Value::Object(map)], "project", export),
            }
        }
        _ => {
            export.warnings.push(format!("{label} holds no project"));
            Vec::new()
        }
    }
}

/// The element-wise half both readers share: what could not be read is counted
/// and named, and the rest of the file still arrives.
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
}

impl ImportReport {
    pub fn imported(&self) -> usize {
        self.projects.iter().map(|p| p.imported).sum()
    }

    pub fn already(&self) -> usize {
        self.projects.iter().map(|p| p.already).sum()
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
        "claude:unfiled".to_string()
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
fn unique_slug(name: &str, uuid: &str, taken: &mut HashSet<String>) -> String {
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
        if slug.chars().count() >= SLUG_LIMIT {
            break;
        }
    }
    let slug = slug.trim_matches('-').to_string();
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

    /// The export stopped shipping `projects.json` and started shipping a
    /// `projects/` directory with one file per project. Reading only the
    /// single file parsed zero projects, so every conversation in the archive
    /// came back unfiled — the whole of the feature failing quietly.
    #[test]
    fn a_projects_directory_stands_in_for_projects_json() {
        let dir = test_dir("import-src-sharded");
        let shards = dir.join(PROJECTS_DIR);
        fs::create_dir_all(&shards).unwrap();
        // One project per file, as the export writes them, and the object
        // itself rather than an array of one.
        for project in one_project().as_array().unwrap() {
            let uuid = project["uuid"].as_str().unwrap();
            fs::write(
                shards.join(format!("{uuid}.json")),
                serde_json::to_vec_pretty(project).unwrap(),
            )
            .unwrap();
        }
        fs::write(
            shards.join("p-2.json"),
            serde_json::to_vec_pretty(&json!({
                "uuid": "p-2",
                "name": "Second Project",
                "prompt_template": "Be brief.",
            }))
            .unwrap(),
        )
        .unwrap();
        fs::write(
            dir.join(CONVERSATIONS),
            serde_json::to_vec_pretty(&json!([{
                "uuid": "c-1",
                "name": "Sharded",
                "project_uuid": "p-1",
                "created_at": "2025-03-04T05:06:07Z",
                "chat_messages": [message("m-1", "human", "hello")],
            }]))
            .unwrap(),
        )
        .unwrap();

        let export = read_export(&dir).unwrap();
        assert_eq!(export.projects.len(), 2);
        // Sorted by shard name, so two runs of one archive agree.
        assert_eq!(export.projects[0].uuid, "p-1");
        assert_eq!(export.projects[1].uuid, "p-2");
        assert_eq!(export.conversations.len(), 1);

        let into = test_dir("import-sharded-out");
        let report = run(&export, &into);
        assert_eq!(report.unfiled, 0, "{:?}", report.warnings);
        assert_eq!(report.imported(), 1);
        let thesis = report
            .projects
            .iter()
            .find(|p| p.name == "Thesis Research")
            .expect("the sharded project");
        assert_eq!(thesis.imported, 1);
        assert_eq!(thesis.notes, 2);
        assert!(thesis.instructions);
    }

    /// An archive carrying both is read the way it always was: the shards are
    /// a fallback, not a second source, or every project in it would be
    /// imported twice.
    #[test]
    fn projects_json_wins_over_a_projects_directory() {
        let dir = test_dir("import-src-both");
        fs::write(
            dir.join(PROJECTS),
            serde_json::to_vec_pretty(&one_project()).unwrap(),
        )
        .unwrap();
        let shards = dir.join(PROJECTS_DIR);
        fs::create_dir_all(&shards).unwrap();
        fs::write(
            shards.join("p-1.json"),
            serde_json::to_vec_pretty(&one_project()[0]).unwrap(),
        )
        .unwrap();
        fs::write(dir.join(CONVERSATIONS), b"[]").unwrap();

        let export = read_export(&dir).unwrap();
        assert_eq!(export.projects.len(), 1);
    }

    /// Nested inside the dated directory, which is where the shards actually
    /// sit — one level deeper than the walk used to reach.
    #[test]
    fn sharded_projects_are_read_out_of_a_nested_zip() {
        use std::io::Write as _;

        let dir = test_dir("import-zip-sharded");
        let path = dir.join("data.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        zip.start_file("data-2025-03-04/projects/p-1.json", options)
            .unwrap();
        zip.write_all(&serde_json::to_vec(&one_project()[0]).unwrap())
            .unwrap();
        zip.start_file("data-2025-03-04/conversations.json", options)
            .unwrap();
        zip.write_all(
            &serde_json::to_vec(&json!([{
                "uuid": "c-1",
                "name": "From a sharded zip",
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
        assert_eq!(export.projects[0].name, "Thesis Research");

        let into = test_dir("import-zip-sharded-out");
        let report = run(&export, &into);
        assert_eq!(report.unfiled, 0);
        assert_eq!(report.imported(), 1);
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
}
