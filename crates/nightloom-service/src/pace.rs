//! The plan's pace (nightshift item 769, 2026-11-16): "at this rate, empty
//! at <time>" for the five-hour and weekly windows, and the time each
//! reaches 80% — his stop line ("a usage line means stop at 80% of this
//! window").
//!
//! His words on the first draft (item 769, 4:52 PM): "the limit pace is
//! kinda useless when it's jus like a linear extrapolation. maybe if it were
//! like nonlinear and actually measures my usage over time to get more
//! accurate values." So the forecast is not a straight line:
//!
//! 1. **A history.** Every plan reading Nightloom takes (each passes
//!    through [`crate::turn_usage::reading`]) is appended to
//!    `~/.nightloom/plan-readings.jsonl` ([`record`]). The first time the
//!    log is made it is seeded from what already exists on disk: the
//!    Claude app's `plan-usage-history.json` and every chat's
//!    `turn-usage.jsonl` (a reply's start and end readings). A one-off
//!    import from older transcripts may sit beside it
//!    ([`IMPORT_FILE`], `scripts/pace-backfill.py`).
//! 2. **His usage by hour of the week.** Between two readings in one
//!    window the points gained are spread over the hours between them; per
//!    hour of the week (local time) that gives points per hour, shrunk
//!    toward his hour-of-day figure and that toward his overall mean when a
//!    slot has seen little ([`Table`]).
//! 3. **The forecast** walks from now to the reset in five-minute steps
//!    (fifteen for the week), each step's rate a blend of his rate over the
//!    last hour (three hours for the week) and half the slot's figure
//!    ([`Tuning::of`] says why half), the recent rate fading as the step
//!    gets further away ([`project`]).
//! 4. **Its error, measured before it is shown** ([`backtest`]): at past
//!    readings, the forecast made from only the history before them is
//!    compared with what the window actually read an hour later (a day
//!    later for the week), and so is the straight line from the window's
//!    start. The pace shows the mean miss in points and how many checks it
//!    rests on; under [`MIN_CHECKS`] it says it is still learning instead
//!    of showing a time.
//!
//! Account-wide figures (every surface, not this chat), the same as the
//! plan chip's.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The reading log, under `config_dir()`.
pub const LOG_FILE: &str = "plan-readings.jsonl";
/// A one-off import beside it (older transcripts), read with the log.
pub const IMPORT_FILE: &str = "plan-readings-import.jsonl";
/// The last pace, for `usagectl.py` and anything outside the app.
pub const PACE_FILE: &str = "plan-pace.json";
/// The stop line he works to (his rule, 2026-11-16).
pub const WARN_PCT: f64 = 80.0;

const HOUR_MS: i64 = 3_600_000;
const MIN_MS: i64 = 60_000;

/// One logged reading: unix ms, each window's percent used and its reset
/// (unix seconds) when known.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Logged {
    pub t: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fh: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fr: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sr: Option<i64>,
}

impl From<&crate::turn_usage::Reading> for Logged {
    fn from(r: &crate::turn_usage::Reading) -> Self {
        Self {
            t: r.at_ms,
            fh: r.five_hour,
            fr: r.five_hour_resets_at,
            sd: r.seven_day,
            sr: r.seven_day_resets_at,
        }
    }
}

/// The two windows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    FiveHour,
    Week,
}

impl Kind {
    fn len_ms(self) -> i64 {
        match self {
            Kind::FiveHour => 5 * HOUR_MS,
            Kind::Week => 7 * 24 * HOUR_MS,
        }
    }
    /// The longest gap between two readings whose rise is spread over it.
    fn max_gap_ms(self) -> i64 {
        match self {
            Kind::FiveHour => 5 * HOUR_MS,
            Kind::Week => 24 * HOUR_MS,
        }
    }
    /// How far back "his rate right now" looks.
    fn recent_ms(self) -> i64 {
        match self {
            Kind::FiveHour => HOUR_MS,
            Kind::Week => 3 * HOUR_MS,
        }
    }
    /// How fast the recent rate gives way to the slot's (e-folding time).
    fn fade_ms(self) -> i64 {
        match self {
            Kind::FiveHour => 45 * MIN_MS,
            Kind::Week => 6 * HOUR_MS,
        }
    }
    fn step_ms(self) -> i64 {
        match self {
            Kind::FiveHour => 5 * MIN_MS,
            Kind::Week => 15 * MIN_MS,
        }
    }
    /// How far ahead a back-test check looks.
    pub fn horizon_ms(self) -> i64 {
        match self {
            Kind::FiveHour => HOUR_MS,
            Kind::Week => 24 * HOUR_MS,
        }
    }
    /// The spacing of back-test checks within a window.
    fn check_every_ms(self) -> i64 {
        match self {
            Kind::FiveHour => 20 * MIN_MS,
            Kind::Week => 4 * HOUR_MS,
        }
    }
    fn name(self) -> &'static str {
        match self {
            Kind::FiveHour => "five_hour",
            Kind::Week => "seven_day",
        }
    }
}

