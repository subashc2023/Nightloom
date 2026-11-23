//! The door as MCP tools: what `mcp-serve --outside` serves to an agent
//! that is not a Nightloom chat (a Claude desktop session, a terminal
//! Claude Code). Four tools — `chat_list`, `chat_show`, `chat_start`,
//! `chat_send` — and nothing else of Nightloom's: the server a Nightloom
//! chat gets is unchanged, so no chat's tool list moves.
//!
//! The two writers are always listed and answer [`super::WRITES_OFF`]
//! while the switch is off, so turning it on needs no reconnect.

use std::path::PathBuf;
use std::time::Duration;

use nightloom_core::ToolDef;
use nightloom_core::tool::{CancellationToken, Effect, Tool};
use serde_json::{Value, json};

use super::client::{self, Waited};
use super::{ChatView, Listing, Request, Sent};

pub const LIST: &str = "chat_list";
pub const SHOW: &str = "chat_show";
pub const START: &str = "chat_start";
pub const SEND: &str = "chat_send";

/// The longest one call waits: under the tool-call limits MCP clients keep.
const MAX_WAIT_SECS: u64 = 600;
/// Who a start is marked with when the server was given no `--as`.
pub const DEFAULT_AS: &str = "an MCP client";

/// What `initialize` says for this server.
pub const INSTRUCTIONS: &str = "Nightloom's chats, from outside the app. chat_list and \
     chat_show read them. chat_start begins a new chat in one of the user's projects and \
     chat_send messages an existing one; both run on the user's Claude plan and work only \
     while Nightloom is running and the user has switched Settings → Outside control to \
     \"Start and message\" — when one is refused, tell the user that sentence rather than \
     retrying. A started chat works on its own: pass wait_seconds to wait for its reply, or \
     call chat_show with wait_seconds later. When the outcome is needs_you, the chat is \
     waiting for the user in Nightloom (a permission, a question, a plan, or the usage \
     limit): say so and stop; do not send again.";

/// The four tools over the home at `config`, starting chats as `by`.
pub fn tools(config: PathBuf, by: Option<String>) -> Vec<Box<dyn Tool>> {
    let by = super::clean_by(by.as_deref().unwrap_or(DEFAULT_AS));
    vec![
        Box::new(ListTool {
            config: config.clone(),
        }),
        Box::new(ShowTool {
            config: config.clone(),
        }),
        Box::new(StartTool {
            config: config.clone(),
            by: by.clone(),
        }),
        Box::new(SendTool { config, by }),
    ]
}

fn text(v: &Value, name: &str) -> Result<String, String> {
    v.get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("{name} is required"))
}

fn wait_secs(v: &Value) -> u64 {
    v.get("wait_seconds")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .min(MAX_WAIT_SECS)
}

fn pretty(v: &Value) -> Result<String, String> {
    serde_json::to_string_pretty(v).map_err(|e| e.to_string())
}

/// A wait's end as the tool's text. A failed wait is the tool's error.
fn waited(chat: &str, w: Waited) -> Result<String, String> {
    let (outcome, v) = match w {
        Waited::Failed(e) => return Err(format!("chat {chat}: {e}")),
        Waited::Replied(v) => ("replied", v),
        Waited::NeedsHim(v) => ("needs_you", v),
        Waited::StillRunning(v) => ("still_running", v),
    };
    pretty(&json!({
        "chat": chat,
        "outcome": outcome,
        "needs": v.line.needs,
        "reply": if outcome == "replied" { v.last_reply().map(|m| m.text.clone()) } else { None },
        "next": match outcome {
            "needs_you" => Some("the user must answer in Nightloom; then chat_show with wait_seconds"),
            "still_running" => Some("call chat_show with wait_seconds again"),
            _ => None,
        },
    }))
}

struct ListTool {
    config: PathBuf,
}

#[async_trait::async_trait]
impl Tool for ListTool {
    fn effect(&self) -> Effect {
        Effect::ReadOnly
    }

    fn def(&self) -> ToolDef {
        ToolDef {
            name: LIST.into(),
            description: "List the user's Nightloom chats, newest first: id, project, title, \
                 when last written, whether it is running or waiting on the user, and who \
                 started it when it was started from outside. project (a name or an id) \
                 keeps one project's chats; limit defaults to 30. Incognito chats are never \
                 listed. The answer also says whether chat_start and chat_send are allowed \
                 now (writes)."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "project": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1 },
                },
            }),
        }
    }

    async fn call(&self, input: Value, _cancel: &CancellationToken) -> Result<String, String> {
        let l: Listing = client::ask_as(
            &self.config,
            &Request::List {
                project: input
                    .get("project")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                limit: input
                    .get("limit")
                    .and_then(Value::as_u64)
                    .map(|n| n as usize),
            },
        )
        .await?;
        pretty(&serde_json::to_value(l).map_err(|e| e.to_string())?)
    }
}

struct ShowTool {
    config: PathBuf,
}

#[async_trait::async_trait]
impl Tool for ShowTool {
    fn effect(&self) -> Effect {
        Effect::ReadOnly
    }

