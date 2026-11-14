//! Keep a chat's 1-hour prompt cache warm (nightshift backlog 582,
//! 2026-11-10; the research is item 541, his yes is blocker 1786).
//!
//! **What it is.** A chat's cache — Anthropic's server-side copy of its
//! processed history — lives one hour from the last request that read
//! it. Left alone past that, his next message pays to write the whole
//! context again (2x the input price) instead of reading it (0.05x on
//! Opus 5.5). A *keep-warm ping* is a small request made only to read it:
//! here a throwaway fork of the chat's Claude Code session
//! ([`AgentSpec::keep_warm_ping`] — `--resume <id> --fork-session
//! --no-session-persistence`, the aside's shape), measured to read the
//! parent's cache, refresh it, and leave the parent's history untouched
//! (blocker 1787: a fork ping at +50 min, the chat at +105 min read all
//! 163,740 tokens and rebuilt nothing).
//!
//! **The policy** (item 541's replay of his real chats): **on by default
//! for every chat** since item 608 (his "i dont have to like click it",
//! 2026-11-10) — the default is his Settings switch, kept in
//! [`DEFAULT_FILE`]; a chat's own switch, once he sets it, is kept in its
//! folder and wins over the default. On, a ping every [`PING_EVERY_MS`] (55 min) after the last
//! reply, none later than [`CAP_MS`] (6 h) after it — **the one cap, here
//! and in `<config>/keep-warm-policy.json`; items 580 and 579 retune it
//! there** — only on the 1-hour cache, only for contexts of
//! [`MIN_CONTEXT`] tokens or more. It ends when he sends (the next reply
//! starts it again), when the chat's tab is closed or the chat deleted,
//! or when the app quits (the facts a ping needs are held in memory only;
//! the switch itself is on disk and stays). A close ends the run but
//! leaves the switch as it was (item 608: written "off", every chat he
//! ever closed would be off for good under an on default).
//!
//! **Holding one chat longer** (item 643): a chat can be held for 12 or
//! 24 h instead of the cap ([`Registry::set_hold`], [`HOLD_FILE`]). While
//! held its cap is the hold's hours after each reply; once a whole hold
//! passes with no reply, the hold goes and the chat is back on the cap.
//!
//! **Never a second writer, never a surprise.** A ping does not run while
//! the chat's own turn does ([`Registry::due`]'s `busy`), is cancelled
//! when he sends ([`Registry::sent`]), is not sent once the cache has
//! already gone cold (the Mac slept: it would pay the rebuild he may
//! never need — [`Why::Cold`]), and stops for good after a ping that read
//! under half the context ([`Why::Missed`]: the prefix did not match, and
//! every further ping would be a rebuild).
//!
//! **Where it is kept.** Beside the chat's reply figures
//! (`<log dir>/ask/<chat>/`): the switch in [`MODE_FILE`], one line per
//! ping in [`PINGS_FILE`] — its cache read and write, output and the
//! CLI's cost estimate — so the chat's figures can count what keeping it
//! warm spent. Nothing goes into the chat's log, and the fork leaves no
//! session file (`--no-session-persistence`), so no list, search or
//! history can show one.
//!
//! **An aside counts as a read** (item 677, his "it doesn't update in the
//! aside that cache bar still stays where it was"): an aside is the
//! ping's shape — a fork of the chat on its cache — so an answer that read
//! at least half the reply's context ([`aside_refreshes`], the ping's own
//! hit rule) moves the cache's hour, and the next ping, to when the aside
//! was sent ([`Registry::aside_read`]). Kept apart from the pings' read,
//! so an aside never uses up a hold (blocker 1954 counts only a ping that
//! had to keep the cache).
//!
//! This module is the schedule ([`step`]), the per-chat state
//! ([`Registry`]) and the ping ([`ping`]); the shell owns the clock and
//! says which chats are busy.

use crate::agent::{AgentSpec, ClaudeCodeAgent};
use nightloom_core::{CacheTtl, Session, SessionEvent};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use tokio_util::sync::CancellationToken;

/// A ping this long after the cache was last read: 55 minutes, five
/// under the hour the entry lives.
pub const PING_EVERY_MS: i64 = 55 * 60_000;
/// **The cap**: no ping later than this after the chat's last reply. Six
/// hours until items 580 / 579 retune it (`keep-warm-policy.json`).
pub const CAP_MS: i64 = 6 * 3_600_000;
/// Contexts under this are not kept warm: a rebuild costs under $0.40.
pub const MIN_CONTEXT: u64 = 50_000;
/// The 1-hour cache's lifetime.
pub const TTL_MS: i64 = 3_600_000;
/// The switch, per chat, beside `turn-usage.jsonl`.
pub const MODE_FILE: &str = "keep-warm.json";
/// One line per ping, per chat, beside `turn-usage.jsonl`.
pub const PINGS_FILE: &str = "keep-warm.jsonl";
/// The policy file in the config directory; every field optional.
pub const POLICY_FILE: &str = "keep-warm-policy.json";
/// His Settings switch "Keep chats' caches warm automatically", in the
/// config directory: `{"on": bool}`; no file reads as on (item 608). Its
/// own file, so a retune of the policy (580/579) never touches it.
pub const DEFAULT_FILE: &str = "keep-warm-default.json";
/// A chat's "hold longer" (item 643, his "click hold for logner"), beside
/// [`MODE_FILE`]: `{"hours": 12|24, "until_ms": …}`. Its own file, so the
/// on/off choice (item 608) is never rewritten by it.
pub const HOLD_FILE: &str = "keep-warm-hold.json";
/// The longer caps a chat can be held for, in hours; the default is the
/// policy's cap (6 h).
pub const HOLD_HOURS: [u32; 2] = [12, 24];
/// A test-only interval in seconds (a measurement, a dev run): read from
/// the environment, never from the shipped defaults.
pub const TEST_EVERY_ENV: &str = "NIGHTLOOM_KEEP_WARM_EVERY_S";
/// What the fork is asked. Not one word, on purpose: a bare "ok" after a
/// reply that ended on a question reads as his assent, and `--max-turns
/// 1` runs a tool call before it stops (081-report, M4).
pub const PING_PROMPT: &str = "Keep-warm ping from Nightloom, not a message from the user: reply with the single word ok. Do not call any tool and do not continue any task.";

/// The schedule's three numbers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Policy {
    pub every_ms: i64,
    pub cap_ms: i64,
    pub min_context: u64,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            every_ms: PING_EVERY_MS,
            cap_ms: CAP_MS,
            min_context: MIN_CONTEXT,
        }
    }
}

#[derive(Deserialize, Default)]
struct PolicyFile {
    every_min: Option<f64>,
    cap_hours: Option<f64>,
    min_context: Option<u64>,
}

impl Policy {
    /// The defaults, overridden field by field from `text` (the policy
    /// file) and then by the test-only interval. The interval is kept
    /// under the cache's lifetime, or a ping would always come too late.
    pub fn from_parts(text: Option<&str>, test_every_s: Option<&str>) -> Self {
        let file: PolicyFile = text
            .and_then(|t| serde_json::from_str(t).ok())
            .unwrap_or_default();
        let mut p = Self::default();
        if let Some(m) = file.every_min.filter(|m| m.is_finite() && *m > 0.0) {
            p.every_ms = (m * 60_000.0) as i64;
        }
        if let Some(h) = file.cap_hours.filter(|h| h.is_finite() && *h >= 0.0) {
            p.cap_ms = (h * 3_600_000.0) as i64;
        }
        if let Some(n) = file.min_context {
            p.min_context = n;
        }
        if let Some(s) = test_every_s.and_then(|s| s.trim().parse::<i64>().ok()) {
            p.every_ms = s * 1000;
        }
        p.every_ms = p.every_ms.clamp(5_000, TTL_MS - 2 * 60_000);
        p
    }

    /// As [`Self::from_parts`], from `<config dir>/keep-warm-policy.json`
    /// and the environment.
    pub fn load(config_dir: Option<&Path>) -> Self {
        let text = config_dir.and_then(|d| std::fs::read_to_string(d.join(POLICY_FILE)).ok());
        Self::from_parts(
            text.as_deref(),
            std::env::var(TEST_EVERY_ENV).ok().as_deref(),
        )
    }
}

