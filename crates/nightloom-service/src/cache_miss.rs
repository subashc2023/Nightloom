//! The cache-miss family guard (nightshift item 727, 2026-11-16): every
//! request Nightloom sends a chat's Claude Code session through — a turn,
//! the first turn after a rewind, a keep-warm ping, an aside — should read
//! the chat's prompt cache back. Bug 725 was one way it did not (a turn
//! that edited the project's notes changed the system prompt, so the next
//! request, in that chat and in every other chat of the project, wrote the
//! whole history again). This module is the guard against the family, in
//! two halves:
//!
//! - **The prefix print** ([`parts_of`], [`print_of`]): a stable hash of
//!   each part of the request Nightloom controls — the system-prompt
//!   layers it appends, the tool and MCP configuration, the model flags,
//!   the settings and the rest of argv — recorded per request in a sidecar
//!   beside the chat's keep-warm lines ([`PRINTS_FILE`], texts in
//!   [`PARTS_DIR`] by hash). A sidecar and not a field on the chat's log:
//!   pings and asides write nothing into the log (`keep_warm`'s rule), the
//!   log is what the window replays and syncs, and the texts (the appended
//!   prompt is ~30–40 KB) would bloat every turn's line. The tests below
//!   build the parts twice around each legitimate between-turn change and
//!   assert the print holds.
//! - **The unexplained-miss detector** ([`examine`], [`check`]): after each
//!   request, the first round's cache read under 80% of the context it
//!   resumed (`bin/cachecheck.py`'s rule) is a miss. A miss is *explained*
//!   when the cache had expired (the gap since the chat's previous request
//!   is over its lifetime: 1 h for Claude Code's writes) or when he chose
//!   it (item 699's markers — an edit, elide, unelide, compaction, a layer
//!   or the kind changed — or a cache-key setting that differs, or an
//!   aside on another model). Every other miss gets one line in
//!   `~/.nightloom/logs/cache-miss.jsonl` ([`Record`]) naming the part that
//!   changed and the first lines that differ on each side, for
//!   `nightshift-code/bin/cachemiss.py` to surface. Never on the turn's
//!   path: the shell runs it on a blocking thread after the result is
//!   back, and every failure is a log line, not an error.
//!
//! **Where the evidence comes from**, best first: (1) a turn's own CLI
//! session file — the CLI writes an `api-request-shape` line (`shapeHash`,
//! `shape.system[]`, `shape.tools[]`) whenever a request's shape changes,
//! so two of them diff exactly; (2) Nightloom's own prefix prints, for a
//! ping or an aside, which keep no session file (`--no-session-persistence`);
//! (3) failing both, where the read stopped: the cache is read up to the
//! last breakpoint that matched, so a read the size of the prefix up to
//! system block *k* locates the change in block *k* (an estimate from the
//! parent's last shape, said so in the record).

use crate::agent::AgentSpec;
use nightloom_core::{CacheTtl, Session, SessionEvent};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

/// The log the detector appends to, under `<config>/logs/`.
pub const LOG_FILE: &str = "cache-miss.jsonl";
/// One line per request in the chat's folder: when, what kind, the print.
pub const PRINTS_FILE: &str = "prefix-print.jsonl";
/// The parts' texts by hash, beside [`PRINTS_FILE`], for the diff lines.
pub const PARTS_DIR: &str = "prefix-parts";
/// A first round reading this share of the context it resumed is a hit.
pub const HIT_SHARE: f64 = 0.8;
/// Claude Code's writes live an hour; the API's default five minutes.
pub const ONE_HOUR_MS: i64 = 3_600_000;
pub const FIVE_MINUTES_MS: i64 = 300_000;
/// The parts that shape the cached prefix. The rest (settings, the MCP
/// config's full text, argv) is printed and kept, but legitimately differs
/// between a turn and its fork: an aside's `dontAsk` permission mode, its
/// own browser endpoint (measured to read the cache, `agent::AgentSpec::aside`).
pub const CACHE_PARTS: [&str; 6] = [
    "system",
    "append",
    "tools",
    "mcp_servers",
    "agents",
    "model",
];
/// Diff lines kept per side, and the record's cap on them in bytes.
const DIFF_LINES: usize = 5;
const DIFF_BYTES: usize = 2048;
const LINE_CHARS: usize = 240;
/// A shape line may be written a little after the round's `sent_at`.
const SHAPE_GRACE_MS: i64 = 120_000;

