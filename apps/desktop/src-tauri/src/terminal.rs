//! The terminal pane's shells (2026-09-17, nightshift backlog 113, boards
//! 12a–12c).
//!
//! One pseudo-terminal per shell, opened by [`terminal_open`] in the folder
//! the window names (the project's), running his login shell — `$SHELL`,
//! or the password database's when that is unset — through `portable-pty`
//! (blocker 187). The window draws it with xterm.js; this side only moves
//! bytes: a reader thread per shell streams the master's output to the
//! window as `terminal-data` events, [`terminal_write`] carries keystrokes
//! back, [`terminal_resize`] tells the kernel the grid changed. When the
//! shell exits the reader sees EOF, waits on the child, and says so with
//! `terminal-exit`; a second thread ticks once a second and reports the
//! foreground process group's name as `terminal-title`, which is what the
//! strip shows after the shell's own name (`zsh`, then `npm run dev`).
//!
//! # Why the shells die with the window
//!
//! [`terminal_close`] kills a shell on its ×, and [`Terminals`]' `Drop`
//! kills every one still open when the state is torn down. The backstop
//! that needs no exit hook at all is the kernel's: when this process ends,
//! however it ends, every master fd closes, and a session leader whose
//! controlling terminal hangs up is sent `SIGHUP` — the shell exits and
//! hangs up its own jobs. `hangup_ends_the_shell_when_the_master_drops`
//! below pins that on the machines the suite runs on. The bundle is
//! unsandboxed (backlog 101 checked: no entitlements are signed in), so
//! opening `/dev/ptmx` from the signed app is allowed on the same terms as
//! spawning `caffeinate` or `claude`.
//!
//! # Bytes, not text
//!
//! The pty hands back bytes, and a read can end in the middle of a UTF-8
//! sequence. A JSON string cannot carry that, so `terminal-data` carries
//! base64 and the window decodes it into the bytes xterm.js takes. Input
//! goes the other way as plain text: the window only ever sends whole
//! characters.
//!
//! # Neither direction may block the window (review D, backlog 135)
//!
//! Input: a write to the master blocks once the slave's input queue is
//! full (about a kilobyte on macOS) and the foreground program is not
//! reading — a paste into a running build sat 3.75 s on the main thread,
//! the whole window frozen. So each shell has a writer thread fed by a
//! bounded queue: [`terminal_write`] pushes and returns, and a queue that
//! is full answers "the program is not reading its input" instead of
//! waiting for it.
//!
//! Output: a reader that forwards every `read` as its own event put a
//! million four-byte events a second onto the window's event loop from a
//! `yes`. So the reader hands its chunks to an emitter thread that
//! coalesces them into one event per frame (`FRAME`, at most `FRAME_BYTES`
//! each; the first chunk after a quiet spell goes at once, so typing is
//! not delayed), and the window acknowledges what xterm.js has drawn
//! ([`terminal_ack`]). With more than `HIGH_WATER` bytes unacknowledged
//! the emitter waits; the reader's queue to it is bounded, so the reader
//! waits too, and the kernel then makes the program wait — the same
//! backpressure a terminal window has always had. A window that stops
//! answering (hidden, reloading, gone) is released every `STALL`, so a
//! shell is never stuck on a lost acknowledgement.

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, TryRecvError, TrySendError};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

/// The reader's buffer: one read at a time. On macOS the pty hands back a
/// line or two per read for line-oriented output whatever the size here,
/// which is why the emitter coalesces (backlog 135).
const READ_CHUNK: usize = 16 * 1024;

/// The reader's queue to the emitter, in chunks. Full means the window
/// is behind; the reader then waits, and the kernel makes the program
/// wait.
const READ_QUEUE: usize = 64;

/// One event per frame, at most: the emitter gathers what arrives within
/// this of the last event before sending the next.
const FRAME: Duration = Duration::from_millis(16);

/// The most one `terminal-data` event carries; a frame past it is sent
/// early and the rest starts the next.
const FRAME_BYTES: usize = 64 * 1024;

/// Bytes sent and not yet acknowledged by the window above which the
/// emitter waits for an ack before the next event.
const HIGH_WATER: usize = 256 * 1024;

/// How long the emitter waits for an ack past `HIGH_WATER` before it
/// assumes the window is not answering and sends anyway.
const STALL: Duration = Duration::from_secs(2);

/// The writer's queue: this many pending writes, or `WRITE_QUEUE_BYTES`
/// of them, and a further write is refused rather than queued.
const WRITE_QUEUE: usize = 256;
const WRITE_QUEUE_BYTES: usize = 256 * 1024;

/// What `terminal_write` answers when the queue is full — the foreground
/// program has not read its input for a while.
const NOT_READING: &str = "the program is not reading its input";

/// How often the title thread asks which process group has the terminal.
/// The thread is unix-only (`spawn_title_watch`), so off unix this is dead
/// and the Windows job's clippy runs with `-D warnings` (review D, 2026-09-17).
#[cfg_attr(not(unix), allow(dead_code))]
const TITLE_POLL: Duration = Duration::from_secs(1);