/// The forecast's knobs; [`Tuning::of`] is what ships. Separate so the
/// measurement on his history can try others.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Tuning {
    pub recent_ms: i64,
    pub fade_ms: i64,
    /// Weight on the hour-of-week figure (0: the recent rate alone, fading to nothing).
    pub slot_scale: f64,
}

impl Tuning {
    pub fn of(kind: Kind) -> Self {
        Self {
            recent_ms: kind.recent_ms(),
            fade_ms: kind.fade_ms(),
            // Measured on his history (2026-11-16, report wave-l-pace):
            // the table only sees hours when readings were being taken,
            // which lean toward the hours he works, so its figure runs
            // high; half of it missed least (5-hour 8.7 pts an hour ahead
            // against 9.6 at full weight; week 7.0 a day ahead against 8.6).
            slot_scale: 0.5,
        }
    }
}

/// Checks needed before a time is shown, per window.
pub const MIN_CHECKS: [u32; 2] = [20, 10];

fn min_checks(k: Kind) -> u32 {
    match k {
        Kind::FiveHour => MIN_CHECKS[0],
        Kind::Week => MIN_CHECKS[1],
    }
}

/// One window's reading in a series.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pt {
    pub t: i64,
    pub p: f64,
    /// Reset, unix ms, when known.
    pub reset: Option<i64>,
}

/// One window's readings, oldest first, one per time.
pub fn series(log: &[Logged], kind: Kind) -> Vec<Pt> {
    let mut out: Vec<Pt> = log
        .iter()
        .filter_map(|l| {
            let (p, r) = match kind {
                Kind::FiveHour => (l.fh?, l.fr),
                Kind::Week => (l.sd?, l.sr),
            };
            Some(Pt {
                t: l.t,
                p,
                reset: r.map(|s| s * 1000),
            })
        })
        .collect();
    out.sort_by_key(|p| p.t);
    out.dedup_by_key(|p| p.t);
    out
}

/// The series cut into windows: a new one where the figure drops, where
/// both readings name resets fifteen minutes apart or more, or past the
/// window's length from its first reading.
pub fn windows(s: &[Pt], kind: Kind) -> Vec<Vec<Pt>> {
    let mut out: Vec<Vec<Pt>> = Vec::new();
    for &pt in s {
        let new = match out.last().and_then(|w| Some((w.first()?, w.last()?))) {
            None => true,
            Some((first, prev)) => {
                pt.p < prev.p - 1.5
                    || matches!((pt.reset, prev.reset), (Some(a), Some(b)) if (a - b).abs() >= 15 * MIN_MS)
                    || prev.reset.is_some_and(|r| pt.t >= r)
                    || pt.t - first.t > kind.len_ms()
            }
        };
        if new {
            out.push(vec![pt]);
        } else if let Some(w) = out.last_mut() {
            w.push(pt);
        }
    }
    out
}

/// Slots: hour of the week, local time (0 = Monday 00:00).
const SLOTS: usize = 168;
/// The shrinkage prior, in observed hours.
const PRIOR_HOURS: f64 = 2.0;

/// His points per hour by hour of the week, from the rises between readings.
#[derive(Debug, Clone)]
pub struct Table {
    pts: [f64; SLOTS],
    hrs: [f64; SLOTS],
    /// Local offset from UTC, seconds (east positive).
    tz: i64,
}

impl Table {
    pub fn new(tz_offset_secs: i64) -> Self {
        Self {
            pts: [0.0; SLOTS],
            hrs: [0.0; SLOTS],
            tz: tz_offset_secs,
        }
    }

    fn slot(&self, t: i64) -> usize {
        // 1970-01-01 was a Thursday: day 0 → weekday 3 (Monday = 0).
        let local = t + self.tz * 1000;
        let hour = local.div_euclid(HOUR_MS);
        let day = hour.div_euclid(24);
        let weekday = (day + 3).rem_euclid(7);
        (weekday * 24 + hour.rem_euclid(24)) as usize
    }

