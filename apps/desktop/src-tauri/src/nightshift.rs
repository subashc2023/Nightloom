//! Nightshift commands — the desktop's window onto `nightloom_service::nightshift`.
//!
//! Every command takes a Nightloom project id, finds the project in the
//! registry, runs the contract's detection on its workspace and hands the
//! service the contract root. Nothing here parses a file or decides what a
//! field means: a Nightshift screen is a projection of the files, the
//! projection lives in Rust, and Svelte renders it. The one piece of state
//! is [`Watches`], the file subscriptions that turn a runner's status write
//! into a `nightshift-change` window event.
//!
//! Separate from `main.rs` because that file is already the whole of the
//! app's command surface; `main.rs` includes this module, manages
//! [`Watches`], and lists the commands in its handler — nothing else.

use crate::{AppState, blocking};
use nightloom_service::nightshift::{
    self, Blocker, ContractRoot, Item, Plan, ShiftSummary, blockers, git, items, launch, mornings,
    shifts, watch,
};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

/// A registered project as the Nightshift list shows it: the ones that
/// pass detection carry their contract root; the ones that do not are the
/// candidates for **Enable Nightshift**.
#[derive(Serialize, Clone)]
pub struct NightshiftRow {
    pub id: String,
    pub name: String,
    /// The Nightloom workspace, or `null` for a project about no folder —
    /// which cannot be enabled, since there is nowhere to put the root.
    pub workspace: Option<String>,
    pub exists: bool,
    pub nightshift: Option<NightshiftInfo>,
    /// The directory holding a `nightshift.json.disabled` — a root that
    /// **Disable Nightshift** turned off and Enable would restore rather
    /// than scaffold (item 037). `null` when there is none.
    pub disabled: Option<String>,
}

/// What detection found, plus the counts a row is worth reading for.
#[derive(Serialize, Clone)]
pub struct NightshiftInfo {
    pub contract_root: String,
    pub nested: bool,
    pub config: nightshift::Config,
    pub config_error: Option<String>,
    /// `state/run.lock`, when present.
    pub lock: Option<launch::Lock>,
    /// A shift is running, or the platform cannot say it is not. Every
    /// editing control locks on this.
    pub live: bool,
    /// Where the runner is looked for: `runner` from `nightshift.json`,
    /// else the contract root itself (§3, blocker 024).
    pub runner: String,
    /// `bin/nightshift.sh` exists under `runner`.
    pub runner_present: bool,
    pub git: bool,
    pub items: usize,
    pub open_blockers: usize,
    pub newest_morning: Option<String>,
    pub latest_shift: Option<String>,
}

impl NightshiftInfo {
    fn of(root: &ContractRoot) -> Self {
        let lock = launch::read_lock(&root.root);
        let (bl, _) = blockers::list_blockers(&root.root);
        Self {
            contract_root: root.root.to_string_lossy().into_owned(),
            nested: root.nested,
            config: root.config.clone(),
            config_error: root.config_error.clone(),
            live: lock.as_ref().is_some_and(|l| l.blocks_writes()),
            lock,
            runner: root.runner_root().to_string_lossy().into_owned(),
            runner_present: launch::runner_present(&root.root, &root.config),
            git: git::is_repo(&root.root),
            items: items::item_files(&root.root).len(),
            open_blockers: bl.iter().filter(|b| b.status == "open").count(),
            newest_morning: mornings::newest_morning(&root.root).map(|m| m.name),
            latest_shift: shifts::list_shifts(&root.root)
                .first()
                .map(|s| s.id.clone()),
        }
    }
}

/// The registry entry's workspace, or the reason there is none.
async fn workspace_of(state: &State<'_, AppState>, id: &str) -> Result<(String, PathBuf), String> {
    let ws = state.workspaces.lock().await;
    let project = ws
        .registry
        .find(id)
        .ok_or_else(|| format!("no project with id {id}"))?;
    let workspace = project
        .workspace
        .clone()
        .ok_or_else(|| format!("{} has no folder; Nightshift needs one", project.name))?;
    Ok((project.name.clone(), workspace))
}

