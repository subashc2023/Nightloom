//! MCP over Streamable HTTP.
//!
//! The other half of [`crate::Client`]: same JSON-RPC, entirely different
//! plumbing. Over stdio there is one long-lived pipe and replies have to be
//! matched back to requests by id, which is why that side runs a reader task
//! and a table of pending senders. Over HTTP the correlation is the POST
//! itself — the answer to a request arrives on that request's own response —
//! so there is no reader task, no pending table, and no way for one call's
//! failure to strand another.
//!
//! What HTTP adds instead is *state the server keeps*: a session id it may
//! mint during `initialize` and expect back on everything after, and a
//! protocol-version header the spec requires once a version has been agreed.
//! Both live here rather than on `Client`, because both are artifacts of this
//! transport and neither means anything to a pipe.
//!
//! # What is not implemented
//!
//! The **deprecated 2024-11-05 HTTP+SSE transport** (a `GET /sse` that hands
//! back an `endpoint` event naming a separate POST URL) is not spoken. It is a
//! different handshake, not a variation on this one, and a server that only
//! offers it will fail at connect with a clear error rather than half-work.
//!
//! The optional **server-initiated GET stream** is also not opened. It exists
//! to carry requests *from* the server, and this client declares no
//! capabilities — there is nothing it could legitimately be asked for, so
//! holding a socket open to listen would buy an idle connection per server.

use crate::McpError;
use eventsource_stream::Eventsource;
use futures::StreamExt;
use reqwest::header::{ACCEPT, CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue};
use serde_json::Value;
use std::sync::Mutex;

/// The header a server uses to mint, and then demand back, a session.
const SESSION_HEADER: &str = "mcp-session-id";

/// The header carrying the version both sides agreed on, required by the spec
/// on every request after `initialize`.
const VERSION_HEADER: &str = "mcp-protocol-version";

/// How much of a failed response body to quote back in an error.
const BODY_SNIPPET: usize = 512;

/// A connection to a server that lives behind a URL.
#[derive(Debug)]
pub(crate) struct HttpWire {
    http: reqwest::Client,
    url: String,
    /// Headers from the config — typically an `Authorization`. Fixed for the
    /// life of the connection; the two moving ones are below.
    headers: HeaderMap,
    /// Whatever the server minted during `initialize`, if it minted anything.
    /// Stateless servers never set it and never expect it back.
    session: Mutex<Option<String>>,
    protocol: Mutex<Option<String>>,
}

impl HttpWire {
    pub(crate) fn new(url: &str, headers: &[(String, String)]) -> Result<Self, McpError> {
        let mut map = HeaderMap::new();
        for (k, v) in headers {
            let name = HeaderName::try_from(k.as_str())
                .map_err(|_| McpError::BadSpec(format!("{k:?} is not a valid header name")))?;
            let value = HeaderValue::from_str(v).map_err(|_| {
                // Deliberately does not quote the value: a bad header is
                // nearly always a token, and an error message is the one place
                // a secret must not turn up.
                McpError::BadSpec(format!("the value of header {k:?} is not valid HTTP"))
            })?;
            map.insert(name, value);
        }
        Ok(Self {
            http: reqwest::Client::builder()
                .build()
                .map_err(|e| McpError::Transport(e.to_string()))?,
            url: url.to_string(),
            headers: map,
            session: Mutex::new(None),
            protocol: Mutex::new(None),
        })
    }

    /// Record the version the handshake settled on, for the header the spec
    /// wants on every later request.
    pub(crate) fn set_protocol_version(&self, version: &str) {
        *self.protocol.lock().unwrap() = Some(version.to_string());
    }

    /// POST one JSON-RPC message and read its reply.
    ///
    /// `None` means the server accepted the message without answering, which
    /// is the correct response to a notification and nothing else.
    pub(crate) async fn send(&self, message: &Value) -> Result<Option<Value>, McpError> {
        let wants_reply = message.get("id").is_some();
        let mut req = self
            .http
            .post(&self.url)
            .headers(self.headers.clone())
            .header(CONTENT_TYPE, "application/json")
            // Both, because the server picks: a small result comes back as
            // JSON, and one the server wants to stream comes back as SSE. A
            // client that advertised only one would work against half the
            // implementations in the wild.
            .header(ACCEPT, "application/json, text/event-stream");
        if let Some(id) = self.session.lock().unwrap().clone() {
            req = req.header(SESSION_HEADER, id);
        }
        if let Some(v) = self.protocol.lock().unwrap().clone() {
            req = req.header(VERSION_HEADER, v);
        }

        let response = req
            .json(message)
            .send()
            .await
            .map_err(|e| McpError::Transport(e.to_string()))?;

        if let Some(id) = response
            .headers()
            .get(SESSION_HEADER)
            .and_then(|v| v.to_str().ok())
        {
            *self.session.lock().unwrap() = Some(id.to_string());
        }

        let status = response.status();
        if status == reqwest::StatusCode::NOT_FOUND && self.session.lock().unwrap().is_some() {
            // The spec's signal that a session has expired. Cleared rather
            // than kept, so the id cannot be replayed onto later requests and
            // turn one dead session into a run of confusing 404s.
            *self.session.lock().unwrap() = None;
            return Err(McpError::SessionExpired);
        }
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(McpError::Http {
                status: status.as_u16(),
                body: snippet(&body),
            });
        }
        // 202 is what the spec prescribes for an accepted notification, but
        // implementations also answer 200 with an empty body. Either way there
        // is nothing to wait for.
        if !wants_reply {
            return Ok(None);
        }

        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();

