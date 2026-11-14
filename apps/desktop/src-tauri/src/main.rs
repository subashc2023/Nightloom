//! Nightloom desktop shell: Tauri commands over `nightloom-service`.
//!
//! Streaming goes out as `turn-event` window events (serialized
//! [`TurnEvent`]s); retry stalls surface as `turn-notice` strings. Commands
//! mirror the service API and return plain serializable values.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use nightloom_core::{ChatKind, ChatMode, Effect, Tool};
use nightloom_core::{
    DocumentInput, ImageInput, ProviderError, SegmentKind, Session, SessionEvent, SystemPrompt,
    Thinking, WireView,
};
use nightloom_service::agent::cli_session::{self, CliSession};
// The CLI-history helpers the desktop's tests drive directly; their bodies
// moved to the service crate with the commands' (item 246 wave 4, 4A).
#[cfg(test)]
use nightloom_service::agent::cli_session::{Block, Target};
use nightloom_service::agent_turn::{
    AgentTurnEnd, AgentTurnRun, ApprovalPrompt, ProjectGrant, TurnEnv, run_agent_turn,
};
use nightloom_service::approval::{Approver, AutoApprove, Decision, PendingCall};
use nightloom_service::chat_ops::{self, MessageEdit, OnCli, turns_after};
#[cfg(test)]
use nightloom_service::chat_ops::{
    CliChange, agent_session_before, cli_block, cli_target, edit_cli_file, edit_on_cli,
    is_narrative_block, restore_cli_file, restore_on_cli,
};
use nightloom_service::context_ops::{self, ContextEdit, PromptLayersInfo};
use nightloom_service::credentials::{self, KeySource};
use nightloom_service::import;
use nightloom_service::project::{self, Note, Project, Registry};
use nightloom_service::store::{self, SessionMatch, SessionSummary};
use nightloom_service::thread::ThreadContext;
use nightloom_service::tools::{ChatDir, ChatDirs, Reviewer, Root, SearchBackend};
use nightloom_service::{
    AgentSpec, Chat, ClaudeCodeAgent, CompactOutcome, KnowledgeContext, PassSpec, Price,
    ProjectContext, PromptConfig, ProviderKind, TurnEvent, TurnInput, TurnOutcome, resolve_binary,
    searched_locations,
};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

/// The Claude Code agents the window holds, one per chat (backlog 159, A2).
mod agents;
mod away;
mod chat_name;
/// The chats the backend holds, one lock per chat (backlog 159, A1).
mod chats;
mod claude_browser;
/// The command groups moved out of this file (item 642).
mod commands;
/// A connect under a deadline that names its wait (item 220).
mod connect_deadline;
/// The composer's exact token count on the provider engine (backlog 155).
mod draft_count;
/// An AppKit exception in event dispatch is logged, not fatal (item 486).
#[cfg(target_os = "macos")]
mod event_guard;
/// A file card's Open as a tab: which paths may be read, and reading them
/// (nightshift backlog 161).
mod filetab;
mod for_you;
/// The notes Inbox's Sort inbox (nightshift backlog 488).
mod inbox_sort;
// The keep-warm clock (backlog 582).
mod keep_warm;
/// A `.tex` tab's rendered PDF (nightshift backlog 381).
mod latex;
mod model_list;
/// Nightshift: the unattended runner's file contract, as commands.
mod nightshift;
/// Edit a note by prompt (nightshift backlog 151).
mod note_edit;
/// A debug build's off-screen window for live tests (backlog 339). Not
/// compiled into a release (backlog 341): there it is a stub that is off.
#[cfg(debug_assertions)]
mod offscreen;
/// Finder's Open With → Nightloom (nightshift backlog 378).
mod opened_files;
/// Panics written to `~/.nightloom/logs/panic.log` (nightshift item 486).
mod panic_log;
/// A paste's web images, fetched (nightshift backlog 382).
mod paste_images;
#[cfg(not(debug_assertions))]
mod offscreen {
    /// Never in a release build.
    pub fn on() -> bool {
        false
    }
    /// Nothing to do in a release build.
    pub fn apply<R: tauri::Runtime>(_app: &tauri::AppHandle<R>) {}
}
/// Sleep-safe turns: the power assertion and the wake watcher.
mod power;
/// A chat's preview, run by the app between messages (nightshift item 430).
mod preview;
/// A changed prompt layer waits for the chat's cold moment (backlog 174).
mod prompt_hold;
/// Quitting while work runs asks first (nightshift backlog 308).
mod quit_guard;
/// The phone page over the tailnet (nightshift backlog 091, Shape B).
mod remote;
mod sent_files;
mod set_aside;
mod startup_log;
/// The terminal pane's shells (nightshift backlog 113).
mod terminal;
// The clock behind Send later and the limit resume (backlog 535).
mod wake;
/// Web tabs: a clicked link as a child webview in a pane (backlog 172).
mod webtab;
/// The page fills the window again after a wake (nightshift backlog 324).
mod webview_fit;

// The moved command groups, so the code left here (and the tests) reads
// their items by bare name, as before the move (item 642).
use commands::agent::*;
use commands::chat::*;
use commands::connect::*;
use commands::notes::*;
use commands::sessions::*;
use commands::system::*;
use commands::usage::*;

// Read only by the tests below.
#[cfg(test)]
use commands::aside::*;

struct AppState {
    /// The provider engine (the API key's loop). ~~Held for a whole turn
    /// under this lock~~ — since backlog 159 A4 (2026-09-30) an `Arc` the
    /// turn clones out and lets go of, so another chat's context page, its
    /// elisions, its compaction and a reconnect do not wait a turn; a
    /// connect swaps in a new engine and the running turn finishes on its
    /// own. One provider turn at a time still (`WindowApprover::turn`).
    chat: tokio::sync::Mutex<Option<Arc<Chat>>>,
    /// The Claude Code agent, when the rail is on that engine instead.
    ///
    /// `Some` here **is** what "agent mode" means, rather than a third field
    /// saying so: `connect` clears it and `connect_agent` clears the `Chat`,
    /// so the two can never both be live and no invariant has to be
    /// maintained between a mode flag and the thing it describes.
    ///
    /// Held mutably across turns because the agent owns the history: each
    /// turn opens or continues one of its sessions, and carrying that id
    /// into the next `--resume` is the only way this is a conversation at
    /// all.
    ///
    /// ~~`agent: Mutex<Option<ClaudeCodeAgent>>`, one for the window~~ —
    /// replaced 2026-09-25 (backlog 159, pass 2 step A2): one agent per
    /// chat, so a second chat's turn runs beside the first. See [`agents`].
    agents: agents::Agents,
    /// Whether `agent` is `Some`, readable without its lock (backlog 159,
    /// A1): a turn holds `agent` for its whole length, and "which engine
    /// is live" — the context page's question, the conversation-edit
    /// guard's — must not wait a turn for the answer. Written beside every
    /// write of `agent` (`connect`, `connect_agent`) and nowhere else.
    agent_live: std::sync::atomic::AtomicBool,
    /// ~~`agent_readopt`: the one agent re-pointed its `--resume` at the
    /// open chat before its next use (A1's bridge)~~ — gone 2026-09-25
    /// (A2): each chat's agent carries its own chat's resume.
    ///
    /// Each agent turn's Stop token, by chat (backlog 159, A2): with two
    /// chats running, Stop in one must stop that one. `cancel` still holds
    /// the latest turn's token, for the callers that name no chat.
    turn_cancels: std::sync::Mutex<HashMap<String, CancellationToken>>,
    /// Each running agent turn's inbox (nightshift backlog 328), by chat
    /// and by turn key, as `turn_cancels`: a message he sends while it runs
    /// goes into the turn through it.
    inboxes: std::sync::Mutex<HashMap<String, nightloom_service::agent::inbox::Inbox>>,
    /// Stops asked for by a turn key (`turn:…`, the window's name for a
    /// turn whose chat it does not know yet) before that turn registered
    /// (backlog 159, A3): the turn cancels itself on registering.
    early_stops: std::sync::Mutex<std::collections::HashSet<String>>,
    /// ~~`session: Mutex<Option<Session>>`, the one open chat~~ — replaced
    /// 2026-09-24 (backlog 159, pass 2 step A1): each chat behind its own
    /// lock and the open one a focus, so a command about chat B never
    /// waits on chat A's turn. See [`chats`].
    chats: chats::Chats,
    /// The kind the next chat will be, while there is no chat
    /// (nightshift backlog 061, 2026-09-15).
    ///
    /// New chat is a state, not a file: `new_session` drops the open
    /// session and records the kind asked for here, and the first message
    /// creates the log in that kind (`ensure_session`). Until then nothing
    /// is on disk and nothing is listed, so clicking New chat twice is the
    /// same as clicking it once. The mode is read from here only while
    /// `session` is `None` — once a log exists its first line is the
    /// answer (`session_mode`) — and a project switch resets it, since the
    /// pending kind was chosen for the list the user was looking at.
    pending_mode: tokio::sync::Mutex<ChatMode>,
    /// What the next chat is for, on the same terms as `pending_mode`
    /// (nightshift backlog 102, 2026-09-16): Claude Code or Chat, chosen
    /// at New chat and honoured at the first message; read only while
    /// there is no chat, reset with the mode on a project switch.
    pending_kind: tokio::sync::Mutex<ChatKind>,
    /// Swapped per turn. Shared with [`WindowApprover`], which has to wait on
    /// whichever token is current at the moment it asks.
    cancel: Arc<std::sync::Mutex<CancellationToken>>,
    /// The project registry and which project is open.
    ///
    /// One mutex over both halves rather than two, because every question
    /// worth asking touches both ("where do chats go", "what is this called")
    /// and two locks would need an ordering rule of their own. This one is a
    /// **leaf**: callers clone what they need out of it and drop the guard
    /// before taking `chat` or `session`, so it can never be part of a cycle.
    workspaces: tokio::sync::Mutex<Workspaces>,
    /// Where chats go when no project is open: `~/.nightloom/unfiled/sessions`.
    ///
    /// Unfiled chats stay unfiled rather than being forced into a folder: the
    /// quickest useful thing this app does is answer a question that has
    /// nothing to do with any directory, and making that require choosing a
    /// project first would be a worse app. They sit beside the projects'
    /// stores rather than in the OS app-data dir so that everything Nightloom
    /// has written for this user is under one directory they can open.
    default_log_dir: PathBuf,
    /// The approval policy, built once for the process and reused by every
    /// `connect`. Rebuilding it there would silently forget every "always
    /// allow" the user granted, because the rail re-connects on every
    /// provider, model or knob change.
    approval: Arc<AutoApprove>,
    /// The half that resolves prompts, kept separately so `approve_call` can
    /// reach it without downcasting out of the policy.
    gate: Arc<WindowApprover>,
    /// Where an agent turn waits for the answer to a call the CLI deferred
    /// (2026-09-16, nightshift backlog 084). Its own gate rather than
    /// `WindowApprover` because the answer carries a payload — a question's
    /// answers, an approved plan — that the engine's `Decision` does not.
    ask: Arc<nightloom_service::agent::AskGate>,
    /// MCP servers, started once per workspace and kept.
    ///
    /// Cached rather than reconnected because the rail re-connects on every
    /// knob change, and each reconnect would otherwise spawn a second copy of
    /// every configured server and leak the first.
    mcp: tokio::sync::Mutex<Option<McpState>>,
    /// One dream at a time. Taken with `try_lock`, so a second request while
    /// one runs is refused with a sentence rather than queued behind a job
    /// that spends money — a queue here would be a bill the user did not
    /// mean to run up twice.
    dreaming: tokio::sync::Mutex<()>,
    /// Swapped per dream, the way `cancel` is swapped per turn. Separate
    /// from it because a dream is not a turn: stopping the chat must not
    /// stop the dream, and stopping the dream must not stop the chat.
    dream_cancel: Arc<std::sync::Mutex<CancellationToken>>,
    /// Swapped per aside (nightshift backlog 081; review F13 2026-09-16
    /// gave it its own token). An aside also installs itself in `cancel`
    /// once it holds the agent, so Stop keeps cancelling it like a turn;
    /// this one is what the aside card's own × cancels — and it works while
    /// the aside is still parked behind a running turn, which `cancel`
    /// cannot reach. ~~One token, swapped per aside~~ — one per exchange
    /// since backlog 176 (2026-09-23), keyed by its `seq`: several cards
    /// may be open, and a × must stop its own exchange and no other.
    aside_cancel: nightloom_service::agent::AsideCancels,
    /// What the live connection's system prompt was built from, written by
    /// `connect` and `connect_agent` and read by `context_view` and
    /// `prompt_layers`. See [`PromptBuilt`] for why it is a field of its own.
    prompt: tokio::sync::Mutex<PromptBuilt>,
}

