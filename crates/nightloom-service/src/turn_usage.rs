//! How much of the plan's five-hour window and week one reply used
//! (nightshift item 323, 2026-10-08): the figure under each finished reply,
//! "5h +N% · week +M%".
//!
//! **Where the two readings come from.** Claude Code sends one
//! `rate_limit_event` per turn, after the turn's first response — measured
//! 2026-10-08 on a Haiku turn of four API calls, one event — with both
//! windows' share used (`unifiedWindows`, whole percents). That is the
//! turn's *start* reading (`inferred`: the share is the account's as the
//! turn's first request was admitted, before what the turn goes on to
//! spend). Its *end* is the next reading the app takes after the turn has
//! ended: the next turn's event in any chat, or the plan chip's refresh
//! (the files or `/usage`, `plan_usage.rs`) when its sample is newer than
//! the turn's end. Until then the turn waits here, in memory; a reply whose
//! end never came (the app quit first) shows nothing.
//!
//! **Shared.** The readings are account-wide. A turn of another chat that
//! ran while this one's span was open — between its start reading and the
//! end reading — is in the figure and cannot be taken out, so the line says
//! `shared`. Use outside this process (the terminal's Claude Code, a night
//! run, the Claude app) is invisible here and is never flagged.
//!
//! **The estimate (his 10/7 question, blocker 1271).** Each reply also
//! carries `est`: its API-equivalent cost (the CLI's own estimate, which
//! prices each model and each kind of token) times the percent-per-dollar
//! fitted over replies that ran alone ([`Fit`], `<config>/usage-fit.json`),
//! once [`FIT_MIN_REPLIES`] such replies exist. Whole-percent readings make
//! one reply's measured figure mostly +0 or +1; the fit averages that out.
//!
//! Written per chat beside the turn budget: `<log dir>/ask/<chat>/turn-usage.jsonl`,
//! one complete line per reply, keyed by the index of the reply's last
//! `assistant_message` in the chat's log.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// The per-chat file of reply figures, beside `turn-budget.json`.
pub const LINES_FILE: &str = "turn-usage.jsonl";
/// The fit across chats, in the config directory.
pub const FIT_FILE: &str = "usage-fit.json";
/// Replies that ran alone before the estimate is offered.
pub const FIT_MIN_REPLIES: u32 = 5;
/// Turns waiting for an end reading; the oldest go past this.
const MAX_PENDING: usize = 64;

/// One account-wide reading of both windows, percent used.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Reading {
    pub five_hour: Option<f64>,
    pub five_hour_resets_at: Option<i64>,
    pub seven_day: Option<f64>,
    pub seven_day_resets_at: Option<i64>,
    /// When it was taken, unix ms.
    pub at_ms: i64,
}

impl Reading {
    /// From a `rate_limit_event`'s shares (0–1); `None` without the
    /// five-hour figure (a CLI that sends none).
    pub fn from_shares(
        five_hour: Option<f64>,
        five_hour_resets_at: Option<i64>,
        seven_day: Option<f64>,
        seven_day_resets_at: Option<i64>,
        at_ms: i64,
    ) -> Option<Self> {
        let pct = |u: f64| (u * 1000.0).round() / 10.0;
        Some(Self {
            five_hour: Some(pct(five_hour?)),
            five_hour_resets_at,
            seven_day: seven_day.map(pct),
            seven_day_resets_at,
            at_ms,
        })
    }

    /// From the plan chip's reading (files or `/usage`).
    pub fn from_plan(u: &crate::plan_usage::PlanUsage) -> Option<Self> {
        let secs = |s: &Option<String>| {
            s.as_deref()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.timestamp())
        };
        Some(Self {
            five_hour: Some(f64::from(u.five_hour?)),
            five_hour_resets_at: secs(&u.five_hour_resets_at),
            seven_day: u.seven_day.map(f64::from),
            seven_day_resets_at: secs(&u.seven_day_resets_at),
            at_ms: u.sampled_at_ms?,
        })
    }
}

/// One window's two readings, percent used.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Span {
    pub start: f64,
    pub end: f64,
}

