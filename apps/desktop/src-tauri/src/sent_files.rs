//! A file a reply sent (nightshift backlog 343): the chip's Save and its
//! drag out of the window. Open and Reveal are the file cards' own
//! `open_file` and `reveal_file`.
//!
//! Both commands take the path the chip read out of the transcript and
//! serve only a copy in one of `send_file`'s stores
//! (`send_file::is_stored`): the page names the path, so the backend is
//! where "only what a reply sent" is enforced.

use std::path::PathBuf;

use nightloom_service::tools::send_file;
use tauri::AppHandle;

fn stored(path: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(path);
    if send_file::is_stored(&p) {
        Ok(p)
    } else {
        Err(format!(
            "{path} is not a file a reply sent, or it is no longer there"
        ))
    }
}

/// The chip's Save: the system's Save dialog, named after the file, and a
/// copy where he chose. `None` when he cancelled.
#[tauri::command]
pub async fn save_sent_file(app: AppHandle, path: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let src = stored(&path)?;
    let name = src
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".to_string());
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut builder = app
        .dialog()
        .file()
        .set_title("Save the file")
        .set_file_name(&name);
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        let downloads = home.join("Downloads");
        if downloads.is_dir() {
            builder = builder.set_directory(downloads);
        }
    }
    builder.save_file(move |picked| {
        let _ = tx.send(picked);
    });
    let Some(dest) = rx.await.ok().flatten().and_then(|p| p.into_path().ok()) else {
        return Ok(None);
    };
    let to = dest.clone();
    tokio::task::spawn_blocking(move || std::fs::copy(&src, &to))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("could not save to {}: {e}", dest.display()))?;
    Ok(Some(dest.to_string_lossy().into_owned()))
}

