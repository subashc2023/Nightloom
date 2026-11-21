//! The feedback box's commands (nightshift item 805). The work is
//! `nightloom_service::feedback`, which the chats' `send_feedback` tool and
//! the phone's `POST /api/feedback` share: his words become one backlog
//! item in Nightloom's own backlog (the Nightshift repo, always: item 816),
//! saved first under the config dir so nothing he sends is lost.

use nightloom_service::feedback::{self, FiledAs, Note, Sent};

use crate::blocking;

fn config() -> Result<std::path::PathBuf, String> {
    nightloom_service::project::config_dir()
        .ok_or_else(|| "no user config directory — feedback has nowhere to be saved".to_string())
}

/// Send what he typed in the box. `note.via` is set to `box` here.
#[tauri::command]
pub async fn feedback_send(note: Note) -> Result<Sent, String> {
    let config = config()?;
    blocking(move || {
        let mut note = note;
        note.via = "box".into();
        // No project picker any more (item 816); an old draft's pick is dropped.
        note.about = None;
        let targets = feedback::targets_in(&config);
        feedback::send(Some(&config), &targets, note)
    })
    .await
}

/// File what is waiting (at launch): the notes saved while a shift was
/// live or no project was registered. Returns what went in.
#[tauri::command]
pub async fn feedback_flush() -> Result<Vec<FiledAs>, String> {
    let config = config()?;
    blocking(move || {
        let targets = feedback::targets_in(&config);
        Ok::<_, String>(
            feedback::flush(&config, &targets)
                .into_iter()
                .map(|(_, f)| f)
                .collect(),
        )
    })
    .await
}

/// Item 815: a shot of the page he is on, for the box's "Attach a shot of
/// this page" — the calling webview's own render, by WebKit's
/// `takeSnapshotWithConfiguration:` (the path item 448's off-screen
/// capture uses). It draws from the web process: no screen capture, so no
/// Screen Recording permission and no system dialog, and nothing takes
/// focus. The box hides itself for the moment it is taken. A PNG, base64.
#[tauri::command]
pub async fn feedback_page_shot(webview: tauri::Webview) -> Result<String, String> {
    use base64::Engine as _;
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Vec<u8>, String>>();
    let tx = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
    webview
        .with_webview(move |native| {
            #[cfg(target_os = "macos")]
            // SAFETY: `with_webview` runs this on the main thread with the
            // live `WKWebView`.
            unsafe {
                shot::take(native.inner().cast(), tx);
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = native;
                if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
                    let _ = tx.send(Err("a page shot is taken only on the Mac".into()));
                }
            }
        })
        .map_err(|e| format!("could not reach the page: {e}"))?;
    let png = tokio::time::timeout(std::time::Duration::from_secs(10), rx)
        .await
        .map_err(|_| "the page shot took too long".to_string())?
        .map_err(|_| "the page shot was dropped".to_string())??;
    Ok(base64::engine::general_purpose::STANDARD.encode(png))
}

#[cfg(target_os = "macos")]
mod shot {
    use objc2::msg_send;
    use objc2::rc::{Retained, autoreleasepool};
    use objc2::runtime::{AnyClass, AnyObject};
    use std::sync::{Arc, Mutex};
    use tokio::sync::oneshot::Sender;

    type Reply = Arc<Mutex<Option<Sender<Result<Vec<u8>, String>>>>>;

    fn answer(tx: &Reply, r: Result<Vec<u8>, String>) {
        if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
            let _ = tx.send(r);
        }
    }

    /// WebKit's NSImage, handed to the thread that makes it a PNG. Nothing
    /// else holds it once the completion handler returns (WebKit is done
    /// with it), and NSImage may be used off the main thread by one thread
    /// at a time.
    struct Shot(Retained<AnyObject>);
    // SAFETY: see the type's comment — one owner, one thread at a time.
    unsafe impl Send for Shot {}

    impl Shot {
        /// Encode on the calling thread, in its own autorelease pool.
        fn png(self) -> Result<Vec<u8>, String> {
            autoreleasepool(|_| png_of(&self.0))
        }
    }

    /// The shot as PNG bytes. Heavy on a large window (a TIFF of the whole
    /// 2× page, read back, then a PNG): item 843 moved it off the main
    /// thread, where it stalled the window for each shot.
    fn png_of(img: &AnyObject) -> Result<Vec<u8>, String> {
        // SAFETY: every message below is public AppKit/Foundation, sent to
        // objects of the classes named.
        unsafe {
            let tiff: *mut AnyObject = msg_send![img, TIFFRepresentation];
            let (Some(rep_cls), Some(dict_cls)) = (
                AnyClass::get(c"NSBitmapImageRep"),
                AnyClass::get(c"NSDictionary"),
            ) else {
                return Err("AppKit is missing".into());
            };
            if tiff.is_null() {
                return Err("the shot had no image data".into());
            }
            let rep: *mut AnyObject = msg_send![rep_cls, imageRepWithData: tiff];
            if rep.is_null() {
                return Err("the shot had no bitmap".into());
            }
            let props: *mut AnyObject = msg_send![dict_cls, dictionary];
            // NSBitmapImageFileTypePNG = 4.
            let data: *mut AnyObject =
                msg_send![&*rep, representationUsingType: 4usize, properties: props];
            if data.is_null() {
                return Err("the shot could not be made a PNG".into());
            }
            let len: usize = msg_send![&*data, length];
            let ptr: *const u8 = msg_send![&*data, bytes];
            if ptr.is_null() || len == 0 {
                return Err("the shot was empty".into());
            }
            Ok(std::slice::from_raw_parts(ptr, len).to_vec())
        }
    }

    /// The page as WebKit renders it, as PNG bytes, to `tx`. WebKit draws
    /// it in the web process and calls back on the main thread; the
    /// callback only keeps the image and hands it to a worker thread, so
    /// the main thread is never held for the encode (item 843).
    pub unsafe fn take(wk: *mut AnyObject, tx: Reply) {
        if wk.is_null() {
            answer(&tx, Err("no page to take a shot of".into()));
            return;
        }
        let reply = tx.clone();
        let done = block2::RcBlock::new(move |img: *mut AnyObject, _err: *mut AnyObject| {
            // SAFETY: WebKit passes a live NSImage or nil.
            let Some(img) = (unsafe { Retained::retain(img) }) else {
                answer(&reply, Err("WebKit returned no image".into()));
                return;
            };
            let shot = Shot(img);
            let to = reply.clone();
            let spawned = std::thread::Builder::new()
                .name("page-shot".into())
                .spawn(move || answer(&to, shot.png()));
            if let Err(e) = spawned {
                answer(
                    &reply,
                    Err(format!("could not start the shot's encoder: {e}")),
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