/// `~/.nightloom/logs/cache-miss.jsonl` (or under `NIGHTLOOM_HOME`).
pub fn log_path() -> Option<PathBuf> {
    crate::project::config_dir().map(|c| c.join("logs").join(LOG_FILE))
}

/// FNV-1a, 64-bit, as 16 hex digits: stable across builds and releases
/// (std's hasher promises neither), and equality is all a print needs.
pub fn fnv64(s: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

// ---- the prefix print ----

/// The request's parts by name, as text: what `spec` would put on argv for
/// a turn, with the prompt and the session plumbing (`--resume`,
/// `--fork-session`, `--no-session-persistence`, `--max-turns`,
/// `--max-budget-usd`, the stdin flags) left out — they change per request
/// and never reach the cached prefix.
pub fn parts_of(spec: &AgentSpec) -> BTreeMap<String, String> {
    let argv = spec.args("");
    // `-p ""` leads every shape.
    split_argv(argv.get(2..).unwrap_or_default())
}

/// [`parts_of`] over an argv already built (also the fork spec's).
pub fn split_argv(argv: &[String]) -> BTreeMap<String, String> {
    let mut parts: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut put = |name: &str, v: String| parts.entry(name.to_string()).or_default().push(v);
    let mut i = 0;
    while i < argv.len() {
        let a = argv[i].as_str();
        let next = argv.get(i + 1).cloned().unwrap_or_default();
        match a {
            "--resume" | "--max-turns" | "--max-budget-usd" | "--input-format" => i += 2,
            "--fork-session" | "--no-session-persistence" | "--replay-user-messages" => i += 1,
            "--system-prompt" | "--append-system-prompt" | "--settings" | "--agents" => {
                let name = match a {
                    "--system-prompt" => "system",
                    "--append-system-prompt" => "append",
                    "--settings" => "settings",
                    _ => "agents",
                };
                put(name, next);
                i += 2;
            }
            "--mcp-config" => {
                put("mcp_servers", mcp_server_names(&next));
                put("mcp", next);
                i += 2;
            }
            "--model" | "--effort" | "--fallback-model" => {
                put("model", format!("{a} {next}"));
                i += 2;
            }
            "--tools" | "--allowedTools" | "--disallowedTools" => {
                // Variadic: every value up to the next flag (`--tools ""`
                // is one empty value).
                let mut j = i + 1;
                let mut vals = Vec::new();
                while j < argv.len() && !argv[j].starts_with("--") {
                    vals.push(argv[j].clone());
                    j += 1;
                }
                put("tools", format!("{a} {}", vals.join(",")));
                i = j;
            }
            "--chrome" | "--no-chrome" => {
                put("tools", a.to_string());
                i += 1;
            }
            _ => {
                put("argv", a.to_string());
                i += 1;
            }
        }
    }
    parts.into_iter().map(|(k, v)| (k, v.join("\n"))).collect()
}

/// The MCP config's server names, sorted — what decides the tools
/// offered; the servers' arguments (a side browser's endpoint) do not.
fn mcp_server_names(cfg: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(cfg) {
        Ok(v) => {
            let mut names: Vec<String> = v
                .get("mcpServers")
                .and_then(|s| s.as_object())
                .map(|m| m.keys().cloned().collect())
                .unwrap_or_default();
            names.sort();
            names.join(",")
        }
        Err(_) => format!("unparsed {}", fnv64(cfg)),
    }
}

/// Each part's hash.
pub fn print_of(parts: &BTreeMap<String, String>) -> BTreeMap<String, String> {
    parts.iter().map(|(k, v)| (k.clone(), fnv64(v))).collect()
}

/// The names whose hash differs between two prints (a part on one side
/// only counts), limited to `only` when given.
pub fn changed(
    a: &BTreeMap<String, String>,
    b: &BTreeMap<String, String>,
    only: Option<&[&str]>,
) -> Vec<String> {
    let names: BTreeSet<&String> = a.keys().chain(b.keys()).collect();
    names
        .into_iter()
        .filter(|n| only.is_none_or(|o| o.contains(&n.as_str())))
        .filter(|n| a.get(*n) != b.get(*n))
        .cloned()
        .collect()
}

/// What a request was.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Turn,
    Rewind,
    Ping,
    Aside,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Turn => "turn",
            Kind::Rewind => "rewind",
            Kind::Ping => "ping",
            Kind::Aside => "aside",
        }
    }
}

