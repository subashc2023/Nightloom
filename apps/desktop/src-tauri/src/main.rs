//! Nightloom desktop shell: Tauri commands over `nightloom-service`.
//!
//! Streaming goes out as `turn-event` window events (serialized
//! [`TurnEvent`]s); retry stalls surface as `turn-notice` strings. Commands
//! mirror the service API and return plain serializable values.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use nightloom_core::Tool;
use nightloom_core::{
    DocumentInput, ImageInput, ProviderError, Session, SessionEvent, Thinking, WireView,
};
use nightloom_service::approval::{Approver, AutoApprove, Decision, PendingCall};
use nightloom_service::credentials::{self, KeySource};
use nightloom_service::import;
use nightloom_service::project::{self, Note, Project, Registry};
use nightloom_service::store::{self, SessionMatch, SessionSummary};
use nightloom_service::tools::{Reviewer, Root, SearchBackend};
use nightloom_service::{
    AgentSpec, Chat, ClaudeCodeAgent, CompactOutcome, Price, ProjectContext, PromptConfig,
    ProviderKind, Recorder, TurnEvent, TurnInput, TurnOutcome, resolve_binary, searched_locations,
};
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio_util::sync::CancellationToken;

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
            chats: store::list(&project.session_dir())
                .map(|s| s.len())
                .unwrap_or(0),
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
    /// `dontAsk` or `bypassPermissions`, or `None` when tools are off.
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
}

impl ChatSpec {
    /// What the file tools may reach: the workspace, and only that.
    ///
    /// One tree, which is what putting the docspace at `<workspace>/.agents`
    /// buys — a note is an ordinary relative path inside a directory the
    /// tools were already rooted at.
    fn root(&self) -> Root {
        Root::new(self.workspace.clone())
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
    chat.system = nightloom_service::prompt::assemble(&PromptConfig {
        identity: spec.preamble,
        environment: spec.preamble,
        project_instructions: spec.preamble,
        user_memory: spec.preamble,
        // Gated on the preamble like every other discovered layer: `--bare`
        // and its desktop equivalent mean "nothing but what I typed".
        project: spec.preamble.then(|| spec.project.clone()).flatten(),
        cwd: spec.workspace.clone(),
        custom: spec.system.clone(),
    });
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
        project: active.as_ref().map(|p| ProjectContext {
            name: p.name.clone(),
            notes_dir: p.notes_dir(),
        }),
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
        engine: "provider".into(),
        agent: None,
    };
    *state.chat.lock().await = Some(chat);
    // One engine at a time: `Some` in either slot is what says which is
    // live, so connecting to a provider is what ends agent mode. The chat
    // itself is not cheap enough to rebuild casually, but the agent is a
    // spec and a process that has already exited.
    *state.agent.lock().await = None;
    Ok(info)
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
/// base URL, no thinking mode, no preamble or sidecar, no MCP list, no
/// reviewers — because Claude Code assembles its own prompt and runs its own
/// loop. A shared entry point would be one whose arguments are mostly inert,
/// which is the shape that invites a knob to be silently ignored.
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
    spec.append_system_prompt = system
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());
    if tools {
        // Headless has no way to ask, so the two honest settings are "deny
        // anything not already permitted" and "run everything". The window's
        // approval prompt is not one of them: it gates calls the engine is
        // about to run, and this engine runs its own.
        spec.permission_mode = Some(if approval.unwrap_or(true) {
            "dontAsk".into()
        } else {
            "bypassPermissions".into()
        });
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
#[tauri::command]
async fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionSummary>, String> {
    store::list(&state.log_dir().await).map_err(|e| e.to_string())
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
    store::search(&state.log_dir().await, &query).map_err(|e| e.to_string())
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
    chat.run_turn(session, input, &cancel, &mut on_event)
        .await
        .map_err(|e| e.to_string())
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
#[tauri::command]
async fn send_agent(
    app: AppHandle,
    state: State<'_, AppState>,
    text: String,
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
    session.record_user(&text);

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
    let result = agent.run_turn(&text, &cancel, &mut on_event).await;

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
#[tauri::command]
async fn context_view(state: State<'_, AppState>) -> Result<WireView, String> {
    not_in_agent_mode(&state, "itemize the context").await?;
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

/// Delete a session log. If it is the active session, the open log handle is
/// dropped first (the next send starts a fresh session).
#[tauri::command]
async fn delete_session(state: State<'_, AppState>, id: String) -> Result<String, String> {
    let path = store::find_by_prefix(&state.log_dir().await, &id).map_err(|e| e.to_string())?;
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
    std::fs::remove_file(&path).map_err(|e| e.to_string())?;
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
async fn pick_folder(app: AppHandle, state: State<'_, AppState>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let start = match state.active().await {
        Some(project) => project.workspace,
        None => project::config_dir().map(|d| d.parent().unwrap_or(&d).to_path_buf()),
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut builder = app.dialog().file().set_title("Choose a project folder");
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
async fn forget_project(state: State<'_, AppState>, id: String) -> Result<(), String> {
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

// ---- the docspace ------------------------------------------------------

/// The notes directory of the open project, or an error naming why there
/// isn't one. Every note command needs this and none of them should guess.
async fn notes_dir(state: &AppState) -> Result<PathBuf, String> {
    state
        .active()
        .await
        .map(|p| p.notes_dir())
        .ok_or_else(|| "no project is open, so there is no shared notes folder".to_string())
}

#[tauri::command]
async fn list_notes(state: State<'_, AppState>) -> Result<Vec<Note>, String> {
    Ok(project::list_notes(&notes_dir(&state).await?))
}

#[tauri::command]
async fn read_note(state: State<'_, AppState>, name: String) -> Result<String, String> {
    project::read_note(&notes_dir(&state).await?, &name)
}

/// Write a note. Also how a new one is created — there is no separate
/// "create", because a note is a file and an empty one is a real note.
#[tauri::command]
async fn save_note(
    state: State<'_, AppState>,
    name: String,
    content: String,
) -> Result<Note, String> {
    project::write_note(&notes_dir(&state).await?, &name, &content)
}

#[tauri::command]
async fn delete_note(state: State<'_, AppState>, name: String) -> Result<(), String> {
    project::delete_note(&notes_dir(&state).await?, &name)
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
        None => notes_dir(&state).await?,
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
/// The four custom items are *forwarded to the webview* rather than performed
/// here (see [`mac_menu_event`]). Each one is a frontend flow — a modal, a
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

    let view = SubmenuBuilder::new(app, "View").fullscreen().build()?;

    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .separator()
        .bring_all_to_front()
        .build()?;

    MenuBuilder::new(app)
        .items(&[&app_menu, &file, &edit, &view, &window])
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
            });
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
            reveal,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nightloom");
}
