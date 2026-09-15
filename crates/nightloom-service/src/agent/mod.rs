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

pub mod cli_session;
mod protocol;
mod record;
mod translate;

pub use protocol::RateLimitInfo;
pub use record::{Recorder, carry_transcript};
pub use translate::{AgentOutcome, Translator};

use crate::{TurnEvent, TurnInput};
use nightloom_core::ChatMode;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
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
    #[error("could not start {binary}: {source}{}", not_found_hint(.source))]
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

/// Where to look, appended to a "not found" and to nothing else.
///
/// The failure this answers is invisible from the message alone: the binary
/// is installed, `claude` runs in the user's terminal, and the same default
/// resolves to nothing under a GUI process's environment. Naming the
/// directories that were tried is the difference between a bug report and a
/// user checking one path.
fn not_found_hint(source: &std::io::Error) -> String {
    if source.kind() == std::io::ErrorKind::NotFound {
        format!(" (looked in {})", searched_locations().join(", "))
    } else {
        String::new()
    }
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
    /// [`AgentSpec::headless_permission_mode`] is the shells' answer.
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
    /// It also emits `--strict-mcp-config`, which reads as redundant and is
    /// belt-and-braces on purpose. `--safe-mode` lists MCP servers among
    /// what it disables, and on macOS it was reported dropping the local
    /// ones while leaving the account-level claude.ai connectors in place:
    /// asked to read a file in the workspace, the child called
    /// `mcp__claude_ai_Google_Drive__search_files` and then said it had no
    /// `Read` tool at all. That is the worst shape available — not a
    /// missing capability but a *substituted* one, so the turn fails in a
    /// way that reads as a stupid model rather than a wrong tool set.
    /// `--strict-mcp-config` is "only servers from `--mcp-config`", and with
    /// no `--mcp-config` supplied that is none, which is what safe mode
    /// already promised.
    ///
    /// What is **verified** and what is not, since the two are different:
    /// the flag pair is accepted by CLI 2.1.238 and on Windows — where this
    /// machine has both a user-level `mcpServers` entry and
    /// `claudeAiMcpEverConnected` — safe mode alone already reports
    /// `mcp_servers: []` with no `mcp__` tool on the request, so the fix is
    /// confirmed harmless but the failure it targets could not be
    /// reproduced here. It is the documented guarantee for exactly this
    /// question, which is the right thing to ask for whether the gap turns
    /// out to be a CLI bug or a platform difference, and asking twice costs
    /// one argument.
    ///
    /// [`--bare`]: https://code.claude.com/docs/en/headless
    ///
    /// **Re-spelled 2026-09-14 (nightshift blocker 058).** `--safe-mode`
    /// turned out to discard the `--mcp-config` server too — CLI 2.1.263's
    /// init event reports `mcp_servers: []` with it — so a safe-mode chat
    /// had none of Nightloom's tools, and his question was "what is the
    /// point of safe mode if it drops Nightloom's stuff?" Measured on this
    /// machine, one Haiku turn per spelling, with a folder `CLAUDE.md`
    /// holding a secret word, a project `SessionStart` hook touching a
    /// file, and his real user-level `CLAUDE.md` and hooks:
    ///
    /// | spelling | user CLAUDE.md | folder CLAUDE.md | user hooks | project hooks | other MCP | Nightloom MCP |
    /// |---|---|---|---|---|---|---|
    /// | plain + `--strict-mcp-config` | loads | loads | fire | fire | none | yes |
    /// | `--safe-mode --strict-mcp-config` | no | **loads** | no | no | none | **no** |
    /// | `--setting-sources "" --strict-mcp-config` | no | loads | no | no | none | **yes** |
    ///
    /// So an empty `--setting-sources` (no user, project or local
    /// settings) drops everything `--safe-mode` actually dropped — the
    /// host's `CLAUDE.md`, both hook layers, the allowlist — and keeps the
    /// one server named on the command line. `--safe-mode`'s own help
    /// promises the folder `CLAUDE.md` off too, and does not deliver it;
    /// neither spelling does, and under Nightloom that file is the
    /// project's own, which is the right side of the line anyway.
    /// `--disable-slash-commands` rides along to take the user's skills off
    /// (18 → 0 in the init event; `--safe-mode` left them at 18).
    /// `CLAUDE_CODE_SIMPLE=1` on its own was tried and kills OAuth
    /// ("Not logged in"), the same trap as `--bare`.
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
    /// Directories outside the workspace the CLI may read without asking,
    /// each sent as `--add-dir`. The vault is the case: the preamble names
    /// it by its real path, and a path the CLI treats as outside its working
    /// directories is one it routes to approval — which, headless, is the
    /// classifier, and a call it declines simply does not run (`external`,
    /// the permissions reference: files in additional directories "become
    /// readable without prompts, and file editing permissions follow the
    /// current permission mode"). Without this the index is a list of files
    /// the model can see and not open (nightshift blocker 050).
    pub add_dirs: Vec<PathBuf>,
    /// An MCP config for the CLI to load, as the inline JSON string
    /// `--mcp-config` accepts (`external`, the CLI reference: "JSON files
    /// or strings"). Nightloom's own server goes here — see `mcp_server`.
    /// Under `safe_mode` the CLI also gets `--strict-mcp-config`, ~~so this
    /// becomes the *only* server, which is what safe mode wants~~ — measured
    /// 2026-09-14: `--safe-mode` drops this server too (`mcp_servers: []` in
    /// the init event), so a safe-mode turn had no Nightloom tools at all
    /// (nightshift blocker 058). Safe mode is now spelled without
    /// `--safe-mode` (see that field), and this server survives it — the
    /// only one that does.
    pub mcp_config: Option<String>,
    /// Keep the CLI from writing its own session file, and so from ever
    /// being able to resume this conversation: `--no-session-persistence`
    /// (2026-09-15, an ephemeral chat). Measured on 2.1.263: a turn without
    /// it wrote a 116 KB file under `~/.claude/projects/<cwd>/` for one word
    /// of reply; a turn with it wrote nothing there; and `--resume` of that
    /// session id then failed with "No conversation found". So a chat run
    /// with this has **no continuity from the CLI's side** — the shell that
    /// wants a second turn to know the first has to carry the conversation
    /// itself ([`Recorder`] keeps it in memory; [`carry_transcript`] renders
    /// it back into the prompt).
    pub no_session_persistence: bool,
    /// Passed through verbatim, last, so a caller can reach a flag this
    /// struct has not grown a field for.
    pub extra_args: Vec<String>,
}