/// The chip's drag out: a native file drag of the copy, started from the
/// page's pointer move while the button is down, so it drops into the
/// Finder, Mail or any app as the file itself. macOS only; elsewhere the
/// chip's Save is the way out.
#[tauri::command]
pub fn drag_sent_file(webview: tauri::Webview, path: String) -> Result<(), String> {
    let src = stored(&path)?;
    #[cfg(target_os = "macos")]
    {
        let path = src.to_string_lossy().into_owned();
        webview
            .with_webview(move |native| {
                // SAFETY: `with_webview` runs this on the main thread with
                // the live `WKWebView`.
                unsafe { macos::begin(native.inner().cast(), &path) };
            })
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (webview, src);
        Err("dragging a file out works on macOS only; use Save".to_string())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::CString;
    use std::sync::OnceLock;

    use objc2::encode::{Encode, Encoding};
    use objc2::rc::{Allocated, Retained};
    use objc2::runtime::{AnyClass, AnyObject, AnyProtocol, ClassBuilder, Sel};
    use objc2::{class, msg_send, sel};

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
    // with the encodings AppKit's methods carry (as `webview_fit.rs`).
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

    /// `NSEventTypeLeftMouseDragged`.
    const LEFT_MOUSE_DRAGGED: usize = 6;
    /// `NSDragOperationCopy`.
    const DRAG_COPY: usize = 1;

    /// `- (NSDragOperation)draggingSession:sourceOperationMaskForDraggingContext:`
    /// — copy, inside the app and out of it.
    extern "C-unwind" fn operation_mask(
        _this: &AnyObject,
        _cmd: Sel,
        _session: *mut AnyObject,
        _context: isize,
    ) -> usize {
        DRAG_COPY
    }

    /// The drag source: one object of a class made once, kept for the
    /// life of the app (a session does not promise to retain its source).
    fn source() -> Option<*mut AnyObject> {
        static SOURCE: OnceLock<Option<usize>> = OnceLock::new();
        SOURCE
            .get_or_init(|| {
                let class = AnyClass::get(c"NightloomSentFileDragSource").or_else(|| {
                    let mut builder =
                        ClassBuilder::new(c"NightloomSentFileDragSource", class!(NSObject))?;
                    // SAFETY: the signature is AppKit's for the selector:
                    // NSUInteger return, self, _cmd, an object, an NSInteger.
                    unsafe {
                        builder.add_method(
                            sel!(draggingSession:sourceOperationMaskForDraggingContext:),
                            operation_mask as extern "C-unwind" fn(_, _, _, _) -> _,
                        );
                    }
                    if let Some(proto) = AnyProtocol::get(c"NSDraggingSource") {
                        builder.add_protocol(proto);
                    }
                    Some(builder.register())
                })?;
                // SAFETY: `new` on an NSObject subclass with no ivars.
                let obj: Retained<AnyObject> = unsafe { msg_send![class, new] };
                Some(Retained::into_raw(obj) as usize)
            })
            .map(|p| p as *mut AnyObject)
    }

    /// Begin a file drag of `path` from `view` at the pointer. Does nothing
    /// when the button is no longer down — the IPC arrived after a release.
    ///
    /// # Safety
    /// Main thread; `view` is a live `WKWebView` or null.
    pub unsafe fn begin(view: *mut AnyObject, path: &str) {
        if view.is_null() {
            return;
        }
        let Ok(cpath) = CString::new(path) else {
            return;
        };
        let Some(source) = source() else {
            eprintln!("drag out: could not make the drag source");
            return;
        };
        unsafe {
            let buttons: usize = msg_send![class!(NSEvent), pressedMouseButtons];
            if buttons & 1 == 0 {
                return;
            }
            let window: *mut AnyObject = msg_send![view, window];
            if window.is_null() {
                return;
            }
            // A mouse event made here rather than `currentEvent`: the IPC
            // runs from the event loop's wake-up, so the current event is
            // not the drag's, and AppKit takes the drag's origin from it.
            let at: CGPoint = msg_send![window, mouseLocationOutsideOfEventStream];
            let number: isize = msg_send![window, windowNumber];
            let info: *mut AnyObject = msg_send![class!(NSProcessInfo), processInfo];
            let uptime: f64 = msg_send![info, systemUptime];
            let none: *mut AnyObject = std::ptr::null_mut();
            let event: Option<Retained<AnyObject>> = msg_send![
                class!(NSEvent),
                mouseEventWithType: LEFT_MOUSE_DRAGGED,
                location: at,
                modifierFlags: 0usize,
                timestamp: uptime,
                windowNumber: number,
                context: none,
                eventNumber: 0isize,
                clickCount: 1isize,
                pressure: 1.0f32
            ];
            let Some(event) = event else {
                return;
            };
            let string: Option<Retained<AnyObject>> =
                msg_send![class!(NSString), stringWithUTF8String: cpath.as_ptr()];
            let Some(string) = string else {
                return;
            };
            let url: Option<Retained<AnyObject>> =
                msg_send![class!(NSURL), fileURLWithPath: &*string];
            let Some(url) = url else {
                return;
            };
            let alloc: Allocated<AnyObject> = msg_send![class!(NSDraggingItem), alloc];
            let item: Option<Retained<AnyObject>> =
                msg_send![alloc, initWithPasteboardWriter: &*url];
            let Some(item) = item else {
                return;
            };
            let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
            let icon: Option<Retained<AnyObject>> = msg_send![workspace, iconForFile: &*string];
            let local: CGPoint = msg_send![view, convertPoint: at, fromView: none];
            let frame = CGRect {
                origin: CGPoint {
                    x: local.x - 24.0,
                    y: local.y - 24.0,
                },
                size: CGSize {
                    width: 48.0,
                    height: 48.0,
                },
            };
            let contents: *mut AnyObject = icon
                .as_ref()
                .map_or(none, |i| Retained::as_ptr(i).cast_mut());
            let _: () = msg_send![&*item, setDraggingFrame: frame, contents: contents];
            let items: Option<Retained<AnyObject>> =
                msg_send![class!(NSArray), arrayWithObject: &*item];
            let Some(items) = items else {
                return;
            };
            let _session: *mut AnyObject = msg_send![
                view,
                beginDraggingSessionWithItems: &*items,
                event: &*event,
                source: source
            ];
        }
    }
}
