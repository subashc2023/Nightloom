//! Home on the Mac (nightshift item 763, H1–H3): the project registered at
//! launch, its built-in morning scan, and the four commands the window
//! reads Home through. The folder, the feed and the scan are the
//! service's (`nightloom_service::home`).

use nightloom_service::home;
use nightloom_service::project::{self, Registry};
use serde::Serialize;
use tauri::AppHandle;

/// The registry at launch, with Home in it (made once; a registry that may
/// not be saved this run is left as it is), and every claude.ai import that
/// had no folder given one in the projects folder (item 1017) — before the
/// window reads the list.
pub(crate) fn registry_with_home() -> Registry {
    let mut r = Registry::load();
    if let Some(config) = project::config_dir() {
        let folder = project::projects_folder_at(&config, &r);
        for line in r.give_imports_folders(&folder) {
            eprintln!("nightloom: {line}");
        }
        let _ = home::ensure_project(&mut r, &config);
    }
    r
}

#[derive(Serialize)]
pub(crate) struct HomeInfo {
    project_id: String,
    chat_id: Option<String>,
    folder: String,
    brief: String,
    scan_words: String,
    scan_job_id: Option<String>,
}

/// Home's project, chat, folder, brief and scan time. Makes the built-in
/// scan job when the Mac keeps jobs and has none yet. Through the app's
/// own registry (the review's finding: a second copy read from disk could
/// register Home behind the app's back, and the app's next save would drop
/// it).
#[tauri::command]
pub(crate) async fn home_info(
    app: AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> Result<HomeInfo, String> {
    let config = project::config_dir().ok_or("no Nightloom home")?;
    let project_id = {
        let mut ws = state.workspaces.lock().await;
        home::ensure_project(&mut ws.registry, &config)?
    };
    let jobs = crate::remote::jobs_store(&app);
    if let Some(j) = &jobs {
        j.ensure_home_scan(&project_id, chrono::Utc::now());
    }
    let scan = jobs.and_then(|j| j.list().into_iter().find(|v| v.job.id == home::SCAN_JOB_ID));
    Ok(HomeInfo {
        project_id,
        chat_id: scan.as_ref().and_then(|v| v.job.chat.clone()),
        folder: home::dir_in(&config).to_string_lossy().into_owned(),
        brief: home::read_brief(&config),
        scan_words: scan
            .as_ref()
            .map_or_else(|| "Every day at 8:00 AM".into(), |v| v.every_words.clone()),
        scan_job_id: scan.map(|v| v.job.id),
    })
}

/// Item 763 H6: what Home's unattended runs used of the week today, its
/// cap, and why they are paused now — the Home row's figure.
#[tauri::command]
pub(crate) async fn home_today() -> Result<home::guard::Today, String> {
    crate::blocking(|| {
        let config = project::config_dir().ok_or("no Nightloom home")?;
        // Max age: on hand (954) — Home's row shows the figure and why it is
        // paused; the guard that decides refreshes first (951).
        let plan =
            nightloom_service::plan_usage::current(nightloom_service::plan_usage::MaxAge::OnHand);
        let now = chrono::Utc::now();
        let pace = home::guard::pace_in(&config, now);
        Ok::<_, String>(home::guard::today(
            &config,
            Some(&plan),
            Some(&pace),
            chrono::Local::now().date_naive(),
        ))
    })
    .await
}

#[derive(Serialize)]
pub(crate) struct HomeFeed {
    rows: Vec<home::FeedRow>,
    seen_at: Option<String>,
}

/// The feed, newest first, at most `limit` rows (200 when not given).
#[tauri::command]
pub(crate) fn home_feed(limit: Option<usize>) -> Result<HomeFeed, String> {
    let config = project::config_dir().ok_or("no Nightloom home")?;
    let mut rows = home::read_feed(&config);
    rows.reverse();
    rows.truncate(limit.unwrap_or(200));
    Ok(HomeFeed {
        rows,
        seen_at: home::seen_at(&config).map(|t| t.to_rfc3339()),
    })
}

/// "Mark all seen": the new seen time.
#[tauri::command]
pub(crate) fn home_mark_seen() -> Result<String, String> {
    let config = project::config_dir().ok_or("no Nightloom home")?;
    let now = chrono::Utc::now();
    home::mark_seen(&config, now)?;
    Ok(now.to_rfc3339())
}

/// Item 763 H5: the Start cards waiting for his tap, and the chats Home
/// started (the sidebar's mark).
#[tauri::command]
pub(crate) async fn home_routes(
    app: tauri::AppHandle,
) -> Result<nightloom_service::remote::RoutesReply, String> {
    crate::remote::home_routes(&app).await
}

/// His tap on a Start card: the prompt as he left it, and his pick
/// (`new` | `into`) on a cold card.
#[tauri::command]
pub(crate) async fn home_route_start(
    app: tauri::AppHandle,
    id: String,
    prompt: Option<String>,
    pick: Option<home::route::Pick>,
) -> Result<home::route::Route, String> {
    crate::remote::home_route_start(&app, &id, prompt.as_deref(), pick).await
}

/// His Dismiss on a Start card: nothing starts; the ledger keeps the line.
#[tauri::command]
pub(crate) fn home_route_dismiss(id: String) -> Result<home::route::Route, String> {
    let config = project::config_dir().ok_or("no Nightloom home")?;
    home::route::dismiss(&config, &id, chrono::Utc::now())
}

/// Save his brief from Settings → Home.
#[tauri::command]
pub(crate) fn home_save_brief(text: String) -> Result<(), String> {
    let config = project::config_dir().ok_or("no Nightloom home")?;
    home::save_brief(&config, &text)
}

/// Item 804: what Home can reach — every connector of the last check as a
/// row (per account), what macOS keeps that Home does not read, and when
/// the check ran.
#[derive(Serialize)]
pub(crate) struct HomeReach {
    checked_at: Option<String>,
    error: Option<String>,
    accounts: Vec<home::reach::Account>,
    locals: Vec<home::reach::Local>,
}

fn reach_of(config: &std::path::Path) -> HomeReach {
    let reach = home::reach::load(config);
    HomeReach {
        checked_at: reach.checked_at.map(|t| t.to_rfc3339()),
        error: reach.error,
        accounts: home::reach::accounts(config),
        locals: home::reach::locals(),
    }
}

/// The last check's rows; no request, nothing run.
#[tauri::command]
pub(crate) fn home_reach() -> Result<HomeReach, String> {
    let config = project::config_dir().ok_or("no Nightloom home")?;
    Ok(reach_of(&config))
}

/// Ask Claude Code what it reaches now (`claude mcp list`: no model
/// request, up to a minute and a half), keep it, and return the rows.
#[tauri::command]
pub(crate) async fn home_reach_check(binary: Option<String>) -> Result<HomeReach, String> {
    let config = project::config_dir().ok_or("no Nightloom home")?;
    let bin = crate::commands::cli::cli_binary(binary);
    tokio::task::spawn_blocking(move || {
        home::reach::check(&config, &bin, chrono::Utc::now());
        reach_of(&config)
    })
    .await
    .map_err(|e| format!("the check did not finish: {e}"))
}

/// Item 845: Watch's per-source Check now — ask Claude Code about one
/// connector (`claude mcp get`: no model request), keep it, return the rows.
#[tauri::command]
pub(crate) async fn home_reach_check_one(
    connector: String,
    binary: Option<String>,
) -> Result<HomeReach, String> {
    let config = project::config_dir().ok_or("no Nightloom home")?;
    let bin = crate::commands::cli::cli_binary(binary);
    tokio::task::spawn_blocking(move || {
        home::reach::check_one(&config, &bin, &connector, chrono::Utc::now())?;
        Ok(reach_of(&config))
    })
    .await
    .map_err(|e| format!("the check did not finish: {e}"))?
}

/// Turn one of his connectors on or off for Home; the rows after.
#[tauri::command]
pub(crate) fn home_reach_set(connector: String, on: bool) -> Result<HomeReach, String> {
    let config = project::config_dir().ok_or("no Nightloom home")?;
    home::reach::set_on(&config, &connector, on)?;
    Ok(reach_of(&config))
}

/// Item 845: the tasks on Home's stage, oldest first.
#[tauri::command]
pub(crate) fn home_tasks() -> Result<Vec<home::tasks::Task>, String> {
    let config = project::config_dir().ok_or("no Nightloom home")?;
    Ok(home::tasks::read(&config, chrono::Utc::now()))
}

/// Item 845: one click of his on the stage that Home should know (a
/// "kind B" control) — a line Home reads at its next look.
#[tauri::command]
pub(crate) fn home_task_event(task: String, view: String, line: String) -> Result<(), String> {
    let config = project::config_dir().ok_or("no Nightloom home")?;
    home::tasks::record(&config, &task, &view, &line, chrono::Utc::now())
}

/// Item 845 (846 §7 step 3): the view in focus on the stage, for the
/// header on his next message to Home.
#[tauri::command]
pub(crate) fn home_stage_focus(view: String, task: Option<String>) -> Result<(), String> {
    let config = project::config_dir().ok_or("no Nightloom home")?;
    home::tasks::set_focus(
        &config,
        &view,
        task.as_deref().unwrap_or(""),
        chrono::Utc::now(),
    )
}

/// Item 845: his × on a task's tab. The work is not stopped by this.
#[tauri::command]
pub(crate) fn home_task_close(id: String) -> Result<(), String> {
    let config = project::config_dir().ok_or("no Nightloom home")?;
    home::tasks::close(&config, &id, chrono::Utc::now())
}
