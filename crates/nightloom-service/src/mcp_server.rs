//! Nightloom's own tools served over MCP, for the Claude Code engine.
//!
//! The mirror image of `nightloom-mcp`'s client. That crate lets tools that
//! live in another process appear as ordinary [`Tool`]s here; this module
//! lets tools that live *here* appear in another process — specifically in
//! `claude -p`, which owns its own loop and tool set and so cannot be handed
//! a `Vec<Box<dyn Tool>>` the way the API engine's `Chat` is. Passed to the
//! CLI as `--mcp-config`, the ~~four~~ five tools below reach the model there
//! as `mcp__nightloom__search_chats` and so on.
//!
//! ~~Four tools, and no more~~ Five tools since 2026-09-16 (`context_status`,
//! below): `search_chats` and `read_chat` (the user's other
//! conversations, which the CLI has no other way into), `remember` (the
//! memory inbox, so an observation made on this engine lands in the same
//! place as one made on the other), and `fetch_page` — the API engine's
//! `web_fetch` under a name that says what it is for. Claude Code's own
//! `WebFetch` runs a page through a summarising model and truncates a long
//! one; asked to reproduce a long post it refused with "content truncated",
//! and the model then worked around it with `curl` and a 30k-token `cat`.
//! Nightloom's fetch returns the extracted text itself, with an `offset` to
//! continue past a cut, which is the tool that job needed.
//!
//! **`context_status` (2026-09-16, nightshift backlog 073).** How full the
//! model's own context window is, from the last turn that completed in this
//! chat: `{used, window, pct, turns}`. The server runs in its own process
//! and has no view of the desktop's state, so the desktop writes the figure
//! to one small file in the config dir at the end of every agent turn
//! ([`write_context_status`], called from `send_agent`) and the tool reads
//! it back. "Last turn" is exact: the turn asking is still running and its
//! own usage is not known until it ends, so the answer is the prefix this
//! turn started from. One file, not one per chat, because one chat runs at
//! a time and the file names its session id for the reader to check.
//!
//! **No approval layer here.** On the API engine every one of these calls
//! goes through [`crate::approval`]; on this engine the CLI's own permission
//! system judges an `mcp__nightloom__*` call like any other tool call, and
//! the user's `~/.claude/settings.json` allowlist is where a standing grant
//! lives. `search_chats` and `read_chat` read the user's own logs on this
//! machine and change nothing; `remember` appends one line to the inbox
//! (`Effect::Session` on the API engine, for the reason `remember.rs`
//! gives); `fetch_page` leaves the machine. A gate of our own in front of a
//! gate of theirs would prompt twice for the same call, or — headless —
//! deny once for it.
//!
//! **A dream's server (2026-09-16, nightshift backlog 070).** Started with
//! `--dream <json>` the server serves **one** tool, `propose_instructions`,
//! and none of the four above: a dream on the Claude Code engine must not
//! be able to read the user's other chats, write to the inbox it is
//! draining, or leave the machine — the same tool set `dream::prepare`
//! gives the API engine's pass, reached the only way the CLI can reach a
//! tool of ours. The JSON names the store the proposal is filed beside, the
//! target it is for and the path of the always-loaded file, and the tool is
//! built by the same `ProposeInstructions::new(..).against(..)` the provider
//! path calls, so the file it writes is the same file by construction.
//! It needs no config dir and reads no registry.
//!
//! The wire is what the client already speaks: newline-delimited JSON-RPC
//! 2.0 over stdio, `initialize` / `tools/list` / `tools/call`. The client's
//! message types are not reused because it has none to reuse — it builds
//! and reads `serde_json::Value`s in place, and so does this. A tool that
//! *ran* and failed comes back as a result with `isError: true` and the
//! tool's message as its text, which is the distinction `client.rs` draws
//! from the other side ("a tool that ran and failed" versus "the server is
//! broken") and the one the protocol draws: the model is meant to read a
//! tool failure and react to it, and a JSON-RPC error is for a request the
//! server could not serve at all. Those are here too — an unknown tool is
//! invalid params, an unknown method is method-not-found — and a line that
//! is not JSON costs a line on stderr, not the session.
//!
//! Every request is answered on its own task, with one writer shared under
//! a mutex, so a `fetch_page` waiting on a slow origin does not hold up a
//! `search_chats` sent beside it. The CLI is free to send several at once,
//! and the cost of serving them in order would be exactly the stall
//! `tools::blocking` exists to avoid.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use nightloom_core::ToolDef;
use nightloom_core::tool::{CancellationToken, Effect, Tool};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

use serde::{Deserialize, Serialize};

use crate::capture;
use crate::project::{PROJECTS_DIR, Registry, SESSIONS_DIR};
use crate::proposal::{ProposalTarget, ProposeInstructions};
use crate::tools::{ChatDir, ChatDirs, Fetch, ReadChat, Remember, SearchChats};

/// The protocol revision this server speaks — the one the client asks for,
/// and the one `http.rs` was verified against.
pub const PROTOCOL_VERSION: &str = "2025-06-18";

/// The name the server is configured under on the CLI's side, and so the
/// middle of every tool's name there: `mcp__nightloom__search_chats`. The
/// `--mcp-config` JSON the desktop hands the CLI has to use this key, or
/// the allowlist line documented for `~/.claude/settings.json` matches
/// nothing.
pub const SERVER_NAME: &str = "nightloom";