        if content_type.starts_with("text/event-stream") {
            let id = message["id"].clone();
            return read_sse(response, &id).await.map(Some);
        }
        let body = response
            .text()
            .await
            .map_err(|e| McpError::Transport(e.to_string()))?;
        if body.trim().is_empty() {
            return Err(McpError::Protocol(
                "the server answered a request with an empty body".into(),
            ));
        }
        serde_json::from_str(&body)
            .map(Some)
            .map_err(|e| McpError::Protocol(format!("{e}: {}", snippet(&body))))
    }
}

/// Read an SSE response until the answer to `id` arrives.
///
/// A server may put anything on this stream before the reply — progress
/// notifications, or requests of its own. They are skipped rather than
/// treated as the answer, which is the whole reason this loops instead of
/// taking the first event it sees.
async fn read_sse(response: reqwest::Response, id: &Value) -> Result<Value, McpError> {
    let mut events = response.bytes_stream().eventsource();
    while let Some(event) = events.next().await {
        let event = event.map_err(|e| McpError::Transport(e.to_string()))?;
        if event.data.trim().is_empty() {
            continue;
        }
        let Ok(message) = serde_json::from_str::<Value>(&event.data) else {
            // One unparseable frame is the server's problem. Failing the call
            // over it would throw away a reply that may be two frames later.
            continue;
        };
        if message.get("id") == Some(id) && message.get("method").is_none() {
            return Ok(message);
        }
    }
    Err(McpError::Closed(Some(
        "the response stream ended before the request was answered".into(),
    )))
}

