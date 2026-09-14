//! Nightloom desktop shell: Tauri commands over `nightloom-service`.
//!
//! Streaming goes out as `turn-event` window events (serialized
//! [`TurnEvent`]s); retry stalls surface as `turn-notice` strings. Commands
//! mirror the service API and return plain serializable values.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use nightloom_core::Tool;
use nightloom_core::{
    DocumentInput, ImageInput, ProviderError, SegmentKind, Session, SessionEvent, SystemPrompt,
    Thinking, WireView,
};
use nightloom_service::approval::{Approver, AutoApprove, Decision, PendingCall};
use nightloom_service::credentials::{self, KeySource};
use nightloom_service::import;
use nightloom_service::project::{self, Note, Project, Registry};
use nightloom_service::store::{self, SessionMatch, SessionSummary};
use nightloom_service::tools::{ChatDir, ChatDirs, Reviewer, Root, SearchBackend};
use nightloom_service::{
    AgentSpec, Chat, ClaudeCodeAgent, CompactOutcome, KnowledgeContext, Price, ProjectContext,
    PromptConfig, ProviderKind, Recorder, TurnEvent, TurnInput, TurnOutcome, resolve_binary,
    searched_locations,
};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

/// Nightshift: the unattended runner's file contract, as commands.
mod nightshift;