/// The chat's switch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Off,
    /// On after every reply, until he switches it off.
    On,
    /// "Keep warm until I'm back": on until his next message in the chat.
    Once,
}

/// The chat's last reply, as the schedule needs it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reply {
    /// When its request was sent — where the cache's hour starts.
    pub sent_ms: i64,
    /// The prefix the next request sends: the reply's input plus output.
    pub context: u64,
    /// The cache it left is the 1-hour kind.
    pub one_hour: bool,
}

/// The newest live reply of `session`, or nothing before the first that
/// recorded when it was sent (the cache timer's rule, backlog 063).
pub fn reply_of(session: &Session) -> Option<Reply> {
    let live = session.live_events();
    let (_, last) = live
        .iter()
        .rev()
        .find(|(_, e)| matches!(e, SessionEvent::AssistantMessage { .. }))?;
    let SessionEvent::AssistantMessage {
        usage,
        sent_at,
        cache_ttl,
        ..
    } = last
    else {
        return None;
    };
    Some(Reply {
        sent_ms: (*sent_at)?.timestamp_millis(),
        context: usage.input_tokens + usage.output_tokens,
        one_hour: *cache_ttl == Some(CacheTtl::OneHour),
    })
}

/// Whether an aside sent at `sent_ms` that read `cache_read` tokens from
/// cache (its newest round's read: every round sends the chat's prefix)
/// refreshed `reply`'s cache (item 677): sent after the reply, and a read
/// of at least half its context — a ping's hit ([`Registry::done`]). A
/// read of less matched only the head of the prefix; the rest still
/// runs out on the reply's (or the last ping's) hour.
pub fn aside_refreshes(reply: &Reply, sent_ms: i64, cache_read: u64) -> bool {
    sent_ms > reply.sent_ms && cache_read.saturating_mul(2) >= reply.context
}

/// Why nothing is scheduled.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Why {
    /// The switch is off.
    Off,
    /// No reply to keep warm yet (none since the app started, or since
    /// he last sent).
    NoReply,
    /// The context is under the floor.
    Small,
    /// The reply's cache is not the 1-hour kind.
    NotOneHour,
    /// The cap after the last reply has passed; the cache runs out its hour.
    Cap,
    /// The cache went cold before a ping could run (the Mac slept).
    Cold,
    /// A ping read under half the context: pinging stopped.
    Missed,
    /// The chat's own turn is running; the ping waits for it.
    Busy,
}

/// What the schedule says at `now`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Ping,
    /// The next ping's time, unix ms.
    Wait(i64),
    Idle(Why),
}

/// The schedule, whole. `touched_ms` is when the cache was last read by
/// a ping (the reply's send before the first); `missed` that a ping read
/// too little; `busy` that the chat's own turn runs.
pub fn step(
    mode: Mode,
    reply: Option<&Reply>,
    touched_ms: Option<i64>,
    missed: bool,
    busy: bool,
    policy: &Policy,
    now: i64,
) -> Step {
    if mode == Mode::Off {
        return Step::Idle(Why::Off);
    }
    let Some(reply) = reply else {
        return Step::Idle(Why::NoReply);
    };
    if !reply.one_hour {
        return Step::Idle(Why::NotOneHour);
    }
    if reply.context < policy.min_context {
        return Step::Idle(Why::Small);
    }
    if missed {
        return Step::Idle(Why::Missed);
    }
    let touched = touched_ms.unwrap_or(reply.sent_ms);
    let due = touched + policy.every_ms;
    if due > reply.sent_ms + policy.cap_ms {
        return Step::Idle(Why::Cap);
    }
    if now < due {
        return Step::Wait(due);
    }
    if now >= touched + TTL_MS {
        return Step::Idle(Why::Cold);
    }
    if busy {
        return Step::Idle(Why::Busy);
    }
    Step::Ping
}

/// When the cache goes cold if every remaining ping runs on time: the
/// last ping the cap allows, plus the hour. With nothing scheduled, the
/// hour after the last read.
pub fn warm_until(reply: &Reply, touched_ms: Option<i64>, scheduled: bool, policy: &Policy) -> i64 {
    let touched = touched_ms.unwrap_or(reply.sent_ms);
    if !scheduled {
        return touched + TTL_MS;
    }
    let room = reply.sent_ms + policy.cap_ms - touched;
    let left = if room > 0 { room / policy.every_ms } else { 0 };
    touched + left * policy.every_ms + TTL_MS
}

/// One ping's line in [`PINGS_FILE`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PingLine {
    /// When the ping's request was sent, unix ms.
    pub sent_ms: i64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub input: u64,
    pub output: u64,
    /// The CLI's API-equivalent estimate; not a bill on the plan.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// The context it was meant to read.
    pub context: u64,
    /// It read at least half of it.
    pub hit: bool,
    /// What went wrong, when something did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// What a chat's pings have spent, summed from its file.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize)]
pub struct Spent {
    pub pings: u32,
    pub cache_read: u64,
    pub cache_write: u64,
    pub output: u64,
    pub cost_usd: f64,
}

impl Spent {
    fn add(&mut self, l: &PingLine) {
        self.pings += 1;
        self.cache_read += l.cache_read;
        self.cache_write += l.cache_write;
        self.output += l.output;
        self.cost_usd += l.cost_usd.unwrap_or(0.0);
    }
}

pub fn read_pings(dir: &Path) -> Vec<PingLine> {
    std::fs::read_to_string(dir.join(PINGS_FILE))
        .map(|t| {
            t.lines()
                .filter_map(|l| serde_json::from_str(l).ok())
                .collect()
        })
        .unwrap_or_default()
}

fn append_ping(dir: &Path, line: &PingLine) {
    use std::io::Write as _;
    let _ = std::fs::create_dir_all(dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(PINGS_FILE))
        && let Ok(text) = serde_json::to_string(line)
    {
        let _ = writeln!(f, "{text}");
    }
}

#[derive(Serialize, Deserialize, Default)]
struct ModeFile {
    mode: Mode,
    #[serde(default)]
    set_ms: i64,
}

/// His own choice for the chat, as its folder holds it; `None` when he
/// never set it (the default applies).
pub fn read_choice(dir: &Path) -> Option<Mode> {
    std::fs::read_to_string(dir.join(MODE_FILE))
        .ok()
        .and_then(|t| serde_json::from_str::<ModeFile>(&t).ok())
        .map(|f| f.mode)
}

/// The chat's own switch; off when he never set it.
pub fn read_mode(dir: &Path) -> Mode {
    read_choice(dir).unwrap_or_default()
}

fn clear_choice(dir: &Path) {
    let _ = std::fs::remove_file(dir.join(MODE_FILE));
}

/// His Settings default from `<config dir>/keep-warm-default.json`; on
/// with no file or an unreadable one.
pub fn load_default(config_dir: Option<&Path>) -> bool {
    #[derive(Deserialize)]
    struct DefaultFile {
        on: bool,
    }
    config_dir
        .and_then(|d| std::fs::read_to_string(d.join(DEFAULT_FILE)).ok())
        .and_then(|t| serde_json::from_str::<DefaultFile>(&t).ok())
        .map(|f| f.on)
        .unwrap_or(true)
}

/// Write his Settings default.
pub fn save_default(config_dir: &Path, on: bool) -> Result<(), String> {
    std::fs::create_dir_all(config_dir).map_err(|e| e.to_string())?;
    let path = config_dir.join(DEFAULT_FILE);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, format!("{{\"on\":{on}}}")).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// A chat held longer than the default cap (item 643): its cap is
/// `hours` while `now < until_ms`; `until_ms` is the newest reply's send
/// plus `hours`, moved on at each reply. Past it the chat is back on the
/// policy's cap and the file goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hold {
    pub hours: u32,
    pub until_ms: i64,
}

impl Hold {
    pub fn ms(&self) -> i64 {
        i64::from(self.hours) * 3_600_000
    }

