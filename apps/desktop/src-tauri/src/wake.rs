//! The clock behind Send later and the limit card's resume (nightshift
//! backlog 535, 2026-11-09).
//!
//! Both were JavaScript timers in the page — a `setInterval` and a
//! `setTimeout` — and WebKit slows or stops a page's timers while its
//! window is hidden, covered, minimized, on another Space or behind the
//! lock screen (`offscreen.rs`: a hidden dev window measured at +420 s).
//! His 5-hour-reset message went an hour late, when he touched the Mac.
//!
//! So the time is kept here. The page arms a named wake with the wall-clock
//! moment it next has something to do ([`Wakes::arm`], the `arm_wake`
//! command); one task compares the wall clock every second and emits
//! `wake-due` (payload: the name) at that moment, and again every
//! [`REPEAT`] while the wake is still armed and past — the page re-arms or
//! clears it when it has acted, so a page that was not ready is asked again.
//! An event from Rust is delivered to the page whatever its timers are
//! doing. The wall clock, not a long `sleep`: tokio's timer does not advance
//! while the Mac sleeps (`power.rs`), and a one-second poll that reads the
//! wall clock fires within a second of the wake.
//!
//! While a wake is armed the process holds an `NSProcessInfo` activity, so
//! App Nap does not slow this task either; and while one is due within
//! [`AWAKE_WITHIN`] it holds a `caffeinate -i -s` child (system only, never
//! the display; his Settings switch decides), so a Mac he walked away from
//! is awake at the time. Each emission and each line the page reports
//! ([`log`]) goes to `<config dir>/logs/schedule.log`, which is what a late
//! send is diagnosed from.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// How often the task looks at the wall clock.
pub const POLL: Duration = Duration::from_secs(1);
/// A wake still armed and past is emitted again this often.
pub const REPEAT: Duration = Duration::from_secs(15);
/// The Mac is kept awake for a wake due within this long.
pub const AWAKE_WITHIN: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Armed {
    at_ms: u64,
    /// The last emission, 0 before the first.
    emitted_ms: u64,
}

/// The armed wakes, by name. Managed by Tauri.
#[derive(Default)]
pub struct Wakes {
    inner: Mutex<HashMap<String, Armed>>,
}

impl Wakes {
    fn inner(&self) -> std::sync::MutexGuard<'_, HashMap<String, Armed>> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Arm `name` for `at_ms` (wall clock), or clear it with `None`. Arming
    /// again for the same moment keeps the emission record, so a page that
    /// re-arms an unchanged time is not sent a burst.
    pub fn arm(&self, name: &str, at_ms: Option<u64>) {
        let mut inner = self.inner();
        match at_ms {
            None => {
                inner.remove(name);
            }
            Some(at_ms) => {
                let same = inner.get(name).is_some_and(|a| a.at_ms == at_ms);
                if !same {
                    inner.insert(
                        name.to_string(),
                        Armed {
                            at_ms,
                            emitted_ms: 0,
                        },
                    );
                }
            }
        }
    }

    /// The wakes to emit at `now_ms`, marked emitted: each one due, and not
    /// emitted within [`REPEAT`]. Sorted, for the tests.
    pub fn due(&self, now_ms: u64) -> Vec<String> {
        let repeat = REPEAT.as_millis() as u64;
        let mut out = Vec::new();
        for (name, a) in self.inner().iter_mut() {
            if a.at_ms <= now_ms
                && (a.emitted_ms == 0 || now_ms.saturating_sub(a.emitted_ms) >= repeat)
            {
                a.emitted_ms = now_ms;
                out.push(name.clone());
            }
        }
        out.sort();
        out
    }

    /// Whether anything is armed, and whether anything is due within
    /// [`AWAKE_WITHIN`] of `now_ms` (past ones included).
    pub fn pending(&self, now_ms: u64) -> (bool, bool) {
        let inner = self.inner();
        let within = AWAKE_WITHIN.as_millis() as u64;
        (
            !inner.is_empty(),
            inner
                .values()
                .any(|a| a.at_ms <= now_ms.saturating_add(within)),
        )
    }
}

fn wall_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `<config dir>/logs/schedule.log`, or `None` with no config dir.
pub fn log_path() -> Option<PathBuf> {
    nightloom_service::project::config_dir().map(|c| c.join("logs").join("schedule.log"))
}

/// One line: `<now, UTC> <who> <text>`, newlines flattened.
pub fn line(wall: chrono::DateTime<chrono::Utc>, who: &str, text: &str) -> String {
    format!(
        "{} {who} {}",
        wall.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        text.replace(['\n', '\r'], " ")
    )
}

