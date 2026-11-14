//! A running Bash command's latest output lines, for the trace's passing
//! text (nightshift item 633).
//!
//! The CLI streams nothing while a foreground command runs — measured on
//! 2.1.322 (`633-report-2026-11-11.md`): a `system/task_started` line
//! (`task_type: "local_bash"`, `is_backgrounded: false`) when it starts and
//! a `task_notification` when it ends, no `tool_progress`, no partial
//! output. What does exist is the CLI's own spool of the command's output,
//! written as it runs and deleted when it ends:
//! `/tmp/claude-<uid>/<cwd slug>/<session_id>/tasks/<task_id>.output`.
//! That path is the CLI's, not a documented contract (blocker 1879), so it
//! is found by search — `<session_id>/tasks/<task_id>.output` under any
//! `claude-*` folder of the temp roots — and a file that never shows up, or
//! goes, simply means no passing text. Read-only, bounded (the last
//! [`TAIL_BYTES`] of the file), throttled by the caller's tick.
//!
//! Item 656 (his "still dont see the bash text"): measured on 2.1.322 with
//! the app's flags, `task_started` comes **~3 s after** the command starts
//! (spool at 3.55 s, the line at 6.52 s) — so a command shorter than that
//! never passed any text, and a longer one only from its fourth second. So
//! the tail now starts at the main thread's Bash call ([`BashTails::call`]):
//! the spool is the one new `b…output` in the session's `tasks/` folder
//! made after the call, taken only when exactly one call waits and exactly
//! one such file is there; `task_started`, when it comes, names the right
//! file and corrects a wrong pick.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

/// How often the read loop looks at the running commands' spools: at most
/// this many updates per command reach the window (~3 a second).
pub(super) const TICK: Duration = Duration::from_millis(300);
/// Lines a row shows.
pub(super) const LINES: usize = 6;
/// The longest line kept, in characters (the row shows far less).
const LINE_CHARS: usize = 160;
/// How much of the end of the spool is read each look.
const TAIL_BYTES: u64 = 8 * 1024;
/// How long a command's spool is searched for before giving up on it.
const FIND_FOR: Duration = Duration::from_secs(20);

#[derive(Debug)]
struct Tail {
    session_id: String,
    task_id: String,
    path: Option<PathBuf>,
    started: Instant,
    /// The spool's length at the last look: unchanged → nothing to read.
    len: u64,
    sent: Vec<String>,
}

/// A main-thread Bash call whose spool is not found yet (item 656).
#[derive(Debug)]
struct Pending {
    session_id: String,
    /// The wall clock at the call: its spool is made after this.
    since: SystemTime,
    started: Instant,
}

/// The foreground Bash commands running now, by their call id.
#[derive(Debug, Default)]
pub(super) struct BashTails {
    tails: HashMap<String, Tail>,
    /// Item 656: calls seen, not yet tied to a spool.
    pending: HashMap<String, Pending>,
    /// Every spool already someone's (by task id), never picked again.
    claimed: std::collections::HashSet<String>,
    /// Where to search; the temp roots unless a test sets its own.
    roots: Vec<PathBuf>,
}

impl BashTails {
    pub(super) fn new() -> Self {
        let mut roots = vec![PathBuf::from("/tmp"), PathBuf::from("/private/tmp")];
        let tmp = std::env::temp_dir();
        if !roots.contains(&tmp) {
            roots.push(tmp);
        }
        Self {
            roots,
            ..Self::default()
        }
    }

    #[cfg(test)]
    fn with_roots(roots: Vec<PathBuf>) -> Self {
        Self {
            roots,
            ..Self::default()
        }
    }

    pub(super) fn active(&self) -> bool {
        !self.tails.is_empty() || !self.pending.is_empty()
    }

    /// The main thread called Bash in the foreground (item 656): look for
    /// its spool from now, not from its `task_started` ~3 s later.
    pub(super) fn call(&mut self, tool_use_id: String, session_id: String) {
        if tool_use_id.is_empty()
            || !safe(&session_id)
            || self.tails.contains_key(&tool_use_id)
            || self.pending.contains_key(&tool_use_id)
        {
            return;
        }
        self.pending.insert(
            tool_use_id,
            Pending {
                session_id,
                // A second's slack: the file system's clock and ours.
                since: SystemTime::now() - Duration::from_secs(1),
                started: Instant::now(),
            },
        );
    }

