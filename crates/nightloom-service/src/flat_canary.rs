//! The canary for item 758's switch (nightshift item 758, his ask
//! 2026-11-16: "can you have a test that like errors if that no longer
//! becomes the case so that you can fix things or rematch things?").
//!
//! Item 758 turns the CLI's mid-conversation system messages off with
//! `CLAUDE_CODE_MODEL_CAPABILITIES=-mid_conv_system` ([`crate::agent::flat`]),
//! so a new chat's second request reads the whole cache (71% → 99.4%).
//! Both names are the CLI's internal ones, read from its bundle, never
//! documented: a CLI release can rename or drop either, and the CLI then
//! ignores the variable without a word. Two checks, each a loud notice
//! naming item 758 and the CLI version, and a line in
//! `<config>/logs/flat-canary.jsonl` — never a silent fallback:
//!
//! - **The bundle** ([`bundle_alarm`]): the installed CLI's file must still
//!   hold both strings ([`NEEDLES`]: the variable's name, and the
//!   capability's name as a quoted string, the way its capability list
//!   spells it). Asked once per install — the answer is kept by the file's
//!   real path and modification time, so a `claude update` (which installs
//!   a new file) is checked again at the next ask, and nothing else is.
//!   The front end asks at launch, with the bell's refresh every ten
//!   minutes, and after an update (item 182's path).
//! - **The behaviour** ([`cache_alarm`]): a new chat that has the switch
//!   should read at least [`SECOND_SHARE`] of its context from the cache on
//!   its second request (a turn, a keep-warm ping or an aside — the second
//!   prefix print in the chat's folder, item 727's record). Under it, with
//!   the cache still alive, nothing chosen and Nightloom's own parts
//!   unchanged, the CLI has stopped honouring the switch.
//!
//! The bundle notice stands while the strings are missing; a behaviour
//! notice stands until he dismisses it in the bell (its id carries the CLI
//! version, so a later release that fails again is a new notice).

use crate::cache_miss::{self, Kind, Request};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, Read, Write};
use std::path::{Path, PathBuf};

pub const ITEM: u32 = 758;
/// The log, under `<config>/logs/`.
pub const LOG_FILE: &str = "flat-canary.jsonl";
/// What the switch relies on, as the CLI's bundle spells it (2.1.323–2.1.326:
/// `Pbi` reads `CLAUDE_CODE_MODEL_CAPABILITIES`; the capability list holds
/// `"mid_conv_system"`).
pub const NEEDLES: [&str; 2] = [crate::agent::flat::CAPS_ENV, "\"mid_conv_system\""];
/// A flat chat's second request reads at least this share of its context
/// (measured 99.4% and 99.6%; 71% without the switch).
pub const SECOND_SHARE: f64 = 0.95;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AlarmKind {
    /// The installed CLI no longer holds a string the switch relies on.
    Bundle,
    /// A flat chat's second request read under [`SECOND_SHARE`].
    Cache,
}

/// One notice, as the bell shows it and the log keeps it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Alarm {
    /// Stable while the thing it names is unchanged: what "dismissed" keys on.
    pub id: String,
    pub item: u32,
    pub kind: AlarmKind,
    pub cli_version: Option<String>,
    pub title: String,
    pub detail: String,
    pub time: String,
    pub at_ms: i64,
    pub chat: Option<String>,
}

fn version_words(v: Option<&str>) -> String {
    v.map_or_else(|| "an unknown version".to_string(), |v| v.to_string())
}

fn local_time(ms: i64) -> String {
    use chrono::TimeZone;
    chrono::Local
        .timestamp_millis_opt(ms)
        .single()
        .map(|t| t.format("%Y-%m-%d %-I:%M %p").to_string())
        .unwrap_or_default()
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// ---- the bundle ----

/// The [`NEEDLES`] `reader` does not hold, read in 1 MiB chunks (the native
/// CLI is ~350 MB) with an overlap, so a string split across two chunks is
/// still found.
pub fn missing_in(mut reader: impl Read) -> std::io::Result<Vec<&'static str>> {
    let finders: Vec<regex::bytes::Regex> = NEEDLES
        .iter()
        .map(|n| regex::bytes::Regex::new(&regex::escape(n)).expect("a literal"))
        .collect();
    let keep = NEEDLES.iter().map(|n| n.len()).max().unwrap_or(1) - 1;
    let mut found = [false; NEEDLES.len()];
    let mut buf = vec![0u8; 1 << 20];
    let mut held = 0usize;
    loop {
        let n = reader.read(&mut buf[held..])?;
        if n == 0 {
            break;
        }
        let end = held + n;
        for (i, f) in finders.iter().enumerate() {
            if !found[i] && f.is_match(&buf[..end]) {
                found[i] = true;
            }
        }
        if found.iter().all(|f| *f) {
            break;
        }
        let tail = keep.min(end);
        buf.copy_within(end - tail..end, 0);
        held = tail;
    }
    Ok(NEEDLES
        .iter()
        .zip(found)
        .filter(|(_, f)| !f)
        .map(|(n, _)| *n)
        .collect())
}

