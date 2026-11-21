//! The Mac's own stores for Home (nightshift item 808): Messages, Contacts,
//! Reminders and the Calendar app, read by this app once he allows each
//! from Settings → Home.
//!
//! - **Status, never a dialog by itself** ([`Mac::access`]): Contacts by
//!   `CNContactStore authorizationStatusForEntityType:`, Reminders and the
//!   Calendar app by `EKEventStore authorizationStatusForEntityType:`
//!   (macOS 14's full access vs add only), Messages by whether
//!   `~/Library/Messages/chat.db` opens for reading (Full Disk Access).
//! - **Allow** ([`home_source_allow`]) is the one place a macOS dialog may
//!   open, and only from his press: Contacts / Reminders / Calendar call
//!   their request API (macOS asks once; a no is then System Settings'),
//!   Messages opens System Settings at Full Disk Access. When a request is
//!   answered the window hears `home-sources-changed`.
//! - **Reads** ([`Mac::read`]) only for a store that is allowed (and the
//!   scan asks only for one he granted in the app — `sources::is_on`): Messages
//!   from its database with `/usr/bin/sqlite3 -readonly` (who and when;
//!   no message text is selected), the rest through their frameworks by
//!   `msg_send!` (no new crate: `objc2-contacts` / `objc2-event-kit` are
//!   not in the lockfile). Every Objective-C call sits inside
//!   `exception::catch`, so a framework exception is an error, not a crash.
//! - **One writer** (item 872, [`Mac::change_reminder`]): a reminder added
//!   or marked done through the same EventKit store, only with Reminders
//!   allowed in full — it reads the status and never asks. It runs when
//!   `home::reminders::apply` calls it, which is after his tap on the
//!   call's card.
//! - The usage strings macOS shows in its dialogs are in `Info.plist`
//!   beside `tauri.conf.json` (Tauri merges it into the bundle's).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use nightloom_service::home::sources::{
    self, Access, Found, MacStores, Row, Source, Thread, Window,
};
use nightloom_service::project;
use tauri::{AppHandle, Emitter};

/// The event the window re-reads the rows on.
pub(crate) const CHANGED: &str = "home-sources-changed";
/// The event that opens Settings → Home at a row (the phone asked).
pub(crate) const ASKED: &str = "home-source-asked";

/// Seconds between 1970 and 2001, Messages' (and Cocoa's) epoch.
const APPLE_EPOCH: i64 = 978_307_200;

/// This Mac's reader.
pub(crate) struct Mac;

/// Install the reader at launch: the scan's facts and the phone's rows
/// read through it.
pub(crate) fn install() {
    sources::install(Arc::new(Mac));
}

fn chat_db() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Messages/chat.db"))
}

/// Messages' status: the database opens (allowed), is refused (Full Disk
/// Access is off — macOS tells no "never asked" from a no), or is not
/// there. Opening a protected file never raises a dialog.
fn messages_access() -> Access {
    let Some(db) = chat_db() else {
        return Access::NotOnThisMac;
    };
    match std::fs::File::open(&db) {
        Ok(_) => Access::Allowed,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Access::NotOnThisMac,
        Err(_) => Access::NotAsked,
    }
}

/// The SQL over Messages' database: one row per chat with a message after
/// `since` (Apple's nanoseconds). Who, how many, the newest time, and
/// whether he wrote the newest — never `text` or `attributedBody`.
fn threads_sql(since_ns: i64) -> String {
    format!(
        "SELECT c.ROWID AS id, COALESCE(c.display_name, '') AS display, \
         COALESCE((SELECT GROUP_CONCAT(h.id, ', ') FROM chat_handle_join chj \
           JOIN handle h ON h.ROWID = chj.handle_id WHERE chj.chat_id = c.ROWID), \
           c.chat_identifier, '') AS handles, \
         COUNT(m.ROWID) AS n, MAX(m.date) AS newest, \
         (SELECT m2.is_from_me FROM chat_message_join j2 JOIN message m2 ON m2.ROWID = j2.message_id \
           WHERE j2.chat_id = c.ROWID ORDER BY m2.date DESC LIMIT 1) AS mine \
         FROM chat c JOIN chat_message_join j ON j.chat_id = c.ROWID \
         JOIN message m ON m.ROWID = j.message_id \
         WHERE m.date > {since_ns} GROUP BY c.ROWID ORDER BY newest DESC LIMIT 20;"
    )
}

/// A handle as a key for the names map: an address lowercased, a number
/// as its last ten digits.
fn handle_key(handle: &str) -> String {
    let h = handle.trim();
    if h.contains('@') {
        return h.to_lowercase();
    }
    let digits: String = h.chars().filter(char::is_ascii_digit).collect();
    let skip = digits.len().saturating_sub(10);
    digits[skip..].to_string()
}

/// Messages' date column: nanoseconds since 2001 (seconds on old Macs).
fn apple_time(v: i64) -> Option<chrono::DateTime<chrono::Utc>> {
    let secs = if v > 10_000_000_000 {
        v / 1_000_000_000
    } else {
        v
    };
    chrono::DateTime::from_timestamp(secs + APPLE_EPOCH, 0)
}

