//! The cap a message works under, declared by the model (nightshift item
//! 538, 2026-11-10; the design is `539-report-2026-11-10.md` §4, his answer
//! to blocker 1784: "that's perfect").
//!
//! The main model calls Nightloom's `set_budget` tool when his message
//! states a cap ("use up to 50%") or the task is big enough to need one.
//! The cap goes into the turn's ledger ([`TurnBudget::cap`], and
//! `stop_at` with it) with one of two modes:
//!
//! - **finish within the cap** (mode A): trim the work to fit. Helpers are
//!   told their share, launches that would not fit are refused, and near
//!   the cap the main agent tells its helpers to finish with what they have.
//! - **work to the cap, then continue after the reset** (mode B, the
//!   default — blocker 1785): the same work, spread over windows. Helpers
//!   are **never shown a usage figure**; no launch is refused; near the cap
//!   Nightloom wakes the main agent, which sends its helpers the wrap-up,
//!   saves state and ends with a `<continue-later at="reset">` line.
//!
//! **Nightloom holds the cap and wakes the agent.** Every hook call of
//! every process in the turn brings a reading; [`due_wakes`] says which
//! thresholds it newly crosses — each fires once per turn. A wake found on
//! the main thread's own call rides that call as `additionalContext`; one
//! found on a helper's call waits in the ledger ([`TurnBudget::wakes_pending`])
//! for the turn's drive loop, which writes it to the main thread's stdin
//! when it sits idle with helpers running (the case 539 found missing), or
//! for the main thread's next call, whichever comes first.
//!
//! Past the cap (or his *Wrap up*, or any stop line) a helper's calls are
//! no longer refused at once: its next [`WRAP_CALLS`] calls run with the
//! wrap-up beside them, so it can make its files coherent and write a
//! state file, and only then are refused (539 pieces 4 and 5 — the refusal
//! was what lost work).
//!
//! The "up to N%" pattern in his message ([`cap_from_message`]) is only a
//! backstop for a model that does not call the tool: it is written at the
//! turn's start with source `message`, and the model's call replaces it.
//! His own correction from the window ([`correct`], the cap chip) is
//! source `user` and holds for the rest of the message.

use super::brief::{self, TurnBudget, WindowReading};
use nightloom_core::ToolDef;
use nightloom_core::tool::{CancellationToken, Effect, Tool};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// The tool's name on Nightloom's MCP server (`mcp__nightloom__set_budget`).
pub const TOOL_NAME: &str = "set_budget";

/// How far below the cap the main agent is woken, in window points (539
/// piece 2: seven Fable helpers spent ~25 points in 90 s, and a reading
/// can be two minutes old).
pub const WAKE_MARGIN: u8 = 5;

/// Mode B: the main agent is also woken each time the message has spent
/// this many more points while its helpers run, so it can pace.
pub const PACE_STEP: u8 = 10;

/// With no cap at all: the wake when helpers run this close to the plan's
/// own stop, so they can save before it cuts them off (539 piece 6).
pub const HARD_WAKE_PCT: u8 = 96;

/// How many calls of a process run with the wrap-up beside them before its
/// calls are refused (539 piece 4, "~10").
pub const WRAP_CALLS: u8 = 10;

/// What a helper is told to do at a wrap-up — never a usage figure.
pub const WRAP_UP_HELPER: &str = "Stop starting new work. Finish or undo the edit you are in so \
     every file is coherent; write what you found, what is done and exactly what is left to a \
     state file (notes/<task>-state.md, or beside your report); then report, naming that file.";

/// What a helper is told in mode A, where the work is trimmed to fit.
pub const FINISH_NOW_HELPER: &str = "Finish now with what you have: make every file coherent, \
     skip what is left, and report what works and what you skipped.";

/// The two ways a cap is worked under (blocker 1785).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetMode {
    /// Mode A: trim the work to fit the cap.
    FinishWithin,
    /// Mode B: do it all; save state at the cap and carry on after the reset.
    WorkToCapThenContinue,
}

impl BudgetMode {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "finish_within" => Some(Self::FinishWithin),
            "work_to_cap_then_continue" => Some(Self::WorkToCapThenContinue),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::FinishWithin => "finish_within",
            Self::WorkToCapThenContinue => "work_to_cap_then_continue",
        }
    }

    /// The mode in words, for the model and the usage line.
    pub fn words(self) -> &'static str {
        match self {
            Self::FinishWithin => "finish within the cap",
            Self::WorkToCapThenContinue => "work to the cap, then continue after the reset",
        }
    }
}

/// The cap in force for this message, as the ledger holds it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cap {
    /// Percent of the plan's five-hour window: the turn's `stop_at`.
    pub percent: u8,
    pub mode: BudgetMode,
    /// Who set it: `model` (the `set_budget` tool), `message` (the pattern
    /// in his words, the backstop), `user` (his correction in the window).
    pub source: String,
    /// The model's one-line reason, or his words the pattern matched.
    #[serde(default)]
    pub reason: String,
    pub set_at_ms: i64,
}

/// One launch's expected cost, held against the cap until the reading
/// catches up (537's fix 1).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reservation {
    pub points: u8,
    /// The window when it launched; `None` when no reading was on hand.
    #[serde(default)]
    pub at_pct: Option<u8>,
    /// When it was taken (wall clock, ms): the drive loop keeps a fresh one
    /// while the helper's `task_started` is still on its way (review
    /// 2026-11-10), so a burst of launches each sees the ones before it.
    #[serde(default)]
    pub at_ms: i64,
}

/// How long a reservation is kept with no helper seen running: the gap
/// between the hook passing a launch and the CLI reporting it started.
pub const RESERVE_GRACE_MS: i64 = 20_000;

/// Which threshold a wake is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WakeKind {
    /// The helpers running are expected to carry the window to the cap's
    /// margin, though the reading is not there yet: launch no more.
    Reserved,
    /// The reading is within [`WAKE_MARGIN`] of the cap: wrap up.
    Near,
    /// The reading is at the cap.
    AtCap,
    /// Mode B: another [`PACE_STEP`] points spent while helpers run.
    Pace,
    /// No cap: [`HARD_WAKE_PCT`] with helpers running.
    Hard,
}

impl WakeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Reserved => "reserved",
            Self::Near => "near",
            Self::AtCap => "at_cap",
            Self::Pace => "pace",
            Self::Hard => "hard",
        }
    }

    /// Whether the wake only means something while helpers run.
    fn needs_helpers(self) -> bool {
        matches!(self, Self::Pace | Self::Hard)
    }

    fn rank(self) -> u8 {
        match self {
            Self::Pace => 0,
            Self::Reserved => 1,
            Self::Near => 2,
            Self::Hard => 3,
            Self::AtCap => 4,
        }
    }
}

/// One wake, with the figures it was found at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Wake {
    pub kind: WakeKind,
    /// The five-hour reading it fired at.
    pub pct: u8,
    #[serde(default)]
    pub cap: Option<u8>,
    #[serde(default)]
    pub mode: Option<BudgetMode>,
    /// Points still reserved for running helpers at that moment.
    #[serde(default)]
    pub reserved: u8,
    /// Points this message had spent.
    #[serde(default)]
    pub spent: u8,
    pub at_ms: i64,
}

// ---- the reservation (537 fix 1; refusals in mode A only) -------------------

/// What one helper is expected to cost, in window points, by the model it
/// runs on (537's starting figures: Fable 6, Opus 3).
pub fn points_for(alias: Option<&str>) -> u8 {
    match alias.map(str::to_ascii_lowercase).as_deref() {
        Some(m) if m.contains("fable") => 6,
        Some(m) if m.contains("sonnet") => 2,
        Some(m) if m.contains("haiku") => 1,
        _ => 3,
    }
}

