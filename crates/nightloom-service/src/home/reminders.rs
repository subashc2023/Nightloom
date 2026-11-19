//! Home's Reminders writer (nightshift item 872, step 4; 846 §5 #3, §7
//! step 5): one tool, `update_reminders`, that adds a reminder or marks
//! one done — and only on his tap.
//!
//! - **Gated as Home's mail and calendar writers are**
//!   ([`crate::agent::connector_writes::HOME_GATED_MATCHER`]): in Home's
//!   read-only chat each call shows the `home_write` card — Allow once /
//!   Deny / Not now, never a standing allow — and a subagent's call is
//!   refused in words. Every other read-only chat refuses it as a known
//!   write; a chat of Home's that is not read-only refuses it too
//!   (`AgentSpec`), so no position runs it unasked.
//! - **It reaches Reminders the way item 808's reader does**: through the
//!   Mac app's [`MacStores`] (EventKit, in the app's own process). The
//!   tool's server is another process, so the change goes to the app over
//!   the socket the preview already uses ([`crate::preview::Request`]).
//! - **Never a macOS dialog.** [`apply`] reads the status and stops in
//!   words when Reminders is not allowed, not granted for Home, or
//!   switched off; asking macOS stays his Allow press in Settings → Home.
//! - **Nothing guessed.** A list he did not name is his default list; a
//!   list that is not there is an error naming the lists that are (never a
//!   new list); "done" needs exactly one open reminder with that title.

use std::path::{Path, PathBuf};

use nightloom_core::ToolDef;
use nightloom_core::tool::{CancellationToken, Effect, Tool};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::sources::{self, Access, MacStores, Source};

/// The tool's name: `mcp__nightloom__update_reminders` on the CLI.
pub const TOOL: &str = "update_reminders";

const TITLE_MAX: usize = 200;
const LIST_MAX: usize = 100;
const NOTES_MAX: usize = 2000;
/// How many list names an error names.
const LISTS_SHOWN: usize = 12;

/// What the call does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Add,
    Complete,
}

/// A due date in his own time zone; no time of day means all day.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Due {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<(u32, u32)>,
}

impl Due {
    /// `2026-11-20`, or with a time `2026-11-20 14:30` (`T` also reads).
    pub fn parse(text: &str) -> Result<Due, String> {
        let bad = || {
            format!(
                "due {text:?} is not a date: write 2026-11-20, or 2026-11-20 14:30 for a time of day."
            )
        };
        let t = text.trim();
        let (date, time) = match t.split_once(['T', ' ']) {
            Some((d, c)) => (d, Some(c.trim())),
            None => (t, None),
        };
        let date = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| bad())?;
        let time = match time {
            Some(c) => {
                let c = chrono::NaiveTime::parse_from_str(c, "%H:%M").map_err(|_| bad())?;
                use chrono::Timelike;
                Some((c.hour(), c.minute()))
            }
            None => None,
        };
        use chrono::Datelike;
        Ok(Due {
            year: date.year(),
            month: date.month(),
            day: date.day(),
            time,
        })
    }

    /// As he would read it: `2026-11-20`, `2026-11-20 at 2:30 PM`.
    pub fn words(&self) -> String {
        let date = format!("{:04}-{:02}-{:02}", self.year, self.month, self.day);
        match self.time {
            Some((h, m)) => {
                let (h12, half) = match h {
                    0 => (12, "AM"),
                    1..=11 => (h, "AM"),
                    12 => (12, "PM"),
                    _ => (h - 12, "PM"),
                };
                format!("{date} at {h12}:{m:02} {half}")
            }
            None => date,
        }
    }
}

/// One change to his Reminders, as the card showed it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Change {
    pub action: Action,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due: Option<Due>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

fn text_of(input: &Value, key: &str, max: usize) -> Result<Option<String>, String> {
    match input.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => {
            let s = s.trim();
            if s.is_empty() {
                Ok(None)
            } else if s.chars().count() > max {
                Err(format!("{key} is longer than {max} characters."))
            } else {
                Ok(Some(s.to_string()))
            }
        }
        Some(_) => Err(format!("{key} must be text.")),
    }
}

