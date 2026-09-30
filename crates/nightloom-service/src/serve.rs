//! `nightloom serve`: the phone page with the desktop app closed
//! (nightshift item 268, step 1).
//!
//! A windowless [`Host`] for the phone listener ([`crate::remote`]): the
//! chat list and transcripts read from the logs on disk, and a message runs
//! a Claude Code turn in this process through
//! [`crate::agent_turn::run_agent_turn`] — the function the desktop's
//! `send_agent` runs — recorded into the same log, so the desktop shows the
//! turn when it next opens and its next message resumes the same CLI
//! session.
//!
//! # One holder (the rule step 1 must not break)
//!
//! `serve` and the desktop must never both hold a chat. The stricter option
//! is taken: they never both run on one Nightloom home. [`HomeLock`] is an
//! OS file lock on `<config>/holder.lock` that each takes at start — `serve`
//! refuses to start while the desktop holds it, and the desktop refuses to
//! open while `serve` does. The lock dies with its process, so a crash
//! leaves nothing stale. A desktop build from before the lock does not take
//! it, so `serve` on the default home also refuses while any
//! `nightloom-desktop` process runs ([`desktop_running`]).
//!
//! # What step 1 leaves out
//!
//! One turn at a time (Keepsake's `CallLock` lesson, and all a phone
//! needs). No provider engine: Claude Code only. No checkpoint helper, no
//! prompt hold (the preamble is built fresh each turn, so a chat's cache
//! may be cold after a layer changed on the Mac), no chat naming pass.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

use nightloom_core::{ChatKind, ChatMode, SegmentKind, Session, SessionEvent, TitleBy};
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;

use crate::agent::{AgentSpec, Answer, AskGate, ClaudeCodeAgent, PlanThen};
use crate::agent_turn::{
    AGENT, AgentTurnEnd, AgentTurnRun, ApprovalPrompt, ChatEvent, ProjectGrant, TurnEnv,
    run_agent_turn,
};
use crate::project::{self, Project, Registry};
use crate::remote::api::feature;
use crate::remote::{
    ApproveRequest, Asset, ChatRow, Event, Handed, Host, ProjectRow, RemoteState, SendRequest,
};
use crate::store;
use crate::turn::{TurnEvent, TurnInput};

/// The lock file both holders honour, in the config dir.
pub const LOCK_FILE: &str = "holder.lock";

/// The process that holds a Nightloom home: the desktop app or `serve`.
/// Held for the process's life; the OS lets go when it exits.
#[derive(Debug)]
pub struct HomeLock {
    _file: File,
    path: PathBuf,
}

