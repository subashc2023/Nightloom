//! How long keep-warm holds a chat's cache (nightshift item 878, his
//! answer to blocker 2266, 2026-11-23: "use the no pings while you sleep …
//! i want all of these values to be continually accumulating data and like
//! updating, so that if anything overtakes that first option … we know").
//!
//! **The rules** ([`Rule`]): every policy item 878's simulation
//! (`notes/runner-design/aside-cache-hold-sim.py` in nightshift-code)
//! scored — a flat cap, "stop at his sleep", "run on through his sleep",
//! the hybrid, a cap per weekday × part of day, and the expected-hit stop
//! — as one function, [`Rule::pings`]: how many pings, one every 55 min
//! after a reply, the rule allows for that reply. The live schedule
//! ([`crate::keep_warm::step`]) and the scoreboard ([`sim`]) both call it,
//! so the table he is shown scores exactly the code that runs.
//!
//! **The active rule** is his pick, kept in [`ACTIVE_FILE`]; without one
//! it is [`DEFAULT_RULE`] — stop at the start of his sleep, up to 8 h
//! while he is awake (blocker 2266: $77.35 vs flat 6 h's $70.62 over his
//! last 4 weeks, reads at 0.5). **It never changes by itself**: the
//! scoreboard only reports that another rule has overtaken it (his
//! "we can make that change tgt", 12:53 PM).
//!
//! **His sleep** ([`Sleep`]) is learned from his own reply and return
//! times — the quietest 7 hours of the day — unless he set it by hand in
//! Settings ([`SLEEP_FILE`]).
//!
//! **The scoreboard** ([`score_now`], daily from the desktop's keep-warm
//! tick, no model calls) re-reads every idle moment of his Opus/Fable
//! chats ([`gaps`]), replays every rule walk-forward (each week decided
//! from the weeks before it only), and writes [`SCOREBOARD_FILE`]; when a
//! rule beats the active one over the last 2+ weeks it appends one line to
//! [`OVERTAKES_FILE`] (read by `bin/holdcheck.py` in nightshift-code, so
//! a Claude Code session hears of it too) and the app shows a notice.

pub mod gaps;
pub mod sim;
#[cfg(test)]
mod tests;

use chrono::{Datelike, Local, TimeZone, Timelike};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// The folder under the config directory that holds every file here.
pub const DIR: &str = "keep-warm";
/// His pick: `{"id": "...", "set_ms": …}`; no file reads as [`DEFAULT_RULE`].
pub const ACTIVE_FILE: &str = "active.json";
/// His sleep set by hand: `{"start": 2, "end": 9}`; no file: the learned one.
pub const SLEEP_FILE: &str = "sleep.json";
/// The scoreboard's last run: the table, the learned sleep, each rule's
/// parameters learned on all data.
pub const SCOREBOARD_FILE: &str = "scoreboard.json";
/// One line per overtake (his ask, 12:53 PM): date, old and new rule, both
/// scores, the weeks counted, the table's path.
pub const OVERTAKES_FILE: &str = "overtakes.jsonl";
/// The rule without a pick of his (blocker 2266's answer).
pub const DEFAULT_RULE: &str = "sleep-cut-8h";
/// His sleep before the scoreboard has run: what the simulation learned
/// in every fold on 2026-11-23 (2 AM–9 AM).
pub const DEFAULT_SLEEP: Sleep = Sleep { start: 2, end: 9 };
/// The sleep window's length, hours (the simulation's best).
pub const SLEEP_HOURS: u8 = 7;
/// The most pings any rule may ask for after one reply (the sim's 30).
pub const MAX_PINGS: u32 = 30;

/// His sleep, whole local hours: from `start` to `end` (it may wrap
/// midnight, as 23 → 6 does).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sleep {
    pub start: u8,
    pub end: u8,
}

impl Sleep {
    /// Whether local hour `h` is inside it (the sim's `in_win`).
    pub fn contains(&self, h: u32) -> bool {
        let (s, e) = (u32::from(self.start), u32::from(self.end));
        if s < e {
            s <= h && h < e
        } else {
            h >= s || h < e
        }
    }

