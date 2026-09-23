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
pub mod brief;
pub mod cli_session;
pub mod fork;
mod protocol;
mod record;
mod translate;

pub use ask::{
    Answer, AskDir, AskGate, DeferredCall, FolderGrant, GrantScope, PlanThen, outside_folder,
};
pub use brief::BriefSpec;
pub use protocol::{DeniedCall, RateLimitInfo};
pub use record::{Recorder, SUBAGENT_CLOSE, SUBAGENT_OPEN, carry_transcript, subagent_block};
pub use translate::{AgentOutcome, LimitHit, Translator};

use crate::{TurnEvent, TurnInput};
use nightloom_core::{ChatKind, ChatMode};
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

/// The last [`STDERR_TAIL`] bytes of `text`, cut on a character boundary:
/// a byte offset that lands inside a multi-byte character would panic the
/// reader task and lose the tail exactly when it is the only diagnosis
/// (review 2026-09-17, C).
fn stderr_tail(text: &str) -> &str {
    let mut from = text.len().saturating_sub(STDERR_TAIL);
    while from < text.len() && !text.is_char_boundary(from) {
        from += 1;
    }
    &text[from..]
}

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
    /// fills (nightshift backlog 086, 2026-09-16). **On by default — the
    /// CLI's own default — and off for a chat**, which `connect_agent`
    /// sets: there he does not compact (a compaction boundary in 2 of 610
    /// sessions), and Nightloom's own hand-off — a wrap-up into
    /// `HANDOFF.md` and a linked new chat — is what the window filling
    /// means. A dream or a capture has no window, no hand-off card and
    /// nobody watching, so for those the CLI's compaction stays as the
    /// only thing between a long pass and its prompt-too-long error
    /// (the whole-project review of 2026-09-16, F4; ~~off by default on
    /// every path — a chat, a dream, a capture~~ left them with nothing).
    /// Off is sent two ways, both read from the CLI binary (2.1.263;
    /// nightshift `notes/runner-design/086-measurements-2026-09-16.md`):
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
    /// The subagent limits (nightshift backlog 165): the CLI's own two go
    /// out as environment at spawn, Nightloom's four are written beside
    /// the brief for the Agent hook. `None` is the defaults.
    pub subagent_limits: Option<brief::SubagentLimits>,
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
    /// The subagent brief (nightshift backlog 152, 2026-09-17): a second
    /// `PreToolUse` hook, on the `Agent` tool, that prepends the chat's
    /// project instructions and engine note to every subagent's task
    /// through `updatedInput` — measured to reach the child ([`brief`]).
    /// Registered in every position, since the CLI's subagent gets none
    /// of `--append-system-prompt` in any of them; not under the Chat
    /// policy (which refuses `Agent`) and not on an aside. `None` is no
    /// brief: no preamble, or a caller that is not a chat.
    pub brief: Option<BriefSpec>,
    /// The chat is a Chat by *policy* while its declaration stays Claude
    /// Code's (nightshift backlog 144, 2026-09-17): every tool the CLI
    /// would list stays listed — narrowing the list re-writes the whole
    /// cached prefix (measured: 0 read, 23,234 written; `--disallowedTools`
    /// does the same, 31,796 written) — and a `PreToolUse` hook refuses
    /// any call outside [`READ_ONLY_TOOLS`] and Nightloom's own server
    /// instead. Registered through the one `--settings` JSON, which is not
    /// part of the request, so the next turn reads the prefix in full
    /// (31–33k read, under 1.2k written) and a refused call reaches the
    /// model as an `is_error` result carrying [`CHAT_POLICY_REASON`]
    /// (nightshift `143-report-2026-09-17.md`, steps 8–11). Set by
    /// [`apply_kind_policy`](Self::apply_kind_policy).
    pub chat_policy: bool,
    /// Fork mode (nightshift backlog 104, pass 3, 2026-09-22; blocker 288,
    /// his answer: "per-chat switch, on"). **On by default.** On, the turn
    /// carries two things: `CLAUDE_CODE_FORK_SUBAGENT=1` — in the one
    /// `--settings` JSON's `env` and in the process environment, the two
    /// spellings the survey's M2c measured together — which lets the model
    /// spawn `subagent_type: "fork"`, a subagent that starts with the whole
    /// conversation at cache-read cost (M2c: wrote 406, read 34,989, against
    /// 26,104 written for a fresh spawn); and `--agents` with the
    /// `checkpoint` roster entry ([`fork::agents_json`]), the helper that
    /// forks from the chat's checkpoint instead, which the brief hook runs
    /// ([`fork`]). Both change the Agent tool's description, so flipping
    /// the switch on a running chat re-writes its cached prefix once; on
    /// from the first turn it costs nothing more.
    pub fork_mode: bool,
    /// Passed through verbatim, last, so a caller can reach a flag this
    /// struct has not grown a field for.
    pub extra_args: Vec<String>,
}

/// The `PreToolUse` matcher for the Chat policy: everything **but** the
/// five read-only tools and Nightloom's own server. A negative lookahead
/// rather than a list of the CLI's writers, so a tool the CLI grows next
/// month is refused too — measured on 2.1.263 (step 11 of the report): the
/// CLI's matcher takes the JavaScript pattern, Bash was refused and Read
/// ran in the same turn.
///
/// `ToolSearch` added 2026-09-17 (nightshift backlog 149, measured
/// `m149/t5-policy.jsonl`): on 2.1.263 the CLI defers `WebSearch` and
/// `WebFetch` and the model loads them through `ToolSearch` first; the
/// policy refused that call, and the model recovered by calling
/// `WebSearch` directly — a wasted round and an error result in every
/// Chat that searches. `ToolSearch` loads a schema and touches nothing.
pub const CHAT_POLICY_MATCHER: &str = "^(?!(Read|Glob|Grep|WebFetch|WebSearch|ToolSearch|mcp__)).*";

