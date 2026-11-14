//! Project commands: the registry, the projects folder, import and CLAUDE.md offers (moved from main.rs, item 642).

#[allow(unused_imports)]
use crate::*;

/// Ask the OS for a folder. `None` when the user cancelled.
///
/// Driven from Rust rather than from the frontend so the app needs no dialog
/// permission in its capability set and no matching npm package: the only
/// thing the webview can do here is ask, and the only thing it gets back is a
/// path the user chose themselves.
#[tauri::command]
pub(crate) async fn pick_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    title: Option<String>,
    start_at: Option<String>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    // The caller's starting point wins when it gave one — picking a knowledge
    // folder should open near the current vault, not near the project.
    let start = match start_at.map(PathBuf::from) {
        Some(dir) => Some(dir),
        None => match state.active().await {
            Some(project) => project.workspace,
            None => project::config_dir().map(|d| d.parent().unwrap_or(&d).to_path_buf()),
        },
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut builder = app
        .dialog()
        .file()
        .set_title(title.as_deref().unwrap_or("Choose a project folder"));
    if let Some(start) = start.filter(|p| p.is_dir()) {
        builder = builder.set_directory(start);
    }
    builder.pick_folder(move |picked| {
        let _ = tx.send(picked);
    });
    Ok(rx
        .await
        .ok()
        .flatten()
        .and_then(|p| p.into_path().ok())
        .map(|p| project::normalize(&p).to_string_lossy().into_owned()))
}

#[tauri::command]
pub(crate) async fn list_projects(state: State<'_, AppState>) -> Result<Vec<ProjectInfo>, String> {
    // The first thing the launch shows (item 220): its line in the startup log.
    startup_log::timed("list_projects", async {
        // ~~Counted under the workspaces lock, one project after another~~
        // (item 220, measured 2026-09-26: 250 ms to 4.3 s for 19 projects,
        // each `ProjectInfo::of` reading its notes and statting its folder,
        // with every command that needs the lock — the reopen among them —
        // waiting behind it). The list is copied out under the lock; the
        // disk is read outside it, one thread per project.
        let projects = state.workspaces.lock().await.registry.projects();
        tokio::task::spawn_blocking(move || project_infos(&projects))
            .await
            .map_err(|e| format!("listing projects: {e}"))
    })
    .await
}

/// `ProjectInfo::of` for each project, together, in the list's order.
pub(crate) fn project_infos(projects: &[Project]) -> Vec<ProjectInfo> {
    std::thread::scope(|s| {
        let handles: Vec<_> = projects
            .iter()
            .map(|p| s.spawn(move || ProjectInfo::of(p)))
            .collect();
        handles
            .into_iter()
            .zip(projects)
            .map(|(h, p)| h.join().unwrap_or_else(|_| ProjectInfo::of(p)))
            .collect()
    })
}

#[tauri::command]
pub(crate) async fn active_project(
    state: State<'_, AppState>,
) -> Result<Option<ProjectInfo>, String> {
    Ok(state.active().await.as_ref().map(ProjectInfo::of))
}

/// Register a folder as a project. Idempotent: the same folder is the same
/// project, so this doubles as "open the one I already have".
/// One project an import produced.
#[derive(Serialize)]
pub(crate) struct ImportedProject {
    name: String,
    root: String,
    chats: usize,
    already: usize,
    notes: usize,
    warnings: Vec<String>,
}

#[derive(Serialize)]
pub(crate) struct ImportSummary {
    projects: Vec<ImportedProject>,
    unfiled: usize,
    unreadable: usize,
    summary: String,
    warnings: Vec<String>,
    /// Projects whose memory summary was too long for `AGENTS.md`, with the
    /// size: their `AGENTS.md` points at the full text and owes a short one.
    needs_condensing: Vec<(String, usize)>,
}

