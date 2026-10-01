//! The Mac's half of the away-server sync (nightshift item 268 step 3):
//! Settings → "Away server", and the background pass that pushes the
//! snapshot up and pulls server chats down (`nightloom_service::sync`).
//!
//! When it runs: ~10 s after launch, every [`INTERVAL`] while the app is
//! open (the Mac is awake by definition), when he presses Sync now, and at
//! quit — a push only, given at most [`QUIT_BUDGET`] (best effort; a slow
//! uplink is cut off and the next launch catches up). The interval and the
//! quit push are his to change (blocker 770).
//!
//! Off until he pastes the server's URL into the card. The token is read
//! from `~/.nightloom/remote/away-token` (his step-2 session writes it) at
//! each pass and goes only into the request's `Authorization` header; the
//! card is told "token found" or "no token", never the value.
//!
//! One writer per file: this module alone writes `~/.nightloom/away.json`
//! (the URL and the last pass's times and error); the "available away"
//! mark is written through the app's own registry (`AppState`), never a
//! second `Registry` (two writers of `projects.json` would lose a mark).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use nightloom_service::project;
use nightloom_service::sync::{self, Client, pull, push};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::AppState;

/// How often the pass runs while the app is open (blocker 770's default).
pub const INTERVAL: Duration = Duration::from_secs(15 * 60);
/// The wait after launch before the first pass, so it does not compete
/// with the window's first paint.
const FIRST_PASS_AFTER: Duration = Duration::from_secs(10);
/// The most a quit waits for its push (blocker 770's default).
pub const QUIT_BUDGET: Duration = Duration::from_secs(5);

/// What is kept on disk: `~/.nightloom/away.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Saved {
    /// The server's URL; empty = sync off.
    #[serde(default)]
    url: String,
    #[serde(default)]
    last_push: Option<DateTime<Utc>>,
    #[serde(default)]
    last_pull: Option<DateTime<Utc>>,
    /// The last pass's failure, in words; cleared by a pass that succeeds.
    #[serde(default)]
    last_error: Option<String>,
    /// The last pass's result in a line ("12 files, 2 sent; 1 chat came down").
    #[serde(default)]
    last_summary: Option<String>,
}

/// The managed state.
pub struct Away {
    saved: Mutex<Saved>,
    /// One pass at a time; Sync now waits for a running one.
    pass: tokio::sync::Mutex<()>,
    /// Wakes the loop early (a URL just set).
    kick: tokio::sync::Notify,
    /// Hashes of earlier pushes, so a pass reads only what changed.
    cache: Arc<Mutex<push::PushCache>>,
    running: std::sync::atomic::AtomicBool,
}

fn config() -> Option<PathBuf> {
    project::config_dir()
}

fn saved_path() -> Option<PathBuf> {
    config().map(|c| c.join("away.json"))
}

fn read_saved() -> Saved {
    saved_path()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default()
}

impl Away {
    fn saved(&self) -> Saved {
        self.saved.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn update(&self, f: impl FnOnce(&mut Saved)) {
        let mut s = self.saved.lock().unwrap_or_else(|p| p.into_inner());
        f(&mut s);
        if let (Some(path), Ok(body)) = (saved_path(), serde_json::to_vec_pretty(&*s)) {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(path, body);
        }
    }
}

/// One project row on the card.
#[derive(Debug, Clone, Serialize)]
pub struct AwayProject {
    pub id: String,
    pub name: String,
    pub available: bool,
}

/// What the card shows.
#[derive(Debug, Clone, Serialize)]
pub struct AwayStatus {
    /// Empty = sync off.
    pub url: String,
    /// Whether `~/.nightloom/remote/away-token` holds a token. Never the value.
    pub token_found: bool,
    /// Where the token is looked for, to tell him where to put it.
    pub token_path: String,
    pub running: bool,
    /// RFC 3339; the card writes them in 12-hour time.
    pub last_push: Option<String>,
    pub last_pull: Option<String>,
    pub last_error: Option<String>,
    pub last_summary: Option<String>,
    pub interval_minutes: u64,
    pub projects: Vec<AwayProject>,
}

async fn status_of(app: &AppHandle) -> AwayStatus {
    let away = app.state::<Away>();
    let s = away.saved();
    let projects = {
        let state = app.state::<AppState>();
        let guard = state.workspaces.lock().await;
        guard.registry.projects()
    };
    let (token_found, token_path) = match config() {
        Some(c) => (
            sync::read_away_token(&c).is_some(),
            sync::away_token_path(&c).display().to_string(),
        ),
        None => (false, "~/.nightloom/remote/away-token".into()),
    };
    AwayStatus {
        url: s.url,
        token_found,
        token_path,
        running: away.running.load(std::sync::atomic::Ordering::SeqCst),
        last_push: s.last_push.map(|t| t.to_rfc3339()),
        last_pull: s.last_pull.map(|t| t.to_rfc3339()),
        last_error: s.last_error,
        last_summary: s.last_summary,
        interval_minutes: INTERVAL.as_secs() / 60,
        projects: projects
            .into_iter()
            .filter(|p| !p.is_unfiled_holder())
            .map(|p| AwayProject {
                id: p.id,
                name: p.name,
                available: p.available_away,
            })
            .collect(),
    }
}

/// Manage the state and start the loop. Called once from `setup`, after
/// `AppState` is managed.
pub fn start(app: &AppHandle) {
    app.manage(Away {
        saved: Mutex::new(read_saved()),
        pass: tokio::sync::Mutex::new(()),
        kick: tokio::sync::Notify::new(),
        cache: Arc::new(Mutex::new(push::PushCache::default())),
        running: std::sync::atomic::AtomicBool::new(false),
    });
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_PASS_AFTER).await;
        loop {
            let _ = run_pass(&app, true).await;
            let away = app.state::<Away>();
            tokio::select! {
                _ = tokio::time::sleep(INTERVAL) => {}
                _ = away.kick.notified() => {}
            }
        }
    });
}

