//! Quick Entry (item 795, 793 report §4 row 2): a system-wide shortcut he
//! picks in Settings opens a small box over whatever app he is in, without
//! bringing Nightloom's window forward. The box (`quick.html`) sends to the
//! chat he last used, a new chat in a project, or an aside on the last chat;
//! the main window runs the send (`quickEntry.svelte.ts`).
//!
//! The shortcut is a Carbon hot key (`RegisterEventHotKey`), the call the
//! system's own apps and every launcher use: it needs no Accessibility or
//! Input Monitoring permission, so it raises no dialog. It lives in this
//! process, so it does nothing while the app is not running, and it never
//! opens anything but this build's own box — a dev build cannot launch the
//! installed app through it. A dev build registers nothing unless
//! `NIGHTLOOM_QUICK_ENTRY=1` is set, so a `tauri dev` never takes the
//! installed app's shortcut from it.
//!
//! The box is a non-activating panel (`panel::make`): it takes the keyboard
//! while the app stays inactive, which is what keeps the main window behind
//! the app he is in.

use std::sync::Mutex;

/// Carbon's modifier bits (`Events.h`).
pub const CMD: u32 = 0x0100;
pub const SHIFT: u32 = 0x0200;
pub const OPTION: u32 = 0x0800;
pub const CONTROL: u32 = 0x1000;

/// The window label of the box.
pub const LABEL: &str = "quick-entry";

/// A parsed shortcut: the virtual key code and Carbon's modifier bits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Shortcut {
    pub key: u32,
    pub mods: u32,
}

/// `KeyboardEvent.code` → the Mac's virtual key code (`kVK_*`, by position,
/// not by layout — the same physical key on every keyboard layout).
fn key_code(code: &str) -> Option<u32> {
    const LETTERS: [(char, u32); 26] = [
        ('A', 0),
        ('B', 11),
        ('C', 8),
        ('D', 2),
        ('E', 14),
        ('F', 3),
        ('G', 5),
        ('H', 4),
        ('I', 34),
        ('J', 38),
        ('K', 40),
        ('L', 37),
        ('M', 46),
        ('N', 45),
        ('O', 31),
        ('P', 35),
        ('Q', 12),
        ('R', 15),
        ('S', 1),
        ('T', 17),
        ('U', 32),
        ('V', 9),
        ('W', 13),
        ('X', 7),
        ('Y', 16),
        ('Z', 6),
    ];
    const DIGITS: [u32; 10] = [29, 18, 19, 20, 21, 23, 22, 26, 28, 25];
    const FKEYS: [u32; 12] = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111];
    if let Some(l) = code.strip_prefix("Key") {
        let mut cs = l.chars();
        let (Some(c), None) = (cs.next(), cs.next()) else {
            return None;
        };
        return LETTERS.iter().find(|(x, _)| *x == c).map(|(_, k)| *k);
    }
    if let Some(d) = code.strip_prefix("Digit") {
        let n: usize = d.parse().ok()?;
        return DIGITS.get(n).copied();
    }
    if let Some(Ok(n)) = code.strip_prefix('F').map(str::parse::<usize>) {
        return (1..=12).contains(&n).then(|| FKEYS[n - 1]);
    }
    Some(match code {
        "Space" => 49,
        "Period" => 47,
        "Comma" => 43,
        "Slash" => 44,
        "Semicolon" => 41,
        "Quote" => 39,
        "BracketLeft" => 33,
        "BracketRight" => 30,
        "Backslash" => 42,
        "Minus" => 27,
        "Equal" => 24,
        "Backquote" => 50,
        _ => return None,
    })
}

/// "Ctrl+Alt+Space" (the Settings recorder's form: modifiers, then the
/// key's `KeyboardEvent.code`) → a shortcut. At least one of ⌘, ⌃ or ⌥ is
/// required: Shift alone would eat a capital letter in every app.
pub fn parse(s: &str) -> Result<Shortcut, String> {
    let mut mods = 0;
    let mut key = None;
    for part in s.split('+').map(str::trim).filter(|p| !p.is_empty()) {
        match part.to_ascii_lowercase().as_str() {
            "cmd" | "command" | "meta" | "super" => mods |= CMD,
            "ctrl" | "control" => mods |= CONTROL,
            "alt" | "option" | "opt" => mods |= OPTION,
            "shift" => mods |= SHIFT,
            _ => {
                if key.is_some() {
                    return Err(format!("“{s}” names two keys"));
                }
                key = Some(
                    key_code(part)
                        .ok_or_else(|| format!("“{part}” is not a key Quick Entry can use"))?,
                );
            }
        }
    }
    let key = key.ok_or_else(|| format!("“{s}” has no key besides the modifiers"))?;
    if mods & (CMD | CONTROL | OPTION) == 0 {
        return Err("a Quick Entry shortcut needs ⌘, ⌃ or ⌥".into());
    }
    Ok(Shortcut { key, mods })
}

