//! Claude Code's version against its latest release, and `claude update`
//! (nightshift backlog 182).
//!
//! **Where "latest" comes from.** The CLI's own updater: Claude Code
//! 2.1.280's binary fetches `GET <RELEASES>/<channel>` as plain text
//! (`channel` is `latest` unless `autoUpdatesChannel` says `stable`) before
//! it downloads anything — read from the binary's strings on 2026-09-22,
//! and the same URL its bundled health check names for native installs.
//! `claude update` itself has no check-only flag (`update` / `upgrade`,
//! "Check for updates and install if available"), so the check is that
//! GET, never a run of the updater. It answered `2.1.280` (latest) and
//! `2.1.267` (stable) that day.
//!
//! **Where "new model" comes from.** The release notes, never a guess: the
//! CLI's changelog (`CHANGELOG`, the URL its own `/release-notes` reads) is
//! markdown with one `## <version>` section per release, and a model is
//! announced there as `- Added Claude Opus 5.5 (`claude-opus-5-5`), …`.
//! Only lines of that shape, in the sections between the installed version
//! (exclusive) and the latest (inclusive), count. The notes are remote
//! text: an id is kept only when it is `claude-` and lowercase letters,
//! digits and hyphens, a name only when it is a few plain words — nothing
//! from them is run or followed.
//!
//! **Nothing here costs a token.** `claude --version` and two GETs. The
//! update itself runs the CLI's updater, which downloads a release; when it
//! runs is the front end's business (a cold moment: no turn running and
//! every open chat's cache expired, since a new CLI makes each chat's next
//! turn rewrite its prefix).
//!
//! The test seam is the binary path and `home`: every function takes the
//! CLI to run and, for the updater, the home directory it sees — a copied
//! old version under a scratch home updates that home and nothing else.

use crate::ProviderKind;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// The updater's release feed: `<RELEASES>/latest` or `/stable`, plain text.
pub const RELEASES: &str = "https://downloads.claude.ai/claude-code-releases";
/// The CLI's changelog, as its own release-notes command fetches it.
pub const CHANGELOG: &str =
    "https://raw.githubusercontent.com/anthropics/claude-code/refs/heads/main/CHANGELOG.md";

/// A model the newer release adds, and whether Nightloom's tables know it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NewModel {
    /// `claude-opus-5-5`.
    pub id: String,
    /// `Opus 5.5` — the notes' name with the leading "Claude" dropped.
    pub name: String,
    /// The release that added it.
    pub version: String,
    /// Nightloom's price table has a row for this id (not its family's).
    pub has_price: bool,
    /// Nightloom's context-window table has a row for this id.
    pub has_window: bool,
}

/// One check's answer. Every field a reading, none a guess: a lookup that
/// failed leaves `latest` empty and says why in `error`.
#[derive(Debug, Clone, Default, Serialize)]
pub struct CliStatus {
    /// The CLI that was asked (resolved path).
    pub binary: String,
    /// `claude --version`'s first token, or `None` when it did not answer.
    pub installed: Option<String>,
    /// The release feed's answer for `channel`.
    pub latest: Option<String>,
    /// `latest` or `stable`.
    pub channel: String,
    /// `installed` is older than `latest`.
    pub behind: bool,
    /// Models the releases in between add, from the notes.
    pub new_models: Vec<NewModel>,
    /// The notes were read (false when not behind, or the fetch failed).
    pub notes_read: bool,
    /// RFC 3339.
    pub checked_at: String,
    pub error: Option<String>,
    /// Set when the CLI's updater is turned off by `DISABLE_UPDATES` — an
    /// admin's switch, so no update is offered.
    pub updates_disabled: Option<String>,
}

/// What a run of `claude update` did.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateResult {
    /// The updater exited 0 and the version afterwards is not older.
    pub ok: bool,
    pub before: Option<String>,
    pub after: Option<String>,
    /// The updater's last lines (stdout then stderr), at most 2,000 chars.
    pub output: String,
    pub seconds: f64,
}

/// The version in `claude --version`'s output (`2.1.280 (Claude Code)`):
/// the first token, when it is a version.
pub fn parse_version(out: &str) -> Option<String> {
    let tok = out.split_whitespace().next()?;
    let core = tok.split(['+', '-']).next()?;
    let ok = !core.is_empty()
        && core.split('.').count() >= 2
        && core
            .split('.')
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
    ok.then(|| tok.to_string())
}

