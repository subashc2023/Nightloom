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
//! # The chat's actions, Context and layers (item 246 wave 4, 4A)
//!
//! `act`, `context` and `layers` run the functions the desktop's commands
//! run ([`crate::chat_ops`], [`crate::context_ops`]) on the chat's log,
//! with the CLI's history edited by copy as the desktop does; no live agent
//! is pointed anywhere, because each turn here resumes what the log
//! records. An action on a chat whose turn is running is refused (409),
//! as on the Mac. To add a route group: one Host method below, one name in
//! `features`.
//!
//! # The rest of the chat ops (item 246 wave 5, wave 3 B1)
//!
//! - **Budget** answers write the same file the Mac's card writes
//!   (`agent::brief::write_answer` under the chat's `ask/` folder, which
//!   is this host's turns' Ask folder too).
//! - **Resume after a usage limit** (backlog 164): a turn that ends on the
//!   plan's limit leaves a pause ([`ServeHost::limit_pause`], on
//!   `/api/state` as `limit_pause`); Resume sends `limit.ts`'s message at
//!   once when the window has reset, else schedules it for the reset plus
//!   30 s — never into a window still exhausted. A resumed turn that hits
//!   the limit again pauses again; nothing resumes on its own.
//! - **Compact** is refused with the Mac's own Claude Code sentence (the
//!   CLI keeps its own history; the Mac refuses it on that engine too),
//!   and **checkpoint** is "not on the away server yet": `serve` runs no
//!   checkpoint helper (`fork_mode` is off), so a checkpoint set here would
//!   do nothing. Neither is in `features`.
//! - **Nightshift** (`/api/nightshift/…`): only the contract root named by
//!   `NIGHTLOOM_NIGHTSHIFT_ROOT`, when it detects as one.
//!
//! # What step 1 leaves out
//!
//! One turn at a time (Keepsake's `CallLock` lesson, and all a phone
//! needs). No provider engine: Claude Code only. No checkpoint helper, no
//! prompt hold (the preamble is built fresh each turn, so a chat's cache
//! may be cold after a layer changed on the Mac), no chat naming pass.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

use nightloom_core::context::WireView;
use nightloom_core::{
    ChatKind, ChatMode, SegmentKind, Session, SessionEvent, SystemPrompt, TitleBy,
};
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;

use crate::agent::{AgentSpec, Answer, AskGate, ClaudeCodeAgent, PlanThen};
use crate::agent_turn::{
    AGENT, AgentTurnEnd, AgentTurnRun, ApprovalPrompt, ChatEvent, ProjectGrant, TurnEnv,
    run_agent_turn,
};
use crate::chat_ops::{self, OnCli};
use crate::context_ops::{self, PromptLayersInfo};
use crate::project::{self, Project, Registry};
use crate::rail_store;
use crate::remote::api::{
    ActReply, ChatAction, ContextReply, EditMode, LayerChange, NewProjectRequest, Rail, RailPatch,
    Running, SearchScope, UsageReply, feature,
};
use crate::remote::{
    ApproveRequest, Asset, ChatRow, Event, Handed, Host, ProjectRow, RemoteState, SendRequest,
};
use crate::serve_reads;
use crate::store;
use crate::turn::{TurnEvent, TurnInput};

/// The lock file both holders honour, in the config dir.
pub const LOCK_FILE: &str = "holder.lock";

/// How long [`HomeLock::take`] keeps asking before it names the holder,
/// and how often (a real holder costs the second process this much more
/// before its refusal; both callers take the lock once, at start).
const HOLD_RE_ASK_FOR: std::time::Duration = std::time::Duration::from_millis(500);
const HOLD_RE_ASK_EVERY: std::time::Duration = std::time::Duration::from_millis(20);

/// The process that holds a Nightloom home: the desktop app or `serve`.
/// Held for the process's life; the OS lets go when it exits.
#[derive(Debug)]
pub struct HomeLock {
    _file: File,
    path: PathBuf,
}

impl HomeLock {
    /// Take `<config>/holder.lock` for `who` (`desktop` or `serve`), or say
    /// who holds it — after asking again for [`HOLD_RE_ASK_FOR`]: any
    /// `Command` spawn in this process holds a copy of every open fd until
    /// the child execs, a just-dropped lock's included, so a take right
    /// after a drop can read the lock as held for that instant (the
    /// `a_home_has_one_holder_at_a_time` flake; `pass_lock::take` is the
    /// same fix for the same race, backlog 168).
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
        let deadline = std::time::Instant::now() + HOLD_RE_ASK_FOR;
        let mut locked = file.try_lock();
        while matches!(locked, Err(std::fs::TryLockError::WouldBlock))
            && std::time::Instant::now() < deadline
        {
            std::thread::sleep(HOLD_RE_ASK_EVERY);
            locked = file.try_lock();
        }
        match locked {
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
    /// `serve`'s Nightloom home (`<config>`): the away server's sync
    /// mirror lives under it (item 268 step 3).
    pub home: PathBuf,
    /// The folder an unfiled Build chat runs in (`serve`'s working
    /// directory by default).
    pub unfiled_workspace: PathBuf,
    /// A Nightshift contract root the phone may read and answer
    /// (`NIGHTLOOM_NIGHTSHIFT_ROOT`; wave 5). `None`: Nightshift is not on
    /// this host.
    pub nightshift_root: Option<PathBuf>,
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
            home: config.to_path_buf(),
            // As the desktop's connect falls back when no project is open
            // and the rail names no folder: the working directory.
            unfiled_workspace: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            nightshift_root: std::env::var_os(NIGHTSHIFT_ROOT_ENV)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from),
        }
    }
}

/// The project id `serve` lists for its unfiled chats ("No project"), so
/// the phone can show and start them beside the projects the Mac marked
/// "available away" (item 268, wave 4 A): the phone page shows an unfiled
/// row only when the host lists no project at all, so before this a
/// server holding three marked projects hid its no-project chats, and
/// once the phone worked in a project there was no way back to them.
/// Never a real project's id (those are UUIDs).
pub const NO_PROJECT_ID: &str = "unfiled";
/// The name of that row: the desktop sidebar's words for it.
pub const NO_PROJECT_NAME: &str = "No project";

/// The environment variable naming the away server's Nightshift root.
pub const NIGHTSHIFT_ROOT_ENV: &str = "NIGHTLOOM_NIGHTSHIFT_ROOT";

/// A resume goes this long after the window resets (`limit.ts`'s
/// `RESUME_MARGIN_MS`): the clocks are two, and a resume one second early
/// is the 429 loop this guards.
pub const RESUME_MARGIN_SECS: i64 = 30;

/// A turn paused by the plan's usage limit (backlog 164).
#[derive(Debug, Clone)]
struct Pause {
    /// Which pause this is: a scheduled resume fires only for its own.
    seq: u64,
    chat: String,
    hit: crate::agent::LimitHit,
}

/// A resume waiting for the reset.
struct Scheduled {
    seq: u64,
    /// Unix seconds.
    at: i64,
    cancel: CancellationToken,
}

fn now_secs() -> i64 {
    chrono::Utc::now().timestamp()
}

/// "in 42 min": a wait the phone can read whatever this machine's zone
/// (the away server runs in UTC).
fn wait_words(secs: i64) -> String {
    let m = (secs.max(0) + 59) / 60;
    if secs < 60 {
        "in under a minute".into()
    } else if m < 60 {
        format!("in {m} min")
    } else if m % 60 == 0 {
        format!("in {} h", m / 60)
    } else {
        format!("in {} h {} min", m / 60, m % 60)
    }
}

/// What Resume sends — `limit.ts`'s `resumeMessage`, word for word: the
/// turn was cut by the limit, the window has opened, and the subagents
/// that died are resumed by SendMessage, not relaunched.
pub fn resume_message(subagents: &[String]) -> String {
    let head = "The last turn was paused by the plan's usage limit and the window has now reset. Continue exactly where it stopped; everything before the limit stands.";
    if subagents.is_empty() {
        return head.to_string();
    }
    let ids = subagents
        .iter()
        .map(|id| format!("`{id}`"))
        .collect::<Vec<_>>()
        .join(", ");
    let one = subagents.len() == 1;
    format!(
        "{head} {} died on the limit (spawned by {ids}): resume {} with SendMessage by id or name rather than launching a new one; if that fails, read its transcript (this session's subagents folder under ~/.claude/projects, agent-<id>.jsonl, the .meta.json beside it names the spawning call) and take up from its last result instead of repeating the search.",
        if one {
            "One subagent".to_string()
        } else {
            format!("{} subagents", subagents.len())
        },
        if one { "it" } else { "each" },
    )
}

/// The card's words for a window: `limit.ts`'s `pauseLabel`.
fn window_words(window: Option<&str>) -> &'static str {
    match window {
        Some("seven_day") => "weekly",
        Some("five_hour") => "5-hour",
        _ => "usage",
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
    /// Chats a phone action is changing now (wave 3, A1): a turn does not
    /// start in one, and a second action on it waits its turn. Locked
    /// after `turn`, never before.
    acting: Mutex<HashSet<String>>,
    ask: AskGate,
    /// The approval prompts still waiting, as the window's payloads.
    pending: Mutex<HashMap<String, serde_json::Value>>,
    tx: broadcast::Sender<Event>,
    /// The away server's sync home (item 268 step 3): the Mac's mirrored
    /// projects and chats, read-only here, and the outbox it pulls.
    sync: Arc<crate::sync::SyncServer>,
    /// The turn the usage limit paused, if any (backlog 164), and the
    /// resume scheduled for its reset. Locked one at a time.
    pause: Mutex<Option<Pause>>,
    resume: Mutex<Option<Scheduled>>,
    pause_gen: std::sync::atomic::AtomicU64,
}

