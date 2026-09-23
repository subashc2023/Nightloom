//! The subagent brief: the preamble reaching every subagent (2026-09-17,
//! nightshift backlog 152, piece 2).
//!
//! A subagent — the CLI's `Agent` tool, a second model run inside the
//! same process — starts with "the agent's own prompt plus environment
//! details … not the Claude Code system prompt" (`external`, the
//! sub-agents doc), so nothing Nightloom sends with `--append-system-prompt`
//! reaches it: not the project's instructions, not the engine note that
//! names the vault alias, the search rule and Nightloom's own tools.
//! Measured on 2.1.263 (nightshift `104-survey-2026-09-17.md`, M2a): a
//! parent told a code word spawned a child asked for it, and the child
//! said `NO CODE WORD`.
//!
//! **The way through is a second `PreToolUse` hook, on the `Agent` tool
//! itself.** A hook may answer `allow` with `updatedInput`, which
//! "replaces the entire input object" (`external`, the hooks doc; the
//! Ask hook already uses it for a question's answers). This one returns
//! the call's input with the brief prepended to `prompt`, so the CLI
//! spawns the child on the brief plus the task the model wrote — with no
//! reliance on the model remembering to brief it. Measured 2026-09-17
//! (nightshift `152-report-2026-09-17.md`, M-B): the `system/task_started`
//! line's `prompt` began with the injected block, the child's first
//! `user` line carried it, and the child answered the code word the
//! parent never knew — `ZEBRAFISH`. The hook's input names the tool
//! **`Agent`** (the init line's `tools` still lists `Task`; the matcher
//! takes both).
//!
//! **The same binary is the hook** (`nightloom-desktop --subagent-hook
//! <dir>`; [`run_hook`]), for the reason the Ask hook is: the CLI spawns
//! whatever path it is given, and this binary is the one always present
//! inside the signed `.app`. The brief is a file in the chat's directory
//! ([`BRIEF_FILE`] beside the Ask position's `rules.json`), written by
//! [`super::ClaudeCodeAgent::set_ask_dir`] before each turn, so the hook
//! — another process, which sees only the directory — reads the chat's
//! current preamble.
//!
//! **What the brief carries, and what it cuts.** [`compose`] keeps two of
//! the preamble's segments — the project's instructions (`AGENTS.md`)
//! and the engine note (the file tools' names, the vault alias and its
//! directory, Nightloom's own tools by their full names, the search rule,
//! `remember`) — plus the extra-folders note when the chat has one. It
//! cuts the project-notes and vault **indexes** (the largest segments;
//! they exist for the parent to choose what to read, and a child's task
//! should name what it needs), the user's and the model's standing
//! instructions (about how the assistant talks to the user — a child
//! reports to its parent), the Chat instructions (a Chat cannot spawn:
//! the policy refuses `Agent`), the library prompt (the parent's persona,
//! not the child's), and the ask-note (a subagent cannot pause for the
//! card; telling it a person answers would be false). Every child's first
//! request writes its own cache anyway (104's table: 26k for a Haiku
//! child), so the brief's few hundred to few thousand tokens ride on a
//! write that was already being paid.

use super::ask::{HookReply, shell_quote};
use nightloom_core::{SegmentKind, SystemPrompt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// The brief's file name inside the chat's directory.
pub const BRIEF_FILE: &str = "subagent-brief.txt";

/// The hook's matcher. ~~`Agent|Task` — the tool's current name and its
/// older one~~ — **every tool since 2026-09-22 (nightshift backlog 165,
/// pass 2):** the one hook process now also enforces the turn's budget
/// ([`budget_verdict`]) on every call of the main thread, its subagents
/// and a council's seats, and only an `Agent`/`Task` call goes on to the
/// brief and the spawn caps ([`is_spawn`]). A JavaScript pattern, as the
/// Chat policy's is (`agent/mod.rs`, measured on 2.1.263).
pub const BRIEF_MATCHER: &str = ".*";

/// Whether a hook call is a spawn (the `Agent` tool; `Task` is its older
/// name, still what the init line lists).
pub fn is_spawn(tool_name: &str) -> bool {
    tool_name == "Agent" || tool_name == "Task"
}

/// The brief's opening tag — also the mark [`decide`] looks for at the
/// top of a task, so a task that already carries a brief (a nested
/// subagent's, spawned by a child whose own task began with one and who
/// copied it) is not given a second.
pub const BRIEF_OPEN: &str = "<nightloom-subagent-brief>";
const BRIEF_CLOSE: &str = "</nightloom-subagent-brief>";

/// How many subagents one turn may spawn (2026-09-17 ~20:40, his report:
/// a research turn spun up fourteen and "it's gonna kill my usage very
/// quickly"). The hook counts spawns in [`SPAWNS_FILE`] and refuses past
/// this with [`spawn_cap_reason`]; [`reset_spawns`] zeroes the count when
/// a turn starts (not when a deferred call resumes — that is the same
/// turn). A per-chat setting for the number is nightshift backlog 164.
pub const SPAWN_CAP: usize = 6;
/// The per-turn spawn count, beside the brief.
pub const SPAWNS_FILE: &str = "subagent-spawns.txt";

/// The refusal the model reads when the cap is reached — his wording.
/// ~~"The limit is set beside \"Subagents run on auto\""~~ — struck
/// 2026-09-18 (the review of `a4a681f`): no such setting exists; the cap
/// is this constant until backlog 165 builds the per-chat number, and a
/// sentence naming a control that is not there is one the parent repeats
/// to him.
pub fn spawn_cap_reason(cap: usize) -> String {
    format!(
        "Nightloom's limit is {cap} subagents in one turn, and this turn has spawned {cap}. \
         Wait for the running ones to finish and use their reports; if what is left is \
         small enough, do it yourself."
    )
}

/// Zero the turn's spawn count. Called when a turn starts.
pub fn reset_spawns(dir: &Path) {
    let _ = std::fs::remove_file(dir.join(SPAWNS_FILE));
}

// ---- the family of limits (nightshift backlog 165, 2026-09-18) ---------------

/// The subagent limits, each a setting with a default, written into the
/// chat's directory as [`LIMITS_FILE`] so the hook (a separate process
/// per `Agent` call) reads them without settings plumbing.
///
/// Three are the CLI's own and are *passed*, never re-implemented
/// (`external`, read from the 2.1.263 bundle's strings on 2026-09-18):
/// `concurrent` is `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (the CLI's
/// default 20; past it the Agent call is refused with *Concurrent
/// subagent limit reached. You can run N subagents at once. Do not
/// retry…* and counted under `subagent_stats.refused.concurrency_limit`);
/// `depth` is `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (default 3, a
/// GrowthBook value `tengu_hazel_trellis` when unset; *Subagent nesting
/// limit reached (depth d of D)…*, `refused.depth_limit`); the budget is
/// `--max-budget-usd`, already the rail's *Budget* field
/// (`AgentSpec::max_budget_usd`; *Budget limit reached ($x spent of the $y
/// maximum). New agents cannot be started…*, `refused.budget`, and the
/// turn ends `error_max_budget_usd`). The other three are Nightloom's
/// hook: `per_turn` (the 6 of `a4a681f`), `per_day` (a running count per
/// chat across turns, zeroed when the date changes), and the usage-aware
/// pair — at `slow_at` percent of the five-hour window the per-turn cap
/// drops to `slow_to`; at `stop_at` every spawn is refused with the reset
/// time in the reason. The percent is the freshest of the desktop's
/// gauge (`plan_usage::read`: the Claude app's sample and the CLI's cache
/// file, which `claude -p "/usage"` refreshes for zero tokens — 166's
/// reading) and the last `rate_limit_event` this chat's turns carried
/// ([`USAGE_FILE`], written by the translator as each arrives).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SubagentLimits {
    #[serde(default = "d_per_turn")]
    pub per_turn: usize,
    #[serde(default = "d_concurrent")]
    pub concurrent: usize,
    #[serde(default = "d_depth")]
    pub depth: usize,
    #[serde(default = "d_per_day")]
    pub per_day: usize,
    #[serde(default = "d_slow_at")]
    pub slow_at: u8,
    #[serde(default = "d_slow_to")]
    pub slow_to: usize,
    #[serde(default = "d_stop_at")]
    pub stop_at: u8,
    /// Pass 2 (2026-09-22): how much of the five-hour window one message
    /// — the main thread plus every subagent and council seat it starts
    /// — may spend before every further tool call is refused with "stop
    /// and report" ([`budget_verdict`]). Blocker 278, his answer: 35.
    #[serde(default = "d_budget_pct")]
    pub budget_pct: u8,
    /// Pass 2: the model subagents run on — the chat's own, or Sonnet for
    /// read-heavy scans. Blocker 280, his answer: the chat's own.
    #[serde(default)]
    pub model: SubagentModel,
}

/// Which model a spawned subagent runs on (backlog 165, pass 2). `Chat`
/// leaves the call's `model` as the parent wrote it (usually absent, so
/// the CLI's inherit); `Sonnet` sets it to `sonnet` unless the parent
/// asked for `haiku`, which is cheaper still.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubagentModel {
    #[default]
    Chat,
    Sonnet,
}

impl SubagentModel {
    /// The `model` the spawn's input should carry, given what the parent
    /// wrote; `None` leaves the input alone.
    pub fn for_spawn(self, asked: Option<&str>) -> Option<&'static str> {
        match (self, asked) {
            (Self::Chat, _) => None,
            (Self::Sonnet, Some("haiku")) => None,
            (Self::Sonnet, Some("sonnet")) => None,
            (Self::Sonnet, _) => Some("sonnet"),
        }
    }
}

fn d_per_turn() -> usize {
    SPAWN_CAP
}
// ~~20, the CLI's own default~~ — 4 since 2026-09-22 (blocker 279, his
// answer): six at once burned the window faster than any gauge could
// react (the Stuart 9 diagnosis).
fn d_concurrent() -> usize {
    4
}
fn d_budget_pct() -> u8 {
    35
}
fn d_depth() -> usize {
    3
}
// ~~30 a day; slow from 70% to 2; stop at 90%~~ — his answer to blocker
// 271 (2026-09-18): "No limit on how many a chat can spawn in a day.
// Maybe the 6 at once drop to 4. Stop at 85%." Zero is no day cap.
fn d_per_day() -> usize {
    0
}
fn d_slow_at() -> u8 {
    70
}
fn d_slow_to() -> usize {
    4
}
fn d_stop_at() -> u8 {
    85
}

impl Default for SubagentLimits {
    fn default() -> Self {
        Self {
            per_turn: d_per_turn(),
            concurrent: d_concurrent(),
            depth: d_depth(),
            per_day: d_per_day(),
            slow_at: d_slow_at(),
            slow_to: d_slow_to(),
            stop_at: d_stop_at(),
            budget_pct: d_budget_pct(),
            model: SubagentModel::default(),
        }
    }
}

impl SubagentLimits {
    /// The CLI's own limits, as the environment the process is spawned
    /// with. The budget rides as a flag (`--max-budget-usd`), not here.
    pub fn env(&self) -> Vec<(&'static str, String)> {
        vec![
            (
                "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS",
                self.concurrent.to_string(),
            ),
            (
                "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH",
                self.depth.to_string(),
            ),
        ]
    }

    /// The per-turn cap in force at a window reading: lowered to
    /// `slow_to` from `slow_at` percent. `None` for no reading.
    pub fn turn_cap_at(&self, five_hour_pct: Option<u8>) -> usize {
        match five_hour_pct {
            Some(p) if p >= self.slow_at => self.per_turn.min(self.slow_to),
            _ => self.per_turn,
        }
    }
}

/// The limits, beside the brief.
pub const LIMITS_FILE: &str = "subagent-limits.json";
/// The per-chat, per-day spawn count: `YYYY-MM-DD n`.
pub const DAY_SPAWNS_FILE: &str = "subagent-spawns-day.txt";
/// The freshest wire reading of the window: `<five-hour %> <resets-at unix
/// seconds or -> <sampled-at unix ms>`.
pub const USAGE_FILE: &str = "subagent-usage.txt";

pub fn write_limits(dir: &Path, limits: &SubagentLimits) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(
        dir.join(LIMITS_FILE),
        serde_json::to_string_pretty(limits).unwrap_or_default(),
    )
}

/// The chat's limits, or the defaults when none were written (a chat
/// older than the file, a directory the hook cannot read).
pub fn read_limits(dir: &Path) -> SubagentLimits {
    std::fs::read_to_string(dir.join(LIMITS_FILE))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// The window as a turn's `rate_limit_event` reported it, for the hook.
pub fn write_usage(dir: &Path, five_hour_pct: u8, resets_at: Option<i64>, at_ms: i64) {
    let _ = std::fs::create_dir_all(dir);
    let resets = resets_at
        .map(|r| r.to_string())
        .unwrap_or_else(|| "-".into());
    let _ = std::fs::write(
        dir.join(USAGE_FILE),
        format!("{five_hour_pct} {resets} {at_ms}\n"),
    );
}

/// One reading of the five-hour window: percent, reset time, when taken.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowReading {
    pub five_hour_pct: u8,
    pub resets_at: Option<i64>,
    pub sampled_at_ms: i64,
}

fn read_usage_file(dir: &Path) -> Option<WindowReading> {
    let s = std::fs::read_to_string(dir.join(USAGE_FILE)).ok()?;
    let mut it = s.split_whitespace();
    let pct: u8 = it.next()?.parse().ok()?;
    let resets_at = it.next().and_then(|r| r.parse::<i64>().ok());
    let sampled_at_ms: i64 = it.next()?.parse().ok()?;
    Some(WindowReading {
        five_hour_pct: pct,
        resets_at,
        sampled_at_ms,
    })
}

/// A reading still worth acting on: its window has not reset since, and
/// it is not older than a window (a stale 92% would refuse spawns into a
/// fresh window forever). Pure over its inputs.
pub fn current(reading: Option<WindowReading>, now_ms: i64) -> Option<WindowReading> {
    const WINDOW_MS: i64 = 5 * 60 * 60 * 1000;
    let r = reading?;
    if let Some(reset) = r.resets_at
        && reset * 1000 <= now_ms
    {
        return None;
    }
    (now_ms - r.sampled_at_ms <= WINDOW_MS).then_some(r)
}

/// The freshest of the two readings, or none. Pure over its inputs.
pub fn freshest(
    wire: Option<WindowReading>,
    gauge: Option<WindowReading>,
) -> Option<WindowReading> {
    match (wire, gauge) {
        (Some(w), Some(g)) => Some(if w.sampled_at_ms >= g.sampled_at_ms {
            w
        } else {
            g
        }),
        (w, g) => w.or(g),
    }
}

