//! Web tabs (nightshift backlog 172): a link he clicks in a reply opens as
//! a page inside the pane, beside the chat, rather than in the browser or —
//! pass 0's bug — over the whole window.
//!
//! Each web tab is one **child webview** of the main window, labelled
//! `web-<tab id>`, placed over the pane's content rectangle by the frontend
//! (`WebView.svelte` measures it and calls [`web_bounds`]). The page is
//! somebody else's and may be hostile, so three walls stand between it and
//! the app:
//!
//! 1. **No command reaches it.** Tauri's own gate already refuses a remote
//!    origin any command no `remote` capability names (tauri 2.11.5,
//!    `Webview::on_message`), and ours names none. [`guard`] wraps the app's
//!    invoke handler as well, so a `web-` webview is refused whatever its
//!    origin — the wall that still stands if the page ever reached a local
//!    origin.
//! 2. **It cannot become local.** [`allowed_navigation`] keeps every
//!    navigation on http(s) (and the `about:`/`data:`/`blob:` frames pages
//!    use); `tauri://`, `ipc://`, `asset://`, `file://` and every custom
//!    scheme are refused, so the page cannot load Nightloom's own UI into
//!    itself and pick up a local origin.
//! 3. **It cannot open windows.** `window.open` and `target=_blank` are
//!    denied; the URL is handed to the frontend (`web-new-window`), which
//!    opens it as another web tab — the same thing as his click.
//!
//! 4. **It cannot reach the app's own origin.** Tauri counts a page as
//!    local — and gives it the window's capabilities and every app command
//!    — when its URL is the dev server's (`devUrl`, `http://localhost:1420`
//!    in a dev build) or a `*.localhost` host (the form the app's own
//!    protocols take on Windows). [`is_app_origin`] refuses both, and the
//!    capability file names the `main` webview rather than the window, so
//!    a page that got there anyway would hold no permission (pass 2,
//!    2026-09-25).
//!
//! Keys (pass 2): with a page holding the keyboard, the Edit menu's Undo,
//! Redo and Find would act on Nightloom, since menu items reach the main
//! page whatever has focus. [`menu_route`] finds the web tab that holds
//! the first responder and sends Undo and Redo to it as the standard
//! `undo:` / `redo:` actions, and Find to its bar (`web-find`), which finds
//! in the page with [`web_find`].
//!
//! Its storage is its own origin's, so the app's localStorage is out of
//! reach by the browser's own rule. Nothing a page says is an instruction:
//! the title and favicon it reports are shown as text and an image URL,
//! checked for scheme and length, and nothing else is read from it.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::Invoke;
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, EventTarget, LogicalPosition, LogicalSize, Manager, Runtime, Url,
    WebviewUrl,
};

/// Every web tab's webview label starts with this; nothing else's does.
pub const PREFIX: &str = "web-";

pub fn is_web_label(label: &str) -> bool {
    label.starts_with(PREFIX)
}

/// Where a web tab may navigate: the web, and the frame schemes pages
/// build themselves from. Everything else — the app's own `tauri://`, the
/// IPC scheme, files, custom app schemes — is refused.
pub fn allowed_navigation(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "about" | "data" | "blob")
}

/// Whether `url` is the app's own origin as tauri judges "local": the dev
/// server's origin (`dev`), or a `*.localhost` host — the app's custom
/// protocols on Windows (`http://tauri.localhost`). A page there would be
/// handed IPC, so a web tab never goes there. (`localhost` alone is the
/// dev server's only when `dev` says so; a page he opens on his own
/// machine's server stays allowed.)
pub fn is_app_origin(url: &Url, dev: Option<&Url>) -> bool {
    if let Some(host) = url.host_str()
        && host.to_ascii_lowercase().ends_with(".localhost")
    {
        return true;
    }
    dev.is_some_and(|d| d.origin() == url.origin())
}