impl ServeHost {
    pub fn new(cfg: ServeConfig, registry: Registry) -> Arc<Self> {
        let (tx, _) = broadcast::channel(1024);
        Arc::new_cyclic(|me| {
            let weak: Weak<ServeHost> = me.clone();
            let sync = Arc::new(
                crate::sync::SyncServer::new(
                    cfg.home.clone(),
                    crate::agent::cli_session::projects_dir()
                        .unwrap_or_else(|| cfg.home.join("claude")),
                )
                .with_busy(Arc::new(move |chat: &str| {
                    weak.upgrade()
                        .is_some_and(|h| lock(&h.turn).as_ref().is_some_and(|t| t.chat == chat))
                })),
            );
            Self {
                me: me.clone(),
                cfg,
                registry: Mutex::new(registry),
                active_project: Mutex::new(None),
                active_chat: Mutex::new(None),
                turn: Mutex::new(None),
                acting: Mutex::new(HashSet::new()),
                ask: AskGate::new(),
                pending: Mutex::new(HashMap::new()),
                tx,
                sync,
                pause: Mutex::new(None),
                resume: Mutex::new(None),
                pause_gen: std::sync::atomic::AtomicU64::new(1),
            }
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
            Some(NO_PROJECT_ID) => return Ok(None),
            Some(id) => Some(id.to_string()),
            None => lock(&self.active_project).clone(),
        };
        match id {
            None => Ok(None),
            Some(id) => {
                let found = lock(&self.registry).find(&id).cloned();
                match found {
                    Some(p) => Ok(Some(p)),
                    None => self.mirrored_project(&id).map(Some),
                }
            }
        }
    }

    /// A project the Mac marked "available away" that this server's
    /// registry lacks: a stand-in with a server folder of its own,
    /// `<home>/workspaces/<id>` (blocker 653), its chats the mirror's.
    fn mirrored_project(&self, id: &str) -> Result<Project, String> {
        let Some(m) = self
            .sync
            .layout()
            .projects()
            .into_iter()
            .find(|m| m.id == id)
        else {
            return Err(format!("no project {id}"));
        };
        let workspace = self.cfg.home.join("workspaces").join(&m.id);
        std::fs::create_dir_all(&workspace).map_err(|e| e.to_string())?;
        let now = chrono::Utc::now();
        Ok(Project {
            id: m.id,
            name: m.name,
            workspace: Some(workspace),
            source: None,
            extra_folders: Vec::new(),
            available_away: false,
            created: now,
            last_opened: now,
        })
    }

    /// Refuse a change to a chat the Mac owns (mirrored, or taken down):
    /// nothing on the server writes under `mirror/` (item 268 step 3).
    fn refuse_mirrored(&self, path: &Path) -> Result<(), String> {
        if self.sync.layout().needs_fork(path) {
            return Err(MAC_OWNS.into());
        }
        Ok(())
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

    /// Where the phone's reads look: the home, the unfiled chats, the
    /// projects and the phone's current project (no lock held after).
    /// (A1's `places` is the act's search order; this is the reads'.)
    fn read_places(&self) -> Result<serve_reads::Places, String> {
        let active = lock(&self.active_project).clone();
        let registry = lock(&self.registry);
        Ok(serve_reads::Places::of(
            serve_reads::home()?,
            &self.cfg.unfiled_dir,
            &registry,
            active.as_deref(),
        ))
    }

    /// The spec a turn in `session` runs under: the desktop's connect,
    /// cut to what a turn needs — the folder by the chat's kind, the vault
    /// and extra folders granted, the preamble by the chat's layers, `auto`
    /// with the Ask position when this binary can be the hook, and the
    /// chat's recorded CLI session resumed.
    /// The phone's rail (`<home>/serve/rail.json`), or the defaults.
    fn rail(&self) -> rail_store::RailSettings {
        serve_reads::home()
            .map(|h| rail_store::load_or_default(&h))
            .unwrap_or_default()
    }

    pub fn spec_for(&self, project: Option<&Project>, session: &Session) -> AgentSpec {
        let declared = session.declared_kind();
        let workspace = self.workspace_for(project, session);
        let mut spec = AgentSpec::new(workspace.clone());
        spec.binary = self.cfg.binary.clone();
        // The phone's rail (`<home>/serve/rail.json`), else `--model`.
        let rail = self.rail();
        rail.apply_model(&mut spec, self.cfg.model.as_deref());
        // No checkpoint helper on this host (the desktop's `sync_checkpoint`).
        spec.fork_mode = false;
        // A chat does not compact (backlog 086).
        spec.auto_compact = false;
        let off: Vec<SegmentKind> = session.prompt_layers_off().to_vec();
        spec.auto_memory = !off.contains(&SegmentKind::CliMemory);
        let knowledge = crate::knowledge::vault_dir();
        spec.add_dirs = knowledge.iter().cloned().collect();
        let granted = granted_folders(project, session);
        spec.add_dirs.extend(granted.iter().cloned());
        let prompt = self.prompt_for(project, session, &workspace, &spec);
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
        rail.apply_ask(&mut spec);
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

    /// The folder a turn in `session` runs in — the one Claude Code files
    /// the chat's history under: the chat's own (a kind switch's), else the
    /// project's, else `serve`'s; a Chat's is the chat folder.
    pub fn workspace_for(&self, project: Option<&Project>, session: &Session) -> PathBuf {
        let base = session
            .kind_workspace()
            .map(Path::to_path_buf)
            .or_else(|| project.map(Project::workspace_dir))
            .unwrap_or_else(|| self.cfg.unfiled_workspace.clone());
        match session.declared_kind() {
            ChatKind::Build => base,
            ChatKind::Chat => crate::prompt::chat_dir().unwrap_or(base),
        }
    }

    /// The preamble a turn in `session` appends, by the chat's layers —
    /// what the Context page itemises (the desktop's `built.agent`).
    /// A mirror-only project's project instructions (wave 3's leftover:
    /// its turns run in an empty `<home>/workspaces/<id>`, so the walk
    /// found none of the Mac's): the server's walk from that folder, then
    /// the `AGENTS.md` the Mac sent to `mirror/projects/<id>/`, last —
    /// most specific, as it sits in the project's own folder on the Mac.
    /// Read in place on every turn, so the Mac's next push is the next
    /// turn's text, and nothing is written. `None` for a project in this
    /// server's registry (its folder holds its own), or when the Mac sent
    /// no file.
    fn mirrored_instructions(&self, project: Option<&Project>, workspace: &Path) -> Option<String> {
        let p = project?;
        if lock(&self.registry).find(&p.id).is_some() {
            return None;
        }
        let file = self
            .sync
            .layout()
            .root()
            .join(project::PROJECTS_DIR)
            .join(&p.id)
            .join("AGENTS.md");
        let mac = std::fs::read_to_string(file).ok()?;
        let mac = mac.trim();
        if mac.is_empty() {
            return None;
        }
        Some(match self.walk_text(workspace) {
            Some(walk) => format!("{walk}\n\n{mac}"),
            None => mac.to_string(),
        })
    }

    /// `serve`'s own user memory file, `<home>/AGENTS.md` (on the away
    /// server the home is also the config dir, so this is the file the
    /// library's user-memory read opens).
    fn home_memory_file(&self) -> PathBuf {
        self.cfg.home.join(crate::prompt::INSTRUCTION_FILE)
    }

    /// The user memory a turn here reads, once (item 274): the Mac's, as
    /// the sync sent it to `mirror/AGENTS.md`, whenever that file exists —
    /// an empty one is the Mac's memory being empty, not a reason to read
    /// the server's — else the server's own `<home>/AGENTS.md`. Read in
    /// place on every turn, never copied. `None`: no memory at all.
    fn user_memory_text(&self) -> Option<String> {
        let mac = self
            .sync
            .layout()
            .root()
            .join(crate::prompt::INSTRUCTION_FILE);
        if mac.is_file() {
            return crate::prompt::read_capped(&mac);
        }
        crate::prompt::read_capped(&self.home_memory_file())
    }

    /// Whether `path` is the server's own memory file — which the
    /// `AGENTS.md` walk from a folder under the home climbs through, and
    /// which is memory, never project instructions (item 274: it was read
    /// twice). Compared as written, then resolved, so a symlinked spelling
    /// of the home still matches.
    fn is_home_memory(&self, path: &Path) -> bool {
        let home = self.home_memory_file();
        if path == home {
            return true;
        }
        match (std::fs::canonicalize(path), std::fs::canonicalize(&home)) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        }
    }

    /// The project-instructions walk from `workspace` as one text — the
    /// library's [`crate::layer_source`] for that layer, outermost first —
    /// without the server's own memory file (item 274).
    fn walk_text(&self, workspace: &Path) -> Option<String> {
        let mut bodies: Vec<String> = Vec::new();
        for dir in workspace.ancestors() {
            let path = dir.join(crate::prompt::INSTRUCTION_FILE);
            if self.is_home_memory(&path) {
                continue;
            }
            if let Some(content) = crate::prompt::read_capped(&path) {
                bodies.push(content.trim().to_string());
            }
        }
        if bodies.is_empty() {
            return None;
        }
        bodies.reverse();
        Some(bodies.join("\n\n"))
    }

    fn prompt_for(
        &self,
        project: Option<&Project>,
        session: &Session,
        workspace: &Path,
        spec: &AgentSpec,
    ) -> SystemPrompt {
        let declared = session.declared_kind();
        let off: Vec<SegmentKind> = session.prompt_layers_off().to_vec();
        let mut edits = session.prompt_layer_edits().clone();
        // A mirror-only project's `AGENTS.md` is the Mac's, in the mirror:
        // it stands in for the walk (the chat's own text still wins).
        if !edits.contains_key(&SegmentKind::ProjectInstructions)
            && let Some(text) = self.mirrored_instructions(project, workspace)
        {
            edits.insert(SegmentKind::ProjectInstructions, text);
        }
        // User memory, once (item 274): the Mac's when the sync sent it,
        // else this server's; the chat's own text still wins.
        let memory = match edits.get(&SegmentKind::UserMemory) {
            Some(_) => true,
            None => match self.user_memory_text() {
                Some(text) => {
                    edits.insert(SegmentKind::UserMemory, text);
                    true
                }
                None => false,
            },
        };
        let knowledge = crate::knowledge::vault_dir();
        let prompt = crate::agent_prompt_with(
            &crate::PromptConfig {
                identity: false,
                environment: false,
                project_instructions: true,
                user_memory: memory,
                model: spec.model.clone(),
                chat_instructions: declared == ChatKind::Chat,
                project: project.map(|p| crate::ProjectContext {
                    name: p.name.clone(),
                    notes_dir: p.notes_dir(),
                }),
                knowledge: knowledge.map(|dir| crate::KnowledgeContext { dir }),
                // The chat's research thread (backlog 271), in its project.
                thread: project
                    .zip(session.thread())
                    .and_then(|(p, slug)| crate::thread::ThreadContext::new(&p.notes_dir(), slug)),
                cwd: workspace.to_path_buf(),
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
                // The subagent rules layer (backlog 291 + 293) is the
                // Mac's: the phone's rail has no rules box yet.
                subagent_rules: None,
            },
        );
        self.without_home_memory(prompt)
    }

    /// `prompt` without the walk's segment for the server's own memory
    /// file (item 274): that file is the memory layer, read above, and the
    /// walk from a folder under the home found it a second time. The cache
    /// anchor moves to the new last segment if it was on the one dropped.
    fn without_home_memory(&self, prompt: SystemPrompt) -> SystemPrompt {
        let drop = |s: &nightloom_core::Segment| {
            s.kind == SegmentKind::ProjectInstructions && self.is_home_memory(Path::new(&s.name))
        };
        if !prompt.segments().iter().any(drop) {
            return prompt;
        }
        let mut kept: Vec<nightloom_core::Segment> = prompt
            .segments()
            .iter()
            .filter(|s| !drop(s))
            .cloned()
            .collect();
        let anchored = prompt.segments().iter().any(|s| drop(s) && s.cache_anchor);
        if anchored
            && !kept.iter().any(|s| s.cache_anchor)
            && let Some(last) = kept.pop()
        {
            kept.push(last.anchored());
        }
        let mut out = SystemPrompt::new();
        for seg in kept {
            out.push(seg);
        }
        out
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
        if lock(&self.acting).contains(chat) {
            return Err("this chat is being changed; send again in a moment".into());
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
                wire_note: None,
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
                self.after_turn(&chat_id, outcome.limit);
            }
            Ok(AgentTurnEnd::StoppedInCouncil) => {
                env.notice("stopped during the council's seats; no chair ran".into());
            }
            Err(e) => env.notice(format!("the turn failed: {e}")),
        }
    }

    /// A turn in `chat` ended: on the plan's limit it leaves a pause (a
    /// new one, so a resume scheduled for an older one does not fire);
    /// otherwise a pause in this chat is over.
    fn after_turn(&self, chat: &str, limit: Option<crate::agent::LimitHit>) {
        let mut pause = lock(&self.pause);
        // A turn ran in the paused chat (his own message, or the resume):
        // a resume still waiting for that pause has nothing to resume.
        if pause.as_ref().is_some_and(|p| p.chat == chat) {
            let mut resume = lock(&self.resume);
            if resume
                .as_ref()
                .is_some_and(|s| pause.as_ref().is_some_and(|p| p.seq == s.seq))
                && let Some(s) = resume.take()
            {
                s.cancel.cancel();
            }
        }
        match limit {
            Some(hit) => {
                let seq = self
                    .pause_gen
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let words = format!(
                    "paused by the {} limit — Resume goes 30 s after the window resets",
                    window_words(hit.window.as_deref())
                );
                *pause = Some(Pause {
                    seq,
                    chat: chat.to_string(),
                    hit,
                });
                drop(pause);
                self.emit(
                    "turn-notice",
                    serde_json::to_string(&words).unwrap_or_default(),
                );
            }
            None => {
                if pause.as_ref().is_some_and(|p| p.chat == chat) {
                    *pause = None;
                }
            }
        }
    }

    /// Resume the paused turn in `chat` (backlog 164): at once when the
    /// window has reset (or the CLI gave no time — his press is the
    /// consent), else scheduled for the reset plus [`RESUME_MARGIN_SECS`].
    /// A second press while one waits says so and changes nothing (the
    /// phone never cancels it).
    async fn resume_limit(&self, chat: &str) -> Result<ActReply, String> {
        let (_, _, session) = self.load(chat).await?;
        let id = session.id.clone();
        let reply = |note: String| ActReply {
            chat: id.clone(),
            events: session.events().to_vec(),
            note: Some(note),
        };
        let Some(p) = lock(&self.pause).clone().filter(|p| p.chat == id) else {
            return Err("nothing in this chat is paused by the usage limit".into());
        };
        let now = now_secs();
        if let Some(s) = lock(&self.resume).as_ref().filter(|s| s.seq == p.seq) {
            return Ok(reply(format!(
                "a resume is already scheduled — it goes {}",
                wait_words(s.at - now)
            )));
        }
        let at = p.hit.resets_at.map(|r| r + RESUME_MARGIN_SECS);
        match at {
            Some(at) if at > now => {
                let cancel = CancellationToken::new();
                *lock(&self.resume) = Some(Scheduled {
                    seq: p.seq,
                    at,
                    cancel: cancel.clone(),
                });
                if let Some(me) = self.me.upgrade() {
                    let wait = std::time::Duration::from_secs((at - now) as u64);
                    tokio::spawn(async move {
                        tokio::select! {
                            _ = cancel.cancelled() => return,
                            _ = tokio::time::sleep(wait) => {}
                        }
                        let mine = {
                            let mut slot = lock(&me.resume);
                            let mine = slot.as_ref().is_some_and(|s| s.seq == p.seq);
                            if mine {
                                *slot = None;
                            }
                            mine
                        };
                        if !mine {
                            return;
                        }
                        if let Err(e) = me.resume_now(&p).await
                            && let Some(text) = scheduled_resume_notice(&e)
                        {
                            me.emit(
                                "turn-notice",
                                serde_json::to_string(&text).unwrap_or_default(),
                            );
                        }
                    });
                }
                Ok(reply(format!(
                    "scheduled — it goes {}, 30 s after the window resets",
                    wait_words(at - now)
                )))
            }
            _ => {
                self.resume_now(&p).await?;
                Ok(reply("resumed".into()))
            }
        }
    }

    /// Send the resume for pause `p`, if it is still the pause. The pause
    /// is taken first: a resumed turn that meets the limit again leaves a
    /// new one, and nothing resumes it but another press (never a loop).
    async fn resume_now(&self, p: &Pause) -> Result<(), String> {
        {
            let mut pause = lock(&self.pause);
            if pause.as_ref().is_none_or(|q| q.seq != p.seq) {
                return Err(PAUSE_OVER.into());
            }
            *pause = None;
        }
        let sent = self
            .send_with(
                Some(&p.chat),
                SendRequest {
                    text: resume_message(&p.hit.subagents),
                    ..SendRequest::default()
                },
            )
            .await;
        if let Err(e) = sent {
            // Not sent: the pause stands, for another press.
            let mut pause = lock(&self.pause);
            if pause.is_none() {
                *pause = Some(p.clone());
            }
            return Err(e);
        }
        Ok(())
    }

    /// His answer on the budget card (backlog 189/192): the file the Mac's
    /// `budget_override` writes, under the chat's `ask/` folder — the one
    /// this host's turns run their hook with.
    async fn budget(
        &self,
        chat: &str,
        decision: &str,
        text: Option<String>,
    ) -> Result<ActReply, String> {
        if !matches!(decision, "continue" | "stop" | "wrap") {
            return Err(format!("unknown decision: {decision}"));
        }
        let (project, path, session) = self.load(chat).await?;
        let stem = path
            .file_stem()
            .map(|s| s.to_os_string())
            .ok_or("that chat's log has no name")?;
        let dir = self.log_dir(project.as_ref()).join("ask").join(stem);
        let decision = decision.to_string();
        let now = chrono::Utc::now().timestamp_millis();
        tokio::task::spawn_blocking(move || {
            crate::agent::brief::write_answer(&dir, &decision, text, now)
        })
        .await
        .map_err(|e| format!("writing the answer failed: {e}"))??;
        Ok(ActReply {
            chat: session.id.clone(),
            events: session.events().to_vec(),
            note: None,
        })
    }

    fn find_chat(&self, project: Option<&Project>, chat: &str) -> Result<PathBuf, String> {
        let own = store::find_by_prefix(&self.log_dir(project), chat).map_err(|e| e.to_string());
        match (own, project) {
            (Ok(path), _) => Ok(path),
            // A marked project's chat (or, No project marked, a
            // no-project chat) as the Mac last sent it.
            (Err(e), project) => {
                store::find_by_prefix(&self.mirror_dir(project), chat).map_err(|_| e)
            }
        }
    }

    /// Where the Mac's copies of `project`'s chats are: a marked project's
    /// mirrored sessions, or for no project the mirrored no-project chats
    /// (item 275). Read-only here.
    fn mirror_dir(&self, project: Option<&Project>) -> PathBuf {
        match project {
            Some(p) => self.sync.layout().sessions(&p.id),
            None => self.sync.layout().unfiled_sessions(),
        }
    }

    /// The places a chat may live, the phone's project first: it, then the
    /// unfiled chats, then every other project (an action names a chat,
    /// not its project).
    fn places(&self) -> Vec<Option<Project>> {
        let open = self.project(None).ok().flatten();
        let mut out = vec![open.clone()];
        if open.is_some() {
            out.push(None);
        }
        for p in lock(&self.registry).projects() {
            if open.as_ref().is_none_or(|o| o.id != p.id) {
                out.push(Some(p));
            }
        }
        out
    }

    /// The chat `chat` (an id or its prefix): its project and its log.
    fn locate(&self, chat: &str) -> Result<(Option<Project>, PathBuf), String> {
        // An empty id is a prefix of every chat: with one chat on disk it
        // matched that one (measured in the A1 live pass, where a blank id
        // deleted the only chat, to the trash).
        if chat.trim().is_empty() {
            return Err("no chat named".into());
        }
        for place in self.places() {
            if let Ok(path) = self.find_chat(place.as_ref(), chat) {
                return Ok((place, path));
            }
        }
        Err(format!("no chat {chat}"))
    }

    /// Hold `chat` for one action: refused while a turn runs in it
    /// (blocker 672's rule, as the Mac refuses mid-turn) or while another
    /// action changes it. Let go on drop.
    fn hold(&self, chat: &str) -> Result<Acting<'_>, String> {
        let turn = lock(&self.turn);
        if turn.as_ref().is_some_and(|t| t.chat == chat) {
            return Err(RUNNING_HERE.into());
        }
        if !lock(&self.acting).insert(chat.to_string()) {
            return Err("another change to this chat is being made; try again in a moment".into());
        }
        Ok(Acting {
            host: self,
            chat: chat.to_string(),
        })
    }

