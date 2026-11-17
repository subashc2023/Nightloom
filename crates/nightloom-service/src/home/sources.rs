//! What macOS keeps on this Mac, read for Home (nightshift item 808,
//! blocker 2070's answer): Messages, Contacts, Reminders and the Calendar
//! app — each only once he has allowed it from inside Nightloom, and only
//! while he leaves it switched on.
//!
//! - **The stores are the app's** ([`MacStores`]): the Mac app installs
//!   its reader at launch ([`install`]) — Contacts and EventKit through
//!   their frameworks, Messages from its own database file. Nothing here
//!   raises a macOS dialog: [`MacStores::access`] only reads the status.
//!   A host with no reader (the away server, the closed-app runner) reads
//!   none of them and says so.
//! - **His switches** are `home/sources.json`: the sources he granted
//!   from inside Nightloom (his Allow press, or his switch turned on —
//!   [`grant`], [`set_on`]) and the ones he turned off. A store macOS
//!   already lets Nightloom read for another reason (Full Disk Access
//!   given earlier, say) is **not** read until he grants it here (merge
//!   round S, 2026-11-17; his "not by default", blocker 2070).
//! - **The scan's facts** ([`facts`]): per source, what it holds now, each
//!   section ending in a `cite:` line the page can quote; a source not
//!   allowed or switched off is one line saying why. Messages carries who
//!   wrote and when, never a message's text: anyone can text him, so a
//!   body would be text from a stranger in the scan's prompt and on a page
//!   the phone and the away server see.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::{Arc, OnceLock};

use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, TimeZone, Utc};
use serde::{Deserialize, Serialize};

/// One of the four stores.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Messages,
    Contacts,
    Reminders,
    Calendar,
}

impl Source {
    /// In the panel's order.
    pub const ALL: [Source; 4] = [
        Source::Messages,
        Source::Contacts,
        Source::Reminders,
        Source::Calendar,
    ];

    /// The wire id (`messages`, …).
    pub fn id(self) -> &'static str {
        match self {
            Source::Messages => "messages",
            Source::Contacts => "contacts",
            Source::Reminders => "reminders",
            Source::Calendar => "calendar",
        }
    }

    pub fn parse(id: &str) -> Option<Source> {
        Source::ALL.into_iter().find(|s| s.id() == id)
    }

    /// Its name in plain words.
    pub fn name(self) -> &'static str {
        match self {
            Source::Messages => "Messages",
            Source::Contacts => "Contacts",
            Source::Reminders => "Reminders",
            Source::Calendar => "Calendar app",
        }
    }

    /// The System Settings pane where its permission lives.
    pub fn settings_url(self) -> &'static str {
        match self {
            Source::Messages => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
            }
            Source::Contacts => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Contacts"
            }
            Source::Reminders => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders"
            }
            Source::Calendar => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars"
            }
        }
    }

    /// That pane's name, as System Settings shows it.
    fn settings_name(self) -> &'static str {
        match self {
            Source::Messages => "Full Disk Access",
            Source::Contacts => "Contacts",
            Source::Reminders => "Reminders",
            Source::Calendar => "Calendars",
        }
    }

    /// What the scan reads from it.
    fn reads(self) -> &'static str {
        match self {
            Source::Messages => {
                "who wrote to you in the last day and when (never the messages themselves)"
            }
            Source::Contacts => "birthdays in the next 7 days",
            Source::Reminders => "what is due today and what is overdue",
            Source::Calendar => {
                "today's and tomorrow's events, less the calendars your Google connectors read"
            }
        }
    }
}

/// Whether Nightloom may read a store, as macOS says now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Access {
    Allowed,
    /// Never asked (for Messages: Full Disk Access is off, which macOS
    /// cannot tell apart from a no).
    NotAsked,
    Denied,
    /// Reminders / Calendar: allowed to add only (macOS 14's write-only).
    WriteOnly,
    /// Not on this host: the store is missing, or this host has no reader.
    NotOnThisMac,
}