/// The names [`CHAT_POLICY_MATCHER`]'s lookahead lets through — the same
/// list, as words, for narrowing the Ask hook beside it.
const CHAT_POLICY_KEPT: [&str; 7] = [
    "Read",
    "Glob",
    "Grep",
    "WebFetch",
    "WebSearch",
    "ToolSearch",
    "mcp__",
];

/// The Ask hook's matcher under the Chat policy (nightshift backlog 147):
/// the alternatives of `matcher` the policy does not refuse. The CLI runs
/// every `PreToolUse` entry that matches a call, so with both hooks on
/// `Bash` the window showed an approval prompt for a call the policy had
/// already refused — an answer that could not matter, and a turn waiting
/// on it. Narrowed, the Ask hook pauses only what a Chat may still run
/// (the web, Nightloom's own server); empty when nothing of the matcher
/// survives (the plan exit's), and then no Ask entry is registered.
fn ask_matcher_under_chat_policy(matcher: &str) -> String {
    matcher
        .split('|')
        .filter(|alt| CHAT_POLICY_KEPT.iter().any(|kept| alt.starts_with(kept)))
        .collect::<Vec<_>>()
        .join("|")
}

/// The deny hook's command line. Single-quoted for the POSIX shell the CLI
/// runs hooks through on macOS and Linux. On Windows, `cmd.exe`'s `echo`
/// prints the rest of its line verbatim and its single quotes would be
/// printed too, so the reply goes unquoted — safe because the reply has
/// none of `cmd`'s metacharacters (`&|<>^%`; pinned by a test) —
/// `inferred`, not measured on a Windows machine (backlog 147).
fn chat_policy_command(reply: &str) -> String {
    #[cfg(windows)]
    {
        format!("echo {reply}")
    }
    #[cfg(not(windows))]
    {
        format!("echo '{reply}'")
    }
}