/// The call's input as a change, or why it is not one. Run before the
/// card's answer is used and again in the app: what is written is exactly
/// what parsed.
pub fn parse(input: &Value) -> Result<Change, String> {
    let action = match input.get("action").and_then(Value::as_str) {
        Some("add") => Action::Add,
        Some("complete") => Action::Complete,
        _ => {
            return Err(
                "update_reminders needs action: \"add\" (a new reminder) or \"complete\" (mark one done)."
                    .into(),
            );
        }
    };
    let title = text_of(input, "title", TITLE_MAX)?
        .ok_or("update_reminders needs title: the reminder's words.")?;
    if title.contains(['\n', '\r']) {
        return Err("title is one line.".into());
    }
    let list = text_of(input, "list", LIST_MAX)?;
    // What he taps Allow on is what is written: no character that draws
    // the card's text other than it is (review, item 872).
    unseen(&title, "title", false)?;
    if let Some(l) = &list {
        unseen(l, "list", false)?;
    }
    let due = match text_of(input, "due", 40)? {
        Some(d) => Some(Due::parse(&d)?),
        None => None,
    };
    let notes = text_of(input, "notes", NOTES_MAX)?;
    if let Some(n) = &notes {
        unseen(n, "notes", true)?;
    }
    if action == Action::Complete && (due.is_some() || notes.is_some()) {
        return Err(
            "complete takes only title and list: it marks the reminder done and changes nothing else."
                .into(),
        );
    }
    Ok(Change {
        action,
        title,
        list,
        due,
        notes,
    })
}

/// A character that is drawn as nothing, or that reorders or hides the
/// text around it: control characters (in `notes`, a line break or a tab
/// is fine), the bidirectional embeddings, overrides and isolates, and
/// the zero-width space and direction marks (the joiners stay: emoji and
/// scripts need them). On the card such a title would read as one
/// thing and be written as another, so the call is refused in words.
fn unseen(text: &str, key: &str, lines: bool) -> Result<(), String> {
    let bad = text.chars().find(|&c| {
        (c.is_control() && !(lines && matches!(c, '\n' | '\r' | '\t')))
            || matches!(c,
                '\u{00AD}'
                | '\u{061C}'
                | '\u{180E}'
                | '\u{200B}'
                | '\u{200E}'
                | '\u{200F}'
                | '\u{2028}'..='\u{202E}'
                | '\u{2060}'..='\u{2069}'
                | '\u{FEFF}'
                | '\u{FFF9}'..='\u{FFFB}')
    });
    match bad {
        Some(c) => Err(format!(
            "{key} holds an invisible or reordering character (U+{:04X}); write it in plain characters. Nothing was changed.",
            c as u32
        )),
        None => Ok(()),
    }
}