/// The contract root for a project, or why it is not a Nightshift project.
async fn root_of(state: &State<'_, AppState>, id: &str) -> Result<ContractRoot, String> {
    let (name, workspace) = workspace_of(state, id).await?;
    blocking(move || {
        nightshift::detect(&workspace).ok_or_else(|| format!("Nightshift is not enabled on {name}"))
    })
    .await
}

/// Every registered project with whether it is a Nightshift project.
#[tauri::command]
pub async fn nightshift_projects(state: State<'_, AppState>) -> Result<Vec<NightshiftRow>, String> {
    let projects = state.workspaces.lock().await.registry.projects();
    blocking(move || -> Result<_, String> {
        Ok(projects
            .iter()
            .map(|p| NightshiftRow {
                id: p.id.clone(),
                name: p.name.clone(),
                workspace: p
                    .workspace
                    .as_ref()
                    .map(|w| w.to_string_lossy().into_owned()),
                exists: p.exists(),
                nightshift: p
                    .workspace
                    .as_deref()
                    .and_then(nightshift::detect)
                    .map(|r| NightshiftInfo::of(&r)),
                disabled: p
                    .workspace
                    .as_deref()
                    .and_then(nightshift::detect_disabled)
                    .map(|d| d.to_string_lossy().into_owned()),
            })
            .collect())
    })
    .await
}

/// One row, fresh — what the surface re-reads on a change event.
#[tauri::command]
pub async fn nightshift_project(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<NightshiftRow, String> {
    let ws = state.workspaces.lock().await;
    let p = ws
        .registry
        .find(&project_id)
        .cloned()
        .ok_or_else(|| format!("no project with id {project_id}"))?;
    drop(ws);
    blocking(move || -> Result<_, String> {
        Ok(NightshiftRow {
            id: p.id.clone(),
            name: p.name.clone(),
            workspace: p
                .workspace
                .as_ref()
                .map(|w| w.to_string_lossy().into_owned()),
            exists: p.exists(),
            nightshift: p
                .workspace
                .as_deref()
                .and_then(nightshift::detect)
                .map(|r| NightshiftInfo::of(&r)),
            disabled: p
                .workspace
                .as_deref()
                .and_then(nightshift::detect_disabled)
                .map(|d| d.to_string_lossy().into_owned()),
        })
    })
    .await
}

/// The one runner install this machine has, if a registered project shows
/// it: the first project (registry order) whose contract root carries its
/// own `bin/nightshift.sh` — the nightshift repo itself — else the first
/// whose `nightshift.json` points at a `runner` that exists. What the
/// Enable form is prefilled with; the user can type another path.
#[tauri::command]
pub async fn nightshift_default_runner(
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let projects = state.workspaces.lock().await.registry.projects();
    blocking(move || -> Result<_, String> {
        let roots: Vec<ContractRoot> = projects
            .iter()
            .filter_map(|p| p.workspace.as_deref().and_then(nightshift::detect))
            .collect();
        Ok(default_runner(&roots))
    })
    .await
}

/// The rule behind [`nightshift_default_runner`], over already-detected roots.
fn default_runner(roots: &[ContractRoot]) -> Option<String> {
    let own = roots
        .iter()
        .find(|r| r.root.join(launch::RUNNER).is_file())
        .map(|r| r.root.clone());
    own.or_else(|| {
        roots
            .iter()
            .filter(|r| r.config.runner.is_some())
            .map(|r| r.runner_root())
            .find(|d| d.join(launch::RUNNER).is_file())
    })
    .map(|d| d.to_string_lossy().into_owned())
}

/// **Enable Nightshift** on a project: scaffold `<workspace>/nightshift/`.
/// `kind` defaults to `research`; `runner` is the install the new root
/// points at (§3, blocker 024) — an empty or missing one writes no key.
/// Returns the row and the scaffold's notes (what it could not do — `git
/// init` without git, a runner path with no script under it).
#[tauri::command]
pub async fn nightshift_enable(
    state: State<'_, AppState>,
    project_id: String,
    kind: Option<String>,
    runner: Option<String>,
) -> Result<(NightshiftRow, Vec<String>), String> {
    let (name, workspace) = workspace_of(&state, &project_id).await?;
    let runner = runner
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty())
        .map(PathBuf::from);
    let notes = blocking(move || {
        nightshift::enable(
            &workspace,
            &name,
            kind.as_deref().unwrap_or("research"),
            runner.as_deref(),
        )
        .map(|e| e.notes)
    })
    .await?;
    Ok((nightshift_project(state, project_id).await?, notes))
}

