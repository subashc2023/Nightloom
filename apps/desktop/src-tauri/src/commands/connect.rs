//! The connect command: MCP servers, the chat spec and build, kind policies and reviewers, and the session/kind/mode helpers the other commands read (moved from main.rs, item 642).

#[allow(unused_imports)]
use crate::*;

/// Start the workspace's MCP servers, or hand back the ones already running.
///
/// Returns empty when tools are off, which also drops the connections: a
/// session with no tools should not be holding server processes open.
pub(crate) async fn ensure_mcp(
    state: &AppState,
    workspace: &Path,
    tools: bool,
) -> Vec<McpServerInfo> {
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
pub(crate) struct ChatSpec {
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
    /// The open project's id, for `mark_file`'s records (nightshift
    /// backlog 377); `None` for an unfiled chat.
    project_id: Option<String>,
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
    /// The chat's own text per layer, read from its log
    /// (`Session::prompt_layer_edits`) at connect time, on the same terms
    /// as `layers_off`: what this chat says instead of the file, whatever
    /// the file says.
    layer_edits: BTreeMap<SegmentKind, String>,
    /// The chat's research thread (`Session::thread`, nightshift backlog
    /// 271), in the open project's docspace; read at connect time like
    /// `layers_off`.
    thread: Option<ThreadContext>,
    /// What the open chat was started as (`Session::mode`), read at connect
    /// time like the two above. A chat that writes nothing gets no writer
    /// in `build_chat`, and subagents and reviewers inherit it with the
    /// rest of the spec, so the promise holds one level down.
    mode: ChatMode,
    /// What the open chat is for (`Session::kind`), read at connect time
    /// like `mode` (nightshift backlog 102). ~~A Chat keeps the readers and
    /// drops every writer as an incognito chat does, and carries the Chat
    /// instructions layer; its `workspace` is the neutral folder.~~ Since
    /// backlog 144 (2026-09-17) this is the *policy* — what the chat may
    /// do now — and `declared_kind` is what the request is built for.
    chat_kind: ChatKind,
    /// What the declaration is built for (`Session::declared_kind`,
    /// nightshift backlog 144): the tool list, the Chat instructions layer
    /// and the folder follow this, so that a kind switch changes nothing
    /// at the head of the request and the cached prefix survives it. A
    /// Chat declared as a Chat keeps the readers, drops every writer and
    /// runs in the neutral folder, as before; a Chat over a Claude Code
    /// declaration keeps everything declared and refuses the writers at
    /// call time (`KindPolicy`).
    declared_kind: ChatKind,
    /// The extra folders the file tools may reach beyond the workspace
    /// (nightshift backlog 143): the project's and the chat's own, as
    /// `extra_folders` lists them. Each becomes a named tree of the `Root`.
    extra_folders: Vec<PathBuf>,
    /// The folders no file tool may reach (nightshift backlog 405): an
    /// incognito chat's `incognito::denied_roots` — his config dir, the
    /// vault, `~/.claude`, every project. Empty for every other chat.
    denied: Vec<PathBuf>,
}

impl ChatSpec {
    /// What the file tools may reach: the workspace, plus the vault when the
    /// user has left it switched on, plus the extra folders (backlog 143).
    ///
    /// The workspace alone is what the docspace living at `<workspace>/.agents`
    /// buys — a note is an ordinary relative path inside a directory the tools
    /// were already rooted at. The vault cannot be arranged that way, holding
    /// what the user knows rather than what this folder contains, so it is a
    /// named second tree reached as `@kb/…`.
    fn root(&self) -> Root {
        let root = Root::new(self.workspace.clone());
        let mut root = match &self.knowledge {
            Some(dir) => root.with_vault(dir.clone()),
            None => root,
        };
        for f in &self.extra_folders {
            root.add_extra(f.clone());
        }
        root.with_denied(self.denied.iter().cloned())
    }
}

/// Build a `Chat` from a spec: the window's own chat, and — through the
/// subagent factory — every subagent it spawns, so the two cannot drift into
/// having different tools or a different workspace.
pub(crate) fn build_chat(
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
        // How a Chat talks (nightshift backlog 102): on for that kind and
        // gated like the model's file, since it is the same kind of
        // standing text about the user.
        // By the declaration, not the policy (backlog 144): the layer is
        // in the system prompt, and a switch must not rewrite that.
        chat_instructions: spec.preamble && spec.declared_kind == ChatKind::Chat,
        // Gated on the preamble like every other discovered layer: `--bare`
        // and its desktop equivalent mean "nothing but what I typed".
        project: spec.preamble.then(|| spec.project.clone()).flatten(),
        knowledge: spec
            .preamble
            .then(|| spec.knowledge.clone().map(|dir| KnowledgeContext { dir }))
            .flatten(),
        // The thread layer (backlog 271) rides the preamble like the notes
        // index it sits beside.
        thread: spec.preamble.then(|| spec.thread.clone()).flatten(),
        cwd: spec.workspace.clone(),
        custom: spec.system.clone(),
        // The chat's own text per layer, in place of the file's for the
        // three it may edit; dormant for a layer switched off below.
        edits: spec.layer_edits.clone(),
    };
    // The chat's own exclusions last, over the rail's switches: what this
    // chat has turned off stays off whatever the rail says.
    chat.system = nightloom_service::prompt::assemble(&config.without(&spec.layers_off));
    chat.thinking = spec.thinking.clone();
    // The Tools switch itself, for each reply's cache key (nightshift item
    // 635): the window warns when it changes while the cache is warm.
    chat.tools_switch = Some(spec.tools);
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
    // A Chat over a Claude Code declaration (nightshift backlog 144): the
    // writers stay declared — see `declared_kind` — and are refused here
    // when called, whatever the approval switch says, with the reason the
    // model reads. Wrapped over the window's policy so an allowed call
    // still goes through it.
    if spec.chat_kind == ChatKind::Chat && spec.declared_kind == ChatKind::Build {
        chat.approver = Some(Arc::new(KindPolicy {
            inner: chat.approver.take(),
        }));
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
        // Never for a chat that writes nothing: the inbox is memory, and
        // memory is the first thing such a chat promised not to reach.
        if spec.knowledge.is_some()
            && !spec.mode.writes_nothing()
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
        // `send_file` (nightshift backlog 343): the model hands him a file
        // from the chat's folder as a chip on its reply. The folder only —
        // not the vault or the extra folders — and `Session`, so the filter
        // below keeps it for an incognito chat, whose copies go to the
        // temporary folder rather than the config dir.
        {
            use nightloom_service::tools::send_file;
            let store = match project::config_dir() {
                Some(config) if !spec.mode.writes_nothing() => send_file::store_in(&config),
                _ => send_file::scratch_store(),
            };
            chat.tools
                .push(Box::new(nightloom_service::tools::SendFile::new(
                    spec.workspace.clone(),
                    store,
                )));
        }
        // `mark_file` (nightshift backlog 377): the model says who each
        // file it makes is for; his are listed under the top bar's Files
        // for you. Not for a chat that writes nothing — the marks go in the
        // config dir.
        if !spec.mode.writes_nothing()
            && let Some(config) = project::config_dir()
        {
            use nightloom_service::tools::mark_file;
            chat.tools
                .push(Box::new(nightloom_service::tools::MarkFile::new(
                    spec.workspace.clone(),
                    mark_file::manifest_in(&config),
                    spec.project_id.clone(),
                )));
        }
        // The note organisers (item 472): list, make a folder, move — over
        // the vault, on the knowledge switch, for a chat that writes. The
        // writers are `Mutating`, so they pass the approval gate as a file
        // write does.
        if let Some(vault) = spec.knowledge.clone()
            && !spec.mode.writes_nothing()
        {
            chat.tools
                .extend(nightloom_service::tools::notes::note_tools(vault));
        }
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
        // Last, over everything above: a chat that writes nothing keeps
        // the readers and drops every writer, whoever supplied it. A Chat
        // (nightshift backlog 102) draws the same line for a different
        // reason — it has no folder to write into — and keeps `remember`,
        // which `reads_only` counts as a reader of the conversation. By
        // the declaration (backlog 144): a Chat switched from Claude Code
        // keeps its writers declared and `KindPolicy` refuses them.
        if spec.mode.writes_nothing() || spec.declared_kind == ChatKind::Chat {
            chat.tools.retain(|t| reads_only(t.as_ref()));
        }
    }
    if !spec.sidecar {
        chat.sidecar = Vec::new();
    }
    Ok(chat)
}

