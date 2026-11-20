//! Recurring jobs (nightshift item 746): a message that sends itself
//! "every morning", "every 2 hours", "every Monday at 9am", set up from
//! the phone, each run in the job's own chat.
//!
//! - **The schedule** ([`Every`]): parsed from his words ([`Every::parse`])
//!   and kept as data; the next run is pure arithmetic over the job's own
//!   time zone ([`Every::next_in`]) — the phone's IANA zone when it was
//!   saved (item 780), so "8:00 AM" stays 8:00 AM across daylight saving
//!   and the away server (whose clock is UTC) runs it at his 8:00 AM. A
//!   job saved before zones were kept moves to the host's zone when that
//!   zone had its offset ([`Jobs::open`]), else to the phone's on its next
//!   look, and keeps its fixed offset until then.
//! - **The store** (`jobs.json` in `<home>/remote/jobs/`, mode 0600): every
//!   job, its next run, its last result and what it cost. A deleted job
//!   moves to `trash.json` beside it, never erased.
//! - **The clock** ([`run_loop`], one per listener): every [`TICK`] it
//!   finishes the runs that ended and starts the ones due ([`Jobs::tick`]).
//!   A job due while the host was off runs once when it is back, not once
//!   per missed time.
//! - **Read-only unless he approved its plan**: a job's chat is a Claude
//!   Code chat held under the Chat policy (`ChatKind::Chat` over a Build
//!   declaration: reads, search and the web; the shell, the file-editing
//!   tools and subagents are refused by hook) until he approves it:
//!   **Approve once** (the next run may write, then it asks again) or
//!   **Approve always** (every run may write until the message changes,
//!   or he takes it back) — item 780. A read-only run the hook refused a
//!   change is recorded ([`Job::wanted`]) and pushed, so the approval card
//!   asks at the moment the job wanted to write; approving from that card
//!   runs it again at once. The host sets the kind before every run
//!   ([`Host::job_prepare`]), so a kind switched by hand does not stick.
//! - **The cost**: the weekly window's percent just before the run and
//!   just after it ended ([`LastRun::week_points`]), and their sum since
//!   the window last reset ([`WeekCost`]). Whole percents, as the plan
//!   reports them — other work running at the same time is counted in.
//! - **The result as a push**: the run is a turn in the job's chat, and
//!   the host pushes every turn's end (item 739) — the chat's name (the
//!   job's title) and "Finished" or "Failed", never the reply. The reply's
//!   first lines are kept here ([`LastRun::summary`]) for the Jobs list,
//!   which the phone reads over its own authenticated API.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Datelike, Duration, NaiveDate, Timelike, Utc};
use serde::{Deserialize, Serialize};

use crate::plan_usage::PlanUsage;
use crate::remote::api::NOT_AVAILABLE;
use crate::remote::{Handed, Host};

/// How often the clock looks.
pub const TICK: std::time::Duration = std::time::Duration::from_secs(30);
/// The shortest interval a job may have.
pub const MIN_MINUTES: u32 = 15;
/// The most jobs one host keeps.
pub const MAX_JOBS: usize = 40;
/// A run that could not start is tried again this much later.
const RETRY_SECS: i64 = 60;
/// … and this much later while the plan's limit is reached.
const LIMIT_RETRY_SECS: i64 = 600;
/// A run is not looked for in the running list before this (the host may
/// not list it yet).
const RUN_GRACE_SECS: i64 = 20;
/// A run still listed after this is recorded as not finished.
const RUN_MAX_SECS: i64 = 6 * 3600;
/// The most of a reply the list keeps.
const SUMMARY_MAX: usize = 240;
/// The time of day a schedule with none named runs at: 8:00 AM.
const DEFAULT_AT_MIN: u32 = 8 * 60;

/// How often a job runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "unit", rename_all = "snake_case")]
pub enum Every {
    Minutes {
        n: u32,
    },
    Hours {
        n: u32,
    },
    /// At `at_min` minutes after his midnight, on `days` (0 = Monday … 6 =
    /// Sunday); empty is every day.
    Days {
        at_min: u32,
        #[serde(default)]
        days: Vec<u8>,
    },
}

const DAY_NAMES: [(&str, &str); 7] = [
    ("monday", "Mondays"),
    ("tuesday", "Tuesdays"),
    ("wednesday", "Wednesdays"),
    ("thursday", "Thursdays"),
    ("friday", "Fridays"),
    ("saturday", "Saturdays"),
    ("sunday", "Sundays"),
];

/// What [`Every::parse`] answers for words it cannot read.
pub const EVERY_FORMS: &str = "say it as “every 30 minutes”, “every 2 hours”, “every day at 8am”, “every morning”, “every weekday at 9am” or “every Monday at 9:30am”";

/// "8", "8am", "8:30 pm", "20:15", "noon", "midnight" → minutes after
/// midnight. Pure.
fn parse_time(s: &str) -> Option<u32> {
    let s = s.trim().to_lowercase().replace(['.', ' '], "");
    match s.as_str() {
        "noon" | "midday" => return Some(12 * 60),
        "midnight" => return Some(0),
        _ => {}
    }
    let (body, half) = if let Some(b) = s.strip_suffix("am") {
        (b, Some(false))
    } else if let Some(b) = s.strip_suffix("pm") {
        (b, Some(true))
    } else {
        (s.as_str(), None)
    };
    let (h, m) = match body.split_once(':') {
        Some((h, m)) => (h.parse::<u32>().ok()?, m.parse::<u32>().ok()?),
        None => (body.parse::<u32>().ok()?, 0),
    };
    if m > 59 {
        return None;
    }
    let h = match half {
        Some(pm) => {
            if !(1..=12).contains(&h) {
                return None;
            }
            (h % 12) + if pm { 12 } else { 0 }
        }
        None => {
            if h > 23 {
                return None;
            }
            h
        }
    };
    Some(h * 60 + m)
}

/// "8:00 AM" — 12-hour, as he reads times.
fn clock_words(at_min: u32) -> String {
    let (h, m) = (at_min / 60 % 24, at_min % 60);
    let half = if h < 12 { "AM" } else { "PM" };
    let h12 = match h % 12 {
        0 => 12,
        x => x,
    };
    format!("{h12}:{m:02} {half}")
}

impl Every {
    /// His words as a schedule: "every 30 minutes", "every hour", "every
    /// day at 8am", "every morning", "every weekday at 9", "every Monday
    /// and Thursday at 9:30am", "every week" (`today`'s weekday, 0 =
    /// Monday). A leading "repeat" and "every"/"each" are optional. `Err`
    /// is the sentence the phone shows. Pure.
    pub fn parse(phrase: &str, today: u8) -> Result<Self, String> {
        let bad = || format!("that is not a schedule Nightloom knows — {EVERY_FORMS}");
        let lower = phrase
            .trim()
            .trim_end_matches(['.', ':', ','])
            .to_lowercase();
        let mut rest = lower.as_str();
        for lead in ["repeat ", "every ", "each "] {
            rest = rest.strip_prefix(lead).unwrap_or(rest).trim_start();
        }
        if rest.is_empty() {
            return Err(bad());
        }
        // The time of day, when one is named: "… at 9am".
        let (what, at) = match rest.rsplit_once(" at ") {
            Some((w, t)) => (w.trim(), Some(parse_time(t).ok_or_else(bad)?)),
            None => (rest, None),
        };
        // An interval: "30 minutes", "hour", "2 hours", "half hour".
        let interval = |what: &str| -> Option<Every> {
            let (n, unit) = match what.split_once(' ') {
                Some((n, unit)) => (
                    match n {
                        "half" => 0,
                        "other" => 2,
                        _ => n.parse::<u32>().ok()?,
                    },
                    unit.trim(),
                ),
                None => (1, what),
            };
            match unit {
                "minute" | "minutes" | "min" | "mins" if n > 0 => Some(Every::Minutes { n }),
                "hour" | "hours" | "hr" | "hrs" if n > 0 => Some(Every::Hours { n }),
                "hour" | "an hour" if n == 0 => Some(Every::Minutes { n: 30 }),
                _ => None,
            }
        };
        if let Some(e) = interval(what) {
            if at.is_some() {
                return Err(bad());
            }
            return match e {
                Every::Minutes { n } if n < MIN_MINUTES => Err(format!(
                    "a job runs at most every {MIN_MINUTES} minutes — each run spends some of the weekly limit"
                )),
                Every::Minutes { n } if n > 24 * 60 => Err(bad()),
                Every::Hours { n } if n > 24 * 7 => Err(bad()),
                e => Ok(e),
            };
        }
        let days_of = |what: &str| -> Option<(Vec<u8>, u32)> {
            Some(match what {
                "day" | "daily" => (vec![], DEFAULT_AT_MIN),
                "morning" => (vec![], 8 * 60),
                "afternoon" => (vec![], 14 * 60),
                "evening" => (vec![], 18 * 60),
                "night" => (vec![], 22 * 60),
                "weekday" | "weekdays" | "weekday morning" => (vec![0, 1, 2, 3, 4], DEFAULT_AT_MIN),
                "weekend" | "weekends" => (vec![5, 6], DEFAULT_AT_MIN),
                "week" | "weekly" => (vec![today % 7], DEFAULT_AT_MIN),
                _ => {
                    let mut days = Vec::new();
                    for w in what
                        .split(|c: char| c == ',' || c.is_whitespace())
                        .filter(|w| !w.is_empty() && *w != "and")
                    {
                        let w = w.trim_end_matches('s');
                        let i = DAY_NAMES.iter().position(|(name, _)| {
                            *name == w || (w.len() >= 3 && name.starts_with(w))
                        })?;
                        if !days.contains(&(i as u8)) {
                            days.push(i as u8);
                        }
                    }
                    if days.is_empty() {
                        return None;
                    }
                    days.sort_unstable();
                    (days, DEFAULT_AT_MIN)
                }
            })
        };
        let (days, default_at) = days_of(what).ok_or_else(bad)?;
        Ok(Every::Days {
            at_min: at.unwrap_or(default_at),
            days,
        })
    }