/// The desktop's gauge as a reading (`plan_usage`), when it has the
/// five-hour figure.
fn gauge_reading() -> Option<WindowReading> {
    // Fresh through print-mode `/usage` when the files are over ~two
    // minutes old (blocker 264, his yes 2026-09-18; pass 2 widened 60 s
    // to 120 s and made the throttle cross-process): every hook is its
    // own process, so the one-a-minute rule lives in a stamp and a lock
    // in the temp directory (`plan_usage::read_fresh_shared`), and a hook
    // that finds the lock held reads the stamp rather than waiting ~12 s.
    reading_of(crate::plan_usage::read_fresh_shared(
        std::time::Duration::from_secs(120),
    ))
}

/// The gauge's files alone as a reading — no refresh, no latency. What a
/// turn's start is measured from ([`begin_turn`]).
fn gauge_on_hand() -> Option<WindowReading> {
    reading_of(crate::plan_usage::read())
}

fn reading_of(u: crate::plan_usage::PlanUsage) -> Option<WindowReading> {
    let pct = u.five_hour?;
    let resets_at = u
        .five_hour_resets_at
        .as_deref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp());
    Some(WindowReading {
        five_hour_pct: pct,
        resets_at,
        sampled_at_ms: u.sampled_at_ms.unwrap_or(0),
    })
}

/// `HH:MM` local for the reason, or "when it resets".
fn reset_words(resets_at: Option<i64>) -> String {
    match resets_at.and_then(|r| chrono::DateTime::from_timestamp(r, 0)) {
        Some(t) => {
            let local = t.with_timezone(&chrono::Local);
            format!("at {}", local.format("%H:%M"))
        }
        None => "when the window resets".to_string(),
    }
}

/// The refusal when the window is past `stop_at` — the reset time in it,
/// so the parent can say when rather than retry.
pub fn window_stop_reason(pct: u8, stop_at: u8, resets_at: Option<i64>) -> String {
    format!(
        "Nightloom refuses new subagents while the plan's five-hour window is at {pct}% \
         (the limit is {stop_at}%). It resets {}. Until then do the work yourself with \
         your own tools, or tell the user what is left and stop; do not retry the spawn.",
        reset_words(resets_at)
    )
}

/// The per-turn refusal when the cap was lowered by the window.
pub fn slowed_cap_reason(cap: usize, pct: u8, slow_at: u8) -> String {
    format!(
        "Nightloom's limit is {cap} subagents in this turn while the plan's five-hour \
         window is at {pct}% (it is lowered from the usual cap past {slow_at}%), and this \
         turn has spawned {cap}. Wait for the running ones to finish and use their reports; \
         if what is left is small enough, do it yourself."
    )
}

/// The refusal of any tool call once the window is past `stop_at`
/// (pass 2): not a spawn this time — the call itself.
pub fn window_stop_all_reason(pct: u8, stop_at: u8, resets_at: Option<i64>) -> String {
    format!(
        "Nightloom refuses further tool calls: the plan's five-hour window is at {pct}% \
         (the stop line is {stop_at}%). It resets {}. Stop now and report to the user, in \
         your reply, what you have and what is left; do not retry this or any other call.",
        reset_words(resets_at)
    )
}

/// The refusal once this message has spent its share of the window.
pub fn budget_spent_reason(spent: u8, budget: u8, pct: u8, start: u8) -> String {
    format!(
        "Nightloom refuses further tool calls: this message has spent {spent}% of the plan's \
         five-hour window (from {start}% to {pct}%), and its budget is {budget}% per message. \
         Stop now and report to the user, in your reply, what you have and what is left — a \
         reply needs no tool; do not retry this or any other call."
    )
}

// ---- the per-message budget (nightshift backlog 165, pass 2, 2026-09-22) ----

/// The turn's budget ledger, beside the brief: written when a turn
/// starts ([`begin_turn`]) with the window reading on hand, updated by
/// every hook call ([`note_reading`]) with the latest reading, and read
/// by the desktop for the live meter (`turn_budget`).
pub const TURN_BUDGET_FILE: &str = "turn-budget.json";

/// A seats phase older than this is not continued by the chair: a
/// council cancelled between its seats and its chair leaves a file the
/// next ordinary turn must not inherit.
const SEATS_CONTINUE_MS: i64 = 10 * 60 * 1000;

/// One message's budget ledger. `start_pct` is the window when the
/// message began — the freshest reading on hand at that moment, no
/// refresh — and is pinned by the first hook reading when none was on
/// hand (a late pin understates the spend, never overstates it).
/// `phase` is `seats` while a council's seats run, `seats-done` between
/// them and the chair, `turn` otherwise.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct TurnBudget {
    pub started_at_ms: i64,
    pub budget_pct: u8,
    pub stop_at: u8,
    #[serde(default)]
    pub start_pct: Option<u8>,
    #[serde(default)]
    pub latest_pct: Option<u8>,
    #[serde(default)]
    pub latest_at_ms: Option<i64>,
    #[serde(default)]
    pub resets_at: Option<i64>,
    #[serde(default)]
    pub phase: String,
    /// The refusal, once the hook has refused a call under this ledger.
    #[serde(default)]
    pub stopped: Option<String>,
    /// How many hook calls this ledger has seen (the meter's "calls").
    #[serde(default)]
    pub calls: u64,
    /// Since when a call past the stop line has been held for his answer
    /// (nightshift backlog 189): the window shows the *Continue anyway*
    /// card while this is set. Cleared by the answer or the hold's end.
    #[serde(default)]
    pub pending_since_ms: Option<i64>,
    /// When he pressed *Continue anyway* for this message — the ledger's
    /// record of the override (backlog 189).
    #[serde(default)]
    pub override_at_ms: Option<i64>,
    /// The deadlines of the calls held right now, one per waiting hook
    /// (backlog 192; review 2026-09-23 finding 6): `pending_since_ms` is
    /// cleared only when the last one ends, so the card does not vanish
    /// under his cursor while a parallel call still waits. A hook killed
    /// mid-hold leaves its deadline behind, which the window ignores once
    /// it has passed.
    #[serde(default)]
    pub holds: Vec<i64>,
    /// When his *Wrap up* reached the model (backlog 192): the call that
    /// carried it was refused with the instruction; the rest of the
    /// message's calls go on so it can write its hand-off, spawns refused.
    #[serde(default)]
    pub wrap_at_ms: Option<i64>,
}

impl TurnBudget {
    /// Window percent spent so far by this message: latest minus start,
    /// never negative (the account's figure can only rise within a
    /// window; a reset in between reads as zero).
    pub fn spent_pct(&self) -> Option<u8> {
        Some(self.latest_pct?.saturating_sub(self.start_pct?))
    }
}

/// Which start a turn is: a council's seats, a turn proper, or the
/// chair of the seats whose ledger started at the given `started_at_ms`.
/// Only a `Chair` continues a `seats-done` ledger, and only its own
/// (nightshift backlog 187): a council whose chair never ran — a Stop,
/// an error — leaves a ledger no ordinary message may inherit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnPhase {
    Seats,
    Turn,
    Chair(i64),
}

/// The ledger, read under a shared lock: the hook's writers rewrite it in
/// place under the exclusive lock (truncate, then write), so an unlocked
/// read could land between the two and see nothing (review 2026-09-23,
/// finding 1). `None` when there is no ledger or it will not parse.
pub fn read_turn_budget(dir: &Path) -> Option<TurnBudget> {
    read_ledger(dir).ok()?
}

/// [`read_turn_budget`] telling the two failures apart: `Err` when there is
/// no ledger at all, `Ok(None)` when one is there but did not parse.
fn read_ledger(dir: &Path) -> Result<Option<TurnBudget>, ()> {
    use std::io::Read as _;
    let mut file = std::fs::File::open(dir.join(TURN_BUDGET_FILE)).map_err(|_| ())?;
    let _ = file.lock_shared();
    let mut s = String::new();
    let _ = file.read_to_string(&mut s);
    Ok(serde_json::from_str(&s).ok())
}

fn write_turn_budget(dir: &Path, b: &TurnBudget) {
    let _ = std::fs::create_dir_all(dir);
    let path = dir.join(TURN_BUDGET_FILE);
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, serde_json::to_string_pretty(b).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// Start a message's ledger from the reading on hand, pure over its
/// inputs: `have` is the file as it was. A `Chair` start continues the
/// `seats-done` ledger it names, when younger than [`SEATS_CONTINUE_MS`]
/// (the chair of a council whose seats just ran); everything else — an
/// ordinary message above all — starts afresh (backlog 187).
pub fn start_turn_budget(
    have: Option<TurnBudget>,
    limits: &SubagentLimits,
    reading: Option<WindowReading>,
    now_ms: i64,
    phase: TurnPhase,
) -> TurnBudget {
    if let TurnPhase::Chair(seats_started) = phase
        && let Some(h) = have
        && h.phase == "seats-done"
        && h.started_at_ms == seats_started
        && now_ms - h.started_at_ms <= SEATS_CONTINUE_MS
    {
        return TurnBudget {
            phase: "turn".into(),
            ..h
        };
    }
    TurnBudget {
        started_at_ms: now_ms,
        budget_pct: limits.budget_pct,
        stop_at: limits.stop_at,
        start_pct: reading.map(|r| r.five_hour_pct),
        latest_pct: reading.map(|r| r.five_hour_pct),
        latest_at_ms: reading.map(|r| r.sampled_at_ms),
        resets_at: reading.and_then(|r| r.resets_at),
        phase: match phase {
            TurnPhase::Seats => "seats",
            TurnPhase::Turn | TurnPhase::Chair(_) => "turn",
        }
        .into(),
        stopped: None,
        calls: 0,
        pending_since_ms: None,
        override_at_ms: None,
        holds: Vec::new(),
        wrap_at_ms: None,
    }
}

/// The reading on hand for a turn's start: the chat's wire file and the
/// gauge's files, whichever is fresher and still current — no `/usage`
/// run, so no latency on the turn.
pub fn reading_on_hand(dir: &Path, now_ms: i64) -> Option<WindowReading> {
    // No older than the hook's own refresh (two minutes): an hours-old
    // start would count other chats' spend since then against this
    // message, and could refuse its first call; with none, the first hook
    // reading pins the start, which only understates (review of 44ab834).
    freshest(
        current(read_usage_file(dir), now_ms),
        current(gauge_on_hand(), now_ms),
    )
    .filter(|r| now_ms - r.sampled_at_ms <= 120_000)
}

/// A turn begins: the spawn count zeroed and the budget ledger started
/// (or, for a chair, continued). Called by `run_turn` and, for a
/// council's seats, by `council::run_seats`.
pub fn begin_turn(dir: &Path, limits: &SubagentLimits, phase: TurnPhase) {
    if dir.as_os_str().is_empty() {
        return;
    }
    reset_spawns(dir);
    let now_ms = chrono::Utc::now().timestamp_millis();
    let b = start_turn_budget(
        read_turn_budget(dir),
        limits,
        reading_on_hand(dir, now_ms),
        now_ms,
        phase,
    );
    write_turn_budget(dir, &b);
}

/// The seats' ledger a chair about to run should continue: its
/// `started_at_ms`, when the chat's ledger is a `seats-done` one. The
/// caller arms the chair with it ([`TurnPhase::Chair`]) only once it has
/// decided the chair runs (backlog 187).
pub fn seats_ledger(dir: &Path) -> Option<i64> {
    read_turn_budget(dir)
        .filter(|b| b.phase == "seats-done")
        .map(|b| b.started_at_ms)
}

/// The seats have finished: the chair's `run_turn` continues this ledger.
pub fn finish_seats(dir: &Path) {
    if let Some(b) = read_turn_budget(dir) {
        write_turn_budget(
            dir,
            &TurnBudget {
                phase: "seats-done".into(),
                ..b
            },
        );
    }
}

/// The hook's verdict on one call under the ledger, pure: the window's
/// stop line first (a reading past it refuses everything), then the
/// message's own budget. `None` reading: nothing to judge by, allowed.
pub fn budget_verdict(b: &TurnBudget, reading: Option<WindowReading>) -> Result<(), String> {
    let Some(r) = reading else {
        return Ok(());
    };
    if r.five_hour_pct >= b.stop_at {
        return Err(window_stop_all_reason(
            r.five_hour_pct,
            b.stop_at,
            r.resets_at,
        ));
    }
    share_verdict(b, r)
}

/// The message's own share (the 35 %), alone: the brake that still binds
/// under his override (backlog 189).
fn share_verdict(b: &TurnBudget, r: WindowReading) -> Result<(), String> {
    if let Some(start) = b.start_pct {
        let spent = r.five_hour_pct.saturating_sub(start);
        if b.budget_pct > 0 && spent >= b.budget_pct {
            return Err(budget_spent_reason(
                spent,
                b.budget_pct,
                r.five_hour_pct,
                start,
            ));
        }
    }
    Ok(())
}

// ---- the override when he is present (nightshift backlog 189, 2026-09-22) ----
//
// Past the stop line every call is refused (blocker 290, kept). In a chat
// he is present in, a call past the line is **held** instead: the ledger
// says so (`pending_since_ms`), the window shows *Continue anyway* /
// *Stop here*, and the click writes [`OVERRIDE_FILE`] naming the ledger's
// turn (`started_at_ms`) and an expiry. The held hook — and every later
// call of the same message — reads it and goes on; the message's own
// share still binds. Another chat has its own directory; the next
// message starts a new ledger, so the old override names a turn that is
// gone. Held rather than refused-then-continued: a refused model stops
// and ends its reply, leaving nothing for a Continue to let through
// (blocker 292).
//
// **Pass 2 (backlog 192, his answer to blocker 292, 2026-09-22).**
// ~~Present: the chat open in a focused window within 20 s, or his message
// within 5 minutes.~~ Present is now his **Mac's** idle time — any key or
// pointer input within [`AWAY_MS`] (10 minutes), read from the HID
// system's `HIDIdleTime` ([`mac_idle_ms`], no permission needed) — or his
// message from the window within 5 minutes; the focused-window look is
// one input among them, not the gate. ~~Continue lasts to the end of the
// message.~~ *Continue anyway* now covers **the chat** until he has been
// away 10 minutes ([`continue_holds`], blocker 312): a global record of
// the Mac's activity ([`ACTIVITY_FILE`], kept by the desktop every minute
// and by the hook) says whether he went away since the click. *Stop here*
// is still this message only, and replaces the chat's Continue. *Wrap up*
// (new) is this message only: the next call of the chat's own thread is
// refused with the instruction to finish and write its hand-off, and the
// rest of the message's calls go on so it can, spawns refused (blocker
// 311).

/// His answer to a held call, beside the ledger.
pub const OVERRIDE_FILE: &str = "budget-override.json";
/// When the window last saw him in this chat, beside the ledger.
pub const PRESENCE_FILE: &str = "presence.json";
/// The Mac's activity as observed (backlog 192): one file for every chat,
/// in Nightloom's config folder, since the Mac's idle time is one figure.
pub const ACTIVITY_FILE: &str = "mac-activity.json";
/// How long a held call waits for his answer before it is refused as
/// before. Under the hook's registered timeout ([`HOOK_TIMEOUT_S`]).
pub const HOLD_MS: i64 = 5 * 60 * 1000;
/// ~~An override lasts to the end of the message, and never past this.~~
/// Since backlog 192: how long a *Stop here* or *Wrap up* names its
/// message at most; a *Continue* lasts until he is away ([`AWAY_MS`]),
/// with [`CONTINUE_TTL_MS`] as the backstop.
pub const OVERRIDE_TTL_MS: i64 = 60 * 60 * 1000;
/// A chat's *Continue anyway* never outlives this, away or not.
pub const CONTINUE_TTL_MS: i64 = 24 * 60 * 60 * 1000;
/// Present: the window saw this chat open and focused this recently
/// (the front end writes every five seconds while the turn runs) …
pub const PRESENT_SEEN_MS: i64 = 20 * 1000;
/// … or his last message in it is this recent …
pub const PRESENT_INPUT_MS: i64 = 5 * 60 * 1000;
/// … or the Mac saw his hand within this (backlog 192, his "present makes
/// sense"): and this long without it is *away*, which ends a *Continue*.
pub const AWAY_MS: i64 = 10 * 60 * 1000;
/// How often the desktop notes the Mac's activity ([`spawn_activity_watch`]).
pub const ACTIVITY_EVERY_MS: u64 = 60 * 1000;
/// The hook's timeout on its registration, in seconds: longer than a
/// hold, so the CLI never cuts a held call off by its own clock. ~~600~~
/// — 3,600 since 104 pass 3 (2026-09-22): the hook also runs a checkpoint
/// fork to completion ([`super::fork`]), capped at [`super::fork::FORK_WALL_MS`]
/// (45 min), and a hook the CLI times out "doesn't block the tool call"
/// (`external`, the hooks reference) — the spawn would then run a second
/// time as a fresh helper, after the fork had already done the work.
pub const HOOK_TIMEOUT_S: u64 = 3_600;

/// The click's record: `turn` is the ledger's `started_at_ms`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BudgetOverride {
    pub turn: i64,
    /// `continue`, `stop` or (backlog 192) `wrap`.
    pub decision: String,
    pub at_ms: i64,
    pub expires_at_ms: i64,
    /// A `wrap`'s instruction to the model, as the window composed it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

/// His answer in force for one call (backlog 192).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Answer {
    /// *Continue anyway*: the chat's calls go on past the line.
    Continue,
    /// *Stop here*: this message's calls past the line are refused.
    Stop,
    /// *Wrap up*: the instruction the model is to get.
    Wrap(String),
}

