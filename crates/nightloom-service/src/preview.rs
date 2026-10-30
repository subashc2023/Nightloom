//! A chat's preview: a long-running command — a dev server — that the app
//! runs for a chat and keeps up between its messages (nightshift item 430,
//! 2026-10-27; the 427 review's fix 2).
//!
//! **Why the app runs it.** A Claude Code chat's message is one `claude -p`
//! process; whatever the model starts in it lives or dies by what that
//! process and the CLI do at its end, which Nightloom does not control and
//! the 427 review could not measure (`external` B10: background tasks die
//! with the process). Item 430's step 1 measured Nightloom's own side
//! (`agent::tests::a_detached_server_outlives_*`): Nightloom kills no
//! process group at a turn's end or at a Stop, so it is not what ends such a
//! server — the CLI's own exit is the open question, left to item 429's
//! real-model run. A preview owned by the app does not depend on the
//! answer: the desktop starts it, in its own process group, and it ends
//! only when he presses Stop, the model calls `preview` with `stop`, a new
//! start replaces it, or the app quits.
//!
//! **How the model reaches it.** The `preview` tool on Nightloom's own MCP
//! server ([`PreviewTool`]), served when the desktop names its socket
//! (`--preview <socket>`) and the chat (`--preview-chat <id>`, rewritten
//! into the server's arguments before each turn by [`with_chat`]). The MCP
//! server is the CLI's child and ends with the message, so the tool owns
//! nothing: it sends one JSON line to the desktop over a Unix socket
//! ([`serve_socket`]) and the desktop's [`Previews`] does the work. A tool
//! rather than a shell command the model runs (`nightloom preview start`)
//! because the CLI's permission layer and Nightloom's Ask hook and Chat
//! policy already judge every `mcp__nightloom__*` call by name, the
//! server already knows the chat's folder (`--root`), and the app's binary
//! is not on the model's `PATH`.
//!
//! **One per chat; ports checked.** A start in a chat that has one stops
//! the old one first. A port another chat's preview holds, or anything
//! answers on, is refused before anything is spawned. The command runs
//! under `/bin/sh -c` in the chat's folder with `PORT` set, its output kept
//! as the last [`LOG_LINES`] lines.
//!
//! **No orphans.** Every preview is its own process group, and a stop or
//! the app's exit signals the group, not one pid, so `npm run dev`'s
//! children go with it. A watchdog in the same group ends it if the app
//! dies without running its exit (a crash, a SIGKILL).

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nightloom_core::ToolDef;
use nightloom_core::tool::{CancellationToken, Effect, Tool};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader};
use tokio::process::Command;

/// The tool's name on the server; the CLI calls it `mcp__nightloom__preview`.
pub const TOOL_NAME: &str = "preview";
/// How many lines of the command's output are kept, both streams together.
pub const LOG_LINES: usize = 200;
/// How many of them the model's reply carries.
const REPLY_LINES: usize = 30;
/// A longer line is cut: a minified bundle printed whole would fill the
/// buffer's memory, not its line count.
const LINE_CAP: usize = 2000;
/// How long a start waits for the port to answer before replying.
pub const READY_WAIT: Duration = Duration::from_secs(20);
/// How long a stop waits on SIGTERM before SIGKILL.
const STOP_GRACE: Duration = Duration::from_millis(1500);

/// Where a preview is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    /// Spawned; nothing answers on the port yet.
    Starting,
    /// Something answers on the port.
    Listening,
    /// The command ended and nothing answers on the port.
    Exited,
}

/// One preview as the window and the model see it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Snapshot {
    pub chat: String,
    pub command: String,
    pub cwd: PathBuf,
    pub port: u16,
    pub url: String,
    pub status: Status,
    /// The shell's exit code once it ended (`None` on a signal).
    pub exit_code: Option<i32>,
    /// The last [`LOG_LINES`] lines, oldest first.
    pub log: Vec<String>,
    /// When it was started, Unix milliseconds.
    pub started_ms: i64,
    /// The process group (the shell's pid).
    pub pgid: Option<u32>,
    /// It ended with the app — a quit, a restart, a crash — and was found
    /// in the record at the next launch (nightshift item 445). Always
    /// [`Status::Exited`] then.
    #[serde(default)]
    pub ended_by_app: bool,
}

struct State {
    status: Status,
    exit_code: Option<i32>,
}

struct Entry {
    command: String,
    cwd: PathBuf,
    port: u16,
    pgid: Option<u32>,
    log: Arc<Mutex<VecDeque<String>>>,
    state: Arc<Mutex<State>>,
    started_ms: i64,
    generation: u64,
    /// The model has been told it ended (item 445): by the note before a
    /// turn ([`Previews::take_ended_note`]) or by a `status` reply.
    told: bool,
    /// Restored from the record at launch: it ended with the app.
    ended_by_app: bool,
}

impl Entry {
    fn snapshot(&self, chat: &str) -> Snapshot {
        let state = self.state.lock().unwrap();
        Snapshot {
            chat: chat.to_string(),
            command: self.command.clone(),
            cwd: self.cwd.clone(),
            port: self.port,
            url: url_for(self.port),
            status: state.status,
            exit_code: state.exit_code,
            log: self.log.lock().unwrap().iter().cloned().collect(),
            started_ms: self.started_ms,
            pgid: self.pgid,
            ended_by_app: self.ended_by_app,
        }
    }

    fn record(&self) -> Record {
        let state = self.state.lock().unwrap();
        Record {
            command: self.command.clone(),
            cwd: self.cwd.clone(),
            port: self.port,
            started_ms: self.started_ms,
            pid: std::process::id(),
            exited: state.status == Status::Exited,
            exit_code: state.exit_code,
            ended_by_app: self.ended_by_app,
            told: self.told,
        }
    }
}

/// One chat's preview as the record on disk keeps it (item 445): enough
/// to say, after the app restarts, that it ended and how to start it again.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Record {
    command: String,
    cwd: PathBuf,
    port: u16,
    started_ms: i64,
    /// The app process that ran it. A record whose process is gone is a
    /// preview that ended with it; one whose process lives is another
    /// running app's (a dev build on the same home) and is left alone.
    pid: u32,
    #[serde(default)]
    exited: bool,
    #[serde(default)]
    exit_code: Option<i32>,
    #[serde(default)]
    ended_by_app: bool,
    #[serde(default)]
    told: bool,
}

/// Told of every change of a chat's preview: its new snapshot, or `None`
/// once it is gone. Called with no lock held.
pub type OnChange = Arc<dyn Fn(&str, Option<&Snapshot>) + Send + Sync>;

/// The app's previews, one per chat.
pub struct Previews {
    entries: Mutex<HashMap<String, Entry>>,
    on_change: Mutex<Option<OnChange>>,
    generation: AtomicU64,
    ready_wait: Duration,
    /// The pid the watchdog watches; `None`, no watchdog (tests of the
    /// watchdog itself set another).
    watch_pid: Option<u32>,
    /// Where every chat's preview is recorded, so the next launch knows
    /// which ended with the app (item 445). `None`, nothing recorded.
    record: Option<PathBuf>,
    /// One writer of the record at a time within this process.
    record_lock: Mutex<()>,
}