/// What a web tab may be opened on: only http(s). mailto and the rest go
/// to the system through `open_url`, never here.
pub fn allowed_open(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

/// A favicon URL a page reported, kept only when it is plainly an http(s)
/// URL of sane length; anything else is dropped.
pub fn clean_favicon(raw: &str) -> Option<String> {
    // `eval_with_callback` hands back the JSON of the result: a quoted string.
    let s: String = serde_json::from_str(raw).ok()?;
    if s.is_empty() || s.len() > 2048 {
        return None;
    }
    let url = Url::parse(&s).ok()?;
    allowed_open(&url).then(|| url.to_string())
}

/// Refuse every app command from a `web-` webview, then hand the rest to
/// the app's own handler. Plugin commands never pass through here; the
/// capability gate and [`allowed_navigation`] keep those from a page.
pub fn guard<R: Runtime>(
    inner: impl Fn(Invoke<R>) -> bool + Send + Sync + 'static,
) -> impl Fn(Invoke<R>) -> bool + Send + Sync + 'static {
    move |invoke: Invoke<R>| {
        if is_web_label(invoke.message.webview_ref().label()) {
            invoke.resolver.reject("a web tab cannot call Nightloom");
            return true;
        }
        inner(invoke)
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct WebState {
    label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    loading: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    favicon: Option<String>,
}

impl WebState {
    fn new(label: &str) -> Self {
        WebState {
            label: label.to_string(),
            url: None,
            title: None,
            loading: None,
            favicon: None,
        }
    }
}

/// Events go to the main page only — never broadcast, so no web tab hears
/// another's address.
fn tell<R: Runtime, S: Serialize + Clone>(app: &AppHandle<R>, event: &str, payload: S) {
    let _ = app.emit_to(EventTarget::webview("main"), event, payload);
}

fn checked_label(label: &str) -> Result<(), String> {
    if !is_web_label(label)
        || label.len() > 64
        || !label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err(format!("not a web tab: {label}"));
    }
    Ok(())
}

fn web_view<R: Runtime>(app: &AppHandle<R>, label: &str) -> Result<tauri::Webview<R>, String> {
    checked_label(label)?;
    app.get_webview(label)
        .ok_or_else(|| format!("no web tab {label}"))
}

const FAVICON_JS: &str = "(function(){var l=document.querySelector('link[rel~=\"icon\"]');return l&&l.href?String(l.href):(location.origin+'/favicon.ico');})()";

/// Open `url` in the web tab `label` at the pane rectangle `x, y, w, h`
/// (logical points in the window). A label already open is moved there and
/// shown, where it was — its tab came back to the front, or a reload of the
/// main page found it still alive.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn web_open<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    url: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    vh: f64,
) -> Result<(), String> {
    checked_label(&label)?;
    let target = Url::parse(&url).map_err(|e| e.to_string())?;
    if !allowed_open(&target) {
        return Err(format!(
            "a web tab opens only http(s), not {}",
            target.scheme()
        ));
    }
    let dev = app.config().build.dev_url.clone();
    if is_app_origin(&target, dev.as_ref()) {
        return Err("a web tab cannot open Nightloom's own address".into());
    }
    if let Some(existing) = app.get_webview(&label) {
        // Never re-navigated: the page may have moved on (a link, a
        // `pushState`) since the tab last reported its address.
        place(&existing, x, y, w, h, vh)?;
        return existing.show().map_err(|e| e.to_string());
    }
    let window = app.get_window("main").ok_or("no main window")?;
    let (a1, a2, a3, a4) = (app.clone(), app.clone(), app.clone(), label.clone());
    let (l1, l2, l3) = (label.clone(), label.clone(), label.clone());
    let builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(target))
        .on_navigation(move |u| allowed_navigation(u) && !is_app_origin(u, dev.as_ref()))
        .on_new_window(move |u, _| {
            if allowed_open(&u) {
                tell(&a1, "web-new-window", (l1.clone(), u.to_string()));
            }
            NewWindowResponse::Deny
        })
        .on_document_title_changed(move |_, title| {
            let mut s = WebState::new(&l2);
            s.title = Some(title.chars().take(300).collect());
            tell(&a2, "web-state", s);
        })
        .on_page_load(move |view, payload| {
            let mut s = WebState::new(&l3);
            s.url = Some(payload.url().to_string());
            let finished = matches!(payload.event(), PageLoadEvent::Finished);
            s.loading = Some(!finished);
            tell(&a3, "web-state", s);
            if finished {
                let (app, label) = (a3.clone(), a4.clone());
                let _ = view.eval_with_callback(FAVICON_JS, move |raw| {
                    if let Some(icon) = clean_favicon(&raw) {
                        let mut s = WebState::new(&label);
                        s.favicon = Some(icon);
                        tell(&app, "web-state", s);
                    }
                });
            }
        });
    let top = y + chrome_height(&window, vh);
    let view = window
        .add_child(
            builder,
            LogicalPosition::new(x, top),
            LogicalSize::new(w.max(1.0), h.max(1.0)),
        )
        .map_err(|e| e.to_string())?;
    remember_native(&app, &view);
    Ok(())
}