/// The points still held for running helpers at reading `pct`: every
/// launch's estimate, less what the window has risen since the first of
/// them (`reserved = max(0, Σ estimates − (reading − start))`).
pub fn outstanding(b: &TurnBudget, pct: u8) -> u8 {
    let total: u32 = b.reserved.iter().map(|r| r.points as u32).sum();
    let Some(first) = b.reserved.iter().filter_map(|r| r.at_pct).min() else {
        return total.min(100) as u8;
    };
    total
        .saturating_sub(pct.saturating_sub(first) as u32)
        .min(100) as u8
}

/// The refusal of a launch that does not fit under a mode-A cap.
pub fn reservation_reason(pct: u8, held: u8, points: u8, cap: u8) -> String {
    format!(
        "Nightloom refuses this launch: the 5-hour window is at {pct}%, the helpers already \
         running are expected to use about {held} more points and this one about {points}, \
         which reaches this message's cap of {cap}% (finish within the cap). Launch fewer: \
         wait for the running ones and measure, or do this piece yourself. If the work must \
         all be done, call set_budget with mode work_to_cap_then_continue instead."
    )
}

/// Take a launch's reservation, pure: under a mode-A cap a launch whose
/// expected cost would reach the cap is refused and nothing is held; in
/// mode B, or with no cap, it is always held (the reservation then only
/// moves the wake earlier). No reading: held, nothing to judge by.
pub fn claim_reservation(
    b: &mut TurnBudget,
    reading: Option<WindowReading>,
    points: u8,
) -> Result<(), String> {
    let pct = reading.map(|r| r.five_hour_pct);
    if let (Some(cap), Some(pct)) = (&b.cap, pct)
        && cap.mode == BudgetMode::FinishWithin
    {
        let held = outstanding(b, pct);
        if pct as u32 + held as u32 + points as u32 >= cap.percent as u32 {
            return Err(reservation_reason(pct, held, points, cap.percent));
        }
    }
    b.reserved.push(Reservation {
        points,
        at_pct: pct,
        at_ms: chrono::Utc::now().timestamp_millis(),
    });
    Ok(())
}

/// Give back a reservation whose launch was refused further on (the
/// turn's or the day's count).
pub fn release_reservation(b: &mut TurnBudget, points: u8) {
    if let Some(i) = b.reserved.iter().rposition(|r| r.points == points) {
        b.reserved.remove(i);
    }
}

// ---- the wakes ---------------------------------------------------------------

fn fire(b: &mut TurnBudget, key: &str) -> bool {
    if b.wakes_fired.iter().any(|k| k == key) {
        return false;
    }
    b.wakes_fired.push(key.to_string());
    true
}

/// The thresholds this reading newly crosses, pure: each is recorded in
/// the ledger as fired, so it is returned once per turn (and again only
/// after the cap itself is changed, [`set_cap`]). With a cap: `Reserved`,
/// `Near` (cap − [`WAKE_MARGIN`]), `AtCap`, and in mode B one `Pace` per
/// [`PACE_STEP`] points this message has spent. With none: `Hard` at
/// [`HARD_WAKE_PCT`]. A higher threshold marks the lower ones fired too.
pub fn due_wakes(b: &mut TurnBudget, reading: Option<WindowReading>, now_ms: i64) -> Vec<Wake> {
    let Some(r) = reading else {
        return Vec::new();
    };
    let pct = r.five_hour_pct;
    let spent = b.start_pct.map_or(0, |s| pct.saturating_sub(s));
    let held = outstanding(b, pct);
    let cap = b.cap.clone();
    let wake = |kind: WakeKind| Wake {
        kind,
        pct,
        cap: cap.as_ref().map(|c| c.percent),
        mode: cap.as_ref().map(|c| c.mode),
        reserved: held,
        spent,
        at_ms: now_ms,
    };
    let mut out = Vec::new();
    let Some(c) = &cap else {
        if pct >= HARD_WAKE_PCT && fire(b, "hard") {
            out.push(wake(WakeKind::Hard));
        }
        return out;
    };
    let near = c.percent.saturating_sub(WAKE_MARGIN);
    if pct >= c.percent {
        let new = fire(b, "cap");
        fire(b, "near");
        fire(b, "reserved");
        if new {
            out.push(wake(WakeKind::AtCap));
        }
    } else if pct >= near {
        let new = fire(b, "near");
        fire(b, "reserved");
        if new {
            out.push(wake(WakeKind::Near));
        }
    } else if held > 0 && pct as u32 + held as u32 >= near as u32 && fire(b, "reserved") {
        out.push(wake(WakeKind::Reserved));
    }
    if c.mode == BudgetMode::WorkToCapThenContinue && pct < near {
        let step = spent / PACE_STEP;
        if step >= 1 {
            let mut new = false;
            for n in 1..=step {
                new |= fire(b, &format!("pace-{n}"));
            }
            if new {
                out.push(wake(WakeKind::Pace));
            }
        }
    }
    out
}

