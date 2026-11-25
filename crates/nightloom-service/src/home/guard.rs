//! Home's spend guard (nightshift item 763, H6): an unattended Home run —
//! the morning scan, any job in Home's project — does not start when
//! either plan window is at [`STOP_AT`] percent or more, when the pace
//! says a window reaches 100% before it resets, or when Home's runs have
//! already used today's cap of the week (blocker 2041: 1% a day). Its job
//! row says why; a skipped scan writes its code-only page.
//!
//! Items 950–953 (948's report): the guard decides on a reading refreshed
//! at the start ([`GUARD_MAX_AGE`]); a reading still stale stops the run
//! and says how old it was; every skip line names the reading's figure in
//! the past tense with its sample time on his clock and its source; the
//! pace skips on its own only when its forecast, within the horizon it
//! was measured over, clears its own measured error ([`pace_may_skip`]).
//!
//! Today's spend is `home/spend.json`: his local date and the points of
//! the week Home's runs moved the plan's figure by that day (whole
//! percents, as the jobs list measures each run). The cap is
//! `home/guard.json` (`{"cap": 1.0}`), [`DEFAULT_CAP`] when absent.

use std::path::Path;

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};

use crate::pace::{PlanPace, WindowPace};
use crate::plan_usage::PlanUsage;

/// Either window at this percent or more stops unattended Home runs.
pub const STOP_AT: u8 = 80;
/// Percent of the week Home's unattended runs may use a day (blocker 2041).
pub const DEFAULT_CAP: f64 = 1.0;

const SPEND_FILE: &str = "spend.json";
const GUARD_FILE: &str = "guard.json";

/// What Home's unattended runs spent on one local day.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Spend {
    pub date: Option<NaiveDate>,
    /// Percent of the weekly window.
    pub points: f64,
    pub runs: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Settings {
    #[serde(default)]
    cap: Option<f64>,
}

/// `GET /api/home/today` and the Mac's Home header.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Today {
    /// Percent of the week Home's unattended runs used today.
    pub points: f64,
    pub cap: f64,
    pub week: Option<u8>,
    pub five_hour: Option<u8>,
    /// Why unattended Home runs are stopped now, in his words.
    pub stop: Option<String>,
}

/// The daily cap, percent of the week.
pub fn cap(config: &Path) -> f64 {
    std::fs::read_to_string(super::dir_in(config).join(GUARD_FILE))
        .ok()
        .and_then(|t| serde_json::from_str::<Settings>(&t).ok())
        .and_then(|s| s.cap)
        .filter(|c| c.is_finite() && *c >= 0.0)
        .unwrap_or(DEFAULT_CAP)
}

/// Today's spend (`today` is his local date); a file of another day reads
/// as nothing spent.
pub fn spent(config: &Path, today: NaiveDate) -> Spend {
    let s: Spend = std::fs::read_to_string(super::dir_in(config).join(SPEND_FILE))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    if s.date == Some(today) {
        s
    } else {
        Spend {
            date: Some(today),
            ..Spend::default()
        }
    }
}

/// Add one finished run's points to today's spend.
pub fn record(config: &Path, today: NaiveDate, points: Option<u8>) {
    let mut s = spent(config, today);
    s.points += f64::from(points.unwrap_or(0));
    s.runs += 1;
    let Ok(dir) = super::ensure_folder(config) else {
        return;
    };
    if let Ok(text) = serde_json::to_string_pretty(&s) {
        let tmp = dir.join(format!("{SPEND_FILE}.tmp"));
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, dir.join(SPEND_FILE));
        }
    }
}

/// The pace from `config`'s own usage log, on its stored fit — the chip's.
pub fn pace_in(config: &Path, now: chrono::DateTime<chrono::Utc>) -> PlanPace {
    let log = crate::pace::read_log_in(config);
    let (ms, tz) = (now.timestamp_millis(), crate::pace::local_offset_secs());
    let stored = std::fs::read_to_string(config.join(crate::pace::PACE_FILE)).unwrap_or_default();
    let fit = crate::pace::current_fit(&stored, &log, ms, tz);
    crate::pace::pace_with_fit(&log, ms, tz, fit)
}

