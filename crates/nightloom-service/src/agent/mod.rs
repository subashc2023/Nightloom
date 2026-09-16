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

pub mod ask;
pub mod cli_session;
mod protocol;
mod record;
mod translate;

pub use ask::{Answer, AskDir, AskGate, DeferredCall, PlanThen};
pub use protocol::RateLimitInfo;
pub use record::{Recorder, SUBAGENT_CLOSE, SUBAGENT_OPEN, carry_transcript, subagent_block};
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

/// How long an interrupted CLI gets to end the turn itself before it is
/// killed (2026-09-16, nightshift backlog 074).
///
/// Measured on 2.1.263, Haiku, a foreground `python3 … sleep(40)` under
/// `bypassPermissions`, the signal sent at 15 s (nightshift
/// `074-report-2026-09-16.md`):
///
/// | stop | exit | last lines | next `--resume`, "what happened?" |
/// |---|---|---|---|
/// | SIGINT | 0, **0.5 s** after the signal | the call's error result ("The user doesn't want to proceed with this tool use…"), `[Request interrupted by user for tool use]`, a `result` with `terminal_reason: "aborted_tools"` | 6 s, no tool call: says the command was rejected |
/// | SIGKILL (the old Stop) | 137 | a `task_started` for the command; no `result` | **47 s, re-ran the 40 s command on its own** and replied `done` |
///
/// So the interrupt is what keeps a stopped chat stopped: the CLI closes
/// the turn in its session file, and the resume takes the next message
/// as a new one. The grace is ten times the measured time to exit, for a
/// slower machine; past it the kill below is the backstop it always was.
const INTERRUPT_GRACE: Duration = Duration::from_secs(5);

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
    /// `--effort <level>` (2026-09-16, nightshift backlog 076): `low`,
    /// `medium`, `high`, `xhigh` or `max` (`external`, `claude --help`
    /// 2.1.263), passed through as the rail sent it — the levels a model
    /// supports are the CLI's to know, and an unsupported one falls back
    /// (`external`, the model-config doc). `None` sends nothing and the
    /// CLI's default applies (his settings say `high`; under safe mode the
    /// settings are dropped and the model's own default applies). Measured
    /// on Haiku, one run each, "explain in three sentences why the sky is
    /// blue" (`m076/e-*.jsonl`):
    ///
    /// | `--effort` | output tokens | of which thinking | API ms |
    /// |---|---|---|---|
    /// | low | 177 | 96 | 2,466 |
    /// | high | 190 | 66 | 2,688 |
    /// | xhigh | 313 | 222 | 3,909 |
    ///
    /// One run each, so the ordering is the finding and the figures are
    /// not. Neither the stream nor the session file on 2.1.263 carries an
    /// `effort` field to read the level back from. The `xhigh` turn on
    /// Opus the item asks for was not run (nightshift blocker 079).
    pub effort: Option<String>,
    /// `--fallback-model <model>` (backlog 076): the model the CLI retries
    /// with when `model` is overloaded or unavailable — a comma-separated
    /// list is accepted (`external`, `claude --help`). `-p` only, which is
    /// every turn here. Measured once on Haiku with `sonnet` as the
    /// fallback: accepted, and with Haiku answering the result's
    /// `modelUsage` named Haiku alone — no line in the stream says a
    /// fallback was configured or not needed, so "no fallback used" is
    /// read from `modelUsage` naming the primary only.
    pub fallback_model: Option<String>,
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
    ///
    /// **Auto memory, measured 2026-09-16 (nightshift backlog 088), CLI
    /// 2.1.263, Haiku, a planted `MEMORY.md` under the scratch cwd's
    /// project folder:** this spelling of safe mode does **not** drop the
    /// CLI's auto memory (`~/.claude/projects/<cwd>/memory/`) — an empty
    /// `--setting-sources` drops the settings *files*, and the memory
    /// directory is not one. The table above, with one column added:
    ///
    /// | spelling | auto memory |
    /// |---|---|
    /// | plain | loads |
    /// | `--setting-sources "" --strict-mcp-config --disable-slash-commands` | **loads** |
    /// | either + `--settings '{"autoMemoryEnabled":false}'` | off |
    ///
    /// So the per-chat switch is [`AgentSpec::auto_memory`], sent inline
    /// like the Ask hook, and it holds under safe mode for the same
    /// reason the hook does.
    pub safe_mode: bool,
    /// Whether the CLI reads its own auto memory for this cwd
    /// (`~/.claude/projects/<cwd>/memory/`; nightshift backlog 088,
    /// 2026-09-16). On by default, as the CLI has it; off sends
    /// `autoMemoryEnabled: false` in `--settings`. **In the same JSON as
    /// the Ask hook's, never a second `--settings`:** measured on 2.1.263,
    /// two `--settings` flags do not merge — the last one wins, and the
    /// memory came back. Nightloom never writes these files; the vault and
    /// `remember` are its own durable memory, and the engine note says so.
    pub auto_memory: bool,
    /// Whether the CLI may compact the conversation itself when its window
    /// fills (nightshift backlog 086, 2026-09-16). **Off by default on
    /// every path** — a chat, a dream, a capture: he does not compact (a
    /// compaction boundary in 2 of 610 sessions), and Nightloom's own
    /// hand-off — a wrap-up into `HANDOFF.md` and a linked new chat — is
    /// what the window filling means here. Off is sent two ways, both
    /// read from the CLI binary (2.1.263; nightshift
    /// `notes/runner-design/086-measurements-2026-09-16.md`):
    /// `autoCompactEnabled: false` in the one `--settings` JSON, the
    /// documented key with default true, and `DISABLE_AUTO_COMPACT=1` in
    /// the child's environment, which the code checks before it reads the
    /// setting at all. Not measured with a turn past the window.
    pub auto_compact: bool,
    /// Ask the CLI to predict the next prompt after each turn (nightshift
    /// backlog 083, 2026-09-16): `--prompt-suggestions true` — the value
    /// spelled out, since the option takes an optional one and would
    /// swallow the prompt otherwise (measured). Off by default. The
    /// `prompt_suggestion` line arrives *after* `result`, from a request
    /// the CLI waits for before exiting: about six seconds on every turn
    /// (measured on Haiku), which the shell's setting says out loud.
    pub prompt_suggestions: bool,
    /// Resume a previous Claude Code session by id.
    pub resume: Option<String>,
    /// With `resume`, continue it as a **new** session and leave the
    /// original untouched: `--fork-session` (2026-09-16, nightshift backlog
    /// 080; `external`, `claude --help`: "When resuming, create a new
    /// session ID instead of reusing the original"). One turn only —
    /// [`ClaudeCodeAgent::follow_on`] adopts the id the CLI minted and
    /// clears this. Measured on 2.1.263, Haiku, a two-turn session
    /// (PELICAN, OTTER) resumed with "list every message so far":
    ///
    /// | resume | session id | cache read / write | history |
    /// |---|---|---|---|
    /// | `--resume <id> --fork-session` | a new one; the original's file untouched, the fork's written whole beside it | 7,298 / 436 | intact, both code words |
    /// | `--resume <id>` (plain) | the same | 7,493 / 48 | intact |
    /// | a **copy** of the file under a new id (backlog 062's fork, cut before the second turn) | the copy's | 7,017 / 247 | first turn only |
    ///
    /// So a fork by flag reads the shared prefix from cache as the copy
    /// does, and costs no file rewrite. What it cannot do is cut: the fork
    /// carries the whole history, so a fork that drops turns — every fork
    /// the desktop makes today, edit-and-send truncating before the edited
    /// turn — still needs [`cli_session`]'s copy.
    pub fork_session: bool,
    /// Hard ceiling on what one turn may spend.
    pub max_budget_usd: Option<f64>,
    /// `--max-turns <n>`: how many model rounds one turn may take. `None`
    /// is the CLI's default (unbounded). An aside sends 2
    /// ([`AgentSpec::aside`]): its answering round, plus one in case the
    /// model read something first — measured, a turn that calls a tool
    /// under `--max-turns 1` runs the tool and then ends `error_max_turns`
    /// with no answer (nightshift `081-report-2026-09-16.md`, M4).
    pub max_turns: Option<u32>,
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
    /// The Ask position of the approval switch (2026-09-16, nightshift
    /// backlog 084): the CLI pauses on each call a person should decide,
    /// and Nightloom asks. See [`AskSpec`] for what it puts on the line and
    /// [`ask`] for the hook and the files behind it. `None` is the two
    /// older positions, `auto` and `bypassPermissions`
    /// ([`AgentSpec::headless_permission_mode`]).
    pub ask: Option<AskSpec>,
    /// Passed through verbatim, last, so a caller can reach a flag this
    /// struct has not grown a field for.
    pub extra_args: Vec<String>,
}

