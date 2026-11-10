//! Claude's browser, owned by the app (nightshift item 508, 2026-11-09;
//! blocker 1666: option A2, logins in memory only).
//!
//! **Why the app owns it.** A chat's message is one `claude -p` process,
//! and the Playwright MCP server in it ends with the message, its browser
//! with it (`agent::own_browser`). So nothing could be watched or used
//! between messages. Here the app keeps one headless WebKit per chat — the
//! same pinned Playwright install, started by a small Node helper
//! (`assets/claude-browser-helper.js`) — and every `claude -p` of the chat
//! attaches its MCP server to it with `--endpoint`.
//!
//! **Started by the first call that runs, not before.** A bound browser's
//! address is not known until it is launched, and a chat that never uses
//! Playwright must cost nothing. So the address the MCP server is given is
//! the app's own: one Unix socket per chat ([`Browsers::endpoint`]), bound
//! when the chat's turn is set up and costing a file. The MCP server
//! connects to it only when a Playwright call actually runs — after the
//! permission hook allowed it (measured: none at `initialize` or
//! `tools/list`). That first connection starts the helper and the browser;
//! each connection is then copied byte for byte to the browser's own
//! socket. A second `claude -p` finds the same browser, the same page, the
//! same logins. The tool list the model sees is byte-identical either way
//! (`own_browser::tests::the_tool_list_is_the_same_with_an_endpoint`).
//!
//! **Ends** with the chat's delete ([`Browsers::close`]), the app's quit
//! ([`Browsers::shutdown_all`]; a watchdog covers a crash, as a preview's
//! does), or after [`IDLE`] with no message attached and no tab watching
//! ([`Browsers::sweep_idle`]). An idle end keeps the socket, so the next
//! call starts a fresh browser — logged in to nothing, on a blank page.
//!
//! **The window** watches and acts through the helper: JPEG frames only
//! while a tab watches, clicks and keys in, status and dialogs out. Frames
//! never reach the model. **The hold**: the user's first click or key
//! takes the browser ([`AskDir::set_held_by_user`]); until he gives it back
//! the permission hook refuses every Playwright call in words
//! (`own_browser::HELD_BY_USER`). The hold ends with the browser.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::agent::ask::AskDir;
use crate::agent::own_browser;

/// The page's size, fixed: the tab letterboxes, so the user's pane never
/// changes the page under the model.
pub const WIDTH: u32 = 1280;
pub const HEIGHT: u32 = 800;
/// How long a browser nobody is attached to or watching is kept.
pub const IDLE: Duration = Duration::from_secs(30 * 60);
/// How long a start may take before the call that asked for it fails.
const READY_WAIT: Duration = Duration::from_secs(60);
/// How often the idle check runs.
const IDLE_TICK: Duration = Duration::from_secs(30);

/// One chat's browser as the window sees it (the 508 contract's
/// `BrowserStatus`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BrowserStatus {
    /// The browser process is up.
    pub live: bool,
    pub url: String,
    pub title: String,
    /// `"model"` or `"user"`.
    pub held_by: &'static str,
    pub width: u32,
    pub height: u32,
    /// Open pages; the newest is the one shown.
    pub pages: u32,
    /// A message is using the browser now (a chat turn's MCP server is
    /// attached; its subagents share that one). False between messages,
    /// while the browser is only kept for its logins (item 557): the
    /// chat's offer then goes and the tab says it is idle.
    pub in_use: bool,
}

/// What a browser tells the window.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// One JPEG, base64, only while watched.
    Frame {
        seq: u64,
        jpeg: String,
        w: u32,
        h: u32,
    },
    /// On start, stop, navigation, title change, hold change.
    Status(BrowserStatus),
    /// `alert`, `confirm`, `prompt` or `file`.
    Dialog { kind: String, message: String },
}

/// Told of every event of a chat's browser. Called with no lock held.
pub type OnEvent = Arc<dyn Fn(&str, &Event) + Send + Sync>;

/// The helper's command line.
#[derive(Debug, Clone, PartialEq)]
pub struct Launcher {
    pub program: PathBuf,
    pub args: Vec<String>,
}

impl Launcher {
    /// The real one: the pinned install's node running the helper, written
    /// beside the install. `None` when Playwright is not installed.
    pub fn pinned() -> Option<Self> {
        let install = own_browser::locate()?;
        let dir = own_browser::default_dir()?;
        let helper = own_browser::ensure_helper(&dir).ok()?;
        Some(Self {
            program: install.node,
            args: vec![
                helper.to_string_lossy().into_owned(),
                dir.to_string_lossy().into_owned(),
            ],
        })
    }
}

#[derive(Default)]
struct Shared {
    url: String,
    title: String,
    pages: u32,
    /// Some tab watches.
    watching: bool,
    /// MCP servers attached now: a message that used the browser is running.
    conns: usize,
    last_active: Option<Instant>,
    /// The running helper's generation and process group.
    live: Option<(u64, Option<u32>)>,
    /// A browser ran for this chat since the app started.
    ever_live: bool,
}

struct Proc {
    stdin: tokio::process::ChildStdin,
    endpoint: String,
    generation: u64,
}

