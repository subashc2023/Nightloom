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

#[cfg(test)]
mod aside_parity;
pub mod ask;
mod bash_tail;
pub mod brief;
pub mod budget;
pub mod cli_session;
pub mod connector_writes;
pub mod connectors;
pub mod flat;
pub mod fork;
pub mod inbox;
pub mod nested;
pub mod own_browser;
mod process;
mod protocol;
mod record;
mod run;
mod spec;
pub mod stagger;
pub mod steer;
mod translate;
pub mod warm;

pub use ask::{
    Answer, AskDir, AskGate, DeferredCall, FolderGrant, GrantScope, PlanThen, outside_folder,
};
pub use brief::BriefSpec;
pub use protocol::{DeniedCall, RateLimitInfo};
pub use record::{
    Recorder, SUBAGENT_CLOSE, SUBAGENT_OPEN, carry_messages, carry_transcript, subagent_block,
};
pub use translate::{AgentOutcome, LimitHit, StoppedAgent, Translator};

pub use process::*;
pub use run::*;
pub use spec::*;

use crate::{TurnEvent, TurnInput};
use nightloom_core::{ChatKind, ChatMode};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

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

/// How often a running chat turn looks at its budget ledger for a wake
/// (item 538): a file read under its lock, nothing when no wake waits.
const BUDGET_TICK: Duration = Duration::from_secs(2);
/// How often the read loop looks for spawns held by the stagger (item 761).
const HELD_TICK: Duration = Duration::from_millis(400);
/// How long after a spawn call it looks (review, 2026-11-19): the hook
/// may first refresh `/usage` (~30 s at worst, measured in 761's run),
/// then hold at most 10 s. Outside it, and with nothing shown, the read
/// loop does not look at all — a turn with no spawn pays nothing.
const HELD_WINDOW: Duration = Duration::from_secs(90);

/// How long to keep reading after a kill (item 466, 2026-10-29): what the
/// CLI wrote before it is already in the pipe; this is only the backstop
/// for a child of its that holds the pipe open.
const KILLED_DRAIN: Duration = Duration::from_millis(500);

/// How long a stopped CLI that has closed its turn gets to exit on its own,
/// in the background, before it is killed (item 466). The turn is over in
/// its session by then, so the kill loses nothing; the grace is the same as
/// the interrupt's, since nobody waits on it.
const EXIT_GRACE: Duration = INTERRUPT_GRACE;

/// Tail of the child's stderr kept for diagnosis, in bytes.
const STDERR_TAIL: usize = 4096;

/// Set to `1` on every `claude` process Nightloom starts (backlog 435), so
/// a user's own Claude Code hooks can tell a Nightloom turn from theirs.
pub const NIGHTLOOM_MARKER_ENV: &str = "NIGHTLOOM";

