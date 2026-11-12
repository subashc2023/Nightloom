//! Notes commands: the two note stores, proposals and the knowledge folder (moved from main.rs, item 642).

#[allow(unused_imports)]
use crate::*;

/// Which of the two note stores a command means.
///
/// One parameter rather than four more commands, because the four operations
/// are identical — [`project::list_notes`] and its siblings already take the
/// directory, so both stores are the same code with a different path. What
/// differs is only which folder, and which of the two can be missing.
///
/// An unrecognized value is an error rather than a default. The two stores
/// hold different things, and a typo that quietly wrote a personal note into
/// somebody's repository is exactly the failure the split exists to prevent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum NoteScope {
    /// `<workspace>/.agents` — about the code, and only while a project is
    /// open.
    Project,
    /// The user's vault — about them, and available with no project at all.
    Knowledge,
    /// `<workspace>/AGENTS.md` — the project's standing instructions, read
    /// whole into every chat's preamble. One fixed file, never a listing:
    /// the scope exists so the same editor reaches it, not so the workspace
    /// root reads as a notes folder.
    Instructions,
    /// `~/.nightloom/AGENTS.md` — user memory, how the model should behave
    /// everywhere. Same shape as `Instructions`: one file, no listing.
    Memory,
    /// `~/.nightloom/models/` — one file per model id, read whole into the
    /// preamble of a chat on that model and no other (nightshift backlog
    /// 044). A folder like the two stores, so it lists and deletes, but its
    /// names are model ids and not titles: `<id>.md`, with a `/` in the id
    /// written `__` (`prompt::model_instruction_file` is the one place that
    /// rule lives). Reads answer a missing file with empty text, as the
    /// fixed-file scopes do, so the editor can open on a model that has no
    /// file yet.
    Models,
    /// `~/.nightloom/CHAT.md` — how a *Chat* talks (nightshift backlog
    /// 102, 2026-09-16), read whole into the preamble of a chat of that
    /// kind and no Build chat's. Same shape as `Memory`: one file, no
    /// listing, emptied rather than deleted.
    Chat,
}

impl NoteScope {
    /// The scopes that name one fixed file rather than a folder of notes.
    /// Listing them is meaningless and deleting them is a loss the
    /// never-lose-work rule forbids: the reversible form is emptying the
    /// text, which `save_note` already does.
    fn is_fixed_file(self) -> bool {
        self.fixed_name().is_some()
    }

    /// The one file a fixed-file scope names; `None` for a folder scope.
    fn fixed_name(self) -> Option<&'static str> {
        match self {
            Self::Instructions | Self::Memory => Some(AGENTS_MD),
            Self::Chat => Some(CHAT_MD),
            Self::Project | Self::Knowledge | Self::Models => None,
        }
    }
}

/// The one file the instructions and memory scopes name.
pub(crate) const AGENTS_MD: &str = "AGENTS.md";
/// The one file the `chat` scope names (`prompt::chat_instruction_path`).
pub(crate) const CHAT_MD: &str = "CHAT.md";

impl Default for NoteScope {
    /// What a frontend that predates the vault meant by every note call.
    fn default() -> Self {
        Self::Project
    }
}

/// The directory a scope names, or an error saying why there isn't one.
///
/// Every note command needs this and none of them should guess. The two
/// failures are genuinely different and each says so: a project scope with no
/// project open is a state the user can fix by opening one, and a knowledge
/// scope with no config directory is a machine with no home to keep a vault
/// in.
pub(crate) async fn scope_dir(state: &AppState, scope: NoteScope) -> Result<PathBuf, String> {
    scope_dir_in(state, scope, None).await
}

