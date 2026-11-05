//! An exception AppKit throws while it dispatches an event no longer kills
//! the app (nightshift item 486, 2026-10-30).
//!
//! The crash at 11:27 AM on 2026-10-30: macOS's Writing Tools affordance
//! (`NSCampoLightweightUIController`, the button AppKit floats over selected
//! text) failed an internal assertion while handling a mouse-entered event.
//! An assertion raises an Objective-C exception. In a plain AppKit app,
//! `-[NSApplication run]` catches an exception raised in event handling,
//! logs it, and carries on. Here it had to unwind through tao's override of
//! `-[NSApplication sendEvent:]` (`tao::platform_impl::macos::app::send_event`),
//! which is an `extern "C"` Rust function, and Rust aborts the process when
//! any unwind reaches such a frame — the crash report's `send_event` →
//! `panic_cannot_unwind` → `abort`.
//!
//! So [`install`] replaces the `sendEvent:` of tao's `TaoApp` class with
//! [`guarded_send_event`], which does what tao's does — a ⌘-key-up goes
//! straight to the key window (tao's fix for AppKit never delivering it),
//! everything else to `NSApplication`'s own `sendEvent:` — inside
//! `objc2::exception::catch`, and a Rust `catch_unwind` around that. A caught
//! exception or panic is written to the panic log (`crate::panic_log`) and
//! the event is dropped, which is what AppKit itself does with one.
//!
//! What tao's version did that this one does not: queue raw mouse-motion and
//! button "device events" for the event-loop callback. Tauri never reads
//! them (tauri-runtime-wry 2.11.4 has no `Event::DeviceEvent` arm), so
//! nothing in the app changes.

use std::panic::AssertUnwindSafe;

use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{class, msg_send, sel};

/// `NSEventTypeKeyUp`.
const NS_EVENT_TYPE_KEY_UP: usize = 11;
/// `NSEventModifierFlagCommand`.
const NS_EVENT_MODIFIER_FLAG_COMMAND: usize = 1 << 20;

/// Swap the guard in. Call on the main thread once tauri has built the app
/// (its `setup` hook). Returns what it did, for the startup log line.
pub fn install() -> &'static str {
    let Some(tao_app) = AnyClass::get(c"TaoApp") else {
        return "no TaoApp class; sendEvent: left as tao's";
    };
    // Only when the running application really is a TaoApp — a later tao
    // that named or built it differently must not be patched blind.
    let shared_is_tao: bool = unsafe {
        let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
        !app.is_null() && msg_send![app, isKindOfClass: tao_app]
    };
    if !shared_is_tao {
        return "NSApp is not a TaoApp; sendEvent: left as tao's";
    }
    unsafe {
        let imp: Imp = std::mem::transmute::<
            unsafe extern "C" fn(&AnyObject, Sel, *mut AnyObject),
            Imp,
        >(guarded_send_event);
        objc2::ffi::class_replaceMethod(
            tao_app as *const AnyClass as *mut AnyClass,
            sel!(sendEvent:),
            imp,
            c"v@:@".as_ptr(),
        );
    }
    "sendEvent: guarded"
}

/// The replacement `-[TaoApp sendEvent:]`. Never unwinds.
unsafe extern "C" fn guarded_send_event(this: &AnyObject, _sel: Sel, event: *mut AnyObject) {
    if let Some(what) = guarded(|| unsafe { dispatch(this, event) }) {
        crate::panic_log::note(
            "objc-exception",
            &format!(
                "{what}\n(caught in -[NSApplication sendEvent:]; the event was dropped and the app kept running)"
            ),
            "event_guard::guarded_send_event",
        );
    }
}

/// tao's `send_event`, less the device events (see the module note).
unsafe fn dispatch(this: &AnyObject, event: *mut AnyObject) {
    unsafe {
        let ty: usize = msg_send![event, type];
        let flags: usize = msg_send![event, modifierFlags];
        if ty == NS_EVENT_TYPE_KEY_UP && flags & NS_EVENT_MODIFIER_FLAG_COMMAND != 0 {
            let key_window: *mut AnyObject = msg_send![this, keyWindow];
            if !key_window.is_null() {
                let _: () = msg_send![key_window, sendEvent: event];
            }
        } else {
            let _: () = msg_send![super(this, class!(NSApplication)), sendEvent: event];
        }
    }
}

/// Run `f`; an Objective-C exception it raises comes back as its
/// description, a Rust panic as `"rust panic"` (the panic hook has already
/// logged the panic itself). `None` when `f` returned.
fn guarded(f: impl FnOnce()) -> Option<String> {
    let outcome = std::panic::catch_unwind(AssertUnwindSafe(|| {
        objc2::exception::catch(AssertUnwindSafe(f))
    }));
    match outcome {
        Ok(Ok(())) => None,
        Ok(Err(Some(exception))) => Some(format!("{exception:?}")),
        Ok(Err(None)) => Some("a nil Objective-C exception".to_string()),
        Err(_) => Some("rust panic".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `[[NSArray array] objectAtIndex:5]`: AppKit-style, raises
    /// `NSRangeException` the way an `NSAssert` raises
    /// `NSInternalInconsistencyException`.
    fn raise_range_exception() {
        unsafe {
            let empty: *mut AnyObject = msg_send![class!(NSArray), array];
            let _: *mut AnyObject = msg_send![empty, objectAtIndex: 5usize];
        }
    }

    #[test]
    fn an_objc_exception_is_caught_and_described() {
        let caught = guarded(raise_range_exception).expect("caught");
        assert!(caught.contains("NSRangeException"), "{caught}");
    }

    #[test]
    fn a_rust_panic_is_caught_too() {
        // The panic prints through the default hook; swapping the global
        // hook here would race the other tests.
        let caught = guarded(|| panic!("boom"));
        assert_eq!(caught.as_deref(), Some("rust panic"));
    }

    #[test]
    fn nothing_is_reported_when_dispatch_returns() {
        assert_eq!(guarded(|| {}), None);
    }

    // The crash itself, reproduced in a child process: an exception raised
    // under an `extern "C"` frame (tao's `send_event`) aborts the process;
    // the same exception under the guard does not. The two `child_*` tests
    // are run only by this one (they are `#[ignore]`d so a plain test run
    // never aborts).

    extern "C" fn like_taos_send_event() {
        raise_range_exception();
    }

    extern "C" fn like_the_guarded_send_event() {
        let _ = guarded(raise_range_exception);
    }

    #[test]
    #[ignore = "run by the_crash_reproduces_unguarded_and_not_guarded"]
    fn child_unguarded() {
        like_taos_send_event();
    }

    #[test]
    #[ignore = "run by the_crash_reproduces_unguarded_and_not_guarded"]
    fn child_guarded() {
        like_the_guarded_send_event();
    }

    fn run_child(name: &str) -> std::process::ExitStatus {
        std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                &format!("event_guard::tests::{name}"),
                "--test-threads=1",
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap()
    }

    #[test]
    fn the_crash_reproduces_unguarded_and_not_guarded() {
        use std::os::unix::process::ExitStatusExt;
        let unguarded = run_child("child_unguarded");
        assert_eq!(unguarded.signal(), Some(6), "unguarded: {unguarded:?}"); // SIGABRT
        let guarded = run_child("child_guarded");
        assert!(guarded.success(), "guarded: {guarded:?}");
    }
}