/// What the Ask position adds to the command line.
///
/// Three flags, each measured on 2.1.263 before this existed (nightshift
/// `082-five-measurements-2026-09-16.md`, 4 and 5):
///
/// - `--permission-mode default` — Manual mode, where every call outside
///   the working-directory reads would prompt; headless there is nobody to
///   prompt, which is exactly the gap the hook fills first.
/// - `--settings <json>` registering `<hook> --permission-hook <dir>` as a
///   `PreToolUse` hook on the prompting tools ([`ask::MATCHER`]). Given
///   inline it fires under safe mode too — `--setting-sources ""` drops
///   the settings *files*, not this — and its `defer` makes the process
///   exit with the call in `deferred_tool_use`.
/// - `--permission-prompt-tool mcp__nightloom__ask` — without a prompt
///   tool named, the CLI does not offer `AskUserQuestion`, `EnterPlanMode`
///   or `ExitPlanMode` at all; with one, all three appear, whatever the
///   name resolves to, and the tool is never called while the hook answers
///   first. Nightloom's server does not serve it on purpose: a real
///   prompt tool blocks the process on the answer, which is the mechanism
///   blocker 071 chose against.
///
/// **The Plan position (2026-09-16, nightshift backlog 085)** is the same
/// three flags with `--permission-mode plan` in place of `default`
/// ([`AskMode::Plan`]): the CLI reads, runs what it may, writes its plan
/// file and calls `ExitPlanMode`, which the hook defers like any call.
/// Measured on 2.1.263, Haiku (nightshift `085-report-2026-09-16.md`):
///
/// | resume of the deferred `ExitPlanMode`, allowed | `ExitPlanMode` result | next `Write` |
/// |---|---|---|
/// | `--permission-mode plan`, full hook | "User has approved exiting plan mode" | deferred (Ask) |
/// | `--permission-mode default`, full hook | error "You are not in plan mode … continue" | deferred (Ask) |
/// | `--permission-mode plan`, hook on `ExitPlanMode` only | approved | Manual: prompt tool refuses |
/// | `--permission-mode auto`, hook on `ExitPlanMode` only | the same error | Manual: prompt tool refuses |
/// | `--permission-mode auto`, no hook | — | refused before any call: `tool_deferred_unavailable`, exit 1 |
///
/// So the approval's resume keeps `plan` for the Ask pick (the clean
/// row), takes `auto` with the narrow matcher for the Auto pick
/// ([`AskMode::ExitingToAuto`], one process), and must always carry the
/// hook. Note `auto` reported `permissionMode: "default"` on every run
/// tonight — unavailable to the session, the CLI starts in Manual — which
/// is the Auto position's standing caveat ([`AgentSpec::headless_permission_mode`]).
#[derive(Debug, Clone)]
pub struct AskSpec {
    /// The hook program and its leading arguments — `[<this binary>,
    /// "--permission-hook"]`; the directory is appended per turn.
    pub hook: Vec<String>,
    /// The chat's ask directory, where the decision and the rules live.
    pub dir: PathBuf,
    /// Which position the hook serves.
    pub mode: AskMode,
}

/// The permission mode the hook is registered under (backlog 085).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AskMode {
    /// `--permission-mode default`: 084's Ask position.
    Ask,
    /// `--permission-mode plan`: nothing is edited until the plan the
    /// card shows is approved.
    Plan,
    /// One resume only, the Auto pick on an approved plan:
    /// `--permission-mode auto` with the hook on the plan tool alone
    /// ([`ask::EXIT_PLAN_MATCHER`]). [`ClaudeCodeAgent::plan_exited`]
    /// turns it into the Auto position proper (no hook, `auto`).
    ExitingToAuto,
    /// An aside of an asking chat (backlog 081): the prompt tool is still
    /// named — without it the question and plan tools leave the offered
    /// list and the cached prefix goes cold — but **no hook** is
    /// registered, since a deferral would park the aside on a prompt, and
    /// the mode is `dontAsk`, which refuses anything that would prompt.
    Aside,
}

