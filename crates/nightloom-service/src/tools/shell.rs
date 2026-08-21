//! Running a shell command.

use super::{INTERRUPTED, Root, truncated};
use nightloom_core::ToolDef;
use nightloom_core::tool::{CancellationToken, Tool};
use serde_json::{Value, json};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
/// Hard ceiling. A tool call blocks the turn, and a turn that never returns
/// is worse for the model than a command it has to re-run in the background.
const MAX_TIMEOUT_MS: u64 = 600_000;
const MIN_TIMEOUT_MS: u64 = 100;
/// How long to keep reading the pipes after the shell has been killed.
///
/// Killing a process is not the same as closing the pipes it was writing to.
/// On Windows a killed `cmd` does not take its children with it, and a
/// surviving grandchild still holds the handles it inherited — so reading to
/// end of file waits for *that* process, which is the wait the kill was
/// supposed to end. Measured before this existed: a command killed after 500
/// ms returned 29 seconds later, when its `ping -n 30` finally finished. The
/// timeout was bounding nothing.
///
/// So the read is given a moment to collect what is already buffered and then
/// abandoned. Long enough that a shell which really is finishing gets to
/// flush, short enough that it is not the wait itself.
const PUMP_GRACE: Duration = Duration::from_secs(2);

/// Output captured so far, readable whether or not the reader ever finishes.
type Captured = Arc<Mutex<Vec<u8>>>;

const BASH_DESC: &str = "Run a shell command from the workspace root and get back its exit code, its \
     stdout, and then whatever it wrote to stderr under a [stderr] marker. A nonzero exit \
     code is a result, not a failure of the call, and stderr is collected at the end rather \
     than interleaved where it was written. Use it for builds, tests, version control and \
     anything else with a command line interface. Do not use it to read, write or search \
     files: read_file, write_file, edit_file, glob and grep exist for that, and they are \
     faster, they handle paths consistently across platforms, and their output is shaped for \
     you. Quote paths containing spaces. Long-running commands are killed at the timeout, so \
     prefer a command that finishes; a test suite is fine, a watch mode is not. This command \
     is NOT sandboxed: it runs with your full user permissions and can reach and change \
     anything on this machine, including paths outside the workspace root that the file tools \
     refuse. Only the working directory is set for you. Do not run destructive or irreversible \
     commands unless you were asked to.";

/// How waiting for the child ended. Named rather than left as nested
/// `Result`s because the three endings want three different things said to
/// the model, and only one of them is the command's own fault.
enum Ended {
    Exited(std::process::ExitStatus),
    Unwaitable(String),
    TimedOut,
    Interrupted,
}

pub struct Bash {
    root: Root,
}

impl Bash {
    pub fn new(root: Root) -> Self {
        Self { root }
    }
}

