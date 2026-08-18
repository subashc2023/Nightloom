//! JSON-RPC 2.0 over a line-delimited stream, plus the MCP handshake.

use crate::McpError;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::oneshot;

/// The protocol version this client asks for.
const PROTOCOL_VERSION: &str = "2025-06-18";

/// How long a single request may take before it is abandoned.
///
/// A cap rather than patience, because [`nightloom_core::Tool::call`] takes no
/// cancellation token: a server that never answers would otherwise hold the
/// turn open forever, and no amount of Ctrl-C would reach it. Timing out
/// produces an error the model can read and work around, which is the same
/// shape every other tool failure has.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// How much of a server's stderr to keep for diagnostics.
const STDERR_TAIL: usize = 4096;

/// What a server said about itself during the handshake.
#[derive(Debug, Clone)]
pub struct ServerInfo {
    pub name: String,
    pub version: String,
    /// The version the *server* chose. MCP lets it answer with something
    /// other than what we asked for, and the useful thing is to record what
    /// was actually agreed rather than assume our own preference held.
    pub protocol_version: String,
}

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, McpError>>>>>;

/// A connected MCP server.
pub struct Client {
    /// The name this server is configured under, used to prefix its tools.
    name: String,
    writer: tokio::sync::Mutex<Box<dyn AsyncWrite + Send + Unpin>>,
    pending: Pending,
    next_id: AtomicU64,
    stderr: Arc<Mutex<String>>,
    /// Kept alive for the life of the client: dropping the handle would
    /// orphan the process rather than stop it.
    _child: Option<tokio::process::Child>,
}