/// `sqlite3 -json`'s rows as threads; a handle with a contact's name
/// shows the name.
fn threads_from(json: &str, names: &HashMap<String, String>) -> Result<Vec<Thread>, String> {
    if json.trim().is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<serde_json::Value> =
        serde_json::from_str(json).map_err(|e| format!("Messages answered oddly: {e}"))?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            let newest = apple_time(r["newest"].as_i64()?)?;
            let display = r["display"].as_str().unwrap_or("").trim();
            let who = if !display.is_empty() {
                display.to_string()
            } else {
                r["handles"]
                    .as_str()
                    .unwrap_or("")
                    .split(", ")
                    .filter(|h| !h.is_empty())
                    .map(|h| {
                        names
                            .get(&handle_key(h))
                            .cloned()
                            .unwrap_or_else(|| h.to_string())
                    })
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            Some(Thread {
                who: if who.is_empty() {
                    "someone".into()
                } else {
                    who
                },
                count: r["n"].as_u64().unwrap_or(0) as u32,
                newest,
                theirs_last: r["mine"].as_i64() == Some(0),
            })
        })
        .collect())
}

fn read_messages(w: &Window) -> Result<Found, String> {
    let db = chat_db().ok_or("no home folder")?;
    let since_ns = (w.since.timestamp() - APPLE_EPOCH) * 1_000_000_000;
    let out = std::process::Command::new("/usr/bin/sqlite3")
        .arg("-readonly")
        .arg("-json")
        .arg(&db)
        .arg(threads_sql(since_ns))
        .output()
        .map_err(|e| format!("sqlite3 did not start: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!(
            "sqlite3 said: {}",
            err.lines().next().unwrap_or("nothing")
        ));
    }
    // Names only when Contacts is allowed (reading it otherwise could ask).
    let names = if macos_access(Source::Contacts) == Access::Allowed {
        mac::contact_names().unwrap_or_default()
    } else {
        HashMap::new()
    };
    threads_from(&String::from_utf8_lossy(&out.stdout), &names).map(Found::Messages)
}

#[cfg(target_os = "macos")]
fn macos_access(source: Source) -> Access {
    mac::access(source)
}

#[cfg(not(target_os = "macos"))]
fn macos_access(_source: Source) -> Access {
    Access::NotOnThisMac
}

impl MacStores for Mac {
    fn access(&self, source: Source) -> Access {
        match source {
            Source::Messages => {
                if cfg!(target_os = "macos") {
                    messages_access()
                } else {
                    Access::NotOnThisMac
                }
            }
            s => macos_access(s),
        }
    }

    fn read(&self, source: Source, w: &Window) -> Result<Found, String> {
        if self.access(source) != Access::Allowed {
            return Err("not allowed".into());
        }
        match source {
            Source::Messages => read_messages(w),
            Source::Contacts => mac::birthdays().map(Found::Contacts),
            Source::Reminders => mac::reminders(w).map(Found::Reminders),
            Source::Calendar => mac::events(w).map(Found::Calendar),
        }
    }

    fn change_reminder(
        &self,
        change: &nightloom_service::home::reminders::Change,
    ) -> Result<String, String> {
        // Checked again here, beside the write: never a request, so never
        // a dialog — a store that is not allowed is an error in words.
        if self.access(Source::Reminders) != Access::Allowed {
            return Err(
                "Reminders is not allowed to Nightloom on this Mac. Nothing was changed.".into(),
            );
        }
        mac::change_reminder(change)
    }
}

fn config() -> Result<PathBuf, String> {
    project::config_dir().ok_or_else(|| "no Nightloom home".to_string())
}

/// The four rows, read now (off the main thread: the status calls are
/// cheap, but they are framework calls).
pub(crate) async fn rows() -> Result<Vec<Row>, String> {
    let config = config()?;
    tauri::async_runtime::spawn_blocking(move || sources::rows(&config, Some(&Mac)))
        .await
        .map_err(|e| e.to_string())
}

/// Settings → Home's rows.
#[tauri::command]
pub(crate) async fn home_sources() -> Result<Vec<Row>, String> {
    rows().await
}

fn open_settings(source: Source) -> Result<(), String> {
    std::process::Command::new("/usr/bin/open")
        .arg(source.settings_url())
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("System Settings did not open: {e}"))
}

/// His Allow on a row: Messages opens System Settings at Full Disk Access;
/// the others ask macOS (the one dialog, only from this press) when never
/// asked, else open System Settings at their pane. The rows after.
#[tauri::command]
pub(crate) async fn home_source_allow(app: AppHandle, id: String) -> Result<Vec<Row>, String> {
    let source = Source::parse(&id).ok_or_else(|| format!("no source {id}"))?;
    let status = Mac.access(source);
    // His press is the grant from inside Nightloom (merge round S): the
    // scan reads a store only with it, whatever macOS already allows.
    if status != Access::NotOnThisMac {
        sources::grant(&config()?, source)?;
    }
    match (source, status) {
        (_, Access::Allowed) => {}
        (Source::Messages, _) | (_, Access::Denied | Access::WriteOnly) => open_settings(source)?,
        (_, Access::NotAsked) => {
            let done = move || {
                let _ = app.emit(CHANGED, source.id());
            };
            mac::request(source, Box::new(done))?;
        }
        (_, Access::NotOnThisMac) => {
            return Err(format!("{} is not on this Mac.", source.name()));
        }
    }
    rows().await
}