struct Entry {
    chat: String,
    socket: PathBuf,
    /// The chat's ask directory, where the hold lives; it moves with the
    /// chat when the chat changes project.
    ask_dir: Mutex<PathBuf>,
    shared: Mutex<Shared>,
    /// The helper; the lock also makes two first connections one start.
    proc_: tokio::sync::Mutex<Option<Proc>>,
    accept: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Entry {
    fn ask(&self) -> AskDir {
        AskDir::new(self.ask_dir.lock().unwrap().clone())
    }

    fn held(&self) -> bool {
        self.ask().held_by_user()
    }

    fn status(&self) -> BrowserStatus {
        let s = self.shared.lock().unwrap();
        BrowserStatus {
            live: s.live.is_some(),
            url: s.url.clone(),
            title: s.title.clone(),
            held_by: if self.held() { "user" } else { "model" },
            width: WIDTH,
            height: HEIGHT,
            pages: s.pages,
            in_use: s.live.is_some() && s.conns > 0,
        }
    }

    fn touch(&self) {
        self.shared.lock().unwrap().last_active = Some(Instant::now());
    }
}

/// The app's browsers, one per chat.
pub struct Browsers {
    entries: Mutex<HashMap<String, Arc<Entry>>>,
    on_event: Mutex<Option<OnEvent>>,
    socket_dir: PathBuf,
    launcher: Option<Launcher>,
    idle: Duration,
    generation: AtomicU64,
    /// The pid each helper's watchdog watches; `None`, no watchdog.
    watch_pid: Option<u32>,
}

impl Browsers {
    /// `socket_dir` holds the per-chat sockets: short (a socket path is at
    /// most ~100 bytes) and this user's alone.
    pub fn new(socket_dir: PathBuf) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            on_event: Mutex::new(None),
            socket_dir,
            launcher: None,
            idle: IDLE,
            generation: AtomicU64::new(1),
            watch_pid: Some(std::process::id()),
        }
    }

    /// The same, starting `launcher` rather than the pinned helper (tests).
    pub fn with_launcher(mut self, launcher: Launcher) -> Self {
        self.launcher = Some(launcher);
        self
    }

    /// The same, ending an unused browser after `idle`.
    pub fn with_idle(mut self, idle: Duration) -> Self {
        self.idle = idle;
        self
    }

    pub fn set_on_event(&self, f: OnEvent) {
        *self.on_event.lock().unwrap() = Some(f);
    }

    fn emit(&self, chat: &str, event: &Event) {
        let f = self.on_event.lock().unwrap().clone();
        if let Some(f) = f {
            f(chat, event);
        }
    }

    fn emit_status(&self, entry: &Entry) {
        self.emit(&entry.chat, &Event::Status(entry.status()));
    }

    fn get(&self, chat: &str) -> Option<Arc<Entry>> {
        self.entries.lock().unwrap().get(chat).cloned()
    }

    fn launcher(&self) -> Option<Launcher> {
        self.launcher.clone().or_else(Launcher::pinned)
    }

    /// This chat's socket path under `dir`: per app process, so a dev build
    /// and the installed app never answer each other's chats.
    fn socket_path(dir: &Path, chat: &str) -> PathBuf {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        chat.hash(&mut h);
        dir.join(format!(
            "cb-{}-{:016x}.sock",
            std::process::id(),
            h.finish()
        ))
    }

    /// Where `chat`'s MCP server finds its browser: the app's socket for
    /// the chat, bound now if it was not. Nothing is started — the browser
    /// starts when something connects. `ask_dir` is the chat's ask
    /// directory, where the hold lives. Call from the runtime.
    ///
    /// An error (Playwright not installed, the socket would not bind)
    /// means the chat keeps a browser of its server's own, as before.
    #[cfg(unix)]
    pub fn endpoint(self: &Arc<Self>, chat: &str, ask_dir: &Path) -> std::io::Result<PathBuf> {
        if let Some(e) = self.get(chat) {
            let moved = {
                let mut dir = e.ask_dir.lock().unwrap();
                let moved = dir.as_path() != ask_dir;
                if moved {
                    *dir = ask_dir.to_path_buf();
                }
                moved
            };
            if moved {
                self.emit_status(&e);
            }
            // A hold with no browser behind it — left by a crash — would
            // lock the model out with nothing to give back.
            if e.shared.lock().unwrap().live.is_none() && e.held() {
                let _ = e.ask().set_held_by_user(false);
            }
            return Ok(e.socket.clone());
        }
        if self.launcher().is_none() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "Playwright is not installed",
            ));
        }
        crate::preview::ensure_private_dir(&self.socket_dir)?;
        let socket = Self::socket_path(&self.socket_dir, chat);
        if !crate::preview::socket_path_fits(&socket) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("{} is too long for a socket", socket.display()),
            ));
        }
        let listener = tokio::net::UnixListener::from_std(crate::preview::bind_socket(&socket)?)?;
        let entry = Arc::new(Entry {
            chat: chat.to_string(),
            socket: socket.clone(),
            ask_dir: Mutex::new(ask_dir.to_path_buf()),
            shared: Mutex::new(Shared::default()),
            proc_: tokio::sync::Mutex::new(None),
            accept: Mutex::new(None),
        });
        // No browser yet, so no hold (as above).
        let _ = AskDir::new(ask_dir).set_held_by_user(false);
        let me = Arc::downgrade(self);
        let accepting = Arc::clone(&entry);
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    continue;
                };
                tokio::spawn(Self::serve(me.clone(), Arc::clone(&accepting), stream));
            }
        });
        *entry.accept.lock().unwrap() = Some(task);
        self.entries.lock().unwrap().insert(chat.to_string(), entry);
        Ok(socket)
    }

    /// One MCP server's connection: the browser started if it is not up,
    /// then bytes copied both ways until either side closes.
    #[cfg(unix)]
    async fn serve(me: Weak<Self>, entry: Arc<Entry>, mut stream: tokio::net::UnixStream) {
        let Some(this) = me.upgrade() else { return };
        let endpoint = match this.ensure_live(&entry).await {
            Ok(e) => e,
            Err(e) => {
                eprintln!("nightloom: Claude's browser did not start: {e}");
                return;
            }
        };
        let Ok(mut upstream) = tokio::net::UnixStream::connect(&endpoint).await else {
            eprintln!("nightloom: Claude's browser is not answering at its socket");
            return;
        };
        let first = {
            let mut s = entry.shared.lock().unwrap();
            s.conns += 1;
            s.last_active = Some(Instant::now());
            s.conns == 1
        };
        this.sync_dialogs(&entry).await;
        // In use from the first attached message (item 557).
        if first {
            this.emit_status(&entry);
        }
        drop(this);
        let _ = tokio::io::copy_bidirectional(&mut stream, &mut upstream).await;
        let last = {
            let mut s = entry.shared.lock().unwrap();
            s.conns = s.conns.saturating_sub(1);
            s.last_active = Some(Instant::now());
            s.conns == 0
        };
        if let Some(this) = me.upgrade() {
            this.sync_dialogs(&entry).await;
            // The message that used it is over: idle, said at once.
            if last {
                this.emit_status(&entry);
            }
        }
    }

    /// The running helper's socket, starting the helper first if none runs.
    #[cfg(unix)]
    async fn ensure_live(self: &Arc<Self>, entry: &Arc<Entry>) -> Result<String, String> {
        let mut slot = entry.proc_.lock().await;
        if let Some(p) = slot.as_ref() {
            let live = entry.shared.lock().unwrap().live;
            if live.is_some_and(|(g, _)| g == p.generation) {
                return Ok(p.endpoint.clone());
            }
        }
        *slot = None;
        let launcher = self.launcher().ok_or("Playwright is not installed")?;
        let mut cmd = tokio::process::Command::new(&launcher.program);
        cmd.args(&launcher.args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .process_group(0);
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("{}: {e}", launcher.program.display()))?;
        let pgid = child.id();
        if let (Some(pgid), Some(watch)) = (pgid, self.watch_pid) {
            crate::preview::spawn_watchdog(pgid, watch);
        }
        let stdin = child.stdin.take().ok_or("the helper has no stdin")?;
        let mut lines =
            BufReader::new(child.stdout.take().ok_or("the helper has no stdout")?).lines();
        let ready = tokio::time::timeout(READY_WAIT, async {
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(v) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                match v["ev"].as_str() {
                    Some("ready") => return v["endpoint"].as_str().map(str::to_string),
                    Some("error") => {
                        eprintln!("nightloom: Claude's browser: {}", v["message"]);
                    }
                    _ => {}
                }
            }
            None
        })
        .await;
        let endpoint = match ready {
            Ok(Some(e)) => e,
            other => {
                crate::preview::stop_group(pgid).await;
                return Err(if other.is_err() {
                    "the browser took too long to start".to_string()
                } else {
                    "the helper ended before the browser was ready".to_string()
                });
            }
        };
        let generation = self.generation.fetch_add(1, Ordering::Relaxed);
        let watching = {
            let mut s = entry.shared.lock().unwrap();
            s.live = Some((generation, pgid));
            s.ever_live = true;
            s.last_active = Some(Instant::now());
            s.watching
        };
        let mut proc_ = Proc {
            stdin,
            endpoint: endpoint.clone(),
            generation,
        };
        if watching {
            let _ = write_line(&mut proc_.stdin, &json!({"op": "watch", "on": true})).await;
        }
        *slot = Some(proc_);
        drop(slot);
        self.emit_status(entry);

        let me = Arc::downgrade(self);
        let reading = Arc::clone(entry);
        tokio::spawn(async move {
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(v) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let Some(this) = me.upgrade() else { break };
                // A helper being stopped still talks as its pages close;
                // only the running one is heard.
                let current = reading.shared.lock().unwrap().live;
                if current.is_some_and(|(g, _)| g == generation) {
                    this.from_helper(&reading, &v);
                }
            }
            let _ = child.wait().await;
            if let Some(this) = me.upgrade() {
                this.ended(&reading, generation);
            }
        });
        Ok(endpoint)
    }

    /// One line from the helper.
    fn from_helper(&self, entry: &Entry, v: &Value) {
        match v["ev"].as_str() {
            Some("status") => {
                {
                    let mut s = entry.shared.lock().unwrap();
                    s.url = v["url"].as_str().unwrap_or_default().to_string();
                    s.title = v["title"].as_str().unwrap_or_default().to_string();
                    s.pages = v["pages"].as_u64().unwrap_or(0) as u32;
                }
                self.emit_status(entry);
            }
            Some("frame") => {
                if !entry.shared.lock().unwrap().watching {
                    return;
                }
                if let Some(jpeg) = v["jpeg"].as_str() {
                    self.emit(
                        &entry.chat,
                        &Event::Frame {
                            seq: v["seq"].as_u64().unwrap_or(0),
                            jpeg: jpeg.to_string(),
                            w: v["w"].as_u64().unwrap_or(WIDTH as u64) as u32,
                            h: v["h"].as_u64().unwrap_or(HEIGHT as u64) as u32,
                        },
                    );
                }
            }
            Some("dialog") => self.emit(
                &entry.chat,
                &Event::Dialog {
                    kind: v["kind"].as_str().unwrap_or("alert").to_string(),
                    message: v["message"].as_str().unwrap_or_default().to_string(),
                },
            ),
            Some("error") => eprintln!("nightloom: Claude's browser: {}", v["message"]),
            _ => {}
        }
    }

    /// The helper of `generation` is gone, by itself: the browser crashed
    /// or was closed from the page. A stop of ours has already said so.
    fn ended(&self, entry: &Entry, generation: u64) {
        {
            let mut s = entry.shared.lock().unwrap();
            if !s.live.is_some_and(|(g, _)| g == generation) {
                return;
            }
            s.live = None;
            s.conns = 0;
            (s.url, s.title, s.pages) = (String::new(), String::new(), 0);
        }
        let _ = entry.ask().set_held_by_user(false);
        self.emit_status(entry);
    }

    /// Send the helper one command; nothing when no browser runs.
    async fn send(&self, entry: &Entry, msg: Value) {
        if entry.shared.lock().unwrap().live.is_none() {
            return;
        }
        let mut slot = entry.proc_.lock().await;
        if let Some(p) = slot.as_mut() {
            let _ = write_line(&mut p.stdin, &msg).await;
        }
    }

    /// Who answers a page's dialog: the helper (accept, empty prompt, no
    /// file) when nobody else will — the user holds the browser, or no
    /// message is attached — and otherwise the model, through Playwright's
    /// own dialog tool, which an answer from here would break.
    async fn sync_dialogs(&self, entry: &Entry) {
        let auto = entry.held() || entry.shared.lock().unwrap().conns == 0;
        self.send(entry, json!({"op": "dialogs", "auto": auto}))
            .await;
    }

    /// The chat's browser, or `None` when the app has run none for it.
    pub fn status(&self, chat: &str) -> Option<BrowserStatus> {
        let e = self.get(chat)?;
        let ever = e.shared.lock().unwrap().ever_live;
        ever.then(|| e.status())
    }

    /// A tab started or stopped watching: frames flow only while one does.
    ///
    /// The last tab gone (item 552) also hands the browser back if he held
    /// it: he closed the tab, sent it to the back, switched chats, or the
    /// window hid or closed — every one a way out of a takeover, and none
    /// may leave the model refused. His next click takes it again.
    pub async fn watch(&self, chat: &str, on: bool) {
        let Some(e) = self.get(chat) else { return };
        {
            let mut s = e.shared.lock().unwrap();
            s.watching = on;
            s.last_active = Some(Instant::now());
        }
        self.send(&e, json!({"op": "watch", "on": on})).await;
        if !on && e.held() {
            let _ = self.set_hold(&e, false).await;
        }
    }

    fn live_entry(&self, chat: &str) -> Result<Arc<Entry>, String> {
        let e = self.get(chat).ok_or("this chat has no browser")?;
        if e.shared.lock().unwrap().live.is_none() {
            return Err("this chat's browser is not running".into());
        }
        Ok(e)
    }

    async fn set_hold(&self, entry: &Entry, held: bool) -> Result<(), String> {
        if entry.held() == held {
            return Ok(());
        }
        entry
            .ask()
            .set_held_by_user(held)
            .map_err(|e| format!("could not record who holds the browser: {e}"))?;
        self.sync_dialogs(entry).await;
        self.emit_status(entry);
        Ok(())
    }

    /// The user's click, key, wheel or text (the contract's `BrowserInput`).
    /// The first one takes the browser from the model. A bare pointer move
    /// never does, and is dropped while the model holds the browser: hovering
    /// over the picture must neither lock the model out nor move its mouse.
    pub async fn input(&self, chat: &str, input: Value) -> Result<(), String> {
        let e = self.live_entry(chat)?;
        let kind = input["kind"].as_str().unwrap_or_default();
        if !matches!(kind, "click" | "move" | "wheel" | "key" | "text") {
            return Err(format!("unknown input kind {kind:?}"));
        }
        if !e.held() {
            if kind == "move" {
                return Ok(());
            }
            self.set_hold(&e, true).await?;
        }
        e.touch();
        self.send(&e, json!({"op": "input", "input": input})).await;
        Ok(())
    }

    /// Back, forward, reload, or go to `url`; takes the browser too.
    pub async fn nav(&self, chat: &str, action: &str, url: Option<&str>) -> Result<(), String> {
        let e = self.live_entry(chat)?;
        if !matches!(action, "back" | "forward" | "reload" | "goto") {
            return Err(format!("unknown navigation {action:?}"));
        }
        if action == "goto" && url.is_none_or(|u| u.trim().is_empty()) {
            return Err("no address to go to".into());
        }
        self.set_hold(&e, true).await?;
        e.touch();
        self.send(&e, json!({"op": "nav", "action": action, "url": url}))
            .await;
        Ok(())
    }

    /// Take over (`true`) or give back (`false`).
    pub async fn hold(&self, chat: &str, held: bool) -> Result<BrowserStatus, String> {
        let e = self.live_entry(chat)?;
        self.set_hold(&e, held).await?;
        e.touch();
        Ok(e.status())
    }

    /// End the entry's browser, if one runs, and say so. The socket stays.
    async fn stop_browser(&self, entry: &Entry) {
        let live = {
            let mut s = entry.shared.lock().unwrap();
            s.conns = 0;
            let live = s.live.take();
            if live.is_some() {
                (s.url, s.title, s.pages) = (String::new(), String::new(), 0);
            }
            live
        };
        let Some((_, pgid)) = live else { return };
        // First, so the model is never refused for a browser that is gone.
        let _ = entry.ask().set_held_by_user(false);
        // Closing its stdin is the helper's cue to close the browser
        // itself; the signals are for one that does not.
        *entry.proc_.lock().await = None;
        #[cfg(unix)]
        crate::preview::stop_group(pgid).await;
        #[cfg(not(unix))]
        let _ = pgid;
        let _ = entry.ask().set_held_by_user(false);
        self.emit_status(entry);
    }

    /// The chat is gone: its browser ends, its socket with it.
    pub async fn close(&self, chat: &str) {
        let Some(e) = self.entries.lock().unwrap().remove(chat) else {
            return;
        };
        if let Some(task) = e.accept.lock().unwrap().take() {
            task.abort();
        }
        let _ = std::fs::remove_file(&e.socket);
        self.stop_browser(&e).await;
    }

    /// End every browser nobody has been attached to, watching or acting
    /// in for the idle time. The idle watch calls this.
    pub async fn sweep_idle(&self) {
        let entries: Vec<Arc<Entry>> = self.entries.lock().unwrap().values().cloned().collect();
        for e in entries {
            let idle = {
                let s = e.shared.lock().unwrap();
                s.live.is_some()
                    && s.conns == 0
                    && !s.watching
                    && s.last_active.is_none_or(|t| t.elapsed() >= self.idle)
            };
            if idle {
                self.stop_browser(&e).await;
            }
        }
    }

    /// Run [`Self::sweep_idle`] for as long as the browsers exist.
    pub fn spawn_idle_watch(self: &Arc<Self>) {
        let me = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(IDLE_TICK).await;
                let Some(this) = me.upgrade() else { return };
                this.sweep_idle().await;
            }
        });
    }

    /// Every browser, at once, without waiting on a runtime: the app's exit.
    pub fn shutdown_all(&self) {
        let entries: Vec<Arc<Entry>> = self
            .entries
            .lock()
            .unwrap()
            .drain()
            .map(|(_, e)| e)
            .collect();
        let mut groups = Vec::new();
        for e in &entries {
            if let Some(task) = e.accept.lock().unwrap().take() {
                task.abort();
            }
            let _ = std::fs::remove_file(&e.socket);
            if let Some((_, pgid)) = e.shared.lock().unwrap().live.take() {
                let _ = e.ask().set_held_by_user(false);
                groups.extend(pgid);
            }
        }
        #[cfg(unix)]
        {
            for g in &groups {
                crate::preview::signal_group(*g, libc::SIGTERM);
            }
            let until = Instant::now() + Duration::from_millis(500);
            while Instant::now() < until && groups.iter().any(|g| crate::preview::group_alive(*g)) {
                std::thread::sleep(Duration::from_millis(25));
            }
            for g in &groups {
                crate::preview::signal_group(*g, libc::SIGKILL);
            }
        }
        #[cfg(not(unix))]
        let _ = groups;
    }

    /// The live browser's process group (tests).
    pub fn pgid(&self, chat: &str) -> Option<u32> {
        self.get(chat)?.shared.lock().unwrap().live?.1
    }
}