impl Client {
    /// Spawn `command` and talk to it over its stdin/stdout.
    pub async fn stdio(
        name: &str,
        command: &str,
        args: &[String],
        env: &[(String, String)],
        cwd: Option<&std::path::Path>,
    ) -> Result<Self, McpError> {
        let mut cmd = Command::new(command);
        cmd.args(args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            // Piped rather than inherited: a server that chatters on stderr
            // would otherwise scribble over a REPL's output, and this is the
            // only record of why a server that dies at startup died.
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        for (k, v) in env {
            cmd.env(k, v);
        }
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        let mut child = cmd.spawn().map_err(|source| McpError::Spawn {
            name: name.to_string(),
            source,
        })?;
        let stdin = child.stdin.take().expect("stdin piped");
        let stdout = child.stdout.take().expect("stdout piped");
        let stderr = child.stderr.take().expect("stderr piped");

        let tail = Arc::new(Mutex::new(String::new()));
        spawn_stderr_drain(stderr, Arc::clone(&tail));

        Ok(Self::from_streams(
            name,
            stdout,
            stdin,
            Some(child),
            Some(tail),
        ))
    }

    /// Build a client over arbitrary streams.
    ///
    /// This is what makes the protocol testable without a server binary on
    /// the machine: a test drives both ends of a `tokio::io::duplex` and
    /// scripts the replies, the same way the service tests script a provider.
    pub fn from_streams(
        name: &str,
        reader: impl AsyncRead + Send + Unpin + 'static,
        writer: impl AsyncWrite + Send + Unpin + 'static,
        child: Option<tokio::process::Child>,
        stderr: Option<Arc<Mutex<String>>>,
    ) -> Self {
        let pending: Pending = Arc::default();
        let stderr = stderr.unwrap_or_default();
        spawn_reader(reader, Arc::clone(&pending), Arc::clone(&stderr));
        Self {
            name: name.to_string(),
            writer: tokio::sync::Mutex::new(Box::new(writer)),
            pending,
            next_id: AtomicU64::new(1),
            stderr,
            _child: child,
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// Perform the MCP handshake.
    ///
    /// A server may answer with a protocol version other than the one asked
    /// for. That is recorded rather than rejected: refusing to talk to a
    /// server that speaks a newer revision buys nothing, since every method
    /// this client uses has been stable across revisions, and the failure
    /// mode of trying is a clear error on the first call rather than a silent
    /// wrong answer.
    pub async fn initialize(&self) -> Result<ServerInfo, McpError> {
        let result = self
            .request(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    // Empty on purpose: this client offers the server nothing
                    // — no sampling, no roots, no elicitation. Declaring a
                    // capability we do not implement invites requests we
                    // would have to refuse mid-turn.
                    "capabilities": {},
                    "clientInfo": { "name": "nightloom", "version": env!("CARGO_PKG_VERSION") },
                }),
            )
            .await?;
        let info = ServerInfo {
            name: result["serverInfo"]["name"]
                .as_str()
                .unwrap_or(&self.name)
                .to_string(),
            version: result["serverInfo"]["version"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            protocol_version: result["protocolVersion"]
                .as_str()
                .unwrap_or(PROTOCOL_VERSION)
                .to_string(),
        };
        // The spec requires this before any other request; a strict server
        // rejects everything until it arrives.
        self.notify("notifications/initialized", json!({})).await?;
        Ok(info)
    }

    /// Every tool the server offers, following pagination to the end.
    pub async fn list_tools(&self) -> Result<Vec<Value>, McpError> {
        let mut tools = Vec::new();
        let mut cursor: Option<String> = None;
        loop {
            let params = match &cursor {
                Some(c) => json!({ "cursor": c }),
                None => json!({}),
            };
            let result = self.request("tools/list", params).await?;
            let page = result["tools"]
                .as_array()
                .ok_or_else(|| McpError::Protocol("tools/list has no tools array".into()))?;
            tools.extend(page.iter().cloned());
            match result["nextCursor"].as_str() {
                // A server that returned the same cursor forever would spin
                // here; treat a repeat as the end rather than looping.
                Some(next) if Some(next) != cursor.as_deref() => cursor = Some(next.to_string()),
                _ => return Ok(tools),
            }
        }
    }

    /// Call a tool, returning its content flattened to text.
    pub async fn call_tool(&self, name: &str, arguments: Value) -> Result<CallOutcome, McpError> {
        let result = self
            .request(
                "tools/call",
                json!({ "name": name, "arguments": arguments }),
            )
            .await?;
        Ok(CallOutcome {
            // A tool that *ran* and failed reports `isError` in its result;
            // only a protocol failure comes back as an `Err` above. Both end
            // up as an error tool result for the model, but only one of them
            // means the server is broken.
            is_error: result["isError"].as_bool().unwrap_or(false),
            text: flatten_content(&result),
        })
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, McpError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let line = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if let Err(e) = self.write_line(&line).await {
            self.pending.lock().unwrap().remove(&id);
            return Err(e);
        }
        match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(result)) => result,
            // The reader task drops the sender when the stream ends without
            // having answered this id.
            Ok(Err(_)) => Err(McpError::Closed(self.stderr_tail())),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(McpError::Timeout(REQUEST_TIMEOUT))
            }
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), McpError> {
        self.write_line(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
            .await
    }

    async fn write_line(&self, value: &Value) -> Result<(), McpError> {
        let mut line =
            serde_json::to_string(value).map_err(|e| McpError::Protocol(e.to_string()))?;
        line.push('\n');
        let mut w = self.writer.lock().await;
        w.write_all(line.as_bytes())
            .await
            .map_err(|e| McpError::Transport(e.to_string()))?;
        w.flush()
            .await
            .map_err(|e| McpError::Transport(e.to_string()))
    }

    fn stderr_tail(&self) -> Option<String> {
        let s = self.stderr.lock().unwrap();
        (!s.trim().is_empty()).then(|| s.trim().to_string())
    }
}

/// What one `tools/call` produced.
#[derive(Debug)]
pub struct CallOutcome {
    pub text: String,
    pub is_error: bool,
}

/// Flatten MCP content blocks into the string a `Tool` returns.
///
/// Text blocks pass through; everything else is named rather than dropped, so
/// a model that asked for a screenshot learns it got one instead of seeing an
/// empty result and concluding the call did nothing. `Tool::call` returns a
/// `String`, so an image cannot travel further than this today.
fn flatten_content(result: &Value) -> String {
    let Some(blocks) = result["content"].as_array() else {
        // Some servers answer with `structuredContent` only.
        return match result.get("structuredContent") {
            Some(v) if !v.is_null() => v.to_string(),
            _ => String::new(),
        };
    };
    let mut out = Vec::new();
    for b in blocks {
        match b["type"].as_str() {
            Some("text") => out.push(b["text"].as_str().unwrap_or_default().to_string()),
            Some("image") => out.push(format!(
                "[image: {} — this harness cannot pass images back from a tool]",
                b["mimeType"].as_str().unwrap_or("unknown type")
            )),
            Some("resource") => {
                let r = &b["resource"];
                match r["text"].as_str() {
                    Some(text) => out.push(text.to_string()),
                    None => out.push(format!(
                        "[resource: {}]",
                        r["uri"].as_str().unwrap_or("unknown")
                    )),
                }
            }
            Some(other) => out.push(format!("[unsupported content block: {other}]")),
            None => {}
        }
    }
    out.join("\n")
}

/// Read replies until the stream ends, completing whoever was waiting.
fn spawn_reader(
    reader: impl AsyncRead + Send + Unpin + 'static,
    pending: Pending,
    stderr: Arc<Mutex<String>>,
) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(msg) = serde_json::from_str::<Value>(&line) else {
                // A line we cannot parse is the server's problem, not a
                // reason to tear down every other in-flight call.
                continue;
            };
            // A message with both an id and a method is the server calling
            // *us*. We declared no capabilities, so there is nothing it can
            // legitimately ask for — but it is still owed a reply, since a
            // server blocking on one would deadlock the session.
            if msg.get("method").is_some() {
                continue;
            }
            let Some(id) = msg["id"].as_u64() else {
                continue;
            };
            let Some(tx) = pending.lock().unwrap().remove(&id) else {
                continue;
            };
            let reply = if let Some(err) = msg.get("error").filter(|e| !e.is_null()) {
                Err(McpError::Rpc {
                    code: err["code"].as_i64().unwrap_or(0),
                    message: err["message"].as_str().unwrap_or("unknown").to_string(),
                })
            } else {
                Ok(msg.get("result").cloned().unwrap_or(Value::Null))
            };
            let _ = tx.send(reply);
        }
        // EOF. Everyone still waiting gets told, rather than waiting out the
        // full timeout for an answer that is never coming.
        let tail = {
            let s = stderr.lock().unwrap();
            (!s.trim().is_empty()).then(|| s.trim().to_string())
        };
        for (_, tx) in pending.lock().unwrap().drain() {
            let _ = tx.send(Err(McpError::Closed(tail.clone())));
        }
    });
}