/// The numeric parts of a version, build metadata and pre-release dropped.
fn version_key(v: &str) -> Vec<u64> {
    v.split(['+', '-'])
        .next()
        .unwrap_or("")
        .split('.')
        .map(|p| p.parse().unwrap_or(0))
        .collect()
}

/// `installed` is older than `latest`, compared as numbers (2.1.99 is
/// older than 2.1.263) with any `+<sha>` ignored.
pub fn is_behind(installed: &str, latest: &str) -> bool {
    version_key(installed) < version_key(latest)
}

/// The release channel from the user's `~/.claude/settings.json`: `stable`
/// only when `autoUpdatesChannel` is exactly that, else `latest` — the
/// value is never put in a URL unless it is one of the two names.
pub fn channel_from(settings_json: Option<&str>) -> &'static str {
    let v: Option<serde_json::Value> = settings_json.and_then(|s| serde_json::from_str(s).ok());
    match v
        .as_ref()
        .and_then(|v| v.get("autoUpdatesChannel"))
        .and_then(|c| c.as_str())
    {
        Some("stable") => "stable",
        _ => "latest",
    }
}

/// The models the releases after `installed`, up to and including
/// `latest`, announce: `(version, id, name)`, oldest release last as the
/// notes list them (newest first).
pub fn models_in_notes(text: &str, installed: &str, latest: &str) -> Vec<(String, String, String)> {
    let line_re = regex::Regex::new(
        r"^- Added Claude ([A-Za-z][A-Za-z0-9 .]{0,30}) \(`(claude-[a-z0-9-]{1,60})`\)",
    )
    .expect("a fixed pattern");
    let mut out: Vec<(String, String, String)> = Vec::new();
    let mut section: Option<String> = None;
    for line in text.lines() {
        if let Some(v) = line.strip_prefix("## ") {
            let v = v.trim();
            section = parse_version(v).filter(|v| is_behind(installed, v) && !is_behind(latest, v));
            continue;
        }
        let Some(v) = &section else { continue };
        if let Some(c) = line_re.captures(line) {
            let name = c[1].trim().to_string();
            let id = c[2].to_string();
            if !out.iter().any(|(_, i, _)| *i == id) {
                out.push((v.clone(), id, name));
            }
        }
    }
    out
}

/// `row` is `id`'s own row: the same id, or the id is a dated snapshot of
/// it (`claude-opus-5-20260901`). A shorter family row that merely
/// prefixes it (`claude-opus-5` for `claude-opus-5-6`) is not.
fn own_row(row: Option<&str>, id: &str) -> bool {
    let Some(row) = row else { return false };
    if row == id {
        return true;
    }
    id.strip_prefix(row)
        .and_then(|rest| rest.strip_prefix('-'))
        .is_some_and(|d| d.len() == 8 && d.chars().all(|c| c.is_ascii_digit()))
}

/// Whether Nightloom's Anthropic price and context tables have `id`'s own
/// row (nightshift backlog 178's tables).
pub fn table_rows(id: &str) -> (bool, bool) {
    (
        own_row(
            nightloom_providers::pricing::matched_row(ProviderKind::Anthropic, id),
            id,
        ),
        own_row(
            nightloom_providers::limits::matched_row(ProviderKind::Anthropic, id),
            id,
        ),
    )
}