impl Span {
    pub fn delta(&self) -> f64 {
        self.end - self.start
    }
}

/// The estimate from the reply's cost, percent.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Estimate {
    pub five_hour: Option<f64>,
    pub seven_day: Option<f64>,
    /// How many lone replies the fit was made from.
    pub replies: u32,
}

/// One reply's line in [`LINES_FILE`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TurnUsageLine {
    /// Index of the turn's last `assistant_message` in the chat's log.
    pub target: usize,
    pub started_at_ms: i64,
    pub ended_at_ms: i64,
    /// `None` when a reading lacked the window or it reset in between.
    pub five_hour: Option<Span>,
    pub seven_day: Option<Span>,
    /// Another chat's turn in this app ran inside the span.
    pub shared: bool,
    pub cost_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub est: Option<Estimate>,
    /// When the start and end readings were taken.
    pub start_at_ms: i64,
    pub end_at_ms: i64,
}

/// Percent per API-equivalent dollar, over replies that ran alone.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Fit {
    pub replies: u32,
    pub cost_five_hour: f64,
    pub five_hour: f64,
    pub cost_seven_day: f64,
    pub seven_day: f64,
}

impl Fit {
    /// `cost` at the fitted rates, once the fit has enough replies.
    pub fn estimate(&self, cost: Option<f64>) -> Option<Estimate> {
        let cost = cost.filter(|c| *c > 0.0)?;
        if self.replies < FIT_MIN_REPLIES {
            return None;
        }
        let at = |sum: f64, costs: f64| (costs > 0.0).then(|| cost * sum / costs);
        Some(Estimate {
            five_hour: at(self.five_hour, self.cost_five_hour),
            seven_day: at(self.seven_day, self.cost_seven_day),
            replies: self.replies,
        })
    }

    /// A reply that ran alone, with a cost and a five-hour span, joins it.
    pub fn add(&mut self, line: &TurnUsageLine) -> bool {
        let Some(cost) = line.cost_usd.filter(|c| *c > 0.0) else {
            return false;
        };
        let Some(fh) = line.five_hour else {
            return false;
        };
        if line.shared {
            return false;
        }
        self.replies += 1;
        self.cost_five_hour += cost;
        self.five_hour += fh.delta();
        if let Some(sd) = line.seven_day {
            self.cost_seven_day += cost;
            self.seven_day += sd.delta();
        }
        true
    }
}

/// One window's span from two readings: both present, the same reset
/// time when both say one, and never falling (a fall is a reset).
fn span(
    start: Option<f64>,
    start_resets: Option<i64>,
    end: Option<f64>,
    end_resets: Option<i64>,
) -> Option<Span> {
    let (s, e) = (start?, end?);
    if let (Some(a), Some(b)) = (start_resets, end_resets)
        && a != b
    {
        return None;
    }
    (e >= s).then_some(Span { start: s, end: e })
}

/// The reply's line from its start, its end reading and the fit before it,
/// pure.
/// `times` is when the turn started and ended, unix ms.
pub fn line_of(
    target: usize,
    times: (i64, i64),
    start: &Reading,
    end: &Reading,
    shared: bool,
    cost_usd: Option<f64>,
    fit: &Fit,
) -> TurnUsageLine {
    TurnUsageLine {
        target,
        started_at_ms: times.0,
        ended_at_ms: times.1,
        five_hour: span(
            start.five_hour,
            start.five_hour_resets_at,
            end.five_hour,
            end.five_hour_resets_at,
        ),
        seven_day: span(
            start.seven_day,
            start.seven_day_resets_at,
            end.seven_day,
            end.seven_day_resets_at,
        ),
        shared,
        cost_usd,
        est: fit.estimate(cost_usd),
        start_at_ms: start.at_ms,
        end_at_ms: end.at_ms,
    }
}

struct Active {
    id: u64,
    key: PathBuf,
    start: Option<Reading>,
    started_at_ms: i64,
    concurrent: bool,
}

struct Pending {
    dir: PathBuf,
    target: usize,
    start: Reading,
    started_at_ms: i64,
    ended_at_ms: i64,
    cost_usd: Option<f64>,
    concurrent: bool,
    /// Turns that began after this one ended, before its end reading.
    later: Vec<u64>,
}