    /// The rise from `a` to `b`, spread evenly over the hours between.
    pub fn add_pair(&mut self, a: Pt, b: Pt, kind: Kind) {
        let dt = b.t - a.t;
        if dt <= 0 || dt > kind.max_gap_ms() {
            return;
        }
        let dp = (b.p - a.p).max(0.0);
        let mut t = a.t;
        while t < b.t {
            let next = ((t.div_euclid(HOUR_MS) + 1) * HOUR_MS).min(b.t);
            let share = (next - t) as f64 / dt as f64;
            let s = self.slot(t);
            self.pts[s] += dp * share;
            self.hrs[s] += (next - t) as f64 / HOUR_MS as f64;
            t = next;
        }
    }

    /// Hours of history in the table.
    pub fn hours(&self) -> f64 {
        self.hrs.iter().sum()
    }

    /// Points per hour expected in the slot of `t`: the slot's own figure
    /// shrunk toward the same hour on every day, and that toward the mean.
    pub fn rate(&self, t: i64) -> f64 {
        let total_h = self.hours();
        if total_h <= 0.0 {
            return 0.0;
        }
        let mean = self.pts.iter().sum::<f64>() / total_h;
        let s = self.slot(t);
        let hod = s % 24;
        let (mut dp, mut dh) = (0.0, 0.0);
        for d in 0..7 {
            dp += self.pts[d * 24 + hod];
            dh += self.hrs[d * 24 + hod];
        }
        let day_rate = (dp + PRIOR_HOURS * mean) / (dh + PRIOR_HOURS);
        (self.pts[s] + PRIOR_HOURS * day_rate) / (self.hrs[s] + PRIOR_HOURS)
    }
}

/// His rate over the last stretch of the window, points per hour; `None`
/// with under ten minutes of readings to go on.
pub fn recent_rate(win: &[Pt], now: i64, kind: Kind) -> Option<f64> {
    recent_rate_over(win, now, kind.recent_ms())
}

fn recent_rate_over(win: &[Pt], now: i64, recent_ms: i64) -> Option<f64> {
    let last = win.iter().rev().find(|p| p.t <= now)?;
    let from = win.iter().find(|p| p.t >= now - recent_ms && p.t <= now)?;
    let span = last.t - from.t;
    if span < 10 * MIN_MS {
        return None;
    }
    Some((last.p - from.p).max(0.0) / (span as f64 / HOUR_MS as f64))
}

/// Where the window is headed.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Projection {
    pub at80: Option<i64>,
    pub at100: Option<i64>,
    /// The figure expected at `until`.
    pub end_pct: f64,
}

/// Walk from `now` (at `p0`) to `until`: each step adds the blend of the
/// recent rate and the slot's, the recent one fading with distance.
pub fn project(
    table: &Table,
    now: i64,
    p0: f64,
    until: i64,
    recent: Option<f64>,
    kind: Kind,
) -> Projection {
    project_tuned(table, now, p0, until, recent, kind, Tuning::of(kind))
}

/// [`project`] with its knobs given.
pub fn project_tuned(
    table: &Table,
    now: i64,
    p0: f64,
    until: i64,
    recent: Option<f64>,
    kind: Kind,
    tune: Tuning,
) -> Projection {
    let step = kind.step_ms();
    let mut p = p0;
    let mut out = Projection {
        at80: (p0 >= WARN_PCT).then_some(now),
        at100: (p0 >= 100.0).then_some(now),
        end_pct: p0,
    };
    let mut t = now;
    while t < until && p < 100.0 {
        let dt = step.min(until - t);
        let mid = t + dt / 2;
        let slot = tune.slot_scale * table.rate(mid);
        let rate = match recent {
            Some(r) => {
                let w = (-((mid - now) as f64) / tune.fade_ms as f64).exp();
                w * r + (1.0 - w) * slot
            }
            None => slot,
        };
        let next = p + rate * dt as f64 / HOUR_MS as f64;
        let cross = |line: f64| -> Option<i64> {
            (p < line && next >= line).then(|| t + ((line - p) / (next - p) * dt as f64) as i64)
        };
        if out.at80.is_none() {
            out.at80 = cross(WARN_PCT);
        }
        if out.at100.is_none() {
            out.at100 = cross(100.0);
        }
        p = next;
        t += dt;
    }
    out.end_pct = p.min(100.0);
    out
}

/// The window's figure at `t`, between its readings (none past the last).
fn value_at(win: &[Pt], t: i64) -> Option<f64> {
    let i = win.iter().position(|p| p.t >= t)?;
    let b = win[i];
    if b.t == t || i == 0 {
        return (b.t == t).then_some(b.p);
    }
    let a = win[i - 1];
    Some(a.p + (b.p - a.p) * (t - a.t) as f64 / (b.t - a.t) as f64)
}

/// How well the forecast did on past windows, against the straight line.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize)]
pub struct Backtest {
    /// Mean miss of the forecast, points.
    pub err_pts: Option<f64>,
    /// Mean miss of the straight line from the window's start, points.
    pub linear_err_pts: Option<f64>,
    pub checks: u32,
}

