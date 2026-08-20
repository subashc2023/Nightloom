//! Nightloom as a front end to the Claude Code CLI.
//!
//! This is deliberately **not** a [`Provider`]. That trait is a stateless
//! request for a completion — hand it the whole message list, get back
//! normalized events, execute the tools it asks for. Claude Code is the
//! other half of that contract already: it owns the loop, runs its own
//! tools, keeps its own history, and never emits an *unexecuted* call for
//! anyone else to run. Wrapping it as a provider means either advertising no
//! tools at all, or re-exposing Nightloom's over MCP and letting its loop
//! replace [`Chat::run_turn`](crate::Chat::run_turn) — at which point the
//! approval gate, `Effect` scheduling, the sidecar and `max_rounds` are all
//! being paid for and none of them are running.
//!
//! So the seam is one level up. [`TurnEvent`] is what both shells already
//! render, and Claude Code's `stream-json` maps onto it almost exactly, so
//! this module is a *second engine* behind the same event stream rather than
//! a sixth adapter under the first one. What that buys is both renderers,
//! unchanged. What it costs is `turn.rs` — Claude Code has its own version
//! of everything in it.
//!
//! The reason to want any of this is billing. A Pro/Max plan covers Claude
//! Code; it does not cover the API. Anthropic is explicit that OAuth is for
//! "ordinary use of Claude Code and other native Anthropic applications" and
//! that developers "should use API key authentication" — so the supported
//! shape is to *drive the signed-in CLI*, which is what this does, and never
//! to lift its token onto a request of our own, which this must not ever be
//! extended to do.
//!
//! [`Provider`]: nightloom_core::Provider

mod protocol;
mod record;
mod translate;

pub use protocol::RateLimitInfo;
pub use record::Recorder;
pub use translate::{AgentOutcome, Translator};

use crate::TurnEvent;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

/// How long to keep reading after the child is asked to stop.
///
/// The same backstop `tools::shell` puts under a killed command, for the
/// same reason: whatever the CLI managed to write is worth having, and a
/// read that cannot finish must not hold the turn open.
const DRAIN_GRACE: Duration = Duration::from_secs(2);

/// Tail of the child's stderr kept for diagnosis, in bytes.
const STDERR_TAIL: usize = 4096;

#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    #[error("could not start {binary}: {source}")]
    Spawn {
        binary: String,
        #[source]
        source: std::io::Error,
    },
    #[error("{binary} exited with {status}{}", tail(.stderr))]
    Failed {
        binary: String,
        status: String,
        stderr: String,
    },
    #[error("transport error: {0}")]
    Io(#[from] std::io::Error),
}

fn tail(stderr: &str) -> String {
    if stderr.trim().is_empty() {
        String::new()
    } else {
        format!(": {}", stderr.trim())
    }
}

/// How to invoke the CLI for one turn.
#[derive(Debug, Clone)]
pub struct AgentSpec {
    /// The executable. `claude` unless the user points somewhere else — a
    /// version manager or a checkout, both of which people have.
    pub binary: String,
    /// Working directory. This is the whole of what the agent is rooted at,
    /// so it is required rather than inherited: a GUI process's cwd is
    /// whatever the launcher set, which is the argument `connect` already
    /// makes for taking an explicit workspace.
    pub workspace: PathBuf,
    /// Model alias (`fable`, `opus`, `sonnet`, `haiku`) or a full id
    /// (`claude-fable-5`).
    ///
    /// Passed through untouched rather than validated against a list of our
    /// own: the aliases move with the CLI's releases, and which ones an
    /// account can reach depends on its plan. An id this build has never
    /// heard of is the CLI's to reject, and it says so far better than a
    /// stale table here could.
    pub model: Option<String>,
    /// The tool set. `Some(vec![])` is no tools at all, `None` leaves the
    /// CLI's default set in place.
    pub tools: Option<Vec<String>>,
    /// Tools that run without a prompt.
    pub allowed_tools: Vec<String>,
    /// `manual` | `acceptEdits` | `auto` | `dontAsk` | `plan` |
    /// `bypassPermissions`. Left unset the CLI starts in its own default,
    /// which for `-p` is manual on every plan — and a manual prompt in a
    /// non-interactive process is a denial, so a caller that wants tools to
    /// actually run has to say which mode it means.
    pub permission_mode: Option<String>,
    /// Replaces the CLI's system prompt entirely.
    pub system_prompt: Option<String>,
    /// Added after it instead.
    pub append_system_prompt: Option<String>,
    /// Start with the host's customizations off — `CLAUDE.md`, skills,
    /// plugins, hooks, MCP servers, custom agents.
    ///
    /// Not [`--bare`], which looks like the same thing and is not: bare mode
    /// "never reads OAuth credentials or the system keychain" and so forces
    /// the run back onto an API key, defeating the only reason this module
    /// exists. Safe mode keeps auth, model selection and permissions
    /// working and drops only the configuration.
    ///
    /// [`--bare`]: https://code.claude.com/docs/en/headless
    pub safe_mode: bool,
    /// Resume a previous Claude Code session by id.
    pub resume: Option<String>,
    /// Hard ceiling on what one turn may spend.
    pub max_budget_usd: Option<f64>,
    /// Keep `ANTHROPIC_API_KEY` out of the child's environment.
    ///
    /// On by default, and the single most consequential field here. Claude
    /// Code prefers an API key over the subscription whenever one is set,
    /// silently — so inheriting the parent's environment bills the API for
    /// every turn, which is the exact cost this module exists to avoid, and
    /// nothing in the output says it happened.
    pub use_subscription: bool,
    /// Passed through verbatim, last, so a caller can reach a flag this
    /// struct has not grown a field for.
    pub extra_args: Vec<String>,
}