/// What the sidebar calls the chats with no project, and what a result
/// line from them says in `all` scope. The same string `connect` uses.
const UNFILED_NAME: &str = "Unfiled chats";

/// Sent back with `initialize` for the host to put in front of the model.
/// The three sentences the engine note carries as well; here because a host
/// that surfaces server instructions gets them even when Nightloom's own
/// prompt layer is switched off for the chat.
const INSTRUCTIONS: &str = "Nightloom's tools. For a whole page use fetch_page, not WebFetch. \
     To find or quote one of the user's other chats use search_chats, then read_chat — when \
     the message points outside this chat (an earlier decision, 'as we discussed', a name you \
     have no context for), not on every turn; recent chats rank first. context_status says \
     how full your context window was when this turn began.";

/// The last sentence of [`INSTRUCTIONS`], present only when the tool is: a
/// server started for an incognito chat (`--no-remember`) must not tell the
/// model to reach for a tool it does not serve.
const REMEMBER_INSTRUCTION: &str =
    " To leave something for the user's long-term memory use remember.";

/// What `initialize` says to a dream: the one tool, and when to call it —
/// the instruction's own rule, restated where a host that surfaces server
/// instructions will put it.
const DREAM_INSTRUCTIONS: &str = "Nightloom's dream server: one tool, propose_instructions, \
     which proposes a full replacement for the always-loaded instruction file of the folder \
     you are consolidating into. Call it at most once, and only when an observation \
     contradicts or extends what that file says; the file itself is not yours to write.";

/// The name the CLI gives one of this server's tools:
/// `mcp__nightloom__propose_instructions`. The spelling `--allowedTools`
/// takes and the model calls by; the CLI's `ToolSearch` resolves nothing
/// shorter.
pub fn mcp_name(tool: &str) -> String {
    format!("mcp__{SERVER_NAME}__{tool}")
}

/// What `initialize` says, for the tool set it is serving.
fn instructions_for(tools: &[Box<dyn Tool>]) -> String {
    if tools.len() == 1 && tools[0].def().name == "propose_instructions" {
        return DREAM_INSTRUCTIONS.to_string();
    }
    let remembers = tools.iter().any(|t| t.def().name == "remember");
    if remembers {
        format!("{INSTRUCTIONS}{REMEMBER_INSTRUCTION}")
    } else {
        INSTRUCTIONS.to_string()
    }
}

/// Build the tool set for one project, or for the unfiled chats when there
/// is none, from the config dir the registry lives under.
///
/// Built from `config` rather than from `Project::session_dir()`, for the
/// reason [`capture::session_dirs`] gives: a job handed its config
/// explicitly reads the registry from it and should find the chats beside
/// that registry. The `ChatDirs` is the one `connect` builds — every
/// project's sessions named as the picker names them, the unfiled ones
/// after, the open project's directory as the default scope — so a search
/// here answers what the same search on the other engine would.
///
/// An id the registry does not know is an error rather than a fall-through
/// to the unfiled chats: the desktop passes the open project's id, and a
/// server quietly searching the wrong chats is the failure that would never
/// be noticed.
///
/// `remember` is left out when `remember` is false — the server for an
/// incognito or ephemeral chat (2026-09-15), which must not be able to
/// write to memory. The two readers and the fetch stay: an incognito chat
/// may read everything; it is other chats that may not read it, and the
/// readers refuse such a chat on their own (`tools/chats.rs`).
pub fn tools_in(
    config: &Path,
    project_id: Option<&str>,
    remember: bool,
) -> Result<Vec<Box<dyn Tool>>, String> {
    let all: Vec<ChatDir> = capture::session_dirs(config)
        .into_iter()
        .map(|d| ChatDir {
            name: d.project.unwrap_or_else(|| UNFILED_NAME.to_string()),
            dir: d.dir,
        })
        .collect();
    let (active, source) = match project_id {
        Some(id) => {
            let registry = Registry::load_in(config);
            let project = registry
                .find(id)
                .ok_or_else(|| format!("no project with id {id:?} in {}", config.display()))?;
            (
                config
                    .join(PROJECTS_DIR)
                    .join(&project.id)
                    .join(SESSIONS_DIR),
                Some(project.name.clone()),
            )
        }
        None => (config.join(capture::UNFILED).join(SESSIONS_DIR), None),
    };
    let chats = ChatDirs { active, all };
    let mut tools: Vec<Box<dyn Tool>> = vec![
        Box::new(SearchChats::new(chats.clone())),
        Box::new(ReadChat::new(chats)),
    ];
    if remember {
        tools.push(Box::new(Remember::new(config.to_path_buf(), source)));
    }
    tools.push(Box::new(FetchPage::default()));
    tools.push(Box::new(ContextStatusTool {
        config: config.to_path_buf(),
    }));
    Ok(tools)
}

// ---- context_status (nightshift backlog 073, 2026-09-16) -------------------

/// The file the desktop writes at the end of every agent turn and the tool
/// reads: in the config dir, beside the registry.
pub const CONTEXT_STATUS_FILE: &str = "context-status.json";

/// What the model can ask about its own window. `used` is the newest
/// round's whole prompt plus its output — the prefix the next request
/// carries, the same figure the top bar's gauge shows — never the turn's
/// running total, which counts the prefix once per round. `window` and
/// `pct` are absent for a model the limits table does not know: a guessed
/// denominator would promise headroom nobody verified.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContextStatus {
    /// Nightloom's chat id, so a reader can tell whose figure this is.
    pub session_id: String,
    pub model: Option<String>,
    pub used: u64,
    pub window: Option<u64>,
    pub pct: Option<u8>,
    /// User messages in the chat so far, the asking turn's included.
    pub turns: u32,
    /// When the turn it describes ended, RFC 3339.
    pub at: String,
}