#[async_trait::async_trait]
// No `effect` override on purpose. `bash` is the least confined thing
// here — it is not sandboxed at all — so the `Mutating` default is both
// correct and the one that must never be relaxed.
impl Tool for Bash {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "bash".into(),
            description: BASH_DESC.into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The command line to run, interpreted by the platform shell (cmd.exe on Windows, sh elsewhere)."
                    },
                    "timeout_ms": {
                        "type": "integer",
                        "description": "Milliseconds to wait before the command is killed. Defaults to 30000, maximum 600000."
                    }
                },
                "required": ["command"]
            }),
        }
    }

    async fn call(&self, input: Value, cancel: &CancellationToken) -> Result<String, String> {
        let command = input["command"]
            .as_str()
            .ok_or_else(|| "missing required argument: command".to_string())?;
        if command.trim().is_empty() {
            return Err("command is empty".to_string());
        }
        let timeout_ms = input["timeout_ms"]
            .as_u64()
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);

        let mut cmd = shell_command(command);
        cmd.current_dir(self.root.path())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("cannot start the shell: {e}"))?;
        let stdout = child.stdout.take().expect("stdout is piped");
        let stderr = child.stderr.take().expect("stderr is piped");

        // Drain both pipes concurrently with the wait: a chatty command that
        // fills a pipe buffer would otherwise block forever on write while we
        // block on exit, and the timeout would be the only thing saving us.
        //
        // Into shared buffers rather than out of the task's return value,
        // because what has been read has to be reachable even when the task
        // cannot finish — see `PUMP_GRACE`.
        let out_buf: Captured = Arc::new(Mutex::new(Vec::new()));
        let err_buf: Captured = Arc::new(Mutex::new(Vec::new()));
        let mut pump = tokio::spawn({
            let (out, err) = (out_buf.clone(), err_buf.clone());
            async move {
                tokio::join!(drain(stdout, out), drain(stderr, err));
            }
        });

        // Ctrl-C has to reach a ten-minute build, and `kill_on_drop` alone
        // cannot deliver it: the engine does not abandon a tool call, because
        // a `tool_use` with no `tool_result` is invalid on replay. So the way
        // out is to kill the child and *return* — which needs the handle back
        // afterwards, hence the inner scope. `waited` borrows `child`, and
        // dropping it at the end of the block is what frees it to be killed.
        let ended = {
            let waited = tokio::time::timeout(Duration::from_millis(timeout_ms), child.wait());
            tokio::pin!(waited);
            tokio::select! {
                biased;
                _ = cancel.cancelled() => Ended::Interrupted,
                waited = &mut waited => match waited {
                    Ok(Ok(status)) => Ended::Exited(status),
                    Ok(Err(e)) => Ended::Unwaitable(e.to_string()),
                    Err(_elapsed) => Ended::TimedOut,
                },
            }
        };
        let interrupted = matches!(ended, Ended::Interrupted);
        let status = match ended {
            Ended::Exited(status) => Some(status),
            Ended::Unwaitable(e) => {
                kill_tree(&mut child).await;
                return Err(format!("the command could not be waited on: {e}"));
            }
            // Killed explicitly rather than left to kill_on_drop, so the pipes
            // close and `pump` finishes with whatever was produced.
            Ended::TimedOut | Ended::Interrupted => {
                kill_tree(&mut child).await;
                None
            }
        };
        let drained = tokio::time::timeout(PUMP_GRACE, &mut pump).await.is_ok();
        if !drained {
            // Aborted rather than detached: it holds both pipe handles, and
            // nothing is coming that anyone is still waiting for.
            pump.abort();
        }
        let out = std::mem::take(&mut *out_buf.lock().unwrap());
        let err = std::mem::take(&mut *err_buf.lock().unwrap());

        let mut body = String::new();
        body.push_str(&String::from_utf8_lossy(&out));
        let stderr_text = String::from_utf8_lossy(&err);
        if !stderr_text.is_empty() {
            if !body.is_empty() && !body.ends_with('\n') {
                body.push('\n');
            }
            // Named, because the two streams are drained into separate
            // buffers and joined afterwards: everything a command wrote to
            // stderr arrives in one run at the end rather than interleaved
            // where it happened. Unlabelled it reads as ordinary trailing
            // output, and a `fatal:` line sitting under the output of the
            // command before it is the shape that misleads. The marker names
            // the stream and claims nothing about failure — plenty of
            // working commands write here, and the exit code above is what
            // says whether anything went wrong.
            body.push_str("[stderr]\n");
            body.push_str(&stderr_text);
        }
        let mut body = if body.trim().is_empty() {
            "(no output)".to_string()
        } else {
            truncated(body)
        };
        // Said out loud rather than left as a short result: output that stops
        // early without saying so reads as a command that produced no more.
        if !drained {
            body.push_str(
                "\n(output may be incomplete: something the command started is still \
                 running and holding its output open)",
            );
        }

        match status {
            // The exit code leads so it survives truncation of the output.
            Some(status) => Ok(format!("exit code: {}\n{body}", code(&status))),
            // Killed by the user, not by the clock. Saying "timed out" here
            // would send the model to raise `timeout_ms` on a command that
            // was working fine, so the two endings get two messages — and
            // this one names no remedy, there being nothing to fix.
            None if interrupted => Err(format!(
                "{INTERRUPTED}. The command was killed part way through. Output up to \
                 the kill:\n{body}"
            )),
            None => Err(format!(
                "the command was killed after {timeout_ms} ms without finishing. Re-run \
                 something that terminates, or raise timeout_ms (maximum {MAX_TIMEOUT_MS}). \
                 Output up to the kill:\n{body}"
            )),
        }
    }
}

/// The child process for one command line.
///
/// Windows uses `cmd /C` rather than PowerShell deliberately: cmd.exe is
/// present on every Windows install, starts in single-digit milliseconds
/// where powershell.exe costs hundreds, and is not gated by an execution
/// policy. Either way the model hands us one command line, which is exactly
/// what `/C` and `-c` take.
///
/// The Windows arm has to bypass `Command::arg`, and that is not a detail.
/// `arg` applies the MSVC argv quoting rules, which cmd.exe does not parse —
/// it has its own rule about the first and last quote on the line. So a
/// command carrying any quote at all arrived mangled: `echo "a b"` reached
/// the shell as `echo \"a b\"`, and `type "C:\a b\c.txt"` came back
/// "The filename, directory name, or volume label syntax is incorrect" for a
/// path that was correct when the model wrote it. Quoting a path containing
/// spaces is the one thing this tool's own description tells the model to do,
/// so following the instruction was what broke the call — and the error names
/// the path rather than the quoting, which sends the model looking for a file
/// that is sitting right there. `raw_arg` passes the line through untouched,
/// which is the only thing cmd wants.
#[cfg(windows)]
fn shell_command(command: &str) -> Command {
    use std::os::windows::process::CommandExt;
    let mut std_cmd = std::process::Command::new("cmd");
    std_cmd.raw_arg("/C").raw_arg(command);
    Command::from(std_cmd)
}