/// One line of [`PRINTS_FILE`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PrintLine {
    pub at_ms: i64,
    pub kind: Kind,
    pub print: BTreeMap<String, String>,
}

/// Record a request's print in the chat's folder, and each part's text
/// once by its hash (a part repeats from request to request, so the
/// folder grows by one file per new version of a part).
pub fn record_print(
    dir: &Path,
    kind: Kind,
    at_ms: i64,
    parts: &BTreeMap<String, String>,
) -> std::io::Result<()> {
    let texts = dir.join(PARTS_DIR);
    std::fs::create_dir_all(&texts)?;
    let print = print_of(parts);
    for (name, text) in parts {
        let path = texts.join(format!("{}.txt", print[name]));
        if !path.exists() {
            std::fs::write(&path, text)?;
        }
    }
    let line =
        serde_json::to_string(&PrintLine { at_ms, kind, print }).map_err(std::io::Error::other)?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(PRINTS_FILE))?;
    writeln!(f, "{line}")
}

/// [`record_print`], a failure logged and dropped (never the turn's error).
pub fn record_print_quiet(dir: &Path, kind: Kind, at_ms: i64, spec: &AgentSpec) {
    if let Err(e) = record_print(dir, kind, at_ms, &parts_of(spec)) {
        eprintln!(
            "cache-miss: prefix print not recorded in {}: {e}",
            dir.display()
        );
    }
}

/// The chat's prints, oldest first; unreadable lines skipped.
pub fn read_prints(dir: &Path) -> Vec<PrintLine> {
    let Ok(f) = std::fs::File::open(dir.join(PRINTS_FILE)) else {
        return Vec::new();
    };
    std::io::BufReader::new(f)
        .lines()
        .map_while(Result::ok)
        .filter_map(|l| serde_json::from_str(&l).ok())
        .collect()
}

fn part_text(dir: &Path, hash: &str) -> Option<String> {
    std::fs::read_to_string(dir.join(PARTS_DIR).join(format!("{hash}.txt"))).ok()
}

// ---- what a turn read, off the chat's log ----

/// A turn's first round against the reply before it (item 699's
/// `turnRead`, in Rust): `before` is how many assistant messages the log
/// held when the turn was sent.
#[derive(Debug, Clone, PartialEq)]
pub struct TurnRead {
    pub read: u64,
    pub write: u64,
    /// The previous live reply's prompt — the context this turn resumed.
    pub context: u64,
    /// When the first round and the previous reply were sent, unix ms.
    pub at_ms: Option<i64>,
    pub last_ms: Option<i64>,
    pub one_hour: bool,
    pub rewound: bool,
    /// Why the miss was his choice, if it was.
    pub chosen: Option<String>,
}

/// The assistant messages the log holds, for [`turn_read`]'s `before`.
pub fn assistant_count(session: &Session) -> usize {
    session
        .events()
        .iter()
        .filter(|e| matches!(e, SessionEvent::AssistantMessage { .. }))
        .count()
}

/// The markers between two replies that change the next prefix by his
/// choice (item 699's `CHOSEN`), by their log names.
const CHOSEN: [&str; 6] = [
    "edit",
    "elide",
    "unelide",
    "compaction",
    "prompt_layers",
    "kind",
];
/// The cache-key fields two replies are compared on (699's `KEY_FIELDS`).
const KEY_FIELDS: [&str; 7] = [
    "engine",
    "model",
    "tools",
    "safe_mode",
    "plan",
    "tools_switch",
    "thinking",
];

