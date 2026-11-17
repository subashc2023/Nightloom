//! What Home can reach (nightshift item 804): his claude.ai connectors,
//! account by account, and what macOS keeps locally.
//!
//! - **The list** is the CLI's own: `claude mcp list` (no model request)
//!   names every server and says whether it is connected ([`check`],
//!   [`parse_list`]). A second account of one service carries a short id
//!   after its name (`claude.ai Gmail 2117773e`), so each account is its
//!   own connector with its own tools. Kept in `home/reach.json`.
//! - **His choices** are `home/accounts.json`: the connectors he turned
//!   off for Home ([`set_on`]). Only the panel writes it.
//! - **Each account's address** is learned from the scan, which ends with
//!   one `account: <connector> = <address>` line per account it read
//!   ([`learn_names`]); kept in `home/account-names.json`. Model-written,
//!   so the panel shows it as a name and nothing is decided from it.
//! - **Home's chats get the connectors** ([`apply`]): on, less the ones he
//!   turned off. Home's chats are held read-only, so a connector action
//!   that writes is refused by `agent::connector_writes` and one whose
//!   name does not say is asked about (item 783) — there is no write path
//!   here.
//! - **The scan reads mail and calendar** from every account that is
//!   connected and on ([`scan_accounts`], `home::scan_message`).
//! - **macOS's own stores** (Messages, Contacts, Reminders, Calendar) are
//!   listed as not reachable, with the reason ([`locals`]): each sits
//!   behind a macOS permission dialog only he can answer, and nothing here
//!   may raise one.

use std::collections::BTreeMap;
use std::path::Path;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::agent::connectors;

/// How long `claude mcp list` may take (it checks every server's health).
const CHECK_LIMIT: Duration = Duration::from_secs(90);

/// What a connector is for, read from its name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Mail,
    Calendar,
    Files,
    Other,
}

/// Whether the CLI could reach a connector at the last check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Connected,
    NeedsSignIn,
    Failed,
}

/// One server the CLI listed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Connector {
    /// As the CLI names it (`claude.ai Gmail 2117773e`).
    pub name: String,
    pub status: Status,
}

/// The last check, as kept in `home/reach.json`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reach {
    pub checked_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub connectors: Vec<Connector>,
    /// Why the check found nothing, in words, when it failed.
    #[serde(default)]
    pub error: Option<String>,
}

/// The connectors he turned off for Home (`home/accounts.json`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Choices {
    #[serde(default)]
    off: Vec<String>,
}

/// A connector's service in plain words and, for a second account, the
/// short id the CLI put after it: `claude.ai Gmail 2117773e` → (`Gmail`,
/// `Some("2117773e")`); a server of his own keeps its name.
pub fn service_of(name: &str) -> (String, Option<String>) {
    let Some(rest) = name.strip_prefix(connectors::SERVER_PREFIX) else {
        return (name.to_string(), None);
    };
    if let Some((head, tail)) = rest.rsplit_once(' ')
        && tail.len() == 8
        && tail.chars().all(|c| c.is_ascii_hexdigit())
    {
        return (head.to_string(), Some(tail.to_string()));
    }
    (rest.to_string(), None)
}

/// What a connector is for.
pub fn kind_of(name: &str) -> Kind {
    let s = service_of(name).0.to_lowercase();
    if s.contains("gmail") || s.contains("mail") || s.contains("outlook") {
        Kind::Mail
    } else if s.contains("calendar") {
        Kind::Calendar
    } else if ["drive", "docs", "sheets", "slides", "onedrive", "notion"]
        .iter()
        .any(|w| s.contains(w))
    {
        Kind::Files
    } else {
        Kind::Other
    }
}

/// The servers in `claude mcp list`'s output: one per `name: … - ✔
/// Connected` line; the status is read from the words after the last
/// ` - `. Lines that are not a server (the "Checking…" line) are skipped.
pub fn parse_list(out: &str) -> Vec<Connector> {
    let mut found: Vec<Connector> = Vec::new();
    for line in out.lines() {
        let Some((name, rest)) = line.split_once(": ") else {
            continue;
        };
        let Some((_, state)) = rest.rsplit_once(" - ") else {
            continue;
        };
        let state = state.to_lowercase();
        let status = if state.contains("needs auth") {
            Status::NeedsSignIn
        } else if state.contains("connected") {
            Status::Connected
        } else {
            Status::Failed
        };
        let name = name.trim().to_string();
        if !name.is_empty() && !found.iter().any(|c| c.name == name) {
            found.push(Connector { name, status });
        }
    }
    found
}