impl AskMode {
    /// The `--permission-mode` value.
    pub fn permission_mode(self) -> &'static str {
        match self {
            Self::Ask => "default",
            Self::Plan => "plan",
            Self::ExitingToAuto => "auto",
            Self::Aside => "dontAsk",
        }
    }

    /// The hook's matcher.
    pub fn matcher(self) -> &'static str {
        match self {
            Self::Ask | Self::Plan => ask::MATCHER,
            Self::ExitingToAuto => ask::EXIT_PLAN_MATCHER,
            // Never registered; see the variant.
            Self::Aside => "",
        }
    }
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
            effort: None,
            fallback_model: None,
            tools: None,
            allowed_tools: Vec::new(),
            permission_mode: None,
            system_prompt: None,
            append_system_prompt: None,
            safe_mode: false,
            auto_memory: true,
            auto_compact: false,
            prompt_suggestions: false,
            resume: None,
            fork_session: false,
            max_budget_usd: None,
            max_turns: None,
            use_subscription: true,
            add_dirs: Vec::new(),
            mcp_config: None,
            no_session_persistence: false,
            ask: None,
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
            // Ask needs `--resume`, and an ephemeral chat's CLI session
            // cannot be resumed (see `no_session_persistence`): a deferred
            // call there would be a prompt whose answer has nowhere to go.
            // The read-only list above leaves nothing that would pause
            // anyway; this makes the fact explicit rather than incidental.
            self.ask = None;
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
    /// `pub(crate)` so the dream's test can assert on its own invocation.
    pub(crate) fn args(&self, prompt: &str) -> Vec<String> {
        self.argv(Shape::Prompt(prompt))
    }

    /// The argument vector for one turn whose user message arrives on
    /// stdin as a `stream-json` line — the shape a turn with attachments
    /// takes, since argv carries text and nothing else.
    fn stdin_args(&self) -> Vec<String> {
        self.argv(Shape::Stdin)
    }

    /// The argument vector that continues a deferred call: `-p` with no
    /// prompt at all, and `--resume` doing the work. The CLI accepts the
    /// missing prompt only for a session holding a deferred call
    /// (`external`, the hooks doc; measured 2026-09-16), which is the one
    /// case this is built for.
    pub(crate) fn resume_args(&self) -> Vec<String> {
        self.argv(Shape::Resume)
    }

    /// The spec for an **aside** (2026-09-16, nightshift backlog 081): a
    /// side question answered from the chat's context, off the chat's
    /// warm cache, kept out of its history — what the CLI's interactive
    /// `/btw` does, which `-p` refuses ("`/btw` isn't available in this
    /// environment", measured). `None` when the chat has no CLI session
    /// yet: there is nothing to ask beside.
    ///
    /// Everything that shapes the cached prefix — the model, the tools,
    /// the MCP servers, the prompt tool, the system prompt — stays as the
    /// chat has it, because the prefix is what makes an aside cheap.
    /// Measured on Haiku against a 30-tool session (`081-report`, M3): the
    /// same tools under `dontAsk` read 32,052 of the prefix back and wrote
    /// 242; `--tools ""` read **0** and wrote 10,360; `plan` mode read 0
    /// and wrote 44,176. So an aside is not toolless — it is harmless:
    /// `dontAsk` refuses anything that would prompt, a read inside the
    /// workspace may still happen, and `--max-turns 2` gives such a read
    /// its answering round. `--fork-session` keeps the chat's session
    /// untouched (the next real turn saw nothing of the aside, M2) and
    /// `--no-session-persistence` keeps the fork off the disk (no file
    /// appeared, M3's last row). The Ask position's hook is not
    /// registered — a deferral would park the aside on a prompt — but its
    /// prompt tool stays named, or the offered tools change and the
    /// prefix with them.
    pub fn aside(&self) -> Option<AgentSpec> {
        self.resume.as_ref()?;
        let mut spec = self.clone();
        spec.fork_session = true;
        spec.no_session_persistence = true;
        spec.max_turns = Some(2);
        spec.permission_mode = Some("dontAsk".into());
        if let Some(ask) = &mut spec.ask {
            ask.mode = AskMode::Aside;
        }
        Some(spec)
    }

    /// The three shapes differ in the first arguments only. A prompt goes
    /// on argv as `-p <prompt>`; the stdin shape is `-p --input-format
    /// stream-json`, saying the message is coming on stdin; a resume of a
    /// deferred call is `-p` alone. The rest is identical, which is the
    /// property that keeps the resume path and every flag test valid for
    /// every shape without a second copy of each.
    fn argv(&self, shape: Shape<'_>) -> Vec<String> {
        let mut a: Vec<String> = vec!["-p".into()];
        match shape {
            Shape::Prompt(p) => a.push(p.into()),
            Shape::Stdin => {
                a.push("--input-format".into());
                a.push("stream-json".into());
            }
            Shape::Resume => {}
        }
        a.extend([
            "--output-format".into(),
            "stream-json".into(),
            // Required by the CLI alongside stream-json, and the reason
            // there are deltas to render at all rather than one block at
            // the end of the turn.
            "--verbose".into(),
            "--include-partial-messages".into(),
            // A subagent's text and thinking as `assistant`/`user` lines
            // carrying `parent_tool_use_id` (2026-09-16, nightshift backlog
            // 075; `external`, the headless reference: v2.1.211+, "at every
            // nesting depth"). Measured on 2.1.263 with an Explore subagent
            // (`m075-1-forward.jsonl` against `m075-2-noforward.jsonl`): the
            // child's final text arrived as one whole `assistant` line and
            // its thinking blocks came empty **with or without the flag**,
            // so on this release it changes nothing that was seen; it is
            // sent for the documented guarantee, since what the flag
            // gates is the CLI's to decide per release, and the translator
            // reads the lines the same either way.
            "--forward-subagent-text".into(),
        ]);
        if let Some(m) = &self.model {
            a.push("--model".into());
            a.push(m.clone());
        }
        if let Some(e) = &self.effort {
            a.push("--effort".into());
            a.push(e.clone());
        }
        if let Some(f) = &self.fallback_model {
            a.push("--fallback-model".into());
            a.push(f.clone());
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
        // Ask overrides the mode: the hook decides first, and what it
        // does not catch falls to Manual, which headless is a refusal the
        // transcript shows — never a silent classifier approval.
        match (&self.ask, &self.permission_mode) {
            (Some(ask), _) => {
                a.push("--permission-mode".into());
                a.push(ask.mode.permission_mode().into());
            }
            (None, Some(mode)) => {
                a.push("--permission-mode".into());
                a.push(mode.clone());
            }
            (None, None) => {}
        }
        // One `--settings` for everything sent inline: the CLI keeps only
        // the last one given (measured 2026-09-16, `auto_memory`'s doc), so
        // the Ask hook and the memory switch share a JSON object.
        let mut settings = serde_json::Map::new();
        if let Some(ask) = &self.ask {
            if ask.mode != AskMode::Aside
                && let Ok(serde_json::Value::Object(hook)) = serde_json::from_str::<serde_json::Value>(
                    &ask::settings_json_matching(&ask.hook, &ask.dir, ask.mode.matcher()),
                )
            {
                settings.extend(hook);
            }
            a.push("--permission-prompt-tool".into());
            a.push(ask::PROMPT_TOOL.into());
        }
        if !self.auto_memory {
            settings.insert("autoMemoryEnabled".into(), serde_json::Value::Bool(false));
        }
        if !self.auto_compact {
            settings.insert("autoCompactEnabled".into(), serde_json::Value::Bool(false));
        }
        if !settings.is_empty() {
            a.push("--settings".into());
            a.push(serde_json::Value::Object(settings).to_string());
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
            // Meaningless without a session to fork, so never sent alone.
            if self.fork_session {
                a.push("--fork-session".into());
            }
        }
        if let Some(budget) = self.max_budget_usd {
            a.push("--max-budget-usd".into());
            a.push(budget.to_string());
        }
        if let Some(n) = self.max_turns {
            a.push("--max-turns".into());
            a.push(n.to_string());
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
        if self.prompt_suggestions {
            a.push("--prompt-suggestions".into());
            a.push("true".into());
        }
        a.extend(self.extra_args.iter().cloned());
        a
    }
}

/// How one turn's user message reaches the CLI — see [`AgentSpec::argv`].
#[derive(Debug, Clone, Copy)]
enum Shape<'a> {
    Prompt(&'a str),
    Stdin,
    Resume,
}

/// How a background pass — a dream, a capture — drives the CLI
/// (2026-09-16, nightshift backlog 070).
///
/// A chat's connection carries a dozen settings; a pass needs four of them,
/// and this is the shape that says which. The binary, the model alias and
/// safe mode are the rail's own, so a pass runs on whatever the user
/// already trusts a chat with; the subscription default is
/// [`AgentSpec::use_subscription`]'s, for its reason — the pass exists so a
/// dream bills the plan and not a key, and an inherited key would silently
/// undo that. Nothing of a chat's crosses: no preamble (the pass has its own
/// instruction), no `--add-dir` (the target folder is the working
/// directory, and the one file it must not reach lives above it), no
/// resume (each target is one fresh turn).
///
/// `server` is how Nightloom's MCP server is started — the program and its
/// leading arguments, `[<desktop binary>, "--mcp-serve"]` from the app and
/// `[nightloom, "mcp-serve"]` from the CLI. A dream appends
/// `--dream <json>` so the server serves `propose_instructions` and nothing
/// else (`mcp_server::DreamServe`); a capture starts no server at all.
#[derive(Debug, Clone)]
pub struct PassSpec {
    pub binary: String,
    /// Model alias (`haiku`, `sonnet`) or a full id; `None` is the CLI's
    /// default, as for a chat.
    pub model: Option<String>,
    pub safe_mode: bool,
    pub use_subscription: bool,
    pub server: Vec<String>,
}

impl PassSpec {
    pub fn new(binary: impl Into<String>, server: Vec<String>) -> Self {
        Self {
            binary: binary.into(),
            model: None,
            safe_mode: false,
            use_subscription: true,
            server,
        }
    }

    /// An [`AgentSpec`] rooted at `cwd` with this pass's settings and
    /// nothing else set: the caller names the tools, the permission mode,
    /// the system prompt and the server. Kept as the one place the four
    /// carried settings are copied across, so a dream and a capture cannot
    /// differ in which of the rail's settings they honour.
    pub fn spec_in(&self, cwd: impl Into<PathBuf>) -> AgentSpec {
        let mut spec = AgentSpec::new(cwd);
        spec.binary = self.binary.clone();
        spec.model = self.model.clone();
        spec.safe_mode = self.safe_mode;
        spec.use_subscription = self.use_subscription;
        spec
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
    /// A fork asked for by [`Self::fork_on_next_turn`] is done once the CLI
    /// has named the new session: the next turn resumes *that*, plainly.
    pub fn follow_on(&mut self, outcome: &AgentOutcome) {
        if let Some(id) = &outcome.session_id {
            self.spec.resume = Some(id.clone());
            self.spec.fork_session = false;
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

    /// Make the next turn a fork of the session pointed at: the CLI mints
    /// a new id, the original stays as it was, and [`Self::follow_on`]
    /// adopts the new id when the turn lands (backlog 080). A no-op with
    /// nothing to resume. For a fork that keeps the whole history; a fork
    /// that cuts is `cli_session`'s copy.
    pub fn fork_on_next_turn(&mut self) {
        if self.spec.resume.is_some() {
            self.spec.fork_session = true;
        }
    }

    /// Point the Ask position's files at `dir` — the open chat's ask
    /// directory, which the shell knows only once the chat exists. A
    /// no-op on a connection that is not asking.
    pub fn set_ask_dir(&mut self, dir: PathBuf) {
        if let Some(ask) = &mut self.spec.ask {
            ask.dir = dir;
        }
    }

    /// Whether the connection is in the Plan position.
    pub fn planning(&self) -> bool {
        self.spec
            .ask
            .as_ref()
            .is_some_and(|a| a.mode == AskMode::Plan)
    }

    /// The card's Approve on a deferred `ExitPlanMode` (backlog 085),
    /// called **before** the resume that carries the allow. For the Ask
    /// pick nothing changes yet: the resume must run in `plan` mode for
    /// the tool to succeed (the table on [`AskSpec`]), and the hook keeps
    /// deferring. For the Auto pick the resume is the one-off
    /// [`AskMode::ExitingToAuto`] shape. Either way [`Self::plan_exited`]
    /// follows the resume. A no-op on a connection that is not in the
    /// Plan position — a plan the model entered on its own mid-Ask
    /// (`EnterPlanMode`) is approved in place and the chat stays Ask,
    /// which is what the rail still shows.
    pub fn plan_approved(&mut self, then: PlanThen) {
        if let Some(ask) = &mut self.spec.ask
            && ask.mode == AskMode::Plan
            && then == PlanThen::Auto
        {
            ask.mode = AskMode::ExitingToAuto;
        }
    }

    /// After the approval's resume: the chat takes the position the card
    /// picked — Ask (the hook stays, `default` mode) or Auto (no hook,
    /// `auto`, exactly what the switch's Auto position sends).
    pub fn plan_exited(&mut self) {
        match self.spec.ask.as_ref().map(|a| a.mode) {
            Some(AskMode::Plan) => {
                if let Some(ask) = &mut self.spec.ask {
                    ask.mode = AskMode::Ask;
                }
            }
            Some(AskMode::ExitingToAuto) => {
                self.spec.ask = None;
                self.spec.permission_mode = Some(Self::auto_mode().into());
            }
            _ => {}
        }
    }

    fn auto_mode() -> &'static str {
        AgentSpec::headless_permission_mode(true)
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
        self.drive(&self.spec, Some(input), Translator::new(), cancel, on_event)
            .await
    }

    /// Continue the turn a deferred call paused (2026-09-16, nightshift
    /// backlog 084): the process that exited on `call` is gone, the
    /// answer is in the chat's ask directory, and this runs `-p --resume
    /// <id>` — no prompt — so the hook is asked again and the call runs or
    /// is refused. The caller has already pointed [`AgentSpec::resume`] at
    /// the session that deferred. Events stream as for any turn; the first
    /// is the deferred call's own result, paired by name from `call`.
    pub async fn resume_deferred(
        &self,
        call: &DeferredCall,
        cancel: &CancellationToken,
        on_event: &mut (dyn FnMut(TurnEvent) + Send),
    ) -> Result<AgentOutcome, AgentError> {
        self.drive(
            &self.spec,
            None,
            Translator::resuming(call),
            cancel,
            on_event,
        )
        .await
    }

    /// Answer a side question from the chat's context without adding to
    /// it (backlog 081; [`AgentSpec::aside`] has the shape and the
    /// measurements). `None` when there is no session to ask beside.
    /// Events stream as for a turn, into a caller's own sink — the chat's
    /// recorder must not see them. Nothing of the agent changes: not the
    /// session it resumes, not the model it resolved.
    pub async fn ask_aside(
        &self,
        question: &str,
        cancel: &CancellationToken,
        on_event: &mut (dyn FnMut(TurnEvent) + Send),
    ) -> Option<Result<AgentOutcome, AgentError>> {
        let spec = self.spec.aside()?;
        let input = TurnInput::from(question);
        Some(
            self.drive(&spec, Some(input), Translator::new(), cancel, on_event)
                .await,
        )
    }

    /// One CLI process, whichever shape: a prompt on argv, attachments on
    /// stdin, or a deferred resume with neither.
    async fn drive(
        &self,
        spec: &AgentSpec,
        input: Option<TurnInput>,
        mut translator: Translator,
        cancel: &CancellationToken,
        on_event: &mut (dyn FnMut(TurnEvent) + Send),
    ) -> Result<AgentOutcome, AgentError> {
        let attached = input
            .as_ref()
            .is_some_and(|i| !i.images.is_empty() || !i.documents.is_empty());
        let mut cmd = Command::new(resolve_binary(&spec.binary));
        match &input {
            Some(_) if attached => {
                cmd.args(spec.stdin_args()).stdin(Stdio::piped());
            }
            Some(input) => {
                cmd.args(spec.args(&input.text))
                    // Null rather than inherited: with a terminal on the
                    // other end the CLI waits three seconds for piped input
                    // that is never coming, on every turn.
                    .stdin(Stdio::null());
            }
            None => {
                cmd.args(spec.resume_args()).stdin(Stdio::null());
            }
        }
        cmd.current_dir(&spec.workspace)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if spec.use_subscription {
            cmd.env_remove("ANTHROPIC_API_KEY");
            cmd.env_remove("ANTHROPIC_AUTH_TOKEN");
            // Set when Nightloom itself was launched from a Claude Code
            // session; inherited they make the child think it is a nested
            // run of its own.
            cmd.env_remove("CLAUDECODE");
            cmd.env_remove("CLAUDE_CODE_ENTRYPOINT");
        }
        if !spec.auto_compact {
            // The belt to the setting's braces (`AgentSpec::auto_compact`).
            cmd.env("DISABLE_AUTO_COMPACT", "1");
        }

        let mut child = cmd.spawn().map_err(|source| AgentError::Spawn {
            binary: spec.binary.clone(),
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
        if attached
            && let Some(input) = &input
            && let Some(mut stdin) = child.stdin.take()
        {
            let line = protocol::user_line(input);
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

        // How the stop went, for the one notice the turn shows: the CLI
        // closed the turn on the interrupt, or had to be killed.
        let mut stop = "interrupted";
        if interrupted {
            // Interrupt first (2026-09-16, nightshift backlog 074), kill
            // only if that does not end the process. On the interrupt the
            // CLI closes the turn itself — the open call gets an error
            // result, the stream ends on a `result` line — and its session
            // file says the turn is over, so the next `--resume` answers
            // the next message instead of carrying on with the work that
            // was stopped (measured: `INTERRUPT_GRACE`'s doc). A kill
            // leaves neither. Everything the CLI writes on its way out is
            // translated here, into the same events as the rest of the
            // turn.
            let ended = if interrupt(&child).await {
                tokio::time::timeout(INTERRUPT_GRACE, async {
                    // Until the end of the stream (or a broken pipe): the
                    // process is on its way out either way.
                    while let Ok(Some(line)) = lines.next_line().await {
                        for event in translator.push(&line) {
                            on_event(event);
                        }
                    }
                })
                .await
                .is_ok()
            } else {
                false
            };
            if ended {
                stop = "interrupted — Claude Code ended the turn";
            } else {
                stop = "interrupted — killed after the interrupt went unanswered";
                kill_tree(&mut child).await;
                // Whatever was already buffered is still worth translating,
                // but a reader that cannot finish must not hold the turn
                // open.
                let _ = tokio::time::timeout(DRAIN_GRACE, async {
                    while let Ok(Some(line)) = lines.next_line().await {
                        for event in translator.push(&line) {
                            on_event(event);
                        }
                    }
                })
                .await;
            }
        }

        let status = child.wait().await?;
        // A killed CLI can leave a grandchild holding its stderr open —
        // the pipe's end never comes, and the tail is not worth the wait.
        let stderr = if interrupted {
            tokio::time::timeout(DRAIN_GRACE, stderr_task)
                .await
                .ok()
                .and_then(Result::ok)
                .unwrap_or_default()
        } else {
            stderr_task.await.unwrap_or_default()
        };
        let mut outcome = translator.finish();

        if interrupted {
            // The CLI's `result` on an interrupt is `is_error: true` with
            // `subtype: "error_during_execution"` (`terminal_reason:
            // "aborted_tools"` or `"aborted_streaming"`); that is the
            // stop's own record, not a failed turn — so neither the flag
            // nor the translator's "ended: …" notice for it stands, and
            // the log's stop reason stays what a kill always left it.
            outcome.is_error = false;
            outcome
                .notices
                .retain(|n| n != "ended: error_during_execution");
            outcome.notices.push(stop.into());
            return Ok(outcome);
        }
        // A non-zero exit with nothing translated is a startup failure —
        // an unknown flag, a missing binary path, an unauthenticated CLI —
        // and the stderr tail is the only thing that explains it. A run that
        // did stream is reported through the outcome instead, since the CLI
        // prints in-run failures as the result on stdout.
        if !status.success() && outcome.text.is_empty() && outcome.session_id.is_none() {
            return Err(AgentError::Failed {
                binary: spec.binary.clone(),
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

/// Ask the CLI to stop the way Ctrl-C does, and say whether it was asked.
///
/// `kill -INT <pid>` rather than `libc::kill`: the crate has no `libc`
/// dependency, and `/bin/kill` is on every Unix this runs on — the same
/// trade `kill_tree` makes with `taskkill`. `false` on Windows, where a
/// detached child has no console to receive a Ctrl-C event and the item
/// asks for no change to that platform's semantics: the caller goes
/// straight to the kill.
async fn interrupt(child: &tokio::process::Child) -> bool {
    #[cfg(unix)]
    {
        let Some(pid) = child.id() else {
            return false;
        };
        Command::new("kill")
            .args(["-INT", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .is_ok_and(|s| s.success())
    }
    #[cfg(not(unix))]
    {
        let _ = child;
        false
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
            "--forward-subagent-text",
        ] {
            assert!(a.iter().any(|x| x == flag), "missing {flag} in {a:?}");
        }
        // On every shape, the resume included: a subagent may be mid-turn
        // when a deferred call is resumed.
        assert!(
            spec()
                .stdin_args()
                .iter()
                .any(|x| x == "--forward-subagent-text")
        );
        assert!(
            spec()
                .resume_args()
                .iter()
                .any(|x| x == "--forward-subagent-text")
        );
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
        assert!(
            joined.contains("--add-dir /vault --add-dir /other"),
            "{a:?}"
        );
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

    /// An aside is the chat's own command line — model, tools, servers,
    /// prompt tool, system prompt — plus the four flags that make it a
    /// harmless throwaway on the warm cache, and minus the hook. Without a
    /// session there is no aside.
    #[test]
    fn an_aside_keeps_the_prefix_and_adds_the_throwaway_flags() {
        assert!(spec().aside().is_none(), "nothing to ask beside");
        let mut s = asking(AskMode::Plan);
        s.model = Some("opus".into());
        s.mcp_config = Some("{\"mcpServers\":{}}".into());
        s.append_system_prompt = Some("preamble".into());
        s.resume = Some("sess-3".into());
        let aside = s.aside().expect("a session to ask beside");
        let a = aside.args("what did we decide?");
        for (flag, value) in [
            ("--resume", "sess-3"),
            ("--model", "opus"),
            ("--mcp-config", "{\"mcpServers\":{}}"),
            ("--append-system-prompt", "preamble"),
            ("--permission-prompt-tool", ask::PROMPT_TOOL),
            ("--permission-mode", "dontAsk"),
            ("--max-turns", "2"),
        ] {
            let i = a
                .iter()
                .position(|x| x == flag)
                .unwrap_or_else(|| panic!("{flag} in {a:?}"));
            assert_eq!(a[i + 1], value, "{flag}");
        }
        for flag in ["--fork-session", "--no-session-persistence"] {
            assert!(a.iter().any(|x| x == flag), "{flag} in {a:?}");
        }
        // No hook: a deferral would park the aside on a prompt (the
        // settings object may still carry the chat's other switches). And
        // the tools are untouched — `--tools ""` is what goes cold.
        if let Some(i) = a.iter().position(|x| x == "--settings") {
            assert!(!a[i + 1].contains("hooks"), "{}", a[i + 1]);
        }
        assert!(!a.iter().any(|x| x == "--tools"), "{a:?}");
        let with_hook = s.args("real turn");
        let i = with_hook.iter().position(|x| x == "--settings").unwrap();
        assert!(
            with_hook[i + 1].contains("hooks"),
            "the chat itself keeps its hook"
        );
        // The chat's own spec is as it was.
        assert_eq!(s.max_turns, None);
        assert!(!s.fork_session && !s.no_session_persistence);
        assert_eq!(s.ask.as_ref().unwrap().mode, AskMode::Plan);
    }

    /// Effort and the fallback model are two flags, each only when set,
    /// passed through as spelled: the levels and the aliases are the
    /// CLI's to validate.
    #[test]
    fn effort_and_fallback_model_are_passed_through_when_set() {
        let bare = spec().args("hi");
        for flag in ["--effort", "--fallback-model"] {
            assert!(!bare.iter().any(|x| x == flag), "{flag} in {bare:?}");
        }
        let mut s = spec();
        s.effort = Some("xhigh".into());
        s.fallback_model = Some("sonnet,haiku".into());
        let a = s.args("hi");
        let i = a.iter().position(|x| x == "--effort").unwrap();
        assert_eq!(a[i + 1], "xhigh");
        let j = a.iter().position(|x| x == "--fallback-model").unwrap();
        assert_eq!(a[j + 1], "sonnet,haiku");
        // On the resume shape too: a deferred call's resume is a turn.
        assert!(s.resume_args().iter().any(|x| x == "--effort"));
    }

    /// A fork by flag rides on `--resume` and lasts one turn: asked for
    /// with nothing to resume it is refused, sent it follows the id, and
    /// once the CLI has named the fork the next turn resumes that plainly.
    #[test]
    fn a_flag_fork_follows_the_resume_id_for_one_turn() {
        let mut agent = ClaudeCodeAgent::new(spec());
        agent.fork_on_next_turn();
        assert!(!agent.spec().fork_session, "nothing to fork");
        assert!(
            !agent
                .spec()
                .args("hi")
                .iter()
                .any(|x| x == "--fork-session")
        );
        agent.set_resume(Some("parent-1".into()));
        agent.fork_on_next_turn();
        let a = agent.spec().args("hi");
        let i = a.iter().position(|x| x == "--resume").unwrap();
        assert_eq!(&a[i + 1..i + 3], ["parent-1", "--fork-session"]);
        // The CLI answers with the fork's id (measured: a new one).
        agent.follow_on(&AgentOutcome {
            session_id: Some("fork-2".into()),
            ..Default::default()
        });
        let a = agent.spec().args("next");
        assert!(a.iter().any(|x| x == "fork-2"));
        assert!(!a.iter().any(|x| x == "--fork-session"), "{a:?}");
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
        let i = a
            .iter()
            .position(|x| x == "--setting-sources")
            .expect("flag");
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
        s.ask = Some(AskSpec {
            hook: vec!["hook".into()],
            dir: PathBuf::from("/x"),
            mode: AskMode::Ask,
        });
        s.apply_mode(ChatMode::Ephemeral);
        let a = s.args("hi");
        let i = a.iter().position(|x| x == "--tools").expect("--tools");
        assert_eq!(&a[i + 1..i + 6], READ_ONLY_TOOLS);
        assert!(a.iter().any(|x| x == "--no-session-persistence"), "{a:?}");
        // No resume, no Ask: the hook is not registered on an ephemeral chat
        // (`--settings` still carries backlog 086's auto-compact switch).
        assert!(s.ask.is_none());
        let i = a.iter().position(|x| x == "--settings").unwrap();
        assert!(!a[i + 1].contains("hooks"), "{a:?}");
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

    /// The Ask position is three flags on top of everything else, and it
    /// wins over the mode the shell would otherwise send: Manual, the
    /// hook registered inline (so safe mode cannot drop it), and a prompt
    /// tool named so the question and plan tools are offered at all.
    #[test]
    fn the_ask_position_is_manual_mode_plus_the_hook_plus_a_prompt_tool() {
        let mut s = spec();
        s.permission_mode = Some("auto".into());
        s.ask = Some(AskSpec {
            hook: vec!["/app/nightloom-desktop".into(), "--permission-hook".into()],
            dir: PathBuf::from("/logs/ask/chat-1"),
            mode: AskMode::Ask,
        });
        let a = s.args("hi");
        let i = a.iter().position(|x| x == "--permission-mode").unwrap();
        assert_eq!(a[i + 1], "default");
        assert!(!a.iter().any(|x| x == "auto"), "{a:?}");
        let i = a
            .iter()
            .position(|x| x == "--settings")
            .expect("--settings");
        let v: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
        assert_eq!(
            v["hooks"]["PreToolUse"][0]["hooks"][0]["command"],
            "'/app/nightloom-desktop' '--permission-hook' '/logs/ask/chat-1'"
        );
        let i = a
            .iter()
            .position(|x| x == "--permission-prompt-tool")
            .expect("prompt tool");
        assert_eq!(a[i + 1], ask::PROMPT_TOOL);
        // And it survives safe mode beside the other flags.
        s.safe_mode = true;
        let a = s.args("hi");
        assert!(a.iter().any(|x| x == "--settings"));
        assert!(a.iter().any(|x| x == "--setting-sources"));
        // Off, none of it leaks (`--settings` still carries the
        // auto-compact switch of backlog 086, so it is checked by content).
        let bare = spec().args("hi");
        assert!(
            !bare.iter().any(|x| x == "--permission-prompt-tool"),
            "{bare:?}"
        );
        let i = bare.iter().position(|x| x == "--settings").unwrap();
        assert!(!bare[i + 1].contains("hooks"), "{bare:?}");
    }

    /// The memory switch (nightshift backlog 088): off is
    /// `autoMemoryEnabled: false` in `--settings`, and with the Ask hook
    /// on it shares the hook's JSON — one `--settings`, since the CLI keeps
    /// only the last. On sends nothing, as the CLI's default is on.
    #[test]
    fn auto_memory_off_rides_in_the_one_settings_json() {
        let mut s = spec();
        s.auto_memory = false;
        let a = s.args("hi");
        assert_eq!(a.iter().filter(|x| *x == "--settings").count(), 1);
        let i = a.iter().position(|x| x == "--settings").unwrap();
        let v: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
        assert_eq!(v["autoMemoryEnabled"], false);
        assert!(v.get("hooks").is_none());

        s.ask = Some(AskSpec {
            hook: vec!["/app/nightloom-desktop".into(), "--permission-hook".into()],
            dir: PathBuf::from("/logs/ask/chat-1"),
            mode: AskMode::Ask,
        });
        let a = s.args("hi");
        assert_eq!(a.iter().filter(|x| *x == "--settings").count(), 1, "{a:?}");
        let i = a.iter().position(|x| x == "--settings").unwrap();
        let v: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
        assert_eq!(v["autoMemoryEnabled"], false);
        assert!(v["hooks"]["PreToolUse"][0]["hooks"][0]["command"].is_string());

        // Memory on and no hook: the JSON still carries the auto-compact
        // switch (backlog 086, off on every path), and nothing else.
        let a = spec().args("hi");
        let i = a.iter().position(|x| x == "--settings").unwrap();
        let v: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
        assert_eq!(v["autoCompactEnabled"], false);
        assert!(v.get("autoMemoryEnabled").is_none());
        assert!(v.get("hooks").is_none());
        // Compaction allowed and memory on: no `--settings` at all.
        let mut s = spec();
        s.auto_compact = true;
        assert!(!s.args("hi").iter().any(|x| x == "--settings"));
    }

    /// The chat's directory is set after connect, once the chat exists,
    /// and only on a connection that is asking.
    #[test]
    fn the_ask_dir_follows_the_open_chat() {
        let mut agent = ClaudeCodeAgent::new(spec());
        agent.set_ask_dir(PathBuf::from("/logs/ask/x"));
        assert!(agent.spec().ask.is_none(), "not asking: nothing to point");
        let mut s = spec();
        s.ask = Some(AskSpec {
            hook: vec!["hook".into()],
            dir: PathBuf::from("/placeholder"),
            mode: AskMode::Ask,
        });
        let mut agent = ClaudeCodeAgent::new(s);
        agent.set_ask_dir(PathBuf::from("/logs/ask/chat-2"));
        assert_eq!(
            agent.spec().ask.as_ref().unwrap().dir,
            PathBuf::from("/logs/ask/chat-2")
        );
        let a = agent.spec().args("hi");
        let i = a.iter().position(|x| x == "--settings").unwrap();
        assert!(a[i + 1].contains("/logs/ask/chat-2"), "{}", a[i + 1]);
    }

    /// A deferred resume is `-p` with no prompt and no input format — the
    /// one shape the CLI accepts without a message — and then the same
    /// tail as every other turn, `--resume` included.
    #[test]
    fn the_resume_shape_has_no_prompt_and_carries_the_tail() {
        let mut s = spec();
        s.model = Some("haiku".into());
        s.resume = Some("sess-7".into());
        s.safe_mode = true;
        let r = s.resume_args();
        assert_eq!(r[0], "-p");
        assert_eq!(r[1], "--output-format", "nothing between -p and the tail");
        assert!(!r.iter().any(|x| x == "--input-format"), "{r:?}");
        let i = r.iter().position(|x| x == "--resume").unwrap();
        assert_eq!(r[i + 1], "sess-7");
        // Same tail as the argv shape.
        let argv = s.args("hi");
        assert_eq!(argv[2..], r[1..]);
    }

    fn asking(mode: AskMode) -> AgentSpec {
        let mut s = spec();
        s.permission_mode = Some("auto".into());
        s.ask = Some(AskSpec {
            hook: vec!["hook".into(), "--permission-hook".into()],
            dir: PathBuf::from("/logs/ask/chat-3"),
            mode,
        });
        s
    }

    fn mode_of(a: &[String]) -> String {
        let i = a.iter().position(|x| x == "--permission-mode").unwrap();
        a[i + 1].clone()
    }

    fn matcher_of(a: &[String]) -> String {
        let i = a.iter().position(|x| x == "--settings").unwrap();
        let v: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
        v["hooks"]["PreToolUse"][0]["matcher"]
            .as_str()
            .unwrap()
            .to_string()
    }

    /// The Plan position is the Ask position under `plan` mode: the same
    /// hook on the same matcher, the same prompt tool, and `plan` in
    /// place of `default` — whatever mode the shell would have sent.
    #[test]
    fn the_plan_position_is_the_ask_position_in_plan_mode() {
        let a = asking(AskMode::Plan).args("hi");
        assert_eq!(mode_of(&a), "plan");
        assert!(!a.iter().any(|x| x == "auto"), "{a:?}");
        assert_eq!(matcher_of(&a), ask::MATCHER);
        assert!(a.iter().any(|x| x == "--permission-prompt-tool"));
        let b = asking(AskMode::Ask).args("hi");
        assert_eq!(mode_of(&b), "default");
        assert_eq!(matcher_of(&b), matcher_of(&a));
        assert!(ClaudeCodeAgent::new(asking(AskMode::Plan)).planning());
        assert!(!ClaudeCodeAgent::new(asking(AskMode::Ask)).planning());
    }

    /// Approve → Ask: the resume goes out in `plan` still (the tool
    /// errors "not in plan mode" under any other, measured), and only
    /// after it does the chat become Ask.
    #[test]
    fn approving_a_plan_into_ask_keeps_plan_mode_for_the_resume_then_asks() {
        let mut agent = ClaudeCodeAgent::new(asking(AskMode::Plan));
        agent.plan_approved(PlanThen::Ask);
        let r = agent.spec().resume_args();
        assert_eq!(mode_of(&r), "plan");
        assert_eq!(matcher_of(&r), ask::MATCHER);
        agent.plan_exited();
        assert!(!agent.planning());
        let a = agent.spec().args("next");
        assert_eq!(mode_of(&a), "default");
        assert_eq!(matcher_of(&a), ask::MATCHER, "the hook stays: Ask");
    }

    /// Approve → Auto: one resume in `auto` with the hook narrowed to
    /// the plan tool — a resume with no hook at all is refused by the
    /// CLI (`tool_deferred_unavailable`, measured) — and then the Auto
    /// position proper: no hook, no prompt tool, `auto`.
    #[test]
    fn approving_a_plan_into_auto_narrows_the_hook_for_one_resume_then_drops_it() {
        let mut agent = ClaudeCodeAgent::new(asking(AskMode::Plan));
        agent.plan_approved(PlanThen::Auto);
        let r = agent.spec().resume_args();
        assert_eq!(mode_of(&r), "auto");
        assert_eq!(matcher_of(&r), "ExitPlanMode");
        assert!(r.iter().any(|x| x == "--permission-prompt-tool"), "{r:?}");
        agent.plan_exited();
        assert!(agent.spec().ask.is_none());
        let a = agent.spec().args("next");
        assert_eq!(mode_of(&a), AgentSpec::headless_permission_mode(true));
        assert!(!a.iter().any(|x| x == "--permission-prompt-tool"), "{a:?}");
        // `--settings` stays for backlog 086's auto-compact switch; the
        // hook is what must be gone.
        let i = a.iter().position(|x| x == "--settings").unwrap();
        assert!(!a[i + 1].contains("hooks"), "{a:?}");
        // Neither call does anything on a connection that is not asking,
        // nor on one in the Ask position (a plan the model entered on its
        // own): the chat stays where the rail shows it.
        let mut plain = ClaudeCodeAgent::new(spec());
        plain.plan_approved(PlanThen::Auto);
        plain.plan_exited();
        assert!(plain.spec().ask.is_none() && plain.spec().permission_mode.is_none());
        let mut asking_chat = ClaudeCodeAgent::new(asking(AskMode::Ask));
        asking_chat.plan_approved(PlanThen::Auto);
        assert_eq!(mode_of(&asking_chat.spec().resume_args()), "default");
        asking_chat.plan_exited();
        assert_eq!(mode_of(&asking_chat.spec().args("next")), "default");
    }

    /// A stand-in CLI for the stop path: announces a call, then parks. On
    /// SIGINT it does what 2.1.263 did (`m074-4-sigint-tool.jsonl`): the
    /// call's error result, the interrupt line, a `result` with
    /// `aborted_tools`, exit 0. `sleep … & wait` rather than a foreground
    /// sleep so the trap runs at once.
    #[cfg(unix)]
    fn stand_in(dir: &std::path::Path, body: &str) -> String {
        let path = dir.join("claude-stand-in");
        std::fs::write(&path, format!("#!/bin/sh\n{body}")).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.to_string_lossy().into_owned()
    }

    #[cfg(unix)]
    const ENDS_ON_INTERRUPT: &str = r##"printf '%s\n' '{"type":"system","subtype":"init","cwd":"x","tools":["Bash"],"mcp_servers":[],"model":"claude-haiku-4-5","permissionMode":"bypassPermissions","session_id":"stop-1"}'
printf '%s\n' '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_stop","name":"Bash","input":{"command":"python3 -c ..."}}]},"parent_tool_use_id":null}'
trap 'kill $child 2>/dev/null
printf "%s\n" "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"tool_result\",\"content\":\"The user doesn'"'"'t want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.\",\"is_error\":true,\"tool_use_id\":\"toolu_stop\"}]},\"parent_tool_use_id\":null}"
printf "%s\n" "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"[Request interrupted by user for tool use]\"}]},\"parent_tool_use_id\":null}"
printf "%s\n" "{\"type\":\"result\",\"subtype\":\"error_during_execution\",\"is_error\":true,\"terminal_reason\":\"aborted_tools\",\"num_turns\":3,\"session_id\":\"stop-1\",\"stop_reason\":null,\"usage\":{\"input_tokens\":0,\"output_tokens\":0}}"
exit 0' INT
sleep 30 >/dev/null 2>&1 & child=$!
wait
"##;

    /// Stop sends the interrupt first and takes what the CLI writes on
    /// its way out: the open call is closed by the CLI's own error result
    /// (not the recorder's orphan marker), the session id is on the
    /// outcome, the notice says the CLI ended the turn, and the CLI's
    /// `is_error: true` on that result is not a failed turn.
    #[cfg(unix)]
    #[tokio::test]
    async fn stop_interrupts_first_and_keeps_what_the_cli_writes_on_the_way_out() {
        let dir = std::env::temp_dir().join(format!("nightloom-stop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut s = AgentSpec::new(&dir);
        s.binary = stand_in(&dir, ENDS_ON_INTERRUPT);
        let agent = ClaudeCodeAgent::new(s);
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        let mut events = Vec::new();
        let started = std::time::Instant::now();
        let outcome = agent
            .run_turn("go", &cancel, &mut |e| {
                if matches!(e, TurnEvent::ToolCall { .. }) {
                    trigger.cancel();
                }
                events.push(e);
            })
            .await
            .unwrap();
        assert!(
            started.elapsed() < INTERRUPT_GRACE,
            "the CLI ended the turn; nothing waited for the kill"
        );
        let result = events.iter().find_map(|e| match e {
            TurnEvent::ToolResult {
                tool_use_id,
                is_error,
                content,
                ..
            } if tool_use_id == "toolu_stop" => Some((*is_error, content.clone())),
            _ => None,
        });
        let (is_error, content) = result.expect("the call's result came from the CLI");
        assert!(is_error);
        assert!(content.contains("doesn't want to proceed"), "{content}");
        assert_eq!(outcome.session_id.as_deref(), Some("stop-1"));
        assert!(!outcome.is_error, "a stop is not a failed turn");
        assert_eq!(
            outcome.notices,
            vec!["interrupted — Claude Code ended the turn".to_string()],
            "one notice, one toast"
        );
    }

    /// A CLI that ignores the interrupt is killed once the grace runs out,
    /// as before; the notice says so.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_cli_that_ignores_the_interrupt_is_killed_after_the_grace() {
        let dir = std::env::temp_dir().join(format!("nightloom-stop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut s = AgentSpec::new(&dir);
        s.binary = stand_in(
            &dir,
            "printf '%s\\n' '{\"type\":\"system\",\"subtype\":\"init\",\"cwd\":\"x\",\"tools\":[],\"mcp_servers\":[],\"model\":\"m\",\"permissionMode\":\"auto\",\"session_id\":\"stop-2\"}'\ntrap '' INT\nsleep 30 >/dev/null 2>&1 & wait\n",
        );
        let agent = ClaudeCodeAgent::new(s);
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        let started = std::time::Instant::now();
        let outcome = agent
            .run_turn("go", &cancel, &mut |e| {
                if matches!(e, TurnEvent::AgentInit { .. }) {
                    trigger.cancel();
                }
            })
            .await
            .unwrap();
        assert!(started.elapsed() >= INTERRUPT_GRACE);
        assert!(started.elapsed() < INTERRUPT_GRACE + DRAIN_GRACE + Duration::from_secs(3));
        assert!(
            outcome
                .notices
                .iter()
                .any(|n| n.starts_with("interrupted — killed")),
            "{:?}",
            outcome.notices
        );
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