/// Append a line to the schedule log. Best-effort: a log that cannot be
/// written never stops a send. The file is started over past 1 MB.
pub fn log(who: &str, text: &str) {
    let Some(path) = log_path() else {
        return;
    };
    log_to(&path, who, text);
}

fn log_to(path: &std::path::Path, who: &str, text: &str) {
    use std::io::Write as _;
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::metadata(path).is_ok_and(|m| m.len() > 1_000_000) {
        let _ = std::fs::remove_file(path);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(f, "{}", line(chrono::Utc::now(), who, text));
    }
}

/// `caffeinate -i -s -w <our pid>`: no idle sleep, no system sleep on
/// mains; the display may sleep. As `power.rs`'s child, let go by itself
/// if this process dies.
fn spawn_awake() -> Option<Child> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    Command::new("caffeinate")
        .args(["-i", "-s", "-w"])
        .arg(std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()
}

/// A debug build's timing probe (nightshift item 535m, 2026-11-10): with
/// `NIGHTLOOM_PROBE_DUE_S=<n>[,<n>…]` the page schedules a message for a
/// chat that does not exist, due `n` seconds after launch (one chat per
/// time), and logs every tick
/// of its own interval; with `NIGHTLOOM_PROBE_LIMIT_S=<n>` it also arms a
/// limit resume for that moment. Its `kept … waiting` line in the schedule
/// log is the delivery attempt's time. Always `None` in a release build.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct Probe {
    pub due_ms: Vec<u64>,
    pub limit_ms: Option<u64>,
}

static LAUNCH_MS: std::sync::OnceLock<u64> = std::sync::OnceLock::new();

/// Note the launch moment the probe counts from (called at setup).
pub fn mark_launch() {
    let _ = LAUNCH_MS.set(wall_ms());
}

/// The probe this run asked for, from the environment.
pub fn probe() -> Probe {
    if !cfg!(debug_assertions) {
        return Probe::default();
    }
    let launch = *LAUNCH_MS.get_or_init(wall_ms);
    let at = |var: &str| -> Vec<u64> {
        std::env::var(var)
            .unwrap_or_default()
            .split(',')
            .filter_map(|v| v.trim().parse::<u64>().ok())
            .map(|s| launch + s * 1000)
            .collect()
    };
    Probe {
        due_ms: at("NIGHTLOOM_PROBE_DUE_S"),
        limit_ms: at("NIGHTLOOM_PROBE_LIMIT_S").first().copied(),
    }
}

/// Run the clock for the life of the app.
pub fn watch(app: tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    tauri::async_runtime::spawn(async move {
        let mut awake: Option<Child> = None;
        let mut activity = nap::Activity::default();
        loop {
            tokio::time::sleep(POLL).await;
            let now = wall_ms();
            let Some(wakes) = app.try_state::<Wakes>() else {
                continue;
            };
            let (armed, soon) = wakes.pending(now);
            // Blocker 1799: a chat being kept warm holds the Mac awake too.
            let warming = crate::keep_warm::warming(&app);
            activity.set(armed || warming);
            let keep = (soon || warming)
                && app
                    .try_state::<crate::power::Holder>()
                    .is_none_or(|h| h.keep_awake());
            match (keep, awake.is_some()) {
                (true, false) => awake = spawn_awake(),
                (false, true) => {
                    if let Some(mut c) = awake.take() {
                        let _ = c.kill();
                        let _ = c.wait();
                    }
                }
                _ => {}
            }
            for name in wakes.due(now) {
                log("rust", &format!("wake-due {name}"));
                let _ = app.emit("wake-due", &name);
            }
        }
    });
}