/// His On/Off switch on an allowed row.
#[tauri::command]
pub(crate) async fn home_source_set(id: String, on: bool) -> Result<Vec<Row>, String> {
    let source = Source::parse(&id).ok_or_else(|| format!("no source {id}"))?;
    sources::set_on(&config()?, source, on)?;
    rows().await
}

/// The phone asked for `source` (`POST /api/home/sources/{id}/ask`): the
/// window opens Settings → Home at its row and a banner says why. Nothing
/// here raises a macOS permission dialog — that waits for his press.
pub(crate) fn ask_from_phone(app: &AppHandle, source: Source) -> Result<String, String> {
    match Mac.access(source) {
        Access::Allowed => return Ok(format!("{} is already allowed.", source.name())),
        Access::NotOnThisMac => return Err(format!("{} is not on this Mac.", source.name())),
        _ => {}
    }
    app.emit(ASKED, source.id()).map_err(|e| e.to_string())?;
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = app
            .notification()
            .builder()
            .title("Home asks to read ".to_string() + source.name())
            .body("From your phone. Settings → Home is open at it: press Allow there.")
            .show();
    }
    Ok(format!(
        "Settings → Home is open on the Mac at {}. Press Allow there.",
        source.name()
    ))
}

#[cfg(not(target_os = "macos"))]
mod mac {
    use super::*;
    use nightloom_service::home::sources::{Birthday, Event, Reminder};

    pub fn contact_names() -> Result<HashMap<String, String>, String> {
        Ok(HashMap::new())
    }
    pub fn birthdays() -> Result<Vec<Birthday>, String> {
        Err("not on this Mac".into())
    }
    pub fn reminders(_w: &Window) -> Result<Vec<Reminder>, String> {
        Err("not on this Mac".into())
    }
    pub fn events(_w: &Window) -> Result<Vec<Event>, String> {
        Err("not on this Mac".into())
    }
    pub fn request(_s: Source, _done: Box<dyn FnOnce() + Send>) -> Result<(), String> {
        Err("not on this Mac".into())
    }
    pub fn change_reminder(
        _c: &nightloom_service::home::reminders::Change,
    ) -> Result<String, String> {
        Err("not on this Mac".into())
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use std::ffi::{CStr, c_char};
    use std::panic::AssertUnwindSafe;
    use std::time::Duration;

    use block2::RcBlock;
    use nightloom_service::home::reminders::{self, Action, Change};
    use nightloom_service::home::sources::{Birthday, Event, Reminder};
    use objc2::rc::{Allocated, Retained, autoreleasepool};
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::{msg_send, sel};

    #[link(name = "Contacts", kind = "framework")]
    unsafe extern "C" {}
    #[link(name = "EventKit", kind = "framework")]
    unsafe extern "C" {}

    /// NSDateComponentUndefined.
    const UNDEFINED: isize = isize::MAX;
    /// EKEntityType.
    const EVENTS: usize = 0;
    const REMINDERS: usize = 1;

    /// Run `f` with a pool, an Objective-C exception as an error.
    fn guarded<R>(f: impl FnOnce() -> Result<R, String>) -> Result<R, String> {
        autoreleasepool(|_| {
            objc2::exception::catch(AssertUnwindSafe(f))
                .unwrap_or_else(|e| Err(format!("macOS raised {e:?}")))
        })
    }

    fn class(name: &CStr) -> Result<&'static AnyClass, String> {
        AnyClass::get(name).ok_or_else(|| format!("{} is missing", name.to_string_lossy()))
    }

    /// An NSString's text (empty for nil).
    unsafe fn text(s: Option<Retained<AnyObject>>) -> String {
        let Some(s) = s else {
            return String::new();
        };
        // SAFETY: the caller's: `s` is an NSString.
        let p: *const c_char = unsafe { msg_send![&*s, UTF8String] };
        if p.is_null() {
            return String::new();
        }
        // SAFETY: UTF8String is NUL-terminated and lives with the pool.
        unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned()
    }

    fn nsstring(s: &str) -> Result<Retained<AnyObject>, String> {
        let c = std::ffi::CString::new(s).map_err(|e| e.to_string())?;
        let cls = class(c"NSString")?;
        // SAFETY: a public class method taking a C string.
        let out: Option<Retained<AnyObject>> =
            unsafe { msg_send![cls, stringWithUTF8String: c.as_ptr()] };
        out.ok_or_else(|| "no string".into())
    }