/// Whether a tool may stay on an incognito or ephemeral chat.
///
/// By effect, not by name, so a writer added to the built-in set or served
/// by an MCP server is out until someone decides otherwise — the same
/// default-closed posture the dream's tool set takes. `ReadOnly` stays;
/// `Session` stays (the task list and self-compaction change the
/// conversation and nothing else; `remember` is `Session` too and is never
/// pushed for such a chat, see `build_chat`); `Mutating` goes — files, the
/// shell, subagents, every MCP tool — **except the web**. A fetch or a
/// search writes nothing on this machine and reaches nothing of the user's;
/// incognito is about his data, not egress, and egress keeps its own switch
/// on the rail. The Claude Code engine draws the same line with
/// `READ_ONLY_TOOLS`.
pub(crate) fn reads_only(tool: &dyn Tool) -> bool {
    reads_only_by(&tool.def().name, tool.effect())
}

/// The same line, on a name and an effect rather than a tool — what
/// `KindPolicy` has of a pending call.
pub(crate) fn reads_only_by(name: &str, effect: Effect) -> bool {
    match effect {
        Effect::ReadOnly | Effect::Session => true,
        Effect::Mutating => name == "web_fetch" || name == "web_search",
    }
}

/// The Chat policy on the API engine (nightshift backlog 144): a chat that
/// is a Chat now over a Claude Code declaration. Every call `reads_only`
/// would drop from a born Chat is refused with the reason the model
/// reads — the same `is_error` result a hallucinated tool gets — and the
/// rest goes to the window's policy, or is allowed outright when the
/// approval switch is off. The counterpart of the CLI's `PreToolUse` deny
/// hook (`AgentSpec::chat_policy`); refusing at call time rather than
/// undeclaring is what keeps the cached prefix across the switch.
pub(crate) struct KindPolicy {
    pub(crate) inner: Option<Arc<dyn Approver>>,
}