/// `binary` as a path: itself when it has a folder, else found on `PATH`;
/// then its real file (the native launcher is a link to a versioned file).
fn real_file(binary: &Path) -> Option<PathBuf> {
    let found = if binary.components().count() > 1 {
        Some(binary.to_path_buf())
    } else {
        std::env::var_os("PATH").and_then(|p| {
            std::env::split_paths(&p)
                .map(|d| d.join(binary))
                .find(|c| c.is_file())
        })
    };
    found?.canonicalize().ok()
}

/// The bundle notice for a CLI at `version` missing `missing`, or `None`
/// when nothing is missing.
pub fn bundle_notice(version: Option<&str>, missing: &[&str], at_ms: i64) -> Option<Alarm> {
    if missing.is_empty() {
        return None;
    }
    let v = version_words(version);
    Some(Alarm {
        id: format!("{ITEM}:bundle:{v}"),
        item: ITEM,
        kind: AlarmKind::Bundle,
        cli_version: version.map(str::to_string),
        title: format!("Claude Code {v} may no longer honour the {ITEM} switch"),
        detail: format!(
            "Item {ITEM}'s cache fix relies on CLAUDE_CODE_MODEL_CAPABILITIES=-mid_conv_system, \
             and this CLI's file no longer holds {}. New chats may re-write ~9k tokens on their \
             second request again; the switch needs re-matching to this release.",
            missing.join(" or ")
        ),
        time: local_time(at_ms),
        at_ms,
        chat: None,
    })
}

/// What the bundle check found for one file: the missing needles, or the
/// read's error.
type Found = Result<Vec<&'static str>, String>;

/// [`missing_in`] for the CLI `binary` runs, asked once per install (kept by
/// real path and modification time).
fn bundle_missing(binary: &Path) -> Option<(PathBuf, Found)> {
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::time::SystemTime;
    type Seen = HashMap<PathBuf, (SystemTime, Found)>;
    static SEEN: Mutex<Option<Seen>> = Mutex::new(None);
    let real = real_file(binary)?;
    let mtime = std::fs::metadata(&real).and_then(|m| m.modified()).ok()?;
    if let Some((t, f)) = SEEN
        .lock()
        .ok()
        .and_then(|g| g.as_ref().and_then(|m| m.get(&real).cloned()))
        && t == mtime
    {
        return Some((real, f));
    }
    let f = std::fs::File::open(&real)
        .and_then(missing_in)
        .map_err(|e| e.to_string());
    if let Ok(mut g) = SEEN.lock() {
        g.get_or_insert_with(HashMap::new)
            .insert(real.clone(), (mtime, f.clone()));
    }
    Some((real, f))
}

/// The bundle check for the CLI `binary` (see the module's note), its
/// notice logged once. A CLI that cannot be found or read is a log line —
/// there is no switch to check without one, and the connect says so.
pub fn bundle_alarm(binary: &Path) -> Option<Alarm> {
    let Some((real, found)) = bundle_missing(binary) else {
        eprintln!(
            "flat-canary: item {ITEM}: {} not found; the switch was not checked",
            binary.display()
        );
        return None;
    };
    let missing = match found {
        Ok(m) => m,
        Err(e) => {
            eprintln!(
                "flat-canary: item {ITEM}: {} not read ({e}); the switch was not checked",
                real.display()
            );
            return None;
        }
    };
    let version = crate::cli_update::cached_version(binary);
    let alarm = bundle_notice(version.as_deref(), &missing, now_ms())?;
    raise(&alarm);
    Some(alarm)
}

// ---- the behaviour ----

/// What [`cache_alarm`] needs beyond the request: whether its session is
/// flat, how many requests the chat had sent up to and including it, and
/// whether Nightloom's own cached parts changed since the one before.
#[derive(Debug, Clone, Copy, Default)]
pub struct Context {
    pub flat: bool,
    pub nth: usize,
    pub parts_changed: bool,
}

/// The behaviour notice for `req`, or `None` when it says nothing about
/// the switch: not a flat chat's second request, a rewind (its copy is a
/// new history), the cache already expired, a change he chose or one in
/// Nightloom's own parts (another bug's, item 727's to log), or a read of
/// at least [`SECOND_SHARE`].
pub fn cache_alarm(req: &Request, cx: Context, version: Option<&str>) -> Option<Alarm> {
    if !cx.flat || cx.nth != 2 || cx.parts_changed || req.kind == Kind::Rewind {
        return None;
    }
    if req.chosen.is_some() || req.context == 0 {
        return None;
    }
    let gap = req.at_ms - req.last_ms?;
    let life = if req.one_hour {
        cache_miss::ONE_HOUR_MS
    } else {
        cache_miss::FIVE_MINUTES_MS
    };
    if gap > life {
        return None;
    }
    let share = req.read as f64 / req.context as f64;
    if share >= SECOND_SHARE {
        return None;
    }
    let v = version_words(version);
    Some(Alarm {
        id: format!("{ITEM}:cache:{v}"),
        item: ITEM,
        kind: AlarmKind::Cache,
        cli_version: version.map(str::to_string),
        title: format!("Claude Code {v} may no longer honour the {ITEM} switch"),
        detail: format!(
            "A new chat's second request ({}) read {} of {} tokens from the cache ({:.0}%, under \
             {:.0}%) with the switch on and nothing else changed. Item {ITEM}'s fix \
             (CLAUDE_CODE_MODEL_CAPABILITIES=-mid_conv_system) needs re-matching to this release.",
            req.kind.as_str(),
            req.read,
            req.context,
            share * 100.0,
            SECOND_SHARE * 100.0
        ),
        time: local_time(req.at_ms),
        at_ms: req.at_ms,
        chat: Some(req.chat.clone()),
    })
}