/// Choose the claude.ai export archive.
///
/// Driven from Rust for the same reason [`pick_folder`] is: the webview needs
/// no filesystem permission in its capability set, and it gets back a path the
/// user chose rather than one it asked for.
#[tauri::command]
pub(crate) async fn pick_export(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Choose your claude.ai export")
        .add_filter("Claude export", &["zip"])
        .pick_file(move |picked| {
            let _ = tx.send(picked);
        });
    Ok(rx
        .await
        .ok()
        .flatten()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned()))
}

/// Import a claude.ai export and register what it produced.
///
/// On a blocking thread because it is file I/O over an archive that is
/// routinely hundreds of megabytes, and the runtime it would otherwise sit on
/// is the one carrying the window's events.
///
/// The import owns the registry for the duration, which is not a convenience:
/// a project's id decides where its chats are written, so nothing can be
/// written before the project exists. It also means a second import adds the
/// chats you have had since rather than a second copy of every project.
///
/// `into` is optional. Without it the imported projects have no folder, which
/// is what a claude.ai project actually is.
#[tauri::command]
pub(crate) async fn import_claude(
    state: State<'_, AppState>,
    export: String,
    into: Option<String>,
    unfiled: bool,
) -> Result<ImportSummary, String> {
    let destination = into.filter(|s| !s.trim().is_empty()).map(PathBuf::from);
    // The registry is taken across the blocking hop and put back, rather than
    // the lock being held over it: this is minutes of file I/O on a big
    // archive, and every project command would be stuck behind it.
    let mut registry = { state.workspaces.lock().await.registry.clone() };
    let (report, registry) = tokio::task::spawn_blocking(move || {
        let export = import::read_export(Path::new(&export))?;
        let mut options = import::ImportOptions::new();
        options.into = destination;
        options.unfiled = unfiled;
        let report = import::import(&export, &options, &mut registry)?;
        Ok::<_, String>((report, registry))
    })
    .await
    .map_err(|e| format!("the import did not finish: {e}"))??;

    let mut guard = state.workspaces.lock().await;
    guard.registry = registry;
    let mut projects = Vec::new();
    for outcome in &report.projects {
        projects.push(ImportedProject {
            name: outcome.name.clone(),
            root: outcome
                .root
                .as_ref()
                .map(|r| r.to_string_lossy().into_owned())
                .unwrap_or_default(),
            chats: outcome.imported,
            already: outcome.already,
            notes: outcome.notes,
            warnings: outcome.warnings.clone(),
        });
    }

    Ok(ImportSummary {
        summary: report.summary(),
        projects,
        unfiled: report.unfiled,
        unreadable: report.unreadable,
        warnings: report.warnings.clone(),
        needs_condensing: report.needs_condensing.clone(),
    })
}

#[tauri::command]
pub(crate) async fn create_project(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    name: Option<String>,
) -> Result<ProjectInfo, String> {
    let mut guard = state.workspaces.lock().await;
    let project = guard.registry.add(PathBuf::from(path), name)?;
    announce_migration(&app, &project);
    Ok(ProjectInfo::of(&project))
}

// ---- the New project form and the projects folder ------------------------

/// Where new projects go: the folder, whether it is the default, and
/// whether it exists yet — the shape of [`KnowledgeInfo`], for the Settings
/// pane beside the vault's.
#[derive(Serialize, Clone)]
pub(crate) struct ProjectsFolderInfo {
    dir: String,
    /// Whether it is where new projects would go with nothing configured.
    /// What Reset to default switches off.
    is_default: bool,
    /// False until the first project is created there. Not an error: the
    /// form's Create makes it along with the project's own folder.
    exists: bool,
}

impl ProjectsFolderInfo {
    /// `None` on a machine with no config directory.
    fn current(registry: &Registry) -> Option<Self> {
        let config = project::config_dir()?;
        let dir = project::projects_folder_at(&config, registry);
        Some(Self {
            exists: dir.is_dir(),
            is_default: project::is_default_projects_folder_in(&config),
            dir: dir.to_string_lossy().into_owned(),
        })
    }
}

#[tauri::command]
pub(crate) async fn projects_folder_info(
    state: State<'_, AppState>,
) -> Result<Option<ProjectsFolderInfo>, String> {
    let guard = state.workspaces.lock().await;
    Ok(ProjectsFolderInfo::current(&guard.registry))
}