fn helper_list(helpers: Option<&[(String, String)]>) -> String {
    match helpers {
        Some(h) if !h.is_empty() => format!(
            "Helpers running: {}.",
            h.iter()
                .map(|(id, what)| format!("`{id}` (\"{what}\")"))
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Some(_) => "No helper is running.".to_string(),
        None => "Your helpers still running are the ones to tell.".to_string(),
    }
}

/// The line the main agent reads for the wakes on hand — the strongest of
/// them, in Nightloom's words and saying so. `helpers` are the running
/// ones by agent id and description when the writer knows them (the drive
/// loop does; the hook does not).
pub fn wake_text(wakes: &[Wake], helpers: Option<&[(String, String)]>) -> Option<String> {
    let w = wakes.iter().max_by_key(|w| (w.kind.rank(), w.at_ms))?;
    let list = helper_list(helpers);
    let cap = w.cap.unwrap_or(100);
    let mode = w.mode.unwrap_or(BudgetMode::WorkToCapThenContinue);
    let wrap = |lead: &str| match mode {
        BudgetMode::WorkToCapThenContinue => format!(
            "{lead} Start nothing new. {list} Send each one this with SendMessage, with no \
             usage figure in it: \"{WRAP_UP_HELPER}\" When they have reported, save your own \
             state to a file and end your reply with a line of its own, <continue-later \
             at=\"reset\">…</continue-later>, naming the state files to continue from; \
             Nightloom sends it to you after the reset and you re-launch what is unfinished."
        ),
        BudgetMode::FinishWithin => format!(
            "{lead} Start nothing new. {list} Send each one this with SendMessage: \
             \"{FINISH_NOW_HELPER}\" Then write up the result from what you have and say \
             what was skipped."
        ),
    };
    let body = match w.kind {
        WakeKind::Reserved => format!(
            "usage is at {}% of the 5-hour window and the helpers running are expected to use \
             about {} more points, which reaches this message's cap of {cap}% ({}). {list} \
             Launch no more helpers in this window; Nightloom wakes you again near the cap.",
            w.pct,
            w.reserved,
            mode.words()
        ),
        WakeKind::Near => wrap(&format!(
            "usage is at {}% of the 5-hour window; this message's cap is {cap}% ({}).",
            w.pct,
            mode.words()
        )),
        WakeKind::AtCap => format!(
            "{} Nightloom is giving each helper the same wrap-up itself now, and refuses a \
             helper's calls after about {WRAP_CALLS} more.",
            wrap(&format!(
                "usage has reached this message's cap: {}% of the 5-hour window (cap {cap}%, {}).",
                w.pct,
                mode.words()
            ))
        ),
        WakeKind::Pace => format!(
            "usage is at {}% of the 5-hour window; this message has spent {} points and its \
             cap is {cap}% ({}). {list} Nothing to do yet unless you want to re-plan; do not \
             pass usage figures to helpers. Nightloom wakes you again near the cap.",
            w.pct,
            w.spent,
            mode.words()
        ),
        WakeKind::Hard => format!(
            "usage is at {}% of the 5-hour window, and the plan stops everything at 100%. \
             {list} Send each one this with SendMessage now, so it saves before the limit \
             cuts it off: \"{WRAP_UP_HELPER}\" Then save your own state; a turn the limit \
             cuts off is resumed by Nightloom after the reset.",
            w.pct
        ),
    };
    Some(format!("[Nightloom, not from Swaraag: {body}]"))
}

/// The hook's half, pure: the wakes for this call. The newly due ones are
/// found and recorded; on the main thread's own call (`main`) every wake
/// waiting — new or left by a helper's call — is taken to ride this call,
/// less the kinds that only matter to an idle main thread; on a helper's
/// call the new ones are left in the ledger for the drive loop.
pub fn wakes_for_call(
    b: &mut TurnBudget,
    reading: Option<WindowReading>,
    main: bool,
    now_ms: i64,
) -> Vec<Wake> {
    let new = due_wakes(b, reading, now_ms);
    b.wakes_pending.extend(new);
    if !main {
        return Vec::new();
    }
    let helpers = !b.reserved.is_empty();
    std::mem::take(&mut b.wakes_pending)
        .into_iter()
        .filter(|w| match w.kind {
            WakeKind::Pace => false,
            WakeKind::Hard => helpers,
            _ => true,
        })
        .collect()
}

/// The drive loop's half: look at the ledger under its lock. With no
/// helper running the reservations are dropped. The reading on hand is
/// judged like a hook's (so a stretch with no hook call still wakes). When
/// the main thread can take a line now (`deliver`), the waiting wakes are
/// taken and returned — less the helper-only kinds when none runs.
pub fn take_wakes(dir: &Path, now_ms: i64, running: bool, deliver: bool) -> Vec<Wake> {
    if dir.as_os_str().is_empty() {
        return Vec::new();
    }
    let reading = brief::reading_on_hand(dir, now_ms);
    brief::with_ledger(dir, |b| {
        // With no helper running the holds go — but not one just taken,
        // whose helper the CLI has not reported started yet (review
        // 2026-11-10: a 2 s look between two launches of one burst dropped
        // the first's hold, so the second was judged without it).
        if !running {
            b.reserved
                .retain(|r| now_ms.saturating_sub(r.at_ms) < RESERVE_GRACE_MS);
        }
        if let Some(r) = reading
            && b.latest_at_ms.is_none_or(|t| r.sampled_at_ms >= t)
        {
            let new = due_wakes(b, Some(r), now_ms);
            b.wakes_pending.extend(new);
        }
        if !deliver {
            return Vec::new();
        }
        std::mem::take(&mut b.wakes_pending)
            .into_iter()
            .filter(|w| running || !w.kind.needs_helpers())
            .collect()
    })
    .unwrap_or_default()
}

/// Wakes the drive loop took and could not write after all: back in the
/// ledger for the next look.
pub fn put_back(dir: &Path, wakes: Vec<Wake>) {
    if wakes.is_empty() {
        return;
    }
    brief::with_ledger(dir, |b| {
        let mut all = wakes;
        all.append(&mut b.wakes_pending);
        b.wakes_pending = all;
    });
}

// ---- the wrap-up's grace (539 pieces 4 and 5) --------------------------------

/// Whether helpers are kept from every usage figure under this ledger:
/// mode B (539's table: "Nothing. … they work as if unlimited").
pub fn hides_usage(b: &TurnBudget) -> bool {
    b.cap
        .as_ref()
        .is_some_and(|c| c.mode == BudgetMode::WorkToCapThenContinue)
}

/// How many more calls of `who` run under a wrap-up before they are refused.
pub fn wrap_left(b: &TurnBudget, who: &str) -> u8 {
    WRAP_CALLS.saturating_sub(b.wrap_calls.get(who).copied().unwrap_or(0))
}

/// What a helper reads beside a call that runs under a wrap-up. No usage
/// figure, in any mode: "the chat you report to is wrapping up".
pub fn helper_wrap_note(left: u8, pressed: bool) -> String {
    let why = if pressed {
        " (Swaraag pressed Wrap up)"
    } else {
        ""
    };
    format!(
        "[Nightloom, not from Swaraag: the chat you report to is wrapping up{why}. \
         {WRAP_UP_HELPER} About {left} more of your tool calls will run; after that they are \
         refused.]"
    )
}

/// The refusal once a helper's grace is used up, with no usage figure.
pub fn helper_wrapped_reason() -> String {
    "Not run: the chat you report to has wrapped up, and your calls for saving your work are \
     used. Stop now and report what you have, naming the state file if you wrote one."
        .into()
}

/// The refusal of a helper's own launch where its reason would carry a
/// usage figure (mode B).
pub fn helper_launch_reason() -> String {
    "Not run: the chat you report to is starting no new subagents now. Do this piece yourself, \
     or report it as left."
        .into()
}

/// What the chat's own thread reads beside a call that runs past its
/// declared cap: the same grace, so it can save state rather than be cut.
pub fn main_at_cap_note(b: &TurnBudget, pct: u8, left: u8) -> String {
    let (cap, mode) = b
        .cap
        .as_ref()
        .map_or((b.stop_at, BudgetMode::WorkToCapThenContinue), |c| {
            (c.percent, c.mode)
        });
    let then = match mode {
        BudgetMode::WorkToCapThenContinue => {
            "save your state to a file and end your reply with a <continue-later at=\"reset\"> \
             line naming it"
        }
        BudgetMode::FinishWithin => {
            "write up the result from what you have and say what was skipped"
        }
    };
    format!(
        "[Nightloom, not from Swaraag: usage is at {pct}% of the 5-hour window, past this \
         message's cap of {cap}% ({}). Start nothing new and launch no helpers; {then}. About \
         {left} more of your tool calls will run before Nightloom stops them at the cap.]",
        mode.words()
    )
}

/// The line a mode-A helper's task opens with: its share (539's table).
pub fn share_line(points: u8) -> String {
    format!(
        "Budget: about {points} points of the plan's 5-hour usage window for this task. \
         Deliver a working result inside it; skip what does not fit and say what you skipped."
    )
}

/// `brief` without its `<pacing>` section: what a mode-B helper is
/// briefed with, so nothing in front of its task speaks of a budget.
pub fn without_pacing(brief: &str) -> String {
    let (Some(a), Some(z)) = (brief.find("<pacing>"), brief.find("</pacing>")) else {
        return brief.to_string();
    };
    if z < a {
        return brief.to_string();
    }
    let head = brief[..a].trim_end_matches([' ', '\n']);
    let tail = brief[z + "</pacing>".len()..].trim_start_matches([' ', '\n']);
    match (head.is_empty(), tail.is_empty()) {
        (true, _) => tail.to_string(),
        (_, true) => head.to_string(),
        _ => format!("{head}\n\n{tail}"),
    }
}

// ---- setting the cap ---------------------------------------------------------

/// Put a cap into the ledger, pure: the turn's stop line becomes the cap,
/// the per-message share stops binding (his cap for this message is this
/// message's budget), and the cap's thresholds and any wrap-up grace start
/// over, since they were for the old cap.
pub fn set_cap(
    b: &mut TurnBudget,
    percent: u8,
    mode: BudgetMode,
    source: &str,
    reason: &str,
    now_ms: i64,
) {
    let percent = percent.clamp(1, 100);
    let moved = b.cap.as_ref().is_none_or(|c| c.percent != percent);
    b.cap = Some(Cap {
        percent,
        mode,
        source: source.to_string(),
        reason: reason.trim().chars().take(300).collect(),
        set_at_ms: now_ms,
    });
    b.stop_at = percent;
    b.budget_pct = 0;
    if moved {
        b.wakes_fired
            .retain(|k| !matches!(k.as_str(), "cap" | "near" | "reserved" | "hard"));
        b.wakes_pending.retain(|w| matches!(w.kind, WakeKind::Pace));
        b.wrap_calls.clear();
        b.stopped = None;
    }
}

/// Take the cap out of the ledger: the stop line and the per-message
/// share go back to the chat's own limits.
fn clear_cap(b: &mut TurnBudget, limits: &brief::SubagentLimits) {
    let l = limits.effective();
    b.cap = None;
    b.stop_at = l.stop_at;
    b.budget_pct = l.budget_pct;
    b.wakes_fired
        .retain(|k| !matches!(k.as_str(), "cap" | "near" | "reserved"));
    b.wakes_pending.clear();
    b.wrap_calls.clear();
    b.stopped = None;
}

/// The model's `set_budget` call: the cap into the turn's ledger, and what
/// was set, in words it can act on. A cap he corrected in the window this
/// message is kept, and the reply says so. An error when no turn's ledger
/// is there to hold it.
pub fn declare(
    dir: &Path,
    percent: u8,
    mode: BudgetMode,
    reason: &str,
    now_ms: i64,
) -> Result<String, String> {
    brief::with_ledger(dir, |b| {
        if b.cap_locked {
            return match &b.cap {
                Some(c) => format!(
                    "Kept as Swaraag set it in the window for this message: cap {}% of the \
                     5-hour window, mode {} ({}). Your call changed nothing.",
                    c.percent,
                    c.mode.as_str(),
                    c.mode.words()
                ),
                None => "Kept as Swaraag set it in the window for this message: no cap. Your \
                         call changed nothing."
                    .to_string(),
            };
        }
        set_cap(b, percent, mode, "model", reason, now_ms);
        set_words(b)
    })
    .ok_or_else(|| {
        "no message of this chat is running under a budget ledger, so there is nothing to \
         hold a cap; carry on without one"
            .to_string()
    })
}

/// What a `set_budget` call returns: the cap as it now stands and what
/// Nightloom will do with it.
fn set_words(b: &TurnBudget) -> String {
    let Some(c) = &b.cap else {
        return "No cap is set.".into();
    };
    let now = match b.latest_pct {
        Some(p) => format!(" Usage now: {p}% of the 5-hour window."),
        None => String::new(),
    };
    let near = c.percent.saturating_sub(WAKE_MARGIN);
    let rest = match c.mode {
        BudgetMode::WorkToCapThenContinue => format!(
            "Nightloom wakes you at about {near}% (earlier if your running helpers are expected \
             to reach it, and at each {PACE_STEP} points spent while they run). Plan the whole \
             job, not a trimmed one. Helpers are shown no usage figure: put none in their \
             briefs or messages. At the wake, send each helper the wrap-up it gives you, save \
             state, and end with a <continue-later at=\"reset\"> line; no launch is refused \
             for the cap."
        ),
        BudgetMode::FinishWithin => format!(
            "Nightloom wakes you at about {near}%. Size the work to fit: a launch whose \
             expected cost (Fable about 6 points, Opus about 3) would reach the cap is \
             refused, and each helper is told its share. At the wake, have helpers finish \
             with what they have and write up the result."
        ),
    };
    let past = match b.latest_pct {
        Some(p) if p >= c.percent => " Usage is already at or past this cap: wrap up now.",
        _ => "",
    };
    format!(
        "Set: cap {}% of the 5-hour window, mode {} ({}).{now}{past} {rest} The cap chip above \
         the message box shows this; Swaraag can correct it there. Call set_budget again to \
         change it.",
        c.percent,
        c.mode.as_str(),
        c.mode.words()
    )
}

/// His correction from the window (the cap chip): a new cap, a new mode,
/// or — `percent` `None` with a cap in force and no `mode` — no cap at
/// all. Holds for the rest of the message against the model's own calls.
/// Returns the ledger as it now stands; an error when there is none, or
/// when a mode is given with no cap to apply it to.
pub fn correct(
    dir: &Path,
    percent: Option<u8>,
    mode: Option<BudgetMode>,
    now_ms: i64,
) -> Result<TurnBudget, String> {
    let limits = brief::read_limits(dir);
    brief::with_ledger(dir, |b| {
        match (percent, mode, b.cap.clone()) {
            (Some(p), m, have) => {
                let mode = m
                    .or(have.as_ref().map(|c| c.mode))
                    .unwrap_or(BudgetMode::WorkToCapThenContinue);
                let reason = have.map(|c| c.reason).unwrap_or_default();
                set_cap(b, p, mode, "user", &reason, now_ms);
            }
            (None, Some(m), Some(have)) => {
                set_cap(b, have.percent, m, "user", &have.reason, now_ms);
            }
            (None, Some(_), None) => {
                return Err("there is no cap on this message to change the mode of".to_string());
            }
            (None, None, _) => clear_cap(b, &limits),
        }
        b.cap_locked = true;
        Ok(b.clone())
    })
    .ok_or_else(|| "no budget ledger for this chat".to_string())?
}

// ---- the backstop: a cap stated in his message (539 piece 1) -----------------

/// A cap his message states, and the mode its words pick (blocker 1785's
/// default): "use up to 50%", "stop at 50%", "no more than 50%" → work to
/// the cap, then continue; "within 50%", "finish in 50%", or a message
/// that says "urgent" or "just get it working" → finish within the cap.
/// Lines inside a code fence and quoted lines (`>`) are not his ask. Only
/// a backstop: the model's `set_budget` call replaces it.
pub fn cap_from_message(text: &str) -> Option<(u8, BudgetMode)> {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(
            r"(?i)\b(up to|stop at|stop once (?:it|usage|you) (?:hits?|reach(?:es)?|is at)|cap(?:ped)?(?: it)? (?:at|of)|within|finish in|no more than|at most|until|till)\s+(?:about\s+|around\s+|~\s*)?(\d{1,3})\s*(?:%|percent)",
        )
        .expect("the cap pattern compiles")
    });
    let mut fenced = false;
    let mut own = String::new();
    for line in text.lines() {
        let t = line.trim_start();
        if t.starts_with("```") {
            fenced = !fenced;
            continue;
        }
        if fenced || t.starts_with('>') {
            continue;
        }
        own.push_str(line);
        own.push('\n');
    }
    // A percent of something other than the plan's usage is not a cap
    // ("within 2% of the baseline", "up to 30% faster", "at most 5% error";
    // review 2026-11-10): "of …" must name the usage, and a measure word
    // right after the figure rules it out.
    let about_usage = |after: &str| {
        let after = after.trim_start().to_ascii_lowercase();
        let first = after
            .split(|ch: char| !ch.is_ascii_alphanumeric() && ch != '-')
            .find(|w| !w.is_empty())
            .unwrap_or("");
        const MEASURES: &[&str] = &[
            "faster",
            "slower",
            "more",
            "less",
            "fewer",
            "off",
            "error",
            "errors",
            "accuracy",
            "better",
            "worse",
            "bigger",
            "smaller",
            "larger",
            "longer",
            "shorter",
            "cheaper",
            "zoom",
            "opacity",
            "width",
            "height",
            "coverage",
            "loss",
            "increase",
            "decrease",
            "growth",
            "margin",
            "discount",
            "chance",
            "probability",
        ];
        if MEASURES.contains(&first) {
            return false;
        }
        if first != "of" {
            return true;
        }
        // The words "of" governs: up to the clause's end, a few words long.
        let rest: String = after
            .chars()
            .take_while(|ch| !matches!(ch, '.' | ';' | ',' | '!' | '?' | '\n' | '%'))
            .take(32)
            .collect();
        [
            "5h",
            "5-h",
            "5 h",
            "five",
            "hour",
            "limit",
            "usage",
            "window",
            "plan",
            "budget",
            "quota",
            "token",
            "week",
            "my max",
            "the max",
            "max plan",
            "allowance",
            "session",
        ]
        .iter()
        .any(|w| rest.contains(w))
    };
    let c = re
        .captures_iter(&own)
        .find(|c| c.get(0).is_some_and(|m| about_usage(&own[m.end()..])))?;
    let percent: u8 = c
        .get(2)?
        .as_str()
        .parse()
        .ok()
        .filter(|p| (1..=100).contains(p))?;
    let phrase = c.get(1)?.as_str().to_ascii_lowercase();
    let lower = own.to_ascii_lowercase();
    let urgent = lower.contains("urgent") || lower.contains("just get it working");
    let mode = if urgent || phrase == "within" || phrase == "finish in" {
        BudgetMode::FinishWithin
    } else {
        BudgetMode::WorkToCapThenContinue
    };
    Some((percent, mode))
}