/// Whether this build registers the shortcut: a release build always; a
/// dev build only when asked (`NIGHTLOOM_QUICK_ENTRY=1`).
pub fn allowed(debug: bool, env: Option<&str>) -> bool {
    !debug || env == Some("1")
}

/// What registers a hot key — Carbon in the app, a stub in the tests (a
/// test must never take a real shortcut on his Mac).
pub trait Backend {
    type Handle;
    fn register(&mut self, s: Shortcut) -> Result<Self::Handle, String>;
    fn unregister(&mut self, h: Self::Handle);
}

/// The one shortcut held: a new one replaces it; `None` turns it off; a
/// string that does not parse, or a register the system refuses (another
/// app holds the combination), leaves Quick Entry off and says why.
pub struct Registrar<B: Backend> {
    backend: B,
    held: Option<(Shortcut, B::Handle)>,
}

impl<B: Backend> Registrar<B> {
    pub fn new(backend: B) -> Self {
        Self {
            backend,
            held: None,
        }
    }

    pub fn current(&self) -> Option<Shortcut> {
        self.held.as_ref().map(|(s, _)| *s)
    }

    pub fn set(&mut self, wanted: Option<&str>) -> Result<Option<Shortcut>, String> {
        let next = match wanted.map(str::trim).filter(|s| !s.is_empty()) {
            Some(s) => Some(parse(s)?),
            None => None,
        };
        if next.is_some() && next == self.current() {
            return Ok(next);
        }
        if let Some((_, h)) = self.held.take() {
            self.backend.unregister(h);
        }
        if let Some(s) = next {
            let h = self.backend.register(s)?;
            self.held = Some((s, h));
        }
        Ok(next)
    }
}

#[cfg(target_os = "macos")]
pub mod carbon {
    //! `RegisterEventHotKey` and its handler. Main thread only.
    use super::{Backend, Shortcut};
    use std::ffi::c_void;
    use std::sync::OnceLock;

    #[repr(C)]
    struct EventTypeSpec {
        class: u32,
        kind: u32,
    }

    #[repr(C)]
    struct EventHotKeyId {
        signature: u32,
        id: u32,
    }

    type Handler = extern "C" fn(*mut c_void, *mut c_void, *mut c_void) -> i32;

    #[link(name = "Carbon", kind = "framework")]
    unsafe extern "C" {
        fn GetApplicationEventTarget() -> *mut c_void;
        fn InstallEventHandler(
            target: *mut c_void,
            handler: Handler,
            count: u32,
            types: *const EventTypeSpec,
            user: *mut c_void,
            out: *mut *mut c_void,
        ) -> i32;
        fn RegisterEventHotKey(
            key: u32,
            mods: u32,
            id: EventHotKeyId,
            target: *mut c_void,
            options: u32,
            out: *mut *mut c_void,
        ) -> i32;
        fn UnregisterEventHotKey(r: *mut c_void) -> i32;
    }

    const K_EVENT_CLASS_KEYBOARD: u32 = u32::from_be_bytes(*b"keyb");
    const K_EVENT_HOT_KEY_PRESSED: u32 = 5;
    const SIGNATURE: u32 = u32::from_be_bytes(*b"NLqe");

    static ON_PRESS: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();

    extern "C" fn pressed(_: *mut c_void, _: *mut c_void, _: *mut c_void) -> i32 {
        if let Some(f) = ON_PRESS.get() {
            f();
        }
        0
    }

    pub struct Carbon;

    /// The registered hot key's ref (an opaque pointer, kept as a number so
    /// the registrar can sit in a `Mutex` across threads).
    pub struct Ref(usize);