    /// Make `chat` (in `project`) the phone's chat, as the Mac's window
    /// follows a fork or a continue.
    fn follow(&self, project: Option<&Project>, chat: &str) {
        *lock(&self.active_chat) = Some(chat.to_string());
        *lock(&self.active_project) = project.map(|p| p.id.clone());
    }

    /// Edit and send: a fork cut before the turn, the new text sent as the
    /// fork's first turn — the Mac's `sendEdit` steps. The turn slot is
    /// taken before the fork is made, so a refusal makes no fork and a
    /// fork never waits without its message.
    fn edit_and_send(
        &self,
        project: Option<Project>,
        parent: &Session,
        index: usize,
        text: String,
    ) -> Result<ActReply, String> {
        let cancel = self.claim(FORKING)?;
        let log_dir = self.log_dir(project.as_ref());
        let cli = OnCli::at(self.workspace_for(project.as_ref(), parent));
        let fork = match chat_ops::fork(parent, &log_dir, Some(cli), index) {
            Ok(f) => f,
            Err(e) => {
                *lock(&self.turn) = None;
                return Err(e);
            }
        };
        if let Some(t) = lock(&self.turn).as_mut() {
            t.chat = fork.id.clone();
        }
        self.follow(project.as_ref(), &fork.id);
        let reply = ActReply {
            chat: fork.id.clone(),
            events: fork.events().to_vec(),
            note: None,
        };
        self.spawn_turn(
            project,
            fork,
            SendRequest {
                text,
                ..SendRequest::default()
            },
            cancel,
        );
        Ok(reply)
    }

    /// Put a deleted chat back, from whichever place's trash holds it.
    fn undelete(&self, chat: &str) -> Result<ActReply, String> {
        for place in self.places() {
            let dir = self.log_dir(place.as_ref());
            if chat_ops::in_trash(&dir, chat) {
                let id = chat_ops::restore_from_trash(&dir, chat)?;
                return Ok(ActReply {
                    chat: id,
                    events: Vec::new(),
                    note: None,
                });
            }
        }
        Err(format!("no deleted chat {chat} in the trash"))
    }

    /// One action on a held chat, on its log (blocking file work).
    fn act_on(
        &self,
        project: Option<Project>,
        path: PathBuf,
        mut session: Session,
        action: ChatAction,
    ) -> Result<ActReply, String> {
        let id = session.id.clone();
        let log_dir = self.log_dir(project.as_ref());
        let cli = || Some(OnCli::at(self.workspace_for(project.as_ref(), &session)));
        let here = |s: &Session| ActReply {
            chat: s.id.clone(),
            events: s.events().to_vec(),
            note: None,
        };
        match action {
            ChatAction::Edit {
                mode: EditMode::Send,
                block: Some(_),
                ..
            } => Err("a reply's block is saved, not sent".into()),
            ChatAction::Edit {
                mode: EditMode::Send,
                index,
                text,
                ..
            } => self.edit_and_send(project, &session, index, text),
            ChatAction::Edit {
                mode: EditMode::Save,
                index,
                text,
                block,
            } => {
                let c = cli();
                chat_ops::edit_saved(&mut session, c, index, text, block)?;
                Ok(here(&session))
            }
            ChatAction::Remove { index } => {
                let c = cli();
                chat_ops::remove_message(&mut session, c, index)?;
                Ok(here(&session))
            }
            ChatAction::Restore { index } => {
                let c = cli();
                chat_ops::restore_message(&mut session, c, index)?;
                Ok(here(&session))
            }
            ChatAction::RemoveBlock { index, block } => {
                let c = cli();
                chat_ops::remove_block(&mut session, c, index, block)?;
                Ok(here(&session))
            }
            ChatAction::RestoreBlock { index, block } => {
                let c = cli();
                chat_ops::restore_block(&mut session, c, index, block)?;
                Ok(here(&session))
            }
            ChatAction::Rewind { to } => {
                let c = cli();
                chat_ops::rewind(&mut session, c, to)?;
                Ok(here(&session))
            }
            ChatAction::Unrewind { of } => {
                let c = cli();
                chat_ops::unrewind(&mut session, c, of)?;
                Ok(here(&session))
            }
            ChatAction::Fork { upto } => {
                let fork = chat_ops::fork(&session, &log_dir, cli(), upto)?;
                self.follow(project.as_ref(), &fork.id);
                Ok(here(&fork))
            }
            ChatAction::Continue => {
                let next = chat_ops::continue_from(&session, &log_dir, None)?;
                self.follow(project.as_ref(), &next.id);
                Ok(here(&next))
            }
            ChatAction::Kind { kind } => {
                let kind = match kind.as_str() {
                    "build" => ChatKind::Build,
                    "chat" => ChatKind::Chat,
                    other => return Err(format!("no chat kind {other}")),
                };
                if session.kind() != kind {
                    chat_ops::set_kind(&mut session, kind, None);
                }
                Ok(here(&session))
            }
            ChatAction::Delete => {
                drop(session);
                chat_ops::move_to_trash(&log_dir, &path, &id)?;
                let mut active = lock(&self.active_chat);
                if active.as_deref() == Some(id.as_str()) {
                    *active = None;
                }
                Ok(ActReply {
                    chat: id,
                    events: Vec::new(),
                    note: None,
                })
            }
            ChatAction::Undelete => self.undelete(&id),
            ChatAction::Compact
            | ChatAction::ResumeLimit
            | ChatAction::Budget { .. }
            | ChatAction::Checkpoint { .. } => Err(not_yet(&action)),
        }
    }

    /// `chat`'s Context page: the preamble its next turn appends, itemised
    /// (Claude Code holds the conversation, so the view has no messages —
    /// the desktop's answer on that engine), its layers as built (each
    /// turn is built fresh from the log here, so the pairs agree), each
    /// editable layer's file text as `layers.sources`, and no held change
    /// (`serve` keeps no prompt hold).
    fn context_of(&self, project: Option<&Project>, session: &Session) -> ContextReply {
        self.context_with(&self.rail(), project, session)
    }

    /// [`Self::context_of`] under `rail`: the model (and subagent limits)
    /// a turn would run with — the rail's, else `--model`, as
    /// [`Self::spec_for`] sets them — so the page shows that model's
    /// instructions, not `--model`'s.
    fn context_with(
        &self,
        rail: &rail_store::RailSettings,
        project: Option<&Project>,
        session: &Session,
    ) -> ContextReply {
        let workspace = self.workspace_for(project, session);
        let mut spec = AgentSpec::new(workspace.clone());
        rail.apply_model(&mut spec, self.cfg.model.as_deref());
        let prompt = self.prompt_for(project, session, &workspace, &spec);
        let view = WireView::assemble(Some(&prompt), &Session::new(), None, None);
        let mut layers = serde_json::to_value(PromptLayersInfo::as_built(session))
            .unwrap_or(serde_json::Value::Null);
        if let Some(obj) = layers.as_object_mut() {
            let mut sources = context_ops::layer_sources(spec.model.as_deref(), &workspace);
            // The files a turn here reads (item 274): the memory it reads
            // once, and the walk without the server's memory file.
            if sources.contains_key(&SegmentKind::UserMemory) {
                sources.insert(SegmentKind::UserMemory, self.user_memory_text());
            }
            if sources.contains_key(&SegmentKind::ProjectInstructions) {
                let walk = self
                    .mirrored_instructions(project, &workspace)
                    .or_else(|| self.walk_text(&workspace));
                sources.insert(SegmentKind::ProjectInstructions, walk);
            }
            obj.insert(
                "sources".into(),
                serde_json::to_value(sources).unwrap_or_default(),
            );
        }
        ContextReply {
            view,
            layers,
            pending: serde_json::Value::Null,
        }
    }