    /// The schedule in his words: "Every 30 minutes", "Every day at 8:00
    /// AM", "Weekdays at 9:00 AM", "Mondays and Thursdays at 9:30 AM". Pure.
    pub fn words(&self) -> String {
        match self {
            Every::Minutes { n: 1 } => "Every minute".into(),
            Every::Minutes { n } => format!("Every {n} minutes"),
            Every::Hours { n: 1 } => "Every hour".into(),
            Every::Hours { n } => format!("Every {n} hours"),
            Every::Days { at_min, days } => {
                let at = clock_words(*at_min);
                let who = match days.as_slice() {
                    [] => "Every day".to_string(),
                    [0, 1, 2, 3, 4] => "Weekdays".to_string(),
                    [5, 6] => "Weekends".to_string(),
                    ds => {
                        let names: Vec<&str> = ds
                            .iter()
                            .filter_map(|d| DAY_NAMES.get(*d as usize).map(|(_, plural)| *plural))
                            .collect();
                        match names.as_slice() {
                            [one] => (*one).to_string(),
                            [head @ .., last] => format!("{} and {last}", head.join(", ")),
                            [] => "Every day".to_string(),
                        }
                    }
                };
                format!("{who} at {at}")
            }
        }
    }

    /// The first run strictly after `after`, on a clock `offset_min`
    /// minutes east of UTC (a job saved before zones were kept). Pure.
    pub fn next_after(&self, after: DateTime<Utc>, offset_min: i32) -> DateTime<Utc> {
        self.next_in(after, &zone_of(None, offset_min))
    }

    /// The first run strictly after `after`, on `zone`'s clock (item 780):
    /// "8:00 AM" is 8:00 AM there on every date, whatever its offset that
    /// day. On a change day an hour that does not exist (2:30 AM when the
    /// clocks go forward) runs at the same distance past it (3:30 AM), and
    /// an hour that happens twice (1:30 AM when they go back) runs once, at
    /// the first — what calendars do. Pure.
    pub fn next_in(&self, after: DateTime<Utc>, zone: &jiff::tz::TimeZone) -> DateTime<Utc> {
        match self {
            Every::Minutes { n } => after + Duration::minutes(i64::from((*n).max(1))),
            Every::Hours { n } => after + Duration::hours(i64::from((*n).max(1))),
            Every::Days { at_min, days } => {
                let Some(today) = local_date(after, zone) else {
                    return after + Duration::days(1);
                };
                let (h, m) = ((*at_min % 1440 / 60) as i8, (*at_min % 60) as i8);
                for d in 0..=8 {
                    let date = today + Duration::days(d);
                    let weekday = date.weekday().num_days_from_monday() as u8;
                    if !days.is_empty() && !days.contains(&weekday) {
                        continue;
                    }
                    let Ok(civil) = jiff::civil::DateTime::new(
                        date.year() as i16,
                        date.month() as i8,
                        date.day() as i8,
                        h,
                        m,
                        0,
                        0,
                    ) else {
                        continue;
                    };
                    let Ok(at) = zone.to_ambiguous_timestamp(civil).compatible() else {
                        continue;
                    };
                    if let Some(at) = DateTime::<Utc>::from_timestamp(at.as_second(), 0)
                        && at > after
                    {
                        return at;
                    }
                }
                after + Duration::days(1)
            }
        }
    }
}

/// The zone a job's times are read on (item 780): its IANA zone when this
/// host's zone list has it, else the fixed offset it was saved with
/// (minutes east of UTC).
pub fn zone_of(tz: Option<&str>, offset_min: i32) -> jiff::tz::TimeZone {
    tz.and_then(|name| jiff::tz::TimeZone::get(name).ok())
        .unwrap_or_else(|| {
            let secs = offset_min.clamp(-14 * 60, 14 * 60) * 60;
            jiff::tz::TimeZone::fixed(
                jiff::tz::Offset::from_seconds(secs).unwrap_or(jiff::tz::Offset::UTC),
            )
        })
}

/// `at`'s date on `zone`'s clock.
fn local_date(at: DateTime<Utc>, zone: &jiff::tz::TimeZone) -> Option<NaiveDate> {
    let ts = jiff::Timestamp::from_second(at.timestamp()).ok()?;
    let d = ts.to_zoned(zone.clone()).date();
    NaiveDate::from_ymd_opt(i32::from(d.year()), d.month() as u32, d.day() as u32)
}

/// `zone`'s offset at `at`, minutes east of UTC.
pub fn offset_at(zone: &jiff::tz::TimeZone, at: DateTime<Utc>) -> i32 {
    jiff::Timestamp::from_second(at.timestamp())
        .map(|ts| zone.to_offset(ts).seconds() / 60)
        .unwrap_or(0)
}

/// An IANA name worth keeping: a known zone, by a name of letters, digits,
/// `/`, `_`, `-` and `+` (what `Intl` answers), never a path.
fn clean_tz(name: Option<String>) -> Option<String> {
    let name = name?.trim().to_string();
    let ok = !name.is_empty()
        && name.len() <= 64
        && !name.contains("..")
        && !name.starts_with('/')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '+'));
    (ok && jiff::tz::TimeZone::get(&name).is_ok()).then_some(name)
}

/// The host's own IANA zone, when it has a name.
fn host_tz() -> Option<String> {
    jiff::tz::TimeZone::try_system()
        .ok()
        .and_then(|z| z.iana_name().map(str::to_string))
}

/// How a run ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// A reply was recorded.
    Done,
    /// The turn ended with no reply, or its log could not be read.
    Failed,
    /// Still listed as running after [`RUN_MAX_SECS`]; no longer watched.
    Unfinished,
    /// The runaway guard paused it and he chose Stop (item 784).
    Stopped,
    /// Not started: Home's spend guard stopped it (item 763, H6); the
    /// summary says why.
    Skipped,
}

/// What a read-only run tried to do and was refused (item 780).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Wanted {
    /// When the run that wanted it ended.
    pub at: DateTime<Utc>,
    /// The refused tools, in his words ("run commands", "edit files"),
    /// each once.
    #[serde(default)]
    pub what: Vec<String>,
}

/// A job's last run, for the list.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LastRun {
    pub started: DateTime<Utc>,
    pub ended: DateTime<Utc>,
    pub outcome: Outcome,
    /// The reply's first lines (or why there is none). Kept on this host
    /// and read by the phone over `/api/jobs`; never in a push.
    pub summary: String,
    /// Percent of the weekly window the run moved the plan's figure by;
    /// `None` when a reading was missing or the window reset meanwhile.
    #[serde(default)]
    pub week_points: Option<u8>,
    /// The weekly figure after the run, percent.
    #[serde(default)]
    pub week_after: Option<u8>,
    /// Tool calls the run made, read from its chat's log (item 784).
    #[serde(default)]
    pub calls: Option<u32>,
    /// Item 812: he pressed Run anyway past Home's spend guard.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub forced: bool,
    /// Percent of the 5-hour window the run moved the plan's figure by
    /// (item 812), like [`week_points`](Self::week_points).
    #[serde(default)]
    pub five_points: Option<u8>,
}

/// What one finished run cost (item 812): the measure of the next run's
/// estimate on the Run anyway card.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct RunCost {
    pub week: u8,
    #[serde(default)]
    pub five: Option<u8>,
}

/// Finished runs kept for the estimate (item 812).
pub const COST_KEEP: usize = 5;

