//! Quitting while work runs asks first (nightshift backlog 308).
//!
//! The window keeps one list of everything running in every project — turns,
//! subagents, asides, councils, the dream and capture (`running.ts`, backlog
//! 309) — and pushes the part a quit would stop here, as lines
//! (`project · chat · what`), whenever it changes. Every way of quitting
//! reads it:
//!
//! - **⌘Q, the app menu's Quit, the Dock's Quit, a logout**: AppKit's
//!   `terminate:`, which asks the app delegate's `applicationShouldTerminate:`
//!   first. tao's delegate does not implement it, so [`install`] adds it to the
//!   delegate's class at start-up.
//! - **The window's close button**: `WindowEvent::CloseRequested` on `main`
//!   (`main.rs`'s run loop calls [`close_requested`]).
//!
//! With nothing on the list, both go ahead at once, exactly as before. With
//! something on it, the quit is cancelled and the window gets
//! `quit-requested` with the lines; its dialog's *Quit anyway* calls
//! [`quit_now`], which marks the quit confirmed and sends `terminate:` again —
//! the same path ⌘Q always took, so `RunEvent::Exit` (the away push) runs as
//! before. *Cancel* does nothing: the app and every run go on.
//!
//! A window that never answers must not trap him in the app: a second quit
//! more than [`ANSWER_WITHIN`] after an ask the window never acknowledged
//! ([`quit_dialog_shown`]) goes ahead.
//!
//! `bin/release-roll.sh` (nightshift-code) sends no signal: it polls `pgrep`
//! for the installed app every 30 s and installs once the process is gone, so
//! it never meets the dialog, and a confirmed quit ends the process as ⌘Q did.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

/// How long the window has to acknowledge an ask before a second quit
/// stops waiting for it.
pub const ANSWER_WITHIN: Duration = Duration::from_secs(3);

#[derive(Default)]
struct Guard {
    /// What a quit would stop, one line each; empty when nothing runs.
    lines: Vec<String>,
    /// *Quit anyway* was pressed: the next quit goes ahead.
    confirmed: bool,
    /// The last ask, and whether the window acknowledged it.
    asked: Option<(Instant, bool)>,
}

static GUARD: Mutex<Option<Guard>> = Mutex::new(None);
static APP: Mutex<Option<AppHandle>> = Mutex::new(None);

fn with<T>(f: impl FnOnce(&mut Guard) -> T) -> T {
    let mut g = GUARD.lock().unwrap_or_else(|e| e.into_inner());
    f(g.get_or_insert_with(Guard::default))
}

/// What a quit request does now.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// Nothing runs, the quit was confirmed, or the window is not answering.
    Quit,
    /// Cancel it and ask the window, with these lines.
    Ask(Vec<String>),
}

/// The rule, apart from the clock and the statics (unit-tested below).
pub fn decide(
    lines: &[String],
    confirmed: bool,
    asked: Option<(Instant, bool)>,
    now: Instant,
) -> Decision {
    if confirmed || lines.is_empty() {
        return Decision::Quit;
    }
    if let Some((at, false)) = asked
        && now.duration_since(at) > ANSWER_WITHIN
    {
        return Decision::Quit;
    }
    Decision::Ask(lines.to_vec())
}

/// The ask to record: a repeat of an ask the window has not acknowledged
/// keeps the first one's clock, so pressing ⌘Q again and again on a hung
/// window still lets a quit through once [`ANSWER_WITHIN`] has passed.
pub fn asked_at(asked: Option<(Instant, bool)>, now: Instant) -> (Instant, bool) {
    match asked {
        Some((at, false)) => (at, false),
        _ => (now, false),
    }
}

/// A quit was asked for: decide, and on an ask record it and tell the window.
/// `true` when the quit may go ahead.
fn request(app: Option<&AppHandle>) -> bool {
    let now = Instant::now();
    let d = with(|g| {
        let d = decide(&g.lines, g.confirmed, g.asked, now);
        if matches!(d, Decision::Ask(_)) {
            g.asked = Some(asked_at(g.asked, now));
        }
        d
    });
    match d {
        Decision::Quit => true,
        Decision::Ask(lines) => {
            let handle = app
                .cloned()
                .or_else(|| APP.lock().unwrap_or_else(|e| e.into_inner()).clone());
            match handle {
                Some(h) => {
                    let _ = h.emit("quit-requested", lines);
                    false
                }
                // Nobody to ask: never trap him.
                None => true,
            }
        }
    }
}

/// The window's close button (`main.rs`'s run loop): `true` lets it close.
pub fn close_requested(app: &AppHandle) -> bool {
    request(Some(app))
}

/// The window's list of what a quit would stop, pushed on every change.
#[tauri::command]
pub fn set_running_work(lines: Vec<String>) {
    with(|g| g.lines = lines);
}