struct AppState {
    chat: tokio::sync::Mutex<Option<Chat>>,
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
    agent: tokio::sync::Mutex<Option<ClaudeCodeAgent>>,
    session: tokio::sync::Mutex<Option<Session>>,
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
#[derive(Default)]
struct PromptBuilt {
    /// The layers switched off in the chat the connection was built for.
    off: Vec<SegmentKind>,
    /// On the Claude Code engine, the bridged segments; `None` on the
    /// provider engine.
    agent: Option<SystemPrompt>,
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
}

impl ProjectInfo {
    fn of(project: &Project) -> Self {
        Self {
            id: project.id.clone(),
            name: project.name.clone(),
            root: project
                .workspace
                .as_ref()
                .map(|r| r.to_string_lossy().into_owned()),
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
}

#[derive(Serialize, Clone)]
struct ApprovalRequest<'a> {
    id: &'a str,
    name: &'a str,
    input: &'a serde_json::Value,
    effect: nightloom_core::Effect,
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
        let token = self.cancel.lock().unwrap().clone();
        if self
            .app
            .emit(
                "tool-approval",
                ApprovalRequest {
                    id: call.id,
                    name: call.name,
                    input: call.input,
                    effect: call.effect,
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
    /// servers. Note that this is `--safe-mode` and never `--bare`: bare
    /// mode never reads OAuth credentials, so it would force the run back
    /// onto an API key.
    safe_mode: bool,
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

/// Every provider Nightloom knows, with whether credentials are present
/// (stored in-app or in the environment).
#[tauri::command]
fn providers() -> Vec<ProviderInfo> {
    ProviderKind::ALL
        .into_iter()
        .map(|kind| ProviderInfo {
            kind: kind.label().to_string(),
            available: credentials::provider_key_source(kind).is_some(),
            default_model: kind.default_model().map(String::from),
            key_source: credentials::provider_key_source(kind),
        })
        .collect()
}

/// Store (or, with an empty key, remove) an API key in the OS credential
/// store. The key is write-only from the UI's perspective: it is never sent
/// back, only its presence (`key_source`) is.
#[tauri::command]
fn set_api_key(provider: String, key: String) -> Result<(), String> {
    let kind: ProviderKind = provider.parse()?;
    credentials::set_provider_key(kind, &key).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_api_key(provider: String) -> Result<(), String> {
    let kind: ProviderKind = provider.parse()?;
    credentials::clear_provider_key(kind).map_err(|e| e.to_string())
}

/// A search backend as the settings pane shows it.
#[derive(Serialize)]
struct SearchBackendInfo {
    name: String,
    label: String,
    /// Named in the UI because it is the other way to set this, and the one
    /// a user who scripts the CLI already uses.
    env_key: String,
    key_source: Option<KeySource>,
    /// Where this backend sits in the chain, 1-based, or `None` with no key.
    /// A position rather than a flag because every key is used: they are
    /// asked in turn, and a pane showing three filled boxes with no hint of
    /// the order would leave the reader to guess at the whole behaviour.
    order: Option<u32>,
}

/// The search backends, with whether each has a key and where in the chain
/// `web_search` will reach it.
#[tauri::command]
fn search_backends() -> Vec<SearchBackendInfo> {
    let chain = nightloom_service::tools::search_backends(credentials::search_key);
    SearchBackend::ALL
        .into_iter()
        .map(|backend| SearchBackendInfo {
            name: backend.name().to_string(),
            label: backend.label().to_string(),
            env_key: backend.env_key().to_string(),
            key_source: credentials::search_key_source(backend),
            order: chain
                .iter()
                .position(|b| *b == backend)
                .map(|i| i as u32 + 1),
        })
        .collect()
}

/// Store (or, with an empty key, remove) a search backend's API key.
/// Write-only from the UI's perspective, exactly like a provider key.
#[tauri::command]
fn set_search_key(backend: String, key: String) -> Result<(), String> {
    let backend = SearchBackend::from_name(&backend)
        .ok_or_else(|| format!("no search backend named {backend}"))?;
    credentials::set_search_key(backend, &key).map_err(|e| e.to_string())
}

/// Model ids the provider's API currently offers (for the settings modal).
#[tauri::command]
async fn list_models(provider: String, base_url: Option<String>) -> Result<Vec<String>, String> {
    let kind: ProviderKind = provider.parse()?;
    let key = credentials::stored_provider_key(kind);
    nightloom_service::list_models(kind, key, base_url)
        .await
        .map_err(|e| e.to_string())
}

/// Context windows for a batch of model ids on one provider, from the static
/// limits table — `None` where the table does not know the model. The model
/// popover and the Settings picker print these beside each id (chat-surface
/// redesign, 2026-09-13); one round trip per list rather than one per row.
#[tauri::command]
fn context_limits(provider: String, models: Vec<String>) -> Result<Vec<Option<u64>>, String> {
    let kind: ProviderKind = provider.parse()?;
    Ok(models
        .iter()
        .map(|m| nightloom_service::context_limit(kind, m))
        .collect())
}

/// Start the workspace's MCP servers, or hand back the ones already running.
///
/// Returns empty when tools are off, which also drops the connections: a
/// session with no tools should not be holding server processes open.
async fn ensure_mcp(state: &AppState, workspace: &Path, tools: bool) -> Vec<McpServerInfo> {
    let mut guard = state.mcp.lock().await;
    if !tools {
        *guard = None;
        return Vec::new();
    }
    if let Some(existing) = guard.as_ref()
        && existing.workspace == workspace
    {
        return existing.servers.clone();
    }
    let config = nightloom_service::mcp::McpConfig::discover(workspace);
    let mut shared: Vec<Arc<dyn Tool>> = Vec::new();
    let mut servers = Vec::new();
    for report in nightloom_service::mcp::connect_all(&config, workspace).await {
        match report.outcome {
            Ok(tools) => {
                servers.push(McpServerInfo {
                    name: report.name,
                    tools: tools.len(),
                    error: None,
                });
                shared.extend(tools.into_iter().map(Arc::from));
            }
            Err(e) => servers.push(McpServerInfo {
                name: report.name,
                tools: 0,
                error: Some(e.to_string()),
            }),
        }
    }
    *guard = Some(McpState {
        workspace: workspace.to_path_buf(),
        tools: shared,
        servers: servers.clone(),
    });
    servers
}

/// Everything `connect` was told, kept whole so a subagent can be built from
/// the same description rather than from a half-copied subset of it.
#[derive(Clone)]
struct ChatSpec {
    kind: ProviderKind,
    model: Option<String>,
    base_url: Option<String>,
    thinking: Thinking,
    system: Option<String>,
    tools: bool,
    preamble: bool,
    sidecar: bool,
    workspace: PathBuf,
    approval: bool,
    /// Whether this chat can reach the network. Separate from `tools`
    /// because the two questions are genuinely different — a workspace you
    /// are happy to let a model edit is not automatically one you are happy
    /// to have quoted into a third party's query log.
    web: bool,
    /// Whether the model may ask for its own history to be summarised.
    /// Its own knob rather than riding on `tools` because it is the one tool
    /// whose effect lands on the conversation instead of on the workspace:
    /// a compaction supersedes everything before it, and handing that over
    /// unasked is a different decision from handing over `edit_file`.
    self_compact: bool,
    /// The open project, for the shared-notes prompt layer. `None` for an
    /// unfiled chat, which has no docspace to index.
    project: Option<ProjectContext>,
    /// The user's knowledge vault, when this chat may reach it.
    ///
    /// Its own switch rather than riding on `tools`, because turning tools on
    /// has always meant "may write inside this folder" and the vault is a
    /// second directory outside it. That is a real change in what the model
    /// can touch, and it belongs on screen rather than in a release note.
    /// Unlike `project` it is **not** gated on the open project: the vault is
    /// the same in every project and in an unfiled chat, which is the case it
    /// exists for.
    knowledge: Option<PathBuf>,
    /// Where the other chats are, for `search_chats` / `read_chat`: the
    /// directory the sidebar lists, and every project's beside it. Taken at
    /// connect time like the rest of the spec, so a project added later is
    /// reachable after the next reconnect and not before — the rail
    /// reconnects on every knob change, which is often enough. `None` for a
    /// reviewer, for the reason `knowledge` is: a second vendor's critic has
    /// no business in the user's transcripts.
    chats: Option<ChatDirs>,
    /// The prompt layers this chat has switched off, read from its log
    /// (`Session::prompt_layers_off`) at connect time. Laid over the rail's
    /// switches rather than replacing them: the rail says what every chat
    /// gets, the log says what this one does not. Subagents and reviewers
    /// inherit it with the rest of the spec, so a blind test stays blind
    /// one level down.
    layers_off: Vec<SegmentKind>,
}

impl ChatSpec {
    /// What the file tools may reach: the workspace, plus the vault when the
    /// user has left it switched on.
    ///
    /// The workspace alone is what the docspace living at `<workspace>/.agents`
    /// buys — a note is an ordinary relative path inside a directory the tools
    /// were already rooted at. The vault cannot be arranged that way, holding
    /// what the user knows rather than what this folder contains, so it is a
    /// named second tree reached as `@kb/…`.
    fn root(&self) -> Root {
        let root = Root::new(self.workspace.clone());
        match &self.knowledge {
            Some(dir) => root.with_vault(dir.clone()),
            None => root,
        }
    }
}

/// Build a `Chat` from a spec: the window's own chat, and — through the
/// subagent factory — every subagent it spawns, so the two cannot drift into
/// having different tools or a different workspace.
fn build_chat(
    app: &AppHandle,
    policy: &Arc<AutoApprove>,
    spec: &ChatSpec,
    mcp_tools: &[Arc<dyn Tool>],
) -> Result<Chat, String> {
    let on_retry = {
        let app = app.clone();
        Box::new(move |e: &ProviderError, attempt: u32| {
            let _ = app.emit(
                "turn-notice",
                format!("transient provider error (attempt {attempt}): {e}; retrying…"),
            );
        })
    };
    let (provider, model) = nightloom_service::connect(
        spec.kind,
        spec.model.clone(),
        credentials::provider_key(spec.kind),
        spec.base_url.clone(),
        Some(on_retry),
    )
    .map_err(|e| e.to_string())?;

    let mut chat = Chat::new(provider, model);
    // The textarea's text is the `custom` layer, appended after whatever the
    // preamble discovered; with the preamble off it is the whole prompt.
    let config = PromptConfig {
        identity: spec.preamble,
        environment: spec.preamble,
        project_instructions: spec.preamble,
        user_memory: spec.preamble,
        // The id the chat is actually on — `connect` fills in the provider's
        // default when the rail sent none — for its own file under
        // `~/.nightloom/models/`. Gated like user memory: it is the same
        // kind of standing text, about the user rather than the folder.
        model: spec.preamble.then(|| chat.model.clone()),
        // Gated on the preamble like every other discovered layer: `--bare`
        // and its desktop equivalent mean "nothing but what I typed".
        project: spec.preamble.then(|| spec.project.clone()).flatten(),
        knowledge: spec
            .preamble
            .then(|| spec.knowledge.clone().map(|dir| KnowledgeContext { dir }))
            .flatten(),
        cwd: spec.workspace.clone(),
        custom: spec.system.clone(),
    };
    // The chat's own exclusions last, over the rail's switches: what this
    // chat has turned off stays off whatever the rail says.
    chat.system = nightloom_service::prompt::assemble(&config.without(&spec.layers_off));
    chat.thinking = spec.thinking.clone();
    // Gives the sidecar's context gauge a denominator; `None` for a model we
    // have no verified window for, which the gauge handles by reporting raw
    // token counts instead of a percentage.
    chat.context_limit = nightloom_service::context_limit(spec.kind, &chat.model);
    // Same table discipline as the limit: an unpriced model records no cost
    // rather than a zero, so the UI can distinguish free from unknown.
    chat.price = nightloom_service::price(spec.kind, &chat.model);
    // On unless the UI says otherwise. The shared policy instance is reused
    // rather than rebuilt, so "always allow bash" survives the re-connect the
    // rail fires on every knob change.
    if spec.approval {
        chat.approver = Some(policy.clone());
    }
    if spec.tools {
        chat.tools = nightloom_service::tools::builtin_in(spec.root());
        // Cloned handles, not new connections: the servers were started once
        // for this workspace and every subagent shares them.
        chat.tools.extend(
            mcp_tools
                .iter()
                .map(|t| Box::new(t.clone()) as Box<dyn Tool>),
        );
        if spec.web {
            // `web_search` appears only when a backend key is set, so this
            // set differs between machines; both tools are `Mutating` and
            // pass the same gate as `bash`.
            chat.tools
                .extend(nightloom_service::tools::web_tools(credentials::search_key));
        }
        // Its own toggle, and inside `tools` rather than beside it: it is
        // still a tool, and a connection that asked for none should not
        // quietly get a tools array — it changes what the provider is sent.
        if spec.self_compact {
            chat.enable_self_compaction();
        }
        // The memory inbox rides the knowledge switch: turning knowledge off
        // turns the memory system off whole, vault and inbox alike. Gated on
        // the config dir rather than the vault existing, because `remember`
        // only appends — an observation is judged and filed by the dream
        // pass, not here. Reviewers never get it: they are built from a spec
        // whose `knowledge` was cleared.
        if spec.knowledge.is_some()
            && let Some(config) = project::config_dir()
        {
            let source = spec.project.as_ref().map(|p| p.name.clone()).or_else(|| {
                spec.workspace
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
            });
            chat.tools
                .push(Box::new(nightloom_service::tools::Remember::new(
                    config, source,
                )));
        }
        // The other chats, on `tools` alone and not on the knowledge switch:
        // chats are not the vault. They are the user's own transcripts on
        // this machine, read-only, and the thing a user most often wants a
        // model to look up is what they told it last week. Subagents inherit
        // them with the rest of the set; reviewers do not (see `reviewers`).
        if let Some(chats) = &spec.chats {
            chat.tools
                .push(Box::new(nightloom_service::tools::SearchChats::new(
                    chats.clone(),
                )));
            chat.tools
                .push(Box::new(nightloom_service::tools::ReadChat::new(
                    chats.clone(),
                )));
        }
        // Subagents are built from this same spec, so they inherit the
        // workspace and the tool set. The engine strips their own `task` tool
        // and replaces their approver, so this cannot recurse or route around
        // the gate.
        let (sub_app, sub_policy, sub_spec) = (app.clone(), policy.clone(), spec.clone());
        let sub_mcp = mcp_tools.to_vec();
        chat.enable_subagents(Arc::new(move || {
            build_chat(&sub_app, &sub_policy, &sub_spec, &sub_mcp)
        }));
        // Cloned first: the bench excludes whatever lineage is under review,
        // so it needs the model this chat actually resolved to, and `chat` is
        // about to be borrowed mutably.
        let model = chat.model.clone();
        let bench = reviewers(app, policy, spec, &model, mcp_tools);
        chat.enable_reviews(bench, spec.root());
    }
    if !spec.sidecar {
        chat.sidecar = Vec::new();
    }
    Ok(chat)
}

/// The curated bench, resolved into buildable reviewers.
///
/// Which reviewers exist, and whether they route through OpenRouter, is
/// [`tools::bench`]'s decision rather than this shell's — the CLI asks the
/// same question and the two must not answer it differently. Left here is the
/// half only a shell can do: build a `Chat` for a named provider and model,
/// from the same `ChatSpec` as the window's own, so a reviewer inherits the
/// workspace, the project and the MCP connections before `review` strips it
/// to the read-only tools.
///
/// A key counts whether it is in the app's credential store or the
/// environment, which is the same test the settings pane shows as
/// `key_source`.
fn reviewers(
    app: &AppHandle,
    policy: &Arc<AutoApprove>,
    spec: &ChatSpec,
    model: &str,
    mcp_tools: &[Arc<dyn Tool>],
) -> Vec<Reviewer> {
    nightloom_service::tools::bench(spec.kind, model, |k| {
        credentials::provider_key_source(k).is_some()
    })
    .into_iter()
    .map(|candidate| {
        let mut spec = spec.clone();
        spec.kind = candidate.kind;
        spec.model = Some(candidate.model);
        // Belonged to the provider being replaced: a base URL pointing at
        // a local server is not where this reviewer lives.
        spec.base_url = None;
        // A reviewer runs on a *second vendor*, and the vault is the user's
        // personal knowledge. A critic reading a document in this workspace
        // has no reason to want it, and "no reason to" is the wrong guarantee
        // when not handing it over at all is available.
        spec.knowledge = None;
        // The same argument, and the transcripts are at least as personal.
        spec.chats = None;
        let (app, policy, mcp) = (app.clone(), policy.clone(), mcp_tools.to_vec());
        Reviewer::new(
            candidate.name,
            candidate.description,
            Arc::new(move || build_chat(&app, &policy, &spec, &mcp)),
        )
    })
    .collect()
}

/// Build the provider + `Chat` for this window; retry stalls are reported as
/// `turn-notice` events. Sessions are created lazily by `send`, so switching
/// providers (or auto-connecting at launch) never leaves empty session logs.
///
/// `preamble` gates the assembled system prompt (identity, environment,
/// project instructions, user memory) and `sidecar` the per-turn status
/// block. Both default to on when absent, so a frontend that predates them
/// keeps the full behaviour.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn connect(
    app: AppHandle,
    state: State<'_, AppState>,
    provider: String,
    model: Option<String>,
    base_url: Option<String>,
    thinking: Option<String>,
    system: Option<String>,
    tools: bool,
    preamble: Option<bool>,
    sidecar: Option<bool>,
    workspace: Option<String>,
    approval: Option<bool>,
    web: Option<bool>,
    self_compact: Option<bool>,
    knowledge: Option<bool>,
) -> Result<ConnectedInfo, String> {
    let kind: ProviderKind = provider.parse()?;
    let thinking = match thinking {
        Some(s) => s.parse::<Thinking>()?,
        None => Thinking::Default,
    };
    // The folder this conversation is about: it roots the file tools and is
    // where the preamble looks for AGENTS.md files and the git branch.
    // A GUI process's cwd is whatever the launcher happened to set — the
    // install directory, or C:\Windows\System32 — so leaving it implicit
    // would point the tools somewhere arbitrary and unmentioned. An
    // unreadable or missing path falls back to cwd rather than failing the
    // connect, and the resolved value goes back to the UI to be shown.
    //
    // An open project **wins** over whatever the rail last saved: a chat
    // filed under a project that rooted its tools somewhere else would be a
    // project in name only. A project with no folder of its own gets the
    // stand-in one inside its store, so this has a path either way.
    let active = state.active().await;
    let workspace = match &active {
        Some(project) => project.workspace_dir(),
        None => workspace
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))),
    };

    // Every project's chats plus the unfiled ones, named as the picker names
    // them, with the sidebar's directory as the default scope. The registry
    // is cloned out under its own lock and the guard dropped, per the lock
    // discipline on `workspaces`.
    let chats = {
        let mut all: Vec<ChatDir> = state
            .workspaces
            .lock()
            .await
            .registry
            .projects()
            .iter()
            .map(|p| ChatDir {
                name: p.name.clone(),
                dir: p.session_dir(),
            })
            .collect();
        all.push(ChatDir {
            name: "Unfiled chats".into(),
            dir: state.default_log_dir.clone(),
        });
        ChatDirs {
            active: state.log_dir().await,
            all,
        }
    };

    let spec = ChatSpec {
        kind,
        model,
        base_url,
        thinking,
        system,
        tools,
        preamble: preamble.unwrap_or(true),
        sidecar: sidecar.unwrap_or(true),
        workspace,
        approval: approval.unwrap_or(true),
        web: web.unwrap_or(true),
        // The one knob that defaults *off*: an absent value is a caller that
        // predates the switch, and the behaviour the switch exists to stop
        // is precisely the one that used to happen without asking.
        self_compact: self_compact.unwrap_or(false),
        // On unless the UI says otherwise, and `None` regardless when there is
        // no config directory to keep a vault in — the same state the CLI
        // reports as "no vault", not a failure to connect.
        knowledge: knowledge
            .unwrap_or(true)
            .then(nightloom_service::knowledge::vault_dir)
            .flatten(),
        project: active.as_ref().map(|p| ProjectContext {
            name: p.name.clone(),
            notes_dir: p.notes_dir(),
        }),
        chats: Some(chats),
        layers_off: layers_off(&state).await,
    };
    let mcp = ensure_mcp(&state, &spec.workspace, spec.tools).await;
    let mcp_tools = state
        .mcp
        .lock()
        .await
        .as_ref()
        .map(|m| m.tools.clone())
        .unwrap_or_default();
    let mut chat = build_chat(&app, &state.approval, &spec, &mcp_tools)?;
    // Here rather than inside `build_chat`, which is also the subagent
    // factory: a subagent's session is in-memory and never appears in the
    // sidebar, so naming one would be a provider call nobody can ever see.
    chat.enable_titles();
    let info = ConnectedInfo {
        provider: chat.provider.name().to_string(),
        model: chat.model.clone(),
        context_limit: chat.context_limit,
        price: chat.price,
        mcp,
        // Asked of the bench directly rather than of `reviewers`: the rail
        // wants the names, not five closures that can each build a provider.
        reviewers: if spec.tools {
            nightloom_service::tools::bench(spec.kind, &chat.model, |k| {
                credentials::provider_key_source(k).is_some()
            })
            .into_iter()
            .map(|r| ReviewerInfo {
                name: r.name,
                model: r.description,
            })
            .collect()
        } else {
            Vec::new()
        },
        workspace: spec.workspace.to_string_lossy().into_owned(),
        project: active.as_ref().map(ProjectInfo::of),
        // The whole chain, not the head: the rail's chip is where a user
        // finds out which third parties see their queries, and naming one of
        // three would be a worse answer than naming none.
        search: (spec.tools && spec.web)
            .then(|| nightloom_service::tools::search_backends(credentials::search_key))
            .filter(|chain| !chain.is_empty())
            .map(|chain| {
                chain
                    .iter()
                    .map(|b| b.label())
                    .collect::<Vec<_>>()
                    .join(" → ")
            }),
        knowledge: spec.knowledge.clone().map(|dir| {
            KnowledgeInfo::of(dir, KnowledgeInfo::current().is_none_or(|k| k.is_default))
        }),
        engine: "provider".into(),
        agent: None,
    };
    *state.chat.lock().await = Some(chat);
    // One engine at a time: `Some` in either slot is what says which is
    // live, so connecting to a provider is what ends agent mode. The chat
    // itself is not cheap enough to rebuild casually, but the agent is a
    // spec and a process that has already exited.
    *state.agent.lock().await = None;
    *state.prompt.lock().await = PromptBuilt {
        off: spec.layers_off,
        agent: None,
    };
    Ok(info)
}

/// The open chat's switched-off layers, or none when no chat is open yet —
/// a fresh chat starts with every layer on, and its log is created lazily
/// by the first send.
async fn layers_off(state: &AppState) -> Vec<SegmentKind> {
    state
        .session
        .lock()
        .await
        .as_ref()
        .map(|s| s.prompt_layers_off().to_vec())
        .unwrap_or_default()
}

/// The default binary, matching the CLI's `--agent-binary`.
const AGENT_BINARY: &str = "claude";

/// Refuse a command that edits the conversation while the agent engine is
/// live.
///
/// Rewinding, compacting and eliding all work by changing what the *log*
/// projects onto the next request. On this engine nothing projects: the next
/// turn is `--resume <id>` against a history Claude Code keeps, so every one
/// of them would rewrite the window and leave the conversation exactly as it
/// was. A control that appears to work and does nothing is worse than one
/// that is not offered, so the UI hides these and this is the backstop under
/// that — the two have to agree, and only one of them is checkable.
async fn not_in_agent_mode(state: &AppState, what: &str) -> Result<(), String> {
    if state.agent.lock().await.is_some() {
        return Err(format!(
            "cannot {what} on the Claude Code engine: it keeps its own history, and this log is a record of it"
        ));
    }
    Ok(())
}

/// Connect the Claude Code engine: turns run through the signed-in CLI and
/// are billed to the subscription rather than to an API key.
///
/// Deliberately a command of its own rather than a `provider` value on
/// [`connect`]. Almost none of that call's arguments mean anything here — no
/// base URL, no thinking mode, no sidecar, no MCP list, no reviewers —
/// because Claude Code assembles its own prompt and runs its own loop. A
/// shared entry point would be one whose arguments are mostly inert, which
/// is the shape that invites a knob to be silently ignored.
///
/// The preamble is the one layer that crosses. It used to be withheld on the
/// same reasoning, and the result was a chat that started knowing nothing a
/// chat on the other engine knows — not the user's standing instructions,
/// not the project's `AGENTS.md`, not which notes exist. Claude Code owns
/// the identity and the environment; the rest is ours to know and goes in
/// `--append-system-prompt` ahead of the library prompt
/// ([`nightloom_service::agent_preamble`]).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn connect_agent(
    state: State<'_, AppState>,
    binary: Option<String>,
    model: Option<String>,
    workspace: Option<String>,
    tools: bool,
    approval: Option<bool>,
    safe_mode: Option<bool>,
    budget: Option<f64>,
    system: Option<String>,
    preamble: Option<bool>,
) -> Result<ConnectedInfo, String> {
    // Same rule as `connect`: an open project wins over the rail's saved
    // folder, or a chat filed under a project would be running somewhere
    // else entirely.
    let active = state.active().await;
    let workspace = match &active {
        Some(project) => project.workspace_dir(),
        None => workspace
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))),
    };

    let mut spec = AgentSpec::new(workspace.clone());
    spec.binary = binary
        .map(|b| b.trim().to_string())
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| AGENT_BINARY.into());
    spec.model = model
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty());
    spec.max_budget_usd = budget.filter(|b| *b > 0.0);
    spec.safe_mode = safe_mode.unwrap_or(false);
    // Same vault call and the same project context `connect` builds, and
    // gated on the same switch: off means "nothing but what I typed" on
    // both engines. The library prompt is the trailer rather than the
    // config's `custom` layer, so it stays recognisable as what the shell
    // passed and still wins by position.
    let preamble = preamble.unwrap_or(true);
    let knowledge = preamble
        .then(nightloom_service::knowledge::vault_dir)
        .flatten();
    // The vault sits outside every workspace, and the preamble is about to
    // name it by its real path; granting the directory is what makes that
    // path one the CLI will open rather than route to a classifier that,
    // headless, can only decline (nightshift blocker 050; `AgentSpec::add_dirs`
    // says what the grant covers).
    spec.add_dirs = knowledge.iter().cloned().collect();
    // Built as segments and rendered from them, so the Context popover can
    // show the same segments the flag carries rather than a re-parse of the
    // string (see `PromptBuilt`). The chat's own exclusions apply here as on
    // the other engine, plus the one layer that exists only here.
    let off = layers_off(&state).await;
    let prompt = nightloom_service::agent_prompt(
        &PromptConfig {
            identity: false,
            environment: false,
            project_instructions: preamble,
            user_memory: preamble,
            // By the alias the rail sent (`opus`, `sonnet`), not the dated id
            // the CLI resolves it to: that arrives with the first turn, after
            // this prompt is built once for the session. So on this engine
            // the file is named after the alias, and a chat on the CLI's
            // default model (no alias) reads none.
            model: preamble.then(|| spec.model.clone()).flatten(),
            project: preamble
                .then(|| {
                    active.as_ref().map(|p| ProjectContext {
                        name: p.name.clone(),
                        notes_dir: p.notes_dir(),
                    })
                })
                .flatten(),
            knowledge: knowledge.map(|dir| KnowledgeContext { dir }),
            cwd: workspace.clone(),
            custom: None,
        }
        .without(&off),
        system.as_deref(),
        !off.contains(&SegmentKind::EngineNote),
    );
    spec.append_system_prompt = prompt.render_flat();
    if tools {
        // Headless has no way to ask, so the window's approval prompt does
        // not run here: it gates calls the engine is about to run, and this
        // engine runs its own. On means the CLI's `auto` — its classifier
        // decides, and a call it cannot approve is denied rather than left
        // waiting for an answer nobody can give (see the helper's doc, and
        // nightshift blocker 045 for why this is no longer `dontAsk`). Off
        // is `bypassPermissions`.
        spec.permission_mode =
            Some(AgentSpec::headless_permission_mode(approval.unwrap_or(true)).into());
        // Nightloom's own tools on this engine — search_chats, read_chat,
        // remember, fetch_page — served by the binary the app is running as
        // (`--mcp-serve` at the top of `main`), because the CLI is not on
        // PATH on most machines that have the app. Inside `if tools` on
        // purpose: `--tools ""` does not disable MCP tools, and a connection
        // that asked for none should not get four. Under safe mode the CLI's
        // `--strict-mcp-config` makes this the only server, which is the
        // point (nightshift backlog 046).
        if let Ok(exe) = std::env::current_exe() {
            let mut args = vec!["--mcp-serve".to_string()];
            if let Some(p) = &active {
                args.push("--project".into());
                args.push(p.id.clone());
            }
            spec.mcp_config = Some(
                serde_json::json!({
                    "mcpServers": {
                        nightloom_service::mcp_server::SERVER_NAME: {
                            "command": exe.to_string_lossy(),
                            "args": args,
                        }
                    }
                })
                .to_string(),
            );
        }
    } else {
        spec.tools = Some(Vec::new());
    }

    // Probed rather than assumed. A missing or unrunnable binary is the
    // overwhelmingly likely first failure on this engine, and finding out at
    // connect gives the rail something to show instead of a turn that dies
    // with a process error the first time the user sends anything.
    let (resolved_binary, version) = agent_version(&spec.binary).await?;

    // Pick the conversation back up if the open chat already has one. This
    // is the case where a session was started on the agent, the rail was
    // switched to a provider and back — without it the transcript would
    // carry on and the agent would have forgotten all of it.
    if let Some(session) = state.session.lock().await.as_ref()
        && let Some((agent, id)) = session.agent_session()
        && agent == AGENT
    {
        spec.resume = Some(id.to_string());
    }

    let info = ConnectedInfo {
        provider: AGENT.into(),
        model: spec.model.clone().unwrap_or_else(|| "default".into()),
        // Unknown until the CLI names the model it resolved: an alias like
        // `sonnet` is not in the limits table and never will be. The first
        // turn reports the real id and the gauge picks a denominator up
        // then, which is later than ideal and better than a guessed window.
        context_limit: None,
        // No per-token bill under a subscription, and the CLI's own dollar
        // figure is an estimate of what the API *would* have charged. Left
        // `None` so the cost readout never renders it as money spent; the
        // rail shows it per turn, saying what it is.
        price: None,
        mcp: Vec::new(),
        reviewers: Vec::new(),
        workspace: workspace.to_string_lossy().into_owned(),
        project: active.as_ref().map(ProjectInfo::of),
        search: None,
        // The vault's index is on the request now, with its real directory
        // in the engine note — but this field is the folder Nightloom's file
        // tools are rooted at, and nothing here roots any: Claude Code owns
        // its own file access. Said as `None` rather than echoed, so the
        // rail's chip keeps meaning what it says.
        knowledge: None,
        engine: AGENT.into(),
        agent: Some(AgentInfo {
            binary: resolved_binary,
            version,
            subscription: spec.use_subscription,
            permission_mode: spec.permission_mode.clone(),
            safe_mode: spec.safe_mode,
            resume: spec.resume.clone(),
        }),
    };
    *state.agent.lock().await = Some(ClaudeCodeAgent::new(spec));
    *state.chat.lock().await = None;
    *state.prompt.lock().await = PromptBuilt {
        off,
        agent: Some(prompt),
    };
    Ok(info)
}

