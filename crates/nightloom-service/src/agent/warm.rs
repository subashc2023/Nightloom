//! The next message's `claude` process, started while he types (nightshift
//! item 256, 2026-10-03).
//!
//! Every Nightloom message starts a new Claude Code process, and before
//! that process sends anything to the model it loads the CLI, runs his
//! `SessionStart` hooks and connects every MCP server: 1.2–1.4 s of the
//! median message in his `turn-timing.log` (`spawned → init`), measured
//! again on 2026-10-03. claude.ai and an interactive CLI pay that once per
//! session; Nightloom paid it on every message.
//!
//! Measured with the real CLI (`notes/runner-design/256-report.md` in
//! nightshift-code, 2026-10-03): a process started with
//! `--input-format stream-json` does all of that start-up **before** its
//! first stdin line arrives, waits idle for it (two minutes tested), and
//! reads the resumed session file only when the line comes — a turn
//! another process added meanwhile is seen. So the window asks for a
//! process as soon as the open chat's composer holds a draft
//! ([`WarmSlot::fill`]), and the turn takes it ([`WarmSlot::take`]) when
//! its command line, environment and folder are exactly the ones the turn
//! would have spawned — anything else (another model, a granted folder, a
//! new session id after a turn) and the warm one is killed and a fresh one
//! spawned, as before. A killed idle process writes nothing to the session
//! file (measured; closing its stdin instead appends a `cost-state` line,
//! which is why it is killed).
//!
//! One per agent, [`MAX_AGE`] at most: after that it is killed by a timer
//! — a CLAUDE.md edited or a git status changed since it started would be
//! stale in it, and an idle CLI holds ~300 MB with its MCP servers.

use super::AgentSpec;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};
use tokio::process::{Child, Command};

/// How long a started process waits for its message before it is killed.
pub const MAX_AGE: Duration = Duration::from_secs(5 * 60);

/// Whether a message goes to the CLI as a stdin line. Every chat message
/// does, warm or not — the stdin shape reached its first text ~0.6 s
/// sooner than the prompt on argv (measured, 2026-10-03) — except one
/// that starts with `/`: on argv the CLI reads that as a slash command,
/// and this keeps it so.
pub fn suits_stdin(text: &str) -> bool {
    !text.trim_start().starts_with('/')
}

/// Everything that makes two processes the same process: what the turn
/// would spawn is compared with what was started, field by field.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Key {
    binary: String,
    args: Vec<String>,
    cwd: PathBuf,
    env_set: Vec<(&'static str, String)>,
    env_removed: Vec<&'static str>,
}

impl Key {
    pub fn of(spec: &AgentSpec, args: &[String]) -> Self {
        Self {
            binary: super::resolve_binary(&spec.binary),
            args: args.to_vec(),
            cwd: spec.workspace.clone(),
            env_set: spec.env_set(),
            env_removed: spec.env_removed().to_vec(),
        }
    }

    /// The command this key names, its stdin as given.
    pub fn command(&self, stdin: Stdio) -> Command {
        let mut cmd = Command::new(&self.binary);
        cmd.args(&self.args)
            .stdin(stdin)
            .current_dir(&self.cwd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // The environment, spelled once for this process and for the
        // checkpoint fork's (`AgentSpec::env_removed` / `env_set`, backlog
        // 104): the key kept out so the subscription is what pays, the
        // compaction switch, the CLI's own subagent limits, fork mode.
        for k in &self.env_removed {
            cmd.env_remove(k);
        }
        for (k, v) in &self.env_set {
            cmd.env(k, v);
        }
        cmd
    }
}

struct Warm {
    child: Child,
    key: Key,
    born: Instant,
    /// Which fill this is, so a timer kills only the process it was set for.
    n: u64,
}

#[derive(Default)]
struct Inner {
    warm: Option<Warm>,
    fills: u64,
}

/// An agent's one waiting process, if any. Dropping the slot (the agent
/// dropped on a disconnect or a closed chat) kills it.
#[derive(Default)]
pub struct WarmSlot(Arc<Mutex<Inner>>);

impl WarmSlot {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Start a process for `key` unless one for it is already waiting.
    /// `true` when a new one was started. Needs a tokio runtime.
    pub fn fill(&self, key: Key) -> std::io::Result<bool> {
        let mut inner = self.lock();
        if let Some(w) = &mut inner.warm
            && w.key == key
            && w.born.elapsed() < MAX_AGE
            && matches!(w.child.try_wait(), Ok(None))
        {
            return Ok(false);
        }
        // Another key, too old, or exited: dropped, which kills it.
        inner.warm = None;
        let child = key.command(Stdio::piped()).spawn()?;
        inner.fills += 1;
        let n = inner.fills;
        inner.warm = Some(Warm {
            child,
            key,
            born: Instant::now(),
            n,
        });
        drop(inner);
        let weak: Weak<Mutex<Inner>> = Arc::downgrade(&self.0);
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn(async move {
                tokio::time::sleep(MAX_AGE).await;
                if let Some(slot) = weak.upgrade() {
                    let mut inner = slot.lock().unwrap_or_else(|p| p.into_inner());
                    if inner.warm.as_ref().is_some_and(|w| w.n == n) {
                        inner.warm = None;
                    }
                }
            });
        }
        Ok(true)
    }