    /// Both ends are hours of a day and differ.
    pub fn valid(&self) -> bool {
        self.start < 24 && self.end < 24 && self.start != self.end
    }
}

/// Local hour and weekday (Monday 0) of a unix-ms instant, the sim's
/// `datetime.fromtimestamp` (the Mac's own zone).
pub fn local_hw(ms: i64) -> (u32, u32) {
    match Local.timestamp_millis_opt(ms).single() {
        Some(t) => (t.hour(), t.weekday().num_days_from_monday()),
        None => (0, 0),
    }
}

/// The price table of items 541/579 (list $ per million tokens): read,
/// 1-hour write, output; Fable's are Opus's doubled except the read.
pub fn prices(fable: bool) -> (f64, f64, f64) {
    if fable {
        (0.2, 16.0, 40.0)
    } else {
        (0.2, 8.0, 20.0)
    }
}
/// A ping's own write and output, tokens (541's measured figures).
pub const PING_WRITE: f64 = 300.0;
pub const PING_OUT: f64 = 100.0;

/// One keep-warm rule with what it learned, small enough to copy into
/// the schedule's [`crate::keep_warm::Policy`]. `base` pings (the cap)
/// come from the policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Rule {
    /// Every ping the cap allows (item 541's rule; a hold, "until I'm back").
    #[default]
    Flat,
    /// No ping inside his sleep; the first that would fall in it ends the run.
    SleepCut(Sleep),
    /// The cap, but a hold that would end inside his sleep runs on to
    /// `after` hours past his waking.
    SleepExtend { sleep: Sleep, after: u8 },
    /// No hold when the reply itself lands in his sleep; else as
    /// [`Rule::SleepExtend`] with 1 h.
    Hybrid(Sleep),
    /// Pings by the reply's weekday-or-weekend × 6-hour part of the day,
    /// tuned on the past; `u8::MAX` is a part with no past (the cap).
    Daypart([u8; 8]),
    /// Ping while the chance he returns before the next ping × the
    /// rebuild it saves beats the ping's price (hazard per weekday-or-
    /// weekend × 3-hour part: (gaps still open, gaps that ended)).
    ExpectedHit { rho_pct: u8, hz: [(u16, u16); 16] },
}

/// What a rule needs of a reply to count its pings.
#[derive(Debug, Clone, Copy)]
pub struct At {
    /// When the reply's request was sent, unix ms.
    pub t0_ms: i64,
    /// Its context, tokens.
    pub ctx: u64,
    pub fable: bool,
}

impl Rule {
    /// Its sleep window, when it has one.
    pub fn sleep(&self) -> Option<Sleep> {
        match self {
            Rule::SleepCut(s) | Rule::Hybrid(s) | Rule::SleepExtend { sleep: s, .. } => Some(*s),
            _ => None,
        }
    }

    /// Whether it forbids a ping at local hour `h` outright (the live
    /// schedule's guard: an aside that moved the hour never makes a ping
    /// land in his sleep).
    pub fn forbids(&self, h: u32) -> bool {
        matches!(self, Rule::SleepCut(s) if s.contains(h))
    }