    impl Carbon {
        /// Install the press handler once; `on_press` runs on the main thread.
        pub fn install(on_press: impl Fn() + Send + Sync + 'static) -> Result<Self, String> {
            if ON_PRESS.set(Box::new(on_press)).is_err() {
                return Ok(Carbon);
            }
            let spec = EventTypeSpec {
                class: K_EVENT_CLASS_KEYBOARD,
                kind: K_EVENT_HOT_KEY_PRESSED,
            };
            let mut out = std::ptr::null_mut();
            // SAFETY: Carbon's documented signature; the spec outlives the
            // call (Carbon copies it); main thread (the caller's contract).
            let err = unsafe {
                InstallEventHandler(
                    GetApplicationEventTarget(),
                    pressed,
                    1,
                    &spec,
                    std::ptr::null_mut(),
                    &mut out,
                )
            };
            if err != 0 {
                return Err(format!(
                    "the system refused the shortcut's handler (error {err})"
                ));
            }
            Ok(Carbon)
        }
    }

    impl Backend for Carbon {
        type Handle = Ref;
        fn register(&mut self, s: Shortcut) -> Result<Ref, String> {
            let mut out = std::ptr::null_mut();
            let id = EventHotKeyId {
                signature: SIGNATURE,
                id: 1,
            };
            // SAFETY: Carbon's documented signature; main thread.
            let err = unsafe {
                RegisterEventHotKey(s.key, s.mods, id, GetApplicationEventTarget(), 0, &mut out)
            };
            if err != 0 || out.is_null() {
                // -9878, eventHotKeyExistsErr: another app holds it.
                return Err(if err == -9878 {
                    "another app already uses that shortcut — pick another".into()
                } else {
                    format!("the system refused that shortcut (error {err})")
                });
            }
            Ok(Ref(out as usize))
        }
        fn unregister(&mut self, h: Ref) {
            // SAFETY: a ref `register` returned, unregistered once.
            unsafe { UnregisterEventHotKey(h.0 as *mut c_void) };
        }
    }
}

#[cfg(target_os = "macos")]
mod panel {
    //! The box as a non-activating panel: the main window's class swapped
    //! for an NSPanel subclass that may become key, with
    //! `NSWindowStyleMaskNonactivatingPanel` — the Spotlight shape. It
    //! takes the keyboard while Nightloom stays inactive.
    use objc2::runtime::{AnyClass, AnyObject, Bool, ClassBuilder, Sel};
    use objc2::{class, msg_send, sel};

    unsafe extern "C" {
        fn object_setClass(obj: *mut AnyObject, cls: *const AnyClass) -> *const AnyClass;
    }

    extern "C-unwind" fn yes(_: *mut AnyObject, _: Sel) -> Bool {
        Bool::YES
    }

    fn class() -> Option<&'static AnyClass> {
        AnyClass::get(c"NightloomQuickEntryPanel").or_else(|| {
            let mut b = ClassBuilder::new(c"NightloomQuickEntryPanel", class!(NSPanel))?;
            // SAFETY: BOOL-returning, no-argument selectors.
            unsafe {
                b.add_method(
                    sel!(canBecomeKeyWindow),
                    yes as extern "C-unwind" fn(_, _) -> _,
                );
            }
            Some(b.register())
        })
    }

    /// Swap the class and set the panel's flags. Main thread; once per window.
    ///
    /// # Safety
    /// `ns` is the box's live NSWindow.
    pub unsafe fn make(ns: *mut AnyObject) {
        // SAFETY: the caller's contract (live NSWindow, main thread).
        unsafe {
            let Some(cls) = class() else { return };
            object_setClass(ns, cls);
            let mask: usize = msg_send![ns, styleMask];
            // NSWindowStyleMaskNonactivatingPanel.
            let _: () = msg_send![ns, setStyleMask: mask | (1 << 7)];
            let _: () = msg_send![ns, setFloatingPanel: Bool::YES];
            let _: () = msg_send![ns, setHidesOnDeactivate: Bool::NO];
            // NSFloatingWindowLevel; over a full-screen app too.
            let _: () = msg_send![ns, setLevel: 3isize];
            // canJoinAllSpaces | fullScreenAuxiliary.
            let _: () = msg_send![ns, setCollectionBehavior: (1usize << 0) | (1usize << 8)];
        }
    }

    /// Order the box in front of every app and give it the keyboard,
    /// without activating Nightloom.
    ///
    /// # Safety
    /// `ns` is the box's live NSWindow; main thread.
    pub unsafe fn front(ns: *mut AnyObject) {
        // SAFETY: the caller's contract.
        unsafe {
            let _: () = msg_send![ns, orderFrontRegardless];
            let _: () = msg_send![ns, makeKeyWindow];
        }
    }
}