/// Item 951: how old Home's guard lets a reading be before it refreshes
/// (the shared `/usage` run, at most once a minute machine-wide).
pub const GUARD_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(120);

/// Item 951: the reading a guard decision used, kept on the job's row
/// (`{value, sampled_at, source}`), so a skip can be checked later.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct GuardReading {
    pub five_hour: Option<u8>,
    pub week: Option<u8>,
    /// When the reading was sampled (not when it was read).
    pub sampled_at: Option<DateTime<Utc>>,
    /// `cli-cache`, `cli-usage`, `desktop`, `none` (`plan_usage`'s).
    pub source: String,
}

impl GuardReading {
    pub fn of(plan: Option<&PlanUsage>) -> Self {
        match plan {
            Some(p) => Self {
                five_hour: p.five_hour,
                week: p.seven_day,
                sampled_at: p
                    .sampled_at_ms
                    .and_then(chrono::DateTime::<Utc>::from_timestamp_millis),
                source: if p.source.is_empty() {
                    "none".into()
                } else {
                    p.source.clone()
                },
            },
            None => Self {
                source: "none".into(),
                ..Self::default()
            },
        }
    }
}

/// Item 951: no figure at all — no reading on this machine (the away
/// server: the plan lives on the Mac) or the host did not answer. The
/// 80% stop cannot be checked; the run says so on its row.
pub fn reading_missing(plan: Option<&PlanUsage>) -> bool {
    plan.is_none_or(|p| p.five_hour.is_none() && p.seven_day.is_none())
}

/// A reading's source in his words.
pub fn source_words(source: &str) -> Option<&'static str> {
    match source {
        "cli-cache" => Some("Claude Code's usage cache"),
        "cli-usage" => Some("a /usage run"),
        "desktop" => Some("the Claude app's record"),
        "turn" => Some("a chat's last reply"),
        _ => None,
    }
}

/// `at` on his clock, 12-hour: "7:55 AM".
pub fn clock(at: DateTime<Utc>, zone: &jiff::tz::TimeZone) -> String {
    jiff::Timestamp::from_millisecond(at.timestamp_millis())
        .map(|ts| ts.to_zoned(zone.clone()).strftime("%-I:%M %p").to_string())
        .unwrap_or_else(|_| at.format("%H:%M UTC").to_string())
}

fn same_local_day(a: DateTime<Utc>, b: DateTime<Utc>, zone: &jiff::tz::TimeZone) -> bool {
    let day = |t: DateTime<Utc>| {
        jiff::Timestamp::from_millisecond(t.timestamp_millis())
            .ok()
            .map(|ts| ts.to_zoned(zone.clone()).date())
    };
    day(a) == day(b)
}

/// "41 min", "3 h".
fn age_words(secs: f64) -> String {
    let min = (secs / 60.0).round().max(0.0) as i64;
    if min < 120 {
        format!("{min} min")
    } else if min < 48 * 60 {
        format!("{} h", (min as f64 / 60.0).round() as i64)
    } else {
        // Item 947: a weekly margin is days, not "100 h".
        format!("{} days", (min as f64 / 1440.0).round() as i64)
    }
}

/// Item 950: the reading's past tense with its time and source: "the
/// weekly window was at 91% at 7:55 AM (Claude Code's usage cache)".
fn window_words(name: &str, n: u8, p: &PlanUsage, zone: &jiff::tz::TimeZone) -> String {
    let mut out = format!("the {name} window was at {n}%");
    if let Some(at) = p
        .sampled_at_ms
        .and_then(chrono::DateTime::<Utc>::from_timestamp_millis)
    {
        out.push_str(&format!(" at {}", clock(at, zone)));
    }
    if let Some(src) = source_words(&p.source) {
        out.push_str(&format!(" ({src})"));
    }
    out
}