impl ContextStatus {
    /// Built from what `send_agent` has in hand once a turn is over.
    pub fn new(
        session_id: impl Into<String>,
        model: Option<String>,
        used: u64,
        window: Option<u64>,
        turns: u32,
    ) -> Self {
        let pct = window
            .filter(|w| *w > 0)
            .map(|w| ((used as f64 / w as f64) * 100.0).round().min(100.0) as u8);
        Self {
            session_id: session_id.into(),
            model,
            used,
            window,
            pct,
            turns,
            at: chrono::Utc::now().to_rfc3339(),
        }
    }
}

/// Write the status for the tool to read. Best-effort by design: the
/// desktop calls this after the turn's work is done, and a failure to
/// write a status file must not fail the turn — it is reported, not raised.
pub fn write_context_status(config: &Path, status: &ContextStatus) -> Result<(), String> {
    let text = serde_json::to_string_pretty(status).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(config).map_err(|e| e.to_string())?;
    std::fs::write(config.join(CONTEXT_STATUS_FILE), text).map_err(|e| e.to_string())
}

/// The last written status, or `None` for no file or an unreadable one.
pub fn read_context_status(config: &Path) -> Option<ContextStatus> {
    let text = std::fs::read_to_string(config.join(CONTEXT_STATUS_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

/// The tool. Reads the file on every call rather than at start-up: the
/// server is spawned per turn by the CLI, but nothing about that is
/// promised, and a read is one small file.
struct ContextStatusTool {
    config: PathBuf,
}

#[async_trait::async_trait]
impl Tool for ContextStatusTool {
    fn effect(&self) -> Effect {
        Effect::ReadOnly
    }

    fn def(&self) -> ToolDef {
        ToolDef {
            name: "context_status".into(),
            description: "How full your context window was when this turn began: tokens used \
                 (the whole prompt plus the last reply), the model's window, the percentage, \
                 and how many turns this chat has had. From the last completed turn in this \
                 chat; nothing during the first turn. Use it before a long read or when \
                 deciding whether to wrap up."
                .into(),
            input_schema: json!({ "type": "object", "properties": {} }),
        }
    }

    async fn call(&self, _input: Value, _cancel: &CancellationToken) -> Result<String, String> {
        match read_context_status(&self.config) {
            Some(s) => serde_json::to_string(&s).map_err(|e| e.to_string()),
            None => Err(
                "no turn has completed in this chat yet, so there is no reading — \
                 the first turn's usage is known only when it ends"
                    .into(),
            ),
        }
    }
}

/// `web_fetch` under the name and description this engine needs.
///
/// A wrapper rather than a flag on [`Fetch`], because nothing about the
/// tool changes — only what it is called and the first sentence of what it
/// says about itself, both of which exist to win a choice the API engine
/// never has to make: there, `web_fetch` is the only fetch; here it sits
/// beside the CLI's `WebFetch`, and a model choosing between two fetches by
/// name will take the built-in one unless told why not to.
#[derive(Default)]
struct FetchPage(Fetch);

#[async_trait::async_trait]
impl Tool for FetchPage {
    fn effect(&self) -> Effect {
        self.0.effect()
    }

    fn def(&self) -> ToolDef {
        let inner = self.0.def();
        ToolDef {
            name: "fetch_page".into(),
            description: format!(
                "The whole page, not a summary; use this, not WebFetch, to read an article. {}",
                inner.description
            ),
            input_schema: inner.input_schema,
        }
    }

    async fn call(&self, input: Value, cancel: &CancellationToken) -> Result<String, String> {
        self.0.call(input, cancel).await
    }
}

/// Serve the tools for `project_id` over `reader`/`writer` until the stream
/// ends. The entry point both binaries call with stdin and stdout; tests
/// call it with the two ends of a `tokio::io::duplex`.
pub async fn serve(
    config: PathBuf,
    args: ServeArgs,
    reader: impl AsyncRead + Send + Unpin + 'static,
    writer: impl AsyncWrite + Send + Unpin + 'static,
) -> Result<(), String> {
    let mut tools = match &args.dream {
        Some(dream) => dream_tools(dream),
        None => tools_in(&config, args.project.as_deref(), args.remember)?,
    };
    if args.ask {
        tools.push(Box::new(crate::agent::ask::PromptTool));
    }
    serve_tools(tools, reader, writer).await;
    Ok(())
}

/// What a server is started with, from either binary's argument parsing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServeArgs {
    /// The open project's id, or none for the unfiled chats.
    pub project: Option<String>,
    /// Whether `remember` is served. Off for an incognito or ephemeral
    /// chat, which is the `--no-remember` flag.
    pub remember: bool,
    /// A dream's server (`--dream <json>`, 2026-09-16): `propose_instructions`
    /// alone. `project` is not consulted and `remember` is `false`, which
    /// is also the truth — the inbox is what the dream is draining.
    pub dream: Option<DreamServe>,
    /// Serve `ask`, the permission host a chat in the Ask position names
    /// with `--permission-prompt-tool` (`--ask`, 2026-09-16, nightshift
    /// backlog 084; `agent::ask::PromptTool` says what it does and why it
    /// refuses). Off otherwise: a tool that only refuses has no business
    /// in a chat that is not asking.
    pub ask: bool,
}

impl ServeArgs {
    pub fn for_project(project: Option<String>) -> Self {
        Self {
            project,
            remember: true,
            dream: None,
            ask: false,
        }
    }

    pub fn for_dream(dream: DreamServe) -> Self {
        Self {
            project: None,
            remember: false,
            dream: Some(dream),
            ask: false,
        }
    }
}

/// What a dream's server is told on the command line, as the JSON after
/// `--dream`: enough to build the one tool, and nothing that names the
/// user's chats. The always-loaded file is passed as a *path* and read
/// here under the preamble's cap (`prompt::read_capped`) rather than as
/// its text, because the text is what the tool's guard compares against
/// and it may be 32 KiB — too much for one argument and pointless to copy
/// when both processes can read the file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DreamServe {
    /// Where the proposal is filed: the project's store, or the config dir
    /// for the user's file (`ProposalTarget::store_in`).
    pub store: PathBuf,
    pub target: ProposalTarget,
    /// The target's `AGENTS.md` — read for the guard, never written.
    pub instructions: PathBuf,
}

impl DreamServe {
    /// The argument as it goes after `--dream`. One line of JSON; the
    /// desktop puts it inside the `--mcp-config` JSON, escaped once more.
    pub fn to_arg(&self) -> String {
        serde_json::to_string(self).expect("three plain fields serialize")
    }

    pub fn parse(json: &str) -> Result<Self, String> {
        serde_json::from_str(json).map_err(|e| format!("--dream is not a dream target: {e}"))
    }
}

/// The dream's tool set: `propose_instructions` and nothing else, built the
/// way `dream::prepare` builds it — same constructor, same guard against
/// the file's current text — so what a dream on this engine can propose,
/// and where the proposal lands, is what the other engine's dream can and
/// does. The slot the constructor returns is dropped: the pass in the other
/// process reads "did it propose" off the store instead.
pub fn dream_tools(dream: &DreamServe) -> Vec<Box<dyn Tool>> {
    let current = crate::prompt::read_capped(&dream.instructions);
    let (propose, _slot) = ProposeInstructions::new(dream.store.clone(), dream.target.clone());
    vec![Box::new(propose.against(current.as_deref()))]
}

/// The write half of the stream, shared by every request's task. The mutex
/// is what keeps two replies from interleaving halves of two lines — the
/// same shape as the client's `SharedWriter`, for the same reason.
type SharedWriter = Arc<tokio::sync::Mutex<Box<dyn AsyncWrite + Send + Unpin>>>;

/// Serve an explicit tool set. Returns when the reader reaches EOF, which
/// is how the CLI ends a session: it closes the server's stdin and waits.
pub async fn serve_tools(
    tools: Vec<Box<dyn Tool>>,
    reader: impl AsyncRead + Send + Unpin + 'static,
    writer: impl AsyncWrite + Send + Unpin + 'static,
) {
    let tools: Arc<Vec<Box<dyn Tool>>> = Arc::new(tools);
    let writer: SharedWriter = Arc::new(tokio::sync::Mutex::new(Box::new(writer)));
    // One token for the life of the server, never cancelled: the CLI ends a
    // call it no longer wants by ending the process, and every tool here
    // either finishes in milliseconds or bounds itself (the fetch's 30s).
    let cancel = CancellationToken::new();
    let mut lines = BufReader::new(reader).lines();
    let mut in_flight = tokio::task::JoinSet::new();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let msg: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                // The client's rule from the other side: a line we cannot
                // parse is the peer's problem, not a reason to end the
                // session. Said on stderr, which the CLI keeps for a server
                // that misbehaves, and nowhere else — a reply with a null id
                // is a message nobody is waiting for.
                eprintln!("nightloom mcp-serve: ignoring a line that is not JSON: {e}");
                continue;
            }
        };
        let Some(method) = msg.get("method").and_then(Value::as_str) else {
            // A reply to a request we never made. This server makes none.
            continue;
        };
        let id = msg.get("id").filter(|v| !v.is_null()).cloned();
        let params = msg.get("params").cloned().unwrap_or(Value::Null);
        let Some(id) = id else {
            // A notification is owed nothing. `notifications/initialized`
            // is the one that always arrives; anything else the client may
            // send (`cancelled`, `progress`) is likewise ignored.
            continue;
        };
        let method = method.to_string();
        let tools = Arc::clone(&tools);
        let writer = Arc::clone(&writer);
        let cancel = cancel.clone();
        in_flight.spawn(async move {
            let reply = match handle(&tools, &method, params, &cancel).await {
                Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                Err((code, message)) => json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": code, "message": message },
                }),
            };
            write_line(&writer, &reply).await;
        });
        // Finished tasks are reaped as we go, so a long session does not
        // accumulate a handle per call.
        while in_flight.try_join_next().is_some() {}
    }
    // EOF: the client is done. Whatever is still running is allowed to
    // finish and answer — a reply to a closed pipe costs nothing — rather
    // than dropped mid-write.
    while in_flight.join_next().await.is_some() {}
}