#[async_trait::async_trait]
impl Approver for KindPolicy {
    async fn approve(&self, call: &PendingCall<'_>) -> Decision {
        if !reads_only_by(call.name, call.effect) {
            return Decision::Deny(nightloom_service::agent::CHAT_POLICY_REASON.to_string());
        }
        match &self.inner {
            Some(inner) => inner.approve(call).await,
            None => Decision::Allow,
        }
    }
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
pub(crate) fn reviewers(
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
/// `turn-notice` events. Sessions are created lazily by the first message
/// (`ensure_session`), so switching providers (or auto-connecting at launch)
/// never leaves empty session logs — and since 2026-09-15 neither does New
/// chat, which only sets the kind the first message will create in.
///
/// `preamble` gates the assembled system prompt (identity, environment,
/// project instructions, user memory) and `sidecar` the per-turn status
/// block. Both default to on when absent, so a frontend that predates them
/// keeps the full behaviour.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn connect(
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
    let chat_kind = session_kind(&state).await;
    let declared_kind = session_declared_kind(&state).await;
    let workspace = match &active {
        Some(project) => project.workspace_dir(),
        None => workspace
            .map(PathBuf::from)
            .filter(|p| p.is_dir())
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))),
    };
    // The folder a switch to Claude Code named wins over the project's
    // (nightshift backlog 144): a chat born as a Chat in a project with no
    // folder, or one pointed elsewhere on purpose.
    let workspace = session_kind_workspace(&state)
        .await
        .filter(|p| p.is_dir())
        .unwrap_or(workspace);
    // A Chat has no working folder (nightshift backlog 102): whatever the
    // project or the rail said, it is rooted in the neutral directory —
    // the file tools, the AGENTS.md walk and the environment line all
    // read from there. The project's notes index still comes along below,
    // since the chat is filed under the project even if it is not about
    // the project's tree. By the declaration (backlog 144): a Chat that
    // was born Claude Code keeps its folder.
    let workspace = chat_workspace(declared_kind, workspace);
    // An incognito chat knows nothing about him (nightshift backlog 405,
    // blocker 1513): its own empty folder outside the project and
    // `~/.nightloom`, no project, vault, extra folders or other chats, the
    // project's layers never read, and every folder of his refused.
    let mode = session_mode(&state).await;
    let incognito = mode.writes_nothing();
    let workspace = if incognito {
        let id = state
            .chats
            .lock_focused()
            .await
            .as_ref()
            .map(|s| s.id.clone());
        nightloom_service::incognito::workspace(id.as_deref())
    } else {
        workspace
    };
    let denied = if incognito {
        let projects = state.workspaces.lock().await.registry.projects();
        nightloom_service::incognito::denied_roots(project::config_dir().as_deref(), &projects)
    } else {
        Vec::new()
    };
    // The project as the model sees it: none for an incognito chat. The
    // window's own `active` stays — the rail still shows the project the
    // chat is filed under.
    let seen = active.as_ref().filter(|_| !incognito);
    // The extra folders (nightshift backlog 143): the project's and the
    // chat's own, each a further named tree the file tools may reach.
    let granted = if incognito {
        Vec::new()
    } else {
        extra_folders(seen, state.chats.lock_focused().await.as_ref())
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
            .flatten()
            .filter(|_| !incognito),
        project: seen.map(|p| ProjectContext {
            name: p.name.clone(),
            notes_dir: p.notes_dir(),
        }),
        project_id: seen.map(|p| p.id.clone()),
        chats: (!incognito).then_some(chats),
        layers_off: {
            let mut off = layers_off(&state).await;
            if incognito {
                off.extend(nightloom_service::incognito::LAYERS_OFF);
            }
            off
        },
        layer_edits: layer_edits(&state).await,
        thread: thread_context(seen, chat_thread(&state).await.as_deref()),
        mode,
        chat_kind,
        declared_kind,
        extra_folders: granted.iter().map(|(p, _)| p.clone()).collect(),
        denied,
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
        // With the alias each went in under, from the root the tools were
        // built with (backlog 143).
        folders: {
            let root = spec.root();
            granted
                .iter()
                .map(|(path, source)| FolderInfo {
                    path: path.to_string_lossy().into_owned(),
                    source: (*source).into(),
                    alias: root
                        .extras()
                        .into_iter()
                        .find(|(_, p)| *p == path.as_path())
                        .map(|(a, _)| format!("@{a}")),
                })
                .collect()
        },
    };
    *state.chat.lock().await = Some(Arc::new(chat));
    // One engine at a time: `Some` in either slot is what says which is
    // live, so connecting to a provider is what ends agent mode. The chat
    // itself is not cheap enough to rebuild casually, but the agent is a
    // spec and a process that has already exited.
    state.agents.disconnect();
    state
        .agent_live
        .store(false, std::sync::atomic::Ordering::SeqCst);
    *state.prompt.lock().await = PromptBuilt {
        off: spec.layers_off,
        edits: spec.layer_edits,
        thread: spec.thread,
        // The id the prompt looked its file up by — the chat's, which
        // `build_chat` filled in from the provider's default when the rail
        // sent none.
        model: Some(info.model.clone()),
        cwd: Some(spec.workspace),
        agent: None,
        mode: spec.mode,
        kind: spec.chat_kind,
        cli_agents_md: false,
    };
    Ok(info)
}