/// The native view of each live web tab (macOS: its `WKWebView`), by
/// label — kept as an address and only ever compared, never followed, so
/// [`focused_label`] can tell which page holds the keyboard.
#[derive(Default)]
struct Natives(Mutex<HashMap<String, usize>>);

fn remember_native<R: Runtime>(app: &AppHandle<R>, view: &tauri::Webview<R>) {
    app.manage(Natives::default());
    let (app, label) = (app.clone(), view.label().to_string());
    let _ = view.with_webview(move |native| {
        #[cfg(target_os = "macos")]
        let address = native.inner() as usize;
        #[cfg(not(target_os = "macos"))]
        let address = {
            let _ = native;
            0usize
        };
        if let Some(n) = app.try_state::<Natives>()
            && let Ok(mut map) = n.0.lock()
        {
            map.insert(label, address);
        }
    });
}

fn forget_native<R: Runtime>(app: &AppHandle<R>, label: &str) {
    if let Some(n) = app.try_state::<Natives>()
        && let Ok(mut map) = n.0.lock()
    {
        map.remove(label);
    }
}

/// The web tab whose page holds the keyboard, if one does: the window's
/// first responder is that page's `WKWebView` or inside it. Main thread
/// only (AppKit); `None` off macOS.
fn focused_label<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        use objc2::runtime::AnyObject;
        use objc2::{class, msg_send};
        let map: HashMap<String, usize> = app.try_state::<Natives>()?.0.lock().ok()?.clone();
        if map.is_empty() {
            return None;
        }
        let ns = app.get_window("main")?.ns_window().ok()? as *mut AnyObject;
        if ns.is_null() {
            return None;
        }
        // SAFETY: on the main thread (every caller), `ns` is the live
        // NSWindow; `firstResponder` and `superview` return live objects
        // or nil, and each is checked to be an NSView before `superview`
        // is sent. The map's addresses are only compared.
        unsafe {
            let mut r: *mut AnyObject = msg_send![ns, firstResponder];
            for _ in 0..64 {
                if r.is_null() {
                    return None;
                }
                if let Some((label, _)) = map.iter().find(|(_, a)| **a == r as usize) {
                    return Some(label.clone());
                }
                let is_view: bool = msg_send![r, isKindOfClass: class!(NSView)];
                if !is_view {
                    return None;
                }
                r = msg_send![r, superview];
            }
        }
        None
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        None
    }
}

/// The Edit menu's ids that mean something inside a page: `main.rs`'s
/// Undo and Redo, and Find, which exists for this.
use crate::{REDO_MENU_ID as MENU_REDO, UNDO_MENU_ID as MENU_UNDO};
pub const MENU_FIND: &str = "find_in_page";

/// A menu item chosen while a web tab's page holds the keyboard: Undo and
/// Redo go to the page as AppKit's own `undo:` / `redo:` — exactly what
/// the OS's predefined items would send, so a text field on the page
/// undoes its own typing and Nightloom's stack is left alone — and Find
/// opens the page's find field in its bar. Returns whether it took the
/// item; everything else, and every item while no page has the keyboard,
/// goes on to the frontend as before. Called from the menu handler, on
/// the main thread.
pub fn menu_route<R: Runtime>(app: &AppHandle<R>, id: &str) -> bool {
    if id != MENU_UNDO && id != MENU_REDO && id != MENU_FIND {
        return false;
    }
    let Some(label) = focused_label(app) else {
        return false;
    };
    #[cfg(target_os = "macos")]
    {
        use objc2::runtime::{AnyObject, Sel};
        use objc2::{class, msg_send, sel};
        let action: Option<Sel> = match id {
            MENU_UNDO => Some(sel!(undo:)),
            MENU_REDO => Some(sel!(redo:)),
            _ => None,
        };
        if let Some(action) = action {
            let none: *mut AnyObject = std::ptr::null_mut();
            // SAFETY: main thread; `sendAction:to:from:` with a nil target
            // walks the key window's responder chain, as a menu item does.
            unsafe {
                let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
                let _: bool = msg_send![ns_app, sendAction: action, to: none, from: none];
            }
            return true;
        }
    }
    tell(app, "web-find", label);
    true
}