#[cfg(not(windows))]
fn shell_command(command: &str) -> Command {
    let mut c = Command::new("sh");
    c.arg("-c").arg(command);
    c
}

/// End the command, and everything it started.
///
/// Killing the shell is not killing the command. A shell spawns the program
/// it was given as its own child, which inherits the pipes and does *not* die
/// with its parent, so `child.kill()` alone leaves the actual work running
/// and its output handle open. Measured on Windows: a command killed after
/// 500 ms went on running for the full 30 seconds it had been asked for.
///
/// That has a second cost beyond the wasted work, and it is the one that
/// bites hardest. A read on a child's pipe runs on a blocking-pool thread,
/// where nothing can interrupt it — not `abort`, not dropping the task — so
/// a surviving grandchild holding the write end pins that thread until it
/// exits, and the runtime's own shutdown waits for it. Interrupting a build
/// and then quitting would hang on the build.
///
/// `taskkill /T` is the tree-walking kill Windows offers without a job
/// object, which would mean a `windows-sys` dependency and a handle to
/// manage for something this crate does in one place. Best-effort: the
/// process may already be gone, and `child.kill()` follows either way so the
/// handle is reaped and the ordinary case does not depend on an external
/// program being present.
///
/// Unix is left with the plain kill. `sh -c` execs a simple command in place
/// rather than forking, so the common case has no grandchild at all, and the
/// general fix there is a process group — which needs `libc` for `killpg`.
/// `PUMP_GRACE` is the backstop under both.
async fn kill_tree(child: &mut tokio::process::Child) {
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
    let _ = child.kill().await;
}

/// Read one pipe to its end, appending as it goes.
///
/// Chunked rather than `read_to_end` so that everything read before the
/// reader is abandoned is still in the buffer. A read error ends the drain
/// like an end of file does: there is nothing useful to say about a broken
/// pipe that the exit code will not say better.
async fn drain(mut reader: impl AsyncRead + Unpin, into: Captured) {
    let mut chunk = [0u8; 8192];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => into.lock().unwrap().extend_from_slice(&chunk[..n]),
        }
    }
}