/// Which agent a recorded [`SessionEvent::AgentSession`] belongs to.
const AGENT: &str = "claude-code";

/// The model the last recorded exchange ran on, whatever superseded it since.
///
/// Read off the whole log rather than the live projection: a compaction or a
/// rewind changes what the next request carries and says nothing about which
/// snapshot the CLI resolves an alias to.
fn last_model(session: &Session) -> Option<String> {
    session.events().iter().rev().find_map(|e| match e {
        SessionEvent::AssistantMessage { model, .. } if !model.is_empty() => Some(model.clone()),
        _ => None,
    })
}

/// Ask the binary what it is, so a connect fails here rather than mid-turn.
///
/// Resolved through [`resolve_binary`] rather than spawned by name, and this
/// is the entry point where that matters most: a GUI process on macOS gets
/// launchd's minimal `PATH` and never reads a login shell, so the default
/// `claude` did not resolve for any macOS user who installed Claude Code the
/// documented way — the connect failed with "not found" while the identical
/// default worked from a terminal. The resolved path is returned so the rail
/// can show which binary actually answered rather than the name it was asked
/// for; the two differ exactly when this fallback did something.
async fn agent_version(binary: &str) -> Result<(String, Option<String>), String> {
    let resolved = resolve_binary(binary);
    let out = tokio::process::Command::new(&resolved)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => format!(
                "could not start {binary}: not found. Looked in {}. Install Claude Code, or give the rail an absolute path to it.",
                searched_locations().join(", ")
            ),
            _ => format!("could not start {binary}: {e}"),
        })?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok((resolved, (!text.is_empty()).then_some(text)))
}

