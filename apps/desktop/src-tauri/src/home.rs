//! Home on the Mac (nightshift item 763, H1–H3): the project registered at
//! launch, its built-in morning scan, and the four commands the window
//! reads Home through. The folder, the feed and the scan are the
//! service's (`nightloom_service::home`).

use nightloom_service::home;
use nightloom_service::project::{self, Registry};
use serde::Serialize;
use tauri::AppHandle;

/// The registry at launch, with Home in it (made once; a registry that may
/// not be saved this run is left as it is).
pub(crate) fn registry_with_home() -> Registry {
    let mut r = Registry::load();
    if let Some(config) = project::config_dir() {
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
/// scan job when the Mac keeps jobs and has none yet.
#[tauri::command]
pub(crate) fn home_info(app: AppHandle) -> Result<HomeInfo, String> {
    let config = project::config_dir().ok_or("no Nightloom home")?;
    let mut r = Registry::load();
    let project_id = home::ensure_project(&mut r, &config)?;
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

/// Save his brief from Settings → Home.
#[tauri::command]
pub(crate) fn home_save_brief(text: String) -> Result<(), String> {
    let config = project::config_dir().ok_or("no Nightloom home")?;
    home::save_brief(&config, &text)
}