/// Every closed window, checked at its readings every
/// [`Kind::check_every_ms`]: the forecast from the history before the
/// check (never after) against what the window read [`Kind::horizon_ms`]
/// later. `before` excludes the open window, which has no answer yet.
pub fn backtest(wins: &[Vec<Pt>], kind: Kind, tz: i64) -> Backtest {
    backtest_tuned(wins, kind, tz, Tuning::of(kind)).0
}

/// [`backtest`] with its knobs given; also the miss of "no change from now".
pub fn backtest_tuned(
    wins: &[Vec<Pt>],
    kind: Kind,
    tz: i64,
    tune: Tuning,
) -> (Backtest, Option<f64>) {
    backtest_scored(wins, kind, tz, tune, i64::MIN, i64::MAX)
}

/// [`backtest_tuned`] counting only the checks taken in `[from, to)` —
/// the table still holds every reading before each check.
pub fn backtest_scored(
    wins: &[Vec<Pt>],
    kind: Kind,
    tz: i64,
    tune: Tuning,
    from: i64,
    to: i64,
) -> (Backtest, Option<f64>) {
    // Every pair, by its end time, so the table only ever holds the past.
    let mut pairs: Vec<(Pt, Pt)> = wins
        .iter()
        .flat_map(|w| w.windows(2).map(|p| (p[0], p[1])))
        .collect();
    pairs.sort_by_key(|(_, b)| b.t);
    let mut checks: Vec<(usize, usize)> = Vec::new();
    for (wi, w) in wins.iter().enumerate() {
        let mut last_check: Option<i64> = None;
        for (pi, p) in w.iter().enumerate() {
            if last_check.is_some_and(|c| p.t - c < kind.check_every_ms()) || p.p >= 98.0 {
                continue;
            }
            let target = p.t + kind.horizon_ms();
            if w.last().is_some_and(|l| l.t >= target) {
                checks.push((wi, pi));
                last_check = Some(p.t);
            }
        }
    }
    checks.sort_by_key(|&(wi, pi)| wins[wi][pi].t);
    let mut table = Table::new(tz);
    let mut next_pair = 0;
    let (mut err, mut lin, mut flat, mut n) = (0.0, 0.0, 0.0, 0u32);
    for (wi, pi) in checks {
        let w = &wins[wi];
        let now = w[pi];
        if now.t < from || now.t >= to {
            continue;
        }
        while next_pair < pairs.len() && pairs[next_pair].1.t <= now.t {
            table.add_pair(pairs[next_pair].0, pairs[next_pair].1, kind);
            next_pair += 1;
        }
        let target = now.t + kind.horizon_ms();
        let Some(actual) = value_at(w, target) else {
            continue;
        };
        let upto = &w[..=pi];
        let recent = recent_rate_over(upto, now.t, tune.recent_ms);
        let pred = project_tuned(&table, now.t, now.p, target, recent, kind, tune).end_pct;
        let first = w[0];
        let line_rate = if now.t > first.t {
            (now.p - first.p).max(0.0) / ((now.t - first.t) as f64 / HOUR_MS as f64)
        } else {
            0.0
        };
        let line = (now.p + line_rate * kind.horizon_ms() as f64 / HOUR_MS as f64).min(100.0);
        err += (pred - actual).abs();
        lin += (line - actual).abs();
        flat += (now.p - actual).abs();
        n += 1;
    }
    (
        Backtest {
            err_pts: (n > 0).then(|| err / f64::from(n)),
            linear_err_pts: (n > 0).then(|| lin / f64::from(n)),
            checks: n,
        },
        (n > 0).then(|| flat / f64::from(n)),
    )
}

/// One window's pace, as the chip and `usagectl.py` show it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WindowPace {
    /// `five_hour` or `seven_day`.
    pub window: &'static str,
    pub pct: f64,
    /// When the reading was taken, unix ms.
    pub at_ms: i64,
    /// The window's reset, unix ms, when known.
    pub resets_at_ms: Option<i64>,
    /// Enough checks behind it to show a time ([`MIN_CHECKS`]).
    pub ready: bool,
    /// When it is expected to reach 80% and 100%, before the reset; `None`
    /// if not before it (or the reset is unknown and not within a window).
    pub at80_ms: Option<i64>,
    pub at100_ms: Option<i64>,
    /// The figure expected at the reset.
    pub end_pct: f64,
    /// What a check looks ahead, hours.
    pub horizon_hours: f64,
    pub backtest: Backtest,
    /// Readings of this window in the history.
    pub readings: u32,
    /// Hours of history behind the hour-of-week table.
    pub history_hours: f64,
}