impl Default for Previews {
    fn default() -> Self {
        Self::new()
    }
}

impl Previews {
    pub fn new() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            on_change: Mutex::new(None),
            generation: AtomicU64::new(1),
            ready_wait: READY_WAIT,
            watch_pid: Some(std::process::id()),
            record: None,
            record_lock: Mutex::new(()),
        }
    }

    /// The same, recording its previews at `path` (item 445) — the
    /// desktop's [`record_path`].
    pub fn with_record(mut self, path: PathBuf) -> Self {
        self.record = Some(path);
        self
    }

    fn read_records(path: &Path) -> HashMap<String, Record> {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    /// Write one chat's record (`None` removes it), leaving every other
    /// chat's as it is — another app process on the same home has its own.
    fn save_record(&self, chat: &str, rec: Option<Record>) {
        let Some(path) = &self.record else { return };
        let _g = self.record_lock.lock().unwrap();
        let mut all = Self::read_records(path);
        match rec {
            Some(r) => {
                all.insert(chat.to_string(), r);
            }
            None => {
                if all.remove(chat).is_none() {
                    return;
                }
            }
        }
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
        if let Ok(text) = serde_json::to_string_pretty(&all)
            && std::fs::write(&tmp, text).is_ok()
        {
            let _ = std::fs::rename(&tmp, path);
        }
    }

    fn save_entry_record(&self, chat: &str) {
        let rec = self.entries.lock().unwrap().get(chat).map(Entry::record);
        if let Some(rec) = rec {
            self.save_record(chat, Some(rec));
        }
    }

    /// At launch: every recorded preview whose app process is gone ended
    /// with it — each comes back as an exited preview, marked
    /// `ended_by_app`, for the chip to offer Restart and the chat's next
    /// turn to tell the model (item 445). A record of this process's own
    /// pid is a reused pid, so it counts as gone too. Returns how many.
    pub fn restore_ended(&self) -> usize {
        let Some(path) = &self.record else { return 0 };
        let me = std::process::id();
        let records = {
            let _g = self.record_lock.lock().unwrap();
            Self::read_records(path)
        };
        let mut n = 0;
        for (chat, rec) in records {
            if rec.pid != me && pid_alive(rec.pid) {
                continue;
            }
            if self.entries.lock().unwrap().contains_key(&chat) {
                continue;
            }
            let entry = Entry {
                command: rec.command,
                cwd: rec.cwd,
                port: rec.port,
                pgid: None,
                log: Arc::new(Mutex::new(VecDeque::new())),
                state: Arc::new(Mutex::new(State {
                    status: Status::Exited,
                    exit_code: if rec.exited { rec.exit_code } else { None },
                })),
                started_ms: rec.started_ms,
                generation: self.generation.fetch_add(1, Ordering::SeqCst),
                told: rec.told,
                // A preview that had already exited on its own before the
                // app went keeps saying so.
                ended_by_app: rec.ended_by_app || !rec.exited,
            };
            self.entries.lock().unwrap().insert(chat.clone(), entry);
            n += 1;
            // Rewritten under this process, so a second launch while this
            // one runs leaves it alone; still ended.
            self.save_entry_record(&chat);
        }
        n
    }

    /// The note the chat's next turn carries when its preview ended and
    /// the model has not been told (item 445), once: taking it marks the
    /// preview told. `None` when there is nothing to tell.
    pub fn take_ended_note(&self, chat: &str) -> Option<String> {
        let snap = {
            let mut entries = self.entries.lock().unwrap();
            let e = entries.get_mut(chat)?;
            if e.told || e.state.lock().unwrap().status != Status::Exited {
                return None;
            }
            e.told = true;
            e.snapshot(chat)
        };
        self.save_entry_record(chat);
        Some(ended_note(&snap))
    }

    /// The model saw the chat's preview ended (a `status` reply): no note
    /// next turn.
    fn mark_told_if_ended(&self, chat: &str) {
        let changed = {
            let mut entries = self.entries.lock().unwrap();
            match entries.get_mut(chat) {
                Some(e) if !e.told && e.state.lock().unwrap().status == Status::Exited => {
                    e.told = true;
                    true
                }
                _ => false,
            }
        };
        if changed {
            self.save_entry_record(chat);
        }
    }

    /// His Restart on the chip (item 445): the chat's preview started again
    /// with the command, folder and port it had.
    pub async fn restart(self: &Arc<Self>, chat: &str) -> Result<Snapshot, String> {
        let (cwd, command, port) = {
            let entries = self.entries.lock().unwrap();
            let e = entries
                .get(chat)
                .ok_or_else(|| "this chat has no preview to restart".to_string())?;
            (e.cwd.clone(), e.command.clone(), e.port)
        };
        self.start(chat, &cwd, &command, port).await
    }

    /// The same, waiting `ready_wait` for a port rather than [`READY_WAIT`].
    pub fn with_ready_wait(mut self, ready_wait: Duration) -> Self {
        self.ready_wait = ready_wait;
        self
    }

    /// The same, its watchdogs watching `pid` rather than this process.
    pub fn watching(mut self, pid: u32) -> Self {
        self.watch_pid = Some(pid);
        self
    }

    pub fn set_on_change(&self, f: OnChange) {
        *self.on_change.lock().unwrap() = Some(f);
    }

    fn changed(&self, chat: &str, snap: Option<&Snapshot>) {
        let f = self.on_change.lock().unwrap().clone();
        if let Some(f) = f {
            f(chat, snap);
        }
    }

    /// The chat's preview, if it has one.
    pub fn status(&self, chat: &str) -> Option<Snapshot> {
        self.entries
            .lock()
            .unwrap()
            .get(chat)
            .map(|e| e.snapshot(chat))
    }

    /// Every preview, for the window's first paint.
    pub fn all(&self) -> Vec<Snapshot> {
        self.entries
            .lock()
            .unwrap()
            .iter()
            .map(|(chat, e)| e.snapshot(chat))
            .collect()
    }

    /// Start `command` in `cwd` as the chat's preview on `port`, replacing
    /// the one it has. Waits until the port answers, the command ends, or
    /// the ready wait runs out, and says which in the snapshot's status.
    pub async fn start(
        self: &Arc<Self>,
        chat: &str,
        cwd: &Path,
        command: &str,
        port: u16,
    ) -> Result<Snapshot, String> {
        let command = command.trim();
        if command.is_empty() {
            return Err("the command is empty".into());
        }
        if port < 1024 {
            return Err(format!(
                "port {port} is below 1024; pick a port from 1024 to 65535"
            ));
        }
        if chat.is_empty() {
            return Err("no chat to run a preview for".into());
        }
        if !cwd.is_dir() {
            return Err(format!(
                "the chat's folder {} is not a folder",
                cwd.display()
            ));
        }
        // Restart replaces: the chat's old preview goes first, and its port
        // with it.
        let old = self.entries.lock().unwrap().remove(chat);
        if let Some(old) = old {
            stop_group(old.pgid).await;
            wait_port_free(old.port, Duration::from_secs(3)).await;
        }
        let other = self
            .entries
            .lock()
            .unwrap()
            .iter()
            .find(|(c, e)| e.port == port && c.as_str() != chat)
            .map(|(c, _)| c.clone());
        if let Some(other) = other {
            return Err(format!(
                "port {port} is held by another chat's preview ({other}); pick another port"
            ));
        }
        if port_busy(port) {
            return Err(format!(
                "port {port} is already in use on this Mac; pick another port (or stop what holds it)"
            ));
        }

        let mut cmd = Command::new("/bin/sh");
        cmd.arg("-c")
            .arg(command)
            .current_dir(cwd)
            .env("PORT", port.to_string())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        cmd.process_group(0);
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("could not start /bin/sh: {e}"))?;
        let pgid = child.id();
        let log: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
        if let Some(out) = child.stdout.take() {
            tokio::spawn(read_lines(out, Arc::clone(&log)));
        }
        if let Some(err) = child.stderr.take() {
            tokio::spawn(read_lines(err, Arc::clone(&log)));
        }
        #[cfg(unix)]
        if let (Some(pgid), Some(watch)) = (pgid, self.watch_pid) {
            spawn_watchdog(pgid, watch);
        }
        let state = Arc::new(Mutex::new(State {
            status: Status::Starting,
            exit_code: None,
        }));
        let generation = self.generation.fetch_add(1, Ordering::SeqCst);
        let entry = Entry {
            command: command.to_string(),
            cwd: cwd.to_path_buf(),
            port,
            pgid,
            log,
            state: Arc::clone(&state),
            started_ms: chrono::Utc::now().timestamp_millis(),
            generation,
            told: false,
            ended_by_app: false,
        };
        let snap = entry.snapshot(chat);
        let rec = entry.record();
        self.entries.lock().unwrap().insert(chat.to_string(), entry);
        self.save_record(chat, Some(rec));
        self.changed(chat, Some(&snap));

        // The shell's end: its code, and Exited if nothing answers on the
        // port then (a command that forks a server and returns is still
        // Listening). Then the group's leftovers — the watchdog — go.
        let me = Arc::downgrade(self);
        let chat_owned = chat.to_string();
        let state_w = Arc::clone(&state);
        tokio::spawn(async move {
            let code = child.wait().await.ok().and_then(|s| s.code());
            let listening = port_answers(port);
            {
                let mut st = state_w.lock().unwrap();
                st.exit_code = code;
                st.status = if listening {
                    Status::Listening
                } else {
                    Status::Exited
                };
            }
            if !listening {
                #[cfg(unix)]
                if let Some(pgid) = pgid {
                    signal_group(pgid, libc::SIGKILL);
                }
            }
            if let Some(me) = me.upgrade() {
                let snap = {
                    let entries = me.entries.lock().unwrap();
                    entries
                        .get(&chat_owned)
                        .filter(|e| e.generation == generation)
                        .map(|e| e.snapshot(&chat_owned))
                };
                if let Some(snap) = snap {
                    // Recorded as exited, so a restart before the next
                    // turn still tells the model how it ended (item 445).
                    me.save_entry_record(&chat_owned);
                    me.changed(&chat_owned, Some(&snap));
                }
            }
        });

        let deadline = tokio::time::Instant::now() + self.ready_wait;
        loop {
            if state.lock().unwrap().status == Status::Exited {
                break;
            }
            if port_answers(port) {
                let became = {
                    let mut st = state.lock().unwrap();
                    let was = st.status;
                    st.status = Status::Listening;
                    was != Status::Listening
                };
                if became {
                    let snap = self.status(chat);
                    self.changed(chat, snap.as_ref());
                }
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        // Let the log readers catch up with what came out before the end.
        tokio::time::sleep(Duration::from_millis(50)).await;
        self.status(chat)
            .ok_or_else(|| "the preview was stopped while it started".to_string())
    }

    /// Stop the chat's preview: SIGTERM to its group, SIGKILL after a grace.
    /// The snapshot it had, or `None` when there was none.
    pub async fn stop(&self, chat: &str) -> Option<Snapshot> {
        let entry = self.entries.lock().unwrap().remove(chat)?;
        let snap = entry.snapshot(chat);
        stop_group(entry.pgid).await;
        self.save_record(chat, None);
        self.changed(chat, None);
        Some(snap)
    }

    /// Every preview, at once, without waiting on a runtime: the app's exit.
    /// SIGTERM to each group, a short grace, SIGKILL to what is left. The
    /// record is left as it is: the next launch reads it to tell each chat
    /// its preview ended with the app (item 445).
    pub fn shutdown_all(&self) {
        let entries: Vec<(String, Entry)> = self.entries.lock().unwrap().drain().collect();
        if entries.is_empty() {
            return;
        }
        #[cfg(unix)]
        {
            for (_, e) in &entries {
                if let Some(pgid) = e.pgid {
                    signal_group(pgid, libc::SIGTERM);
                }
            }
            let until = std::time::Instant::now() + Duration::from_millis(500);
            while std::time::Instant::now() < until
                && entries.iter().any(|(_, e)| e.pgid.is_some_and(group_alive))
            {
                std::thread::sleep(Duration::from_millis(25));
            }
            for (_, e) in &entries {
                if let Some(pgid) = e.pgid {
                    signal_group(pgid, libc::SIGKILL);
                }
            }
        }
        for (chat, _) in &entries {
            self.changed(chat, None);
        }
    }
}

impl Drop for Previews {
    fn drop(&mut self) {
        self.shutdown_all();
    }
}

/// What the chat's next turn tells the model of a preview that ended
/// (item 445): what it was, how it ended, and how to start it again.
pub fn ended_note(s: &Snapshot) -> String {
    let how = if s.ended_by_app {
        "it ended when the Nightloom app quit or restarted".to_string()
    } else {
        match s.exit_code {
            Some(c) => format!("its command ended (exit code {c}) and nothing answers on the port"),
            None => {
                "its command was stopped by a signal and nothing answers on the port".to_string()
            }
        }
    };
    let mut note = format!(
        "[Nightloom: this chat's preview `{}` (port {}, in {}) is no longer running — {how}. \
         If you still need it, start it again with the preview tool (action \"start\"); the user can \
         also press Restart on its chip.]",
        s.command,
        s.port,
        s.cwd.display()
    );
    if !s.ended_by_app && !s.log.is_empty() {
        let tail: Vec<&str> = s
            .log
            .iter()
            .rev()
            .take(10)
            .rev()
            .map(String::as_str)
            .collect();
        note.push_str(&format!(
            "\nIts last {} log lines:\n{}",
            tail.len(),
            tail.join("\n")
        ));
    }
    note
}

#[cfg(unix)]
fn pid_alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[cfg(not(unix))]
fn pid_alive(_pid: u32) -> bool {
    false
}

pub fn url_for(port: u16) -> String {
    format!("http://localhost:{port}")
}

/// Whether something answers on the port, on either loopback.
pub fn port_answers(port: u16) -> bool {
    let t = Duration::from_millis(200);
    std::net::TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), t).is_ok()
        || std::net::TcpStream::connect_timeout(
            &std::net::SocketAddr::from((std::net::Ipv6Addr::LOCALHOST, port)),
            t,
        )
        .is_ok()
}