/// [`scope_dir`] for a named project (item 300 B1: the phone names the
/// project on its screen, so a note is never written into the window's open
/// project while he looks at another). `None` is the open project;
/// `unfiled` is No project; an id the registry does not know is refused
/// rather than read as the open one — for the scopes that live in a
/// project only, so a forgotten project leaves the Vault, Memory and models
/// tabs working (300 review 3).
pub(crate) async fn scope_dir_in(
    state: &AppState,
    scope: NoteScope,
    project: Option<&str>,
) -> Result<PathBuf, String> {
    let named = match project {
        None => NamedProject::Open,
        Some(nightloom_service::serve::NO_PROJECT_ID) => NamedProject::Named(None),
        Some(id) => {
            let projects = state.workspaces.lock().await.registry.projects();
            named_project(projects, id)
        }
    };
    let project_of = async || match &named {
        NamedProject::Open => Ok(state.active().await),
        NamedProject::Named(p) => Ok(p.clone()),
        NamedProject::Missing(id) => Err(format!("no project {id}")),
    };
    match scope {
        NoteScope::Project => project_of()
            .await?
            .map(|p| p.notes_dir())
            .ok_or_else(|| "no project is open, so there is no shared notes folder".to_string()),
        NoteScope::Knowledge => nightloom_service::knowledge::vault_dir()
            .ok_or_else(|| "no user config directory to keep a knowledge base in".to_string()),
        NoteScope::Instructions => project_of()
            .await?
            .map(|p| p.workspace_dir())
            .ok_or_else(|| "no project is open, so there are no project instructions".to_string()),
        NoteScope::Memory => project::config_dir()
            .ok_or_else(|| "no user config directory to keep user memory in".to_string()),
        NoteScope::Models => nightloom_service::prompt::model_instructions_dir()
            .ok_or_else(|| "no user config directory to keep model instructions in".to_string()),
        NoteScope::Chat => project::config_dir()
            .ok_or_else(|| "no user config directory to keep the Chat instructions in".to_string()),
    }
}

/// The project a note call's `?project=` names (item 300 B1, review 3).
pub(crate) enum NamedProject {
    /// None named: the window's open project.
    Open,
    /// This project, or No project (`unfiled`).
    Named(Option<project::Project>),
    /// An id the registry does not know (forgotten while the phone's Notes
    /// were open): refused by the project scopes only.
    Missing(String),
}

/// `id` looked up among the registered `projects`.
pub(crate) fn named_project(projects: Vec<project::Project>, id: &str) -> NamedProject {
    match projects.into_iter().find(|p| p.id == id) {
        Some(p) => NamedProject::Named(Some(p)),
        None => NamedProject::Missing(id.to_string()),
    }
}