/// Both windows' pace.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlanPace {
    pub five_hour: Option<WindowPace>,
    pub seven_day: Option<WindowPace>,
    pub computed_at_ms: i64,
    /// The knobs in use and when they were fitted (persisted in
    /// [`PACE_FILE`]; refitted weekly, [`needs_refit`]).
    pub fit: PaceFit,
}

/// One window's pace from the whole log, at `now`; `None` without a
/// reading of it.
pub fn window_pace(log: &[Logged], kind: Kind, now: i64, tz: i64) -> Option<WindowPace> {
    window_pace_tuned(log, kind, now, tz, Tuning::of(kind))
}

/// [`window_pace`] with the knobs given (the weekly fit's, [`PaceFit`]).
pub fn window_pace_tuned(
    log: &[Logged],
    kind: Kind,
    now: i64,
    tz: i64,
    tune: Tuning,
) -> Option<WindowPace> {
    let s = series(log, kind);
    let wins = windows(&s, kind);
    let open = wins.last()?;
    let cur = *open.last()?;
    // A reading past its own reset says nothing of the window now.
    if cur.reset.is_some_and(|r| r <= now) || now - cur.t > kind.len_ms() {
        return None;
    }
    let closed = &wins[..wins.len() - 1];
    let bt = backtest_tuned(closed, kind, tz, tune).0;
    let mut table = Table::new(tz);
    for w in &wins {
        for p in w.windows(2) {
            table.add_pair(p[0], p[1], kind);
        }
    }
    let until = cur
        .reset
        .unwrap_or_else(|| open[0].t + kind.len_ms())
        .max(now);
    let start = now.max(cur.t);
    let pr = project_tuned(
        &table,
        start,
        cur.p,
        until,
        recent_rate_over(open, cur.t, tune.recent_ms),
        kind,
        tune,
    );
    Some(WindowPace {
        window: kind.name(),
        pct: cur.p,
        at_ms: cur.t,
        resets_at_ms: cur.reset,
        ready: bt.checks >= min_checks(kind),
        at80_ms: pr.at80,
        at100_ms: pr.at100,
        end_pct: pr.end_pct,
        horizon_hours: kind.horizon_ms() as f64 / HOUR_MS as f64,
        backtest: bt,
        readings: s.len() as u32,
        history_hours: table.hours(),
    })
}

/// Both windows from the log.
pub fn pace_of(log: &[Logged], now: i64, tz: i64) -> PlanPace {
    pace_with_fit(log, now, tz, PaceFit::defaults(now))
}

/// Both windows from the log with the fitted knobs.
pub fn pace_with_fit(log: &[Logged], now: i64, tz: i64, fit: PaceFit) -> PlanPace {
    PlanPace {
        five_hour: window_pace_tuned(log, Kind::FiveHour, now, tz, fit.five_hour.tuning),
        seven_day: window_pace_tuned(log, Kind::Week, now, tz, fit.seven_day.tuning),
        computed_at_ms: now,
        fit,
    }
}

// ---- the weekly fit (his yes, 2026-11-16) ----------------------------------
//
// The two knobs — the weight on the hour-of-week figure and how far back
// "his rate right now" looks — re-tune themselves once a week from the
// log: every pair on a grid is back-tested over the last [`FIT_WEEKS`]
// weeks, fitted on the older checks and scored on the newest week (out of
// sample) when there are enough of each; the fitted pair is kept only if
// it does no worse than today's pair on that newest week. With fewer
// checks it fits in-sample on them all; thinner still, today's pair.

/// How far back the fit looks.
pub const FIT_WEEKS: i64 = 6;
/// How often it refits.
pub const REFIT_MS: i64 = 7 * 24 * HOUR_MS;
/// The grid: weights on the hour-of-week figure.
pub const SLOT_GRID: [f64; 5] = [0.25, 0.35, 0.5, 0.7, 1.0];
/// The grid: the recent window as a multiple of today's.
pub const RECENT_GRID: [f64; 4] = [0.5, 1.0, 2.0, 4.0];

/// One window's fitted knobs and the evidence for them (read back by
/// [`stored_fit`]).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct KindFit {
    /// The pair in use.
    pub tuning: Tuning,
    /// The pair the grid chose on the older checks (equal to `tuning`
    /// unless today's pair was kept).
    pub fitted: Tuning,
    /// When it was fitted, unix ms.
    pub fitted_at_ms: i64,
    /// `held-out`, `in-sample`, `default-thin` (too few checks) or
    /// `default-kept` (the fitted pair did worse on the newest week).
    pub how: &'static str,
    /// Checks the pair was chosen on, and scored on afterwards.
    pub fit_checks: u32,
    pub holdout_checks: u32,
    /// Mean miss on the newest week: the grid's pair (`fitted`) and today's.
    pub holdout_err_pts: Option<f64>,
    pub default_holdout_err_pts: Option<f64>,
}

