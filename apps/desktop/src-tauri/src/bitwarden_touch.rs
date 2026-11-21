//! Touch ID for Bitwarden, and the vault locked at sleep and screen lock
//! (nightshift item 826).
//!
//! [`TouchId`] is the service's [`Presence`]: LocalAuthentication's
//! `LAContext` with the *device owner* policy — Touch ID, and the login
//! password where there is no Touch ID or it fails. It is called only from
//! a press (Unlock with Touch ID, Pre-arm), on a blocking thread; its reply
//! comes on a system queue. Nothing calls it at launch or from a test.
//!
//! [`watch_lock`] forgets the open session the moment the Mac is about to
//! sleep, the screen locks, or the user session is switched away —
//! `NSWorkspaceWillSleepNotification`, `NSWorkspaceSessionDidResignActive
//! Notification` and the distributed `com.apple.screenIsLocked`. A
//! pre-arm's values are kept (his ask). `power::watch_wake` forgets it as
//! well, in case a sleep went by unnoticed.

use nightloom_service::bitwarden_unlock::{Presence, PresenceError};

/// LocalAuthentication's "device owner" policy: biometry, falling back to
/// the login password (`LAPolicyDeviceOwnerAuthentication` = 2).
#[cfg(target_os = "macos")]
const DEVICE_OWNER: isize = 2;

/// The longest the sheet may stay up before the press gives up.
#[cfg(target_os = "macos")]
const SHEET_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);

#[derive(Debug, Default, Clone, Copy)]
pub struct TouchId;

#[cfg(target_os = "macos")]
#[link(name = "LocalAuthentication", kind = "framework")]
unsafe extern "C" {}

#[cfg(target_os = "macos")]
fn ns_string(s: &str) -> *mut objc2::runtime::AnyObject {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    let c = std::ffi::CString::new(s.replace('\0', " ")).unwrap_or_default();
    let Some(cls) = AnyClass::get(c"NSString") else {
        return std::ptr::null_mut();
    };
    // SAFETY: a class method returning an autoreleased NSString; the
    // pointer is used at once, inside the caller's autorelease pool.
    unsafe {
        let p: *mut AnyObject = msg_send![cls, stringWithUTF8String: c.as_ptr()];
        p
    }
}

/// An `LAError` code in words (LAError.h).
#[cfg(target_os = "macos")]
fn la_error(code: isize) -> PresenceError {
    match code {
        -2 | -4 | -9 => PresenceError::Cancelled,
        -5 => PresenceError::Unavailable("no login password is set".into()),
        -8..=-6 => PresenceError::Unavailable("Touch ID is not available".into()),
        -1 => PresenceError::Failed("it could not confirm it was you".into()),
        c => PresenceError::Failed(format!("LocalAuthentication error {c}")),
    }
}

#[cfg(target_os = "macos")]
impl Presence for TouchId {
    fn confirm(&self, reason: &str) -> Result<(), PresenceError> {
        use block2::RcBlock;
        use objc2::msg_send;
        use objc2::runtime::{AnyClass, AnyObject, Bool};
        objc2::rc::autoreleasepool(|_| {
            let cls = AnyClass::get(c"LAContext").ok_or_else(|| {
                PresenceError::Unavailable("LocalAuthentication is missing".into())
            })?;
            // SAFETY: `new` returns a +1 LAContext, released below; the
            // selectors and argument types are LAContext's (LAContext.h).
            unsafe {
                let ctx: *mut AnyObject = msg_send![cls, new];
                if ctx.is_null() {
                    return Err(PresenceError::Unavailable("no LAContext".into()));
                }
                let mut err: *mut AnyObject = std::ptr::null_mut();
                let can: Bool = msg_send![ctx, canEvaluatePolicy: DEVICE_OWNER, error: &mut err];
                if !can.as_bool() {
                    let code: isize = if err.is_null() {
                        -6
                    } else {
                        msg_send![err, code]
                    };
                    let _: () = msg_send![ctx, release];
                    return Err(la_error(code));
                }
                let (tx, rx) = std::sync::mpsc::channel::<Result<(), PresenceError>>();
                let tx = std::sync::Mutex::new(Some(tx));
                let block = RcBlock::new(move |ok: Bool, error: *mut AnyObject| {
                    let answer = if ok.as_bool() {
                        Ok(())
                    } else {
                        let code: isize = if error.is_null() {
                            -1
                        } else {
                            msg_send![error, code]
                        };
                        Err(la_error(code))
                    };
                    if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
                        let _ = tx.send(answer);
                    }
                });
                let why = ns_string(reason);
                // LAContext raises an Objective-C exception on a nil or
                // empty reason, which would end the app.
                if why.is_null() || reason.trim().is_empty() {
                    let _: () = msg_send![ctx, release];
                    return Err(PresenceError::Unavailable("no reason to show".into()));
                }
                let _: () = msg_send![
                    ctx,
                    evaluatePolicy: DEVICE_OWNER,
                    localizedReason: why,
                    reply: &*block
                ];
                let answer = rx.recv_timeout(SHEET_TIMEOUT).unwrap_or_else(|_| {
                    let _: () = msg_send![ctx, invalidate];
                    Err(PresenceError::Cancelled)
                });
                let _: () = msg_send![ctx, release];
                answer
            }
        })
    }
}