/// What the window last saw of him in one chat.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Presence {
    #[serde(default)]
    pub seen_at_ms: Option<i64>,
    #[serde(default)]
    pub input_at_ms: Option<i64>,
}

/// Present, pure: ~~the chat open in a focused window within
/// [`PRESENT_SEEN_MS`], or his message within [`PRESENT_INPUT_MS`]~~ —
/// since backlog 192 also, and first, the Mac's idle time under
/// [`AWAY_MS`] (`idle_ms`, `None` when it could not be read).
pub fn is_present(p: Option<Presence>, idle_ms: Option<i64>, now_ms: i64) -> bool {
    if idle_ms.is_some_and(|i| i < AWAY_MS) {
        return true;
    }
    let Some(p) = p else { return false };
    p.seen_at_ms.is_some_and(|t| now_ms - t <= PRESENT_SEEN_MS)
        || p.input_at_ms
            .is_some_and(|t| now_ms - t <= PRESENT_INPUT_MS)
}

pub fn read_presence(dir: &Path) -> Option<Presence> {
    serde_json::from_str(&std::fs::read_to_string(dir.join(PRESENCE_FILE)).ok()?).ok()
}

/// The window saw him: the chat open and focused, or (`input`) he just
/// sent a message in it.
pub fn note_presence(dir: &Path, input: bool, now_ms: i64) -> std::io::Result<()> {
    let mut p = read_presence(dir).unwrap_or_default();
    p.seen_at_ms = Some(now_ms);
    if input {
        p.input_at_ms = Some(now_ms);
    }
    std::fs::create_dir_all(dir)?;
    let path = dir.join(PRESENCE_FILE);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string(&p).unwrap_or_default())?;
    std::fs::rename(&tmp, path)
}

// ---- the Mac's activity (backlog 192) ----

/// What has been observed of the Mac's activity, for every chat.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Activity {
    /// The last observation.
    #[serde(default)]
    pub observed_at_ms: Option<i64>,
    /// The latest observation that found him away: idle [`AWAY_MS`] or
    /// more, the idle time unreadable, or a gap of that long with nobody
    /// observing (the Mac asleep, the app closed).
    #[serde(default)]
    pub away_at_ms: Option<i64>,
}

/// One observation, pure: `idle_ms` is the Mac's idle time now (`None`
/// when unreadable, which counts as away — a presence nobody can see is
/// not vouched for).
pub fn observe(prev: Option<Activity>, idle_ms: Option<i64>, now_ms: i64) -> Activity {
    let mut a = prev.unwrap_or_default();
    let gap = a.observed_at_ms.is_some_and(|t| now_ms - t >= AWAY_MS);
    if gap || idle_ms.is_none_or(|i| i >= AWAY_MS) {
        a.away_at_ms = Some(now_ms);
    }
    a.observed_at_ms = Some(now_ms.max(a.observed_at_ms.unwrap_or(now_ms)));
    a
}

/// A *Continue* clicked at `at_ms` still covers the chat, pure: he has not
/// been seen away since, and is not away now.
pub fn continue_holds(at_ms: i64, a: Option<Activity>, idle_ms: Option<i64>, now_ms: i64) -> bool {
    now_ms - at_ms < CONTINUE_TTL_MS
        && idle_ms.is_some_and(|i| i < AWAY_MS)
        && a.and_then(|a| a.away_at_ms).is_none_or(|t| t < at_ms)
}

pub fn read_activity(path: &Path) -> Option<Activity> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Record one observation (a per-process temporary file, then a rename:
/// the desktop and any number of hooks may write at once, and each writes
/// what it just saw of the same Mac). Returns what was written.
pub fn note_activity(path: &Path, idle_ms: Option<i64>, now_ms: i64) -> Activity {
    let a = observe(read_activity(path), idle_ms, now_ms);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    if std::fs::write(&tmp, serde_json::to_string(&a).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
    a
}

/// Where [`ACTIVITY_FILE`] lives: Nightloom's config folder.
pub fn activity_path() -> Option<PathBuf> {
    crate::project::config_dir().map(|d| d.join(ACTIVITY_FILE))
}

/// Milliseconds since the Mac last saw a key or the pointer: the HID
/// system's `HIDIdleTime` (nanoseconds), through `ioreg` — no permission,
/// ~15 ms. `None` off macOS or when it cannot be read.
pub fn mac_idle_ms() -> Option<i64> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let out = std::process::Command::new("/usr/sbin/ioreg")
        .args(["-c", "IOHIDSystem", "-d", "4", "-r", "-k", "HIDIdleTime"])
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    parse_hid_idle(&String::from_utf8_lossy(&out.stdout))
}

/// The first `"HIDIdleTime" = <ns>` in `ioreg`'s output, as milliseconds.
fn parse_hid_idle(text: &str) -> Option<i64> {
    let line = text.lines().find(|l| l.contains("\"HIDIdleTime\""))?;
    let ns: i64 = line.rsplit('=').next()?.trim().parse().ok()?;
    Some(ns / 1_000_000)
}

/// The desktop's watch on the Mac's activity: an observation every
/// [`ACTIVITY_EVERY_MS`] for as long as the app runs, so an away stretch
/// between two turns is seen and ends a chat's *Continue*. Best-effort.
pub fn spawn_activity_watch() {
    let Some(path) = activity_path() else { return };
    let _ = std::thread::Builder::new()
        .name("mac-activity".into())
        .spawn(move || {
            loop {
                note_activity(&path, mac_idle_ms(), chrono::Utc::now().timestamp_millis());
                std::thread::sleep(std::time::Duration::from_millis(ACTIVITY_EVERY_MS));
            }
        });
}

/// What the hook senses of the world beyond the chat's directory: the
/// Mac's idle time and the activity record. The suite passes its own.
pub struct Senses<'a> {
    pub idle_ms: &'a dyn Fn() -> Option<i64>,
    pub activity: Option<PathBuf>,
}

impl Senses<'static> {
    pub fn real() -> Self {
        Senses {
            idle_ms: &mac_idle_ms,
            activity: activity_path(),
        }
    }
}

impl Senses<'_> {
    /// The idle time now, with the observation recorded.
    fn look(&self, now_ms: i64) -> (Option<i64>, Option<Activity>) {
        let idle = (self.idle_ms)();
        let a = self
            .activity
            .as_deref()
            .map(|p| note_activity(p, idle, now_ms));
        (idle, a)
    }
}

pub fn read_override(dir: &Path) -> Option<BudgetOverride> {
    serde_json::from_str(&std::fs::read_to_string(dir.join(OVERRIDE_FILE)).ok()?).ok()
}

/// The answer in force for this ledger, pure. `continue_ok` is
/// [`continue_holds`] for the record's click (backlog 192: a *Continue* is
/// the chat's, whatever turn it named). *Stop* and *Wrap* name their
/// message: another turn's, or one past its expiry, is `None`, as is a
/// word it does not know. A stale or foreign one never lets a call through.
pub fn override_for(
    b: &TurnBudget,
    ov: Option<&BudgetOverride>,
    continue_ok: bool,
    now_ms: i64,
) -> Option<Answer> {
    let ov = ov?;
    if ov.decision == "continue" {
        return continue_ok.then_some(Answer::Continue);
    }
    if ov.turn != b.started_at_ms || now_ms >= ov.expires_at_ms {
        return None;
    }
    match ov.decision.as_str() {
        "stop" => Some(Answer::Stop),
        "wrap" => Some(Answer::Wrap(
            ov.text
                .clone()
                .filter(|t| !t.trim().is_empty())
                .unwrap_or_else(|| WRAP_UP_DEFAULT.to_string()),
        )),
        _ => None,
    }
}

/// The answer on file for this ledger, the Mac looked at only when a
/// *Continue* needs it — and only past the line (`past`), where it matters.
fn answer_now(
    dir: &Path,
    b: &TurnBudget,
    past: bool,
    senses: &Senses,
    now_ms: i64,
) -> Option<Answer> {
    let ov = read_override(dir)?;
    let continue_ok = ov.decision == "continue" && past && {
        let (idle, a) = senses.look(now_ms);
        continue_holds(ov.at_ms, a, idle, now_ms)
    };
    override_for(b, Some(&ov), continue_ok, now_ms)
}

/// The instruction a *Wrap up* carries when the window sent none.
pub const WRAP_UP_DEFAULT: &str = "Finish or save whatever edit is half-done, so every file is in a \
     coherent state; write a hand-off (HANDOFF.md at the top of the project: what you were doing, \
     what is done, what is next, the files that matter); then stop.";

/// The refusal that carries his *Wrap up* to the model (backlog 192).
pub fn wrap_up_reason(text: &str) -> String {
    format!(
        "Not run: Swaraag pressed Wrap up — the 5-hour usage window is near its stop line. Do not \
         start new work or spawn subagents; your next tool calls will run so you can do this:\n\n{}",
        text.trim()
    )
}

/// What a subagent's call gets once the chat is wrapping up.
pub fn wrap_up_subagent_reason() -> String {
    "Not run: the chat you report to is wrapping up (Swaraag pressed Wrap up). Stop now and \
     report what you have."
        .into()
}

/// One call's verdict under the ledger (backlog 189).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CallVerdict {
    /// Allowed; `overridden` when it is past the stop line on his word.
    Allow {
        overridden: bool,
    },
    Deny(String),
    /// Past the stop line in a chat he is present in: wait for him.
    Hold,
    /// His *Wrap up*, not yet delivered: refuse this call with the
    /// instruction and mark the ledger (backlog 192).
    WrapUp(String),
}

/// [`budget_verdict`] with his answer and his presence, pure. *Wrap up*
/// first, at any window: the chat's own next call carries it (`WrapUp`),
/// later calls go on (spawns are refused by the hook), a subagent's are
/// refused. Past the stop line: *Continue* lets the call on to the
/// message's own share; *Stop* refuses; with no answer the call is held
/// when he is present and it is the chat's own call (a subagent's is
/// refused — its parent's next call is the one that asks), refused
/// otherwise.
pub fn call_verdict(
    b: &TurnBudget,
    reading: Option<WindowReading>,
    ans: Option<&Answer>,
    present: bool,
    subagent: bool,
) -> CallVerdict {
    let wrapping = matches!(ans, Some(Answer::Wrap(_)));
    if let Some(Answer::Wrap(text)) = ans {
        if subagent {
            return CallVerdict::Deny(wrap_up_subagent_reason());
        }
        if b.wrap_at_ms.is_none() {
            return CallVerdict::WrapUp(wrap_up_reason(text));
        }
    }
    let Some(r) = reading else {
        return CallVerdict::Allow { overridden: false };
    };
    let mut overridden = false;
    if r.five_hour_pct >= b.stop_at {
        match ans {
            Some(Answer::Continue) => overridden = true,
            _ if wrapping => overridden = true,
            None if present && !subagent => return CallVerdict::Hold,
            _ => {
                return CallVerdict::Deny(window_stop_all_reason(
                    r.five_hour_pct,
                    b.stop_at,
                    r.resets_at,
                ));
            }
        }
    }
    match share_verdict(b, r) {
        Ok(()) => CallVerdict::Allow { overridden },
        Err(reason) => CallVerdict::Deny(reason),
    }
}

/// Open the ledger locked, change it, write it back. `None` when there
/// is no ledger or it cannot be locked or read.
fn with_ledger<T>(dir: &Path, f: impl FnOnce(&mut TurnBudget) -> T) -> Option<T> {
    use std::io::{Read as _, Seek as _, Write as _};
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(dir.join(TURN_BUDGET_FILE))
        .ok()?;
    file.lock().ok()?;
    let mut have = String::new();
    let _ = file.read_to_string(&mut have);
    let mut b = serde_json::from_str::<TurnBudget>(&have).ok()?;
    let out = f(&mut b);
    let _ = file.set_len(0);
    let _ = file.seek(std::io::SeekFrom::Start(0));
    let _ = file.write_all(
        serde_json::to_string_pretty(&b)
            .unwrap_or_default()
            .as_bytes(),
    );
    Some(out)
}