/// Whether the port is taken: something answers on it, on either loopback
/// (a listener on the wildcard address answers on both).
///
/// ~~2026-10-27 (item 430): "or it cannot be bound" — a trial bind of
/// 127.0.0.1 as well.~~ 2026-10-29 (item 473): no trial bind. macOS has no
/// atomic close-on-exec for a new socket (`SOCK_CLOEXEC` is Linux's): Rust
/// makes the socket, then marks it a moment later, and a child another
/// thread spawns in that moment — a preview's server, its watchdog, the
/// CLI — inherits it unmarked and keeps it past exec. The trial bind's
/// socket is a listener on the very port asked for, so a child that
/// caught it held the port bound and listening after the check had
/// dropped it, for the child's whole life, and the next start read "already
/// in use on this Mac" with nothing of his on it (measured with `lsof`:
/// one listening socket shared by two other previews' servers, a watchdog
/// shell and its `sleep`; 9 runs in 15 under load). Asking by connecting
/// leaves no socket on the port to inherit. What the bind also caught — a
/// socket bound to the port but not listening — the server's own bind
/// still refuses, and the chip shows its "Address already in use" line.
pub fn port_busy(port: u16) -> bool {
    port_answers(port)
}

async fn wait_port_free(port: u16, within: Duration) {
    let until = tokio::time::Instant::now() + within;
    while port_answers(port) && tokio::time::Instant::now() < until {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn read_lines(reader: impl AsyncRead + Unpin, log: Arc<Mutex<VecDeque<String>>>) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(mut line)) = lines.next_line().await {
        if line.len() > LINE_CAP {
            let mut cut = LINE_CAP;
            while !line.is_char_boundary(cut) {
                cut -= 1;
            }
            line.truncate(cut);
            line.push('…');
        }
        let mut log = log.lock().unwrap();
        log.push_back(line);
        while log.len() > LOG_LINES {
            log.pop_front();
        }
    }
}