/// Item 953: whether the pace may skip a run on its own. Its forecast is
/// trusted only as far as it was measured: the 100% crossing must fall
/// within the horizon its backtest scored (24 h for the week, 1 h for the
/// 5-hour window), and before the reset by more than its measured mean
/// miss is worth at the forecast's own rate — `(reset − at100) × rate >
/// err_pts`. No measured error, no reset time, or not ready: it advises
/// only. `Some((at100, reset, err))` when it may skip.
pub fn pace_may_skip(w: &WindowPace, now_ms: i64) -> Option<(i64, i64, f64)> {
    if !w.ready {
        return None;
    }
    let (at100, reset, err) = (w.at100_ms?, w.resets_at_ms?, w.backtest.err_pts?);
    let horizon_ms = (w.horizon_hours * 3_600_000.0) as i64;
    if at100 > now_ms + horizon_ms || at100 >= reset {
        return None;
    }
    let margin = if at100 <= w.at_ms {
        f64::INFINITY
    } else {
        let rate = (100.0 - w.pct).max(0.0) / (at100 - w.at_ms) as f64;
        (reset - at100) as f64 * rate
    };
    (margin > err).then_some((at100, reset, err))
}

/// Why an unattended Home run must not start now; `None` lets it run.
/// Checked in order: the reading (item 951: a stale one stops it), the
/// windows, the pace (item 953), the cap. Times on `zone`'s clock.
pub fn stop_reason(
    plan: Option<&PlanUsage>,
    pace: Option<&PlanPace>,
    spent: f64,
    cap: f64,
    now: DateTime<Utc>,
    zone: &jiff::tz::TimeZone,
) -> Option<String> {
    if let Some(p) = plan.filter(|_| !reading_missing(plan)) {
        if p.stale {
            return Some(match p.age_seconds {
                Some(a) => format!(
                    "usage could not be read (last reading {} old)",
                    age_words(a)
                ),
                None => "usage could not be read".into(),
            });
        }
        if let Some(n) = p.five_hour.filter(|n| *n >= STOP_AT) {
            return Some(window_words("5-hour", n, p, zone));
        }
        if let Some(n) = p.seven_day.filter(|n| *n >= STOP_AT) {
            return Some(window_words("weekly", n, p, zone));
        }
    }
    if let Some(pace) = pace {
        for (w, name) in [(&pace.five_hour, "5-hour"), (&pace.seven_day, "weekly")] {
            let Some(w) = w.as_ref() else { continue };
            if let Some((at100, reset, err)) = pace_may_skip(w, now.timestamp_millis()) {
                let at = chrono::DateTime::<Utc>::from_timestamp_millis(at100).unwrap_or(now);
                let day = if same_local_day(at, now, zone) {
                    ""
                } else {
                    " tomorrow"
                };
                let before = age_words((reset - at100) as f64 / 1000.0);
                return Some(format!(
                    "at this pace the {name} window reaches 100% by {}{day}, {before} before it resets (the forecast misses by {err:.1} points on average)",
                    clock(at, zone)
                ));
            }
        }
    }
    if spent >= cap {
        return Some(format!(
            "Home has used today's {} of the week",
            percent_words(cap)
        ));
    }
    None
}

/// "1%", "0.5%".
pub fn percent_words(p: f64) -> String {
    let r = (p * 10.0).round() / 10.0;
    if r.fract() == 0.0 {
        format!("{r:.0}%")
    } else {
        format!("{r:.1}%")
    }
}

/// Today's figures and whether runs are stopped.
pub fn today(
    config: &Path,
    plan: Option<&PlanUsage>,
    pace: Option<&PlanPace>,
    date: NaiveDate,
) -> Today {
    let s = spent(config, date);
    let cap = cap(config);
    Today {
        points: s.points,
        cap,
        week: plan.and_then(|p| p.seven_day),
        five_hour: plan.and_then(|p| p.five_hour),
        stop: stop_reason(
            plan,
            pace,
            s.points,
            cap,
            Utc::now(),
            &jiff::tz::TimeZone::system(),
        ),
    }
}