/// What the window learns when a shell opens.
#[derive(Serialize, Clone, Debug)]
pub struct ShellInfo {
    pub id: u32,
    /// The shell's pid, for the window's own curiosity (and the tests).
    pub pid: Option<u32>,
    /// The program's name — `zsh`, `bash`, `fish` — the strip's first title.
    pub shell: String,
    /// The folder it started in, as given.
    pub cwd: String,
}

/// `terminal-data`: a read's bytes, base64.
#[derive(Serialize, Clone, Debug)]
struct DataEvent {
    id: u32,
    data: String,
}

/// `terminal-exit`: the shell ended with this code (`None` when a signal
/// ended it; the window reads that as "ended", no number).
#[derive(Serialize, Clone, Debug)]
struct ExitEvent {
    id: u32,
    code: Option<u32>,
    signal: Option<String>,
}

/// `terminal-title`: the foreground process group's name changed.
#[derive(Serialize, Clone, Debug)]
struct TitleEvent {
    id: u32,
    title: String,
}

/// What a shell reports, before it is an event: the reader and title
/// threads hand these to a [`Sink`], which for the app is the window and
/// for the tests is a channel.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outgoing {
    Data {
        id: u32,
        bytes: Vec<u8>,
    },
    Exit {
        id: u32,
        code: Option<u32>,
        signal: Option<String>,
    },
    /// Made only by the unix title thread; off unix it is matched by the
    /// window sink and never built, which `-D warnings` calls dead.
    #[cfg_attr(not(unix), allow(dead_code))]
    Title {
        id: u32,
        title: String,
    },
}

/// Where a shell's reports go.
pub trait Sink: Send + Sync {
    fn send(&self, ev: Outgoing);
}

/// The window: each report as its named event.
struct WindowSink(AppHandle);

impl Sink for WindowSink {
    fn send(&self, ev: Outgoing) {
        let _ = match ev {
            Outgoing::Data { id, bytes } => self.0.emit(
                "terminal-data",
                DataEvent {
                    id,
                    data: BASE64.encode(bytes),
                },
            ),
            Outgoing::Exit { id, code, signal } => {
                self.0.emit("terminal-exit", ExitEvent { id, code, signal })
            }
            Outgoing::Title { id, title } => {
                self.0.emit("terminal-title", TitleEvent { id, title })
            }
        };
    }
}

/// One open shell: the master side, the writer's queue, the child. The
/// reader, the emitter and the writer are each on their own thread.
struct Shell {
    master: Box<dyn MasterPty + Send>,
    /// The writer thread's queue; dropping it with the shell ends the
    /// thread once it has written what it holds.
    input: mpsc::SyncSender<Vec<u8>>,
    /// Bytes in the writer's queue not yet written, for the byte bound.
    queued: Arc<AtomicUsize>,
    /// Bytes sent to the window and not yet acknowledged.
    flow: Arc<Flow>,
    /// Shared with the reader thread, which waits on it at EOF for the
    /// exit code; `terminal_close` kills through it.
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    /// Set when the window closed the shell, so the reader's EOF does not
    /// also report an exit the window never asked to hear about.
    closed: Arc<AtomicBool>,
}

/// The output's flow control: bytes sent and not yet acknowledged, and
/// the emitter's wait for room.
#[derive(Default)]
struct Flow {
    inflight: Mutex<usize>,
    room: Condvar,
}

impl Flow {
    /// Wait until fewer than `HIGH_WATER` bytes are outstanding, or the
    /// window has not answered for `STALL` — then take it as gone (or
    /// reloading, or hiding the pane) and let the next event through.
    fn wait_for_room(&self) {
        let mut inflight = self.inflight.lock().unwrap_or_else(|p| p.into_inner());
        while *inflight >= HIGH_WATER {
            let (guard, timeout) = self
                .room
                .wait_timeout(inflight, STALL)
                .unwrap_or_else(|p| p.into_inner());
            inflight = guard;
            if timeout.timed_out() && *inflight >= HIGH_WATER {
                *inflight = 0;
            }
        }
    }

    fn sent(&self, n: usize) {
        *self.inflight.lock().unwrap_or_else(|p| p.into_inner()) += n;
    }

    fn acked(&self, n: usize) {
        let mut inflight = self.inflight.lock().unwrap_or_else(|p| p.into_inner());
        *inflight = inflight.saturating_sub(n);
        self.room.notify_one();
    }