    /// The waiting process, if it is exactly the one `key` would spawn,
    /// still running and young enough; any other is killed.
    pub fn take(&self, key: &Key) -> Option<Child> {
        let mut w = self.lock().warm.take()?;
        (w.key == *key && w.born.elapsed() < MAX_AGE && matches!(w.child.try_wait(), Ok(None)))
            .then_some(w.child)
    }

    /// Whether a process is waiting (for tests and the report).
    pub fn waiting(&self) -> bool {
        self.lock().warm.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec_with(dir: &std::path::Path, body: &str) -> AgentSpec {
        let path = dir.join("claude-stand-in");
        std::fs::write(&path, format!("#!/bin/sh\n{body}")).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut spec = AgentSpec::new(dir);
        spec.binary = path.to_string_lossy().into_owned();
        spec
    }

    fn scratch() -> PathBuf {
        let d = std::env::temp_dir().join(format!("nightloom-warm-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_slash_command_stays_on_argv() {
        assert!(suits_stdin("hello"));
        assert!(suits_stdin("a/b"));
        assert!(!suits_stdin("/compact"));
        assert!(!suits_stdin("  /review"));
    }

    #[tokio::test]
    async fn the_waiting_process_is_taken_only_by_the_same_command() {
        let dir = scratch();
        // Waits on stdin as the CLI does.
        let spec = spec_with(&dir, "read line\n");
        let slot = WarmSlot::default();
        let key = Key::of(&spec, &spec.stdin_args());
        assert!(slot.fill(key.clone()).unwrap());
        // The same key again starts nothing new.
        assert!(!slot.fill(key.clone()).unwrap());
        // Another model: not taken, and the waiting one is gone.
        let mut other = spec.clone();
        other.model = Some("haiku".into());
        assert!(slot.take(&Key::of(&other, &other.stdin_args())).is_none());
        assert!(!slot.waiting());
        // Refilled, then taken by its own key.
        assert!(slot.fill(key.clone()).unwrap());
        let child = slot.take(&key).expect("the same command");
        assert!(child.id().is_some());
        assert!(!slot.waiting());
    }

    #[tokio::test]
    async fn an_exited_process_is_never_taken() {
        let dir = scratch();
        let spec = spec_with(&dir, "exit 0\n");
        let slot = WarmSlot::default();
        let key = Key::of(&spec, &spec.stdin_args());
        slot.fill(key.clone()).unwrap();
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(slot.take(&key).is_none());
    }

    /// A stand-in CLI that, like the real one, says `init` only once its
    /// stdin line has come, then streams one word.
    const READS_THEN_ANSWERS: &str = r##"read line
printf '%s\n' '{"type":"system","subtype":"init","cwd":"x","tools":[],"mcp_servers":[],"model":"claude-haiku-4-5","permissionMode":"default","session_id":"s-1"}'
printf '%s\n' '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}},"parent_tool_use_id":null,"session_id":"s-1"}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"hi","session_id":"s-1","stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":2}}'
"##;

    #[tokio::test]
    async fn a_turn_takes_the_waiting_process_and_says_so_on_its_line() {
        use crate::agent::ClaudeCodeAgent;
        use crate::turn_timing::{self, TurnTiming};
        let dir = scratch();
        let mut agent = ClaudeCodeAgent::new(spec_with(&dir, READS_THEN_ANSWERS));
        assert!(agent.prewarm().unwrap());
        assert!(!agent.prewarm().unwrap(), "the same one is already waiting");
        for want_warm in [true, false] {
            let timing = TurnTiming::begin(turn_timing::SERVE, None, None);
            agent.set_timing(Some(timing.clone()));
            let cancel = tokio_util::sync::CancellationToken::new();
            let out = agent.run_turn("hello", &cancel, &mut |_| {}).await.unwrap();
            agent.set_timing(None);
            assert_eq!(out.text, "hi");
            let s = timing.stages();
            assert_eq!(s.warm, Some(want_warm));
            assert!(s.first_event.is_some() && s.first_text.is_some());
            // Taken: nothing waits after the turn.
            assert!(!agent.warm.waiting());
        }
    }

    #[test]
    fn the_key_names_a_new_session_or_a_granted_folder_as_different() {
        let dir = scratch();
        let spec = spec_with(&dir, "");
        let a = Key::of(&spec, &spec.stdin_args());
        let mut resumed = spec.clone();
        resumed.resume = Some("s-2".into());
        assert_ne!(a, Key::of(&resumed, &resumed.stdin_args()));
        let mut granted = spec.clone();
        granted.add_dirs.push(dir.join("more"));
        assert_ne!(a, Key::of(&granted, &granted.stdin_args()));
        assert_eq!(a, Key::of(&spec.clone(), &spec.stdin_args()));
    }

    /// The 256 measurement with the real CLI (`cargo test -p
    /// nightloom-service --lib measure_warm -- --ignored --nocapture`):
    /// Send → first text for the old shape (prompt on argv), the new cold
    /// shape (stdin line) and a warm process, `N` rounds each, haiku, no
    /// session kept. Bills a few one-word replies to whatever the CLI is
    /// logged in as.
    #[tokio::test]
    #[ignore]
    async fn measure_warm_against_cold_with_the_real_cli() {
        use crate::agent::ClaudeCodeAgent;
        use crate::turn_timing::{self, TurnTiming, median};
        const N: usize = 6;
        let dir = scratch();
        let mut spec = AgentSpec::new(&dir);
        spec.binary = "claude".into();
        spec.model = Some("haiku".into());
        spec.no_session_persistence = true;
        let mut agent = ClaudeCodeAgent::new(spec.clone());
        let prompt = "Reply with the single word: ok";
        let mut rows: Vec<(&str, Vec<i64>, Vec<i64>)> = Vec::new();
        for shape in ["argv (before)", "stdin, cold", "stdin, warm"] {
            let (mut init, mut text) = (Vec::new(), Vec::new());
            for _ in 0..N {
                if shape == "stdin, warm" {
                    agent.prewarm().unwrap();
                    // He is typing.
                    tokio::time::sleep(Duration::from_secs(3)).await;
                }
                let timing = TurnTiming::begin(turn_timing::SERVE, None, None);
                agent.set_timing(Some(timing.clone()));
                let cancel = tokio_util::sync::CancellationToken::new();
                let out = if shape == "argv (before)" {
                    agent.run_with(&spec, prompt, &cancel, &mut |_| {}).await
                } else {
                    agent.run_turn(prompt, &cancel, &mut |_| {}).await
                };
                agent.set_timing(None);
                out.unwrap();
                let s = timing.stages();
                let at = |x: Option<u64>| x.unwrap() as i64 - s.entered.unwrap() as i64;
                init.push(at(s.init));
                text.push(at(s.first_text));
            }
            println!("{shape}: init {init:?} first text {text:?}");
            rows.push((shape, init, text));
        }
        for (shape, init, text) in rows {
            println!(
                "{shape}: median send→init {} ms, send→first text {} ms",
                median(init).unwrap(),
                median(text).unwrap()
            );
        }
    }
}