impl AgentSpec {
    pub fn new(workspace: impl Into<PathBuf>) -> Self {
        Self {
            binary: "claude".into(),
            workspace: workspace.into(),
            model: None,
            tools: None,
            allowed_tools: Vec::new(),
            permission_mode: None,
            system_prompt: None,
            append_system_prompt: None,
            safe_mode: false,
            resume: None,
            max_budget_usd: None,
            use_subscription: true,
            extra_args: Vec::new(),
        }
    }

    /// The argument vector for one turn.
    ///
    /// Split out from spawning so it can be asserted on directly — the same
    /// shape the provider adapters are tested in, where the unit under test
    /// is the request that would have gone out rather than the reply.
    fn args(&self, prompt: &str) -> Vec<String> {
        let mut a: Vec<String> = vec![
            "-p".into(),
            prompt.into(),
            "--output-format".into(),
            "stream-json".into(),
            // Required by the CLI alongside stream-json, and the reason
            // there are deltas to render at all rather than one block at
            // the end of the turn.
            "--verbose".into(),
            "--include-partial-messages".into(),
        ];
        if let Some(m) = &self.model {
            a.push("--model".into());
            a.push(m.clone());
        }
        if let Some(tools) = &self.tools {
            a.push("--tools".into());
            // `--tools` takes a variadic list; the empty set is the empty
            // string, which is how the CLI spells "no tools".
            if tools.is_empty() {
                a.push(String::new());
            } else {
                a.extend(tools.iter().cloned());
            }
        }
        if !self.allowed_tools.is_empty() {
            a.push("--allowedTools".into());
            a.extend(self.allowed_tools.iter().cloned());
        }
        if let Some(mode) = &self.permission_mode {
            a.push("--permission-mode".into());
            a.push(mode.clone());
        }
        if let Some(s) = &self.system_prompt {
            a.push("--system-prompt".into());
            a.push(s.clone());
        }
        if let Some(s) = &self.append_system_prompt {
            a.push("--append-system-prompt".into());
            a.push(s.clone());
        }
        if self.safe_mode {
            a.push("--safe-mode".into());
        }
        if let Some(id) = &self.resume {
            a.push("--resume".into());
            a.push(id.clone());
        }
        if let Some(budget) = self.max_budget_usd {
            a.push("--max-budget-usd".into());
            a.push(budget.to_string());
        }
        a.extend(self.extra_args.iter().cloned());
        a
    }
}

/// Runs turns by driving the CLI, reporting progress as [`TurnEvent`]s.
pub struct ClaudeCodeAgent {
    spec: AgentSpec,
    /// The model id the CLI last resolved [`AgentSpec::model`] to.
    ///
    /// Kept beside the spec rather than written into it, because the two are
    /// different facts: the spec holds what to *ask* for, and asking for
    /// `sonnet` next turn is right — pinning yesterday's snapshot into the
    /// request would quietly stop following the alias the user chose. This is
    /// what to *call* the answer, which matters wherever a model id is looked
    /// up rather than displayed: an alias is in no limits or pricing table.
    resolved: Option<String>,
}

