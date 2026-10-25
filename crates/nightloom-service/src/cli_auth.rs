//! Claude Code's sign-in (nightshift backlog 409, 2026-10-24).
//!
//! He saw a turn end with *No reply: Failed to authenticate: OAuth session
//! expired and could not be refreshed*, and no way out of it from the app.
//! This module is what Nightloom knows about the CLI's sign-in:
//!
//! - [`is_sign_in_failure`]: whether a failure the CLI reported is its
//!   sign-in, so the turn's stop reason is marked (`SIGNED_OUT_REASON`) and
//!   the window offers Sign in.
//! - [`status`]: `claude auth status --json`, read for its `loggedIn` alone —
//!   the window's engine chip says signed in or out and nothing else (the
//!   command also prints the account's email and organisation; never kept,
//!   never shown).
//! - [`absolute_binary`]: the CLI Nightloom runs, as an absolute path, which
//!   the Sign in button types into a terminal tab (`<path> auth login`) so it
//!   does not depend on the shell's `PATH` — his zsh startup had been
//!   interrupted and `claude` was "command not found" there.
//!
//! The entry points, `external`, from `claude auth --help` on 2.1.310:
//! `auth login [--claudeai|--console|--sso|--email]`, `auth logout`,
//! `auth status [--json (default)|--text]`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

/// Whether a failure the CLI reported is its sign-in (backlog 409): Claude
/// Code is signed out and every turn will fail until it logs in again.
///
/// The shapes, `external`, read from the CLI's own transcripts on
/// 2.1.221–2.1.310 (2026-10-24): a main-thread synthetic assistant line with
/// `"error":"authentication_failed"`, `"isApiErrorMessage":true`, sometimes
/// `"apiErrorStatus":401`, and one of the texts *Not logged in · Please run
/// /login*, *Failed to authenticate. API Error: 401 OAuth access token has
/// expired. Re-authenticate to continue.*, *Failed to authenticate: OAuth
/// session expired and could not be refreshed*. The `error` code or the
/// status decides; the text is the backstop for a line, a `result` or a
/// startup failure's stderr that carries neither. Called only on what the
/// CLI flagged as a failure, never on the model's prose.
pub fn is_sign_in_failure(error: Option<&str>, status: Option<u16>, text: &str) -> bool {
    if error == Some("authentication_failed") || status == Some(401) {
        return true;
    }
    [
        "Failed to authenticate",
        "Not logged in",
        "Please run /login",
        "OAuth session expired",
        "OAuth access token has expired",
    ]
    .iter()
    .any(|p| text.contains(p))
}

/// The CLI's own login, after its path: `<binary> auth login`.
pub const LOGIN_ARGS: [&str; 2] = ["auth", "login"];

/// The configured binary resolved the way a connect resolves it
/// ([`crate::resolve_binary`]), then made absolute: a bare name that
/// resolved on `PATH` is looked up there. Unchanged when nothing resolves.
pub fn absolute_binary(binary: &str) -> PathBuf {
    let resolved = PathBuf::from(crate::resolve_binary(binary));
    if resolved.is_absolute() {
        return resolved;
    }
    if resolved.components().count() == 1
        && let Some(path) = std::env::var_os("PATH")
        && let Some(found) = std::env::split_paths(&path)
            .filter(|d| d.is_absolute())
            .map(|d| d.join(&resolved))
            .find(|p| p.is_file())
    {
        return found;
    }
    resolved
}

/// What the engine chip shows (backlog 409): the binary asked, and whether
/// it is signed in — `None` when the status could not be read (an older CLI
/// without `auth status`, a timeout, output that is not its JSON).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AuthStatus {
    pub binary: String,
    pub signed_in: Option<bool>,
    /// The home folder, where a Sign in tab opens when the chat has no
    /// folder of its own (an unfiled chat).
    pub home: Option<String>,
}