    fn nsdate(t: chrono::DateTime<chrono::Utc>) -> Result<Retained<AnyObject>, String> {
        let cls = class(c"NSDate")?;
        let secs = t.timestamp() as f64;
        // SAFETY: a public class method.
        let out: Option<Retained<AnyObject>> =
            unsafe { msg_send![cls, dateWithTimeIntervalSince1970: secs] };
        out.ok_or_else(|| "no date".into())
    }

    /// An NSDate as UTC.
    unsafe fn utc(d: Option<Retained<AnyObject>>) -> Option<chrono::DateTime<chrono::Utc>> {
        let d = d?;
        // SAFETY: the caller's: `d` is an NSDate.
        let secs: f64 = unsafe { msg_send![&*d, timeIntervalSince1970] };
        chrono::DateTime::from_timestamp(secs as i64, 0)
    }

    /// Each object of an NSArray.
    unsafe fn each(arr: Option<&AnyObject>) -> Vec<Retained<AnyObject>> {
        let Some(arr) = arr else {
            return Vec::new();
        };
        // SAFETY: the caller's: `arr` is an NSArray.
        let n: usize = unsafe { msg_send![arr, count] };
        (0..n)
            .filter_map(|i| {
                // SAFETY: i < count.
                let o: Option<Retained<AnyObject>> = unsafe { msg_send![arr, objectAtIndex: i] };
                o
            })
            .collect()
    }

    pub fn access(source: Source) -> Access {
        let read = || -> Result<Access, String> {
            match source {
                Source::Contacts => {
                    let cls = class(c"CNContactStore")?;
                    // CNEntityTypeContacts = 0. SAFETY: a public class method; reads, never asks.
                    let st: isize =
                        unsafe { msg_send![cls, authorizationStatusForEntityType: 0isize] };
                    Ok(match st {
                        0 => Access::NotAsked,
                        3 | 4 => Access::Allowed,
                        _ => Access::Denied,
                    })
                }
                Source::Reminders | Source::Calendar => {
                    let cls = class(c"EKEventStore")?;
                    let kind = if source == Source::Reminders {
                        REMINDERS
                    } else {
                        EVENTS
                    };
                    // SAFETY: a public class method; reads, never asks.
                    let st: isize =
                        unsafe { msg_send![cls, authorizationStatusForEntityType: kind] };
                    Ok(match st {
                        0 => Access::NotAsked,
                        3 => Access::Allowed,
                        4 => Access::WriteOnly,
                        _ => Access::Denied,
                    })
                }
                Source::Messages => Ok(messages_access()),
            }
        };
        guarded(read).unwrap_or(Access::NotOnThisMac)
    }

    /// Ask macOS for `source` — the dialog, from his press only. `done`
    /// runs once he has answered.
    pub fn request(source: Source, done: Box<dyn FnOnce() + Send>) -> Result<(), String> {
        let done = std::sync::Mutex::new(Some(done));
        guarded(move || {
            let answered = move || {
                if let Some(f) = done.lock().ok().and_then(|mut d| d.take()) {
                    f();
                }
            };
            match source {
                Source::Contacts => {
                    let cls = class(c"CNContactStore")?;
                    // SAFETY: public API; the store is kept by the block.
                    let store: Retained<AnyObject> = unsafe { msg_send![cls, new] };
                    let keep = store.clone();
                    let block = RcBlock::new(move |_ok: Bool, _err: *mut AnyObject| {
                        let _ = &keep;
                        answered();
                    });
                    // SAFETY: the block matches `(BOOL, NSError *)`; macOS copies it.
                    let _: () = unsafe {
                        msg_send![&*store, requestAccessForEntityType: 0isize, completionHandler: &*block]
                    };
                }
                Source::Reminders | Source::Calendar => {
                    let cls = class(c"EKEventStore")?;
                    // SAFETY: public API.
                    let store: Retained<AnyObject> = unsafe { msg_send![cls, new] };
                    let keep = store.clone();
                    let block = RcBlock::new(move |_ok: Bool, _err: *mut AnyObject| {
                        let _ = &keep;
                        answered();
                    });
                    let full = if source == Source::Reminders {
                        sel!(requestFullAccessToRemindersWithCompletion:)
                    } else {
                        sel!(requestFullAccessToEventsWithCompletion:)
                    };
                    // SAFETY: a public instance method.
                    let has_full: bool = unsafe { msg_send![&*store, respondsToSelector: full] };
                    // SAFETY: the block matches `(BOOL, NSError *)`; EventKit copies it.
                    unsafe {
                        if !has_full {
                            let kind = if source == Source::Reminders {
                                REMINDERS
                            } else {
                                EVENTS
                            };
                            let _: () = msg_send![&*store, requestAccessToEntityType: kind, completion: &*block];
                        } else if source == Source::Reminders {
                            let _: () = msg_send![&*store, requestFullAccessToRemindersWithCompletion: &*block];
                        } else {
                            let _: () = msg_send![&*store, requestFullAccessToEventsWithCompletion: &*block];
                        }
                    }
                }
                Source::Messages => return Err("Messages is allowed in System Settings".into()),
            }
            Ok(())
        })
    }