#[derive(Default)]
struct Tracker {
    next: u64,
    active: Vec<Active>,
    pending: Vec<Pending>,
}

static TRACKER: Mutex<Tracker> = Mutex::new(Tracker {
    next: 0,
    active: Vec::new(),
    pending: Vec::new(),
});

fn tracker() -> std::sync::MutexGuard<'static, Tracker> {
    TRACKER.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

impl Tracker {
    fn begin(&mut self, dir: &Path, at_ms: i64) -> u64 {
        self.next += 1;
        let id = self.next;
        let concurrent = !self.active.is_empty();
        for a in &mut self.active {
            a.concurrent = true;
        }
        for p in &mut self.pending {
            p.later.push(id);
        }
        self.active.push(Active {
            id,
            key: dir.to_path_buf(),
            start: None,
            started_at_ms: at_ms,
            concurrent,
        });
        id
    }

    fn end(&mut self, id: u64, target: Option<usize>, cost_usd: Option<f64>, at_ms: i64) {
        let Some(i) = self.active.iter().position(|a| a.id == id) else {
            return;
        };
        let a = self.active.remove(i);
        if let (Some(start), Some(target)) = (a.start, target) {
            self.pending.push(Pending {
                dir: a.key,
                target,
                start,
                started_at_ms: a.started_at_ms,
                ended_at_ms: at_ms,
                cost_usd,
                concurrent: a.concurrent,
                later: Vec::new(),
            });
            let over = self.pending.len().saturating_sub(MAX_PENDING);
            self.pending.drain(..over);
        }
    }

    fn drop_turn(&mut self, id: u64) {
        self.active.retain(|a| a.id != id);
    }

    fn reading(&mut self, key: Option<&Path>, r: Reading, fit_path: Option<PathBuf>) {
        let mut from = None;
        if let Some(k) = key
            && let Some(a) = self.active.iter_mut().find(|a| a.key == k)
        {
            from = Some(a.id);
            if a.start.is_none() {
                a.start = Some(r);
            }
        }
        let (due, keep): (Vec<Pending>, Vec<Pending>) = std::mem::take(&mut self.pending)
            .into_iter()
            .partition(|p| p.ended_at_ms <= r.at_ms);
        self.pending = keep;
        if due.is_empty() {
            return;
        }
        let mut fit = fit_path.as_deref().map(read_fit).unwrap_or_default();
        let mut fit_changed = false;
        for p in due {
            let shared = p.concurrent || p.later.iter().any(|id| Some(*id) != from);
            let line = line_of(
                p.target,
                (p.started_at_ms, p.ended_at_ms),
                &p.start,
                &r,
                shared,
                p.cost_usd,
                &fit,
            );
            append_line(&p.dir, &line);
            fit_changed |= fit.add(&line);
        }
        if fit_changed && let Some(path) = &fit_path {
            write_json(path, &fit);
        }
    }
}

/// A turn running in a chat; dropped without [`TurnGuard::end`] (an
/// error, a Stop) it records nothing.
pub struct TurnGuard {
    id: u64,
}

/// A turn begins in the chat whose ask directory is `dir`.
pub fn begin(dir: &Path) -> TurnGuard {
    TurnGuard {
        id: tracker().begin(dir, now_ms()),
    }
}

impl TurnGuard {
    /// The turn ended: `target` is its last reply's index in the log, and
    /// `cost_usd` the CLI's estimate for the whole turn. It waits for the
    /// next reading; a turn with no start reading or no reply records
    /// nothing.
    pub fn end(self, target: Option<usize>, cost_usd: Option<f64>) {
        tracker().end(self.id, target, cost_usd, now_ms());
        std::mem::forget(self);
    }
}

impl Drop for TurnGuard {
    fn drop(&mut self) {
        tracker().drop_turn(self.id);
    }
}

/// A reading arrived: from the turn running in the chat `key` (its
/// `rate_limit_event`), or from the plan chip (`None`). The first one a
/// turn brings is its start; every one closes the turns that ended before
/// it was taken.
pub fn reading(key: Option<&Path>, r: Reading) {
    let fit_path = crate::project::config_dir().map(|d| d.join(FIT_FILE));
    tracker().reading(key, r, fit_path);
}