/// The open chat's switched-off layers, or none when no chat is open yet —
/// a fresh chat starts with every layer on, and its log is created lazily
/// by the first send.
pub(crate) async fn layers_off(state: &AppState) -> Vec<SegmentKind> {
    state
        .chats
        .lock_focused()
        .await
        .as_ref()
        .map(|s| s.prompt_layers_off().to_vec())
        .unwrap_or_default()
}

/// The open chat's own text per layer, or none — the same terms as
/// [`layers_off`].
pub(crate) async fn layer_edits(state: &AppState) -> BTreeMap<SegmentKind, String> {
    state
        .chats
        .lock_focused()
        .await
        .as_ref()
        .map(|s| s.prompt_layer_edits().clone())
        .unwrap_or_default()
}

/// The open chat's research thread (nightshift backlog 271), or none —
/// the same terms as [`layers_off`].
pub(crate) async fn chat_thread(state: &AppState) -> Option<String> {
    state
        .chats
        .lock_focused()
        .await
        .as_ref()
        .and_then(|s| s.thread().map(str::to_string))
}

/// A thread slug as the prompt's context, in the open project's docspace;
/// `None` without a project or for a slug that is not one.
pub(crate) fn thread_context(
    active: Option<&Project>,
    slug: Option<&str>,
) -> Option<ThreadContext> {
    ThreadContext::new(&active?.notes_dir(), slug?)
}

/// Whether the thread layer names a different thread (or none) from the
/// one the chat's CLI conversation holds — a binding he changed, taken at
/// once rather than held for the cold moment (backlog 271). The segment's
/// name carries the slug (`thread/<slug>`).
pub(crate) fn thread_rebound(held: Option<&prompt_hold::Hold>, fresh: &SystemPrompt) -> bool {
    let name = |segs: &[nightloom_core::Segment]| {
        segs.iter()
            .find(|s| s.kind == SegmentKind::Thread)
            .map(|s| s.name.clone())
    };
    held.is_some_and(|h| name(&h.segments) != name(fresh.segments()))
}

/// What the open chat was started as, or — when no chat is open yet — the
/// kind the next one will be (`AppState::pending_mode`). The two are one
/// question to every caller: `connect` and `connect_agent` build the engine
/// for it, and `prompt_layers` reports it beside the built one, so a
/// pending incognito chat gets its engine without writers *before* the
/// first message rather than one reconnect after it.
pub(crate) async fn session_mode(state: &AppState) -> ChatMode {
    let pending = *state.pending_mode.lock().await;
    mode_of(state.chats.lock_focused().await.as_ref(), pending)
}