    /// Every contact, through `f` (keys: names, birthday, numbers, mail).
    /// Only ever called with Contacts allowed.
    fn contacts(mut f: impl FnMut(&AnyObject)) -> Result<(), String> {
        guarded(|| {
            let keys_cls = class(c"NSMutableArray")?;
            // SAFETY: public API.
            let keys: Retained<AnyObject> = unsafe { msg_send![keys_cls, array] };
            for k in [
                "givenName",
                "familyName",
                "nickname",
                "birthday",
                "phoneNumbers",
                "emailAddresses",
            ] {
                let s = nsstring(k)?;
                // SAFETY: adding an NSString to an NSMutableArray.
                let _: () = unsafe { msg_send![&*keys, addObject: &*s] };
            }
            let fr = class(c"CNContactFetchRequest")?;
            // SAFETY: alloc + init of a public class.
            let req: Allocated<AnyObject> = unsafe { msg_send![fr, alloc] };
            let req: Option<Retained<AnyObject>> =
                unsafe { msg_send![req, initWithKeysToFetch: &*keys] };
            let req = req.ok_or("no fetch request")?;
            let cls = class(c"CNContactStore")?;
            // SAFETY: public API.
            let store: Retained<AnyObject> = unsafe { msg_send![cls, new] };
            let f = std::cell::RefCell::new(&mut f);
            let block = block2::StackBlock::new(|contact: *mut AnyObject, _stop: *mut Bool| {
                if let Some(c) = unsafe { contact.as_ref() } {
                    (f.borrow_mut())(c);
                }
            });
            let mut err: *mut AnyObject = std::ptr::null_mut();
            // SAFETY: synchronous; the block is called on this thread
            // before the call returns.
            let ok: bool = unsafe {
                msg_send![&*store, enumerateContactsWithFetchRequest: &*req, error: &mut err, usingBlock: &*block]
            };
            if ok {
                Ok(())
            } else {
                Err("Contacts did not answer".into())
            }
        })
    }

    unsafe fn full_name(c: &AnyObject) -> String {
        // SAFETY: the caller's: `c` is a CNContact fetched with these keys.
        unsafe {
            let given = text(msg_send![c, givenName]);
            let family = text(msg_send![c, familyName]);
            let nick = text(msg_send![c, nickname]);
            let name = format!("{given} {family}").trim().to_string();
            if name.is_empty() { nick } else { name }
        }
    }

    pub fn birthdays() -> Result<Vec<Birthday>, String> {
        let mut out = Vec::new();
        contacts(|c| {
            // SAFETY: a CNContact fetched with `birthday`.
            unsafe {
                let b: Option<Retained<AnyObject>> = msg_send![c, birthday];
                let Some(b) = b else { return };
                let month: isize = msg_send![&*b, month];
                let day: isize = msg_send![&*b, day];
                if month == UNDEFINED || day == UNDEFINED || month < 1 || day < 1 {
                    return;
                }
                out.push(Birthday {
                    name: full_name(c),
                    month: month as u32,
                    day: day as u32,
                });
            }
        })?;
        Ok(out)
    }

    /// Each number and address of his contacts → the contact's name.
    pub fn contact_names() -> Result<HashMap<String, String>, String> {
        let mut out = HashMap::new();
        contacts(|c| {
            // SAFETY: a CNContact fetched with these keys.
            unsafe {
                let name = full_name(c);
                if name.is_empty() {
                    return;
                }
                let phones: Option<Retained<AnyObject>> = msg_send![c, phoneNumbers];
                for lv in each(phones.as_deref()) {
                    let n: Option<Retained<AnyObject>> = msg_send![&*lv, value];
                    let Some(n) = n else { continue };
                    let s = text(msg_send![&*n, stringValue]);
                    let k = handle_key(&s);
                    if k.len() >= 7 {
                        out.entry(k).or_insert_with(|| name.clone());
                    }
                }
                let mails: Option<Retained<AnyObject>> = msg_send![c, emailAddresses];
                for lv in each(mails.as_deref()) {
                    let s = text(msg_send![&*lv, value]);
                    if !s.is_empty() {
                        out.entry(handle_key(&s)).or_insert_with(|| name.clone());
                    }
                }
            }
        })?;
        Ok(out)
    }

    fn event_store() -> Result<Retained<AnyObject>, String> {
        let cls = class(c"EKEventStore")?;
        // SAFETY: public API; only made with access allowed.
        let s: Option<Retained<AnyObject>> = unsafe { msg_send![cls, new] };
        s.ok_or_else(|| "no event store".into())
    }

    /// A calendar's title and its account's.
    unsafe fn calendar_of(item: &AnyObject) -> (String, String) {
        // SAFETY: the caller's: an EKCalendarItem.
        unsafe {
            let cal: Option<Retained<AnyObject>> = msg_send![item, calendar];
            let Some(cal) = cal else {
                return (String::new(), String::new());
            };
            let title = text(msg_send![&*cal, title]);
            let src: Option<Retained<AnyObject>> = msg_send![&*cal, source];
            let account = src.map(|s| text(msg_send![&*s, title])).unwrap_or_default();
            (title, account)
        }
    }