/// The app's registrar (macOS: Carbon), made at setup.
#[cfg(target_os = "macos")]
pub struct QuickEntry(pub Mutex<Option<Registrar<carbon::Carbon>>>);
#[cfg(not(target_os = "macos"))]
pub struct QuickEntry(pub Mutex<Option<()>>);

/// Setup: install the press handler (nothing is registered until the main
/// window hands over his saved shortcut).
pub fn install<R: tauri::Runtime>(app: &tauri::App<R>) -> QuickEntry {
    #[cfg(target_os = "macos")]
    {
        let handle = app.handle().clone();
        match carbon::Carbon::install(move || show(&handle)) {
            Ok(c) => QuickEntry(Mutex::new(Some(Registrar::new(c)))),
            Err(e) => {
                eprintln!("quick entry: {e}");
                QuickEntry(Mutex::new(None))
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        QuickEntry(Mutex::new(None))
    }
}

/// Show the box (made the first time), its page told so it re-reads the
/// targets and its draft. Called on the main thread by Carbon's handler;
/// the window is built off it (Tauri's safe path), the panel calls run on it.
pub fn show<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move { open_box(&app) });
}

fn open_box<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::{Emitter, Manager};
    let (win, fresh) = match app.get_webview_window(LABEL) {
        Some(w) => (w, false),
        None => {
            let built = tauri::WebviewWindowBuilder::new(
                app,
                LABEL,
                tauri::WebviewUrl::App("quick.html".into()),
            )
            .title("Quick Entry")
            .inner_size(560.0, 210.0)
            .resizable(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible_on_all_workspaces(true)
            .visible(false)
            .focused(false)
            .center()
            .build();
            match built {
                Ok(w) => (w, true),
                Err(e) => {
                    eprintln!("quick entry: the box did not open: {e}");
                    return;
                }
            }
        }
    };
    let _ = win.emit_to(LABEL, "quick-entry-shown", ());
    #[cfg(target_os = "macos")]
    if let Ok(ns) = win.ns_window() {
        let ns = ns as usize;
        let _ = app.run_on_main_thread(move || {
            // SAFETY: the box's live NSWindow, on the main thread; the
            // class swap happens once, when the window is new.
            unsafe {
                if fresh {
                    panel::make(ns as *mut objc2::runtime::AnyObject);
                }
                panel::front(ns as *mut objc2::runtime::AnyObject);
            }
        });
        return;
    }
    let _ = fresh;
    let _ = win.show();
    let _ = win.set_focus();
}

/// The main window hands over his saved shortcut at launch and on every
/// change in Settings; `None` (or "") turns Quick Entry off. Returns the
/// shortcut held, or why none is.
#[tauri::command]
pub async fn quick_entry_set_shortcut(
    app: tauri::AppHandle,
    shortcut: Option<String>,
) -> Result<Option<String>, String> {
    if !allowed(
        cfg!(debug_assertions),
        std::env::var("NIGHTLOOM_QUICK_ENTRY").ok().as_deref(),
    ) {
        // Parsed all the same, so Settings says when a pick is unusable.
        if let Some(s) = shortcut.as_deref().filter(|s| !s.trim().is_empty()) {
            parse(s)?;
        }
        return Err("this is a dev build: Quick Entry's shortcut stays with the installed app (set NIGHTLOOM_QUICK_ENTRY=1 to try it here)".into());
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        use tauri::Manager;
        let state = handle.state::<QuickEntry>();
        let mut held = state.0.lock().unwrap_or_else(|e| e.into_inner());
        #[cfg(target_os = "macos")]
        let out = match held.as_mut() {
            Some(r) => r
                .set(shortcut.as_deref())
                .map(|_| shortcut.clone().filter(|s| !s.trim().is_empty())),
            None => Err("Quick Entry could not start on this Mac".to_string()),
        };
        #[cfg(not(target_os = "macos"))]
        let out = {
            let _ = (&mut held, &shortcut);
            Err::<Option<String>, String>("Quick Entry is a macOS feature".to_string())
        };
        let _ = tx.send(out);
    })
    .map_err(|e| e.to_string())?;
    rx.await.map_err(|e| e.to_string())?
}