/// The fixed-file scopes accept exactly one name. Anything else is a caller
/// bug, and answering it with a file in the workspace root would turn the
/// instructions scope into a second, unindexed docspace.
pub(crate) fn check_fixed_name(scope: NoteScope, name: &str) -> Result<(), String> {
    if let Some(fixed) = scope.fixed_name()
        && name.trim() != fixed
    {
        return Err(format!("{scope:?} names only {fixed}, not {name}"));
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn list_notes(
    state: State<'_, AppState>,
    scope: Option<NoteScope>,
    project: Option<String>,
) -> Result<Vec<Note>, String> {
    let scope = scope.unwrap_or_default();
    if scope.is_fixed_file() {
        return Err(format!("{scope:?} is one file, not a folder to list"));
    }
    // The panel's listing, not the system prompt's (item 457): every note
    // is reachable from the Notes panel and the phone's Notes, where the
    // index's 200 used to cut the list mid-walk with nothing said.
    Ok(project::list_note_tree(&scope_dir_in(&state, scope, project.as_deref()).await?).notes)
}

/// The docspace as a tree for the Notes panel (item 457): every note, every
/// folder (empty ones too), and whether the walk saw everything.
#[tauri::command]
pub(crate) async fn list_note_tree(
    state: State<'_, AppState>,
    scope: Option<NoteScope>,
    project: Option<String>,
) -> Result<project::NoteTree, String> {
    let scope = scope.unwrap_or_default();
    if scope.is_fixed_file() {
        return Err(format!("{scope:?} is one file, not a folder to list"));
    }
    Ok(project::list_note_tree(
        &scope_dir_in(&state, scope, project.as_deref()).await?,
    ))
}

/// Move or rename a note or a folder of notes (item 457); the new name.
#[tauri::command]
pub(crate) async fn move_note(
    state: State<'_, AppState>,
    scope: Option<NoteScope>,
    from: String,
    to: String,
    project: Option<String>,
) -> Result<String, String> {
    let scope = scope.unwrap_or_default();
    if scope.is_fixed_file() {
        return Err(format!("{scope:?} is one file; it is not moved from here"));
    }
    project::move_note(
        &scope_dir_in(&state, scope, project.as_deref()).await?,
        &from,
        &to,
    )
}

/// Make a folder among the notes (item 457's New folder).
#[tauri::command]
pub(crate) async fn new_note_folder(
    state: State<'_, AppState>,
    scope: Option<NoteScope>,
    name: String,
    project: Option<String>,
) -> Result<String, String> {
    let scope = scope.unwrap_or_default();
    if scope.is_fixed_file() {
        return Err(format!("{scope:?} is one file, not a folder"));
    }
    project::make_note_folder(
        &scope_dir_in(&state, scope, project.as_deref()).await?,
        &name,
    )
}

#[tauri::command]
pub(crate) async fn read_note(
    state: State<'_, AppState>,
    scope: Option<NoteScope>,
    name: String,
    project: Option<String>,
) -> Result<String, String> {
    let scope = scope.unwrap_or_default();
    check_fixed_name(scope, &name)?;
    let dir = scope_dir_in(&state, scope, project.as_deref()).await?;
    // A fixed file that does not exist yet is an empty one, not an error:
    // the editor opens on it so the user can write the first line. A model's
    // file is the same case — "+ add for this model" opens the editor on a
    // name nothing has written yet.
    if let Some(fixed) = scope.fixed_name()
        && !dir.join(fixed).is_file()
    {
        return Ok(String::new());
    }
    if scope == NoteScope::Models && !dir.join(name.trim()).is_file() {
        return Ok(String::new());
    }
    project::read_note(&dir, &name)
}

/// A note that is not text (nightshift backlog 307), as the file tab draws
/// it: an image or a PDF with its bytes, anything else as `other` with its
/// size, for Open and Reveal. `None` for text, which `read_note` reads. The
/// note editor asks this first: a `.pdf` dropped in a project's `files/`
/// read as a string failed with "stream did not contain valid UTF-8".
#[tauri::command]
pub(crate) async fn read_note_media(
    state: State<'_, AppState>,
    scope: Option<NoteScope>,
    name: String,
    project: Option<String>,
) -> Result<Option<filetab::FileTab>, String> {
    use std::io::Read;
    let scope = scope.unwrap_or_default();
    if scope.fixed_name().is_some() || scope == NoteScope::Models {
        // Instruction files are text by definition; a missing one is empty.
        return Ok(None);
    }
    let dir = scope_dir_in(&state, scope, project.as_deref()).await?;
    let path = project::note_file(&dir, &name)?;
    let mut head = vec![0u8; 512];
    let read = match std::fs::File::open(&path).and_then(|mut f| f.read(&mut head)) {
        Ok(n) => n,
        // Missing or unreadable: `read_note` gives the error in its words.
        Err(_) => return Ok(None),
    };
    if project::binary_kind(&path, &head[..read]).is_none() {
        return Ok(None);
    }
    filetab::read_not_text(&path).map(Some)
}

/// Where a `memory_where` hit opens (nightshift backlog 296): the note
/// editor's scope and name, or `None` for a memory file the editor does not
/// reach, which the reply opens as a file instead.
#[tauri::command]
pub(crate) async fn memory_note_for(
    state: State<'_, AppState>,
    path: PathBuf,
) -> Result<Option<(String, String)>, String> {
    let workspace = state.active().await.map(|p| p.workspace_dir());
    let config = project::config_dir();
    let vault = nightloom_service::knowledge::vault_dir();
    Ok(nightloom_service::memory_where::note_for(
        &path,
        config.as_deref(),
        workspace.as_deref(),
        vault.as_deref(),
    )
    .map(|(scope, name)| (scope.to_string(), name)))
}

/// *Strike* on a `memory_where` hit (backlog 296): supersede line `line` of
/// `path` with today's date — never delete it — provided it still reads as
/// `text`. Only a file the memory walk names for the open project: the path
/// came from a tool result, and a strike is a write.
#[tauri::command]
pub(crate) async fn memory_strike(
    state: State<'_, AppState>,
    path: PathBuf,
    line: usize,
    text: String,
) -> Result<String, String> {
    use nightloom_service::memory_where as mw;
    let config = project::config_dir().ok_or("no user config directory")?;
    let workspace = state.active().await.map(|p| p.workspace_dir());
    let roots = mw::MemoryRoots::discover(&config, workspace);
    tokio::task::spawn_blocking(move || {
        if !roots.owns(&path) {
            return Err(format!(
                "{} is not one of this chat's memory files, so Nightloom will not write to it",
                path.display()
            ));
        }
        mw::strike_line(&path, line, &text, chrono::Local::now().date_naive())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write a note. Also how a new one is created — there is no separate
/// "create", because a note is a file and an empty one is a real note.
#[tauri::command]
pub(crate) async fn save_note(
    state: State<'_, AppState>,
    scope: Option<NoteScope>,
    name: String,
    content: String,
    project: Option<String>,
) -> Result<Note, String> {
    let scope = scope.unwrap_or_default();
    check_fixed_name(scope, &name)?;
    project::write_note(
        &scope_dir_in(&state, scope, project.as_deref()).await?,
        &name,
        &content,
    )
}

#[tauri::command]
pub(crate) async fn delete_note(
    state: State<'_, AppState>,
    scope: Option<NoteScope>,
    name: String,
    project: Option<String>,
) -> Result<String, String> {
    let scope = scope.unwrap_or_default();
    if let Some(fixed) = scope.fixed_name() {
        return Err(format!(
            "{fixed} is not deleted from here — empty it instead"
        ));
    }
    // To the docspace's trash since item 457, not unlinked. Item 471: the
    // answer is where it went inside the trash, so its drafts can follow.
    let dir = scope_dir_in(&state, scope, project.as_deref()).await?;
    project::delete_note(&dir, &name).map(|to| project::trash_name(&dir, &to))
}

/// Item 471: unsaved drafts into the notes trash, beside their deleted
/// notes (or alone, for a draft with no note left); the names written.
#[tauri::command]
pub(crate) async fn trash_note_drafts(
    state: State<'_, AppState>,
    scope: Option<NoteScope>,
    drafts: Vec<(String, String)>,
    project: Option<String>,
) -> Result<Vec<String>, String> {
    let scope = scope.unwrap_or_default();
    if scope.is_fixed_file() {
        return Err(format!("{scope:?} is one file; it has no trash"));
    }
    project::trash_note_drafts(
        &scope_dir_in(&state, scope, project.as_deref()).await?,
        &drafts,
    )
}

// ---- proposals: the dream's suggested edits to the fixed files ------------

/// The store a fixed-file scope's proposals sit beside: the active project's
/// directory under `~/.nightloom/projects/` for `instructions`, the config
/// dir for `memory`. Only those two scopes have proposals — the dream may
/// suggest a change to an always-loaded file and to nothing else — so any
/// other scope is a caller bug and says so.
pub(crate) async fn proposal_store(state: &AppState, scope: NoteScope) -> Result<PathBuf, String> {
    match scope {
        NoteScope::Instructions => state.active().await.map(|p| p.store_dir()).ok_or_else(|| {
            "no project is open, so there are no proposals for its instructions".to_string()
        }),
        NoteScope::Memory => project::config_dir()
            .ok_or_else(|| "no user config directory to keep proposals in".to_string()),
        other => Err(format!(
            "{other:?} has no proposals — only instructions and memory do"
        )),
    }
}

/// Pending proposals for a fixed file, newest first — the badge on the
/// pinned row, and the one the review opens on. Cheap (a directory of small
/// files), so the frontend asks whenever it re-lists the notes.
#[tauri::command]
pub(crate) async fn list_proposals(
    state: State<'_, AppState>,
    scope: NoteScope,
) -> Result<Vec<nightloom_service::proposal::Entry>, String> {
    let store = proposal_store(&state, scope).await?;
    blocking(move || Ok::<_, String>(nightloom_service::proposal::list_in(&store))).await
}

#[tauri::command]
pub(crate) async fn read_proposal(
    state: State<'_, AppState>,
    scope: NoteScope,
    id: String,
) -> Result<nightloom_service::proposal::Proposal, String> {
    let store = proposal_store(&state, scope).await?;
    blocking(move || nightloom_service::proposal::read(&store, &id)).await
}

/// Move a proposal aside as turned down. The frontend confirms first — a
/// dismissed proposal leaves the badge, which is the closest thing here to
/// losing work — and the file is kept under `proposals/dismissed/`.
#[tauri::command]
pub(crate) async fn dismiss_proposal(
    state: State<'_, AppState>,
    scope: NoteScope,
    id: String,
) -> Result<(), String> {
    let store = proposal_store(&state, scope).await?;
    blocking(move || nightloom_service::proposal::dismiss(&store, &id).map(|_| ())).await
}

/// Record that a proposal was applied: called by the frontend *after* its
/// ordinary `save_note` of the draft succeeded, with the text it saved. The
/// proposal moves under `proposals/applied/` carrying a hash of that text.
/// Nothing here writes the fixed file — the save that did was the user's,
/// through the editor, which is the design.
#[tauri::command]
pub(crate) async fn mark_applied(
    state: State<'_, AppState>,
    scope: NoteScope,
    id: String,
    text: String,
) -> Result<(), String> {
    let store = proposal_store(&state, scope).await?;
    blocking(move || nightloom_service::proposal::applied(&store, &id, &text).map(|_| ())).await
}

// ---- the knowledge vault -----------------------------------------------

/// Where the vault is and what is in it.
#[derive(Serialize, Clone)]
pub(crate) struct KnowledgeInfo {
    dir: String,
    /// How the model addresses it, so the UI can show the same string the
    /// prompt does rather than inventing its own name for it.
    alias: String,
    notes: usize,
    /// Whether it sits where it would with nothing configured. What a "Reset
    /// to default" control switches off, and worth showing regardless: a vault
    /// pointing somewhere forgotten looks identical to an empty one.
    pub(crate) is_default: bool,
    /// False until the first note is written. Not an error — the docspace is
    /// created the same way, and a vault nobody has written in yet is the
    /// ordinary state of a new install.
    exists: bool,
}

impl KnowledgeInfo {
    pub(crate) fn of(dir: PathBuf, is_default: bool) -> Self {
        Self {
            notes: project::list_notes(&dir).len(),
            exists: dir.is_dir(),
            alias: nightloom_service::tools::VAULT_ALIAS.to_string(),
            is_default,
            dir: dir.to_string_lossy().into_owned(),
        }
    }

    /// `None` on a machine with no config directory, which reads as "no
    /// vault" the same way it reads as "no user memory".
    pub(crate) fn current() -> Option<Self> {
        let config = project::config_dir()?;
        Some(Self::of(
            nightloom_service::knowledge::vault_dir_in(&config),
            nightloom_service::knowledge::is_default_location_in(&config),
        ))
    }
}

#[tauri::command]
pub(crate) async fn knowledge_info() -> Result<Option<KnowledgeInfo>, String> {
    // 86 s as the window saw it once (item 220): its own line, to tell the
    // read from the wait before it.
    startup_log::timed("knowledge_info", async { Ok(KnowledgeInfo::current()) }).await
}

/// Where the per-model instruction files live, so the editor's Folder button
/// can show it; `None` on a machine with no user config directory.
#[tauri::command]
pub(crate) fn model_instructions_dir() -> Option<String> {
    nightloom_service::prompt::model_instructions_dir().map(|d| d.display().to_string())
}

/// Where the Chat instructions live (`~/.nightloom/CHAT.md`, nightshift
/// backlog 102), so Settings can name the file; `None` on a machine with no
/// user config directory.
#[tauri::command]
pub(crate) fn chat_instructions_path() -> Option<String> {
    nightloom_service::prompt::chat_instruction_path().map(|p| p.display().to_string())
}

/// Point the vault at a folder, or back at the default with `None`.
///
/// **Moves nothing.** Both directories are left exactly as they are, which is
/// what makes an existing Obsidian vault usable as-is — and what stops a
/// changed setting from relocating somebody's notes.
#[tauri::command]
pub(crate) async fn set_knowledge_dir(
    dir: Option<String>,
) -> Result<Option<KnowledgeInfo>, String> {
    let chosen = dir.map(PathBuf::from).filter(|d| !d.as_os_str().is_empty());
    if let Some(dir) = &chosen {
        // A folder the user picked through a dialog exists; one typed into the
        // field may not, and creating it is friendlier than refusing a path
        // that is only a moment from being right.
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    nightloom_service::knowledge::set_vault_dir(chosen.as_deref())?;
    Ok(KnowledgeInfo::current())
}

/// The vault as notes and the links between them.
///
/// Built on a blocking thread: it reads every note in the vault, which is file
/// I/O over a folder that may hold years of them, and the runtime it would
/// otherwise sit on is the one carrying the window's events.
#[tauri::command]
pub(crate) async fn knowledge_graph() -> Result<nightloom_service::LinkGraph, String> {
    let dir = nightloom_service::knowledge::vault_dir()
        .ok_or_else(|| "no user config directory to keep a knowledge base in".to_string())?;
    tauri::async_runtime::spawn_blocking(move || nightloom_service::LinkGraph::build(&dir))
        .await
        .map_err(|e| format!("cannot read the knowledge base: {e}"))
}