/// The prompt as the live engine was given it.
///
/// The provider engine keeps its segments on the `Chat`, so `context_view`
/// can itemize them from there. The agent engine keeps only the flat string
/// it passed to `--append-system-prompt`, and re-splitting that into layers
/// would be a second parser for a string this process rendered a moment ago.
/// So the segments are kept here as they were rendered, and the view shows
/// those — the same segments the flag carries, by construction rather than
/// by parsing.
///
/// `off` is here for the same reason: a chat's switched-off layers are read
/// from its log at connect time, and the question "does the live engine
/// match the chat now open" needs the set it was actually built with, not
/// the set the log holds now — the two differ exactly after another chat is
/// opened, which is when the UI has to reconnect.
///
/// `edits`, `model` and `cwd` (2026-09-15, nightshift backlog 057) are here
/// on the same terms: the chat's own text per layer is compared like the
/// off set to decide a reconnect, and `prompt_layer_file` seeds an edit
/// from what the live prompt would read — the model's file by the id the
/// prompt was built for, the walk from the workspace it was built in.
#[derive(Default)]
struct PromptBuilt {
    /// The layers switched off in the chat the connection was built for.
    off: Vec<SegmentKind>,
    /// The chat's own text per layer the connection was built with.
    edits: BTreeMap<SegmentKind, String>,
    /// The model id the prompt looked up its instruction file by.
    model: Option<String>,
    /// The workspace the `AGENTS.md` walk started from.
    cwd: Option<PathBuf>,
    /// On the Claude Code engine, the bridged segments; `None` on the
    /// provider engine.
    agent: Option<SystemPrompt>,
    /// The mode of the chat the connection was built for (2026-09-15): an
    /// incognito chat's engine has no writers, and a normal chat opened
    /// after it must get them back — the same reconnect comparison as
    /// `off`, for the same reason.
    mode: ChatMode,
    /// The kind of chat the connection was built for (nightshift backlog
    /// 102): a Chat's engine has the read-only tools, no folder and the
    /// Chat instructions; the Build chat opened after it needs its folder
    /// and tools back — the same reconnect comparison as `mode`.
    kind: ChatKind,
    /// The research thread the prompt was built with (nightshift backlog
    /// 271): compared with the open chat's like `off`, and read by
    /// `prompt_layer_file` to seed the thread layer's edit.
    thread: Option<ThreadContext>,
    /// Whether the CLI the connection spawns reads the folder's `AGENTS.md`
    /// itself (nightshift 575), so the walk left it out: the new-chat dial
    /// counts it under the CLI's instructions then, and only then.
    cli_agents_md: bool,
}

/// The registry, plus the project currently open.
struct Workspaces {
    registry: Registry,
    active: Option<Project>,
}

impl AppState {
    /// The open project, cloned out. Cloning rather than lending is the whole
    /// lock discipline: no caller holds the registry while it takes another
    /// lock, so no ordering rule has to be remembered.
    async fn active(&self) -> Option<Project> {
        self.workspaces.lock().await.active.clone()
    }

    /// Where the current chats live: the open project's log directory, or the
    /// app-data one when nothing is open.
    async fn log_dir(&self) -> PathBuf {
        match self.active().await {
            Some(project) => project.session_dir(),
            None => self.default_log_dir.clone(),
        }
    }
}

/// A project as the UI shows it: the registry entry plus the two counts that
/// make a picker row worth reading, and whether the folder is still there.
#[derive(Serialize, Clone)]
struct ProjectInfo {
    id: String,
    name: String,
    /// The folder this project is about, or `null` for one that is about no
    /// folder — an imported claude.ai project, until it is given one.
    root: Option<String>,
    /// Where its notes are: `<root>/.agents`, or the stand-in workspace inside
    /// the store for a project with no folder. Shown, and used by `reveal`.
    notes_dir: String,
    /// Notes in the docspace, and chats logged under the project.
    notes: usize,
    chats: usize,
    /// False when the folder has moved or been deleted. Reported rather than
    /// filtered out: an unplugged drive is not a decision to forget a project,
    /// and a row that silently vanished would be the more alarming answer.
    exists: bool,
    last_opened: String,
    /// The other folders the project's content lives in (nightshift backlog
    /// 143), granted to every chat in it; empty for most projects.
    extra_folders: Vec<String>,
    /// The claude.ai import's holder for chats that had no project
    /// (`Project::is_unfiled_holder`): a New chat in it is a Chat even though
    /// it has a folder (nightshift backlog 102).
    unfiled: bool,
}

impl ProjectInfo {
    fn of(project: &Project) -> Self {
        Self {
            id: project.id.clone(),
            name: project.name.clone(),
            unfiled: project.is_unfiled_holder(),
            root: project
                .workspace
                .as_ref()
                .map(|r| r.to_string_lossy().into_owned()),
            extra_folders: project
                .extra_folders
                .iter()
                .map(|f| f.to_string_lossy().into_owned())
                .collect(),
            notes_dir: project.notes_dir().to_string_lossy().into_owned(),
            notes: project::list_notes(&project.notes_dir()).len(),
            // Counted, not listed. This runs on every rail refresh and once
            // per project in the project picker, and `list` reads every log
            // it names — a hundred megabytes, after an import, to learn a
            // number that `read_dir` already knows.
            chats: store::count(&project.session_dir()),
            exists: project.exists(),
            last_opened: project.last_opened.to_rfc3339(),
        }
    }
}

/// The MCP servers running for one workspace.
struct McpState {
    workspace: PathBuf,
    /// Shared, so a subagent built later gets these same connections rather
    /// than starting its own.
    tools: Vec<Arc<dyn Tool>>,
    servers: Vec<McpServerInfo>,
}

/// One server, as the UI sees it.
#[derive(Clone, Serialize)]
struct McpServerInfo {
    name: String,
    tools: usize,
    /// `None` when it started. A server that failed is reported rather than
    /// hidden: its tools are simply missing otherwise, and a model that has
    /// been told nothing will confidently explain why it cannot help.
    error: Option<String>,
}