/// Seconds since the last keyboard, mouse or trackpad input on this Mac
/// (nightshift backlog 544): how the window tells "he is away" when it is
/// itself in front — a Mac left overnight with Nightloom frontmost never
/// lost focus, so the hand-off's away rule never held. `None` off macOS.
/// Reads a counter the window server keeps; needs no permission.
pub fn idle_seconds() -> Option<f64> {
    #[cfg(target_os = "macos")]
    {
        #[link(name = "CoreGraphics", kind = "framework")]
        unsafe extern "C" {
            fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
        }
        // kCGEventSourceStateHIDSystemState, kCGAnyInputEventType.
        const HID_SYSTEM_STATE: i32 = 1;
        const ANY_INPUT: u32 = u32::MAX;
        // SAFETY: a plain C function of two integers, no pointers.
        let secs = unsafe { CGEventSourceSecondsSinceLastEventType(HID_SYSTEM_STATE, ANY_INPUT) };
        (secs.is_finite() && secs >= 0.0).then_some(secs)
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// The App Nap hold: an `NSProcessInfo` activity while a wake is armed.
mod nap {
    #[derive(Default)]
    pub struct Activity {
        #[cfg(target_os = "macos")]
        token: Option<objc2::rc::Retained<objc2::runtime::AnyObject>>,
    }

    // SAFETY: the token is an opaque NSObject that is only ever handed back
    // to `-[NSProcessInfo endActivity:]`, which is thread-safe.
    unsafe impl Send for Activity {}

    impl Activity {
        #[cfg(not(target_os = "macos"))]
        pub fn set(&mut self, _on: bool) {}

        #[cfg(target_os = "macos")]
        pub fn set(&mut self, on: bool) {
            use objc2::rc::{Retained, autoreleasepool};
            use objc2::runtime::AnyObject;
            use objc2::{class, msg_send};
            if on == self.token.is_some() {
                return;
            }
            // NSActivityUserInitiatedAllowingIdleSystemSleep: no App Nap,
            // no sudden or automatic termination; sleep is `caffeinate`'s.
            const OPTIONS: u64 = 0x00EF_FFFF;
            autoreleasepool(|_| {
                // SAFETY: public Foundation selectors on the shared
                // NSProcessInfo, with a live NSString; the token is retained
                // before the pool drains and released after `endActivity:`.
                unsafe {
                    let info: *mut AnyObject = msg_send![class!(NSProcessInfo), processInfo];
                    if info.is_null() {
                        return;
                    }
                    if on {
                        let reason: *mut AnyObject = msg_send![
                            class!(NSString),
                            stringWithUTF8String: c"A scheduled message is waiting for its time".as_ptr()
                        ];
                        let token: *mut AnyObject =
                            msg_send![info, beginActivityWithOptions: OPTIONS, reason: reason];
                        self.token = Retained::retain(token);
                    } else if let Some(token) = self.token.take() {
                        let _: () = msg_send![info, endActivity: &*token];
                    }
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wake_is_emitted_at_its_time_and_again_only_after_the_repeat() {
        let w = Wakes::default();
        w.arm("scheduled", Some(10_000));
        assert!(w.due(9_999).is_empty(), "not before its time");
        assert_eq!(w.due(10_000), vec!["scheduled".to_string()]);
        assert!(
            w.due(10_000 + 14_999).is_empty(),
            "not again within the repeat"
        );
        assert_eq!(w.due(10_000 + 15_000), vec!["scheduled".to_string()]);
    }

    #[test]
    fn arming_the_same_time_again_keeps_the_record_and_a_new_time_starts_over() {
        let w = Wakes::default();
        w.arm("scheduled", Some(10_000));
        assert_eq!(w.due(10_000).len(), 1);
        w.arm("scheduled", Some(10_000));
        assert!(w.due(11_000).is_empty(), "re-armed unchanged: no burst");
        w.arm("scheduled", Some(10_500));
        assert_eq!(
            w.due(11_000).len(),
            1,
            "a new time is emitted at once when past"
        );
        w.arm("scheduled", None);
        assert!(w.due(99_000).is_empty(), "cleared");
    }

    #[test]
    fn a_mac_that_slept_through_the_time_emits_at_the_first_poll_after() {
        let w = Wakes::default();
        w.arm("limit", Some(10_000));
        w.arm("scheduled", Some(20_000));
        // The wall clock jumped an hour while the task was frozen.
        assert_eq!(
            w.due(3_600_000),
            vec!["limit".to_string(), "scheduled".to_string()]
        );
    }

    #[test]
    fn pending_says_armed_and_due_soon() {
        let w = Wakes::default();
        assert_eq!(w.pending(0), (false, false));
        let within = AWAKE_WITHIN.as_millis() as u64;
        w.arm("scheduled", Some(within + 10_000));
        assert_eq!(
            w.pending(0),
            (true, false),
            "a week away holds nothing awake"
        );
        assert_eq!(w.pending(10_000), (true, true));
        assert_eq!(w.pending(within * 3), (true, true), "past and still armed");
    }

    #[test]
    fn the_log_line_is_flat_and_appended() {
        let dir = std::env::temp_dir().join(format!("nl-wake-{}", std::process::id()));
        let path = dir.join("logs").join("schedule.log");
        log_to(&path, "page", "tick\nsent 4f2");
        log_to(&path, "rust", "wake-due scheduled");
        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].ends_with(" page tick sent 4f2"));
        assert!(lines[1].ends_with(" rust wake-due scheduled"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