    /// A foreground command started (its `task_started`).
    pub(super) fn start(&mut self, tool_use_id: String, task_id: String, session_id: String) {
        if tool_use_id.is_empty() || task_id.is_empty() || session_id.is_empty() {
            return;
        }
        if !safe(&task_id) || !safe(&session_id) {
            return;
        }
        self.pending.remove(&tool_use_id);
        self.claimed.insert(task_id.clone());
        // Already tailing the file it names (656's early pick): keep it.
        if self
            .tails
            .get(&tool_use_id)
            .is_some_and(|t| t.task_id == task_id)
        {
            return;
        }
        self.tails.insert(
            tool_use_id,
            Tail {
                session_id,
                task_id,
                path: None,
                started: Instant::now(),
                len: 0,
                sent: Vec::new(),
            },
        );
    }

    /// The command ended (its result, its `task_notification`, or the turn).
    pub(super) fn end(&mut self, tool_use_id: &str) {
        self.tails.remove(tool_use_id);
        self.pending.remove(tool_use_id);
    }

    /// Item 656: the one waiting call gets the one new, unclaimed `b…`
    /// spool in its session's folder. Two calls waiting, or two files
    /// (a subagent's command beside it), and `task_started` decides.
    fn bind_pending(&mut self) {
        self.pending.retain(|_, p| p.started.elapsed() <= FIND_FOR);
        if self.pending.len() != 1 {
            return;
        }
        let (id, p) = self.pending.iter().next().unwrap();
        let Some(dir) = find_tasks_dir(&self.roots, &p.session_id) else {
            return;
        };
        let Ok(files) = std::fs::read_dir(&dir) else {
            return;
        };
        let mut fresh = Vec::new();
        for f in files.flatten() {
            let name = f.file_name().to_string_lossy().into_owned();
            let Some(task) = name.strip_suffix(".output") else {
                continue;
            };
            // Bash tasks' ids begin with `b`, agents' with `a` (measured).
            if !task.starts_with('b') || !safe(task) || self.claimed.contains(task) {
                continue;
            }
            let Ok(meta) = f.metadata() else { continue };
            let made = meta.created().or_else(|_| meta.modified());
            if made.is_ok_and(|t| t >= p.since) {
                fresh.push((task.to_string(), f.path()));
            }
        }
        if fresh.len() != 1 {
            return;
        }
        let (task_id, path) = fresh.pop().unwrap();
        let id = id.clone();
        let p = self.pending.remove(&id).unwrap();
        self.claimed.insert(task_id.clone());
        self.tails.insert(
            id,
            Tail {
                session_id: p.session_id,
                task_id,
                path: Some(path),
                started: p.started,
                len: 0,
                sent: Vec::new(),
            },
        );
    }

    /// One look at every running command: each whose last lines changed
    /// since the last look, with those lines.
    pub(super) fn poll(&mut self) -> Vec<(String, Vec<String>)> {
        self.bind_pending();
        let mut out = Vec::new();
        let mut gone = Vec::new();
        for (id, t) in self.tails.iter_mut() {
            if t.path.is_none() {
                t.path = find_spool(&self.roots, &t.session_id, &t.task_id);
                if t.path.is_none() {
                    if t.started.elapsed() > FIND_FOR {
                        gone.push(id.clone());
                    }
                    continue;
                }
            }
            let Some(path) = &t.path else { continue };
            let Some((len, bytes)) = read_tail(path) else {
                // Deleted: the command ended; its result is on its way.
                gone.push(id.clone());
                continue;
            };
            if len == t.len {
                continue;
            }
            t.len = len;
            let lines = last_lines(&bytes, LINES);
            if lines.is_empty() || lines == t.sent {
                continue;
            }
            t.sent = lines.clone();
            out.push((id.clone(), lines));
        }
        for id in gone {
            self.tails.remove(&id);
        }
        out
    }
}