impl Drop for Browsers {
    fn drop(&mut self) {
        self.shutdown_all();
    }
}

async fn write_line(stdin: &mut tokio::process::ChildStdin, msg: &Value) -> std::io::Result<()> {
    let mut line = msg.to_string();
    line.push('\n');
    stdin.write_all(line.as_bytes()).await?;
    stdin.flush().await
}

/// Remove the sockets of app processes that are gone from `dir`.
#[cfg(unix)]
pub fn sweep_sockets(dir: &Path) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for e in read.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(pid) = name
            .strip_prefix("cb-")
            .and_then(|r| r.strip_suffix(".sock"))
            .and_then(|r| r.split('-').next())
            .and_then(|p| p.parse::<i32>().ok())
        else {
            continue;
        };
        // SAFETY: signal 0 only checks; plain integers, no memory effects.
        let alive = unsafe { libc::kill(pid, 0) == 0 };
        if !alive {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    /// A scratch folder with a short path (sockets live in it).
    fn scratch(name: &str) -> PathBuf {
        static N: AtomicU64 = AtomicU64::new(0);
        let d = PathBuf::from("/tmp").join(format!(
            "nl-cb-{name}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// A stand-in for the browser's own socket: echoes what it is sent.
    fn echo_server(path: &Path) {
        let l = tokio::net::UnixListener::bind(path).unwrap();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = l.accept().await {
                tokio::spawn(async move {
                    let (mut r, mut w) = s.split();
                    let _ = tokio::io::copy(&mut r, &mut w).await;
                });
            }
        });
    }

    /// A stand-in for the helper: notes that it started, says it is ready
    /// at `endpoint` and on a page, then keeps every command it is sent
    /// until its stdin closes.
    fn fake_helper(dir: &Path, endpoint: &Path) -> Launcher {
        let script = r#"echo started >> "$0/spawns"
printf '%s\n' "{\"ev\":\"ready\",\"endpoint\":\"$1\"}"
printf '%s\n' '{"ev":"status","url":"http://example.test/","title":"Example","pages":1}'
cat >> "$0/received""#;
        Launcher {
            program: "/bin/sh".into(),
            args: vec![
                "-c".into(),
                script.into(),
                dir.to_string_lossy().into_owned(),
                endpoint.to_string_lossy().into_owned(),
            ],
        }
    }

    fn spawns(dir: &Path) -> usize {
        std::fs::read_to_string(dir.join("spawns"))
            .map(|s| s.lines().count())
            .unwrap_or(0)
    }

    async fn received(dir: &Path, needle: &str) -> bool {
        for _ in 0..100 {
            if std::fs::read_to_string(dir.join("received")).is_ok_and(|s| s.contains(needle)) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        false
    }

    /// What an MCP server does when a call runs: connect, talk, hang up at
    /// the message's end.
    async fn one_turn(socket: &Path, word: &str) -> String {
        let mut s = tokio::net::UnixStream::connect(socket).await.unwrap();
        s.write_all(word.as_bytes()).await.unwrap();
        let mut buf = vec![0u8; word.len()];
        tokio::time::timeout(Duration::from_secs(10), s.read_exact(&mut buf))
            .await
            .expect("the browser answered")
            .unwrap();
        String::from_utf8(buf).unwrap()
    }

    async fn until(mut f: impl FnMut() -> bool) -> bool {
        for _ in 0..150 {
            if f() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        false
    }

    struct Rig {
        dir: PathBuf,
        ask: PathBuf,
        browsers: Arc<Browsers>,
        events: Arc<Mutex<Vec<Event>>>,
    }

    fn rig(name: &str, idle: Duration) -> Rig {
        let dir = scratch(name);
        let real = dir.join("real.sock");
        echo_server(&real);
        let ask = dir.join("ask").join("chat-1");
        let browsers = Arc::new(
            Browsers::new(dir.join("socks"))
                .with_launcher(fake_helper(&dir, &real))
                .with_idle(idle),
        );
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&events);
        browsers.set_on_event(Arc::new(move |chat, e| {
            assert_eq!(chat, "chat-1");
            sink.lock().unwrap().push(e.clone());
        }));
        Rig {
            dir,
            ask,
            browsers,
            events,
        }
    }

    /// The lifecycle (item 508): a chat that is set up starts nothing; the
    /// first call that runs starts the browser; the next message's server
    /// reaches the same one; closing the chat ends it, socket and all.
    #[tokio::test]
    async fn a_browser_starts_on_first_use_is_shared_by_two_turns_and_ends_on_close() {
        let r = rig("life", IDLE);
        let b = &r.browsers;
        assert_eq!(b.status("chat-1"), None);
        let socket = b.endpoint("chat-1", &r.ask).unwrap();
        assert!(socket.exists());
        assert_eq!(
            b.endpoint("chat-1", &r.ask).unwrap(),
            socket,
            "one per chat"
        );
        // Set up, never used: no helper, no browser, nothing to show.
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(spawns(&r.dir), 0);
        assert_eq!(b.status("chat-1"), None);

        // Turn 1's first Playwright call.
        assert_eq!(one_turn(&socket, "turn one").await, "turn one");
        assert_eq!(spawns(&r.dir), 1);
        assert!(
            until(|| b
                .status("chat-1")
                .is_some_and(|s| s.url == "http://example.test/"))
            .await
        );
        let st = b.status("chat-1").unwrap();
        assert_eq!(
            (
                st.live,
                st.title.as_str(),
                st.held_by,
                st.width,
                st.height,
                st.pages
            ),
            (true, "Example", "model", 1280, 800, 1)
        );
        let pgid = b.pgid("chat-1").unwrap();

        // Turn 2, a new process: the same browser, not a second one.
        assert_eq!(one_turn(&socket, "turn two").await, "turn two");
        assert_eq!(spawns(&r.dir), 1);
        assert_eq!(b.pgid("chat-1"), Some(pgid));

        // The chat is closed.
        b.close("chat-1").await;
        assert!(until(|| !crate::preview::group_alive(pgid)).await);
        assert!(!socket.exists());
        assert_eq!(b.status("chat-1"), None);
        let last = r.events.lock().unwrap().last().cloned();
        assert!(matches!(last, Some(Event::Status(s)) if !s.live));
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    /// The hold: his first click takes the browser, the hook then refuses
    /// the model in the contract's words, Give back restores it, and a
    /// browser that ends takes the hold with it.
    #[tokio::test]
    async fn the_users_first_input_takes_the_browser_and_the_hook_refuses_the_model() {
        let r = rig("hold", IDLE);
        let b = &r.browsers;
        let socket = b.endpoint("chat-1", &r.ask).unwrap();
        // No browser yet: nothing to act in.
        assert!(
            b.input("chat-1", json!({"kind": "text", "text": "x"}))
                .await
                .is_err()
        );
        assert_eq!(one_turn(&socket, "go").await, "go");
        let call =
            json!({"hook_event_name": "PreToolUse", "tool_name": "mcp__playwright__browser_click",
            "tool_input": {}, "tool_use_id": "c1", "permission_mode": "auto"})
            .to_string();
        let ask = AskDir::new(&r.ask);
        ask.set_playwright_chat(true).unwrap();
        assert_eq!(crate::agent::ask::decide(&r.ask, &call).decision(), "allow");

        // A pointer move is not taking over, and does not reach the page.
        b.input("chat-1", json!({"kind": "move", "x": 5, "y": 5}))
            .await
            .unwrap();
        assert!(!ask.held_by_user());
        // A click is.
        let click = json!({"kind": "click", "x": 200, "y": 230, "button": "left", "clicks": 1, "modifiers": []});
        b.input("chat-1", click).await.unwrap();
        assert!(ask.held_by_user());
        assert_eq!(b.status("chat-1").unwrap().held_by, "user");
        assert!(received(&r.dir, r#""kind":"click""#).await);
        assert!(received(&r.dir, r#"{"auto":true,"op":"dialogs"}"#).await);
        let got = std::fs::read_to_string(r.dir.join("received")).unwrap();
        assert!(!got.contains(r#""kind":"move""#), "{got}");
        let refused = crate::agent::ask::decide(&r.ask, &call);
        assert_eq!(refused.decision(), "deny");
        assert_eq!(refused.reason(), Some(own_browser::HELD_BY_USER));
        // Held, his moves pass.
        b.input("chat-1", json!({"kind": "move", "x": 9, "y": 9}))
            .await
            .unwrap();
        assert!(received(&r.dir, r#""kind":"move""#).await);
        assert!(b.input("chat-1", json!({"kind": "poke"})).await.is_err());

        // Give back.
        let st = b.hold("chat-1", false).await.unwrap();
        assert_eq!(st.held_by, "model");
        assert_eq!(crate::agent::ask::decide(&r.ask, &call).decision(), "allow");
        // The address line takes it again.
        b.nav("chat-1", "goto", Some("example.com")).await.unwrap();
        assert!(ask.held_by_user());
        assert!(received(&r.dir, r#""action":"goto""#).await);
        assert!(b.nav("chat-1", "goto", None).await.is_err());
        assert!(b.nav("chat-1", "sideways", None).await.is_err());
        let holds: Vec<&'static str> = r
            .events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| match e {
                Event::Status(s) => Some(s.held_by),
                _ => None,
            })
            .collect();
        assert!(
            holds.windows(2).any(|w| w == ["model", "user"]),
            "{holds:?}"
        );
        assert!(
            holds.windows(2).any(|w| w == ["user", "model"]),
            "{holds:?}"
        );

        // The browser ends while he holds it: the model is not locked out.
        b.close("chat-1").await;
        assert!(!ask.held_by_user());
        assert_eq!(crate::agent::ask::decide(&r.ask, &call).decision(), "allow");
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    /// Item 550: the helper draws the page at 2 device pixels per CSS
    /// pixel and casts frames at that size (sharp on a Retina display),
    /// with the viewport still 1280×800 CSS px.
    #[test]
    fn the_helper_casts_retina_frames_of_the_same_page() {
        let js = own_browser::HELPER_JS;
        assert!(js.contains("const SCALE = 2;"));
        assert!(
            js.contains("viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: SCALE")
        );
        assert!(js.contains("size: { width: WIDTH * SCALE, height: HEIGHT * SCALE }"));
        assert!(js.contains(&format!("const WIDTH = {WIDTH};")));
        assert!(js.contains(&format!("const HEIGHT = {HEIGHT};")));
    }

    /// Item 557 (a bug he reported): the browser is kept between messages
    /// for its logins, but it is in use only while a message's MCP server
    /// is attached. The window hears both edges at once, so the chat's
    /// offer ("Claude's browser · open") goes when the turn ends instead of
    /// staying for the 30-minute idle end.
    #[tokio::test]
    async fn the_browser_reads_idle_the_moment_the_message_using_it_ends() {
        let r = rig("in-use", IDLE);
        let b = &r.browsers;
        let socket = b.endpoint("chat-1", &r.ask).unwrap();
        // A message's MCP server, attached and talking.
        let mut conn = tokio::net::UnixStream::connect(&socket).await.unwrap();
        conn.write_all(b"hi").await.unwrap();
        let mut buf = [0u8; 2];
        tokio::time::timeout(Duration::from_secs(10), conn.read_exact(&mut buf))
            .await
            .expect("the browser answered")
            .unwrap();
        assert!(until(|| b.status("chat-1").is_some_and(|s| s.live && s.in_use)).await);
        let said_in_use = || {
            r.events.lock().unwrap().iter().rev().find_map(|e| match e {
                Event::Status(s) => Some(s.in_use),
                _ => None,
            })
        };
        assert!(until(|| said_in_use() == Some(true)).await);
        // A second message attached at once (a subagent's call in the same
        // process shares the connection; another turn would add one).
        assert_eq!(one_turn(&socket, "two").await, "two");
        assert!(
            b.status("chat-1").unwrap().in_use,
            "the first is still attached"
        );

        // The message ends: its server hangs up.
        drop(conn);
        assert!(until(|| said_in_use() == Some(false)).await);
        let st = b.status("chat-1").unwrap();
        assert!(st.live, "kept for its logins");
        assert!(!st.in_use);
        b.close("chat-1").await;
        assert!(!b.status("chat-1").is_some_and(|s| s.in_use));
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    /// Item 552: a takeover ends with the tab. He takes the browser, then
    /// the last tab watching it goes (closed, to the back, a chat switch,
    /// the window hidden): the browser is the model's again, the window is
    /// told, and the model's next call is allowed. A tab still watching
    /// keeps his hold.
    #[tokio::test]
    async fn closing_the_tab_while_he_holds_the_browser_gives_it_back() {
        let r = rig("handback", IDLE);
        let b = &r.browsers;
        let socket = b.endpoint("chat-1", &r.ask).unwrap();
        assert_eq!(one_turn(&socket, "go").await, "go");
        let call =
            json!({"hook_event_name": "PreToolUse", "tool_name": "mcp__playwright__browser_click",
            "tool_input": {}, "tool_use_id": "c1", "permission_mode": "auto"})
            .to_string();
        let ask = AskDir::new(&r.ask);
        ask.set_playwright_chat(true).unwrap();

        b.watch("chat-1", true).await;
        b.hold("chat-1", true).await.unwrap();
        assert!(ask.held_by_user());
        assert_eq!(crate::agent::ask::decide(&r.ask, &call).decision(), "deny");

        // The tab closes.
        b.watch("chat-1", false).await;
        assert!(!ask.held_by_user());
        assert_eq!(b.status("chat-1").unwrap().held_by, "model");
        assert_eq!(crate::agent::ask::decide(&r.ask, &call).decision(), "allow");
        let last = r.events.lock().unwrap().iter().rev().find_map(|e| match e {
            Event::Status(s) => Some(s.held_by),
            _ => None,
        });
        assert_eq!(last, Some("model"));

        // Reopened, his click takes it again; the browser still runs.
        b.watch("chat-1", true).await;
        let click = json!({"kind": "click", "x": 1, "y": 1, "button": "left", "clicks": 1, "modifiers": []});
        b.input("chat-1", click).await.unwrap();
        assert!(ask.held_by_user());
        // Watching on (a second view coming) never gives it back.
        b.watch("chat-1", true).await;
        assert!(ask.held_by_user());
        // A watch-off with the model holding changes nothing.
        b.hold("chat-1", false).await.unwrap();
        b.watch("chat-1", false).await;
        assert!(!ask.held_by_user());
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    /// Frames reach the window only while a tab watches; an unused browser
    /// ends after the idle time, never while watched or attached, and the
    /// chat's next call starts a new one at the same socket.
    #[tokio::test]
    async fn frames_flow_only_while_watched_and_an_idle_browser_ends_and_restarts() {
        let r = rig("idle", Duration::from_millis(150));
        let b = &r.browsers;
        let socket = b.endpoint("chat-1", &r.ask).unwrap();
        assert_eq!(one_turn(&socket, "a").await, "a");
        let e = b.get("chat-1").unwrap();
        let frame = json!({"ev": "frame", "seq": 1, "jpeg": "AAAA", "w": 1280, "h": 800});
        let frames = |r: &Rig| {
            r.events
                .lock()
                .unwrap()
                .iter()
                .filter(|e| matches!(e, Event::Frame { .. }))
                .count()
        };
        b.from_helper(&e, &frame);
        assert_eq!(frames(&r), 0, "nobody watches");
        b.watch("chat-1", true).await;
        assert!(received(&r.dir, r#"{"on":true,"op":"watch"}"#).await);
        b.from_helper(&e, &frame);
        assert_eq!(frames(&r), 1);
        b.from_helper(
            &e,
            &json!({"ev": "dialog", "kind": "alert", "message": "hi"}),
        );
        assert!(r.events.lock().unwrap().contains(&Event::Dialog {
            kind: "alert".into(),
            message: "hi".into()
        }));

        // Watched: kept, however long.
        tokio::time::sleep(Duration::from_millis(250)).await;
        b.sweep_idle().await;
        assert!(b.status("chat-1").unwrap().live);
        // Attached (a message is running): kept.
        b.watch("chat-1", false).await;
        let mut held_open = tokio::net::UnixStream::connect(&socket).await.unwrap();
        held_open.write_all(b"x").await.unwrap();
        let mut one = [0u8; 1];
        held_open.read_exact(&mut one).await.unwrap();
        tokio::time::sleep(Duration::from_millis(250)).await;
        b.sweep_idle().await;
        assert!(b.status("chat-1").unwrap().live);
        // Neither, for the idle time: ended, the socket kept.
        drop(held_open);
        let pgid = b.pgid("chat-1").unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        b.sweep_idle().await;
        let st = b.status("chat-1").unwrap();
        assert!(!st.live);
        assert!(until(|| !crate::preview::group_alive(pgid)).await);
        assert!(socket.exists());
        // The next call starts a new browser.
        assert_eq!(one_turn(&socket, "b").await, "b");
        assert_eq!(spawns(&r.dir), 2);
        assert!(b.status("chat-1").unwrap().live);
        b.shutdown_all();
        assert!(!socket.exists());
        let _ = std::fs::remove_dir_all(&r.dir);
    }

    /// A helper that never becomes ready fails the call, and leaves nothing
    /// running and nothing to show.
    #[tokio::test]
    async fn a_helper_that_dies_before_ready_starts_nothing() {
        let dir = scratch("dead");
        let b = Arc::new(Browsers::new(dir.join("socks")).with_launcher(Launcher {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "exit 3".into()],
        }));
        let socket = b.endpoint("chat-1", &dir.join("ask")).unwrap();
        let mut s = tokio::net::UnixStream::connect(&socket).await.unwrap();
        let mut buf = [0u8; 1];
        // The connection is dropped: the MCP server reports it could not
        // reach the browser.
        let n = tokio::time::timeout(Duration::from_secs(10), s.read(&mut buf))
            .await
            .unwrap()
            .unwrap_or(0);
        assert_eq!(n, 0);
        assert_eq!(b.status("chat-1"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sockets_of_dead_app_processes_are_swept() {
        let dir = scratch("sweep");
        let dead = dir.join("cb-999999-00aa.sock");
        let mine = dir.join(format!("cb-{}-00aa.sock", std::process::id()));
        let other = dir.join("preview-999999.sock");
        for p in [&dead, &mine, &other] {
            std::fs::write(p, b"").unwrap();
        }
        sweep_sockets(&dir);
        assert!(!dead.exists() && mine.exists() && other.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