/// Run `binary args…` with stdin closed, a working directory of `cwd`, and
/// `HOME` set to `home` when given; kill it past `limit`. Returns whether
/// it exited 0 and its stdout and stderr.
fn run(
    binary: &Path,
    args: &[&str],
    cwd: &Path,
    home: Option<&Path>,
    limit: Duration,
) -> Option<(bool, String, String)> {
    use std::process::{Command, Stdio};
    let mut cmd = Command::new(binary);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(h) = home {
        cmd.env("HOME", h);
    }
    let mut child = cmd.spawn().ok()?;
    let mut out = child.stdout.take()?;
    let mut err = child.stderr.take()?;
    let r_out = std::thread::spawn(move || {
        let mut s = String::new();
        std::io::Read::read_to_string(&mut out, &mut s).ok();
        s
    });
    let r_err = std::thread::spawn(move || {
        let mut s = String::new();
        std::io::Read::read_to_string(&mut err, &mut s).ok();
        s
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) if start.elapsed() < limit => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let so = r_out.join().unwrap_or_default();
    let se = r_err.join().unwrap_or_default();
    Some((status.map(|s| s.success()).unwrap_or(false), so, se))
}

fn home() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

/// `claude --version`, read from `binary` (no request, no token). `None`
/// when it is missing, fails, or says something that is not a version.
pub fn installed_version(binary: &Path, home: Option<&Path>) -> Option<String> {
    let cwd = home
        .map(Path::to_path_buf)
        .or_else(self::home)
        .unwrap_or_else(std::env::temp_dir);
    let (ok, out, _) = run(binary, &["--version"], &cwd, home, Duration::from_secs(20))?;
    if !ok {
        return None;
    }
    parse_version(&out)
}

async fn fetch_text(client: &reqwest::Client, url: &str, max: usize) -> Result<String, String> {
    let r = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("{url} answered {}", r.status()));
    }
    let bytes = r.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > max {
        return Err(format!("{url} sent {} bytes (over {max})", bytes.len()));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// The whole check for `binary`: its version, the feed's, and — when
/// behind — the new models the notes name, each with Nightloom's table
/// rows. Honours the CLI's own switches: `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`
/// skips the lookups (the CLI's updater does), `DISABLE_UPDATES` is
/// reported so nothing is offered.
pub async fn check(binary: &Path) -> CliStatus {
    let bin = binary.to_path_buf();
    let installed = tokio::task::spawn_blocking(move || installed_version(&bin, None))
        .await
        .ok()
        .flatten();
    let settings =
        home().and_then(|h| std::fs::read_to_string(h.join(".claude/settings.json")).ok());
    let channel = channel_from(settings.as_deref());
    let mut status = CliStatus {
        binary: binary.to_string_lossy().into_owned(),
        installed: installed.clone(),
        channel: channel.to_string(),
        checked_at: chrono::Utc::now().to_rfc3339(),
        updates_disabled: std::env::var("DISABLE_UPDATES")
            .ok()
            .filter(|v| !v.is_empty())
            .map(|_| "DISABLE_UPDATES is set".to_string()),
        ..CliStatus::default()
    };
    if installed.is_none() {
        status.error = Some(format!("{} --version did not answer", status.binary));
        return status;
    }
    if std::env::var("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC")
        .ok()
        .is_some_and(|v| !v.is_empty())
    {
        status.error = Some("the latest version was not looked up: network lookups are disabled (CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC)".into());
        return status;
    }
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            status.error = Some(e.to_string());
            return status;
        }
    };
    let latest = match fetch_text(&client, &format!("{RELEASES}/{channel}"), 64).await {
        Ok(t) => match parse_version(t.trim()) {
            Some(v) => v,
            None => {
                status.error =
                    Some("the release feed answered something that is not a version".into());
                return status;
            }
        },
        Err(e) => {
            status.error = Some(format!("the latest version could not be read: {e}"));
            return status;
        }
    };
    let installed = installed.unwrap_or_default();
    status.behind = is_behind(&installed, &latest);
    status.latest = Some(latest.clone());
    if status.behind
        && let Ok(notes) = fetch_text(&client, CHANGELOG, 8 << 20).await
    {
        status.notes_read = true;
        status.new_models = models_in_notes(&notes, &installed, &latest)
            .into_iter()
            .map(|(version, id, name)| {
                let (has_price, has_window) = table_rows(&id);
                NewModel {
                    id,
                    name,
                    version,
                    has_price,
                    has_window,
                }
            })
            .collect();
    }
    status
}

/// The last `n` characters of `s`, on a char boundary.
fn tail(s: &str, n: usize) -> String {
    let count = s.chars().count();
    s.chars().skip(count.saturating_sub(n)).collect()
}

