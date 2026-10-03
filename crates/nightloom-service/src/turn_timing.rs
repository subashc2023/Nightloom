//! One timing line per message (nightshift item 256, 2026-09-30).
//!
//! He asked whether Nightloom adds time between Send and the first word of
//! the reply. The 256 note (`notes/runner-design/256-latency-2026-09-29.md`
//! in nightshift-code) measured the CLI from a shell; what it could not see
//! is the app's own part — the window before the command, the command
//! before the spawn, and the first event before it is painted. So every
//! agent turn appends one line to `<config dir>/logs/turn-timing.log`, in
//! connect.log's shape (item 222): the time of each stage as milliseconds
//! after Send.
//!
//! | stage | taken by | when |
//! |---|---|---|
//! | `sent` | the window | Send pressed (`send` in `state.svelte.ts`) |
//! | `invoked` | the window | the `send_agent` command called (after a cold chat's reconnect) |
//! | `entered` | the desktop's `send_agent` | the command's first line |
//! | `turn` | [`run_agent_turn`](crate::agent_turn::run_agent_turn) | its first line, after the chat's locks and the checkpoint |
//! | `spawned` | the agent | the `claude` process started |
//! | `init` | the agent | the CLI's `system/init` line read (hooks and MCP servers done) |
//! | `first event` | the agent | the model's first streamed event (`stream_event`; added 2026-10-03) |
//! | `first text` | the agent | the first `text_delta` translated |
//! | `emitted` | the turn | that event handed to the window (or the phone) |
//! | `painted` | the window | the frame that draws the first text |
//! | `end` | the turn | the turn returned |
//!
//! After the stages, `spawn warm` or `spawn cold` (2026-10-03): whether the
//! turn took the process started while he typed (`agent::warm`) or
//! started its own. Absent when no process was reached.
//!
//! On `serve` there is no window: `sent`, `invoked` and `painted` are
//! absent (`-`), never zero, and the offsets count from `entered`. No
//! message text and no path goes on the line; the chat is named by id.
//!
//! The window's marks reach here after the turn's end as often as before
//! it (a stand-in turn ends within milliseconds of its first word), so the
//! line is written by whichever comes second — the turn's end or the
//! window's report ([`window_marks`]) — and, when the window never reports
//! (the app closed, the chat's window gone), by a timer [`WINDOW_WAIT`]
//! after the end, with the window's stages absent.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// How long a turn's line waits for the window's marks after the turn
/// ended. The window reports at its first paint or, failing that, as its
/// own `sendAgent` returns — milliseconds after the end either way.
pub const WINDOW_WAIT: Duration = Duration::from_secs(3);

/// A stage the Rust side marks; the first mark of each wins.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mark {
    Entered,
    Started,
    Spawned,
    Init,
    FirstText,
    Emitted,
    FirstEvent,
}

const MARKS: usize = 7;

impl Mark {
    fn slot(self) -> usize {
        self as usize
    }
}

/// What the window measured (`turnTiming.ts`): epoch milliseconds.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Deserialize)]
pub struct WindowMarks {
    pub sent: u64,
    #[serde(default)]
    pub invoked: Option<u64>,
    #[serde(default)]
    pub painted: Option<u64>,
}

/// Every stage of one turn, as epoch milliseconds; the input of [`line`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Stages {
    pub sent: Option<u64>,
    pub invoked: Option<u64>,
    pub entered: Option<u64>,
    pub turn: Option<u64>,
    pub spawned: Option<u64>,
    pub init: Option<u64>,
    pub first_event: Option<u64>,
    pub first_text: Option<u64>,
    pub emitted: Option<u64>,
    pub painted: Option<u64>,
    pub end: Option<u64>,
    /// The turn took the waiting process (`Some(true)`) or spawned its
    /// own (`Some(false)`); `None` when no process was reached.
    pub warm: Option<bool>,
}