/// The CLI's built-in tools a chat that writes nothing may keep: the
/// readers, and the web. A **positive** list rather than `--disallowedTools`
/// naming the writers, because the two were measured side by side
/// (2026-09-15, CLI 2.1.263, Haiku, the init event's `tools`):
///
/// | spelling | init `tools` |
/// |---|---|
/// | `--disallowedTools Write Edit NotebookEdit Bash` | the four gone — and `EnterWorktree`, `CronCreate`, `CronDelete`, `Task` still there |
/// | `--tools Read Glob Grep WebFetch WebSearch` | exactly those five |
///
/// A deny-list is honest about the release it was written against and
/// drifts open on the next one; a worktree and a cron job both write. The
/// positive list is default-closed, and `--tools` is already how the rail's
/// "tools off" is spelled (`Some(vec![])`), so this is the same field with
/// five names in it. MCP tools are untouched by `--tools` — Nightloom's own
/// server still reaches the model, started without `remember`.
///
/// The web stays. Incognito is about *his* data — nothing written here,
/// nothing read by other chats — and a fetch writes nothing on this
/// machine; egress has its own switch on the rail and keeps it.
pub const READ_ONLY_TOOLS: [&str; 5] = ["Read", "Glob", "Grep", "WebFetch", "WebSearch"];

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
            add_dirs: Vec::new(),
            mcp_config: None,
            no_session_persistence: false,
            extra_args: Vec::new(),
        }
    }

    /// Shape the spec for a chat started in `mode`. `Normal` changes nothing.
    /// Both other modes confine the CLI to [`READ_ONLY_TOOLS`] — unless the
    /// caller had already asked for no tools at all, which stays no tools —
    /// and `Ephemeral` also asks the CLI to keep no session of its own.
    ///
    /// One method rather than two fields the shell sets in step, so the
    /// ladder (ephemeral is incognito and then some) is written down once.
    pub fn apply_mode(&mut self, mode: ChatMode) {
        if !mode.writes_nothing() {
            return;
        }
        match &self.tools {
            Some(t) if t.is_empty() => {}
            _ => {
                self.tools = Some(READ_ONLY_TOOLS.iter().map(|t| (*t).to_string()).collect());
            }
        }
        if mode == ChatMode::Ephemeral {
            self.no_session_persistence = true;
        }
    }

    /// What the approval switch means on a headless run: `auto` when it is
    /// on, `bypassPermissions` when it is off.
    ///
    /// Neither is Nightloom's own gate, which is a live prompt with nobody
    /// to answer it here. `auto` is the CLI's classifier deciding each call
    /// — the mode a Pro or Max terminal session already starts in — and on a
    /// `-p` run it **denies rather than waits** when it cannot approve: the
    /// docs say a non-interactive run "has no prompt to fall back to", so
    /// "the action doesn't run and Claude keeps working" (`external`,
    /// code.claude.com/docs/en/permission-modes, 2026-09-14). Where auto
    /// mode is unavailable to the session, the CLI starts in manual instead,
    /// which headless is a denial too; nothing here can hang.
    ///
    /// `dontAsk` was the previous answer, and with the empty allowlist a
    /// fresh install has it refused every write, command and fetch — a chat
    /// on which nothing but reads ran. Blocker 045 in the nightshift repo
    /// records the switch and the reasoning.
    pub fn headless_permission_mode(approval: bool) -> &'static str {
        if approval {
            "auto"
        } else {
            "bypassPermissions"
        }
    }

    /// The argument vector for one text-only turn, prompt on argv.
    ///
    /// Split out from spawning so it can be asserted on directly — the same
    /// shape the provider adapters are tested in, where the unit under test
    /// is the request that would have gone out rather than the reply.
    fn args(&self, prompt: &str) -> Vec<String> {
        self.argv(Some(prompt))
    }

    /// The argument vector for one turn whose user message arrives on
    /// stdin as a `stream-json` line — the shape a turn with attachments
    /// takes, since argv carries text and nothing else.
    fn stdin_args(&self) -> Vec<String> {
        self.argv(None)
    }

    /// Both shapes differ in the first two arguments only. A prompt goes on
    /// argv as `-p <prompt>`; without one `-p` stands alone and
    /// `--input-format stream-json` says the message is coming on stdin.
    /// The rest is identical, which is the property that keeps the resume
    /// path and every flag test valid for the stdin shape without a second
    /// copy of each.
    fn argv(&self, prompt: Option<&str>) -> Vec<String> {
        let mut a: Vec<String> = vec!["-p".into()];
        match prompt {
            Some(p) => a.push(p.into()),
            None => {
                a.push("--input-format".into());
                a.push("stream-json".into());
            }
        }
        a.extend([
            "--output-format".into(),
            "stream-json".into(),
            // Required by the CLI alongside stream-json, and the reason
            // there are deltas to render at all rather than one block at
            // the end of the turn.
            "--verbose".into(),
            "--include-partial-messages".into(),
        ]);
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
            // Not `--safe-mode`: see the field doc's table — that flag
            // drops the `--mcp-config` server with everything else. No
            // setting source at all is what leaves Nightloom's server
            // standing while the host's CLAUDE.md, hooks and allowlist go.
            a.push("--setting-sources".into());
            a.push(String::new());
            a.push("--strict-mcp-config".into());
            a.push("--disable-slash-commands".into());
        }
        if let Some(id) = &self.resume {
            a.push("--resume".into());
            a.push(id.clone());
        }
        if let Some(budget) = self.max_budget_usd {
            a.push("--max-budget-usd".into());
            a.push(budget.to_string());
        }
        for dir in &self.add_dirs {
            a.push("--add-dir".into());
            a.push(dir.to_string_lossy().into_owned());
        }
        if let Some(cfg) = &self.mcp_config {
            a.push("--mcp-config".into());
            a.push(cfg.clone());
        }
        if self.no_session_persistence {
            a.push("--no-session-persistence".into());
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
    /// A bare `&str` converts, so a text-only call reads as it always did;
    /// attachments are the case that has to say so, and they change how the
    /// turn is handed over. Text alone goes on argv as `-p`, the shape every
    /// flag test asserts on. Images or documents cannot — argv is text — so
    /// that turn is written to the CLI's stdin as one `stream-json` user
    /// line instead ([`protocol::user_line`]), which is how the Agent SDK
    /// sends an image and was verified live on 2.1.263, `--resume` included.
    /// Keeping argv for the common case means the attachment path is the
    /// only thing that changed when it was added.
    ///
    /// Cancellation kills the process tree rather than dropping the future.
    /// The reasoning is `tools::shell`'s: the CLI spawns its own children —
    /// it *is* a process supervisor — and a killed parent leaves them
    /// holding the pipes, so the read the kill was meant to end goes on
    /// waiting. There is no orphaned-`tool_use` hazard here, because the
    /// transcript the tool results belong to is Claude Code's own.
    pub async fn run_turn(
        &self,
        input: impl Into<TurnInput>,
        cancel: &CancellationToken,
        on_event: &mut (dyn FnMut(TurnEvent) + Send),
    ) -> Result<AgentOutcome, AgentError> {
        let input = input.into();
        let attached = !input.images.is_empty() || !input.documents.is_empty();
        let mut cmd = Command::new(resolve_binary(&self.spec.binary));
        if attached {
            cmd.args(self.spec.stdin_args()).stdin(Stdio::piped());
        } else {
            cmd.args(self.spec.args(&input.text))
                // Null rather than inherited: with a terminal on the other
                // end the CLI waits three seconds for piped input that is
                // never coming, on every turn.
                .stdin(Stdio::null());
        }
        cmd.current_dir(&self.spec.workspace)
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

        // Written from its own task and then closed. A PDF near the cap is
        // tens of megabytes of base64, far past what a pipe buffers, and the
        // CLI only drains stdin as it parses — so a write awaited here, in
        // front of the stdout loop, could sit forever against a child that
        // is itself blocked writing a line nobody is reading yet. Dropping
        // the handle is the EOF that tells the CLI the turn's input is
        // complete; without it the process stays open waiting for a second
        // message.
        if attached && let Some(mut stdin) = child.stdin.take() {
            let line = protocol::user_line(&input);
            tokio::spawn(async move {
                // A child that exits before reading — a bad flag, a failed
                // login — closes the pipe first, and the write error says no
                // more than the exit status and stderr tail already will.
                let _ = stdin.write_all(line.as_bytes()).await;
                let _ = stdin.shutdown().await;
            });
        }

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

/// Where to look for the CLI when a bare name does not resolve on `PATH`.
///
/// Unix only, and that is the bug rather than a platform Nightloom cares
/// less about. A GUI process on macOS is started by launchd, which hands it
/// a minimal `PATH` — `/usr/bin:/bin:/usr/sbin:/sbin` — and never sources a
/// login shell, so `.zshrc` might as well not exist. Claude Code's own
/// installer puts the binary in `~/.local/bin`, which is in none of that, so
/// the desktop app failed to find a working `claude` for **every** macOS
/// user who installed it the documented way, while the same default worked
/// perfectly from a terminal. Linux launched from a `.desktop` entry is the
/// same story. Windows is not: a GUI process there inherits the machine and
/// user `PATH` out of the registry, so the case this exists for cannot
/// arise, and probing Unix directories on it would be theatre.
///
/// Resolving through a **login shell** is the general answer and is
/// deliberately not what this does. `$SHELL -lic 'command -v claude'` covers
/// version managers this list cannot, and it also runs the user's entire
/// startup configuration on the connect path, where it can be slow and can
/// hang outright on a broken rc file. That trades a reliable connect for
/// coverage of a case that already has a working answer — [`AgentSpec::binary`]
/// takes an absolute path, and both shells expose it.
#[cfg(unix)]
fn candidate_dirs() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut dirs = Vec::new();
    if let Some(h) = &home {
        // The native installer's location, and so the one that matters.
        dirs.push(h.join(".local/bin"));
    }
    // Apple silicon homebrew, then Intel homebrew and the usual npm prefix.
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));
    if let Some(h) = &home {
        dirs.push(h.join(".bun/bin"));
        dirs.push(h.join(".volta/bin"));
        dirs.push(h.join(".npm-global/bin"));
    }
    dirs
}