fn same(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

fn named(lists: &[String]) -> String {
    let mut shown: Vec<String> = lists
        .iter()
        .take(LISTS_SHOWN)
        .map(|l| format!("\"{l}\""))
        .collect();
    if lists.len() > LISTS_SHOWN {
        shown.push(format!("and {} more", lists.len() - LISTS_SHOWN));
    }
    if shown.is_empty() {
        "none".into()
    } else {
        shown.join(", ")
    }
}

/// The list a new reminder goes to among `lists` (title, whether it takes
/// changes): the one he named, by its name whatever the capitals — `None`
/// when he named none (the store's default list). A name that is not
/// there, or names two lists, or a list that takes no changes, is an
/// error; a list is never made.
pub fn pick_list(lists: &[(String, bool)], want: Option<&str>) -> Result<Option<usize>, String> {
    let Some(want) = want else {
        return Ok(None);
    };
    let hits: Vec<usize> = lists
        .iter()
        .enumerate()
        .filter(|(_, (t, _))| same(t, want))
        .map(|(i, _)| i)
        .collect();
    let names: Vec<String> = lists.iter().map(|(t, _)| t.clone()).collect();
    match hits.as_slice() {
        [] => Err(format!(
            "There is no Reminders list named \"{want}\". His lists: {}. Nothing was changed, and no list was made.",
            named(&names)
        )),
        [i] if lists[*i].1 => Ok(Some(*i)),
        [_] => Err(format!(
            "The Reminders list \"{want}\" does not take changes (it is shared read-only or subscribed). Nothing was changed."
        )),
        _ => Err(format!(
            "{} Reminders lists are named \"{want}\"; which one is his to say. Nothing was changed.",
            hits.len()
        )),
    }
}

/// The open reminder a `complete` marks done, among `open` (title, list):
/// the one with that title — in the list he named, when he named one.
/// None, or more than one, is an error: the wrong reminder is never
/// ticked.
pub fn pick_reminder(
    open: &[(String, String)],
    title: &str,
    list: Option<&str>,
) -> Result<usize, String> {
    let hits: Vec<usize> = open
        .iter()
        .enumerate()
        .filter(|(_, (t, l))| same(t, title) && list.is_none_or(|w| same(l, w)))
        .map(|(i, _)| i)
        .collect();
    let place = list.map(|l| format!(" in \"{l}\"")).unwrap_or_default();
    match hits.as_slice() {
        [i] => Ok(*i),
        [] => Err(format!(
            "No open reminder is titled \"{title}\"{place}. Nothing was changed — check the title against what Reminders holds."
        )),
        _ => {
            let lists: Vec<String> = hits.iter().map(|i| open[*i].1.clone()).collect();
            Err(format!(
                "{} open reminders are titled \"{title}\"{place} (lists: {}). Nothing was changed — name the list, or ask him which.",
                hits.len(),
                named(&lists)
            ))
        }
    }
}

/// What the model reads after an add.
pub fn added_words(change: &Change, list: &str) -> String {
    let due = change
        .due
        .map(|d| format!(", due {}", d.words()))
        .unwrap_or_default();
    format!(
        "Added to Reminders: \"{}\" in the list \"{list}\"{due}.",
        change.title
    )
}

/// What the model reads after a complete.
pub fn done_words(title: &str, list: &str) -> String {
    format!("Marked done in Reminders: \"{title}\" (list \"{list}\").")
}

/// Why nothing can be written, when Reminders is not his to give yet.
const NOT_ALLOWED: &str = "Nightloom is not allowed to change Reminders on this Mac. He allows it in Settings → Home → Reminders (macOS asks him there, from his press). Nothing was changed.";
const NOT_GRANTED: &str =
    "He has not allowed Reminders for Home: Settings → Home → Reminders. Nothing was changed.";
const SWITCHED_OFF: &str =
    "He switched Reminders off for Home (Settings → Home). Nothing was changed.";
/// A host with no way to the Mac's Reminders.
pub const NOT_HERE: &str =
    "Reminders is on his Mac, and this chat's host cannot reach the Mac app. Nothing was changed.";

/// Make `change` through `stores`, in the app's process: only with
/// Reminders allowed by macOS in full, granted for Home in Nightloom and
/// left on. Reads the status and never asks macOS for anything.
pub fn apply(
    config: &Path,
    stores: Option<&dyn MacStores>,
    change: &Change,
) -> Result<String, String> {
    let Some(stores) = stores else {
        return Err(NOT_HERE.into());
    };
    match stores.access(Source::Reminders) {
        Access::Allowed => {}
        Access::NotOnThisMac => return Err(NOT_HERE.into()),
        Access::NotAsked | Access::Denied | Access::WriteOnly => return Err(NOT_ALLOWED.into()),
    }
    if !sources::is_granted(config, Source::Reminders) {
        return Err(NOT_GRANTED.into());
    }
    if !sources::is_on(config, Source::Reminders) {
        return Err(SWITCHED_OFF.into());
    }
    stores.change_reminder(change)
}

const DESC: &str = "Change his Reminders: add one, or mark one done. Each call shows him a card and runs only on his tap, so make one change per call, and only one he asked for or accepted on the stage. action \"add\": title, and optionally list (one of his lists, by name — none is made; left out, his default list), due (\"2026-11-20\", or \"2026-11-20 14:30\" in his time zone) and notes. action \"complete\": title exactly as Reminders holds it, and list when two lists could hold it. The result says what was changed, or why nothing was.";

/// What `initialize` adds where the tool is served.
pub const INSTRUCTION: &str = " A change to his Reminders (one added, one marked done) is made with update_reminders, one change per call, once he accepted it on the stage or asked for it: each call shows him a card and runs only on his tap.";

/// The tool: served to a chat of Home's that writes.
pub struct UpdateReminders {
    config: PathBuf,
    /// The Mac app's socket (`--preview`), when the app named one.
    socket: Option<PathBuf>,
}

impl UpdateReminders {
    pub fn new(config: PathBuf, socket: Option<PathBuf>) -> Self {
        Self { config, socket }
    }
}

#[async_trait::async_trait]
impl Tool for UpdateReminders {
    fn effect(&self) -> Effect {
        Effect::Mutating
    }
    fn def(&self) -> ToolDef {
        ToolDef {
            name: TOOL.into(),
            description: DESC.into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": { "type": "string", "enum": ["add", "complete"] },
                    "title": { "type": "string", "description": "The reminder's words, one line." },
                    "list": { "type": "string", "description": "One of his Reminders lists, by name." },
                    "due": { "type": "string", "description": "add only: 2026-11-20, or 2026-11-20 14:30." },
                    "notes": { "type": "string", "description": "add only." }
                },
                "required": ["action", "title"]
            }),
        }
    }
    async fn call(&self, input: Value, _cancel: &CancellationToken) -> Result<String, String> {
        let change = parse(&input)?;
        // In the app's own process (a host that installed the stores): at once.
        if let Some(stores) = sources::installed() {
            let config = self.config.clone();
            return tokio::task::spawn_blocking(move || {
                apply(&config, Some(stores.as_ref()), &change)
            })
            .await
            .map_err(|e| e.to_string())?;
        }
        let Some(socket) = &self.socket else {
            return Err(NOT_HERE.into());
        };
        send(socket, change).await
    }
}