/// His click on the card: `continue` or `stop` for the message the
/// ledger is on now. Kept for its callers; [`write_answer`] is the whole.
pub fn write_override(dir: &Path, go_on: bool, now_ms: i64) -> Result<(), String> {
    write_answer(dir, if go_on { "continue" } else { "stop" }, None, now_ms)
}

/// His click on the card or the meter: `continue`, `stop` or `wrap` (with
/// the instruction), naming the message the ledger is on now. Written
/// under the file lock, the ledger's pattern; the ledger drops the pending
/// mark and, on Continue, records the override. An error when there is
/// no ledger to name or the word is unknown.
pub fn write_answer(
    dir: &Path,
    decision: &str,
    text: Option<String>,
    now_ms: i64,
) -> Result<(), String> {
    use std::io::{Seek as _, Write as _};
    if !matches!(decision, "continue" | "stop" | "wrap") {
        return Err(format!("unknown decision: {decision}"));
    }
    let turn = with_ledger(dir, |b| {
        b.pending_since_ms = None;
        if decision == "continue" {
            b.override_at_ms = Some(now_ms);
        }
        b.started_at_ms
    })
    .ok_or_else(|| "no budget ledger for this chat".to_string())?;
    let ov = BudgetOverride {
        turn,
        decision: decision.into(),
        at_ms: now_ms,
        expires_at_ms: now_ms
            + if decision == "continue" {
                CONTINUE_TTL_MS
            } else {
                OVERRIDE_TTL_MS
            },
        text: if decision == "wrap" { text } else { None },
    };
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(OVERRIDE_FILE))
        .map_err(|e| e.to_string())?;
    file.lock().map_err(|e| e.to_string())?;
    let _ = file.set_len(0);
    let _ = file.seek(std::io::SeekFrom::Start(0));
    file.write_all(serde_json::to_string(&ov).unwrap_or_default().as_bytes())
        .map_err(|e| e.to_string())
}

/// One held call has ended: its deadline leaves the ledger, and the
/// pending mark goes with the last one (review finding 6).
fn release_hold(b: &mut TurnBudget, deadline: i64, now_ms: i64) {
    if let Some(i) = b.holds.iter().position(|d| *d == deadline) {
        b.holds.remove(i);
    }
    b.holds.retain(|d| *d > now_ms);
    if b.holds.is_empty() {
        b.pending_since_ms = None;
    }
}

/// Wait for his answer to a held call, polling the override every
/// `poll_ms`, for at most `hold_ms` (to `deadline`, the one the ledger
/// holds for this call). A new message starting under the hold (the
/// ledger's turn changed), the ledger gone, or no answer in time: refused
/// as before, and the ledger records the refusal. An unreadable ledger
/// is waited through, never read as permission (review finding 1).
fn await_answer(
    dir: &Path,
    turn: i64,
    deadline: i64,
    reading: WindowReading,
    subagent: bool,
    poll_ms: u64,
    senses: &Senses,
) -> CallVerdict {
    loop {
        std::thread::sleep(std::time::Duration::from_millis(poll_ms));
        let now = chrono::Utc::now().timestamp_millis();
        let b = match read_ledger(dir) {
            Err(()) => break,
            Ok(None) if now < deadline => continue,
            Ok(None) => break,
            Ok(Some(b)) => b,
        };
        if b.started_at_ms != turn {
            break;
        }
        if let Some(ans) = answer_now(dir, &b, true, senses, now) {
            let v = call_verdict(&b, Some(reading), Some(&ans), false, subagent);
            let v = with_ledger(dir, |l| {
                if l.started_at_ms == turn {
                    release_hold(l, deadline, now);
                }
                match v {
                    // Another held call may have carried it already.
                    CallVerdict::WrapUp(reason) if l.wrap_at_ms.is_none() => {
                        l.wrap_at_ms = Some(now);
                        CallVerdict::Deny(reason)
                    }
                    CallVerdict::WrapUp(_) => CallVerdict::Allow { overridden: true },
                    CallVerdict::Deny(reason) => {
                        l.stopped = Some(reason.clone());
                        CallVerdict::Deny(reason)
                    }
                    CallVerdict::Allow { overridden } => {
                        if overridden {
                            l.override_at_ms.get_or_insert(now);
                        }
                        CallVerdict::Allow { overridden }
                    }
                    CallVerdict::Hold => CallVerdict::Hold,
                }
            })
            .unwrap_or_else(|| {
                CallVerdict::Deny(window_stop_all_reason(
                    reading.five_hour_pct,
                    b.stop_at,
                    reading.resets_at,
                ))
            });
            if v != CallVerdict::Hold {
                return v;
            }
        }
        if now >= deadline {
            break;
        }
    }
    let stop_at = read_turn_budget(dir).map_or(SubagentLimits::default().stop_at, |b| b.stop_at);
    let reason = window_stop_all_reason(reading.five_hour_pct, stop_at, reading.resets_at);
    let now = chrono::Utc::now().timestamp_millis();
    with_ledger(dir, |b| {
        if b.started_at_ms == turn {
            release_hold(b, deadline, now);
            b.stopped = Some(reason.clone());
        }
    });
    CallVerdict::Deny(reason)
}

/// Record a hook's reading in the ledger under the file lock (the
/// turn's hooks run at once), pin the start if none was on hand, judge
/// the call, and write the refusal into the ledger when there is one.
/// No ledger (a chat older than the file, a turn started elsewhere):
/// allowed, nothing written. Since backlog 189 the verdict weighs his
/// override and his presence, and a held call marks the ledger pending;
/// since 192 it returns the held call's deadline (0 otherwise), a *Wrap
/// up* is delivered here, and the Mac is looked at only past the line.
fn note_reading(
    dir: &Path,
    reading: Option<WindowReading>,
    subagent: bool,
    now_ms: i64,
    hold_ms: i64,
    senses: &Senses,
) -> (CallVerdict, i64, i64) {
    use std::io::{Read as _, Seek as _, Write as _};
    let allowed = (CallVerdict::Allow { overridden: false }, 0, 0);
    let Ok(mut file) = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(dir.join(TURN_BUDGET_FILE))
    else {
        return allowed;
    };
    if file.lock().is_err() {
        return allowed;
    }
    let mut have = String::new();
    let _ = file.read_to_string(&mut have);
    let Ok(mut b) = serde_json::from_str::<TurnBudget>(&have) else {
        return allowed;
    };
    b.calls += 1;
    if let Some(r) = reading {
        if b.start_pct.is_none() {
            b.start_pct = Some(r.five_hour_pct);
        }
        // The latest is the newest reading seen, never an older one a
        // slower hook brings in after a faster one.
        if b.latest_at_ms.is_none_or(|t| r.sampled_at_ms >= t) {
            b.latest_pct = Some(r.five_hour_pct);
            b.latest_at_ms = Some(r.sampled_at_ms);
            b.resets_at = r.resets_at.or(b.resets_at);
        }
    }
    let past = reading.is_some_and(|r| r.five_hour_pct >= b.stop_at);
    let ans = answer_now(dir, &b, past, senses, now_ms);
    // His presence only matters for a call that would otherwise be held.
    let present = past
        && ans.is_none()
        && !subagent
        && is_present(read_presence(dir), senses.look(now_ms).0, now_ms);
    let mut verdict = call_verdict(&b, reading, ans.as_ref(), present, subagent);
    let mut deadline = 0;
    match &verdict {
        CallVerdict::Deny(reason) => b.stopped = Some(reason.clone()),
        CallVerdict::Hold => {
            deadline = now_ms + hold_ms;
            b.pending_since_ms.get_or_insert(now_ms);
            b.holds.retain(|d| *d > now_ms);
            b.holds.push(deadline);
        }
        CallVerdict::WrapUp(reason) => {
            b.wrap_at_ms = Some(now_ms);
            verdict = CallVerdict::Deny(reason.clone());
        }
        CallVerdict::Allow { overridden } => {
            if *overridden && ans == Some(Answer::Continue) {
                b.override_at_ms.get_or_insert(now_ms);
            }
        }
    }
    let _ = file.set_len(0);
    let _ = file.seek(std::io::SeekFrom::Start(0));
    let _ = file.write_all(
        serde_json::to_string_pretty(&b)
            .unwrap_or_default()
            .as_bytes(),
    );
    (verdict, b.started_at_ms, deadline)
}

/// The per-chat, per-day refusal.
pub fn day_cap_reason(cap: usize) -> String {
    format!(
        "Nightloom's limit is {cap} subagents in this chat today, and this chat has spawned \
         {cap}. Use the reports you have; do what is left yourself, or ask the user to \
         raise the limit or continue in a new chat."
    )
}

/// Take one spawn of the chat's daily allowance, or say it is spent.
/// The same lock as [`claim_spawn`]; the count restarts when the date
/// (local) changes, so the file holds the date it counts.
fn claim_day_spawn(dir: &Path, cap: usize, today: &str) -> Result<(), usize> {
    use std::io::{Read as _, Seek as _, Write as _};
    let _ = std::fs::create_dir_all(dir);
    let Ok(mut file) = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.join(DAY_SPAWNS_FILE))
    else {
        return Ok(());
    };
    if file.lock().is_err() {
        return Ok(());
    }
    let mut have = String::new();
    let _ = file.read_to_string(&mut have);
    let mut it = have.split_whitespace();
    let n: usize = match (it.next(), it.next()) {
        (Some(d), Some(n)) if d == today => n.parse().unwrap_or(0),
        _ => 0,
    };
    if n >= cap {
        return Err(n);
    }
    let _ = file.set_len(0);
    let _ = file.seek(std::io::SeekFrom::Start(0));
    let _ = file.write_all(format!("{today} {}", n + 1).as_bytes());
    Ok(())
}

/// The hook's verdict on one spawn, pure over what it read: the window
/// first (a stop needs no count), then the turn's cap at that window,
/// then the day's. `Ok(cap)` is the per-turn cap in force.
pub fn window_verdict(
    limits: &SubagentLimits,
    reading: Option<WindowReading>,
) -> Result<usize, String> {
    if let Some(r) = reading
        && r.five_hour_pct >= limits.stop_at
    {
        return Err(window_stop_reason(
            r.five_hour_pct,
            limits.stop_at,
            r.resets_at,
        ));
    }
    Ok(limits.turn_cap_at(reading.map(|r| r.five_hour_pct)))
}

/// Take one spawn of the turn's allowance, or say how many were taken.
///
/// One hook process runs per `Agent` call, and a turn that fans out puts
/// its calls in one assistant message, which the CLI runs — hooks
/// included — at once. The first shape (2026-09-17, `a4a681f`) read the
/// count and wrote it back with no lock, so fourteen hooks at once each
/// read 0 and wrote 1, and the cap held only for a model that spawned one
/// at a time — the opposite of the report that raised it (the review of
/// 2026-09-18). So: the file is opened, locked exclusively for the
/// read-and-write (`File::lock`, an advisory lock the other hooks wait
/// on), and released with the handle. A directory or file that cannot be
/// opened counts as no spawns taken: the brief still goes in, the cap
/// does not bind — the failure is logged nowhere the model reads, and a
/// refusal for a bookkeeping error would be worse than an uncounted
/// spawn.
fn claim_spawn(dir: &Path, cap: usize) -> Result<(), usize> {
    use std::io::{Read as _, Seek as _, Write as _};
    let _ = std::fs::create_dir_all(dir);
    let Ok(mut file) = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.join(SPAWNS_FILE))
    else {
        return Ok(());
    };
    if file.lock().is_err() {
        return Ok(());
    }
    let mut have = String::new();
    let _ = file.read_to_string(&mut have);
    let n: usize = have.trim().parse().unwrap_or(0);
    if n >= cap {
        return Err(n);
    }
    let _ = file.set_len(0);
    let _ = file.seek(std::io::SeekFrom::Start(0));
    let _ = file.write_all((n + 1).to_string().as_bytes());
    Ok(())
}

/// The sentence at the top of the brief, so the child knows what the
/// block is and what it is not.
const BRIEF_LEAD: &str = "You are a subagent of a chat running in Nightloom. What follows reached the \
     main conversation as its system prompt and reaches you here, in front of your \
     task: the project's instructions, and how the tools and names read on this \
     engine. You see nothing else of the conversation — only your task below.";

/// The segment kinds the brief keeps, in the preamble's own order.
const KEPT: [SegmentKind; 2] = [SegmentKind::ProjectInstructions, SegmentKind::EngineNote];

/// What a connection carries for the brief (mirrors [`super::AskSpec`]).
#[derive(Debug, Clone)]
pub struct BriefSpec {
    /// The hook program and its leading arguments — `[<this binary>,
    /// "--subagent-hook"]`; the directory is appended per turn.
    pub hook: Vec<String>,
    /// The chat's directory, where [`BRIEF_FILE`] is written; empty until
    /// the shell points it at the open chat.
    pub dir: PathBuf,
    /// The brief's text, composed once per connection by [`compose`].
    pub text: String,
}

/// The brief from the chat's preamble: the kept segments and `notes`
/// (the extra-folders note, when there is one), wrapped and led. `None`
/// when nothing of it exists — a chat with the preamble off — so no hook
/// is registered for nothing.
pub fn compose(prompt: &SystemPrompt, notes: &[String]) -> Option<String> {
    let mut parts: Vec<&str> = prompt
        .segments()
        .iter()
        .filter(|s| KEPT.contains(&s.kind))
        .map(|s| s.text.as_str())
        .collect();
    parts.extend(
        notes
            .iter()
            .map(String::as_str)
            .filter(|n| !n.trim().is_empty()),
    );
    if parts.is_empty() {
        return None;
    }
    Some(format!(
        "{BRIEF_OPEN}\n{BRIEF_LEAD}\n\n{}\n{BRIEF_CLOSE}",
        parts.join("\n\n")
    ))
}

/// The `PreToolUse` entry that registers the hook, for the one
/// `--settings` JSON beside the Ask hook's entry: the command quoted word
/// by word as [`super::ask::settings_json`] quotes its own.
pub fn hook_entry(hook: &[String], dir: &Path) -> Value {
    let mut words: Vec<String> = hook.iter().map(|w| shell_quote(w)).collect();
    words.push(shell_quote(&dir.to_string_lossy()));
    serde_json::json!({
        "matcher": BRIEF_MATCHER,
        "hooks": [{ "type": "command", "command": words.join(" "), "timeout": HOOK_TIMEOUT_S }]
    })
}

/// Write the brief into `dir`, only when it differs from what is there —
/// the hook may be reading at the same moment, and an unchanged file is
/// not rewritten under it.
pub fn write(dir: &Path, text: &str) -> std::io::Result<()> {
    let path = dir.join(BRIEF_FILE);
    if std::fs::read_to_string(&path).is_ok_and(|have| have == text) {
        return Ok(());
    }
    std::fs::create_dir_all(dir)?;
    let tmp = path.with_extension("txt.tmp");
    std::fs::write(&tmp, text.as_bytes())?;
    std::fs::rename(&tmp, path)
}