fn snippet(body: &str) -> String {
    let flat: String = body.split_whitespace().collect::<Vec<_>>().join(" ");
    match flat.char_indices().nth(BODY_SNIPPET) {
        Some((cut, _)) => format!("{}…", &flat[..cut]),
        None => flat,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

    #[test]
    fn a_bad_header_name_is_caught_at_construction() {
        let err = HttpWire::new("http://x", &[("not a header".into(), "v".into())]).unwrap_err();
        assert!(matches!(err, McpError::BadSpec(_)), "{err}");
    }

    #[test]
    fn a_bad_header_value_never_quotes_the_value() {
        // Newlines cannot go in a header value, and the value here is the
        // shape a leaked token would have.
        let err = HttpWire::new(
            "http://x",
            &[("authorization".into(), "Bearer sk-\nx".into())],
        )
        .unwrap_err();
        let text = err.to_string();
        assert!(text.contains("authorization"), "{text}");
        assert!(!text.contains("sk-"), "{text}");
    }

    #[tokio::test]
    async fn sse_skips_notifications_and_returns_the_matching_reply() {
        let body = concat!(
            "data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\n",
            "data: {\"jsonrpc\":\"2.0\",\"id\":9,\"result\":{\"ok\":true}}\n\n",
        );
        let response = http_response(body);
        let reply = read_sse(response, &json!(9)).await.unwrap();
        assert_eq!(reply["result"]["ok"], json!(true));
    }

    #[tokio::test]
    async fn an_sse_stream_that_ends_unanswered_is_an_error_not_a_hang() {
        let response = http_response("data: {\"jsonrpc\":\"2.0\",\"method\":\"ping\"}\n\n");
        let err = read_sse(response, &json!(1)).await.unwrap_err();
        assert!(matches!(err, McpError::Closed(_)), "{err}");
    }

    /// Build a `reqwest::Response` over a canned body, so the SSE reader can
    /// be driven without a server on a port.
    fn http_response(body: &'static str) -> reqwest::Response {
        reqwest::Response::from(
            http::Response::builder()
                .header(CONTENT_TYPE, "text/event-stream")
                .body(body)
                .unwrap(),
        )
    }

    #[test]
    fn a_long_error_body_is_trimmed_rather_than_dumped() {
        let long = "x".repeat(BODY_SNIPPET * 2);
        let out = snippet(&long);
        assert!(out.ends_with('…'));
        assert!(out.chars().count() <= BODY_SNIPPET + 1);
    }

    /// One request the scripted server received.
    struct Recorded {
        headers: Vec<(String, String)>,
        body: Value,
    }

    impl Recorded {
        fn header(&self, name: &str) -> Option<&str> {
            self.headers
                .iter()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.as_str())
        }
    }

    /// A scripted MCP server on a real socket.
    ///
    /// Hand-rolled rather than pulled in as a dependency, and worth the sixty
    /// lines: the point of this test is the parts a fake `HttpWire` could not
    /// exercise — that reqwest sends the headers we think it does, that the
    /// session id the server mints comes back on the next request, and that a
    /// reply delivered as SSE is read the same as one delivered as JSON.
    ///
    /// Each reply is `(content_type, body)`. The request's id is stamped onto
    /// the reply, the same way the stdio scripted server does it.
    async fn scripted_server(
        replies: Vec<(&'static str, Value)>,
    ) -> (String, Arc<Mutex<Vec<Recorded>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let log: Arc<Mutex<Vec<Recorded>>> = Arc::default();
        let recorded = Arc::clone(&log);
        tokio::spawn(async move {
            let mut replies = replies.into_iter();
            let mut first = true;
            while let Ok((mut socket, _)) = listener.accept().await {
                let (read_half, mut write_half) = socket.split();
                let mut reader = tokio::io::BufReader::new(read_half);
                let mut headers = Vec::new();
                let mut length = 0usize;
                let mut line = String::new();
                loop {
                    line.clear();
                    match reader.read_line(&mut line).await {
                        Ok(0) => break,
                        Ok(_) => {}
                        Err(_) => break,
                    }
                    if line == "\r\n" {
                        break;
                    }
                    if let Some((k, v)) = line.trim_end().split_once(": ") {
                        if k.eq_ignore_ascii_case("content-length") {
                            length = v.parse().unwrap_or(0);
                        }
                        headers.push((k.to_ascii_lowercase(), v.to_string()));
                    }
                }
                let mut body = vec![0u8; length];
                let _ = reader.read_exact(&mut body).await;
                let request: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
                let id = request.get("id").cloned();
                recorded.lock().unwrap().push(Recorded {
                    headers,
                    body: request,
                });

                // A notification is accepted and not answered — and, just as
                // importantly, consumes no scripted reply: the client has to
                // tolerate a message that gets a bare 202.
                let response = match id.as_ref().map(|id| (id, replies.next())) {
                    None => "HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string(),
                    Some((id, Some((content_type, mut reply)))) => {
                        reply["id"] = id.clone();
                        reply["jsonrpc"] = json!("2.0");
                        let payload = if content_type == "text/event-stream" {
                            format!("event: message\ndata: {reply}\n\n")
                        } else {
                            reply.to_string()
                        };
                        let session = if std::mem::take(&mut first) {
                            "Mcp-Session-Id: sess-42\r\n"
                        } else {
                            ""
                        };
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\n{session}Content-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                            payload.len()
                        )
                    }
                    Some((_, None)) => {
                        "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 9\r\nConnection: close\r\n\r\nno script".to_string()
                    }
                };
                let _ = write_half.write_all(response.as_bytes()).await;
                let _ = write_half.flush().await;
            }
        });
        (url, log)
    }

    #[tokio::test]
    async fn a_session_id_is_captured_and_replayed_on_every_later_request() {
        let (url, log) = scripted_server(vec![
            (
                "application/json",
                json!({"result": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "serverInfo": {"name": "remote", "version": "1.0"}
                }}),
            ),
            // Deliberately the other content type: a server picks per
            // response, and both have to read the same from up here.
            (
                "text/event-stream",
                json!({"result": {"tools": [{"name": "search"}]}}),
            ),
        ])
        .await;
        let client = crate::Client::http(
            "remote",
            &url,
            &[("authorization".into(), "Bearer t".into())],
        )
        .unwrap();
        let info = client.initialize().await.unwrap();
        assert_eq!(info.name, "remote");
        let tools = client.list_tools().await.unwrap();
        assert_eq!(tools[0]["name"], "search");

        let log = log.lock().unwrap();
        // initialize, notifications/initialized, tools/list.
        assert_eq!(log.len(), 3);
        assert_eq!(log[0].header("authorization"), Some("Bearer t"));
        // Nothing to send on the first request; minted by the reply to it.
        assert_eq!(log[0].header(SESSION_HEADER), None);
        assert_eq!(log[0].header(VERSION_HEADER), None);
        for later in &log[1..] {
            assert_eq!(later.header(SESSION_HEADER), Some("sess-42"));
            // The version the *server* chose, and carried from the very next
            // message on — including the notification, which a strict server
            // will reject without it.
            assert_eq!(later.header(VERSION_HEADER), Some("2025-06-18"));
        }
        assert_eq!(log[1].body["method"], "notifications/initialized");
        assert!(log[1].body.get("id").is_none());
    }

    #[tokio::test]
    async fn an_http_failure_carries_the_body_the_status_alone_cannot_explain() {
        // The script runs out, so the server answers 500 with a body.
        let (url, _) = scripted_server(vec![]).await;
        let client = crate::Client::http("remote", &url, &[]).unwrap();
        let err = client.initialize().await.unwrap_err();
        match err {
            McpError::Http { status, body } => {
                assert_eq!(status, 500);
                assert_eq!(body, "no script");
            }
            other => panic!("{other}"),
        }
    }
}