impl Stages {
    /// In the line's order, with the line's names.
    pub fn named(&self) -> [(&'static str, Option<u64>); 11] {
        [
            ("sent", self.sent),
            ("invoked", self.invoked),
            ("entered", self.entered),
            ("turn", self.turn),
            ("spawned", self.spawned),
            ("init", self.init),
            ("first event", self.first_event),
            ("first text", self.first_text),
            ("emitted", self.emitted),
            ("painted", self.painted),
            ("end", self.end),
        ]
    }

    /// The clock the offsets count from: Send, or the command's entry
    /// where there is no window.
    pub fn base(&self) -> Option<(&'static str, u64)> {
        self.sent
            .map(|s| ("send", s))
            .or_else(|| self.entered.map(|e| ("entered", e)))
            .or_else(|| self.turn.map(|t| ("turn", t)))
    }
}

/// The text after the timestamp: `turn desktop chat <id>: from send;
/// sent +0, invoked +4, …, painted -, end +1520 ms; ok`. A stage that was
/// not reached (or does not exist on this host) is `-`, never `+0`.
pub fn line(host: &str, chat: &str, stages: &Stages, outcome: &str) -> String {
    let (from, base) = stages.base().unwrap_or(("nothing", 0));
    let parts = stages
        .named()
        .iter()
        .map(|(name, at)| match at {
            Some(t) => format!("{name} +{}", *t as i64 - base as i64),
            None => format!("{name} -"),
        })
        .collect::<Vec<_>>()
        .join(", ");
    let chat = if chat.is_empty() { "-" } else { chat };
    let spawn = match stages.warm {
        Some(true) => "; spawn warm",
        Some(false) => "; spawn cold",
        None => "",
    };
    format!("turn {host} chat {chat}: from {from}; {parts} ms{spawn}; {outcome}")
}

/// Milliseconds since the epoch: the one clock the window (`Date.now()`)
/// and this process share.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `<config dir>/logs/turn-timing.log`, or `None` with no config dir.
pub fn log_path() -> Option<PathBuf> {
    crate::project::config_dir().map(|c| c.join("logs").join("turn-timing.log"))
}

/// Append one line, creating the folder; best-effort, as connect.log's.
pub fn append(path: &Path, line: &str) {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(f, "{line}");
    }
}

/// The host a turn ran on, as the line names it.
pub const DESKTOP: &str = "desktop";
pub const SERVE: &str = "serve";

struct Inner {
    chat: String,
    marks: [Option<u64>; MARKS],
    window: Option<WindowMarks>,
    end: Option<(u64, String)>,
    written: bool,
    warm: Option<bool>,
}

/// One turn's marks, shared by the command, the turn and the agent.
pub struct TurnTiming {
    host: &'static str,
    /// The window's name for the turn (its stop key), under which its
    /// marks arrive; `None` where there is no window to wait for.
    key: Option<String>,
    /// Where the line goes; `None` writes nowhere.
    log: Option<PathBuf>,
    inner: Mutex<Inner>,
}

fn registry() -> &'static Mutex<HashMap<String, Arc<TurnTiming>>> {
    static PENDING: OnceLock<Mutex<HashMap<String, Arc<TurnTiming>>>> = OnceLock::new();
    PENDING.get_or_init(Default::default)
}

