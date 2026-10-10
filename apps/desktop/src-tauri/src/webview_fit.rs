//! The page fills the window again after a wake (nightshift backlog 324,
//! 2026-10-08).
//!
//! His report: every time he opens the Mac with Nightloom full-screen, the
//! page is drawn in a box half the window's width and half its height in
//! the top-left corner, until he leaves and re-enters full screen
//! (`notes/runner-design/324-wake-small-window.webp` in nightshift-code).
//!
//! How the window is put together on macOS (wry 0.55,
//! `wkwebview/mod.rs`): the window's content view is wry's own parent view,
//! and the main `WKWebView` is a subview of it that follows it by
//! autoresizing (width and height sizable). Autoresizing only ever adds
//! the parent's change in size to the subview's frame, so once the two
//! disagree — for whatever reason the wake gives them — every later resize
//! keeps the disagreement, and nothing in Tauri or wry sets the main
//! webview's frame again (`set_bounds` is a no-op for it).
//!
//! So [`refit`] compares the webview's frame with its parent's bounds and,
//! when they differ, sets the one to the other; when they agree it does
//! nothing. It runs on the wake `power.rs` notices, on the main window's
//! Resized / ScaleFactorChanged / Focused(true), and — from the page,
//! `webviewFit.ts` — when the page becomes visible again (display off
//! without system sleep) and on the wake. The page's call also passes its
//! own `innerWidth`/`innerHeight`: if the native frame is right but the page
//! still lays out at another size (WebKit holding a stale size of its own),
//! the frame is nudged a point and back so WebKit takes the size again.
//!
//! Every refit or nudge that changed something appends one line to
//! `<config dir>/logs/webview-fit.log`, so the next wake on his Mac says
//! which of the two it was and which hook caught it.

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

/// A rectangle in the view's own coordinates (points).
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// How far apart two edges may be and still count as the same: half a
/// point, below anything that draws differently.
pub const FRAME_TOLERANCE: f64 = 0.5;

/// How far the page's `innerWidth`/`innerHeight` (whole CSS pixels, times
/// the page zoom) may sit from the frame before the page counts as laid out
/// at another size. Two points covers the rounding.
pub const PAGE_TOLERANCE: f64 = 2.0;

/// The webview's frame is not its parent's bounds — the stale frame this
/// item is about.
pub fn differs(frame: Rect, bounds: Rect) -> bool {
    (frame.x - bounds.x).abs() > FRAME_TOLERANCE
        || (frame.y - bounds.y).abs() > FRAME_TOLERANCE
        || (frame.w - bounds.w).abs() > FRAME_TOLERANCE
        || (frame.h - bounds.h).abs() > FRAME_TOLERANCE
}

/// The page lays out at a width other than its frame's: `inner_width` is
/// the page's `innerWidth` in CSS pixels, which the page zoom (`set_zoom`,
/// backlog 108) divides the frame by. A zoom that is not a usable number is
/// taken as 1. Width only: `innerHeight` sits below the frame's height by
/// the title bar's inset (32 points measured in a window, 390 against 358),
/// which full screen takes away, so the height cannot be compared.
pub fn page_lags(frame: Rect, zoom: f64, inner_width: f64) -> bool {
    let zoom = if zoom.is_finite() && zoom > 0.0 {
        zoom
    } else {
        1.0
    };
    (inner_width * zoom - frame.w).abs() > PAGE_TOLERANCE
}

/// What one refit found and did, for the page's call and the log.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    /// The webview's frame before anything was done.
    pub frame: Rect,
    /// Its parent's bounds — what the frame should be.
    pub bounds: Rect,
    pub zoom: f64,
    /// The frame was set to the bounds.
    pub refit: bool,
    /// The frame was right but the page was not; it was nudged.
    pub nudged: bool,
}