    /// The policy in force while held: the hold's cap, never shorter
    /// than the policy's own.
    pub fn apply(&self, policy: &Policy) -> Policy {
        Policy {
            cap_ms: policy.cap_ms.max(self.ms()),
            ..*policy
        }
    }
}

/// The chat's hold as its folder holds it; `None` without one, or with
/// hours that are not one of [`HOLD_HOURS`].
pub fn read_hold(dir: &Path) -> Option<Hold> {
    std::fs::read_to_string(dir.join(HOLD_FILE))
        .ok()
        .and_then(|t| serde_json::from_str::<Hold>(&t).ok())
        .filter(|h| HOLD_HOURS.contains(&h.hours))
}

fn write_hold(dir: &Path, hold: &Hold) {
    let path = dir.join(HOLD_FILE);
    let _ = std::fs::create_dir_all(dir);
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string(hold).unwrap_or_default();
    if std::fs::write(&tmp, text).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

fn clear_hold(dir: &Path) {
    let _ = std::fs::remove_file(dir.join(HOLD_FILE));
}

fn write_mode(dir: &Path, mode: Mode, now: i64) {
    let path = dir.join(MODE_FILE);
    let _ = std::fs::create_dir_all(dir);
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string(&ModeFile { mode, set_ms: now }).unwrap_or_default();
    if std::fs::write(&tmp, text).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

/// What a ping came back with.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PingResult {
    pub cache_read: u64,
    pub cache_write: u64,
    pub input: u64,
    pub output: u64,
    pub cost_usd: Option<f64>,
    pub model: Option<String>,
    pub error: Option<String>,
}

/// Run one ping: a fork of the session `spec` resumes, one round, the
/// chat's own model and tools so the prefix is the chat's. `Err` when the
/// spec has no session to fork or the process could not run.
pub async fn ping(spec: &AgentSpec, cancel: &CancellationToken) -> Result<PingResult, String> {
    let fork = spec
        .keep_warm_ping()
        .ok_or_else(|| "no Claude Code session to fork".to_string())?;
    let agent = ClaudeCodeAgent::new(spec.clone());
    let out = agent
        .run_with(&fork, PING_PROMPT, cancel, &mut |_| {})
        .await
        .map_err(|e| e.to_string())?;
    let read = out.usage.cache_read_tokens.unwrap_or(0);
    let write = out.usage.cache_write_tokens.unwrap_or(0);
    Ok(PingResult {
        cache_read: read,
        cache_write: write,
        // `input_tokens` is the whole prompt here (the gauge's reading);
        // what was neither read nor written is the uncached part.
        input: out.usage.input_tokens.saturating_sub(read + write),
        output: out.usage.output_tokens,
        cost_usd: out.cost_usd,
        model: out.model,
        error: out.is_error.then(|| {
            if out.text.trim().is_empty() {
                "the fork ended in an error".to_string()
            } else {
                out.text.chars().take(200).collect()
            }
        }),
    })
}

/// A chat's keep-warm, as the window shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Status {
    pub chat: String,
    /// The switch as it acts: his choice, else the default.
    pub mode: Mode,
    /// Whether the chat has his own choice (else `mode` is the default's).
    pub chosen: bool,
    /// His Settings default (item 608).
    pub default_on: bool,
    /// A ping is scheduled or running.
    pub scheduled: bool,
    /// When the cache goes cold if the schedule runs, unix ms; `None`
    /// with no reply on hand.
    pub warm_until_ms: Option<i64>,
    /// When the cache was last read by a ping or, since item 677, an
    /// aside, unix ms.
    pub touched_ms: Option<i64>,
    pub next_ping_ms: Option<i64>,
    /// Why nothing is scheduled, when nothing is.
    pub why: Option<Why>,
    pub spent: Spent,
    /// The policy's own numbers (the default cap among them).
    pub policy: Policy,
    /// The cap in force for this chat: the hold's while held, else the
    /// policy's (item 643).
    pub cap_ms: i64,
    /// The chat's hold, 12 or 24 h; `None` on the default cap.
    pub hold_hours: Option<u32>,
    /// When the hold runs out and the chat goes back to the default cap,
    /// unix ms (the newest reply's send plus the hold).
    pub hold_until_ms: Option<i64>,
}

/// A ping to run: [`Registry::due`] hands these out, [`Registry::done`]
/// takes the result.
pub struct Job {
    pub chat: String,
    pub spec: AgentSpec,
    pub cancel: CancellationToken,
    pub context: u64,
}

struct Entry {
    /// His own choice for the chat; `None` follows the default.
    chosen: Option<Mode>,
    dir: PathBuf,
    spec: Option<AgentSpec>,
    reply: Option<Reply>,
    touched_ms: Option<i64>,
    /// When an aside last refreshed the cache (item 677), unix ms. Counts
    /// only while it is later than the held reply's send, so a new reply
    /// (or none) needs no reset.
    aside_ms: Option<i64>,
    missed: bool,
    flying: Option<CancellationToken>,
    spent: Spent,
    /// His "hold longer" for the chat (item 643), as on disk.
    hold: Option<Hold>,
}

impl Entry {
    fn load(dir: &Path) -> Self {
        let mut spent = Spent::default();
        for l in read_pings(dir) {
            spent.add(&l);
        }
        Self {
            chosen: read_choice(dir),
            hold: read_hold(dir),
            dir: dir.to_path_buf(),
            spec: None,
            reply: None,
            touched_ms: None,
            aside_ms: None,
            missed: false,
            flying: None,
            spent,
        }
    }

    /// A chat no folder has been read for.
    fn blank() -> Self {
        Self {
            chosen: None,
            dir: PathBuf::new(),
            spec: None,
            reply: None,
            touched_ms: None,
            aside_ms: None,
            missed: false,
            flying: None,
            spent: Spent::default(),
            hold: None,
        }
    }

    /// When the cache was last read since the held reply: by a ping or by
    /// an aside (item 677), the later. `None` before either.
    fn last_read(&self) -> Option<i64> {
        let aside = self
            .aside_ms
            .filter(|&a| self.reply.is_some_and(|r| a > r.sent_ms));
        match (self.touched_ms, aside) {
            (Some(t), Some(a)) => Some(t.max(a)),
            (t, a) => t.or(a),
        }
    }

    /// The switch as it acts: his choice, else the default.
    fn mode(&self, default: Mode) -> Mode {
        self.chosen.unwrap_or(default)
    }

    /// The hold, once it has run out (`now` past its end): gone, on disk
    /// too, and the chat back on the default cap.
    fn expire_hold(&mut self, now: i64) {
        if self.hold.is_some_and(|h| now >= h.until_ms) {
            self.hold = None;
            clear_hold(&self.dir);
        }
    }

    /// The policy in force for the chat at `now` (item 643): the hold's
    /// cap while it lasts, else `policy` as it is.
    fn policy(&mut self, policy: &Policy, now: i64) -> Policy {
        self.expire_hold(now);
        self.hold.map_or(*policy, |h| h.apply(policy))
    }

    /// "Until I'm back" was answered (or its tab closed): back to off —
    /// his off when the default is on, the default's off otherwise.
    fn end_once(&mut self, default: Mode, now: i64) {
        if default == Mode::Off {
            self.chosen = None;
            clear_choice(&self.dir);
        } else {
            self.chosen = Some(Mode::Off);
            write_mode(&self.dir, Mode::Off, now);
        }
    }
}

/// Every chat's keep-warm the process knows. A std mutex, never held
/// across an await.
pub struct Registry {
    inner: Mutex<HashMap<String, Entry>>,
    /// His Settings default (item 608); on until the shell reads the file.
    default_on: AtomicBool,
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            inner: Mutex::default(),
            default_on: AtomicBool::new(true),
        }
    }
}

impl Registry {
    fn inner(&self) -> MutexGuard<'_, HashMap<String, Entry>> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// His Settings default: every chat without a choice of its own
    /// follows it. Switching it off stops the pings of those chats.
    pub fn set_default(&self, on: bool) {
        self.default_on.store(on, Ordering::Relaxed);
        if !on {
            for e in self.inner().values_mut() {
                if e.chosen.is_none()
                    && let Some(c) = e.flying.take()
                {
                    c.cancel();
                }
            }
        }
    }