/// Claude Code's switch for its "tether" (server-held conversations,
/// requests with a `thread` field), set `false` on a side request's
/// process ([`AgentSpec::side_cache_mark`]). Item 806 found it on his
/// account (server flag `tengu_curious_tower`) and this switch past it.
pub const TETHER_OFF_ENV: &str = "CLAUDE_CODE_TETHER_LIVE";

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
    /// `--system-prompt-snapshot off`: the CLI renders the prompt from the
    /// flags on every request instead of reusing the one it recorded on the
    /// conversation's first. Measured on 2.1.280 (nightshift backlog 174,
    /// `174-report-2026-09-22.md`): with the record on, a changed
    /// `--append-system-prompt` never reaches a resumed chat. Set for a chat
    /// that has taken a newer layer at a cold moment (blocker 320).
    pub system_prompt_snapshot_off: bool,
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
    /// is the CLI's default (unbounded). An aside keeps the chat's own
    /// value ([`AgentSpec::aside`]) — ~~2: its answering round, plus one
    /// in case the model read something first~~ (until item 675,
    /// 2026-11-12: two rounds ended an aside that thought, read two things
    /// and answered in `error_max_turns`), ~~then 20~~ (removed 2026-11-12,
    /// his "why is there a max turns on asides in the first place gang":
    /// an aside runs like the main chat) — measured, a turn
    /// that calls a tool under `--max-turns 1` runs the tool and then ends
    /// `error_max_turns` with no answer (nightshift
    /// `081-report-2026-09-16.md`, M4).
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
    /// A Chat by declaration and by kind (nightshift item 759): its
    /// `--tools` list is the five readers, but MCP tools are not on that
    /// list, so the connector writes, the browser and the preview are
    /// refused by the same deny entries the Chat policy registers
    /// ([`connector_writes`]). Set by
    /// [`apply_kind_policy`](Self::apply_kind_policy).
    pub born_chat: bool,
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
    /// His claude.ai connectors (Google Drive, Claude Docs, …) as tools —
    /// nightshift backlog 235, blocker 490. **Off by default**, on every
    /// path that builds a spec: off sends `ENABLE_CLAUDEAI_MCP_SERVERS=false`
    /// in the environment and the CLI never loads them ([`connectors`] has
    /// the measurements). Only a chat's rail switch turns it on.
    pub claude_ai_connectors: bool,
    /// Item 845 (846 §7 step 5): Home's read-only chat — its mail and
    /// calendar writers ([`connector_writes::HOME_GATED_MATCHER`]) ask him
    /// on a card, one call at a time, instead of being refused. Set only by
    /// `home::reach::apply`; off everywhere else.
    pub home_gated_writes: bool,
    /// A chat of Home's project, in whatever position (item 872; set by
    /// `home::reach::mark`). Home's own writer — its Reminders tool
    /// ([`connector_writes::HOME_OWN_WRITER_MATCHER`]) — asks him only on
    /// the read-only chat's card; were Home's chat ever not held
    /// read-only, the tool is refused outright rather than run unasked or
    /// offered a standing allow.
    pub home_chat: bool,
    /// With [`Self::claude_ai_connectors`] on, the connectors he unticked,
    /// by the init event's server name (`claude.ai Google Drive`): each a
    /// server-level `--disallowedTools` rule. Ignored while off.
    pub claude_ai_blocked: Vec<String>,
    /// Claude in Chrome — the CLI driving his real, logged-in Chrome through
    /// the extension (nightshift backlog 353, blocker 1412). **Off by
    /// default** on every path that builds a spec. On sends `--chrome`, off
    /// sends `--no-chrome`, so the CLI's own default never applies silently.
    ///
    /// Measured 2026-10-12, CLI 2.1.296, one Haiku turn each, reading the
    /// init event (nightshift `notes/runner-design/353-findings.md`):
    ///
    /// | spelling | `mcp__claude-in-chrome__*` tools | server |
    /// |---|---|---|
    /// | the chat's flags today | 0 | none |
    /// | + `--chrome` | 22 | `claude-in-chrome`, connected |
    /// | + `--no-chrome` | 0 | none |
    /// | + `--chrome` under safe mode's three flags | 22 | `claude-in-chrome`, connected |
    ///
    /// So his `claudeInChromeDefaultEnabled` does not reach `claude -p`, and
    /// `--strict-mcp-config` does not drop the server: `--chrome` adds it as
    /// a built-in, not from a config file. Its tools are `mcp__…` and so go
    /// through the Ask hook's matcher like any MCP tool; under the Chat
    /// policy they are refused ([`BROWSER_TOOLS_MATCHER`], blocker 1414).
    pub browser: bool,
    /// Playwright's gate (nightshift backlog 367): a `PreToolUse` entry on
    /// [`own_browser::MATCHER`] in every position, bypass included, so a
    /// call defers for the approval card unless the chat or the reply
    /// already allows it. `None` when the chat has no Playwright server in
    /// its `mcp_config` (not installed, or a spec that is not a chat's).
    pub playwright: Option<own_browser::PlaywrightGate>,
    /// `add_folder`'s gate is registered for a process no card waits on —
    /// an aside's or a checkpoint fork's (nightshift item 613): the hook
    /// refuses its call in words instead of deferring it. The gate itself
    /// rides the brief's directory and binary (`folder_gate_entry`).
    pub folder_side: bool,
    /// A side request whose prefix is the chat's (an aside, a keep-warm
    /// ping; aside-cache research 2026-11-23): its process runs with
    /// [`TETHER_OFF_ENV`] off, so its request carries a cache breakpoint on
    /// the chat's last message as well as its own end, and its write is
    /// one the chat's next send can read. On his account Claude Code sends
    /// tether-shaped requests (`thread`), which carry the end mark only:
    /// a cold chat's aside wrote a copy ending at its own question, and
    /// the chat's next send read 38.7% (run R1). Tether off, the same
    /// aside left the next send reading 97.3% (R2), and a warm aside still
    /// read 96.8% (R3). Measured on CLI 2.1.330, Haiku, a scratch chat
    /// (`notes/runner-design/aside-cache-report-2026-11-23.md` in
    /// nightshift-code); Opus 5.5 `auto` captured with the same two marks.
    pub side_cache_mark: bool,
    /// An aside seated on its own directory (nightshift item 919,
    /// [`AgentSpec::seat_aside`]): the Ask position's hook is registered
    /// for it after all, on the chat's matcher, waiting in the hook for
    /// his answer on the aside's card ([`ask::WAIT_ARG`]) where the chat's
    /// would defer. Only `--settings` changes — no flag, tool or mode — so
    /// the aside still reads the chat's cached prefix.
    pub aside_cards: bool,
    /// An incognito chat (nightshift backlog 405): set by
    /// [`apply_incognito`](Self::apply_incognito), never directly. On, the
    /// CLI loads no setting file — so not his `~/.claude/CLAUDE.md`, his
    /// hooks or his allowlist — no MCP server but the ones named here, and
    /// no skill: the spelling safe mode uses, for the reason its doc's
    /// table gives (`--setting-sources ""`, measured 2026-09-14).
    pub incognito: bool,
    /// The folders no read may reach (backlog 405), sent as
    /// `permissions.deny` `Read(//…)` rules in the one `--settings` JSON
    /// ([`crate::incognito::deny_rules`]; measured in the 405 report, M0).
    pub denied_reads: Vec<PathBuf>,
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
///
/// With the Browser on (nightshift backlog 353 review) the `mcp__.*`
/// alternative becomes [`ASK_MCP_LESS_BROWSER`]: the browser's tools are
/// refused by their own deny entry under the policy, and the CLI runs
/// every matching entry, so an Ask hook still naming them showed an
/// approval card for a call already refused — backlog 147's bug again.
fn ask_matcher_under_chat_policy(matcher: &str, browser: bool) -> String {
    matcher
        .split('|')
        .filter(|alt| CHAT_POLICY_KEPT.iter().any(|kept| alt.starts_with(kept)))
        .map(|alt| {
            if alt != ask::MCP_ALTERNATIVE {
                alt.to_string()
            } else {
                ask_mcp_less(browser)
            }
        })
        .collect::<Vec<_>>()
        .join("|")
}