/// The main window's events that refit: a resize (live or full-screen), a
/// move to a screen of another scale, and the window coming forward.
pub fn trigger(event: &tauri::WindowEvent) -> Option<&'static str> {
    match event {
        tauri::WindowEvent::Resized(_) => Some("resized"),
        tauri::WindowEvent::ScaleFactorChanged { .. } => Some("scale-factor"),
        tauri::WindowEvent::Focused(true) => Some("focused"),
        _ => None,
    }
}

/// Refit the main webview, fire-and-forget: the work is queued for the main
/// thread (AppKit), and a refit that changed something is logged.
pub fn refit<R: Runtime>(app: &AppHandle<R>, trigger: &'static str) {
    let Some(view) = app.get_webview("main") else {
        return;
    };
    let _ = view.with_webview(move |native| {
        #[cfg(target_os = "macos")]
        {
            // SAFETY: `with_webview` runs this on the main thread with the
            // live `WKWebView` (see [`macos::fit`]).
            let out = unsafe { macos::fit(native.inner().cast(), None) };
            if let Some(out) = out {
                log_outcome(trigger, None, &out);
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (native, trigger);
    });
}

/// The page's refit (`webviewFit.ts`): on becoming visible and on the wake,
/// with its own `innerWidth`/`innerHeight` so a page laid out at a stale
/// size is caught as well as a stale frame. `None` off macOS.
#[tauri::command]
pub async fn refit_webview<R: Runtime>(
    app: AppHandle<R>,
    trigger: String,
    inner_width: f64,
    inner_height: f64,
) -> Result<Option<Outcome>, String> {
    let view = app
        .get_webview("main")
        .ok_or_else(|| "no main webview".to_string())?;
    let (tx, rx) = tokio::sync::oneshot::channel();
    view.with_webview(move |native| {
        #[cfg(target_os = "macos")]
        let out = {
            // SAFETY: as in [`refit`].
            unsafe { macos::fit(native.inner().cast(), Some((inner_width, inner_height))) }
        };
        #[cfg(not(target_os = "macos"))]
        let out: Option<Outcome> = {
            let _ = (native, inner_width, inner_height);
            None
        };
        let _ = tx.send(out);
    })
    .map_err(|e| e.to_string())?;
    let out = rx.await.map_err(|e| e.to_string())?;
    if let Some(o) = &out {
        log_outcome(&trigger, Some((inner_width, inner_height)), o);
    }
    Ok(out)
}

/// One line per refit or nudge (nothing for a refit that found all well):
/// `<UTC> <trigger> refit|nudged frame=… bounds=… zoom=… [inner=W×H]`.
fn log_outcome(trigger: &str, inner: Option<(f64, f64)>, o: &Outcome) {
    if !(o.refit || o.nudged || harness_on()) {
        return;
    }
    let what = if o.refit {
        "refit"
    } else if o.nudged {
        "nudged"
    } else {
        "equal"
    };
    let mut line = format!(
        "{trigger} {what} frame={} bounds={} zoom={}",
        show(o.frame),
        show(o.bounds),
        o.zoom
    );
    if let Some((w, h)) = inner {
        line.push_str(&format!(" inner={w}x{h}"));
    }
    log(&line);
}

fn show(r: Rect) -> String {
    format!("{},{} {}x{}", r.x, r.y, r.w, r.h)
}

/// Append `line`, stamped, to `<config dir>/logs/webview-fit.log`. Best
/// effort: a log that cannot be written changes nothing.
fn log(line: &str) {
    use std::io::Write;
    let Some(dir) = nightloom_service::project::config_dir().map(|c| c.join("logs")) else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("webview-fit.log"))
    {
        let _ = writeln!(
            f,
            "{} {line}",
            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        );
    }
}

/// The measurement harness for the item's bar, debug builds only and only
/// with `NIGHTLOOM_DEBUG_WEBVIEW_FIT=1`: shrink the webview's frame to the
/// top-left quarter the way his screenshot shows it, read the page's
/// `innerWidth`/`innerHeight`, fire one hook for real, and read them again.
/// Every step goes to the log above. A release build never runs it.
pub fn maybe_self_test<R: Runtime>(app: &AppHandle<R>) {
    if !harness_on() {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        use std::time::Duration;
        let pause = |ms| tokio::time::sleep(Duration::from_millis(ms));
        pause(6000).await;
        for step in ["control", "resized", "hidden-shown", "system-woke"] {
            // The window's size while the page still fills it: tao reads its
            // size from the view the webview sits in, so after the shrink it
            // would report the quarter.
            let size = app.get_window("main").and_then(|w| {
                let scale = w.scale_factor().ok()?;
                Some(w.inner_size().ok()?.to_logical::<f64>(scale))
            });
            shrink(&app);
            pause(800).await;
            measure(&app, &format!("{step} before"));
            pause(500).await;
            match step {
                // Nothing fired: the shrunk frame stays shrunk, which is the
                // bug — the window does not mend itself.
                "control" => {}
                // A real Resized from the window: 40 points wider, or back.
                "resized" => {
                    if let (Some(w), Some(s)) = (app.get_window("main"), size) {
                        let _ = w.set_size(tauri::LogicalSize::new(s.width + 40.0, s.height));
                    }
                }
                // The page hidden and shown: visibilitychange → visible,
                // and Focused(true) when it comes back.
                "hidden-shown" => {
                    if let Some(w) = app.get_window("main") {
                        let _ = w.hide();
                        pause(800).await;
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
                // The Rust half of the wake (a real sleep cannot be had
                // here): what `power::watch_wake` calls after its emit.
                _ => refit(&app, "system-woke"),
            }
            pause(1500).await;
            measure(&app, &format!("{step} after"));
            pause(500).await;
        }
        log("self-test done");
    });
}

/// The harness is on: a debug build with `NIGHTLOOM_DEBUG_WEBVIEW_FIT=1`.
/// It also logs the refits that found all well, so each hook shows up.
fn harness_on() -> bool {
    cfg!(debug_assertions) && std::env::var("NIGHTLOOM_DEBUG_WEBVIEW_FIT").as_deref() == Ok("1")
}

/// Set the main webview's frame to the top-left quarter of its parent.
fn shrink<R: Runtime>(app: &AppHandle<R>) {
    let Some(view) = app.get_webview("main") else {
        return;
    };
    let _ = view.with_webview(|native| {
        #[cfg(target_os = "macos")]
        // SAFETY: as in [`refit`].
        unsafe {
            macos::shrink(native.inner().cast())
        };
        #[cfg(not(target_os = "macos"))]
        let _ = native;
    });
}

/// Log the page's own size, `innerWidth`×`innerHeight`, under `tag`.
fn measure<R: Runtime>(app: &AppHandle<R>, tag: &str) {
    let Some(view) = app.get_webview("main") else {
        return;
    };
    let native_tag = tag.to_string();
    let _ = view.with_webview(move |native| {
        #[cfg(target_os = "macos")]
        // SAFETY: as in [`refit`].
        if let Some((f, b, z)) = unsafe { macos::read(native.inner().cast()) } {
            log(&format!(
                "native {native_tag} frame={} bounds={} zoom={z}",
                show(f),
                show(b)
            ));
            // SAFETY: as above.
            log(&format!("window {native_tag} {}", unsafe {
                macos::describe(native.inner().cast())
            }));
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (native, native_tag);
    });
    if let Some(w) = app.get_window("main")
        && let (Ok(size), Ok(scale)) = (w.inner_size(), w.scale_factor())
    {
        log(&format!(
            "window {tag} inner={}x{} physical scale={scale}",
            size.width, size.height
        ));
    }
    let tag = tag.to_string();
    let _ = view.eval_with_callback(
        "JSON.stringify([window.innerWidth, window.innerHeight, window.devicePixelRatio, document.visibilityState])",
        move |json| log(&format!("measure {tag} {json}")),
    );
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{Outcome, Rect, differs, page_lags};
    use objc2::encode::{Encode, Encoding};
    use objc2::runtime::AnyObject;
    use objc2::{msg_send, sel};

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGPoint {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGSize {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGRect {
        origin: CGPoint,
        size: CGSize,
    }
    // SAFETY: the layouts above are CoreGraphics' on 64-bit macOS (CGFloat
    // is a double), and the encodings are the ones AppKit's methods carry.
    unsafe impl Encode for CGPoint {
        const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
    }
    unsafe impl Encode for CGSize {
        const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
    }
    unsafe impl Encode for CGRect {
        const ENCODING: Encoding =
            Encoding::Struct("CGRect", &[CGPoint::ENCODING, CGSize::ENCODING]);
    }

    fn rect(r: CGRect) -> Rect {
        Rect {
            x: r.origin.x,
            y: r.origin.y,
            w: r.size.width,
            h: r.size.height,
        }
    }

    fn cg(r: Rect) -> CGRect {
        CGRect {
            origin: CGPoint { x: r.x, y: r.y },
            size: CGSize {
                width: r.w,
                height: r.h,
            },
        }
    }

    /// The webview's frame, its superview's bounds, its page zoom.
    ///
    /// # Safety
    /// Main thread; `view` is a live `WKWebView` or null.
    pub unsafe fn read(view: *mut AnyObject) -> Option<(Rect, Rect, f64)> {
        if view.is_null() {
            return None;
        }
        unsafe {
            let parent: *mut AnyObject = msg_send![view, superview];
            if parent.is_null() {
                return None;
            }
            let frame: CGRect = msg_send![view, frame];
            let bounds: CGRect = msg_send![parent, bounds];
            // `pageZoom` is macOS 11+; wry's `set_zoom` sets it.
            let has_zoom: bool = msg_send![view, respondsToSelector: sel!(pageZoom)];
            let zoom: f64 = if has_zoom {
                msg_send![view, pageZoom]
            } else {
                1.0
            };
            Some((rect(frame), rect(bounds), zoom))
        }
    }

    /// Compare and mend; see the module comment. `inner` is the page's size
    /// when the page asked.
    ///
    /// # Safety
    /// Main thread; `view` is a live `WKWebView` or null.
    pub unsafe fn fit(view: *mut AnyObject, inner: Option<(f64, f64)>) -> Option<Outcome> {
        let (frame, bounds, zoom) = unsafe { read(view)? };
        let mut out = Outcome {
            frame,
            bounds,
            zoom,
            ..Outcome::default()
        };
        if differs(frame, bounds) {
            unsafe {
                let _: () = msg_send![view, setFrame: cg(bounds)];
            }
            out.refit = true;
        } else if let Some((inner_width, _)) = inner
            && page_lags(frame, zoom, inner_width)
        {
            // The frame is right and the page is not: a point shorter and
            // back makes WebKit take the size again.
            let shorter = Rect {
                h: bounds.h - 1.0,
                ..bounds
            };
            unsafe {
                let _: () = msg_send![view, setFrame: cg(shorter)];
                let _: () = msg_send![view, setFrame: cg(bounds)];
            }
            out.nudged = true;
        }
        Some(out)
    }

    /// The debug harness's picture of the window around the webview: the
    /// window's frame, the content rect AppKit derives from it, the content
    /// view's frame and bounds, and whether the webview's parent is it.
    ///
    /// # Safety
    /// Main thread; `view` is a live `WKWebView` (checked by `read` first).
    pub unsafe fn describe(view: *mut AnyObject) -> String {
        unsafe {
            let win: *mut AnyObject = msg_send![view, window];
            if win.is_null() {
                return "no window".into();
            }
            let parent: *mut AnyObject = msg_send![view, superview];
            let content: *mut AnyObject = msg_send![win, contentView];
            let wf: CGRect = msg_send![win, frame];
            let cr: CGRect = msg_send![win, contentRectForFrameRect: wf];
            let cf: CGRect = msg_send![content, frame];
            let cb: CGRect = msg_send![content, bounds];
            let pf: CGRect = msg_send![parent, frame];
            let scale: f64 = msg_send![win, backingScaleFactor];
            format!(
                "nswindow={} contentRect={} contentView.frame={} contentView.bounds={} parent==contentView={} parent.frame={} backing={scale}",
                super::show(rect(wf)),
                super::show(rect(cr)),
                super::show(rect(cf)),
                super::show(rect(cb)),
                parent == content,
                super::show(rect(pf)),
            )
        }
    }

    /// The debug harness's shrink: the top-left quarter of the parent, as
    /// his screenshot shows it.
    ///
    /// # Safety
    /// Main thread; `view` is a live `WKWebView` or null.
    pub unsafe fn shrink(view: *mut AnyObject) {
        let Some((_, b, _)) = (unsafe { read(view) }) else {
            return;
        };
        unsafe {
            let parent: *mut AnyObject = msg_send![view, superview];
            let flipped: bool = msg_send![parent, isFlipped];
            let quarter = Rect {
                x: b.x,
                // Top-left: in AppKit's unflipped coordinates the top half
                // starts halfway up.
                y: if flipped { b.y } else { b.y + b.h / 2.0 },
                w: b.w / 2.0,
                h: b.h / 2.0,
            };
            let _: () = msg_send![view, setFrame: cg(quarter)];
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL: Rect = Rect {
        x: 0.0,
        y: 0.0,
        w: 1512.0,
        h: 982.0,
    };

    #[test]
    fn a_frame_equal_to_the_bounds_does_not_differ() {
        assert!(!differs(FULL, FULL));
        let within = Rect {
            w: FULL.w - 0.4,
            y: 0.3,
            ..FULL
        };
        assert!(!differs(within, FULL), "under half a point is the same");
    }

    #[test]
    fn the_top_left_quarter_of_his_screenshot_differs() {
        let quarter = Rect {
            x: 0.0,
            y: FULL.h / 2.0,
            w: FULL.w / 2.0,
            h: FULL.h / 2.0,
        };
        assert!(differs(quarter, FULL));
    }

    #[test]
    fn any_one_edge_off_by_more_than_half_a_point_differs() {
        for r in [
            Rect { x: 1.0, ..FULL },
            Rect { y: -1.0, ..FULL },
            Rect {
                w: FULL.w - 1.0,
                ..FULL
            },
            Rect {
                h: FULL.h + 0.6,
                ..FULL
            },
        ] {
            assert!(differs(r, FULL), "{r:?}");
        }
    }

    #[test]
    fn the_page_lags_only_past_its_zoomed_size() {
        assert!(!page_lags(FULL, 1.0, 1512.0));
        assert!(!page_lags(FULL, 1.0, 1511.0), "rounding");
        assert!(page_lags(FULL, 1.0, 756.0), "a stale page");
        // At 125 % the page is the frame divided by the zoom.
        assert!(!page_lags(FULL, 1.25, 1209.6));
        assert!(page_lags(FULL, 1.25, 1512.0));
        // A zoom that is no number is 1.
        assert!(!page_lags(FULL, f64::NAN, 1512.0));
        assert!(!page_lags(FULL, 0.0, 1512.0));
    }

    #[test]
    fn the_window_events_that_refit() {
        use tauri::{PhysicalPosition, PhysicalSize, WindowEvent};
        assert_eq!(
            trigger(&WindowEvent::Resized(PhysicalSize::new(1, 1))),
            Some("resized")
        );
        assert_eq!(trigger(&WindowEvent::Focused(true)), Some("focused"));
        assert_eq!(trigger(&WindowEvent::Focused(false)), None);
        assert_eq!(
            trigger(&WindowEvent::Moved(PhysicalPosition::new(0, 0))),
            None
        );
    }
}