/// Puts a `mutating` tool call to the user and waits for the answer.
///
/// The request goes out as a `tool-approval` window event and parks a
/// oneshot keyed by the call id; the `approve_call` command completes it.
/// The wait is raced against the turn's cancellation token, because
/// otherwise a prompt the user dismisses — or a window they close — leaves
/// the turn parked forever with no way back.
struct WindowApprover {
    app: AppHandle,
    cancel: Arc<std::sync::Mutex<CancellationToken>>,
    pending: std::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<Decision>>>,
    /// The provider turn running now, by its chat (backlog 159, A4): one
    /// at a time — the engine's subagent handle and its compaction flag
    /// are one per engine — and its prompts name that chat, so a turn off
    /// screen asks in its own tab. `chat` is empty while its chat is not
    /// open yet. A compaction claims it too (A4 review, 2026-09-29).
    turn: std::sync::Mutex<Option<ProviderRun>>,
}

/// What the running provider turn holds (backlog 159, A4).
#[derive(Default)]
struct ProviderRun {
    /// Its chat, once open; empty before.
    chat: String,
    /// Its own Stop token (A4 review, 2026-09-29): its prompts race this,
    /// not `AppState::cancel`, which the latest turn, compaction or aside
    /// of any chat overwrites — a Claude Code turn in another chat after
    /// an engine switch did, and a Stop of this turn then left its prompt
    /// standing until answered.
    cancel: Option<CancellationToken>,
}

/// The one provider turn, claimed for its length (backlog 159, A4).
struct ProviderTurn<'a> {
    slot: &'a std::sync::Mutex<Option<ProviderRun>>,
}

/// The refusal a second provider turn gets while one runs.
const PROVIDER_TURN_BUSY: &str = "a turn is running in another chat — this sends when that ends";

impl<'a> ProviderTurn<'a> {
    /// Claimed, or refused with `busy` while another chat's provider turn
    /// (or compaction) runs.
    fn claim(slot: &'a std::sync::Mutex<Option<ProviderRun>>, busy: &str) -> Result<Self, String> {
        let mut held = slot.lock().unwrap_or_else(|p| p.into_inner());
        if held.is_some() {
            return Err(busy.into());
        }
        *held = Some(ProviderRun::default());
        Ok(Self { slot })
    }

    /// The chat the turn runs in, once it is open, and its Stop token.
    fn name(&self, chat: &str, cancel: &CancellationToken) {
        *self.slot.lock().unwrap_or_else(|p| p.into_inner()) = Some(ProviderRun {
            chat: chat.to_string(),
            cancel: Some(cancel.clone()),
        });
    }
}

impl Drop for ProviderTurn<'_> {
    fn drop(&mut self) {
        *self.slot.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
}

#[derive(Serialize, Clone)]
struct ApprovalRequest<'a> {
    id: &'a str,
    name: &'a str,
    input: &'a serde_json::Value,
    effect: nightloom_core::Effect,
    /// The folder the call reaches for outside every tree the chat may
    /// see (nightshift backlog 143, pass 2) — the card then offers *Allow,
    /// and let this chat · the project see it*. Only the Claude Code
    /// engine's deferred calls carry one; the API engine's file tools
    /// refuse such a path themselves, before any prompt.
    #[serde(skip_serializing_if = "Option::is_none")]
    outside: Option<PathBuf>,
    /// The chat whose turn asks (nightshift backlog 159, A2): with two
    /// chats running, the card belongs in that chat's pane. Only the
    /// agent engine's deferred calls name one; the API engine's prompts
    /// are the open chat's.
    #[serde(skip_serializing_if = "Option::is_none")]
    chat: Option<&'a str>,
}

/// A `turn-event` with the chat it belongs to (nightshift backlog 159,
/// A2): the event's own fields, plus `chat`. Two chats may stream at once,
/// and the window routes each event to its chat's pane by this.
#[derive(Serialize, Clone)]
struct ChatEvent<'a> {
    chat: &'a str,
    #[serde(flatten)]
    event: &'a TurnEvent,
}

impl<'a> ChatEvent<'a> {
    fn new(chat: &'a str, event: &'a TurnEvent) -> Self {
        Self { chat, event }
    }
}

/// A running agent turn's Stop token, registered by chat for as long as
/// the turn runs (nightshift backlog 159, A2).
struct TurnStop<'a> {
    map: &'a std::sync::Mutex<HashMap<String, CancellationToken>>,
    chat: String,
}

impl<'a> TurnStop<'a> {
    fn register(
        map: &'a std::sync::Mutex<HashMap<String, CancellationToken>>,
        chat: &str,
        token: &CancellationToken,
    ) -> Self {
        map.lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(chat.to_string(), token.clone());
        Self {
            map,
            chat: chat.to_string(),
        }
    }
}

/// The window's name for a turn whose chat it may not know yet (backlog
/// 159, A3): `turn:` and a nonce, sent with the turn and with its Stop.
fn is_turn_key(name: &str) -> bool {
    name.starts_with("turn:")
}

/// Whether a Stop for `key` came before its turn registered; forgets it.
fn take_early_stop(stops: &std::sync::Mutex<std::collections::HashSet<String>>, key: &str) -> bool {
    stops.lock().unwrap_or_else(|p| p.into_inner()).remove(key)
}

/// Hold a Stop for a turn key no turn has registered yet. Bounded: a key
/// whose turn never came (the send failed first) must not pile up.
fn hold_early_stop(stops: &std::sync::Mutex<std::collections::HashSet<String>>, key: &str) {
    let mut held = stops.lock().unwrap_or_else(|p| p.into_inner());
    if held.len() >= 32 {
        held.clear();
    }
    held.insert(key.to_string());
}

/// A running turn's inbox in [`AppState::inboxes`] for the turn's length
/// (backlog 328), removed when the guard drops.
struct InboxReg<'a> {
    map: &'a std::sync::Mutex<HashMap<String, nightloom_service::agent::inbox::Inbox>>,
    names: Vec<String>,
}

impl<'a> InboxReg<'a> {
    fn register(
        map: &'a std::sync::Mutex<HashMap<String, nightloom_service::agent::inbox::Inbox>>,
        names: Vec<String>,
        inbox: &nightloom_service::agent::inbox::Inbox,
    ) -> Self {
        let mut m = map.lock().unwrap_or_else(|p| p.into_inner());
        for n in &names {
            m.insert(n.clone(), inbox.clone());
        }
        drop(m);
        Self { map, names }
    }
}

impl Drop for InboxReg<'_> {
    fn drop(&mut self) {
        let mut m = self.map.lock().unwrap_or_else(|p| p.into_inner());
        for n in &self.names {
            m.remove(n);
        }
    }
}

impl Drop for TurnStop<'_> {
    fn drop(&mut self) {
        self.map
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&self.chat);
    }
}

impl WindowApprover {
    /// Resolve one pending prompt. Unknown ids are ignored rather than
    /// erroring: a decision arriving after the turn was cancelled is a race
    /// the UI cannot avoid, not a bug to report.
    fn resolve(&self, id: &str, decision: Decision) {
        if let Some(tx) = self.pending.lock().unwrap().remove(id) {
            let _ = tx.send(decision);
        }
    }

    /// Refuse everything still waiting. Called on cancel so an interrupted
    /// turn does not leave prompts on screen that can no longer do anything.
    fn deny_all(&self, reason: &str) {
        let pending: Vec<_> = self.pending.lock().unwrap().drain().collect();
        for (_, tx) in pending {
            let _ = tx.send(Decision::Deny(reason.to_string()));
        }
    }
}

#[async_trait::async_trait]
impl Approver for WindowApprover {
    async fn approve(&self, call: &PendingCall<'_>) -> Decision {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.pending.lock().unwrap().insert(call.id.to_string(), tx);
        // The running provider turn's chat (A4), when it has one, and its
        // own Stop token (A4 review) — the shared one only before it is
        // named, which no tool call precedes.
        let (chat, own) = match &*self.turn.lock().unwrap_or_else(|p| p.into_inner()) {
            Some(run) => (
                Some(run.chat.clone()).filter(|c| !c.is_empty()),
                run.cancel.clone(),
            ),
            None => (None, None),
        };
        let token = own.unwrap_or_else(|| self.cancel.lock().unwrap().clone());
        if self
            .app
            .emit(
                "tool-approval",
                ApprovalRequest {
                    id: call.id,
                    name: call.name,
                    input: call.input,
                    effect: call.effect,
                    outside: None,
                    chat: chat.as_deref(),
                },
            )
            .is_err()
        {
            // No window to ask. Denying is the only safe reading: the
            // alternative is running a mutating tool because the UI failed.
            self.pending.lock().unwrap().remove(call.id);
            return Decision::Deny("the app could not show an approval prompt".into());
        }
        tokio::select! {
            _ = token.cancelled() => {
                self.pending.lock().unwrap().remove(call.id);
                Decision::Deny("the turn was interrupted before this was approved".into())
            }
            answer = rx => answer.unwrap_or_else(|_| {
                Decision::Deny("the approval prompt was dismissed".into())
            }),
        }
    }
}

#[derive(Serialize)]
struct ProviderInfo {
    kind: String,
    available: bool,
    default_model: Option<String>,
    /// Where the key that would be used comes from: "stored" (entered in the
    /// app, OS credential store) or "env"; absent when there is no key.
    key_source: Option<KeySource>,
}