    fn def(&self) -> ToolDef {
        ToolDef {
            name: SHOW.into(),
            description: "Read one Nightloom chat: its state (idle, running, waiting, paused) \
                 and its last messages — the user's and the assistant's text, never tool \
                 output. chat is its id or the first characters of it. last is how many \
                 messages (default 6). With wait_seconds (at most 600) it first waits for the \
                 chat to stop running and answers with outcome: replied (reply holds the \
                 newest reply), needs_you (the chat waits for the user in Nightloom) or \
                 still_running (call again)."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "chat": { "type": "string" },
                    "last": { "type": "integer", "minimum": 1 },
                    "wait_seconds": { "type": "integer", "minimum": 0, "maximum": MAX_WAIT_SECS },
                },
                "required": ["chat"],
            }),
        }
    }

    async fn call(&self, input: Value, _cancel: &CancellationToken) -> Result<String, String> {
        let last = input
            .get("last")
            .and_then(Value::as_u64)
            .map(|n| n as usize);
        let v: ChatView = client::ask_as(
            &self.config,
            &Request::Show {
                chat: text(&input, "chat")?,
                last,
            },
        )
        .await?;
        let secs = wait_secs(&input);
        if secs == 0 {
            return pretty(&serde_json::to_value(v).map_err(|e| e.to_string())?);
        }
        let id = v.line.id.clone();
        waited(
            &id,
            client::wait(&self.config, &id, None, Duration::from_secs(secs), last).await,
        )
    }
}

/// After a start or a send: wait when asked, else say it went.
async fn sent(config: &std::path::Path, sent: Sent, secs: u64) -> Result<String, String> {
    if secs == 0 {
        return pretty(&json!({
            "chat": sent.chat,
            "project": sent.project,
            "outcome": "sent",
            "next": "chat_show with wait_seconds reads the reply",
        }));
    }
    let w = client::wait(
        config,
        &sent.chat,
        Some(sent.replies),
        Duration::from_secs(secs),
        Some(1),
    )
    .await;
    waited(&sent.chat, w)
}

struct StartTool {
    config: PathBuf,
    by: String,
}

#[async_trait::async_trait]
impl Tool for StartTool {
    fn effect(&self) -> Effect {
        Effect::Mutating
    }

    fn def(&self) -> ToolDef {
        ToolDef {
            name: START.into(),
            description: "Start a new Nightloom chat in one of the user's projects, with \
                 prompt as its first message. It runs as a Claude Code chat in that \
                 project's folder, on the user's plan, and appears in Nightloom's sidebar \
                 marked as started from outside. project is the project's name or id \
                 (chat_list shows them). title names the chat (else the prompt's first \
                 line). read_only true holds it to reading: no shell, no file edits. Answers \
                 with the chat's id; with wait_seconds (at most 600) it waits for the reply \
                 as chat_show does. Refused unless the user has allowed it in Nightloom's \
                 Settings → Outside control."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "project": { "type": "string" },
                    "prompt": { "type": "string" },
                    "title": { "type": "string" },
                    "read_only": { "type": "boolean" },
                    "wait_seconds": { "type": "integer", "minimum": 0, "maximum": MAX_WAIT_SECS },
                },
                "required": ["project", "prompt"],
            }),
        }
    }

    async fn call(&self, input: Value, _cancel: &CancellationToken) -> Result<String, String> {
        let s: Sent = client::ask_as(
            &self.config,
            &Request::Start {
                project: text(&input, "project")?,
                text: text(&input, "prompt")?,
                title: input
                    .get("title")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                read_only: input
                    .get("read_only")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                by: self.by.clone(),
            },
        )
        .await?;
        sent(&self.config, s, wait_secs(&input)).await
    }
}

struct SendTool {
    config: PathBuf,
    by: String,
}

#[async_trait::async_trait]
impl Tool for SendTool {
    fn effect(&self) -> Effect {
        Effect::Mutating
    }

    fn def(&self) -> ToolDef {
        ToolDef {
            name: SEND.into(),
            description: "Send message into an existing Nightloom chat (chat: its id or the \
                 first characters of it). A send never interrupts: a chat that is running a \
                 turn refuses it — wait with chat_show first. With wait_seconds (at most \
                 600) it waits for the reply as chat_show does. Refused unless the user has \
                 allowed it in Nightloom's Settings → Outside control."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "chat": { "type": "string" },
                    "message": { "type": "string" },
                    "wait_seconds": { "type": "integer", "minimum": 0, "maximum": MAX_WAIT_SECS },
                },
                "required": ["chat", "message"],
            }),
        }
    }

    async fn call(&self, input: Value, _cancel: &CancellationToken) -> Result<String, String> {
        let s: Sent = client::ask_as(
            &self.config,
            &Request::Send {
                chat: text(&input, "chat")?,
                text: text(&input, "message")?,
                by: self.by.clone(),
            },
        )
        .await?;
        sent(&self.config, s, wait_secs(&input)).await
    }
}