/// Both windows' fits.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct PaceFit {
    pub five_hour: KindFit,
    pub seven_day: KindFit,
}

impl KindFit {
    fn default_at(kind: Kind, now: i64, how: &'static str) -> Self {
        Self {
            tuning: Tuning::of(kind),
            fitted: Tuning::of(kind),
            fitted_at_ms: now,
            how,
            fit_checks: 0,
            holdout_checks: 0,
            holdout_err_pts: None,
            default_holdout_err_pts: None,
        }
    }
}

impl PaceFit {
    /// Today's pair for both, unfitted.
    pub fn defaults(now: i64) -> Self {
        Self {
            five_hour: KindFit::default_at(Kind::FiveHour, now, "default-thin"),
            seven_day: KindFit::default_at(Kind::Week, now, "default-thin"),
        }
    }
}

/// Every pair on the grid for `kind`.
pub fn grid(kind: Kind) -> Vec<Tuning> {
    let base = Tuning::of(kind);
    let mut out = Vec::new();
    for &s in &SLOT_GRID {
        for &r in &RECENT_GRID {
            out.push(Tuning {
                slot_scale: s,
                recent_ms: (base.recent_ms as f64 * r) as i64,
                ..base
            });
        }
    }
    out
}

/// The pair with the lowest miss over checks in `[from, to)`, and its
/// result; ties keep the earlier (smaller) pair on the grid.
fn best_on(wins: &[Vec<Pt>], kind: Kind, tz: i64, from: i64, to: i64) -> (Tuning, Backtest) {
    let mut best: Option<(Tuning, Backtest)> = None;
    for t in grid(kind) {
        let (b, _) = backtest_scored(wins, kind, tz, t, from, to);
        let better = match (&best, b.err_pts) {
            (_, None) => false,
            (None, Some(_)) => true,
            (Some((_, bb)), Some(e)) => bb.err_pts.is_none_or(|be| e < be - 1e-9),
        };
        if better {
            best = Some((t, b));
        }
    }
    best.unwrap_or((Tuning::of(kind), Backtest::default()))
}

/// Fit one window's knobs from the log at `now`.
pub fn fit_kind(log: &[Logged], kind: Kind, now: i64, tz: i64) -> KindFit {
    let s = series(log, kind);
    let mut wins = windows(&s, kind);
    // Closed windows only (the open one has no answers yet), within the span.
    wins.pop();
    let span_from = now - FIT_WEEKS * 7 * 24 * HOUR_MS;
    wins.retain(|w| w.last().is_some_and(|l| l.t >= span_from));
    let base = Tuning::of(kind);
    let hold_from = now - 7 * 24 * HOUR_MS;
    let min = min_checks(kind);
    let fit_n = backtest_scored(&wins, kind, tz, base, span_from, hold_from)
        .0
        .checks;
    let hold_default = backtest_scored(&wins, kind, tz, base, hold_from, i64::MAX).0;
    if fit_n >= 2 * min && hold_default.checks >= min.div_ceil(2) {
        let (t, fitb) = best_on(&wins, kind, tz, span_from, hold_from);
        let hold = backtest_scored(&wins, kind, tz, t, hold_from, i64::MAX).0;
        let keep_fitted = match (hold.err_pts, hold_default.err_pts) {
            (Some(a), Some(b)) => a <= b + 1e-9,
            _ => false,
        };
        return KindFit {
            tuning: if keep_fitted { t } else { base },
            fitted: t,
            fitted_at_ms: now,
            how: if keep_fitted {
                "held-out"
            } else {
                "default-kept"
            },
            fit_checks: fitb.checks,
            holdout_checks: hold.checks,
            holdout_err_pts: hold.err_pts,
            default_holdout_err_pts: hold_default.err_pts,
        };
    }
    let all_n = backtest_scored(&wins, kind, tz, base, span_from, i64::MAX)
        .0
        .checks;
    if all_n >= 2 * min {
        let (t, b) = best_on(&wins, kind, tz, span_from, i64::MAX);
        return KindFit {
            tuning: t,
            fitted: t,
            fitted_at_ms: now,
            how: "in-sample",
            fit_checks: b.checks,
            holdout_checks: 0,
            holdout_err_pts: None,
            default_holdout_err_pts: None,
        };
    }
    KindFit::default_at(kind, now, "default-thin")
}