/// Which web tab's page holds the keyboard — the frontend asks when the
/// main page loses focus, so the pane of a page he clicked into becomes
/// the focused pane and ⌘W closes that tab, not the chat beside it.
#[tauri::command]
pub async fn web_focused<R: Runtime>(app: AppHandle<R>) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let a = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(focused_label(&a));
    })
    .ok()?;
    rx.await.ok().flatten()
}

/// Find `text` in web tab `label`'s page, the next match after the
/// current one (or before, `backwards`), wrapping; whether one was found.
/// The page's own `window.find` does the work — a page that replaced it
/// can only make its own find fail. An empty `text` clears the selection.
#[tauri::command]
pub async fn web_find<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    text: String,
    backwards: bool,
) -> Result<bool, String> {
    let view = web_view(&app, &label)?;
    let text: String = text.chars().take(500).collect();
    if text.is_empty() {
        view.eval("try{getSelection().removeAllRanges()}catch(e){}")
            .map_err(|e| e.to_string())?;
        return Ok(false);
    }
    let js = find_js(&text, backwards);
    let (tx, rx) = tokio::sync::oneshot::channel();
    let tx = Mutex::new(Some(tx));
    view.eval_with_callback(js, move |raw| {
        if let Some(tx) = tx.lock().ok().and_then(|mut t| t.take()) {
            let _ = tx.send(raw.trim() == "true");
        }
    })
    .map_err(|e| e.to_string())?;
    Ok(rx.await.unwrap_or(false))
}

/// The script [`web_find`] runs: `text` goes in as a JSON string literal,
/// so nothing he types can break out of it.
fn find_js(text: &str, backwards: bool) -> String {
    let quoted = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into());
    format!(
        "(function(){{try{{return !!window.find({quoted},false,{backwards},true,false,false,false)}}catch(e){{return false}}}})()"
    )
}

/// How far below the top of the window the main page starts, in points.
///
/// Measured on macOS (probe, 2026-09-23): a child webview's position is
/// counted from the top of the window's *frame*, title bar included, while
/// the main page — and so every rectangle the frontend measures — starts
/// under the title bar; a page placed at the pane's `y` sat one title bar
/// (28 pt) too high. tao reports the frame's height as the inner height
/// there (outer = inner = 640 pt for a page 612 pt tall), so the bar is
/// found as the window's inner height less the page's own viewport height
/// `vh`, which the frontend sends (`innerHeight`, in points). Zero in full
/// screen, and wherever the title bar is the webview's own.
fn chrome_height<R: Runtime>(window: &tauri::Window<R>, vh: f64) -> f64 {
    let scale = window.scale_factor().unwrap_or(1.0);
    match window.inner_size() {
        Ok(i) if vh > 0.0 => (f64::from(i.height) / scale - vh).clamp(0.0, 120.0),
        _ => 0.0,
    }
}

fn place<R: Runtime>(
    view: &tauri::Webview<R>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    vh: f64,
) -> Result<(), String> {
    let top = y + chrome_height(&view.window(), vh);
    view.set_position(LogicalPosition::new(x, top))
        .map_err(|e| e.to_string())?;
    view.set_size(LogicalSize::new(w.max(1.0), h.max(1.0)))
        .map_err(|e| e.to_string())
}

/// Move a web tab to the pane rectangle, or hide it (`visible: false` —
/// its tab went to the back, a dialog is over it, a drag is on).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn web_bounds<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    vh: f64,
    visible: bool,
) -> Result<(), String> {
    let view = web_view(&app, &label)?;
    if !visible {
        return view.hide().map_err(|e| e.to_string());
    }
    place(&view, x, y, w, h, vh)?;
    view.show().map_err(|e| e.to_string())
}