/// The box hides itself (sent, Escape, or a click elsewhere); the draft is
/// the page's to keep.
#[tauri::command]
pub fn quick_entry_hide(app: tauri::AppHandle) {
    use tauri::Manager;
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.hide();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Stub {
        taken: Vec<Shortcut>,
        live: Vec<u32>,
        next: u32,
        refuse: bool,
    }

    impl Backend for &mut Stub {
        type Handle = u32;
        fn register(&mut self, s: Shortcut) -> Result<u32, String> {
            if self.refuse {
                return Err("another app already uses that shortcut".into());
            }
            self.next += 1;
            self.taken.push(s);
            self.live.push(self.next);
            Ok(self.next)
        }
        fn unregister(&mut self, h: u32) {
            self.live.retain(|x| *x != h);
        }
    }

    #[test]
    fn parses_the_recorders_form() {
        assert_eq!(
            parse("Ctrl+Alt+Space"),
            Ok(Shortcut {
                key: 49,
                mods: CONTROL | OPTION
            })
        );
        assert_eq!(
            parse("Cmd+Shift+KeyK"),
            Ok(Shortcut {
                key: 40,
                mods: CMD | SHIFT
            })
        );
        assert_eq!(
            parse("alt + Digit1"),
            Ok(Shortcut {
                key: 18,
                mods: OPTION
            })
        );
        assert_eq!(
            parse("Cmd+F12"),
            Ok(Shortcut {
                key: 111,
                mods: CMD
            })
        );
        assert_eq!(
            parse("Option+Slash"),
            Ok(Shortcut {
                key: 44,
                mods: OPTION
            })
        );
    }

    #[test]
    fn refuses_what_would_eat_typing_or_names_no_key() {
        assert!(parse("Shift+KeyA").is_err());
        assert!(parse("KeyA").is_err());
        assert!(parse("Cmd+Shift").is_err());
        assert!(parse("Cmd+KeyA+KeyB").is_err());
        assert!(parse("Cmd+Enterprise").is_err());
        assert!(parse("Cmd+F13").is_err());
        assert!(parse("Cmd+KeyAB").is_err());
    }

    #[test]
    fn a_dev_build_takes_no_shortcut_unless_asked() {
        assert!(allowed(false, None));
        assert!(!allowed(true, None));
        assert!(!allowed(true, Some("0")));
        assert!(allowed(true, Some("1")));
    }

    #[test]
    fn a_new_shortcut_replaces_the_old_and_none_turns_it_off() {
        let mut stub = Stub::default();
        {
            let mut r = Registrar::new(&mut stub);
            assert_eq!(
                r.set(Some("Ctrl+Alt+Space")).unwrap(),
                Some(Shortcut {
                    key: 49,
                    mods: CONTROL | OPTION
                })
            );
            r.set(Some("Ctrl+Alt+Space")).unwrap();
            r.set(Some("Cmd+Shift+KeyK")).unwrap();
            assert_eq!(
                r.current(),
                Some(Shortcut {
                    key: 40,
                    mods: CMD | SHIFT
                })
            );
            r.set(None).unwrap();
            assert_eq!(r.current(), None);
            r.set(Some("  ")).unwrap();
        }
        // Registered twice (the repeat is a no-op), all released.
        assert_eq!(stub.taken.len(), 2);
        assert!(stub.live.is_empty());
    }

    #[test]
    fn a_bad_pick_keeps_the_old_and_a_refusal_leaves_it_off() {
        let mut stub = Stub::default();
        {
            let mut r = Registrar::new(&mut stub);
            r.set(Some("Ctrl+Alt+Space")).unwrap();
            assert!(r.set(Some("Shift+KeyA")).is_err());
            assert_eq!(
                r.current(),
                Some(Shortcut {
                    key: 49,
                    mods: CONTROL | OPTION
                })
            );
        }
        assert_eq!(stub.live.len(), 1);
        stub.refuse = true;
        let mut r = Registrar::new(&mut stub);
        assert!(r.set(Some("Cmd+KeyJ")).is_err());
        assert_eq!(r.current(), None);
    }
}