    pub fn default_on(&self) -> bool {
        self.default_on.load(Ordering::Relaxed)
    }

    fn default_mode(&self) -> Mode {
        if self.default_on() {
            Mode::On
        } else {
            Mode::Off
        }
    }

    /// Set the chat's switch, on disk and here. `facts` — the chat's spec
    /// (pointed at its session) and last reply — start the schedule now;
    /// without them it starts at the chat's next reply.
    pub fn set_mode(
        &self,
        chat: &str,
        dir: &Path,
        mode: Mode,
        facts: Option<(AgentSpec, Reply)>,
        now: i64,
    ) {
        let mut inner = self.inner();
        let e = inner
            .entry(chat.to_string())
            .or_insert_with(|| Entry::load(dir));
        e.dir = dir.to_path_buf();
        e.chosen = Some(mode);
        e.missed = false;
        write_mode(dir, mode, now);
        if mode == Mode::Off {
            if let Some(c) = e.flying.take() {
                c.cancel();
            }
            // Off is off: a hold longer goes with it (item 643).
            if e.hold.take().is_some() {
                clear_hold(dir);
            }
            return;
        }
        if let Some((spec, reply)) = facts {
            // The same reply as before keeps what its pings refreshed.
            if e.reply != Some(reply) {
                e.touched_ms = None;
            }
            e.spec = Some(spec);
            e.reply = Some(reply);
        }
    }

    /// Hold the chat warm longer (item 643): `hours` one of
    /// [`HOLD_HOURS`] caps it at that many hours after each reply until a
    /// gap that long passes without one; anything else (the default's 6)
    /// takes the hold away. A chat whose switch reads off is switched on
    /// — his own on — since a hold on an off chat would keep nothing.
    /// `facts` as for [`Self::set_mode`].
    pub fn set_hold(
        &self,
        chat: &str,
        dir: &Path,
        hours: u32,
        facts: Option<(AgentSpec, Reply)>,
        now: i64,
    ) {
        let default = self.default_mode();
        let hold = HOLD_HOURS.contains(&hours).then(|| {
            let from = {
                let inner = self.inner();
                facts
                    .as_ref()
                    .map(|(_, r)| r.sent_ms)
                    .or_else(|| inner.get(chat).and_then(|e| e.reply.map(|r| r.sent_ms)))
                    .unwrap_or(now)
            };
            Hold {
                hours,
                until_ms: from + i64::from(hours) * 3_600_000,
            }
        });
        let off = {
            let mut inner = self.inner();
            let e = inner
                .entry(chat.to_string())
                .or_insert_with(|| Entry::load(dir));
            e.dir = dir.to_path_buf();
            e.hold = hold;
            match &hold {
                Some(h) => write_hold(dir, h),
                None => clear_hold(dir),
            }
            e.mode(default) == Mode::Off
        };
        if hold.is_some() && off {
            self.set_mode(chat, dir, Mode::On, facts, now);
        } else if let Some((spec, reply)) = facts {
            let mut inner = self.inner();
            if let Some(e) = inner.get_mut(chat)
                && e.mode(default) != Mode::Off
            {
                if e.reply != Some(reply) {
                    e.touched_ms = None;
                }
                e.spec = Some(spec);
                e.reply = Some(reply);
            }
        }
    }

    /// He sent a message in the chat: a ping in flight is stopped, the
    /// reply it kept warm is no longer the newest, and "until I'm back"
    /// has been answered. `true` when the switch changed.
    pub fn sent(&self, chat: &str, dir: Option<&Path>, now: i64) -> bool {
        let default = self.default_mode();
        let mut inner = self.inner();
        if !inner.contains_key(chat) {
            // A chat switched on in an earlier run of the app: its file
            // is the only trace until something reads it.
            match dir {
                Some(d) if read_choice(d).unwrap_or(default) != Mode::Off => {
                    inner.insert(chat.to_string(), Entry::load(d));
                }
                _ => return false,
            }
        }
        let Some(e) = inner.get_mut(chat) else {
            return false;
        };
        if let Some(c) = e.flying.take() {
            c.cancel();
        }
        e.reply = None;
        e.touched_ms = None;
        e.missed = false;
        if e.chosen == Some(Mode::Once) {
            e.end_once(default, now);
            return true;
        }
        false
    }

    /// The chat's turn ended with a reply: the schedule starts from it,
    /// when the switch is on.
    pub fn replied(&self, chat: &str, dir: &Path, spec: &AgentSpec, reply: Option<Reply>) {
        let default = self.default_mode();
        let mut inner = self.inner();
        if !inner.contains_key(chat) {
            if read_choice(dir).unwrap_or(default) == Mode::Off {
                return;
            }
            inner.insert(chat.to_string(), Entry::load(dir));
        }
        let Some(e) = inner.get_mut(chat) else {
            return;
        };
        if e.mode(default) == Mode::Off {
            return;
        }
        // Item 643: a hold that ran out before this message went out is
        // gone; one still running counts its hours from this reply.
        // Blocker 1954 (his answer, 2026-11-12): back within the cache's own
        // hour (no ping had to keep it) and the hold goes on; back later,
        // after a ping kept it warm, and the hold is used — the default again.
        if let Some(r) = reply {
            e.expire_hold(r.sent_ms);
            if e.touched_ms.is_some() && e.hold.is_some() {
                e.hold = None;
                clear_hold(&e.dir);
            }
            if let Some(h) = e.hold.as_mut() {
                h.until_ms = h.until_ms.max(r.sent_ms + h.ms());
                let h = *h;
                write_hold(&e.dir, &h);
            }
        }
        e.spec = Some(spec.clone());
        e.reply = reply;
        e.touched_ms = None;
        e.missed = false;
    }

    /// The chat's tab was closed or the chat deleted: its run ends (a ping
    /// in flight is cancelled, the reply forgotten). The switch stays as
    /// he left it (item 608) — but "until I'm back" ends, as at a send.
    /// `true` when it was on.
    pub fn stop(&self, chat: &str, now: i64) -> bool {
        let default = self.default_mode();
        let mut inner = self.inner();
        let Some(mut e) = inner.remove(chat) else {
            return false;
        };
        if let Some(c) = e.flying.take() {
            c.cancel();
        }
        let was_on = e.mode(default) != Mode::Off;
        if e.chosen == Some(Mode::Once) {
            e.end_once(default, now);
        }
        was_on
    }

    /// A chat shown with its last reply and agent on hand (after an app
    /// restart, or a tab reopened): when its switch is on and no run is
    /// held, the run starts from that reply — the default needs no reply
    /// first. `step`'s guards decide whether anything is pinged.
    pub fn offer(&self, chat: &str, dir: &Path, spec: &AgentSpec, reply: Reply) -> bool {
        let default = self.default_mode();
        let mut inner = self.inner();
        let e = inner
            .entry(chat.to_string())
            .or_insert_with(|| Entry::load(dir));
        if e.mode(default) == Mode::Off || e.reply.is_some() || e.flying.is_some() {
            return false;
        }
        e.spec = Some(spec.clone());
        e.reply = Some(reply);
        e.touched_ms = None;
        e.missed = false;
        true
    }

    /// Whether the chat would take [`Self::offer`]'s facts: on, nothing held.
    pub fn wants_facts(&self, chat: &str, dir: &Path) -> bool {
        let default = self.default_mode();
        match self.inner().get(chat) {
            Some(e) => e.mode(default) != Mode::Off && e.reply.is_none() && e.flying.is_none(),
            None => read_choice(dir).unwrap_or(default) != Mode::Off,
        }
    }