/// Item 812: his Run now on a Home job that the spend guard refused — the
/// card asks Run anyway / Cancel with what Home estimates the run costs
/// and where his windows are. The figures are those read at the press.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunConfirm {
    pub at: DateTime<Utc>,
    /// The guard's reason, in his words.
    pub why: String,
    /// Mean percent of the week of its last runs; `None`: no estimate yet.
    #[serde(default)]
    pub est_week: Option<f64>,
    /// Mean percent of the 5-hour window, when runs measured it.
    #[serde(default)]
    pub est_five: Option<f64>,
    /// How many runs the estimate is the mean of.
    #[serde(default)]
    pub est_runs: u32,
    #[serde(default)]
    pub five_hour: Option<u8>,
    #[serde(default)]
    pub week: Option<u8>,
    /// The usage reading was old (or missing) at the press.
    #[serde(default)]
    pub stale: bool,
}

/// What a job has cost of the weekly window since it last reset.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WeekCost {
    /// The reset this sum counts toward (the plan's own stamp).
    #[serde(default)]
    pub resets_at: Option<String>,
    pub points: u32,
    pub runs: u32,
}

/// A run in flight.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunMark {
    pub started: DateTime<Utc>,
    /// The run was let write (item 780).
    #[serde(default)]
    pub writable: bool,
    #[serde(default)]
    pub week_before: Option<u8>,
    #[serde(default)]
    pub resets_at: Option<String>,
    /// Item 812: the 5-hour figure and its reset at the start.
    #[serde(default)]
    pub five_before: Option<u8>,
    #[serde(default)]
    pub five_resets_at: Option<String>,
    /// Item 812: started by Run anyway, past Home's spend guard.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub forced: bool,
}

/// One recurring job.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Job {
    pub id: String,
    pub title: String,
    /// The message each run sends.
    pub text: String,
    pub every: Every,
    /// The phone's clock when it was made, minutes east of UTC — what its
    /// times are read on when it has no [`tz`](Self::tz).
    #[serde(default)]
    pub offset_min: i32,
    /// Its time zone (item 780), the phone's IANA name when it was saved
    /// ("America/Los_Angeles"): "8:00 AM" is 8:00 AM there on every date.
    #[serde(default)]
    pub tz: Option<String>,
    /// The project its chat lives in; `None` is the unfiled chats.
    #[serde(default)]
    pub project: Option<String>,
    /// The job's own chat, once its first run made it.
    #[serde(default)]
    pub chat: Option<String>,
    /// The chat he made it from.
    #[serde(default)]
    pub from_chat: Option<String>,
    #[serde(default)]
    pub paused: bool,
    /// When he tapped Approve always: from then every run may write, until
    /// the message changes or he takes it back. `None`: it asks.
    #[serde(default)]
    pub approved: Option<DateTime<Utc>>,
    /// When he tapped Approve once (item 780): the next run may write; the
    /// approval is used up when that run starts.
    #[serde(default)]
    pub approved_once: Option<DateTime<Utc>>,
    /// The last read-only run wanted to make changes and was refused
    /// (item 780): the approval card asks until he answers it.
    #[serde(default)]
    pub wanted: Option<Wanted>,
    pub created: DateTime<Utc>,
    pub next_run: DateTime<Utc>,
    /// A run that could not start is not tried again before this.
    #[serde(default)]
    pub retry_at: Option<DateTime<Utc>>,
    /// "Run now": one run at the next tick, paused or not.
    #[serde(default)]
    pub run_now: bool,
    #[serde(default)]
    pub running: Option<RunMark>,
    #[serde(default)]
    pub last: Option<LastRun>,
    #[serde(default)]
    pub week: WeekCost,
    /// Why it has not run yet, when a run is waiting.
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub runs: u32,
    /// Tool calls of its recent finished runs, oldest first (item 784):
    /// the runaway guard's measure of a run far above its usual.
    #[serde(default)]
    pub recent_calls: Vec<u32>,
    /// What its recent finished runs cost, oldest first (item 812).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub recent_cost: Vec<RunCost>,
    /// Item 812: his Run now that Home's spend guard refused; the card asks.
    #[serde(default)]
    pub confirm: Option<RunConfirm>,
    /// Item 812: he pressed Run anyway — the next Run now start passes the
    /// guard once (a scheduled start never does).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub force_once: bool,
    /// Item 781: the away server's copy of one of the Mac's jobs (the Mac
    /// sends its away jobs with each sync, [`Jobs::take_mac_jobs`]). Run
    /// only under the lease ([`crate::sync::lease`]); never listed to the
    /// phone, which edits the Mac's own.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub stand_in: bool,
    /// Item 794: a research watch — each run appends what changed to one
    /// note ([`watch`]). `None`: an ordinary job.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub watch: Option<watch::Watch>,
}

/// A job as `/api/jobs` lists it: the job, its schedule in words, and
/// whether its next run is read-only.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobView {
    #[serde(flatten)]
    pub job: Job,
    pub every_words: String,
    /// Its next run may not write.
    pub read_only: bool,
    /// "ask", "once" (the next run may write) or "always" (item 780).
    pub approval: String,
}

impl Job {
    /// The next run may write: approved always, or once and not used yet.
    pub fn writable(&self) -> bool {
        self.approved.is_some() || self.approved_once.is_some()
    }

    /// The zone its times are read on.
    pub fn zone(&self) -> jiff::tz::TimeZone {
        zone_of(self.tz.as_deref(), self.offset_min)
    }

    /// Its first run strictly after `after`.
    pub fn next_after(&self, after: DateTime<Utc>) -> DateTime<Utc> {
        self.every.next_in(after, &self.zone())
    }
}

impl From<Job> for JobView {
    fn from(job: Job) -> Self {
        Self {
            every_words: job.every.words(),
            read_only: !job.writable(),
            approval: if job.approved.is_some() {
                "always"
            } else if job.approved_once.is_some() {
                "once"
            } else {
                "ask"
            }
            .into(),
            job,
        }
    }
}

/// `POST /api/jobs`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct NewJob {
    /// His words for how often ("every morning").
    pub every: String,
    pub text: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub from_chat: Option<String>,
    /// The phone's clock, minutes east of UTC.
    #[serde(default)]
    pub offset_min: i32,
    /// The phone's time zone, its IANA name (item 780).
    #[serde(default)]
    pub tz: Option<String>,
    /// Item 794: a research watch's topic and pages (its note is named here).
    #[serde(default)]
    pub watch: Option<watch::Watch>,
}

/// `POST /api/jobs/{id}`: each field only when it changes.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct JobPatch {
    #[serde(default)]
    pub paused: Option<bool>,
    #[serde(default)]
    pub every: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    /// `true`: he approved the job's plan — its runs may write from now
    /// (Approve always). `false`: read-only again. Kept for pages older
    /// than [`approve`](Self::approve).
    #[serde(default)]
    pub approve_plan: Option<bool>,
    /// Item 780: "once" (the next run may write), "always" (every run,
    /// until the message changes) or "ask" (read-only again; takes back
    /// either). From the card a refused run raised, "once" and "always"
    /// also run it again at once.
    #[serde(default)]
    pub approve: Option<String>,
    /// `true`: "Keep read-only" on that card — it stops asking.
    #[serde(default)]
    pub dismiss_wanted: Option<bool>,
    /// Item 812: Run anyway on the spend guard's card — one run at the
    /// next tick, past Home's spend guard (the plan's 100% still waits).
    #[serde(default)]
    pub run_anyway: Option<bool>,
    /// Item 812: Cancel on that card — it stays skipped, the card goes.
    #[serde(default)]
    pub dismiss_confirm: Option<bool>,
    #[serde(default)]
    pub offset_min: Option<i32>,
    /// The phone's IANA zone: kept only on a job with none yet (one saved
    /// before zones were kept) whose offset it had when the job was made.
    #[serde(default)]
    pub tz: Option<String>,
    /// Item 794: a watch's new topic and pages (its note keeps its name).
    #[serde(default)]
    pub watch: Option<watch::Watch>,
}

/// What a job's chat may do, as its log says it (item 746): a Chat over
/// its Claude Code declaration while the job is read-only, Claude Code once
/// its plan is approved.
pub fn kind_for(read_only: bool) -> nightloom_core::ChatKind {
    if read_only {
        nightloom_core::ChatKind::Chat
    } else {
        nightloom_core::ChatKind::Build
    }
}

/// Put `want` on the job chat's log at `path`, then read the file back
/// (item 746's review): a log that cannot be written — the Mac took the
/// chat down (0444), or the disk refused — swallows the write
/// (`Session::record` seals the log rather than fail), and the run would
/// read the old kind and run with the writers. `Err` then: the job waits.
/// The chat's id on success.
pub fn hold_kind_on_disk(path: &Path, want: nightloom_core::ChatKind) -> Result<String, String> {
    hold_on_disk(path, want, None)
}

