//! The cursor the page asks for is the one on screen (nightshift item 828).
//!
//! His report: the mouse cursor is the arrow over the composer's text and
//! while he highlights text in the chat history, where it should be the
//! I-beam. The page's CSS asks for the I-beam there (measured, item 828's
//! report); the cursor is AppKit's, and WebKit sets it only after checks of
//! its own (the window must be frontmost at the mouse, and since WebKit bug
//! 315425, fixed 2026-05 and so in macOS 27, the window's content view must
//! hit-test to the web view), and only when the cursor it wants changes. So
//! once the arrow is on screen by any other route, nothing puts the I-beam
//! back.
//!
//! `cursorKeep.ts` works out the cursor WebKit's rule gives at the mouse and
//! calls [`keep_cursor`] when that changes and once more when the mouse
//! rests. Here, on the main thread, with the app active, the window key and
//! the mouse inside the window's content: if AppKit's current cursor is not
//! that one, it is set, and one line goes to `<config dir>/logs/cursor.log`
//! (what was on screen, what the page wanted, which call) — at most one line
//! a second, with a count of the ones left out — so his Mac says how often
//! the repair fires. Only the three standard cursors are kept.

use std::sync::Mutex;
use std::time::Instant;

use tauri::{AppHandle, Runtime};

/// The cursors kept: the page's names for them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    IBeam,
    Hand,
    Arrow,
}

impl Kind {
    /// The page's name, or `None` for anything else (refused).
    pub fn parse(s: &str) -> Option<Kind> {
        match s {
            "ibeam" => Some(Kind::IBeam),
            "hand" => Some(Kind::Hand),
            "arrow" => Some(Kind::Arrow),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Kind::IBeam => "ibeam",
            Kind::Hand => "hand",
            Kind::Arrow => "arrow",
        }
    }
}

/// The log's rate: at most one line per this long; the rest are counted.
const LOG_EVERY_MS: u128 = 1000;

/// When the last line went out, and how many corrections since.
struct LogGate {
    last: Option<Instant>,
    skipped: u64,
}

static GATE: Mutex<LogGate> = Mutex::new(LogGate {
    last: None,
    skipped: 0,
});

/// Whether a correction is logged now: the first, and then one a second.
/// Returns the corrections left out since the last line. Pure but for the gate.
fn gate(now: Instant, g: &mut LogGate) -> Option<u64> {
    match g.last {
        Some(t) if now.duration_since(t).as_millis() < LOG_EVERY_MS => {
            g.skipped += 1;
            None
        }
        _ => {
            g.last = Some(now);
            let n = g.skipped;
            g.skipped = 0;
            Some(n)
        }
    }
}

/// The page's call (`cursorKeep.ts`): `kind` is the cursor WebKit's rule
/// gives at the mouse, `trigger` `change` or `rest`. Fire-and-forget; off
/// macOS it does nothing.
#[tauri::command]
pub fn keep_cursor<R: Runtime>(
    app: AppHandle<R>,
    kind: String,
    trigger: String,
) -> Result<(), String> {
    let Some(kind) = Kind::parse(&kind) else {
        return Err(format!("not a kept cursor: {kind:.20}"));
    };
    let trigger: String = trigger.chars().take(12).collect();
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        let Some(window) = app.get_window("main") else {
            return Ok(());
        };
        let ns = window.ns_window().map_err(|e| e.to_string())? as usize;
        app.run_on_main_thread(move || {
            // SAFETY: on the main thread; `ns` is the main window's live
            // NSWindow (the window outlives the app's run loop turn).
            if let Some(was) = unsafe { macos::keep(ns as *mut objc2::runtime::AnyObject, kind) } {
                note(was, kind, &trigger);
            }
        })
        .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, kind, trigger);
    }
    Ok(())
}

/// One stamped line for a correction, through the gate.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn note(was: &'static str, kind: Kind, trigger: &str) {
    let skipped = match GATE.lock() {
        Ok(mut g) => gate(Instant::now(), &mut g),
        Err(_) => return,
    };
    let Some(skipped) = skipped else { return };
    let mut line = format!("{trigger} set {} (was {was})", kind.name());
    if skipped > 0 {
        line.push_str(&format!(" +{skipped} not logged"));
    }
    log(&line);
}