/// Answer one request. `Err` is a JSON-RPC error: something the server
/// could not serve at all, as distinct from a tool that ran and failed.
async fn handle(
    tools: &[Box<dyn Tool>],
    method: &str,
    params: Value,
    cancel: &CancellationToken,
) -> Result<Value, (i64, String)> {
    match method {
        "initialize" => {
            // Answered with the client's own revision when it named one. The
            // methods this server implements have been the same across every
            // revision — the argument `client.rs` makes for accepting
            // whatever a server chose — and a host that sees a version it
            // did not ask for may disconnect, which is a worse outcome than
            // agreeing to a revision whose only relevant parts are these.
            let version = params["protocolVersion"]
                .as_str()
                .unwrap_or(PROTOCOL_VERSION);
            Ok(json!({
                "protocolVersion": version,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
                "instructions": instructions_for(tools),
            }))
        }
        // Answerable by every peer regardless of capabilities, and a host
        // using it as a keepalive concludes from silence that we are gone.
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({
            "tools": tools.iter().map(|t| {
                let d = t.def();
                json!({
                    "name": d.name,
                    "description": d.description,
                    "inputSchema": d.input_schema,
                })
            }).collect::<Vec<_>>()
        })),
        "tools/call" => {
            let name = params["name"]
                .as_str()
                .ok_or_else(|| (-32602, "tools/call needs a tool name".to_string()))?;
            let tool = tools
                .iter()
                .find(|t| t.def().name == name)
                .ok_or_else(|| (-32602, format!("unknown tool: {name}")))?;
            let arguments = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            let (text, is_error) = match tool.call(arguments, cancel).await {
                Ok(text) => (text, false),
                Err(message) => (message, true),
            };
            Ok(json!({
                "content": [{ "type": "text", "text": text }],
                "isError": is_error,
            }))
        }
        other => Err((-32601, format!("method not found: {other}"))),
    }
}