/// [`hold_kind_on_disk`], and the chat's automatic in-place hand-off marks
/// (item 763: Home's chat) when `auto` names them.
pub fn hold_on_disk(
    path: &Path,
    want: nightloom_core::ChatKind,
    auto: Option<(u64, u64)>,
) -> Result<String, String> {
    let mut session = nightloom_core::Session::load(path).map_err(|e| e.to_string())?;
    if session.kind() != want {
        crate::chat_ops::set_kind(&mut session, want, None);
    }
    if let Some((soft, hard)) = auto {
        session.set_auto_hand_off(soft, hard);
    }
    let id = session.id.clone();
    drop(session);
    let back = nightloom_core::Session::load(path).map_err(|e| e.to_string())?;
    if back.kind() == want {
        Ok(id)
    } else {
        Err(UNHELD.into())
    }
}

/// Why a run waits when its chat's kind could not be written.
pub const UNHELD: &str = "its chat's log could not be changed, so its read-only hold could not be set; it tries again in a minute";

/// What a host is asked before a run ([`Host::job_prepare`]): the job's
/// chat exists (made in `project`, named `title`, when `chat` is `None`
/// or gone) and is read-only or not as `read_only` says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prep {
    pub project: Option<String>,
    pub chat: Option<String>,
    pub title: String,
    pub read_only: bool,
    /// The chat hands off in place by itself at these marks (item 763:
    /// Home's chat, `(soft, hard)` tokens); `None` leaves it as it is.
    pub auto_hand_off: Option<(u64, u64)>,
    /// The model and effort the run must use, `(model, effort)` (item
    /// 763: Home's scan, blocker 2041); `None` leaves the host's choice.
    pub model: Option<(String, String)>,
    /// The run's chat gets his claude.ai connectors (item 804: Home's
    /// scan reads mail and calendars; the chat is held read-only, so a
    /// connector action that writes is refused).
    pub connectors: bool,
}

/// A title from the message when he gave none: its first line, cut.
pub(crate) fn title_from(text: &str) -> String {
    let line = text
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    let mut t: String = line.chars().take(48).collect();
    if line.chars().count() > 48 {
        t.push('…');
    }
    if t.is_empty() { "Job".into() } else { t }
}

fn weekday_at(now: DateTime<Utc>, zone: &jiff::tz::TimeZone) -> u8 {
    local_date(now, zone).map_or(0, |d| d.weekday().num_days_from_monday() as u8)
}

/// The changes a read-only run was refused (item 780): the tools whose
/// result after the last time `text` was sent is the Chat policy's refusal,
/// in his words, each once. Pure.
pub fn refused_in(events: &[serde_json::Value], text: &str) -> Vec<String> {
    let Some(sent) = events.iter().rposition(|e| {
        e["event"] == "user_message" && e["text"].as_str().is_some_and(|t| t.contains(text.trim()))
    }) else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for e in &events[sent + 1..] {
        if e["event"] != "tool_result" || e["is_error"] != true {
            continue;
        }
        if !e["content"]
            .as_str()
            .is_some_and(|c| c.contains(REFUSED_MARK))
        {
            continue;
        }
        let words = tool_words(e["name"].as_str().unwrap_or(""));
        if !out.iter().any(|w| w == words) {
            out.push(words.to_string());
        }
    }
    out
}

/// What every Chat-policy refusal says (`agent::CHAT_POLICY_REASON` and its
/// preview and browser forms).
const REFUSED_MARK: &str = "This chat is a Chat now";

/// A refused tool in his words.
fn tool_words(name: &str) -> &'static str {
    match name {
        "Bash" | "BashOutput" | "KillShell" | "KillBash" => "run commands",
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => "edit files",
        "Task" | "Agent" => "start helpers",
        "ExitPlanMode" | "EnterPlanMode" => "make a plan",
        n if n.starts_with("mcp__") => "use a connector",
        _ => "use tools that make changes",
    }
}

/// The run's reply from the chat's log: the text of the last assistant
/// message after the last time `text` was sent. `None` when the log holds
/// no reply to it. Works on the log's JSON so it does not depend on the
/// engine that wrote it. Pure.
pub fn reply_in(events: &[serde_json::Value], text: &str) -> Option<String> {
    let sent = events.iter().rposition(|e| {
        e["event"] == "user_message" && e["text"].as_str().is_some_and(|t| t.contains(text.trim()))
    })?;
    events[sent + 1..]
        .iter()
        .rev()
        .filter(|e| e["event"] == "assistant_message" && stand_in_why(e).is_none())
        .find_map(|e| {
            let said: Vec<&str> = e["blocks"]
                .as_array()?
                .iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .filter(|t| !t.trim().is_empty())
                .collect();
            (!said.is_empty()).then(|| said.join("\n"))
        })
}

/// Item 896: why a run ended with no reply, from Nightloom's own stand-in
/// under the sent text ("No reply: <why>", backlog 361) — the connection
/// error a dead run's process printed. `None` when there is none. Pure.
pub fn failure_in(events: &[serde_json::Value], text: &str) -> Option<String> {
    let sent = events.iter().rposition(|e| {
        e["event"] == "user_message" && e["text"].as_str().is_some_and(|t| t.contains(text.trim()))
    })?;
    events[sent + 1..].iter().rev().find_map(stand_in_why)
}

/// The reason in a stand-in reply (backlog 361): its words after "No
/// reply: ", or "it was stopped" for a stopped one. Read from the log's
/// JSON like [`reply_in`]; the stop reason marks it as Nightloom's own.
fn stand_in_why(e: &serde_json::Value) -> Option<String> {
    if e["event"] != "assistant_message" {
        return None;
    }
    let ended = e["stop_reason"]
        .as_str()
        .is_some_and(|r| r == "stopped" || r.starts_with("error: "));
    let [block] = e["blocks"].as_array()?.as_slice() else {
        return None;
    };
    let text = block["text"]
        .as_str()
        .filter(|_| ended && block["type"] == "text")?;
    if text == nightloom_core::STOPPED_BEFORE_REPLY {
        return Some("it was stopped before any reply".into());
    }
    text.strip_prefix(nightloom_core::NO_REPLY_PREFIX)
        .map(|why| why.trim().to_string())
        .filter(|why| !why.is_empty())
}

/// The guard's Stop line in a run's reply (item 784): from its prefix on.
fn stopped_reply(reply: &str) -> Option<&str> {
    reply
        .find(crate::runaway::STOPPED_PREFIX)
        .map(|at| &reply[at..])
}

fn cut(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = flat.chars().take(SUMMARY_MAX).collect();
    if flat.chars().count() > SUMMARY_MAX {
        out.push('…');
    }
    out
}

/// The plan's limit is reached now (a fresh reading at 100%).
fn limited(plan: &PlanUsage) -> bool {
    !plan.stale
        && (plan.five_hour.is_some_and(|p| p >= 100) || plan.seven_day.is_some_and(|p| p >= 100))
}

/// The run's cost in whole percents of the weekly window: the figure after
/// less the figure before, when both were read in the same window. Pure.
pub fn week_points(mark: &RunMark, after: &PlanUsage) -> Option<u8> {
    let (before, now) = (mark.week_before?, after.seven_day?);
    if mark.resets_at != after.seven_day_resets_at || now < before {
        return None;
    }
    Some(now - before)
}

/// The run's cost in whole percents of the 5-hour window (item 812), as
/// [`week_points`] reads the week. Pure.
pub fn five_points(mark: &RunMark, after: &PlanUsage) -> Option<u8> {
    let (before, now) = (mark.five_before?, after.five_hour?);
    if mark.five_resets_at != after.five_hour_resets_at || now < before {
        return None;
    }
    Some(now - before)
}

/// Item 812: what Home estimates the next run of `job` costs — the mean
/// of its last finished runs ([`Job::recent_cost`]), else of this week's
/// runs ([`Job::week`]) — as (week, 5-hour, runs). Pure.
pub fn estimate(job: &Job) -> (Option<f64>, Option<f64>, u32) {
    let mean = |v: &[f64]| (!v.is_empty()).then(|| v.iter().sum::<f64>() / v.len() as f64);
    if !job.recent_cost.is_empty() {
        let week: Vec<f64> = job.recent_cost.iter().map(|c| f64::from(c.week)).collect();
        let five: Vec<f64> = job
            .recent_cost
            .iter()
            .filter_map(|c| c.five.map(f64::from))
            .collect();
        return (mean(&week), mean(&five), job.recent_cost.len() as u32);
    }
    if job.week.runs > 0 {
        let w = f64::from(job.week.points) / f64::from(job.week.runs);
        return (Some(w), None, job.week.runs);
    }
    (None, None, 0)
}

/// Item 812: the Run anyway card's figures at his press. Pure.
pub fn run_confirm(
    job: &Job,
    why: &str,
    plan: Option<&PlanUsage>,
    now: DateTime<Utc>,
) -> RunConfirm {
    let (est_week, est_five, est_runs) = estimate(job);
    RunConfirm {
        at: now,
        why: why.to_string(),
        est_week,
        est_five,
        est_runs,
        five_hour: plan.and_then(|p| p.five_hour),
        week: plan.and_then(|p| p.seven_day),
        stale: plan.is_none_or(|p| p.stale),
    }
}