#[cfg(unix)]
fn signal_group(pgid: u32, sig: libc::c_int) {
    // SAFETY: killpg takes plain integers and has no memory effects.
    unsafe {
        libc::killpg(pgid as libc::pid_t, sig);
    }
}

#[cfg(unix)]
fn group_alive(pgid: u32) -> bool {
    // SAFETY: as above; signal 0 only checks.
    unsafe { libc::killpg(pgid as libc::pid_t, 0) == 0 }
}

async fn stop_group(pgid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pgid) = pgid {
        signal_group(pgid, libc::SIGTERM);
        let until = tokio::time::Instant::now() + STOP_GRACE;
        while group_alive(pgid) && tokio::time::Instant::now() < until {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        signal_group(pgid, libc::SIGKILL);
    }
    #[cfg(not(unix))]
    let _ = pgid;
}

/// A shell in the preview's own group that ends the group once `watch` is
/// gone — the app killed or crashed past its exit handler. In the group,
/// so a stop takes it too.
#[cfg(unix)]
fn spawn_watchdog(pgid: u32, watch: u32) {
    let script =
        format!("while kill -0 {watch} 2>/dev/null; do sleep 2; done; kill -KILL -- -{pgid}");
    let mut cmd = std::process::Command::new("/bin/sh");
    cmd.arg("-c")
        .arg(script)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    use std::os::unix::process::CommandExt;
    cmd.process_group(pgid as i32);
    if let Ok(mut child) = cmd.spawn() {
        // Reaped off the runtime so it never lingers as a zombie.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
}

// ---- the desktop's socket -------------------------------------------------

/// One request from the tool to the desktop, as one JSON line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Request {
    Start {
        chat: String,
        cwd: PathBuf,
        command: String,
        port: u16,
    },
    Stop {
        chat: String,
    },
    Status {
        chat: String,
    },
}

/// The desktop's answer, as one JSON line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Reply {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<Snapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The socket's path for this app process, under the config dir. Per
/// process, so a dev build and the installed app never answer each
/// other's chats.
pub fn socket_path(config: &Path) -> PathBuf {
    config
        .join("run")
        .join(format!("preview-{}.sock", std::process::id()))
}

/// Where the previews are recorded across launches (item 445).
pub fn record_path(config: &Path) -> PathBuf {
    config.join("run").join("previews.json")
}

/// The longest socket path the OS takes: `sun_path` is 104 bytes on macOS
/// and the BSDs, 108 on Linux, its last byte the terminating NUL.
#[cfg(any(target_os = "linux", target_os = "android"))]
pub const SUN_PATH_MAX: usize = 108;
#[cfg(not(any(target_os = "linux", target_os = "android")))]
pub const SUN_PATH_MAX: usize = 104;

/// Whether `path` fits in `sun_path`, its NUL included.
pub fn socket_path_fits(path: &Path) -> bool {
    path.as_os_str().len() < SUN_PATH_MAX
}

/// The short folder a socket falls back to when the config dir's path is
/// too long for one (item 444; the 429 run lost its previews to a
/// ~150-character `NIGHTLOOM_HOME`): `/tmp/nightloom-<uid>`, this user's
/// alone (mode 0700).
#[cfg(unix)]
pub fn short_socket_dir() -> PathBuf {
    // SAFETY: getuid has no failure mode and no memory effects.
    let uid = unsafe { libc::getuid() };
    PathBuf::from("/tmp").join(format!("nightloom-{uid}"))
}

/// The paths to try for this process's socket, in order: under the config
/// dir when it fits `sun_path`, then [`short_socket_dir`] (item 444).
#[cfg(unix)]
pub fn socket_candidates(config: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let preferred = socket_path(config);
    if socket_path_fits(&preferred) {
        out.push(preferred);
    }
    out.push(short_socket_dir().join(format!("preview-{}.sock", std::process::id())));
    out
}

/// Make `dir` a folder only this user can enter: created 0700, and refused
/// when it is a link or someone else's (a shared `/tmp` must not hand a
/// planted folder our socket).
#[cfg(unix)]
pub fn ensure_private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    match std::fs::symlink_metadata(dir) {
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(dir)?;
        }
        Err(e) => return Err(e),
    }
    let meta = std::fs::symlink_metadata(dir)?;
    // SAFETY: as above.
    let uid = unsafe { libc::getuid() };
    if !meta.file_type().is_dir() || meta.uid() != uid {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("{} is not a folder of this user's", dir.display()),
        ));
    }
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
}

/// Bind this process's socket at the first of [`socket_candidates`] that
/// takes it (item 444). The path bound, or every attempt's error in one
/// line — what the window shows as "preview unavailable".
#[cfg(unix)]
pub fn bind_preview_socket(
    config: &Path,
) -> Result<(PathBuf, std::os::unix::net::UnixListener), String> {
    let preferred = socket_path(config);
    let mut errors = Vec::new();
    if !socket_path_fits(&preferred) {
        errors.push(format!(
            "{} is {} bytes, longer than a socket path may be ({})",
            preferred.display(),
            preferred.as_os_str().len(),
            SUN_PATH_MAX - 1
        ));
    }
    for path in socket_candidates(config) {
        let short = path.parent() == Some(short_socket_dir().as_path());
        if short && let Err(e) = ensure_private_dir(&short_socket_dir()) {
            errors.push(format!("{}: {e}", short_socket_dir().display()));
            continue;
        }
        match bind_socket(&path) {
            Ok(l) => return Ok((path, l)),
            Err(e) => errors.push(format!("{}: {e}", path.display())),
        }
    }
    Err(errors.join("; "))
}

