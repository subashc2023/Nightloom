//! A debug build's off-screen window, for live tests that must not take
//! his screen (nightshift backlog 339, 2026-10-11). With
//! `NIGHTLOOM_OFFSCREEN=1` on a **debug** build only, the main window is
//! built hidden, made borderless (a titled window is pulled back on screen
//! when ordered front), moved to (-20000, -20000), and its `WKWebView`'s
//! window-occlusion detection is switched off — WebKit's private
//! `_setWindowOcclusionDetectionEnabled:`, the switch W6-B's
//! `wkmeasure.swift` used — so the page runs and paints at full speed
//! although no one can see it (a hidden dev window otherwise crawls:
//! W5-C measured `providers` at +420 s). Screenshots by window id and the
//! accessibility tree still reach it. A release build never runs this.

/// Whether this run asked for it.
pub fn on() -> bool {
    cfg!(debug_assertions) && std::env::var("NIGHTLOOM_OFFSCREEN").as_deref() == Ok("1")
}

/// Move the built main window off screen and keep its page awake.
pub fn apply<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Manager;
    if !on() {
        return;
    }
    let Some(view) = app.get_webview("main") else {
        return;
    };
    let _ = view.with_webview(|native| {
        #[cfg(target_os = "macos")]
        // SAFETY: `with_webview` runs this on the main thread with the live
        // `WKWebView`; every selector below exists on it or its NSWindow
        // (the private one is checked with `respondsToSelector:` first).
        unsafe {
            macos::apply(native.inner().cast());
        }
        #[cfg(not(target_os = "macos"))]
        let _ = native;
    });
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::encode::{Encode, Encoding};
    use objc2::runtime::AnyObject;
    use objc2::{msg_send, sel};

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    // SAFETY: CoreGraphics' layout on 64-bit macOS (CGFloat is a double).
    unsafe impl Encode for CGPoint {
        const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }

    pub unsafe fn apply(wk: *mut AnyObject) {
        if wk.is_null() {
            return;
        }
        // SAFETY: the caller's.
        unsafe {
            let wkr: &AnyObject = &*wk;
            let private = sel!(_setWindowOcclusionDetectionEnabled:);
            let can: bool = msg_send![wkr, respondsToSelector: private];
            if can {
                let _: () = msg_send![wkr, _setWindowOcclusionDetectionEnabled: false];
            }
            let win: *mut AnyObject = msg_send![wkr, window];
            if win.is_null() {
                return;
            }
            let win: &AnyObject = &*win;
            // NSWindowStyleMaskBorderless = 0: not constrained to a screen.
            let _: () = msg_send![win, setStyleMask: 0usize];
            // CanJoinAllSpaces | Stationary: still drivable when he switches Spaces (blocker 1385).
            let _: () = msg_send![win, setCollectionBehavior: (1usize << 0) | (1usize << 4)];
            let _: () = msg_send![win, setFrameOrigin: CGPoint { x: -20000.0, y: -20000.0 }];
            let _: () = msg_send![win, orderFrontRegardless];
            eprintln!("[offscreen] window at (-20000, -20000); occlusion detection off: {can}");
        }
    }
}