#[derive(Serialize)]
struct ConnectedInfo {
    provider: String,
    model: String,
    /// The model's context window, or `None` when the limits table doesn't
    /// know it — the UI gauge then shows a raw token count instead of a
    /// percentage rather than implying headroom nobody verified.
    context_limit: Option<u64>,
    /// The resolved workspace root, so the UI can show where the file tools
    /// actually point rather than leaving the user to guess.
    workspace: String,
    /// What this model charges, for the cost readout. `None` for a model with
    /// no verified price, which the UI shows as no dollar figure at all — a
    /// "$0.00" would read as free rather than as unknown.
    price: Option<Price>,
    /// MCP servers configured for this workspace, including ones that failed.
    mcp: Vec<McpServerInfo>,
    /// The models available to the `review` tool as a second opinion, empty
    /// when this machine has credentials for only one provider. Echoed so the
    /// rail can say which they are: a review is a call against another vendor,
    /// and "off because there is no second key" is not something the user can
    /// work out from a tool that simply never gets used.
    reviewers: Vec<ReviewerInfo>,
    /// The project this connection is filed under, echoed back so the UI's
    /// notion of "open project" and the backend's cannot drift apart.
    project: Option<ProjectInfo>,
    /// Which search provider `web_search` will query, or `None` when no key
    /// is set and the tool is therefore absent. Echoed for the same reason
    /// `reviewers` is: a model that cannot search does not announce it, it
    /// simply guesses, and the user has no way to tell those apart.
    search: Option<String>,
    /// The knowledge vault this connection can reach, or `None` when the
    /// switch is off. Echoed for the same reason `search` is: a folder the
    /// model is quietly reading — or quietly not reading — is not something
    /// the user can work out from the transcript.
    knowledge: Option<KnowledgeInfo>,
    /// Which engine is behind this connection: `provider` or `claude-code`.
    ///
    /// The UI needs it for more than a label. Half the controls above the
    /// transcript act on the session log, and in agent mode the log is a
    /// record of a conversation kept somewhere else — so rewinding or
    /// compacting it would change what the window shows and nothing about
    /// what the next turn actually replays.
    engine: String,
    /// Present only on the agent engine, and then it carries the facts the
    /// rail has no other way to learn: which binary answered, what version
    /// it is, and whether the turn will be billed to the plan or to a key.
    agent: Option<AgentInfo>,
    /// The extra folders this connection may reach beyond the workspace
    /// (nightshift backlog 143): the project's and the chat's own, each with
    /// where it came from and — on the API engine — the `@alias` the tools
    /// spell it by. Empty when none is granted.
    folders: Vec<FolderInfo>,
}

/// One extra folder as the rail and the Context popover show it.
#[derive(Serialize, Clone)]
struct FolderInfo {
    path: String,
    /// `project` or `chat` — which grant it came from; a folder granted
    /// both ways reads `project`.
    source: String,
    /// `@name`, on the API engine; `None` on the CLI, whose tools take the
    /// absolute path (`--add-dir`).
    alias: Option<String>,
}

/// The extra folders a chat sees: the project's, then the chat's own, each
/// once, missing ones dropped — a grant on a folder that is gone is not a
/// tree the tools can be rooted at, and the rail says so by leaving it out.
fn extra_folders(
    project: Option<&Project>,
    session: Option<&Session>,
) -> Vec<(PathBuf, &'static str)> {
    existing_folders(folder_candidates(project, session))
}