/// One Messages thread with a message in the last day.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Thread {
    /// A contact's name when Contacts is allowed, else the group's name,
    /// the number or the address.
    pub who: String,
    /// Messages in the window.
    pub count: u32,
    pub newest: DateTime<Utc>,
    /// The newest message is theirs, not his.
    pub theirs_last: bool,
}

/// An incomplete reminder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reminder {
    pub title: String,
    pub due: Option<DateTime<Utc>>,
    /// The due date has no time of day.
    pub all_day: bool,
    pub list: String,
}

/// A Calendar app event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    pub title: String,
    pub start: DateTime<Utc>,
    pub all_day: bool,
    pub calendar: String,
    /// The account the calendar belongs to (its source's title: an
    /// address for a Google calendar, "iCloud", "On My Mac").
    pub account: String,
}

/// A contact with a birthday.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Birthday {
    pub name: String,
    pub month: u32,
    pub day: u32,
}

/// What one store holds over the scan's window.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Found {
    Messages(Vec<Thread>),
    Contacts(Vec<Birthday>),
    Reminders(Vec<Reminder>),
    Calendar(Vec<Event>),
}

/// The times a read covers, all in UTC.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window {
    pub now: DateTime<Utc>,
    /// Messages since (now − 24 h).
    pub since: DateTime<Utc>,
    /// His local midnight today.
    pub today: DateTime<Utc>,
    /// His local midnight tomorrow (reminders due before it).
    pub tomorrow: DateTime<Utc>,
    /// His local midnight the day after tomorrow (events before it).
    pub day_after: DateTime<Utc>,
}

impl Window {
    /// The window at `now` in `tz`.
    pub fn at<Tz: TimeZone>(now: DateTime<Utc>, tz: &Tz) -> Window {
        let local = now.with_timezone(tz).date_naive();
        let midnight = |d: NaiveDate| {
            tz.from_local_datetime(&d.and_hms_opt(0, 0, 0).unwrap_or_default())
                .earliest()
                .map_or(now, |t| t.with_timezone(&Utc))
        };
        Window {
            now,
            since: now - Duration::hours(24),
            today: midnight(local),
            tomorrow: midnight(local + Duration::days(1)),
            day_after: midnight(local + Duration::days(2)),
        }
    }
}

/// The Mac's reader of its own stores. [`access`](MacStores::access)
/// never raises a dialog; [`read`](MacStores::read) is called only for a
/// store that is allowed and on.
pub trait MacStores: Send + Sync {
    fn access(&self, source: Source) -> Access;
    fn read(&self, source: Source, window: &Window) -> Result<Found, String>;
}

static STORES: OnceLock<Arc<dyn MacStores>> = OnceLock::new();

/// The Mac app's reader, installed once at launch.
pub fn install(stores: Arc<dyn MacStores>) {
    let _ = STORES.set(stores);
}

/// The installed reader; `None` on a host that has none.
pub fn installed() -> Option<Arc<dyn MacStores>> {
    STORES.get().cloned()
}

/// His choices (`home/sources.json`): the sources he granted from inside
/// Nightloom, and the ones he turned off since.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Choices {
    #[serde(default)]
    off: BTreeSet<Source>,
    /// Granted in the app: his Allow press or his switch turned on.
    #[serde(default)]
    granted: BTreeSet<Source>,
}