/// See [`TurnRead`]. `None` on the chat's first turn, a turn that wrote no
/// round, a first round that is not live, or no cache figure.
pub fn turn_read(session: &Session, before: usize) -> Option<TurnRead> {
    let events = session.events();
    let live: BTreeSet<usize> = session.live_events().iter().map(|(i, _)| *i).collect();
    let at = events
        .iter()
        .enumerate()
        .filter(|(_, e)| matches!(e, SessionEvent::AssistantMessage { .. }))
        .nth(before)
        .map(|(i, _)| i)?;
    if !live.contains(&at) {
        return None;
    }
    let prev = (0..at).rev().find(|i| {
        live.contains(i) && matches!(events[*i], SessionEvent::AssistantMessage { .. })
    })?;
    let (
        SessionEvent::AssistantMessage {
            usage: first,
            sent_at: first_sent,
            cache_key: first_key,
            ..
        },
        SessionEvent::AssistantMessage {
            usage: was,
            sent_at: was_sent,
            cache_ttl,
            cache_key: was_key,
            ..
        },
    ) = (&events[at], &events[prev])
    else {
        return None;
    };
    let read = first.cache_read_tokens?;
    let mut rewound = false;
    let mut chosen = None;
    for (i, e) in events.iter().enumerate().take(at).skip(prev + 1) {
        let name = serde_json::to_value(e)
            .ok()
            .and_then(|v| v.get("event").and_then(|n| n.as_str()).map(str::to_string))
            .unwrap_or_default();
        if name == "rewind" {
            rewound = true;
        } else if live.contains(&i) && CHOSEN.contains(&name.as_str()) {
            chosen = Some(format!("a {name} marker"));
        }
    }
    if chosen.is_none()
        && let (Some(a), Some(b)) = (was_key, first_key)
        && let (Ok(a), Ok(b)) = (serde_json::to_value(a), serde_json::to_value(b))
        && let Some(f) = KEY_FIELDS.iter().find(|f| a.get(**f) != b.get(**f))
    {
        chosen = Some(format!("the {f} setting changed"));
    }
    Some(TurnRead {
        read,
        write: first.cache_write_tokens.unwrap_or(0),
        context: was.input_tokens,
        at_ms: first_sent.map(|t| t.timestamp_millis()),
        last_ms: was_sent.map(|t| t.timestamp_millis()),
        one_hour: *cache_ttl == Some(CacheTtl::OneHour),
        rewound,
        chosen,
    })
}

/// The newest keep-warm ping that read the cache (a hit) before `at_ms`:
/// it restarted the cache's hour, so the gap is measured from it.
pub fn last_hit_ping(dir: &Path, at_ms: i64) -> Option<i64> {
    crate::keep_warm::read_pings(dir)
        .into_iter()
        .filter(|p| p.sent_ms < at_ms && p.hit)
        .map(|p| p.sent_ms)
        .max()
}

// ---- the verdict ----

/// What one request's first round says about the cache.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// No context to judge against (a first turn), or no gap known.
    Unjudged,
    Hit,
    Expired,
    Chosen(String),
    Unexplained,
}

/// `cachecheck.py`'s rule, then the two explanations.
pub fn judge(
    read: u64,
    context: u64,
    gap_ms: Option<i64>,
    one_hour: bool,
    chosen: Option<&str>,
) -> Verdict {
    if context == 0 {
        return Verdict::Unjudged;
    }
    if read as f64 >= HIT_SHARE * context as f64 {
        return Verdict::Hit;
    }
    let Some(gap) = gap_ms else {
        return Verdict::Unjudged;
    };
    let life = if one_hour {
        ONE_HOUR_MS
    } else {
        FIVE_MINUTES_MS
    };
    if gap > life {
        return Verdict::Expired;
    }
    match chosen {
        Some(c) => Verdict::Chosen(c.to_string()),
        None => Verdict::Unexplained,
    }
}

// ---- the CLI's request shapes ----

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct SystemBlock {
    #[serde(default)]
    pub text: String,
}

/// `shape` on an `api-request-shape` line.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
pub struct Shape {
    #[serde(default)]
    pub system: Vec<SystemBlock>,
    #[serde(default)]
    pub tools: Vec<serde_json::Value>,
}

/// One `api-request-shape` line, by when it was written.
#[derive(Debug, Clone, PartialEq)]
pub struct Stamped {
    pub at_ms: i64,
    pub hash: String,
    pub shape: Shape,
}

#[derive(Deserialize)]
struct ShapeLine {
    #[serde(rename = "type")]
    kind: String,
    timestamp: String,
    #[serde(rename = "shapeHash", default)]
    shape_hash: String,
    shape: Shape,
}

/// Every request shape in a CLI session file, oldest first. Only lines
/// naming the type are parsed (the file is megabytes of history).
pub fn read_shapes(file: &Path) -> Vec<Stamped> {
    let Ok(f) = std::fs::File::open(file) else {
        return Vec::new();
    };
    std::io::BufReader::new(f)
        .lines()
        .map_while(Result::ok)
        .filter(|l| l.contains("\"api-request-shape\""))
        .filter_map(|l| serde_json::from_str::<ShapeLine>(&l).ok())
        .filter(|s| s.kind == "api-request-shape")
        .filter_map(|s| {
            let at = chrono::DateTime::parse_from_rfc3339(&s.timestamp).ok()?;
            Some(Stamped {
                at_ms: at.timestamp_millis(),
                hash: s.shape_hash,
                shape: s.shape,
            })
        })
        .collect()
}

