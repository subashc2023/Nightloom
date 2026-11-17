//! Warm a cold chat's cache before an aside (nightshift item 787).
//!
//! An aside's request ends with its own question, and Claude Code marks
//! only the end of each request for the cache, so the aside's write is
//! the chat *plus the question* — never a prefix of the chat's next
//! request, which then finds only the system prompt and tools (786's
//! measurement: 27,014 of ~67k read after an aside on a cold chat).
//! There is no flag that places the mark elsewhere.
//!
//! The CLI does have its own "resume cache warm": with `CLAUDE_CODE_REMOTE`
//! and `CLAUDE_CODE_RESUME_CACHE_WARM` set, a resumed process that is given
//! no message within ~2 s of its `initialize` sends one request of one
//! output token that re-sends the chat's last request — the transcript up
//! to its newest user message, marked there. Captured on CLI 2.1.326 (no
//! model call, a local recorder): the same system blocks, the same tools
//! and the same messages as the chat's next turn up to that point, so the
//! next turn and the aside both read it. It skips itself when the account
//! is past a usage warning, the last reply is another model's, the chat
//! holds uploads, and in a few other cases — then nothing is sent and this
//! gives up after [`START_WAIT`].
//!
//! So [`run`] starts the aside's own command (the aside's spec, the chat's
//! model: the same prefix) with those two variables, sends `initialize`
//! and nothing else, and waits on the CLI's debug log for the warm
//! request to finish. The process is killed after: no session file (the
//! aside's `--no-session-persistence`), no reply.

use super::AgentSpec;
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

/// The variables that turn the CLI's own resume warm on.
pub const ENV: [(&str, &str); 2] = [
    ("CLAUDE_CODE_REMOTE", "1"),
    ("CLAUDE_CODE_RESUME_CACHE_WARM", "1"),
];
/// How long the warm request has to start: sent 2.4 s after the spawn in
/// the captures; past this it skipped itself.
pub const START_WAIT: Duration = Duration::from_secs(8);
/// How long a started warm request has to finish (a long chat's prefix
/// is written at prefill speed).
pub const FINISH_WAIT: Duration = Duration::from_secs(180);
/// The debug log's line for the warm request going out.
const SENT: &str = "source=resume_cache_warm";
/// … and for its end.
const FINISHED: &str = "[resume_cache_warm] finished";
/// The control request that starts the session without a message.
const INITIALIZE: &str = r#"{"type":"control_request","request_id":"nightloom-warm","request":{"subtype":"initialize"}}"#;

/// How a warm ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Warm {
    /// The request went out and finished: the chat's prefix is written.
    Written,
    /// The CLI did not send one (one of its own skips) within [`START_WAIT`].
    Skipped,
    /// Sent, but not finished within [`FINISH_WAIT`].
    TimedOut,
    /// Stopped by the aside's cancel.
    Cancelled,
    /// The process did not start, or the log could not be read.
    Failed(String),
}

/// What the CLI's debug log says so far: (sent, finished). Pure.
pub fn read_log(text: &str) -> (bool, bool) {
    (text.contains(SENT), text.contains(FINISHED))
}

/// The warm's command: `spec`'s stdin shape (an aside's, so the prefix is
/// the chat's), its debug log at `debug`, the two variables. Its output
/// is not read.
pub fn command(spec: &AgentSpec, debug: &Path) -> Command {
    let args = spec.stdin_args();
    let mut cmd = super::warm::Key::of(spec, &args).command(Stdio::piped());
    cmd.arg("--debug-file")
        .arg(debug)
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    for (k, v) in ENV {
        cmd.env(k, v);
    }
    cmd
}

/// Warm `spec`'s session (see the module doc). Never fails the aside: the
/// caller asks it either way.
pub async fn run(spec: &AgentSpec, cancel: &CancellationToken) -> Warm {
    let debug =
        std::env::temp_dir().join(format!("nightloom-cache-warm-{}.log", uuid::Uuid::new_v4()));
    let end = drive(spec, &debug, cancel).await;
    let _ = std::fs::remove_file(&debug);
    end
}