    pub fn events(w: &Window) -> Result<Vec<Event>, String> {
        guarded(|| {
            let store = event_store()?;
            let from = nsdate(w.today)?;
            let to = nsdate(w.day_after)?;
            let none: *mut AnyObject = std::ptr::null_mut();
            // SAFETY: public API.
            let pred: Option<Retained<AnyObject>> = unsafe {
                msg_send![&*store, predicateForEventsWithStartDate: &*from, endDate: &*to, calendars: none]
            };
            let pred = pred.ok_or("no predicate")?;
            let found: Option<Retained<AnyObject>> =
                unsafe { msg_send![&*store, eventsMatchingPredicate: &*pred] };
            let mut out = Vec::new();
            // SAFETY: `found` is EventKit's NSArray of EKEvent.
            for e in unsafe { each(found.as_deref()) } {
                // SAFETY: EKEvent's public properties.
                unsafe {
                    let Some(start) = utc(msg_send![&*e, startDate]) else {
                        continue;
                    };
                    let all_day: bool = msg_send![&*e, isAllDay];
                    let (calendar, account) = calendar_of(&e);
                    out.push(Event {
                        title: text(msg_send![&*e, title]),
                        start,
                        all_day,
                        calendar,
                        account,
                    });
                }
            }
            Ok(out)
        })
    }

    pub fn reminders(w: &Window) -> Result<Vec<Reminder>, String> {
        let (tx, rx) = std::sync::mpsc::channel::<Vec<Reminder>>();
        // The store must outlive the fetch: kept here until the answer.
        let store = guarded(|| {
            let store = event_store()?;
            let end = nsdate(w.tomorrow)?;
            let none: *mut AnyObject = std::ptr::null_mut();
            // SAFETY: public API.
            let pred: Option<Retained<AnyObject>> = unsafe {
                msg_send![&*store, predicateForIncompleteRemindersWithDueDateStarting: none, ending: &*end, calendars: none]
            };
            let pred = pred.ok_or("no predicate")?;
            let cal_cls = class(c"NSCalendar")?;
            let block = RcBlock::new(move |arr: *mut AnyObject| {
                let mut out = Vec::new();
                let _ = guarded(|| {
                    // SAFETY: EventKit hands an NSArray of EKReminder.
                    unsafe {
                        let calendar: Option<Retained<AnyObject>> =
                            msg_send![cal_cls, currentCalendar];
                        for r in each(arr.as_ref()) {
                            let comps: Option<Retained<AnyObject>> =
                                msg_send![&*r, dueDateComponents];
                            let (due, all_day) = match (&comps, &calendar) {
                                (Some(c), Some(cal)) => {
                                    let hour: isize = msg_send![&**c, hour];
                                    (
                                        utc(msg_send![&**cal, dateFromComponents: &**c]),
                                        hour == UNDEFINED,
                                    )
                                }
                                _ => (None, false),
                            };
                            let (list, _) = calendar_of(&r);
                            out.push(Reminder {
                                title: text(msg_send![&*r, title]),
                                due,
                                all_day,
                                list,
                            });
                        }
                    }
                    Ok(())
                });
                let _ = tx.send(out);
            });
            // SAFETY: the block matches `(NSArray *)`; EventKit copies it.
            let _: Option<Retained<AnyObject>> = unsafe {
                msg_send![&*store, fetchRemindersMatchingPredicate: &*pred, completion: &*block]
            };
            Ok(store)
        })?;
        let got = rx
            .recv_timeout(Duration::from_secs(20))
            .map_err(|_| "Reminders did not answer in 20 s".to_string());
        drop(store);
        got
    }

    /// The Reminders lists: each one's title, whether it takes changes,
    /// and the list itself.
    unsafe fn reminder_lists(store: &AnyObject) -> Vec<(String, bool, Retained<AnyObject>)> {
        // SAFETY: the caller's: `store` is an EKEventStore; EventKit's
        // public API, and each object is an EKCalendar.
        unsafe {
            let arr: Option<Retained<AnyObject>> =
                msg_send![store, calendarsForEntityType: REMINDERS];
            each(arr.as_deref())
                .into_iter()
                .map(|c| {
                    let title = text(msg_send![&*c, title]);
                    let open: bool = msg_send![&*c, allowsContentModifications];
                    (title, open, c)
                })
                .collect()
        }
    }

    /// Save `reminder` at once; EventKit's own words when it will not.
    unsafe fn save_reminder(store: &AnyObject, reminder: &AnyObject) -> Result<(), String> {
        let mut err: *mut AnyObject = std::ptr::null_mut();
        // SAFETY: the caller's: an EKEventStore and an EKReminder of it;
        // `(EKReminder *, BOOL, NSError **)` returning BOOL.
        let ok: bool =
            unsafe { msg_send![store, saveReminder: reminder, commit: true, error: &mut err] };
        if ok {
            return Ok(());
        }
        // SAFETY: a non-nil `err` is the NSError EventKit wrote.
        let why = match unsafe { err.as_ref() } {
            Some(e) => unsafe { text(msg_send![e, localizedDescription]) },
            None => String::new(),
        };
        Err(if why.is_empty() {
            "Reminders did not save it. Nothing was changed.".into()
        } else {
            format!("Reminders did not save it ({why}). Nothing was changed.")
        })
    }