    // Gated like its one caller (the pty tests, `cfg(all(test, unix))`):
    // on Windows the test build has no reader for it, and dead code fails
    // the desktop job's clippy under `-D warnings` (nightshift backlog
    // 119 pass 2 — red on every push from ac53018 to ee0dfc6).
    #[cfg(all(test, unix))]
    fn outstanding(&self) -> usize {
        *self.inflight.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// What the reader hands the emitter: bytes, then the exit, in order —
/// so the exit is never reported before the last of what the shell
/// printed.
enum Chunk {
    Data(Vec<u8>),
    Exit {
        code: Option<u32>,
        signal: Option<String>,
    },
}

/// Every shell the window has open, by id. Managed by Tauri beside
/// `AppState`.
#[derive(Default)]
pub struct Terminals {
    shells: Mutex<HashMap<u32, Shell>>,
    next: AtomicU32,
}

impl Terminals {
    /// Open a shell in `cwd` at `cols`×`rows` and start streaming it to
    /// `sink`. Returns what the window shows.
    fn open(
        &self,
        sink: Arc<dyn Sink>,
        cwd: &str,
        cols: u16,
        rows: u16,
    ) -> Result<ShellInfo, String> {
        let dir = PathBuf::from(cwd);
        if !dir.is_dir() {
            return Err(format!("{cwd} is not a folder"));
        }
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows: rows.max(2),
                cols: cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("could not open a pty: {e}"))?;
        let mut cmd = CommandBuilder::new_default_prog();
        cmd.cwd(&dir);
        // xterm.js speaks xterm; without this a login shell inherits
        // whatever TERM the app was launched with, which from Finder is
        // nothing at all.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // So a `claude` typed by hand, or anything else that looks, knows
        // whose terminal it is in.
        cmd.env("TERM_PROGRAM", "Nightloom");
        let shell_name = shell_display_name(&cmd.get_shell());
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("could not start {shell_name}: {e}"))?;
        // The slave's fd must go once the child has it: a copy held here
        // would keep the reader from ever seeing EOF.
        drop(pair.slave);
        let pid = child.process_id();
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("could not read the pty: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("could not write the pty: {e}"))?;
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let child = Arc::new(Mutex::new(child));
        let closed = Arc::new(AtomicBool::new(false));
        let flow = Arc::new(Flow::default());
        let queued = Arc::new(AtomicUsize::new(0));
        // The three threads. A spawn can fail (the process is out of
        // threads); the child is already running by then, so a failure
        // kills it and is the window's error, not a panic on whichever
        // thread the command ran on (review D, FD6).
        let threads = (|| -> std::io::Result<mpsc::SyncSender<Vec<u8>>> {
            let (tx, rx) = mpsc::sync_channel::<Chunk>(READ_QUEUE);
            spawn_emitter(sink.clone(), id, rx, flow.clone())?;
            spawn_reader(tx, id, reader, child.clone(), closed.clone())?;
            spawn_writer(id, writer, queued.clone())
        })();
        let input = match threads {
            Ok(input) => input,
            Err(e) => {
                closed.store(true, Ordering::Relaxed);
                let mut child = child.lock().unwrap_or_else(|p| p.into_inner());
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("could not start the shell's threads: {e}"));
            }
        };
        // The title is a nicety: a shell without its thread still works,
        // its tab reading the shell's name throughout.
        #[cfg(unix)]
        spawn_title_watch(
            sink,
            id,
            pair.master.as_ref(),
            &shell_name,
            pid,
            closed.clone(),
        );
        #[cfg(not(unix))]
        drop(sink);
        self.shells
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(
                id,
                Shell {
                    master: pair.master,
                    input,
                    queued,
                    flow,
                    child,
                    closed,
                },
            );
        Ok(ShellInfo {
            id,
            pid,
            shell: shell_name,
            cwd: cwd.to_string(),
        })
    }

    /// Queue `data` for the shell's writer thread. Never waits on the
    /// pty: a queue past its bound — the foreground program has stopped
    /// reading — is refused with [`NOT_READING`], and the window says so.
    fn write(&self, id: u32, data: &str) -> Result<(), String> {
        let shells = self.shells.lock().unwrap_or_else(|p| p.into_inner());
        let shell = shells.get(&id).ok_or("no such shell")?;
        let n = data.len();
        if n == 0 {
            return Ok(());
        }
        // Reserve the bytes before the send so two writes cannot both
        // fit under the bound at once; give them back if it is refused.
        let before = shell.queued.fetch_add(n, Ordering::AcqRel);
        if before + n > WRITE_QUEUE_BYTES {
            shell.queued.fetch_sub(n, Ordering::AcqRel);
            return Err(NOT_READING.to_string());
        }
        match shell.input.try_send(data.as_bytes().to_vec()) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => {
                shell.queued.fetch_sub(n, Ordering::AcqRel);
                Err(NOT_READING.to_string())
            }
            // The writer thread ended: the pty is gone under it.
            Err(TrySendError::Disconnected(_)) => {
                shell.queued.fetch_sub(n, Ordering::AcqRel);
                Err("the shell's terminal is gone".to_string())
            }
        }
    }

    /// The window drew `n` more bytes; the emitter may send more.
    fn ack(&self, id: u32, n: usize) {
        let shells = self.shells.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(shell) = shells.get(&id) {
            shell.flow.acked(n);
        }
    }

    fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let shells = self.shells.lock().unwrap_or_else(|p| p.into_inner());
        let shell = shells.get(&id).ok_or("no such shell")?;
        shell
            .master
            .resize(PtySize {
                rows: rows.max(2),
                cols: cols.max(2),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())
    }

    /// Kill and forget. Unknown ids are fine: the shell may have exited
    /// and been closed from the strip in either order.
    fn close(&self, id: u32) {
        let shell = self
            .shells
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&id);
        if let Some(shell) = shell {
            shell.closed.store(true, Ordering::Relaxed);
            let mut child = shell.child.lock().unwrap_or_else(|p| p.into_inner());
            let _ = child.kill();
            let _ = child.wait();
            // The master (and with it the reader's clone's last owner) goes
            // with `shell`; the reader thread sees EOF and ends.
        }
    }

    /// The open shells' ids, for a window that reloads (dev) and for the
    /// tests.
    fn ids(&self) -> Vec<u32> {
        let mut ids: Vec<u32> = self
            .shells
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .keys()
            .copied()
            .collect();
        ids.sort_unstable();
        ids
    }
}

