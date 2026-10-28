//! A debug build's off-screen window, for live tests that must not take
//! his screen (nightshift backlog 339, 2026-10-11). With
//! `NIGHTLOOM_OFFSCREEN=1` on a **debug** build only, the main window is
//! built hidden, made borderless (a titled window is pulled back on screen
//! when ordered front), moved to (-20000, -20000), and its `WKWebView`'s
//! window-occlusion detection is switched off — WebKit's private
//! `_setWindowOcclusionDetectionEnabled:`, the switch W6-B's
//! `wkmeasure.swift` used — so the page runs and paints at full speed
//! although no one can see it (a hidden dev window otherwise crawls:
//! W5-C measured `providers` at +420 s). ~~Screenshots by window id and the
//! accessibility tree still reach it.~~ (struck 2026-10-28, item 448: the
//! 429 run measured `screencapture -l <id>` failing on this window — "could
//! not create image from window" — since it sits on no display; only the
//! accessibility tree still reaches it.)
//!
//! **Shots of the off-screen window (item 448).** The page itself is
//! captured instead, by `WKWebView`'s `takeSnapshotWithConfiguration:`,
//! which renders from the web process and needs no display: a harness
//! writes one line, the absolute path of the PNG it wants, to
//! [`capture_request_path`] (`<config dir>/run/offscreen-capture`); within
//! ~0.3 s the request file is removed, and the PNG is written there
//! (atomically, so its appearance means it is whole). A release build
//! never runs any of this.

use std::path::{Path, PathBuf};
use std::time::Duration;

/// Whether this run asked for it.
pub fn on() -> bool {
    cfg!(debug_assertions) && std::env::var("NIGHTLOOM_OFFSCREEN").as_deref() == Ok("1")
}

/// The file a harness writes to ask for a shot of the page: its one line
/// is the absolute path the PNG goes to (item 448).
pub fn capture_request_path() -> Option<PathBuf> {
    nightloom_service::project::config_dir().map(|c| c.join("run").join("offscreen-capture"))
}

/// The PNG path a request names: one trimmed line, absolute, ending in
/// `.png`; anything else is refused with why.
pub fn capture_target(request: &str) -> Result<PathBuf, String> {
    let line = request.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        return Err("the request names no file".into());
    }
    let path = Path::new(line);
    if !path.is_absolute() {
        return Err(format!("{line} is not an absolute path"));
    }
    if path.extension().and_then(|e| e.to_str()) != Some("png") {
        return Err(format!("{line} does not end in .png"));
    }
    Ok(path.to_path_buf())
}

/// Watch for capture requests while the off-screen window lives.
fn spawn_capture_watch<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    use tauri::Manager;
    let Some(req) = capture_request_path() else {
        return;
    };
    let _ = std::fs::remove_file(&req);
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(300));
            let Ok(text) = std::fs::read_to_string(&req) else {
                continue;
            };
            let _ = std::fs::remove_file(&req);
            let out = match capture_target(&text) {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("[offscreen] capture refused: {e}");
                    continue;
                }
            };
            let Some(view) = app.get_webview("main") else {
                continue;
            };
            let _ = view.with_webview(move |native| {
                #[cfg(target_os = "macos")]
                // SAFETY: as `apply`'s: the main thread, the live WKWebView.
                unsafe {
                    macos::snapshot(native.inner().cast(), &out);
                }
                #[cfg(not(target_os = "macos"))]
                let _ = (native, out);
            });
        }
    });
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
    spawn_capture_watch(app.clone());
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::encode::{Encode, Encoding};
    use objc2::runtime::{AnyClass, AnyObject};
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

    /// The page as WebKit renders it, written as a PNG to `out` (item 448).
    pub unsafe fn snapshot(wk: *mut AnyObject, out: &std::path::Path) {
        if wk.is_null() {
            return;
        }
        let Ok(c_out) = std::ffi::CString::new(out.to_string_lossy().into_owned()) else {
            return;
        };
        let shown = out.display().to_string();
        let done = block2::RcBlock::new(move |img: *mut AnyObject, _err: *mut AnyObject| {
            if img.is_null() {
                eprintln!("[offscreen] capture failed: WebKit returned no image for {shown}");
                return;
            }
            // SAFETY: WebKit calls this on the main thread with a live
            // NSImage; every message below is public AppKit/Foundation.
            unsafe {
                let img: &AnyObject = &*img;
                let tiff: *mut AnyObject = msg_send![img, TIFFRepresentation];
                let (Some(rep_cls), Some(dict_cls), Some(str_cls)) = (
                    AnyClass::get(c"NSBitmapImageRep"),
                    AnyClass::get(c"NSDictionary"),
                    AnyClass::get(c"NSString"),
                ) else {
                    return;
                };
                if tiff.is_null() {
                    eprintln!("[offscreen] capture failed: no TIFF for {shown}");
                    return;
                }
                let rep: *mut AnyObject = msg_send![rep_cls, imageRepWithData: tiff];
                if rep.is_null() {
                    eprintln!("[offscreen] capture failed: no bitmap for {shown}");
                    return;
                }
                let props: *mut AnyObject = msg_send![dict_cls, dictionary];
                // NSBitmapImageFileTypePNG = 4.
                let png: *mut AnyObject =
                    msg_send![&*rep, representationUsingType: 4usize, properties: props];
                if png.is_null() {
                    eprintln!("[offscreen] capture failed: no PNG for {shown}");
                    return;
                }
                let path: *mut AnyObject = msg_send![str_cls, stringWithUTF8String: c_out.as_ptr()];
                let ok: bool = msg_send![&*png, writeToFile: path, atomically: true];
                eprintln!(
                    "[offscreen] capture {} {shown}",
                    if ok { "wrote" } else { "could not write" }
                );
            }
        });
        // SAFETY: the caller's; WebKit copies the block before returning.
        unsafe {
            let wkr: &AnyObject = &*wk;
            let _: () = msg_send![
                wkr,
                takeSnapshotWithConfiguration: std::ptr::null_mut::<AnyObject>(),
                completionHandler: &*done
            ];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_capture_request_names_one_absolute_png() {
        assert_eq!(
            capture_target("/tmp/shots/a.png\n"),
            Ok(PathBuf::from("/tmp/shots/a.png"))
        );
        assert!(capture_target("").is_err());
        assert!(capture_target("shots/a.png").is_err());
        assert!(capture_target("/tmp/a.jpg").is_err());
    }
}
