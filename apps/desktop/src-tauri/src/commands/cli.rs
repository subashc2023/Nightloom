//! Claude Code CLI commands: the version check, auth status and update (moved from main.rs, item 642).

#[allow(unused_imports)]
use crate::*;

/// The CLI a version check or an update is about: the connected chat's
/// resolved binary when the front end passes it, else `claude` resolved
/// the way a connect resolves it.
pub(crate) fn cli_binary(binary: Option<String>) -> std::path::PathBuf {
    let b = binary
        .filter(|b| !b.trim().is_empty())
        .unwrap_or_else(|| "claude".to_string());
    std::path::PathBuf::from(nightloom_service::resolve_binary(&b))
}

/// Claude Code's version against the release feed, with the models the
/// newer release adds (nightshift backlog 182). Zero tokens:
/// `claude --version` and two GETs. The front end asks at launch and
/// every six hours, never while a turn runs.
#[tauri::command]
pub(crate) async fn cli_version_check(
    binary: Option<String>,
) -> Result<nightloom_service::cli_update::CliStatus, String> {
    Ok(nightloom_service::cli_update::check(&cli_binary(binary)).await)
}

/// Whether Claude Code is signed in (nightshift backlog 409), for the
/// engine chip, and the absolute path of the CLI the Sign in button types
/// `auth login` after. `loggedIn` alone is read; the account's details the
/// command also prints are never kept or shown. Zero tokens.
#[tauri::command]
pub(crate) async fn claude_auth_status(
    binary: Option<String>,
) -> Result<nightloom_service::cli_auth::AuthStatus, String> {
    let b = binary
        .filter(|b| !b.trim().is_empty())
        .unwrap_or_else(|| "claude".to_string());
    let bin = nightloom_service::cli_auth::absolute_binary(&b);
    Ok(nightloom_service::cli_auth::status(&bin).await)
}

/// One `claude update` at a time, whatever asks.
pub(crate) static CLI_UPDATING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Run the CLI's own updater (nightshift backlog 182). The front end calls
/// it only at a cold moment — no turn running and every open chat's cache
/// expired — or on "now" after showing what it costs.
#[tauri::command]
pub(crate) async fn cli_update(
    binary: Option<String>,
) -> Result<nightloom_service::cli_update::UpdateResult, String> {
    use std::sync::atomic::Ordering;
    if CLI_UPDATING.swap(true, Ordering::SeqCst) {
        return Err("an update of Claude Code is already running".into());
    }
    let bin = cli_binary(binary);
    let r = tokio::task::spawn_blocking(move || {
        nightloom_service::cli_update::run_update(
            &bin,
            None,
            std::time::Duration::from_secs(10 * 60),
        )
    })
    .await;
    CLI_UPDATING.store(false, Ordering::SeqCst);
    r.map_err(|e| format!("running claude update failed: {e}"))
}