/// Both windows' fits.
pub fn fit_all(log: &[Logged], now: i64, tz: i64) -> PaceFit {
    PaceFit {
        five_hour: fit_kind(log, Kind::FiveHour, now, tz),
        seven_day: fit_kind(log, Kind::Week, now, tz),
    }
}

/// Whether a stored fit is due again: none, a week old, or from the future
/// (a clock change).
pub fn needs_refit(prev: Option<&KindFit>, now: i64) -> bool {
    prev.is_none_or(|f| now - f.fitted_at_ms >= REFIT_MS || f.fitted_at_ms > now)
}

/// A stored fit, read back from [`PACE_FILE`]'s text; `None` per window
/// when absent or unreadable.
pub fn stored_fit(text: &str) -> (Option<KindFit>, Option<KindFit>) {
    #[derive(Deserialize)]
    struct Stored {
        tuning: Tuning,
        #[serde(default)]
        fitted: Option<Tuning>,
        fitted_at_ms: i64,
        how: String,
        #[serde(default)]
        fit_checks: u32,
        #[serde(default)]
        holdout_checks: u32,
        #[serde(default)]
        holdout_err_pts: Option<f64>,
        #[serde(default)]
        default_holdout_err_pts: Option<f64>,
    }
    let v: serde_json::Value = serde_json::from_str(text).unwrap_or_default();
    let one = |k: &str| -> Option<KindFit> {
        let s: Stored = serde_json::from_value(v.get("fit")?.get(k)?.clone()).ok()?;
        let how: &'static str = match s.how.as_str() {
            "held-out" => "held-out",
            "in-sample" => "in-sample",
            "default-kept" => "default-kept",
            _ => "default-thin",
        };
        Some(KindFit {
            tuning: s.tuning,
            fitted: s.fitted.unwrap_or(s.tuning),
            fitted_at_ms: s.fitted_at_ms,
            how,
            fit_checks: s.fit_checks,
            holdout_checks: s.holdout_checks,
            holdout_err_pts: s.holdout_err_pts,
            default_holdout_err_pts: s.default_holdout_err_pts,
        })
    };
    (one("five_hour"), one("seven_day"))
}

/// The fit to use now: the stored one per window while under a week old,
/// else a fresh fit of that window.
pub fn current_fit(stored: &str, log: &[Logged], now: i64, tz: i64) -> PaceFit {
    let (fh, sd) = stored_fit(stored);
    PaceFit {
        five_hour: match fh {
            Some(f) if !needs_refit(Some(&f), now) => f,
            _ => fit_kind(log, Kind::FiveHour, now, tz),
        },
        seven_day: match sd {
            Some(f) if !needs_refit(Some(&f), now) => f,
            _ => fit_kind(log, Kind::Week, now, tz),
        },
    }
}

// ---- the log on disk -------------------------------------------------------

/// The lines of a log file; a bad line is skipped.
pub fn read_log_file(path: &Path) -> Vec<Logged> {
    std::fs::read_to_string(path)
        .map(|s| {
            s.lines()
                .filter_map(|l| serde_json::from_str(l).ok())
                .collect()
        })
        .unwrap_or_default()
}

/// The log and the import, merged, oldest first.
pub fn read_log_in(dir: &Path) -> Vec<Logged> {
    let mut all = read_log_file(&dir.join(LOG_FILE));
    all.extend(read_log_file(&dir.join(IMPORT_FILE)));
    all.sort_by_key(|l| l.t);
    all.dedup_by_key(|l| l.t);
    all
}

/// The seed for a new log: the Claude app's history and every chat's
/// reply readings (`turn-usage.jsonl`, start and end) under `dir`.
pub fn seed_in(dir: &Path, desktop: Option<&Path>) -> Vec<Logged> {
    let mut out = Vec::new();
    if let Some(p) = desktop {
        out.extend(desktop_samples(p));
    }
    for ask in ask_dirs(dir) {
        let Ok(chats) = std::fs::read_dir(&ask) else {
            continue;
        };
        for c in chats.flatten() {
            for line in crate::turn_usage::read_lines(&c.path()) {
                for (at, pick) in [(line.start_at_ms, 0), (line.end_at_ms, 1)] {
                    if at <= 0 {
                        continue;
                    }
                    let get = |s: Option<crate::turn_usage::Span>| {
                        s.map(|s| if pick == 0 { s.start } else { s.end })
                    };
                    let (fh, sd) = (get(line.five_hour), get(line.seven_day));
                    if fh.is_some() || sd.is_some() {
                        out.push(Logged {
                            t: at,
                            fh,
                            fr: None,
                            sd,
                            sr: None,
                        });
                    }
                }
            }
        }
    }
    out.sort_by_key(|l| l.t);
    out.dedup_by_key(|l| l.t);
    out
}