fn read_fit(path: &Path) -> Fit {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_json<T: Serialize>(path: &Path, v: &T) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, serde_json::to_string_pretty(v).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

fn append_line(dir: &Path, line: &TurnUsageLine) {
    use std::io::Write as _;
    let _ = std::fs::create_dir_all(dir);
    if let (Ok(mut f), Ok(s)) = (
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(LINES_FILE)),
        serde_json::to_string(line),
    ) {
        let _ = writeln!(f, "{s}");
    }
}

/// The chat's reply figures, oldest first; a line that will not parse is
/// skipped.
pub fn read_lines(dir: &Path) -> Vec<TurnUsageLine> {
    std::fs::read_to_string(dir.join(LINES_FILE))
        .map(|s| {
            s.lines()
                .filter_map(|l| serde_json::from_str(l).ok())
                .collect()
        })
        .unwrap_or_default()
}

/// The index of the last `assistant_message` in a log, the key a turn's
/// line is written under.
pub fn last_reply(events: &[nightloom_core::SessionEvent]) -> Option<usize> {
    events
        .iter()
        .rposition(|e| matches!(e, nightloom_core::SessionEvent::AssistantMessage { .. }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(fh: f64, sd: f64, at_ms: i64) -> Reading {
        Reading {
            five_hour: Some(fh),
            five_hour_resets_at: Some(100),
            seven_day: Some(sd),
            seven_day_resets_at: Some(900),
            at_ms,
        }
    }

    #[test]
    fn a_line_is_the_two_readings_per_window() {
        let l = line_of(
            7,
            (1, 2),
            &r(41.0, 12.0, 1),
            &r(44.0, 13.0, 5),
            false,
            Some(0.5),
            &Fit::default(),
        );
        assert_eq!(l.target, 7);
        assert_eq!(
            l.five_hour,
            Some(Span {
                start: 41.0,
                end: 44.0
            })
        );
        assert_eq!(l.seven_day.map(|s| s.delta()), Some(1.0));
        assert_eq!(l.est, None, "no estimate before the fit has replies");
    }

    #[test]
    fn a_reset_between_the_readings_gives_no_span() {
        let mut end = r(3.0, 13.0, 5);
        end.five_hour_resets_at = Some(200);
        let l = line_of(
            0,
            (1, 2),
            &r(41.0, 12.0, 1),
            &end,
            false,
            None,
            &Fit::default(),
        );
        assert_eq!(l.five_hour, None);
        assert!(l.seven_day.is_some());
        // A fall with no reset times is a reset too.
        let s = span(Some(50.0), None, Some(2.0), None);
        assert_eq!(s, None);
    }

    #[test]
    fn a_missing_window_gives_no_span_for_it() {
        let mut end = r(44.0, 0.0, 5);
        end.seven_day = None;
        let l = line_of(
            0,
            (1, 2),
            &r(41.0, 12.0, 1),
            &end,
            false,
            None,
            &Fit::default(),
        );
        assert!(l.five_hour.is_some());
        assert_eq!(l.seven_day, None);
    }

    #[test]
    fn the_fit_takes_lone_replies_and_estimates_from_cost() {
        let mut fit = Fit::default();
        for _ in 0..FIT_MIN_REPLIES {
            let l = line_of(
                0,
                (1, 2),
                &r(10.0, 5.0, 1),
                &r(12.0, 5.5, 5),
                false,
                Some(1.0),
                &fit,
            );
            assert!(fit.add(&l));
        }
        // A shared reply and one with no cost do not join.
        let shared = line_of(
            0,
            (1, 2),
            &r(10.0, 5.0, 1),
            &r(30.0, 9.0, 5),
            true,
            Some(1.0),
            &fit,
        );
        assert!(!fit.add(&shared));
        let free = line_of(
            0,
            (1, 2),
            &r(10.0, 5.0, 1),
            &r(30.0, 9.0, 5),
            false,
            None,
            &fit,
        );
        assert!(!fit.add(&free));
        let e = fit.estimate(Some(0.25)).expect("an estimate");
        assert_eq!(e.replies, FIT_MIN_REPLIES);
        assert!(
            (e.five_hour.unwrap() - 0.5).abs() < 1e-9,
            "2 % per $ × $0.25"
        );
        assert!((e.seven_day.unwrap() - 0.125).abs() < 1e-9);
        assert_eq!(fit.estimate(None), None);
    }

    #[test]
    fn shares_become_percents_and_need_the_five_hour_figure() {
        let r = Reading::from_shares(Some(0.01), Some(1), Some(0.023), None, 9).unwrap();
        assert_eq!(r.five_hour, Some(1.0));
        assert_eq!(r.seven_day, Some(2.3));
        assert!(Reading::from_shares(None, None, Some(0.5), None, 9).is_none());
    }

    /// The tracker end to end, on its own instance (the process-global one
    /// is fed by every agent test that streams a `rate_limit_event`).
    #[test]
    fn turns_wait_for_the_next_reading_and_say_when_shared() {
        let tmp = std::env::temp_dir().join(format!("nl-turn-usage-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let (a, b) = (tmp.join("chat-a"), tmp.join("chat-b"));
        let fit = Some(tmp.join(FIT_FILE));
        let mut t = Tracker::default();

        // A lone turn in A: its event is its start; B's next turn's event
        // is its end, and A is not shared (B's own spend comes after it).
        let a1 = t.begin(&a, 0);
        t.reading(Some(a.as_path()), r(40.0, 10.0, 10), fit.clone());
        t.end(a1, Some(3), Some(0.2), 20);
        assert!(read_lines(&a).is_empty(), "waits for the end reading");
        let b1 = t.begin(&b, 30);
        t.reading(Some(b.as_path()), r(42.0, 11.0, 40), fit.clone());
        let lines = read_lines(&a);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].target, 3);
        assert_eq!(lines[0].five_hour.map(|s| s.delta()), Some(2.0));
        assert!(!lines[0].shared);

        // A turn in A while B's is still going: both shared.
        let a2 = t.begin(&a, 50);
        t.reading(Some(a.as_path()), r(42.0, 11.0, 60), fit.clone());
        t.end(a2, Some(9), Some(0.1), 70);
        t.end(b1, Some(5), Some(0.3), 80);
        // The plan chip's refresh closes both.
        t.reading(None, r(45.0, 11.0, 90), fit.clone());
        let a_lines = read_lines(&a);
        assert_eq!(a_lines.len(), 2);
        assert!(a_lines[1].shared, "A's second turn overlapped B's");
        let b_lines = read_lines(&b);
        assert_eq!(b_lines.len(), 1);
        assert!(b_lines[0].shared, "B's overlapped A's second");

        // A reading taken before a turn ended does not close it.
        let a3 = t.begin(&a, 100);
        t.reading(Some(a.as_path()), r(45.0, 11.0, 110), fit.clone());
        t.end(a3, Some(12), None, 120);
        t.reading(None, r(46.0, 11.0, 115), fit.clone());
        assert_eq!(read_lines(&a).len(), 2);

        // A turn whose end reading is another turn's that began after it
        // ended and had a third turn begin in between: shared.
        let b2 = t.begin(&b, 130);
        let c1 = t.begin(&tmp.join("chat-c"), 131);
        t.reading(
            Some(tmp.join("chat-c").as_path()),
            r(46.0, 11.0, 140),
            fit.clone(),
        );
        assert!(
            read_lines(&a)[2].shared,
            "B's turn began inside A's span too"
        );

        // A turn dropped without `end` (an error, a Stop) records nothing.
        t.reading(Some(b.as_path()), r(46.0, 11.0, 141), fit.clone());
        t.drop_turn(b2);
        t.end(c1, None, None, 150);
        t.reading(None, r(47.0, 11.0, 160), fit.clone());
        assert_eq!(read_lines(&b).len(), 1);

        // The fit took the lone first turn only.
        let f = read_fit(&tmp.join(FIT_FILE));
        assert_eq!(f.replies, 1);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