impl HomeLock {
    /// Take `<config>/holder.lock` for `who` (`desktop` or `serve`), or say
    /// who holds it.
    pub fn take(config: &Path, who: &str) -> Result<Self, String> {
        std::fs::create_dir_all(config).map_err(|e| format!("{}: {e}", config.display()))?;
        let path = config.join(LOCK_FILE);
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|e| format!("{}: {e}", path.display()))?;
        match file.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => {
                let mut held = String::new();
                let _ = file.read_to_string(&mut held);
                let held = held.trim();
                return Err(format!(
                    "this Nightloom home ({}) is in use by {} — quit it first; \
                     the desktop app and `nightloom serve` never both hold the chats",
                    config.display(),
                    if held.is_empty() {
                        "another Nightloom process"
                    } else {
                        held
                    }
                ));
            }
            Err(std::fs::TryLockError::Error(e)) => {
                return Err(format!("{}: {e}", path.display()));
            }
        }
        // Who holds it, for the other one's refusal.
        let _ = file.set_len(0);
        let _ = file.rewind();
        let _ = write!(file, "{who} (pid {})", std::process::id());
        let _ = file.flush();
        Ok(Self { _file: file, path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Whether a `nightloom-desktop` process is running (any build, any home):
/// the check for a desktop from before [`HomeLock`], which does not take it.
pub fn desktop_running() -> bool {
    std::process::Command::new("pgrep")
        .args(["-x", "nightloom-desktop"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// How `serve` runs its turns.
#[derive(Debug, Clone)]
pub struct ServeConfig {
    /// The `claude` binary (resolved as the desktop resolves it).
    pub binary: String,
    /// The model alias every turn asks for; `None` is the CLI's default.
    pub model: Option<String>,
    /// This binary, for the CLI's Ask hook (`permission-hook <dir>`) and
    /// Nightloom's MCP tools (`mcp-serve`). `None`: neither — the CLI runs
    /// in `auto` with no hook, and nothing is ever asked.
    pub hook_exe: Option<PathBuf>,
    /// The built phone page (`apps/desktop/dist`), or `None` for API only.
    pub assets: Option<PathBuf>,
    /// Where unfiled chats live (`<config>/unfiled/sessions`).
    pub unfiled_dir: PathBuf,
    /// The folder an unfiled Build chat runs in (`serve`'s working
    /// directory by default).
    pub unfiled_workspace: PathBuf,
}

impl ServeConfig {
    /// The defaults for `config`'s home.
    pub fn for_home(config: &Path) -> Self {
        Self {
            binary: "claude".into(),
            model: None,
            hook_exe: None,
            assets: None,
            unfiled_dir: config.join("unfiled").join(project::SESSIONS_DIR),
            // As the desktop's connect falls back when no project is open
            // and the rail names no folder: the working directory.
            unfiled_workspace: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        }
    }
}

/// The turn running now.
struct Turn {
    chat: String,
    cancel: CancellationToken,
}

/// The windowless host.
pub struct ServeHost {
    me: Weak<ServeHost>,
    cfg: ServeConfig,
    registry: Mutex<Registry>,
    /// The project the phone last worked in (`None`: unfiled).
    active_project: Mutex<Option<String>>,
    /// The chat the phone last worked in.
    active_chat: Mutex<Option<String>>,
    turn: Mutex<Option<Turn>>,
    ask: AskGate,
    /// The approval prompts still waiting, as the window's payloads.
    pending: Mutex<HashMap<String, serde_json::Value>>,
    tx: broadcast::Sender<Event>,
}

impl ServeHost {
    pub fn new(cfg: ServeConfig, registry: Registry) -> Arc<Self> {
        let (tx, _) = broadcast::channel(1024);
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            cfg,
            registry: Mutex::new(registry),
            active_project: Mutex::new(None),
            active_chat: Mutex::new(None),
            turn: Mutex::new(None),
            ask: AskGate::new(),
            pending: Mutex::new(HashMap::new()),
            tx,
        })
    }

    fn emit(&self, name: &str, payload: String) {
        let _ = self.tx.send(Event {
            name: name.into(),
            payload,
        });
    }

    fn project(&self, id: Option<&str>) -> Result<Option<Project>, String> {
        let id = match id {
            Some(id) => Some(id.to_string()),
            None => lock(&self.active_project).clone(),
        };
        match id {
            None => Ok(None),
            Some(id) => lock(&self.registry)
                .find(&id)
                .cloned()
                .map(Some)
                .ok_or_else(|| format!("no project {id}")),
        }
    }

    fn log_dir(&self, project: Option<&Project>) -> PathBuf {
        project
            .map(Project::session_dir)
            .unwrap_or_else(|| self.cfg.unfiled_dir.clone())
    }

    /// Whether a turn is running now.
    pub fn busy(&self) -> bool {
        lock(&self.turn).is_some()
    }

    /// The spec a turn in `session` runs under: the desktop's connect,
    /// cut to what a turn needs — the folder by the chat's kind, the vault
    /// and extra folders granted, the preamble by the chat's layers, `auto`
    /// with the Ask position when this binary can be the hook, and the
    /// chat's recorded CLI session resumed.
    pub fn spec_for(&self, project: Option<&Project>, session: &Session) -> AgentSpec {
        let declared = session.declared_kind();
        let base = session
            .kind_workspace()
            .map(Path::to_path_buf)
            .or_else(|| project.map(Project::workspace_dir))
            .unwrap_or_else(|| self.cfg.unfiled_workspace.clone());
        let workspace = match declared {
            ChatKind::Build => base,
            ChatKind::Chat => crate::prompt::chat_dir().unwrap_or(base),
        };
        let mut spec = AgentSpec::new(workspace.clone());
        spec.binary = self.cfg.binary.clone();
        spec.model = self.cfg.model.clone();
        // No checkpoint helper on this host (the desktop's `sync_checkpoint`).
        spec.fork_mode = false;
        // A chat does not compact (backlog 086).
        spec.auto_compact = false;
        let off: Vec<SegmentKind> = session.prompt_layers_off().to_vec();
        let edits = session.prompt_layer_edits().clone();
        spec.auto_memory = !off.contains(&SegmentKind::CliMemory);
        let knowledge = crate::knowledge::vault_dir();
        spec.add_dirs = knowledge.iter().cloned().collect();
        let mut granted: Vec<PathBuf> =
            project.map(|p| p.extra_folders.clone()).unwrap_or_default();
        granted.extend(session.folders().iter().cloned());
        spec.add_dirs.extend(granted.iter().cloned());
        let prompt = crate::agent_prompt_with(
            &crate::PromptConfig {
                identity: false,
                environment: false,
                project_instructions: true,
                user_memory: true,
                model: spec.model.clone(),
                chat_instructions: declared == ChatKind::Chat,
                project: project.map(|p| crate::ProjectContext {
                    name: p.name.clone(),
                    notes_dir: p.notes_dir(),
                }),
                knowledge: knowledge.map(|dir| crate::KnowledgeContext { dir }),
                cwd: workspace,
                custom: None,
                edits,
            }
            .without(&off),
            None,
            crate::EngineLayers {
                engine_note: !off.contains(&SegmentKind::EngineNote),
                pacing: !off.contains(&SegmentKind::Pacing),
                subagents: !off.contains(&SegmentKind::Subagents),
                reusable: false,
                subagent_model: spec.subagent_limits.unwrap_or_default().model,
            },
        );
        spec.append_system_prompt = prompt.render_flat();
        if !granted.is_empty() && !off.contains(&SegmentKind::EngineNote) {
            let list: Vec<String> = granted.iter().map(|p| p.display().to_string()).collect();
            let note = format!(
                "<extra-folders>\nBesides the working directory, this chat may read and edit \
                 these folders, by their absolute paths: {}. Notes and AGENTS.md stay in the \
                 working directory.\n</extra-folders>",
                list.join("; ")
            );
            spec.append_system_prompt = Some(match spec.append_system_prompt.take() {
                Some(s) => format!("{s}\n\n{note}"),
                None => note,
            });
        }
        spec.permission_mode = Some(AgentSpec::headless_permission_mode(true).into());
        if let Some(exe) = &self.cfg.hook_exe {
            let exe = exe.to_string_lossy().into_owned();
            spec.ask = Some(crate::agent::AskSpec {
                hook: vec![exe.clone(), "permission-hook".into()],
                dir: PathBuf::new(),
                mode: crate::agent::AskMode::Ask,
                subagents_auto: crate::agent::ask::SUBAGENTS_AUTO_DEFAULT,
            });
            let mut args = vec!["mcp-serve".to_string()];
            if let Some(p) = project {
                args.push("--project".into());
                args.push(p.id.clone());
            }
            if session.mode().writes_nothing() {
                args.push("--no-remember".into());
            }
            args.push("--ask".into());
            spec.mcp_config = Some(
                serde_json::json!({
                    "mcpServers": {
                        crate::mcp_server::SERVER_NAME: { "command": exe, "args": args }
                    }
                })
                .to_string(),
            );
        }
        spec.apply_mode(session.mode());
        spec.apply_kind(declared);
        spec.apply_kind_policy(session.kind(), declared);
        if !spec.no_session_persistence
            && let Some((agent, id)) = session.agent_session()
            && agent == AGENT
        {
            spec.resume = Some(id.to_string());
        }
        spec
    }

    /// Take the one turn slot for `chat`, or say what holds it.
    fn claim(&self, chat: &str) -> Result<CancellationToken, String> {
        let mut turn = lock(&self.turn);
        if let Some(t) = turn.as_ref() {
            return Err(if t.chat == chat {
                "a turn is running in this chat; send again when it ends".into()
            } else {
                "a turn is running in another chat; send again when it ends".into()
            });
        }
        let cancel = CancellationToken::new();
        *turn = Some(Turn {
            chat: chat.to_string(),
            cancel: cancel.clone(),
        });
        Ok(cancel)
    }

    /// Run a turn in `session`, off the request (the phone is answered as
    /// soon as it is handed on).
    fn spawn_turn(
        &self,
        project: Option<Project>,
        session: Session,
        req: SendRequest,
        cancel: CancellationToken,
    ) {
        let Some(me) = self.me.upgrade() else {
            return;
        };
        tokio::spawn(async move {
            let chat = session.id.clone();
            me.run_turn(project, session, req, cancel).await;
            *lock(&me.turn) = None;
            lock(&me.pending).retain(|_, v| v.get("chat").and_then(|c| c.as_str()) != Some(&chat));
            // The phone re-asks `/api/state` after every event: this one
            // is the one that finds the chat free.
            me.emit(
                "turn-notice",
                serde_json::to_string("the turn ended").unwrap_or_default(),
            );
        });
    }

    async fn run_turn(
        &self,
        project: Option<Project>,
        mut session: Session,
        req: SendRequest,
        cancel: CancellationToken,
    ) {
        let log_dir = self.log_dir(project.as_ref());
        let mut agent = ClaudeCodeAgent::new(self.spec_for(project.as_ref(), &session));
        let ask_dir = session
            .log_path()
            .and_then(|p| p.file_stem().map(|s| s.to_os_string()))
            .map(|stem| log_dir.join("ask").join(stem));
        if let Some(dir) = &ask_dir {
            agent.set_ask_dir(dir.clone());
        }
        let chat_id = session.id.clone();
        self.emit(
            "turn-chat",
            serde_json::to_string(&chat_id).unwrap_or_default(),
        );
        let env = ServeEnv {
            host: self,
            project: project.as_ref().map(|p| p.id.clone()),
        };
        let end = run_agent_turn(
            AgentTurnRun {
                agent: &mut agent,
                session: &mut session,
                chat_id: &chat_id,
                input: TurnInput {
                    text: req.text,
                    images: req.images,
                    documents: req.documents,
                },
                spoken: req.spoken,
                council: req.council,
                cancel: &cancel,
                ask_dir,
                ask: &self.ask,
            },
            &env,
        )
        .await;
        match end {
            Ok(AgentTurnEnd::Done { outcome, .. }) => {
                for n in outcome.notices {
                    env.notice(n);
                }
            }
            Ok(AgentTurnEnd::StoppedInCouncil) => {
                env.notice("stopped during the council's seats; no chair ran".into());
            }
            Err(e) => env.notice(format!("the turn failed: {e}")),
        }
    }

    fn find_chat(&self, project: Option<&Project>, chat: &str) -> Result<PathBuf, String> {
        store::find_by_prefix(&self.log_dir(project), chat).map_err(|e| e.to_string())
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn lowercase<T: std::fmt::Debug>(v: T) -> String {
    format!("{v:?}").to_lowercase()
}

/// What a turn on this host sends where: every event to the relay, and a
/// folder granted for the project into the registry on disk.
struct ServeEnv<'a> {
    host: &'a ServeHost,
    project: Option<String>,
}

#[async_trait::async_trait]
impl TurnEnv for ServeEnv<'_> {
    fn event(&self, chat: &str, event: &TurnEvent) {
        if let Ok(p) = serde_json::to_string(&ChatEvent { chat, event }) {
            self.host.emit("turn-event", p);
        }
    }

    fn notice(&self, text: String) {
        self.host.emit(
            "turn-notice",
            serde_json::to_string(&text).unwrap_or_default(),
        );
    }

    fn approval(&self, prompt: &ApprovalPrompt<'_>) {
        if let Ok(v) = serde_json::to_value(prompt) {
            lock(&self.host.pending).insert(prompt.id.to_string(), v.clone());
            self.host.emit("tool-approval", v.to_string());
        }
    }

    async fn grant_to_project(&self, dir: &Path) -> ProjectGrant {
        let Some(id) = &self.project else {
            return ProjectGrant::NoProject;
        };
        let mut registry = lock(&self.host.registry);
        let Some(p) = registry.find(id).cloned() else {
            return ProjectGrant::NoProject;
        };
        let mut list = p.extra_folders.clone();
        list.push(dir.to_path_buf());
        match registry.set_extra_folders(&p.id, list) {
            Ok(_) => ProjectGrant::Kept,
            Err(e) => ProjectGrant::Failed(e),
        }
    }
}

#[async_trait::async_trait]
impl Host for ServeHost {
    async fn state(&self) -> RemoteState {
        let running = lock(&self.turn).as_ref().map(|t| t.chat.clone());
        let project = self.project(None).ok().flatten().map(|p| p.name);
        RemoteState {
            project,
            busy: running.is_some(),
            active_chat: running.or_else(|| lock(&self.active_chat).clone()),
            connected: true,
            engine: Some(AGENT.to_string()),
            pending: lock(&self.pending).values().cloned().collect(),
            voice: None,
        }
    }

    async fn chats(&self, project: Option<&str>) -> Result<Vec<ChatRow>, String> {
        let project = self.project(project)?;
        let dir = self.log_dir(project.as_ref());
        let rows = tokio::task::spawn_blocking(move || store::list(&dir))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        Ok(rows
            .into_iter()
            .map(|s| ChatRow {
                label: s.label(80),
                id: s.id,
                modified: s.modified,
                user_turns: s.user_turns,
                kind: lowercase(s.kind),
                mode: lowercase(s.mode),
            })
            .collect())
    }

    async fn projects(&self) -> Result<Vec<ProjectRow>, String> {
        let open = lock(&self.active_project).clone();
        Ok(lock(&self.registry)
            .projects()
            .into_iter()
            .map(|p| ProjectRow {
                active: open.as_deref() == Some(p.id.as_str()),
                id: p.id,
                name: p.name,
            })
            .collect())
    }

    async fn transcript(
        &self,
        project: Option<&str>,
        id: &str,
    ) -> Result<Vec<SessionEvent>, String> {
        let project = self.project(project)?;
        let path = self.find_chat(project.as_ref(), id)?;
        tokio::task::spawn_blocking(move || -> Result<Vec<SessionEvent>, String> {
            let session = Session::load(path).map_err(|e| e.to_string())?;
            Ok(session.events().to_vec())
        })
        .await
        .map_err(|e| e.to_string())?
    }

    async fn send(&self, chat: Option<&str>, text: &str) -> Result<Handed, String> {
        self.send_with(
            chat,
            SendRequest {
                text: text.to_string(),
                ..SendRequest::default()
            },
        )
        .await
    }

    async fn send_spoken(&self, chat: Option<&str>, text: &str) -> Result<Handed, String> {
        self.send_with(
            chat,
            SendRequest {
                text: text.to_string(),
                spoken: true,
                ..SendRequest::default()
            },
        )
        .await
    }

    async fn send_with(&self, chat: Option<&str>, req: SendRequest) -> Result<Handed, String> {
        if req.text.trim().is_empty() && req.images.is_empty() && req.documents.is_empty() {
            return Err("nothing to send".into());
        }
        let project = self.project(req.project.as_deref())?;
        let chat = match chat {
            Some(c) => c.to_string(),
            None => lock(&self.active_chat)
                .clone()
                .ok_or("no chat is open; start a new one")?,
        };
        let path = self.find_chat(project.as_ref(), &chat)?;
        let session = tokio::task::spawn_blocking(move || Session::load(path))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        let cancel = self.claim(&session.id)?;
        *lock(&self.active_chat) = Some(session.id.clone());
        *lock(&self.active_project) = project.as_ref().map(|p| p.id.clone());
        self.spawn_turn(project, session, req, cancel);
        Ok(Handed::Sent)
    }

    async fn new_chat(&self, project: Option<&str>, text: &str) -> Result<Handed, String> {
        if text.trim().is_empty() {
            return Err("nothing to send".into());
        }
        let project = self.project(project)?;
        // Checked before a log exists, so a refused start leaves no empty chat.
        if self.busy() {
            return Err("a turn is running in another chat; send again when it ends".into());
        }
        let dir = self.log_dir(project.as_ref());
        let session = tokio::task::spawn_blocking(move || {
            Session::start(dir, ChatMode::Normal, ChatKind::Build)
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
        let cancel = self.claim(&session.id)?;
        *lock(&self.active_chat) = Some(session.id.clone());
        *lock(&self.active_project) = project.as_ref().map(|p| p.id.clone());
        self.spawn_turn(
            project,
            session,
            SendRequest {
                text: text.to_string(),
                ..SendRequest::default()
            },
            cancel,
        );
        Ok(Handed::Sent)
    }

    async fn rename(&self, chat: &str, title: &str) -> Result<(), String> {
        let title = title.trim();
        if title.is_empty() {
            return Err("a name cannot be empty".into());
        }
        if lock(&self.turn)
            .as_ref()
            .is_some_and(|t| t.chat.starts_with(chat))
        {
            return Err("a turn is running in this chat; rename it when it ends".into());
        }
        let project = self.project(None)?;
        let path = self.find_chat(project.as_ref(), chat)?;
        let title = title.to_string();
        tokio::task::spawn_blocking(move || -> Result<(), String> {
            let mut session = Session::load(path).map_err(|e| e.to_string())?;
            session.record_title_by(title, TitleBy::User);
            match session.write_failure() {
                Some(f) => Err(f.summary()),
                None => Ok(()),
            }
        })
        .await
        .map_err(|e| e.to_string())?
    }

    async fn open(&self, chat: &str) -> Result<(), String> {
        // No window: the phone's own last chat, for a send with none named.
        let project = self.project(None)?;
        let path = self.find_chat(project.as_ref(), chat)?;
        let id = path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| chat.to_string());
        let id = Session::load(&path).map(|s| s.id).unwrap_or(id);
        *lock(&self.active_chat) = Some(id);
        Ok(())
    }

    async fn approve(&self, req: ApproveRequest) -> Result<(), String> {
        if !self.ask.has(&req.id) {
            return Err("nothing is waiting for that answer".into());
        }
        let answer = match req.decision.as_str() {
            "allow" => Answer::Allow {
                updated_input: req.answer,
                plan_then: req.then.as_deref().and_then(PlanThen::parse),
                grant: None,
            },
            "always" => Answer::AllowForChat {
                updated_input: req.answer,
            },
            "deny" => Answer::Deny {
                reason: req
                    .reason
                    .filter(|r| !r.trim().is_empty())
                    .unwrap_or_else(|| "the user declined this call".into()),
            },
            other => return Err(format!("unknown decision: {other}")),
        };
        lock(&self.pending).remove(&req.id);
        self.ask.answer(&req.id, answer);
        Ok(())
    }

    async fn cancel(&self, chat: Option<&str>) -> Result<(), String> {
        if let Some(t) = lock(&self.turn).as_ref()
            && chat.is_none_or(|c| t.chat.starts_with(c))
        {
            t.cancel.cancel();
        }
        Ok(())
    }

    fn events(&self) -> broadcast::Receiver<Event> {
        self.tx.subscribe()
    }

    fn asset(&self, path: &str) -> Option<Asset> {
        let root = self.cfg.assets.as_ref()?;
        let rel = Path::new(path.trim_start_matches('/'));
        if rel
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return None;
        }
        let bytes = std::fs::read(root.join(rel)).ok()?;
        let mime = match rel.extension().and_then(|e| e.to_str()) {
            Some("html") => "text/html",
            Some("js" | "mjs") => "text/javascript",
            Some("css") => "text/css",
            Some("svg") => "image/svg+xml",
            Some("png") => "image/png",
            Some("json" | "webmanifest") => "application/json",
            Some("woff2") => "font/woff2",
            Some("ico") => "image/x-icon",
            _ => "application/octet-stream",
        };
        Some(Asset {
            bytes,
            mime: mime.into(),
        })
    }

    fn features(&self) -> Vec<String> {
        [
            feature::SEND_PROJECT,
            feature::IMAGES,
            feature::DOCUMENTS,
            feature::COUNCIL,
            feature::SPOKEN,
        ]
        .into_iter()
        .map(String::from)
        .collect()
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::remote::Server;
    use std::time::{Duration, Instant};

    /// A stand-in `claude`, driven by `<dir>/mode`: `reply` answers in
    /// words; `defer` pauses on a `Write` the way 2.1.263 does under the
    /// Ask position (`tool_deferred`), and the resume that follows carries
    /// the call's result and a reply; `park` waits until interrupted and
    /// then ends the turn the way the CLI does on SIGINT.
    fn stand_in(dir: &Path) -> String {
        let d = dir.display();
        let body = format!(
            r##"#!/bin/sh
D="{d}"
printf '%s\n' "$@" > "$D/last-args"
say() {{ printf '%s\n' "{{\"type\":\"stream_event\",\"event\":{{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{{\"type\":\"text_delta\",\"text\":\"$1\"}}}},\"parent_tool_use_id\":null,\"session_id\":\"s-1\"}}"; printf '%s\n' "{{\"type\":\"assistant\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"$1\"}}]}},\"parent_tool_use_id\":null}}"; }}
done_() {{ printf '%s\n' "{{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"num_turns\":1,\"result\":\"$1\",\"session_id\":\"s-1\",\"stop_reason\":\"end_turn\",\"usage\":{{\"input_tokens\":3,\"output_tokens\":2}}}}"; }}
printf '%s\n' '{{"type":"system","subtype":"init","cwd":"x","tools":["Write"],"mcp_servers":[],"model":"claude-haiku-4-5","permissionMode":"default","session_id":"s-1"}}'
if [ -f "$D/deferred" ]; then
  rm "$D/deferred"
  printf '%s\n' '{{"type":"user","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"toolu_w","content":"File created","is_error":false}}]}},"parent_tool_use_id":null}}'
  say "wrote it"
  done_ "wrote it"
  exit 0
fi
case "$(cat "$D/mode")" in
reply)
  say "hi from the stand-in"
  done_ "hi from the stand-in"
  ;;
defer)
  printf '%s\n' '{{"type":"assistant","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"toolu_w","name":"Write","input":{{"file_path":"/tmp/serve-test.txt","content":"hello"}}}}]}},"parent_tool_use_id":null}}'
  touch "$D/deferred"
  printf '%s\n' '{{"type":"result","subtype":"success","stop_reason":"tool_deferred","terminal_reason":"tool_deferred","is_error":false,"num_turns":1,"result":"","permission_denials":[],"session_id":"s-1","deferred_tool_use":{{"id":"toolu_w","name":"Write","input":{{"file_path":"/tmp/serve-test.txt","content":"hello"}}}}}}'
  ;;
park)
  trap 'kill $child 2>/dev/null
printf "%s\n" "{{\"type\":\"result\",\"subtype\":\"error_during_execution\",\"is_error\":true,\"terminal_reason\":\"aborted_tools\",\"num_turns\":1,\"session_id\":\"s-1\",\"stop_reason\":null,\"usage\":{{\"input_tokens\":0,\"output_tokens\":0}}}}"
exit 0' INT
  sleep 30 >/dev/null 2>&1 & child=$!
  wait
  ;;
esac
"##
        );
        let path = dir.join("claude-stand-in");
        std::fs::write(&path, body).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.to_string_lossy().into_owned()
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    async fn get(c: &reqwest::Client, url: String, token: &str) -> serde_json::Value {
        let r = c.get(url).bearer_auth(token).send().await.unwrap();
        assert_eq!(r.status(), 200);
        r.json().await.unwrap()
    }

    async fn post(
        c: &reqwest::Client,
        url: String,
        token: &str,
        body: serde_json::Value,
    ) -> (u16, String) {
        let r = c
            .post(url)
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .unwrap();
        (r.status().as_u16(), r.text().await.unwrap_or_default())
    }

    /// Poll `/api/state` until `ok` holds, or fail after `limit`.
    async fn until(
        c: &reqwest::Client,
        base: &str,
        token: &str,
        limit: Duration,
        ok: impl Fn(&serde_json::Value) -> bool,
    ) -> serde_json::Value {
        let start = Instant::now();
        loop {
            let s = get(c, format!("{base}/api/state"), token).await;
            if ok(&s) {
                return s;
            }
            assert!(start.elapsed() < limit, "timed out; last state {s}");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    fn texts(events: &serde_json::Value) -> String {
        events.to_string()
    }

    /// The whole step-1 path over HTTP, headless: the chat list from the
    /// logs, a turn run by the stand-in and streamed, its reply on the log
    /// with the CLI session recorded for the next turn to resume, Stop,
    /// and an Ask-position approval answered from the phone.
    #[tokio::test]
    async fn serve_lists_runs_streams_stops_and_round_trips_an_approval() {
        crate::project::set_config_dir(
            std::env::temp_dir().join(format!("nightloom-home-{}", std::process::id())),
        );
        let root = std::env::temp_dir().join(format!("nightloom-serve-{}", uuid::Uuid::new_v4()));
        let unfiled = root.join("unfiled").join("sessions");
        let workspace = root.join("ws");
        std::fs::create_dir_all(&unfiled).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        let mut seeded = Session::start(&unfiled, ChatMode::Normal, ChatKind::Build).unwrap();
        seeded.record_title_by("seeded chat", TitleBy::User);
        let chat = seeded.id.clone();
        drop(seeded);

        let cfg = ServeConfig {
            binary: stand_in(&root),
            model: None,
            // Any path: the stand-in never runs the hook; what matters is
            // that the Ask position is on, as it is under `serve`.
            hook_exe: Some(PathBuf::from("/usr/bin/true")),
            assets: None,
            unfiled_dir: unfiled.clone(),
            unfiled_workspace: workspace.clone(),
        };
        let host = ServeHost::new(cfg, Registry::load_from(root.join("projects.json")));
        let token = "t0k3n".to_string();
        let server = Server::start_for_test(
            "127.0.0.1:0".parse().unwrap(),
            token.clone(),
            host.clone() as Arc<dyn Host>,
        )
        .await
        .unwrap();
        let base = format!("http://{}", server.addr());
        let c = client();

        // The chat list, read from the log on disk.
        let chats = get(&c, format!("{base}/api/chats"), &token).await;
        assert!(texts(&chats).contains(&chat), "{chats}");
        let state = get(&c, format!("{base}/api/state"), &token).await;
        assert_eq!(state["engine"], "claude-code");
        assert_eq!(state["busy"], false);

        // The stream, open before the turn.
        let mut sse = c
            .get(format!("{base}/api/events"))
            .bearer_auth(&token)
            .send()
            .await
            .unwrap();
        let mut got = String::new();
        while !got.contains("event: hello") {
            let chunk = sse.chunk().await.unwrap().expect("stream open");
            got.push_str(&String::from_utf8_lossy(&chunk));
        }

        // 1. A turn: handed on at once, streamed, recorded.
        std::fs::write(root.join("mode"), "reply").unwrap();
        let (code, body) = post(
            &c,
            format!("{base}/api/chats/{chat}/send"),
            &token,
            serde_json::json!({ "text": "hello" }),
        )
        .await;
        assert_eq!(code, 202, "{body}");
        assert!(body.contains("sent"), "{body}");
        while !got.contains("hi from the stand-in") {
            let chunk = tokio::time::timeout(Duration::from_secs(10), sse.chunk())
                .await
                .unwrap_or_else(|_| panic!("an event within 10 s; so far: {got}"))
                .unwrap()
                .expect("stream open");
            got.push_str(&String::from_utf8_lossy(&chunk));
        }
        assert!(got.contains("event: turn-event"), "{got}");
        assert!(got.contains(&format!("\"chat\":\"{chat}\"")), "{got}");
        until(&c, &base, &token, Duration::from_secs(10), |s| {
            s["busy"] == false
        })
        .await;
        let log = get(&c, format!("{base}/api/chats/{chat}/transcript"), &token).await;
        let log_text = texts(&log);
        assert!(log_text.contains("hello"), "{log_text}");
        assert!(log_text.contains("hi from the stand-in"), "{log_text}");
        // The CLI session is on the log: the desktop's next turn (and
        // this host's) resumes it.
        let path = store::find_by_prefix(&unfiled, &chat).unwrap();
        let session = Session::load(&path).unwrap();
        assert_eq!(session.agent_session(), Some((AGENT, "s-1")));
        let spec = host.spec_for(None, &session);
        assert_eq!(spec.resume.as_deref(), Some("s-1"));
        assert_eq!(spec.workspace, workspace);

        // 2. Stop: a parked turn ends on the phone's Stop.
        std::fs::write(root.join("mode"), "park").unwrap();
        let (code, body) = post(
            &c,
            format!("{base}/api/chats/{chat}/send"),
            &token,
            serde_json::json!({ "text": "wait for it" }),
        )
        .await;
        assert_eq!(code, 202, "{body}");
        until(&c, &base, &token, Duration::from_secs(10), |s| {
            s["busy"] == true
        })
        .await;
        // A second send while it runs is refused, not lost silently.
        let (code, _) = post(
            &c,
            format!("{base}/api/chats/{chat}/send"),
            &token,
            serde_json::json!({ "text": "too soon" }),
        )
        .await;
        assert_eq!(code, 409);
        // The stand-in must be running before the interrupt can reach it.
        let start = Instant::now();
        while !root.join("last-args").exists() || start.elapsed() < Duration::from_millis(300) {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let stopped_at = Instant::now();
        let (code, _) = post(
            &c,
            format!("{base}/api/chats/{chat}/cancel"),
            &token,
            serde_json::json!({}),
        )
        .await;
        assert_eq!(code, 200);
        until(&c, &base, &token, Duration::from_secs(15), |s| {
            s["busy"] == false
        })
        .await;
        assert!(
            stopped_at.elapsed() < Duration::from_secs(15),
            "Stop ended the turn"
        );

        // 3. An approval: the card reaches the phone, the phone allows,
        // the resume runs the call and the reply lands.
        std::fs::write(root.join("mode"), "defer").unwrap();
        let (code, body) = post(
            &c,
            format!("{base}/api/chats/{chat}/send"),
            &token,
            serde_json::json!({ "text": "write the file" }),
        )
        .await;
        assert_eq!(code, 202, "{body}");
        let asked = until(&c, &base, &token, Duration::from_secs(10), |s| {
            s["pending"].as_array().is_some_and(|p| !p.is_empty())
        })
        .await;
        let card = &asked["pending"][0];
        assert_eq!(card["id"], "toolu_w");
        assert_eq!(card["name"], "Write");
        assert_eq!(card["chat"], chat.as_str());
        let (code, body) = post(
            &c,
            format!("{base}/api/approve"),
            &token,
            serde_json::json!({ "id": "toolu_w", "name": "Write", "decision": "allow" }),
        )
        .await;
        assert_eq!(code, 200, "{body}");
        let after = until(&c, &base, &token, Duration::from_secs(10), |s| {
            s["busy"] == false
        })
        .await;
        assert!(after["pending"].as_array().unwrap().is_empty());
        let log = texts(&get(&c, format!("{base}/api/chats/{chat}/transcript"), &token).await);
        assert!(log.contains("File created"), "{log}");
        assert!(log.contains("wrote it"), "{log}");
        // The answer went where the CLI's hook reads it.
        let stem = path.file_stem().unwrap();
        assert!(unfiled.join("ask").join(stem).is_dir());
        // The resume continued the session that deferred.
        let args = std::fs::read_to_string(root.join("last-args")).unwrap();
        assert!(args.contains("--resume\ns-1"), "{args}");

        // 4. A new chat from the phone: a log is made and the turn runs.
        std::fs::write(root.join("mode"), "reply").unwrap();
        let (code, body) = post(
            &c,
            format!("{base}/api/new"),
            &token,
            serde_json::json!({ "text": "a fresh one" }),
        )
        .await;
        assert_eq!(code, 202, "{body}");
        until(&c, &base, &token, Duration::from_secs(10), |s| {
            s["busy"] == false && s["active_chat"] != chat.as_str()
        })
        .await;
        let chats = texts(&get(&c, format!("{base}/api/chats"), &token).await);
        assert!(chats.contains("a fresh one"), "{chats}");

        server.stop().await;
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The one-holder rule: a second holder of a home is refused, with the
    /// first named; the lock goes with its holder.
    #[test]
    fn a_home_has_one_holder_at_a_time() {
        let home = std::env::temp_dir().join(format!("nightloom-lock-{}", uuid::Uuid::new_v4()));
        let first = HomeLock::take(&home, "the Nightloom desktop app").unwrap();
        let refused = HomeLock::take(&home, "nightloom serve").unwrap_err();
        assert!(
            refused.contains("the Nightloom desktop app"),
            "names the holder: {refused}"
        );
        drop(first);
        let second = HomeLock::take(&home, "nightloom serve").unwrap();
        drop(second);
        let _ = std::fs::remove_dir_all(&home);
    }
}
