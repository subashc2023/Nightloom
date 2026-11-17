//! Home's spend guard (nightshift item 763, H6): an unattended Home run —
//! the morning scan, any job in Home's project — does not start when
//! either plan window is at [`STOP_AT`] percent or more, when the pace
//! says a window reaches 100% before it resets, or when Home's runs have
//! already used today's cap of the week (blocker 2041: 1% a day). Its job
//! row says why; a skipped scan writes its code-only page.
//!
//! Today's spend is `home/spend.json`: his local date and the points of
//! the week Home's runs moved the plan's figure by that day (whole
//! percents, as the jobs list measures each run). The cap is
//! `home/guard.json` (`{"cap": 1.0}`), [`DEFAULT_CAP`] when absent.

use std::path::Path;

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

use crate::pace::PlanPace;
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

/// Why an unattended Home run must not start now; `None` lets it run.
/// Checked in order: the windows, the pace, the cap.
pub fn stop_reason(
    plan: Option<&PlanUsage>,
    pace: Option<&PlanPace>,
    spent: f64,
    cap: f64,
) -> Option<String> {
    if let Some(p) = plan.filter(|p| !p.stale) {
        if let Some(n) = p.five_hour.filter(|n| *n >= STOP_AT) {
            return Some(format!("the 5-hour window is at {n}%"));
        }
        if let Some(n) = p.seven_day.filter(|n| *n >= STOP_AT) {
            return Some(format!("the weekly window is at {n}%"));
        }
    }
    if let Some(pace) = pace {
        for (w, name) in [(&pace.five_hour, "5-hour"), (&pace.seven_day, "weekly")] {
            if w.as_ref().is_some_and(|w| w.ready && w.at100_ms.is_some()) {
                return Some(format!(
                    "at this pace the {name} window runs out before it resets"
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
        stop: stop_reason(plan, pace, s.points, cap),
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

    #[test]
    fn the_five_hour_window_at_80_stops_a_run() {
        assert_eq!(
            stop_reason(Some(&plan(80, 10)), None, 0.0, 1.0).as_deref(),
            Some("the 5-hour window is at 80%")
        );
        assert_eq!(stop_reason(Some(&plan(79, 10)), None, 0.0, 1.0), None);
    }

    #[test]
    fn the_weekly_window_at_80_stops_a_run() {
        assert_eq!(
            stop_reason(Some(&plan(10, 91)), None, 0.0, 1.0).as_deref(),
            Some("the weekly window is at 91%")
        );
    }

    #[test]
    fn a_bad_pace_stops_a_run_only_once_the_pace_is_ready() {
        let bad = pace(None, Some(window("seven_day", Some(5), true)));
        assert_eq!(
            stop_reason(Some(&plan(10, 50)), Some(&bad), 0.0, 1.0).as_deref(),
            Some("at this pace the weekly window runs out before it resets")
        );
        let unready = pace(Some(window("five_hour", Some(5), false)), None);
        assert_eq!(stop_reason(None, Some(&unready), 0.0, 1.0), None);
        let fine = pace(Some(window("five_hour", None, true)), None);
        assert_eq!(stop_reason(None, Some(&fine), 0.0, 1.0), None);
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
