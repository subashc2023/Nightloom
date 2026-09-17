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

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

/// The reader's buffer: one read at a time, handed to the window as it
/// comes. Small enough that a keystroke's echo is not held behind a
/// build's output; large enough that `cat` of a big file is not a storm
/// of tiny events.
const READ_CHUNK: usize = 16 * 1024;

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

/// One open shell: the master side, the writer, the child. The reader is
/// on its own thread with a clone of the master's read handle.
struct Shell {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    /// Shared with the reader thread, which waits on it at EOF for the
    /// exit code; `terminal_close` kills through it.
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    /// Set when the window closed the shell, so the reader's EOF does not
    /// also report an exit the window never asked to hear about.
    closed: Arc<AtomicBool>,
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
        spawn_reader(sink.clone(), id, reader, child.clone(), closed.clone());
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
                    writer,
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

    fn write(&self, id: u32, data: &str) -> Result<(), String> {
        let mut shells = self.shells.lock().unwrap_or_else(|p| p.into_inner());
        let shell = shells.get_mut(&id).ok_or("no such shell")?;
        shell
            .writer
            .write_all(data.as_bytes())
            .and_then(|()| shell.writer.flush())
            .map_err(|e| e.to_string())
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

/// The reader: every chunk to the window, then the exit.
fn spawn_reader(
    sink: Arc<dyn Sink>,
    id: u32,
    mut reader: Box<dyn Read + Send>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    closed: Arc<AtomicBool>,
) {
    thread::Builder::new()
        .name(format!("terminal-{id}"))
        .spawn(move || {
            let mut buf = vec![0u8; READ_CHUNK];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => sink.send(Outgoing::Data {
                        id,
                        bytes: buf[..n].to_vec(),
                    }),
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
            sink.send(Outgoing::Exit {
                id,
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
        .expect("spawn the terminal's reader thread");
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
        .expect("spawn the terminal's title thread");
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

/// New shell in `cwd`, sized to the pane's grid.
#[tauri::command]
pub fn terminal_open(
    app: AppHandle,
    terminals: State<'_, Terminals>,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<ShellInfo, String> {
    terminals.open(Arc::new(WindowSink(app)), &cwd, cols, rows)
}

/// Keystrokes (and pastes) to the shell, as the text xterm.js produced.
#[tauri::command]
pub fn terminal_write(
    terminals: State<'_, Terminals>,
    id: u32,
    data: String,
) -> Result<(), String> {
    terminals.write(id, &data)
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
/// already exited is closed the same way.
#[tauri::command]
pub fn terminal_close(terminals: State<'_, Terminals>, id: u32) {
    terminals.close(id);
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
    fn hangup_ends_the_shell_when_the_master_drops() {
        // The backstop for the window going away without closing: the
        // master's last owner drops, the kernel hangs the line up, the
        // shell gets SIGHUP and exits.
        let t = Terminals::default();
        let (info, _rx) = open_sh(&t, &std::env::temp_dir());
        let pid = info.pid.unwrap();
        assert!(alive(pid));
        let shell = t.shells.lock().unwrap().remove(&info.id).unwrap();
        // Keep the child handle so nothing reaps it early; drop the master
        // and the writer only. The reader thread's clone is the other
        // owner of the fd; it ends when the read errors.
        let Shell {
            master,
            writer,
            child,
            ..
        } = shell;
        drop(writer);
        drop(master);
        wait_until(|| !alive(pid), "the shell to die of SIGHUP");
        let _ = child.lock().unwrap().wait();
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

    #[test]
    fn shell_names_are_the_file_name() {
        assert_eq!(shell_display_name("/bin/zsh"), "zsh");
        assert_eq!(shell_display_name("/opt/homebrew/bin/fish"), "fish");
        assert_eq!(shell_display_name("-bash"), "bash");
    }
}
