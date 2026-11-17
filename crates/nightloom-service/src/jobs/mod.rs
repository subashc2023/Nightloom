//! Recurring jobs (nightshift item 746): a message that sends itself
//! "every morning", "every 2 hours", "every Monday at 9am", set up from
//! the phone, each run in the job's own chat.
//!
//! - **The schedule** ([`Every`]): parsed from his words ([`Every::parse`])
//!   and kept as data; the next run is pure arithmetic over the phone's
//!   own clock offset ([`Every::next_after`]), so the away server (whose
//!   clock is UTC) runs "8:00 AM" at his 8:00 AM.
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
//!   tools and subagents are refused by hook) until he approves the job's
//!   plan on the phone. The host sets that before every run
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

use chrono::{DateTime, Datelike, Duration, FixedOffset, NaiveTime, TimeZone, Utc};
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
    /// minutes east of UTC (the phone's, kept on the job). Pure.
    pub fn next_after(&self, after: DateTime<Utc>, offset_min: i32) -> DateTime<Utc> {
        match self {
            Every::Minutes { n } => after + Duration::minutes(i64::from((*n).max(1))),
            Every::Hours { n } => after + Duration::hours(i64::from((*n).max(1))),
            Every::Days { at_min, days } => {
                let offset = FixedOffset::east_opt(offset_min.clamp(-14 * 60, 14 * 60) * 60)
                    .unwrap_or_else(|| FixedOffset::east_opt(0).expect("zero is an offset"));
                let local = after.with_timezone(&offset);
                let time = NaiveTime::from_num_seconds_from_midnight_opt((*at_min % 1440) * 60, 0)
                    .unwrap_or(NaiveTime::MIN);
                for d in 0..=7 {
                    let date = local.date_naive() + Duration::days(d);
                    let weekday = date.weekday().num_days_from_monday() as u8;
                    if !days.is_empty() && !days.contains(&weekday) {
                        continue;
                    }
                    if let Some(at) = offset.from_local_datetime(&date.and_time(time)).single() {
                        let at = at.with_timezone(&Utc);
                        if at > after {
                            return at;
                        }
                    }
                }
                after + Duration::days(1)
            }
        }
    }
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
    #[serde(default)]
    pub week_before: Option<u8>,
    #[serde(default)]
    pub resets_at: Option<String>,
}

/// One recurring job.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Job {
    pub id: String,
    pub title: String,
    /// The message each run sends.
    pub text: String,
    pub every: Every,
    /// The phone's clock when it was made, minutes east of UTC.
    #[serde(default)]
    pub offset_min: i32,
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
    /// When he approved its plan: from then its runs may write. `None` is
    /// read-only.
    #[serde(default)]
    pub approved: Option<DateTime<Utc>>,
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
}

/// A job as `/api/jobs` lists it: the job, its schedule in words, and
/// whether it is read-only.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobView {
    #[serde(flatten)]
    pub job: Job,
    pub every_words: String,
    pub read_only: bool,
}

