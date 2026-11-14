//! Attachment commands: office and PDF attachments, draft files, keeping files, zip unpacking (moved from main.rs, item 642).

#[allow(unused_imports)]
use crate::*;

/// An office file made sendable (nightshift item 277): a PDF through
/// LibreOffice when it is installed, its text otherwise or when the
/// conversion fails or passes `CONVERT_TIMEOUT` (the result's `note` says
/// why). `data` is the file's base64; his file on disk is never touched —
/// the bytes go into a temporary folder that is removed after.
#[tauri::command]
pub(crate) async fn prepare_office_attachment(
    name: String,
    data: String,
    // The text whatever is installed: the PDF came out over the engine's
    // cap, and the words are what can still go.
    text_only: Option<bool>,
) -> Result<nightloom_service::attach::Prepared, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|e| format!("{name}: {e}"))?;
    let soffice = if text_only == Some(true) {
        None
    } else {
        nightloom_service::attach::find_soffice()
    };
    nightloom_service::attach::prepare_office(
        &name,
        &bytes,
        soffice.as_deref(),
        nightloom_service::attach::CONVERT_TIMEOUT,
    )
    .await
}

/// A PDF's page count (nightshift item 491): what routes one over 10 pages
/// by path on the Claude Code engine. `None` when none is found.
#[tauri::command]
pub(crate) fn pdf_pages(data: String) -> Option<usize> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .ok()?;
    nightloom_service::attach::pdf_pages(&bytes)
}

/// An unsent draft's long PDF kept on disk across a relaunch (item 491);
/// its id. `read_draft_file` gives it back.
#[tauri::command]
pub(crate) fn stash_draft_file(data: String) -> Result<String, String> {
    let config = project::config_dir().ok_or("no config folder")?;
    nightloom_service::attach::stash_draft_file(&config, &data)
}

#[tauri::command]
pub(crate) fn read_draft_file(id: String) -> Result<String, String> {
    let config = project::config_dir().ok_or("no config folder")?;
    nightloom_service::attach::read_draft_file(&config, &id)
}

/// Item 491 follow-up: at start, delete the draft copies no saved draft
/// names (`keep`) that are over 30 days old; off the main thread. A named
/// copy is never deleted.
#[tauri::command]
pub(crate) async fn prune_draft_files(
    keep: Vec<String>,
) -> Result<nightloom_service::attach::DraftPrune, String> {
    let config = project::config_dir().ok_or("no config folder")?;
    let keep = keep.into_iter().map(|k| k.to_ascii_lowercase()).collect();
    tokio::task::spawn_blocking(move || {
        nightloom_service::attach::prune_draft_files(
            &config,
            &keep,
            nightloom_service::attach::DRAFT_FILE_MAX_AGE,
            std::time::SystemTime::now(),
        )
    })
    .await
    .map_err(|e| e.to_string())
}

/// Whether an office file will become a PDF (LibreOffice is installed) or
/// text — what the composer's chip says before the conversion starts.
#[tauri::command]
pub(crate) fn office_converter() -> bool {
    nightloom_service::attach::find_soffice().is_some()
}