    /// How many pings, one every `every_ms` after the reply, this rule
    /// allows, with `base` the cap's count. `hw` is [`local_hw`] (a test
    /// clock in tests). The sim's functions, one by one.
    pub fn pings(&self, at: At, base: u32, every_ms: i64, hw: &impl Fn(i64) -> (u32, u32)) -> u32 {
        let ping_t = |j: u32| at.t0_ms + every_ms * i64::from(j);
        match *self {
            Rule::Flat => base,
            Rule::SleepCut(s) => {
                let mut k = 0;
                for j in 1..=base {
                    if s.contains(hw(ping_t(j)).0) {
                        break;
                    }
                    k = j;
                }
                k
            }
            Rule::SleepExtend { sleep, after } => extend(at, sleep, base, after, every_ms, hw),
            Rule::Hybrid(s) => {
                if s.contains(hw(at.t0_ms).0) {
                    0
                } else {
                    extend(at, s, base, 1, every_ms, hw)
                }
            }
            Rule::Daypart(k) => {
                let (h, wd) = hw(at.t0_ms);
                let i = (usize::from(wd < 5) * 4) + (h / 6) as usize;
                match k[i] {
                    u8::MAX => base,
                    n => u32::from(n),
                }
            }
            Rule::ExpectedHit { rho_pct, hz } => {
                let (rd, w, o) = prices(at.fable);
                let ctx = at.ctx as f64;
                let rho = f64::from(rho_pct) / 100.0;
                let ping = (rho * ctx * rd + PING_WRITE * w + PING_OUT * o) / 1e6;
                let save = ctx * (w - rd) / 1e6;
                let mut k = 0;
                for j in 1..=MAX_PINGS {
                    let (at_n, back) = hz[hz_key(hw(ping_t(j)))];
                    let p = (f64::from(back) + 1.0) / (f64::from(at_n) + 4.0);
                    if p * save < ping && j > 1 {
                        break;
                    }
                    k = j;
                }
                k
            }
        }
    }
}

/// The hazard table's slot for a ping at (hour, weekday): weekday-or-
/// weekend × 3-hour part (the sim's key).
pub fn hz_key((h, wd): (u32, u32)) -> usize {
    usize::from(wd < 5) * 8 + (h / 3) as usize
}

/// The sim's `k_sleep_extend`.
fn extend(
    at: At,
    s: Sleep,
    base: u32,
    after: u8,
    every_ms: i64,
    hw: &impl Fn(i64) -> (u32, u32),
) -> u32 {
    let ping_t = |j: u32| at.t0_ms + every_ms * i64::from(j);
    if !s.contains(hw(ping_t(base) + 3_600_000).0) {
        return base;
    }
    let wake = (u32::from(s.end) + u32::from(after)) % 24;
    let mut k = base;
    while k < MAX_PINGS {
        let h = hw(ping_t(k + 1)).0;
        k += 1;
        if !s.contains(h) && h == wake {
            break;
        }
    }
    k
}

/// His sleep from an hour-of-day count of his activity: the `n` quietest
/// consecutive hours, the first such start on a tie (the sim's
/// `sleep_window`).
pub fn sleep_window(counts: &[u32; 24], n: u8) -> Sleep {
    let sum = |s: usize| {
        (0..usize::from(n))
            .map(|i| counts[(s + i) % 24])
            .sum::<u32>()
    };
    let mut best = 0;
    for s in 1..24 {
        if sum(s) < sum(best) {
            best = s;
        }
    }
    Sleep {
        start: best as u8,
        end: ((best + usize::from(n)) % 24) as u8,
    }
}

// ---------- files ----------