impl From<Job> for JobView {
    fn from(job: Job) -> Self {
        Self {
            every_words: job.every.words(),
            read_only: job.approved.is_none(),
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
    /// `true`: he approved the job's plan — its runs may write from now.
    /// `false`: read-only again.
    #[serde(default)]
    pub approve_plan: Option<bool>,
    #[serde(default)]
    pub offset_min: Option<i32>,
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
    let mut session = nightloom_core::Session::load(path).map_err(|e| e.to_string())?;
    if session.kind() != want {
        crate::chat_ops::set_kind(&mut session, want, None);
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
}

/// A title from the message when he gave none: its first line, cut.
fn title_from(text: &str) -> String {
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

fn weekday_at(now: DateTime<Utc>, offset_min: i32) -> u8 {
    let offset = FixedOffset::east_opt(offset_min.clamp(-14 * 60, 14 * 60) * 60)
        .unwrap_or_else(|| FixedOffset::east_opt(0).expect("zero is an offset"));
    now.with_timezone(&offset).weekday().num_days_from_monday() as u8
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
        .filter(|e| e["event"] == "assistant_message")
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
    pub fn open(dir: PathBuf) -> Arc<Self> {
        let jobs = std::fs::read(dir.join("jobs.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<Vec<Job>>(&b).ok())
            .unwrap_or_default();
        Arc::new(Self {
            dir,
            inner: Mutex::new(jobs),
            ticking: tokio::sync::Mutex::new(()),
        })
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

    /// Every job, soonest next run first (paused ones last).
    pub fn list(&self) -> Vec<JobView> {
        let mut jobs = self.lock().clone();
        jobs.sort_by_key(|j| (j.paused, j.next_run));
        jobs.into_iter().map(JobView::from).collect()
    }

    /// A new job, read-only, its first run at the schedule's next time.
    pub fn create(&self, req: NewJob, now: DateTime<Utc>) -> Result<JobView, String> {
        let text = req.text.trim().to_string();
        if text.is_empty() {
            return Err("a job needs the message it repeats".into());
        }
        let every = Every::parse(&req.every, weekday_at(now, req.offset_min))?;
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
            .unwrap_or_else(|| title_from(&text));
        let job = Job {
            id: uuid::Uuid::new_v4().simple().to_string(),
            title,
            text,
            next_run: every.next_after(now, req.offset_min),
            every,
            offset_min: req.offset_min,
            project: req.project.filter(|p| !p.trim().is_empty()),
            chat: None,
            from_chat: req.from_chat.filter(|c| !c.trim().is_empty()),
            paused: false,
            approved: None,
            created: now,
            retry_at: None,
            run_now: false,
            running: None,
            last: None,
            week: WeekCost::default(),
            note: None,
            runs: 0,
            recent_calls: Vec::new(),
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
        let every = match &patch.every {
            Some(words) => Some(Every::parse(words, weekday_at(now, offset))?),
            None => None,
        };
        if patch.text.as_deref().is_some_and(|t| t.trim().is_empty()) {
            return Err("a job needs the message it repeats".into());
        }
        if patch.title.as_deref().is_some_and(|t| t.trim().is_empty()) {
            return Err("a job needs a name".into());
        }
        self.change(id, |job| {
            if let Some(text) = patch.text {
                let text = text.trim().to_string();
                if text != job.text {
                    job.text = text;
                    job.approved = None;
                }
            }
            if let Some(title) = patch.title {
                job.title = title.trim().to_string();
            }
            job.offset_min = offset;
            if let Some(every) = every {
                job.next_run = every.next_after(now, offset);
                job.every = every;
                job.retry_at = None;
                job.note = None;
            }
            match patch.approve_plan {
                Some(true) if job.approved.is_none() => job.approved = Some(now),
                Some(false) => job.approved = None,
                _ => {}
            }
            if let Some(paused) = patch.paused {
                // Resumed: from its next time, not the ones it sat out.
                if job.paused && !paused && job.next_run <= now {
                    job.next_run = job.every.next_after(now, job.offset_min);
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
        let _one = self.ticking.lock().await;
        let jobs = self.lock().clone();
        for job in jobs {
            if job.running.is_some() {
                self.finish_if_ended(host, &job, now).await;
            } else if job.run_now
                || (!job.paused && job.next_run <= now && job.retry_at.is_none_or(|at| at <= now))
            {
                self.start(host, &job, now).await;
            }
        }
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
        let chat = match host
            .job_prepare(Prep {
                project: job.project.clone(),
                chat: job.chat.clone(),
                title: job.title.clone(),
                read_only: job.approved.is_none(),
            })
            .await
        {
            Ok(chat) => chat,
            Err(e) => return wait(e, RETRY_SECS),
        };
        // Kept before the send: a send that fails must not make a second chat.
        let _ = self.change(&job.id, |j| j.chat = Some(chat.clone()));
        match host
            .job_send(job.project.as_deref(), &chat, &job.text)
            .await
        {
            Ok(Handed::Sent | Handed::Queued) => {
                let _ = self.change(&job.id, |j| {
                    j.running = Some(RunMark {
                        started: now,
                        week_before: plan.as_ref().and_then(|p| p.seven_day),
                        resets_at: plan.as_ref().and_then(|p| p.seven_day_resets_at.clone()),
                    });
                    j.run_now = false;
                    j.retry_at = None;
                    j.note = None;
                    j.runs += 1;
                    // From now, not from the time it was due: a host that
                    // was off for a day runs it once.
                    if j.next_run <= now {
                        j.next_run = j.every.next_after(now, j.offset_min);
                    }
                });
            }
            Err(e) => wait(e, RETRY_SECS),
        }
    }

    async fn finish_if_ended(&self, host: &dyn Host, job: &Job, now: DateTime<Utc>) {
        let (Some(mark), Some(chat)) = (&job.running, &job.chat) else {
            let _ = self.change(&job.id, |j| j.running = None);
            return;
        };
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
        let mut calls = None;
        let (outcome, summary) = if listed {
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
                    calls = crate::runaway::calls_in(&events, &job.text);
                    match reply_in(&events, &job.text) {
                        // Item 784: he chose Stop on the guard's card.
                        Some(reply) if stopped_reply(&reply).is_some() => (
                            Outcome::Stopped,
                            cut(stopped_reply(&reply).unwrap_or_default()),
                        ),
                        Some(reply) => (Outcome::Done, cut(&reply)),
                        None => (
                            Outcome::Failed,
                            "the run ended with no reply — open its chat".to_string(),
                        ),
                    }
                }
                Err(e) => (Outcome::Failed, format!("its chat could not be read: {e}")),
            }
        };
        let after = host.usage().await.ok().map(|u| u.plan);
        let points = after.as_ref().and_then(|a| week_points(mark, a));
        let _ = self.change(&job.id, |j| {
            j.running = None;
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
            });
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
        tokio::select! {
            _ = closing.cancelled() => return,
            _ = tokio::time::sleep(TICK) => {}
        }
    }
}

#[cfg(test)]
mod tests;