/// A skipped scan's code-only page: `scans/<date>.md` with its
/// `Skipped: <why>` line (the phone's card reads it) and the facts the
/// scan would have sent, and its feed row. Never over a page a run wrote.
pub fn skipped_scan_page(
    config: &Path,
    date: NaiveDate,
    why: &str,
    facts: &str,
    now: chrono::DateTime<chrono::Utc>,
) -> Result<(), String> {
    let dir = super::ensure_folder(config).map_err(|e| e.to_string())?;
    let scans = dir.join("scans");
    let _ = std::fs::create_dir_all(&scans);
    let path = scans.join(format!("{date}.md"));
    if path.is_file() {
        return Ok(());
    }
    std::fs::write(
        &path,
        format!(
            "# Morning scan — {date}\n\nSkipped: {why}\n\nThis page is the facts alone, collected in code — no model read them.\n\n{facts}\n"
        ),
    )
    .map_err(|e| e.to_string())?;
    super::append(
        config,
        &super::FeedRow {
            at: now,
            kind: "scan".into(),
            label: Some(super::NAME.into()),
            chat: None,
            project: None,
            line: format!("Morning scan skipped — {why}"),
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pace::{PaceFit, WindowPace};

    fn plan(five: u8, week: u8) -> PlanUsage {
        PlanUsage {
            five_hour: Some(five),
            seven_day: Some(week),
            ..PlanUsage::default()
        }
    }

    fn window(name: &'static str, at100: Option<i64>, ready: bool) -> WindowPace {
        WindowPace {
            window: name,
            pct: 50.0,
            at_ms: 0,
            resets_at_ms: Some(1),
            ready,
            at80_ms: None,
            at100_ms: at100,
            end_pct: 50.0,
            horizon_hours: 1.0,
            backtest: Default::default(),
            readings: 10,
            history_hours: 10.0,
        }
    }

    fn pace(five: Option<WindowPace>, week: Option<WindowPace>) -> PlanPace {
        PlanPace {
            five_hour: five,
            seven_day: week,
            computed_at_ms: 0,
            fit: PaceFit::defaults(0),
        }
    }

    fn pst() -> jiff::tz::TimeZone {
        jiff::tz::TimeZone::fixed(jiff::tz::Offset::from_hours(-8).unwrap())
    }

    fn at(rfc: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(rfc)
            .unwrap()
            .with_timezone(&Utc)
    }

    /// No reading time or source: the fake reading of the tests.
    fn stop(plan: Option<&PlanUsage>, pace: Option<&PlanPace>) -> Option<String> {
        stop_reason(plan, pace, 0.0, 1.0, at("2026-11-24T16:00:14Z"), &pst())
    }

    /// Item 947: ages read in minutes, hours, then days.
    #[test]
    fn ages_read_in_minutes_hours_then_days() {
        assert_eq!(age_words(41.0 * 60.0), "41 min");
        assert_eq!(age_words(3.0 * 3600.0), "3 h");
        assert_eq!(age_words(47.0 * 3600.0), "47 h");
        assert_eq!(age_words(100.0 * 3600.0), "4 days");
    }

    #[test]
    fn the_five_hour_window_at_80_stops_a_run() {
        assert_eq!(
            stop(Some(&plan(80, 10)), None).as_deref(),
            Some("the 5-hour window was at 80%")
        );
        assert_eq!(stop(Some(&plan(79, 10)), None), None);
    }

    #[test]
    fn the_weekly_window_at_80_stops_a_run() {
        assert_eq!(
            stop(Some(&plan(10, 91)), None).as_deref(),
            Some("the weekly window was at 91%")
        );
    }

    /// Item 950: the Nov 24 skip as it is now worded — past tense, the
    /// sample's time on his clock, and where it was read.
    #[test]
    fn a_skip_says_when_its_reading_was_taken_and_where() {
        let p = PlanUsage {
            sampled_at_ms: Some(at("2026-11-24T15:55:34Z").timestamp_millis()),
            age_seconds: Some(280.0),
            source: "cli-cache".into(),
            ..plan(0, 91)
        };
        assert_eq!(
            stop(Some(&p), None).as_deref(),
            Some("the weekly window was at 91% at 7:55 AM (Claude Code's usage cache)")
        );
        let run = PlanUsage {
            source: "cli-usage".into(),
            ..p.clone()
        };
        assert!(stop(Some(&run), None).unwrap().ends_with("(a /usage run)"));
    }

    /// Item 951: a stale reading stops the run and says how old it was;
    /// a missing one (no figure at all) cannot stop it.
    #[test]
    fn a_stale_reading_stops_a_run_with_its_age_and_a_missing_one_does_not() {
        let stale = PlanUsage {
            stale: true,
            age_seconds: Some(41.0 * 60.0),
            ..plan(10, 50)
        };
        assert_eq!(
            stop(Some(&stale), None).as_deref(),
            Some("usage could not be read (last reading 41 min old)")
        );
        let old = PlanUsage {
            age_seconds: Some(5.0 * 3600.0),
            ..stale.clone()
        };
        assert_eq!(
            stop(Some(&old), None).as_deref(),
            Some("usage could not be read (last reading 5 h old)")
        );
        let none = PlanUsage {
            stale: true,
            source: "none".into(),
            ..PlanUsage::default()
        };
        assert!(reading_missing(Some(&none)) && reading_missing(None));
        assert_eq!(stop(Some(&none), None), None);
        assert_eq!(stop(None, None), None);
        assert_eq!(GuardReading::of(None).source, "none");
        let r = GuardReading::of(Some(&PlanUsage {
            sampled_at_ms: Some(at("2026-11-24T15:55:34Z").timestamp_millis()),
            source: "cli-cache".into(),
            ..plan(0, 91)
        }));
        assert_eq!(
            (r.week, r.sampled_at, r.source.as_str()),
            (Some(91), Some(at("2026-11-24T15:55:34Z")), "cli-cache")
        );
    }

    #[test]
    fn a_bad_pace_stops_a_run_only_once_the_pace_is_ready() {
        // At100 5 ms after a reading at 50%, reset at 1 h, error 1 point.
        let mut w = window("seven_day", Some(5), true);
        w.resets_at_ms = Some(3_600_000);
        w.backtest.err_pts = Some(1.0);
        let now = DateTime::<Utc>::from_timestamp_millis(0).unwrap();
        let reason = stop_reason(
            Some(&plan(10, 50)),
            Some(&pace(None, Some(w.clone()))),
            0.0,
            1.0,
            now,
            &pst(),
        );
        assert_eq!(
            reason.as_deref(),
            Some(
                "at this pace the weekly window reaches 100% by 4:00 PM, 60 min before it resets (the forecast misses by 1.0 points on average)"
            )
        );
        let unready = pace(Some(window("five_hour", Some(5), false)), None);
        assert_eq!(stop(None, Some(&unready)), None);
        let fine = pace(Some(window("five_hour", None, true)), None);
        assert_eq!(stop(None, Some(&fine)), None);
        // No measured error: the pace advises only.
        let mut unmeasured = w.clone();
        unmeasured.backtest.err_pts = None;
        assert_eq!(pace_may_skip(&unmeasured, 0), None);
    }

    /// Item 953, from the logged figures: the weekly pace at each morning
    /// scan's 8:00 AM PST start, Nov 19–23 (the five skipped "at this
    /// pace the weekly window runs out before it resets"), as
    /// `pace_with_fit` computes it from `~/.nightloom/plan-readings.jsonl`
    /// cut at that minute (948's report; err 8.2 points over 66 checks).
    /// The week ended near 98%, not 100%: none of the five may skip now.
    #[test]
    fn the_pace_alone_would_not_have_skipped_the_nov_19_to_23_scans() {
        const RESET: i64 = 1_795_600_800_000;
        // (day, now, reading at, pct, at100, err)
        let days: [(u32, i64, i64, f64, i64, f64); 5] = [
            (
                19,
                1_795_104_014_000,
                1_795_103_720_892,
                46.0,
                1_795_586_869_658,
                8.220_384_824_089_091,
            ),
            (
                20,
                1_795_190_414_000,
                1_795_189_927_652,
                64.0,
                1_795_535_710_440,
                8.220_384_824_089_091,
            ),
            (
                21,
                1_795_276_814_000,
                1_795_242_699_284,
                67.0,
                1_795_478_708_210,
                8.230_854_840_702_824,
            ),
            (
                22,
                1_795_363_214_000,
                1_795_242_699_284,
                67.0,
                1_795_508_937_784,
                8.230_854_840_702_824,
            ),
            (
                23,
                1_795_449_614_000,
                1_795_449_281_246,
                76.0,
                1_795_570_157_858,
                8.230_854_840_702_824,
            ),
        ];
        for (day, now, at_ms, pct, at100, err) in days {
            let mut w = window("seven_day", Some(at100), true);
            w.pct = pct;
            w.at_ms = at_ms;
            w.resets_at_ms = Some(RESET);
            w.horizon_hours = 24.0;
            w.end_pct = 100.0;
            w.backtest.err_pts = Some(err);
            w.backtest.checks = 66;
            assert_eq!(pace_may_skip(&w, now), None, "Nov {day}");
            let p = pace(None, Some(w));
            let n = DateTime::<Utc>::from_timestamp_millis(now).unwrap();
            assert_eq!(
                stop_reason(Some(&plan(0, pct as u8)), Some(&p), 0.0, 1.0, n, &pst()),
                None,
                "Nov {day}"
            );
        }
        // The same week, a crossing 10 h ahead and 14 h before the reset at
        // 0.9 points an hour: 12.6 points of room, more than its error.
        let mut w = window("seven_day", None, true);
        let now = RESET - 24 * 3_600_000;
        (w.pct, w.at_ms, w.resets_at_ms) = (91.0, now, Some(RESET));
        w.at100_ms = Some(now + 10 * 3_600_000);
        (w.horizon_hours, w.backtest.err_pts) = (24.0, Some(8.23));
        assert!(pace_may_skip(&w, now).is_some());
    }

    #[test]
    fn the_daily_cap_stops_a_run_and_a_new_day_starts_at_nothing() {
        let d = std::env::temp_dir().join(format!("nl-guard-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let day = NaiveDate::from_ymd_opt(2026, 11, 17).unwrap();
        assert_eq!(cap(&d), DEFAULT_CAP);
        record(&d, day, Some(1));
        let t = today(&d, Some(&plan(10, 10)), None, day);
        assert_eq!(t.points, 1.0);
        assert_eq!(
            t.stop.as_deref(),
            Some("Home has used today's 1% of the week")
        );
        let next = day.succ_opt().unwrap();
        assert_eq!(spent(&d, next).points, 0.0);
        assert_eq!(today(&d, Some(&plan(10, 10)), None, next).stop, None);
        std::fs::write(super::super::dir_in(&d).join(GUARD_FILE), r#"{"cap":2.5}"#).unwrap();
        assert_eq!(cap(&d), 2.5);
        assert_eq!(today(&d, None, None, day).stop, None);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Item 950: the page, the feed row and the phone's card (the page's
    /// `Skipped:` line, as `GET /home/scan` reads it) carry the reading's
    /// value, its time on his clock and its source.
    #[test]
    fn a_skipped_scans_page_feed_row_and_phone_card_say_when_and_where() {
        let d = std::env::temp_dir().join(format!("nl-guard-950-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let p = PlanUsage {
            sampled_at_ms: Some(at("2026-11-24T15:55:34Z").timestamp_millis()),
            source: "cli-cache".into(),
            ..plan(0, 91)
        };
        let why = stop(Some(&p), None).unwrap();
        let day = NaiveDate::from_ymd_opt(2026, 11, 24).unwrap();
        skipped_scan_page(&d, day, &why, "facts", at("2026-11-24T16:00:14Z")).unwrap();
        let want = "the weekly window was at 91% at 7:55 AM (Claude Code's usage cache)";
        let page =
            std::fs::read_to_string(super::super::dir_in(&d).join("scans/2026-11-24.md")).unwrap();
        assert!(page.contains(&format!("Skipped: {want}\n")));
        let feed = super::super::read_feed(&d);
        assert_eq!(
            feed.last().map(|r| r.line.as_str()),
            Some(format!("Morning scan skipped — {want}").as_str())
        );
        assert_eq!(
            crate::remote::skipped_line_for_tests(&page).as_deref(),
            Some(want)
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_skipped_scan_writes_its_code_only_page_once() {
        let d = std::env::temp_dir().join(format!("nl-guard-page-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        let day = NaiveDate::from_ymd_opt(2026, 11, 17).unwrap();
        let now = chrono::Utc::now();
        skipped_scan_page(&d, day, "the weekly window is at 85%", "facts here", now).unwrap();
        let path = super::super::dir_in(&d).join("scans/2026-11-17.md");
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("Skipped: the weekly window is at 85%\n"));
        assert!(text.contains("facts here"));
        skipped_scan_page(&d, day, "other", "x", now).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
        let _ = std::fs::remove_dir_all(&d);
    }
}