/// What changed between two prefixes, and how that was known.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Diff {
    /// The first part that changed, in prefix order (`system block 2`,
    /// `tools`, `argv`, `unknown`).
    pub part: String,
    /// Every part that changed.
    pub changed: Vec<String>,
    pub how: String,
    pub was: Vec<String>,
    pub now: Vec<String>,
}

fn tool_name(t: &serde_json::Value) -> String {
    t.get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("?")
        .to_string()
}

/// The parts that differ between two shapes; `None` when none does.
/// Tools come first in the prefix, but a tool list grown mid-turn by the
/// CLI's deferred tools was measured not to cost a read (item 725's c4b8),
/// so a system block that changed is named first.
pub fn diff_shapes(a: &Shape, b: &Shape) -> Option<Diff> {
    let mut changed = Vec::new();
    let mut lines = None;
    for i in 0..a.system.len().max(b.system.len()) {
        let (x, y) = (a.system.get(i), b.system.get(i));
        if x != y {
            changed.push(format!("system block {i}"));
            if lines.is_none() {
                lines = Some(line_diff(
                    x.map_or("", |s| s.text.as_str()),
                    y.map_or("", |s| s.text.as_str()),
                ));
            }
        }
    }
    if a.tools != b.tools {
        let an: Vec<String> = a.tools.iter().map(tool_name).collect();
        let bn: Vec<String> = b.tools.iter().map(tool_name).collect();
        changed.push("tools".into());
        if lines.is_none() {
            let gone: Vec<String> = an.iter().filter(|n| !bn.contains(n)).cloned().collect();
            let came: Vec<String> = bn.iter().filter(|n| !an.contains(n)).cloned().collect();
            lines = Some(if gone.is_empty() && came.is_empty() {
                let x: Vec<String> = a
                    .tools
                    .iter()
                    .zip(&b.tools)
                    .filter(|(x, y)| x != y)
                    .map(|(x, _)| format!("tool {} changed", tool_name(x)))
                    .collect();
                (x.clone(), x)
            } else {
                (gone, came)
            });
        }
    }
    let (was, now) = lines?;
    Some(Diff {
        part: changed[0].clone(),
        changed,
        how: String::new(),
        was,
        now,
    })
}

/// The first lines of `a` not in `b`, and of `b` not in `a`, each cut to
/// [`LINE_CHARS`] and together under [`DIFF_BYTES`].
pub fn line_diff(a: &str, b: &str) -> (Vec<String>, Vec<String>) {
    let (sa, sb): (BTreeSet<&str>, BTreeSet<&str>) = (a.lines().collect(), b.lines().collect());
    let side = |text: &str, other: &BTreeSet<&str>| -> Vec<String> {
        let mut out = Vec::new();
        let mut bytes = 0;
        for l in text.lines().filter(|l| !other.contains(l)) {
            if out.len() == DIFF_LINES {
                break;
            }
            let cut: String = l.chars().take(LINE_CHARS).collect();
            bytes += cut.len();
            if bytes > DIFF_BYTES / 2 {
                break;
            }
            out.push(cut);
        }
        out
    };
    let (was, now) = (side(a, &sb), side(b, &sa));
    if !was.is_empty() || !now.is_empty() || a == b {
        return (was, now);
    }
    // The same lines in another order (a listing re-sorted): the first
    // positions that differ.
    let (mut was, mut now, mut bytes) = (Vec::new(), Vec::new(), 0);
    for (x, y) in a
        .lines()
        .zip(b.lines())
        .filter(|(x, y)| x != y)
        .take(DIFF_LINES)
    {
        let (x, y): (String, String) = (
            x.chars().take(LINE_CHARS).collect(),
            y.chars().take(LINE_CHARS).collect(),
        );
        bytes += x.len() + y.len();
        if bytes > DIFF_BYTES {
            break;
        }
        was.push(x);
        now.push(y);
    }
    (was, now)
}

/// The CLI system block holding `text` (Nightloom's appended prompt sits
/// inside the CLI's last block), by its first 200 characters.
pub fn block_holding(shape: &Shape, text: &str) -> Option<usize> {
    let head: String = text.chars().take(200).collect();
    if head.trim().is_empty() {
        return None;
    }
    shape.system.iter().position(|b| b.text.contains(&head))
}