/// Hand `change` to the Mac app over its socket and read what it did.
///
/// Review (item 872): a socket that never took the change and one that
/// took it and then said nothing are told apart — after the first nothing
/// was changed; after the second the change may have landed, so a retry
/// (one more card, one more tap) could add the same reminder twice.
#[cfg(unix)]
async fn send(socket: &Path, change: Change) -> Result<String, String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let mut stream = tokio::net::UnixStream::connect(socket).await.map_err(|e| {
        format!("The Mac app is not reachable ({e}); it may have quit. Nothing was changed in Reminders.")
    })?;
    let mut line = serde_json::to_string(&crate::preview::Request::Reminder { change })
        .map_err(|e| format!("{e}. Nothing was changed in Reminders."))?;
    line.push('\n');
    stream.write_all(line.as_bytes()).await.map_err(|e| {
        format!("The change did not reach the Mac app ({e}). Check Reminders before trying again: it may have landed.")
    })?;
    let lost = |why: String| {
        format!(
            "The Mac app took the change and then did not answer ({why}). Check Reminders before trying again: it may have landed."
        )
    };
    let reply = BufReader::new(stream)
        .lines()
        .next_line()
        .await
        .map_err(|e| lost(e.to_string()))?
        .ok_or_else(|| lost("it closed the socket".into()))?;
    let reply: crate::preview::Reply =
        serde_json::from_str(&reply).map_err(|e| lost(e.to_string()))?;
    match (reply.ok, reply.text, reply.error) {
        (true, Some(text), _) => Ok(text),
        (_, _, Some(e)) => Err(e),
        _ => Err(
            "The Mac app answered nothing about Reminders. Check Reminders before trying again."
                .into(),
        ),
    }
}