/// **Disable Nightshift** on a project (item 037): rename `nightshift.json`
/// to `nightshift.json.disabled`, so detection fails and the project drops
/// out of the list. Deletes nothing; refused while a shift is live. The
/// caller has shown the warning and the user has said yes. Returns the
/// fresh row, which now carries `disabled`.
#[tauri::command]
pub async fn nightshift_disable(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<NightshiftRow, String> {
    let (_, workspace) = workspace_of(&state, &project_id).await?;
    blocking(move || nightshift::disable(&workspace)).await?;
    nightshift_project(state, project_id).await
}

// ---- backlog ----

#[derive(Serialize)]
pub struct ItemList {
    pub items: Vec<Item>,
    pub order: Vec<String>,
    /// Files that did not read, by message. Shown, not dropped.
    pub errors: Vec<String>,
}

#[tauri::command]
pub async fn nightshift_items(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<ItemList, String> {
    let root = root_of(&state, &project_id).await?;
    blocking(move || -> Result<_, String> {
        let (items, errors) = items::list_items(&root.root, &root.config);
        Ok(ItemList {
            items,
            order: items::load_order(&root.root),
            errors,
        })
    })
    .await
}

#[tauri::command]
pub async fn nightshift_item(
    state: State<'_, AppState>,
    project_id: String,
    id: String,
) -> Result<Item, String> {
    let root = root_of(&state, &project_id).await?;
    blocking(move || items::read_item(&root.root, &root.config, &id)).await
}

/// Rewrite `backlog/order.json`. Refused while a shift is live.
#[tauri::command]
pub async fn nightshift_set_order(
    state: State<'_, AppState>,
    project_id: String,
    order: Vec<String>,
) -> Result<Vec<String>, String> {
    let root = root_of(&state, &project_id).await?;
    blocking(move || items::save_order(&root.root, &order)).await
}

/// Scaffold a new backlog item and append it to the order; returns its id.
/// Refused while a shift is live.
#[tauri::command]
pub async fn nightshift_new_item(
    state: State<'_, AppState>,
    project_id: String,
    title: String,
    kind: String,
) -> Result<String, String> {
    let root = root_of(&state, &project_id).await?;
    blocking(move || items::new_item(&root.root, &title, &kind)).await
}

/// Replace a backlog item's text — the Edit screen's Save. Refused while a
/// shift is live.
#[tauri::command]
pub async fn nightshift_write_item(
    state: State<'_, AppState>,
    project_id: String,
    id: String,
    text: String,
) -> Result<(), String> {
    let root = root_of(&state, &project_id).await?;
    blocking(move || items::write_item(&root.root, &id, &text)).await
}

// ---- blockers ----

#[derive(Serialize)]
pub struct BlockerList {
    pub blockers: Vec<Blocker>,
    pub errors: Vec<String>,
}

#[tauri::command]
pub async fn nightshift_blockers(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<BlockerList, String> {
    let root = root_of(&state, &project_id).await?;
    blocking(move || -> Result<_, String> {
        let (blockers, errors) = blockers::list_blockers(&root.root);
        Ok(BlockerList { blockers, errors })
    })
    .await
}

/// Write `## Answer` and flip `status` to `answered` — the two edits the
/// contract gives the GUI. Refused while a shift is live.
#[tauri::command]
pub async fn nightshift_answer_blocker(
    state: State<'_, AppState>,
    project_id: String,
    id: String,
    answer: String,
) -> Result<Blocker, String> {
    let root = root_of(&state, &project_id).await?;
    blocking(move || blockers::answer_blocker(&root.root, &id, &answer)).await
}

// ---- shifts ----

#[tauri::command]
pub async fn nightshift_shifts(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<ShiftSummary>, String> {
    let root = root_of(&state, &project_id).await?;
    blocking(move || -> Result<_, String> { Ok(shifts::list_shifts(&root.root)) }).await
}

#[tauri::command]
pub async fn nightshift_shift(
    state: State<'_, AppState>,
    project_id: String,
    shift_id: String,
) -> Result<ShiftSummary, String> {
    let root = root_of(&state, &project_id).await?;
    blocking(move || shifts::read_shift(&root.root, &shift_id)).await
}

/// The last `max_bytes` of a shift's `run.log` (default 64 KiB).
#[tauri::command]
pub async fn nightshift_shift_log(
    state: State<'_, AppState>,
    project_id: String,
    shift_id: String,
    max_bytes: Option<usize>,
) -> Result<String, String> {
    let root = root_of(&state, &project_id).await?;
    blocking(move || shifts::log_tail(&root.root, &shift_id, max_bytes.unwrap_or(64 * 1024))).await
}

/// A plan the way `shiftctl plan synth` would write it, with a fresh shift
/// id, for the plan form to start from. Writes nothing.
#[tauri::command]
pub async fn nightshift_synth_plan(
    state: State<'_, AppState>,
    project_id: String,
    max_units: Option<u32>,
    until: Option<String>,
    budget_usd: Option<f64>,
) -> Result<Plan, String> {
    let root = root_of(&state, &project_id).await?;
    blocking(move || -> Result<_, String> {
        Ok(Plan::synthesise(
            &root.root,
            &root.config,
            &shifts::next_shift_id(),
            max_units,
            until,
            budget_usd,
        ))
    })
    .await
}

/// Write `shifts/<id>/plan.json`. Returns its root-relative path — the
/// argument [`nightshift_launch`] takes. Refused while a shift is live and
/// when the plan exists.
#[tauri::command]
pub async fn nightshift_write_plan(
    state: State<'_, AppState>,
    project_id: String,
    plan: Plan,
) -> Result<String, String> {
    let root = root_of(&state, &project_id).await?;
    blocking(move || shifts::write_plan(&root.root, &plan)).await
}

/// Launch the runner on a written plan, detached. macOS only; elsewhere it
/// says so. Returns the wrapper pid.
#[tauri::command]
pub async fn nightshift_launch(
    state: State<'_, AppState>,
    project_id: String,
    plan_path: String,
) -> Result<u32, String> {
    let root = root_of(&state, &project_id).await?;
    blocking(move || launch::launch(&root.root, &root.config, &plan_path)).await
}

// ---- mornings, notes, streams ----

#[tauri::command]
pub async fn nightshift_mornings(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<mornings::Morning>, String> {
    let root = root_of(&state, &project_id).await?;
    blocking(move || -> Result<_, String> { Ok(mornings::list_mornings(&root.root)) }).await
}

#[derive(Serialize)]
pub struct MorningPage {
    pub name: String,
    pub text: String,
}

/// A morning page by name, or the newest when `name` is null. `Ok(None)`
/// for a project with no page yet — an ordinary state, not an error.
#[tauri::command]
pub async fn nightshift_morning(
    state: State<'_, AppState>,
    project_id: String,
    name: Option<String>,
) -> Result<Option<MorningPage>, String> {
    let root = root_of(&state, &project_id).await?;
    blocking(move || -> Result<_, String> {
        let name = match name {
            Some(n) => n,
            None => match mornings::newest_morning(&root.root) {
                Some(m) => m.name,
                None => return Ok(None),
            },
        };
        let text = mornings::read_morning(&root.root, &name)?;
        Ok(Some(MorningPage { name, text }))
    })
    .await
}

#[tauri::command]
pub async fn nightshift_notes(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<mornings::NoteEntry>, String> {
    let root = root_of(&state, &project_id).await?;
    blocking(move || -> Result<_, String> { Ok(mornings::notes_tree(&root.root)) }).await
}

/// Any text file inside the contract root by relative path.
#[tauri::command]
pub async fn nightshift_read_file(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
) -> Result<String, String> {
    let root = root_of(&state, &project_id).await?;
    blocking(move || mornings::read_file(&root.root, &path)).await
}

/// The last `limit` rows (default 200) of `state/spend.jsonl` or
/// `state/adherence.jsonl`, by `stream` = `spend` | `adherence`.
#[tauri::command]
pub async fn nightshift_stream(
    state: State<'_, AppState>,
    project_id: String,
    stream: String,
    limit: Option<usize>,
) -> Result<Vec<serde_json::Value>, String> {
    let rel = match stream.as_str() {
        "spend" => "state/spend.jsonl",
        "adherence" => "state/adherence.jsonl",
        "limits" => "state/limit-observations.jsonl",
        other => {
            return Err(format!(
                "unknown stream {other:?}; spend, adherence or limits"
            ));
        }
    };
    let root = root_of(&state, &project_id).await?;
    blocking(move || mornings::jsonl_tail(&root.root, rel, limit.unwrap_or(200))).await
}

// ---- schedule ----

#[tauri::command]
pub async fn nightshift_schedule(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<mornings::Schedules, String> {
    let root = root_of(&state, &project_id).await?;
    blocking(move || mornings::read_schedules(&root.root)).await
}

#[tauri::command]
pub async fn nightshift_set_schedule(
    state: State<'_, AppState>,
    project_id: String,
    schedules: mornings::Schedules,
) -> Result<mornings::Schedules, String> {
    let root = root_of(&state, &project_id).await?;
    blocking(move || mornings::write_schedules(&root.root, &schedules)).await
}

// ---- git ----

/// What one unit changed: the diff of its commit.
#[tauri::command]
pub async fn nightshift_diff(
    state: State<'_, AppState>,
    project_id: String,
    sha: String,
) -> Result<String, String> {
    let root = root_of(&state, &project_id).await?;
    blocking(move || git::diff_commit(&root.root, &sha)).await
}

/// What a whole shift changed: `head_at_start..HEAD` from its `status.json`.
#[tauri::command]
pub async fn nightshift_shift_diff(
    state: State<'_, AppState>,
    project_id: String,
    shift_id: String,
) -> Result<String, String> {
    let root = root_of(&state, &project_id).await?;
    blocking(move || {
        let from = head_at_start(&root, &shift_id)?;
        git::diff_range(&root.root, &from, "HEAD")
    })
    .await
}

/// The diff a revert of this shift would discard, and whether the tree is
/// clean enough to do it. Shown before [`nightshift_revert`] is offered.
#[tauri::command]
pub async fn nightshift_revert_preview(
    state: State<'_, AppState>,
    project_id: String,
    shift_id: String,
) -> Result<git::RevertPreview, String> {
    let root = root_of(&state, &project_id).await?;
    blocking(move || {
        let target = head_at_start(&root, &shift_id)?;
        git::revert_preview(&root.root, &target)
    })
    .await
}

/// `git reset --hard <head_at_start>`. Only with `confirm`; the caller has
/// shown the preview and the user has said yes. Never automatic.
#[tauri::command]
pub async fn nightshift_revert(
    state: State<'_, AppState>,
    project_id: String,
    shift_id: String,
    confirm: bool,
) -> Result<git::RevertPreview, String> {
    let root = root_of(&state, &project_id).await?;
    blocking(move || {
        let target = head_at_start(&root, &shift_id)?;
        git::revert(&root.root, &target, confirm)
    })
    .await
}

fn head_at_start(root: &ContractRoot, shift_id: &str) -> Result<String, String> {
    let shift = shifts::read_shift(&root.root, shift_id)?;
    shift
        .status
        .and_then(|s| s.head_at_start)
        .ok_or_else(|| format!("shift {shift_id} has no status.json with head_at_start"))
}

// ---- watching ----

/// The live file subscriptions, one per project id. Managed by `main.rs`
/// beside `AppState` rather than inside it, so `AppState`'s lock ordering
/// gains nothing to remember.
#[derive(Default)]
pub struct Watches(std::sync::Mutex<HashMap<String, watch::ChangeWatcher>>);

/// The payload of a `nightshift-change` window event.
#[derive(Serialize, Clone)]
pub struct Change {
    pub project_id: String,
    /// Root-relative paths that changed, deduplicated.
    pub paths: Vec<String>,
}

/// Watch a project's contract root; a change emits `nightshift-change`.
/// Replaces an existing watch on the same project.
#[tauri::command]
pub async fn nightshift_watch(
    app: AppHandle,
    state: State<'_, AppState>,
    watches: State<'_, Watches>,
    project_id: String,
) -> Result<(), String> {
    let root = root_of(&state, &project_id).await?;
    let id = project_id.clone();
    let watcher = watch::watch(
        &root.root,
        Duration::from_millis(400),
        Duration::from_secs(3),
        move |paths| {
            let _ = app.emit(
                "nightshift-change",
                Change {
                    project_id: id.clone(),
                    paths,
                },
            );
        },
    )?;
    watches
        .0
        .lock()
        .map_err(|_| "watch table poisoned".to_string())?
        .insert(project_id, watcher);
    Ok(())
}

#[tauri::command]
pub fn nightshift_unwatch(watches: State<'_, Watches>, project_id: String) -> Result<(), String> {
    watches
        .0
        .lock()
        .map_err(|_| "watch table poisoned".to_string())?
        .remove(&project_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn root_at(dir: &std::path::Path, runner: Option<&str>) -> ContractRoot {
        fs::create_dir_all(dir).unwrap();
        let mut config = serde_json::json!({ "version": 2, "kind": "research", "name": "t" });
        if let Some(r) = runner {
            config["runner"] = serde_json::Value::String(r.to_string());
        }
        fs::write(dir.join(nightshift::CONFIG_FILE), config.to_string()).unwrap();
        nightshift::detect(dir).unwrap()
    }

    #[test]
    fn the_default_runner_is_a_root_with_its_own_script_else_a_pointed_at_one() {
        let ws =
            std::env::temp_dir().join(format!("nightloom-default-runner-{}", std::process::id()));
        let _ = fs::remove_dir_all(&ws);
        let install = ws.join("install");
        fs::create_dir_all(install.join("bin")).unwrap();
        fs::write(install.join(launch::RUNNER), "#!/bin/bash\n").unwrap();
        // Nothing registered carries or names a runner: none.
        let bare = root_at(&ws.join("bare"), None);
        assert_eq!(default_runner(std::slice::from_ref(&bare)), None);
        // A root pointing at an existing install: that install.
        let pointed = root_at(&ws.join("pointed"), Some(&install.to_string_lossy()));
        assert_eq!(
            default_runner(&[bare.clone(), pointed.clone()]).as_deref(),
            Some(install.to_string_lossy().as_ref())
        );
        // A pointer at nothing does not count.
        let dangling = root_at(
            &ws.join("dangling"),
            Some(&ws.join("nowhere").to_string_lossy()),
        );
        assert_eq!(default_runner(std::slice::from_ref(&dangling)), None);
        // A root that IS the install wins over a pointer, whatever the order.
        let own = root_at(&install, None);
        assert_eq!(
            default_runner(&[pointed, dangling, own]).as_deref(),
            Some(install.to_string_lossy().as_ref())
        );
        let _ = fs::remove_dir_all(&ws);
    }
}