#[cfg(not(unix))]
fn candidate_dirs() -> Vec<PathBuf> {
    Vec::new()
}

/// Everywhere a bare binary name is looked for, for an error message.
///
/// A "not found" that does not say where it looked leaves the user with
/// nothing to check, which is most of why the original report had to be
/// diagnosed by hand.
pub fn searched_locations() -> Vec<String> {
    let mut out = vec!["PATH".to_string()];
    out.extend(candidate_dirs().iter().map(|d| d.display().to_string()));
    out
}

/// The path to actually spawn for a configured binary name.
///
/// `PATH` wins whenever it resolves, and that ordering is load-bearing
/// rather than tidiness: a user running the CLI through a version manager
/// has a `PATH` entry that is *correct* and may well also have a stale
/// `~/.local/bin/claude` from an install they replaced. Preferring the
/// candidate list would silently run the wrong one — a worse failure than
/// the one being fixed, because it succeeds.
///
/// A name carrying a separator is returned untouched: the user pointed
/// somewhere on purpose, and second-guessing that is not this function's
/// job. So is a name nothing resolves, so the error names what was asked
/// for rather than something invented here.
pub fn resolve_binary(binary: &str) -> String {
    if binary.chars().any(std::path::is_separator) {
        return binary.to_string();
    }
    if which_on_path(binary).is_some() {
        return binary.to_string();
    }
    for dir in candidate_dirs() {
        let candidate = dir.join(binary);
        if candidate.is_file() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    binary.to_string()
}

/// Whether a bare name resolves on `PATH`.
///
/// Hand-rolled for the same reason `project.rs` hand-rolls FNV-1a and
/// `prompt.rs` reads `.git/HEAD` rather than spawning git: it is a dozen
/// lines against a transitive dependency tree. Unix only, because the
/// fallback it guards is — on Windows nothing here is consulted and
/// `Command` does its own resolution, `PATHEXT` and all, exactly as before.
#[cfg(unix)]
fn which_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .filter(|d| !d.as_os_str().is_empty())
        .map(|d| d.join(name))
        .find(|p| p.is_file())
}