/// What the model reads when the policy refuses a call — the hook's
/// `permissionDecisionReason`, delivered as the tool's error result.
pub const CHAT_POLICY_REASON: &str = "This chat is a Chat now: the shell, the file-editing tools, subagents and plans are withdrawn. Reads, search and the web remain.";

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
    /// *Subagents run on auto* (nightshift backlog 152, 2026-09-17): a
    /// subagent's call the hook would pause for is allowed instead when
    /// this is on, refused in words when off — never deferred, which the
    /// CLI drops at that depth ([`ask::decide`]). Written into the chat's
    /// `rules.json` each time the directory is pointed at the chat
    /// ([`ClaudeCodeAgent::set_ask_dir`]), since the hook reads only the
    /// directory. Default on (blocker 247).
    pub subagents_auto: bool,
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
            auto_compact: true,
            prompt_suggestions: false,
            resume: None,
            fork_session: false,
            max_budget_usd: None,
            subagent_limits: None,
            max_turns: None,
            use_subscription: true,
            add_dirs: Vec::new(),
            mcp_config: None,
            no_session_persistence: false,
            ask: None,
            brief: None,
            chat_policy: false,
            fork_mode: true,
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

    /// Shape the spec for a chat of `kind` (nightshift backlog 102,
    /// 2026-09-16). `Build` changes nothing. `Chat` confines the CLI to
    /// [`READ_ONLY_TOOLS`] exactly as [`apply_mode`](Self::apply_mode)
    /// does for a chat that writes nothing — the same five, the same
    /// "no tools stays no tools" — and nothing else: the folder is the
    /// caller's to choose (`workspace` is set at construction, and a Chat's
    /// is the neutral one from `prompt::chat_dir`), and the Chat
    /// instructions travel in the prompt. Narrows, never widens, so the
    /// order it is applied in relative to `apply_mode` does not matter.
    pub fn apply_kind(&mut self, kind: ChatKind) {
        if kind != ChatKind::Chat {
            return;
        }
        match &self.tools {
            Some(t) if t.is_empty() => {}
            _ => {
                self.tools = Some(READ_ONLY_TOOLS.iter().map(|t| (*t).to_string()).collect());
            }
        }
    }

    /// The policy half of a kind (nightshift backlog 144): `kind` is what
    /// the chat may do now, `declared` what its declaration was built for
    /// ([`apply_kind`](Self::apply_kind) with `Session::declared_kind`).
    /// A Chat over a Claude Code declaration gets the refusing hook
    /// ([`chat_policy`](Self::chat_policy)); every other pairing changes
    /// nothing — a Chat declared as a Chat has nothing to refuse, and a
    /// Claude Code chat has nothing withdrawn.
    pub fn apply_kind_policy(&mut self, kind: ChatKind, declared: ChatKind) {
        self.chat_policy = kind == ChatKind::Chat && declared == ChatKind::Build;
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
        // No brief either: the aside is one question on the warm cache,
        // and its settings carry no hook (the test below pins that).
        spec.brief = None;
        Some(spec)
    }

    /// The spec for a **checkpoint fork** (nightshift backlog 104, pass 3;
    /// the module doc of [`fork`] has the design): a second CLI process on
    /// the chat's session, forked (`--fork-session`) from a chosen message
    /// — the hook appends `--resume-session-at <uuid>` — that does a
    /// helper's long task and reports. `None` without a session to fork or
    /// with fork mode off.
    ///
    /// Everything that shapes the cached prefix stays as the chat has it,
    /// as for an aside: the fork exists to read the checkpoint's prefix
    /// from the cache, not to re-write it. What differs: the fork keeps no
    /// session file of its own (its report is the deliverable); under Ask
    /// or Plan it runs as an aside does — `dontAsk`, no Ask hook — since a
    /// deferral from a side process would park it on a card nobody's turn
    /// is waiting for; the brief hook stays, so its calls are judged by the
    /// message's budget and its own spawns by the caps; `--max-turns` is
    /// left to the budget.
    pub fn checkpoint_fork(&self) -> Option<AgentSpec> {
        self.resume.as_ref()?;
        if !self.fork_mode {
            return None;
        }
        let mut spec = self.clone();
        spec.fork_session = true;
        spec.no_session_persistence = true;
        if let Some(ask) = &mut spec.ask {
            ask.mode = AskMode::Aside;
            spec.permission_mode = Some("dontAsk".into());
        }
        Some(spec)
    }

    /// The checkpoint fork's command line, written beside the brief for
    /// the hook ([`fork::ForkSpec`]): `-p ""` in front for the task, the
    /// environment the turn runs with. The uuid is not here — the hook
    /// reads the checkpoint file and appends `--resume-session-at`.
    pub fn fork_spec(&self) -> Option<fork::ForkSpec> {
        let spec = self.checkpoint_fork()?;
        Some(fork::ForkSpec {
            binary: spec.binary.clone(),
            workspace: spec.workspace.clone(),
            argv: spec.argv(Shape::Prompt("")),
            env: spec
                .env_set()
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect(),
            env_remove: spec.env_removed().iter().map(|k| k.to_string()).collect(),
        })
    }

    /// The variables a turn's process is given, beyond what it inherits
    /// ([`Self::env_removed`] is the other half). Shared by [`ClaudeCodeAgent::drive`]
    /// and the fork's spec, so the two processes run alike.
    pub fn env_set(&self) -> Vec<(&'static str, String)> {
        let mut env: Vec<(&'static str, String)> = Vec::new();
        if !self.auto_compact {
            // The belt to the setting's braces (`AgentSpec::auto_compact`).
            env.push(("DISABLE_AUTO_COMPACT", "1".into()));
        }
        // The CLI's own subagent limits (backlog 165): concurrency and
        // nesting depth are environment, read by the CLI at each spawn.
        env.extend(self.subagent_limits.unwrap_or_default().env());
        if self.fork_mode {
            // Fork subagents (backlog 104): the environment spelling beside
            // the `--settings` one, as the survey's M2c ran it.
            env.push(("CLAUDE_CODE_FORK_SUBAGENT", "1".into()));
        }
        env
    }

    /// The variables kept out of a turn's process.
    pub fn env_removed(&self) -> &'static [&'static str] {
        if self.use_subscription {
            // Claude Code prefers an API key over the subscription whenever
            // one is set, silently. `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT`
            // are set when Nightloom itself was launched from a Claude Code
            // session; inherited they make the child think it is a nested
            // run of its own.
            &[
                "ANTHROPIC_API_KEY",
                "ANTHROPIC_AUTH_TOKEN",
                "CLAUDECODE",
                "CLAUDE_CODE_ENTRYPOINT",
            ]
        } else {
            &[]
        }
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
            // Under the Chat policy the Ask hook pauses only what the
            // policy leaves (backlog 147): a call both hooks match would
            // show a prompt whose answer cannot matter.
            let matcher = if self.chat_policy {
                ask_matcher_under_chat_policy(ask.mode.matcher())
            } else {
                ask.mode.matcher().to_string()
            };
            if ask.mode != AskMode::Aside
                && !matcher.is_empty()
                && let Ok(serde_json::Value::Object(hook)) = serde_json::from_str::<serde_json::Value>(
                    &ask::settings_json_matching(&ask.hook, &ask.dir, &matcher),
                )
            {
                settings.extend(hook);
            }
            a.push("--permission-prompt-tool".into());
            a.push(ask::PROMPT_TOOL.into());
        }
        if self.chat_policy {
            // A second `PreToolUse` entry beside the Ask hook's, in the same
            // array — the CLI runs every matching entry, and a deny from
            // any of them stands. The command is an `echo` of the reply,
            // so no program of Nightloom's has to be found for it to work.
            let reply = serde_json::json!({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": CHAT_POLICY_REASON,
                }
            })
            .to_string();
            let entry = serde_json::json!({
                "matcher": CHAT_POLICY_MATCHER,
                "hooks": [{ "type": "command", "command": chat_policy_command(&reply) }]
            });
            let hooks = settings
                .entry("hooks")
                .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
            if let serde_json::Value::Object(hooks) = hooks {
                let pre = hooks
                    .entry("PreToolUse")
                    .or_insert_with(|| serde_json::Value::Array(Vec::new()));
                if let serde_json::Value::Array(pre) = pre {
                    pre.push(entry);
                }
            }
        }
        // The subagent brief's hook (backlog 152), a third `PreToolUse`
        // entry in the same array. ~~On `Agent|Task` alone: every position
        // but the Chat policy's (which refuses the call)~~ — since pass 2
        // of backlog 165 (2026-09-22) the entry matches every tool and is
        // registered in every position, the Chat policy's and a council
        // seat's included: the same hook enforces the message's budget on
        // each call, and only a spawn goes on to the brief (which the
        // policy's own deny still wins over, backlog 147's measurement).
        if let Some(brief) = &self.brief
            && !brief.dir.as_os_str().is_empty()
        {
            let hooks = settings
                .entry("hooks")
                .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
            if let serde_json::Value::Object(hooks) = hooks {
                let pre = hooks
                    .entry("PreToolUse")
                    .or_insert_with(|| serde_json::Value::Array(Vec::new()));
                if let serde_json::Value::Array(pre) = pre {
                    pre.push(brief::hook_entry(&brief.hook, &brief.dir));
                }
            }
        }
        if !self.auto_memory {
            settings.insert("autoMemoryEnabled".into(), serde_json::Value::Bool(false));
        }
        if !self.auto_compact {
            settings.insert("autoCompactEnabled".into(), serde_json::Value::Bool(false));
        }
        if self.fork_mode {
            // Fork mode (backlog 104): the settings spelling of the switch,
            // in the same one JSON, beside the environment spelling
            // (`env_set`) — the survey's M2c ran both and got the fork.
            settings.insert(
                "env".into(),
                serde_json::json!({ "CLAUDE_CODE_FORK_SUBAGENT": "1" }),
            );
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
        if self.fork_mode {
            // The checkpoint helper's roster entry (backlog 104): a flag,
            // not a settings source, so it stands under safe mode's empty
            // `--setting-sources` too (measured in the pass-3 report).
            a.push("--agents".into());
            a.push(fork::agents_json());
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
    /// A call a Stop left pending, refused on disk for the next turn's hook
    /// to deliver, with the session it is pending in (the whole-project
    /// review of 2026-09-16, F1). The next turn that resumes that session
    /// opens with the refusal as its first line — a `tool_result` for a
    /// call its process never announced — so its translator is seeded
    /// from this, as a resume's is, and the result renders under the
    /// call's own name rather than `unknown`. Cleared by [`Self::follow_on`]
    /// once a turn has landed. (The log side is the recorder's: it drops a
    /// result for a call the turn never opened.)
    refused: Option<(String, DeferredCall)>,
}

impl ClaudeCodeAgent {
    pub fn new(spec: AgentSpec) -> Self {
        Self {
            spec,
            resolved: None,
            refused: None,
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
        // Not under `--no-session-persistence`: the CLI names a session id
        // for that turn too, but saved nothing under it, and resuming it
        // ends the next turn with `error_during_execution` — every second
        // message of an ephemeral chat (his report, 2026-09-17). There the
        // replay in the message is the conversation, and `resume` stays as
        // it was (`None` for an ephemeral chat).
        if let Some(id) = outcome
            .session_id
            .as_ref()
            .filter(|_| !self.spec.no_session_persistence)
        {
            self.spec.resume = Some(id.clone());
            self.spec.fork_session = false;
        }
        if let Some(model) = &outcome.model {
            self.resolved = Some(model.clone());
        }
        // A turn has landed: the refusal it opened with, if any, is delivered.
        self.refused = None;
    }

    /// Remember a deferred call the shell refused on disk without running
    /// it (a Stop while the prompt was up), pending in `session`: the next
    /// turn resuming that session opens with its result (see the field).
    /// Nothing to remember without a session to resume.
    pub fn note_refused(&mut self, session: Option<&str>, call: DeferredCall) {
        self.refused = session.map(|s| (s.to_string(), call));
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

    /// Let every later process of this connection read `dir` — the card's
    /// *Allow, and this folder…* (nightshift backlog 143, pass 2), taken
    /// mid-turn so the resume that carries the allow already has it
    /// (measured 2026-09-17: a `--resume … --add-dir` reads the folder
    /// with no second prompt). Once; a folder already granted is not
    /// sent twice. The shell rebuilds `add_dirs` from the project and the
    /// log at every connect, so this holds until then and the record
    /// takes over.
    pub fn grant_dir(&mut self, dir: PathBuf) {
        if !self.spec.add_dirs.contains(&dir) {
            self.spec.add_dirs.push(dir);
        }
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
    ///
    /// Also writes the *Subagents run on auto* switch into the chat's
    /// rules there (backlog 152): the hook is another process and reads
    /// only the directory, so the rail's position has to be on disk
    /// before the turn's first subagent call. Best-effort — a directory
    /// that cannot be written (a test's placeholder path) leaves the
    /// file as it was, and an absent field reads as the default.
    ///
    /// The subagent brief's file goes to the same directory (backlog 152)
    /// — in every position, since a subagent gets no preamble in any of
    /// them — written only when it changed.
    pub fn set_ask_dir(&mut self, dir: PathBuf) {
        if let Some(ask) = &mut self.spec.ask {
            ask.dir = dir.clone();
            let _ = AskDir::new(&ask.dir).set_subagents_auto(ask.subagents_auto);
        }
        if let Some(brief) = &mut self.spec.brief {
            brief.dir = dir;
            let _ = brief::write(&brief.dir, &brief.text);
            // The limits beside it, for the hook (backlog 165).
            let _ = brief::write_limits(&brief.dir, &self.spec.subagent_limits.unwrap_or_default());
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
        // A fresh turn, a fresh spawn count for the Agent hook's cap —
        // and, since pass 2 of backlog 165, the message's budget ledger
        // started from the window reading on hand (or continued, for the
        // chair of a council whose seats just ran).
        if let Some(brief) = &self.spec.brief {
            brief::begin_turn(
                &brief.dir,
                &self.spec.subagent_limits.unwrap_or_default(),
                brief::TurnPhase::Turn,
            );
        }
        let mut translator = match &self.refused {
            Some((session, call)) if self.spec.resume.as_deref() == Some(session) => {
                Translator::resuming(call)
            }
            _ => Translator::new(),
        };
        // The window as each `rate_limit_event` reports it, written beside
        // the brief for the Agent hook's usage-aware cap (backlog 165).
        if let Some(brief) = &self.spec.brief
            && !brief.dir.as_os_str().is_empty()
        {
            translator.usage_sink = Some(brief.dir.clone());
        }
        self.drive(&self.spec, Some(input), translator, cancel, on_event)
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

    /// One turn under a spec the caller shaped — a council seat
    /// (`council::seat_spec`; nightshift backlog 149, 2026-09-17): the
    /// chat's spec re-pointed at another model, forked from the chat's
    /// session, its events into the caller's own sink. Nothing of the
    /// agent changes, as for an aside; `&self` is read only, so N of
    /// these run at once over one agent.
    pub async fn run_with(
        &self,
        spec: &AgentSpec,
        input: impl Into<TurnInput>,
        cancel: &CancellationToken,
        on_event: &mut (dyn FnMut(TurnEvent) + Send),
    ) -> Result<AgentOutcome, AgentError> {
        self.drive(
            spec,
            Some(input.into()),
            Translator::new(),
            cancel,
            on_event,
        )
        .await
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
        // The environment, spelled once for this process and for the
        // checkpoint fork's (`AgentSpec::env_removed` / `env_set`, backlog
        // 104): the key kept out so the subscription is what pays, the
        // compaction switch, the CLI's own subagent limits, fork mode.
        for k in spec.env_removed() {
            cmd.env_remove(k);
        }
        for (k, v) in spec.env_set() {
            cmd.env(k, v);
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
            stderr_tail(&text).to_string()
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

    /// An ephemeral chat's turn names a session id but saved nothing under
    /// it: `follow_on` must not adopt it, or the next turn resumes a
    /// session that does not exist.
    #[test]
    fn follow_on_does_not_adopt_an_unsaved_session() {
        let mut s = spec();
        s.no_session_persistence = true;
        let mut agent = ClaudeCodeAgent::new(s);
        let outcome = AgentOutcome {
            session_id: Some("unsaved".into()),
            ..Default::default()
        };
        agent.follow_on(&outcome);
        assert_eq!(agent.spec().resume, None);
        let mut agent = ClaudeCodeAgent::new(spec());
        agent.follow_on(&outcome);
        assert_eq!(agent.spec().resume.as_deref(), Some("unsaved"));
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

    /// The card's grant (backlog 143, pass 2): a folder granted mid-turn is
    /// on the very next argv — the resume's — once, however often it is
    /// granted.
    #[test]
    fn a_granted_dir_is_on_the_next_argv_once() {
        let mut s = AgentSpec::new(PathBuf::from("/w"));
        s.add_dirs = vec![PathBuf::from("/vault")];
        let mut agent = ClaudeCodeAgent::new(s);
        agent.grant_dir(PathBuf::from("/elsewhere"));
        agent.grant_dir(PathBuf::from("/elsewhere"));
        agent.grant_dir(PathBuf::from("/vault"));
        let a = agent.spec.resume_args();
        let joined = a.join(" ");
        assert!(
            joined.contains("--add-dir /vault --add-dir /elsewhere"),
            "{a:?}"
        );
        assert_eq!(joined.matches("--add-dir").count(), 2, "{a:?}");
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
    /// A Chat (nightshift backlog 102) gets the same five read-only tools
    /// an incognito chat does, keeps "no tools" as no tools, and a Build
    /// chat is untouched; the folder is not the method's business.
    #[test]
    fn a_chat_kind_narrows_to_the_read_only_tools_and_build_changes_nothing() {
        let mut s = spec();
        s.apply_kind(ChatKind::Build);
        assert!(!s.args("hi").iter().any(|x| x == "--tools"));

        s.apply_kind(ChatKind::Chat);
        let a = s.args("hi");
        let i = a.iter().position(|x| x == "--tools").expect("--tools");
        assert_eq!(&a[i + 1..i + 6], READ_ONLY_TOOLS);
        assert_eq!(s.workspace, spec().workspace);

        let mut none = spec();
        none.tools = Some(Vec::new());
        none.apply_kind(ChatKind::Chat);
        assert_eq!(none.tools.as_deref(), Some(&[][..]));
    }

    /// The policy half of a kind (nightshift backlog 144): a Chat over a
    /// Claude Code declaration leaves `--tools` alone and registers the
    /// refusing hook in the one `--settings` JSON — beside the Ask hook's
    /// entry when there is one, never a second `--settings` — with the
    /// lookahead matcher and the reason the model reads. Every other
    /// pairing registers nothing.
    #[test]
    fn a_chat_over_a_build_declaration_is_a_deny_hook_not_a_narrower_tool_list() {
        let mut s = spec();
        s.apply_kind(ChatKind::Build);
        s.apply_kind_policy(ChatKind::Chat, ChatKind::Build);
        assert!(s.chat_policy);
        let a = s.args("hi");
        assert!(!a.iter().any(|x| x == "--tools"), "{a:?}");
        assert!(!a.iter().any(|x| x == "--disallowedTools"), "{a:?}");
        assert_eq!(a.iter().filter(|x| *x == "--settings").count(), 1);
        let i = a.iter().position(|x| x == "--settings").unwrap();
        let v: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
        let pre = v["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(pre.len(), 1);
        assert_eq!(pre[0]["matcher"], CHAT_POLICY_MATCHER);
        let command = pre[0]["hooks"][0]["command"].as_str().unwrap();
        assert!(command.starts_with("echo "), "{command}");
        let reply: serde_json::Value = serde_json::from_str(
            command
                .trim_start_matches("echo ")
                .trim_start_matches('\'')
                .trim_end_matches('\''),
        )
        .unwrap();
        assert_eq!(reply["hookSpecificOutput"]["permissionDecision"], "deny");
        assert_eq!(
            reply["hookSpecificOutput"]["permissionDecisionReason"],
            CHAT_POLICY_REASON
        );

        // Beside the Ask hook: two entries in one array, one `--settings`.
        s.ask = Some(AskSpec {
            hook: vec!["/app/nightloom-desktop".into(), "--permission-hook".into()],
            dir: PathBuf::from("/logs/ask/chat-1"),
            mode: AskMode::Ask,
            subagents_auto: true,
        });
        s.auto_memory = false;
        let a = s.args("hi");
        assert_eq!(a.iter().filter(|x| *x == "--settings").count(), 1);
        let i = a.iter().position(|x| x == "--settings").unwrap();
        let v: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
        let pre = v["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(pre.len(), 2, "{v}");
        // Narrowed beside the policy (backlog 147): see the next test.
        assert_eq!(
            pre[0]["matcher"],
            ask_matcher_under_chat_policy(ask::MATCHER)
        );
        assert_eq!(pre[1]["matcher"], CHAT_POLICY_MATCHER);
        assert_eq!(v["autoMemoryEnabled"], false);

        // The other pairings: nothing to refuse.
        for (kind, declared) in [
            (ChatKind::Build, ChatKind::Build),
            (ChatKind::Chat, ChatKind::Chat),
            (ChatKind::Build, ChatKind::Chat),
        ] {
            let mut s = spec();
            // Fork mode's own `env` entry aside (backlog 104), which rides
            // the same JSON: off here so the policy is what is tested.
            s.fork_mode = false;
            s.apply_kind_policy(kind, declared);
            assert!(!s.chat_policy, "{kind:?} over {declared:?}");
            assert!(!s.args("hi").iter().any(|x| x == "--settings"));
        }
        // The matcher itself is JavaScript's (a negative lookahead the
        // `regex` crate cannot compile); the CLI was measured reading it —
        // Bash refused, Read run, in one turn (the report's step 11).
    }

    /// Under the Chat policy the Ask hook no longer names a withdrawn
    /// tool (nightshift backlog 147): the CLI runs every matching entry,
    /// so a `Bash` both hooks matched would raise a prompt the policy's
    /// deny had already settled. The plan exit's matcher, all withdrawn,
    /// registers no Ask entry at all. And the deny's echo carries nothing
    /// `cmd.exe` would read as its own, so the unquoted Windows form holds.
    #[test]
    fn under_the_chat_policy_the_ask_hook_names_only_what_the_policy_leaves() {
        let narrowed = ask_matcher_under_chat_policy(ask::MATCHER);
        assert_eq!(narrowed, "WebFetch|WebSearch|mcp__.*");
        for withdrawn in [
            "Bash",
            "Write",
            "Edit",
            "MultiEdit",
            "NotebookEdit",
            "ExitPlanMode",
        ] {
            assert!(!narrowed.split('|').any(|t| t == withdrawn), "{withdrawn}");
        }
        assert_eq!(ask_matcher_under_chat_policy(ask::EXIT_PLAN_MATCHER), "");

        let mut s = spec();
        s.apply_kind(ChatKind::Build);
        s.apply_kind_policy(ChatKind::Chat, ChatKind::Build);
        s.ask = Some(AskSpec {
            hook: vec!["/app/nightloom-desktop".into(), "--permission-hook".into()],
            dir: PathBuf::from("/logs/ask/chat-1"),
            mode: AskMode::Ask,
            subagents_auto: true,
        });
        let a = s.args("hi");
        let i = a.iter().position(|x| x == "--settings").unwrap();
        let v: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
        let pre = v["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(pre.len(), 2, "{v}");
        assert_eq!(pre[0]["matcher"], "WebFetch|WebSearch|mcp__.*");
        assert_eq!(pre[1]["matcher"], CHAT_POLICY_MATCHER);
        // The one resume that leaves plan mode: only the deny is registered.
        s.ask.as_mut().unwrap().mode = AskMode::ExitingToAuto;
        let a = s.args("hi");
        let i = a.iter().position(|x| x == "--settings").unwrap();
        let v: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
        let pre = v["hooks"]["PreToolUse"].as_array().unwrap();
        assert_eq!(pre.len(), 1, "{v}");
        assert_eq!(pre[0]["matcher"], CHAT_POLICY_MATCHER);
        // Without the policy, the matcher is untouched.
        let mut plain = spec();
        plain.ask = s.ask.clone();
        plain.ask.as_mut().unwrap().mode = AskMode::Ask;
        assert_eq!(matcher_of(&plain.args("hi")), ask::MATCHER);

        let command = pre[0]["hooks"][0]["command"].as_str().unwrap();
        let reply = command.trim_start_matches("echo ").trim_matches('\'');
        assert!(
            !reply.contains(['&', '|', '<', '>', '^', '%']),
            "cmd.exe would read one of these as its own: {reply}"
        );
        assert!(!reply.contains('\''), "{reply}");
    }

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
            subagents_auto: true,
        });
        s.apply_mode(ChatMode::Ephemeral);
        let a = s.args("hi");
        let i = a.iter().position(|x| x == "--tools").expect("--tools");
        assert_eq!(&a[i + 1..i + 6], READ_ONLY_TOOLS);
        assert!(a.iter().any(|x| x == "--no-session-persistence"), "{a:?}");
        // No resume, no Ask: the hook is not registered on an ephemeral chat
        // (a `--settings` JSON, when a chat's auto-compact switch puts one
        // there, must not carry it either).
        assert!(s.ask.is_none());
        assert!(!a.iter().any(|x| x.contains("hooks")), "{a:?}");
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
            subagents_auto: true,
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
        // Off, none of it leaks — checked by content, since a chat's
        // auto-compact switch (backlog 086) may put a `--settings` there.
        let bare = spec().args("hi");
        assert!(
            !bare.iter().any(|x| x == "--permission-prompt-tool"),
            "{bare:?}"
        );
        assert!(!bare.iter().any(|x| x.contains("hooks")), "{bare:?}");
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
            subagents_auto: true,
        });
        let a = s.args("hi");
        assert_eq!(a.iter().filter(|x| *x == "--settings").count(), 1, "{a:?}");
        let i = a.iter().position(|x| x == "--settings").unwrap();
        let v: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
        assert_eq!(v["autoMemoryEnabled"], false);
        assert!(v["hooks"]["PreToolUse"][0]["hooks"][0]["command"].is_string());

        // Memory on, no hook, compaction off (a chat's shape, backlog 086):
        // the JSON carries the auto-compact switch and nothing else.
        let mut s = spec();
        s.auto_compact = false;
        let a = s.args("hi");
        let i = a.iter().position(|x| x == "--settings").unwrap();
        let v: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
        assert_eq!(v["autoCompactEnabled"], false);
        assert!(v.get("autoMemoryEnabled").is_none());
        assert!(v.get("hooks").is_none());
        // The default — a dream's or a capture's shape (review F4,
        // 2026-09-16) — leaves compaction to the CLI: no `--settings` at all.
        assert!(spec().auto_compact);
        // — once fork mode's `env` entry (backlog 104), which is on by
        // default and rides the same JSON, is off.
        let mut plain = spec();
        plain.fork_mode = false;
        assert!(!plain.args("hi").iter().any(|x| x == "--settings"));
    }

    /// Fork mode (backlog 104, pass 3): on by default, it puts
    /// `CLAUDE_CODE_FORK_SUBAGENT=1` in the one `--settings` JSON's `env`
    /// and in the process environment, and the `checkpoint` roster entry
    /// on `--agents`; off, none of the three. The checkpoint fork's spec
    /// keeps the prefix (model, tools, MCP, prompt, roster), forks the
    /// session with no file of its own, runs as an aside under Ask, and
    /// its written command line has the task slot empty and no uuid.
    #[test]
    fn fork_mode_rides_the_settings_env_and_the_agents_roster() {
        let on = spec();
        assert!(on.fork_mode);
        let a = on.args("hi");
        let i = a.iter().position(|x| x == "--settings").unwrap();
        let v: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
        assert_eq!(v["env"]["CLAUDE_CODE_FORK_SUBAGENT"], "1");
        let j = a.iter().position(|x| x == "--agents").unwrap();
        let roster: serde_json::Value = serde_json::from_str(&a[j + 1]).unwrap();
        assert!(roster[fork::CHECKPOINT_AGENT]["description"].is_string());
        assert!(
            on.env_set()
                .iter()
                .any(|(k, v)| *k == "CLAUDE_CODE_FORK_SUBAGENT" && v == "1")
        );
        let mut off = spec();
        off.fork_mode = false;
        let a = off.args("hi");
        assert!(!a.iter().any(|x| x == "--agents"), "{a:?}");
        assert!(!a.iter().any(|x| x == "--settings"), "{a:?}");
        assert!(
            !off.env_set()
                .iter()
                .any(|(k, _)| *k == "CLAUDE_CODE_FORK_SUBAGENT")
        );
        // The removed keys are the subscription's guard, on both paths.
        assert!(on.env_removed().contains(&"ANTHROPIC_API_KEY"));

        // No session, no fork; fork mode off, no fork.
        assert!(spec().checkpoint_fork().is_none());
        let mut s = asking(AskMode::Ask);
        s.resume = Some("sess-3".into());
        s.model = Some("opus".into());
        s.fork_mode = false;
        assert!(s.checkpoint_fork().is_none());
        s.fork_mode = true;
        s.brief = Some(BriefSpec {
            hook: vec!["hook".into()],
            dir: PathBuf::from("/chat"),
            text: "brief".into(),
        });
        let f = s.checkpoint_fork().unwrap();
        assert!(f.fork_session && f.no_session_persistence);
        assert_eq!(f.ask.as_ref().unwrap().mode, AskMode::Aside);
        assert!(f.brief.is_some(), "the budget hook rides in the fork");
        assert_eq!(f.max_turns, None);
        let fa = f.args("task");
        for (flag, value) in [
            ("--resume", "sess-3"),
            ("--model", "opus"),
            ("--permission-mode", "dontAsk"),
            ("--permission-prompt-tool", ask::PROMPT_TOOL),
        ] {
            let i = fa.iter().position(|x| x == flag).unwrap();
            assert_eq!(fa[i + 1], value, "{flag}");
        }
        assert!(fa.iter().any(|x| x == "--fork-session"));
        assert!(fa.iter().any(|x| x == "--agents"), "the roster stays");
        assert!(
            !fa.iter().any(|x| x == "--resume-session-at"),
            "the hook adds the uuid"
        );
        // The chat's own spec is as it was.
        assert!(!s.fork_session && !s.no_session_persistence);
        assert_eq!(s.ask.as_ref().unwrap().mode, AskMode::Ask);

        let fs = s.fork_spec().unwrap();
        assert_eq!(&fs.argv[..2], ["-p", ""]);
        assert_eq!(fs.workspace, s.workspace);
        assert!(fs.env.iter().any(|(k, _)| k == "CLAUDE_CODE_FORK_SUBAGENT"));
        assert!(fs.env_remove.iter().any(|k| k == "ANTHROPIC_API_KEY"));
    }

    /// A call refused by a Stop is remembered against its session until a
    /// turn lands (review F1, 2026-09-16); without a session there is no
    /// resume to deliver it on, so nothing is kept.
    #[test]
    fn a_refused_call_is_kept_for_the_next_turn_and_cleared_when_one_lands() {
        let mut agent = ClaudeCodeAgent::new(spec());
        let call = DeferredCall {
            id: "toolu_1".into(),
            name: "Edit".into(),
            input: serde_json::json!({}),
        };
        agent.note_refused(None, call.clone());
        assert!(
            agent.refused.is_none(),
            "no session: nothing to deliver it on"
        );
        agent.note_refused(Some("sess-1"), call.clone());
        assert_eq!(
            agent.refused.as_ref().map(|(s, c)| (s.as_str(), &c.id)),
            Some(("sess-1", &call.id))
        );
        agent.follow_on(&AgentOutcome {
            session_id: Some("sess-1".into()),
            ..AgentOutcome::default()
        });
        assert!(
            agent.refused.is_none(),
            "delivered with the turn that landed"
        );
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
            subagents_auto: true,
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

    /// The subagent brief's hook (backlog 152) is a `PreToolUse` entry on
    /// `Agent|Task` in the one `--settings` JSON: registered in the Auto
    /// position (no Ask hook) and beside the Ask hook's entry alike, only
    /// once the shell has pointed it at the chat's directory, never under
    /// the Chat policy, never on an aside; and pointing it writes the
    /// brief file.
    #[test]
    fn the_brief_hook_rides_every_position_but_the_chat_policy_and_asides() {
        let dir = std::env::temp_dir().join(format!("nightloom-152b-{}", uuid::Uuid::new_v4()));
        let brief = BriefSpec {
            hook: vec!["hook".into(), "--subagent-hook".into()],
            dir: PathBuf::new(),
            text: "<nightloom-subagent-brief>\nx\n</nightloom-subagent-brief>".into(),
        };
        let entries = |a: &[String]| -> Vec<serde_json::Value> {
            let Some(i) = a.iter().position(|x| x == "--settings") else {
                return Vec::new();
            };
            let v: serde_json::Value = serde_json::from_str(&a[i + 1]).unwrap();
            v["hooks"]["PreToolUse"]
                .as_array()
                .cloned()
                .unwrap_or_default()
        };
        let brief_entries = |a: &[String]| {
            entries(a)
                .into_iter()
                .filter(|e| e["matcher"] == brief::BRIEF_MATCHER)
                .count()
        };
        // Auto position, brief set but not yet pointed: nothing registered.
        let mut s = spec();
        s.permission_mode = Some("auto".into());
        s.brief = Some(brief.clone());
        assert_eq!(brief_entries(&s.args("hi")), 0);
        // Pointed: one entry, the command quoted, and the file written.
        let mut agent = ClaudeCodeAgent::new(s);
        agent.set_ask_dir(dir.clone());
        assert_eq!(
            std::fs::read_to_string(dir.join(brief::BRIEF_FILE)).unwrap(),
            brief.text
        );
        let a = agent.spec().args("hi");
        assert_eq!(brief_entries(&a), 1);
        assert_eq!(entries(&a).len(), 1, "no Ask hook in Auto");
        let cmd = entries(&a)[0]["hooks"][0]["command"].clone();
        assert_eq!(cmd, format!("'hook' '--subagent-hook' '{}'", dir.display()));
        // Ask position: beside the Ask hook's entry, the Ask one first.
        let mut s = asking(AskMode::Ask);
        s.brief = Some(brief.clone());
        let mut agent = ClaudeCodeAgent::new(s);
        agent.set_ask_dir(dir.clone());
        let a = agent.spec().args("hi");
        let e = entries(&a);
        assert_eq!(e.len(), 2, "{e:?}");
        assert_eq!(e[0]["matcher"], ask::MATCHER);
        assert_eq!(e[1]["matcher"], brief::BRIEF_MATCHER);
        // The aside of that chat carries no hook at all.
        let mut s = asking(AskMode::Ask);
        s.brief = Some(brief.clone());
        s.resume = Some("sid".into());
        let aside = s.aside().unwrap();
        assert!(aside.brief.is_none());
        // ~~Under the Chat policy the entry is withheld~~ — since pass 2
        // of backlog 165 it rides there too, beside the policy's own: the
        // hook is the budget's on every tool, and the policy's deny on
        // `Agent` still wins (backlog 147's measurement).
        let mut s = spec();
        s.chat_policy = true;
        s.brief = Some(BriefSpec {
            dir: dir.clone(),
            ..brief.clone()
        });
        let a = s.args("hi");
        assert_eq!(brief_entries(&a), 1);
        assert_eq!(
            entries(&a).len(),
            2,
            "the policy's own entry and the budget's"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Pointing the ask directory at a chat writes the *Subagents run on
    /// auto* switch into its rules (backlog 152), so the hook — another
    /// process — reads the rail's position; and flipping it rewrites.
    #[test]
    fn the_ask_dir_carries_the_subagent_switch() {
        let dir = std::env::temp_dir().join(format!("nightloom-152-{}", uuid::Uuid::new_v4()));
        let mut s = spec();
        s.ask = Some(AskSpec {
            hook: vec!["hook".into()],
            dir: PathBuf::from("/placeholder"),
            mode: AskMode::Ask,
            subagents_auto: false,
        });
        let mut agent = ClaudeCodeAgent::new(s);
        agent.set_ask_dir(dir.clone());
        assert!(!AskDir::new(&dir).subagents_auto());
        agent.spec.ask.as_mut().unwrap().subagents_auto = true;
        agent.set_ask_dir(dir.clone());
        assert!(AskDir::new(&dir).subagents_auto());
        let _ = std::fs::remove_dir_all(&dir);
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
            subagents_auto: true,
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
        // A `--settings` may stay for a chat's auto-compact switch
        // (backlog 086); the hook is what must be gone.
        assert!(!a.iter().any(|x| x.contains("hooks")), "{a:?}");
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
    fn the_stderr_tail_is_cut_on_a_char_boundary() {
        let short = "plain";
        assert_eq!(stderr_tail(short), short);
        // `—` is three bytes; place it so the byte cut lands inside it.
        let mut text = "x".repeat(STDERR_TAIL + 1);
        text.insert(2, '—');
        let tail = stderr_tail(&text);
        assert!(tail.len() <= STDERR_TAIL);
        assert!(
            tail.chars().all(|c| c == 'x'),
            "the straddled dash is dropped whole"
        );
        // A cut that lands on a boundary keeps exactly the tail.
        let exact = "y".repeat(STDERR_TAIL + 10);
        assert_eq!(stderr_tail(&exact).len(), STDERR_TAIL);
    }

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