/// The bar's buttons: `back`, `forward`, `reload`.
#[tauri::command]
pub async fn web_nav<R: Runtime>(
    app: AppHandle<R>,
    label: String,
    action: String,
) -> Result<(), String> {
    let view = web_view(&app, &label)?;
    match action.as_str() {
        "back" => view.eval("history.back()"),
        "forward" => view.eval("history.forward()"),
        "reload" => view.reload(),
        // The find field closing hands the keyboard back to the page.
        "focus" => view.set_focus(),
        other => return Err(format!("unknown web action {other}")),
    }
    .map_err(|e| e.to_string())
}

/// Destroy a web tab's webview — its tab closed.
#[tauri::command]
pub async fn web_close<R: Runtime>(app: AppHandle<R>, label: String) -> Result<(), String> {
    checked_label(&label)?;
    forget_native(&app, &label);
    if let Some(view) = app.get_webview(&label) {
        view.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Every live web tab's label — the frontend closes the ones no tab holds
/// (a reload of the main page forgets its tabs; the webviews outlive it).
#[tauri::command]
pub async fn web_labels<R: Runtime>(app: AppHandle<R>) -> Vec<String> {
    let mut out: Vec<String> = app
        .webviews()
        .into_keys()
        .filter(|l| is_web_label(l))
        .collect();
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_web_tab_navigates_only_on_the_web() {
        for ok in [
            "https://example.com/a",
            "http://127.0.0.1:8000/",
            "about:blank",
            "data:text/html,x",
            "blob:https://a.b/1",
        ] {
            assert!(allowed_navigation(&Url::parse(ok).unwrap()), "{ok}");
        }
        for no in [
            "tauri://localhost/",
            "ipc://localhost/x",
            "asset://localhost/x",
            "file:///etc/passwd",
            "nightloom://x",
            "javascript:alert(1)",
        ] {
            assert!(!allowed_navigation(&Url::parse(no).unwrap()), "{no}");
        }
    }

    #[test]
    fn a_web_tab_never_reaches_the_apps_own_origin() {
        let dev = Url::parse("http://localhost:1420").unwrap();
        for no in [
            "http://localhost:1420/",
            "http://localhost:1420/index.html?x",
            "http://tauri.localhost/",
            "https://tauri.localhost/",
            "http://ipc.LOCALHOST/x",
        ] {
            assert!(is_app_origin(&Url::parse(no).unwrap(), Some(&dev)), "{no}");
        }
        for ok in [
            "http://localhost:3000/",
            "https://localhost:1420/",
            "http://127.0.0.1:1420/",
            "https://example.com/",
        ] {
            assert!(!is_app_origin(&Url::parse(ok).unwrap(), Some(&dev)), "{ok}");
        }
        assert!(!is_app_origin(
            &Url::parse("http://localhost:1420/").unwrap(),
            None
        ));
    }

    #[test]
    fn find_text_cannot_break_out_of_its_string() {
        let js = find_js("\"),alert(1),(\"", true);
        assert!(
            js.contains(r#"window.find("\"),alert(1),(\"",false,true,"#),
            "{js}"
        );
        assert!(find_js("a", false).contains(r#"window.find("a",false,false,true"#));
    }

    #[test]
    fn a_web_tab_opens_only_http() {
        assert!(allowed_open(&Url::parse("https://a.b").unwrap()));
        assert!(!allowed_open(&Url::parse("mailto:a@b.c").unwrap()));
        assert!(!allowed_open(&Url::parse("about:blank").unwrap()));
    }

    #[test]
    fn labels_are_checked() {
        assert!(checked_label("web-t12").is_ok());
        assert!(checked_label("main").is_err());
        assert!(checked_label("web-../x").is_err());
    }

    #[test]
    fn a_favicon_is_kept_only_when_plainly_http() {
        assert_eq!(
            clean_favicon("\"https://a.b/f.ico\"").as_deref(),
            Some("https://a.b/f.ico")
        );
        assert_eq!(clean_favicon("\"javascript:alert(1)\""), None);
        assert_eq!(clean_favicon("\"data:image/png;base64,AA\""), None);
        assert_eq!(clean_favicon("42"), None);
        assert_eq!(clean_favicon(""), None);
    }
}