/// Remove the sockets of app processes that are gone, under the config dir
/// and in the short fallback folder.
#[cfg(unix)]
pub fn sweep_sockets(config: &Path) {
    sweep_socket_dir(&config.join("run"));
    sweep_socket_dir(&short_socket_dir());
}

#[cfg(unix)]
fn sweep_socket_dir(dir: &Path) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for e in read.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(pid) = name
            .strip_prefix("preview-")
            .and_then(|r| r.strip_suffix(".sock"))
            .and_then(|p| p.parse::<i32>().ok())
        else {
            continue;
        };
        // SAFETY: signal 0 only checks.
        let alive = unsafe { libc::kill(pid, 0) == 0 };
        if !alive {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// Bind the socket at `path`, readable by this user alone. A std listener,
/// so it can be bound before any runtime runs (the desktop's setup) and
/// the path handed out at once; [`serve_socket`] takes it onto the runtime.
#[cfg(unix)]
pub fn bind_socket(path: &Path) -> std::io::Result<std::os::unix::net::UnixListener> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let _ = std::fs::remove_file(path);
    let listener = std::os::unix::net::UnixListener::bind(path)?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    listener.set_nonblocking(true)?;
    Ok(listener)
}

/// Answer requests on `listener` for ever: one JSON line in, one out, per
/// connection.
#[cfg(unix)]
pub async fn serve_socket(listener: std::os::unix::net::UnixListener, previews: Arc<Previews>) {
    let Ok(listener) = tokio::net::UnixListener::from_std(listener) else {
        return;
    };
    while let Ok((stream, _)) = listener.accept().await {
        let previews = Arc::clone(&previews);
        tokio::spawn(async move {
            let (read, mut write) = stream.into_split();
            let mut lines = BufReader::new(read).lines();
            let Ok(Some(line)) = lines.next_line().await else {
                return;
            };
            let reply = match serde_json::from_str::<Request>(&line) {
                Ok(req) => answer(&previews, req).await,
                Err(e) => Reply {
                    ok: false,
                    preview: None,
                    error: Some(format!("not a preview request: {e}")),
                },
            };
            let mut out = serde_json::to_string(&reply).unwrap_or_default();
            out.push('\n');
            let _ = write.write_all(out.as_bytes()).await;
        });
    }
}

/// What one request does to the previews.
pub async fn answer(previews: &Arc<Previews>, req: Request) -> Reply {
    match req {
        Request::Start {
            chat,
            cwd,
            command,
            port,
        } => match previews.start(&chat, &cwd, &command, port).await {
            Ok(snap) => Reply {
                ok: true,
                preview: Some(snap),
                error: None,
            },
            Err(e) => Reply {
                ok: false,
                preview: None,
                error: Some(e),
            },
        },
        Request::Stop { chat } => Reply {
            ok: true,
            preview: previews.stop(&chat).await,
            error: None,
        },
        Request::Status { chat } => {
            let preview = previews.status(&chat);
            previews.mark_told_if_ended(&chat);
            Reply {
                ok: true,
                preview,
                error: None,
            }
        }
    }
}

/// Send one request to the desktop's socket and read its answer.
#[cfg(unix)]
pub async fn request(socket: &Path, req: &Request) -> Result<Reply, String> {
    let mut stream = tokio::net::UnixStream::connect(socket).await.map_err(|e| {
        format!(
            "Nightloom's preview service is not reachable ({e}) — the app that started this chat may have quit"
        )
    })?;
    let mut line = serde_json::to_string(req).map_err(|e| e.to_string())?;
    line.push('\n');
    stream
        .write_all(line.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    let mut lines = BufReader::new(stream).lines();
    let reply = lines
        .next_line()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "the preview service closed without answering".to_string())?;
    serde_json::from_str(&reply).map_err(|e| e.to_string())
}

// ---- the chat's id in the server's arguments --------------------------------

/// `mcp_config` with every server started with `--preview` told the chat:
/// `--preview-chat <chat>` replacing whatever chat it named before. `None`
/// when no server has `--preview` (nothing to change) or the JSON is not
/// an MCP config.
pub fn with_chat(mcp_config: &str, chat: &str) -> Option<String> {
    let mut cfg: Value = serde_json::from_str(mcp_config).ok()?;
    let servers = cfg.get_mut("mcpServers")?.as_object_mut()?;
    let mut changed = false;
    for server in servers.values_mut() {
        let Some(args) = server.get_mut("args").and_then(Value::as_array_mut) else {
            continue;
        };
        if !args.iter().any(|a| a == "--preview") {
            continue;
        }
        let mut kept = Vec::with_capacity(args.len() + 2);
        let mut it = args.drain(..);
        while let Some(a) = it.next() {
            if a == "--preview-chat" {
                it.next();
                continue;
            }
            kept.push(a);
        }
        drop(it);
        kept.push(Value::String("--preview-chat".into()));
        kept.push(Value::String(chat.to_string()));
        *args = kept;
        changed = true;
    }
    changed.then(|| cfg.to_string())
}

// ---- the tool ---------------------------------------------------------------

const DESCRIPTION: &str = "Run a long-running command — a dev server, a watcher — as this chat's preview. \
Nightloom runs it, not this message: it keeps running after your reply ends, between messages, until the \
user presses Stop, you call this tool with action \"stop\", a new \"start\" replaces it, or the app quits. \
The user sees it as a Preview chip with its URL, status and log, and can open it. One preview per chat. \
Use this instead of a background shell command for anything that must still be up after your reply. \
\"start\" runs `command` in the chat's folder with the PORT environment variable set to `port`, waits until \
the port answers (up to 20 s) and returns the status and the log's tail; the server must listen on that port. \
\"status\" returns the current status and log; \"stop\" ends it.";

/// `preview`, as Nightloom's MCP server serves it to a chat.
pub struct PreviewTool {
    socket: PathBuf,
    chat: String,
    root: PathBuf,
}

impl PreviewTool {
    pub fn new(socket: PathBuf, chat: String, root: PathBuf) -> Self {
        Self { socket, chat, root }
    }
}