/// The open project's chats, or the unfiled ones when none is open.
///
/// On the blocking pool, like the search below it: both walk a directory of
/// logs, and an imported history is thousands of them. Holding a runtime
/// thread for that stalls whatever turn is streaming into the window.
#[tauri::command]
async fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionSummary>, String> {
    let dir = state.log_dir().await;
    blocking(move || store::list(&dir)).await
}

/// The same chats, filtered to the ones that mention `query`.
///
/// A backend call rather than a filter over the list the sidebar already
/// holds, because that list carries a name and an opening message and the
/// thing you are trying to find is usually neither — it is a sentence from
/// the middle of a conversation, which only the log has.
#[tauri::command]
async fn search_sessions(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<SessionMatch>, String> {
    let dir = state.log_dir().await;
    blocking(move || store::search(&dir, &query)).await
}

/// Rename a session, recording a `Title` event on its log.
///
/// The escape hatch the generated name needs: a name is written once, from
/// the first exchange, so a long conversation that has moved on keeps
/// describing where it started. It is an append like everything else here —
/// the old name stays in the log and the projection takes the latest.
///
/// Renaming the *active* session goes through the handle already open on its
/// log rather than loading a second one, which would leave two writers
/// appending to one file.
#[tauri::command]
async fn rename_session(
    state: State<'_, AppState>,
    id: String,
    title: String,
) -> Result<(), String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("a name cannot be empty".into());
    }
    let mut session_guard = state.session.lock().await;
    if let Some(active) = session_guard.as_mut().filter(|s| s.id == id) {
        active.record_title(title);
        return Ok(());
    }
    drop(session_guard);

    let path = store::find_by_prefix(&state.log_dir().await, &id).map_err(|e| e.to_string())?;
    let mut session = Session::load(&path).map_err(|e| e.to_string())?;
    session.record_title(title);
    Ok(())
}

#[tauri::command]
async fn new_session(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let session = Session::with_log(&state.log_dir().await).map_err(|e| e.to_string())?;
    let id = session.id.clone();
    *state.session.lock().await = Some(session);
    // A new chat is a new conversation on the agent too. Left set, the next
    // turn would resume the previous chat's history behind an empty
    // transcript — the same lie in the other direction from the one
    // `SessionEvent::AgentSession` exists to prevent.
    adopt_agent_session(&state, None).await;
    Ok(serde_json::json!({ "id": id }))
}

/// Point the agent at `resume` (or at nothing), if the agent engine is live.
///
/// Nothing happens on the provider engine, which is what lets the session
/// commands call this unconditionally instead of each asking which engine is
/// running.
async fn adopt_agent_session(state: &AppState, resume: Option<String>) {
    if let Some(agent) = state.agent.lock().await.as_mut() {
        agent.set_resume(resume);
    }
}