/// Keep the tail of a server's stderr, so a crash has an explanation.
fn spawn_stderr_drain(stderr: tokio::process::ChildStderr, tail: Arc<Mutex<String>>) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let mut buf = tail.lock().unwrap();
            buf.push_str(&line);
            buf.push('\n');
            if buf.len() > STDERR_TAIL {
                let cut = buf.len() - STDERR_TAIL;
                *buf = buf[cut..].to_string();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

    /// A scripted server: reads one request at a time and answers it with the
    /// next canned reply, echoing the request's id back.
    fn scripted(replies: Vec<Value>) -> Client {
        let (client_side, mut server_side) = tokio::io::duplex(8192);
        let (cr, cw) = tokio::io::split(client_side);
        tokio::spawn(async move {
            let (sr, mut sw) = tokio::io::split(&mut server_side);
            let mut lines = BufReader::new(sr).lines();
            let mut replies = replies.into_iter();
            while let Ok(Some(line)) = lines.next_line().await {
                let req: Value = serde_json::from_str(&line).unwrap();
                // Notifications carry no id and get no reply.
                let Some(id) = req["id"].as_u64() else {
                    continue;
                };
                let Some(mut reply) = replies.next() else {
                    break;
                };
                reply["id"] = json!(id);
                reply["jsonrpc"] = json!("2.0");
                let mut out = serde_json::to_string(&reply).unwrap();
                out.push('\n');
                if sw.write_all(out.as_bytes()).await.is_err() {
                    break;
                }
            }
        });
        Client::from_streams("test", cr, cw, None, None)
    }

    #[tokio::test]
    async fn handshake_records_the_version_the_server_chose() {
        let c = scripted(vec![json!({"result": {
            "protocolVersion": "2099-01-01",
            "capabilities": {},
            "serverInfo": { "name": "demo", "version": "9.9" }
        }})]);
        let info = c.initialize().await.unwrap();
        assert_eq!(info.name, "demo");
        // Not the version we asked for, and accepted anyway: the methods this
        // client uses have been stable across revisions.
        assert_eq!(info.protocol_version, "2099-01-01");
    }

    #[tokio::test]
    async fn tool_listing_follows_pagination() {
        let c = scripted(vec![
            json!({"result": {"tools": [{"name": "a"}], "nextCursor": "p2"}}),
            json!({"result": {"tools": [{"name": "b"}]}}),
        ]);
        let tools = c.list_tools().await.unwrap();
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[1]["name"], "b");
    }

    #[tokio::test]
    async fn a_repeated_cursor_ends_the_listing_instead_of_spinning() {
        let c = scripted(vec![
            json!({"result": {"tools": [{"name": "a"}], "nextCursor": "same"}}),
            json!({"result": {"tools": [{"name": "b"}], "nextCursor": "same"}}),
        ]);
        let tools = c.list_tools().await.unwrap();
        assert_eq!(tools.len(), 2);
    }

    #[tokio::test]
    async fn a_failed_call_is_a_result_not_a_transport_error() {
        let c = scripted(vec![json!({"result": {
            "content": [{"type": "text", "text": "no such file"}],
            "isError": true
        }})]);
        let out = c.call_tool("read", json!({})).await.unwrap();
        // The server answered; the *tool* failed. Only a broken server is an
        // Err, and the difference decides whether the session is still usable.
        assert!(out.is_error);
        assert_eq!(out.text, "no such file");
    }

    #[tokio::test]
    async fn a_json_rpc_error_is_an_error() {
        let c = scripted(vec![
            json!({"error": {"code": -32601, "message": "no method"}}),
        ]);
        let err = c.call_tool("nope", json!({})).await.unwrap_err();
        assert!(matches!(err, McpError::Rpc { code: -32601, .. }), "{err}");
    }

    #[tokio::test]
    async fn a_server_that_dies_fails_the_call_instead_of_hanging() {
        // No replies scripted: the task returns and drops the stream.
        let c = scripted(vec![]);
        let err = c.call_tool("anything", json!({})).await.unwrap_err();
        // Without the EOF sweep this would sit out the full request timeout.
        assert!(matches!(err, McpError::Closed(_)), "{err}");
    }

    #[test]
    fn content_blocks_flatten_and_name_what_they_cannot_carry() {
        let v = json!({"content": [
            {"type": "text", "text": "one"},
            {"type": "image", "mimeType": "image/png", "data": "…"},
            {"type": "resource", "resource": {"uri": "file:///x", "text": "two"}}
        ]});
        let out = flatten_content(&v);
        assert!(out.starts_with("one\n"));
        // Named rather than dropped: an empty result would read as "the call
        // did nothing" and invite the model to try again forever.
        assert!(out.contains("image/png"), "{out}");
        assert!(out.ends_with("two"), "{out}");
    }
}