    /// One change to Reminders (item 872). Only ever called with
    /// Reminders allowed in full; nothing here asks macOS for access.
    pub fn change_reminder(change: &Change) -> Result<String, String> {
        match change.action {
            Action::Add => add_reminder(change),
            Action::Complete => complete_reminder(change),
        }
    }

    fn add_reminder(change: &Change) -> Result<String, String> {
        guarded(|| {
            let store = event_store()?;
            // SAFETY: an EKEventStore.
            let lists = unsafe { reminder_lists(&store) };
            let rows: Vec<(String, bool)> = lists.iter().map(|(t, o, _)| (t.clone(), *o)).collect();
            let list = match reminders::pick_list(&rows, change.list.as_deref())? {
                Some(i) => lists[i].2.clone(),
                None => {
                    // SAFETY: public API; nil when there is no list at all.
                    let d: Option<Retained<AnyObject>> =
                        unsafe { msg_send![&*store, defaultCalendarForNewReminders] };
                    d.ok_or(
                        "Reminders has no default list on this Mac. Nothing was changed — name one of his lists.",
                    )?
                }
            };
            let cls = class(c"EKReminder")?;
            // SAFETY: a public class method.
            let r: Option<Retained<AnyObject>> =
                unsafe { msg_send![cls, reminderWithEventStore: &*store] };
            let r = r.ok_or("Reminders made no reminder")?;
            let title = nsstring(&change.title)?;
            // SAFETY: EKReminder's public setters, each handed its type.
            unsafe {
                let _: () = msg_send![&*r, setTitle: &*title];
                let _: () = msg_send![&*r, setCalendar: &*list];
                if let Some(notes) = &change.notes {
                    let notes = nsstring(notes)?;
                    let _: () = msg_send![&*r, setNotes: &*notes];
                }
                if let Some(due) = change.due {
                    let comps_cls = class(c"NSDateComponents")?;
                    let comps: Retained<AnyObject> = msg_send![comps_cls, new];
                    let _: () = msg_send![&*comps, setYear: due.year as isize];
                    let _: () = msg_send![&*comps, setMonth: due.month as isize];
                    let _: () = msg_send![&*comps, setDay: due.day as isize];
                    if let Some((h, m)) = due.time {
                        let _: () = msg_send![&*comps, setHour: h as isize];
                        let _: () = msg_send![&*comps, setMinute: m as isize];
                    }
                    let _: () = msg_send![&*r, setDueDateComponents: &*comps];
                }
                save_reminder(&store, &r)?;
                let name = text(msg_send![&*list, title]);
                Ok(reminders::added_words(change, &name))
            }
        })
    }

    fn complete_reminder(change: &Change) -> Result<String, String> {
        let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
        // The store must outlive the fetch: kept here until the answer.
        let store = guarded(|| {
            let store = event_store()?;
            let none: *mut AnyObject = std::ptr::null_mut();
            // SAFETY: public API; every open reminder, whatever its date.
            let pred: Option<Retained<AnyObject>> = unsafe {
                msg_send![&*store, predicateForIncompleteRemindersWithDueDateStarting: none, ending: none, calendars: none]
            };
            let pred = pred.ok_or("no predicate")?;
            let keep = store.clone();
            let (title, list) = (change.title.clone(), change.list.clone());
            let block = RcBlock::new(move |arr: *mut AnyObject| {
                let done = guarded(|| {
                    // SAFETY: EventKit hands an NSArray of EKReminder, each
                    // of `keep`'s store.
                    unsafe {
                        let found = each(arr.as_ref());
                        let rows: Vec<(String, String)> = found
                            .iter()
                            .map(|r| (text(msg_send![&**r, title]), calendar_of(r).0))
                            .collect();
                        let i = reminders::pick_reminder(&rows, &title, list.as_deref())?;
                        let _: () = msg_send![&*found[i], setCompleted: true];
                        save_reminder(&keep, &found[i])?;
                        Ok(reminders::done_words(&rows[i].0, &rows[i].1))
                    }
                });
                let _ = tx.send(done);
            });
            // SAFETY: the block matches `(NSArray *)`; EventKit copies it.
            let _: Option<Retained<AnyObject>> = unsafe {
                msg_send![&*store, fetchRemindersMatchingPredicate: &*pred, completion: &*block]
            };
            Ok(store)
        })?;
        let got = rx.recv_timeout(Duration::from_secs(20)).unwrap_or_else(|_| {
            Err("Reminders did not answer in 20 s. Check Reminders before trying again: the change may still land.".into())
        });
        drop(store);
        got
    }