impl ClaudeCodeAgent {
    pub fn new(spec: AgentSpec) -> Self {
        Self {
            spec,
            resolved: None,
        }
    }

    /// What the CLI resolved the model to on the last completed turn.
    ///
    /// `None` before the first one, and the CLI reports it on a line that
    /// arrives before any event — so a caller that has to name the model
    /// *while* a turn streams has this answer only from a turn before it.
    pub fn resolved_model(&self) -> Option<&str> {
        self.resolved.as_deref()
    }

    pub fn spec(&self) -> &AgentSpec {
        &self.spec
    }

    /// Adopt the session the last turn opened, so the next one continues it.
    pub fn follow_on(&mut self, outcome: &AgentOutcome) {
        if let Some(id) = &outcome.session_id {
            self.spec.resume = Some(id.clone());
        }
        if let Some(model) = &outcome.model {
            self.resolved = Some(model.clone());
        }
    }

    /// Point at a specific session, or at none.
    ///
    /// What a windowed shell needs and a REPL does not: chats are switched
    /// between rather than run one after another, so opening one has to
    /// carry its agent session with it and starting a new one has to let go
    /// of the old — which `follow_on` alone cannot express, only ever moving
    /// forward.
    pub fn set_resume(&mut self, id: Option<String>) {
        self.spec.resume = id.filter(|s| !s.is_empty());
    }

    /// Run one turn to completion, streaming events as they arrive.
    ///
    /// Cancellation kills the process tree rather than dropping the future.
    /// The reasoning is `tools::shell`'s: the CLI spawns its own children —
    /// it *is* a process supervisor — and a killed parent leaves them
    /// holding the pipes, so the read the kill was meant to end goes on
    /// waiting. There is no orphaned-`tool_use` hazard here, because the
    /// transcript the tool results belong to is Claude Code's own.
    pub async fn run_turn(
        &self,
        prompt: &str,
        cancel: &CancellationToken,
        on_event: &mut (dyn FnMut(TurnEvent) + Send),
    ) -> Result<AgentOutcome, AgentError> {
        let mut cmd = Command::new(&self.spec.binary);
        cmd.args(self.spec.args(prompt))
            .current_dir(&self.spec.workspace)
            // Null rather than inherited: with a terminal on the other end
            // the CLI waits three seconds for piped input that is never
            // coming, on every turn.
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if self.spec.use_subscription {
            cmd.env_remove("ANTHROPIC_API_KEY");
            cmd.env_remove("ANTHROPIC_AUTH_TOKEN");
            // Set when Nightloom itself was launched from a Claude Code
            // session; inherited they make the child think it is a nested
            // run of its own.
            cmd.env_remove("CLAUDECODE");
            cmd.env_remove("CLAUDE_CODE_ENTRYPOINT");
        }

        let mut child = cmd.spawn().map_err(|source| AgentError::Spawn {
            binary: self.spec.binary.clone(),
            source,
        })?;

        let stdout = child.stdout.take().expect("stdout piped");
        let mut stderr = child.stderr.take().expect("stderr piped");
        let stderr_task = tokio::spawn(async move {
            let mut buf = Vec::new();
            let _ = stderr.read_to_end(&mut buf).await;
            let text = String::from_utf8_lossy(&buf).into_owned();
            let from = text.len().saturating_sub(STDERR_TAIL);
            text[from..].to_string()
        });

        let mut lines = BufReader::new(stdout).lines();
        let mut translator = Translator::new();
        let mut interrupted = false;

        loop {
            let next = tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    interrupted = true;
                    break;
                }
                line = lines.next_line() => line,
            };
            match next {
                Ok(Some(line)) => {
                    for event in translator.push(&line) {
                        on_event(event);
                    }
                }
                Ok(None) => break,
                // A broken pipe says no more than the exit status will.
                Err(_) => break,
            }
        }

        if interrupted {
            kill_tree(&mut child).await;
            // Whatever was already buffered is still worth translating, but
            // a reader that cannot finish must not hold the turn open.
            let _ = tokio::time::timeout(DRAIN_GRACE, async {
                while let Ok(Some(line)) = lines.next_line().await {
                    for event in translator.push(&line) {
                        on_event(event);
                    }
                }
            })
            .await;
        }

        let status = child.wait().await?;
        let stderr = stderr_task.await.unwrap_or_default();
        let mut outcome = translator.finish();

        if interrupted {
            outcome.notices.push("interrupted".into());
            return Ok(outcome);
        }
        // A non-zero exit with nothing translated is a startup failure —
        // an unknown flag, a missing binary path, an unauthenticated CLI —
        // and the stderr tail is the only thing that explains it. A run that
        // did stream is reported through the outcome instead, since the CLI
        // prints in-run failures as the result on stdout.
        if !status.success() && outcome.text.is_empty() && outcome.session_id.is_none() {
            return Err(AgentError::Failed {
                binary: self.spec.binary.clone(),
                status: status.to_string(),
                stderr,
            });
        }
        Ok(outcome)
    }
}

