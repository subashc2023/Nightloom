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

/// The hook's matcher: the tool's current name and its older one.
pub const BRIEF_MATCHER: &str = "Agent|Task";

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
}

fn d_per_turn() -> usize {
    SPAWN_CAP
}
fn d_concurrent() -> usize {
    20
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
    // Fresh through print-mode `/usage` when the files are over a minute
    // old (blocker 264, his yes 2026-09-18): a fan-out's first hook pays
    // ~12 s, the rest of the burst reuse it (one refresh a minute).
    let u = crate::plan_usage::read_fresh(std::time::Duration::from_secs(60));
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
        "hooks": [{ "type": "command", "command": words.join(" ") }]
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
    tool_input: Value,
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
    decide_with(dir, stdin_json, gauge_reading())
}

/// [`decide`] with the desktop's gauge reading passed in, so the suite
/// runs against a fixed window rather than this machine's files.
pub fn decide_with(dir: &Path, stdin_json: &str, gauge: Option<WindowReading>) -> HookReply {
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
    let cap = match window_verdict(&limits, reading) {
        Ok(cap) => cap,
        Err(reason) => return HookReply::deny(reason),
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
    let brief = std::fs::read_to_string(dir.join(BRIEF_FILE)).unwrap_or_default();
    if brief.trim().is_empty() {
        return HookReply::pass();
    }
    let Value::Object(mut fields) = input.tool_input else {
        return HookReply::pass();
    };
    let Some(Value::String(prompt)) = fields.get("prompt") else {
        return HookReply::pass();
    };
    if prompt.trim_start().starts_with(BRIEF_OPEN) {
        return HookReply::pass();
    }
    let briefed = format!("{}\n\n{prompt}", brief.trim_end());
    fields.insert("prompt".into(), Value::String(briefed));
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
        assert_eq!(json!(BRIEF_MATCHER), "Agent|Task");
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
        assert_eq!(back.concurrent, 20);
        assert_eq!(back.depth, 3);
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