#[cfg(not(unix))]
fn which_on_path(_name: &str) -> Option<PathBuf> {
    // Never reached: `candidate_dirs` is empty off Unix, so `resolve_binary`
    // returns the name unchanged whatever this says.
    None
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
            "--setting-sources",
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
            "--setting-sources",
            "--resume",
            "--max-budget-usd",
            "--system-prompt",
        ] {
            assert!(a.iter().any(|x| x == flag), "missing {flag}");
        }
    }

    /// Approval on is `auto`, not `dontAsk`: the classifier decides, and a
    /// headless run it cannot approve is denied rather than left waiting.
    /// Off is still the CLI's "run everything".
    #[test]
    fn approval_on_is_auto_mode_and_off_is_bypass() {
        let mut s = spec();
        s.permission_mode = Some(AgentSpec::headless_permission_mode(true).into());
        let a = s.args("hi");
        let i = a.iter().position(|x| x == "--permission-mode").unwrap();
        assert_eq!(a[i + 1], "auto");
        assert!(!a.iter().any(|x| x == "dontAsk"), "{a:?}");

        s.permission_mode = Some(AgentSpec::headless_permission_mode(false).into());
        let a = s.args("hi");
        let i = a.iter().position(|x| x == "--permission-mode").unwrap();
        assert_eq!(a[i + 1], "bypassPermissions");
    }

    /// Caller-supplied arguments go last so they can override.
    #[test]
    fn add_dirs_become_add_dir_flags() {
        let mut s = AgentSpec::new(PathBuf::from("/w"));
        s.add_dirs = vec![PathBuf::from("/vault"), PathBuf::from("/other")];
        let a = s.args("hi");
        let joined = a.join(" ");
        assert!(joined.contains("--add-dir /vault --add-dir /other"), "{a:?}");
        // The CLI's own flags come first; a directory grant is never the
        // thing that pushes `-p` off the front.
        assert_eq!(a[0], "-p");
    }

    /// A turn with attachments drops the prompt from argv and says where
    /// it is coming from instead. The first argument is still `-p`: the
    /// stdin shape is print mode too, not an interactive session that
    /// happens to be fed a pipe.
    #[test]
    fn stdin_args_replace_the_prompt_with_the_input_format() {
        let a = spec().stdin_args();
        assert_eq!(&a[..3], ["-p", "--input-format", "stream-json"]);
        assert!(!a.iter().any(|x| x == "hi"));
        for flag in [
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
        ] {
            assert!(a.iter().any(|x| x == flag), "missing {flag} in {a:?}");
        }
    }

    /// Everything after the prompt is the same vector either way — the
    /// resume id, the model, the tool set, the directory grants. One
    /// tail, not two, is what makes every flag test above hold for the
    /// stdin shape without being written twice.
    #[test]
    fn the_stdin_shape_carries_every_flag_the_argv_shape_does() {
        let mut s = spec();
        s.model = Some("opus".into());
        s.tools = Some(vec![]);
        s.resume = Some("sess-9".into());
        s.safe_mode = true;
        s.add_dirs = vec![PathBuf::from("/vault")];
        s.extra_args = vec!["--x".into()];
        let argv = s.args("hi");
        let stdin = s.stdin_args();
        // `-p hi` versus `-p --input-format stream-json`, then identical.
        assert_eq!(argv[2..], stdin[3..]);
    }

    /// The stdin line is the Agent SDK's user message: a `user` line whose
    /// Messages-API `content` is the block list, caption first, images
    /// before documents, every source base64. Asserted on the parsed JSON,
    /// since the CLI reads the frame and not the spelling.
    #[test]
    fn the_stdin_line_is_one_user_message_with_the_blocks_in_log_order() {
        let input = TurnInput {
            text: "what colour".into(),
            images: vec![nightloom_core::ImageInput {
                media_type: "image/png".into(),
                data: "AAAA".into(),
            }],
            documents: vec![nightloom_core::DocumentInput {
                media_type: "application/pdf".into(),
                name: "notes.pdf".into(),
                data: "BBBB".into(),
            }],
        };
        let line = protocol::user_line(&input);
        assert!(line.ends_with('\n'), "NDJSON needs the frame");
        assert_eq!(line.matches('\n').count(), 1, "one line, not several");
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["role"], "user");
        assert!(v["parent_tool_use_id"].is_null());
        let content = v["message"]["content"].as_array().unwrap();
        assert_eq!(content.len(), 3);
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[0]["text"], "what colour");
        assert_eq!(content[1]["type"], "image");
        assert_eq!(content[1]["source"]["type"], "base64");
        assert_eq!(content[1]["source"]["media_type"], "image/png");
        assert_eq!(content[1]["source"]["data"], "AAAA");
        assert_eq!(content[2]["type"], "document");
        assert_eq!(content[2]["source"]["media_type"], "application/pdf");
        assert_eq!(content[2]["source"]["data"], "BBBB");
        assert_eq!(content[2]["title"], "notes.pdf");
    }

    /// A text-only turn is untouched by all of this: `-p <prompt>`, no
    /// `--input-format`. That is the shape every caller outside the desktop
    /// still uses, and the one the resume path was tested on.
    #[test]
    fn a_text_only_turn_never_asks_for_stdin_input() {
        let a = spec().args("hi");
        assert!(!a.iter().any(|x| x == "--input-format"), "{a:?}");
        assert_eq!(&a[..2], ["-p", "hi"]);
    }

    #[test]
    fn mcp_config_is_passed_inline_and_survives_safe_mode() {
        let mut s = AgentSpec::new(PathBuf::from("/w"));
        s.mcp_config = Some(r#"{"mcpServers":{"nightloom":{}}}"#.into());
        let a = s.args("hi");
        let i = a.iter().position(|x| x == "--mcp-config").expect("flag");
        assert_eq!(a[i + 1], r#"{"mcpServers":{"nightloom":{}}}"#);
        s.safe_mode = true;
        let a = s.args("hi");
        assert!(a.iter().any(|x| x == "--strict-mcp-config"), "{a:?}");
        assert!(a.iter().any(|x| x == "--mcp-config"), "{a:?}");
    }

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

    /// Safe mode is three flags and none of them is `--safe-mode`.
    ///
    /// `--safe-mode` discards the `--mcp-config` server with the host's
    /// (measured 2026-09-14, nightshift blocker 058), so Nightloom's tools
    /// vanished with it. An empty `--setting-sources` drops the host's
    /// settings — CLAUDE.md, hooks, allowlist — and `--strict-mcp-config`
    /// keeps every server but the one on the command line off; both are
    /// load-bearing and the empty string is the value, not an omission.
    /// The old `--safe-mode` coming back would restore the bug silently.
    #[test]
    fn safe_mode_is_no_setting_sources_plus_strict_mcp_config() {
        let mut s = spec();
        s.safe_mode = true;
        let a = s.args("hi");
        assert!(!a.iter().any(|x| x == "--safe-mode"), "{a:?}");
        let i = a.iter().position(|x| x == "--setting-sources").expect("flag");
        assert_eq!(a[i + 1], "", "the value is the empty list");
        assert!(a.iter().any(|x| x == "--strict-mcp-config"));
        assert!(a.iter().any(|x| x == "--disable-slash-commands"));
    }

    /// And only under safe mode: without it the host's own servers are
    /// exactly what the user is asking to keep.
    #[test]
    fn strict_mcp_config_is_not_sent_unasked() {
        assert!(!spec().args("hi").iter().any(|x| x == "--strict-mcp-config"));
    }

    /// An incognito chat confines the CLI to the measured read-only list —
    /// `--tools` with five names, never `--disallowedTools` — and does not
    /// ask for `--no-session-persistence`; an ephemeral one does both. The
    /// rail's "no tools" is left alone by either.
    #[test]
    fn incognito_is_the_read_only_tool_list_and_ephemeral_adds_no_persistence() {
        let mut s = spec();
        s.apply_mode(ChatMode::Normal);
        let a = s.args("hi");
        assert!(!a.iter().any(|x| x == "--tools"));
        assert!(!a.iter().any(|x| x == "--no-session-persistence"));

        let mut s = spec();
        s.apply_mode(ChatMode::Incognito);
        let a = s.args("hi");
        let i = a.iter().position(|x| x == "--tools").expect("--tools");
        assert_eq!(&a[i + 1..i + 6], READ_ONLY_TOOLS);
        for writer in ["Write", "Edit", "NotebookEdit", "Bash"] {
            assert!(!a.iter().any(|x| x == writer), "{writer} in {a:?}");
        }
        assert!(!a.iter().any(|x| x == "--disallowedTools"), "{a:?}");
        assert!(!a.iter().any(|x| x == "--no-session-persistence"), "{a:?}");

        let mut s = spec();
        s.apply_mode(ChatMode::Ephemeral);
        let a = s.args("hi");
        let i = a.iter().position(|x| x == "--tools").expect("--tools");
        assert_eq!(&a[i + 1..i + 6], READ_ONLY_TOOLS);
        assert!(a.iter().any(|x| x == "--no-session-persistence"), "{a:?}");
        // Before the caller's own trailing arguments, like every other flag.
        s.extra_args = vec!["--x".into()];
        let a = s.args("hi");
        assert_eq!(a.last().map(String::as_str), Some("--x"));

        let mut s = spec();
        s.tools = Some(vec![]);
        s.apply_mode(ChatMode::Incognito);
        let a = s.args("hi");
        let i = a.iter().position(|x| x == "--tools").unwrap();
        assert_eq!(a[i + 1], "", "no tools stays no tools");
    }

    /// A path the user typed is honoured as typed. Second-guessing it would
    /// override the one escape hatch the fallback leaves them.
    #[test]
    fn an_explicit_path_is_never_rewritten() {
        for named in ["/opt/claude/bin/claude", "./claude", "../tools/claude"] {
            assert_eq!(resolve_binary(named), named);
        }
    }

    /// A name nothing resolves comes back unchanged, so the error names
    /// what was asked for rather than a directory invented here.
    #[test]
    fn an_unresolvable_name_is_returned_as_asked() {
        let name = "nightloom-no-such-binary-9f3a";
        assert_eq!(resolve_binary(name), name);
    }

    /// `PATH` is searched first and said first. Preferring a candidate
    /// directory would silently run a stale install in front of the one the
    /// user's version manager put on `PATH`.
    #[test]
    fn path_leads_the_places_that_are_searched() {
        assert_eq!(
            searched_locations().first().map(String::as_str),
            Some("PATH")
        );
    }
}