    /// Load `chat`'s log wherever it lives.
    async fn load(&self, chat: &str) -> Result<(Option<Project>, PathBuf, Session), String> {
        let (project, path) = self.locate(chat)?;
        let p = path.clone();
        let session = tokio::task::spawn_blocking(move || Session::load(p))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        Ok((project, path, session))
    }
}

/// The sentence for an action on a chat whose turn is running here (the
/// Mac's `RUNNING_HERE`, blocker 672's one-turn rule).
const RUNNING_HERE: &str = "a turn is running in this chat — try again when it ends";
/// [`ServeHost::resume_now`]'s refusal when the pause it was for has gone.
const PAUSE_OVER: &str = "the pause is over";

/// What a scheduled resume that could not start tells the phone: nothing
/// when its pause is already over (a turn in the chat ended it, so there
/// is nothing to press again — review B1 finding 3), else why, and to
/// press Resume again.
fn scheduled_resume_notice(err: &str) -> Option<String> {
    (err != PAUSE_OVER)
        .then(|| format!("the scheduled resume could not start: {err} — press Resume again"))
}

/// A change to a chat the Mac owns (item 268 step 3).
const MAC_OWNS: &str = "this chat is the Mac's; send a message to continue it as a copy";

/// The turn slot's holder while an edit-and-send makes its fork.
const FORKING: &str = "(forking)";

/// What `serve` does not do: compact is the Mac's own Claude Code refusal
/// (the CLI keeps its history; the Mac refuses it on that engine too); a
/// checkpoint is "not yet" (no checkpoint helper runs here).
fn not_yet(action: &ChatAction) -> String {
    let what = match action {
        ChatAction::Compact => return context_ops::not_on_claude_code("compact"),
        ChatAction::ResumeLimit => "resuming after a usage limit",
        ChatAction::Budget { .. } => "answering a turn's budget",
        ChatAction::Checkpoint { .. } => "setting a checkpoint",
        _ => "this action",
    };
    format!("{what} is not on the away server yet — do it on the Mac")
}

/// A chat held by [`ServeHost::hold`] for one action.
struct Acting<'a> {
    host: &'a ServeHost,
    chat: String,
}

impl Drop for Acting<'_> {
    fn drop(&mut self) {
        lock(&self.host.acting).remove(&self.chat);
    }
}