/// The window put the dialog up: a second quit waits for its answer.
#[tauri::command]
pub fn quit_dialog_shown() {
    with(|g| {
        if let Some((_, acked)) = g.asked.as_mut() {
            *acked = true;
        }
    });
}

/// *Quit anyway*: confirmed, then the same `terminate:` ⌘Q sends.
#[tauri::command]
pub fn quit_now(app: AppHandle) {
    with(|g| g.confirmed = true);
    #[cfg(target_os = "macos")]
    {
        let sent = app.run_on_main_thread(|| {
            use objc2::runtime::AnyObject;
            use objc2::{class, msg_send};
            let none: *mut AnyObject = std::ptr::null_mut();
            // SAFETY: main thread; `terminate:` is what the Quit menu item
            // sends, and with `confirmed` set the delegate answers "now".
            unsafe {
                let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
                let _: () = msg_send![ns_app, terminate: none];
            }
        });
        if sent.is_err() {
            app.exit(0);
        }
    }
    #[cfg(not(target_os = "macos"))]
    app.exit(0);
}

/// Add `applicationShouldTerminate:` to the app delegate's class (macOS),
/// and keep the handle the ask is emitted through. Called from `setup`, on
/// the main thread, after tao has set its delegate.
pub fn install(app: &AppHandle) {
    *APP.lock().unwrap_or_else(|e| e.into_inner()) = Some(app.clone());
    #[cfg(target_os = "macos")]
    mac::install();
}

#[cfg(target_os = "macos")]
mod mac {
    use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
    use objc2::{class, msg_send, sel};

    /// `NSTerminateCancel` / `NSTerminateNow`.
    const CANCEL: usize = 0;
    const NOW: usize = 1;

    extern "C-unwind" fn should_terminate(
        _this: *mut AnyObject,
        _sel: Sel,
        _app: *mut AnyObject,
    ) -> usize {
        if super::request(None) { NOW } else { CANCEL }
    }

    pub fn install() {
        // SAFETY: main thread (setup). The method is added to the delegate
        // object's own class with the AppKit signature
        // `- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)`
        // — NSUInteger return ("Q"), self, _cmd, one object.
        unsafe {
            let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            let delegate: *mut AnyObject = msg_send![ns_app, delegate];
            if delegate.is_null() {
                eprintln!("quit guard: no app delegate; quitting will not ask");
                return;
            }
            let cls = objc2::ffi::object_getClass(delegate) as *mut AnyClass;
            let imp: Imp = std::mem::transmute::<
                extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize,
                Imp,
            >(should_terminate);
            let added = objc2::ffi::class_addMethod(
                cls,
                sel!(applicationShouldTerminate:),
                imp,
                c"Q@:@".as_ptr(),
            );
            if !added.as_bool() {
                eprintln!(
                    "quit guard: the delegate already answers applicationShouldTerminate:; left as is"
                );
                return;
            }
            // AppKit may have cached what the delegate answers when it was
            // set; setting it again makes it look afresh.
            let _: () = msg_send![ns_app, setDelegate: delegate];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("P · chat {i} · turn")).collect()
    }

    #[test]
    fn nothing_running_quits_at_once() {
        assert_eq!(decide(&[], false, None, Instant::now()), Decision::Quit);
    }

    #[test]
    fn something_running_asks_with_its_lines() {
        let l = lines(2);
        assert_eq!(
            decide(&l, false, None, Instant::now()),
            Decision::Ask(l.clone())
        );
    }

    #[test]
    fn a_confirmed_quit_goes_ahead() {
        assert_eq!(
            decide(&lines(1), true, None, Instant::now()),
            Decision::Quit
        );
    }

    #[test]
    fn an_answered_ask_asks_again_however_long_ago() {
        let then = Instant::now();
        let later = then + Duration::from_secs(60);
        assert!(matches!(
            decide(&lines(1), false, Some((then, true)), later),
            Decision::Ask(_)
        ));
    }

    #[test]
    fn repeated_quits_on_a_silent_window_keep_the_first_clock() {
        let then = Instant::now();
        let soon = then + Duration::from_secs(2);
        let asked = asked_at(None, then);
        let asked = asked_at(Some(asked), soon);
        assert_eq!(asked, (then, false));
        assert_eq!(
            decide(&lines(1), false, Some(asked), then + Duration::from_secs(4)),
            Decision::Quit
        );
        // An acknowledged ask starts a fresh clock.
        assert_eq!(asked_at(Some((then, true)), soon), (soon, false));
    }

    #[test]
    fn a_window_that_never_answered_does_not_trap_the_quit() {
        let then = Instant::now();
        let soon = then + Duration::from_millis(500);
        let late = then + ANSWER_WITHIN + Duration::from_millis(1);
        assert!(matches!(
            decide(&lines(1), false, Some((then, false)), soon),
            Decision::Ask(_)
        ));
        assert_eq!(
            decide(&lines(1), false, Some((then, false)), late),
            Decision::Quit
        );
    }
}