    /// The pings to run now. Each is marked in flight until
    /// [`Self::done`]; `busy` says whether a chat's own turn is running.
    pub fn due(&self, policy: &Policy, now: i64, busy: impl Fn(&str) -> bool) -> Vec<Job> {
        let default = self.default_mode();
        let mut inner = self.inner();
        let mut jobs = Vec::new();
        for (chat, e) in inner.iter_mut() {
            let mode = e.mode(default);
            if mode == Mode::Off || e.flying.is_some() {
                continue;
            }
            let held = e.policy(policy, now);
            let (Some(spec), Some(reply)) = (&e.spec, &e.reply) else {
                continue;
            };
            // Asked only when a ping is otherwise due: the answer takes a lock.
            if step(
                mode,
                Some(reply),
                e.last_read(),
                e.missed,
                false,
                &held,
                now,
            ) != Step::Ping
                || busy(chat)
            {
                continue;
            }
            let cancel = CancellationToken::new();
            e.flying = Some(cancel.clone());
            jobs.push(Job {
                chat: chat.clone(),
                spec: spec.clone(),
                cancel,
                context: reply.context,
            });
        }
        jobs
    }

    /// A ping ended. Its line is written; a read of at least half the
    /// context moves the cache's hour to `sent_ms`, anything less stops
    /// the pinging. A ping he cancelled by sending leaves no trace.
    pub fn done(&self, job: &Job, sent_ms: i64, result: Result<PingResult, String>) {
        let mut inner = self.inner();
        let Some(e) = inner.get_mut(&job.chat) else {
            return;
        };
        // His send (or a switch-off) took the token away; this ping is
        // about a reply that is no longer the newest.
        let ours = e
            .flying
            .as_ref()
            .is_some_and(|_| !job.cancel.is_cancelled());
        if !ours {
            return;
        }
        e.flying = None;
        let r = match result {
            Ok(r) => r,
            Err(error) => PingResult {
                error: Some(error),
                ..PingResult::default()
            },
        };
        let hit = r.cache_read * 2 >= job.context;
        let line = PingLine {
            sent_ms,
            cache_read: r.cache_read,
            cache_write: r.cache_write,
            input: r.input,
            output: r.output,
            cost_usd: r.cost_usd,
            model: r.model,
            context: job.context,
            hit,
            error: r.error,
        };
        append_ping(&e.dir, &line);
        e.spent.add(&line);
        if hit {
            e.touched_ms = Some(sent_ms);
        } else {
            e.missed = true;
        }
    }

    /// An aside in `chat`, sent at `sent_ms`, read `cache_read` tokens
    /// from cache (item 677): when that refreshed the held reply's cache
    /// ([`aside_refreshes`]), the cache's hour and the next ping count
    /// from it. `true` when the schedule moved. A chat with nothing held
    /// (switched off, or no reply yet) has no schedule to move.
    pub fn aside_read(&self, chat: &str, sent_ms: i64, cache_read: u64) -> bool {
        let mut inner = self.inner();
        let Some(e) = inner.get_mut(chat) else {
            return false;
        };
        let Some(reply) = e.reply else {
            return false;
        };
        if !aside_refreshes(&reply, sent_ms, cache_read) || e.aside_ms.is_some_and(|a| a >= sent_ms)
        {
            return false;
        }
        e.aside_ms = Some(sent_ms);
        true
    }

    /// The chat's status. A chat this run has not seen is read from `dir`.
    pub fn status(&self, chat: &str, dir: Option<&Path>, policy: &Policy, now: i64) -> Status {
        let default = self.default_mode();
        let mut inner = self.inner();
        if !inner.contains_key(chat)
            && let Some(d) = dir
            && (d.join(MODE_FILE).exists()
                || d.join(PINGS_FILE).exists()
                || d.join(HOLD_FILE).exists())
        {
            inner.insert(chat.to_string(), Entry::load(d));
        }
        let mut blank = Entry::blank();
        let e = inner.get_mut(chat).unwrap_or(&mut blank);
        let held = e.policy(policy, now);
        let e = &*e;
        let mode = e.mode(default);
        let flying = e.flying.is_some();
        let read = e.last_read();
        let s = step(mode, e.reply.as_ref(), read, e.missed, false, &held, now);
        let scheduled = flying || matches!(s, Step::Ping | Step::Wait(_));
        Status {
            chat: chat.to_string(),
            mode,
            chosen: e.chosen.is_some(),
            default_on: default == Mode::On,
            scheduled,
            warm_until_ms: e
                .reply
                .as_ref()
                .map(|r| warm_until(r, read, scheduled, &held)),
            touched_ms: read,
            next_ping_ms: match s {
                Step::Wait(at) => Some(at),
                Step::Ping => Some(now),
                Step::Idle(_) => None,
            },
            why: match s {
                Step::Idle(w) if !flying => Some(w),
                _ => None,
            },
            spent: e.spent,
            policy: *policy,
            cap_ms: held.cap_ms,
            hold_hours: e.hold.map(|h| h.hours),
            hold_until_ms: e.hold.map(|h| h.until_ms),
        }
    }

    /// Every chat the registry holds, sorted.
    pub fn known(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.inner().keys().cloned().collect();
        ids.sort();
        ids
    }

