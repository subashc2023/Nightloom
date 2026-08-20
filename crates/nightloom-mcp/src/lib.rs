//! An MCP (Model Context Protocol) client: tools that live in another
//! process, exposed to the harness as ordinary [`nightloom_core::Tool`]s.
//!
//! Its own crate for the same reason [`nightloom_providers`] is one — it is a
//! wire protocol with its own framing, error taxonomy and lifecycle, and the
//! rest of the harness should only ever see what comes out the far side. The
//! dependency direction matches: this sits on `nightloom-core` and knows
//! nothing about chat, providers, or shells.
//!
//! # What arrives over MCP is not vouched for
//!
//! A server's tools are declared by the server. Their names, descriptions and
//! schemas are strings from another process, and the harness has no way to
//! know what any of them do. So [`McpTool`] takes
//! [`Effect::Mutating`](nightloom_core::Effect::Mutating) — not by forgetting
//! to classify, but because that is the honest answer, and the `Tool` trait's
//! default was written with exactly this case in mind. Every MCP tool call
//! goes through the approval gate.
//!
//! Descriptions are the other half of that: they are prompt text written by
//! someone else and handed straight to the model. That is the *point* of MCP
//! and also its sharpest edge, and it is why the server name is prefixed onto
//! every tool the model sees — so a `read_file` from a random server cannot
//! quietly shadow the built-in one.

mod client;
mod config;
mod http;
mod tool;

pub use client::{Client, ServerInfo};
pub use config::{McpConfig, ServerSpec, Transport};
pub use tool::{McpTool, ServerReport, connect_all};

/// Everything that can go wrong talking to an MCP server.
#[derive(Debug, thiserror::Error)]
pub enum McpError {
    #[error("could not start MCP server {name}: {source}")]
    Spawn {
        name: String,
        source: std::io::Error,
    },
    #[error("transport error: {0}")]
    Transport(String),
    #[error("malformed message from server: {0}")]
    Protocol(String),
    /// A JSON-RPC error object the server returned for our request.
    #[error("server returned error {code}: {message}")]
    Rpc { code: i64, message: String },
    /// The connection ended, taking every in-flight request with it. Carries
    /// whatever the server said on stderr, which is usually the only
    /// explanation a crashed server leaves behind.
    #[error("MCP server exited{}", .0.as_ref().map(|s| format!(": {s}")).unwrap_or_default())]
    Closed(Option<String>),
    #[error("MCP request timed out after {0:?}")]
    Timeout(std::time::Duration),
    /// The turn was interrupted while this request was in flight.
    /// Distinct from [`McpError::Timeout`] because the two want different
    /// words: a timeout says the server is unwell, where this says the user
    /// pressed Ctrl-C and nothing is wrong with anything.
    #[error("the request was interrupted")]
    Cancelled,
    /// A non-2xx answer from an HTTP server. Carries a trimmed body, because
    /// the status alone rarely says which of a URL, a token or a payload was
    /// wrong.
    #[error("MCP server returned HTTP {status}{}", if .body.is_empty() { String::new() } else { format!(": {}", .body) })]
    Http { status: u16, body: String },
    /// The server forgot the session, which it is entitled to do at any time.
    /// Distinct from a plain 404 so a caller can tell "reconnect" from "that
    /// URL is wrong".
    #[error("the MCP session expired; the server no longer recognises it")]
    SessionExpired,
    /// A `${VAR}` in the config with nothing behind it.
    #[error("{0} is referenced in mcp.json but not set in the environment")]
    MissingEnv(String),
    /// The entry in `mcp.json` does not describe a reachable server.
    #[error("invalid MCP server entry: {0}")]
    BadSpec(String),
    #[error("could not read MCP config {path}: {source}")]
    Config {
        path: String,
        source: std::io::Error,
    },
}