/// Append `line`, stamped, to `<config dir>/logs/cursor.log`. Best effort.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn log(line: &str) {
    use std::io::Write;
    let Some(dir) = nightloom_service::project::config_dir().map(|c| c.join("logs")) else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("cursor.log"))
    {
        let _ = writeln!(
            f,
            "{} {line}",
            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        );
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::Kind;
    use objc2::encode::{Encode, Encoding};
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::{class, msg_send};

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
    // SAFETY: CoreGraphics' layouts on 64-bit macOS (CGFloat is a double),
    // with the encodings AppKit's methods carry.
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

    /// The standard cursor for `kind` (a shared instance AppKit owns).
    ///
    /// # Safety
    /// Main thread.
    unsafe fn cursor(kind: Kind) -> *mut AnyObject {
        let c: &AnyClass = class!(NSCursor);
        unsafe {
            match kind {
                Kind::IBeam => msg_send![c, IBeamCursor],
                Kind::Hand => msg_send![c, pointingHandCursor],
                Kind::Arrow => msg_send![c, arrowCursor],
            }
        }
    }

    /// Set `kind` if the app is active, `ns` is key, the mouse is inside
    /// its content view, and AppKit's current cursor is another; `Some`
    /// with the name of the one replaced when it did.
    ///
    /// # Safety
    /// Main thread; `ns` is a live NSWindow or null.
    pub unsafe fn keep(ns: *mut AnyObject, kind: Kind) -> Option<&'static str> {
        if ns.is_null() {
            return None;
        }
        unsafe {
            let app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
            if app.is_null() {
                return None;
            }
            let active: Bool = msg_send![app, isActive];
            let key: Bool = msg_send![ns, isKeyWindow];
            if !active.as_bool() || !key.as_bool() {
                return None;
            }
            let content: *mut AnyObject = msg_send![ns, contentView];
            if content.is_null() {
                return None;
            }
            let screen: CGPoint = msg_send![class!(NSEvent), mouseLocation];
            let in_window: CGPoint = msg_send![ns, convertPointFromScreen: screen];
            let frame: CGRect = msg_send![content, frame];
            let inside = in_window.x >= frame.origin.x
                && in_window.y >= frame.origin.y
                && in_window.x < frame.origin.x + frame.size.width
                && in_window.y < frame.origin.y + frame.size.height;
            if !inside {
                return None;
            }
            let want = cursor(kind);
            let now: *mut AnyObject = msg_send![class!(NSCursor), currentCursor];
            if want.is_null() || now == want {
                return None;
            }
            let was = if now == cursor(Kind::IBeam) {
                "ibeam"
            } else if now == cursor(Kind::Hand) {
                "hand"
            } else if now == cursor(Kind::Arrow) {
                "arrow"
            } else if now.is_null() {
                "none"
            } else {
                "other"
            };
            let _: () = msg_send![want, set];
            Some(was)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn only_the_three_kept_cursors_are_taken() {
        assert_eq!(Kind::parse("ibeam"), Some(Kind::IBeam));
        assert_eq!(Kind::parse("hand"), Some(Kind::Hand));
        assert_eq!(Kind::parse("arrow"), Some(Kind::Arrow));
        assert_eq!(Kind::parse("grab"), None);
        assert_eq!(Kind::parse(""), None);
    }

    #[test]
    fn the_log_takes_one_line_a_second_and_counts_the_rest() {
        let mut g = LogGate {
            last: None,
            skipped: 0,
        };
        let t0 = Instant::now();
        assert_eq!(gate(t0, &mut g), Some(0));
        assert_eq!(gate(t0 + Duration::from_millis(200), &mut g), None);
        assert_eq!(gate(t0 + Duration::from_millis(900), &mut g), None);
        assert_eq!(gate(t0 + Duration::from_millis(1100), &mut g), Some(2));
    }
}