/// The mode the shell is in: the open chat's own, else the pending one.
/// The pure half of [`session_mode`], so a test can pin it without an
/// `AppState`.
pub(crate) fn mode_of(session: Option<&Session>, pending: ChatMode) -> ChatMode {
    session.map(Session::mode).unwrap_or(pending)
}

/// What the open chat is for, or — with no chat open — what the next one
/// will be (`AppState::pending_kind`); `session_mode`'s twin (nightshift
/// backlog 102). `connect` and `connect_agent` root and equip the engine
/// for it, and `prompt_layers` reports it beside the built one.
pub(crate) async fn session_kind(state: &AppState) -> ChatKind {
    let pending = *state.pending_kind.lock().await;
    kind_of(state.chats.lock_focused().await.as_ref(), pending)
}

/// The pure half of [`session_kind`], like [`mode_of`].
pub(crate) fn kind_of(session: Option<&Session>, pending: ChatKind) -> ChatKind {
    session.map(Session::kind).unwrap_or(pending)
}

/// What the open chat's request is *built* for (`Session::declared_kind`,
/// nightshift backlog 144), or the pending kind with no chat open: the tool
/// list, the Chat layer and the folder follow this; [`session_kind`] is
/// the policy enforced over it. The two differ only on a chat born Claude
/// Code that is a Chat now — see `KindPolicy` and `AgentSpec::chat_policy`.
pub(crate) async fn session_declared_kind(state: &AppState) -> ChatKind {
    let pending = *state.pending_kind.lock().await;
    state
        .chats
        .lock_focused()
        .await
        .as_ref()
        .map(Session::declared_kind)
        .unwrap_or(pending)
}

/// The folder the open chat's latest switch to Claude Code named, if it
/// named one (`Session::kind_workspace`, nightshift backlog 144): a chat
/// born as a Chat has no folder of its own, and the switch asks for one
/// when the project's is not wanted. `None` for every other chat.
pub(crate) async fn session_kind_workspace(state: &AppState) -> Option<PathBuf> {
    state
        .chats
        .lock_focused()
        .await
        .as_ref()
        .and_then(|s| s.kind_workspace().map(Path::to_path_buf))
}

/// Where a chat of `kind` runs: the folder the caller resolved for a Build
/// chat, the neutral directory (`prompt::chat_dir`, `~/.nightloom/chat/`)
/// for a Chat — falling back to the caller's folder only on a machine with
/// no config directory to make one in, which is the machine every other
/// standing file is already missing on.
///
/// Since backlog 144 the callers pass the *declared* kind: a chat born
/// Claude Code that is a Chat now stays in its folder (nightshift blocker
/// 210), the writers refused rather than the folder taken away.
pub(crate) fn chat_workspace(kind: ChatKind, resolved: PathBuf) -> PathBuf {
    match kind {
        ChatKind::Build => resolved,
        ChatKind::Chat => nightloom_service::prompt::chat_dir().unwrap_or(resolved),
    }
}

/// The session the next turn records into, created now if there is none
/// (nightshift backlog 061, 2026-09-15).
///
/// One helper for the four commands that used to each create an ordinary
/// log when they found no session — `send`, `send_agent`,
/// `set_prompt_layers`, `set_prompt_layer_text`. They create in the
/// pending kind now, which is what makes New chat a state rather than a
/// file: the kind is chosen at the button and honoured at the first
/// message. The pending mode is left as it was — once the log exists its
/// first line answers the question, and `session_mode` reads that first.
///
/// Since backlog 159 A1 (2026-09-24) the commands go through
/// [`chats::Chats::focused_or_start`], which makes the chat with the same
/// [`start_session`] and focuses it; this `Option` form stays as the pure
/// statement of the rule the tests below pin.
#[cfg(test)]
pub(crate) fn ensure_session<'a>(
    session: &'a mut Option<Session>,
    mode: ChatMode,
    kind: ChatKind,
    log_dir: &Path,
) -> Result<&'a mut Session, String> {
    if session.is_none() {
        *session = Some(start_session(mode, kind, log_dir).map_err(|e| e.to_string())?);
    }
    Ok(session.as_mut().expect("session ensured above"))
}

/// A chat in `mode` of `kind`: an ordinary log, a log marked incognito on
/// its first line, or no log at all (`Session::ephemeral`), each with the
/// kind on the same line (nightshift backlog 102).
pub(crate) fn start_session(
    mode: ChatMode,
    kind: ChatKind,
    log_dir: &Path,
) -> std::io::Result<Session> {
    Session::start(log_dir, mode, kind)
}