impl Drop for Terminals {
    fn drop(&mut self) {
        if let Ok(shells) = self.shells.get_mut() {
            for shell in shells.values_mut() {
                shell.closed.store(true, Ordering::Relaxed);
                if let Ok(mut child) = shell.child.lock() {
                    let _ = child.kill();
                }
            }
        }
    }
}

/// `/bin/zsh` → `zsh`; the first title on the strip.
fn shell_display_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(path)
        .trim_start_matches('-')
        .to_string()
}

/// The reader: every chunk to the emitter's queue, then the exit. The
/// queue is bounded, so a window that is behind holds the reader here,
/// and the kernel holds the program.
fn spawn_reader(
    tx: mpsc::SyncSender<Chunk>,
    id: u32,
    mut reader: Box<dyn Read + Send>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    closed: Arc<AtomicBool>,
) -> std::io::Result<()> {
    thread::Builder::new()
        .name(format!("terminal-{id}"))
        .spawn(move || {
            let mut buf = vec![0u8; READ_CHUNK];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        if tx.send(Chunk::Data(buf[..n].to_vec())).is_err() {
                            return;
                        }
                    }
                    // EIO is how a Linux master reports the slave's last
                    // close; macOS gives a clean 0. Either is the end.
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            if closed.load(Ordering::Relaxed) {
                return;
            }
            let status = child.lock().unwrap_or_else(|p| p.into_inner()).wait().ok();
            let _ = tx.send(Chunk::Exit {
                code: status.as_ref().and_then(|s| {
                    if s.signal().is_some() {
                        None
                    } else {
                        Some(s.exit_code())
                    }
                }),
                signal: status.as_ref().and_then(|s| s.signal().map(String::from)),
            });
        })
        .map(|_| ())
}

/// The emitter: the reader's chunks to the window, one event per frame.
/// The first chunk after a quiet spell goes at once; while the shell
/// keeps printing, what arrives within `FRAME` of the last event is one
/// event, capped at `FRAME_BYTES`. Past `HIGH_WATER` unacknowledged it
/// waits for the window (see `Flow`).
fn spawn_emitter(
    sink: Arc<dyn Sink>,
    id: u32,
    rx: mpsc::Receiver<Chunk>,
    flow: Arc<Flow>,
) -> std::io::Result<()> {
    thread::Builder::new()
        .name(format!("terminal-emit-{id}"))
        .spawn(move || {
            let mut last_emit = Instant::now() - FRAME;
            // A chunk that did not fit the frame it arrived in.
            let mut carry: Option<Vec<u8>> = None;
            loop {
                let mut frame = match carry.take() {
                    Some(b) => b,
                    None => match rx.recv() {
                        Ok(Chunk::Data(b)) => b,
                        Ok(Chunk::Exit { code, signal }) => {
                            sink.send(Outgoing::Exit { id, code, signal });
                            return;
                        }
                        Err(_) => return,
                    },
                };
                let deadline = last_emit + FRAME;
                let mut exit = None;
                while frame.len() < FRAME_BYTES {
                    let now = Instant::now();
                    let next = if now >= deadline {
                        match rx.try_recv() {
                            Ok(c) => c,
                            Err(TryRecvError::Empty) | Err(TryRecvError::Disconnected) => break,
                        }
                    } else {
                        match rx.recv_timeout(deadline - now) {
                            Ok(c) => c,
                            Err(RecvTimeoutError::Timeout) => continue,
                            Err(RecvTimeoutError::Disconnected) => break,
                        }
                    };
                    match next {
                        Chunk::Data(b) => {
                            if frame.len() + b.len() > FRAME_BYTES && !frame.is_empty() {
                                carry = Some(b);
                                break;
                            }
                            frame.extend_from_slice(&b);
                        }
                        Chunk::Exit { code, signal } => {
                            exit = Some((code, signal));
                            break;
                        }
                    }
                }
                flow.wait_for_room();
                flow.sent(frame.len());
                sink.send(Outgoing::Data { id, bytes: frame });
                last_emit = Instant::now();
                if let Some((code, signal)) = exit {
                    sink.send(Outgoing::Exit { id, code, signal });
                    return;
                }
            }
        })
        .map(|_| ())
}