/// Characters per token the read-boundary estimate allows: the prefix
/// measured 3.1 and 3.5 on the two misses of 2026-11-15.
const CHARS_PER_TOKEN: (f64, f64) = (2.8, 4.0);

/// Where a read of `read` tokens stopped in `shape` (estimate): the cache is
/// read up to the last breakpoint that matched, and the prefix runs tools,
/// then system blocks. The latest boundary the read's size is consistent
/// with is taken; the part after it is the one that changed.
pub fn locate_by_read(shape: &Shape, read: u64) -> Option<String> {
    let mut ends: Vec<(usize, String)> = Vec::new();
    let mut cum = shape
        .tools
        .iter()
        .map(|t| t.to_string().len())
        .sum::<usize>();
    ends.push((cum, "tools".into()));
    for (i, b) in shape.system.iter().enumerate() {
        cum += b.text.len();
        ends.push((cum, format!("system block {i}")));
    }
    let read = read as f64;
    let fits = |chars: usize| {
        chars as f64 / CHARS_PER_TOKEN.1 <= read && read <= chars as f64 / CHARS_PER_TOKEN.0
    };
    if ends
        .first()
        .is_some_and(|(c, _)| (*c as f64) / CHARS_PER_TOKEN.1 > read)
    {
        return Some("tools".into());
    }
    let k = ends.iter().rposition(|(c, _)| fits(*c))?;
    Some(match ends.get(k + 1) {
        Some((_, name)) => name.clone(),
        None => "messages".into(),
    })
}

// ---- the check ----

/// One request to judge, as the shell knows it at its end.
#[derive(Debug, Clone)]
pub struct Request {
    pub kind: Kind,
    pub chat: String,
    pub project: Option<String>,
    /// When the first round was sent, unix ms.
    pub at_ms: i64,
    pub read: u64,
    pub context: u64,
    /// The chat's previous request that left the cache, unix ms.
    pub last_ms: Option<i64>,
    pub one_hour: bool,
    pub cost_usd: Option<f64>,
    pub chosen: Option<String>,
    /// The CLI session file holding the shapes: a turn's own, a ping's or
    /// an aside's parent.
    pub cli_file: Option<PathBuf>,
    /// The chat's folder, holding the prefix prints.
    pub ask_dir: Option<PathBuf>,
}

/// One line of [`LOG_FILE`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Record {
    /// Local time, 12-hour, for a person; `at_ms` for a program.
    pub time: String,
    pub at_ms: i64,
    pub chat: String,
    pub project: Option<String>,
    pub kind: Kind,
    pub read: u64,
    pub context: u64,
    pub gap_ms: Option<i64>,
    pub gap: String,
    pub cost_usd: Option<f64>,
    pub part: String,
    pub changed: Vec<String>,
    pub how: String,
    pub was: Vec<String>,
    pub now: Vec<String>,
    pub cli_session: Option<String>,
}

fn gap_words(ms: Option<i64>) -> String {
    match ms {
        None => "unknown".into(),
        Some(ms) if ms < 120_000 => format!("{} s", ms / 1000),
        Some(ms) => format!("{} min", ms / 60_000),
    }
}

fn local_time(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| {
            t.with_timezone(&chrono::Local)
                .format("%Y-%m-%d %I:%M:%S %p")
                .to_string()
        })
        .unwrap_or_default()
}

/// The print recorded for this request (the newest of its kind at or
/// before its send, within a few minutes) and the newest turn's before it.
fn prints_around(dir: &Path, req: &Request) -> Option<(PrintLine, PrintLine)> {
    let lines = read_prints(dir);
    let this_i = lines.iter().rposition(|l| {
        (l.kind == req.kind || matches!((l.kind, req.kind), (Kind::Turn, Kind::Rewind)))
            && l.at_ms <= req.at_ms + SHAPE_GRACE_MS
            && l.at_ms >= req.at_ms - 10 * 60_000
    })?;
    let prior = lines[..this_i]
        .iter()
        .rev()
        .find(|l| matches!(l.kind, Kind::Turn | Kind::Rewind))?;
    Some((prior.clone(), lines[this_i].clone()))
}

