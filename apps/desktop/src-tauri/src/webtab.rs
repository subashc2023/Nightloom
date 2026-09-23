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
//! Its storage is its own origin's, so the app's localStorage is out of
//! reach by the browser's own rule. Nothing a page says is an instruction:
//! the title and favicon it reports are shown as text and an image URL,
//! checked for scheme and length, and nothing else is read from it.

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
        .on_navigation(allowed_navigation)
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
    window
        .add_child(
            builder,
            LogicalPosition::new(x, top),
            LogicalSize::new(w.max(1.0), h.max(1.0)),
        )
        .map_err(|e| e.to_string())?;
    Ok(())
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
        other => return Err(format!("unknown web action {other}")),
    }
    .map_err(|e| e.to_string())
}

/// Destroy a web tab's webview — its tab closed.
#[tauri::command]
pub async fn web_close<R: Runtime>(app: AppHandle<R>, label: String) -> Result<(), String> {
    checked_label(&label)?;
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