/// Ask the CLI what it reaches now and keep the answer. Blocking (up to
/// [`CHECK_LIMIT`]); no model request. A CLI that cannot be run or lists
/// nothing is kept as an `error`, and the last good list stays beside it.
pub fn check(config: &Path, binary: &Path, now: DateTime<Utc>) -> Reach {
    let dir = super::ensure_folder(config).unwrap_or_else(|_| super::dir_in(config));
    let ran = crate::cli_update::run(binary, &["mcp", "list"], &dir, None, CHECK_LIMIT);
    let mut reach = load(config);
    match ran {
        Some((true, out, _)) => {
            reach.connectors = parse_list(&out);
            reach.error = None;
        }
        Some((false, _, _)) => {
            reach.error = Some("Claude Code did not finish listing its connectors.".into());
        }
        None => reach.error = Some("Claude Code could not be started.".into()),
    }
    reach.checked_at = Some(now);
    if let Ok(bytes) = serde_json::to_vec_pretty(&reach) {
        let _ = std::fs::write(dir.join("reach.json"), bytes);
    }
    reach
}

/// The last check; empty when there has been none.
pub fn load(config: &Path) -> Reach {
    std::fs::read(super::dir_in(config).join("reach.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn choices(config: &Path) -> Choices {
    std::fs::read(super::dir_in(config).join("accounts.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// The connectors he turned off for Home, as the CLI names them.
pub fn off(config: &Path) -> Vec<String> {
    choices(config).off
}

/// Turn a connector on or off for Home. Only a claude.ai connector can be
/// turned off (his own servers are his settings').
pub fn set_on(config: &Path, name: &str, on: bool) -> Result<(), String> {
    if !connectors::is_connector(name) {
        return Err("Only a claude.ai connector can be turned off here.".into());
    }
    let dir = super::ensure_folder(config).map_err(|e| e.to_string())?;
    let mut c = choices(config);
    c.off.retain(|n| n != name);
    if !on {
        c.off.push(name.to_string());
    }
    c.off.sort();
    let bytes = serde_json::to_vec_pretty(&c).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("accounts.json"), bytes).map_err(|e| e.to_string())
}

/// Each connector's address, as a scan reported it.
pub fn names(config: &Path) -> BTreeMap<String, String> {
    std::fs::read(super::dir_in(config).join("account-names.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// The `account: <connector> = <address>` lines of a scan's reply.
pub fn names_in(reply: &str) -> Vec<(String, String)> {
    reply
        .lines()
        .filter_map(|l| l.trim().trim_matches('`').strip_prefix("account:"))
        .filter_map(|rest| rest.split_once('='))
        .map(|(c, a)| (c.trim().to_string(), a.trim().to_string()))
        .filter(|(c, a)| {
            connectors::is_connector(c)
                && !a.is_empty()
                && a.chars().count() <= 80
                && !a.contains(char::is_whitespace)
        })
        .collect()
}

/// Keep the addresses a scan reported, for connectors the last check
/// listed (a name the reply made up is dropped).
pub fn learn_names(config: &Path, reply: &str) {
    let found = names_in(reply);
    if found.is_empty() {
        return;
    }
    let known = load(config).connectors;
    let mut all = names(config);
    let before = all.clone();
    for (connector, address) in found {
        if known.iter().any(|c| c.name == connector) {
            all.insert(connector, address);
        }
    }
    if all != before
        && let Ok(bytes) = serde_json::to_vec_pretty(&all)
    {
        let _ = std::fs::write(super::dir_in(config).join("account-names.json"), bytes);
    }
}

/// One row of the panel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Account {
    /// The CLI's name; what [`set_on`] takes.
    pub connector: String,
    /// `Gmail`, `Google Calendar`, … in plain words.
    pub service: String,
    pub kind: Kind,
    /// Its address, when a scan has reported one.
    pub address: Option<String>,
    /// Which account of its service this is, from 1, when there are several.
    pub nth: Option<usize>,
    pub status: Status,
    /// Not turned off by him.
    pub on: bool,
    /// One of his claude.ai connectors (and so his to turn off here).
    pub claude_ai: bool,
    /// Whether the morning scan reads it (mail and calendar that are
    /// connected and on).
    pub in_scan: bool,
}

/// The panel's rows: every server of the last check, mail first, then
/// calendars, files, the rest; accounts of one service numbered.
pub fn accounts(config: &Path) -> Vec<Account> {
    let reach = load(config);
    let off = off(config);
    let names = names(config);
    let mut per_service: BTreeMap<String, usize> = BTreeMap::new();
    for c in &reach.connectors {
        *per_service.entry(service_of(&c.name).0).or_default() += 1;
    }
    let mut seen: BTreeMap<String, usize> = BTreeMap::new();
    let mut rows: Vec<Account> = reach
        .connectors
        .iter()
        .map(|c| {
            let (service, _) = service_of(&c.name);
            let n = seen.entry(service.clone()).or_default();
            *n += 1;
            let kind = kind_of(&c.name);
            let claude_ai = connectors::is_connector(&c.name);
            let on = !off.contains(&c.name);
            Account {
                connector: c.name.clone(),
                nth: (per_service[&service] > 1).then_some(*n),
                service,
                kind,
                address: names.get(&c.name).cloned(),
                status: c.status,
                on,
                claude_ai,
                in_scan: claude_ai
                    && on
                    && c.status == Status::Connected
                    && matches!(kind, Kind::Mail | Kind::Calendar),
            }
        })
        .collect();
    let order = |k: Kind| match k {
        Kind::Mail => 0,
        Kind::Calendar => 1,
        Kind::Files => 2,
        Kind::Other => 3,
    };
    rows.sort_by_key(|a| order(a.kind));
    rows
}

/// The accounts the scan reads: (kind, the tool prefix the CLI gives the
/// connector, its name, its address when known).
pub fn scan_accounts(config: &Path) -> Vec<(Kind, String, String, Option<String>)> {
    accounts(config)
        .into_iter()
        .filter(|a| a.in_scan)
        .map(|a| {
            (
                a.kind,
                connectors::server_rule(&a.connector),
                a.connector,
                a.address,
            )
        })
        .collect()
}

/// Something macOS keeps on this Mac that Home does not read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Local {
    pub name: &'static str,
    pub why: &'static str,
}

/// macOS's own stores, each with why Home cannot read it. Stated, never
/// probed: reading any of them raises (or silently needs) a macOS
/// permission only he can give.
pub fn locals() -> Vec<Local> {
    vec![
        Local {
            name: "Messages",
            why: "Needs Full Disk Access for Nightloom, which only you can grant in System Settings.",
        },
        Local {
            name: "Contacts",
            why: "macOS asks for permission with a dialog; Home never raises one by itself.",
        },
        Local {
            name: "Reminders",
            why: "macOS asks for permission with a dialog; Home never raises one by itself.",
        },
        Local {
            name: "Calendar app",
            why: "Same dialog. Your Google calendars are read through their connectors instead.",
        },
    ]
}

/// A chat of Home's project (`source`) gets his connectors, less the ones
/// he turned off for Home; other projects are left as set. The chat is
/// held read-only by its host, which is what keeps this to reading.
pub fn apply(
    source: Option<Option<&str>>,
    config: Option<&Path>,
    spec: &mut crate::agent::AgentSpec,
) {
    if source.flatten() != Some(super::SOURCE) {
        return;
    }
    spec.claude_ai_connectors = true;
    for name in config.map(off).unwrap_or_default() {
        if !spec.claude_ai_blocked.contains(&name) {
            spec.claude_ai_blocked.push(name);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("nl-reach-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    const LIST: &str = "Checking MCP server health…\n\n\
claude.ai Claude Docs: https://x.example/mcp - ✔ Connected\n\
claude.ai Microsoft 365: https://x.example/mcp - ! Needs authentication\n\
claude.ai Gmail: https://x.example/mcp - ✔ Connected\n\
claude.ai Gmail 2117773e: https://x.example/mcp - ✔ Connected\n\
claude.ai Google Calendar 974e51a6: https://x.example/mcp - ✔ Connected\n\
claude.ai Google Drive: https://x.example/mcp - ✗ Failed to connect\n\
openalex: /usr/bin/python /p/openalex_mcp.py - ✔ Connected\n";

    fn keep(config: &Path, connectors: Vec<Connector>) {
        let dir = crate::home::ensure_folder(config).unwrap();
        let r = Reach {
            checked_at: Some(Utc::now()),
            connectors,
            error: None,
        };
        std::fs::write(dir.join("reach.json"), serde_json::to_vec(&r).unwrap()).unwrap();
    }

    #[test]
    fn the_clis_list_reads_as_servers_with_their_state() {
        let got = parse_list(LIST);
        let state = |n: &str| got.iter().find(|c| c.name == n).map(|c| c.status);
        assert_eq!(got.len(), 7);
        assert_eq!(state("claude.ai Claude Docs"), Some(Status::Connected));
        assert_eq!(state("claude.ai Microsoft 365"), Some(Status::NeedsSignIn));
        assert_eq!(state("claude.ai Gmail 2117773e"), Some(Status::Connected));
        assert_eq!(state("claude.ai Google Drive"), Some(Status::Failed));
        assert_eq!(state("openalex"), Some(Status::Connected));
    }

    #[test]
    fn a_second_account_is_its_service_and_a_short_id() {
        assert_eq!(service_of("claude.ai Gmail"), ("Gmail".into(), None));
        assert_eq!(
            service_of("claude.ai Gmail 2117773e"),
            ("Gmail".into(), Some("2117773e".into()))
        );
        // A product whose last word is not an id keeps it.
        assert_eq!(
            service_of("claude.ai Microsoft 365"),
            ("Microsoft 365".into(), None)
        );
        assert_eq!(service_of("openalex"), ("openalex".into(), None));
        assert_eq!(kind_of("claude.ai Gmail 2117773e"), Kind::Mail);
        assert_eq!(kind_of("claude.ai Google Calendar"), Kind::Calendar);
        assert_eq!(kind_of("claude.ai Google Sheets"), Kind::Files);
        assert_eq!(kind_of("openalex"), Kind::Other);
    }

    #[test]
    fn every_account_is_a_row_and_the_scan_reads_mail_and_calendar_that_are_on() {
        let config = scratch("rows");
        keep(&config, parse_list(LIST));
        set_on(&config, "claude.ai Gmail", false).unwrap();
        assert!(set_on(&config, "openalex", false).is_err());
        let rows = accounts(&config);
        assert_eq!(rows.len(), 7);
        assert_eq!(rows[0].kind, Kind::Mail);
        let gmail: Vec<&Account> = rows.iter().filter(|a| a.service == "Gmail").collect();
        assert_eq!(gmail.len(), 2);
        assert_eq!(
            gmail.iter().map(|a| a.nth).collect::<Vec<_>>(),
            vec![Some(1), Some(2)]
        );
        assert!(!gmail[0].on && !gmail[0].in_scan);
        assert!(gmail[1].on && gmail[1].in_scan);
        let scan = scan_accounts(&config);
        assert_eq!(
            scan.iter().map(|s| s.1.as_str()).collect::<Vec<_>>(),
            vec![
                "mcp__claude_ai_Gmail_2117773e",
                "mcp__claude_ai_Google_Calendar_974e51a6"
            ]
        );
        // Needs sign-in, failed, files and his own server: listed, not scanned.
        assert!(
            rows.iter()
                .any(|a| a.status == Status::NeedsSignIn && !a.in_scan)
        );
        assert!(rows.iter().any(|a| !a.claude_ai && !a.in_scan));
        // Back on.
        set_on(&config, "claude.ai Gmail", true).unwrap();
        assert!(off(&config).is_empty());
    }

    #[test]
    fn a_scans_account_lines_name_only_connectors_the_check_listed() {
        let config = scratch("names");
        keep(&config, parse_list(LIST));
        let reply = "## Mail\n…\naccount: claude.ai Gmail 2117773e = a@example.com\n\
`account: claude.ai Google Calendar 974e51a6 = b@example.com`\n\
account: claude.ai Made Up = c@example.com\n\
account: claude.ai Gmail = two words\naccount: openalex = d@example.com\nwaiting: 2";
        learn_names(&config, reply);
        let got = names(&config);
        assert_eq!(got.len(), 2);
        assert_eq!(got["claude.ai Gmail 2117773e"], "a@example.com");
        assert_eq!(got["claude.ai Google Calendar 974e51a6"], "b@example.com");
        let row = accounts(&config)
            .into_iter()
            .find(|a| a.connector == "claude.ai Gmail 2117773e")
            .unwrap();
        assert_eq!(row.address.as_deref(), Some("a@example.com"));
    }

    #[test]
    fn homes_chats_get_the_connectors_less_the_ones_he_turned_off_and_others_none() {
        let config = scratch("apply");
        keep(&config, parse_list(LIST));
        set_on(&config, "claude.ai Google Drive", false).unwrap();
        let mut home = crate::agent::AgentSpec::new(&config);
        apply(Some(Some(crate::home::SOURCE)), Some(&config), &mut home);
        assert!(home.claude_ai_connectors);
        assert_eq!(
            home.claude_ai_blocked,
            vec!["claude.ai Google Drive".to_string()]
        );
        let mut other = crate::agent::AgentSpec::new(&config);
        apply(Some(None), Some(&config), &mut other);
        apply(None, Some(&config), &mut other);
        assert!(!other.claude_ai_connectors && other.claude_ai_blocked.is_empty());
    }

    #[test]
    fn a_cli_that_cannot_run_keeps_the_last_good_list_and_says_why() {
        let config = scratch("check");
        keep(&config, parse_list(LIST));
        let r = check(&config, Path::new("/nonexistent/claude"), Utc::now());
        assert_eq!(r.connectors.len(), 7);
        assert!(r.error.is_some());
        assert_eq!(load(&config), r);
    }
}