/// Point new projects at a folder, or back at the default with `None`.
///
/// **Moves nothing.** The projects already made are registered by their own
/// paths and stay where they are; this only decides where the next one goes.
#[tauri::command]
pub(crate) async fn set_projects_folder(
    state: State<'_, AppState>,
    dir: Option<String>,
) -> Result<Option<ProjectsFolderInfo>, String> {
    let chosen = dir.map(PathBuf::from).filter(|d| !d.as_os_str().is_empty());
    if let Some(dir) = &chosen {
        // As the vault's setting does: a picked folder exists, a typed one
        // may not, and making it beats refusing a path a moment from right.
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    project::set_projects_folder(chosen.as_deref())?;
    let guard = state.workspaces.lock().await;
    Ok(ProjectsFolderInfo::current(&guard.registry))
}

/// What the form shows as the folder row while the name is typed.
#[derive(Serialize)]
pub(crate) struct NewProjectPathInfo {
    /// `<projects folder>/<slug>`; empty when the slug is.
    path: String,
    /// Empty when the name has no letter or digit — the form disables
    /// Create and says so.
    slug: String,
    /// The projects folder the path sits under.
    folder: String,
}

/// The folder a name would get: computed here, by the same rule Create
/// uses, so the preview and the folder cannot disagree.
#[tauri::command]
pub(crate) async fn resolve_new_project_path(
    state: State<'_, AppState>,
    name: String,
) -> Result<NewProjectPathInfo, String> {
    let guard = state.workspaces.lock().await;
    let folder = project::projects_folder(&guard.registry)
        .ok_or_else(|| "no user config directory to keep projects under".to_string())?;
    let resolved = project::NewProjectPath::resolve(&name, &folder);
    Ok(NewProjectPathInfo {
        path: resolved.path.to_string_lossy().into_owned(),
        slug: resolved.slug,
        folder: resolved.folder.to_string_lossy().into_owned(),
    })
}

/// The form's Create. `path` is a folder the user picked for "I already
/// have work somewhere"; without one the folder is `<projects folder>/<slug>`,
/// resolved here again rather than trusted from the webview. The checks and
/// the writes are [`Registry::new_project`]'s.
#[tauri::command]
pub(crate) async fn new_project(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    path: Option<String>,
    instructions: Option<String>,
    claude_md: Option<bool>,
) -> Result<ProjectInfo, String> {
    let mut guard = state.workspaces.lock().await;
    let folder = match path
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
    {
        Some(picked) => project::NewProjectFolder::Picked(picked),
        None => {
            let base = project::projects_folder(&guard.registry)
                .ok_or_else(|| "no user config directory to keep projects under".to_string())?;
            project::NewProjectFolder::Resolved(project::NewProjectPath::resolve(&name, &base).path)
        }
    };
    let project = guard.registry.new_project_with(
        &name,
        folder,
        instructions.as_deref(),
        claude_md.unwrap_or(false),
    )?;
    announce_migration(&app, &project);
    Ok(ProjectInfo::of(&project))
}

/// Backlog 432: whether a folder could take the practices `CLAUDE.md` —
/// `exists` when it has one (never touched), `practices` when
/// `~/.claude/practices/practices.md` is there for the line to import.
#[derive(Serialize, Clone)]
pub(crate) struct ClaudeMdOffer {
    exists: bool,
    practices: bool,
}

/// The offer's check, for a picked folder in the New project form and a
/// folder just opened by Open project…. Reads only.
#[tauri::command]
pub(crate) async fn claude_md_offer(path: String) -> Result<ClaudeMdOffer, String> {
    let dir = PathBuf::from(path);
    Ok(ClaudeMdOffer {
        // An empty path is a folder New project has yet to make: no file.
        exists: !dir.as_os_str().is_empty()
            && dir.join(project::CLAUDE_MD).symlink_metadata().is_ok(),
        practices: project::practices_file_exists(),
    })
}

/// Backlog 432: Open project…'s offer accepted — the practices `CLAUDE.md`
/// in the project's folder, only if it has none. `false` when one was
/// already there (left exactly as it was).
#[tauri::command]
pub(crate) async fn add_practices_claude_md(
    state: State<'_, AppState>,
    id: String,
) -> Result<bool, String> {
    let (dir, name) = {
        let guard = state.workspaces.lock().await;
        let p = guard
            .registry
            .find(&id)
            .ok_or_else(|| format!("no project {id}"))?;
        let dir = p
            .workspace
            .clone()
            .ok_or_else(|| format!("{} has no folder", p.name))?;
        (dir, p.name.clone())
    };
    project::write_practices_claude_md(&dir, &name)
}

/// Open a project: its chats become the listing and its folder the workspace.
///
/// Drops the active session, because a session is a handle on a log file in
/// the *previous* project's directory — carrying it across would append the
/// next turn to a conversation the sidebar no longer lists.
///
/// Does not re-connect. The frontend does that with the settings it already
/// holds, and doing it here would mean this command needed everything
/// `connect` needs just to pass it through unchanged.
#[tauri::command]
pub(crate) async fn open_project(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<ProjectInfo, String> {
    // The launch waits on this one (item 220): its line in the startup log.
    startup_log::timed("open_project", open_project_body(&app, &state, &id)).await
}

/// [`open_project`]'s work.
pub(crate) async fn open_project_body(
    app: &AppHandle,
    state: &AppState,
    id: &str,
) -> Result<ProjectInfo, String> {
    let project = {
        let mut guard = state.workspaces.lock().await;
        let project = guard
            .registry
            .find(id)
            .cloned()
            .ok_or_else(|| format!("no project {id}"))?;
        guard.registry.touch(id);
        guard.active = Some(project.clone());
        project
    };
    state.chats.focus_new();
    // The pending kind was chosen against the list the user was looking at;
    // the next chat in the new project is an ordinary one until they say
    // otherwise (nightshift backlog 061).
    *state.pending_mode.lock().await = ChatMode::Normal;
    *state.pending_kind.lock().await = ChatKind::Build;
    adopt_agent_session(state, None).await;
    // After the guard is dropped, and before the counts are read: a project
    // opened for the first time since the move has its chats and notes still
    // in the folder, and `ProjectInfo` would report zero of each.
    announce_migration(app, &project);
    Ok(ProjectInfo::of(&project))
}

/// Leave the open project; later chats are unfiled again.
#[tauri::command]
pub(crate) async fn close_project(state: State<'_, AppState>) -> Result<(), String> {
    state.workspaces.lock().await.active = None;
    state.chats.focus_new();
    *state.pending_mode.lock().await = ChatMode::Normal;
    *state.pending_kind.lock().await = ChatKind::Build;
    adopt_agent_session(&state, None).await;
    Ok(())
}

#[tauri::command]
pub(crate) async fn rename_project(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<ProjectInfo, String> {
    let mut guard = state.workspaces.lock().await;
    let project = guard.registry.rename(&id, &name)?;
    if guard.active.as_ref().is_some_and(|p| p.id == id) {
        guard.active = Some(project.clone());
    }
    Ok(ProjectInfo::of(&project))
}

/// Remove a project from the list. **Forgets, never deletes** — the folder,
/// its notes and its chats are all still on disk, and the UI says so.
#[tauri::command]
pub(crate) async fn forget_project(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    // A held Nightshift launch must not outlive the project (review F4).
    nightshift::drop_pending(&app, &id)?;
    let closed = {
        let mut guard = state.workspaces.lock().await;
        guard.registry.forget(&id)?;
        let closed = guard.active.as_ref().is_some_and(|p| p.id == id);
        if closed {
            guard.active = None;
        }
        closed
    };
    if closed {
        state.chats.focus_new();
        *state.pending_mode.lock().await = ChatMode::Normal;
        *state.pending_kind.lock().await = ChatKind::Build;
    }
    Ok(())
}
