//! Nightshift commands — the desktop's window onto `nightloom_service::nightshift`.
//!
//! Every command takes a Nightloom project id, finds the project in the
//! registry, runs the contract's detection on its workspace and hands the
//! service the contract root. Nothing here parses a file or decides what a
//! field means: a Nightshift screen is a projection of the files, the
//! projection lives in Rust, and Svelte renders it. The state is two
//! tables: [`Watches`], the file subscriptions that turn a runner's status
//! write into a `nightshift-change` window event, and [`PendingLaunches`],
//! the one-off timers the Plan screen's Start field arms (§7's v1 rule: the
//! scheduler lives in the app while it is open).
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
use tauri::{AppHandle, Emitter, Manager, State};

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
    /// Files the runner's `git add -A` would sweep into a `WIP:` commit at
    /// launch (`git status --porcelain`, untracked counted one each); `null`
    /// when the root is not a repo or git cannot say.
    pub dirty: Option<usize>,
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
            dirty: git::dirty_count(&root.root),
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
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
) -> Result<NightshiftRow, String> {
    // A held launch on this project would otherwise fire on the disabled
    // root — and the runner, finding no nightshift.json in its cwd, falls
    // back to its own install root (review F4, 2026-09-12).
    drop_pending(&app, &project_id)?;
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

/// Move a backlog item to `backlog/trash/` and drop it from the order — the
/// Backlog screen's Delete, behind its dialog. Refused while a shift is live.
#[tauri::command]
pub async fn nightshift_delete_item(
    state: State<'_, AppState>,
    project_id: String,
    id: String,
) -> Result<String, String> {
    let root = root_of(&state, &project_id).await?;
    blocking(move || items::delete_item(&root.root, &id)).await
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

// ---- a pending launch: the app holds the timer (SHIFT-CONTRACT §7, v1) ----

/// One scheduled one-off launch per project: the plan as the form left it
/// and the moment to write and launch it. **In memory only** — §7's v1 rule
/// is that the scheduler lives in the app while it is open, and Swaraag
/// keeps it open; an app restart drops the timer and the chip that showed
/// it says so in its tooltip. Managed by `main.rs` beside [`Watches`].
pub struct PendingLaunch {
    pub plan: Plan,
    /// Unix epoch milliseconds — what the form computed, what the chip shows.
    pub fire_at_ms: u64,
    task: tauri::async_runtime::JoinHandle<()>,
    /// `caffeinate -i` for as long as the launch is held: the point of the
    /// field is to fire with nobody at the keyboard, and idle sleep would
    /// otherwise stop the clock the timer runs on (review F2, 2026-09-12).
    /// Killed when the entry leaves the table — fire, cancel, replace.
    awake: Option<std::process::Child>,
}

impl Drop for PendingLaunch {
    fn drop(&mut self) {
        if let Some(mut c) = self.awake.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

/// How far past `fire_at_ms` a timer may wake and still launch. Past this
/// the Mac was asleep (or the app was frozen) across the moment, and a shift
/// that starts hours late — while Swaraag is at the desk — is worse than a
/// toast saying it was missed.
const MISSED_GRACE_MS: u64 = 10 * 60 * 1000;
/// The timer sleeps in slices and re-reads the wall clock each time, because
/// tokio's timer runs on a monotonic clock that macOS does not advance during
/// system sleep: one long sleep would fire late by however long the Mac slept.
const TIMER_SLICE_MS: u64 = 30 * 1000;

#[derive(Default)]
pub struct PendingLaunches(std::sync::Mutex<HashMap<String, PendingLaunch>>);

/// What the frontend sees of a pending launch.
#[derive(Serialize, Clone)]
pub struct PendingView {
    pub fire_at_ms: u64,
    /// The draft's id — re-minted when the timer fires (see [`prepare_timed_plan`]).
    pub shift_id: String,
    pub items: usize,
}

/// The payload of a `nightshift-launched` window event: the timer fired.
#[derive(Serialize, Clone)]
pub struct Launched {
    pub project_id: String,
    pub shift_id: Option<String>,
    pub pid: Option<u32>,
    pub error: Option<String>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The plan a timer writes: the draft with its id **re-minted** to the
/// moment of launch — the draft's id is the moment the Plan screen was
/// opened, and a shift that starts at 05:10 must not be called `00-29` —
/// and `scheduled_for` recorded beside `created`. Refuses a live root the
/// way the button does, via `write_plan`.
pub fn prepare_timed_plan(
    root: &std::path::Path,
    draft: &Plan,
    fire_at_ms: u64,
) -> Result<(String, String), String> {
    let mut plan = draft.clone();
    plan.shift_id = shifts::next_shift_id();
    plan.created = String::new();
    plan.extra.insert(
        "scheduled_for".into(),
        serde_json::Value::String(iso_of_ms(fire_at_ms)),
    );
    let path = shifts::write_plan(root, &plan)?;
    Ok((plan.shift_id, path))
}

/// `2026-09-12T05:10:00Z` from epoch milliseconds, without a date crate.
fn iso_of_ms(ms: u64) -> String {
    let secs = ms / 1000;
    let days = secs / 86_400;
    let rem = secs % 86_400;
    // Civil-from-days (Howard Hinnant's algorithm), proleptic Gregorian.
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Remove and abort a project's held launch, if any. A poisoned table is an
/// error: cancel must never report success while the timer still runs.
pub fn drop_pending(app: &AppHandle, project_id: &str) -> Result<(), String> {
    let removed = app
        .state::<PendingLaunches>()
        .0
        .lock()
        .map_err(|_| "pending table poisoned".to_string())?
        .remove(project_id);
    if let Some(p) = removed {
        p.task.abort();
    }
    Ok(())
}

/// Hold a plan and launch it at `fire_at_ms` — write `plan.json` then start
/// the runner, exactly what the button does, then tell the window with
/// `nightshift-launched`. Replaces a pending launch on the same project.
/// Refused while a shift is live and when the moment is already past.
#[tauri::command]
pub async fn nightshift_schedule_launch(
    app: AppHandle,
    state: State<'_, AppState>,
    pending: State<'_, PendingLaunches>,
    project_id: String,
    plan: Plan,
    fire_at_ms: u64,
) -> Result<PendingView, String> {
    let root = root_of(&state, &project_id).await?;
    launch::ensure_not_live(&root.root)?;
    let now = now_ms();
    if fire_at_ms <= now {
        return Err("that moment has passed; pick a later time or launch now".into());
    }
    if plan.items.iter().filter(|i| i.selected).count() == 0 {
        return Err("no items selected".into());
    }
    drop_pending(&app, &project_id)?;
    let view = PendingView {
        fire_at_ms,
        shift_id: plan.shift_id.clone(),
        items: plan.items.iter().filter(|i| i.selected).count(),
    };
    let handle = app.clone();
    let id = project_id.clone();
    let draft = plan.clone();
    // The table is locked across the spawn and the insert, so the task's own
    // removal (after the sleep) cannot run before its entry exists — an
    // imminent moment would otherwise leave a phantom "held" entry.
    let mut table = pending
        .0
        .lock()
        .map_err(|_| "pending table poisoned".to_string())?;
    let task = tauri::async_runtime::spawn(async move {
        loop {
            let now = now_ms();
            if now >= fire_at_ms {
                break;
            }
            tokio::time::sleep(Duration::from_millis(
                (fire_at_ms - now).min(TIMER_SLICE_MS),
            ))
            .await;
        }
        let woke = now_ms();
        let r = if woke > fire_at_ms + MISSED_GRACE_MS {
            Err(format!(
                "missed: the launch was for {} and it is {} — the Mac was asleep across it (or the app frozen); launch now if you still want it",
                clock_of_ms(fire_at_ms),
                clock_of_ms(woke)
            ))
        } else if !root.root.join("nightshift.json").is_file() {
            Err("Nightshift was disabled on this project after the launch was held; nothing launched".into())
        } else {
            blocking({
                let root = root.clone();
                let draft = draft.clone();
                move || -> Result<(String, u32), String> {
                    let (shift_id, path) = prepare_timed_plan(&root.root, &draft, fire_at_ms)?;
                    let pid = launch::launch(&root.root, &root.config, &path)?;
                    Ok((shift_id, pid))
                }
            })
            .await
        };
        let payload = match r {
            Ok((shift_id, pid)) => Launched {
                project_id: id.clone(),
                shift_id: Some(shift_id),
                pid: Some(pid),
                error: None,
            },
            Err(e) => Launched {
                project_id: id.clone(),
                shift_id: None,
                pid: None,
                error: Some(e),
            },
        };
        // The entry goes before the event, so a listener re-reading the
        // pending launch on the event sees none.
        if let Ok(mut m) = handle.state::<PendingLaunches>().0.lock() {
            m.remove(&id);
        }
        let _ = handle.emit("nightshift-launched", payload);
    });
    let awake = std::process::Command::new("caffeinate")
        .arg("-i")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok();
    table.insert(
        project_id,
        PendingLaunch {
            plan,
            fire_at_ms,
            task,
            awake,
        },
    );
    drop(table);
    Ok(view)
}

/// `05:10` local from epoch milliseconds, for the missed-launch message.
fn clock_of_ms(ms: u64) -> String {
    use std::process::Command;
    // Local time without a date crate: `date -r <secs> +%H:%M`, the way the
    // rest of this file shells out for git and caffeinate.
    Command::new("date")
        .arg("-r")
        .arg((ms / 1000).to_string())
        .arg("+%H:%M")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| iso_of_ms(ms))
}

#[tauri::command]
pub fn nightshift_cancel_launch(app: AppHandle, project_id: String) -> Result<(), String> {
    drop_pending(&app, &project_id)
}

#[tauri::command]
pub fn nightshift_pending_launch(
    pending: State<'_, PendingLaunches>,
    project_id: String,
) -> Result<Option<PendingView>, String> {
    Ok(pending
        .0
        .lock()
        .map_err(|_| "pending table poisoned".to_string())?
        .get(&project_id)
        .map(|p| PendingView {
            fire_at_ms: p.fire_at_ms,
            shift_id: p.plan.shift_id.clone(),
            items: p.plan.items.iter().filter(|i| i.selected).count(),
        }))
}

/// The usage reading the runner's gate uses — `python3 bin/usagectl.py
/// --json` in the runner root, one probe for both — as its JSON. The Plan
/// screen's "when usage resets" needs `five_hour_resets_at`. An error is a
/// string: the script missing, python missing, or unparseable output.
#[tauri::command]
pub async fn nightshift_usage(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<serde_json::Value, String> {
    let root = root_of(&state, &project_id).await?;
    blocking(move || -> Result<serde_json::Value, String> {
        let runner = launch::runner_root(&root.root, &root.config);
        let script = runner.join("bin").join("usagectl.py");
        if !script.is_file() {
            return Err(format!("no usage probe at {}", script.display()));
        }
        let out = std::process::Command::new("python3")
            .arg(&script)
            .arg("--json")
            .current_dir(&runner)
            .output()
            .map_err(|e| format!("could not run usagectl.py: {e}"))?;
        let text = String::from_utf8_lossy(&out.stdout);
        // usagectl prints warnings before the JSON; the object starts at `{`.
        let json = text.find('{').map(|i| &text[i..]).unwrap_or("");
        serde_json::from_str(json).map_err(|e| {
            format!(
                "usagectl.py --json did not parse: {e}: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            )
        })
    })
    .await
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
    fn iso_of_ms_is_utc_civil_time() {
        assert_eq!(iso_of_ms(0), "1970-01-01T00:00:00Z");
        // 2026-09-12T12:10:00Z — the 5h window's reset the night this was written.
        assert_eq!(iso_of_ms(1_789_215_000_000), "2026-09-12T12:10:00Z");
        // A leap day.
        assert_eq!(iso_of_ms(1_709_164_800_000), "2024-02-29T00:00:00Z");
    }

    #[test]
    fn a_timed_plan_is_re_minted_stamped_and_refused_while_live() {
        let ws = std::env::temp_dir().join(format!("nightloom-timed-plan-{}", std::process::id()));
        let _ = fs::remove_dir_all(&ws);
        let root = root_at(&ws, None);
        let draft: Plan = serde_json::from_value(serde_json::json!({
            "shift_id": "2026-09-12T00-29-06",
            "created": "2026-09-12T00:29:06",
            "items": [{"id": "017", "selected": true}],
            "max_units": 1
        }))
        .unwrap();
        let (shift_id, path) = prepare_timed_plan(&root.root, &draft, 1_789_215_000_000).unwrap();
        // The id is the moment of launch, not the moment the screen was opened.
        assert_ne!(shift_id, "2026-09-12T00-29-06");
        assert_eq!(path, format!("shifts/{shift_id}/plan.json"));
        let on_disk = shifts::read_plan(&root.root, &shift_id).unwrap();
        assert_eq!(on_disk.extra["scheduled_for"], "2026-09-12T12:10:00Z");
        assert!(
            !on_disk.created.is_empty(),
            "write_plan stamps created afresh"
        );
        assert_eq!(on_disk.max_units, Some(1));
        assert_eq!(on_disk.items.len(), 1);
        // A live lock (this test's own pid) refuses the write, so a shift
        // already running when a timer fires yields an error, not a second runner.
        fs::create_dir_all(root.root.join("state")).unwrap();
        fs::write(
            root.root.join("state/run.lock"),
            std::process::id().to_string(),
        )
        .unwrap();
        let err = prepare_timed_plan(&root.root, &draft, 1_789_215_000_000).unwrap_err();
        assert!(err.contains("live"), "{err}");
        let _ = fs::remove_dir_all(&ws);
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

// ---- the intake interview (item 005) ---------------------------------------
//
// One interview per project, in memory, on the Claude Code engine — the
// subscription path the units run on. The pure part (prompt, the final
// answer's shape, the files) is `nightloom_service::nightshift::interview`;
// this is the conversation: a session the engine resumes turn by turn, the
// transcript, and the stream of deltas the window renders.

use nightloom_service::TurnEvent;
use nightloom_service::agent::{AgentSpec, ClaudeCodeAgent};
use nightloom_service::nightshift::interview;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

pub struct Interview {
    agent: ClaudeCodeAgent,
    /// `(role, text)` — `user` / `assistant`, in order.
    messages: Vec<(String, String)>,
    /// One token for the interview's life: cancel ends the reply that is
    /// streaming and the interview with it (start replaces, cancel forgets).
    cancel: CancellationToken,
}

/// The handle and its token side by side, so cancel never needs the
/// interview's own lock — which a streaming reply holds for the whole turn.
type Entry = (Arc<tokio::sync::Mutex<Interview>>, CancellationToken);

#[derive(Default)]
pub struct Interviews(std::sync::Mutex<HashMap<String, Entry>>);

/// What the window sees of an interview.
#[derive(Serialize, Clone)]
pub struct InterviewView {
    pub messages: Vec<InterviewMessage>,
    pub model: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct InterviewMessage {
    pub role: String,
    pub text: String,
}

/// One `nightshift-interview` window event: a delta of the interviewer's
/// reply, or the turn's end.
#[derive(Serialize, Clone)]
pub struct InterviewEvent {
    pub project_id: String,
    /// `delta` | `done` | `error`
    pub kind: String,
    pub text: String,
}

fn interview_of(
    app: &AppHandle,
    project_id: &str,
) -> Result<Arc<tokio::sync::Mutex<Interview>>, String> {
    app.state::<Interviews>()
        .0
        .lock()
        .map_err(|_| "interview table poisoned".to_string())?
        .get(project_id)
        .map(|(iv, _)| iv.clone())
        .ok_or_else(|| "no interview in progress; start one".to_string())
}

fn view_of(iv: &Interview) -> InterviewView {
    InterviewView {
        messages: iv
            .messages
            .iter()
            .map(|(role, text)| InterviewMessage {
                role: role.clone(),
                text: text.clone(),
            })
            .collect(),
        model: iv.agent.resolved_model().map(String::from),
    }
}

/// Run one turn: stream the reply as deltas, record both sides. The
/// interview's own lock is held for the turn — a second send while one
/// streams waits its turn rather than interleaving two replies.
async fn interview_turn(
    app: &AppHandle,
    project_id: &str,
    iv: &Arc<tokio::sync::Mutex<Interview>>,
    text: &str,
) -> Result<String, String> {
    let mut g = iv.lock().await;
    g.messages.push(("user".into(), text.to_string()));
    let cancel = g.cancel.clone();
    let mut streamed = String::new();
    let pid = project_id.to_string();
    let handle = app.clone();
    let mut on_event = |e: TurnEvent| {
        if let TurnEvent::TextDelta { text } = e {
            streamed.push_str(&text);
            let _ = handle.emit(
                "nightshift-interview",
                InterviewEvent {
                    project_id: pid.clone(),
                    kind: "delta".into(),
                    text,
                },
            );
        }
    };
    let result = g.agent.run_turn(text, &cancel, &mut on_event).await;
    let reply = match result {
        Ok(outcome) => {
            if outcome.is_error {
                // The session stays where it was: a turn the API refused
                // (the safeguards classifier does this to ordinary text)
                // opened no conversation worth continuing, and adopting
                // its id would orphan the one that has the questions.
                let msg = if outcome.text.is_empty() {
                    outcome.notices.join("; ")
                } else {
                    outcome.text.clone()
                };
                let _ = app.emit(
                    "nightshift-interview",
                    InterviewEvent {
                        project_id: pid.clone(),
                        kind: "error".into(),
                        text: msg.clone(),
                    },
                );
                // Neither side of a refused turn is kept: the session did
                // not see it, so the transcript must not claim it did.
                g.messages.pop();
                return Err(msg);
            }
            // Adopt the session so the next turn continues it — without
            // this every turn is a fresh conversation (found on the first
            // real interview, 2026-09-13: "I don't have our earlier
            // exchange in this session").
            g.agent.follow_on(&outcome);
            if outcome.text.is_empty() {
                streamed
            } else {
                outcome.text
            }
        }
        Err(e) => {
            let msg = e.to_string();
            let _ = app.emit(
                "nightshift-interview",
                InterviewEvent {
                    project_id: pid.clone(),
                    kind: "error".into(),
                    text: msg.clone(),
                },
            );
            g.messages.pop();
            return Err(msg);
        }
    };
    g.messages.push(("assistant".into(), reply.clone()));
    let _ = app.emit(
        "nightshift-interview",
        InterviewEvent {
            project_id: pid,
            kind: "done".into(),
            text: reply.clone(),
        },
    );
    Ok(reply)
}

/// Begin an interview with the idea as the first message. Replaces one in
/// progress on the same project. `model` is a CLI alias (`opus`) or an id;
/// the default is the runner's own work model.
#[tauri::command]
pub async fn nightshift_interview_start(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    idea: String,
    model: Option<String>,
) -> Result<InterviewView, String> {
    if idea.trim().is_empty() {
        return Err("describe the idea first".into());
    }
    let root = root_of(&state, &project_id).await?;
    let mut spec = AgentSpec::new(&root.root);
    spec.model = Some(model.unwrap_or_else(|| "opus".into()));
    // No tools: the interviewer talks, it does not read or edit the tree.
    spec.tools = Some(vec![]);
    spec.system_prompt = Some(interview::prompt(&root.root));
    spec.safe_mode = true;
    let cancel = CancellationToken::new();
    let iv = Arc::new(tokio::sync::Mutex::new(Interview {
        agent: ClaudeCodeAgent::new(spec),
        messages: Vec::new(),
        cancel: cancel.clone(),
    }));
    {
        let interviews = app.state::<Interviews>();
        let mut table = interviews
            .0
            .lock()
            .map_err(|_| "interview table poisoned".to_string())?;
        if let Some((_, old)) = table.insert(project_id.clone(), (iv.clone(), cancel)) {
            old.cancel();
        }
    }
    interview_turn(&app, &project_id, &iv, &idea).await?;
    let g = iv.lock().await;
    Ok(view_of(&g))
}

/// Swaraag's answer; the interviewer's next questions come back as deltas
/// then `done`.
#[tauri::command]
pub async fn nightshift_interview_send(
    app: AppHandle,
    project_id: String,
    text: String,
) -> Result<InterviewView, String> {
    if text.trim().is_empty() {
        return Err("nothing to send".into());
    }
    let iv = interview_of(&app, &project_id)?;
    interview_turn(&app, &project_id, &iv, &text).await?;
    let g = iv.lock().await;
    Ok(view_of(&g))
}

/// The interview as it stands, for a screen that comes back to it.
#[tauri::command]
pub async fn nightshift_interview_state(
    app: AppHandle,
    project_id: String,
) -> Result<Option<InterviewView>, String> {
    let iv = {
        let interviews = app.state::<Interviews>();
        let table = interviews
            .0
            .lock()
            .map_err(|_| "interview table poisoned".to_string())?;
        table.get(&project_id).map(|(iv, _)| iv.clone())
    };
    let Some(iv) = iv else {
        return Ok(None);
    };
    let g = iv.lock().await;
    Ok(Some(view_of(&g)))
}

/// Stop the reply that is streaming (if any) and forget the interview.
#[tauri::command]
pub fn nightshift_interview_cancel(app: AppHandle, project_id: String) -> Result<(), String> {
    let removed = app
        .state::<Interviews>()
        .0
        .lock()
        .map_err(|_| "interview table poisoned".to_string())?
        .remove(&project_id);
    if let Some((_, cancel)) = removed {
        cancel.cancel();
    }
    Ok(())
}

#[derive(Serialize, Clone)]
pub struct InterviewWritten {
    pub id: String,
    pub title: String,
    pub kind: String,
}

/// Close the interview: ask for the item, write it as `backlog/<id>-<slug>.md`
/// with the transcript beside it, and forget the conversation. Refused while
/// a shift is live (through `new_item`). The written file is shown for
/// editing by the caller — nothing here is final.
#[tauri::command]
pub async fn nightshift_interview_write(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
) -> Result<InterviewWritten, String> {
    let root = root_of(&state, &project_id).await?;
    launch::ensure_not_live(&root.root)?;
    let iv = interview_of(&app, &project_id)?;
    let reply = interview_turn(&app, &project_id, &iv, interview::WRITE_INSTRUCTION).await?;
    let draft = interview::parse_item(&reply);
    let messages = iv.lock().await.messages.clone();
    let title = draft.title.clone();
    let kind = draft.kind.clone();
    let id = blocking({
        let root = root.root.clone();
        move || interview::create_item(&root, &draft, &messages)
    })
    .await?;
    let _ = nightshift_interview_cancel(app.clone(), project_id);
    Ok(InterviewWritten { id, title, kind })
}