/// The fields of the hook's stdin line read here.
#[derive(Debug, Deserialize)]
struct HookInput {
    #[serde(default)]
    tool_name: String,
    #[serde(default)]
    tool_input: Value,
    /// Set on a subagent's call (measured in 165 pass 2: `agent_id`
    /// beside `agent_type` on the child's `Read`).
    #[serde(default)]
    agent_id: Option<String>,
}

/// The hook's whole decision, pure: the CLI's stdin line and the chat's
/// directory in, the reply out. `{}` — no opinion, the CLI's own flow —
/// whenever there is nothing to add: no brief on disk, torn input, a
/// call whose `prompt` is not a string, or a task that already begins
/// with the brief's tag. Otherwise `allow` with the whole input back and
/// `prompt` prefixed. `allow` rather than a decision-less update because
/// `updatedInput` rides on a permission decision (`external`, the hooks
/// doc), and `Agent` is a call every mode runs unasked — the Chat
/// policy's own `deny` on it still stands, since the CLI runs every
/// matching entry and any deny wins (measured, backlog 147).
pub fn decide(dir: &Path, stdin_json: &str) -> HookReply {
    // Every tool call runs this hook since pass 2, so a `/usage` refresh
    // (seconds, blocking the call) is paid only when the chat's own wire
    // reading is older than the refresh's two minutes; a fresher one wins
    // in `freshest` anyway (review of 44ab834).
    let now_ms = chrono::Utc::now().timestamp_millis();
    let wire_fresh = read_usage_file(dir).is_some_and(|r| now_ms - r.sampled_at_ms <= 120_000);
    let gauge = if wire_fresh {
        gauge_on_hand()
    } else {
        gauge_reading()
    };
    decide_with(dir, stdin_json, gauge)
}

/// [`decide`] with the desktop's gauge reading passed in, so the suite
/// runs against a fixed window rather than this machine's files.
pub fn decide_with(dir: &Path, stdin_json: &str, gauge: Option<WindowReading>) -> HookReply {
    decide_holding(dir, stdin_json, gauge, HOLD_MS, 500, &Senses::real())
}

/// [`decide_with`] with the hold's length and poll interval passed in,
/// so the suite holds for milliseconds rather than minutes — and (backlog
/// 192) what the hook senses of the Mac, so it runs against a fixed one.
fn decide_holding(
    dir: &Path,
    stdin_json: &str,
    gauge: Option<WindowReading>,
    hold_ms: i64,
    poll_ms: u64,
    senses: &Senses,
) -> HookReply {
    let Ok(input) = serde_json::from_str::<HookInput>(stdin_json) else {
        return HookReply::pass();
    };
    // The caps first, before the brief: a torn brief must not lift them.
    // The claims are under a file lock, since the turn's hooks run at once.
    // Order (backlog 165): the window (a stop needs no count), the turn's
    // cap at that window, the chat's day.
    let limits = read_limits(dir);
    let now_ms = chrono::Utc::now().timestamp_millis();
    let reading = freshest(
        current(read_usage_file(dir), now_ms),
        current(gauge, now_ms),
    );
    // Pass 2: the message's budget, on every call of every process in
    // the turn — the main thread's, a subagent's, a council seat's. The
    // ledger takes the reading either way (the live meter reads it).
    // Backlog 189: past the stop line, a chat he is present in holds the
    // call for his answer rather than refusing it.
    let subagent = input.agent_id.as_deref().is_some_and(|s| !s.is_empty());
    let (mut verdict, turn, deadline) =
        note_reading(dir, reading, subagent, now_ms, hold_ms, senses);
    if verdict == CallVerdict::Hold
        && let Some(r) = reading
    {
        verdict = await_answer(dir, turn, deadline, r, subagent, poll_ms, senses);
    }
    let overridden = match verdict {
        CallVerdict::Deny(reason) | CallVerdict::WrapUp(reason) => {
            return HookReply::deny(reason);
        }
        CallVerdict::Allow { overridden } => overridden,
        CallVerdict::Hold => false,
    };
    if !is_spawn(&input.tool_name) {
        return HookReply::pass();
    }
    // A chat wrapping up starts nothing new (backlog 192).
    if read_turn_budget(dir).is_some_and(|b| b.wrap_at_ms.is_some() && b.started_at_ms == turn) {
        return HookReply::deny(
            "Not run: no new subagents while the chat wraps up (Swaraag pressed Wrap up). \
             Finish the hand-off yourself."
                .into(),
        );
    }
    // Under his override the stop line does not refuse the spawn either;
    // the turn's cap at that window still counts.
    let cap = if overridden {
        limits.turn_cap_at(reading.map(|r| r.five_hour_pct))
    } else {
        match window_verdict(&limits, reading) {
            Ok(cap) => cap,
            Err(reason) => return HookReply::deny(reason),
        }
    };
    if claim_spawn(dir, cap).is_err() {
        return HookReply::deny(match reading {
            Some(r) if cap < limits.per_turn => {
                slowed_cap_reason(cap, r.five_hour_pct, limits.slow_at)
            }
            _ => spawn_cap_reason(cap),
        });
    }
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    // A day cap of zero is no cap (his answer to blocker 271).
    if limits.per_day > 0 && claim_day_spawn(dir, limits.per_day, &today).is_err() {
        return HookReply::deny(day_cap_reason(limits.per_day));
    }
    let Value::Object(mut fields) = input.tool_input else {
        return HookReply::pass();
    };
    // A checkpoint fork (backlog 104, pass 3; `super::fork`): the spawn
    // asked for the `checkpoint` helper, and the chat's directory holds
    // its command line and a resolved checkpoint. The hook runs the fork
    // — a second CLI process on the chat's session, from that message —
    // and answers the spawn with `deny` carrying the report, which is the
    // Agent call's result as the model reads it (blocker 287; the hooks
    // reference gives a hook no other way to supply one — blocker 296).
    // Counted as a spawn by the caps above, as it should be. Anything
    // missing — no spec, no uuid yet, a binary that will not start — and
    // the spawn goes on as a fresh helper under the roster's own prompt,
    // briefed like any other.
    if super::fork::is_checkpoint_spawn(&fields)
        && let Some(Value::String(task)) = fields.get("prompt")
        && let Some(fs) = super::fork::read_fork_spec(dir)
        && let Some(cp) = super::fork::read_checkpoint(dir)
        && let Some(uuid) = cp.uuid.as_deref()
        && let Ok(out) = super::fork::run_fork(dir, &fs, uuid, task, super::fork::FORK_WALL_MS)
    {
        return HookReply::deny(super::fork::report(&out));
    }
    let brief = std::fs::read_to_string(dir.join(BRIEF_FILE)).unwrap_or_default();
    let mut changed = false;
    if !brief.trim().is_empty()
        && let Some(Value::String(prompt)) = fields.get("prompt")
        && !prompt.trim_start().starts_with(BRIEF_OPEN)
    {
        let briefed = format!("{}\n\n{prompt}", brief.trim_end());
        fields.insert("prompt".into(), Value::String(briefed));
        changed = true;
    }
    // The subagents' model (pass 2, blocker 280): the switch on the rail
    // sets the spawn's `model` input, which the Agent tool takes.
    let asked = fields.get("model").and_then(Value::as_str);
    if let Some(model) = limits.model.for_spawn(asked) {
        fields.insert("model".into(), Value::String(model.into()));
        changed = true;
    }
    if !changed {
        return HookReply::pass();
    }
    HookReply::allow(Some(Value::Object(fields)))
}