/// "Keep in project" (nightshift item 306): an attachment copied into the
/// open project's files folder (`.agents/files/`), so a later chat lists
/// and reads it without its being attached again. `data` is the bytes the
/// model was sent (an office file's PDF, as `media_type` says); `path` is a
/// file the Claude Code engine saved in a chat's folder, named in a sent
/// message. Never an overwrite (`keep::keep_in_project`). A chat with no
/// project — none open, or the import's unfiled holder — has nowhere to
/// keep it, and says so.
#[tauri::command]
pub(crate) async fn keep_attachment(
    state: State<'_, AppState>,
    name: String,
    media_type: String,
    data: Option<String>,
    path: Option<String>,
    dir: Option<String>,
    // Item 428: the SHA-256 of the office file `data` was converted from,
    // so the same file kept twice is found though its PDF differs.
    source: Option<String>,
) -> Result<nightloom_service::keep::Kept, String> {
    use base64::Engine as _;
    let project = state
        .active()
        .await
        .filter(|p| !p.is_unfiled_holder())
        .ok_or("this chat is not in a project, so there is no project to keep the file in")?;
    let docspace = project.notes_dir();
    let workspace = project.workspace_dir();
    tokio::task::spawn_blocking(move || match (data, path) {
        (Some(data), _) => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data.trim())
                .map_err(|e| format!("{name}: {e}"))?;
            // Item 414: an entry of a dropped zip goes into its folder.
            nightloom_service::keep::keep_in_project_from(
                &docspace,
                dir.as_deref().unwrap_or(""),
                &name,
                &media_type,
                &bytes,
                source.as_deref(),
            )
        }
        (None, Some(path)) => {
            nightloom_service::keep::keep_chat_file(&workspace, &docspace, Path::new(&path))
        }
        (None, None) => Err(format!("{name}: nothing to keep")),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Item 492: a file kept in the notes folder he points at (`folder`,
/// docspace-relative: `people`, `files/bundle`) — a folder row he dropped
/// on, or the + on it. `clash`: `"ask"` answers `Taken` with nothing
/// written when the name holds other bytes; `"both"` numbers it;
/// `"replace"` moves the old file to the notes trash first
/// (`keep::keep_in_folder`).
#[tauri::command]
pub(crate) async fn keep_in_folder(
    state: State<'_, AppState>,
    name: String,
    media_type: String,
    data: String,
    folder: String,
    clash: Option<String>,
    source: Option<String>,
) -> Result<nightloom_service::keep::Landing, String> {
    use base64::Engine as _;
    let project = state
        .active()
        .await
        .filter(|p| !p.is_unfiled_holder())
        .ok_or("this chat is not in a project, so there is no project to keep the file in")?;
    let docspace = project.notes_dir();
    tokio::task::spawn_blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data.trim())
            .map_err(|e| format!("{name}: {e}"))?;
        nightloom_service::keep::keep_in_folder(
            &docspace,
            &folder,
            &name,
            &media_type,
            &bytes,
            source.as_deref(),
            nightloom_service::keep::OnClash::parse(clash.as_deref()),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Item 498: an image the note toolbar inserts, kept in `folder` (the
/// `attachments/` folder beside the note, store-relative) of the note's own
/// store — the project's notes or the vault. The same keep as
/// [`keep_in_folder`] (`keep::keep_in_folder`), with Keep both on a clash:
/// a name taken by other bytes is numbered, the same bytes are reused.
#[tauri::command]
pub(crate) async fn keep_note_file(
    state: State<'_, AppState>,
    scope: NoteScope,
    folder: String,
    name: String,
    media_type: String,
    data: String,
) -> Result<nightloom_service::keep::Landing, String> {
    use base64::Engine as _;
    if !matches!(scope, NoteScope::Project | NoteScope::Knowledge) {
        return Err("images are kept beside notes in the project's notes or the vault only".into());
    }
    let docspace = scope_dir(&state, scope).await?;
    tokio::task::spawn_blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data.trim())
            .map_err(|e| format!("{name}: {e}"))?;
        nightloom_service::keep::keep_in_folder(
            &docspace,
            &folder,
            &name,
            &media_type,
            &bytes,
            None,
            nightloom_service::keep::OnClash::Both,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One file out of a dropped zip, for the window (item 414).
#[derive(serde::Serialize)]
pub(crate) struct ZipFileWire {
    path: String,
    data: String,
}

/// A dropped zip, read (item 414): the folder under `files/` it unpacks
/// into, its files as base64 for the window to put through a dropped
/// file's rules and keep with `keep_attachment`'s `dir`, and the entries
/// left out. Nothing is written here.
#[derive(serde::Serialize)]
pub(crate) struct UnpackedWire {
    folder: String,
    files: Vec<ZipFileWire>,
    skipped: Vec<nightloom_service::keep::ZipSkip>,
}

#[tauri::command]
pub(crate) async fn unpack_zip(
    state: State<'_, AppState>,
    name: String,
    data: String,
    // Item 492: the notes folder the zip was dropped on; its folder is
    // named free there rather than in `files/`.
    folder: Option<String>,
) -> Result<UnpackedWire, String> {
    use base64::Engine as _;
    let project = state
        .active()
        .await
        .filter(|p| !p.is_unfiled_holder())
        .ok_or("this chat is not in a project, so there is no project to keep the files in")?;
    let docspace = project.notes_dir();
    tokio::task::spawn_blocking(move || {
        let b64 = &base64::engine::general_purpose::STANDARD;
        let bytes = b64
            .decode(data.trim())
            .map_err(|e| format!("{name}: {e}"))?;
        let u = nightloom_service::keep::unpack_zip(&docspace, &name, &bytes)?;
        let in_folder = match folder.as_deref() {
            Some(f) => {
                let (dir, _) = nightloom_service::keep::note_folder(&docspace, f)?;
                nightloom_service::keep::zip_folder_in(&dir, &name)
            }
            None => u.folder,
        };
        Ok(UnpackedWire {
            folder: in_folder,
            files: u
                .files
                .into_iter()
                .map(|f| ZipFileWire {
                    path: f.path,
                    data: b64.encode(f.bytes),
                })
                .collect(),
            skipped: u.skipped,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