    /// The classes and selectors the writer sends, as `(class, selector,
    /// on the class itself)` — for the test that each one exists on this
    /// macOS without making a store or touching a reminder.
    #[cfg(test)]
    pub fn writer_selectors_missing() -> Vec<String> {
        let wants: [(&CStr, objc2::runtime::Sel, bool); 15] = [
            (c"EKEventStore", sel!(calendarsForEntityType:), false),
            (c"EKEventStore", sel!(defaultCalendarForNewReminders), false),
            (c"EKEventStore", sel!(saveReminder:commit:error:), false),
            (
                c"EKEventStore",
                sel!(predicateForIncompleteRemindersWithDueDateStarting:ending:calendars:),
                false,
            ),
            (
                c"EKEventStore",
                sel!(fetchRemindersMatchingPredicate:completion:),
                false,
            ),
            (c"EKCalendar", sel!(allowsContentModifications), false),
            (c"EKCalendar", sel!(title), false),
            (c"EKReminder", sel!(reminderWithEventStore:), true),
            (c"EKReminder", sel!(setTitle:), false),
            (c"EKReminder", sel!(setCalendar:), false),
            (c"EKReminder", sel!(setNotes:), false),
            (c"EKReminder", sel!(setDueDateComponents:), false),
            (c"EKReminder", sel!(setCompleted:), false),
            (c"NSDateComponents", sel!(setMinute:), false),
            (c"NSError", sel!(localizedDescription), false),
        ];
        let mut missing = Vec::new();
        for (cls, sel, on_class) in wants {
            let Ok(c) = class(cls) else {
                missing.push(format!("{} (class)", cls.to_string_lossy()));
                continue;
            };
            // SAFETY: NSObject's public class methods; they read the
            // class's method table and make nothing.
            let has: bool = unsafe {
                if on_class {
                    msg_send![c, respondsToSelector: sel]
                } else {
                    msg_send![c, instancesRespondToSelector: sel]
                }
            };
            if !has {
                missing.push(format!(
                    "{} {}",
                    cls.to_string_lossy(),
                    sel.name().to_string_lossy()
                ));
            }
        }
        missing
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The status calls never ask (no dialog) and never crash, whatever
    /// this Mac answers; off macOS every store is "not on this Mac".
    #[test]
    fn every_status_reads_without_a_dialog() {
        for s in Source::ALL {
            let a = Mac.access(s);
            if !cfg!(target_os = "macos") {
                assert_eq!(a, Access::NotOnThisMac);
            }
            eprintln!("{}: {a:?}", s.name());
        }
    }

    /// Item 872: every class and selector the Reminders writer sends is
    /// on this macOS. Reads the classes' method tables only — no store is
    /// made, no reminder read or written, nothing asked.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_reminders_writers_selectors_exist() {
        assert_eq!(mac::writer_selectors_missing(), Vec::<String>::new());
    }

    /// Item 872: the writer refuses in words where Reminders is not
    /// allowed to this binary, and writes only where it is — which this
    /// test never does: it stops unless the status says "not allowed".
    #[test]
    fn the_writer_refuses_without_access_and_never_asks() {
        if Mac.access(Source::Reminders) == Access::Allowed {
            eprintln!("SKIPPED: Reminders is allowed here; a write is not made from a test");
            return;
        }
        let change = nightloom_service::home::reminders::parse(&serde_json::json!({
            "action": "add", "title": "never written"
        }))
        .unwrap();
        let e = Mac.change_reminder(&change).unwrap_err();
        assert!(e.contains("not allowed"), "{e}");
    }

    #[test]
    fn a_handle_is_keyed_by_its_last_ten_digits_or_its_address() {
        assert_eq!(handle_key("+1 (949) 555-0100"), "9495550100");
        assert_eq!(handle_key("9495550100"), "9495550100");
        assert_eq!(handle_key(" Me@Example.com "), "me@example.com");
    }

    #[test]
    fn messages_rows_become_threads_with_names_and_never_text() {
        let since_2001 = 816_000_000i64; // seconds after 2001, in 2026
        let json = format!(
            r#"[{{"id":1,"display":"","handles":"+19495550100","n":3,"newest":{ns},"mine":0}},
               {{"id":2,"display":"Climbing","handles":"a@b.c, +1 555 0101","n":1,"newest":{s},"mine":1}},
               {{"id":3,"display":"","handles":"","n":1,"newest":{s},"mine":null}}]"#,
            ns = since_2001 * 1_000_000_000,
            s = since_2001
        );
        let mut names = HashMap::new();
        names.insert("9495550100".to_string(), "Alex Kim".to_string());
        let t = threads_from(&json, &names).unwrap();
        assert_eq!(t.len(), 3);
        assert_eq!(t[0].who, "Alex Kim");
        assert!(t[0].theirs_last && t[0].count == 3);
        assert_eq!(t[0].newest.timestamp(), since_2001 + APPLE_EPOCH);
        // Seconds (an old Mac) read the same as nanoseconds.
        assert_eq!(t[1].newest, t[0].newest);
        assert_eq!(t[1].who, "Climbing");
        assert!(!t[1].theirs_last);
        assert_eq!(t[2].who, "someone");
        assert!(threads_from("", &names).unwrap().is_empty());
        // The query selects no message text.
        let sql = threads_sql(0);
        assert!(!sql.contains("text") && !sql.contains("attributedBody"));
    }
}