/// `<config>/keep-warm/`.
pub fn dir(config_dir: &Path) -> PathBuf {
    config_dir.join(DIR)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Active {
    pub id: String,
    pub set_ms: i64,
}

/// His pick's id, else [`DEFAULT_RULE`]; an id the scoreboard does not
/// know reads as the default too.
pub fn active_id(config_dir: Option<&Path>) -> String {
    config_dir
        .and_then(|d| std::fs::read_to_string(dir(d).join(ACTIVE_FILE)).ok())
        .and_then(|t| serde_json::from_str::<Active>(&t).ok())
        .map(|a| a.id)
        .filter(|id| sim::selectable(id))
        .unwrap_or_else(|| DEFAULT_RULE.to_string())
}

/// Switch the active rule (his click, never the scoreboard's).
pub fn set_active(config_dir: &Path, id: &str, now: i64) -> Result<(), String> {
    if !sim::selectable(id) {
        return Err(format!("not a keep-warm rule: {id}"));
    }
    write_json(
        &dir(config_dir).join(ACTIVE_FILE),
        &Active {
            id: id.to_string(),
            set_ms: now,
        },
    )
}

/// His sleep set by hand, if he set one.
pub fn manual_sleep(config_dir: Option<&Path>) -> Option<Sleep> {
    config_dir
        .and_then(|d| std::fs::read_to_string(dir(d).join(SLEEP_FILE)).ok())
        .and_then(|t| serde_json::from_str::<Sleep>(&t).ok())
        .filter(Sleep::valid)
}

/// Set (or, with `None`, clear back to the learned one) his sleep.
pub fn set_manual_sleep(config_dir: &Path, sleep: Option<Sleep>) -> Result<(), String> {
    let path = dir(config_dir).join(SLEEP_FILE);
    match sleep {
        None => {
            let _ = std::fs::remove_file(path);
            Ok(())
        }
        Some(s) if s.valid() => write_json(&path, &s),
        Some(_) => Err("a sleep window needs two different hours, 0–23".into()),
    }
}

pub(crate) fn write_json<T: Serialize>(path: &Path, v: &T) -> Result<(), String> {
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// The last scoreboard, if one ran.
pub fn read_scoreboard(config_dir: Option<&Path>) -> Option<sim::Scoreboard> {
    config_dir
        .and_then(|d| std::fs::read_to_string(dir(d).join(SCOREBOARD_FILE)).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
}

/// His sleep as the schedule uses it: his own setting, else the
/// scoreboard's learned window, else [`DEFAULT_SLEEP`]; and whether it is
/// his own setting.
pub fn sleep_in_force(config_dir: Option<&Path>, board: Option<&sim::Scoreboard>) -> (Sleep, bool) {
    if let Some(s) = manual_sleep(config_dir) {
        return (s, true);
    }
    (board.map_or(DEFAULT_SLEEP, |b| b.learned_sleep), false)
}

/// The active rule, live: its id, the rule with its learned parameters
/// (the scoreboard's, on all data; the defaults before it ran), and the
/// cap it runs under, ms.
pub fn active_rule(config_dir: Option<&Path>, every_ms: i64) -> (&'static str, Rule, Option<i64>) {
    let board = read_scoreboard(config_dir);
    let id = active_id(config_dir);
    let (sleep, _) = sleep_in_force(config_dir, board.as_ref());
    let learned = board.as_ref().map(|b| &b.learned);
    sim::live(&id, sleep, learned, every_ms)
}

/// Run the scoreboard now on his files and write its results: the table,
/// and an overtake line when one is new. `claude_projects` is the CLI's
/// transcript folder. Blocking — minutes of file reads at worst; the
/// desktop runs it on a blocking thread, daily.
pub fn score_now(
    config_dir: &Path,
    claude_projects: &Path,
    now_ms: i64,
) -> Result<sim::Scoreboard, String> {
    let rows = gaps::extract(config_dir, claude_projects, gaps::SINCE_S, now_ms / 1000);
    let active = active_id(Some(config_dir));
    let prev = read_scoreboard(Some(config_dir));
    let board = sim::scoreboard(
        &rows,
        now_ms,
        &active,
        manual_sleep(Some(config_dir)),
        prev.as_ref(),
    );
    let path = dir(config_dir).join(SCOREBOARD_FILE);
    write_json(&path, &board)?;
    if let Some(o) = &board.overtake
        && board.overtake_new
    {
        let line = serde_json::json!({
            "id": o.id,
            "date": chrono::Local.timestamp_millis_opt(now_ms).single().map(|t| t.format("%Y-%m-%d %-I:%M %p").to_string()),
            "at_ms": now_ms,
            "old": o.active,
            "old_name": sim::name_of(&o.active),
            "old_usd": o.active_usd,
            "new": o.challenger,
            "new_name": sim::name_of(&o.challenger),
            "new_usd": o.challenger_usd,
            "weeks": o.weeks,
            "metric": "net list $, reads at 0.5 (item 580)",
            "table": path,
        });
        use std::io::Write;
        let p = dir(config_dir).join(OVERTAKES_FILE);
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(p)
            .map_err(|e| e.to_string())?;
        writeln!(f, "{line}").map_err(|e| e.to_string())?;
    }
    Ok(board)
}