/// Give every job with no zone `zone` when `zone` had its offset the day
/// it was made; the next run is read again on it (one already due stays
/// due). Whether any changed.
pub fn migrate_zones(jobs: &mut [Job], zone: &str, now: DateTime<Utc>) -> bool {
    let Ok(z) = jiff::tz::TimeZone::get(zone) else {
        return false;
    };
    let mut changed = false;
    for job in jobs.iter_mut().filter(|j| j.tz.is_none()) {
        if offset_at(&z, job.created) == job.offset_min {
            job.tz = Some(zone.to_string());
            if job.next_run > now && job.running.is_none() {
                job.next_run = job.next_after(now);
            }
            changed = true;
        }
    }
    changed
}

/// A host's jobs: the store and the clock's one step.
pub struct Jobs {
    dir: PathBuf,
    inner: Mutex<Vec<Job>>,
    /// One tick at a time.
    ticking: tokio::sync::Mutex<()>,
}

impl Jobs {
    /// `<home>/remote/jobs`.
    pub fn dir_under(home: &Path) -> PathBuf {
        home.join("remote").join("jobs")
    }

    /// The jobs kept in `dir` (none when it has no file yet, or one that
    /// does not read — which is then left as it is until a job is saved).
    ///
    /// A job saved before zones were kept (item 780) takes the host's zone
    /// when that zone had the job's offset the day it was made — on the
    /// Mac, his zone; the away server's UTC matches only a UTC phone — and
    /// is saved so.
    pub fn open(dir: PathBuf) -> Arc<Self> {
        Self::open_in(dir, host_tz())
    }

