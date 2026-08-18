//! Running a shell command.

use super::{Root, truncated};
use nightloom_core::ToolDef;
use nightloom_core::tool::Tool;
use serde_json::{Value, json};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
/// Hard ceiling. A tool call blocks the turn, and a turn that never returns
/// is worse for the model than a command it has to re-run in the background.
const MAX_TIMEOUT_MS: u64 = 600_000;
const MIN_TIMEOUT_MS: u64 = 100;

const BASH_DESC: &str = "Run a shell command from the workspace root and get back its combined \
     stdout and stderr plus its exit code. Use it for builds, tests, version control and \
     anything else with a command line interface. Do not use it to read, write or search \
     files: read_file, write_file, edit_file, glob and grep exist for that, and they are \
     faster, they handle paths consistently across platforms, and their output is shaped for \
     you. Quote paths containing spaces. Long-running commands are killed at the timeout, so \
     prefer a command that finishes; a test suite is fine, a watch mode is not. This command \
     is NOT sandboxed: it runs with your full user permissions and can reach and change \
     anything on this machine, including paths outside the workspace root that the file tools \
     refuse. Only the working directory is set for you. Do not run destructive or irreversible \
     commands unless you were asked to.";

pub struct Bash {
    root: Root,
}

impl Bash {
    pub fn new(root: Root) -> Self {
        Self { root }
    }
}

#[async_trait::async_trait]
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

    async fn call(&self, input: Value) -> Result<String, String> {
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

        // Windows uses `cmd /C` rather than PowerShell deliberately: cmd.exe
        // is present on every Windows install, starts in single-digit
        // milliseconds where powershell.exe costs hundreds, and is not gated
        // by an execution policy. Either way the model hands us one command
        // line, which is exactly what `/C` and `-c` take.
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.arg("/C").arg(command);
            c
        } else {
            let mut c = Command::new("sh");
            c.arg("-c").arg(command);
            c
        };
        cmd.current_dir(self.root.path())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("cannot start the shell: {e}"))?;
        let mut stdout = child.stdout.take().expect("stdout is piped");
        let mut stderr = child.stderr.take().expect("stderr is piped");

        // Drain both pipes concurrently with the wait: a chatty command that
        // fills a pipe buffer would otherwise block forever on write while we
        // block on exit, and the timeout would be the only thing saving us.
        let pump = tokio::spawn(async move {
            let mut out = Vec::new();
            let mut err = Vec::new();
            let _ = tokio::join!(stdout.read_to_end(&mut out), stderr.read_to_end(&mut err));
            (out, err)
        });

        let waited = tokio::time::timeout(Duration::from_millis(timeout_ms), child.wait()).await;
        let status = match waited {
            Ok(Ok(status)) => Some(status),
            Ok(Err(e)) => {
                let _ = child.kill().await;
                return Err(format!("the command could not be waited on: {e}"));
            }
            Err(_elapsed) => {
                // Kill explicitly rather than leaning on kill_on_drop, so the
                // pipes close and `pump` finishes with whatever was produced.
                let _ = child.kill().await;
                None
            }
        };
        let (out, err) = pump.await.unwrap_or_default();

        let mut body = String::new();
        body.push_str(&String::from_utf8_lossy(&out));
        let stderr_text = String::from_utf8_lossy(&err);
        if !stderr_text.is_empty() {
            if !body.is_empty() && !body.ends_with('\n') {
                body.push('\n');
            }
            body.push_str(&stderr_text);
        }
        let body = if body.trim().is_empty() {
            "(no output)".to_string()
        } else {
            truncated(body)
        };

        match status {
            // The exit code leads so it survives truncation of the output.
            Some(status) => Ok(format!("exit code: {}\n{body}", code(&status))),
            None => Err(format!(
                "the command was killed after {timeout_ms} ms without finishing. Re-run \
                 something that terminates, or raise timeout_ms (maximum {MAX_TIMEOUT_MS}). \
                 Output up to the kill:\n{body}"
            )),
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
            .call(json!({ "command": "echo hello" }))
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
            .call(json!({ "command": "exit 3" }))
            .await
            .unwrap();
        assert!(out.starts_with("exit code: 3\n"), "{out}");
        fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn runs_in_the_workspace_root() {
        let dir = test_dir("shell-cwd");
        fs::write(dir.join("marker.txt"), "x").unwrap();
        let command = if cfg!(windows) { "dir /b" } else { "ls" };
        let out = bash(&dir)
            .call(json!({ "command": command }))
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
        let err = bash(&dir)
            .call(json!({ "command": command, "timeout_ms": 500 }))
            .await
            .unwrap_err();
        assert!(err.contains("killed after 500 ms"), "{err}");
        fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn clamps_an_absurd_timeout() {
        let dir = test_dir("shell-clamp");
        let err = bash(&dir)
            .call(json!({ "command": "echo hi", "timeout_ms": 0 }))
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
            .call(json!({ "command": command }))
            .await
            .unwrap();
        assert!(out.ends_with("(no output)"), "{out}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn output_is_truncated_like_read_file() {
        let long = "y".repeat(READ_LIMIT + 10);
        assert!(truncated(long).ends_with("… (truncated)"));
    }
}