/// The CLI version a session file says it was written by: the newest
/// line's `"version"`.
pub fn version_in(file: &Path) -> Option<String> {
    let f = std::fs::File::open(file).ok()?;
    let mut last = None;
    for line in std::io::BufReader::new(f).lines().map_while(Result::ok) {
        if !line.contains("\"version\"") {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line)
            && let Some(s) = v.get("version").and_then(|s| s.as_str())
            && crate::cli_update::parse_version(s).is_some()
        {
            last = Some(s.to_string());
        }
    }
    last
}

/// [`Context`] for `req`, off its CLI session id (`flat_dir` holds the
/// marks) and the chat's prefix prints.
pub fn context_of(req: &Request, flat_dir: &Path) -> Context {
    let flat = req
        .cli_file
        .as_deref()
        .and_then(|f| f.file_stem())
        .is_some_and(|id| crate::agent::flat::is_flat_in(flat_dir, &id.to_string_lossy()));
    let prints: Vec<_> = req
        .ask_dir
        .as_deref()
        .map(cache_miss::read_prints)
        .unwrap_or_default()
        .into_iter()
        .filter(|p| p.at_ms <= req.at_ms)
        .collect();
    let nth = prints.len();
    let parts_changed = nth >= 2
        && !cache_miss::changed(
            &prints[nth - 2].print,
            &prints[nth - 1].print,
            Some(&cache_miss::CACHE_PARTS),
        )
        .is_empty();
    Context {
        flat,
        nth,
        parts_changed,
    }
}

/// The behaviour check after a request (the shell calls it beside
/// [`cache_miss::check`], off the turn's path): the notice, logged once,
/// for the shell to announce.
pub fn after_request(req: &Request) -> Option<Alarm> {
    let flat_dir = crate::project::config_dir()?.join("flat-sessions");
    let cx = context_of(req, &flat_dir);
    if !cx.flat || cx.nth != 2 {
        return None;
    }
    let version = req.cli_file.as_deref().and_then(version_in);
    let alarm = cache_alarm(req, cx, version.as_deref())?;
    raise(&alarm);
    Some(alarm)
}

// ---- the log and the bell ----

pub fn log_path() -> Option<PathBuf> {
    crate::project::config_dir().map(|c| c.join("logs").join(LOG_FILE))
}

/// The alarms `log` holds, oldest first; unreadable lines skipped.
pub fn read_log(log: &Path) -> Vec<Alarm> {
    let Ok(f) = std::fs::File::open(log) else {
        return Vec::new();
    };
    std::io::BufReader::new(f)
        .lines()
        .map_while(Result::ok)
        .filter_map(|l| serde_json::from_str(&l).ok())
        .collect()
}

/// Append `alarm` to `log` unless a line with its id is there. `true` when
/// it was new.
pub fn raise_in(log: &Path, alarm: &Alarm) -> std::io::Result<bool> {
    if read_log(log).iter().any(|a| a.id == alarm.id) {
        return Ok(false);
    }
    if let Some(dir) = log.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let line = serde_json::to_string(alarm).map_err(std::io::Error::other)?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)?;
    writeln!(f, "{line}")?;
    Ok(true)
}

/// Log `alarm` (once per id) and say it on stderr every time.
fn raise(alarm: &Alarm) {
    eprintln!("flat-canary: {} — {}", alarm.title, alarm.detail);
    match log_path() {
        Some(log) => {
            if let Err(e) = raise_in(&log, alarm) {
                eprintln!("flat-canary: not logged to {}: {e}", log.display());
            }
        }
        None => eprintln!("flat-canary: no config folder for {LOG_FILE}"),
    }
}

/// The bell's notices: the bundle check now, and every behaviour notice
/// the log holds (the bell drops the ones he dismissed).
pub fn notices(binary: &Path) -> Vec<Alarm> {
    let mut out: Vec<Alarm> = bundle_alarm(binary).into_iter().collect();
    if let Some(log) = log_path() {
        for a in read_log(&log) {
            if a.kind == AlarmKind::Cache && !out.iter().any(|o| o.id == a.id) {
                out.push(a);
            }
        }
    }
    out
}

#[cfg(test)]
#[path = "flat_canary_tests.rs"]
mod tests;