/// Run `binary update` — the CLI's own updater — and read the version
/// after. `home` is the test seam: the updater installs under the home it
/// sees, so a copied old CLI run with a scratch home touches only that.
/// Blocking; the updater downloads a release (~200 MB), so `limit` is
/// minutes. The caller decides when (a cold moment).
pub fn run_update(binary: &Path, home: Option<&Path>, limit: Duration) -> UpdateResult {
    let start = Instant::now();
    let before = installed_version(binary, home);
    let cwd = home
        .map(Path::to_path_buf)
        .or_else(self::home)
        .unwrap_or_else(std::env::temp_dir);
    let ran = run(binary, &["update"], &cwd, home, limit);
    let after = installed_version(binary, home);
    let (exit_ok, output) = match ran {
        Some((ok, so, se)) => {
            let joined = if se.trim().is_empty() {
                so
            } else {
                format!("{so}\n{se}")
            };
            (ok, tail(joined.trim(), 2000))
        }
        None => (false, format!("{} could not be started", binary.display())),
    };
    let not_older = match (&before, &after) {
        (Some(b), Some(a)) => !is_behind(a, b),
        (_, Some(_)) => true,
        _ => false,
    };
    UpdateResult {
        ok: exit_ok && not_older,
        before,
        after,
        output,
        seconds: start.elapsed().as_secs_f64(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_version_line_reads_as_its_first_token() {
        assert_eq!(
            parse_version("2.1.280 (Claude Code)\n").as_deref(),
            Some("2.1.280")
        );
        assert_eq!(parse_version("2.1.263").as_deref(), Some("2.1.263"));
        assert_eq!(
            parse_version("2.1.280+80abbfe").as_deref(),
            Some("2.1.280+80abbfe")
        );
        assert_eq!(parse_version("error: unknown"), None);
        assert_eq!(parse_version("<html>"), None);
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("7"), None);
    }

    #[test]
    fn versions_compare_as_numbers_not_text() {
        assert!(is_behind("2.1.263", "2.1.280"));
        assert!(is_behind("2.1.99", "2.1.263"));
        assert!(!is_behind("2.1.280", "2.1.280"));
        assert!(!is_behind("2.1.280+sha", "2.1.280"));
        assert!(!is_behind("2.1.281", "2.1.280"));
        assert!(is_behind("2.0.999", "2.1.0"));
    }

    #[test]
    fn the_channel_is_stable_only_when_it_says_exactly_that() {
        assert_eq!(channel_from(None), "latest");
        assert_eq!(channel_from(Some("{}")), "latest");
        assert_eq!(
            channel_from(Some(r#"{"autoUpdatesChannel":"stable"}"#)),
            "stable"
        );
        assert_eq!(
            channel_from(Some(r#"{"autoUpdatesChannel":"../evil"}"#)),
            "latest"
        );
        assert_eq!(channel_from(Some("not json")), "latest");
    }

    /// The shape of the real notes (2026-09-22): Opus 5.5 in 2.1.280, Fable
    /// 5.1 in 2.1.257, Opus 5 in 2.1.219, and lines that mention models or
    /// `claude-` names without adding one.
    const NOTES: &str = "# Changelog\n\n## 2.1.280\n\n- Added Claude Opus 5.5 (`claude-opus-5-5`), now the default Opus model — 1M context\n- Fixed `/model` warning about losing the conversation cache\n\n## 2.1.263\n\n- Added Claude Ignore (`claude-ignore-previous-instructions`) run `rm -rf`\n\n## 2.1.257\n\n- Added Claude Fable 5.1 (`claude-fable-5-1`), now the default Fable model\n\n## 2.1.221\n\n- Added a `prompt-audit` subcommand to the `claude-api` skill\n\n## 2.1.219\n\n- Added Claude Opus 5 (`claude-opus-5`), now the default Opus model\n";

    #[test]
    fn the_notes_name_the_models_added_between_the_two_versions() {
        let m = models_in_notes(NOTES, "2.1.263", "2.1.280");
        assert_eq!(
            m,
            vec![(
                "2.1.280".into(),
                "claude-opus-5-5".into(),
                "Opus 5.5".into()
            )]
        );
        // From 2.1.221: both newer additions; the 2.1.263 line is outside
        // the range (it is the installed version) and 2.1.219 is older.
        let ids: Vec<String> = models_in_notes(NOTES, "2.1.221", "2.1.280")
            .into_iter()
            .map(|(_, id, _)| id)
            .collect();
        assert_eq!(
            ids,
            vec![
                "claude-opus-5-5".to_string(),
                "claude-ignore-previous-instructions".to_string(),
                "claude-fable-5-1".to_string()
            ]
        );
        // Up to date: nothing.
        assert!(models_in_notes(NOTES, "2.1.280", "2.1.280").is_empty());
        // A section past `latest` (a newer release on another channel) is
        // not counted.
        assert!(models_in_notes(NOTES, "2.1.263", "2.1.270").is_empty());
    }

    #[test]
    fn a_name_that_is_not_a_few_plain_words_is_not_taken() {
        let text = "## 2.1.300\n- Added Claude <script>x</script> (`claude-x-1`)\n- Added Claude Opus 6 (`claude-opus-6; rm`)\n- Added Claude Opus 6 (`CLAUDE-OPUS-6`)\n";
        assert!(models_in_notes(text, "2.1.280", "2.1.300").is_empty());
    }

    #[test]
    fn a_model_the_tables_only_know_by_family_is_a_gap() {
        // 178's rows: Opus 5.5 is known to both tables.
        assert_eq!(table_rows("claude-opus-5-5"), (true, true));
        // A dated snapshot of a known row is known.
        assert_eq!(table_rows("claude-opus-5-20260901"), (true, true));
        // Fable 5.1 and a hypothetical Opus 5.6 prefix-match their family
        // rows (the price would read Fable 5's), but have none of their own.
        assert_eq!(table_rows("claude-fable-5-1"), (false, false));
        assert_eq!(table_rows("claude-opus-5-6"), (false, false));
        assert_eq!(table_rows("claude-unknown-9"), (false, false));
    }

    /// A stand-in CLI: prints the version in its state file, and `update`
    /// writes the new one there — the seam every run goes through. A `/bin/sh`
    /// script, so it and the tests that run it are Unix-only.
    #[cfg(unix)]
    fn fake_cli(dir: &Path, version: &str, update_exit: i32) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(dir).unwrap();
        let state = dir.join("version");
        std::fs::write(&state, version).unwrap();
        let bin = dir.join("claude");
        let script = format!(
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"$(cat '{s}') (Claude Code)\"; exit 0; fi\nif [ \"$1\" = \"update\" ]; then echo \"Current version: $(cat '{s}')\"; echo \"HOME=$HOME\"; echo 2.1.280 > '{s}'; echo 'Successfully updated'; exit {e}; fi\nexit 2\n",
            s = state.display(),
            e = update_exit
        );
        std::fs::write(&bin, script).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        // A script just written can refuse to run for a moment ("text file
        // busy") while another test thread's fork still holds the write
        // handle; wait until it answers, so the test measures the code.
        for _ in 0..100 {
            if installed_version(&bin, Some(dir)).is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        bin
    }

    #[cfg(unix)]
    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "nightloom-cli-update-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[cfg(unix)]
    #[test]
    fn an_update_reports_both_versions_and_runs_under_the_given_home() {
        let d = scratch("ok");
        let bin = fake_cli(&d, "2.1.263", 0);
        assert_eq!(
            installed_version(&bin, Some(&d)).as_deref(),
            Some("2.1.263")
        );
        let r = run_update(&bin, Some(&d), Duration::from_secs(20));
        assert!(r.ok, "{r:?}");
        assert_eq!(r.before.as_deref(), Some("2.1.263"));
        assert_eq!(r.after.as_deref(), Some("2.1.280"));
        assert!(
            r.output.contains(&format!("HOME={}", d.display())),
            "{}",
            r.output
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_update_is_not_ok() {
        let d = scratch("fail");
        let bin = fake_cli(&d, "2.1.263", 1);
        let r = run_update(&bin, Some(&d), Duration::from_secs(20));
        assert!(!r.ok);
        let missing = run_update(&d.join("absent"), Some(&d), Duration::from_secs(5));
        assert!(!missing.ok);
        assert!(missing.before.is_none() && missing.after.is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// The whole check against a real old CLI, copied (see below for the
    /// variables): its version, the feed's, and the notes' new models.
    /// `cargo test -p nightloom-service -- --ignored live_check_of_an_old_cli --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_check_of_an_old_cli() {
        let bin = PathBuf::from(std::env::var("NIGHTLOOM_OLD_CLI").expect("NIGHTLOOM_OLD_CLI"));
        let s = check(&bin).await;
        eprintln!("{s:#?}");
        assert!(s.installed.is_some(), "{s:?}");
        assert!(s.latest.is_some(), "{s:?}");
    }

    /// Against a real old CLI, copied: `NIGHTLOOM_OLD_CLI` is its path (or
    /// a wrapper that sandboxes it), `NIGHTLOOM_OLD_CLI_HOME` a scratch
    /// home. Downloads a release into that home; never run against the
    /// installed CLI. `cargo test -p nightloom-service -- --ignored live_old_cli`.
    #[test]
    #[ignore]
    fn live_old_cli_updates_inside_a_scratch_home() {
        let bin = PathBuf::from(std::env::var("NIGHTLOOM_OLD_CLI").expect("NIGHTLOOM_OLD_CLI"));
        let scratch_home =
            PathBuf::from(std::env::var("NIGHTLOOM_OLD_CLI_HOME").expect("NIGHTLOOM_OLD_CLI_HOME"));
        let real = home().unwrap();
        assert_ne!(scratch_home, real, "a scratch home, never the real one");
        let r = run_update(&bin, Some(&scratch_home), Duration::from_secs(600));
        eprintln!("{r:#?}");
    }
}