/// The writer: the queue's bytes into the pty, in order. This is the
/// thread that blocks when the foreground program is not reading; the
/// command that queued the bytes has long returned. Ends with the queue
/// (the shell closed) or with the first failed write (the pty gone).
fn spawn_writer(
    id: u32,
    mut writer: Box<dyn Write + Send>,
    queued: Arc<AtomicUsize>,
) -> std::io::Result<mpsc::SyncSender<Vec<u8>>> {
    let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(WRITE_QUEUE);
    thread::Builder::new()
        .name(format!("terminal-write-{id}"))
        .spawn(move || {
            while let Ok(bytes) = rx.recv() {
                let n = bytes.len();
                let r = writer.write_all(&bytes).and_then(|()| writer.flush());
                queued.fetch_sub(n, Ordering::AcqRel);
                if r.is_err() {
                    return;
                }
            }
        })
        .map(|_| tx)
}

/// The title thread: which process group has the terminal, by name, once a
/// second, reported only when it changes. `shell` is what the strip shows
/// when the shell itself is in front, so the same name coming back as the
/// foreground group reads as "nothing running".
#[cfg(unix)]
fn spawn_title_watch(
    sink: Arc<dyn Sink>,
    id: u32,
    master: &dyn MasterPty,
    shell: &str,
    shell_pid: Option<u32>,
    closed: Arc<AtomicBool>,
) {
    // The master's fd is what `tcgetpgrp` is asked about; the raw fd is
    // taken now, and the thread stops asking once the window closed the
    // shell (`closed`) or the fd stops answering (the master dropped).
    let Some(fd) = master.as_raw_fd() else { return };
    let shell = shell.to_string();
    thread::Builder::new()
        .name(format!("terminal-title-{id}"))
        .spawn(move || {
            let mut last = shell.clone();
            loop {
                thread::sleep(TITLE_POLL);
                if closed.load(Ordering::Relaxed) {
                    return;
                }
                // SAFETY: `tcgetpgrp` reads an integer property of an open
                // descriptor and touches no memory of ours; a closed or
                // reused fd answers -1 (ENOTTY/EBADF), which ends the loop.
                let pgid = unsafe { libc::tcgetpgrp(fd) };
                if pgid <= 0 {
                    return;
                }
                // The shell's own group in front is "idle", under the
                // shell's display name — not the kernel's, which is `bash`
                // for `/bin/sh` on macOS, or a symlinked `$SHELL`'s target.
                let title = if Some(pgid as u32) == shell_pid {
                    shell.clone()
                } else {
                    match process_name(pgid) {
                        Some(name) => name,
                        None => continue,
                    }
                };
                if title != last {
                    last = title.clone();
                    sink.send(Outgoing::Title { id, title });
                }
            }
        })
        // Out of threads: the strip keeps the shell's own name; the
        // shell itself is unaffected (review D, FD6).
        .ok();
}