/// Nightloom's own parts that changed, as a diff, with the appended
/// prompt named by the CLI block that holds it when a shape is known.
fn print_diff(dir: &Path, req: &Request, shape: Option<&Shape>) -> Option<Diff> {
    let (was, now) = prints_around(dir, req)?;
    let names = changed(&was.print, &now.print, Some(&CACHE_PARTS));
    if names.is_empty() {
        return Some(Diff {
            part: "unchanged".into(),
            ..Diff::default()
        });
    }
    let first = &names[0];
    let (a, b) = (
        part_text(dir, &was.print.get(first).cloned().unwrap_or_default()).unwrap_or_default(),
        part_text(dir, &now.print.get(first).cloned().unwrap_or_default()).unwrap_or_default(),
    );
    let name = |n: &String| -> String {
        if n == "append" || n == "system" {
            if let Some(k) = shape.and_then(|s| block_holding(s, &a)) {
                return format!("system block {k}");
            }
            return if n == "append" {
                "appended system prompt".into()
            } else {
                "system prompt".into()
            };
        }
        if n == "mcp_servers" || n == "tools" {
            return "tools".into();
        }
        n.clone()
    };
    let (w, n) = line_diff(&a, &b);
    Some(Diff {
        part: name(first),
        changed: names.iter().map(name).collect(),
        how: "Nightloom's prefix print".into(),
        was: w,
        now: n,
    })
}

/// Judge `req` and, for an unexplained miss, the record to log. Reads the
/// CLI session file and the chat's prints; writes nothing.
pub fn examine(req: &Request) -> Option<Record> {
    let gap = req.last_ms.map(|l| req.at_ms - l);
    if judge(
        req.read,
        req.context,
        gap,
        req.one_hour,
        req.chosen.as_deref(),
    ) != Verdict::Unexplained
    {
        return None;
    }
    let shapes = req.cli_file.as_deref().map(read_shapes).unwrap_or_default();
    let last = req.last_ms.unwrap_or(i64::MIN);
    let mut diff = None;
    if matches!(req.kind, Kind::Turn | Kind::Rewind) {
        // The shape this request went out with, written since the
        // previous request, against the one in force before it.
        let window: Vec<&Stamped> = shapes
            .iter()
            .filter(|s| s.at_ms > last && s.at_ms <= req.at_ms + SHAPE_GRACE_MS)
            .collect();
        if let (Some(now), Some(base)) =
            (window.last(), shapes.iter().rev().find(|s| s.at_ms <= last))
            && let Some(mut d) = diff_shapes(&base.shape, &now.shape)
        {
            d.how = "the CLI's request shapes".into();
            diff = Some(d);
        }
    }
    // The newest shape at or before this request: the parent's, for a
    // fork that keeps no file.
    let parent = shapes
        .iter()
        .rev()
        .find(|s| s.at_ms <= req.at_ms + SHAPE_GRACE_MS);
    if diff.is_none() {
        let printed = req
            .ask_dir
            .as_deref()
            .and_then(|d| print_diff(d, req, parent.map(|s| &s.shape)));
        match printed {
            Some(d) if d.part != "unchanged" => diff = Some(d),
            other => {
                let unchanged = other.is_some();
                let located = parent.and_then(|s| locate_by_read(&s.shape, req.read));
                diff = Some(match located {
                    Some(part) => Diff {
                        changed: vec![part.clone()],
                        part,
                        how: format!(
                            "where the read stopped in the last request shape (estimate{})",
                            if unchanged {
                                "; Nightloom's own parts unchanged, so the CLI's side"
                            } else {
                                "; no prefix print to compare"
                            }
                        ),
                        ..Diff::default()
                    },
                    None => Diff {
                        part: "unknown".into(),
                        changed: Vec::new(),
                        how: if unchanged {
                            "Nightloom's own parts unchanged; no request shape to locate the read in".into()
                        } else {
                            "no request shape and no prefix print".into()
                        },
                        ..Diff::default()
                    },
                });
            }
        }
    }
    let d = diff.unwrap_or_default();
    Some(Record {
        time: local_time(req.at_ms),
        at_ms: req.at_ms,
        chat: req.chat.clone(),
        project: req.project.clone(),
        kind: req.kind,
        read: req.read,
        context: req.context,
        gap_ms: gap,
        gap: gap_words(gap),
        cost_usd: req.cost_usd,
        part: d.part,
        changed: d.changed,
        how: d.how,
        was: d.was,
        now: d.now,
        cli_session: req
            .cli_file
            .as_deref()
            .and_then(|f| f.file_stem())
            .map(|s| s.to_string_lossy().into_owned()),
    })
}