/// What the model is told of a snapshot.
pub fn reply_text(action: &str, snap: Option<&Snapshot>) -> String {
    let Some(s) = snap else {
        return match action {
            "stop" => "There was no preview running in this chat.".into(),
            _ => "This chat has no preview running.".into(),
        };
    };
    let head = match (action, s.status) {
        ("stop", _) => format!("Stopped the preview `{}` (port {}).", s.command, s.port),
        (_, Status::Listening) => format!(
            "Preview running: `{}` in {}, answering at {}. It stays up after this reply, between messages, \
             until it is stopped or the app quits; check it with `curl -sS {}`.",
            s.command,
            s.cwd.display(),
            s.url,
            s.url
        ),
        (_, Status::Starting) => format!(
            "Preview started (`{}` in {}) but nothing answers on port {} yet — it may still be building. \
             Call preview with action \"status\" in a moment, or read the log below. Make sure it listens on port {} \
             (the PORT environment variable).",
            s.command,
            s.cwd.display(),
            s.port,
            s.port
        ),
        (_, Status::Exited) => format!(
            "The preview command `{}` ended (exit code {}) and nothing answers on port {}.",
            s.command,
            s.exit_code
                .map_or_else(|| "none — a signal".to_string(), |c| c.to_string()),
            s.port
        ),
    };
    if action == "stop" || s.log.is_empty() {
        return head;
    }
    let tail: Vec<&str> = s
        .log
        .iter()
        .rev()
        .take(REPLY_LINES)
        .rev()
        .map(String::as_str)
        .collect();
    format!(
        "{head}\n\nLast {} log lines:\n{}",
        tail.len(),
        tail.join("\n")
    )
}