async fn drive(spec: &AgentSpec, debug: &Path, cancel: &CancellationToken) -> Warm {
    let mut child = match command(spec, debug).spawn() {
        Ok(c) => c,
        Err(e) => return Warm::Failed(e.to_string()),
    };
    let mut stdin = child.stdin.take();
    if let Some(s) = stdin.as_mut()
        && s.write_all(format!("{INITIALIZE}\n").as_bytes())
            .await
            .is_err()
    {
        return Warm::Failed("the CLI closed its input".into());
    }
    let started = Instant::now();
    let mut sent_at: Option<Instant> = None;
    let end = loop {
        tokio::select! {
            _ = cancel.cancelled() => break Warm::Cancelled,
            _ = tokio::time::sleep(Duration::from_millis(200)) => {}
        }
        let text = std::fs::read_to_string(debug).unwrap_or_default();
        let (sent, finished) = read_log(&text);
        if finished {
            break Warm::Written;
        }
        if sent && sent_at.is_none() {
            sent_at = Some(Instant::now());
        }
        match sent_at {
            None if started.elapsed() > START_WAIT => break Warm::Skipped,
            Some(at) if at.elapsed() > FINISH_WAIT => break Warm::TimedOut,
            _ => {}
        }
        if let Ok(Some(_)) = child.try_wait() {
            break if sent { Warm::TimedOut } else { Warm::Skipped };
        }
    };
    drop(stdin);
    let _ = child.kill().await;
    end
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_log_says_sent_then_finished() {
        assert_eq!(read_log(""), (false, false));
        let sent =
            "[DEBUG] [API REQUEST] /v1/messages x-client-request-id=a source=resume_cache_warm";
        assert_eq!(read_log(sent), (true, false));
        let done = format!(
            "{sent}\n[DEBUG] Forked agent [resume_cache_warm] finished: 1 messages, types=[assistant]"
        );
        assert_eq!(read_log(&done), (true, true));
    }

    /// The warm is the aside's own command — the stdin shape, the fork that
    /// keeps nothing — with the debug log and the two variables.
    #[test]
    fn the_command_is_the_asides_with_the_warm_switched_on() {
        let mut chat = AgentSpec::new(Path::new("/tmp"));
        chat.resume = Some("s-1".into());
        let spec = chat.aside().expect("a session to ask beside");
        let cmd = command(&spec, Path::new("/tmp/w.log"));
        let std = cmd.as_std();
        let args: Vec<String> = std
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        for want in [
            "--input-format",
            "stream-json",
            "--fork-session",
            "--no-session-persistence",
            "--resume",
            "s-1",
        ] {
            assert!(args.iter().any(|a| a == want), "{want} in {args:?}");
        }
        let at = args
            .iter()
            .position(|a| a == "--debug-file")
            .expect("debug log");
        assert_eq!(args[at + 1], "/tmp/w.log");
        let envs: Vec<(String, Option<String>)> = std
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect();
        for (k, v) in ENV {
            assert!(
                envs.iter()
                    .any(|(ek, ev)| ek == k && ev.as_deref() == Some(v)),
                "{k} in {envs:?}"
            );
        }
    }

    /// A stand-in CLI that never sends the warm is given up on, not waited
    /// on for long.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_cli_that_sends_nothing_is_a_skip() {
        let root = std::env::temp_dir().join(format!("nightloom-787-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let bin = root.join("claude-quiet");
        std::fs::write(&bin, "#!/bin/sh\nexit 0\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut chat = AgentSpec::new(&root);
        chat.binary = bin.to_string_lossy().into_owned();
        chat.resume = Some("s-1".into());
        let spec = chat.aside().unwrap();
        let started = Instant::now();
        assert_eq!(run(&spec, &CancellationToken::new()).await, Warm::Skipped);
        assert!(started.elapsed() < START_WAIT + Duration::from_secs(2));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// One that writes the two lines is a written cache.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_cli_that_logs_the_warm_is_written() {
        let root = std::env::temp_dir().join(format!("nightloom-787w-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let bin = root.join("claude-warm");
        // The debug log is the argument after `--debug-file`.
        let script = "#!/bin/sh\nwhile [ \"$1\" != --debug-file ]; do shift; done\nprintf '%s\\n' 'x source=resume_cache_warm' '[resume_cache_warm] finished: 1' > \"$2\"\nsleep 5\n";
        std::fs::write(&bin, script).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut chat = AgentSpec::new(&root);
        chat.binary = bin.to_string_lossy().into_owned();
        chat.resume = Some("s-1".into());
        let spec = chat.aside().unwrap();
        assert_eq!(run(&spec, &CancellationToken::new()).await, Warm::Written);
        let _ = std::fs::remove_dir_all(&root);
    }
}