/// Kill the child and anything it started.
///
/// A copy of `tools::shell::kill_tree`'s Windows half, and kept here rather
/// than shared because the two will drift: that one is killing a shell,
/// this one a supervisor that may be holding a `bash` of its own.
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

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> AgentSpec {
        AgentSpec::new("/work")
    }

    /// Every turn needs these three together: `stream-json` is what this
    /// module parses, `--verbose` is what the CLI requires beside it, and
    /// partial messages are what make the reply stream rather than land.
    #[test]
    fn streaming_flags_are_always_present() {
        let a = spec().args("hi");
        assert_eq!(a[0], "-p");
        assert_eq!(a[1], "hi");
        for flag in [
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
        ] {
            assert!(a.iter().any(|x| x == flag), "missing {flag} in {a:?}");
        }
    }

    /// The empty tool set is an empty string, not an omitted flag — omitted
    /// leaves the CLI's whole default set switched on.
    #[test]
    fn no_tools_is_an_empty_string_argument() {
        let mut s = spec();
        s.tools = Some(vec![]);
        let a = s.args("hi");
        let i = a.iter().position(|x| x == "--tools").expect("--tools");
        assert_eq!(a[i + 1], "");
    }

    #[test]
    fn a_named_tool_set_is_passed_variadically() {
        let mut s = spec();
        s.tools = Some(vec!["Read".into(), "Grep".into()]);
        s.allowed_tools = vec!["Read".into()];
        let a = s.args("hi");
        let i = a.iter().position(|x| x == "--tools").unwrap();
        assert_eq!(&a[i + 1..i + 3], ["Read", "Grep"]);
        let j = a.iter().position(|x| x == "--allowedTools").unwrap();
        assert_eq!(a[j + 1], "Read");
    }

    /// Leaving `tools` unset must not smuggle the flag in — that is the
    /// difference between the CLI's defaults and a tool set we chose.
    #[test]
    fn unset_tools_omits_the_flag() {
        assert!(!spec().args("hi").iter().any(|x| x == "--tools"));
    }

    #[test]
    fn optional_flags_appear_only_when_set() {
        let bare = spec().args("hi");
        for flag in [
            "--model",
            "--safe-mode",
            "--resume",
            "--max-budget-usd",
            "--system-prompt",
        ] {
            assert!(
                !bare.iter().any(|x| x == flag),
                "{flag} leaked into {bare:?}"
            );
        }
        let mut s = spec();
        s.model = Some("haiku".into());
        s.safe_mode = true;
        s.resume = Some("abc".into());
        s.max_budget_usd = Some(0.5);
        s.system_prompt = Some("be terse".into());
        let a = s.args("hi");
        for flag in [
            "--model",
            "--safe-mode",
            "--resume",
            "--max-budget-usd",
            "--system-prompt",
        ] {
            assert!(a.iter().any(|x| x == flag), "missing {flag}");
        }
    }

    /// Caller-supplied arguments go last so they can override.
    #[test]
    fn extra_args_are_appended() {
        let mut s = spec();
        s.extra_args = vec!["--add-dir".into(), "/other".into()];
        let a = s.args("hi");
        assert_eq!(&a[a.len() - 2..], ["--add-dir", "/other"]);
    }

    #[test]
    fn follow_on_resumes_the_session_the_turn_opened() {
        let mut agent = ClaudeCodeAgent::new(spec());
        assert!(agent.spec().resume.is_none());
        let outcome = AgentOutcome {
            session_id: Some("sess-1".into()),
            ..Default::default()
        };
        agent.follow_on(&outcome);
        assert_eq!(agent.spec().resume.as_deref(), Some("sess-1"));
        assert!(agent.spec().args("hi").iter().any(|x| x == "sess-1"));
    }

    /// The default has to be the subscription. An inherited key bills the
    /// API silently, which is the one failure this module cannot detect
    /// after the fact.
    #[test]
    fn subscription_is_the_default() {
        assert!(spec().use_subscription);
    }
}