#[async_trait::async_trait]
impl Tool for PreviewTool {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: TOOL_NAME.into(),
            description: DESCRIPTION.into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["start", "status", "stop"],
                        "description": "\"start\" (replaces this chat's preview), \"status\", or \"stop\"."
                    },
                    "command": {
                        "type": "string",
                        "description": "For \"start\": the shell command, run in the chat's folder, e.g. \"npm run dev -- --port $PORT\" or \"python3 -m http.server $PORT\"."
                    },
                    "port": {
                        "type": "integer",
                        "minimum": 1024,
                        "maximum": 65535,
                        "description": "For \"start\": the port the server listens on; must be free."
                    }
                },
                "required": ["action"]
            }),
        }
    }

    fn effect(&self) -> Effect {
        // It runs a command of the model's on his machine: what Bash is.
        Effect::Mutating
    }

    async fn call(&self, input: Value, _cancel: &CancellationToken) -> Result<String, String> {
        let action = input
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("status")
            .to_string();
        let req = match action.as_str() {
            "start" => {
                let command = input
                    .get("command")
                    .and_then(Value::as_str)
                    .filter(|c| !c.trim().is_empty())
                    .ok_or("\"start\" needs a command")?;
                let port = input
                    .get("port")
                    .and_then(Value::as_u64)
                    .and_then(|p| u16::try_from(p).ok())
                    .ok_or("\"start\" needs a port from 1024 to 65535")?;
                Request::Start {
                    chat: self.chat.clone(),
                    cwd: self.root.clone(),
                    command: command.to_string(),
                    port,
                }
            }
            "stop" => Request::Stop {
                chat: self.chat.clone(),
            },
            "status" => Request::Status {
                chat: self.chat.clone(),
            },
            other => {
                return Err(format!(
                    "unknown action {other:?}; use start, status or stop"
                ));
            }
        };
        #[cfg(unix)]
        {
            let reply = request(&self.socket, &req).await?;
            if !reply.ok {
                return Err(reply
                    .error
                    .unwrap_or_else(|| "the preview could not be started".into()));
            }
            let text = reply_text(&action, reply.preview.as_ref());
            if action == "start"
                && reply
                    .preview
                    .as_ref()
                    .is_some_and(|s| s.status == Status::Exited)
            {
                return Err(text);
            }
            Ok(text)
        }
        #[cfg(not(unix))]
        {
            let _ = req;
            Err("previews run on macOS and Linux only".into())
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// A port nothing answers on, found without making a socket on it
    /// (item 473): ~~a bind of port 0~~ — that listener, caught by another
    /// test's child in the moment before it is marked close-on-exec, stayed
    /// listening in that child and the test read its own fresh port as
    /// "already in use" (see `port_busy`). Ports below macOS's ephemeral
    /// range (49152 up), so no outgoing connection is ever given one; a
    /// random start and a step per call keep this process's ports apart
    /// and away from another test run's.
    fn free_port() -> u16 {
        use std::sync::atomic::AtomicU16;
        static NEXT: AtomicU16 = AtomicU16::new(0);
        let _ = NEXT.compare_exchange(
            0,
            20_000 + (uuid::Uuid::new_v4().as_u128() % 20_000) as u16,
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
        loop {
            let p = NEXT.fetch_add(1, Ordering::SeqCst);
            let p = 20_000 + p.wrapping_sub(20_000) % 25_000;
            if !port_answers(p) {
                return p;
            }
        }
    }

    // The server tests run side by side again (item 473). ~~2026-10-28:
    // one at a time behind a shared lock, since a start's port check read
    // a fresh port as busy 1 to 5 runs in 15, cause not found.~~ The cause
    // (2026-10-29): another test's child inherited the port's listener in
    // the moment before Rust marks a new socket close-on-exec, and held it
    // (see `port_busy`).

    fn tmp(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("nightloom-430-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn server(port: u16) -> String {
        format!("echo serving; exec python3 -m http.server {port} --bind 127.0.0.1")
    }

    fn previews() -> Arc<Previews> {
        Arc::new(Previews::new().with_ready_wait(Duration::from_secs(15)))
    }

    #[tokio::test]
    async fn a_start_answers_once_the_port_does_and_keeps_the_log() {
        let p = previews();
        let dir = tmp("start");
        std::fs::write(dir.join("index.html"), "hello 430").unwrap();
        let port = free_port();
        let snap = p.start("chat-a", &dir, &server(port), port).await.unwrap();
        assert_eq!(snap.status, Status::Listening, "{snap:?}");
        assert_eq!(snap.url, format!("http://localhost:{port}"));
        assert!(snap.log.iter().any(|l| l == "serving"), "{:?}", snap.log);
        // It serves the chat's folder: the command ran there.
        let body = http_get(port, "/index.html");
        assert!(body.contains("hello 430"), "{body}");
        p.stop("chat-a").await;
    }

    /// The item's point: a preview is not the turn's. A stand-in CLI turn
    /// runs and ends (`agent::tests::server_after_turn` does the same for
    /// a server the CLI starts); the preview, started by the app, is up
    /// before, during and after.
    #[tokio::test]
    async fn a_preview_survives_a_turn_ending() {
        let p = previews();
        let dir = tmp("turn");
        let port = free_port();
        p.start("chat-t", &dir, &server(port), port).await.unwrap();
        crate::agent::run_stand_in_turn(&dir).await;
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(port_answers(port), "the preview died with the turn");
        assert_eq!(p.status("chat-t").unwrap().status, Status::Listening);
        p.stop("chat-t").await;
    }

    #[tokio::test]
    async fn a_stop_ends_the_whole_group_and_frees_the_port() {
        let p = previews();
        let dir = tmp("stop");
        let port = free_port();
        // A child of the shell that is not exec'd: a stop by pid would miss it.
        let cmd = format!("python3 -m http.server {port} --bind 127.0.0.1 & wait");
        let snap = p.start("chat-s", &dir, &cmd, port).await.unwrap();
        assert_eq!(snap.status, Status::Listening);
        let pgid = snap.pgid.unwrap();
        let stopped = p.stop("chat-s").await.unwrap();
        assert_eq!(stopped.port, port);
        assert!(p.status("chat-s").is_none());
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!port_answers(port), "the server outlived its stop");
        assert!(!group_alive(pgid), "something of the group is left");
    }

    #[tokio::test]
    async fn shutdown_kills_every_preview() {
        let p = previews();
        let dir = tmp("quit");
        let (a, b) = (free_port(), free_port());
        let sa = p.start("chat-1", &dir, &server(a), a).await.unwrap();
        let sb = p
            .start(
                "chat-2",
                &dir,
                &format!("python3 -m http.server {b} --bind 127.0.0.1 & wait"),
                b,
            )
            .await
            .unwrap();
        assert!(port_answers(a) && port_answers(b));
        p.shutdown_all();
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(
            !port_answers(a) && !port_answers(b),
            "a preview outlived the app's exit"
        );
        assert!(!group_alive(sa.pgid.unwrap()) && !group_alive(sb.pgid.unwrap()));
        assert!(p.all().is_empty());
    }

    /// The app gone without its exit (a crash): the watchdog ends the group.
    #[tokio::test]
    async fn the_watchdog_ends_a_preview_whose_app_is_gone() {
        let mut fake_app = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let p = Arc::new(
            Previews::new()
                .with_ready_wait(Duration::from_secs(15))
                .watching(fake_app.id()),
        );
        let dir = tmp("watchdog");
        let port = free_port();
        let snap = p.start("chat-w", &dir, &server(port), port).await.unwrap();
        assert_eq!(snap.status, Status::Listening);
        fake_app.kill().unwrap();
        let _ = fake_app.wait();
        let until = std::time::Instant::now() + Duration::from_secs(6);
        while port_answers(port) && std::time::Instant::now() < until {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(!port_answers(port), "the preview outlived its app");
    }

    #[tokio::test]
    async fn a_port_in_use_is_refused_before_anything_runs() {
        let p = previews();
        let dir = tmp("clash");
        let held = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = held.local_addr().unwrap().port();
        let marker = dir.join("ran");
        let err = p
            .start(
                "chat-c",
                &dir,
                &format!("touch '{}'", marker.display()),
                port,
            )
            .await
            .unwrap_err();
        assert!(err.contains("already in use"), "{err}");
        assert!(p.status("chat-c").is_none());
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!marker.exists(), "the command ran on a busy port");
        drop(held);
        // Another chat's preview's port is refused by name.
        let port = free_port();
        p.start("chat-x", &dir, &server(port), port).await.unwrap();
        let err = p
            .start("chat-y", &dir, &server(port), port)
            .await
            .unwrap_err();
        assert!(err.contains("another chat's preview"), "{err}");
        p.stop("chat-x").await;
    }

    #[tokio::test]
    async fn a_restart_replaces_the_chats_preview_on_the_same_port() {
        let p = previews();
        let dir = tmp("restart");
        let port = free_port();
        let first = p.start("chat-r", &dir, &server(port), port).await.unwrap();
        let second = p.start("chat-r", &dir, &server(port), port).await.unwrap();
        assert_eq!(second.status, Status::Listening, "{second:?}");
        assert_ne!(first.pgid, second.pgid);
        assert!(
            !group_alive(first.pgid.unwrap()),
            "the first one was left running"
        );
        assert_eq!(p.all().len(), 1);
        p.stop("chat-r").await;
    }

    #[tokio::test]
    async fn a_command_that_dies_says_so_with_its_log() {
        let p = previews();
        let dir = tmp("dies");
        let port = free_port();
        let snap = p
            .start("chat-d", &dir, "echo boom >&2; exit 3", port)
            .await
            .unwrap();
        assert_eq!(snap.status, Status::Exited);
        assert_eq!(snap.exit_code, Some(3));
        assert!(snap.log.iter().any(|l| l == "boom"), "{:?}", snap.log);
        let text = reply_text("start", Some(&snap));
        assert!(
            text.contains("exit code 3") && text.contains("boom"),
            "{text}"
        );
    }

    #[tokio::test]
    async fn the_log_keeps_the_last_two_hundred_lines() {
        let p = previews();
        let dir = tmp("log");
        let port = free_port();
        let snap = p
            .start(
                "chat-l",
                &dir,
                "i=0; while [ $i -lt 450 ]; do echo line$i; i=$((i+1)); done",
                port,
            )
            .await
            .unwrap();
        assert_eq!(snap.log.len(), LOG_LINES);
        assert_eq!(snap.log.last().map(String::as_str), Some("line449"));
        assert_eq!(snap.log.first().map(String::as_str), Some("line250"));
    }

    /// The model's way in: the tool, over the desktop's socket, to the
    /// previews the desktop owns.
    #[tokio::test]
    async fn the_tool_reaches_the_desktop_over_its_socket() {
        let p = previews();
        let dir = tmp("socket");
        // A socket path must fit `sun_path` (104 bytes on macOS), and the
        // temporary folder's does not.
        let sock = PathBuf::from("/tmp").join(format!(
            "nl430-{}.sock",
            &uuid::Uuid::new_v4().simple().to_string()[..12]
        ));
        let listener = bind_socket(&sock).unwrap();
        let server_task = tokio::spawn(serve_socket(listener, Arc::clone(&p)));
        let seen: Arc<Mutex<Vec<(String, Option<Status>)>>> = Arc::default();
        let seen_c = Arc::clone(&seen);
        p.set_on_change(Arc::new(move |chat, snap| {
            seen_c
                .lock()
                .unwrap()
                .push((chat.to_string(), snap.map(|s| s.status)));
        }));
        let tool = PreviewTool::new(sock.clone(), "chat-m".into(), dir.clone());
        let port = free_port();
        let cancel = CancellationToken::new();
        let text = tool
            .call(
                json!({"action": "start", "command": server(port), "port": port}),
                &cancel,
            )
            .await
            .unwrap();
        assert!(
            text.contains("Preview running") && text.contains(&url_for(port)),
            "{text}"
        );
        let text = tool
            .call(json!({"action": "status"}), &cancel)
            .await
            .unwrap();
        assert!(text.contains("Preview running"), "{text}");
        let err = tool
            .call(json!({"action": "start", "command": "true"}), &cancel)
            .await
            .unwrap_err();
        assert!(err.contains("port"), "{err}");
        let text = tool.call(json!({"action": "stop"}), &cancel).await.unwrap();
        assert!(text.starts_with("Stopped"), "{text}");
        assert!(!port_answers(port));
        let seen = seen.lock().unwrap().clone();
        assert_eq!(
            seen.first(),
            Some(&("chat-m".to_string(), Some(Status::Starting)))
        );
        assert!(seen.contains(&("chat-m".to_string(), Some(Status::Listening))));
        assert_eq!(seen.last(), Some(&("chat-m".to_string(), None)));
        server_task.abort();
        let _ = std::fs::remove_file(&sock);
    }

    #[test]
    fn the_chat_is_written_into_the_preview_servers_arguments() {
        let cfg = json!({"mcpServers": {
            "nightloom": {"command": "/x", "args": ["--mcp-serve", "--root", "/w", "--preview", "/s.sock"]},
            "other": {"command": "/y", "args": ["a"]}
        }})
        .to_string();
        let once = with_chat(&cfg, "c1").unwrap();
        let twice = with_chat(&once, "c2").unwrap();
        let v: Value = serde_json::from_str(&twice).unwrap();
        assert_eq!(
            v["mcpServers"]["nightloom"]["args"],
            json!([
                "--mcp-serve",
                "--root",
                "/w",
                "--preview",
                "/s.sock",
                "--preview-chat",
                "c2"
            ])
        );
        assert_eq!(v["mcpServers"]["other"]["args"], json!(["a"]));
        let none = json!({"mcpServers": {"n": {"args": ["--mcp-serve"]}}}).to_string();
        assert!(with_chat(&none, "c").is_none());
    }

    /// Item 444: a config dir too long for `sun_path` falls back to the
    /// short folder, and the socket there binds and answers.
    #[tokio::test]
    async fn a_long_home_binds_its_socket_in_the_short_folder() {
        let long = tmp(&"h".repeat(120));
        assert!(
            !socket_path_fits(&socket_path(&long)),
            "the test home must be too long"
        );
        let candidates = socket_candidates(&long);
        assert_eq!(candidates.len(), 1, "{candidates:?}");
        assert_eq!(candidates[0].parent(), Some(short_socket_dir().as_path()));
        assert!(socket_path_fits(&candidates[0]));
        let (path, listener) = bind_preview_socket(&long).unwrap();
        assert_eq!(path, candidates[0]);
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(short_socket_dir())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700, "the short folder is this user's alone");
        let p = previews();
        let server_task = tokio::spawn(serve_socket(listener, Arc::clone(&p)));
        let reply = request(&path, &Request::Status { chat: "c".into() })
            .await
            .unwrap();
        assert!(reply.ok && reply.preview.is_none(), "{reply:?}");
        server_task.abort();
        let _ = std::fs::remove_file(&path);
        // A short home keeps its socket under the config dir.
        let short = PathBuf::from("/tmp/nl444");
        assert_eq!(socket_candidates(&short)[0], socket_path(&short));
    }

    /// Item 444: a planted link in the short folder's place is refused,
    /// not followed.
    #[test]
    fn the_short_folder_must_be_a_folder_of_this_users() {
        let dir = tmp("planted");
        let link = dir.join("link");
        std::os::unix::fs::symlink(&dir, &link).unwrap();
        assert!(ensure_private_dir(&link).is_err());
        let fresh = dir.join("fresh");
        ensure_private_dir(&fresh).unwrap();
        assert!(fresh.is_dir());
    }

    /// Item 445: a preview that ended with the app comes back at the next
    /// launch as ended; the chat's next turn is told once; Restart runs it
    /// again with the same command and port.
    #[tokio::test]
    async fn a_preview_ended_by_the_app_is_told_once_and_restarts() {
        let dir = tmp("record");
        let record = dir.join("run").join("previews.json");
        let port = free_port();
        // A record as a dead app process left it: running when it went.
        let dead_pid = {
            let mut c = std::process::Command::new("/usr/bin/true").spawn().unwrap();
            let pid = c.id();
            c.wait().unwrap();
            pid
        };
        let rec = Record {
            command: server(port),
            cwd: dir.clone(),
            port,
            started_ms: 1,
            pid: dead_pid,
            exited: false,
            exit_code: None,
            ended_by_app: false,
            told: false,
        };
        std::fs::create_dir_all(record.parent().unwrap()).unwrap();
        std::fs::write(
            &record,
            serde_json::to_string(&HashMap::from([("chat-r".to_string(), rec)])).unwrap(),
        )
        .unwrap();
        let p = Arc::new(
            Previews::new()
                .with_ready_wait(Duration::from_secs(15))
                .with_record(record.clone()),
        );
        assert_eq!(p.restore_ended(), 1);
        let snap = p.status("chat-r").unwrap();
        assert_eq!(snap.status, Status::Exited);
        assert!(snap.ended_by_app);
        let note = p.take_ended_note("chat-r").expect("told at the next turn");
        assert!(note.contains("ended when the Nightloom app quit"), "{note}");
        assert!(note.contains(&format!("port {port}")), "{note}");
        assert!(note.contains("\"start\""), "{note}");
        assert!(p.take_ended_note("chat-r").is_none(), "told once");
        // Told is on the record, so another launch does not tell it again.
        let on_disk = Previews::read_records(&record);
        assert!(
            on_disk["chat-r"].told && on_disk["chat-r"].ended_by_app,
            "{on_disk:?}"
        );
        let restarted = p.restart("chat-r").await.unwrap();
        assert_eq!(restarted.status, Status::Listening, "{restarted:?}");
        assert!(!restarted.ended_by_app);
        assert_eq!(restarted.port, port);
        assert!(
            p.take_ended_note("chat-r").is_none(),
            "running: nothing to tell"
        );
        // A stop forgets it: nothing restored at the next launch.
        p.stop("chat-r").await;
        let next = Previews::new().with_record(record.clone());
        assert_eq!(next.restore_ended(), 0);
        assert!(!std::fs::read_to_string(&record).unwrap().contains("chat-r"));
    }

    /// Item 445: a preview whose command died tells the model how, once;
    /// a `status` reply counts as telling it.
    #[tokio::test]
    async fn a_preview_that_exited_is_told_with_its_code_and_a_status_counts() {
        let p = previews();
        let dir = tmp("exit-note");
        let port = free_port();
        let snap = p
            .start("chat-x", &dir, "echo boom; exit 3", port)
            .await
            .unwrap();
        assert_eq!(snap.status, Status::Exited, "{snap:?}");
        let note = p.take_ended_note("chat-x").unwrap();
        assert!(note.contains("exit code 3"), "{note}");
        assert!(note.contains("boom"), "{note}");
        assert!(p.take_ended_note("chat-x").is_none());
        p.start("chat-y", &dir, "exit 1", free_port())
            .await
            .unwrap();
        let reply = answer(
            &p,
            Request::Status {
                chat: "chat-y".into(),
            },
        )
        .await;
        assert!(reply.ok);
        assert!(
            p.take_ended_note("chat-y").is_none(),
            "the status reply told it"
        );
        assert!(p.take_ended_note("no-such-chat").is_none());
    }

    /// Item 445: the app's own exit leaves the record, so the next launch
    /// can say the preview ended with it.
    #[tokio::test]
    async fn the_apps_exit_keeps_the_record() {
        let dir = tmp("exit-keeps");
        let record = dir.join("previews.json");
        let p = Arc::new(
            Previews::new()
                .with_ready_wait(Duration::from_secs(15))
                .with_record(record.clone()),
        );
        let port = free_port();
        p.start("chat-k", &dir, &server(port), port).await.unwrap();
        p.shutdown_all();
        let text = std::fs::read_to_string(&record).unwrap();
        assert!(text.contains("chat-k"), "{text}");
    }

    fn http_get(port: u16, path: &str) -> String {
        use std::io::{Read, Write};
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "GET {path} HTTP/1.0\r\nHost: localhost\r\n\r\n").unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        out
    }
}