/// `loggedIn` from `claude auth status --json`'s output, and nothing else.
pub fn parse_status(stdout: &str) -> Option<bool> {
    let v: serde_json::Value = serde_json::from_str(stdout.trim()).ok()?;
    v.get("loggedIn")?.as_bool()
}

/// How long the status may take: 0.12 s measured on 2.1.310; a hung CLI
/// must not hold the chip.
const STATUS_LIMIT: Duration = Duration::from_secs(10);

/// Ask the CLI whether it is signed in. Zero tokens: a local read of its
/// stored credentials, by the CLI itself — Nightloom never opens them.
pub async fn status(binary: &Path) -> AuthStatus {
    let run = tokio::process::Command::new(binary)
        .args(["auth", "status", "--json"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let signed_in = match tokio::time::timeout(STATUS_LIMIT, run).await {
        Ok(Ok(out)) => parse_status(&String::from_utf8_lossy(&out.stdout)),
        _ => None,
    };
    AuthStatus {
        binary: binary.display().to_string(),
        signed_in,
        home: std::env::var("HOME").ok().filter(|h| !h.is_empty()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_failure_lines_the_cli_writes_are_sign_in_failures() {
        // Verbatim texts from the CLI's transcripts, 2.1.221–2.1.310.
        for text in [
            "Failed to authenticate: OAuth session expired and could not be refreshed",
            "Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.",
            "Not logged in · Please run /login",
        ] {
            assert!(is_sign_in_failure(None, None, text), "{text}");
            assert!(is_sign_in_failure(
                Some("authentication_failed"),
                None,
                text
            ));
        }
        assert!(is_sign_in_failure(Some("authentication_failed"), None, ""));
        assert!(is_sign_in_failure(None, Some(401), "API Error: 401"));
    }

    #[test]
    fn other_failures_are_not() {
        assert!(!is_sign_in_failure(
            Some("rate_limit"),
            Some(429),
            "You've hit your session limit · resets 11:50pm"
        ));
        assert!(!is_sign_in_failure(
            Some("unknown"),
            None,
            "API Error: Output blocked by content filtering policy"
        ));
        assert!(!is_sign_in_failure(
            None,
            Some(529),
            "API Error: Overloaded"
        ));
        assert!(!is_sign_in_failure(
            None,
            None,
            "the turn failed before any reply arrived"
        ));
    }

    #[test]
    fn the_status_is_logged_in_alone() {
        let out =
            r#"{"loggedIn":true,"authMethod":"claude.ai","email":"x@example.org","orgName":"o"}"#;
        assert_eq!(parse_status(out), Some(true));
        assert_eq!(parse_status(r#"{"loggedIn":false}"#), Some(false));
        assert_eq!(parse_status("Not logged in"), None);
        assert_eq!(parse_status(r#"{"other":1}"#), None);
        assert_eq!(parse_status(""), None);
    }

    #[cfg(unix)]
    #[test]
    fn an_absolute_path_stays_and_a_bare_name_on_path_is_made_absolute() {
        assert_eq!(
            absolute_binary("/opt/x/claude"),
            PathBuf::from("/opt/x/claude")
        );
        // `sh` is on every Unix PATH.
        let sh = absolute_binary("sh");
        assert!(sh.is_absolute(), "{}", sh.display());
        assert!(sh.ends_with("sh"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn status_reads_a_stand_in_cli() {
        let dir = std::env::temp_dir().join(format!("nightloom-409-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("claude");
        std::fs::write(
            &bin,
            "#!/bin/sh\n[ \"$1 $2 $3\" = \"auth status --json\" ] && printf '%s\\n' '{\"loggedIn\":false,\"authMethod\":\"none\"}'\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let s = status(&bin).await;
        assert_eq!(s.signed_in, Some(false));
        assert_eq!(s.binary, bin.display().to_string());
        let missing = status(&dir.join("nope")).await;
        assert_eq!(missing.signed_in, None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