    /// [`open`](Self::open) with the host's zone named (tests).
    pub fn open_in(dir: PathBuf, host_zone: Option<String>) -> Arc<Self> {
        let mut jobs = std::fs::read(dir.join("jobs.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<Vec<Job>>(&b).ok())
            .unwrap_or_default();
        let migrated = host_zone.is_some_and(|zone| migrate_zones(&mut jobs, &zone, Utc::now()));
        let me = Arc::new(Self {
            dir,
            inner: Mutex::new(jobs),
            ticking: tokio::sync::Mutex::new(()),
        });
        if migrated {
            let jobs = me.lock().clone();
            let _ = me.save(&jobs);
        }
        me
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Vec<Job>> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn write(&self, name: &str, value: &impl Serialize) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir).map_err(|e| format!("{}: {e}", self.dir.display()))?;
        let path = self.dir.join(name);
        let tmp = self.dir.join(format!("{name}.tmp"));
        let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
        std::fs::write(&tmp, bytes).map_err(|e| format!("{}: {e}", tmp.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
        }
        std::fs::rename(&tmp, &path).map_err(|e| format!("{}: {e}", path.display()))
    }

    fn save(&self, jobs: &[Job]) -> Result<(), String> {
        self.write("jobs.json", &jobs)
    }

    /// Change job `id` and save; `Err` when it is gone.
    fn change(&self, id: &str, f: impl FnOnce(&mut Job)) -> Result<Job, String> {
        let mut jobs = self.lock();
        let job = jobs
            .iter_mut()
            .find(|j| j.id == id)
            .ok_or_else(|| "that job is gone".to_string())?;
        f(job);
        let out = job.clone();
        self.save(&jobs)?;
        Ok(out)
    }

    /// The Nightloom home this store lives under (`<home>/remote/jobs`).
    fn config_dir(&self) -> Option<PathBuf> {
        self.dir.parent()?.parent().map(Path::to_path_buf)
    }

    /// The morning scan's message (item 763): [`crate::home::SCAN_LINE`]
    /// and the facts collected now.
    fn scan_text(&self, now: DateTime<Utc>, read_only: bool) -> String {
        let Some(config) = self.config_dir() else {
            return crate::home::scan_message("(no Nightloom home)", false);
        };
        let projects: Vec<(String, Option<PathBuf>)> = crate::project::Registry::load_in(&config)
            .projects()
            .into_iter()
            .filter(|p| p.source.as_deref() != Some(crate::home::SOURCE))
            .map(|p| (p.name, p.workspace))
            .collect();
        let facts = crate::home::collect(&config, &self.list(), &projects, now);
        // Item 804: with accounts to read, the turn reads their mail and
        // calendars with the connectors' read tools.
        // Only a read-only run gets the connectors (804's review: an
        // approved, writable scan is sent without them, so it is not told
        // to read accounts it cannot reach).
        let accounts = read_only && !crate::home::reach::scan_accounts(&config).is_empty();
        crate::home::scan_message(&facts, accounts)
    }

    /// Item 763: the built-in morning scan in Home's project `project`,
    /// made once (8:00 AM on the host's zone); a job he changed or paused
    /// is left as he left it. Whether it was made now.
    pub fn ensure_home_scan(&self, project: &str, now: DateTime<Utc>) -> bool {
        if self.lock().iter().any(|j| j.id == crate::home::SCAN_JOB_ID) {
            return false;
        }
        let mut req = crate::home::scan_job(project);
        req.tz = host_tz();
        let Ok(view) = self.create(req, now) else {
            return false;
        };
        let mut jobs = self.lock();
        if let Some(j) = jobs.iter_mut().find(|j| j.id == view.job.id) {
            j.id = crate::home::SCAN_JOB_ID.into();
        }
        let _ = self.save(&jobs);
        true
    }

    /// Every job, soonest next run first (paused ones last).
    pub fn list(&self) -> Vec<JobView> {
        let mut jobs: Vec<Job> = self
            .lock()
            .iter()
            .filter(|j| !j.stand_in)
            .cloned()
            .collect();
        jobs.sort_by_key(|j| (j.paused, j.next_run));
        jobs.into_iter().map(JobView::from).collect()
    }

    /// Item 2105: Home's jobs — the morning scan and any job in Home's
    /// project — in [`list`](Self::list)'s order, for the Mac's job rows.
    pub fn home_list(&self) -> Vec<JobView> {
        self.list()
            .into_iter()
            .filter(|v| self.is_home_job(&v.job))
            .collect()
    }

    /// A new job, read-only, its first run at the schedule's next time.
    pub fn create(&self, req: NewJob, now: DateTime<Utc>) -> Result<JobView, String> {
        let text = req.text.trim().to_string();
        if text.is_empty() {
            return Err("a job needs the message it repeats".into());
        }
        let tz = clean_tz(req.tz);
        let zone = zone_of(tz.as_deref(), req.offset_min);
        let every = Every::parse(&req.every, weekday_at(now, &zone))?;
        let watch = req.watch.map(watch::Watch::cleaned).transpose()?;
        let mut jobs = self.lock();
        if jobs.len() >= MAX_JOBS {
            return Err(format!(
                "this host keeps at most {MAX_JOBS} jobs — delete one first"
            ));
        }
        let title = req
            .title
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| match &watch {
                Some(w) => title_from(&format!("Watch — {}", w.topic)),
                None => title_from(&text),
            });
        // Item 794: the note's name, fixed now, never one another watch keeps.
        let watch = watch.map(|mut w| {
            let taken: Vec<String> = jobs
                .iter()
                .filter_map(|j| j.watch.as_ref().map(|w| w.note.clone()))
                .collect();
            w.note = watch::note_name(&w.topic, &taken);
            w
        });
        let job = Job {
            id: uuid::Uuid::new_v4().simple().to_string(),
            title,
            text,
            next_run: every.next_in(now, &zone),
            every,
            offset_min: req.offset_min,
            tz,
            project: req.project.filter(|p| !p.trim().is_empty()),
            chat: None,
            from_chat: req.from_chat.filter(|c| !c.trim().is_empty()),
            paused: false,
            approved: None,
            approved_once: None,
            wanted: None,
            created: now,
            retry_at: None,
            run_now: false,
            running: None,
            last: None,
            week: WeekCost::default(),
            note: None,
            runs: 0,
            recent_calls: Vec::new(),
            recent_cost: Vec::new(),
            confirm: None,
            force_once: false,
            stand_in: false,
            watch,
        };
        jobs.push(job.clone());
        self.save(&jobs)?;
        Ok(job.into())
    }

    /// Pause or resume, re-word, re-time, approve the plan or take the
    /// approval back. New words for the message take the approval back:
    /// what he approved was the old plan.
    pub fn patch(&self, id: &str, patch: JobPatch, now: DateTime<Utc>) -> Result<JobView, String> {
        let current = self
            .lock()
            .iter()
            .find(|j| j.id == id)
            .cloned()
            .ok_or_else(|| "that job is gone".to_string())?;
        let offset = patch.offset_min.unwrap_or(current.offset_min);
        // A zone is taken only by a job that has none, and only one that
        // had its offset the day the job was made (the phone that made it,
        // not one travelling): a job's zone is where it was saved.
        let tz = if current.tz.is_none() {
            clean_tz(patch.tz.clone()).filter(|name| {
                offset_at(&zone_of(Some(name), 0), current.created) == current.offset_min
            })
        } else {
            None
        };
        let zone = zone_of(
            tz.as_deref().or(current.tz.as_deref()),
            if current.tz.is_none() && tz.is_none() {
                offset
            } else {
                current.offset_min
            },
        );
        let every = match &patch.every {
            Some(words) => Some(Every::parse(words, weekday_at(now, &zone))?),
            None => None,
        };
        let approve = match (patch.approve.as_deref(), patch.approve_plan) {
            (Some(a @ ("once" | "always" | "ask")), _) => Some(a.to_string()),
            (Some(_), _) => return Err("approve is once, always or ask".into()),
            (None, Some(true)) => Some("always".into()),
            (None, Some(false)) => Some("ask".into()),
            (None, None) => None,
        };
        if patch.text.as_deref().is_some_and(|t| t.trim().is_empty()) {
            return Err("a job needs the message it repeats".into());
        }
        if patch.title.as_deref().is_some_and(|t| t.trim().is_empty()) {
            return Err("a job needs a name".into());
        }
        let new_watch = patch.watch.map(watch::Watch::cleaned).transpose()?;
        if new_watch.is_some() && current.watch.is_none() {
            return Err("this job is not a watch".into());
        }
        self.change(id, |job| {
            // Item 794: new topic or pages; the note keeps its name.
            if let (Some(w), Some(cur)) = (new_watch, job.watch.as_mut()) {
                cur.topic = w.topic;
                cur.sources = w.sources;
            }
            if let Some(text) = patch.text {
                let text = text.trim().to_string();
                if text != job.text {
                    job.text = text;
                    job.approved = None;
                    job.approved_once = None;
                    job.wanted = None;
                }
            }
            if let Some(title) = patch.title {
                job.title = title.trim().to_string();
            }
            if job.tz.is_none() {
                job.offset_min = offset;
            }
            if let Some(tz) = tz {
                job.tz = Some(tz);
                if job.next_run > now && job.running.is_none() {
                    job.next_run = job.next_after(now);
                }
            }
            if let Some(every) = every {
                job.every = every;
                job.next_run = job.next_after(now);
                job.retry_at = None;
                job.note = None;
            }
            // From the card a refused run raised, an approval runs it again.
            let again = job.wanted.is_some();
            match approve.as_deref() {
                Some("always") => {
                    if job.approved.is_none() {
                        job.approved = Some(now);
                    }
                    job.approved_once = None;
                }
                Some("once") => {
                    job.approved = None;
                    job.approved_once = Some(now);
                }
                Some(_) => {
                    job.approved = None;
                    job.approved_once = None;
                }
                None => {}
            }
            if matches!(approve.as_deref(), Some("once" | "always")) {
                job.wanted = None;
                if again && job.running.is_none() {
                    job.run_now = true;
                    job.retry_at = None;
                }
            }
            if patch.dismiss_wanted == Some(true) || approve.as_deref() == Some("ask") {
                job.wanted = None;
            }
            if patch.dismiss_confirm == Some(true) {
                job.confirm = None;
            }
            // A second press (or the other device's) while the forced run
            // is waiting or running changes nothing.
            if patch.run_anyway == Some(true) && job.running.is_none() {
                job.confirm = None;
                job.run_now = true;
                job.force_once = true;
                job.retry_at = None;
            }
            if let Some(paused) = patch.paused {
                // Resumed: from its next time, not the ones it sat out.
                if job.paused && !paused && job.next_run <= now {
                    job.next_run = job.next_after(now);
                }
                job.paused = paused;
                if paused {
                    job.note = None;
                    job.retry_at = None;
                }
            }
        })
        .map(JobView::from)
    }

    /// One run at the next tick, whatever its schedule says.
    /// The job whose chat is `chat` (item 784): its name and its recent
    /// runs' tool calls, for the runaway guard.
    pub fn usual_for_chat(&self, chat: &str) -> Option<crate::runaway::JobUsual> {
        self.lock()
            .iter()
            .find(|j| j.chat.as_deref() == Some(chat))
            .map(|j| crate::runaway::JobUsual {
                title: j.title.clone(),
                recent_calls: j.recent_calls.clone(),
            })
    }

    pub fn run_now(&self, id: &str) -> Result<JobView, String> {
        let job = self.change(id, |job| {
            if job.running.is_none() {
                job.run_now = true;
                job.retry_at = None;
            }
        })?;
        if job.running.is_some() {
            return Err("it is running now".into());
        }
        Ok(job.into())
    }

    /// Item 812: his Run now press (`POST /api/jobs/{id}/run`). A Home job
    /// the spend guard would refuse is skipped at once and carries the
    /// Run anyway card ([`Job::confirm`]); any other is [`run_now`](Self::run_now).
    pub async fn press_run(
        &self,
        host: &dyn Host,
        id: &str,
        now: DateTime<Utc>,
    ) -> Result<JobView, String> {
        let job = self
            .lock()
            .iter()
            .find(|j| j.id == id)
            .cloned()
            .ok_or_else(|| "that job is gone".to_string())?;
        if job.running.is_some() {
            return Err("it is running now".into());
        }
        // A Run anyway already waiting: the press is the same run.
        if !job.force_once && self.is_home_job(&job) {
            let plan = host.usage().await.ok().map(|u| u.plan);
            if !plan.as_ref().is_some_and(limited)
                && let Some(why) = self.home_guard(&job, plan.as_ref(), now)
            {
                self.skip(&job, &why, plan.as_ref(), true, now);
                return self
                    .list()
                    .into_iter()
                    .find(|j| j.job.id == id)
                    .ok_or_else(|| "that job is gone".to_string());
            }
        }
        self.run_now(id)
    }

    /// Delete job `id`: it leaves the list for `trash.json` (its chat and
    /// every past result stay where they are).
    pub fn delete(&self, id: &str) -> Result<(), String> {
        let mut jobs = self.lock();
        let at = jobs
            .iter()
            .position(|j| j.id == id)
            .ok_or_else(|| "that job is gone".to_string())?;
        let mut trash: Vec<serde_json::Value> = std::fs::read(self.dir.join("trash.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        trash.push(serde_json::json!({ "deleted": Utc::now(), "job": jobs[at] }));
        self.write("trash.json", &trash)?;
        jobs.remove(at);
        self.save(&jobs)
    }

    /// One step of the clock: finish the runs that ended, start the ones
    /// due. Never fails — what went wrong is the job's `note`.
    pub async fn tick(&self, host: &dyn Host, now: DateTime<Utc>) {
        self.tick_with(host, now, true).await;
    }

    /// Item 781: a tick that only finishes the runs that ended and starts
    /// none (the Mac runner once the app asked for the home).
    pub async fn finish_ended(&self, host: &dyn Host, now: DateTime<Utc>) {
        self.tick_with(host, now, false).await;
    }

    /// Whether a run is in flight.
    pub fn any_running(&self) -> bool {
        self.lock().iter().any(|j| j.running.is_some())
    }

    async fn tick_with(&self, host: &dyn Host, now: DateTime<Utc>, start: bool) {
        let _one = self.ticking.lock().await;
        host.before_tick(self).await;
        let jobs = self.lock().clone();
        for job in jobs {
            if job.running.is_some() {
                self.finish_if_ended(host, &job, now).await;
            } else if !start {
                continue;
            } else if job.run_now && !job.stand_in {
                self.start(host, &job, now).await;
            } else if !job.paused && job.next_run <= now && job.retry_at.is_none_or(|at| at <= now)
            {
                // Item 781: one holder per run, the Mac or the away server.
                match host.job_claim(&job, job.next_run, now).await {
                    crate::sync::lease::Claim::Granted => self.start(host, &job, now).await,
                    crate::sync::lease::Claim::Wait => {}
                    crate::sync::lease::Claim::Taken { by, .. } => {
                        self.ran_elsewhere(&job, &by, now)
                    }
                }
            }
        }
    }

    /// Item 781: the other host took this run; move on without running it.
    fn ran_elsewhere(&self, job: &Job, by: &str, now: DateTime<Utc>) {
        let due = job.next_run;
        let utc_min = (due.hour() * 60 + due.minute()) as i32;
        let local = (utc_min + offset_at(&job.zone(), due)).rem_euclid(24 * 60);
        let when = clock_words(local.unsigned_abs());
        let place = if by == crate::sync::lease::AWAY {
            "the away server"
        } else {
            "the Mac"
        };
        let _ = self.change(&job.id, |j| {
            j.note = Some(format!("its {when} run ran on {place}"));
            j.retry_at = None;
            if j.next_run <= now {
                j.next_run = j.next_after(now);
            }
        });
    }

    /// Item 781, on the away server: take the Mac's list of away jobs as
    /// stand-in copies. What he set comes from the Mac (message, schedule,
    /// pause, approval); the run state stays the server's. The next run is
    /// the later of the two unless the schedule changed (a run either side
    /// took moved its own copy on); copies the Mac no longer sends go.
    pub fn take_mac_jobs(&self, mac: Vec<Job>) {
        let mut jobs = self.lock();
        let before = jobs.clone();
        jobs.retain(|j| !j.stand_in || mac.iter().any(|m| m.id == j.id));
        for m in mac {
            match jobs.iter_mut().find(|j| j.id == m.id) {
                Some(j) if !j.stand_in => {} // never over a job of the server's own
                Some(j) => {
                    let moved = j.every != m.every || j.tz != m.tz || j.offset_min != m.offset_min;
                    j.next_run = if moved {
                        m.next_run
                    } else {
                        j.next_run.max(m.next_run)
                    };
                    j.title = m.title;
                    j.text = m.text;
                    j.every = m.every;
                    j.tz = m.tz;
                    j.offset_min = m.offset_min;
                    j.project = m.project;
                    j.paused = m.paused;
                    j.approved = m.approved;
                    j.approved_once = m.approved_once;
                    j.watch = m.watch;
                }
                None => {
                    let chat = m.chat.clone();
                    jobs.push(Job {
                        stand_in: true,
                        running: None,
                        retry_at: None,
                        run_now: false,
                        note: None,
                        confirm: None,
                        force_once: false,
                        // The Mac's chat: mirrored, so the first run here
                        // forks it into a chat of the server's own.
                        chat,
                        ..m
                    });
                }
            }
        }
        if *jobs != before {
            let _ = self.save(&jobs);
        }
    }

    /// Item 781, on the away server: whether a job keeps it up — a run in
    /// flight, or one due within `ahead` (an overdue one too, for up to two
    /// hours: a run that keeps failing does not hold the machine all day).
    pub fn keeps_up(&self, now: DateTime<Utc>, ahead: Duration) -> bool {
        self.lock().iter().any(|j| {
            j.running.is_some()
                || j.run_now
                || (!j.paused
                    && j.next_run <= now + ahead
                    && j.next_run >= now - Duration::hours(2))
        })
    }

    async fn start(&self, host: &dyn Host, job: &Job, now: DateTime<Utc>) {
        let wait = |why: String, secs: i64| {
            let _ = self.change(&job.id, |j| {
                j.note = Some(format!("waiting — {why}"));
                j.retry_at = Some(now + Duration::seconds(secs));
            });
        };
        let plan = host.usage().await.ok().map(|u| u.plan);
        if plan.as_ref().is_some_and(limited) {
            return wait(
                "the plan's usage limit is reached; it runs after the reset".into(),
                LIMIT_RETRY_SECS,
            );
        }
        // Item 763 H6: Home's unattended runs stop short of his limits.
        // Item 812: his Run anyway passes once; his Run now asks.
        let forced = job.run_now && job.force_once;
        if !forced && let Some(why) = self.home_guard(job, plan.as_ref(), now) {
            return self.skip(job, &why, plan.as_ref(), job.run_now, now);
        }
        let chat = match host
            .job_prepare(Prep {
                project: job.project.clone(),
                chat: job.chat.clone(),
                title: job.title.clone(),
                read_only: !job.writable(),
                auto_hand_off: (job.id == crate::home::SCAN_JOB_ID)
                    .then_some((crate::hand_off::SOFT_TOKENS, crate::hand_off::HARD_TOKENS)),
                // Blocker 2041: the scan runs on Home's model and effort.
                model: (job.id == crate::home::SCAN_JOB_ID).then(|| {
                    (
                        crate::home::MODEL.to_string(),
                        crate::home::EFFORT.to_string(),
                    )
                }),
                connectors: job.id == crate::home::SCAN_JOB_ID,
            })
            .await
        {
            Ok(chat) => chat,
            Err(e) => return wait(e, RETRY_SECS),
        };
        // Kept before the send: a send that fails must not make a second chat.
        let _ = self.change(&job.id, |j| j.chat = Some(chat.clone()));
        // Item 763: the morning scan's message is its line plus the facts
        // collected now, in code.
        let text = if job.id == crate::home::SCAN_JOB_ID {
            self.scan_text(now, !job.writable())
        } else if let Some(w) = &job.watch {
            // Item 794: his instructions, the sources, the note's latest
            // entries and the answer's shape; its turn end pushes nothing.
            watch::quiet_started(&chat);
            let tail = self
                .config_dir()
                .map(|c| watch::tail(&watch::note_path(&c, job.project.as_deref(), w)))
                .unwrap_or_default();
            let today = watch::stamp(now, &job.zone());
            watch::run_text(&job.text, w, &tail, &today)
        } else {
            job.text.clone()
        };
        // Item 763: from before the send (a quick turn's end push must
        // find it), the run's own row is this chat's only one.
        crate::home::job_run_started(&chat);
        match host.job_send(job.project.as_deref(), &chat, &text).await {
            Ok(Handed::Sent | Handed::Queued) => {
                let _ = self.change(&job.id, |j| {
                    j.running = Some(RunMark {
                        started: now,
                        writable: job.writable(),
                        week_before: plan.as_ref().and_then(|p| p.seven_day),
                        resets_at: plan.as_ref().and_then(|p| p.seven_day_resets_at.clone()),
                        five_before: plan.as_ref().and_then(|p| p.five_hour),
                        five_resets_at: plan.as_ref().and_then(|p| p.five_hour_resets_at.clone()),
                        forced,
                    });
                    j.run_now = false;
                    j.force_once = false;
                    j.confirm = None;
                    j.retry_at = None;
                    j.note = None;
                    j.runs += 1;
                    // Approve once is used by this run; the next one asks.
                    // (Its chat was set writable just now, by `prepare`.)
                    if j.approved_once.is_some() && job.approved_once.is_some() {
                        j.approved_once = None;
                    }
                    // From now, not from the time it was due: a host that
                    // was off for a day runs it once.
                    if j.next_run <= now {
                        j.next_run = j.next_after(now);
                    }
                });
            }
            Err(e) => {
                crate::home::job_run_ended(&chat);
                if job.watch.is_some() {
                    watch::quiet_ended(&chat);
                }
                wait(e, RETRY_SECS)
            }
        }
    }

    /// Whether `job` is one of Home's: the morning scan, or any job in
    /// Home's project.
    fn is_home_job(&self, job: &Job) -> bool {
        if job.id == crate::home::SCAN_JOB_ID {
            return true;
        }
        let (Some(project), Some(config)) = (&job.project, self.config_dir()) else {
            return false;
        };
        crate::project::Registry::load_in(&config)
            .find(project)
            .is_some_and(|p| p.source.as_deref() == Some(crate::home::SOURCE))
    }

    /// Item 763 H6: why a Home job must not start now (the 80% stop, the
    /// pace, today's cap), `None` for any other job or when it may run.
    fn home_guard(
        &self,
        job: &Job,
        plan: Option<&PlanUsage>,
        now: DateTime<Utc>,
    ) -> Option<String> {
        if !self.is_home_job(job) {
            return None;
        }
        let config = self.config_dir()?;
        let date = local_date(now, &job.zone()).unwrap_or_else(|| now.date_naive());
        let spent = crate::home::guard::spent(&config, date).points;
        // The pace from this home's own usage log (not the process's).
        let pace = crate::home::guard::pace_in(&config, now);
        crate::home::guard::stop_reason(plan, Some(&pace), spent, crate::home::guard::cap(&config))
    }

    /// A Home run the guard stopped: its row says why, its next time is
    /// the next one (no retry each minute), and a skipped scan writes its
    /// code-only page. Item 812: a run he pressed (`pressed`) carries the
    /// Run anyway card instead of the page.
    fn skip(
        &self,
        job: &Job,
        why: &str,
        plan: Option<&PlanUsage>,
        pressed: bool,
        now: DateTime<Utc>,
    ) {
        let summary = format!("skipped — {why}");
        let _ = self.change(&job.id, |j| {
            j.last = Some(LastRun {
                started: now,
                ended: now,
                outcome: Outcome::Skipped,
                summary: summary.clone(),
                week_points: None,
                week_after: None,
                calls: None,
                forced: false,
                five_points: None,
            });
            if pressed {
                j.confirm = Some(run_confirm(j, why, plan, now));
            }
            j.note = Some(summary.clone());
            j.run_now = false;
            j.retry_at = None;
            if j.next_run <= now {
                j.next_run = j.next_after(now);
            }
        });
        if !pressed
            && job.id == crate::home::SCAN_JOB_ID
            && let Some(config) = self.config_dir()
        {
            let date = local_date(now, &job.zone()).unwrap_or_else(|| now.date_naive());
            let text = self.scan_text(now, false);
            let facts = text
                .split_once("<facts>\n")
                .and_then(|(_, r)| r.split_once("</facts>"))
                .map_or(text.trim(), |(f, _)| f.trim());
            let _ = crate::home::guard::skipped_scan_page(&config, date, why, facts, now);
        }
    }

    async fn finish_if_ended(&self, host: &dyn Host, job: &Job, now: DateTime<Utc>) {
        let (Some(mark), Some(chat)) = (&job.running, &job.chat) else {
            let _ = self.change(&job.id, |j| j.running = None);
            return;
        };
        // Item 763: a relaunch mid-run forgets the process's runs; every
        // tick of a running job says it again.
        crate::home::job_run_started(chat);
        if job.watch.is_some() {
            watch::quiet_started(chat);
        }
        let age = (now - mark.started).num_seconds();
        if age < RUN_GRACE_SECS {
            return;
        }
        let listed = match host.running().await {
            Ok(r) => r
                .chats
                .iter()
                .any(|c| c.chat.as_deref() == Some(chat.as_str())),
            // A host with no running list: its state's one flag.
            Err(e) if e == NOT_AVAILABLE => host.state().await.busy,
            // The host did not answer: ask again next tick.
            Err(_) => true,
        };
        if listed && age < RUN_MAX_SECS {
            return;
        }
        let mut refused = Vec::new();
        let mut calls = None;
        let mut full_reply: Option<String> = None;
        let mut opened: Vec<String> = Vec::new();
        let (outcome, mut summary) = if listed {
            (
                Outcome::Unfinished,
                "still running after six hours — open its chat".to_string(),
            )
        } else {
            match host.transcript(job.project.as_deref(), chat).await {
                Ok(events) => {
                    let events: Vec<serde_json::Value> = events
                        .iter()
                        .filter_map(|e| serde_json::to_value(e).ok())
                        .collect();
                    if !mark.writable {
                        refused = refused_in(&events, &job.text);
                    }
                    calls = crate::runaway::calls_in(&events, &job.text);
                    full_reply = reply_in(&events, &job.text);
                    if job.watch.is_some() {
                        opened = watch::opened_in(&events, &job.text);
                    }
                    match full_reply.clone() {
                        // Item 784: he chose Stop on the guard's card.
                        Some(reply) if stopped_reply(&reply).is_some() => (
                            Outcome::Stopped,
                            cut(stopped_reply(&reply).unwrap_or_default()),
                        ),
                        Some(reply) => (Outcome::Done, cut(&reply)),
                        // Item 896: the stand-in's reason, when there is one.
                        None => (
                            Outcome::Failed,
                            match failure_in(&events, &job.text) {
                                Some(why) => cut(&format!("the run failed: {why} — open its chat")),
                                None => "the run ended with no reply — open its chat".to_string(),
                            },
                        ),
                    }
                }
                Err(e) => (Outcome::Failed, format!("its chat could not be read: {e}")),
            }
        };
        // Item 794: a watch's finished run appends its entry to the note
        // (in code, append-only); the Jobs list shows its first line.
        let mut changed: Option<String> = None;
        if let (Some(w), Outcome::Done, Some(reply), Some(config)) =
            (&job.watch, outcome, &full_reply, self.config_dir())
        {
            let e = watch::entry(reply, &opened, &watch::stamp(mark.started, &job.zone()));
            let path = watch::note_path(&config, job.project.as_deref(), w);
            summary = match watch::append(&path, &job.title, &w.topic, &e) {
                Ok(()) if e.changed => {
                    changed = Some(e.headline.clone());
                    cut(&format!(
                        "{} ({} new, {} unverified)",
                        e.headline, e.verified, e.unverified
                    ))
                }
                Ok(()) if e.unverified > 0 => cut(&format!(
                    "Nothing verified new ({} unverified)",
                    e.unverified
                )),
                Ok(()) => watch::NOTHING_NEW.into(),
                Err(err) => format!("its note could not be written: {err}"),
            };
        }
        let after = host.usage().await.ok().map(|u| u.plan);
        let points = after.as_ref().and_then(|a| week_points(mark, a));
        let five = after.as_ref().and_then(|a| five_points(mark, a));
        let wants = !refused.is_empty();
        let summary_line = summary.clone();
        let _ = self.change(&job.id, |j| {
            j.running = None;
            // A read-only run that was refused a change asks; one that was
            // not leaves an earlier ask standing until he answers it.
            if wants {
                j.wanted = Some(Wanted {
                    at: now,
                    what: refused,
                });
            }
            if let Some(a) = &after
                && j.week.resets_at != a.seven_day_resets_at
            {
                j.week = WeekCost {
                    resets_at: a.seven_day_resets_at.clone(),
                    ..WeekCost::default()
                };
            }
            j.week.runs += 1;
            j.week.points += u32::from(points.unwrap_or(0));
            j.last = Some(LastRun {
                started: mark.started,
                ended: now,
                outcome,
                summary,
                week_points: points,
                week_after: after.as_ref().and_then(|a| a.seven_day),
                calls,
                forced: mark.forced,
                five_points: five,
            });
            // Item 812: a finished run's cost is the next estimate's measure.
            if let (Some(week), Outcome::Done) = (points, outcome) {
                j.recent_cost.push(RunCost { week, five });
                let over = j.recent_cost.len().saturating_sub(COST_KEEP);
                j.recent_cost.drain(..over);
            }
            // A finished run is the measure of the next one's ceiling; a
            // stopped one is not (it was the runaway).
            if let (Some(n), Outcome::Done) = (calls, outcome) {
                j.recent_calls.push(n);
                let over = j
                    .recent_calls
                    .len()
                    .saturating_sub(crate::runaway::USUAL_KEEP);
                j.recent_calls.drain(..over);
            }
        });
        // Item 763 H6: a Home run's points count toward today's cap.
        if self.is_home_job(job)
            && let Some(config) = self.config_dir()
        {
            let date = local_date(now, &job.zone()).unwrap_or_else(|| now.date_naive());
            crate::home::guard::record(&config, date, points);
        }
        // Item 763: every run's end is a feed row; the scan keeps its page
        // and pushes its counts.
        // One row per run: a scan that kept its page is its `scan` row
        // alone; every other end is a `job_done` / `job_failed` row.
        if let Some(config) = self.config_dir() {
            let ok = outcome == Outcome::Done;
            // Item 789: a run in a chat with a hand-off chain that wrote no
            // run-log entry of its own gets one from code — a failure in
            // words, or the start of its reply.
            let logs = crate::chain::log_dir_for(&config, job.project.as_deref());
            let _ = crate::chain::close_run(
                &logs,
                chat,
                mark.started,
                now,
                ok,
                &summary_line,
                full_reply.as_deref(),
            );
            let mut scanned = false;
            if job.id == crate::home::SCAN_JOB_ID
                && ok
                && let Some(reply) = &full_reply
            {
                let date = local_date(now, &job.zone()).unwrap_or_else(|| now.date_naive());
                scanned = crate::home::finish_scan(&config, reply, date, Some(chat), now).is_ok();
                if scanned && let Some(push) = host.push() {
                    push.notify(crate::home::scan_note(
                        reply,
                        Some(chat.clone()),
                        job.project.clone(),
                        host.at_the_mac(),
                    ))
                    .await;
                }
            }
            if !scanned {
                crate::home::append(
                    &config,
                    &crate::home::FeedRow {
                        at: now,
                        kind: if ok { "job_done" } else { "job_failed" }.into(),
                        label: Some(job.title.clone()),
                        chat: Some(chat.clone()),
                        project: job.project.clone(),
                        line: summary_line.clone(),
                    },
                );
            }
        }
        crate::home::job_run_ended(chat);
        if job.watch.is_some() {
            watch::quiet_ended(chat);
        }
        // Item 794: a watch run that found something pushes its first line.
        if let Some(headline) = changed
            && let Some(push) = host.push()
        {
            push.notify(watch::change_note(
                &headline,
                &job.title,
                Some(chat.clone()),
                job.project.clone(),
                host.at_the_mac(),
            ))
            .await;
        }
        // Its push: the job's name and "wants to make changes", nothing of
        // the reply. Not while he is at the Mac (the Mac's chat shows it).
        if wants && let Some(push) = host.push() {
            push.notify(crate::push::Note {
                what: crate::push::What::Changes,
                chat: Some(chat.clone()),
                label: Some(job.title.clone()),
                project: job.project.clone(),
                at_the_mac: host.at_the_mac(),
                detail: None,
            })
            .await;
        }
    }
}

/// The clock: a tick every [`TICK`] until `closing` is cancelled (the
/// listener stopped). One per listener; a tick that overlaps another waits.
pub async fn run_loop(
    jobs: Arc<Jobs>,
    host: Arc<dyn Host>,
    closing: tokio_util::sync::CancellationToken,
) {
    loop {
        jobs.tick(host.as_ref(), Utc::now()).await;
        // Item 763 H5: Home's routes start and finish on the same clock.
        crate::home::route::tick(host.as_ref(), Utc::now()).await;
        tokio::select! {
            _ = closing.cancelled() => return,
            _ = tokio::time::sleep(TICK) => {}
        }
    }
}

pub mod knock;
pub mod runner;
pub mod watch;

#[cfg(test)]
mod tests;