fn code(status: &std::process::ExitStatus) -> String {
    match status.code() {
        Some(code) => code.to_string(),
        // Unix only: terminated by a signal, so there is no exit code.
        None => "none (terminated by signal)".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{READ_LIMIT, test_dir};
    use std::fs;

    fn bash(dir: &std::path::Path) -> Bash {
        Bash::new(Root::new(dir))
    }

    #[tokio::test]
    async fn captures_stdout_and_a_zero_exit_code() {
        let dir = test_dir("shell-ok");
        let out = bash(&dir)
            .call(
                json!({ "command": "echo hello" }),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(out.starts_with("exit code: 0\n"), "{out}");
        assert!(out.contains("hello"), "{out}");
        fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn captures_a_nonzero_exit_code_without_failing_the_call() {
        let dir = test_dir("shell-exit");
        let out = bash(&dir)
            .call(json!({ "command": "exit 3" }), &CancellationToken::new())
            .await
            .unwrap();
        assert!(out.starts_with("exit code: 3\n"), "{out}");
        fs::remove_dir_all(&dir).ok();
    }

    /// stdout and stderr are drained into separate buffers and joined at the
    /// end, so a diagnostic arrives detached from the output it followed. A
    /// live run showed `fatal: not a git repository` sitting under three
    /// lines of unrelated stdout with nothing to say it came from anywhere
    /// else, which reads as the tail of the command's own output.
    #[tokio::test]
    async fn names_the_stream_when_a_command_writes_to_stderr() {
        let dir = test_dir("shell-stderr");
        let command = if cfg!(windows) {
            "echo out & echo err 1>&2"
        } else {
            "echo out; echo err 1>&2"
        };
        let out = bash(&dir)
            .call(json!({ "command": command }), &CancellationToken::new())
            .await
            .unwrap();
        let marker = out.find("[stderr]").unwrap_or_else(|| panic!("{out}"));
        // The marker introduces the stderr run rather than trailing it.
        assert!(out[..marker].contains("out"), "{out}");
        assert!(out[marker..].contains("err"), "{out}");
        fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn runs_in_the_workspace_root() {
        let dir = test_dir("shell-cwd");
        fs::write(dir.join("marker.txt"), "x").unwrap();
        let command = if cfg!(windows) { "dir /b" } else { "ls" };
        let out = bash(&dir)
            .call(json!({ "command": command }), &CancellationToken::new())
            .await
            .unwrap();
        assert!(out.contains("marker.txt"), "{out}");
        fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn kills_a_command_that_outlives_its_timeout() {
        let dir = test_dir("shell-timeout");
        // `ping -n 30 127.0.0.1` is the portable "sleep" on Windows; `sleep`
        // itself is not a cmd builtin.
        let command = if cfg!(windows) {
            "ping -n 30 127.0.0.1 > nul"
        } else {
            "sleep 30"
        };
        let started = std::time::Instant::now();
        let err = bash(&dir)
            .call(
                json!({ "command": command, "timeout_ms": 500 }),
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert!(err.contains("killed after 500 ms"), "{err}");
        // And the timeout has to bound the *call*, not just the shell. This
        // command outlives its parent by 30 seconds on Windows, holding the
        // stderr handle it inherited; before `PUMP_GRACE` the call returned
        // when the grandchild did.
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "a killed command was still waited out: {:?}",
            started.elapsed()
        );
        fs::remove_dir_all(&dir).ok();
    }

    /// Why `bash` takes the token rather than being left to `kill_on_drop`:
    /// the engine never drops a tool call, so an interrupted command has to
    /// be killed from inside the call and reported back.
    #[tokio::test]
    async fn an_interrupted_command_is_killed_rather_than_waited_out() {
        let dir = test_dir("shell-interrupt");
        // A ten-minute command under a ten-minute timeout, so nothing but the
        // interrupt can end it.
        let command = if cfg!(windows) {
            "ping -n 600 127.0.0.1 > nul"
        } else {
            "sleep 600"
        };
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            trigger.cancel();
        });

        let started = std::time::Instant::now();
        let err = bash(&dir)
            .call(
                json!({ "command": command, "timeout_ms": 600_000 }),
                &cancel,
            )
            .await
            .unwrap_err();
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "the command was waited out rather than killed: {:?}",
            started.elapsed()
        );
        // And it must not read as a timeout, which would send the model to
        // raise `timeout_ms` on a command that was working perfectly.
        assert!(err.contains("interrupted"), "{err}");
        assert!(!err.contains("timeout_ms"), "{err}");
        fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn clamps_an_absurd_timeout() {
        let dir = test_dir("shell-clamp");
        let err = bash(&dir)
            .call(
                json!({ "command": "echo hi", "timeout_ms": 0 }),
                &CancellationToken::new(),
            )
            .await;
        // 0 clamps up to MIN_TIMEOUT_MS rather than becoming an instant kill;
        // echo finishes well inside it.
        assert!(err.is_ok(), "{err:?}");
        fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn reports_empty_output_explicitly() {
        let dir = test_dir("shell-quiet");
        let command = if cfg!(windows) { "echo. > nul" } else { "true" };
        let out = bash(&dir)
            .call(json!({ "command": command }), &CancellationToken::new())
            .await
            .unwrap();
        assert!(out.ends_with("(no output)"), "{out}");
        fs::remove_dir_all(&dir).ok();
    }

    /// The exact call that failed in a live session: a quoted path is what
    /// this tool's description asks for, and MSVC argv quoting turned it into
    /// a syntax error naming the path rather than the quotes.
    #[tokio::test]
    async fn a_quoted_path_containing_spaces_reaches_the_shell_intact() {
        let dir = test_dir("shell-quoted-path");
        fs::create_dir_all(dir.join("a b")).unwrap();
        fs::write(dir.join("a b").join("c.txt"), "content-here").unwrap();
        let command = if cfg!(windows) {
            "type \"a b\\c.txt\""
        } else {
            "cat \"a b/c.txt\""
        };
        let out = bash(&dir)
            .call(json!({ "command": command }), &CancellationToken::new())
            .await
            .unwrap();
        assert!(out.contains("content-here"), "{out}");
        fs::remove_dir_all(&dir).ok();
    }

    /// And nothing may re-escape on the way through: cmd echoes the quotes it
    /// was given, so a leaked backslash is visible in the output.
    #[cfg(windows)]
    #[tokio::test]
    async fn msvc_argv_quoting_does_not_leak_into_the_command_line() {
        let dir = test_dir("shell-quoting");
        let out = bash(&dir)
            .call(
                json!({ "command": "echo \"a b\"" }),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(out.contains("\"a b\""), "{out}");
        assert!(!out.contains('\\'), "MSVC quoting leaked through: {out}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn output_is_truncated_like_read_file() {
        let long = "y".repeat(READ_LIMIT + 10);
        assert!(truncated(long).ends_with("… (truncated)"));
    }
}