/// A process's short name by pid — `proc_name` on macOS, `/proc` on Linux.
#[cfg(target_os = "macos")]
fn process_name(pid: libc::pid_t) -> Option<String> {
    let mut buf = [0u8; 64];
    // SAFETY: `proc_name` writes at most `buffersize` bytes into `buf` and
    // returns how many; the buffer outlives the call.
    let n = unsafe {
        libc::proc_name(
            pid,
            buf.as_mut_ptr().cast::<libc::c_void>(),
            buf.len() as u32,
        )
    };
    if n <= 0 {
        return None;
    }
    let name = String::from_utf8_lossy(&buf[..n as usize]);
    let name = name.trim_end_matches('\0').trim_start_matches('-');
    (!name.is_empty()).then(|| name.to_string())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn process_name(pid: libc::pid_t) -> Option<String> {
    let comm = std::fs::read_to_string(format!("/proc/{pid}/comm")).ok()?;
    let name = comm.trim().trim_start_matches('-');
    (!name.is_empty()).then(|| name.to_string())
}

// ---- the commands ---------------------------------------------------------

/// New shell in `cwd`, sized to the pane's grid. `async`, as are `write`
/// and `close`: a synchronous command runs on the main thread, and a
/// fork, a wait on a dying shell, or a write the program is not reading
/// would hold the window with it (review D, backlog 135).
#[tauri::command]
pub async fn terminal_open(
    app: AppHandle,
    terminals: State<'_, Terminals>,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<ShellInfo, String> {
    terminals.open(Arc::new(WindowSink(app)), &cwd, cols, rows)
}

/// Keystrokes (and pastes) to the shell, as the text xterm.js produced.
/// Queued, never waited on: `Err(NOT_READING)` when the queue is full.
#[tauri::command]
pub async fn terminal_write(
    terminals: State<'_, Terminals>,
    id: u32,
    data: String,
) -> Result<(), String> {
    terminals.write(id, &data)
}

/// The window has drawn `bytes` more of a shell's output; the emitter
/// may send the next frame past the high-water mark.
#[tauri::command]
pub fn terminal_ack(terminals: State<'_, Terminals>, id: u32, bytes: usize) {
    terminals.ack(id, bytes);
}

/// The pane's grid changed; the kernel tells the shell (`SIGWINCH`).
#[tauri::command]
pub fn terminal_resize(
    terminals: State<'_, Terminals>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    terminals.resize(id, cols, rows)
}

/// The shell's × — kill it and forget it. Never an error: a shell that
/// already exited is closed the same way. (`Result` because an async
/// command that borrows state must return one.)
#[tauri::command]
pub async fn terminal_close(terminals: State<'_, Terminals>, id: u32) -> Result<(), String> {
    terminals.close(id);
    Ok(())
}

/// The ids still open, for the tests and for a window that reloads.
#[tauri::command]
pub fn terminal_list(terminals: State<'_, Terminals>) -> Vec<u32> {
    terminals.ids()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Instant;

    /// The test's window: every report on a channel.
    struct ChannelSink(Mutex<mpsc::Sender<Outgoing>>);

    impl Sink for ChannelSink {
        fn send(&self, ev: Outgoing) {
            let _ = self.0.lock().unwrap().send(ev);
        }
    }

    fn sink() -> (Arc<dyn Sink>, mpsc::Receiver<Outgoing>) {
        let (tx, rx) = mpsc::channel();
        (Arc::new(ChannelSink(Mutex::new(tx))), rx)
    }

    fn open_sh(t: &Terminals, dir: &std::path::Path) -> (ShellInfo, mpsc::Receiver<Outgoing>) {
        // The tests want a shell whose behaviour they know, not his; the
        // builder reads `$SHELL` from the environment it was built with,
        // which is this process's.
        // SAFETY (Rust 2024's `set_var`): nothing else in the crate reads
        // `SHELL`, and every test here sets the same value.
        unsafe { std::env::set_var("SHELL", "/bin/sh") };
        let (sink, rx) = sink();
        let info = t
            .open(sink, dir.to_str().unwrap(), 80, 24)
            .expect("open a shell");
        (info, rx)
    }

    const PATIENCE: Duration = Duration::from_secs(10);

    fn wait_until(mut f: impl FnMut() -> bool, what: &str) {
        let start = Instant::now();
        while !f() {
            assert!(start.elapsed() < PATIENCE, "timed out waiting for {what}");
            thread::sleep(Duration::from_millis(50));
        }
    }

    /// Everything the shell printed, until `stop` says the text is enough.
    fn read_until(rx: &mpsc::Receiver<Outgoing>, stop: impl Fn(&str) -> bool) -> String {
        let mut out = String::new();
        let start = Instant::now();
        while !stop(&out) {
            let left = PATIENCE.saturating_sub(start.elapsed());
            assert!(!left.is_zero(), "timed out; the shell said {out:?}");
            match rx.recv_timeout(left) {
                Ok(Outgoing::Data { bytes, .. }) => out.push_str(&String::from_utf8_lossy(&bytes)),
                Ok(_) => {}
                Err(_) => panic!("the shell went quiet; it said {out:?}"),
            }
        }
        out
    }

    fn alive(pid: u32) -> bool {
        // SAFETY: signal 0 checks for the process's existence and delivers
        // nothing.
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }

    #[test]
    fn opens_a_shell_in_the_folder_and_echoes_what_it_is_told() {
        let dir = std::env::temp_dir().join(format!("nightloom-term-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let t = Terminals::default();
        let (info, rx) = open_sh(&t, &dir);
        assert_eq!(info.shell, "sh");
        assert_eq!(info.id, 1);
        assert!(info.pid.is_some());
        t.write(info.id, "pwd; echo MARK-$((20+22))\n").unwrap();
        let out = read_until(&rx, |o| o.contains("MARK-42"));
        // macOS's temp dir is a symlink (/var → /private/var); the shell
        // reports its logical cwd, so accept either form.
        let canon = std::fs::canonicalize(&dir).unwrap();
        assert!(
            out.contains(dir.to_str().unwrap()) || out.contains(canon.to_str().unwrap()),
            "pwd not in {out:?}"
        );
        t.close(info.id);
        assert!(t.ids().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_a_folder_that_is_not_one() {
        let t = Terminals::default();
        let (s, _rx) = sink();
        let err = t.open(s, "/nonexistent/nightloom", 80, 24).unwrap_err();
        assert!(err.contains("not a folder"), "{err}");
    }

    #[test]
    fn resize_reaches_the_kernel() {
        let t = Terminals::default();
        let (info, _rx) = open_sh(&t, &std::env::temp_dir());
        t.resize(info.id, 132, 40).unwrap();
        let size = t.shells.lock().unwrap()[&info.id]
            .master
            .get_size()
            .unwrap();
        assert_eq!((size.cols, size.rows), (132, 40));
        t.close(info.id);
        assert!(t.resize(info.id, 80, 24).is_err());
    }

    #[test]
    fn close_kills_the_shell_and_reports_no_exit() {
        let t = Terminals::default();
        let (info, rx) = open_sh(&t, &std::env::temp_dir());
        let pid = info.pid.unwrap();
        assert!(alive(pid));
        t.close(info.id);
        wait_until(|| !alive(pid), "the shell to die on close");
        // The window asked; it is not told the shell "exited".
        thread::sleep(Duration::from_millis(200));
        assert!(!rx.try_iter().any(|e| matches!(e, Outgoing::Exit { .. })));
    }

    #[test]
    fn eof_ends_the_shell_when_its_input_queue_drops() {
        // What dropping a `Shell` does to an idle shell: the writer's
        // queue goes, the writer thread ends and its dup of the master
        // closes with a `\n` + `^D` (portable-pty's writer), and `sh`
        // exits on the EOF. Not a hangup — the reader's dup keeps the
        // pty open (review D, FD3); the hangup is the next test.
        let t = Terminals::default();
        let (info, _rx) = open_sh(&t, &std::env::temp_dir());
        let pid = info.pid.unwrap();
        assert!(alive(pid));
        let shell = t.shells.lock().unwrap().remove(&info.id).unwrap();
        // Keep the child handle so nothing reaps it early.
        let Shell {
            master,
            input,
            child,
            ..
        } = shell;
        drop(input);
        drop(master);
        wait_until(|| !alive(pid), "the shell to exit on EOF");
        let _ = child.lock().unwrap().wait();
    }

    #[test]
    fn hangup_ends_a_foreground_job_when_every_master_fd_closes() {
        // The backstop the module doc claims for the process ending: with
        // no fd left on the master, the kernel hangs the line up and the
        // session leader's group gets SIGHUP — a `sleep` in front, which
        // reads nothing and would never see an EOF, dies of it. No reader
        // clone is taken here, so the master is the one fd.
        let pty = native_pty_system();
        let pair = pty
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.args(["-c", "exec sleep 30"]);
        let mut child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        thread::sleep(Duration::from_millis(200));
        assert!(
            child.try_wait().unwrap().is_none(),
            "sleep should still be running"
        );
        drop(pair.master);
        // `kill(pid, 0)` answers for a zombie too, so the wait is the
        // check: the job is reaped, and by the hangup.
        let mut status = None;
        wait_until(
            || {
                status = child.try_wait().unwrap();
                status.is_some()
            },
            "the job to die of SIGHUP",
        );
        let signal = status.unwrap().signal().map(String::from);
        assert!(
            signal.as_deref().is_some_and(|s| s.contains("Hangup")),
            "{signal:?}"
        );
    }

    #[test]
    fn a_full_input_queue_is_refused_and_drains_when_the_program_reads() {
        // A paste the program is not reading fills the writer's queue up
        // to its byte bound; the write past it is refused, not waited on;
        // once the program is gone the shell reads it all.
        let t = Terminals::default();
        let (info, rx) = open_sh(&t, &std::env::temp_dir());
        t.write(info.id, "sleep 2\n").unwrap();
        read_until(&rx, |o| o.contains("sleep 2"));
        thread::sleep(Duration::from_millis(300));
        // Blank lines: the shell reads them after the sleep and does
        // nothing, and a line the tty cuts (a cooked tty past its 1 KB
        // line limit drops input with a bell, in any terminal) is still
        // blank. Each under the line limit.
        let filler = format!("{}\n", " ".repeat(999));
        let mut accepted = 0usize;
        let refused = loop {
            match t.write(info.id, &filler) {
                Ok(()) => accepted += 1,
                Err(e) => break e,
            }
            // The queue, plus the one in the writer's hands, plus the
            // line the tty took before it filled.
            assert!(accepted <= WRITE_QUEUE + 2, "the queue never filled");
        };
        assert_eq!(refused, NOT_READING);
        assert!(accepted * filler.len() <= WRITE_QUEUE_BYTES);
        assert!(accepted >= WRITE_QUEUE, "only {accepted} accepted");
        eprintln!(
            "MEASURE queue: {accepted} writes of {} bytes accepted before {refused:?}",
            filler.len()
        );
        // The sleep ends and the shell drains the queue: nothing is left
        // in it, a write is accepted again, and its echo arrives.
        let queued = t.shells.lock().unwrap()[&info.id].queued.clone();
        wait_until(|| queued.load(Ordering::Acquire) == 0, "the queue to drain");
        thread::sleep(Duration::from_millis(300));
        t.write(info.id, "echo QUEUE-DRAINED\n").unwrap();
        read_until(&rx, |o| o.contains("QUEUE-DRAINED\r\n"));
        t.close(info.id);
    }

    #[test]
    fn output_pauses_past_the_high_water_mark_until_the_window_acks() {
        let t = Terminals::default();
        let (info, rx) = open_sh(&t, &std::env::temp_dir());
        read_until(&rx, |o| !o.is_empty());
        t.write(info.id, "yes | head -c 5000000\n").unwrap();
        // No acks: the emitter stops at the mark (plus one frame's cap).
        thread::sleep(Duration::from_millis(600));
        let got: usize = rx
            .try_iter()
            .map(|e| match e {
                Outgoing::Data { bytes, .. } => bytes.len(),
                _ => 0,
            })
            .sum();
        eprintln!("MEASURE pause: {got} bytes in 600 ms without acks (mark {HIGH_WATER})");
        assert!(got >= HIGH_WATER, "{got} never reached the mark");
        assert!(got <= HIGH_WATER + FRAME_BYTES, "{got} ran past the mark");
        let flow = t.shells.lock().unwrap()[&info.id].flow.clone();
        assert!(flow.outstanding() >= HIGH_WATER);
        // An ack for what was drawn lets the next frames through.
        t.ack(info.id, got);
        let more = read_until(&rx, |o| o.len() >= FRAME_BYTES);
        assert!(!more.is_empty());
        t.close(info.id);
    }

    #[test]
    fn a_shell_that_exits_reports_its_code() {
        let t = Terminals::default();
        let (info, rx) = open_sh(&t, &std::env::temp_dir());
        t.write(info.id, "exit 3\n").unwrap();
        let exit = loop {
            match rx.recv_timeout(PATIENCE).expect("the shell's exit") {
                Outgoing::Exit { id, code, signal } => break (id, code, signal),
                _ => continue,
            }
        };
        assert_eq!(exit, (info.id, Some(3), None));
        t.close(info.id);
    }

    #[test]
    fn the_title_is_the_foreground_program() {
        let t = Terminals::default();
        let (info, rx) = open_sh(&t, &std::env::temp_dir());
        // Right after the spawn the child may not have taken the line
        // yet — the foreground group is still this process's for a tick;
        // and `/bin/sh` is bash on macOS, so the kernel's name for it is
        // either.
        wait_until(
            || {
                let shells = t.shells.lock().unwrap();
                let pgid = shells[&info.id].master.process_group_leader();
                matches!(pgid.and_then(process_name).as_deref(), Some("sh" | "bash"))
            },
            "the shell to take the line",
        );
        t.write(info.id, "sleep 30\n").unwrap();
        // The title thread ticks once a second; the report names `sleep`.
        let title = loop {
            match rx.recv_timeout(PATIENCE).expect("a title") {
                Outgoing::Title { title, .. } => break title,
                _ => continue,
            }
        };
        assert_eq!(title, "sleep");
        t.close(info.id);
    }

    /// Review D's paste (FD1): 44 lines, 3,036 bytes, into a shell whose
    /// foreground program is not reading its input.
    fn paste_3k() -> String {
        let mut s = String::new();
        let mut i = 0;
        while s.len() < 3036 {
            let line = format!("echo line-{i:02} {}\n", "x".repeat(58));
            let room = 3036 - s.len();
            if line.len() > room {
                s.push_str(&line[..room - 1]);
                s.push('\n');
            } else {
                s.push_str(&line);
            }
            i += 1;
        }
        assert_eq!(s.len(), 3036);
        s
    }

    #[test]
    fn a_paste_into_a_program_not_reading_stdin_returns_at_once() {
        let t = Terminals::default();
        let (info, rx) = open_sh(&t, &std::env::temp_dir());
        t.write(info.id, "sleep 4\n").unwrap();
        // The sleep is in front once its line has echoed and a tick passed.
        read_until(&rx, |o| o.contains("sleep 4"));
        thread::sleep(Duration::from_millis(300));
        let paste = paste_3k();
        let start = Instant::now();
        let r = t.write(info.id, &paste);
        let took = start.elapsed();
        eprintln!(
            "MEASURE paste: {} bytes returned {:?} -> {:?}",
            paste.len(),
            r,
            took
        );
        assert!(r.is_ok(), "{r:?}");
        assert!(
            took < Duration::from_millis(100),
            "the paste blocked {took:?}"
        );
        t.close(info.id);
    }

    #[test]
    fn a_flood_arrives_as_frames_not_lines() {
        let t = Terminals::default();
        let (info, rx) = open_sh(&t, &std::env::temp_dir());
        read_until(&rx, |o| !o.is_empty());
        let total: usize = 20_000_000;
        t.write(info.id, "yes | head -c 20000000; echo FLOOD-DONE\n")
            .unwrap();
        let start = Instant::now();
        let mut events = 0usize;
        let mut bytes = 0usize;
        let mut largest = 0usize;
        let mut tail = String::new();
        loop {
            let Outgoing::Data { bytes: b, .. } =
                rx.recv_timeout(Duration::from_secs(60)).expect("the flood")
            else {
                continue;
            };
            events += 1;
            bytes += b.len();
            largest = largest.max(b.len());
            // The window's ack, as xterm.js's write callback sends it.
            t.ack(info.id, b.len());
            tail.push_str(&String::from_utf8_lossy(&b));
            if tail.len() > 64 {
                tail = tail[tail.len() - 64..].to_string();
            }
            if bytes >= total && tail.contains("FLOOD-DONE") {
                break;
            }
        }
        let took = start.elapsed();
        eprintln!(
            "MEASURE flood: {bytes} bytes as {events} events (mean {} B, largest {largest} B) in {took:?} = {:.0} events/s, {:.1} MB/s",
            bytes / events.max(1),
            events as f64 / took.as_secs_f64(),
            bytes as f64 / took.as_secs_f64() / 1e6
        );
        assert!(largest <= FRAME_BYTES, "an event of {largest} bytes");
        // Frames, not lines: a `yes` line is 3 bytes; a frame is thousands.
        assert!(
            bytes / events >= 4096,
            "mean {} bytes per event",
            bytes / events
        );
        t.close(info.id);
    }

    #[test]
    fn shell_names_are_the_file_name() {
        assert_eq!(shell_display_name("/bin/zsh"), "zsh");
        assert_eq!(shell_display_name("/opt/homebrew/bin/fish"), "fish");
        assert_eq!(shell_display_name("-bash"), "bash");
    }
}
