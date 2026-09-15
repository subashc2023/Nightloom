//! Nightloom's own tools served over MCP, for the Claude Code engine.
//!
//! The mirror image of `nightloom-mcp`'s client. That crate lets tools that
//! live in another process appear as ordinary [`Tool`]s here; this module
//! lets tools that live *here* appear in another process — specifically in
//! `claude -p`, which owns its own loop and tool set and so cannot be handed
//! a `Vec<Box<dyn Tool>>` the way the API engine's `Chat` is. Passed to the
//! CLI as `--mcp-config`, the four tools below reach the model there as
//! `mcp__nightloom__search_chats` and so on.
//!
//! Four tools, and no more: `search_chats` and `read_chat` (the user's other
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

use crate::capture;
use crate::project::{PROJECTS_DIR, Registry, SESSIONS_DIR};
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
     have no context for), not on every turn; recent chats rank first. To leave something for \
     the user's long-term memory use remember.";

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
pub fn tools_in(config: &Path, project_id: Option<&str>) -> Result<Vec<Box<dyn Tool>>, String> {
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
    Ok(vec![
        Box::new(SearchChats::new(chats.clone())),
        Box::new(ReadChat::new(chats)),
        Box::new(Remember::new(config.to_path_buf(), source)),
        Box::new(FetchPage::default()),
    ])
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
    project_id: Option<String>,
    reader: impl AsyncRead + Send + Unpin + 'static,
    writer: impl AsyncWrite + Send + Unpin + 'static,
) -> Result<(), String> {
    let tools = tools_in(&config, project_id.as_deref())?;
    serve_tools(tools, reader, writer).await;
    Ok(())
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
                "instructions": INSTRUCTIONS,
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
/// `--project=<id>`, and nothing else. Parsed by hand rather than with clap
/// because the desktop binary has no clap and does not want one for a flag
/// that Tauri must never see.
pub fn parse_args(args: &[String]) -> Result<Option<String>, String> {
    let mut project = None;
    let mut it = args.iter();
    while let Some(arg) = it.next() {
        if arg == "--project" {
            let id = it
                .next()
                .ok_or_else(|| "--project needs a project id".to_string())?;
            project = Some(id.clone());
        } else if let Some(id) = arg.strip_prefix("--project=") {
            project = Some(id.to_string());
        } else {
            return Err(format!(
                "unknown argument {arg:?}; the only flag is --project <id>"
            ));
        }
    }
    Ok(project)
}

/// Serve on this process's stdin and stdout until they close, on a runtime
/// of this call's own. What a binary with no runtime of its own — the
/// desktop, whose `main` is Tauri's — calls from the top of `main`; the CLI
/// is already inside one and awaits [`serve`] directly.
pub fn run_blocking(args: &[String]) -> Result<(), String> {
    let project = parse_args(args)?;
    let config = crate::project::config_dir()
        .ok_or_else(|| "no user config directory — there are no chats to serve".to_string())?;
    let runtime = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    runtime.block_on(serve(
        config,
        project,
        tokio::io::stdin(),
        tokio::io::stdout(),
    ))
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
            serve(config, project, sr, sw).await.unwrap();
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
    async fn the_handshake_the_listing_and_the_four_tools_over_a_pipe() {
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
            ["search_chats", "read_chat", "remember", "fetch_page"]
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
        let Err(err) = tools_in(&config, Some("not-a-project")) else {
            panic!("an unknown id built a tool set");
        };
        assert!(err.contains("not-a-project"), "{err}");
    }

    #[test]
    fn the_flag_parses_both_spellings_and_nothing_else() {
        let args = |s: &[&str]| s.iter().map(|a| a.to_string()).collect::<Vec<_>>();
        assert_eq!(parse_args(&[]).unwrap(), None);
        assert_eq!(
            parse_args(&args(&["--project", "abc"])).unwrap().as_deref(),
            Some("abc")
        );
        assert_eq!(
            parse_args(&args(&["--project=abc"])).unwrap().as_deref(),
            Some("abc")
        );
        assert!(parse_args(&args(&["--project"])).is_err());
        assert!(parse_args(&args(&["--verbose"])).is_err());
    }
}