/// The Ask hook's matcher in a born Chat (item 759): its `mcp__`
/// alternative narrowed as under the policy — the deny entries refuse the
/// connector writes, the browser and the preview there too, and a card
/// for a refused call is backlog 147's bug. The rest is untouched: the
/// tool list already holds only the readers.
fn ask_matcher_in_born_chat(matcher: &str, browser: bool) -> String {
    matcher
        .split('|')
        .map(|alt| {
            if alt == ask::MCP_ALTERNATIVE {
                ask_mcp_less(browser)
            } else {
                alt.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("|")
}

/// [`ASK_MCP_LESS_BROWSER`] or [`ASK_MCP_LESS_PREVIEW`], with the connector
/// writes ([`connector_writes::ASK_EXCLUSION`], item 759) left out too.
fn ask_mcp_less(browser: bool) -> String {
    let base = if browser {
        ASK_MCP_LESS_BROWSER
    } else {
        ASK_MCP_LESS_PREVIEW
    };
    let head = base.strip_suffix(").*").expect("a lookahead and .*");
    // With `remember` (item 783): this matcher is only ever the Ask hook's,
    // and wherever that hook is registered the read-only chat's asking
    // entry decides `remember` and the connector actions.
    format!("{head}|{}).*", connector_writes::ASK_EXCLUSION_WITH_CARD)
}

/// The Ask hook's `mcp__` alternative under the Chat policy with the
/// Browser on: every MCP tool but Claude in Chrome's, by the same
/// JavaScript negative lookahead [`CHAT_POLICY_MATCHER`] uses.
/// Playwright's tools stay out too, as in [`ask::MATCHER`] (backlog 367).
/// The preview's tool stays out too (item 430): the policy's own deny
/// entry refuses it, and an Ask card for it would be backlog 147's bug.
const ASK_MCP_LESS_BROWSER: &str = "mcp__(?!claude-in-chrome__|playwright__|nightloom__preview|nightloom__add_folder|nightloom__request_secret|nightloom__ask_user_to_drive).*";

/// The same without the Browser: every MCP tool but Playwright's and the
/// preview's.
const ASK_MCP_LESS_PREVIEW: &str = "mcp__(?!playwright__|nightloom__preview|nightloom__add_folder|nightloom__request_secret|nightloom__ask_user_to_drive).*";

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

/// The `PreToolUse` matcher for Claude in Chrome's tools under the Chat
/// policy (nightshift backlog 353, blocker 1414). The policy's own matcher
/// lets every `mcp__` tool through, and a browser that clicks and submits
/// in his logged-in Chrome is not a read, so with the Browser switch on a
/// Chat refuses these too — by hook, like the policy, so the tool list and
/// the cached prefix stay what they were.
pub const BROWSER_TOOLS_MATCHER: &str = "mcp__claude-in-chrome__.*";

/// The `PreToolUse` matcher for the chat's preview (nightshift item 430)
/// under the Chat policy: it runs a command, so a Chat refuses it as it
/// refuses the shell.
pub const PREVIEW_TOOL_MATCHER: &str = "mcp__nightloom__preview";

/// Why a Chat refuses the preview.
pub const PREVIEW_UNDER_CHAT_POLICY_REASON: &str = "This chat is a Chat now: the preview runs a command, and the shell and the tools that act are withdrawn. Reads, search and the web remain.";

/// What the model reads when a Chat refuses a browser call.
pub const BROWSER_UNDER_CHAT_POLICY_REASON: &str = "This chat is a Chat now: the browser is withdrawn with the other tools that act. Reads, search and the web remain.";

/// What the model reads when the policy refuses a call — the hook's
/// `permissionDecisionReason`, delivered as the tool's error result.
pub const CHAT_POLICY_REASON: &str = "This chat is a Chat now: the shell, the file-editing tools, subagents and plans are withdrawn. Reads, search and the web remain.";

/// What follows `add_folder`'s gate on its command line: it fails closed,
/// as Playwright's does — a hook that could not run must not let a folder
/// be asked for unseen (exit 2 blocks the call; the line goes to the model).
pub const FOLDER_GATE_FAIL_CLOSED: &str =
    "|| { echo 'The folder was not added: its approval check could not run.' >&2; exit 2; }";

/// What follows `request_secret`'s gate (item 766): fails closed, so a
/// hook that could not run never lets the call through unasked.
pub const SECRET_GATE_FAIL_CLOSED: &str =
    "|| { echo 'Nothing was asked: the secret card could not be shown.' >&2; exit 2; }";

/// What follows `ask_user_to_drive`'s gate (item 872): fails closed, so a
/// hook that could not run never lets the call through unasked.
pub const DRIVE_GATE_FAIL_CLOSED: &str = "|| { echo 'Nothing was asked: the card that hands you the page could not be shown.' >&2; exit 2; }";

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

/// Where an aside sits (nightshift item 919; [`AgentSpec::seat_aside`]).
#[derive(Debug, Clone, PartialEq)]
pub struct AsideSeat {
    /// The aside's own ask directory: `<chat's ask dir>/asides/<key>`.
    pub dir: PathBuf,
    /// The app's browser for the aside, its own tab in the pane.
    pub endpoint: Option<PathBuf>,
}

impl AsideSeat {
    /// The aside's directory under the chat's, `key` (the thread's stable
    /// name) kept to letters, digits, `-` and `_`.
    pub fn dir_for(chat_dir: &std::path::Path, key: &str) -> PathBuf {
        let clean: String = key
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .take(64)
            .collect();
        chat_dir
            .join("asides")
            .join(if clean.is_empty() { "aside" } else { &clean })
    }

    /// Make the aside's directory and give it the chat's standing answers
    /// as they are now — the tools "Allow for this chat" granted, his
    /// per-chat rules, the chat's Playwright switch — so an aside asks
    /// about nothing the chat would not. One way only: what he answers in
    /// the aside stays in the aside's directory. A stale one-shot decision
    /// is cleared. Best-effort: a file that cannot be copied leaves the
    /// aside asking more, never less.
    pub fn prepare(
        chat_dir: &std::path::Path,
        key: &str,
        endpoint: Option<PathBuf>,
    ) -> std::io::Result<Self> {
        let dir = Self::dir_for(chat_dir, key);
        std::fs::create_dir_all(&dir)?;
        for name in [ask::RULES_FILE, crate::approval_rules::FILE] {
            match std::fs::read(chat_dir.join(name)) {
                Ok(b) => {
                    let _ = std::fs::write(dir.join(name), b);
                }
                Err(_) => {
                    let _ = std::fs::remove_file(dir.join(name));
                }
            }
        }
        let _ = std::fs::remove_file(dir.join(ask::DECISION_FILE));
        let _ = std::fs::remove_file(dir.join(ask::PENDING_FILE));
        Ok(Self { dir, endpoint })
    }
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
    /// The Auto position (nightshift backlog 294, 2026-10-03):
    /// `--permission-mode auto`, the prompt tool named so the CLI offers
    /// `AskUserQuestion`, and the hook on that tool alone
    /// ([`ask::AUTO_MATCHER`]) — the model's question shows the card and
    /// waits for his answer; nothing else pauses. The plan tools the flag
    /// also offers are refused in words ([`ask::PLAN_TOOLS_ON_AUTO`]).
    Auto,
    /// A checkpoint fork of an Auto chat (backlog 294): `auto` still, the
    /// prompt tool named (the prefix), the plan refusal kept, and no Ask
    /// hook — a question from a side process has no card waiting for it,
    /// so it falls to the prompt tool, which refuses in words.
    AutoFork,
    /// An aside or keep-warm ping of a Plan chat (nightshift item 774,
    /// blocker 2037, 2026-11-16): `plan` still, so it edits nothing, the
    /// prompt tool named (the prefix), and no Ask hook, as [`Self::Aside`]
    /// — a deferral would park it on a card nobody's turn waits for.
    /// `plan` and not `dontAsk` because on Opus 5.5 (CLI 2.1.326) the two
    /// send different Bash tool text ([`AgentSpec::side_permission_mode`]).
    PlanAside,
}

impl AskMode {
    /// The `--permission-mode` value.
    pub fn permission_mode(self) -> &'static str {
        match self {
            Self::Ask => "default",
            Self::Plan | Self::PlanAside => "plan",
            Self::ExitingToAuto | Self::Auto | Self::AutoFork => "auto",
            Self::Aside => "dontAsk",
        }
    }

    /// Whether this is the Auto position, a fork of one included: the
    /// plan tools are refused (backlog 294).
    pub fn is_auto(self) -> bool {
        matches!(self, Self::Auto | Self::AutoFork)
    }

    /// The hook's matcher.
    pub fn matcher(self) -> &'static str {
        match self {
            Self::Ask | Self::Plan => ask::MATCHER,
            Self::ExitingToAuto => ask::EXIT_PLAN_MATCHER,
            Self::Auto => ask::AUTO_MATCHER,
            // Never registered; see the variants.
            Self::Aside | Self::AutoFork | Self::PlanAside => "",
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
/// | `--tools Read Glob Grep WebFetch WebSearch ToolSearch` | exactly those six |
///
/// A deny-list is honest about the release it was written against and
/// drifts open on the next one; a worktree and a cron job both write. The
/// positive list is default-closed, and `--tools` is already how the rail's
/// "tools off" is spelled (`Some(vec![])`), so this is the same field with
/// six names in it. MCP tools are untouched by `--tools` — Nightloom's own
/// server still reaches the model, started without `remember`.
///
/// The web stays. Incognito is about *his* data — nothing written here,
/// nothing read by other chats — and a fetch writes nothing on this
/// machine; egress has its own switch on the rail and keeps it.
///
/// `ToolSearch` too (nightshift item 899): without it the CLI cannot defer
/// tools, so every MCP and connector schema is sent whole on every turn —
/// measured on CLI 2.1.330 with his connectors on, a Chat-kind turn carried
/// 179,525 tokens (196 tools inline; $1.44 written cold) against 14,372 with
/// it. It adds no tool: it only loads the schemas of tools the chat already
/// has, under the same permissions.
pub const READ_ONLY_TOOLS: [&str; 6] = [
    "Read",
    "Glob",
    "Grep",
    "WebFetch",
    "WebSearch",
    "ToolSearch",
];

/// Each aside's own cancel token, keyed by its exchange number `seq`
/// (nightshift backlog 176, 2026-09-23). Several aside cards may be open
/// at once, so the window's × must stop the exchange it was clicked on and
/// no other. Before this the app kept **one** token, overwritten by every
/// `ask_aside`: a second question left the first's token unreachable, and
/// a × then stopped the wrong one. [`AsideCancels::begin`] registers a
/// fresh token and hands back a guard that removes it when the exchange
/// ends, however it ends; [`AsideCancels::cancel`] reaches one exchange,
/// whether it is still waiting for the agent's lock or running.
#[derive(Default)]
pub struct AsideCancels {
    /// `seq` → (registration number, token). The registration number lets
    /// a guard remove only its own entry.
    tokens: std::sync::Mutex<std::collections::HashMap<u64, (u64, CancellationToken)>>,
    next: std::sync::atomic::AtomicU64,
}

/// An aside's registration in [`AsideCancels`]: its token while it runs,
/// dropped from the map when the guard goes.
pub struct AsideCancelGuard<'a> {
    owner: &'a AsideCancels,
    seq: u64,
    reg: u64,
    token: CancellationToken,
}

impl AsideCancels {
    /// Register exchange `seq` and return its guard. A `seq` already
    /// present (the window never reuses one) is replaced, its old token
    /// cancelled so nothing is left running unreachable.
    pub fn begin(&self, seq: u64) -> AsideCancelGuard<'_> {
        let token = CancellationToken::new();
        let reg = self.next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let old = self
            .tokens
            .lock()
            .unwrap()
            .insert(seq, (reg, token.clone()));
        if let Some((_, old)) = old {
            old.cancel();
        }
        AsideCancelGuard {
            owner: self,
            seq,
            reg,
            token,
        }
    }

    /// Cancel exchange `seq`; false when no such exchange is registered
    /// (it finished, or never started).
    pub fn cancel(&self, seq: u64) -> bool {
        match self.tokens.lock().unwrap().get(&seq) {
            Some((_, t)) => {
                t.cancel();
                true
            }
            None => false,
        }
    }

    /// How many exchanges are registered — waiting or running.
    pub fn len(&self) -> usize {
        self.tokens.lock().unwrap().len()
    }

    /// Whether no exchange is registered.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl AsideCancelGuard<'_> {
    /// The exchange's token, for the wait on the agent and for the CLI.
    pub fn token(&self) -> &CancellationToken {
        &self.token
    }
}

impl Drop for AsideCancelGuard<'_> {
    fn drop(&mut self) {
        let mut map = self.owner.tokens.lock().unwrap();
        // Only this registration's own entry: a `begin` that replaced it
        // owns the slot now.
        if map.get(&self.seq).is_some_and(|(r, _)| *r == self.reg) {
            map.remove(&self.seq);
        }
    }
}

#[cfg(test)]
mod tests;