/// At quit (`RunEvent::Exit`): one push, waited for at most
/// [`QUIT_BUDGET`]. Nothing is pulled — a chat placed while the app closes
/// would only be found at the next launch anyway, and the next pass pulls it.
pub fn on_exit(app: &AppHandle) {
    if app.try_state::<Away>().is_none() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::block_on(async move {
        let _ = tokio::time::timeout(QUIT_BUDGET, run_pass(&app, false)).await;
    });
}

/// One pass: push, then (when `pull_too`) pull. Off (no URL) does nothing.
/// The outcome lands in `away.json` for the card.
async fn run_pass(app: &AppHandle, pull_too: bool) -> Result<(), String> {
    let away = app.state::<Away>();
    let _one = away.pass.lock().await;
    let url = away.saved().url;
    if url.trim().is_empty() {
        return Ok(());
    }
    away.running
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let outcome = pass(app, &away, &url, pull_too).await;
    away.running
        .store(false, std::sync::atomic::Ordering::SeqCst);
    match &outcome {
        Ok(summary) => away.update(|s| {
            s.last_error = None;
            s.last_summary = Some(summary.clone());
        }),
        Err(e) => away.update(|s| s.last_error = Some(e.clone())),
    }
    outcome.map(|_| ())
}

async fn pass(app: &AppHandle, away: &Away, url: &str, pull_too: bool) -> Result<String, String> {
    let config = config().ok_or("no home folder, so no ~/.nightloom to sync")?;
    let token = sync::read_away_token(&config).ok_or_else(|| {
        format!(
            "no token at {} — the away server's deploy writes it",
            sync::away_token_path(&config).display()
        )
    })?;
    let client = Client::new(url, &token)?;
    let projects = {
        let state = app.state::<AppState>();
        let guard = state.workspaces.lock().await;
        guard.registry.projects()
    };

    // Up.
    let snap = push::MacSnapshot {
        vault: nightloom_service::knowledge::vault_dir_in(&config),
        config: config.clone(),
        projects: projects
            .iter()
            .filter(|p| p.available_away)
            .cloned()
            .collect(),
        claude_projects: nightloom_service::agent::cli_session::projects_dir()
            .unwrap_or_else(|| config.join("claude")),
    };
    let cache = away.cache.clone();
    let (outgoing, skipped) = crate::blocking(move || {
        let mut cache = cache.lock().unwrap_or_else(|p| p.into_inner());
        let mut skipped = Vec::new();
        let out = push::collect(&snap, &mut cache, &mut skipped);
        Ok::<_, String>((out, skipped))
    })
    .await?;
    let pushed = push::send(&client, outgoing, skipped).await?;
    away.update(|s| s.last_push = Some(Utc::now()));
    let mut summary = format!(
        "{} file{} up to date, {} sent",
        pushed.files,
        if pushed.files == 1 { "" } else { "s" },
        pushed.sent
    );
    if pushed.removed > 0 {
        summary.push_str(&format!(", {} dropped from the server", pushed.removed));
    }
    if !pushed.skipped.is_empty() {
        summary.push_str(&format!(", {} could not be read", pushed.skipped.len()));
    }
    if !pull_too {
        return Ok(summary);
    }

    // Down.
    let mac = pull::mac_side(&config, projects);
    let pulled = pull::run(&client, &mac).await?;
    away.update(|s| s.last_pull = Some(Utc::now()));
    let n = pulled.placed.len();
    summary.push_str(&format!(
        "; {n} chat{} came down from the server",
        if n == 1 { "" } else { "s" }
    ));
    if let Some(first) = pulled.skipped.first() {
        return Err(format!(
            "{summary}; {} left on the server: {first}",
            pulled.skipped.len()
        ));
    }
    Ok(summary)
}

/// The card's read.
#[tauri::command]
pub async fn away_status(app: AppHandle) -> Result<AwayStatus, String> {
    Ok(status_of(&app).await)
}

/// Set the server's URL (empty switches sync off). A URL that is set
/// starts a pass at once.
#[tauri::command]
pub async fn away_set_url(
    app: AppHandle,
    away: State<'_, Away>,
    url: String,
) -> Result<AwayStatus, String> {
    let url = url.trim().trim_end_matches('/').to_string();
    if !url.is_empty() && !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("the address must start with https://".into());
    }
    away.update(|s| {
        s.url = url.clone();
        if url.is_empty() {
            s.last_error = None;
        }
    });
    if !url.is_empty() {
        away.kick.notify_one();
    }
    Ok(status_of(&app).await)
}

/// Sync now: a whole pass, waited for; the card gets the outcome.
#[tauri::command]
pub async fn away_sync_now(app: AppHandle) -> Result<AwayStatus, String> {
    if app.state::<Away>().saved().url.trim().is_empty() {
        return Err("paste the away server's address first".into());
    }
    let _ = run_pass(&app, true).await;
    Ok(status_of(&app).await)
}

/// Mark a project "available away", or unmark it — through the app's own
/// registry. Unmarking takes effect at the next pass, which drops the
/// server's copies of it.
#[tauri::command]
pub async fn away_set_project(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    on: bool,
) -> Result<AwayStatus, String> {
    {
        let mut guard = state.workspaces.lock().await;
        let project = guard.registry.set_available_away(&id, on)?;
        if guard.active.as_ref().is_some_and(|p| p.id == id) {
            guard.active = Some(project);
        }
    }
    Ok(status_of(&app).await)
}