fn choices(config: &Path) -> Choices {
    std::fs::read(super::dir_in(config).join("sources.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Whether Home may read `source` as far as he is concerned: he granted
/// it from inside Nightloom and has not turned it off since. Never on by
/// default, whatever macOS already allows.
pub fn is_on(config: &Path, source: Source) -> bool {
    let c = choices(config);
    c.granted.contains(&source) && !c.off.contains(&source)
}

/// Turn a source on or off for Home. On is his grant.
pub fn set_on(config: &Path, source: Source, on: bool) -> Result<(), String> {
    let dir = super::ensure_folder(config).map_err(|e| e.to_string())?;
    let mut c = choices(config);
    if on {
        c.off.remove(&source);
        c.granted.insert(source);
    } else {
        c.off.insert(source);
    }
    let bytes = serde_json::to_vec_pretty(&c).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("sources.json"), bytes).map_err(|e| e.to_string())
}

/// Whether he ever granted `source` from inside Nightloom.
pub fn is_granted(config: &Path, source: Source) -> bool {
    choices(config).granted.contains(&source)
}

/// His Allow press on `source` in Settings → Home: granted, and on.
pub fn grant(config: &Path, source: Source) -> Result<(), String> {
    set_on(config, source, true)
}

/// One row of the panel and of `GET /api/home/sources`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Row {
    pub id: Source,
    pub name: &'static str,
    pub status: Access,
    /// His switch (meaningful once allowed).
    pub on: bool,
    /// What it means now, in one plain sentence.
    pub why: String,
    /// The System Settings pane for it.
    pub settings_url: &'static str,
}

/// Why a source is where it is, in one sentence.
fn why(source: Source, status: Access, on: bool, granted: bool, reader: bool) -> String {
    let pane = source.settings_name();
    match status {
        Access::Allowed if on => format!("The morning scan reads {}.", source.reads()),
        Access::Allowed if !granted => {
            "macOS already allows it; Home reads it once you turn it on here.".into()
        }
        Access::Allowed => "Allowed, and turned off for Home.".into(),
        Access::NotAsked if source == Source::Messages => {
            "Press Allow, then turn on Nightloom under Full Disk Access in System Settings.".into()
        }
        Access::NotAsked => "Not allowed yet. Press Allow and macOS asks you once.".into(),
        Access::Denied => format!(
            "You said no before. Turn on Nightloom in System Settings → Privacy & Security → {pane}."
        ),
        Access::WriteOnly => format!(
            "Allowed to add only. Home needs full access: System Settings → Privacy & Security → {pane}."
        ),
        Access::NotOnThisMac if reader => format!("{} has nothing on this Mac.", source.name()),
        Access::NotOnThisMac => "Only the Nightloom app on your Mac reads this.".into(),
    }
}

/// The four rows, read now through `stores` (none: every row is "not on
/// this Mac").
pub fn rows(config: &Path, stores: Option<&dyn MacStores>) -> Vec<Row> {
    Source::ALL
        .into_iter()
        .map(|s| {
            let status = stores.map_or(Access::NotOnThisMac, |r| r.access(s));
            let on = is_on(config, s);
            Row {
                id: s,
                name: s.name(),
                status,
                on,
                why: why(s, status, on, is_granted(config, s), stores.is_some()),
                settings_url: s.settings_url(),
            }
        })
        .collect()
}

/// Text from his stores, made safe to sit in the scan's facts: one line,
/// no markup that could close the facts, at most `max` characters.
fn clean(text: &str, max: usize) -> String {
    let one: String = text
        .chars()
        .map(|c| match c {
            '<' => '‹',
            '>' => '›',
            '`' => '\'',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let one = one.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= max {
        return if one.is_empty() {
            "(untitled)".into()
        } else {
            one
        };
    }
    let mut cut: String = one.chars().take(max.saturating_sub(1)).collect();
    cut.push('…');
    cut
}

/// At most this many lines per source.
const LINES_MAX: usize = 12;

fn clock<Tz: TimeZone>(t: DateTime<Utc>, tz: &Tz) -> String
where
    Tz::Offset: std::fmt::Display,
{
    t.with_timezone(tz).format("%-I:%M %p").to_string()
}

fn day<Tz: TimeZone>(t: DateTime<Utc>, tz: &Tz) -> String
where
    Tz::Offset: std::fmt::Display,
{
    t.with_timezone(tz).format("%a %b %-d").to_string()
}

/// Days from `today` to the next `month`/`day` (0 = today). Feb 29 falls on
/// Feb 28 in a year without one.
fn days_until(today: NaiveDate, month: u32, day: u32) -> Option<i64> {
    let on = |y: i32| {
        NaiveDate::from_ymd_opt(y, month, day)
            .or_else(|| (month == 2 && day == 29).then(|| NaiveDate::from_ymd_opt(y, 2, 28))?)
    };
    let this = on(today.year())?;
    let next = if this >= today {
        this
    } else {
        on(today.year() + 1)?
    };
    Some((next - today).num_days())
}

/// One source's section of the facts: its lines, then its `cite:` line.
fn section<Tz: TimeZone>(found: Found, w: &Window, tz: &Tz, google: &[String]) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let mut out = String::new();
    let cite = match found {
        Found::Messages(mut threads) => {
            out.push_str("### Messages — the last day (who and when; no message text)\n\n");
            threads.retain(|t| t.newest >= w.since);
            threads.sort_by_key(|t| std::cmp::Reverse(t.newest));
            for t in threads.iter().take(LINES_MAX) {
                out.push_str(&format!(
                    "- {} · {} message{} · newest {} {}{}\n",
                    clean(&t.who, 60),
                    t.count,
                    if t.count == 1 { "" } else { "s" },
                    day(t.newest, tz),
                    clock(t.newest, tz),
                    if t.theirs_last {
                        " · the last one is theirs"
                    } else {
                        " · you wrote last"
                    }
                ));
            }
            let waiting = threads.iter().filter(|t| t.theirs_last).count();
            match threads.first() {
                None => "Messages — no messages in the last day.".to_string(),
                Some(t) => format!(
                    "Messages — {} thread{} in the last day, {waiting} with the last word theirs; newest from {} at {}.",
                    threads.len(),
                    if threads.len() == 1 { "" } else { "s" },
                    clean(&t.who, 60),
                    clock(t.newest, tz)
                ),
            }
        }
        Found::Reminders(mut list) => {
            out.push_str("### Reminders — due today and overdue\n\n");
            list.retain(|r| r.due.is_some_and(|d| d < w.tomorrow));
            list.sort_by_key(|r| r.due);
            let overdue = |r: &Reminder| {
                r.due
                    .is_some_and(|d| if r.all_day { d < w.today } else { d < w.now })
            };
            for r in list.iter().take(LINES_MAX) {
                let due = r.due.unwrap_or(w.now);
                let when = if overdue(r) {
                    format!("OVERDUE since {}", day(due, tz))
                } else if r.all_day {
                    "due today".to_string()
                } else {
                    format!("due today {}", clock(due, tz))
                };
                out.push_str(&format!(
                    "- {when}: {} (list {})\n",
                    clean(&r.title, 80),
                    clean(&r.list, 40)
                ));
            }
            let late = list.iter().filter(|r| overdue(r)).count();
            match list.first() {
                None => "Reminders — nothing due today and nothing overdue.".to_string(),
                Some(r) => format!(
                    "Reminders — {late} overdue, {} due today; first: \"{}\".",
                    list.len() - late,
                    clean(&r.title, 80)
                ),
            }
        }
        Found::Calendar(mut events) => {
            out.push_str("### Calendar app — today and tomorrow\n\n");
            let before = events.len();
            let is_google = |e: &Event| {
                google.iter().any(|a| {
                    a.eq_ignore_ascii_case(e.account.trim())
                        || a.eq_ignore_ascii_case(e.calendar.trim())
                })
            };
            events.retain(|e| {
                e.start < w.day_after
                    && e.start >= w.today
                    && !is_google(e)
                    // Contacts' birthdays are their own section.
                    && e.calendar != "Birthdays"
            });
            let skipped = before - events.len();
            events.sort_by_key(|e| e.start);
            for e in events.iter().take(LINES_MAX) {
                let which = if e.start < w.tomorrow {
                    "today"
                } else {
                    "tomorrow"
                };
                let at = if e.all_day {
                    "all day".to_string()
                } else {
                    clock(e.start, tz)
                };
                out.push_str(&format!(
                    "- {which} {at}: {} (calendar {})\n",
                    clean(&e.title, 80),
                    clean(&e.calendar, 40)
                ));
            }
            if skipped > 0 {
                out.push_str(&format!(
                    "({skipped} other event{} skipped: outside the two days, on a calendar a Google connector reads, or birthdays.)\n",
                    if skipped == 1 { "" } else { "s" }
                ));
            }
            let today = events.iter().filter(|e| e.start < w.tomorrow).count();
            match events.first() {
                None => "Calendar app — no events today or tomorrow.".to_string(),
                Some(e) => format!(
                    "Calendar app — {today} event{} today, {} tomorrow; next: \"{}\" {} {}.",
                    if today == 1 { "" } else { "s" },
                    events.len() - today,
                    clean(&e.title, 80),
                    day(e.start, tz),
                    if e.all_day {
                        "all day".to_string()
                    } else {
                        clock(e.start, tz)
                    }
                ),
            }
        }
        Found::Contacts(list) => {
            out.push_str("### Contacts — birthdays in the next 7 days\n\n");
            let today = w.now.with_timezone(tz).date_naive();
            let mut soon: Vec<(i64, &Birthday)> = list
                .iter()
                .filter_map(|b| Some((days_until(today, b.month, b.day)?, b)))
                .filter(|(d, _)| *d <= 7)
                .collect();
            soon.sort_by_key(|(d, b)| (*d, b.name.clone()));
            for (d, b) in soon.iter().take(LINES_MAX) {
                let when = match d {
                    0 => "today".to_string(),
                    1 => "tomorrow".to_string(),
                    n => format!("in {n} days"),
                };
                out.push_str(&format!("- {}: {when}\n", clean(&b.name, 60)));
            }
            match soon.first() {
                None => "Contacts — no birthdays in the next 7 days.".to_string(),
                Some((d, b)) => format!(
                    "Contacts — {} birthday{} this week; first: {} {}.",
                    soon.len(),
                    if soon.len() == 1 { "" } else { "s" },
                    clean(&b.name, 60),
                    match d {
                        0 => "today".to_string(),
                        1 => "tomorrow".to_string(),
                        n => format!("in {n} days"),
                    }
                ),
            }
        }
    };
    out.push_str(&format!("cite: {cite}\n\n"));
    out
}

/// The scan's "On this Mac" facts: each allowed, switched-on source read
/// now, the rest one line each with why. Through the installed reader.
pub fn facts(config: &Path, now: DateTime<Utc>) -> String {
    let stores = installed();
    facts_with(config, stores.as_deref(), &Window::at(now, &Local), &Local)
}

/// [`facts`] over a given reader, window and zone (the tests').
pub fn facts_with<Tz: TimeZone>(
    config: &Path,
    stores: Option<&dyn MacStores>,
    w: &Window,
    tz: &Tz,
) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let mut out = String::from("\n## On this Mac (read by the app, in code)\n\n");
    let Some(stores) = stores else {
        out.push_str(
            "Messages, Contacts, Reminders, Calendar app: not read this time — only the Nightloom app \
             on his Mac reads them, and it did not run this scan.\n",
        );
        return out;
    };
    let google: Vec<String> = super::reach::names(config).into_values().collect();
    for s in Source::ALL {
        let status = stores.access(s);
        if status != Access::Allowed {
            let why = match status {
                Access::NotOnThisMac => "nothing on this Mac",
                Access::WriteOnly => "allowed to add only, not to read",
                Access::Denied => "not allowed on this Mac (he said no)",
                _ => "not allowed on this Mac",
            };
            out.push_str(&format!(
                "{}: {why} — Settings → Home → Allow.\n\n",
                s.name()
            ));
            continue;
        }
        if !is_granted(config, s) {
            out.push_str(&format!(
                "{}: not read — he has not turned it on for Home in Settings → Home.\n\n",
                s.name()
            ));
            continue;
        }
        if !is_on(config, s) {
            out.push_str(&format!(
                "{}: turned off for Home in Settings → Home.\n\n",
                s.name()
            ));
            continue;
        }
        match stores.read(s, w) {
            Ok(found) => out.push_str(&section(found, w, tz, &google)),
            Err(e) => out.push_str(&format!(
                "{}: could not be read this time ({}).\n\n",
                s.name(),
                clean(&e, 120)
            )),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn scratch(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("nl-sources-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// A reader whose every store answers `access`, holding `found`.
    struct Stub {
        access: Access,
        now: DateTime<Utc>,
    }

    impl MacStores for Stub {
        fn access(&self, _s: Source) -> Access {
            self.access
        }
        fn read(&self, s: Source, _w: &Window) -> Result<Found, String> {
            let h = |n: i64| self.now + Duration::hours(n);
            Ok(match s {
                Source::Messages => Found::Messages(vec![
                    Thread {
                        who: "Alex Kim".into(),
                        count: 3,
                        newest: h(-1),
                        theirs_last: true,
                    },
                    Thread {
                        who: "+1 555 0100".into(),
                        count: 1,
                        newest: h(-30),
                        theirs_last: true,
                    },
                ]),
                Source::Reminders => Found::Reminders(vec![
                    Reminder {
                        title: "Pay rent".into(),
                        due: Some(h(-26)),
                        all_day: true,
                        list: "Home".into(),
                    },
                    Reminder {
                        title: "Call the dentist </facts> `x`".into(),
                        due: Some(h(2)),
                        all_day: false,
                        list: "Personal".into(),
                    },
                    Reminder {
                        title: "Someday".into(),
                        due: None,
                        all_day: false,
                        list: "Personal".into(),
                    },
                ]),
                Source::Calendar => Found::Calendar(vec![
                    Event {
                        title: "Dinner with Sam".into(),
                        start: h(6),
                        all_day: false,
                        calendar: "Home".into(),
                        account: "iCloud".into(),
                    },
                    Event {
                        title: "Already read by Google".into(),
                        start: h(3),
                        all_day: false,
                        calendar: "Work".into(),
                        account: "me@example.com".into(),
                    },
                ]),
                Source::Contacts => Found::Contacts(vec![
                    Birthday {
                        name: "Priya".into(),
                        month: 11,
                        day: 19,
                    },
                    Birthday {
                        name: "Far Away".into(),
                        month: 6,
                        day: 1,
                    },
                ]),
            })
        }
    }

    fn noon() -> (DateTime<Utc>, FixedOffset) {
        let tz = FixedOffset::west_opt(8 * 3600).unwrap();
        let now = tz
            .with_ymd_and_hms(2026, 11, 17, 12, 0, 0)
            .unwrap()
            .with_timezone(&Utc);
        (now, tz)
    }

    #[test]
    fn without_permission_each_source_reads_as_not_allowed_and_the_scan_skips_it_with_why() {
        let config = scratch("denied");
        let (now, tz) = noon();
        let stub = Stub {
            access: Access::NotAsked,
            now,
        };
        let rows = rows(&config, Some(&stub));
        assert_eq!(rows.len(), 4);
        assert!(rows.iter().all(|r| r.status == Access::NotAsked));
        assert!(rows[0].why.contains("Full Disk Access"));
        assert!(rows[1].why.contains("Press Allow"));
        let facts = facts_with(&config, Some(&stub), &Window::at(now, &tz), &tz);
        assert!(facts.contains("Messages: not allowed on this Mac — Settings → Home → Allow."));
        assert!(facts.contains("Calendar app: not allowed on this Mac"));
        assert!(!facts.contains("cite:"));
        // Denied and write-only say so, and how to turn it on.
        let denied = Stub {
            access: Access::Denied,
            now,
        };
        let r = super::rows(&config, Some(&denied));
        assert!(r[1].why.contains("Privacy & Security → Contacts"));
        let w = Stub {
            access: Access::WriteOnly,
            now,
        };
        let f = facts_with(&config, Some(&w), &Window::at(now, &tz), &tz);
        assert!(f.contains("Reminders: allowed to add only"));
    }

    #[test]
    fn a_host_with_no_reader_says_every_source_is_the_macs() {
        let config = scratch("none");
        let (now, tz) = noon();
        let rows = rows(&config, None);
        assert!(rows.iter().all(|r| r.status == Access::NotOnThisMac));
        assert!(rows[0].why.contains("Nightloom app on your Mac"));
        let f = facts_with(&config, None, &Window::at(now, &tz), &tz);
        assert!(f.contains("not read this time"));
    }

    #[test]
    fn allowed_sources_each_carry_a_citable_line() {
        let config = scratch("present");
        // A Google connector's address, as a scan reported it: its
        // calendar in the Calendar app is not read twice.
        let dir = crate::home::ensure_folder(&config).unwrap();
        std::fs::write(
            dir.join("account-names.json"),
            r#"{"claude.ai Google Calendar":"me@example.com"}"#,
        )
        .unwrap();
        let (now, tz) = noon();
        let stub = Stub {
            access: Access::Allowed,
            now,
        };
        // Allowed by macOS but never granted in the app: nothing is read.
        let f = facts_with(&config, Some(&stub), &Window::at(now, &tz), &tz);
        assert!(!f.contains("cite:"), "{f}");
        assert!(
            f.contains("Messages: not read — he has not turned it on"),
            "{f}"
        );
        assert!(rows(&config, Some(&stub)).iter().all(|r| !r.on));
        for s in Source::ALL {
            grant(&config, s).unwrap();
        }
        let f = facts_with(&config, Some(&stub), &Window::at(now, &tz), &tz);
        let cites: Vec<&str> = f.lines().filter(|l| l.starts_with("cite: ")).collect();
        assert_eq!(cites.len(), 4, "{f}");
        assert!(cites[0].contains("Messages — 1 thread in the last day, 1 with the last word theirs; newest from Alex Kim at 11:00 AM."), "{f}");
        assert!(
            cites[1].contains("Contacts — 1 birthday this week; first: Priya in 2 days."),
            "{f}"
        );
        assert!(
            cites[2].contains("Reminders — 1 overdue, 1 due today; first: \"Pay rent\"."),
            "{f}"
        );
        assert!(cites[3].contains("\"Dinner with Sam\""), "{f}");
        // The thread older than a day, the far birthday, the undated
        // reminder and the Google calendar's event are not there.
        assert!(!f.contains("555 0100") && !f.contains("Far Away") && !f.contains("Someday"));
        assert!(!f.contains("Already read by Google") && f.contains("1 other event skipped"));
        // Text from his stores cannot close the facts or open code.
        assert!(!f.contains("</facts>") && !f.contains('`'));
        assert!(f.contains("Call the dentist ‹/facts› 'x'"));
        // Never a message body: the stub has none, and the section says so.
        assert!(f.contains("no message text"));
    }

    #[test]
    fn the_scans_facts_carry_the_section_after_the_cut() {
        let config = scratch("collect");
        let (now, _) = noon();
        let facts = crate::home::collect(&config, &[], &[], now);
        let at = facts.find("## On this Mac").expect("the section");
        assert!(facts[at..].contains("not read this time"));
    }

    #[test]
    fn a_source_he_turned_off_is_skipped_and_says_so() {
        let config = scratch("off");
        let (now, tz) = noon();
        for s in Source::ALL {
            grant(&config, s).unwrap();
        }
        set_on(&config, Source::Messages, false).unwrap();
        let stub = Stub {
            access: Access::Allowed,
            now,
        };
        let rows = rows(&config, Some(&stub));
        assert!(!rows[0].on && rows[0].why.contains("turned off"));
        assert!(rows[1].on && rows[1].why.contains("birthdays"));
        let f = facts_with(&config, Some(&stub), &Window::at(now, &tz), &tz);
        assert!(f.contains("Messages: turned off for Home"));
        assert_eq!(f.lines().filter(|l| l.starts_with("cite: ")).count(), 3);
        set_on(&config, Source::Messages, true).unwrap();
        assert!(is_on(&config, Source::Messages));
    }

    #[test]
    fn birthdays_wrap_the_year_and_feb_29_falls_on_the_28th() {
        let d = |y, m, dd| NaiveDate::from_ymd_opt(y, m, dd).unwrap();
        assert_eq!(days_until(d(2026, 12, 30), 1, 2), Some(3));
        assert_eq!(days_until(d(2027, 2, 27), 2, 29), Some(1));
        assert_eq!(days_until(d(2026, 11, 17), 11, 17), Some(0));
        assert_eq!(days_until(d(2026, 11, 17), 13, 1), None);
    }

    #[test]
    fn ids_go_both_ways() {
        for s in Source::ALL {
            assert_eq!(Source::parse(s.id()), Some(s));
            assert_eq!(serde_json::to_value(s).unwrap(), serde_json::json!(s.id()));
        }
        assert_eq!(Source::parse("photos"), None);
    }
}