/// Resolve a session ID (or unique prefix), make it active, and return its
/// full event log for the UI to render.
///
/// A log that did not read back cleanly still opens — see
/// [`Session::load`] — and says so as a `turn-notice` toast rather than as a
/// failure. Refusing the session would be the wrong trade in both directions:
/// the events that did read are the user's conversation, and the ones that
/// did not are worth a sentence rather than silence.
#[tauri::command]
async fn open_session(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<SessionEvent>, String> {
    let path = store::find_by_prefix(&state.log_dir().await, &id).map_err(|e| e.to_string())?;
    let session = Session::load(path).map_err(|e| e.to_string())?;
    if let Some(notice) = session.load_report().summary() {
        let _ = app.emit("turn-notice", notice);
    }
    let events = session.events().to_vec();
    // Reopening an agent chat resumes the conversation it is a record of.
    // Without this the transcript would scroll back a week and the next turn
    // would begin with a model that had never seen any of it.
    let resume = session
        .agent_session()
        .filter(|(agent, _)| *agent == AGENT)
        .map(|(_, id)| id.to_string());
    *state.session.lock().await = Some(session);
    adopt_agent_session(&state, resume).await;
    Ok(events)
}

#[tauri::command]
async fn transcript(state: State<'_, AppState>) -> Result<Vec<SessionEvent>, String> {
    Ok(state
        .session
        .lock()
        .await
        .as_ref()
        .map(|s| s.events().to_vec())
        .unwrap_or_default())
}

/// Run one user turn, streaming progress as `turn-event` window events.
///
/// `images` and `documents` are base64 payloads the frontend already read
/// off a paste or a drop. They go into the session log verbatim rather than
/// as file paths, so the transcript keeps rendering after the source file
/// moves — see [`nightloom_core::ImageInput`].
#[tauri::command]
async fn send(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
    images: Option<Vec<ImageInput>>,
    documents: Option<Vec<DocumentInput>>,
) -> Result<TurnOutcome, String> {
    let chat_guard = state.chat.lock().await;
    let chat = chat_guard
        .as_ref()
        .ok_or_else(|| "not connected".to_string())?;

    let log_dir = state.log_dir().await;
    let mut session_guard = state.session.lock().await;
    if session_guard.is_none() {
        *session_guard = Some(Session::with_log(&log_dir).map_err(|e| e.to_string())?);
    }
    let session = session_guard.as_mut().expect("session ensured above");

    let cancel = CancellationToken::new();
    *state.cancel.lock().unwrap() = cancel.clone();

    let mut on_event = |e: TurnEvent| {
        let _ = app.emit("turn-event", &e);
    };
    let input = TurnInput {
        text,
        images: images.unwrap_or_default(),
        documents: documents.unwrap_or_default(),
    };
    let sealed_before = session.write_failure().is_some();
    let outcome = chat.run_turn(session, input, &cancel, &mut on_event).await;
    // On the transition only, which needs no flag to remember: a log seals
    // once, and a turn that sealed it looks from here exactly like one that
    // did not. There is no stderr behind this window for the notice to go to,
    // and a chat that stopped being saved goes on answering as if it were.
    if !sealed_before && let Some(failure) = session.write_failure() {
        let _ = app.emit("turn-notice", failure.summary());
    }
    outcome.map_err(|e| e.to_string())
}

/// What one agent turn spent and where it went.
///
/// Separate from [`TurnOutcome`] because almost none of it is the same
/// question. A provider turn's outcome is about the request; this is about a
/// subscription — which plan window the turn came out of, and what the same
/// turn would have cost on the API, which is worth showing precisely because
/// it is the number *not* being charged.
#[derive(Serialize)]
struct AgentTurn {
    /// The model the CLI resolved to, and its window if the table knows it.
    /// Reported rather than guessed at connect: `sonnet` is an alias, and
    /// only the CLI can say which snapshot it means today.
    model: Option<String>,
    context_limit: Option<u64>,
    /// The CLI's own client-side estimate, and **not** a bill.
    cost_usd: Option<f64>,
    /// Assistant turns the CLI took internally, tool rounds included.
    rounds: Option<u32>,
    /// The plan window. Present only on an OAuth run, which makes it the one
    /// honest signal that this turn was billed to the plan and not to a key.
    plan: Option<nightloom_service::agent::RateLimitInfo>,
    notices: Vec<String>,
    is_error: bool,
}

/// Run one user turn on the agent engine, streaming the same `turn-event`s
/// the provider path does.
///
/// The turn is recorded into the session log in the ordinary shape — see
/// [`Recorder`] for why, and for the pairing guarantee that keeps the log
/// replayable if the rail is later switched back to a provider. What the log
/// is *not* is the thing the next turn replays: that is the agent's own
/// session, resumed by the id recorded alongside.
///
/// `images` and `documents` are the same base64 payloads `send` takes, and
/// they land in the log the same way — the user event carries them verbatim,
/// so a chat that started on this engine projects onto a provider request
/// with its attachments intact if the rail is switched. How they reach the
/// CLI is the agent's business (`ClaudeCodeAgent::run_turn`: a stdin line
/// rather than argv, for that one turn).
#[tauri::command]
async fn send_agent(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
    images: Option<Vec<ImageInput>>,
    documents: Option<Vec<DocumentInput>>,
) -> Result<AgentTurn, String> {
    let mut agent_guard = state.agent.lock().await;
    let agent = agent_guard
        .as_mut()
        .ok_or_else(|| "not connected".to_string())?;

    let log_dir = state.log_dir().await;
    let mut session_guard = state.session.lock().await;
    if session_guard.is_none() {
        *session_guard = Some(Session::with_log(&log_dir).map_err(|e| e.to_string())?);
    }
    let session = session_guard.as_mut().expect("session ensured above");
    // Sampled before the first append of the turn. See `send`: an agent turn
    // records into the same log through `Recorder`, so it can seal it the same
    // way, and this window has no stderr for the notice to go to either.
    let sealed_before = session.write_failure().is_some();
    let input = TurnInput {
        text,
        images: images.unwrap_or_default(),
        documents: documents.unwrap_or_default(),
    };
    session.record_user_with_attachments(
        input.text.clone(),
        input.images.clone(),
        input.documents.clone(),
    );

    let cancel = CancellationToken::new();
    *state.cancel.lock().unwrap() = cancel.clone();

    // Seeded from the last turn rather than from the rail, because what the
    // rail holds may be an alias. `sonnet` is not in the limits or pricing
    // tables and never will be — only the CLI can say which snapshot it
    // means today, and it says so on its `init` line, which arrives before
    // any event and so after this recorder has to exist. The previous turn
    // already asked that question and the log kept the answer.
    //
    // The agent remembers it too, which covers a *new* chat on a connection
    // that has already run one. What is left is the first turn after a
    // connect, whose messages carry the alias up to the one that closes the
    // turn — every message after that, in every later turn, carries the id.
    let seed = last_model(session)
        .or_else(|| agent.resolved_model().map(String::from))
        .or_else(|| agent.spec().model.clone())
        .unwrap_or_else(|| AGENT.into());
    // Rendered live and recorded in one pass. Two passes over the same
    // stream would be two chances for the window and the log to disagree
    // about what happened.
    let mut recorder = Recorder::new(session, seed);
    let mut on_event = |e: TurnEvent| {
        let _ = app.emit("turn-event", &e);
        recorder.push(&e);
    };
    let result = agent.run_turn(input, &cancel, &mut on_event).await;

    match result {
        Ok(outcome) => {
            if let Some(model) = &outcome.model {
                recorder.set_model(model.clone());
            }
            recorder.finish(if outcome.is_error {
                Some("error")
            } else {
                Some("end_turn")
            });
            // Written after the turn rather than before it: an id from a run
            // that then failed to start is a handle to nothing, and the next
            // turn resuming it would fail for a reason nobody could see.
            if let Some(id) = &outcome.session_id {
                session.record_agent_session(AGENT, id);
            }
            if !sealed_before && let Some(failure) = session.write_failure() {
                let _ = app.emit("turn-notice", failure.summary());
            }
            agent.follow_on(&outcome);
            let context_limit = outcome
                .model
                .as_deref()
                .and_then(|m| nightloom_service::context_limit(ProviderKind::Anthropic, m));
            Ok(AgentTurn {
                model: outcome.model,
                context_limit,
                cost_usd: outcome.cost_usd,
                rounds: outcome.rounds,
                plan: outcome.rate_limit,
                notices: outcome.notices,
                is_error: outcome.is_error,
            })
        }
        Err(e) => {
            // Whatever streamed before the failure is still what happened,
            // and the pairing guarantee is exactly for this: a turn killed
            // mid-round leaves calls open, and `finish` closes them.
            recorder.finish(Some("error"));
            Err(e.to_string())
        }
    }
}

/// Compact the active session: earlier turns are superseded by a
/// model-written summary (recorded as a session event; the log keeps the
/// full history). Cancellable via `cancel`, which leaves the session
/// unchanged.
#[tauri::command]
async fn compact(state: State<'_, AppState>) -> Result<CompactOutcome, String> {
    not_in_agent_mode(&state, "compact").await?;
    let chat_guard = state.chat.lock().await;
    let chat = chat_guard
        .as_ref()
        .ok_or_else(|| "not connected".to_string())?;
    let mut session_guard = state.session.lock().await;
    let session = session_guard
        .as_mut()
        .ok_or_else(|| "no active session".to_string())?;

    let cancel = CancellationToken::new();
    *state.cancel.lock().unwrap() = cancel.clone();
    chat.compact(session, &cancel)
        .await
        .map_err(|e| e.to_string())
}

/// Rewind the active session to the turn at log index `to`, returning the
/// transcript that results.
///
/// Returns the events rather than an acknowledgement so the UI re-syncs from
/// the log in the same call: a rewind changes what every projection reads,
/// and a UI that updated its own copy optimistically would be describing a
/// conversation the model is no longer having.
///
/// Safe against a turn in flight without a check of its own: `send` holds the
/// session lock for the whole turn, so this waits rather than cutting the log
/// out from under a reply being recorded. It would still be a surprising
/// thing to have queued, which is why the UI hides the control while busy.
#[tauri::command]
async fn rewind(state: State<'_, AppState>, to: usize) -> Result<Vec<SessionEvent>, String> {
    not_in_agent_mode(&state, "rewind").await?;
    let mut session_guard = state.session.lock().await;
    let session = session_guard
        .as_mut()
        .ok_or_else(|| "no active session".to_string())?;
    session.rewind(to)?;
    Ok(session.events().to_vec())
}

/// What removing items changed: the new view, plus the transcript, because
/// an elision moves both.
#[derive(Serialize)]
struct ContextEdit {
    view: WireView,
    events: Vec<SessionEvent>,
    /// How many items the call actually changed. Zero is not an error — a UI
    /// re-sending a selection that is already hidden is not a mistake.
    changed: usize,
}

/// Itemize the request the active chat would send right now.
///
/// Needs both locks because the view is the *request*, not the log: the
/// preamble and the sidecar live on the `Chat` and only the `Session` knows
/// the conversation. Taking them in the same order `compact` does (chat,
/// then session) so the two can never deadlock against each other.
///
/// On the Claude Code engine the view is the bridged preamble alone, with
/// no messages: the CLI holds the conversation and assembles its own
/// request, so there is no history of ours to itemize — but the layers
/// Nightloom appends are ours, and "what does this chat know at the start"
/// deserves the same answer on both engines. It used to refuse here; that
/// was the right call while the popover could only rank items to remove,
/// and the wrong one once it shows what was sent. No limit either: the
/// CLI's window is reported per turn, not known at connect.
#[tauri::command]
async fn context_view(state: State<'_, AppState>) -> Result<WireView, String> {
    if state.agent.lock().await.is_some() {
        let built = state.prompt.lock().await;
        return Ok(WireView::assemble(
            built.agent.as_ref(),
            &Session::new(),
            None,
            None,
        ));
    }
    let chat_guard = state.chat.lock().await;
    let chat = chat_guard
        .as_ref()
        .ok_or_else(|| "not connected".to_string())?;
    let session_guard = state.session.lock().await;
    let Some(session) = session_guard.as_ref() else {
        // Sessions are created lazily by `send`, so "no session yet" is the
        // ordinary state at launch rather than a failure. An empty session
        // still has a preamble worth showing, which is the answer to "what
        // am I starting with".
        return Ok(chat.context_view(&Session::new()));
    };
    Ok(chat.context_view(session))
}

/// Remove or restore the content of log events, returning the new view and
/// transcript together.
///
/// Both come back for the same reason [`rewind`] returns the transcript: the
/// UI re-syncs from the log rather than patching its own copy, and an
/// elision changes what every projection reads.
#[tauri::command]
async fn edit_context(
    state: State<'_, AppState>,
    targets: Vec<usize>,
    remove: bool,
) -> Result<ContextEdit, String> {
    not_in_agent_mode(&state, "edit the context").await?;
    let chat_guard = state.chat.lock().await;
    let chat = chat_guard
        .as_ref()
        .ok_or_else(|| "not connected".to_string())?;
    let mut session_guard = state.session.lock().await;
    let session = session_guard
        .as_mut()
        .ok_or_else(|| "no active session".to_string())?;

    let changed = if remove {
        session.elide(targets)?
    } else {
        session.unelide(targets)?
    };
    Ok(ContextEdit {
        view: chat.context_view(session),
        events: session.events().to_vec(),
        changed,
    })
}

/// The chat's switched-off layers, and the set the live engine was built
/// with. The UI reconnects when the two differ — after opening another chat,
/// or a new one — so the prompt on the wire is always the open chat's.
#[derive(Serialize)]
struct PromptLayersInfo {
    off: Vec<SegmentKind>,
    built: Vec<SegmentKind>,
}

#[tauri::command]
async fn prompt_layers(state: State<'_, AppState>) -> Result<PromptLayersInfo, String> {
    let off = layers_off(&state).await;
    let built = state.prompt.lock().await.off.clone();
    Ok(PromptLayersInfo { off, built })
}

/// Record which prompt layers this chat excludes, returning the transcript.
///
/// The log is the only thing written here: the live engine still carries
/// the prompt it was built with, and the UI reconnects after this returns —
/// the same path a rail knob takes — so `connect` / `connect_agent` read the
/// new set back the one way they read it. A session is created if the chat
/// has none yet, as `send` would create one: the exclusion is a fact about
/// the chat, and a chat has to exist to have it.
///
/// Allowed on the Claude Code engine, unlike a rewind or an elision: those
/// change what the *log* projects, which that engine never reads, while
/// this changes what the next connect appends to the CLI's prompt, which it
/// does read — after the next compaction on a resumed session (see
/// `docs/service-agent.md`), and the popover says so there.
#[tauri::command]
async fn set_prompt_layers(
    state: State<'_, AppState>,
    off: Vec<SegmentKind>,
) -> Result<Vec<SessionEvent>, String> {
    let log_dir = state.log_dir().await;
    let mut session_guard = state.session.lock().await;
    if session_guard.is_none() {
        *session_guard = Some(Session::with_log(&log_dir).map_err(|e| e.to_string())?);
    }
    let session = session_guard.as_mut().expect("session ensured above");
    session.record_prompt_layers(off);
    Ok(session.events().to_vec())
}

/// Delete a session log the reversible way: it moves to `<logs>/trash/`
/// rather than being unlinked (review round 1, 2026-09-13 — the rule that
/// no click in the UI may lose work for good; `backlog/trash/` is the same
/// shape). The listing never descends into subdirectories, so a trashed log
/// is out of the sidebar at once and still on disk. If it is the active
/// session, the open log handle is dropped first (the next send starts a
/// fresh session).
#[tauri::command]
async fn delete_session(state: State<'_, AppState>, id: String) -> Result<String, String> {
    let log_dir = state.log_dir().await;
    let path = store::find_by_prefix(&log_dir, &id).map_err(|e| e.to_string())?;
    let full_id = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let was_active = {
        let mut session_guard = state.session.lock().await;
        let active = session_guard.as_ref().is_some_and(|s| s.id == full_id);
        if active {
            *session_guard = None;
        }
        active
    };
    if was_active {
        adopt_agent_session(&state, None).await;
    }
    let trash = log_dir.join("trash");
    std::fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
    let name = path
        .file_name()
        .ok_or_else(|| "session log has no file name".to_string())?;
    let mut dest = trash.join(name);
    // A second deletion of a re-imported chat with the same id keeps both.
    if dest.exists() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        dest = trash.join(format!("{full_id}.{stamp}.jsonl"));
    }
    std::fs::rename(&path, &dest).map_err(|e| e.to_string())?;
    Ok(full_id)
}

// ---- projects ----------------------------------------------------------

/// Ask the OS for a folder. `None` when the user cancelled.
///
/// Driven from Rust rather than from the frontend so the app needs no dialog
/// permission in its capability set and no matching npm package: the only
/// thing the webview can do here is ask, and the only thing it gets back is a
/// path the user chose themselves.
#[tauri::command]
async fn pick_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    title: Option<String>,
    start_at: Option<String>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    // The caller's starting point wins when it gave one — picking a knowledge
    // folder should open near the current vault, not near the project.
    let start = match start_at.map(PathBuf::from) {
        Some(dir) => Some(dir),
        None => match state.active().await {
            Some(project) => project.workspace,
            None => project::config_dir().map(|d| d.parent().unwrap_or(&d).to_path_buf()),
        },
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut builder = app
        .dialog()
        .file()
        .set_title(title.as_deref().unwrap_or("Choose a project folder"));
    if let Some(start) = start.filter(|p| p.is_dir()) {
        builder = builder.set_directory(start);
    }
    builder.pick_folder(move |picked| {
        let _ = tx.send(picked);
    });
    Ok(rx
        .await
        .ok()
        .flatten()
        .and_then(|p| p.into_path().ok())
        .map(|p| project::normalize(&p).to_string_lossy().into_owned()))
}

#[tauri::command]
async fn list_projects(state: State<'_, AppState>) -> Result<Vec<ProjectInfo>, String> {
    Ok(state
        .workspaces
        .lock()
        .await
        .registry
        .projects()
        .iter()
        .map(ProjectInfo::of)
        .collect())
}