/// The extra folders a turn in `session` may see: the project's, then the
/// chat's own.
fn granted_folders(project: Option<&Project>, session: &Session) -> Vec<PathBuf> {
    let mut granted: Vec<PathBuf> = project.map(|p| p.extra_folders.clone()).unwrap_or_default();
    granted.extend(session.folders().iter().cloned());
    granted
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
        let mirror = Some(self.mirror_dir(project.as_ref())).filter(|d| d.is_dir());
        let rows = tokio::task::spawn_blocking(move || -> Result<_, store::StoreError> {
            let own = store::list(&dir)?;
            let Some(mirror) = mirror else {
                return Ok(own);
            };
            // The mirror's row wins: after a pull the Mac owns the chat
            // and sends it back up.
            let mut rows = store::list(&mirror)?;
            let seen: HashSet<String> = rows.iter().map(|s| s.id.clone()).collect();
            rows.extend(own.into_iter().filter(|s| !seen.contains(&s.id)));
            rows.sort_by_key(|a| std::cmp::Reverse(a.modified));
            Ok(rows)
        })
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
        let mut rows: Vec<ProjectRow> = lock(&self.registry)
            .projects()
            .into_iter()
            .map(|p| ProjectRow {
                active: open.as_deref() == Some(p.id.as_str()),
                id: p.id,
                name: p.name,
            })
            .collect();
        // The projects the Mac marked "available away" that this server
        // does not hold itself (item 268 step 3).
        for m in self.sync.layout().projects() {
            if rows.iter().all(|r| r.id != m.id) {
                rows.push(ProjectRow {
                    active: open.as_deref() == Some(m.id.as_str()),
                    id: m.id,
                    name: m.name,
                });
            }
        }
        // The unfiled chats, always listed (wave 4 A; see NO_PROJECT_ID).
        rows.insert(
            0,
            ProjectRow {
                active: open.is_none(),
                id: NO_PROJECT_ID.into(),
                name: NO_PROJECT_NAME.into(),
            },
        );
        Ok(rows)
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
        let mut path = self.find_chat(project.as_ref(), &chat)?;
        // A chat the Mac owns (mirrored, or taken down) is continued as a
        // copy in this server's own folder (blocker 652); the original
        // stays byte-identical.
        if self.sync.layout().needs_fork(&path) {
            if self.busy() {
                return Err("a turn is running in another chat; send again when it ends".into());
            }
            let cwd = project
                .as_ref()
                .map(Project::workspace_dir)
                .unwrap_or_else(|| self.cfg.unfiled_workspace.clone());
            let forked = self
                .sync
                .fork(project.as_ref().map(|p| p.id.as_str()), &path, &cwd)?;
            if let Some(w) = forked.warning {
                self.emit("turn-notice", serde_json::to_string(&w).unwrap_or_default());
            }
            path = forked.log;
        }
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
        self.refuse_mirrored(&path)?;
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

    async fn act(&self, chat: &str, action: ChatAction) -> Result<ActReply, String> {
        match &action {
            ChatAction::Undelete => return self.undelete(chat),
            ChatAction::ResumeLimit => return self.resume_limit(chat).await,
            ChatAction::Budget { decision, text } => {
                return self.budget(chat, decision, text.clone()).await;
            }
            ChatAction::Compact | ChatAction::Checkpoint { .. } => return Err(not_yet(&action)),
            _ => {}
        }
        let (project, path, session) = self.load(chat).await?;
        self.refuse_mirrored(&path)?;
        // A delete names the whole chat, never a prefix that happens to
        // match one.
        if matches!(action, ChatAction::Delete) && session.id != chat {
            return Err(format!("name the whole chat id to delete it, not `{chat}`"));
        }
        let _held = self.hold(&session.id).map_err(|e| {
            if matches!(action, ChatAction::Delete) && e == RUNNING_HERE {
                "that chat is running a turn — delete it when the turn ends".to_string()
            } else {
                e
            }
        })?;
        self.act_on(project, path, session, action)
    }

    async fn context(&self, chat: &str) -> Result<ContextReply, String> {
        let (project, _, session) = self.load(chat).await?;
        Ok(self.context_of(project.as_ref(), &session))
    }

    /// Refused, as the Mac refuses it on the Claude Code engine — the only
    /// engine `serve` runs.
    async fn edit_context(
        &self,
        chat: &str,
        _targets: Vec<usize>,
        _remove: bool,
    ) -> Result<WireView, String> {
        self.locate(chat)?;
        Err(context_ops::not_on_claude_code("edit the context"))
    }

    async fn layers(&self, chat: &str, change: LayerChange) -> Result<ContextReply, String> {
        let (project, path, mut session) = self.load(chat).await?;
        self.refuse_mirrored(&path)?;
        let _held = self.hold(&session.id)?;
        match change {
            LayerChange::Off { off } => context_ops::set_layers_off(&mut session, off),
            LayerChange::Text { kind, text } => {
                context_ops::set_layer_text(&mut session, kind, text)?
            }
            LayerChange::Choice { .. } => {
                return Err(
                    "the away server builds each turn's prompt fresh from the chat, \
                     so there is no held version to choose"
                        .into(),
                );
            }
        }
        if let Some(f) = session.write_failure() {
            return Err(f.summary());
        }
        Ok(self.context_of(project.as_ref(), &session))
    }

    async fn rail(&self) -> Result<Rail, String> {
        let saved = rail_store::load(&serve_reads::home()?)?;
        Ok(saved.to_rail(self.cfg.model.as_deref(), self.busy()))
    }

    async fn set_rail(&self, patch: RailPatch) -> Result<Rail, String> {
        let saved = rail_store::apply(&serve_reads::home()?, &patch)?;
        Ok(saved.to_rail(self.cfg.model.as_deref(), self.busy()))
    }

    async fn running(&self) -> Result<Running, String> {
        let chat = lock(&self.turn).as_ref().map(|t| t.chat.clone());
        let waiting = lock(&self.pending).len();
        let busy = chat
            .map(|chat| serve_reads::Busy { chat, waiting })
            .into_iter()
            .collect();
        serve_reads::running(self.read_places()?, busy).await
    }

    async fn usage(&self) -> Result<UsageReply, String> {
        serve_reads::usage().await
    }

    async fn search(
        &self,
        q: &str,
        scope: SearchScope,
    ) -> Result<crate::store::search::SearchResult, String> {
        serve_reads::search(self.read_places()?, q, scope).await
    }

    async fn project_new(&self, req: NewProjectRequest) -> Result<ProjectRow, String> {
        let active = lock(&self.active_project).clone();
        let home = serve_reads::home()?;
        serve_reads::project_new(&home, &mut lock(&self.registry), &req, active.as_deref())
    }

    async fn project_open(&self, id: &str) -> Result<ProjectRow, String> {
        if id == NO_PROJECT_ID {
            let mut active = lock(&self.active_project);
            if active.is_some() {
                *lock(&self.active_chat) = None;
            }
            *active = None;
            return Ok(ProjectRow {
                active: true,
                id: NO_PROJECT_ID.into(),
                name: NO_PROJECT_NAME.into(),
            });
        }
        let mut registry = lock(&self.registry);
        let mut active = lock(&self.active_project);
        let mut chat = lock(&self.active_chat);
        serve_reads::project_open(&mut registry, &mut active, &mut chat, id)
    }

    async fn project_rename(&self, id: &str, name: &str) -> Result<ProjectRow, String> {
        let active = lock(&self.active_project).clone();
        serve_reads::project_rename(&mut lock(&self.registry), active.as_deref(), id, name)
    }

    async fn project_forget(&self, id: &str) -> Result<(), String> {
        let mut registry = lock(&self.registry);
        let mut active = lock(&self.active_project);
        let mut chat = lock(&self.active_chat);
        serve_reads::project_forget(&mut registry, &mut active, &mut chat, id)
    }

    async fn notes_list(&self, scope: &str) -> Result<Vec<crate::project::Note>, String> {
        serve_reads::notes_list(&self.read_places()?, scope)
    }

    async fn note_read(&self, scope: &str, name: &str) -> Result<String, String> {
        serve_reads::note_read(&self.read_places()?, scope, name)
    }

    async fn note_write(&self, scope: &str, name: &str, text: &str) -> Result<(), String> {
        serve_reads::note_write(&self.read_places()?, scope, name, text)
    }

    async fn note_delete(&self, scope: &str, name: &str) -> Result<(), String> {
        serve_reads::note_delete(&self.read_places()?, scope, name)
    }

    fn sync(&self) -> Option<Arc<crate::sync::SyncServer>> {
        Some(self.sync.clone())
    }

    fn kind(&self) -> &'static str {
        "serve"
    }

    async fn limit_pause(&self) -> Option<crate::remote::api::LimitPause> {
        let p = lock(&self.pause).clone()?;
        let resume_at = lock(&self.resume)
            .as_ref()
            .filter(|s| s.seq == p.seq)
            .map(|s| s.at);
        Some(crate::remote::api::LimitPause {
            chat: Some(p.chat),
            resets_at: p.hit.resets_at,
            window: p.hit.window,
            text: p.hit.text,
            subagents: p.hit.subagents,
            resume_at,
        })
    }

    async fn nightshift_roots(&self) -> Vec<crate::remote::NightshiftProject> {
        let Some(dir) = self.cfg.nightshift_root.clone() else {
            return Vec::new();
        };
        tokio::task::spawn_blocking(move || {
            crate::nightshift::detect(&dir)
                .map(|root| {
                    let name = if root.config.name.trim().is_empty() {
                        dir.file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_else(|| "Nightshift".into())
                    } else {
                        root.config.name.clone()
                    };
                    crate::remote::NightshiftProject {
                        id: "away".into(),
                        name,
                        root,
                    }
                })
                .into_iter()
                .collect()
        })
        .await
        .unwrap_or_default()
    }

    fn features(&self) -> Vec<String> {
        [
            feature::ACT,
            feature::CONTEXT,
            feature::LAYERS,
            feature::SEND_PROJECT,
            feature::IMAGES,
            feature::DOCUMENTS,
            feature::COUNCIL,
            feature::SPOKEN,
            feature::RAIL,
            feature::RUNNING,
            feature::USAGE,
            feature::SEARCH,
            feature::PROJECTS,
            feature::NOTES,
            // Wave 5 (wave 3 B1): not compact, checkpoint, dream or
            // capture; `nightshift` the listener names itself.
            feature::BUDGET,
            feature::RESUME_LIMIT,
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
echo run >> "$D/runs"
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
limit)
  R="$(cat "$D/resets")"
  printf '%s\n' "{{\"type\":\"assistant\",\"message\":{{\"id\":\"9cd2b807\",\"model\":\"<synthetic>\",\"role\":\"assistant\",\"stop_reason\":\"stop_sequence\",\"content\":[{{\"type\":\"text\",\"text\":\"You've hit your session limit · resets 11:50pm (America/Los_Angeles)\"}}],\"usage\":{{\"input_tokens\":0,\"output_tokens\":0}}}},\"parent_tool_use_id\":null,\"error\":\"rate_limit\",\"isApiErrorMessage\":true,\"apiErrorStatus\":429,\"quotaLimits\":{{\"status\":\"rejected\",\"resetsAt\":$R,\"rateLimitType\":\"five_hour\",\"overageStatus\":\"rejected\",\"isUsingOverage\":false}},\"session_id\":\"s-1\"}}"
  printf '%s\n' '{{"type":"result","subtype":"success","is_error":true,"num_turns":1,"result":"You have hit your session limit","session_id":"s-1","stop_reason":"stop_sequence","usage":{{"input_tokens":0,"output_tokens":0}}}}'
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
            home: root.clone(),
            unfiled_workspace: workspace.clone(),
            nightshift_root: None,
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

    /// A log's events as JSON with what differs between two writes of the
    /// same edit taken out: every `at`, and a new chat's own id.
    fn shape(events: &[SessionEvent]) -> Vec<serde_json::Value> {
        events
            .iter()
            .map(|e| {
                let mut v = serde_json::to_value(e).unwrap();
                if let Some(o) = v.as_object_mut() {
                    o.remove("at");
                    if o.get("event").and_then(|x| x.as_str()) == Some("session_created") {
                        o.remove("id");
                    }
                }
                v
            })
            .collect()
    }

    /// A copy of the log at `path` in a scratch folder of its own, loaded:
    /// what the Mac's command would act on.
    fn mirror(path: &Path, scratch: &Path) -> Session {
        let dir = scratch.join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir).unwrap();
        let copy = dir.join(path.file_name().unwrap());
        std::fs::copy(path, &copy).unwrap();
        Session::load(&copy).unwrap()
    }

    fn on_disk(unfiled: &Path, chat: &str) -> Vec<SessionEvent> {
        let path = store::find_by_prefix(unfiled, chat).unwrap();
        Session::load(&path).unwrap().events().to_vec()
    }

    /// Wave 3, A1: every chat action, the Context page and the layers on
    /// the away server, over HTTP with the stand-in `claude`. Each action's
    /// log is checked against the shared function the Mac's command runs
    /// (`chat_ops` / `context_ops`) applied to a copy of the log taken just
    /// before — not a copy of the function.
    #[tokio::test]
    async fn serve_answers_the_chat_actions_context_and_layers_as_the_mac_does() {
        use nightloom_core::{ContentBlock, Usage};
        crate::project::set_config_dir(
            std::env::temp_dir().join(format!("nightloom-home-{}", std::process::id())),
        );
        let root =
            std::env::temp_dir().join(format!("nightloom-serve-ops-{}", uuid::Uuid::new_v4()));
        let unfiled = root.join("unfiled").join("sessions");
        let workspace = root.join("ws");
        let scratch = root.join("mac");
        std::fs::create_dir_all(&unfiled).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        let text = |s: &str| ContentBlock::Text { text: s.into() };
        let mut seeded = Session::start(&unfiled, ChatMode::Normal, ChatKind::Build).unwrap();
        seeded.record_user("first"); // 1
        seeded.record_assistant("m", vec![text("a1"), text("a2")], None, Usage::default()); // 2
        seeded.record_user("second"); // 3
        seeded.record_assistant("m", vec![text("b1")], None, Usage::default()); // 4
        let chat = seeded.id.clone();
        drop(seeded);
        let path = store::find_by_prefix(&unfiled, &chat).unwrap();

        let cfg = ServeConfig {
            binary: stand_in(&root),
            model: None,
            hook_exe: None,
            assets: None,
            unfiled_dir: unfiled.clone(),
            home: root.clone(),
            unfiled_workspace: workspace.clone(),
            nightshift_root: None,
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
        let act = format!("{base}/api/chats/{chat}/act");
        let ws = || Some(OnCli::at(workspace.clone()));

        // The host and what it serves: exactly the routes answered below.
        let state = get(&c, format!("{base}/api/state"), &token).await;
        assert_eq!(state["host"], "serve");
        assert_eq!(
            state["features"],
            serde_json::json!([
                "act",
                "context",
                "layers",
                "send_project",
                "images",
                "documents",
                "council",
                "spoken",
                "rail",
                "running",
                "usage",
                "search",
                "projects",
                "notes",
                "budget",
                "resume_limit"
            ])
        );

        // Each in-place action: the log equals the shared function's.
        type Op = Box<dyn Fn(&mut Session)>;
        let w = workspace.clone();
        let cli = move || Some(OnCli::at(w.clone()));
        let cases: Vec<(serde_json::Value, Op)> = vec![
            (
                serde_json::json!({"op": "edit", "index": 1, "text": "first, better", "mode": "save"}),
                Box::new({
                    let cli = cli.clone();
                    move |s| {
                        chat_ops::edit_saved(s, cli(), 1, "first, better".into(), None).unwrap()
                    }
                }),
            ),
            (
                serde_json::json!({"op": "edit", "index": 2, "text": "a2 better", "mode": "save", "block": 1}),
                Box::new({
                    let cli = cli.clone();
                    move |s| chat_ops::edit_saved(s, cli(), 2, "a2 better".into(), Some(1)).unwrap()
                }),
            ),
            (
                serde_json::json!({"op": "remove", "index": 3}),
                Box::new({
                    let cli = cli.clone();
                    move |s| chat_ops::remove_message(s, cli(), 3).unwrap()
                }),
            ),
            (
                serde_json::json!({"op": "restore", "index": 3}),
                Box::new({
                    let cli = cli.clone();
                    move |s| chat_ops::restore_message(s, cli(), 3).unwrap()
                }),
            ),
            (
                serde_json::json!({"op": "remove_block", "index": 2, "block": 0}),
                Box::new({
                    let cli = cli.clone();
                    move |s| chat_ops::remove_block(s, cli(), 2, 0).unwrap()
                }),
            ),
            (
                serde_json::json!({"op": "restore_block", "index": 2, "block": 0}),
                Box::new({
                    let cli = cli.clone();
                    move |s| chat_ops::restore_block(s, cli(), 2, 0).unwrap()
                }),
            ),
            (
                serde_json::json!({"op": "rewind", "to": 3}),
                Box::new({
                    let cli = cli.clone();
                    move |s| chat_ops::rewind(s, cli(), 3).unwrap()
                }),
            ),
            (
                serde_json::json!({"op": "kind", "kind": "chat"}),
                Box::new(|s| chat_ops::set_kind(s, ChatKind::Chat, None)),
            ),
            (
                serde_json::json!({"op": "kind", "kind": "build"}),
                Box::new(|s| chat_ops::set_kind(s, ChatKind::Build, None)),
            ),
        ];
        for (body, mac) in cases {
            let mut expected = mirror(&path, &scratch);
            mac(&mut expected);
            let (code, reply) = post(&c, act.clone(), &token, body.clone()).await;
            assert_eq!(code, 200, "{body}: {reply}");
            let reply: ActReply = serde_json::from_str(&reply).unwrap();
            assert_eq!(reply.chat, chat, "{body}");
            let got = on_disk(&unfiled, &chat);
            assert_eq!(shape(&got), shape(expected.events()), "{body}");
            assert_eq!(
                shape(&reply.events),
                shape(&got),
                "{body}: the reply is the log"
            );
        }
        // Unrewind lifts the rewind just recorded (its marker's index).
        let marker = on_disk(&unfiled, &chat)
            .iter()
            .rposition(|e| matches!(e, SessionEvent::Rewind { .. }))
            .unwrap();
        let mut expected = mirror(&path, &scratch);
        chat_ops::unrewind(&mut expected, ws(), marker).unwrap();
        let (code, reply) = post(
            &c,
            act.clone(),
            &token,
            serde_json::json!({"op": "unrewind", "of": marker}),
        )
        .await;
        assert_eq!(code, 200, "{reply}");
        assert_eq!(shape(&on_disk(&unfiled, &chat)), shape(expected.events()));

        // A fork: the reply names the new chat, whose log is the shared
        // function's fork; the parent is untouched.
        let before = on_disk(&unfiled, &chat);
        let expected = chat_ops::fork(&mirror(&path, &scratch), &scratch, ws(), 3).unwrap();
        let (code, reply) = post(
            &c,
            act.clone(),
            &token,
            serde_json::json!({"op": "fork", "upto": 3}),
        )
        .await;
        assert_eq!(code, 200, "{reply}");
        let reply: ActReply = serde_json::from_str(&reply).unwrap();
        assert_ne!(reply.chat, chat);
        assert_eq!(
            shape(&on_disk(&unfiled, &reply.chat)),
            shape(expected.events())
        );
        assert_eq!(shape(&on_disk(&unfiled, &chat)), shape(&before));
        let state = get(&c, format!("{base}/api/state"), &token).await;
        assert_eq!(
            state["active_chat"],
            reply.chat.as_str(),
            "the phone follows the fork"
        );

        // Continue: a new, linked chat.
        let expected = chat_ops::continue_from(&mirror(&path, &scratch), &scratch, None).unwrap();
        let (code, reply) = post(
            &c,
            act.clone(),
            &token,
            serde_json::json!({"op": "continue"}),
        )
        .await;
        assert_eq!(code, 200, "{reply}");
        let reply: ActReply = serde_json::from_str(&reply).unwrap();
        assert_ne!(reply.chat, chat);
        assert_eq!(
            shape(&on_disk(&unfiled, &reply.chat)),
            shape(expected.events())
        );

        // Layers: switched off, a layer's own text — the log as the Mac's
        // command writes it, the Context page after in the reply.
        let layers = format!("{base}/api/chats/{chat}/layers");
        let mut expected = mirror(&path, &scratch);
        context_ops::set_layers_off(&mut expected, vec![SegmentKind::Pacing]);
        let (code, reply) = post(
            &c,
            layers.clone(),
            &token,
            serde_json::json!({"off": ["pacing"]}),
        )
        .await;
        assert_eq!(code, 200, "{reply}");
        assert_eq!(shape(&on_disk(&unfiled, &chat)), shape(expected.events()));
        let v: serde_json::Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(v["layers"]["off"], serde_json::json!(["pacing"]));
        let mut expected = mirror(&path, &scratch);
        context_ops::set_layer_text(&mut expected, SegmentKind::UserMemory, Some("mine".into()))
            .unwrap();
        let (code, reply) = post(
            &c,
            layers.clone(),
            &token,
            serde_json::json!({"kind": "user_memory", "text": "mine"}),
        )
        .await;
        assert_eq!(code, 200, "{reply}");
        assert_eq!(shape(&on_disk(&unfiled, &chat)), shape(expected.events()));
        // No prompt hold here: a choice is refused with a sentence.
        let (code, reply) = post(
            &c,
            layers.clone(),
            &token,
            serde_json::json!({"kind": "user_memory", "choice": "keep"}),
        )
        .await;
        assert_eq!(code, 409, "{reply}");

        // The Context page: the preamble itemised, the layers as built,
        // each editable layer's file as `sources`, no held change.
        let ctx = get(&c, format!("{base}/api/chats/{chat}/context"), &token).await;
        assert!(ctx["view"].is_object(), "{ctx}");
        assert_eq!(ctx["layers"]["off"], ctx["layers"]["built"]);
        assert!(
            ctx["layers"]["sources"]
                .as_object()
                // Five since the thread's Start here became editable (271).
                .is_some_and(|o| o.len() == 5),
            "{ctx}"
        );
        assert!(ctx["pending"].is_null());
        // Hiding items is refused on Claude Code, as on the Mac.
        let (code, reply) = post(
            &c,
            format!("{base}/api/chats/{chat}/context"),
            &token,
            serde_json::json!({"targets": [1], "remove": true}),
        )
        .await;
        assert_eq!(code, 409);
        assert!(reply.contains("Claude Code engine"), "{reply}");
        // Compact: the Mac's own refusal on the Claude Code engine (wave
        // B, B1; was "not on the away server yet"), never a 200.
        let (code, reply) = post(
            &c,
            act.clone(),
            &token,
            serde_json::json!({"op": "compact"}),
        )
        .await;
        assert_eq!(code, 409);
        assert!(reply.contains("on the Claude Code engine"), "{reply}");

        // Edit and send: a fork cut before the turn, the new text its first
        // turn, run by the stand-in.
        std::fs::write(root.join("mode"), "reply").unwrap();
        let (code, reply) = post(
            &c,
            act.clone(),
            &token,
            serde_json::json!({"op": "edit", "index": 3, "text": "second, resent", "mode": "send"}),
        )
        .await;
        assert_eq!(code, 200, "{reply}");
        let fork: ActReply = serde_json::from_str(&reply).unwrap();
        assert_ne!(fork.chat, chat);
        until(&c, &base, &token, Duration::from_secs(10), |s| {
            s["busy"] == false
        })
        .await;
        let log = serde_json::to_string(&on_disk(&unfiled, &fork.chat)).unwrap();
        assert!(log.contains("second, resent"), "{log}");
        assert!(log.contains("hi from the stand-in"), "{log}");

        // Mid-turn: every change to the running chat is a 409 with the
        // sentence, and the log is as it was.
        std::fs::write(root.join("mode"), "park").unwrap();
        let (code, body) = post(
            &c,
            format!("{base}/api/chats/{chat}/send"),
            &token,
            serde_json::json!({"text": "wait"}),
        )
        .await;
        assert_eq!(code, 202, "{body}");
        until(&c, &base, &token, Duration::from_secs(10), |s| {
            s["busy"] == true
        })
        .await;
        let before = on_disk(&unfiled, &chat);
        for body in [
            serde_json::json!({"op": "remove", "index": 1}),
            serde_json::json!({"op": "delete"}),
        ] {
            let (code, reply) = post(&c, act.clone(), &token, body.clone()).await;
            assert_eq!(code, 409, "{body}: {reply}");
            assert!(
                reply.contains("running a turn") || reply.contains("turn is running"),
                "{reply}"
            );
        }
        let (code, _) = post(&c, layers.clone(), &token, serde_json::json!({"off": []})).await;
        assert_eq!(code, 409);
        // The turn records its own message; no action's marker landed.
        let markers = |es: &[SessionEvent]| {
            es.iter()
                .filter(|e| {
                    matches!(
                        e,
                        SessionEvent::Elide { .. } | SessionEvent::PromptLayers { .. }
                    )
                })
                .count()
        };
        assert_eq!(markers(&on_disk(&unfiled, &chat)), markers(&before));
        while !root.join("last-args").exists() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
        post(
            &c,
            format!("{base}/api/chats/{chat}/cancel"),
            &token,
            serde_json::json!({}),
        )
        .await;
        until(&c, &base, &token, Duration::from_secs(15), |s| {
            s["busy"] == false
        })
        .await;

        // A blank id or a prefix never deletes a chat (the live pass found
        // a blank id matching the only chat).
        let (code, _) = post(
            &c,
            format!("{base}/api/chats/%20/act"),
            &token,
            serde_json::json!({"op": "delete"}),
        )
        .await;
        assert_ne!(code, 200);
        let (code, _) = post(
            &c,
            format!("{base}/api/chats/{}/act", &chat[..8]),
            &token,
            serde_json::json!({"op": "delete"}),
        )
        .await;
        assert_eq!(code, 409);
        assert!(path.exists());
        // Delete moves the log to the trash folder; undelete brings it back.
        let (code, reply) =
            post(&c, act.clone(), &token, serde_json::json!({"op": "delete"})).await;
        assert_eq!(code, 200, "{reply}");
        assert!(!path.exists());
        assert!(chat_ops::in_trash(&unfiled, &chat));
        let chats = texts(&get(&c, format!("{base}/api/chats"), &token).await);
        assert!(!chats.contains(&chat), "{chats}");
        let (code, reply) = post(
            &c,
            act.clone(),
            &token,
            serde_json::json!({"op": "undelete"}),
        )
        .await;
        assert_eq!(code, 200, "{reply}");
        assert!(path.exists());

        server.stop().await;
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The one-holder rule: a second holder of a home is refused, with the
    /// first named; the lock goes with its holder.
    #[test]
    fn a_scheduled_resume_whose_pause_is_over_says_nothing() {
        assert_eq!(scheduled_resume_notice(PAUSE_OVER), None);
        let said = scheduled_resume_notice("a turn is running in another chat").unwrap();
        assert!(said.contains("press Resume again"), "{said}");
    }

    /// A host on its own home, for the prompt tests below.
    fn prompt_host(model: Option<&str>) -> (Arc<ServeHost>, PathBuf) {
        crate::project::set_config_dir(
            std::env::temp_dir().join(format!("nightloom-home-{}", std::process::id())),
        );
        let root = std::env::temp_dir().join(format!("nightloom-serve-{}", uuid::Uuid::new_v4()));
        let unfiled = root.join("unfiled").join("sessions");
        let workspace = root.join("ws");
        std::fs::create_dir_all(&unfiled).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        let cfg = ServeConfig {
            binary: "claude".into(),
            model: model.map(str::to_string),
            hook_exe: None,
            assets: None,
            unfiled_dir: unfiled,
            home: root.clone(),
            unfiled_workspace: workspace,
            nightshift_root: None,
        };
        let host = ServeHost::new(cfg, Registry::load_from(root.join("projects.json")));
        (host, root)
    }

    /// Serve's Context page shows the model a turn would run with: the
    /// rail's, else `--model` (wave 3's leftover: it always used
    /// `--model`). Seen through each model's instructions file.
    #[tokio::test]
    async fn the_context_page_follows_the_rails_model() {
        let tag = uuid::Uuid::new_v4().simple().to_string();
        let flag = format!("w4c-flag-{tag}");
        let railed = format!("w4c-rail-{tag}");
        let (host, root) = prompt_host(Some(&flag));
        let models = crate::prompt::model_instructions_dir().unwrap();
        std::fs::create_dir_all(&models).unwrap();
        let flag_file = models.join(crate::prompt::model_instruction_file(&flag));
        let rail_file = models.join(crate::prompt::model_instruction_file(&railed));
        std::fs::write(&flag_file, "the flag model's rules").unwrap();
        std::fs::write(&rail_file, "the rail model's rules").unwrap();

        let mut rail = rail_store::RailSettings {
            model: railed.clone(),
            ..Default::default()
        };
        let page = serde_json::to_string(&host.context_with(&rail, None, &Session::new())).unwrap();
        assert!(page.contains("the rail model's rules"), "{page}");
        assert!(!page.contains("the flag model's rules"), "{page}");

        rail.model.clear();
        let page = serde_json::to_string(&host.context_with(&rail, None, &Session::new())).unwrap();
        assert!(page.contains("the flag model's rules"), "{page}");

        let _ = std::fs::remove_file(flag_file);
        let _ = std::fs::remove_file(rail_file);
        let _ = std::fs::remove_dir_all(root);
    }

    /// A mirror-only project's `AGENTS.md` — the one the Mac sent — reaches
    /// the turn's preamble and the Context page (wave 3's leftover: its
    /// turns ran in an empty server folder and read none); a chat's own
    /// project instructions still win.
    #[tokio::test]
    async fn a_mirror_only_project_reads_the_macs_agents_md() {
        let (host, root) = prompt_host(None);
        let pid = format!("p-{}", uuid::Uuid::new_v4().simple());
        let layout = crate::sync::Layout::new(&root);
        let dir = layout.root().join(project::PROJECTS_DIR).join(&pid);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            layout.root().join("projects.json"),
            serde_json::json!([{ "id": pid, "name": "Marked away" }]).to_string(),
        )
        .unwrap();
        std::fs::write(dir.join("AGENTS.md"), "the mac's project rules\n").unwrap();

        let p = host.project(Some(&pid)).unwrap().unwrap();
        let session = Session::new();
        let prompt = host
            .spec_for(Some(&p), &session)
            .append_system_prompt
            .unwrap_or_default();
        assert!(prompt.contains("the mac's project rules"), "{prompt}");
        let page = serde_json::to_string(&host.context_of(Some(&p), &session)).unwrap();
        assert!(page.contains("the mac's project rules"), "{page}");

        let mut own = Session::new();
        own.record_user("q");
        context_ops::set_layer_text(
            &mut own,
            SegmentKind::ProjectInstructions,
            Some("the chat's own rules".into()),
        )
        .unwrap();
        let prompt = host
            .spec_for(Some(&p), &own)
            .append_system_prompt
            .unwrap_or_default();
        assert!(prompt.contains("the chat's own rules"), "{prompt}");
        assert!(!prompt.contains("the mac's project rules"), "{prompt}");

        let _ = std::fs::remove_dir_all(root);
    }

    /// How often `needle` appears in `hay`.
    fn count(hay: &str, needle: &str) -> usize {
        hay.matches(needle).count()
    }

    /// A turn's preamble, the Context page's itemised view of it, and the
    /// page's `sources`, for an unfiled chat (its folder, `<home>/ws`, sits
    /// under the home, so the walk climbs through `<home>/AGENTS.md`).
    fn memory_seen(host: &ServeHost) -> (String, String, serde_json::Value) {
        let session = Session::new();
        let turn = host
            .spec_for(None, &session)
            .append_system_prompt
            .unwrap_or_default();
        let page = serde_json::to_value(host.context_of(None, &session)).unwrap();
        // The page's preamble as one text (each segment also carries a
        // preview, which would count twice).
        let view = page["view"]["system_text"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        (turn, view, page["layers"]["sources"].clone())
    }

    /// Item 274: with the Mac's memory synced to `mirror/AGENTS.md`, a turn
    /// reads it, once, and not the server's own `<home>/AGENTS.md` (which
    /// the walk from a folder under the home used to read a second time,
    /// as project instructions); the Context page shows the same. An empty
    /// mirror copy is the Mac's memory being empty: no memory, still not
    /// the server's. A chat's own memory text still wins.
    #[tokio::test]
    async fn serve_reads_the_macs_memory_once_when_the_mirror_has_it() {
        let tag = uuid::Uuid::new_v4().simple().to_string();
        let (host, root) = prompt_host(None);
        let mac = format!("mac-memory-{tag}");
        let server = format!("server-memory-{tag}");
        std::fs::write(root.join("AGENTS.md"), &server).unwrap();
        let mirror = crate::sync::Layout::new(&root).root();
        std::fs::create_dir_all(&mirror).unwrap();
        std::fs::write(mirror.join("AGENTS.md"), &mac).unwrap();

        let (turn, view, sources) = memory_seen(&host);
        assert_eq!(count(&turn, &mac), 1, "{turn}");
        assert_eq!(count(&turn, &server), 0, "{turn}");
        assert_eq!(count(&view, &mac), 1, "{view}");
        assert_eq!(count(&view, &server), 0, "{view}");
        assert_eq!(sources["user_memory"], serde_json::json!(mac), "{sources}");
        assert!(
            !sources["project_instructions"]
                .to_string()
                .contains(&server),
            "{sources}"
        );

        // A mirror-only project's turn, in `<home>/workspaces/<id>`: the
        // same memory, once.
        let pid = format!("p-{tag}");
        std::fs::write(
            mirror.join("projects.json"),
            serde_json::json!([{ "id": pid, "name": "Marked away" }]).to_string(),
        )
        .unwrap();
        let p = host.project(Some(&pid)).unwrap().unwrap();
        let turn = host
            .spec_for(Some(&p), &Session::new())
            .append_system_prompt
            .unwrap_or_default();
        assert_eq!(count(&turn, &mac), 1, "{turn}");
        assert_eq!(count(&turn, &server), 0, "{turn}");

        // The chat's own memory text wins over the Mac's.
        let mut own = Session::new();
        own.record_user("q");
        context_ops::set_layer_text(&mut own, SegmentKind::UserMemory, Some("mine".into()))
            .unwrap();
        let turn = host
            .spec_for(None, &own)
            .append_system_prompt
            .unwrap_or_default();
        assert!(turn.contains("mine"), "{turn}");
        assert_eq!(count(&turn, &mac), 0, "{turn}");

        // An emptied mirror copy: no memory, and not the server's.
        std::fs::write(mirror.join("AGENTS.md"), "  \n").unwrap();
        let (turn, view, sources) = memory_seen(&host);
        assert_eq!(count(&turn, &server), 0, "{turn}");
        assert_eq!(count(&view, &server), 0, "{view}");
        assert!(!turn.contains("<user-instructions>"), "{turn}");
        assert!(sources["user_memory"].is_null(), "{sources}");

        let _ = std::fs::remove_dir_all(root);
    }

    /// Item 274: with no mirror copy, a turn reads the server's own
    /// `<home>/AGENTS.md` as memory, once — no longer a second time as
    /// project instructions from the walk — and a real project file in
    /// the folder still reaches the turn; the Context page agrees.
    #[tokio::test]
    async fn serve_reads_its_own_memory_once_without_a_mirror_copy() {
        let tag = uuid::Uuid::new_v4().simple().to_string();
        let (host, root) = prompt_host(None);
        let server = format!("server-memory-{tag}");
        let rules = format!("folder-rules-{tag}");
        std::fs::write(root.join("AGENTS.md"), &server).unwrap();
        std::fs::write(root.join("ws").join("AGENTS.md"), &rules).unwrap();

        let (turn, view, sources) = memory_seen(&host);
        assert_eq!(count(&turn, &server), 1, "{turn}");
        assert_eq!(count(&view, &server), 1, "{view}");
        let memory_at = turn.find("<user-instructions>").expect("memory layer");
        assert!(turn.find(&server).unwrap() > memory_at, "{turn}");
        assert_eq!(count(&turn, &rules), 1, "{turn}");
        assert_eq!(count(&view, &rules), 1, "{view}");
        assert_eq!(
            sources["user_memory"],
            serde_json::json!(server),
            "{sources}"
        );
        assert_eq!(
            sources["project_instructions"],
            serde_json::json!(rules),
            "{sources}"
        );

        let _ = std::fs::remove_dir_all(root);
    }

    /// The flake's race, made to happen: while another thread spawns
    /// processes, a take right after a drop must still win. Without the
    /// re-ask in [`HomeLock::take`] this lost 406 of 3000 rounds
    /// (measured 2026-10-01), and this test lost 99 in its 400 ms; with it,
    /// none.
    #[test]
    fn a_take_right_after_a_drop_wins_while_children_spawn() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let stop = Arc::new(AtomicBool::new(false));
        let spawning = stop.clone();
        let spawner = std::thread::spawn(move || {
            while !spawning.load(Ordering::Relaxed) {
                let _ = std::process::Command::new("/usr/bin/true").status();
            }
        });
        let home = std::env::temp_dir().join(format!("nightloom-lock-{}", uuid::Uuid::new_v4()));
        let mut lost = Vec::new();
        let start = std::time::Instant::now();
        let mut round = 0;
        while start.elapsed() < std::time::Duration::from_millis(400) {
            round += 1;
            match HomeLock::take(&home, "the Nightloom desktop app") {
                Ok(first) => drop(first),
                Err(e) => lost.push(format!("{round}: {e}")),
            }
        }
        stop.store(true, Ordering::Relaxed);
        spawner.join().unwrap();
        let _ = std::fs::remove_dir_all(&home);
        assert!(lost.is_empty(), "{} lost: {:?}", lost.len(), lost.first());
    }

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

    /// The away server's side of sync (item 268 step 3, A4's patch §2): a
    /// project the Mac marked and its chat are listed from the mirror; a
    /// send to the mirrored chat forks it into the server's own folder and
    /// leaves the Mac's copy byte-identical; a change to the Mac's copy is
    /// refused.
    #[tokio::test]
    async fn serve_lists_mirrored_chats_and_forks_before_writing_one() {
        crate::project::set_config_dir(
            std::env::temp_dir().join(format!("nightloom-home-{}", std::process::id())),
        );
        let home = crate::project::config_dir().unwrap();
        let root = std::env::temp_dir().join(format!("nightloom-serve-{}", uuid::Uuid::new_v4()));
        let unfiled = root.join("unfiled").join("sessions");
        let workspace = root.join("ws");
        std::fs::create_dir_all(&unfiled).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(root.join("mode"), "reply").unwrap();

        // What a push from the Mac leaves: the marked project and one chat.
        let pid = format!("p-{}", uuid::Uuid::new_v4().simple());
        let layout = crate::sync::Layout::new(&home);
        std::fs::create_dir_all(layout.root()).unwrap();
        std::fs::write(
            layout.root().join("projects.json"),
            serde_json::json!([{ "id": pid, "name": "Marked away" }]).to_string(),
        )
        .unwrap();
        let mut mac =
            Session::start(layout.sessions(&pid), ChatMode::Normal, ChatKind::Build).unwrap();
        mac.record_user("asked on the mac");
        let chat = mac.id.clone();
        drop(mac);
        let original = store::find_by_prefix(&layout.sessions(&pid), &chat).unwrap();
        let before = std::fs::read(&original).unwrap();

        let cfg = ServeConfig {
            binary: stand_in(&root),
            model: None,
            hook_exe: None,
            assets: None,
            unfiled_dir: unfiled.clone(),
            home: home.clone(),
            unfiled_workspace: workspace.clone(),
            nightshift_root: None,
        };
        let host = ServeHost::new(cfg, Registry::load_from(root.join("projects.json")));

        let projects = host.projects().await.unwrap();
        assert!(
            projects
                .iter()
                .any(|p| p.id == pid && p.name == "Marked away")
        );
        let rows = host.chats(Some(&pid)).await.unwrap();
        assert!(
            rows.iter().any(|r| r.id == chat),
            "the mirrored chat is listed"
        );
        let log = host.transcript(Some(&pid), &chat).await.unwrap();
        assert!(
            serde_json::to_string(&log)
                .unwrap()
                .contains("asked on the mac")
        );

        // A send forks first; the turn runs in the fork.
        let handed = host
            .send_with(
                Some(&chat),
                SendRequest {
                    text: "continue away".into(),
                    project: Some(pid.clone()),
                    ..SendRequest::default()
                },
            )
            .await
            .unwrap();
        assert!(matches!(handed, Handed::Sent));
        let start = Instant::now();
        while host.busy() {
            assert!(start.elapsed() < Duration::from_secs(10), "the turn ends");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(
            std::fs::read(&original).unwrap(),
            before,
            "the Mac's copy is untouched"
        );
        let fork = lock(&host.active_chat).clone().unwrap();
        assert_ne!(fork, chat);
        let forked =
            store::find_by_prefix(&home.join("projects").join(&pid).join("sessions"), &fork)
                .unwrap();
        let text = std::fs::read_to_string(&forked).unwrap();
        assert!(
            text.contains("continue away") && text.contains("hi from the stand-in"),
            "{text}"
        );
        let rows = host.chats(Some(&pid)).await.unwrap();
        assert!(rows.iter().any(|r| r.id == chat) && rows.iter().any(|r| r.id == fork));

        // A change to the Mac's copy is refused, in words.
        let err = host.rename(&chat, "renamed away").await.unwrap_err();
        assert_eq!(err, MAC_OWNS);
        assert_eq!(std::fs::read(&original).unwrap(), before);

        let _ = std::fs::remove_dir_all(home.join("mirror").join("projects").join(&pid));
        let _ = std::fs::remove_dir_all(home.join("projects").join(&pid));
        let _ = std::fs::remove_dir_all(home.join("workspaces").join(&pid));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// His question after marking three projects available away (wave 4
    /// A): "I hope that means I'm still able to create new chats in the no
    /// project section." `serve` lists a "No project" row beside the marked
    /// projects; its chats list, a new chat in it lands in the unfiled
    /// folder, and the phone's place goes back to no project — also after
    /// it worked in a marked project.
    #[tokio::test]
    async fn serve_keeps_no_project_chats_beside_marked_projects() {
        crate::project::set_config_dir(
            std::env::temp_dir().join(format!("nightloom-home-{}", std::process::id())),
        );
        let root = std::env::temp_dir().join(format!("nightloom-serve-{}", uuid::Uuid::new_v4()));
        let unfiled = root.join("unfiled").join("sessions");
        let workspace = root.join("ws");
        std::fs::create_dir_all(&unfiled).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(root.join("mode"), "reply").unwrap();
        let mut seeded = Session::start(&unfiled, ChatMode::Normal, ChatKind::Build).unwrap();
        seeded.record_user("an unfiled chat");
        let old = seeded.id.clone();
        drop(seeded);

        // Three projects the Mac marked, as a push leaves them.
        let layout = crate::sync::Layout::new(&root);
        std::fs::create_dir_all(layout.root()).unwrap();
        let pids: Vec<String> = (0..3)
            .map(|_| format!("p-{}", uuid::Uuid::new_v4().simple()))
            .collect();
        std::fs::write(
            layout.root().join("projects.json"),
            serde_json::json!(
                pids.iter()
                    .map(|p| serde_json::json!({ "id": p, "name": p }))
                    .collect::<Vec<_>>()
            )
            .to_string(),
        )
        .unwrap();

        let cfg = ServeConfig {
            binary: stand_in(&root),
            model: None,
            hook_exe: None,
            assets: None,
            unfiled_dir: unfiled.clone(),
            home: root.clone(),
            unfiled_workspace: workspace.clone(),
            nightshift_root: None,
        };
        let host = ServeHost::new(cfg, Registry::load_from(root.join("projects.json")));
        let wait = |host: Arc<ServeHost>| async move {
            let start = Instant::now();
            while host.busy() {
                assert!(start.elapsed() < Duration::from_secs(10), "the turn ends");
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        };

        let projects = host.projects().await.unwrap();
        assert_eq!(projects.len(), 4, "no project + the three marked");
        assert_eq!(projects[0].id, NO_PROJECT_ID);
        assert_eq!(projects[0].name, NO_PROJECT_NAME);
        assert!(
            projects[0].active,
            "nothing worked in yet: no project is open"
        );
        assert!(pids.iter().all(|p| projects.iter().any(|r| &r.id == p)));

        // The phone works in a marked project; no project is still listed
        // and its chats still read.
        host.new_chat(Some(&pids[0]), "in a marked project")
            .await
            .unwrap();
        wait(host.clone()).await;
        let projects = host.projects().await.unwrap();
        assert!(!projects[0].active && projects.iter().any(|r| r.id == pids[0] && r.active));
        let rows = host.chats(Some(NO_PROJECT_ID)).await.unwrap();
        assert!(
            rows.iter().any(|r| r.id == old),
            "the unfiled chat is listed"
        );

        // A new chat in no project lands in the unfiled folder, and no
        // project is the phone's place again.
        host.new_chat(Some(NO_PROJECT_ID), "a new no-project chat")
            .await
            .unwrap();
        wait(host.clone()).await;
        let new = lock(&host.active_chat).clone().unwrap();
        assert!(lock(&host.active_project).is_none());
        let log = store::find_by_prefix(&unfiled, &new).unwrap();
        assert!(
            std::fs::read_to_string(&log)
                .unwrap()
                .contains("a new no-project chat")
        );
        assert!(host.projects().await.unwrap()[0].active);
        assert!(host.chats(None).await.unwrap().iter().any(|r| r.id == new));

        // Opening no project from a marked one goes back too.
        host.new_chat(Some(&pids[1]), "again in a marked project")
            .await
            .unwrap();
        wait(host.clone()).await;
        let row = host.project_open(NO_PROJECT_ID).await.unwrap();
        assert!(row.active && lock(&host.active_project).is_none());
        assert!(lock(&host.active_chat).is_none());

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Item 275 on the server: the Mac's no-project chats, mirrored, list
    /// under "No project" beside the server's own; a send to one forks it
    /// into the server's unfiled folder and the Mac's copy stays as sent;
    /// a change to it is refused.
    #[tokio::test]
    async fn serve_lists_the_macs_no_project_chats_and_forks_before_writing_one() {
        crate::project::set_config_dir(
            std::env::temp_dir().join(format!("nightloom-home-{}", std::process::id())),
        );
        let root = std::env::temp_dir().join(format!("nightloom-serve-{}", uuid::Uuid::new_v4()));
        let unfiled = root.join("unfiled").join("sessions");
        let workspace = root.join("ws");
        std::fs::create_dir_all(&unfiled).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(root.join("mode"), "reply").unwrap();
        let mut own = Session::start(&unfiled, ChatMode::Normal, ChatKind::Build).unwrap();
        own.record_user("started on the server");
        let own_id = own.id.clone();
        drop(own);
        let layout = crate::sync::Layout::new(&root);
        let mut mac =
            Session::start(layout.unfiled_sessions(), ChatMode::Normal, ChatKind::Build).unwrap();
        mac.record_user("asked on the mac");
        let chat = mac.id.clone();
        drop(mac);
        let original = store::find_by_prefix(&layout.unfiled_sessions(), &chat).unwrap();
        let before = std::fs::read(&original).unwrap();

        let cfg = ServeConfig {
            binary: stand_in(&root),
            model: None,
            hook_exe: None,
            assets: None,
            unfiled_dir: unfiled.clone(),
            home: root.clone(),
            unfiled_workspace: workspace.clone(),
            nightshift_root: None,
        };
        let host = ServeHost::new(cfg, Registry::load_from(root.join("projects.json")));

        let rows = host.chats(Some(NO_PROJECT_ID)).await.unwrap();
        assert!(
            rows.iter().any(|r| r.id == chat),
            "the Mac's chat is listed"
        );
        assert!(rows.iter().any(|r| r.id == own_id), "the server's own too");
        let log = host.transcript(None, &chat).await.unwrap();
        assert!(
            serde_json::to_string(&log)
                .unwrap()
                .contains("asked on the mac")
        );

        let err = host.rename(&chat, "renamed away").await.unwrap_err();
        assert_eq!(err, MAC_OWNS);

        let handed = host
            .send_with(
                Some(&chat),
                SendRequest {
                    text: "continue away".into(),
                    project: Some(NO_PROJECT_ID.into()),
                    ..SendRequest::default()
                },
            )
            .await
            .unwrap();
        assert!(matches!(handed, Handed::Sent));
        let start = Instant::now();
        while host.busy() {
            assert!(start.elapsed() < Duration::from_secs(10), "the turn ends");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(
            std::fs::read(&original).unwrap(),
            before,
            "the Mac's copy is untouched"
        );
        let fork = lock(&host.active_chat).clone().unwrap();
        assert_ne!(fork, chat);
        let forked = store::find_by_prefix(&unfiled, &fork).unwrap();
        assert!(
            std::fs::read_to_string(&forked)
                .unwrap()
                .contains("continue away")
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    /// Backlog 164 on the away server (wave 3 B1): a turn that ends on the
    /// plan's limit leaves a pause on `/api/state`; Resume after the reset
    /// sends `limit.ts`'s message at once; before it, it is scheduled for
    /// the reset + 30 s, and a second press neither sends nor cancels; a
    /// resumed turn that meets the limit again pauses again and nothing
    /// runs on its own (never a 429 loop). The stand-in emits the CLI's
    /// 429 line (pass 1's fixture shape).
    #[tokio::test]
    async fn serve_pauses_on_the_limit_and_resumes_once_never_into_an_exhausted_window() {
        crate::project::set_config_dir(
            std::env::temp_dir().join(format!("nightloom-home-{}", std::process::id())),
        );
        let root = std::env::temp_dir().join(format!("nightloom-serve-{}", uuid::Uuid::new_v4()));
        let unfiled = root.join("unfiled").join("sessions");
        let workspace = root.join("ws");
        std::fs::create_dir_all(&unfiled).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        let mut seeded = Session::start(&unfiled, ChatMode::Normal, ChatKind::Build).unwrap();
        seeded.record_title_by("limit chat", TitleBy::User);
        let chat = seeded.id.clone();
        drop(seeded);
        let mut other = Session::start(&unfiled, ChatMode::Normal, ChatKind::Build).unwrap();
        other.record_title_by("other chat", TitleBy::User);
        let other = other.id.clone();
        let cfg = ServeConfig {
            binary: stand_in(&root),
            model: None,
            hook_exe: None,
            assets: None,
            unfiled_dir: unfiled.clone(),
            home: root.clone(),
            unfiled_workspace: workspace.clone(),
            nightshift_root: None,
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
        let runs = || {
            std::fs::read_to_string(root.join("runs"))
                .map(|t| t.lines().count())
                .unwrap_or(0)
        };
        let act = |body: serde_json::Value, id: String| {
            let c = c.clone();
            let base = base.clone();
            let token = token.clone();
            async move { post(&c, format!("{base}/api/chats/{id}/act"), &token, body).await }
        };
        let resume = serde_json::json!({"op": "resume_limit"});
        let st = get(&c, format!("{base}/api/state"), &token).await;
        assert_eq!(st["limit_pause"], serde_json::Value::Null);
        let features = st["features"].to_string();
        assert!(features.contains("resume_limit") && features.contains("budget"));
        assert!(!features.contains("compact") && !features.contains("checkpoint"));
        assert!(!features.contains("nightshift") && !features.contains("dream"));

        // Nothing paused: refused in words.
        let (code, body) = act(resume.clone(), chat.clone()).await;
        assert_eq!(code, 409, "{body}");
        assert!(body.contains("nothing in this chat is paused"), "{body}");

        // 1. The limit, with the window already reset: a pause, then a
        //    resume at once that sends limit.ts's words.
        let past = chrono::Utc::now().timestamp() - 100;
        std::fs::write(root.join("mode"), "limit").unwrap();
        std::fs::write(root.join("resets"), past.to_string()).unwrap();
        let (code, body) = post(
            &c,
            format!("{base}/api/chats/{chat}/send"),
            &token,
            serde_json::json!({"text": "scan everything"}),
        )
        .await;
        assert_eq!(code, 202, "{body}");
        let st = until(&c, &base, &token, Duration::from_secs(10), |s| {
            s["busy"] == false && !s["limit_pause"].is_null()
        })
        .await;
        assert_eq!(st["limit_pause"]["chat"], chat.as_str());
        assert_eq!(st["limit_pause"]["resets_at"], past);
        assert_eq!(st["limit_pause"]["window"], "five_hour");
        assert_eq!(st["limit_pause"]["resume_at"], serde_json::Value::Null);
        assert!(
            st["limit_pause"]["text"]
                .as_str()
                .unwrap()
                .starts_with("You've hit your")
        );
        assert_eq!(runs(), 1);
        // Another chat has nothing paused.
        let (code, _) = act(resume.clone(), other.clone()).await;
        assert_eq!(code, 409);

        std::fs::write(root.join("mode"), "reply").unwrap();
        let (code, body) = act(resume.clone(), chat.clone()).await;
        assert_eq!(code, 200, "{body}");
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["note"], "resumed");
        until(&c, &base, &token, Duration::from_secs(10), |s| {
            s["busy"] == false && s["limit_pause"].is_null()
        })
        .await;
        assert_eq!(runs(), 2);
        let log = get(&c, format!("{base}/api/chats/{chat}/transcript"), &token).await;
        assert!(
            texts(&log).contains(&resume_message(&[])),
            "the resume is limit.ts's message: {log}"
        );

        // 2. The limit with the window still exhausted: scheduled for the
        //    reset + 30 s; a second press says so and changes nothing.
        let future = chrono::Utc::now().timestamp() + 3600;
        std::fs::write(root.join("mode"), "limit").unwrap();
        std::fs::write(root.join("resets"), future.to_string()).unwrap();
        post(
            &c,
            format!("{base}/api/chats/{chat}/send"),
            &token,
            serde_json::json!({"text": "again"}),
        )
        .await;
        until(&c, &base, &token, Duration::from_secs(10), |s| {
            s["busy"] == false && s["limit_pause"]["resets_at"] == future
        })
        .await;
        assert_eq!(runs(), 3);
        let (code, body) = act(resume.clone(), chat.clone()).await;
        assert_eq!(code, 200, "{body}");
        assert!(body.contains("scheduled — it goes in 1 h"), "{body}");
        let st = get(&c, format!("{base}/api/state"), &token).await;
        assert_eq!(st["limit_pause"]["resume_at"], future + RESUME_MARGIN_SECS);
        let (code, body) = act(resume.clone(), chat.clone()).await;
        assert_eq!(code, 200, "{body}");
        assert!(body.contains("already scheduled"), "{body}");
        let st = get(&c, format!("{base}/api/state"), &token).await;
        assert_eq!(
            st["limit_pause"]["resume_at"],
            future + RESUME_MARGIN_SECS,
            "never toggled off from the phone"
        );
        assert_eq!(st["busy"], false);
        assert_eq!(runs(), 3, "nothing sent into the exhausted window");

        // 3. His own message in the chat ends that pause (and the waiting
        //    resume); a resumed turn that meets the limit again pauses
        //    again, and nothing runs on its own.
        std::fs::write(root.join("resets"), past.to_string()).unwrap();
        post(
            &c,
            format!("{base}/api/chats/{chat}/send"),
            &token,
            serde_json::json!({"text": "once more"}),
        )
        .await;
        until(&c, &base, &token, Duration::from_secs(10), |s| {
            s["busy"] == false && s["limit_pause"]["resets_at"] == past
        })
        .await;
        let st = get(&c, format!("{base}/api/state"), &token).await;
        assert_eq!(st["limit_pause"]["resume_at"], serde_json::Value::Null);
        assert_eq!(runs(), 4);
        let (code, body) = act(resume.clone(), chat.clone()).await;
        assert_eq!(code, 200, "{body}");
        tokio::time::sleep(Duration::from_millis(300)).await;
        until(&c, &base, &token, Duration::from_secs(10), |s| {
            s["busy"] == false && !s["limit_pause"].is_null()
        })
        .await;
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert_eq!(runs(), 5, "re-paused, not looped");
        let st = get(&c, format!("{base}/api/state"), &token).await;
        assert_eq!(st["limit_pause"]["chat"], chat.as_str());
        assert_eq!(st["limit_pause"]["resume_at"], serde_json::Value::Null);

        // Budget: the Mac's file, under the chat's ask folder. With no
        // ledger there it says so, as the Mac's command does.
        let (code, body) = act(
            serde_json::json!({"op": "budget", "decision": "continue"}),
            chat.clone(),
        )
        .await;
        assert_eq!(code, 409, "{body}");
        assert!(body.contains("no budget ledger"), "{body}");
        let (code, body) = act(
            serde_json::json!({"op": "budget", "decision": "maybe"}),
            chat.clone(),
        )
        .await;
        assert_eq!(code, 409, "{body}");
        // Compact: the Mac's own Claude Code sentence; checkpoint: not yet.
        let (code, body) = act(serde_json::json!({"op": "compact"}), chat.clone()).await;
        assert_eq!(code, 409);
        assert!(body.contains("on the Claude Code engine"), "{body}");
        let (code, body) = act(
            serde_json::json!({"op": "checkpoint", "index": 0}),
            chat.clone(),
        )
        .await;
        assert_eq!(code, 409);
        assert!(body.contains("not on the away server yet"), "{body}");

        server.stop().await;
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_resume_message_is_limit_ts_word_for_word() {
        assert_eq!(
            resume_message(&[]),
            "The last turn was paused by the plan's usage limit and the window has now reset. Continue exactly where it stopped; everything before the limit stands."
        );
        let two = resume_message(&["toolu_a".into(), "toolu_b".into()]);
        assert!(two.contains(" 2 subagents died on the limit (spawned by `toolu_a`, `toolu_b`): resume each with SendMessage"), "{two}");
        let one = resume_message(&["toolu_a".into()]);
        assert!(
            one.contains(" One subagent died on the limit (spawned by `toolu_a`): resume it with"),
            "{one}"
        );
        assert_eq!(wait_words(30), "in under a minute");
        assert_eq!(wait_words(42 * 60), "in 42 min");
        assert_eq!(wait_words(3630), "in 1 h 1 min");
        assert_eq!(wait_words(7200), "in 2 h");
    }

    /// Nightshift on the away server is the one root the environment
    /// names, and only when it detects as one.
    #[tokio::test]
    async fn serve_offers_nightshift_only_from_the_named_root() {
        let root = std::env::temp_dir().join(format!("nightloom-serve-{}", uuid::Uuid::new_v4()));
        let mut cfg = ServeConfig::for_home(&root);
        cfg.nightshift_root = None;
        let none = ServeHost::new(cfg.clone(), Registry::load_from(root.join("projects.json")));
        assert!(none.nightshift_roots().await.is_empty());
        cfg.nightshift_root = Some(root.join("not-a-root"));
        let bad = ServeHost::new(cfg.clone(), Registry::load_from(root.join("projects.json")));
        assert!(bad.nightshift_roots().await.is_empty());
        cfg.nightshift_root = Some(crate::nightshift::testutil::fixture());
        let one = ServeHost::new(cfg, Registry::load_from(root.join("projects.json")));
        let roots = one.nightshift_roots().await;
        assert_eq!(roots.len(), 1);
        assert_eq!(roots[0].id, "away");
        assert_eq!(roots[0].name, "Value generalization");
        let _ = std::fs::remove_dir_all(&root);
    }
}