/// Append one record to `log`, creating its folder.
pub fn append(log: &Path, rec: &Record) -> std::io::Result<()> {
    if let Some(dir) = log.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let line = serde_json::to_string(rec).map_err(std::io::Error::other)?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)?;
    writeln!(f, "{line}")
}

/// [`examine`] and, for an unexplained miss, [`append`] to [`log_path`].
/// Never fails: a failure is one stderr line. Call it off the turn's path
/// (`spawn_blocking`): it reads the CLI's session file.
pub fn check(req: &Request) {
    let Some(rec) = examine(req) else {
        return;
    };
    let Some(log) = log_path() else {
        eprintln!("cache-miss: no config folder for {LOG_FILE}");
        return;
    };
    if let Err(e) = append(&log, &rec) {
        eprintln!("cache-miss: not logged to {}: {e}", log.display());
    }
}

/// A finished turn's request, off the chat's log: `before` is
/// [`assistant_count`] taken before it was sent, `cli_session` the CLI
/// session it ran in (after a rewind, the fork), `cwd` the CLI's working
/// directory. `None` when there is nothing to judge (a first turn).
pub fn turn_request(
    session: &Session,
    before: usize,
    ask_dir: Option<&Path>,
    cwd: &Path,
    cli_session: Option<&str>,
    cost_usd: Option<f64>,
) -> Option<Request> {
    let t = turn_read(session, before)?;
    let at_ms = t.at_ms?;
    let ping = ask_dir.and_then(|d| last_hit_ping(d, at_ms));
    let last_ms = match (t.last_ms, ping) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    };
    Some(Request {
        kind: if t.rewound { Kind::Rewind } else { Kind::Turn },
        chat: session.id.clone(),
        project: ask_dir.and_then(project_of),
        at_ms,
        read: t.read,
        context: t.context,
        last_ms,
        one_hour: t.one_hour,
        cost_usd,
        chosen: t.chosen,
        cli_file: cli_file(cwd, cli_session),
        ask_dir: ask_dir.map(Path::to_path_buf),
    })
}

/// An aside's request: sent at `sent_ms`, its first round's read, against
/// the chat's newest reply. `chosen` when he asked it on another model or
/// effort than the chat's (the prefix is the model's own).
#[allow(clippy::too_many_arguments)]
pub fn aside_request(
    session: &Session,
    ask_dir: Option<&Path>,
    cwd: &Path,
    cli_session: Option<&str>,
    sent_ms: i64,
    first_read: u64,
    cost_usd: Option<f64>,
    other_model: bool,
) -> Option<Request> {
    let reply = crate::keep_warm::reply_of(session)?;
    let ping = ask_dir.and_then(|d| last_hit_ping(d, sent_ms));
    Some(Request {
        kind: Kind::Aside,
        chat: session.id.clone(),
        project: ask_dir.and_then(project_of),
        at_ms: sent_ms,
        read: first_read,
        context: reply.context,
        last_ms: Some(ping.map_or(reply.sent_ms, |p| p.max(reply.sent_ms))),
        one_hour: reply.one_hour,
        cost_usd,
        chosen: other_model.then(|| "an aside on another model or effort".to_string()),
        cli_file: cli_file(cwd, cli_session),
        ask_dir: ask_dir.map(Path::to_path_buf),
    })
}

/// The chat's folder for its log: `<log dir>/ask/<log stem>/` (as
/// `send_agent` names it).
pub fn ask_dir_of(session: &Session) -> Option<PathBuf> {
    let log = session.log_path()?;
    Some(log.parent()?.join("ask").join(log.file_stem()?))
}

/// The CLI session file a request reads its shapes from: `<id>.jsonl`
/// under the CLI's folder for `cwd`.
pub fn cli_file(cwd: &Path, session_id: Option<&str>) -> Option<PathBuf> {
    let id = session_id?;
    let dir = crate::agent::cli_session::project_dir(cwd)?;
    Some(dir.join(format!("{id}.jsonl")))
}

/// The project id of a chat's folder `<config>/projects/<id>/sessions/ask/<chat>`.
pub fn project_of(ask_dir: &Path) -> Option<String> {
    let parts: Vec<_> = ask_dir.components().map(|c| c.as_os_str()).collect();
    let n = parts.len();
    (n >= 5 && parts[n - 5] == "projects" && parts[n - 3] == "sessions" && parts[n - 2] == "ask")
        .then(|| parts[n - 4].to_string_lossy().into_owned())
}

#[cfg(test)]
#[path = "cache_miss_tests.rs"]
mod tests;