    /// The chats whose switch is on, sorted.
    pub fn on(&self) -> Vec<String> {
        let default = self.default_mode();
        let mut ids: Vec<String> = self
            .inner()
            .iter()
            .filter(|(_, e)| e.mode(default) != Mode::Off)
            .map(|(id, _)| id.clone())
            .collect();
        ids.sort();
        ids
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: i64 = 60_000;
    const HOUR: i64 = 3_600_000;

    fn reply(context: u64) -> Reply {
        Reply {
            sent_ms: 0,
            context,
            one_hour: true,
        }
    }

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nightloom-kw-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn spec() -> AgentSpec {
        let mut s = AgentSpec::new(PathBuf::from("/tmp"));
        s.resume = Some("sess-1".into());
        s
    }

    /// The whole run at the shipped numbers: a ping at 55 min and every
    /// 55 after, six in all, none past six hours; then the cache runs out
    /// its hour and nothing more is sent.
    #[test]
    fn pings_run_every_55_minutes_and_stop_at_the_cap() {
        let p = Policy::default();
        let r = reply(120_000);
        let mut touched = None;
        let mut now = 0;
        let mut pings = Vec::new();
        loop {
            match step(Mode::On, Some(&r), touched, false, false, &p, now) {
                Step::Wait(at) => now = at,
                Step::Ping => {
                    pings.push(now / MIN);
                    touched = Some(now);
                }
                Step::Idle(why) => {
                    assert_eq!(why, Why::Cap);
                    break;
                }
            }
        }
        assert_eq!(pings, vec![55, 110, 165, 220, 275, 330]);
        // Warm until the last ping plus the hour: 6 h 30 min after the reply.
        assert_eq!(warm_until(&r, None, true, &p), 390 * MIN);
        assert_eq!(warm_until(&r, touched, false, &p), 390 * MIN);
        // The cap is the one number: at four hours, four pings.
        let four = Policy {
            cap_ms: 4 * HOUR,
            ..p
        };
        assert_eq!(warm_until(&r, None, true, &four), (220 + 60) * MIN);
        // A cap under the interval pings never.
        let none = Policy {
            cap_ms: 30 * MIN,
            ..p
        };
        assert_eq!(
            step(Mode::On, Some(&r), None, false, false, &none, 0),
            Step::Idle(Why::Cap)
        );
    }

    #[test]
    fn nothing_is_pinged_off_small_short_lived_missed_or_without_a_reply() {
        let p = Policy::default();
        let at = 56 * MIN;
        let idle = |mode, r: Option<&Reply>, missed| step(mode, r, None, missed, false, &p, at);
        assert_eq!(
            idle(Mode::Off, Some(&reply(200_000)), false),
            Step::Idle(Why::Off)
        );
        assert_eq!(idle(Mode::On, None, false), Step::Idle(Why::NoReply));
        // The 50k floor: 49,999 no, 50,000 yes.
        assert_eq!(
            idle(Mode::On, Some(&reply(49_999)), false),
            Step::Idle(Why::Small)
        );
        assert_eq!(idle(Mode::On, Some(&reply(50_000)), false), Step::Ping);
        assert_eq!(idle(Mode::Once, Some(&reply(50_000)), false), Step::Ping);
        let five = Reply {
            one_hour: false,
            ..reply(200_000)
        };
        assert_eq!(
            idle(Mode::On, Some(&five), false),
            Step::Idle(Why::NotOneHour)
        );
        assert_eq!(
            idle(Mode::On, Some(&reply(200_000)), true),
            Step::Idle(Why::Missed)
        );
    }

    #[test]
    fn a_ping_waits_for_the_chats_turn_and_is_not_sent_into_a_cold_cache() {
        let p = Policy::default();
        let r = reply(100_000);
        let s = |busy, now| step(Mode::On, Some(&r), None, false, busy, &p, now);
        assert_eq!(s(false, 54 * MIN), Step::Wait(55 * MIN));
        assert_eq!(s(true, 56 * MIN), Step::Idle(Why::Busy));
        assert_eq!(s(false, 59 * MIN), Step::Ping);
        // The Mac slept through the hour: no ping, the rebuild is his to
        // pay only if he comes back.
        assert_eq!(s(false, 60 * MIN), Step::Idle(Why::Cold));
        assert_eq!(s(true, 3 * HOUR), Step::Idle(Why::Cold));
    }

    #[test]
    fn the_policy_file_and_the_test_interval_override_the_defaults() {
        assert_eq!(Policy::from_parts(None, None), Policy::default());
        let p = Policy::from_parts(Some(r#"{"cap_hours": 4}"#), None);
        assert_eq!(
            (p.cap_ms, p.every_ms, p.min_context),
            (4 * HOUR, PING_EVERY_MS, MIN_CONTEXT)
        );
        let p = Policy::from_parts(Some(r#"{"every_min": 50, "min_context": 80000}"#), None);
        assert_eq!((p.every_ms, p.min_context), (50 * MIN, 80_000));
        // Never at or past the cache's hour; a broken file is the defaults.
        assert_eq!(
            Policy::from_parts(Some(r#"{"every_min": 90}"#), None).every_ms,
            58 * MIN
        );
        assert_eq!(
            Policy::from_parts(Some("not json"), None),
            Policy::default()
        );
        assert_eq!(Policy::from_parts(None, Some("20")).every_ms, 20_000);
    }

    /// The registry end to end, no process: on, a reply, a ping due and
    /// handed out once, its result moving the hour, his send ending it.
    #[test]
    fn the_registry_hands_out_a_ping_once_and_his_send_ends_the_run() {
        let dir = scratch("reg");
        let reg = Registry::default();
        let p = Policy::default();
        reg.set_mode("c", &dir, Mode::On, Some((spec(), reply(100_000))), 0);
        assert_eq!(read_mode(&dir), Mode::On);
        assert!(reg.due(&p, 10 * MIN, |_| false).is_empty(), "not yet");
        assert!(reg.due(&p, 55 * MIN, |_| true).is_empty(), "its turn runs");
        let jobs = reg.due(&p, 55 * MIN, |_| false);
        assert_eq!(jobs.len(), 1);
        assert!(reg.due(&p, 55 * MIN, |_| false).is_empty(), "one in flight");
        let st = reg.status("c", None, &p, 55 * MIN);
        assert!(st.scheduled && st.why.is_none());
        reg.done(
            &jobs[0],
            55 * MIN,
            Ok(PingResult {
                cache_read: 99_800,
                cache_write: 300,
                output: 4,
                cost_usd: Some(0.02),
                ..PingResult::default()
            }),
        );
        let st = reg.status("c", None, &p, 56 * MIN);
        assert_eq!(st.touched_ms, Some(55 * MIN));
        assert_eq!(st.next_ping_ms, Some(110 * MIN));
        assert_eq!(st.warm_until_ms, Some(390 * MIN));
        assert_eq!((st.spent.pings, st.spent.cache_read), (1, 99_800));
        let lines = read_pings(&dir);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].hit);
        // He sends: nothing is due until the next reply; On stays on.
        assert!(!reg.sent("c", Some(&dir), 111 * MIN));
        assert!(reg.due(&p, 112 * MIN, |_| false).is_empty());
        assert_eq!(reg.status("c", None, &p, 112 * MIN).why, Some(Why::NoReply));
        let next = Reply {
            sent_ms: 113 * MIN,
            ..reply(101_000)
        };
        reg.replied("c", &dir, &spec(), Some(next));
        assert_eq!(
            reg.status("c", None, &p, 114 * MIN).next_ping_ms,
            Some((113 + 55) * MIN)
        );
        // The spent figures outlive the process: a fresh registry reads them.
        let again = Registry::default();
        let st = again.status("c", Some(&dir), &p, 0);
        assert_eq!((st.mode, st.spent.pings), (Mode::On, 1));
        assert_eq!(st.why, Some(Why::NoReply), "no facts after a restart");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn until_im_back_ends_at_his_send_and_a_send_cancels_a_ping_in_flight() {
        let dir = scratch("once");
        let reg = Registry::default();
        let p = Policy::default();
        reg.set_mode("c", &dir, Mode::Once, Some((spec(), reply(100_000))), 0);
        let jobs = reg.due(&p, 55 * MIN, |_| false);
        assert_eq!(jobs.len(), 1);
        assert!(reg.sent("c", Some(&dir), 56 * MIN), "the switch went off");
        assert!(jobs[0].cancel.is_cancelled());
        assert_eq!(read_mode(&dir), Mode::Off);
        // The cancelled ping's late result is dropped: no line, no hour moved.
        reg.done(&jobs[0], 55 * MIN, Ok(PingResult::default()));
        assert!(read_pings(&dir).is_empty());
        // And the next reply does not start it again.
        reg.replied("c", &dir, &spec(), Some(reply(100_000)));
        assert!(reg.due(&p, 55 * MIN, |_| false).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_ping_that_read_too_little_stops_the_pinging_and_a_close_ends_the_run() {
        let dir = scratch("miss");
        let reg = Registry::default();
        let p = Policy::default();
        reg.set_mode("c", &dir, Mode::On, Some((spec(), reply(100_000))), 0);
        let jobs = reg.due(&p, 55 * MIN, |_| false);
        reg.done(
            &jobs[0],
            55 * MIN,
            Ok(PingResult {
                cache_read: 11_000,
                cache_write: 89_000,
                ..PingResult::default()
            }),
        );
        assert_eq!(reg.status("c", None, &p, 56 * MIN).why, Some(Why::Missed));
        assert!(reg.due(&p, 3 * HOUR, |_| false).is_empty());
        assert!(!read_pings(&dir)[0].hit);
        // A failed process is a miss too, with its reason on the line.
        reg.set_mode("c", &dir, Mode::On, None, 0);
        let jobs = reg.due(&p, 55 * MIN, |_| false);
        reg.done(&jobs[0], 55 * MIN, Err("claude not found".into()));
        assert_eq!(
            read_pings(&dir)[1].error.as_deref(),
            Some("claude not found")
        );
        // His tab closed: the run ends and the chat leaves the registry,
        // but his switch stays on disk as he set it (item 608).
        reg.set_mode("c", &dir, Mode::On, None, 0);
        assert_eq!(reg.on(), vec!["c".to_string()]);
        assert!(reg.stop("c", 0));
        assert_eq!(read_mode(&dir), Mode::On);
        assert!(reg.on().is_empty());
        assert!(!reg.stop("c", 0));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Item 608: a chat he never set follows the default — on unless he
    /// switched the default off — with every guard of `step` intact.
    #[test]
    fn every_chat_is_kept_warm_by_default_and_his_own_choice_wins() {
        let dir = scratch("default");
        let reg = Registry::default();
        let p = Policy::default();
        assert!(reg.default_on(), "the shipped default is on");
        // A chat never touched: on, no file written for it.
        let st = reg.status("c", Some(&dir), &p, 0);
        assert_eq!((st.mode, st.chosen, st.default_on), (Mode::On, false, true));
        assert_eq!(st.why, Some(Why::NoReply));
        // Its reply starts the schedule without a click.
        reg.replied("c", &dir, &spec(), Some(reply(100_000)));
        assert_eq!(reg.on(), vec!["c".to_string()]);
        assert_eq!(reg.due(&p, 55 * MIN, |_| false).len(), 1);
        assert_eq!(read_choice(&dir), None, "the default writes nothing");
        // The guards still hold: a small context, a 5-minute cache.
        reg.replied("small", &dir, &spec(), Some(reply(49_999)));
        assert!(reg.due(&p, 55 * MIN, |_| false).is_empty());
        let short = Reply {
            one_hour: false,
            ..reply(200_000)
        };
        reg.replied("short", &dir, &spec(), Some(short));
        assert!(reg.due(&p, 55 * MIN, |_| false).is_empty());
        let _ = std::fs::remove_dir_all(&dir);

        // His off for one chat is kept, and outlives the process.
        let dir = scratch("default-off");
        let reg = Registry::default();
        reg.set_mode("c", &dir, Mode::Off, None, 0);
        assert_eq!(read_choice(&dir), Some(Mode::Off));
        reg.replied("c", &dir, &spec(), Some(reply(100_000)));
        assert!(reg.due(&p, 55 * MIN, |_| false).is_empty());
        let again = Registry::default();
        let st = again.status("c", Some(&dir), &p, 0);
        assert_eq!((st.mode, st.chosen), (Mode::Off, true));
        again.replied("c", &dir, &spec(), Some(reply(100_000)));
        assert!(again.due(&p, 55 * MIN, |_| false).is_empty());
        // A close does not turn a default chat off for good.
        let d2 = scratch("default-close");
        again.replied("d", &d2, &spec(), Some(reply(100_000)));
        assert!(again.stop("d", 0));
        assert_eq!(read_choice(&d2), None);
        assert_eq!(again.status("d", Some(&d2), &p, 0).mode, Mode::On);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&d2);
    }

    /// Item 608: the Settings default switched off: chats without a
    /// choice stop (a ping in flight is cancelled); his on stays on.
    #[test]
    fn the_default_off_stops_the_chats_that_follow_it_only() {
        let a = scratch("dflt-a");
        let b = scratch("dflt-b");
        let reg = Registry::default();
        let p = Policy::default();
        reg.replied("a", &a, &spec(), Some(reply(100_000)));
        reg.set_mode("b", &b, Mode::On, Some((spec(), reply(100_000))), 0);
        let jobs = reg.due(&p, 55 * MIN, |_| false);
        assert_eq!(jobs.len(), 2);
        reg.set_default(false);
        let a_job = jobs.iter().find(|j| j.chat == "a").unwrap();
        let b_job = jobs.iter().find(|j| j.chat == "b").unwrap();
        assert!(a_job.cancel.is_cancelled());
        assert!(!b_job.cancel.is_cancelled());
        assert_eq!(reg.on(), vec!["b".to_string()]);
        let st = reg.status("a", None, &p, 56 * MIN);
        assert_eq!(
            (st.mode, st.chosen, st.default_on),
            (Mode::Off, false, false)
        );
        // A new chat follows the off default; "until I'm back" then ends
        // back at the default's off, leaving no choice on disk.
        let c = scratch("dflt-c");
        assert_eq!(reg.status("c", Some(&c), &p, 0).mode, Mode::Off);
        reg.replied("c", &c, &spec(), Some(reply(100_000)));
        assert!(!reg.on().contains(&"c".to_string()));
        reg.set_mode("c", &c, Mode::Once, Some((spec(), reply(100_000))), 0);
        assert!(reg.sent("c", Some(&c), MIN));
        assert_eq!(read_choice(&c), None);
        for d in [a, b, c] {
            let _ = std::fs::remove_dir_all(&d);
        }
    }

    /// Item 608: a chat shown after a restart takes its last reply as the
    /// start, once; a chat already running or off does not.
    #[test]
    fn a_shown_chat_starts_from_its_last_reply_without_waiting() {
        let dir = scratch("offer");
        let reg = Registry::default();
        let p = Policy::default();
        assert!(reg.wants_facts("c", &dir));
        assert!(reg.offer("c", &dir, &spec(), reply(100_000)));
        assert!(!reg.wants_facts("c", &dir));
        assert!(!reg.offer("c", &dir, &spec(), reply(100_000)), "once");
        assert_eq!(reg.due(&p, 55 * MIN, |_| false).len(), 1);
        let off = scratch("offer-off");
        reg.set_mode("o", &off, Mode::Off, None, 0);
        assert!(!reg.wants_facts("o", &off));
        assert!(!reg.offer("o", &off, &spec(), reply(100_000)));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&off);
    }

    /// Pings every 55 min from 55 min up to `until`, each a hit; the
    /// minutes (after the reply) at which one ran.
    fn run_pings(reg: &Registry, p: &Policy, until: i64) -> Vec<i64> {
        let mut at = Vec::new();
        let mut t = 55 * MIN;
        while t <= until {
            for job in reg.due(p, t, |_| false) {
                let hit = PingResult {
                    cache_read: job.context,
                    ..PingResult::default()
                };
                reg.done(&job, t, Ok(hit));
                at.push(t / MIN);
            }
            t += 55 * MIN;
        }
        at
    }

    /// Item 643's proof: a chat held 24 h, idle 8 h, still pings; the
    /// same chat on the default 6 h has stopped.
    #[test]
    fn a_chat_held_24_hours_still_pings_at_8_hours_and_a_6_hour_one_stops() {
        let p = Policy::default();
        let eight = 8 * HOUR;

        let d6 = scratch("hold-6");
        let six = Registry::default();
        six.replied("c", &d6, &spec(), Some(reply(150_000)));
        let pings = run_pings(&six, &p, eight);
        assert_eq!(pings, vec![55, 110, 165, 220, 275, 330], "the 6 h cap");
        let st = six.status("c", Some(&d6), &p, eight);
        assert_eq!(
            (st.why, st.cap_ms, st.hold_hours),
            (Some(Why::Cap), 6 * HOUR, None)
        );

        let d24 = scratch("hold-24");
        let held = Registry::default();
        held.replied("c", &d24, &spec(), Some(reply(150_000)));
        held.set_hold("c", &d24, 24, None, 0);
        let pings = run_pings(&held, &p, eight);
        assert_eq!(pings.len(), 8, "a ping every 55 min through 8 h: {pings:?}");
        assert_eq!(pings.last(), Some(&440));
        let st = held.status("c", Some(&d24), &p, eight);
        assert!(st.scheduled, "still on schedule at 8 h");
        assert_eq!(
            (st.cap_ms, st.hold_hours, st.hold_until_ms),
            (24 * HOUR, Some(24), Some(24 * HOUR))
        );
        // The last ping the 24 h cap allows is at 23 h 50 min (26 × 55 min);
        // the cache stays warm an hour past it.
        assert_eq!(st.warm_until_ms, Some(26 * 55 * MIN + HOUR));
        // 12 h: a ping at 8 h too, none past 12 h.
        let d12 = scratch("hold-12");
        let twelve = Registry::default();
        twelve.replied("c", &d12, &spec(), Some(reply(150_000)));
        twelve.set_hold("c", &d12, 12, None, 0);
        let pings = run_pings(&twelve, &p, 30 * HOUR);
        assert_eq!(pings.len(), 13);
        assert_eq!(pings.last(), Some(&715));
        for d in [d6, d24, d12] {
            let _ = std::fs::remove_dir_all(&d);
        }
    }

    /// The hold is kept with the chat (a restart reads it), moves on with
    /// each reply, runs out after a whole hold with no reply, and goes
    /// with an off or a pick of the default.
    #[test]
    fn a_hold_is_kept_moves_on_with_each_reply_and_runs_out() {
        let p = Policy::default();
        let dir = scratch("hold-keep");
        let reg = Registry::default();
        reg.set_hold("c", &dir, 24, None, 0);
        assert_eq!(
            read_hold(&dir),
            Some(Hold {
                hours: 24,
                until_ms: 24 * HOUR
            })
        );
        // A restart: a new registry reads the hold from the folder.
        let again = Registry::default();
        let st = again.status("c", Some(&dir), &p, HOUR);
        assert_eq!((st.hold_hours, st.cap_ms), (Some(24), 24 * HOUR));
        // A reply at 10 h: the hold now ends 24 h after it.
        let late = Reply {
            sent_ms: 10 * HOUR,
            ..reply(100_000)
        };
        again.replied("c", &dir, &spec(), Some(late));
        assert_eq!(read_hold(&dir).map(|h| h.until_ms), Some(34 * HOUR));
        // Past its end with no reply: gone, on disk too; the default cap.
        let st = again.status("c", Some(&dir), &p, 34 * HOUR);
        assert_eq!((st.hold_hours, st.cap_ms), (None, 6 * HOUR));
        assert_eq!(read_hold(&dir), None);
        // A message after the hold ran out does not bring it back: held
        // 12 h from the 10 h reply (ends at 22 h), next message at 23 h.
        again.set_hold("c", &dir, 12, None, 0);
        assert_eq!(read_hold(&dir).map(|h| h.until_ms), Some(22 * HOUR));
        let after = Reply {
            sent_ms: 23 * HOUR,
            ..reply(100_000)
        };
        again.replied("c", &dir, &spec(), Some(after));
        assert_eq!(read_hold(&dir), None);
        // Picking the default (6) or switching off takes it away.
        again.set_hold("c", &dir, 12, None, 0);
        again.set_hold("c", &dir, 6, None, 0);
        assert_eq!(read_hold(&dir), None);
        again.set_hold("c", &dir, 24, None, 0);
        again.set_mode("c", &dir, Mode::Off, None, 0);
        assert_eq!(read_hold(&dir), None);
        assert_eq!(again.status("c", Some(&dir), &p, 0).hold_hours, None);
        // Hours that are not 12 or 24 on disk read as no hold.
        std::fs::write(dir.join(HOLD_FILE), r#"{"hours":100,"until_ms":0}"#).unwrap();
        assert_eq!(read_hold(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Blocker 1954: a reply within the cache's own hour (no ping since the
    /// last reply) keeps the hold going; a reply after a ping kept the
    /// cache warm uses the hold up, and the chat is back on the default.
    #[test]
    fn a_hold_is_used_once_a_ping_has_kept_the_cache() {
        let p = Policy::default();
        let dir = scratch("hold-used");
        let reg = Registry::default();
        reg.set_hold("c", &dir, 24, None, 0);
        let at = |h: i64| Reply {
            sent_ms: h * HOUR,
            ..reply(100_000)
        };
        // Back within the hour: no ping fired; the hold moves on.
        reg.replied("c", &dir, &spec(), Some(at(0)));
        assert_eq!(read_hold(&dir).map(|h| h.until_ms), Some(24 * HOUR));
        // A ping kept the cache at 1 h; he is back at 3 h: the hold is used.
        reg.inner().get_mut("c").unwrap().touched_ms = Some(HOUR);
        reg.replied("c", &dir, &spec(), Some(at(3)));
        assert_eq!(read_hold(&dir), None);
        let st = reg.status("c", Some(&dir), &p, 3 * HOUR);
        assert_eq!((st.hold_hours, st.cap_ms), (None, 6 * HOUR));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Item 677: an aside that read at least half the context moves the
    /// cache's hour and the next ping to when it was sent; one that read
    /// less, or was sent before the reply, moves nothing.
    #[test]
    fn an_aside_that_read_the_cache_moves_the_next_ping() {
        let p = Policy::default();
        let dir = scratch("aside-read");
        let reg = Registry::default();
        reg.replied("c", &dir, &spec(), Some(reply(100_000)));
        assert_eq!(
            reg.status("c", Some(&dir), &p, MIN).next_ping_ms,
            Some(55 * MIN)
        );
        // Under half: only the head of the prefix was read.
        assert!(!reg.aside_read("c", 20 * MIN, 49_999));
        assert!(!reg.aside_read("c", 0, 100_000), "not after the reply");
        assert_eq!(
            reg.status("c", Some(&dir), &p, 21 * MIN).next_ping_ms,
            Some(55 * MIN)
        );
        // Half or more (his aside read 53%): the hour runs from the aside.
        assert!(reg.aside_read("c", 20 * MIN, 53_000));
        let st = reg.status("c", Some(&dir), &p, 21 * MIN);
        assert_eq!(st.next_ping_ms, Some(75 * MIN));
        assert_eq!(st.touched_ms, Some(20 * MIN));
        assert!(
            !reg.aside_read("c", 10 * MIN, 100_000),
            "an older aside moves nothing back"
        );
        // A ping later than the aside wins; a new reply leaves the aside behind.
        reg.inner().get_mut("c").unwrap().touched_ms = Some(70 * MIN);
        assert_eq!(
            reg.status("c", Some(&dir), &p, 71 * MIN).next_ping_ms,
            Some(125 * MIN)
        );
        reg.replied(
            "c",
            &dir,
            &spec(),
            Some(Reply {
                sent_ms: 2 * HOUR,
                ..reply(100_000)
            }),
        );
        assert_eq!(reg.status("c", Some(&dir), &p, 2 * HOUR).touched_ms, None);
        // Nothing held (an off chat): nothing to move.
        assert!(!reg.aside_read("nobody", HOUR, 100_000));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Item 677 with blocker 1954: an aside is him using the chat, not a
    /// ping keeping it — it never uses up a hold.
    #[test]
    fn an_aside_read_does_not_use_up_a_hold() {
        let dir = scratch("aside-hold");
        let reg = Registry::default();
        reg.set_hold("c", &dir, 24, None, 0);
        reg.replied("c", &dir, &spec(), Some(reply(100_000)));
        assert!(reg.aside_read("c", 30 * MIN, 100_000));
        reg.replied(
            "c",
            &dir,
            &spec(),
            Some(Reply {
                sent_ms: 3 * HOUR,
                ..reply(100_000)
            }),
        );
        assert_eq!(read_hold(&dir).map(|h| h.until_ms), Some(27 * HOUR));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A hold on a chat he switched off switches it on (his own on); on
    /// a chat on by default it leaves the choice as it was.
    #[test]
    fn a_hold_on_an_off_chat_switches_it_on() {
        let p = Policy::default();
        let dir = scratch("hold-off");
        let reg = Registry::default();
        reg.set_mode("c", &dir, Mode::Off, None, 0);
        reg.set_hold("c", &dir, 12, Some((spec(), reply(100_000))), 0);
        assert_eq!(read_choice(&dir), Some(Mode::On));
        let st = reg.status("c", Some(&dir), &p, 0);
        assert_eq!(
            (st.mode, st.scheduled, st.hold_hours),
            (Mode::On, true, Some(12))
        );
        let d2 = scratch("hold-dflt");
        reg.set_hold("d", &d2, 24, Some((spec(), reply(100_000))), 0);
        assert_eq!(
            read_choice(&d2),
            None,
            "the default's on stays the default's"
        );
        assert!(reg.status("d", Some(&d2), &p, 0).scheduled);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&d2);
    }

    #[test]
    fn the_settings_default_reads_on_without_a_file() {
        let dir = scratch("dfile");
        assert!(load_default(None));
        assert!(load_default(Some(&dir)));
        save_default(&dir, false).unwrap();
        assert!(!load_default(Some(&dir)));
        save_default(&dir, true).unwrap();
        assert!(load_default(Some(&dir)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The ping's command line: the chat's own, as a throwaway fork — no
    /// session file, one round — so nothing can list it.
    #[test]
    fn the_ping_is_a_fork_that_keeps_no_session_file() {
        let s = spec();
        let f = s.keep_warm_ping().expect("a session to fork");
        assert!(f.fork_session && f.no_session_persistence);
        assert_eq!(f.max_turns, Some(1));
        assert_eq!(
            (f.model.clone(), f.resume.clone()),
            (s.model.clone(), s.resume.clone())
        );
        let mut fresh = spec();
        fresh.resume = None;
        assert!(fresh.keep_warm_ping().is_none(), "nothing to fork");
    }
}