async fn write_line(writer: &SharedWriter, value: &Value) {
    let Ok(mut line) = serde_json::to_string(value) else {
        return;
    };
    line.push('\n');
    let mut w = writer.lock().await;
    // A write that fails means the pipe is going, and the read loop's own
    // EOF is what ends the server; there is nobody left to tell.
    let _ = w.write_all(line.as_bytes()).await;
    let _ = w.flush().await;
}

/// The arguments after `mcp-serve` / `--mcp-serve`: `--project <id>` or
/// `--project=<id>`, `--no-remember` (2026-09-15), `--dream <json>` or
/// `--dream=<json>` (2026-09-16), and nothing else. Parsed by hand rather
/// than with clap because the desktop binary has no clap and does not want
/// one for a flag that Tauri must never see.
pub fn parse_args(args: &[String]) -> Result<ServeArgs, String> {
    let mut out = ServeArgs::for_project(None);
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        if arg == "--project" {
            let id = it
                .next()
                .ok_or_else(|| "--project needs a project id".to_string())?;
            out.project = Some(id.clone());
        } else if let Some(id) = arg.strip_prefix("--project=") {
            out.project = Some(id.to_string());
        } else if arg == "--no-remember" {
            out.remember = false;
        } else if arg == "--ask" {
            out.ask = true;
        } else if arg == "--dream" {
            let json = it
                .next()
                .ok_or_else(|| "--dream needs a dream target".to_string())?;
            out.dream = Some(DreamServe::parse(json)?);
            out.remember = false;
        } else if let Some(json) = arg.strip_prefix("--dream=") {
            out.dream = Some(DreamServe::parse(json)?);
            out.remember = false;
        } else {
            return Err(format!(
                "unknown argument {arg:?}; the flags are --project <id>, --no-remember, --ask and --dream <json>"
            ));
        }
    }
    Ok(out)
}