#[tauri::command]
async fn active_project(state: State<'_, AppState>) -> Result<Option<ProjectInfo>, String> {
    Ok(state.active().await.as_ref().map(ProjectInfo::of))
}

/// Register a folder as a project. Idempotent: the same folder is the same
/// project, so this doubles as "open the one I already have".
/// One project an import produced.
#[derive(Serialize)]
struct ImportedProject {
    name: String,
    root: String,
    chats: usize,
    already: usize,
    notes: usize,
    warnings: Vec<String>,
}

#[derive(Serialize)]
struct ImportSummary {
    projects: Vec<ImportedProject>,
    unfiled: usize,
    unreadable: usize,
    summary: String,
    warnings: Vec<String>,
    /// Projects whose memory summary was too long for `AGENTS.md`, with the
    /// size: their `AGENTS.md` points at the full text and owes a short one.
    needs_condensing: Vec<(String, usize)>,
}

/// Choose the claude.ai export archive.
///
/// Driven from Rust for the same reason [`pick_folder`] is: the webview needs
/// no filesystem permission in its capability set, and it gets back a path the
/// user chose rather than one it asked for.
#[tauri::command]
async fn pick_export(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title("Choose your claude.ai export")
        .add_filter("Claude export", &["zip"])
        .pick_file(move |picked| {
            let _ = tx.send(picked);
        });
    Ok(rx
        .await
        .ok()
        .flatten()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().into_owned()))
}

/// Import a claude.ai export and register what it produced.
///
/// On a blocking thread because it is file I/O over an archive that is
/// routinely hundreds of megabytes, and the runtime it would otherwise sit on
/// is the one carrying the window's events.
///
/// The import owns the registry for the duration, which is not a convenience:
/// a project's id decides where its chats are written, so nothing can be
/// written before the project exists. It also means a second import adds the
/// chats you have had since rather than a second copy of every project.
///
/// `into` is optional. Without it the imported projects have no folder, which
/// is what a claude.ai project actually is.
#[tauri::command]
async fn import_claude(
    state: State<'_, AppState>,
    export: String,
    into: Option<String>,
    unfiled: bool,
) -> Result<ImportSummary, String> {
    let destination = into.filter(|s| !s.trim().is_empty()).map(PathBuf::from);
    // The registry is taken across the blocking hop and put back, rather than
    // the lock being held over it: this is minutes of file I/O on a big
    // archive, and every project command would be stuck behind it.
    let mut registry = { state.workspaces.lock().await.registry.clone() };
    let (report, registry) = tokio::task::spawn_blocking(move || {
        let export = import::read_export(Path::new(&export))?;
        let mut options = import::ImportOptions::new();
        options.into = destination;
        options.unfiled = unfiled;
        let report = import::import(&export, &options, &mut registry)?;
        Ok::<_, String>((report, registry))
    })
    .await
    .map_err(|e| format!("the import did not finish: {e}"))??;

    let mut guard = state.workspaces.lock().await;
    guard.registry = registry;
    let mut projects = Vec::new();
    for outcome in &report.projects {
        projects.push(ImportedProject {
            name: outcome.name.clone(),
            root: outcome
                .root
                .as_ref()
                .map(|r| r.to_string_lossy().into_owned())
                .unwrap_or_default(),
            chats: outcome.imported,
            already: outcome.already,
            notes: outcome.notes,
            warnings: outcome.warnings.clone(),
        });
    }

    Ok(ImportSummary {
        summary: report.summary(),
        projects,
        unfiled: report.unfiled,
        unreadable: report.unreadable,
        warnings: report.warnings.clone(),
        needs_condensing: report.needs_condensing.clone(),
    })
}

#[tauri::command]
async fn create_project(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    name: Option<String>,
) -> Result<ProjectInfo, String> {
    let mut guard = state.workspaces.lock().await;
    let project = guard.registry.add(PathBuf::from(path), name)?;
    announce_migration(&app, &project);
    Ok(ProjectInfo::of(&project))
}