#[cfg(not(target_os = "macos"))]
impl Presence for TouchId {
    fn confirm(&self, _reason: &str) -> Result<(), PresenceError> {
        Err(PresenceError::Unavailable(
            "Touch ID is a Mac feature".into(),
        ))
    }
}

/// Forget the open Bitwarden session at sleep, screen lock and a switched
/// user session (see the module note). Registered once, at setup.
#[cfg(target_os = "macos")]
pub fn watch_lock() {
    use block2::RcBlock;
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    let forget = || nightloom_service::bitwarden::Vault::global().on_screen_lock();
    // SAFETY: NSWorkspace's and NSDistributedNotificationCenter's documented
    // observer API; the blocks are copied by the centre and live as long as
    // the process (the observer tokens are kept on purpose: never removed).
    unsafe {
        let ws_cls = AnyClass::get(c"NSWorkspace");
        let dist_cls = AnyClass::get(c"NSDistributedNotificationCenter");
        let block = RcBlock::new(move |_n: *mut AnyObject| forget());
        let nil: *mut AnyObject = std::ptr::null_mut();
        if let Some(ws_cls) = ws_cls {
            let ws: *mut AnyObject = msg_send![ws_cls, sharedWorkspace];
            if !ws.is_null() {
                let center: *mut AnyObject = msg_send![ws, notificationCenter];
                for name in [
                    "NSWorkspaceWillSleepNotification",
                    "NSWorkspaceSessionDidResignActiveNotification",
                ] {
                    let n = ns_string(name);
                    let token: *mut AnyObject = msg_send![
                        center,
                        addObserverForName: n,
                        object: nil,
                        queue: nil,
                        usingBlock: &*block
                    ];
                    let _: *mut AnyObject = msg_send![token, retain];
                }
            }
        }
        if let Some(dist_cls) = dist_cls {
            let center: *mut AnyObject = msg_send![dist_cls, defaultCenter];
            if !center.is_null() {
                let n = ns_string("com.apple.screenIsLocked");
                let token: *mut AnyObject = msg_send![
                    center,
                    addObserverForName: n,
                    object: nil,
                    queue: nil,
                    usingBlock: &*block
                ];
                let _: *mut AnyObject = msg_send![token, retain];
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn watch_lock() {}

/// Review 2026-11-18: every Objective-C call above, checked against the
/// method signatures the runtime itself holds — no sheet, no Touch ID, no
/// Keychain. A release build does not check these at the call (objc2 only
/// does in debug), so a wrong type there would be a crash on the first
/// press; here it is a failed test.
#[cfg(all(test, target_os = "macos"))]
mod tests {
    use block2::Block;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::sel;
    use std::ffi::c_char;

    type Obj = *mut AnyObject;

    fn class(name: &std::ffi::CStr) -> &'static AnyClass {
        AnyClass::get(name).unwrap_or_else(|| panic!("{name:?} is not loaded"))
    }

    #[test]
    fn the_touch_id_calls_match_the_runtime_signatures() {
        // The framework is linked (the empty `extern` block) and loaded.
        let la = class(c"LAContext");
        la.verify_sel::<(isize, *mut Obj), Bool>(sel!(canEvaluatePolicy:error:))
            .unwrap();
        la.verify_sel::<(isize, Obj, &Block<dyn Fn(Bool, Obj)>), ()>(sel!(
            evaluatePolicy:localizedReason:reply:
        ))
        .unwrap();
        la.verify_sel::<(), ()>(sel!(invalidate)).unwrap();
        la.verify_sel::<(), ()>(sel!(release)).unwrap();
        la.metaclass().verify_sel::<(), Obj>(sel!(new)).unwrap();
        class(c"NSError")
            .verify_sel::<(), isize>(sel!(code))
            .unwrap();
        class(c"NSString")
            .metaclass()
            .verify_sel::<(*const c_char,), Obj>(sel!(stringWithUTF8String:))
            .unwrap();
    }

    #[test]
    fn the_lock_observer_calls_match_the_runtime_signatures() {
        let ws = class(c"NSWorkspace");
        ws.metaclass()
            .verify_sel::<(), Obj>(sel!(sharedWorkspace))
            .unwrap();
        ws.verify_sel::<(), Obj>(sel!(notificationCenter)).unwrap();
        let dist = class(c"NSDistributedNotificationCenter");
        dist.metaclass()
            .verify_sel::<(), Obj>(sel!(defaultCenter))
            .unwrap();
        for center in [class(c"NSNotificationCenter"), dist] {
            center
                .verify_sel::<(Obj, Obj, Obj, &Block<dyn Fn(Obj)>), Obj>(sel!(
                    addObserverForName:object:queue:usingBlock:
                ))
                .unwrap();
        }
        class(c"NSObject")
            .verify_sel::<(), Obj>(sel!(retain))
            .unwrap();
    }

    /// LAPolicyDeviceOwnerAuthentication is 2 (LAPublicDefines.h); 1 would
    /// be biometry only, with no login-password fallback.
    #[test]
    fn the_policy_is_device_owner() {
        assert_eq!(super::DEVICE_OWNER, 2);
    }
}