/// The process entry: `<binary> --subagent-hook <dir>`. Reads stdin to
/// EOF, prints one JSON line, exits 0 — never non-zero on purpose, for
/// the reason [`super::ask::run_hook`] gives.
pub fn run_hook(args: &[String]) -> std::io::Result<()> {
    let dir = args.first().map(PathBuf::from).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "--subagent-hook needs the chat directory",
        )
    })?;
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let reply = decide(&dir, &input);
    let mut out = std::io::stdout().lock();
    out.write_all(serde_json::to_string(&reply)?.as_bytes())?;
    out.write_all(b"\n")?;
    out.flush()
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_seventh_spawn_of_a_turn_is_refused_and_a_new_turn_starts_over() {
        let dir = std::env::temp_dir().join(format!("nightloom-spawn-cap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        super::write(
            &dir,
            "<nightloom-subagent-brief>x</nightloom-subagent-brief>",
        )
        .unwrap();
        let call = r#"{"tool_name":"Agent","tool_input":{"prompt":"go"}}"#;
        for _ in 0..super::SPAWN_CAP {
            assert_eq!(super::decide_with(&dir, call, None).decision(), "allow");
        }
        let r = super::decide_with(&dir, call, None);
        assert_eq!(r.decision(), "deny");
        assert!(r.reason().is_some_and(|s| s.contains("do it yourself")));
        super::reset_spawns(&dir);
        assert_eq!(super::decide_with(&dir, call, None).decision(), "allow");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The case he reported (a research turn spawning fourteen at once):
    /// the hooks run concurrently, and exactly `SPAWN_CAP` of them are
    /// allowed — the claim is under the file lock, so no two read the
    /// same count (the review of 2026-09-18; before it, all fourteen read
    /// 0). Threads stand in for the hook processes: `File::lock` is per
    /// open handle, so separate opens in one process contend as separate
    /// processes do.
    #[test]
    fn fourteen_spawns_at_once_get_exactly_the_cap() {
        let dir =
            std::env::temp_dir().join(format!("nightloom-spawn-race-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        super::write(
            &dir,
            "<nightloom-subagent-brief>x</nightloom-subagent-brief>",
        )
        .unwrap();
        let call = r#"{"tool_name":"Agent","tool_input":{"prompt":"go"}}"#;
        let gate = std::sync::Arc::new(std::sync::Barrier::new(14));
        let handles: Vec<_> = (0..14)
            .map(|_| {
                let dir = dir.clone();
                let gate = gate.clone();
                std::thread::spawn(move || {
                    gate.wait();
                    super::decide_with(&dir, call, None).decision() == "allow"
                })
            })
            .collect();
        let allowed = handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .filter(|ok| *ok)
            .count();
        assert_eq!(allowed, super::SPAWN_CAP);
        assert_eq!(
            std::fs::read_to_string(dir.join(super::SPAWNS_FILE))
                .unwrap()
                .trim(),
            super::SPAWN_CAP.to_string()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    use super::*;
    use nightloom_core::Segment;
    use serde_json::json;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nightloom-brief-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The parent's `Agent` call as the CLI handed it to the hook on
    /// 2026-09-17 (`152-evidence-2026-09-17/mb-hook.log`), the fields
    /// nothing here reads trimmed.
    const STDIN: &str = r#"{"session_id":"0ec12560","cwd":"/tmp","hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{"description":"Check for code word in task","prompt":"Reply with the code word if your task text states one.","subagent_type":"general-purpose","model":"haiku","run_in_background":false},"tool_use_id":"toolu_01Bs4UKADSZoWWJ73dAkY3aG","permission_mode":"default"}"#;

    fn preamble() -> SystemPrompt {
        let mut p = SystemPrompt::new();
        p.push(Segment::new(
            SegmentKind::ProjectInstructions,
            "project-instructions",
            "<project-instructions>\nWrite notes under notes/.\n</project-instructions>",
        ));
        p.push(Segment::new(
            SegmentKind::Knowledge,
            "knowledge",
            "<knowledge>\n@kb/a.md\n@kb/b.md\n</knowledge>",
        ));
        p.push(Segment::new(
            SegmentKind::UserMemory,
            "user-memory",
            "<user-memory>\nBe terse.\n</user-memory>",
        ));
        p.push(Segment::new(
            SegmentKind::EngineNote,
            "engine-note",
            "<engine-note>\n@kb stands for the vault directory /v.\n</engine-note>",
        ));
        p.push(Segment::new(SegmentKind::Custom, "custom", "You are Rex."));
        p
    }

    /// The brief keeps the project's instructions and the engine note,
    /// takes the notes it is given, and cuts the indexes, the standing
    /// instructions and the library prompt.
    #[test]
    fn the_brief_keeps_two_segments_and_the_notes() {
        let text = compose(
            &preamble(),
            &["<extra-folders>\n/x\n</extra-folders>".into()],
        )
        .unwrap();
        assert!(text.starts_with(BRIEF_OPEN), "{text}");
        assert!(text.ends_with(BRIEF_CLOSE), "{text}");
        assert!(text.contains("Write notes under notes/."));
        assert!(text.contains("@kb stands for the vault directory /v."));
        assert!(text.contains("<extra-folders>"));
        for cut in ["@kb/a.md", "Be terse.", "You are Rex."] {
            assert!(!text.contains(cut), "{cut} should be cut: {text}");
        }
        let p = text.find("<project-instructions>").unwrap();
        let e = text.find("<engine-note>").unwrap();
        let x = text.find("<extra-folders>").unwrap();
        assert!(p < e && e < x, "the preamble's order, the notes last");
        // Nothing to brief with: no brief, so no hook is registered.
        assert_eq!(compose(&SystemPrompt::new(), &[]), None);
        assert_eq!(compose(&SystemPrompt::from_text("You are Rex."), &[]), None);
        assert_eq!(compose(&SystemPrompt::new(), &["  ".into()]), None);
    }

    /// The hook prepends the brief to the task and hands the whole input
    /// back; without a brief on disk, or on a task already briefed, it
    /// has no opinion.
    #[test]
    fn the_hook_prepends_the_brief_once() {
        let dir = scratch();
        assert_eq!(decide(&dir, STDIN), HookReply::pass());
        let brief = compose(&preamble(), &[]).unwrap();
        write(&dir, &brief).unwrap();
        let reply = decide(&dir, STDIN);
        assert_eq!(reply.decision(), "allow");
        let updated = reply.updated_input().unwrap();
        let prompt = updated["prompt"].as_str().unwrap();
        assert!(prompt.starts_with(BRIEF_OPEN), "{prompt}");
        assert!(
            prompt.ends_with("\n\nReply with the code word if your task text states one."),
            "{prompt}"
        );
        // The rest of the input rides along untouched.
        assert_eq!(updated["subagent_type"], "general-purpose");
        assert_eq!(updated["model"], "haiku");
        assert_eq!(updated["run_in_background"], false);
        // A second pass over the briefed task adds nothing.
        let again = STDIN.replace(
            r#""prompt":"Reply with the code word if your task text states one.""#,
            &format!(r#""prompt":{}"#, Value::String(prompt.to_string())),
        );
        assert_eq!(decide(&dir, &again), HookReply::pass());
        // Torn input and a call with no string prompt: no opinion.
        assert_eq!(decide(&dir, "{not json"), HookReply::pass());
        let no_prompt = STDIN.replace(r#""prompt":"Reply"#, r#""task":"Reply"#);
        assert_eq!(decide(&dir, &no_prompt), HookReply::pass());
        // The documented reply shape, key for key.
        let json = serde_json::to_string(&reply).unwrap();
        assert!(json.contains(r#""permissionDecision":"allow""#), "{json}");
        assert!(json.contains(r#""updatedInput":{"#), "{json}");
        // Writing the same brief again leaves the file as it is; a new one
        // replaces it.
        write(&dir, &brief).unwrap();
        write(&dir, "other").unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join(BRIEF_FILE)).unwrap(),
            "other"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A checkpoint spawn (backlog 104, pass 3): with the chat's fork
    /// command line and a resolved checkpoint on disk, the hook runs the
    /// fork — a fake CLI here, echoing its argv and printing a `result`
    /// line — and answers `deny` with the report as the reason; the task
    /// reaches the fork as written (no brief: it has the context), after
    /// the chat's own arguments, with the uuid last. Before either file
    /// exists, or while the uuid is unresolved, the spawn goes through as
    /// a fresh helper, briefed like any other.
    #[test]
    #[cfg(unix)]
    fn a_checkpoint_spawn_runs_the_fork_and_denies_with_its_report() {
        use super::super::fork::{self, Checkpoint, CheckpointSetBy, ForkSpec};
        let dir = scratch();
        write(&dir, &compose(&preamble(), &[]).unwrap()).unwrap();
        let stdin = STDIN.replace(
            r#""subagent_type":"general-purpose""#,
            r#""subagent_type":"checkpoint""#,
        );
        // No fork spec yet: a fresh helper, briefed.
        let reply = super::decide_with(&dir, &stdin, None);
        assert_eq!(reply.decision(), "allow");
        assert!(
            reply.updated_input().unwrap()["prompt"]
                .as_str()
                .unwrap()
                .starts_with(BRIEF_OPEN)
        );
        let fake = dir.join("fake-claude.sh");
        let args_file = dir.join("args.txt");
        std::fs::write(
            &fake,
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$FORK_ARGS\"\n\
             echo '{\"type\":\"result\",\"result\":\"Code word A: APPLE\",\"session_id\":\"fork-9\",\"num_turns\":1,\"is_error\":false,\"usage\":{\"cache_read_input_tokens\":35034,\"cache_creation_input_tokens\":231}}'\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        fork::write_fork_spec(
            &dir,
            &ForkSpec {
                binary: fake.to_string_lossy().into_owned(),
                workspace: dir.clone(),
                argv: vec![
                    "-p".into(),
                    String::new(),
                    "--resume".into(),
                    "sess-1".into(),
                    "--fork-session".into(),
                ],
                env: vec![("FORK_ARGS".into(), args_file.to_string_lossy().into_owned())],
                env_remove: vec![],
            },
        )
        .unwrap();
        // A checkpoint whose uuid is not resolved yet: still a fresh helper.
        let mut cp = Checkpoint {
            index: 1,
            uuid: None,
            resolved_in: None,
            set_by: CheckpointSetBy::Auto,
            at_ms: 1,
        };
        fork::write_checkpoint(&dir, &cp).unwrap();
        assert_eq!(super::decide_with(&dir, &stdin, None).decision(), "allow");
        assert!(!args_file.exists(), "no fork ran");
        // Resolved: the fork runs and its report is the call's result.
        cp.uuid = Some("s2".into());
        cp.resolved_in = Some("sess-1".into());
        fork::write_checkpoint(&dir, &cp).unwrap();
        let reply = super::decide_with(&dir, &stdin, None);
        assert_eq!(reply.decision(), "deny");
        let reason = reply
            .hook_specific_output
            .as_ref()
            .and_then(|o| o.permission_decision_reason.clone())
            .unwrap();
        assert!(reason.starts_with(fork::REPORT_LEAD), "{reason}");
        assert!(reason.ends_with("Code word A: APPLE"), "{reason}");
        assert!(
            reason.contains("cache read 35034 / written 231"),
            "{reason}"
        );
        let args = std::fs::read_to_string(&args_file).unwrap();
        assert_eq!(
            args.lines().collect::<Vec<_>>(),
            [
                "-p",
                "Reply with the code word if your task text states one.",
                "--resume",
                "sess-1",
                "--fork-session",
                "--resume-session-at",
                "s2"
            ]
        );
        // The stream is kept under the chat's directory.
        assert_eq!(
            std::fs::read_dir(dir.join(fork::FORKS_DIR))
                .unwrap()
                .count(),
            2,
            "the stream and the stderr file"
        );
        // A fork subagent (`fork`) or a general-purpose one is not this
        // path: briefed and allowed as before.
        let plain = STDIN.replace(
            r#""subagent_type":"general-purpose""#,
            r#""subagent_type":"fork""#,
        );
        assert_eq!(super::decide_with(&dir, &plain, None).decision(), "allow");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The registration: the matcher names both spellings of the tool,
    /// the command is quoted word by word.
    #[test]
    fn the_hook_entry_is_quoted_and_matches_both_names() {
        let entry = hook_entry(
            &[
                "/Applications/Night loom.app/Contents/MacOS/nightloom-desktop".into(),
                "--subagent-hook".into(),
            ],
            Path::new("/tmp/ask/chat-1"),
        );
        assert_eq!(entry["matcher"], BRIEF_MATCHER);
        assert_eq!(
            entry["hooks"][0]["command"],
            "'/Applications/Night loom.app/Contents/MacOS/nightloom-desktop' '--subagent-hook' '/tmp/ask/chat-1'"
        );
        assert_eq!(entry["hooks"][0]["type"], "command");
        // ~~`Agent|Task`~~ — every tool since pass 2 of backlog 165; the
        // spawn branch is chosen by the call's name instead.
        assert_eq!(json!(BRIEF_MATCHER), ".*");
        assert!(is_spawn("Agent") && is_spawn("Task") && !is_spawn("Read"));
    }

    // The per-message budget (nightshift backlog 165, pass 2, 2026-09-22).

    fn reading(pct: u8, at_ms: i64) -> Option<super::WindowReading> {
        Some(super::WindowReading {
            five_hour_pct: pct,
            // An hour ahead: a reading whose window has reset is no reading.
            resets_at: Some(chrono::Utc::now().timestamp() + 3600),
            sampled_at_ms: at_ms,
        })
    }

    /// The verdict, pure: the stop line refuses everything; the budget
    /// refuses once latest − start reaches it; no start (nothing on hand
    /// when the turn began) and no reading judge nothing.
    #[test]
    fn the_budget_verdict_stops_at_the_line_and_at_the_message_share() {
        let l = super::SubagentLimits::default();
        let b = super::start_turn_budget(None, &l, reading(21, 1), 1_000, super::TurnPhase::Turn);
        assert_eq!(
            (b.start_pct, b.budget_pct, b.stop_at, b.phase.as_str()),
            (Some(21), 35, 85, "turn")
        );
        assert_eq!(super::budget_verdict(&b, None), Ok(()));
        assert_eq!(super::budget_verdict(&b, reading(55, 2)), Ok(()));
        let spent = super::budget_verdict(&b, reading(56, 2)).unwrap_err();
        assert!(
            spent.contains("spent 35%")
                && spent.contains("from 21% to 56%")
                && spent.contains("do not retry"),
            "{spent}"
        );
        let line = super::budget_verdict(&b, reading(85, 2)).unwrap_err();
        assert!(
            line.contains("stop line is 85%") && line.contains("It resets at "),
            "{line}"
        );
        // A budget of zero is no budget; the stop line still holds.
        let none = super::start_turn_budget(
            None,
            &super::SubagentLimits { budget_pct: 0, ..l },
            reading(21, 1),
            1_000,
            super::TurnPhase::Turn,
        );
        assert_eq!(super::budget_verdict(&none, reading(84, 2)), Ok(()));
        // No reading on hand at the start: nothing to judge until one is pinned.
        let blind = super::start_turn_budget(None, &l, None, 1_000, super::TurnPhase::Turn);
        assert_eq!(blind.start_pct, None);
        assert_eq!(super::budget_verdict(&blind, reading(99 - 15, 2)), Ok(()));
    }

    /// The chair continues the seats' ledger (its start is the message's
    /// start, before the seats spent), an ordinary turn after a stale one
    /// does not, and a fresh `seats` start is never a continuation.
    #[test]
    fn a_chair_continues_its_seats_ledger_and_nothing_else_does() {
        let l = super::SubagentLimits::default();
        let seats =
            super::start_turn_budget(None, &l, reading(20, 1), 1_000, super::TurnPhase::Seats);
        assert_eq!(seats.phase, "seats");
        let done = super::TurnBudget {
            phase: "seats-done".into(),
            latest_pct: Some(30),
            ..seats.clone()
        };
        let chair = super::start_turn_budget(
            Some(done.clone()),
            &l,
            reading(30, 2),
            5_000,
            super::TurnPhase::Chair(1_000),
        );
        assert_eq!(
            (chair.phase.as_str(), chair.start_pct, chair.started_at_ms),
            ("turn", Some(20), 1_000)
        );
        let stale = super::start_turn_budget(
            Some(done.clone()),
            &l,
            reading(30, 2),
            1_000 + 11 * 60 * 1000,
            super::TurnPhase::Chair(1_000),
        );
        assert_eq!((stale.phase.as_str(), stale.start_pct), ("turn", Some(30)));
        let again = super::start_turn_budget(
            Some(done.clone()),
            &l,
            reading(30, 2),
            5_000,
            super::TurnPhase::Seats,
        );
        assert_eq!((again.phase.as_str(), again.start_pct), ("seats", Some(30)));
        let plain = super::start_turn_budget(
            Some(chair),
            &l,
            reading(31, 3),
            9_000,
            super::TurnPhase::Turn,
        );
        assert_eq!((plain.start_pct, plain.started_at_ms), (Some(31), 9_000));
        // A chair armed for another council's seats does not continue these.
        let other = super::start_turn_budget(
            Some(done.clone()),
            &l,
            reading(30, 2),
            5_000,
            super::TurnPhase::Chair(777),
        );
        assert_eq!((other.start_pct, other.started_at_ms), (Some(30), 5_000));
    }

    /// Backlog 187: the seats ran and spent, the chair never did (a Stop,
    /// an error); an ordinary message a minute later starts its own ledger
    /// at 0 % spent — through the files, as the turns write them.
    #[test]
    fn seats_whose_chair_never_ran_leave_nothing_on_the_next_message() {
        let dir = std::env::temp_dir().join(format!(
            "nightloom-187-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let l = super::SubagentLimits::default();
        // The seats' ledger, as `run_seats` leaves it: started at 20 %,
        // the seats spent 10, then `finish_seats`.
        let seats = super::TurnBudget {
            latest_pct: Some(30),
            calls: 12,
            ..super::start_turn_budget(None, &l, reading(20, 1), 1_000, super::TurnPhase::Seats)
        };
        super::write_turn_budget(&dir, &seats);
        super::finish_seats(&dir);
        assert_eq!(super::seats_ledger(&dir), Some(1_000));
        // No chair: the next message is an ordinary turn.
        let have = super::read_turn_budget(&dir);
        let next =
            super::start_turn_budget(have, &l, reading(30, 2), 61_000, super::TurnPhase::Turn);
        assert_eq!(next.spent_pct(), Some(0));
        assert_eq!(
            (next.phase.as_str(), next.started_at_ms, next.calls),
            ("turn", 61_000, 0)
        );
        // And through `begin_turn` itself: the seats' ledger is replaced.
        super::begin_turn(&dir, &l, super::TurnPhase::Turn);
        let b = super::read_turn_budget(&dir).unwrap();
        assert_ne!(b.started_at_ms, 1_000);
        assert_eq!((b.phase.as_str(), b.calls), ("turn", 0));
        assert_eq!(super::seats_ledger(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Through the hook: a `Read` (not a spawn) is allowed under budget,
    /// refused past it with the ledger recording the refusal, and a start
    /// no reading was on hand for is pinned by the first reading. The
    /// ledger's latest never goes backwards under a slower hook.
    #[test]
    fn every_tool_call_is_judged_by_the_budget_and_the_ledger_keeps_the_latest() {
        let dir = limits_dir("budget");
        let now = chrono::Utc::now().timestamp_millis();
        let l = super::SubagentLimits::default();
        super::write_limits(&dir, &l).unwrap();
        super::write_usage(&dir, 40, Some(now / 1000 + 3600), now);
        super::begin_turn(&dir, &l, super::TurnPhase::Turn);
        let read = r#"{"tool_name":"Read","tool_input":{"file_path":"/x"}}"#;
        assert_eq!(super::decide_with(&dir, read, None).decision(), "pass");
        let b = super::read_turn_budget(&dir).unwrap();
        assert_eq!(
            (b.start_pct, b.latest_pct, b.calls, b.spent_pct()),
            (Some(40), Some(40), 1, Some(0))
        );
        // The gauge, fresher, says 60: twenty spent of thirty-five, allowed.
        assert_eq!(
            super::decide_with(&dir, read, reading(60, now + 1)).decision(),
            "pass"
        );
        assert_eq!(super::read_turn_budget(&dir).unwrap().spent_pct(), Some(20));
        // An older reading a slower hook brings in does not move it back.
        assert_eq!(
            super::decide_with(&dir, read, reading(50, now - 5)).decision(),
            "pass"
        );
        assert_eq!(super::read_turn_budget(&dir).unwrap().latest_pct, Some(60));
        // 75: thirty-five spent — refused, and a spawn is refused the same.
        let r = super::decide_with(&dir, read, reading(75, now + 2));
        assert_eq!(r.decision(), "deny");
        assert!(r.reason().is_some_and(|s| s.contains("spent 35%")));
        let b = super::read_turn_budget(&dir).unwrap();
        assert!(
            b.stopped
                .as_deref()
                .is_some_and(|s| s.contains("spent 35%"))
        );
        assert_eq!(
            super::decide_with(&dir, CALL, reading(75, now + 3)).decision(),
            "deny"
        );
        // A new turn starts over from the reading on hand (the wire file's 40).
        super::begin_turn(&dir, &l, super::TurnPhase::Turn);
        let b = super::read_turn_budget(&dir).unwrap();
        assert_eq!(
            (b.start_pct, b.stopped.is_none(), b.calls),
            (Some(40), true, 0)
        );
        assert_eq!(
            super::decide_with(&dir, read, reading(74, now + 4)).decision(),
            "pass"
        );
        // No reading on hand at the start: the first hook reading pins it.
        let _ = std::fs::remove_file(dir.join(super::USAGE_FILE));
        super::begin_turn(&dir, &l, super::TurnPhase::Turn);
        // (This machine's own gauge may supply one; either way the ledger exists.)
        assert!(
            super::read_turn_budget(&dir).unwrap().start_pct.is_none()
                || super::gauge_on_hand().is_some()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // The override when he is present (nightshift backlog 189, 2026-09-22;
    // pass 2, backlog 192).

    fn ov(turn: i64, decision: &str, expires_at_ms: i64) -> super::BudgetOverride {
        super::BudgetOverride {
            turn,
            decision: decision.into(),
            at_ms: 0,
            expires_at_ms,
            text: None,
        }
    }

    /// The pure check: *Stop* and *Wrap* name their message — another
    /// turn's, an expired one or a word it does not know is nothing; a
    /// *Continue* is the chat's, whatever turn it named, while it holds.
    /// No answer holds only a present chat's own call; the 35 % share
    /// still binds under the override; a *Wrap* is carried once by the
    /// chat's own call, refuses a subagent's, and lets later calls on.
    #[test]
    fn the_override_lets_this_turn_through_and_nothing_else() {
        use super::Answer;
        use super::CallVerdict::*;
        let l = super::SubagentLimits::default();
        let b = super::start_turn_budget(None, &l, reading(60, 1), 1_000, super::TurnPhase::Turn);
        let now = 5_000;
        let of = |o: super::BudgetOverride, ok: bool| super::override_for(&b, Some(&o), ok, now);
        assert_eq!(
            of(ov(1_000, "continue", now + 1), true),
            Some(Answer::Continue)
        );
        // Backlog 192: another turn's Continue is still the chat's …
        assert_eq!(
            of(ov(999, "continue", now + 1), true),
            Some(Answer::Continue)
        );
        // … until he has been away (`continue_holds` said no).
        assert_eq!(of(ov(1_000, "continue", now + 1), false), None);
        assert_eq!(of(ov(1_000, "yes", now + 1), true), None);
        assert_eq!(of(ov(1_000, "stop", now + 1), true), Some(Answer::Stop));
        assert_eq!(of(ov(999, "stop", now + 1), true), None, "another turn");
        assert_eq!(of(ov(1_000, "stop", now), true), None, "expired");
        assert_eq!(
            of(ov(1_000, "wrap", now + 1), false),
            Some(Answer::Wrap(super::WRAP_UP_DEFAULT.into()))
        );
        assert_eq!(super::override_for(&b, None, true, now), None);
        let go = Some(&Answer::Continue);
        // 90 %: past the line, 30 spent of 35 — Continue lets it through.
        assert_eq!(
            super::call_verdict(&b, reading(90, 2), go, false, false),
            Allow { overridden: true }
        );
        // The same from a subagent: the parent's chat is overridden.
        assert_eq!(
            super::call_verdict(&b, reading(90, 2), go, false, true),
            Allow { overridden: true }
        );
        // Stop, or nothing and nobody there: refused as before.
        for (o, present) in [(Some(&Answer::Stop), true), (None, false)] {
            let v = super::call_verdict(&b, reading(90, 2), o, present, false);
            assert!(
                matches!(&v, Deny(r) if r.contains("stop line is 85%")),
                "{v:?}"
            );
        }
        // Nothing yet and he is there: held — but a subagent's call is refused.
        assert_eq!(
            super::call_verdict(&b, reading(90, 2), None, true, false),
            Hold
        );
        assert!(matches!(
            super::call_verdict(&b, reading(90, 2), None, true, true),
            Deny(_)
        ));
        // Under the line nothing changes: no hold, no override needed.
        assert_eq!(
            super::call_verdict(&b, reading(80, 2), None, true, false),
            Allow { overridden: false }
        );
        // The message's 35 % still binds under the override: 95 − 60.
        let v = super::call_verdict(&b, reading(95, 2), go, true, false);
        assert!(matches!(&v, Deny(r) if r.contains("spent 35%")), "{v:?}");
        // Wrap up, at any window: carried by the chat's own call …
        let wrap = Answer::Wrap("write HANDOFF.md".into());
        for r in [reading(50, 2), reading(90, 2), None] {
            let v = super::call_verdict(&b, r, Some(&wrap), true, false);
            assert!(
                matches!(&v, WrapUp(t) if t.contains("Wrap up") && t.ends_with("write HANDOFF.md")),
                "{v:?}"
            );
        }
        // … a subagent's call is told to stop …
        assert!(matches!(
            super::call_verdict(&b, reading(90, 2), Some(&wrap), true, true),
            Deny(r) if r.contains("wrapping up")
        ));
        // … and once carried, the chat's calls go on past the line to write it.
        let mut carried = b.clone();
        carried.wrap_at_ms = Some(4_000);
        assert_eq!(
            super::call_verdict(&carried, reading(90, 2), Some(&wrap), false, false),
            Allow { overridden: true }
        );
    }

    /// Presence (backlog 192): the Mac's input within 10 minutes, or — as
    /// before — seen in a focused window within 20 s, or his message within
    /// 5 minutes; nothing readable and nothing on file is absent.
    #[test]
    fn presence_is_the_macs_activity_or_a_recent_look_or_message() {
        let now = 1_000_000_000;
        let p = |seen: Option<i64>, input: Option<i64>| {
            Some(super::Presence {
                seen_at_ms: seen,
                input_at_ms: input,
            })
        };
        let away = super::AWAY_MS;
        assert!(!super::is_present(None, None, now));
        // The Mac alone decides it, with nothing from the window.
        assert!(super::is_present(None, Some(away - 1), now));
        assert!(!super::is_present(None, Some(away), now));
        // The window's inputs still count when the Mac says away.
        assert!(super::is_present(
            p(Some(now - 20_000), None),
            Some(away),
            now
        ));
        assert!(!super::is_present(
            p(Some(now - 20_001), None),
            Some(away),
            now
        ));
        assert!(super::is_present(
            p(Some(now - 60_000), Some(now - 300_000)),
            None,
            now
        ));
        assert!(!super::is_present(
            p(Some(now - 60_000), Some(now - 300_001)),
            None,
            now
        ));
    }

    /// `HIDIdleTime` out of `ioreg`'s text, nanoseconds to milliseconds.
    #[test]
    fn the_macs_idle_time_is_read_from_ioreg() {
        let text = "+-o IOHIDSystem  <class IOHIDSystem>\n  |   \"HIDIdleTime\" = 2148615587208\n";
        assert_eq!(super::parse_hid_idle(text), Some(2_148_615));
        assert_eq!(super::parse_hid_idle("nothing here"), None);
    }

    /// A *Continue* lasts while he stays (backlog 192): an observation
    /// finding him away 10 minutes ends it, and so does a gap of 10 minutes
    /// nobody observed (the Mac asleep, the app closed); an away stretch
    /// before the click does not; an unreadable idle time never vouches.
    #[test]
    fn a_continue_lasts_until_he_has_been_away_ten_minutes() {
        let away = super::AWAY_MS;
        let click = 100 * away;
        let hold = |a: super::Activity, idle: Option<i64>, now: i64| {
            super::continue_holds(click, Some(a), idle, now)
        };
        // Watched every minute, active: holds for hours.
        let mut a = super::observe(None, Some(1_000), click - 60_000);
        for m in 1..=180 {
            a = super::observe(Some(a), Some(30_000), click + m * 60_000);
        }
        assert!(hold(a, Some(30_000), click + 180 * 60_000));
        // He walks away: the watcher's next look past 10 minutes ends it,
        // and his return does not bring it back.
        let t = click + 200 * 60_000;
        let gone = super::observe(Some(a), Some(away), t);
        assert!(!hold(gone, Some(away), t));
        let back = super::observe(Some(gone), Some(2_000), t + 60_000);
        assert!(!hold(back, Some(2_000), t + 60_000));
        // A gap nobody observed (asleep): away, even if he is at the keys now.
        let woke = super::observe(Some(a), Some(1_000), click + 181 * 60_000 + away);
        assert!(!hold(woke, Some(1_000), click + 181 * 60_000 + away));
        // Away before the click is not away after it.
        let before = super::observe(None, Some(away), click - 60_000);
        let after = super::observe(Some(before), Some(1_000), click + 30_000);
        assert!(hold(after, Some(1_000), click + 30_000));
        // Unreadable idle: not vouched for.
        assert!(!hold(after, None, click + 30_000));
        let blind = super::observe(Some(after), None, click + 60_000);
        assert!(!hold(blind, Some(1_000), click + 90_000));
        // The backstop.
        assert!(!super::continue_holds(
            click,
            None,
            Some(0),
            click + super::CONTINUE_TTL_MS
        ));
    }

    /// The suite's senses: the Mac's idle time from a cell the test sets,
    /// the activity record in the test's own directory.
    fn senses<'a>(idle: &'a dyn Fn() -> Option<i64>, dir: &std::path::Path) -> super::Senses<'a> {
        super::Senses {
            idle_ms: idle,
            activity: Some(dir.join(super::ACTIVITY_FILE)),
        }
    }

    /// Wait (bounded) for the ledger to show a held call, then answer it.
    fn answer_when_held(
        dir: PathBuf,
        decision: &'static str,
        text: Option<String>,
    ) -> std::thread::JoinHandle<bool> {
        std::thread::spawn(move || {
            let until = std::time::Instant::now() + std::time::Duration::from_secs(20);
            while std::time::Instant::now() < until {
                std::thread::sleep(std::time::Duration::from_millis(5));
                if super::read_turn_budget(&dir).is_some_and(|b| b.pending_since_ms.is_some()) {
                    let at = chrono::Utc::now().timestamp_millis();
                    super::write_answer(&dir, decision, text, at).unwrap();
                    return true;
                }
            }
            false
        })
    }

    /// Through the hook, past the line at 90 %: unattended it is refused
    /// without a hold; present, the call is held and the ledger says so;
    /// his Continue lets it (and a spawn) through and is recorded; since
    /// backlog 192 it carries to the chat's next message while he stays,
    /// and ends when he has been away; another chat's directory never sees
    /// it; Stop refuses a held call. Pass 2 (backlog 192) made it robust:
    /// ~~the unattended call must return in under 300 ms~~ (it missed that
    /// under a loaded machine, 2026-09-23) — "not held" is now read from
    /// the ledger, never from a clock; the held-and-clicked call waits up
    /// to 20 s for its click rather than racing a 400 ms hold.
    #[test]
    fn a_held_call_goes_on_by_his_click_for_this_message_only() {
        let dir = limits_dir("override");
        let other = limits_dir("override-other");
        let now = chrono::Utc::now().timestamp_millis();
        let l = super::SubagentLimits::default();
        for d in [&dir, &other] {
            super::write_limits(d, &l).unwrap();
            super::write_usage(d, 70, Some(now / 1000 + 3600), now);
            super::begin_turn(d, &l, super::TurnPhase::Turn);
        }
        let idle_ms = std::sync::atomic::AtomicI64::new(-1);
        let idle = || match idle_ms.load(std::sync::atomic::Ordering::SeqCst) {
            -1 => None,
            v => Some(v),
        };
        let s = senses(&idle, &dir);
        let s_other = senses(&idle, &other);
        let read = r#"{"tool_name":"Read","tool_input":{"file_path":"/x"}}"#;
        let hold_for = |d: &std::path::Path, stdin: &str, at: i64, ms: i64, s: &super::Senses| {
            super::decide_holding(d, stdin, reading(90, at), ms, 5, s)
        };
        // Nobody there (the Mac unread, nothing from the window): refused,
        // and never held — the ledger shows no hold was taken.
        assert_eq!(hold_for(&dir, read, now + 1, 60_000, &s).decision(), "deny");
        let b = super::read_turn_budget(&dir).unwrap();
        assert!(b.holds.is_empty() && b.pending_since_ms.is_none(), "{b:?}");
        // The Mac idle 10 minutes: away, refused the same way.
        idle_ms.store(super::AWAY_MS, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(hold_for(&dir, read, now + 2, 60_000, &s).decision(), "deny");
        assert!(super::read_turn_budget(&dir).unwrap().holds.is_empty());
        // He is at the Mac, and says nothing: held for the hold, then refused,
        // and the hold leaves the ledger.
        idle_ms.store(5_000, std::sync::atomic::Ordering::SeqCst);
        let t = std::time::Instant::now();
        assert_eq!(hold_for(&dir, read, now + 3, 100, &s).decision(), "deny");
        assert!(t.elapsed() >= std::time::Duration::from_millis(100));
        let b = super::read_turn_budget(&dir).unwrap();
        assert!(b.pending_since_ms.is_none() && b.holds.is_empty(), "{b:?}");
        // Held, and he clicks Continue while it waits: it goes on.
        let clicker = answer_when_held(dir.clone(), "continue", None);
        assert_eq!(hold_for(&dir, read, now + 4, 20_000, &s).decision(), "pass");
        assert!(
            clicker.join().unwrap(),
            "the ledger showed the call pending"
        );
        let b = super::read_turn_budget(&dir).unwrap();
        assert!(b.override_at_ms.is_some() && b.pending_since_ms.is_none());
        // The rest of this message goes through without asking — a spawn too.
        assert_eq!(hold_for(&dir, read, now + 5, 60_000, &s).decision(), "pass");
        assert_ne!(hold_for(&dir, CALL, now + 6, 60_000, &s).decision(), "deny");
        // Another chat's calls: its own directory, no override — refused
        // (away there, so at once).
        idle_ms.store(-1, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(
            hold_for(&other, read, now + 7, 60_000, &s_other).decision(),
            "deny"
        );
        // The next message of this chat, him still at the Mac: the chat's
        // Continue carries (backlog 192), and the ledger records it.
        idle_ms.store(5_000, std::sync::atomic::Ordering::SeqCst);
        std::thread::sleep(std::time::Duration::from_millis(2));
        super::begin_turn(&dir, &l, super::TurnPhase::Turn);
        assert_eq!(hold_for(&dir, read, now + 8, 60_000, &s).decision(), "pass");
        assert!(
            super::read_turn_budget(&dir)
                .unwrap()
                .override_at_ms
                .is_some()
        );
        // He is away 10 minutes: the Continue has ended, and the next call is
        // refused (nobody there to ask) — and stays ended when he is back:
        // that call is held again for a new answer.
        idle_ms.store(super::AWAY_MS, std::sync::atomic::Ordering::SeqCst);
        assert_eq!(hold_for(&dir, read, now + 9, 60_000, &s).decision(), "deny");
        idle_ms.store(1_000, std::sync::atomic::Ordering::SeqCst);
        let t = std::time::Instant::now();
        assert_eq!(hold_for(&dir, read, now + 10, 100, &s).decision(), "deny");
        assert!(
            t.elapsed() >= std::time::Duration::from_millis(100),
            "held, not passed"
        );
        // Stop here, with him there: refused at once, recorded.
        super::write_override(&dir, false, chrono::Utc::now().timestamp_millis()).unwrap();
        assert_eq!(
            hold_for(&dir, read, now + 11, 60_000, &s).decision(),
            "deny"
        );
        assert!(super::read_turn_budget(&dir).unwrap().stopped.is_some());
        // The registration gives the hook longer than a hold.
        let entry = super::hook_entry(&["x".into()], &dir);
        assert!(entry["hooks"][0]["timeout"].as_i64().unwrap() * 1000 > super::HOLD_MS);
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&other);
    }

    /// *Wrap up* (backlog 192) on a held call: the call is refused with his
    /// instruction, the model's next calls run (past the line) so it can
    /// write the hand-off, a spawn is refused, a subagent is told to stop;
    /// from the meter with nothing held, the next call carries it.
    #[test]
    fn wrap_up_is_carried_once_then_the_hand_off_may_be_written() {
        let dir = limits_dir("wrap");
        let now = chrono::Utc::now().timestamp_millis();
        let l = super::SubagentLimits::default();
        super::write_limits(&dir, &l).unwrap();
        super::write_usage(&dir, 70, Some(now / 1000 + 3600), now);
        super::begin_turn(&dir, &l, super::TurnPhase::Turn);
        let idle = || Some(1_000);
        let s = senses(&idle, &dir);
        let read = r#"{"tool_name":"Read","tool_input":{"file_path":"/x"}}"#;
        let write = r#"{"tool_name":"Write","tool_input":{"file_path":"/p/HANDOFF.md"}}"#;
        let sub = r#"{"tool_name":"Read","tool_input":{},"agent_id":"a1"}"#;
        let go = |stdin: &str, at: i64| {
            super::decide_holding(&dir, stdin, reading(90, at), 20_000, 5, &s)
        };
        let clicker = answer_when_held(dir.clone(), "wrap", Some("write HANDOFF.md now".into()));
        let r = go(read, now + 1);
        assert!(clicker.join().unwrap());
        assert_eq!(r.decision(), "deny");
        let words = serde_json::to_string(&r).unwrap();
        assert!(
            words.contains("Wrap up") && words.contains("write HANDOFF.md now"),
            "{words}"
        );
        let b = super::read_turn_budget(&dir).unwrap();
        assert!(b.wrap_at_ms.is_some() && b.pending_since_ms.is_none() && b.holds.is_empty());
        assert_eq!(go(write, now + 2).decision(), "pass");
        assert_eq!(go(CALL, now + 3).decision(), "deny");
        assert_eq!(go(sub, now + 4).decision(), "deny");
        // The next message: the wrap named the last one; nothing carries.
        std::thread::sleep(std::time::Duration::from_millis(2));
        super::begin_turn(&dir, &l, super::TurnPhase::Turn);
        let b = super::read_turn_budget(&dir).unwrap();
        assert!(b.wrap_at_ms.is_none());
        // From the meter, under the line and nothing held: the next call
        // carries it, the one after runs.
        super::write_answer(&dir, "wrap", None, chrono::Utc::now().timestamp_millis()).unwrap();
        let under = |stdin: &str, at: i64| {
            super::decide_holding(&dir, stdin, reading(50, at), 20_000, 5, &s)
        };
        let r = under(read, now + 5);
        assert_eq!(r.decision(), "deny");
        assert!(serde_json::to_string(&r).unwrap().contains("HANDOFF.md"));
        assert_eq!(under(write, now + 6).decision(), "pass");
        assert!(super::write_answer(&dir, "maybe", None, 0).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Two calls held at once (review finding 6): the card stays until the
    /// last one ends; a torn ledger mid-hold is waited through, not read as
    /// permission (finding 1).
    #[test]
    fn parallel_holds_keep_the_card_and_a_torn_ledger_never_lets_a_call_through() {
        let dir = limits_dir("holds");
        let now = chrono::Utc::now().timestamp_millis();
        let l = super::SubagentLimits::default();
        super::write_limits(&dir, &l).unwrap();
        super::write_usage(&dir, 70, Some(now / 1000 + 3600), now);
        super::begin_turn(&dir, &l, super::TurnPhase::Turn);
        let read = r#"{"tool_name":"Read","tool_input":{"file_path":"/x"}}"#;
        let spawn_hold = |at: i64, ms: i64| {
            let d = dir.clone();
            std::thread::spawn(move || {
                let idle = || Some(1_000);
                let s = senses(&idle, &d);
                super::decide_holding(&d, read, reading(90, at), ms, 5, &s)
                    .decision()
                    .to_string()
            })
        };
        let holds = || super::read_turn_budget(&dir).map_or(0, |b| b.holds.len());
        let wait_for = |n: usize| {
            let until = std::time::Instant::now() + std::time::Duration::from_secs(20);
            while holds() != n && std::time::Instant::now() < until {
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            holds() == n
        };
        // The long hold first, and only once the ledger shows it, the short.
        let long = spawn_hold(now + 1, 60_000);
        assert!(wait_for(1));
        let short = spawn_hold(now + 2, 100);
        assert_eq!(short.join().unwrap(), "deny");
        // The short hold has ended; the long one still waits: the card stays.
        let b = super::read_turn_budget(&dir).unwrap();
        assert!(b.pending_since_ms.is_some() && b.holds.len() == 1, "{b:?}");
        // A torn ledger under the hold: empty for a moment, as a writer's
        // truncate leaves it, with the long hook polling every 5 ms.
        {
            use std::io::Write as _;
            let path = dir.join(super::TURN_BUDGET_FILE);
            let good = std::fs::read(&path).unwrap();
            std::fs::write(&path, b"").unwrap();
            std::thread::sleep(std::time::Duration::from_millis(50));
            let mut f = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
            f.write_all(&good).unwrap();
        }
        // Still held (a torn read let nothing through); Stop ends it.
        assert!(!long.is_finished(), "a torn ledger ended the hold");
        super::write_override(&dir, false, chrono::Utc::now().timestamp_millis()).unwrap();
        assert_eq!(long.join().unwrap(), "deny");
        let b = super::read_turn_budget(&dir).unwrap();
        assert!(b.pending_since_ms.is_none() && b.holds.is_empty(), "{b:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The subagents' model (blocker 280): `chat` leaves the spawn alone;
    /// `sonnet` sets the call's `model` unless the parent asked for haiku.
    #[test]
    fn the_sonnet_switch_sets_the_spawns_model_and_haiku_is_left_cheaper() {
        assert_eq!(super::SubagentModel::Chat.for_spawn(None), None);
        assert_eq!(super::SubagentModel::Chat.for_spawn(Some("opus")), None);
        assert_eq!(super::SubagentModel::Sonnet.for_spawn(None), Some("sonnet"));
        assert_eq!(
            super::SubagentModel::Sonnet.for_spawn(Some("opus")),
            Some("sonnet")
        );
        assert_eq!(super::SubagentModel::Sonnet.for_spawn(Some("haiku")), None);
        assert_eq!(super::SubagentModel::Sonnet.for_spawn(Some("sonnet")), None);
        let dir = limits_dir("model");
        super::write_limits(
            &dir,
            &super::SubagentLimits {
                model: super::SubagentModel::Sonnet,
                ..Default::default()
            },
        )
        .unwrap();
        let r = super::decide_with(
            &dir,
            r#"{"tool_name":"Agent","tool_input":{"prompt":"go","model":"opus"}}"#,
            None,
        );
        assert_eq!(r.decision(), "allow");
        let out = r
            .hook_specific_output
            .as_ref()
            .and_then(|o| o.updated_input.clone())
            .unwrap();
        assert_eq!(out["model"], "sonnet");
        assert!(out["prompt"].as_str().unwrap().starts_with(BRIEF_OPEN));
        // With the brief already on the prompt, the model alone changes the input.
        let r = super::decide_with(
            &dir,
            r#"{"tool_name":"Agent","tool_input":{"prompt":"<nightloom-subagent-brief>x</nightloom-subagent-brief>\n\ngo"}}"#,
            None,
        );
        assert_eq!(r.decision(), "allow");
        let out = r
            .hook_specific_output
            .as_ref()
            .and_then(|o| o.updated_input.clone())
            .unwrap();
        assert_eq!(out["model"], "sonnet");
        assert!(out["prompt"].as_str().unwrap().starts_with(BRIEF_OPEN));
        assert_eq!(
            out["prompt"].as_str().unwrap().matches(BRIEF_OPEN).count(),
            1
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // The family of limits (nightshift backlog 165).
    fn limits_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("nightloom-165-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        super::write(
            &dir,
            "<nightloom-subagent-brief>x</nightloom-subagent-brief>",
        )
        .unwrap();
        dir
    }
    const CALL: &str = r#"{"tool_name":"Agent","tool_input":{"prompt":"go"}}"#;

    #[test]
    fn limits_round_trip_and_a_partial_file_keeps_the_defaults() {
        let dir = limits_dir("rt");
        let l = super::SubagentLimits {
            per_turn: 4,
            stop_at: 95,
            ..Default::default()
        };
        super::write_limits(&dir, &l).unwrap();
        assert_eq!(super::read_limits(&dir), l);
        std::fs::write(dir.join(super::LIMITS_FILE), r#"{"per_day": 5}"#).unwrap();
        let back = super::read_limits(&dir);
        assert_eq!(back.per_day, 5);
        assert_eq!(back.per_turn, super::SPAWN_CAP);
        // 4 at once since pass 2 (blocker 279, his answer); 35 % a message
        // (278); the chat's own model (280).
        assert_eq!(back.concurrent, 4);
        assert_eq!(back.depth, 3);
        assert_eq!(back.budget_pct, 35);
        assert_eq!(back.model, super::SubagentModel::Chat);
        let json = serde_json::to_string(&super::SubagentLimits::default()).unwrap();
        assert!(json.contains(r#""model":"chat""#), "{json}");
        assert_eq!(
            super::read_limits(Path::new("/nonexistent/x")),
            super::SubagentLimits::default()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_clis_own_limits_go_out_as_environment() {
        let l = super::SubagentLimits {
            concurrent: 4,
            depth: 2,
            ..Default::default()
        };
        assert_eq!(
            l.env(),
            vec![
                ("CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS", "4".to_string()),
                ("CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH", "2".to_string()),
            ]
        );
    }

    #[test]
    fn the_window_slows_then_stops_with_the_reset_time_in_the_reason() {
        let l = super::SubagentLimits::default();
        let r = |pct| {
            Some(super::WindowReading {
                five_hour_pct: pct,
                resets_at: Some(1789714200),
                sampled_at_ms: 1,
            })
        };
        assert_eq!(super::window_verdict(&l, None), Ok(6));
        assert_eq!(super::window_verdict(&l, r(69)), Ok(6));
        // His numbers (blocker 271): to 4 at 70, stop at 85.
        assert_eq!(super::window_verdict(&l, r(70)), Ok(4));
        assert_eq!(super::window_verdict(&l, r(84)), Ok(4));
        let stop = super::window_verdict(&l, r(85)).unwrap_err();
        assert!(
            stop.contains("85%") && stop.contains("It resets at ") && stop.contains("do not retry")
        );
        let none = super::window_verdict(
            &l,
            Some(super::WindowReading {
                five_hour_pct: 95,
                resets_at: None,
                sampled_at_ms: 1,
            }),
        )
        .unwrap_err();
        assert!(none.contains("when the window resets"));
        // The fresher reading wins, whichever side it came from.
        let wire = super::WindowReading {
            five_hour_pct: 10,
            resets_at: None,
            sampled_at_ms: 5,
        };
        let gauge = super::WindowReading {
            five_hour_pct: 80,
            resets_at: None,
            sampled_at_ms: 9,
        };
        assert_eq!(super::freshest(Some(wire), Some(gauge)), Some(gauge));
        assert_eq!(super::freshest(Some(wire), None), Some(wire));
        assert_eq!(super::freshest(None, None), None);
        // A reading whose window has reset, or one older than a window, is no reading.
        let now = 10_000_000_000i64;
        let past = super::WindowReading {
            five_hour_pct: 92,
            resets_at: Some(now / 1000 - 1),
            sampled_at_ms: now - 1,
        };
        assert_eq!(super::current(Some(past), now), None);
        let old = super::WindowReading {
            five_hour_pct: 92,
            resets_at: None,
            sampled_at_ms: now - 6 * 3600 * 1000,
        };
        assert_eq!(super::current(Some(old), now), None);
        let fresh = super::WindowReading {
            five_hour_pct: 92,
            resets_at: None,
            sampled_at_ms: now - 1000,
        };
        assert_eq!(super::current(Some(fresh), now), Some(fresh));
    }

    #[test]
    fn at_a_simulated_92_percent_window_the_spawn_is_refused_and_at_75_the_turn_holds_four() {
        let dir = limits_dir("window");
        let now = chrono::Utc::now().timestamp_millis();
        super::write_usage(&dir, 92, Some(now / 1000 + 3600), now);
        let r = super::decide_with(&dir, CALL, None);
        assert_eq!(r.decision(), "deny");
        assert!(
            r.reason()
                .is_some_and(|s| s.contains("92%") && s.contains("It resets at "))
        );
        // The gauge, fresher, says 75: the cap is four (blocker 271, his
        // number), and the fifth is refused in those words.
        let gauge = Some(super::WindowReading {
            five_hour_pct: 75,
            resets_at: None,
            sampled_at_ms: now + 1,
        });
        for _ in 0..4 {
            assert_eq!(super::decide_with(&dir, CALL, gauge).decision(), "allow");
        }
        let third = super::decide_with(&dir, CALL, gauge);
        assert_eq!(third.decision(), "deny");
        assert!(
            third
                .reason()
                .is_some_and(|s| s.contains("75%") && s.contains("lowered"))
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_chats_daily_count_runs_across_turns_and_restarts_with_the_date() {
        let dir = limits_dir("day");
        super::write_limits(
            &dir,
            &super::SubagentLimits {
                per_day: 3,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(super::decide_with(&dir, CALL, None).decision(), "allow");
        assert_eq!(super::decide_with(&dir, CALL, None).decision(), "allow");
        super::reset_spawns(&dir); // a new turn: the day's count stands
        assert_eq!(super::decide_with(&dir, CALL, None).decision(), "allow");
        let r = super::decide_with(&dir, CALL, None);
        assert_eq!(r.decision(), "deny");
        assert!(r.reason().is_some_and(|s| s.contains("in this chat today")));
        // Another date in the file: the count restarts.
        std::fs::write(dir.join(super::DAY_SPAWNS_FILE), "2000-01-01 3").unwrap();
        super::reset_spawns(&dir);
        assert_eq!(super::decide_with(&dir, CALL, None).decision(), "allow");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