/// Serve on this process's stdin and stdout until they close, on a runtime
/// of this call's own. What a binary with no runtime of its own — the
/// desktop, whose `main` is Tauri's — calls from the top of `main`; the CLI
/// is already inside one and awaits [`serve`] directly.
///
/// A dream's server needs no config dir: everything it serves is named in
/// its argument, and a dream over a test home must not read the real one.
pub fn run_blocking(args: &[String]) -> Result<(), String> {
    let args = parse_args(args)?;
    let config = match crate::project::config_dir() {
        Some(config) => config,
        None if args.dream.is_some() => PathBuf::new(),
        None => return Err("no user config directory — there are no chats to serve".to_string()),
    };
    let runtime = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    runtime.block_on(serve(config, args, tokio::io::stdin(), tokio::io::stdout()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::observe;
    use nightloom_core::{ContentBlock, Session, Usage};
    use std::fs;

    /// A config dir with one registered project that has one logged chat.
    /// Returns the config dir and the project's id.
    fn fixture(name: &str) -> (PathBuf, String) {
        let config = crate::tools::test_dir(&format!("mcp-server-{name}"));
        let workspace = config.join("ws");
        fs::create_dir_all(&workspace).unwrap();
        let project = Registry::load_in(&config)
            .create("Lanternfish", Some(workspace), None)
            .unwrap();
        let sessions = config
            .join(PROJECTS_DIR)
            .join(&project.id)
            .join(SESSIONS_DIR);
        let mut s = Session::with_log(&sessions).unwrap();
        s.record_user("how do I rewind a session?");
        s.record_assistant(
            "test-model",
            vec![ContentBlock::Text {
                text: "A rewind is a marker that supersedes.".into(),
            }],
            Some("end_turn".into()),
            Usage::default(),
        );
        s.record_title("Rewinding");
        (config, project.id)
    }

    /// The server on one end of a pipe, and the client's read and write
    /// halves on the other.
    fn start(
        config: PathBuf,
        project: Option<String>,
    ) -> (
        tokio::io::ReadHalf<tokio::io::DuplexStream>,
        tokio::io::WriteHalf<tokio::io::DuplexStream>,
    ) {
        let (client_side, server_side) = tokio::io::duplex(1 << 16);
        let (sr, sw) = tokio::io::split(server_side);
        tokio::spawn(async move {
            serve(config, ServeArgs::for_project(project), sr, sw)
                .await
                .unwrap();
        });
        tokio::io::split(client_side)
    }

    async fn send(w: &mut (impl AsyncWrite + Unpin), line: &str) {
        w.write_all(line.as_bytes()).await.unwrap();
        w.write_all(b"\n").await.unwrap();
        w.flush().await.unwrap();
    }

    async fn recv(lines: &mut tokio::io::Lines<BufReader<impl AsyncRead + Unpin>>) -> Value {
        let line = tokio::time::timeout(std::time::Duration::from_secs(10), lines.next_line())
            .await
            .expect("a reply within ten seconds")
            .unwrap()
            .expect("a reply before EOF");
        serde_json::from_str(&line).unwrap()
    }

    #[tokio::test]
    async fn the_handshake_the_listing_and_the_five_tools_over_a_pipe() {
        let (config, id) = fixture("session");
        let (r, mut w) = start(config.clone(), Some(id));
        let mut lines = BufReader::new(r).lines();

        send(
            &mut w,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}"#,
        )
        .await;
        let init = recv(&mut lines).await;
        assert_eq!(init["id"], 1);
        assert_eq!(init["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(init["result"]["serverInfo"]["name"], SERVER_NAME);
        assert!(init["result"]["capabilities"]["tools"].is_object());

        // Owed nothing, and gets nothing: the next reply is to the next
        // request, not a complaint about this.
        send(
            &mut w,
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
        )
        .await;

        send(&mut w, r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#).await;
        let list = recv(&mut lines).await;
        assert_eq!(list["id"], 2);
        let names: Vec<&str> = list["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            [
                "search_chats",
                "read_chat",
                "remember",
                "fetch_page",
                "context_status"
            ]
        );
        // The MCP spelling, not the trait's: a host reads `inputSchema`.
        assert!(list["result"]["tools"][0]["inputSchema"]["properties"]["query"].is_object());
        assert!(
            list["result"]["tools"][3]["description"]
                .as_str()
                .unwrap()
                .contains("not WebFetch"),
            "fetch_page says which fetch to use"
        );

        send(
            &mut w,
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_chats","arguments":{"query":"rewind"}}}"#,
        )
        .await;
        let hit = recv(&mut lines).await;
        assert_eq!(hit["id"], 3);
        assert_eq!(hit["result"]["isError"], false);
        let text = hit["result"]["content"][0]["text"].as_str().unwrap();
        assert!(
            text.contains("Rewinding"),
            "the logged chat is found: {text}"
        );
        assert!(
            text.contains("the chats of Lanternfish"),
            "the project's directory is the default scope: {text}"
        );

        send(
            &mut w,
            r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"remember","arguments":{"text":"The user prefers rewinds to edits.","kind":"user_stated"}}}"#,
        )
        .await;
        let remembered = recv(&mut lines).await;
        assert_eq!(remembered["result"]["isError"], false);
        let backlog = observe::backlog_in(&config);
        assert_eq!(backlog.pending.len(), 1);
        assert_eq!(
            backlog.pending[0].obs.source.as_deref(),
            Some("Lanternfish"),
            "an observation from a project is filed under its name"
        );

        // A tool that ran and failed: a result the model reads, not a
        // protocol error.
        send(
            &mut w,
            r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"read_chat","arguments":{"session":"zzzzzzzz"}}}"#,
        )
        .await;
        let failed = recv(&mut lines).await;
        assert_eq!(failed["result"]["isError"], true);
        assert!(
            failed["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .contains("zzzzzzzz")
        );

        send(
            &mut w,
            r#"{"jsonrpc":"2.0","id":6,"method":"resources/list"}"#,
        )
        .await;
        let unknown = recv(&mut lines).await;
        assert_eq!(unknown["id"], 6);
        assert_eq!(unknown["error"]["code"], -32601);

        send(
            &mut w,
            r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"no_such_tool"}}"#,
        )
        .await;
        let no_tool = recv(&mut lines).await;
        assert_eq!(no_tool["error"]["code"], -32602);

        // Not JSON, and the server is still there to answer the next line.
        send(&mut w, "this is not a request").await;
        send(&mut w, r#"{"jsonrpc":"2.0","id":8,"method":"ping"}"#).await;
        let pong = recv(&mut lines).await;
        assert_eq!(pong["id"], 8);
        assert!(pong["result"].is_object());
    }

    #[tokio::test]
    async fn no_project_means_the_unfiled_chats_and_an_unfiled_source() {
        let (config, _) = fixture("unfiled");
        let (r, mut w) = start(config.clone(), None);
        let mut lines = BufReader::new(r).lines();
        send(
            &mut w,
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"remember","arguments":{"text":"Something said with no project open.","kind":"inferred"}}}"#,
        )
        .await;
        let reply = recv(&mut lines).await;
        assert_eq!(reply["result"]["isError"], false);
        let backlog = observe::backlog_in(&config);
        assert_eq!(backlog.pending[0].obs.source, None);
    }

    #[test]
    fn an_unknown_project_id_is_refused_rather_than_served_from_the_wrong_chats() {
        let (config, _) = fixture("unknown-id");
        let Err(err) = tools_in(&config, Some("not-a-project"), true) else {
            panic!("an unknown id built a tool set");
        };
        assert!(err.contains("not-a-project"), "{err}");
    }

    #[test]
    fn the_flag_parses_both_spellings_and_nothing_else() {
        let args = |s: &[&str]| s.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        assert_eq!(parse_args(&[]).unwrap(), ServeArgs::for_project(None));
        assert_eq!(
            parse_args(&args(&["--project", "abc"]))
                .unwrap()
                .project
                .as_deref(),
            Some("abc")
        );
        assert_eq!(
            parse_args(&args(&["--project=abc"]))
                .unwrap()
                .project
                .as_deref(),
            Some("abc")
        );
        assert!(parse_args(&args(&["--project"])).is_err());
        assert!(parse_args(&args(&["--verbose"])).is_err());
        let parsed = parse_args(&args(&["--project", "abc", "--no-remember"])).unwrap();
        assert_eq!(parsed.project.as_deref(), Some("abc"));
        assert!(!parsed.remember);
        assert!(
            parse_args(&args(&["--no-remember"]))
                .unwrap()
                .project
                .is_none()
        );
    }

    /// `--no-remember` is a server with three tools and instructions that
    /// never name the fourth; the default server keeps all four and the
    /// sentence. The readers stay either way — an incognito chat may read
    /// other chats; it is other chats that may not read it.
    #[test]
    fn no_remember_drops_the_tool_and_the_sentence_about_it() {
        let (config, id) = fixture("no-remember");
        let names = |remember: bool| {
            tools_in(&config, Some(&id), remember)
                .unwrap()
                .iter()
                .map(|t| t.def().name)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            names(true),
            [
                "search_chats",
                "read_chat",
                "remember",
                "fetch_page",
                "context_status"
            ]
        );
        assert_eq!(
            names(false),
            ["search_chats", "read_chat", "fetch_page", "context_status"]
        );
        let with = instructions_for(&tools_in(&config, Some(&id), true).unwrap());
        let without = instructions_for(&tools_in(&config, Some(&id), false).unwrap());
        assert!(with.contains("use remember"), "{with}");
        assert!(!without.contains("remember"), "{without}");
        assert!(without.contains("search_chats"));
    }

    fn dream_target(config: &Path) -> DreamServe {
        DreamServe {
            store: config.to_path_buf(),
            target: ProposalTarget::User,
            instructions: config.join(crate::prompt::INSTRUCTION_FILE),
        }
    }

    /// The flag parses both spellings into the same target, refuses a
    /// value that is not one, and still needs a value.
    #[test]
    fn the_dream_flag_parses_both_spellings_into_the_same_target() {
        let target = dream_target(Path::new("/cfg"));
        let arg = target.to_arg();
        let args = |s: &[&str]| s.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        let spaced = parse_args(&args(&["--dream", &arg])).unwrap();
        let joined = parse_args(&args(&[&format!("--dream={arg}")])).unwrap();
        assert_eq!(spaced, joined);
        assert_eq!(spaced.dream.as_ref(), Some(&target));
        assert_eq!(spaced, ServeArgs::for_dream(target));
        assert!(parse_args(&args(&["--dream"])).is_err());
        assert!(parse_args(&args(&["--dream", "not json"])).is_err());
        assert_eq!(
            mcp_name("propose_instructions"),
            "mcp__nightloom__propose_instructions"
        );
    }

    /// A dream's server lists exactly one tool — not the chats, not the
    /// inbox, not the fetch — says so in its instructions, and the
    /// proposal it writes through `tools/call` is the file the provider
    /// path's tool writes: same store, same target, same fields, same
    /// guard against the file's current text.
    #[tokio::test]
    async fn a_dream_server_serves_propose_instructions_alone_and_writes_the_same_file() {
        let config = crate::tools::test_dir("mcp-server-dream");
        fs::write(
            config.join(crate::prompt::INSTRUCTION_FILE),
            "# Me\n\nBe terse.\n",
        )
        .unwrap();
        let dream = dream_target(&config);

        let names: Vec<String> = dream_tools(&dream).iter().map(|t| t.def().name).collect();
        assert_eq!(names, ["propose_instructions"]);
        let said = instructions_for(&dream_tools(&dream));
        assert!(said.contains("propose_instructions"), "{said}");
        for absent in [
            "search_chats",
            "read_chat",
            "remember",
            "fetch_page",
            "context_status",
        ] {
            assert!(!said.contains(absent), "{absent} in {said}");
        }

        let (client_side, server_side) = tokio::io::duplex(1 << 16);
        let (sr, sw) = tokio::io::split(server_side);
        let args = ServeArgs::for_dream(dream.clone());
        // A config dir that does not exist: a dream's server must not need one.
        let no_config = config.join("no-such-config");
        tokio::spawn(async move {
            serve(no_config, args, sr, sw).await.unwrap();
        });
        let (r, mut w) = tokio::io::split(client_side);
        let mut lines = BufReader::new(r).lines();

        send(
            &mut w,
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}"#,
        )
        .await;
        let init = recv(&mut lines).await;
        assert_eq!(init["result"]["instructions"], DREAM_INSTRUCTIONS);

        send(&mut w, r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#).await;
        let list = recv(&mut lines).await;
        let listed = list["result"]["tools"].as_array().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0]["name"], "propose_instructions");
        assert!(listed[0]["inputSchema"]["properties"]["text"].is_object());

        // The other four are unknown here, not merely hidden.
        send(
            &mut w,
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"remember","arguments":{"text":"x","kind":"inferred"}}}"#,
        )
        .await;
        let refused = recv(&mut lines).await;
        assert_eq!(refused["error"]["code"], -32602);
        assert!(observe::backlog_in(&config).pending.is_empty());

        // Through the wire.
        send(
            &mut w,
            r##"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"propose_instructions","arguments":{"text":"# Me\n\nBe expansive.\n","why":"Observation 1."}}}"##,
        )
        .await;
        let proposed = recv(&mut lines).await;
        assert_eq!(proposed["result"]["isError"], false, "{proposed}");
        let over_wire = crate::proposal::list_in(&config);
        assert_eq!(over_wire.len(), 1);

        // The same call on the provider path's tool, in process. Proposal
        // files are named by a millisecond stamp, and on CI's Linux runner
        // the two calls landed in the same millisecond, so the second
        // overwrote the first and the count below read 1 (every push since
        // 09-14). A turn never proposes twice in a millisecond; the test can.
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        let (direct, _slot) = ProposeInstructions::new(dream.store.clone(), dream.target.clone());
        let direct = direct.against(Some("# Me\n\nBe terse.\n"));
        direct
            .call(
                json!({ "text": "# Me\n\nBe expansive.\n", "why": "Observation 1." }),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        let both = crate::proposal::list_in(&config);
        assert_eq!(both.len(), 2);
        let (a, b) = (&both[0].proposal, &both[1].proposal);
        // Everything but the stamp.
        assert_eq!(
            (a.v, &a.target, &a.why, &a.text, a.from_dream),
            (b.v, &b.target, &b.why, &b.text, b.from_dream)
        );
        assert!(a.held.is_none() && b.held.is_none());
        // The file the proposal is for was read for the guard, not written.
        assert_eq!(
            fs::read(config.join(crate::prompt::INSTRUCTION_FILE)).unwrap(),
            b"# Me\n\nBe terse.\n"
        );

        // And the guard holds over the wire too: a biographical section the
        // file does not have is held, not offered.
        send(
            &mut w,
            r##"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"propose_instructions","arguments":{"text":"# Me\n\n**Personal context**\n\nLifts.\n","why":"no"}}}"##,
        )
        .await;
        let held = recv(&mut lines).await;
        assert_eq!(held["result"]["isError"], false);
        assert!(
            held["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .starts_with("Not proposed"),
        );
        assert_eq!(crate::proposal::list_in(&config).len(), 2);
    }

    /// Not a test: the dream's server, for [`crate::dream`]'s end-to-end
    /// test. That test stands in a shell script for `claude`, and the
    /// script needs a real server process to call `propose_instructions`
    /// on — this crate builds no binary, so the test binary is it. Run
    /// under `cargo test` with nothing set, this passes and does nothing;
    /// run as `<test exe> --exact mcp_server::tests::dream_server_entry
    /// --nocapture` with `NIGHTLOOM_TEST_DREAM` holding the `--dream` JSON,
    /// it serves that dream on stdin/stdout until EOF, the way
    /// `run_blocking` would. The harness's own lines on stdout are the
    /// fake's problem, and the fake reads none of them.
    #[test]
    fn dream_server_entry() {
        let Ok(json) = std::env::var("NIGHTLOOM_TEST_DREAM") else {
            return;
        };
        run_blocking(&["--dream".to_string(), json]).unwrap();
    }

    /// `context_status` (nightshift backlog 073): nothing before a turn has
    /// completed — a tool error the model can read, not a server error —
    /// then exactly what the desktop wrote, with the percentage rounded
    /// against the window and absent when the window is unknown.
    #[tokio::test]
    async fn context_status_reads_what_the_desktop_wrote() {
        let (config, id) = fixture("context-status");
        let tools = tools_in(&config, Some(&id), true).unwrap();
        let tool = tools
            .iter()
            .find(|t| t.def().name == "context_status")
            .expect("the tool is served");
        assert_eq!(tool.effect(), Effect::ReadOnly);
        let cancel = CancellationToken::new();

        let err = tool.call(json!({}), &cancel).await.unwrap_err();
        assert!(err.contains("no turn has completed"), "{err}");

        let status = ContextStatus::new(
            "s-1",
            Some("claude-opus-5".into()),
            61_000,
            Some(200_000),
            4,
        );
        assert_eq!(status.pct, Some(31));
        write_context_status(&config, &status).unwrap();
        let text = tool.call(json!({}), &cancel).await.unwrap();
        let back: ContextStatus = serde_json::from_str(&text).unwrap();
        assert_eq!(back, status);
        assert_eq!(read_context_status(&config), Some(status));

        let unknown = ContextStatus::new("s-1", None, 5_000, None, 1);
        assert_eq!(unknown.pct, None);
        write_context_status(&config, &unknown).unwrap();
        let back: ContextStatus =
            serde_json::from_str(&tool.call(json!({}), &cancel).await.unwrap()).unwrap();
        assert_eq!(back.window, None);
        assert_eq!(back.used, 5_000);
        assert_eq!(back.turns, 1);
    }
}