/// At a turn's start: the cap his message states, into the fresh ledger
/// with source `message`. Nothing when the message states none.
pub fn declare_from_message(dir: &Path, text: &str, now_ms: i64) {
    if dir.as_os_str().is_empty() {
        return;
    }
    let Some((percent, mode)) = cap_from_message(text) else {
        return;
    };
    brief::with_ledger(dir, |b| {
        if b.cap.is_none() {
            set_cap(b, percent, mode, "message", "stated in the message", now_ms);
        }
    });
}

// ---- the MCP tool ------------------------------------------------------------

/// `set_budget`, served to a chat whose turn has a ledger (`--budget-dir`).
pub struct SetBudget {
    dir: PathBuf,
}

impl SetBudget {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }
}

#[async_trait::async_trait]
impl Tool for SetBudget {
    fn effect(&self) -> Effect {
        Effect::Session
    }

    fn def(&self) -> ToolDef {
        ToolDef {
            name: TOOL_NAME.into(),
            description: "Declare the usage cap this message works under, as a percent of the \
                 plan's 5-hour window, and how to work under it. Call it when the user's \
                 message states a cap (\"use up to 50%\") or the task is big enough to need \
                 one, before launching helpers. Mode work_to_cap_then_continue (the default \
                 for any cap the user states): do the whole job; near the cap Nightloom wakes \
                 you, you have helpers save state, and the work continues after the reset. \
                 Mode finish_within (only when the user says within, urgent, or just get it \
                 working): trim the work to fit. Nightloom holds the cap, shows it above the \
                 message box for the user to correct, and wakes you near it. Call again to \
                 change it. The main chat only, never a subagent."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "cap_percent": {
                        "type": "number",
                        "minimum": 1,
                        "maximum": 100,
                        "description": "The cap, as a percent of the plan's 5-hour usage window (the figure the usage line calls 5-hour)."
                    },
                    "mode": {
                        "type": "string",
                        "enum": ["finish_within", "work_to_cap_then_continue"]
                    },
                    "reason": {
                        "type": "string",
                        "description": "One line: the user's words that state the cap, or why the task needs one."
                    }
                },
                "required": ["cap_percent", "mode", "reason"]
            }),
        }
    }

    async fn call(&self, input: Value, _cancel: &CancellationToken) -> Result<String, String> {
        let percent = input
            .get("cap_percent")
            .and_then(Value::as_f64)
            .filter(|p| (1.0..=100.0).contains(p))
            .ok_or_else(|| "cap_percent must be a number from 1 to 100".to_string())?
            .round() as u8;
        let mode = input
            .get("mode")
            .and_then(Value::as_str)
            .and_then(BudgetMode::parse)
            .ok_or_else(|| {
                "mode must be \"finish_within\" or \"work_to_cap_then_continue\"".to_string()
            })?;
        let reason = input.get("reason").and_then(Value::as_str).unwrap_or("");
        let now_ms = chrono::Utc::now().timestamp_millis();
        declare(&self.dir, percent, mode, reason, now_ms)
    }
}