#[cfg(not(unix))]
async fn send(_socket: &Path, _change: Change) -> Result<String, String> {
    Err(NOT_HERE.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nl-reminders-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// A store that answers `access` and keeps what it was asked to write.
    struct Fake {
        access: Access,
        wrote: Mutex<Vec<Change>>,
    }

    impl Fake {
        fn new(access: Access) -> Self {
            Self {
                access,
                wrote: Mutex::new(Vec::new()),
            }
        }
        fn count(&self) -> usize {
            self.wrote.lock().unwrap().len()
        }
    }

    impl MacStores for Fake {
        fn access(&self, _s: Source) -> Access {
            self.access
        }
        fn read(&self, _s: Source, _w: &sources::Window) -> Result<sources::Found, String> {
            Err("not read here".into())
        }
        fn change_reminder(&self, change: &Change) -> Result<String, String> {
            self.wrote.lock().unwrap().push(change.clone());
            Ok(added_words(change, "Reminders"))
        }
    }

    fn add(title: &str) -> Change {
        parse(&json!({ "action": "add", "title": title })).unwrap()
    }

    #[test]
    fn a_call_parses_to_exactly_what_the_card_showed_or_says_why_not() {
        let c = parse(&json!({
            "action": "add", "title": "  Buy milk ", "list": "Groceries",
            "due": "2026-11-20 14:30", "notes": "2%"
        }))
        .unwrap();
        assert_eq!(c.title, "Buy milk");
        assert_eq!(c.list.as_deref(), Some("Groceries"));
        assert_eq!(
            c.due,
            Some(Due {
                year: 2026,
                month: 11,
                day: 20,
                time: Some((14, 30))
            })
        );
        assert_eq!(c.due.unwrap().words(), "2026-11-20 at 2:30 PM");
        assert_eq!(
            Due::parse("2026-11-20T00:05").unwrap().words(),
            "2026-11-20 at 12:05 AM"
        );
        assert_eq!(Due::parse("2026-11-20").unwrap().words(), "2026-11-20");
        // Notes keep their lines; a title keeps its accents and emoji.
        let n = parse(&json!({
            "action": "add", "title": "Café 👨\u{200D}👩\u{200D}👧 ünd", "notes": "one\ntwo\tthree"
        }))
        .unwrap();
        assert_eq!(n.notes.as_deref(), Some("one\ntwo\tthree"));
        // The socket carries it whole.
        let wire = serde_json::to_string(&c).unwrap();
        assert_eq!(serde_json::from_str::<Change>(&wire).unwrap(), c);
        for bad in [
            json!({ "title": "x" }),
            json!({ "action": "delete", "title": "x" }),
            json!({ "action": "add" }),
            json!({ "action": "add", "title": "   " }),
            json!({ "action": "add", "title": "a\nb" }),
            json!({ "action": "add", "title": "x", "due": "tomorrow" }),
            json!({ "action": "add", "title": "x", "due": "2026-02-30" }),
            json!({ "action": "add", "title": "x", "due": "2026-11-20 25:00" }),
            json!({ "action": "add", "title": "x".repeat(201) }),
            json!({ "action": "add", "title": "x", "list": 3 }),
            json!({ "action": "complete", "title": "x", "due": "2026-11-20" }),
            json!({ "action": "complete", "title": "x", "notes": "n" }),
            // Review: what the card draws is what is written.
            json!({ "action": "add", "title": "Pay \u{202E}tner" }),
            json!({ "action": "add", "title": "Pay\u{200B}rent" }),
            json!({ "action": "add", "title": "Pay\u{0007}rent" }),
            json!({ "action": "add", "title": "x", "list": "Work\u{2066}" }),
            json!({ "action": "add", "title": "x", "notes": "a\u{202D}b" }),
        ] {
            assert!(parse(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_list_that_is_missing_doubled_or_closed_is_an_error_never_a_new_list() {
        let lists = vec![
            ("Reminders".to_string(), true),
            ("Groceries".to_string(), true),
            ("Family".to_string(), false),
            ("Work".to_string(), true),
            ("work".to_string(), true),
        ];
        assert_eq!(pick_list(&lists, None), Ok(None));
        assert_eq!(pick_list(&lists, Some("groceries ")), Ok(Some(1)));
        let missing = pick_list(&lists, Some("Errands")).unwrap_err();
        assert!(
            missing.contains("no Reminders list named \"Errands\""),
            "{missing}"
        );
        assert!(missing.contains("\"Groceries\"") && missing.contains("no list was made"));
        assert!(
            pick_list(&lists, Some("Family"))
                .unwrap_err()
                .contains("does not take changes")
        );
        assert!(
            pick_list(&lists, Some("Work"))
                .unwrap_err()
                .starts_with("2 Reminders lists")
        );
        assert!(
            pick_list(&[], Some("x"))
                .unwrap_err()
                .contains("His lists: none")
        );
    }

    #[test]
    fn done_marks_the_one_open_reminder_with_that_title_or_nothing() {
        let open = vec![
            ("Pay rent".to_string(), "Home".to_string()),
            ("Call Sam".to_string(), "Home".to_string()),
            ("Call Sam".to_string(), "Work".to_string()),
        ];
        assert_eq!(pick_reminder(&open, "pay rent", None), Ok(0));
        assert_eq!(pick_reminder(&open, "Call Sam", Some("work")), Ok(2));
        let two = pick_reminder(&open, "Call Sam", None).unwrap_err();
        assert!(
            two.starts_with("2 open reminders") && two.contains("\"Home\", \"Work\""),
            "{two}"
        );
        let none = pick_reminder(&open, "Pay rent", Some("Work")).unwrap_err();
        assert!(
            none.contains("No open reminder is titled \"Pay rent\" in \"Work\""),
            "{none}"
        );
        assert!(pick_reminder(&[], "x", None).is_err());
    }

    /// Reminders is written only when macOS allows it in full, he granted
    /// it for Home, and he left it on; every other state is words and no
    /// write — and nothing here can ask macOS (the stores' `access` reads).
    #[test]
    fn nothing_is_written_unless_reminders_is_allowed_granted_and_on() {
        let config = scratch("gate");
        let change = add("Buy milk");
        assert_eq!(apply(&config, None, &change).unwrap_err(), NOT_HERE);
        for (access, why) in [
            (Access::NotAsked, NOT_ALLOWED),
            (Access::Denied, NOT_ALLOWED),
            (Access::WriteOnly, NOT_ALLOWED),
            (Access::NotOnThisMac, NOT_HERE),
        ] {
            sources::grant(&config, Source::Reminders).unwrap();
            let fake = Fake::new(access);
            assert_eq!(apply(&config, Some(&fake), &change).unwrap_err(), why);
            assert_eq!(fake.count(), 0, "{access:?}");
        }
        // macOS allows it, but he never allowed it for Home here.
        let config = scratch("gate-ungranted");
        let fake = Fake::new(Access::Allowed);
        assert_eq!(
            apply(&config, Some(&fake), &change).unwrap_err(),
            NOT_GRANTED
        );
        // Granted, then switched off.
        sources::grant(&config, Source::Reminders).unwrap();
        sources::set_on(&config, Source::Reminders, false).unwrap();
        assert_eq!(
            apply(&config, Some(&fake), &change).unwrap_err(),
            SWITCHED_OFF
        );
        assert_eq!(fake.count(), 0);
        // On again: the one change, as parsed.
        sources::set_on(&config, Source::Reminders, true).unwrap();
        let said = apply(&config, Some(&fake), &change).unwrap();
        assert_eq!(
            said,
            "Added to Reminders: \"Buy milk\" in the list \"Reminders\"."
        );
        assert_eq!(*fake.wrote.lock().unwrap(), vec![change]);
    }

    /// A reader that only reads (an older host) refuses the change in words.
    #[test]
    fn a_store_with_no_writer_refuses() {
        struct ReadOnly;
        impl MacStores for ReadOnly {
            fn access(&self, _s: Source) -> Access {
                Access::Allowed
            }
            fn read(&self, _s: Source, _w: &sources::Window) -> Result<sources::Found, String> {
                Err("no".into())
            }
        }
        let config = scratch("no-writer");
        sources::grant(&config, Source::Reminders).unwrap();
        assert!(apply(&config, Some(&ReadOnly), &add("x")).is_err());
    }

    /// Review (item 872): a socket that is not there means nothing was
    /// changed; one that takes the change and closes without a word means
    /// it may have landed — never "nothing changed" — so a retry is not
    /// taken as safe. And the app's answer is passed on as it said it.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_lost_answer_is_never_read_as_nothing_changed() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let dir = PathBuf::from(format!("/tmp/nl-rem-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let gone = send(&dir.join("none.sock"), add("x")).await.unwrap_err();
        assert!(gone.contains("Nothing was changed"), "{gone}");

        let sock = dir.join("s.sock");
        let listener = tokio::net::UnixListener::bind(&sock).unwrap();
        let server = tokio::spawn(async move {
            for answer in [None, Some(r#"{"ok":true,"text":"Added."}"#)] {
                let (stream, _) = listener.accept().await.unwrap();
                let (read, mut write) = stream.into_split();
                let mut lines = BufReader::new(read).lines();
                let got = lines.next_line().await.unwrap().unwrap();
                assert!(got.contains(r#""op":"reminder""#), "{got}");
                if let Some(a) = answer {
                    write.write_all(format!("{a}\n").as_bytes()).await.unwrap();
                }
            }
        });
        let lost = send(&sock, add("x")).await.unwrap_err();
        assert!(
            lost.contains("may have landed") && !lost.contains("Nothing was changed"),
            "{lost}"
        );
        assert_eq!(send(&sock, add("x")).await.unwrap(), "Added.");
        server.await.unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// With no socket and no stores in this process the tool says where
    /// Reminders is, and a call that does not parse never leaves the tool.
    #[tokio::test]
    async fn the_tool_refuses_in_words_with_no_way_to_the_mac() {
        let tool = UpdateReminders::new(scratch("tool"), None);
        assert_eq!(tool.def().name, TOOL);
        assert_eq!(tool.effect(), Effect::Mutating);
        let cancel = CancellationToken::new();
        if sources::installed().is_none() {
            let e = tool
                .call(json!({ "action": "add", "title": "x" }), &cancel)
                .await
                .unwrap_err();
            assert_eq!(e, NOT_HERE);
        }
        let e = tool
            .call(json!({ "action": "add" }), &cancel)
            .await
            .unwrap_err();
        assert!(e.contains("needs title"), "{e}");
    }
}