impl TurnTiming {
    /// A turn entered now. With `key`, the window's marks are awaited
    /// under it (see [`window_marks`]).
    pub fn begin(host: &'static str, key: Option<String>, log: Option<PathBuf>) -> Arc<Self> {
        let t = Arc::new(Self {
            host,
            key: key.clone(),
            log,
            inner: Mutex::new(Inner {
                chat: String::new(),
                marks: [None; MARKS],
                window: None,
                end: None,
                written: false,
                warm: None,
            }),
        });
        t.mark(Mark::Entered);
        if let Some(k) = key {
            registry()
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .insert(k, t.clone());
        }
        t
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// The first time `mark` is reached; later ones are ignored.
    pub fn mark(&self, mark: Mark) {
        self.mark_at(mark, now_ms());
    }

    pub fn mark_at(&self, mark: Mark, at: u64) {
        let mut inner = self.lock();
        let slot = &mut inner.marks[mark.slot()];
        if slot.is_none() {
            *slot = Some(at);
        }
    }

    pub fn has(&self, mark: Mark) -> bool {
        self.lock().marks[mark.slot()].is_some()
    }

    /// Whether the turn's process was the waiting one (`agent::warm`);
    /// the first call wins, as a mark's.
    pub fn set_warm(&self, warm: bool) {
        let mut inner = self.lock();
        if inner.warm.is_none() {
            inner.warm = Some(warm);
        }
    }

    pub fn set_chat(&self, chat: &str) {
        self.lock().chat = chat.to_string();
    }

    /// Every stage so far.
    pub fn stages(&self) -> Stages {
        let inner = self.lock();
        let m = &inner.marks;
        let w = inner.window;
        Stages {
            sent: w.map(|w| w.sent),
            invoked: w.and_then(|w| w.invoked),
            entered: m[Mark::Entered.slot()],
            turn: m[Mark::Started.slot()],
            spawned: m[Mark::Spawned.slot()],
            init: m[Mark::Init.slot()],
            first_event: m[Mark::FirstEvent.slot()],
            first_text: m[Mark::FirstText.slot()],
            emitted: m[Mark::Emitted.slot()],
            painted: w.and_then(|w| w.painted),
            end: inner.end.as_ref().map(|e| e.0),
            warm: inner.warm,
        }
    }

    /// The turn returned with `outcome` (`ok`, `error`, `stopped`). The
    /// line is written now unless the window's marks are still to come;
    /// then by them, or [`WINDOW_WAIT`] from now without them.
    pub fn end(self: &Arc<Self>, outcome: &str) {
        let waiting = {
            let mut inner = self.lock();
            if inner.end.is_some() {
                return;
            }
            inner.end = Some((now_ms(), outcome.to_string()));
            self.key.is_some() && inner.window.is_none()
        };
        if !waiting {
            self.write();
            return;
        }
        let me = self.clone();
        match tokio::runtime::Handle::try_current() {
            Ok(rt) => {
                rt.spawn(async move {
                    tokio::time::sleep(WINDOW_WAIT).await;
                    me.write();
                });
            }
            Err(_) => me.write(),
        }
    }

    /// Ends the turn as `error` when dropped before anything else ended
    /// it — a command that returned early (not connected, a bad council)
    /// still writes its line and leaves nothing waiting.
    pub fn end_guard(self: &Arc<Self>) -> EndGuard {
        EndGuard(self.clone())
    }

    fn take_window(&self, marks: WindowMarks) -> bool {
        let mut inner = self.lock();
        if inner.window.is_none() {
            inner.window = Some(marks);
        }
        inner.end.is_some()
    }

    /// The line, once: later calls do nothing.
    pub fn write(&self) {
        let text = {
            let mut inner = self.lock();
            if inner.written {
                return;
            }
            inner.written = true;
            drop(inner);
            let stages = self.stages();
            let inner = self.lock();
            let outcome = inner.end.as_ref().map(|e| e.1.as_str()).unwrap_or("open");
            line(self.host, &inner.chat, &stages, outcome)
        };
        if let Some(k) = &self.key {
            let mut reg = registry().lock().unwrap_or_else(|p| p.into_inner());
            if reg.get(k).is_some_and(|t| std::ptr::eq(&**t, self)) {
                reg.remove(k);
            }
        }
        if let Some(path) = &self.log {
            append(path, &format!("{} {text}", chrono::Utc::now().to_rfc3339()));
        }
    }
}

/// See [`TurnTiming::end_guard`].
pub struct EndGuard(Arc<TurnTiming>);

impl Drop for EndGuard {
    fn drop(&mut self) {
        self.0.end("error");
    }
}

/// The window's marks for the turn it named `key`: kept, and the line
/// written if the turn has already ended. A key no turn is waiting under
/// (its line already written without them) is ignored.
pub fn window_marks(key: &str, marks: WindowMarks) {
    let t = registry()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(key)
        .cloned();
    if let Some(t) = t
        && t.take_window(marks)
    {
        t.write();
    }
}

/// The middle value of `xs` (the upper one of an even count), for the
/// 256 measurement's medians; `None` when empty.
pub fn median(mut xs: Vec<i64>) -> Option<i64> {
    xs.sort_unstable();
    xs.get(xs.len() / 2).copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!("nightloom-turn-timing-{}", uuid::Uuid::new_v4()))
            .join(name)
    }

    #[test]
    fn the_line_counts_from_send_and_marks_a_missing_stage_absent() {
        let s = Stages {
            sent: Some(1000),
            invoked: Some(1004),
            entered: Some(1006),
            turn: Some(1009),
            spawned: Some(1012),
            init: Some(1500),
            first_event: Some(2400),
            first_text: Some(2900),
            emitted: Some(2901),
            painted: None,
            end: Some(3200),
            warm: Some(true),
        };
        assert_eq!(
            line(DESKTOP, "c-1", &s, "ok"),
            "turn desktop chat c-1: from send; sent +0, invoked +4, entered +6, turn +9, \
             spawned +12, init +500, first event +1400, first text +1900, emitted +1901, \
             painted -, end +2200 ms; spawn warm; ok"
        );
        let cold = Stages {
            warm: Some(false),
            ..s.clone()
        };
        assert!(line(DESKTOP, "c-1", &cold, "ok").ends_with("ms; spawn cold; ok"));
    }

    #[test]
    fn on_serve_the_window_stages_are_absent_and_offsets_count_from_entry() {
        let s = Stages {
            entered: Some(50),
            turn: Some(51),
            spawned: Some(60),
            end: Some(90),
            ..Default::default()
        };
        let l = line(SERVE, "", &s, "error");
        assert!(
            l.starts_with("turn serve chat -: from entered; sent -, invoked -, entered +0"),
            "{l}"
        );
        assert!(l.contains("painted -, end +40 ms; error"), "{l}");
        assert!(!l.contains("sent +"), "{l}");
    }

    #[test]
    fn a_stage_reached_twice_keeps_its_first_time() {
        let t = TurnTiming::begin(SERVE, None, None);
        t.mark_at(Mark::Spawned, 10);
        t.mark_at(Mark::Spawned, 99);
        assert_eq!(t.stages().spawned, Some(10));
        assert!(t.has(Mark::Spawned));
        assert!(!t.has(Mark::Init));
    }

    #[test]
    fn without_a_window_the_line_is_written_at_the_end_once() {
        let log = scratch("turn-timing.log");
        let t = TurnTiming::begin(SERVE, None, Some(log.clone()));
        t.set_chat("abc");
        t.end("ok");
        t.end("error");
        t.write();
        let text = std::fs::read_to_string(&log).unwrap();
        assert_eq!(text.lines().count(), 1, "{text}");
        assert!(
            text.contains("turn serve chat abc: from entered;"),
            "{text}"
        );
        assert!(text.trim_end().ends_with("; ok"), "{text}");
    }

    #[test]
    fn the_window_marks_arriving_after_the_end_write_the_line_with_them() {
        let log = scratch("turn-timing.log");
        let key = format!("k-{}", uuid::Uuid::new_v4());
        let t = TurnTiming::begin(DESKTOP, Some(key.clone()), Some(log.clone()));
        t.set_chat("c");
        // No runtime here: `end` without one writes at once, so take the
        // window's marks first to exercise the "end comes second" order,
        // then a separate turn for "window comes second".
        let entered = t.stages().entered.unwrap();
        window_marks(
            &key,
            WindowMarks {
                sent: entered - 20,
                invoked: Some(entered - 2),
                painted: Some(entered + 300),
            },
        );
        assert!(!log.exists(), "written before the end");
        t.end("ok");
        let text = std::fs::read_to_string(&log).unwrap();
        assert!(
            text.contains("from send; sent +0, invoked +18, entered +20"),
            "{text}"
        );
        assert!(text.contains("painted +320"), "{text}");
        // Its key is gone: a late report changes nothing.
        window_marks(&key, WindowMarks::default());
        assert_eq!(std::fs::read_to_string(&log).unwrap().lines().count(), 1);
    }

    #[tokio::test]
    async fn the_end_waits_for_the_window_and_its_report_writes_the_line() {
        let log = scratch("turn-timing.log");
        let key = format!("k-{}", uuid::Uuid::new_v4());
        let t = TurnTiming::begin(DESKTOP, Some(key.clone()), Some(log.clone()));
        t.end("stopped");
        assert!(!log.exists(), "written without waiting for the window");
        let entered = t.stages().entered.unwrap();
        window_marks(
            &key,
            WindowMarks {
                sent: entered,
                invoked: None,
                painted: None,
            },
        );
        let text = std::fs::read_to_string(&log).unwrap();
        assert!(text.contains("invoked -"), "{text}");
        assert!(text.contains("painted -"), "{text}");
        assert!(text.trim_end().ends_with("; stopped"), "{text}");
    }

    #[test]
    fn median_is_the_middle_value() {
        assert_eq!(median(vec![]), None);
        assert_eq!(median(vec![5, 1, 3]), Some(3));
        assert_eq!(median(vec![4, 1, 3, 2]), Some(3));
    }
}