/// `mcp_config` with Nightloom's own server told the chat's directory:
/// `--budget-dir <dir>` replacing whatever it named before, so its
/// `set_budget` writes this chat's ledger and no other. `None` when the
/// config has no such server or is not an MCP config.
pub fn with_budget_dir(mcp_config: &str, dir: &Path) -> Option<String> {
    let mut cfg: Value = serde_json::from_str(mcp_config).ok()?;
    let server = cfg
        .get_mut("mcpServers")?
        .get_mut(crate::mcp_server::SERVER_NAME)?;
    let args = server.get_mut("args").and_then(Value::as_array_mut)?;
    // Never a dream's server or the note editor's: neither has a turn's ledger.
    if !args.iter().any(|a| a == "--mcp-serve")
        || args.iter().any(|a| a == "--dream" || a == "--rename-note")
    {
        return None;
    }
    let mut kept = Vec::with_capacity(args.len() + 2);
    let mut it = args.drain(..);
    while let Some(a) = it.next() {
        if a == "--budget-dir" {
            it.next();
            continue;
        }
        kept.push(a);
    }
    drop(it);
    kept.push(Value::String("--budget-dir".into()));
    kept.push(Value::String(dir.to_string_lossy().into_owned()));
    *args = kept;
    Some(cfg.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::ask::HookReply;
    use crate::agent::brief::{
        self, SubagentLimits, TurnPhase, begin_turn, read_turn_budget, write_usage,
    };

    fn no_idle() -> Option<i64> {
        None
    }

    /// The hook's decision against a Mac nobody is at and no activity
    /// record, so a call past the line is refused rather than held for his
    /// answer, and nothing of this machine's is read or written.
    fn decide_with(dir: &Path, call: &str, gauge: Option<WindowReading>) -> HookReply {
        let senses = brief::Senses {
            idle_ms: &no_idle,
            activity: None,
        };
        brief::decide_holding(dir, call, gauge, None, 50, 10, &senses)
    }

    fn temp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("nightloom-538-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A reading "now", from the chat's own wire file, so `decide_with`
    /// judges by it whatever this machine's gauge says.
    fn at(dir: &Path, pct: u8) -> Option<WindowReading> {
        let now = chrono::Utc::now().timestamp_millis();
        write_usage(dir, pct, None, now);
        Some(WindowReading {
            five_hour_pct: pct,
            resets_at: None,
            sampled_at_ms: now,
        })
    }

    fn reading(pct: u8, at_ms: i64) -> Option<WindowReading> {
        Some(WindowReading {
            five_hour_pct: pct,
            resets_at: None,
            sampled_at_ms: at_ms,
        })
    }

    /// Every limit off, as he runs (537): only a declared cap binds.
    fn limits_off() -> SubagentLimits {
        let mut l = SubagentLimits::default();
        l.off.per_turn = true;
        l.off.per_day = true;
        l.off.slow = true;
        l.off.stop_at = true;
        l.off.budget_pct = true;
        l
    }

    fn start(dir: &Path, pct: u8) {
        let l = limits_off();
        brief::write_limits(dir, &l).unwrap();
        at(dir, pct);
        begin_turn(dir, &l, TurnPhase::Turn);
        // Pin the start whatever this machine's gauge had on hand.
        brief::with_ledger(dir, |b| {
            b.start_pct = Some(pct);
            b.latest_pct = Some(pct);
        });
    }

    fn ledger(start: u8, cap: Option<(u8, BudgetMode)>) -> TurnBudget {
        let mut b = TurnBudget {
            stop_at: brief::NEVER_PCT,
            start_pct: Some(start),
            latest_pct: Some(start),
            ..Default::default()
        };
        if let Some((p, m)) = cap {
            set_cap(&mut b, p, m, "model", "test", 1);
        }
        b
    }

    const B: BudgetMode = BudgetMode::WorkToCapThenContinue;
    const A: BudgetMode = BudgetMode::FinishWithin;

    /// Task 1: the tool writes the cap and mode into the turn's ledger
    /// (`stop_at` with it), returns what was set, and can be called again.
    #[tokio::test]
    async fn set_budget_writes_the_ledger_and_can_be_called_again() {
        let dir = temp("tool");
        start(&dir, 26);
        let tool = SetBudget::new(&dir);
        let cancel = CancellationToken::new();
        let said = tool
            .call(
                json!({"cap_percent": 50, "mode": "work_to_cap_then_continue", "reason": "he said up to 50%"}),
                &cancel,
            )
            .await
            .unwrap();
        assert!(
            said.contains("cap 50%") && said.contains("work_to_cap_then_continue"),
            "{said}"
        );
        let b = read_turn_budget(&dir).unwrap();
        let cap = b.cap.clone().unwrap();
        assert_eq!((b.stop_at, cap.percent, cap.mode), (50, 50, B));
        assert_eq!(
            (cap.source.as_str(), cap.reason.as_str()),
            ("model", "he said up to 50%")
        );
        // Again, to change it: the ledger follows.
        let said = tool
            .call(
                json!({"cap_percent": 40.0, "mode": "finish_within", "reason": "urgent"}),
                &cancel,
            )
            .await
            .unwrap();
        assert!(
            said.contains("cap 40%") && said.contains("finish_within"),
            "{said}"
        );
        let b = read_turn_budget(&dir).unwrap();
        assert_eq!((b.stop_at, b.cap.unwrap().mode), (40, A));
        // Bad input is an error the model reads, and changes nothing.
        for bad in [
            json!({"cap_percent": 0, "mode": "finish_within", "reason": ""}),
            json!({"cap_percent": 50, "mode": "sometimes", "reason": ""}),
            json!({"mode": "finish_within"}),
        ] {
            assert!(tool.call(bad, &cancel).await.is_err());
        }
        assert_eq!(read_turn_budget(&dir).unwrap().stop_at, 40);
        // No ledger at all: an error, not a silent success.
        let none = temp("tool-none");
        assert!(
            SetBudget::new(&none)
                .call(
                    json!({"cap_percent": 50, "mode": "finish_within", "reason": ""}),
                    &cancel
                )
                .await
                .is_err()
        );
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&none);
    }

    /// The server serves the tool only when it was told the chat's
    /// directory, and the config is rewritten to name it — once, however
    /// many chats the connection has pointed at.
    #[test]
    fn the_servers_arguments_name_the_chats_directory() {
        let cfg = json!({"mcpServers": {
            "nightloom": {"command": "/x", "args": ["--mcp-serve", "--root", "/w"]},
            "playwright": {"command": "/p", "args": []},
        }})
        .to_string();
        let once = with_budget_dir(&cfg, Path::new("/ask/c1")).unwrap();
        let twice = with_budget_dir(&once, Path::new("/ask/c2")).unwrap();
        let v: Value = serde_json::from_str(&twice).unwrap();
        assert_eq!(
            v["mcpServers"]["nightloom"]["args"],
            json!(["--mcp-serve", "--root", "/w", "--budget-dir", "/ask/c2"])
        );
        assert_eq!(v["mcpServers"]["playwright"]["args"], json!([]));
        let parsed =
            crate::mcp_server::parse_args(&["--budget-dir".to_string(), "/ask/c2".to_string()])
                .unwrap();
        assert_eq!(parsed.budget_dir.as_deref(), Some(Path::new("/ask/c2")));
        // A dream's server has no turn's ledger: left alone.
        let dream =
            json!({"mcpServers": {"nightloom": {"args": ["--mcp-serve", "--dream", "{}"]}}})
                .to_string();
        assert!(with_budget_dir(&dream, Path::new("/ask/c1")).is_none());
    }

    /// Task 2: the pattern in his message is only a backstop — written at
    /// the turn's start, replaced by the model's call; and his correction
    /// in the window holds against the model's later calls.
    #[test]
    fn the_message_pattern_is_a_backstop_the_models_call_replaces() {
        for (text, want) in [
            (
                "use up to 50% of the 5h limit and mainly spin up subagents",
                Some((50, B)),
            ),
            ("stop at 60% please", Some((60, B))),
            ("do it all, no more than 70 percent", Some((70, B))),
            ("get this done within 40%", Some((40, A))),
            ("finish in 30% — it's a small thing", Some((30, A))),
            ("urgent: up to 45%, just get it working", Some((45, A))),
            ("make the build 50% faster", None),
            ("```\nuse up to 50%\n```\nwhat does this mean?", None),
            ("> use up to 50%\nthat was yesterday's ask", None),
            ("up to 250% zoom", None),
            // Review 2026-11-10: a percent of something else is no cap.
            ("keep the error within 2% of the baseline", None),
            ("it should load up to 30% faster", None),
            ("at most 5% error on the eval", None),
            ("up to 30% of the users see it", None),
            (
                "up to 30% of the users; use up to 60% of the window",
                Some((60, B)),
            ),
            ("you can use up to 40% of my 5-hour limit", Some((40, B))),
        ] {
            assert_eq!(cap_from_message(text), want, "{text}");
        }
        let dir = temp("backstop");
        start(&dir, 26);
        declare_from_message(&dir, "use up to 50% of the 5h limit", 5);
        let b = read_turn_budget(&dir).unwrap();
        assert_eq!(
            b.cap.as_ref().map(|c| (c.percent, c.source.as_str())),
            Some((50, "message"))
        );
        assert_eq!(b.stop_at, 50);
        // The model's own call replaces it.
        declare(&dir, 55, A, "he said within", 6).unwrap();
        let b = read_turn_budget(&dir).unwrap();
        assert_eq!(
            b.cap
                .as_ref()
                .map(|c| (c.percent, c.mode, c.source.as_str())),
            Some((55, A, "model"))
        );
        // A message with no cap leaves a ledger with none.
        start(&dir, 26);
        declare_from_message(&dir, "fix the tab-drag bug", 7);
        let b = read_turn_budget(&dir).unwrap();
        assert!(b.cap.is_none());
        assert_eq!(b.stop_at, brief::NEVER_PCT);
        // His correction (the chip): the mode flips, and the model's later
        // call changes nothing; no cap at all puts the chat's own line back.
        declare(&dir, 50, B, "x", 8).unwrap();
        let b = correct(&dir, None, Some(A), 9).unwrap();
        assert_eq!(
            b.cap
                .as_ref()
                .map(|c| (c.percent, c.mode, c.source.as_str())),
            Some((50, A, "user"))
        );
        let said = declare(&dir, 90, B, "more", 10).unwrap();
        assert!(said.contains("Kept as Swaraag set it"), "{said}");
        assert_eq!(read_turn_budget(&dir).unwrap().stop_at, 50);
        let b = correct(&dir, Some(65), None, 11).unwrap();
        assert_eq!((b.stop_at, b.cap.as_ref().unwrap().mode), (65, A));
        let b = correct(&dir, None, None, 12).unwrap();
        assert!(b.cap.is_none() && b.cap_locked);
        assert_eq!(b.stop_at, brief::NEVER_PCT);
        assert!(
            correct(&dir, None, Some(A), 13).is_err(),
            "a mode with no cap"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Task 3: each threshold wakes once. Cap 50 in mode B from 26%: the
    /// 10-point pace mark, then cap − 5, then the cap; the same reading
    /// again brings nothing; a new cap arms its thresholds afresh.
    #[test]
    fn a_wake_fires_once_per_threshold() {
        let mut b = ledger(26, Some((50, B)));
        let kinds = |b: &mut TurnBudget, pct: u8| -> Vec<WakeKind> {
            due_wakes(b, reading(pct, 1), 1)
                .into_iter()
                .map(|w| w.kind)
                .collect()
        };
        assert!(kinds(&mut b, 30).is_empty());
        assert_eq!(kinds(&mut b, 36), [WakeKind::Pace]);
        assert!(kinds(&mut b, 37).is_empty(), "the same pace mark");
        assert!(kinds(&mut b, 44).is_empty());
        assert_eq!(kinds(&mut b, 45), [WakeKind::Near]);
        assert!(kinds(&mut b, 46).is_empty());
        assert!(kinds(&mut b, 49).is_empty());
        assert_eq!(kinds(&mut b, 50), [WakeKind::AtCap]);
        assert!(kinds(&mut b, 55).is_empty());
        // A reading that jumps straight past the cap wakes for the cap alone.
        let mut b = ledger(26, Some((50, B)));
        assert_eq!(kinds(&mut b, 52), [WakeKind::AtCap]);
        assert!(
            kinds(&mut b, 47).is_empty(),
            "the lower thresholds went with it"
        );
        // Raised, the cap's thresholds are armed again.
        set_cap(&mut b, 70, B, "model", "more", 2);
        assert_eq!(
            kinds(&mut b, 60),
            [WakeKind::Pace],
            "one wake for the marks passed"
        );
        assert!(kinds(&mut b, 61).is_empty());
        assert_eq!(kinds(&mut b, 66), [WakeKind::Near]);
        // Mode A has no pace wakes; no cap has only the 96% one, once.
        let mut a = ledger(26, Some((50, A)));
        assert!(kinds(&mut a, 40).is_empty());
        assert_eq!(kinds(&mut a, 45), [WakeKind::Near]);
        let mut none = ledger(26, None);
        assert!(kinds(&mut none, 95).is_empty());
        assert_eq!(kinds(&mut none, 96), [WakeKind::Hard]);
        assert!(kinds(&mut none, 99).is_empty());
        assert!(
            due_wakes(&mut none, None, 1).is_empty(),
            "no reading, no wake"
        );
    }

    /// The reservation (537's fix 1), replaying that night's turn: seven
    /// Fable launches at once from 26% under a 50% cap. Mode A lets three
    /// through; mode B refuses none and wakes the main agent at the fourth,
    /// when the helpers' expected cost reaches the cap's margin.
    #[test]
    fn the_reservation_refuses_in_mode_a_and_only_wakes_in_mode_b() {
        let fable = points_for(Some("fable"));
        assert_eq!(
            (fable, points_for(Some("opus")), points_for(None)),
            (6, 3, 3)
        );
        let mut a = ledger(26, Some((50, A)));
        let let_through = (0..7)
            .filter(|_| claim_reservation(&mut a, reading(26, 1), fable).is_ok())
            .count();
        assert_eq!(let_through, 3);
        let no = claim_reservation(&mut a, reading(26, 1), fable).unwrap_err();
        assert!(
            no.contains("cap of 50%") && no.contains("Launch fewer"),
            "{no}"
        );
        // As the reading catches up, the hold is released: at 44% the three
        // helpers' 18 points are spent, and nothing is held.
        assert_eq!(
            (
                outstanding(&a, 26),
                outstanding(&a, 35),
                outstanding(&a, 44)
            ),
            (18, 9, 0)
        );
        let mut b = ledger(26, Some((50, B)));
        let mut woke = Vec::new();
        for n in 1..=7 {
            assert!(
                claim_reservation(&mut b, reading(26, 1), fable).is_ok(),
                "launch {n}"
            );
            for w in due_wakes(&mut b, reading(26, 1), 1) {
                woke.push((n, w.kind, w.reserved));
            }
        }
        assert_eq!(woke, [(4, WakeKind::Reserved, 24)]);
        // With no cap nothing is refused and nothing wakes.
        let mut none = ledger(26, None);
        for _ in 0..7 {
            assert!(claim_reservation(&mut none, reading(26, 1), fable).is_ok());
        }
        assert!(due_wakes(&mut none, reading(26, 1), 1).is_empty());
        // A launch refused further on gives its hold back.
        release_reservation(&mut none, fable);
        assert_eq!(none.reserved.len(), 6);
    }

    /// The wake's words: Nightloom's, saying so; the helpers by id; the
    /// wrap-up to pass on; and in mode B the continue-later line.
    #[test]
    fn the_wake_line_names_the_helpers_and_what_to_send_them() {
        let mut b = ledger(26, Some((50, B)));
        let wakes = due_wakes(&mut b, reading(46, 1), 1);
        let helpers = vec![("a8bb".to_string(), "survey the hook".to_string())];
        let text = wake_text(&wakes, Some(&helpers)).unwrap();
        assert!(
            text.starts_with("[Nightloom, not from Swaraag: usage is at 46%"),
            "{text}"
        );
        for part in [
            "cap is 50%",
            "`a8bb` (\"survey the hook\")",
            "SendMessage",
            WRAP_UP_HELPER,
            "<continue-later at=\"reset\">",
        ] {
            assert!(text.contains(part), "{part}: {text}");
        }
        let mut a = ledger(26, Some((50, A)));
        let text = wake_text(&due_wakes(&mut a, reading(46, 1), 1), None).unwrap();
        assert!(
            text.contains(FINISH_NOW_HELPER) && !text.contains("continue-later"),
            "{text}"
        );
        assert!(wake_text(&[], None).is_none());
    }

    const HELPER_READ: &str =
        r#"{"tool_name":"Read","tool_input":{"file_path":"/x"},"agent_id":"h1","tool_use_id":"t"}"#;
    const MAIN_READ: &str =
        r#"{"tool_name":"Read","tool_input":{"file_path":"/x"},"tool_use_id":"m"}"#;

    /// Whether text the hook hands a helper carries a usage figure.
    fn has_figure(text: &str) -> bool {
        let lower = text.to_ascii_lowercase();
        text.contains('%')
            || [
                "5-hour",
                "five-hour",
                "window",
                "budget",
                "week",
                "cap ",
                "points",
            ]
            .iter()
            .any(|w| lower.contains(w))
    }

    /// Task 3, mode B: nothing the hook hands a helper carries a usage
    /// figure — not on an ordinary call, not near the cap, not at it, not
    /// in the refusal after its grace, not on its own launch — while the
    /// main thread's line names the cap. In mode A the helper sees the line.
    #[test]
    fn a_mode_b_helpers_hook_output_has_no_usage_figure() {
        let dir = temp("hide");
        brief::write(&dir, "<nightloom-subagent-brief>\nlead\n\n<pacing>\nEach message has a usage budget.\n</pacing>\n</nightloom-subagent-brief>").unwrap();
        start(&dir, 26);
        declare(&dir, 50, B, "up to 50%", 1).unwrap();
        let spawn = r#"{"tool_name":"Agent","tool_input":{"prompt":"Estimated context: 100k\ngo","model":"opus"},"agent_id":"h1","agent_type":"general-purpose","tool_use_id":"s"}"#;
        let mut seen = Vec::new();
        for pct in [26u8, 31, 36, 46, 50, 51] {
            let r = at(&dir, pct);
            for call in [HELPER_READ, spawn] {
                let reply = decide_with(&dir, call, r);
                seen.push(serde_json::to_string(&reply).unwrap());
            }
        }
        // Through the grace and past it.
        let r = at(&dir, 52);
        for _ in 0..(WRAP_CALLS + 2) {
            seen.push(serde_json::to_string(&decide_with(&dir, HELPER_READ, r)).unwrap());
        }
        for out in &seen {
            // The helper's own launch carries the brief and its task; the
            // brief's pacing section is what must be gone.
            assert!(!out.contains("<pacing>"), "{out}");
            let said = out.replace("Estimated context: 100k", "");
            assert!(!has_figure(&said), "{out}");
        }
        assert!(
            seen.iter().any(|o| o.contains("wrapping up")),
            "the wrap-up reached it"
        );
        assert!(
            seen.last().unwrap().contains("deny"),
            "{}",
            seen.last().unwrap()
        );
        // The main thread, on the same ledger, is told the cap.
        let main = decide_with(&dir, MAIN_READ, at(&dir, 40));
        let line = main.additional_context().unwrap_or_default().to_string();
        assert!(
            line.contains("cap 50%") && line.contains("from your set_budget call"),
            "{line}"
        );
        // Mode A: the helper sees the usage line, and its launch its share.
        let dir_a = temp("show");
        brief::write(
            &dir_a,
            "<nightloom-subagent-brief>\nlead\n</nightloom-subagent-brief>",
        )
        .unwrap();
        start(&dir_a, 26);
        declare(&dir_a, 50, A, "within 50%", 1).unwrap();
        let reply = decide_with(&dir_a, HELPER_READ, at(&dir_a, 27));
        assert!(
            reply
                .additional_context()
                .is_some_and(|c| c.contains("5-hour 27%")),
            "{reply:?}"
        );
        let launch = r#"{"tool_name":"Agent","tool_input":{"prompt":"Estimated context: 100k\ngo","model":"opus"},"tool_use_id":"s"}"#;
        let out = serde_json::to_string(&decide_with(&dir_a, launch, at(&dir_a, 27))).unwrap();
        assert!(out.contains("Budget: about 3 points"), "{out}");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&dir_a);
    }

    /// Task 3, pieces 4 and 5: past the cap a helper's calls are allowed
    /// with the wrap-up beside them — WRAP_CALLS of them — and then
    /// refused; a second helper has its own count; the main thread gets
    /// the same grace and then is stopped at the cap as before.
    #[test]
    fn the_wrap_up_allows_then_denies() {
        let dir = temp("grace");
        start(&dir, 26);
        declare(&dir, 50, B, "up to 50%", 1).unwrap();
        let r = at(&dir, 51);
        for n in 0..WRAP_CALLS {
            let reply = decide_with(&dir, HELPER_READ, r);
            assert_ne!(reply.decision(), "deny", "call {n}");
            let note = reply.additional_context().unwrap_or_default();
            assert!(
                note.contains("wrapping up") && note.contains(WRAP_UP_HELPER),
                "call {n}: {note}"
            );
            assert!(
                note.contains(&format!("About {} more", WRAP_CALLS - n)),
                "call {n}: {note}"
            );
        }
        let reply = decide_with(&dir, HELPER_READ, r);
        assert_eq!(reply.decision(), "deny");
        assert_eq!(reply.reason(), Some(helper_wrapped_reason().as_str()));
        // Another helper starts its own count.
        let other = HELPER_READ.replace("h1", "h2");
        assert_ne!(decide_with(&dir, &other, r).decision(), "deny");
        // A helper under the grace starts no helper of its own.
        let spawn = r#"{"tool_name":"Agent","tool_input":{"prompt":"Estimated context: 100k\ngo"},"agent_id":"h2","tool_use_id":"s"}"#;
        assert_eq!(decide_with(&dir, spawn, r).decision(), "deny");
        // The main thread: the same grace, told to save state, then stopped.
        for n in 0..WRAP_CALLS {
            let reply = decide_with(&dir, MAIN_READ, r);
            assert_ne!(reply.decision(), "deny", "main call {n}");
            let note = reply.additional_context().unwrap_or_default();
            assert!(
                note.contains("past this message's cap of 50%") && note.contains("continue-later"),
                "{note}"
            );
        }
        let reply = decide_with(&dir, MAIN_READ, r);
        assert_eq!(reply.decision(), "deny");
        // His Wrap up button: a helper's calls run with it beside them too.
        let dir2 = temp("grace-wrap");
        start(&dir2, 26);
        brief::write_answer(&dir2, "wrap", None, chrono::Utc::now().timestamp_millis()).unwrap();
        let r = at(&dir2, 30);
        for _ in 0..WRAP_CALLS {
            let reply = decide_with(&dir2, HELPER_READ, r);
            assert_ne!(reply.decision(), "deny");
            assert!(
                reply
                    .additional_context()
                    .is_some_and(|c| c.contains("Swaraag pressed Wrap up"))
            );
        }
        assert_eq!(decide_with(&dir2, HELPER_READ, r).decision(), "deny");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&dir2);
    }

    /// A wake found on a helper's call waits in the ledger; the drive
    /// loop's look takes it when the main thread can be written to, once;
    /// otherwise the main thread's own next call carries it.
    #[test]
    fn a_helpers_wake_waits_for_the_main_thread() {
        let dir = temp("pending");
        start(&dir, 26);
        declare(&dir, 50, B, "up to 50%", 1).unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        // A helper's call at 46%: nothing said to the helper, a wake waiting.
        let reply = decide_with(&dir, HELPER_READ, at(&dir, 46));
        assert!(reply.additional_context().is_none(), "{reply:?}");
        let b = read_turn_budget(&dir).unwrap();
        assert_eq!(
            b.wakes_pending.iter().map(|w| w.kind).collect::<Vec<_>>(),
            [WakeKind::Near]
        );
        // The main thread busy: the look leaves it.
        assert!(take_wakes(&dir, now, true, false).is_empty());
        // Idle with helpers: taken, once.
        let took = take_wakes(&dir, now, true, true);
        assert_eq!(
            took.iter().map(|w| w.kind).collect::<Vec<_>>(),
            [WakeKind::Near]
        );
        assert!(take_wakes(&dir, now, true, true).is_empty());
        // Not written after all: back, and the main thread's next call has it.
        put_back(&dir, took);
        let reply = decide_with(&dir, MAIN_READ, at(&dir, 46));
        let line = reply.additional_context().unwrap_or_default();
        assert!(
            line.starts_with("[Nightloom, not from Swaraag: usage is at 46%"),
            "{line}"
        );
        assert!(read_turn_budget(&dir).unwrap().wakes_pending.is_empty());
        let again = decide_with(&dir, MAIN_READ, at(&dir, 47));
        assert!(
            !again
                .additional_context()
                .unwrap_or_default()
                .contains("Nightloom, not from")
        );
        // No cap, helpers running, 96%: the look's own reading wakes.
        let dir2 = temp("hard");
        start(&dir2, 60);
        brief::with_ledger(&dir2, |b| {
            claim_reservation(b, reading(60, 1), 3).unwrap();
        });
        at(&dir2, 96);
        let now = chrono::Utc::now().timestamp_millis();
        let took = take_wakes(&dir2, now, true, true);
        assert_eq!(
            took.iter().map(|w| w.kind).collect::<Vec<_>>(),
            [WakeKind::Hard]
        );
        // …and with none running it is not a wake at all, and the holds go.
        let dir3 = temp("hard-none");
        start(&dir3, 60);
        brief::with_ledger(&dir3, |b| {
            claim_reservation(b, reading(60, 1), 3).unwrap();
        });
        at(&dir3, 96);
        assert!(take_wakes(&dir3, now, false, true).is_empty());
        // A hold just taken outlives the look (its helper may not be
        // reported started yet); past the grace it goes.
        assert_eq!(read_turn_budget(&dir3).unwrap().reserved.len(), 1);
        let later = chrono::Utc::now().timestamp_millis() + RESERVE_GRACE_MS + 1;
        assert!(take_wakes(&dir3, later, false, true).is_empty());
        assert!(read_turn_budget(&dir3).unwrap().reserved.is_empty());
        for d in [dir, dir2, dir3] {
            let _ = std::fs::remove_dir_all(&d);
        }
    }

    /// A subagent may not set the budget: the brief hook refuses its call.
    #[test]
    fn a_subagents_set_budget_call_is_refused() {
        let dir = temp("sub-set");
        start(&dir, 26);
        let call = r#"{"tool_name":"mcp__nightloom__set_budget","tool_input":{},"agent_id":"h1","tool_use_id":"t"}"#;
        let reply = decide_with(&dir, call, at(&dir, 27));
        assert_eq!(reply.decision(), "deny");
        let main = call.replace(r#""agent_id":"h1","#, "");
        assert_ne!(decide_with(&dir, &main, at(&dir, 27)).decision(), "deny");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_brief_loses_only_its_pacing_section() {
        assert_eq!(without_pacing("a\n\n<pacing>\nx\n</pacing>\n\nb"), "a\n\nb");
        assert_eq!(without_pacing("a\n\n<pacing>\nx\n</pacing>"), "a");
        assert_eq!(without_pacing("no such section"), "no such section");
    }
}