/// Open a project: its chats become the listing and its folder the workspace.
///
/// Drops the active session, because a session is a handle on a log file in
/// the *previous* project's directory — carrying it across would append the
/// next turn to a conversation the sidebar no longer lists.
///
/// Does not re-connect. The frontend does that with the settings it already
/// holds, and doing it here would mean this command needed everything
/// `connect` needs just to pass it through unchanged.
#[tauri::command]
async fn open_project(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<ProjectInfo, String> {
    let project = {
        let mut guard = state.workspaces.lock().await;
        let project = guard
            .registry
            .find(&id)
            .cloned()
            .ok_or_else(|| format!("no project {id}"))?;
        guard.registry.touch(&id);
        guard.active = Some(project.clone());
        project
    };
    *state.session.lock().await = None;
    adopt_agent_session(&state, None).await;
    // After the guard is dropped, and before the counts are read: a project
    // opened for the first time since the move has its chats and notes still
    // in the folder, and `ProjectInfo` would report zero of each.
    announce_migration(&app, &project);
    Ok(ProjectInfo::of(&project))
}

/// Leave the open project; later chats are unfiled again.
#[tauri::command]
async fn close_project(state: State<'_, AppState>) -> Result<(), String> {
    state.workspaces.lock().await.active = None;
    *state.session.lock().await = None;
    adopt_agent_session(&state, None).await;
    Ok(())
}

#[tauri::command]
async fn rename_project(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<ProjectInfo, String> {
    let mut guard = state.workspaces.lock().await;
    let project = guard.registry.rename(&id, &name)?;
    if guard.active.as_ref().is_some_and(|p| p.id == id) {
        guard.active = Some(project.clone());
    }
    Ok(ProjectInfo::of(&project))
}

/// Remove a project from the list. **Forgets, never deletes** — the folder,
/// its notes and its chats are all still on disk, and the UI says so.
#[tauri::command]
async fn forget_project(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    // A held Nightshift launch must not outlive the project (review F4).
    nightshift::drop_pending(&app, &id)?;
    let closed = {
        let mut guard = state.workspaces.lock().await;
        guard.registry.forget(&id)?;
        let closed = guard.active.as_ref().is_some_and(|p| p.id == id);
        if closed {
            guard.active = None;
        }
        closed
    };
    if closed {
        *state.session.lock().await = None;
    }
    Ok(())
}

// ---- notes: the docspace and the vault ---------------------------------

/// Which of the two note stores a command means.
///
/// One parameter rather than four more commands, because the four operations
/// are identical — [`project::list_notes`] and its siblings already take the
/// directory, so both stores are the same code with a different path. What
/// differs is only which folder, and which of the two can be missing.
///
/// An unrecognized value is an error rather than a default. The two stores
/// hold different things, and a typo that quietly wrote a personal note into
/// somebody's repository is exactly the failure the split exists to prevent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum NoteScope {
    /// `<workspace>/.agents` — about the code, and only while a project is
    /// open.
    Project,
    /// The user's vault — about them, and available with no project at all.
    Knowledge,
    /// `<workspace>/AGENTS.md` — the project's standing instructions, read
    /// whole into every chat's preamble. One fixed file, never a listing:
    /// the scope exists so the same editor reaches it, not so the workspace
    /// root reads as a notes folder.
    Instructions,
    /// `~/.nightloom/AGENTS.md` — user memory, how the model should behave
    /// everywhere. Same shape as `Instructions`: one file, no listing.
    Memory,
    /// `~/.nightloom/models/` — one file per model id, read whole into the
    /// preamble of a chat on that model and no other (nightshift backlog
    /// 044). A folder like the two stores, so it lists and deletes, but its
    /// names are model ids and not titles: `<id>.md`, with a `/` in the id
    /// written `__` (`prompt::model_instruction_file` is the one place that
    /// rule lives). Reads answer a missing file with empty text, as the
    /// fixed-file scopes do, so the editor can open on a model that has no
    /// file yet.
    Models,
}

impl NoteScope {
    /// The scopes that name one fixed file rather than a folder of notes.
    /// Listing them is meaningless and deleting them is a loss the
    /// never-lose-work rule forbids: the reversible form is emptying the
    /// text, which `save_note` already does.
    fn is_fixed_file(self) -> bool {
        matches!(self, Self::Instructions | Self::Memory)
    }
}

/// The one file the fixed-file scopes name.
const AGENTS_MD: &str = "AGENTS.md";

impl Default for NoteScope {
    /// What a frontend that predates the vault meant by every note call.
    fn default() -> Self {
        Self::Project
    }
}

/// The directory a scope names, or an error saying why there isn't one.
///
/// Every note command needs this and none of them should guess. The two
/// failures are genuinely different and each says so: a project scope with no
/// project open is a state the user can fix by opening one, and a knowledge
/// scope with no config directory is a machine with no home to keep a vault
/// in.
async fn scope_dir(state: &AppState, scope: NoteScope) -> Result<PathBuf, String> {
    match scope {
        NoteScope::Project => state
            .active()
            .await
            .map(|p| p.notes_dir())
            .ok_or_else(|| "no project is open, so there is no shared notes folder".to_string()),
        NoteScope::Knowledge => nightloom_service::knowledge::vault_dir()
            .ok_or_else(|| "no user config directory to keep a knowledge base in".to_string()),
        NoteScope::Instructions => state
            .active()
            .await
            .map(|p| p.workspace_dir())
            .ok_or_else(|| "no project is open, so there are no project instructions".to_string()),
        NoteScope::Memory => project::config_dir()
            .ok_or_else(|| "no user config directory to keep user memory in".to_string()),
        NoteScope::Models => nightloom_service::prompt::model_instructions_dir()
            .ok_or_else(|| "no user config directory to keep model instructions in".to_string()),
    }
}

/// The fixed-file scopes accept exactly one name. Anything else is a caller
/// bug, and answering it with a file in the workspace root would turn the
/// instructions scope into a second, unindexed docspace.
fn check_fixed_name(scope: NoteScope, name: &str) -> Result<(), String> {
    if scope.is_fixed_file() && name.trim() != AGENTS_MD {
        return Err(format!("{scope:?} names only {AGENTS_MD}, not {name}"));
    }
    Ok(())
}

#[tauri::command]
async fn list_notes(
    state: State<'_, AppState>,
    scope: Option<NoteScope>,
) -> Result<Vec<Note>, String> {
    let scope = scope.unwrap_or_default();
    if scope.is_fixed_file() {
        return Err(format!("{scope:?} is one file, not a folder to list"));
    }
    Ok(project::list_notes(&scope_dir(&state, scope).await?))
}

#[tauri::command]
async fn read_note(
    state: State<'_, AppState>,
    scope: Option<NoteScope>,
    name: String,
) -> Result<String, String> {
    let scope = scope.unwrap_or_default();
    check_fixed_name(scope, &name)?;
    let dir = scope_dir(&state, scope).await?;
    // A fixed file that does not exist yet is an empty one, not an error:
    // the editor opens on it so the user can write the first line. A model's
    // file is the same case — "+ add for this model" opens the editor on a
    // name nothing has written yet.
    if scope.is_fixed_file() && !dir.join(AGENTS_MD).is_file() {
        return Ok(String::new());
    }
    if scope == NoteScope::Models && !dir.join(name.trim()).is_file() {
        return Ok(String::new());
    }
    project::read_note(&dir, &name)
}

/// Write a note. Also how a new one is created — there is no separate
/// "create", because a note is a file and an empty one is a real note.
#[tauri::command]
async fn save_note(
    state: State<'_, AppState>,
    scope: Option<NoteScope>,
    name: String,
    content: String,
) -> Result<Note, String> {
    let scope = scope.unwrap_or_default();
    check_fixed_name(scope, &name)?;
    project::write_note(&scope_dir(&state, scope).await?, &name, &content)
}

#[tauri::command]
async fn delete_note(
    state: State<'_, AppState>,
    scope: Option<NoteScope>,
    name: String,
) -> Result<(), String> {
    let scope = scope.unwrap_or_default();
    if scope.is_fixed_file() {
        return Err(format!("{AGENTS_MD} is not deleted from here — empty it instead"));
    }
    project::delete_note(&scope_dir(&state, scope).await?, &name)
}

// ---- proposals: the dream's suggested edits to the fixed files ------------

/// The store a fixed-file scope's proposals sit beside: the active project's
/// directory under `~/.nightloom/projects/` for `instructions`, the config
/// dir for `memory`. Only those two scopes have proposals — the dream may
/// suggest a change to an always-loaded file and to nothing else — so any
/// other scope is a caller bug and says so.
async fn proposal_store(state: &AppState, scope: NoteScope) -> Result<PathBuf, String> {
    match scope {
        NoteScope::Instructions => state
            .active()
            .await
            .map(|p| p.store_dir())
            .ok_or_else(|| "no project is open, so there are no proposals for its instructions".to_string()),
        NoteScope::Memory => project::config_dir()
            .ok_or_else(|| "no user config directory to keep proposals in".to_string()),
        other => Err(format!("{other:?} has no proposals — only instructions and memory do")),
    }
}

/// Pending proposals for a fixed file, newest first — the badge on the
/// pinned row, and the one the review opens on. Cheap (a directory of small
/// files), so the frontend asks whenever it re-lists the notes.
#[tauri::command]
async fn list_proposals(
    state: State<'_, AppState>,
    scope: NoteScope,
) -> Result<Vec<nightloom_service::proposal::Entry>, String> {
    let store = proposal_store(&state, scope).await?;
    blocking(move || Ok::<_, String>(nightloom_service::proposal::list_in(&store))).await
}

#[tauri::command]
async fn read_proposal(
    state: State<'_, AppState>,
    scope: NoteScope,
    id: String,
) -> Result<nightloom_service::proposal::Proposal, String> {
    let store = proposal_store(&state, scope).await?;
    blocking(move || nightloom_service::proposal::read(&store, &id)).await
}

/// Move a proposal aside as turned down. The frontend confirms first — a
/// dismissed proposal leaves the badge, which is the closest thing here to
/// losing work — and the file is kept under `proposals/dismissed/`.
#[tauri::command]
async fn dismiss_proposal(
    state: State<'_, AppState>,
    scope: NoteScope,
    id: String,
) -> Result<(), String> {
    let store = proposal_store(&state, scope).await?;
    blocking(move || nightloom_service::proposal::dismiss(&store, &id).map(|_| ())).await
}

/// Record that a proposal was applied: called by the frontend *after* its
/// ordinary `save_note` of the draft succeeded, with the text it saved. The
/// proposal moves under `proposals/applied/` carrying a hash of that text.
/// Nothing here writes the fixed file — the save that did was the user's,
/// through the editor, which is the design.
#[tauri::command]
async fn mark_applied(
    state: State<'_, AppState>,
    scope: NoteScope,
    id: String,
    text: String,
) -> Result<(), String> {
    let store = proposal_store(&state, scope).await?;
    blocking(move || nightloom_service::proposal::applied(&store, &id, &text).map(|_| ())).await
}

// ---- the knowledge vault -----------------------------------------------

/// Where the vault is and what is in it.
#[derive(Serialize, Clone)]
struct KnowledgeInfo {
    dir: String,
    /// How the model addresses it, so the UI can show the same string the
    /// prompt does rather than inventing its own name for it.
    alias: String,
    notes: usize,
    /// Whether it sits where it would with nothing configured. What a "Reset
    /// to default" control switches off, and worth showing regardless: a vault
    /// pointing somewhere forgotten looks identical to an empty one.
    is_default: bool,
    /// False until the first note is written. Not an error — the docspace is
    /// created the same way, and a vault nobody has written in yet is the
    /// ordinary state of a new install.
    exists: bool,
}

impl KnowledgeInfo {
    fn of(dir: PathBuf, is_default: bool) -> Self {
        Self {
            notes: project::list_notes(&dir).len(),
            exists: dir.is_dir(),
            alias: nightloom_service::tools::VAULT_ALIAS.to_string(),
            is_default,
            dir: dir.to_string_lossy().into_owned(),
        }
    }

    /// `None` on a machine with no config directory, which reads as "no
    /// vault" the same way it reads as "no user memory".
    fn current() -> Option<Self> {
        let config = project::config_dir()?;
        Some(Self::of(
            nightloom_service::knowledge::vault_dir_in(&config),
            nightloom_service::knowledge::is_default_location_in(&config),
        ))
    }
}

#[tauri::command]
async fn knowledge_info() -> Result<Option<KnowledgeInfo>, String> {
    Ok(KnowledgeInfo::current())
}

/// Where the per-model instruction files live, so the editor's Folder button
/// can show it; `None` on a machine with no user config directory.
#[tauri::command]
fn model_instructions_dir() -> Option<String> {
    nightloom_service::prompt::model_instructions_dir().map(|d| d.display().to_string())
}

/// Point the vault at a folder, or back at the default with `None`.
///
/// **Moves nothing.** Both directories are left exactly as they are, which is
/// what makes an existing Obsidian vault usable as-is — and what stops a
/// changed setting from relocating somebody's notes.
#[tauri::command]
async fn set_knowledge_dir(dir: Option<String>) -> Result<Option<KnowledgeInfo>, String> {
    let chosen = dir.map(PathBuf::from).filter(|d| !d.as_os_str().is_empty());
    if let Some(dir) = &chosen {
        // A folder the user picked through a dialog exists; one typed into the
        // field may not, and creating it is friendlier than refusing a path
        // that is only a moment from being right.
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    nightloom_service::knowledge::set_vault_dir(chosen.as_deref())?;
    Ok(KnowledgeInfo::current())
}

/// The vault as notes and the links between them.
///
/// Built on a blocking thread: it reads every note in the vault, which is file
/// I/O over a folder that may hold years of them, and the runtime it would
/// otherwise sit on is the one carrying the window's events.
#[tauri::command]
async fn knowledge_graph() -> Result<nightloom_service::LinkGraph, String> {
    let dir = nightloom_service::knowledge::vault_dir()
        .ok_or_else(|| "no user config directory to keep a knowledge base in".to_string())?;
    tauri::async_runtime::spawn_blocking(move || nightloom_service::LinkGraph::build(&dir))
        .await
        .map_err(|e| format!("cannot read the knowledge base: {e}"))
}

// ---- the dream -----------------------------------------------------------

/// How many observations await the next dream — the badge over the Dream
/// button. Cheap on purpose: one file read, no locks, no model, so the UI
/// can ask after every turn.
#[tauri::command]
async fn dream_status() -> Result<usize, String> {
    Ok(project::config_dir()
        .map(|c| nightloom_service::observe::pending_count_in(&c))
        .unwrap_or(0))
}

/// What one dream did, flattened for the UI. `git` is a finished sentence
/// rather than an enum, because the frontend has nothing to add to it; with
/// the project layer it is one clause per folder the pass touched, joined.
/// `filed` is the split by target in the order the turns ran, projects
/// first and the vault last, for the toast's "N into Lanternfish, M into
/// the vault".
#[derive(Serialize)]
struct DreamReport {
    consolidated: usize,
    filed: Vec<FiledReport>,
    remaining: usize,
    interrupted: bool,
    git: String,
    /// "proposed a change to Lanternfish's instructions …", the service's
    /// own sentence (`dream::proposed_line`), or `None` when no turn
    /// proposed — a finished clause like `git`, for the same reason.
    proposed: Option<String>,
    cost_usd: Option<f64>,
}

/// One target's count. `project` is `None` for the vault.
#[derive(Serialize)]
struct FiledReport {
    project: Option<String>,
    consolidated: usize,
    /// The turn proposed a change to the target's always-loaded file.
    proposed: bool,
}

/// Run one consolidation pass over the observation log.
///
/// Takes its connection from the arguments rather than reusing the window's
/// `Chat`: a dream is its own job with its own system prompt and tool set
/// (see `service::dream::prepare`), and it works the same whichever engine
/// the window is on — which is why this is deliberately *not* gated by
/// `not_in_agent_mode`. Progress streams out as `dream-event`s, the same
/// `TurnEvent` shape `turn-event` carries but on its own channel, so a
/// running chat and a running dream cannot interleave in the transcript.
#[tauri::command]
async fn dream(
    app: AppHandle,
    state: State<'_, AppState>,
    provider: String,
    model: Option<String>,
    base_url: Option<String>,
    thinking: Option<String>,
) -> Result<DreamReport, String> {
    let Some(config) = project::config_dir() else {
        return Err("no user config directory — there is no observation log to consolidate".into());
    };
    let Some(vault) = nightloom_service::knowledge::vault_dir() else {
        return Err("no user config directory — there is no vault to consolidate into".into());
    };
    let Ok(_running) = state.dreaming.try_lock() else {
        return Err("a dream is already running".into());
    };
    // A first dream on a fresh install: an empty folder is a better start
    // than a pass that opens by erroring on list_dir.
    std::fs::create_dir_all(&vault).map_err(|e| e.to_string())?;

    let kind: ProviderKind = provider.parse()?;
    let thinking = match thinking {
        Some(s) => s.parse::<Thinking>()?,
        None => Thinking::Default,
    };
    let (provider, model) =
        nightloom_service::connect(kind, model, credentials::provider_key(kind), base_url, None)
            .map_err(|e| e.to_string())?;
    let mut chat = Chat::new(provider, model);
    chat.thinking = thinking;
    chat.context_limit = nightloom_service::context_limit(kind, &chat.model);
    chat.price = nightloom_service::price(kind, &chat.model);
    // The pass prepares the chat itself, once per target (the vault, each
    // project's memory folder), so there is no `prepare` here any more.

    let cancel = CancellationToken::new();
    *state.dream_cancel.lock().unwrap() = cancel.clone();
    let emitter = app.clone();
    let mut on_event = move |event: TurnEvent| {
        let _ = emitter.emit("dream-event", &event);
    };
    let outcome = nightloom_service::dream::run(&mut chat, &vault, &config, &cancel, &mut on_event)
        .await?
        // Checked non-empty by the UI before offering the button; a race
        // with a CLI dream is the only way here, and "nothing left" is
        // its honest report.
        .ok_or_else(|| "nothing left to consolidate".to_string())?;
    Ok(DreamReport {
        consolidated: outcome.consolidated,
        filed: outcome
            .filed
            .iter()
            .map(|f| FiledReport {
                project: f.project.clone(),
                consolidated: f.consolidated,
                proposed: f.proposed,
            })
            .collect(),
        remaining: outcome.remaining,
        interrupted: outcome.interrupted,
        proposed: nightloom_service::dream::proposed_line(&outcome.filed),
        git: outcome
            .filed
            .iter()
            .map(|f| {
                let what = match &f.project {
                    Some(name) => format!("{name}'s .agents"),
                    None => "vault".to_string(),
                };
                dream_git_line(&what, &f.git_before, &f.git_after)
            })
            .collect::<Vec<_>>()
            .join("; "),
        cost_usd: outcome.cost_usd,
    })
}

/// One clause about rollback for one folder — the CLI's `print_git`,
/// phrased for a toast. `what` names the folder (the vault, or a project's
/// `.agents`); both snapshots ran on it, so `after` carries the story.
fn dream_git_line(
    what: &str,
    before: &nightloom_service::dream::GitNote,
    after: &nightloom_service::dream::GitNote,
) -> String {
    use nightloom_service::dream::GitNote;
    if let GitNote::Failed(e) = before
        && !matches!(after, GitNote::Failed(_))
    {
        return format!("pre-dream git snapshot of {what} failed: {e}");
    }
    // What the pre-dream snapshot committed was the user's own uncommitted
    // work — necessary, so that reverting the dream does not take an edit of
    // theirs with it, and worth saying rather than leaving to be found in
    // `git log`.
    let swept = match before {
        GitNote::Committed { paths, .. } if *paths > 0 => format!(
            ", {paths} uncommitted {what} file{} committed first so this pass reverts on its own",
            if *paths == 1 { " was" } else { "s were" }
        ),
        _ => String::new(),
    };
    match after {
        GitNote::Untouched => format!("{what} untouched"),
        GitNote::NotARepo => {
            format!("{what} is not in a git repository, so there is no rollback for it")
        }
        GitNote::Committed { hash, .. } if hash.is_empty() => format!("{what} committed{swept}"),
        GitNote::Committed { hash, .. } => format!("{what} committed ({hash}){swept}"),
        GitNote::Clean => format!("{what} unchanged"),
        GitNote::Failed(e) => format!("git snapshot of {what} failed: {e}"),
    }
}

/// Interrupt the in-flight dream, if any. Separate from `cancel` because a
/// dream is not a turn: the Stop button over the transcript must not kill a
/// consolidation, and stopping a consolidation must not kill the reply the
/// user is reading.
#[tauri::command]
fn cancel_dream(state: State<'_, AppState>) {
    state.dream_cancel.lock().unwrap().cancel();
}

// ---- the capture pass ------------------------------------------------------

/// How many session logs have bytes past their capture watermark — the
/// count on the Capture button. Directory scans only, no log opened, no
/// locks, so the UI can ask after every turn. The button is always shown:
/// the inbox count says nothing about what the logs hold, and the chat
/// open right now is always one of the unread.
#[tauri::command]
async fn capture_status() -> Result<usize, String> {
    let Some(config) = project::config_dir() else {
        return Ok(0);
    };
    blocking(move || Ok::<_, String>(nightloom_service::capture::pending_count_in(&config))).await
}

/// What one capture did, flattened for the toast. `per_project` is the
/// split by source in the order the dirs were walked, "unfiled" for the
/// chats with no project.
#[derive(Serialize)]
struct CaptureReport {
    observations: usize,
    logs_read: usize,
    skipped: usize,
    deferred: usize,
    remaining: usize,
    per_project: Vec<CapturedReport>,
    interrupted: bool,
    cost_usd: Option<f64>,
}

#[derive(Serialize)]
struct CapturedReport {
    project: String,
    observations: usize,
}

/// Run one capture pass over the session logs.
///
/// The dream's twin: its own job with its own system prompt and no tools
/// (see `service::capture::prepare`), connected from the arguments rather
/// than the window's `Chat`, and working the same whichever engine the
/// window is on. It shares the dream's `dreaming` mutex rather than
/// having its own, because the two are one pipeline — capture fills the
/// inbox the dream drains — and a dream started while a capture is
/// appending would read half of what the capture wrote. The refusal is
/// the same sentence a second dream gets. Progress streams as
/// `capture-event`s on their own channel.
#[tauri::command]
async fn capture(
    app: AppHandle,
    state: State<'_, AppState>,
    provider: String,
    model: Option<String>,
    base_url: Option<String>,
    thinking: Option<String>,
) -> Result<CaptureReport, String> {
    let Some(config) = project::config_dir() else {
        return Err("no user config directory — there are no session logs to read".into());
    };
    let Ok(_running) = state.dreaming.try_lock() else {
        return Err("a dream or a capture is already running".into());
    };

    let kind: ProviderKind = provider.parse()?;
    let thinking = match thinking {
        Some(s) => s.parse::<Thinking>()?,
        None => Thinking::Default,
    };
    let (provider, model) =
        nightloom_service::connect(kind, model, credentials::provider_key(kind), base_url, None)
            .map_err(|e| e.to_string())?;
    let mut chat = Chat::new(provider, model);
    chat.thinking = thinking;
    chat.context_limit = nightloom_service::context_limit(kind, &chat.model);
    chat.price = nightloom_service::price(kind, &chat.model);

    // The same token the dream swaps in: the two never run at once (the
    // mutex above), so one Stop reaches whichever is running.
    let cancel = CancellationToken::new();
    *state.dream_cancel.lock().unwrap() = cancel.clone();
    let emitter = app.clone();
    let mut on_event = move |event: TurnEvent| {
        let _ = emitter.emit("capture-event", &event);
    };
    let outcome =
        nightloom_service::capture::run(&mut chat, &config, false, &cancel, &mut on_event)
            .await?
            .ok_or_else(|| "nothing left to capture".to_string())?;
    Ok(CaptureReport {
        observations: outcome.observations,
        logs_read: outcome.logs_read,
        skipped: outcome.skipped,
        deferred: outcome.deferred,
        remaining: outcome.remaining,
        per_project: outcome
            .per_project
            .iter()
            .map(|(project, observations)| CapturedReport {
                project: project.clone(),
                observations: *observations,
            })
            .collect(),
        interrupted: outcome.interrupted,
        cost_usd: outcome.cost_usd,
    })
}

/// Interrupt the in-flight capture, if any. The same token as the dream's
/// (they never overlap); a command of its own so the frontend's name says
/// what it stops.
#[tauri::command]
fn cancel_capture(state: State<'_, AppState>) {
    state.dream_cancel.lock().unwrap().cancel();
}

/// Show a folder in the OS file manager.
///
/// The docspace is a real directory and its whole appeal is that it is: the
/// user can drop a PDF in it, edit a note in their own editor, or put it under
/// version control. A button that opens it is what makes that discoverable.
#[tauri::command]
async fn reveal(state: State<'_, AppState>, path: Option<String>) -> Result<(), String> {
    let target = match path {
        Some(p) => PathBuf::from(p),
        None => scope_dir(&state, NoteScope::Project).await?,
    };
    // Created on demand: the docspace does not exist until something is in it,
    // and "open the folder" is a reasonable way to put the first thing there.
    if !target.exists() {
        std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    }
    project::reveal(&target).map_err(|e| e.to_string())
}

/// Interrupt the in-flight turn or compaction, if any.
#[tauri::command]
fn cancel(state: State<'_, AppState>) {
    state.cancel.lock().unwrap().cancel();
    state
        .gate
        .deny_all("the turn was interrupted before this was approved");
}

/// Answer one `tool-approval` prompt.
///
/// `decision` is "allow", "always" or "deny"; a `reason` on a denial is
/// handed to the model, which is the point — it is what lets it try something
/// else instead of repeating the same call.
#[tauri::command]
fn approve_call(
    state: State<'_, AppState>,
    id: String,
    name: String,
    decision: String,
    reason: Option<String>,
) -> Result<(), String> {
    let decision = match decision.as_str() {
        "allow" => Decision::Allow,
        "always" => {
            // Recorded on the policy, not the pending call: it has to outlive
            // this turn and every later re-connect.
            state.approval.always_allow(&name);
            Decision::AllowAlways
        }
        "deny" => Decision::Deny(
            reason
                .filter(|r| !r.trim().is_empty())
                .unwrap_or_else(|| "the user declined this call".into()),
        ),
        other => return Err(format!("unknown decision: {other}")),
    };
    state.gate.resolve(&id, decision);
    Ok(())
}

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

    win.build()?;
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
    let new_chat = MenuItemBuilder::with_id("new_chat", "New Chat")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    let add_project = MenuItemBuilder::with_id("add_project", "Open Folder as Project…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let import = MenuItemBuilder::with_id("import_claude", "Import from claude.ai…").build(app)?;

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
        .separator()
        .item(&add_project)
        .item(&import)
        .separator()
        .close_window()
        .build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&model)
        .item(&context)
        .item(&commands)
        .item(&projects)
        .separator()
        .item(&engine)
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

/// Hands a menu click to the webview as a `menu` event carrying the item's id.
///
/// Predefined items (quit, copy, minimize) are performed by the OS and arrive
/// here too; the frontend ignores every id it does not know, which is also
/// what makes adding an item a one-line change on each side.
#[cfg(target_os = "macos")]
fn mac_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    let _ = app.emit("menu", event.id().0.as_str());
}

fn main() {
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

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());

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
            });
            app.manage(AppState {
                chat: tokio::sync::Mutex::new(None),
                agent: tokio::sync::Mutex::new(None),
                session: tokio::sync::Mutex::new(None),
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
                mcp: tokio::sync::Mutex::new(None),
                dreaming: tokio::sync::Mutex::new(()),
                dream_cancel: Arc::new(std::sync::Mutex::new(CancellationToken::new())),
                prompt: tokio::sync::Mutex::new(PromptBuilt::default()),
            });
            // The Nightshift file watches, beside `AppState` rather than in it.
            app.manage(nightshift::Watches::default());
            app.manage(nightshift::PendingLaunches::default());
            app.manage(nightshift::Interviews::default());
            // Last, and that ordering is load-bearing rather than tidiness:
            // the webview starts loading the moment the window exists and its
            // first paint calls straight into `providers` and `list_sessions`,
            // which resolve `State<AppState>` and panic if nothing has managed
            // it yet.
            build_window(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            providers,
            set_api_key,
            clear_api_key,
            search_backends,
            set_search_key,
            list_models,
            context_limits,
            connect,
            connect_agent,
            list_sessions,
            search_sessions,
            rename_session,
            new_session,
            open_session,
            transcript,
            send,
            send_agent,
            cancel,
            compact,
            rewind,
            context_view,
            edit_context,
            prompt_layers,
            set_prompt_layers,
            delete_session,
            approve_call,
            pick_folder,
            pick_export,
            import_claude,
            list_projects,
            active_project,
            create_project,
            open_project,
            close_project,
            rename_project,
            forget_project,
            list_notes,
            read_note,
            save_note,
            delete_note,
            list_proposals,
            read_proposal,
            dismiss_proposal,
            mark_applied,
            knowledge_info,
            model_instructions_dir,
            set_knowledge_dir,
            knowledge_graph,
            dream_status,
            dream,
            cancel_dream,
            capture_status,
            capture,
            cancel_capture,
            reveal,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nightloom");
}