/// Names only: the search joins ids into a path, so nothing that could
/// climb out of the folder it is joined to.
fn safe(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// `<root>/claude-*/*/<session>/tasks`, the first that exists (item 656).
fn find_tasks_dir(roots: &[PathBuf], session_id: &str) -> Option<PathBuf> {
    for root in roots {
        let Ok(tops) = std::fs::read_dir(root) else {
            continue;
        };
        for top in tops.flatten() {
            if !top.file_name().to_string_lossy().starts_with("claude-") {
                continue;
            }
            let Ok(slugs) = std::fs::read_dir(top.path()) else {
                continue;
            };
            for slug in slugs.flatten() {
                let p = slug.path().join(session_id).join("tasks");
                if p.is_dir() {
                    return Some(p);
                }
            }
        }
    }
    None
}

/// `<root>/claude-*/*/<session>/tasks/<task>.output`, the first that exists.
fn find_spool(roots: &[PathBuf], session_id: &str, task_id: &str) -> Option<PathBuf> {
    let file = format!("{task_id}.output");
    for root in roots {
        let Ok(tops) = std::fs::read_dir(root) else {
            continue;
        };
        for top in tops.flatten() {
            if !top.file_name().to_string_lossy().starts_with("claude-") {
                continue;
            }
            let Ok(slugs) = std::fs::read_dir(top.path()) else {
                continue;
            };
            for slug in slugs.flatten() {
                let p = slug.path().join(session_id).join("tasks").join(&file);
                if p.is_file() {
                    return Some(p);
                }
            }
        }
    }
    None
}

/// The file's length and its last [`TAIL_BYTES`]; `None` once it is gone.
fn read_tail(path: &Path) -> Option<(u64, Vec<u8>)> {
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let from = len.saturating_sub(TAIL_BYTES);
    f.seek(SeekFrom::Start(from)).ok()?;
    let mut buf = Vec::with_capacity((len - from) as usize);
    f.take(TAIL_BYTES).read_to_end(&mut buf).ok()?;
    Some((len, buf))
}

/// The last `n` non-blank lines as a terminal would show them: a carriage
/// return's rewrite keeps only what follows it, escape sequences (colour,
/// cursor) are dropped, other control characters too, and each line is cut
/// to [`LINE_CHARS`].
pub(super) fn last_lines(bytes: &[u8], n: usize) -> Vec<String> {
    let text = String::from_utf8_lossy(bytes);
    let mut out: Vec<String> = Vec::new();
    for raw in text.split('\n').rev() {
        let shown = raw
            .trim_end_matches('\r')
            .rsplit('\r')
            .next()
            .unwrap_or_default();
        let clean = strip_escapes(shown);
        let line = clean.trim_end();
        if line.trim().is_empty() {
            continue;
        }
        out.push(line.chars().take(LINE_CHARS).collect());
        if out.len() == n {
            break;
        }
    }
    out.reverse();
    out
}

fn strip_escapes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\u{1b}' {
            match it.peek() {
                // CSI: parameters, then one final byte in @..~.
                Some('[') => {
                    it.next();
                    for d in it.by_ref() {
                        if ('@'..='~').contains(&d) {
                            break;
                        }
                    }
                }
                // OSC: to BEL or ESC \.
                Some(']') => {
                    it.next();
                    while let Some(d) = it.next() {
                        if d == '\u{7}' {
                            break;
                        }
                        if d == '\u{1b}' {
                            it.next();
                            break;
                        }
                    }
                }
                Some(_) => {
                    it.next();
                }
                None => {}
            }
        } else if c == '\t' {
            out.push_str("  ");
        } else if !c.is_control() {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn last_lines_keep_what_a_terminal_shows() {
        let b = b"one\n\x1b[32mtwo\x1b[0m\n\nthree 10%\rthree 55%\rthree 90%\n  \n";
        assert_eq!(last_lines(b, 6), vec!["one", "two", "three 90%"]);
        assert_eq!(last_lines(b, 2), vec!["two", "three 90%"]);
        assert!(last_lines(b"\n\n  \n", 6).is_empty());
        let long = "x".repeat(500);
        assert_eq!(
            last_lines(long.as_bytes(), 1)[0].chars().count(),
            LINE_CHARS
        );
        // An OSC title and a tab.
        assert_eq!(last_lines(b"\x1b]0;title\x07a\tb", 1), vec!["a  b"]);
    }

    #[test]
    fn a_spool_is_found_tailed_and_dropped_when_it_goes() {
        let dir = std::env::temp_dir().join(format!("nl633-{}", std::process::id()));
        let tasks = dir
            .join("claude-501")
            .join("-Users-x")
            .join("sess-1")
            .join("tasks");
        std::fs::create_dir_all(&tasks).unwrap();
        let spool = tasks.join("b1x2.output");
        let mut tails = BashTails::with_roots(vec![dir.clone()]);
        tails.start("toolu_A".into(), "b1x2".into(), "sess-1".into());
        assert!(tails.active());
        // Not there yet: nothing, and still waited for.
        assert!(tails.poll().is_empty());
        assert!(tails.active());
        std::fs::write(&spool, "tick 0\ntick 1\n").unwrap();
        assert_eq!(
            tails.poll(),
            vec![(
                "toolu_A".to_string(),
                vec!["tick 0".into(), "tick 1".into()]
            )]
        );
        // Unchanged: nothing sent again.
        assert!(tails.poll().is_empty());
        std::fs::write(&spool, "tick 0\ntick 1\ntick 2\n").unwrap();
        assert_eq!(tails.poll()[0].1.last().unwrap(), "tick 2");
        std::fs::remove_file(&spool).unwrap();
        assert!(tails.poll().is_empty());
        assert!(!tails.active());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Item 656: the spool is tailed from the call, before `task_started`
    /// (which comes ~3 s into the command); an old file, an agent's, or a
    /// second new one is never taken; `task_started` corrects a wrong pick.
    #[test]
    fn a_call_finds_its_spool_before_task_started() {
        let dir = std::env::temp_dir().join(format!("nl656-{}", std::process::id()));
        let tasks = dir
            .join("claude-501")
            .join("-cwd")
            .join("s-656")
            .join("tasks");
        std::fs::create_dir_all(&tasks).unwrap();
        // Before the call: an older command's spool, still running.
        std::fs::write(tasks.join("bold1.output"), "old\n").unwrap();
        let mut tails = BashTails::with_roots(vec![dir.clone()]);
        // Older than the call's second of slack.
        std::thread::sleep(Duration::from_millis(1600));
        tails.call("toolu_B".into(), "s-656".into());
        assert!(tails.active());
        assert!(tails.poll().is_empty(), "the old file is not this call's");
        std::thread::sleep(Duration::from_millis(600));
        std::fs::write(tasks.join("a9agent.output"), "agent\n").unwrap();
        std::fs::write(tasks.join("bnew2.output"), "tick 1\n").unwrap();
        assert_eq!(
            tails.poll(),
            vec![("toolu_B".to_string(), vec!["tick 1".to_string()])]
        );
        // Its `task_started` names the same file: nothing restarts.
        tails.start("toolu_B".into(), "bnew2".into(), "s-656".into());
        assert!(tails.poll().is_empty());
        // A wrong pick is corrected by `task_started`.
        tails.call("toolu_C".into(), "s-656".into());
        std::fs::write(tasks.join("bwrong.output"), "not mine\n").unwrap();
        assert_eq!(tails.poll()[0].0, "toolu_C");
        std::fs::write(tasks.join("bright.output"), "mine\n").unwrap();
        tails.start("toolu_C".into(), "bright".into(), "s-656".into());
        assert_eq!(
            tails.poll(),
            vec![("toolu_C".to_string(), vec!["mine".to_string()])]
        );
        // Two calls waiting: neither guesses.
        tails.call("toolu_D".into(), "s-656".into());
        tails.call("toolu_E".into(), "s-656".into());
        std::fs::write(tasks.join("bboth.output"), "x\n").unwrap();
        assert!(tails.poll().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ids_that_could_leave_the_folder_are_refused() {
        let mut tails = BashTails::with_roots(vec![]);
        tails.start("t".into(), "../x".into(), "s".into());
        tails.start("t".into(), "x".into(), "a/b".into());
        tails.start("t".into(), "".into(), "s".into());
        assert!(!tails.active());
        tails.start("t".into(), "bx".into(), "s-1".into());
        tails.end("t");
        assert!(!tails.active());
    }
}