/// The folders [`extra_folders`] would check, read without touching the
/// disk: the project's home, then the project's and the chat's folders in
/// order (nightshift item 261). Split out so `connect_agent` can ask the
/// disk on a blocking thread — a stat on a stalled volume (iCloud; on
/// 2026-09-28 `list_projects` took 36 s at the same moment) held the
/// connect's runtime thread for 35 s, where no deadline can fire.
type FolderCandidates = (Option<PathBuf>, Vec<(PathBuf, &'static str)>);

fn folder_candidates(project: Option<&Project>, session: Option<&Session>) -> FolderCandidates {
    let home = project.map(Project::workspace_dir);
    let mut all: Vec<(PathBuf, &'static str)> = Vec::new();
    if let Some(p) = project {
        all.extend(p.extra_folders.iter().map(|f| (f.clone(), "project")));
    }
    if let Some(s) = session {
        all.extend(s.folders().iter().map(|f| (f.clone(), "chat")));
    }
    (home, all)
}

/// The disk half of [`extra_folders`]: each candidate once, not the home,
/// and only if it is a folder now.
fn existing_folders((home, candidates): FolderCandidates) -> Vec<(PathBuf, &'static str)> {
    let mut out: Vec<(PathBuf, &'static str)> = Vec::new();
    for (f, source) in candidates {
        if home.as_ref() == Some(&f) || out.iter().any(|(p, _)| *p == f) || !f.is_dir() {
            continue;
        }
        out.push((f, source));
    }
    out
}

/// Every tree a Claude Code chat's tools may open without a prompt: the
/// working directory and each `--add-dir` (the vault, the extra folders,
/// a folder the card granted this turn). What a path is measured against
/// to be *outside* (backlog 143, pass 2).
fn agent_trees(agent: &ClaudeCodeAgent) -> Vec<PathBuf> {
    let spec = agent.spec();
    let mut trees = vec![spec.workspace.clone()];
    trees.extend(spec.add_dirs.iter().cloned());
    trees
}

/// The agent engine as the rail shows it.
#[derive(Serialize, Clone)]
struct AgentInfo {
    binary: String,
    /// What `--version` printed. Probed at connect rather than assumed,
    /// because "the binary is on PATH" and "the binary runs" are different
    /// facts and only the second one matters here.
    version: Option<String>,
    /// `ANTHROPIC_API_KEY` is withheld from the child, so the turn goes to
    /// the subscription. False means an inherited key may silently bill the
    /// API instead — which is the whole failure this engine exists to avoid,
    /// and it is invisible in the transcript, so the rail says it out loud.
    subscription: bool,
    /// `auto` or `bypassPermissions`, or `None` when tools are off.
    ///
    /// Nightloom's own approval gate does not apply on this engine: the loop
    /// is Claude Code's and the prompt would have nobody to ask, headless.
    /// Naming the mode is what stops the familiar switch implying the
    /// familiar gate.
    permission_mode: Option<String>,
    /// The CLI ran without the host's CLAUDE.md, hooks, plugins and MCP
    /// servers — Nightloom's own server excepted. Spelled as no setting
    /// sources plus `--strict-mcp-config` since 2026-09-14 (`AgentSpec::
    /// safe_mode` has the measurements; `--safe-mode` itself dropped
    /// Nightloom's server), and never `--bare`: bare mode never reads
    /// OAuth credentials, so it would force the run back onto an API key.
    safe_mode: bool,
    /// `--effort` as sent, or `None` for the CLI's default (nightshift
    /// backlog 076); shown on the Context page's session line.
    effort: Option<String>,
    /// `--fallback-model` as sent, or `None` for no fallback.
    fallback_model: Option<String>,
    /// The agent session this chat continues, when it has one — read back
    /// off the log, so reopening a chat tomorrow resumes it rather than
    /// starting a fresh one behind an unchanged transcript.
    resume: Option<String>,
}

/// A reviewer as the rail shows it: the name the model asks for, and the
/// model actually behind it. Both, because the name is what appears in a tool
/// chip mid-turn and the model is what the user is choosing to pay for.
#[derive(Serialize)]
struct ReviewerInfo {
    name: String,
    model: String,
}

/// Run synchronous filesystem work off the runtime, reporting its error as a
/// string the way every command here does.
///
/// A Tauri command is a future on the shared runtime: work that blocks in one
/// blocks a thread that a streaming turn is also using. Anything that walks a
/// directory of session logs belongs here.
async fn blocking<T, E, F>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, E> + Send + 'static,
    T: Send + 'static,
    E: std::fmt::Display + Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(out) => out.map_err(|e| e.to_string()),
        Err(e) => Err(format!("the file system task did not finish: {e}")),
    }
}

// ---- projects ----------------------------------------------------------

// ---- the usage ledger ------------------------------------------------------

// ---- notes: the docspace and the vault ---------------------------------

// ---- the dream -----------------------------------------------------------

// ---- the capture pass ------------------------------------------------------

/// Migrate a project's pre-move `.nightloom/` and say so if anything moved.
///
/// A toast rather than silence, unlike the unfiled chats: this one touches
/// files inside a folder the user chose, and moving somebody's notes without
/// mentioning it is not a thing to do quietly even when it is the right move.
fn announce_migration(app: &AppHandle, project: &Project) {
    let Some(root) = &project.workspace else {
        return;
    };
    if let Some(line) = project::migrate(root).summary() {
        let _ = app.emit("turn-notice", format!("{}: {line}", project.name));
    }
}

/// Move unfiled session logs out of the OS app-data dir into `~/.nightloom`.
///
/// Deliberately thinner than `project::migrate`: there is one flat directory
/// of `.jsonl` files and no configuration mixed in with them, so the whole
/// job is "move what is not already there". Silent, because it runs before a
/// window exists to say anything in, and because a user who never used the
/// old location has nothing to be told.
///
/// `store`'s cached listing rides along with everything else, which is both
/// harmless and worth having: a move keeps each log's size and mtime, so the
/// entries still validate at the new address and a thousand imported chats do
/// not all have to be read again on the first listing after the move. If
/// anything about that fails to hold, the listing rebuilds itself.
fn adopt_unfiled(from: &Path, to: &Path) {
    let Ok(entries) = std::fs::read_dir(from) else {
        return;
    };
    if std::fs::create_dir_all(to).is_err() {
        return;
    }
    for entry in entries.flatten() {
        let source = entry.path();
        if !source.is_file() {
            continue;
        }
        let Some(name) = source.file_name() else {
            continue;
        };
        let target = to.join(name);
        if target.exists() {
            continue;
        }
        // Same fallback as `project::migrate`, and for the same reason: the
        // app-data dir and the home dir are routinely on different volumes.
        if std::fs::rename(&source, &target).is_err() && std::fs::copy(&source, &target).is_ok() {
            let _ = std::fs::remove_file(&source);
        }
    }
    let _ = std::fs::remove_dir(from);
}

/// The window, built here rather than declared in `tauri.conf.json`.
///
/// What it should be differs per platform and the config file has no way to
/// say so. Windows and Linux get **no system frame at all** — the title bar is
/// ours, drawn in the webview, so the app looks like one thing rather than a
/// dark app wearing a light-grey caption strip.
///
/// **macOS keeps its frame, whole and untouched**, and that is the opposite
/// of what it looked like it should get. The obvious move there is the one
/// every modern Mac app makes — hide the title and overlay the traffic lights
/// on our own bar (`TitleBarStyle::Overlay` + `hidden_title`) — and it was
/// tried and reverted, because a window zoomed with it on leaves a strip of
/// the desktop showing above the content: the frame's height comes out of the
/// window and nothing fills it. A sliver of somebody's wallpaper along the top
/// edge is a worse failure than a system title bar, which is at least what the
/// platform looks like. So macOS is *native*, and what would have gone in a
/// bar of ours goes in [`mac_menu`] instead — the menu bar at the top of the
/// screen is where a Mac user looks for an app's commands anyway, and it is
/// the one piece of chrome that already melds with the notch.
///
/// Declaring `decorations: false` in the config and undoing it here for macOS
/// was the other reading and it is worse in both directions: there is no
/// runtime setter for the macOS title-bar style, so that platform would get a
/// full system caption bar *above* ours, and the platform this exists for
/// would show a system frame for however many frames the setup hook takes.
/// The main window's timer policy (backlog 535): never throttled. A debug
/// build with `NIGHTLOOM_THROTTLE=default` keeps WebKit's own policy, for
/// measuring what the page's timers do without it.
fn throttling_policy() -> tauri::utils::config::BackgroundThrottlingPolicy {
    use tauri::utils::config::BackgroundThrottlingPolicy as P;
    if cfg!(debug_assertions) && std::env::var("NIGHTLOOM_THROTTLE").as_deref() == Ok("default") {
        P::Suspend
    } else {
        P::Disabled
    }
}

fn build_window(app: &tauri::App) -> tauri::Result<()> {
    #[allow(unused_mut)]
    let mut win = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
        .title("Nightloom")
        .inner_size(1150.0, 780.0)
        .min_inner_size(700.0, 500.0)
        // Tauri's OS-level file-drop handler otherwise swallows a drop before
        // the webview sees an HTML5 `drop` event, and the composer takes
        // attachments by drop. On Windows, disabling it is the documented
        // requirement; paste works either way, which is what makes the
        // omission easy to miss.
        .disable_drag_drop_handler()
        // Backlog 535: the page's timers keep their pace while the window
        // is hidden, covered or minimized (WKWebView's
        // `inactiveSchedulingPolicy = none`, macOS 14+) — a scheduled send
        // and a turn's bookkeeping must not wait for him to look. The
        // clock itself is `wake.rs`; this is the second line.
        .background_throttling(throttling_policy())
        // Exact, synchronous, and available before the first paint — which a
        // command could not be. The title bar reads it to decide whether it
        // draws window buttons or leaves room for the traffic lights, and a
        // bar that laid itself out twice would flicker on every launch.
        .initialization_script(format!(
            "globalThis.__NIGHTLOOM_PLATFORM__ = {:?};",
            std::env::consts::OS
        ));

    // tao keeps `WS_THICKFRAME` on a borderless window, so the resize border,
    // the drop shadow and the maximize-without-covering-the-taskbar case all
    // still come from the system on Windows. GTK gives no such thing, which
    // is why the bar supplies its own resize edges on Linux.
    #[cfg(not(target_os = "macos"))]
    {
        win = win.decorations(false);
    }
    // Built hidden for a debug live test (backlog 339): `offscreen::apply`
    // moves it off screen before it is ever ordered in.
    if offscreen::on() {
        win = win.visible(false).focused(false);
    }

    // Item 622b: the web view's creation in the startup log — stamped when the
    // build began, its time how long the build took — so the ~2 s before the
    // window's first script line (`bootMark.ts`) can be split.
    let started = std::time::Instant::now();
    win.build()?;
    startup_log::mark("webview_created", started);
    Ok(())
}

/// The macOS menu bar.
///
/// It exists because macOS is the one platform here with no title bar of ours
/// to hang anything on, and because it is where the commands belong on that
/// platform regardless: ⌘, opens settings in every Mac app, and a user who
/// reaches for it and finds nothing has learned that this is a port.
///
/// Nothing here is decoration. Tauri installs a default menu on macOS when an
/// app sets none, and it is not enough on either count — it has no Settings
/// item, and its File menu can only close the window. The **Edit** submenu is
/// the one that has to be here whatever else is: a webview on macOS takes ⌘C
/// and ⌘V from the menu, so an app that replaces the default menu without it
/// silently breaks copy and paste in every text box it has.
///
/// The custom items (the original four, and the redesign's eight since
/// 2026-09-13) are *forwarded to the webview* rather than performed here (see
/// [`mac_menu_event`]). Each one is a frontend flow — a modal, a
/// file dialog, a re-connect — and the backend has no way to run half of one.
#[cfg(target_os = "macos")]
fn mac_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder};

    let pkg = app.package_info();
    let about = AboutMetadata {
        name: Some(pkg.name.clone()),
        version: Some(pkg.version.to_string()),
        ..Default::default()
    };

    // Accelerators parse leniently — an unrecognized one is dropped rather
    // than refused — so these are the spellings muda documents, not guesses.
    let settings = MenuItemBuilder::with_id("settings", "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;
    // The two kinds of chat (nightshift backlog 102, 2026-09-16, his
    // review of boards 8a/8b): ⌘N is a Claude Code chat — the folder, every
    // tool — and ⌥⌘N a Chat, reads only and no folder. ⌥⌘N was free:
    // blocker 035's table and the app carry no Option chord. The sidebar's
    // wide button makes the project's default kind; these two are fixed.
    let new_chat = MenuItemBuilder::with_id("new_build", "New Claude Code Chat")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let new_talk = MenuItemBuilder::with_id("new_talk", "New Chat")
        .accelerator("CmdOrCtrl+Alt+N")
        .build(app)?;
    // The two other kinds of chat (nightshift backlog 059, 2026-09-15),
    // beside the ordinary one wherever it is offered. ⌘⇧N for the default
    // he asked for; ephemeral has no key, the same way New project has none.
    let new_incognito = MenuItemBuilder::with_id("new_incognito", "New Incognito Chat")
        .accelerator("CmdOrCtrl+Shift+N")
        .build(app)?;
    let new_ephemeral =
        MenuItemBuilder::with_id("new_ephemeral", "New Ephemeral Chat").build(app)?;
    // New project is a form (backlog 047, 2026-09-14) and Open project the
    // folder picker it used to be. No accelerator on New: the chord set is
    // blocker 035/043's, and ⌘P's N reaches it.
    let new_project = MenuItemBuilder::with_id("new_project", "New Project…").build(app)?;
    let add_project = MenuItemBuilder::with_id("add_project", "Open Project…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let import = MenuItemBuilder::with_id("import_claude", "Import from claude.ai…").build(app)?;

    // Tabs (nightshift backlog 099, 2026-09-17; board 9d): ⌘T a new tab,
    // ⌘W the tab — *in place of* the predefined Close Window, which the OS
    // performed itself before its id could reach the webview; the window
    // now closes from its traffic light only (blocker 183). ⌘⇧] / ⌘⇧[
    // step across both panes; Open Beside splits the active tab off into
    // a second pane, no key. All forwarded like the rest; `runMenuCommand`
    // acts on each. ⌘T was free; ⌘⇧T is the thinking toggle, bound in the
    // window and untouched.
    let new_tab = MenuItemBuilder::with_id("new_tab", "New Tab")
        .accelerator("CmdOrCtrl+T")
        .build(app)?;
    let close_tab = MenuItemBuilder::with_id("close_tab", "Close Tab")
        .accelerator("CmdOrCtrl+W")
        .build(app)?;
    let next_tab = MenuItemBuilder::with_id("next_tab", "Next Tab")
        .accelerator("CmdOrCtrl+Shift+]")
        .build(app)?;
    let prev_tab = MenuItemBuilder::with_id("prev_tab", "Previous Tab")
        .accelerator("CmdOrCtrl+Shift+[")
        .build(app)?;
    let split_tab = MenuItemBuilder::with_id("split_tab", "Open Beside").build(app)?;

    // The chat-surface redesign's set (nightshift blocker 035, 2026-09-13):
    // the popover, the two palettes, the engine toggle, and one key per core
    // model. Forwarded like the four above; `runMenuCommand` acts on each.
    // ⌘⇧S is free in this app — there is no Save As.
    // Context left the popover for its own button under the top bar's
    // gauge (review round 1, 2026-09-13), with ⌘⇧C to open it from anywhere.
    let model = MenuItemBuilder::with_id("model", "Model && Tasks")
        .accelerator("CmdOrCtrl+M")
        .build(app)?;
    let context = MenuItemBuilder::with_id("context", "Context")
        .accelerator("CmdOrCtrl+Shift+C")
        .build(app)?;
    let commands = MenuItemBuilder::with_id("commands", "Command Palette…")
        .accelerator("CmdOrCtrl+K")
        .build(app)?;
    let projects = MenuItemBuilder::with_id("projects", "Switch Project…")
        .accelerator("CmdOrCtrl+P")
        .build(app)?;
    let engine = MenuItemBuilder::with_id("engine", "Switch Engine (Provider ⇄ Claude Code)")
        .accelerator("CmdOrCtrl+E")
        .build(app)?;
    // ⌘. stops the running turn (nightshift item 398, blocker 1506 — his
    // yes, 2026-10-19), the composer's Stop by key. Always enabled: with no
    // turn running `runMenuCommand` does nothing, and an aside's box with
    // the keyboard stops its own answer instead (Composer's interceptor).
    let stop_turn = MenuItemBuilder::with_id("stop_turn", "Stop")
        .accelerator("CmdOrCtrl+.")
        .build(app)?;
    // Whole-app zoom (nightshift backlog 108): ⌘= is the key Chrome binds
    // Zoom In to (⌘+ needs Shift on a US layout; `zoom.ts` takes that one
    // too, since it is not a menu item), ⌘− out, ⌘0 back to 100 %. The
    // ids reach `zoom.ts` as `menu` events, not `runMenuCommand`.
    let zoom_in = MenuItemBuilder::with_id("zoom_in", "Zoom In")
        .accelerator("CmdOrCtrl+=")
        .build(app)?;
    let zoom_out = MenuItemBuilder::with_id("zoom_out", "Zoom Out")
        .accelerator("CmdOrCtrl+-")
        .build(app)?;
    let zoom_reset = MenuItemBuilder::with_id("zoom_reset", "Actual Size")
        .accelerator("CmdOrCtrl+0")
        .build(app)?;
    let sonnet = MenuItemBuilder::with_id("model_sonnet", "Sonnet (Claude Code)")
        .accelerator("CmdOrCtrl+Shift+S")
        .build(app)?;
    let opus = MenuItemBuilder::with_id("model_opus", "Opus (Claude Code)")
        .accelerator("CmdOrCtrl+Shift+O")
        .build(app)?;
    let fable = MenuItemBuilder::with_id("model_fable", "Fable (Claude Code)")
        .accelerator("CmdOrCtrl+Shift+F")
        .build(app)?;
    let haiku = MenuItemBuilder::with_id("model_haiku", "Haiku (Claude Code)")
        .accelerator("CmdOrCtrl+Shift+H")
        .build(app)?;

    let app_menu = SubmenuBuilder::new(app, pkg.name.clone())
        .about(Some(about))
        .separator()
        .item(&settings)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file = SubmenuBuilder::new(app, "File")
        .item(&new_chat)
        .item(&new_talk)
        .item(&new_incognito)
        .item(&new_ephemeral)
        .separator()
        .item(&new_project)
        .item(&add_project)
        .item(&import)
        .separator()
        .item(&new_tab)
        .item(&close_tab)
        .build()?;

    // Undo and Redo are ours since 2026-09-15 (nightshift backlog 064),
    // not the OS's predefined pair: the app has an undo stack of its own —
    // a rewind, a removal, an edit, a rename, a delete, a layer — and a
    // predefined item is validated by the first responder, which would
    // leave it disabled whenever no text field had history, and pointed at
    // the composer's typing whenever one did. These two are forwarded like
    // every custom item; the frontend decides what ⌘Z means from where the
    // focus is (a text field keeps its own history through the webview's
    // `execCommand`), and `set_undo_menu` retitles and enables them live.
    // Enabled from the start so copy-paste-undo in a text box works before
    // the frontend has said anything.
    let undo = MenuItemBuilder::with_id(UNDO_MENU_ID, "Undo")
        .accelerator("CmdOrCtrl+Z")
        .build(app)?;
    // ⌘Y, not ⌘⇧Z: his ask (2026-09-16, "make it command Y for redo").
    // As a menu accelerator it reaches a text box too, where the window
    // handler steps aside; ⌘⇧Z stays as a second spelling in `App.svelte`.
    let redo = MenuItemBuilder::with_id(REDO_MENU_ID, "Redo")
        .accelerator("CmdOrCtrl+Y")
        .build(app)?;

    // ⌘F as a menu item since backlog 172 pass 2: a web tab's page holding
    // the keyboard sends an unhandled ⌘F to the menu and nowhere else, so
    // this is how it finds in the page (`webtab::menu_route`). With the
    // main page focused the frontend's ⌘F (the find bar, backlog 106) runs
    // as before and ignores this id.
    let find = MenuItemBuilder::with_id(webtab::MENU_FIND, "Find…")
        .accelerator("CmdOrCtrl+F")
        .build(app)?;

    let edit = SubmenuBuilder::with_id(app, EDIT_MENU_ID, "Edit")
        .item(&undo)
        .item(&redo)
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&find)
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&model)
        .item(&context)
        .item(&commands)
        .item(&projects)
        .separator()
        .item(&engine)
        .item(&stop_turn)
        .separator()
        .item(&next_tab)
        .item(&prev_tab)
        .item(&split_tab)
        .separator()
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&zoom_reset)
        .separator()
        .fullscreen()
        .build()?;

    // One key per core model, switching the picker in place from any screen.
    // The letters are the Claude Code engine's aliases (2026-09-14); on the
    // API engine the picker's models are ⌘⇧1…9, bound in App.svelte since the
    // list is dynamic, and these four items decline with a toast saying so.
    let model_menu = SubmenuBuilder::new(app, "Model")
        .item(&sonnet)
        .item(&opus)
        .item(&fable)
        .item(&haiku)
        .build()?;

    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .bring_all_to_front()
        .build()?;

    MenuBuilder::new(app)
        .items(&[&app_menu, &file, &edit, &view, &model_menu, &window])
        .build()
}