/// `<dir>/<x>/sessions/ask` and `<dir>/projects/<x>/sessions/ask`.
fn ask_dirs(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut tops = vec![dir.to_path_buf()];
    if let Ok(rd) = std::fs::read_dir(dir.join("projects")) {
        tops.extend(rd.flatten().map(|e| e.path()));
    }
    for top in tops {
        if let Ok(rd) = std::fs::read_dir(&top) {
            for e in rd.flatten() {
                let ask = e.path().join("sessions").join("ask");
                if ask.is_dir() {
                    out.push(ask);
                }
            }
        }
        let ask = top.join("sessions").join("ask");
        if ask.is_dir() {
            out.push(ask);
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Every sample of the Claude app's `plan-usage-history.json`.
fn desktop_samples(path: &Path) -> Vec<Logged> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    let num = |u: &serde_json::Value, k: &str| u.get(k).and_then(serde_json::Value::as_f64);
    v.get("samples")
        .and_then(serde_json::Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|s| {
                    let u = s.get("u")?;
                    Some(Logged {
                        t: s.get("t")?.as_i64()?,
                        fh: num(u, "fh"),
                        fr: None,
                        sd: num(u, "sd"),
                        sr: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn append(path: &Path, lines: &[Logged]) {
    use std::io::Write as _;
    if let Some(d) = path.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    else {
        return;
    };
    for l in lines {
        if let Ok(s) = serde_json::to_string(l) {
            let _ = writeln!(f, "{s}");
        }
    }
}

/// Whether `r` adds anything after `last`: a changed figure or reset, or
/// ten minutes since (so an idle stretch is on record as idle).
pub fn worth_logging(last: Option<&Logged>, r: &Logged) -> bool {
    match last {
        None => true,
        Some(l) => {
            r.t > l.t
                && (r.fh != l.fh
                    || r.sd != l.sd
                    || (r.fr.is_some() && r.fr != l.fr)
                    || (r.sr.is_some() && r.sr != l.sr)
                    || r.t - l.t >= 10 * MIN_MS)
        }
    }
}

/// Record a reading in `dir`'s log, seeding the log the first time.
pub fn record_in(dir: &Path, desktop: Option<&Path>, last: &mut Option<Logged>, r: Logged) {
    let path = dir.join(LOG_FILE);
    if last.is_none() {
        if path.exists() {
            *last = read_log_file(&path).last().copied();
        } else {
            let seed = seed_in(dir, desktop);
            append(&path, &seed);
            *last = seed.last().copied();
        }
    }
    if worth_logging(last.as_ref(), &r) {
        append(&path, &[r]);
        *last = Some(r);
    }
}

static LAST: Mutex<Option<Logged>> = Mutex::new(None);

fn desktop_path() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .map(|h| Path::new(&h).join(crate::plan_usage::DESKTOP_SAMPLE))
}

/// A reading arrived ([`crate::turn_usage::reading`]): log it. Never in a
/// unit test — the real `~/.nightloom` is not the suite's.
pub fn record(r: &crate::turn_usage::Reading) {
    if cfg!(test) || r.at_ms <= 0 {
        return;
    }
    let Some(dir) = crate::project::config_dir() else {
        return;
    };
    let mut last = LAST.lock().unwrap_or_else(|e| e.into_inner());
    record_in(&dir, desktop_path().as_deref(), &mut last, Logged::from(r));
}

/// The local zone's offset from UTC now, seconds.
pub fn local_offset_secs() -> i64 {
    i64::from(chrono::Local::now().offset().local_minus_utc())
}

/// The pace now, from the log; written to [`PACE_FILE`] for `usagectl.py`.
pub fn read() -> PlanPace {
    let now = chrono::Utc::now().timestamp_millis();
    let Some(dir) = crate::project::config_dir() else {
        return pace_of(&[], now, 0);
    };
    let log = read_log_in(&dir);
    let tz = local_offset_secs();
    let stored = std::fs::read_to_string(dir.join(PACE_FILE)).unwrap_or_default();
    let fit = current_fit(&stored, &log, now, tz);
    let pace = pace_with_fit(&log, now, tz, fit);
    if let Ok(s) = serde_json::to_string_pretty(&pace) {
        let tmp = dir.join(format!("{PACE_FILE}.tmp"));
        if std::fs::write(&tmp, s).is_ok() {
            let _ = std::fs::rename(&tmp, dir.join(PACE_FILE));
        }
    }
    pace
}

#[cfg(test)]
#[path = "pace_tests.rs"]
mod tests;