/// The Edit menu's ids the frontend and [`set_undo_menu`] agree on.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const EDIT_MENU_ID: &str = "edit";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const UNDO_MENU_ID: &str = "undo_app";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const REDO_MENU_ID: &str = "redo_app";

/// Hands a menu click to the webview as a `menu` event carrying the item's id.
///
/// Predefined items (quit, copy, minimize) are performed by the OS and arrive
/// here too; the frontend ignores every id it does not know, which is also
/// what makes adding an item a one-line change on each side.
#[cfg(target_os = "macos")]
fn mac_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    // Undo, Redo and Find while a web tab's page has the keyboard act on
    // the page (backlog 172 pass 2).
    if webtab::menu_route(app, event.id().0.as_str()) {
        return;
    }
    let _ = app.emit("menu", event.id().0.as_str());
}

/// Say why the app will not open (the home is held by `nightloom serve`)
/// and exit: an alert on macOS, since there is no window yet to put it in,
/// and stderr everywhere.
fn refuse_to_open(why: &str) {
    eprintln!("nightloom-desktop: {why}");
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "display alert \"Nightloom cannot open\" message {:?}",
            why.replace('"', "'")
        );
        let _ = std::process::Command::new("osascript")
            .args(["-e", &script])
            .status();
    }
}

fn main() {
    // The startup log's clock (item 220): every line's `+N ms` counts from here.
    startup_log::mark_launch();
    // Item 486: every panic is written to `~/.nightloom/logs/panic.log`;
    // a Finder-launched app's stderr goes nowhere.
    panic_log::install();
    // `nightloom-desktop --mcp-serve [--project <id>]`: this binary as an
    // MCP server on stdio, for the Claude Code engine. The app's `connect_agent`
    // hands `claude -p` a `--mcp-config` naming `current_exe()` with these
    // arguments, because this is the one binary the app can always find —
    // the CLI is not on PATH on most machines that have the app. Handled
    // before Tauri builds anything: a server that opened a window, or that
    // Tauri parsed the flag of, would be neither. The server runs on a
    // runtime of its own and returns at EOF, which is how the CLI ends it.
    let argv: Vec<String> = std::env::args().skip(1).collect();
    if argv.first().map(String::as_str) == Some("--mcp-serve") {
        if let Err(e) = nightloom_service::mcp_server::run_blocking(&argv[1..]) {
            eprintln!("nightloom-desktop --mcp-serve: {e}");
            std::process::exit(1);
        }
        return;
    }
    // `nightloom-desktop --permission-hook <dir>`: this binary as the CLI's
    // `PreToolUse` hook for a chat in the Ask position (2026-09-16,
    // nightshift backlog 084). Reads the call from stdin, answers from the
    // chat's ask directory, prints one line — `agent::ask::run_hook`. The
    // same reason as `--mcp-serve` for living here: the CLI spawns whatever
    // path it was given, and this binary is the one that is always present.
    if argv.first().map(String::as_str) == Some("--permission-hook") {
        if let Err(e) = nightloom_service::agent::ask::run_hook(&argv[1..]) {
            eprintln!("nightloom-desktop --permission-hook: {e}");
            std::process::exit(1);
        }
        return;
    }
    // `nightloom-desktop --subagent-hook <dir>`: the `PreToolUse` hook on
    // the `Agent` tool that puts the chat's brief in front of every
    // subagent's task (2026-09-17, nightshift backlog 152;
    // `agent::brief::run_hook`). Same reason for living here.
    if argv.first().map(String::as_str) == Some("--subagent-hook") {
        if let Err(e) = nightloom_service::agent::brief::run_hook(&argv[1..]) {
            eprintln!("nightloom-desktop --subagent-hook: {e}");
            std::process::exit(1);
        }
        return;
    }

    // The one-holder rule (nightshift item 268, step 1): the desktop and
    // `nightloom serve` never both hold one Nightloom home's chats. Each
    // takes `<config>/holder.lock` for its life; while `serve` holds it
    // the app says so and does not open. Kept in a `let` for the whole of
    // `main`, so the lock lives as long as the app.
    let _holder = match project::config_dir() {
        Some(config) => {
            match nightloom_service::serve::HomeLock::take(&config, "the Nightloom desktop app") {
                Ok(lock) => Some(lock),
                Err(e) => {
                    refuse_to_open(&e);
                    return;
                }
            }
        }
        None => None,
    };

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init());

    // Only on macOS. On Windows and Linux a menu is drawn *inside* the window,
    // under a caption bar this app no longer has — it would be a grey strip
    // across the top of a themed window, which is the thing the borderless
    // frame exists to be rid of. Those platforms have the title bar's own gear
    // instead.
    #[cfg(target_os = "macos")]
    {
        builder = builder.menu(mac_menu).on_menu_event(mac_menu_event);
    }

    builder
        .setup(|app| {
            // Item 486: an exception AppKit raises while dispatching an event
            // is logged instead of aborting the app through tao's `extern "C"`
            // `sendEvent:` (the 11:27 AM 2026-10-30 crash).
            #[cfg(target_os = "macos")]
            {
                let what = event_guard::install();
                eprintln!("event guard: {what}");
            }
            // A chat's preview (nightshift item 430): served from the start.
            preview::setup(app.handle());
            // Claude's browser (nightshift item 508): nothing starts until
            // a chat's Playwright call runs.
            claude_browser::setup(app.handle());
            // The Mac's activity, watched while the app runs: ends a chat's
            // Continue anyway at the 85 % line after 10 minutes away
            // (nightshift backlog 192).
            nightloom_service::agent::brief::spawn_activity_watch();
            // Item 231: pay the OS's first run of the CLI now, in the
            // background, rather than inside the window's first connect.
            tauri::async_runtime::spawn(connect_deadline::warm(
                connect_deadline::probe_cache_path(),
                AGENT_BINARY.to_string(),
                |b: String| async move { agent_version(&b).await },
            ));
            // Item 256: and the binary it hands the CLI as its MCP server
            // and hooks — this one — run once the way the CLI runs it.
            if let Ok(exe) = std::env::current_exe() {
                tauri::async_runtime::spawn(connect_deadline::warm_hook(
                    exe,
                    connect_deadline::log_path(),
                ));
            }
            // App-data is now the *previous* home for unfiled chats, kept
            // only long enough to move them. A user who has been running this
            // app has a sidebar full of them, and a release that silently
            // emptied it would read as data loss whatever the changelog said.
            let legacy_unfiled = app.path().app_data_dir()?.join("sessions");
            let default_log_dir = project::config_dir()
                .map(|home| home.join("unfiled").join(project::SESSIONS_DIR))
                .unwrap_or_else(|| legacy_unfiled.clone());
            if default_log_dir != legacy_unfiled {
                adopt_unfiled(&legacy_unfiled, &default_log_dir);
            }
            let cancel = Arc::new(std::sync::Mutex::new(CancellationToken::new()));
            let gate = Arc::new(WindowApprover {
                app: app.handle().clone(),
                cancel: cancel.clone(),
                pending: std::sync::Mutex::new(HashMap::new()),
                turn: std::sync::Mutex::new(None),
            });
            app.manage(AppState {
                chat: tokio::sync::Mutex::new(None),
                agents: agents::Agents::default(),
                agent_live: std::sync::atomic::AtomicBool::new(false),
                turn_cancels: std::sync::Mutex::new(HashMap::new()),
                inboxes: std::sync::Mutex::new(HashMap::new()),
                early_stops: std::sync::Mutex::new(std::collections::HashSet::new()),
                chats: chats::Chats::default(),
                pending_mode: tokio::sync::Mutex::new(ChatMode::Normal),
                pending_kind: tokio::sync::Mutex::new(ChatKind::Build),
                cancel,
                workspaces: tokio::sync::Mutex::new(Workspaces {
                    registry: Registry::load(),
                    // Nothing open at launch. The frontend reopens the last
                    // project if it had one, which keeps "which project was
                    // I in" a UI preference rather than a second source of
                    // truth beside the registry.
                    active: None,
                }),
                default_log_dir,
                // `AutoApprove` answers read-only and session-only calls
                // itself, so the window is only ever asked about calls that
                // can change something outside the conversation.
                approval: Arc::new(AutoApprove::new(gate.clone())),
                gate,
                ask: Arc::new(nightloom_service::agent::AskGate::new()),
                mcp: tokio::sync::Mutex::new(None),
                dreaming: tokio::sync::Mutex::new(()),
                dream_cancel: Arc::new(std::sync::Mutex::new(CancellationToken::new())),
                aside_cancel: Default::default(),
                prompt: tokio::sync::Mutex::new(PromptBuilt::default()),
            });
            // The Nightshift file watches, beside `AppState` rather than in it.
            app.manage(nightshift::Watches::default());
            app.manage(nightshift::PendingLaunches::default());
            app.manage(nightshift::Interviews::default());
            app.manage(prompt_hold::Pending::default());
            // The power assertion's holder and the wake watcher (nightshift
            // backlog 101). The holder has nothing to spawn until a turn
            // takes a guard; the watcher ticks every 30 s for the life of
            // the app.
            app.manage(power::Holder::default());
            power::watch_wake(app.handle().clone());
            // The schedule clock (backlog 535): Send later's and the limit
            // resume's times are kept here, not by the page's timers.
            app.manage(wake::Wakes::default());
            // Keep-warm (backlog 582): each switched-on chat's pings.
            app.manage(keep_warm::Holder::load());
            keep_warm::watch(app.handle().clone());
            wake::mark_launch();
            wake::watch(app.handle().clone());
            // A debug build's measurement of item 324's refit, only with
            // NIGHTLOOM_DEBUG_WEBVIEW_FIT=1; a release build never runs it.
            webview_fit::maybe_self_test(app.handle());
            // The phone page's host and relay (nightshift backlog 091): the
            // listener itself is off until Settings → Remote switches it on.
            remote::Remote::install(app.handle());
            // The away server's sync (item 268 step 3): off until a URL is set.
            away::start(app.handle());
            // The terminal pane's shells (nightshift backlog 113): none
            // open until the window asks; every one dies with the app.
            app.manage(terminal::Terminals::default());
            // Last, and that ordering is load-bearing rather than tidiness:
            // the webview starts loading the moment the window exists and its
            // first paint calls straight into `providers` and `list_sessions`,
            // which resolve `State<AppState>` and panic if nothing has managed
            // it yet.
            // A debug live test's off-screen window (backlog 339): no Dock
            // icon, no menu bar, never the active app — his screen untouched.
            #[cfg(target_os = "macos")]
            if offscreen::on() {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            }
            build_window(app)?;
            offscreen::apply(app.handle());
            // Quitting while work runs asks first (backlog 308): the
            // delegate's `applicationShouldTerminate:`, after tao set it.
            quit_guard::install(app.handle());
            Ok(())
        })
        // Wrapped (backlog 172): no app command answers a web tab's page.
        .invoke_handler(webtab::guard(tauri::generate_handler![
            commands::providers::providers,
            commands::providers::set_api_key,
            commands::providers::clear_api_key,
            commands::providers::search_backends,
            commands::providers::set_search_key,
            commands::providers::list_models,
            commands::providers::context_limits,
            draft_count::count_draft_tokens,
            commands::connect::connect,
            commands::agent::connect_agent,
            commands::sessions::list_sessions,
            commands::sessions::search_sessions,
            commands::sessions::search_everywhere,
            commands::sessions::rename_session,
            commands::sessions::new_session,
            commands::sessions::open_session,
            commands::sessions::peek_session,
            commands::sessions::transcript,
            commands::sessions::turn_session,
            commands::turns::send,
            commands::turns::send_agent,
            commands::attachments::prepare_office_attachment,
            commands::attachments::keep_attachment,
            commands::attachments::keep_in_folder,
            commands::attachments::keep_note_file,
            commands::attachments::unpack_zip,
            commands::attachments::office_converter,
            commands::attachments::pdf_pages,
            commands::attachments::stash_draft_file,
            commands::attachments::prune_draft_files,
            commands::attachments::read_draft_file,
            commands::turns::turn_timing_window,
            commands::turns::prewarm_agent,
            commands::usage::council_turns,
            commands::usage::provider_credits,
            commands::aside::ask_aside,
            commands::aside::cancel_aside,
            note_edit::edit_note_by_prompt,
            note_edit::cancel_note_edit,
            inbox_sort::inbox_sort_list,
            inbox_sort::inbox_sort_plan,
            inbox_sort::inbox_sort_cancel,
            inbox_sort::inbox_sort_apply,
            commands::turns::cancel,
            commands::turns::compact,
            commands::edits::rewind,
            commands::edits::unrewind,
            commands::edits::set_aside_files,
            commands::edits::edit_message,
            commands::edits::remove_message,
            commands::edits::restore_message,
            commands::edits::remove_block,
            commands::edits::restore_block,
            commands::edits::fork_session,
            keep_warm::keep_warm_set,
            keep_warm::keep_warm_hold,
            keep_warm::keep_warm_status,
            keep_warm::keep_warm_stop,
            keep_warm::keep_warm_default,
            keep_warm::keep_warm_set_default,
            commands::context::context_view,
            commands::context::edit_context,
            commands::context::prompt_layers,
            commands::context::set_prompt_layers,
            commands::chat::start_chat,
            commands::chat::can_send_in_chat,
            commands::chat::reserve_chat_agent,
            commands::chat::chat_home,
            commands::chat::arm_wake,
            commands::chat::schedule_log,
            commands::chat::schedule_probe,
            commands::chat::set_chat_kind,
            commands::chat::set_chat_folders,
            commands::threads::set_chat_thread,
            commands::threads::set_session_thread,
            commands::threads::list_threads,
            commands::threads::new_thread,
            commands::threads::rename_thread,
            commands::threads::delete_thread,
            commands::threads::reveal_thread,
            commands::threads::append_thread_log,
            commands::threads::save_thread_handoff,
            commands::threads::peek_thread_handoff,
            commands::threads::take_thread_handoff,
            commands::threads::thread_upkeep,
            commands::threads::tidy_threads,
            commands::chat::set_project_folders,
            commands::context::set_prompt_layer_text,
            commands::context::prompt_layer_file,
            commands::chat::voice_note_file,
            commands::chat::set_voice_note,
            commands::chat::cli_memory_file,
            commands::context::cli_prompt_snapshot,
            commands::context::start_context,
            commands::context::tool_result_images,
            commands::context::prompt_pending,
            commands::context::set_prompt_layer_choice,
            commands::edits::continue_session,
            commands::edits::continue_chat,
            commands::edits::idle_seconds,
            commands::edits::switch_subagents_same_to_choose,
            commands::sessions::delete_session,
            commands::sessions::move_session,
            commands::sessions::restore_session,
            commands::menu::set_undo_menu,
            commands::menu::paste_into_focus,
            quit_guard::set_running_work,
            quit_guard::quit_dialog_shown,
            quit_guard::quit_now,
            commands::turns::approve_call,
            commands::system::playwright_for_chat,
            commands::projects::pick_folder,
            commands::projects::pick_export,
            commands::projects::import_claude,
            commands::projects::list_projects,
            commands::projects::active_project,
            commands::projects::create_project,
            commands::projects::projects_folder_info,
            commands::projects::set_projects_folder,
            commands::usage::usage_ledger,
            commands::usage::refresh_usage_ledger,
            commands::usage::plan_usage,
            commands::usage::plan_usage_refresh,
            commands::usage::plan_scoped_limits,
            commands::usage::session_figures,
            commands::cli::cli_version_check,
            commands::cli::claude_auth_status,
            commands::cli::cli_update,
            commands::usage::turn_budget,
            commands::usage::set_turn_cap,
            commands::usage::turn_usage,
            commands::usage::note_presence,
            commands::usage::budget_override,
            commands::steer::steer_subagent,
            commands::steer::inject_message,
            commands::steer::take_back_injected,
            commands::steer::send_now_injected,
            commands::steer::stop_subagents,
            commands::steer::steer_state,
            commands::steer::unsteer_subagent,
            commands::usage::checkpoint,
            commands::usage::set_checkpoint,
            commands::projects::resolve_new_project_path,
            commands::projects::new_project,
            commands::projects::claude_md_offer,
            commands::projects::add_practices_claude_md,
            commands::projects::open_project,
            commands::projects::close_project,
            commands::projects::rename_project,
            commands::projects::forget_project,
            commands::notes::list_notes,
            commands::notes::list_note_tree,
            commands::notes::move_note,
            commands::notes::new_note_folder,
            commands::notes::read_note,
            commands::notes::read_note_media,
            commands::notes::memory_note_for,
            commands::notes::memory_strike,
            commands::notes::save_note,
            commands::notes::delete_note,
            commands::notes::trash_note_drafts,
            commands::notes::list_proposals,
            commands::notes::read_proposal,
            commands::notes::dismiss_proposal,
            commands::notes::mark_applied,
            commands::notes::knowledge_info,
            startup_log::startup_mark,
            commands::notes::model_instructions_dir,
            commands::notes::chat_instructions_path,
            commands::notes::set_knowledge_dir,
            commands::notes::knowledge_graph,
            commands::memory::dream_status,
            commands::memory::dream,
            commands::memory::cancel_dream,
            commands::memory::capture_status,
            commands::memory::mac_idle_ms,
            commands::memory::capture,
            commands::memory::cancel_capture,
            commands::memory::centre_proposals,
            commands::memory::centre_dream_commits,
            commands::memory::centre_applied,
            commands::memory::centre_applied_diff,
            commands::memory::centre_revert_applied,
            commands::memory::centre_dream_diff,
            commands::memory::centre_revert_file,
            commands::system::build_stamp,
            commands::memory::tidy_memory,
            commands::system::reveal,
            commands::system::named_files,
            commands::system::reveal_file,
            commands::system::open_file,
            paste_images::fetch_paste_image,
            sent_files::save_sent_file,
            sent_files::drag_sent_file,
            commands::system::read_file_tab,
            latex::render_latex,
            commands::system::open_url,
            commands::system::notify,
            commands::system::notify_usage_refreshed,
            commands::system::set_power_prefs,
            commands::system::set_zoom,
            webview_fit::refit_webview,
            remote::remote_status,
            remote::remote_start,
            remote::remote_stop,
            remote::remote_set_keep_awake,
            remote::remote_token,
            remote::remote_sent,
            remote::remote_done,
            remote::remote_claim,
            remote::remote_self_test,
            away::away_status,
            away::away_set_url,
            away::away_sync_now,
            away::away_set_project,
            model_list::model_list_get,
            model_list::model_list_set,
            terminal::terminal_open,
            terminal::terminal_run,
            terminal::terminal_run_cwd,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
            terminal::terminal_ack,
            nightshift::nightshift_projects,
            nightshift::nightshift_project,
            nightshift::nightshift_enable,
            nightshift::nightshift_disable,
            nightshift::nightshift_default_runner,
            nightshift::nightshift_items,
            nightshift::nightshift_item,
            nightshift::nightshift_set_order,
            nightshift::nightshift_blockers,
            nightshift::nightshift_answer_blocker,
            nightshift::nightshift_shifts,
            nightshift::nightshift_shift,
            nightshift::nightshift_shift_log,
            nightshift::nightshift_synth_plan,
            nightshift::nightshift_write_plan,
            nightshift::nightshift_launch,
            nightshift::nightshift_schedule_launch,
            nightshift::nightshift_cancel_launch,
            nightshift::nightshift_pending_launch,
            nightshift::nightshift_usage,
            nightshift::nightshift_interview_start,
            nightshift::nightshift_interview_send,
            nightshift::nightshift_interview_state,
            nightshift::nightshift_interview_cancel,
            nightshift::nightshift_interview_write,
            nightshift::nightshift_mornings,
            nightshift::nightshift_morning,
            nightshift::nightshift_notes,
            nightshift::nightshift_read_file,
            nightshift::nightshift_stream,
            nightshift::nightshift_schedule,
            nightshift::nightshift_set_schedule,
            nightshift::nightshift_diff,
            nightshift::nightshift_shift_diff,
            nightshift::nightshift_new_item,
            nightshift::nightshift_write_item,
            nightshift::nightshift_delete_item,
            nightshift::nightshift_revert_preview,
            nightshift::nightshift_revert,
            nightshift::nightshift_watch,
            nightshift::nightshift_unwatch,
            webtab::web_open,
            webtab::web_bounds,
            webtab::web_nav,
            webtab::web_close,
            webtab::web_labels,
            webtab::web_focused,
            webtab::web_find,
            for_you::for_you_files,
            for_you::for_you_stamp,
            for_you::for_you_reveal,
            opened_files::take_opened_files,
            preview::preview_list,
            preview::preview_get,
            preview::preview_stop,
            preview::preview_restart,
            preview::preview_unavailable,
            claude_browser::claude_browser_status,
            claude_browser::claude_browser_watch,
            claude_browser::claude_browser_input,
            claude_browser::claude_browser_nav,
            claude_browser::claude_browser_hold,
        ]))
        .build(tauri::generate_context!())
        .expect("error while building Nightloom")
        .run(|app, event| match event {
            // The away server's quit push (item 268 step 3), best effort.
            tauri::RunEvent::Exit => {
                // Every chat's preview ends with the app (item 430).
                preview::on_exit(app);
                // And every chat's browser (item 508).
                claude_browser::on_exit(app);
                away::on_exit(app);
            }
            // Finder's Open With → Nightloom (nightshift backlog 378): the
            // file becomes a tab, whether the open launched the app or not.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Opened { urls } => opened_files::on_opened(app, &urls),
            // The window's close button while work runs asks first (backlog
            // 308); with nothing running it closes, and the app quits, as
            // before.
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } if label == "main" && !quit_guard::close_requested(app) => api.prevent_close(),
            // The page fills the window again (backlog 324): a resize, a
            // change of screen scale or the window coming forward sets a
            // stale webview frame back to the window's; no-op when equal.
            tauri::RunEvent::WindowEvent { label, event, .. } if label == "main" => {
                if let Some(t) = webview_fit::trigger(&event) {
                    webview_fit::refit(app, t);
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests;
