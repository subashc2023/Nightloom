//! The Mac and the away server exchange copies (nightshift item 268,
//! step 3; research note `268-phone-without-the-mac-2026-09-29.md` §4).
//!
//! **One writer per file** decides the shape. The two machines never write
//! the same file; they send each other copies:
//!
//! - **Up** ([`push`]): when the Mac is awake it sends a snapshot of user
//!   memory (`AGENTS.md`), the vault, and — only for projects he marks
//!   "available away" (blocker 651) — each project's `AGENTS.md`, its chat
//!   logs and the Claude Code session files those logs name; "No project"
//!   is markable the same way (item 275, on by default). A manifest
//!   goes first ([`manifest`]); only changed files follow. The server keeps
//!   them under `<home>/mirror/` ([`Layout`]) and never writes a mirrored
//!   file except when the Mac sends it.
//! - **Down** ([`pull`]): chats started on the server are listed in its
//!   outbox; the Mac copies each into its project (log **and** CLI session
//!   file, the session's folder rewritten for the Mac), never over a file
//!   it has, then acknowledges; the server then marks its copy read-only.
//! - **Continuing a Mac chat from the phone** is a fork ([`fork`], blocker
//!   652): the mirrored log and CLI file are copied into a new server-owned
//!   chat, which comes down beside the original. The original is untouched.
//!
//! The server half ([`mirror::SyncServer`]) is reached through
//! `remote::sync_routes` behind the listener's bearer token; the Mac half
//! is [`push::send`] and [`pull::run`] over [`Client`].

pub mod fork;
pub mod manifest;
pub mod mirror;
pub mod pull;
pub mod push;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

pub use manifest::{Entry, Manifest};
pub use mirror::SyncServer;

/// `<home>/mirror`: everything the Mac sent, and nothing else.
pub const MIRROR_DIR: &str = "mirror";
/// `<home>/sync`: the server's own sync state (which chats the Mac has
/// taken down). Never mirrored, never sent.
pub const STATE_DIR: &str = "sync";
/// The away server's token on the Mac: `~/.nightloom/remote/away-token`,
/// written by his step-2 session. Read by Rust only; its value is never
/// shown, logged, or sent anywhere but the away server's `Authorization`.
pub const AWAY_TOKEN_FILE: &str = "away-token";
/// The mirror's generated project list: `[{id, name}]` of the marked
/// projects, so the server can name them.
pub const PROJECTS_FILE: &str = "projects.json";
/// The Mac's model list (`<config>/model-list.json`, item 272, wave 4 B),
/// sent as is so the away server's pickers offer the same models. The
/// same name as `model_list::FILE` on branch w4-b; one may name the other
/// once both are merged.
pub const MODEL_LIST_FILE: &str = "model-list.json";
/// The no-project chats' folder name, on the Mac (`<config>/unfiled`),
/// on the server (`<home>/unfiled`) and in the mirror (item 275).
pub const UNFILED_DIR: &str = "unfiled";
/// The `reason` on the creation line of a chat forked on the server.
pub const FORK_REASON: &str = "away";

/// Where the mirror keeps what, on the server. Every path the Mac sends is
/// one of these shapes ([`Layout::allowed`]); anything else is refused.
///
/// ```text
/// <home>/mirror/AGENTS.md                         user memory
/// <home>/mirror/knowledge/…                       the vault
/// <home>/mirror/projects.json                     the marked projects
/// <home>/mirror/model-list.json                   the Mac's model list
/// <home>/mirror/projects/<id>/AGENTS.md           a project's memory
/// <home>/mirror/projects/<id>/sessions/<c>.jsonl  its chat logs
/// <home>/mirror/unfiled/sessions/<c>.jsonl        no-project chat logs
/// <home>/mirror/claude/<cwd-slug>/<sid>.jsonl     the CLI session files
/// ```
#[derive(Debug, Clone)]
pub struct Layout {
    home: PathBuf,
}

/// One marked project, as the mirror names it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MirrorProject {
    pub id: String,
    pub name: String,
}

impl Layout {
    pub fn new(home: impl Into<PathBuf>) -> Self {
        Self { home: home.into() }
    }

    pub fn home(&self) -> &Path {
        &self.home
    }

    /// `<home>/mirror`.
    pub fn root(&self) -> PathBuf {
        self.home.join(MIRROR_DIR)
    }

    /// `<home>/mirror/projects/<id>/sessions` — a marked project's logs as
    /// the Mac last sent them. Read-only to everything on the server.
    pub fn sessions(&self, project: &str) -> PathBuf {
        self.root()
            .join(crate::project::PROJECTS_DIR)
            .join(project)
            .join(crate::project::SESSIONS_DIR)
    }

    /// `<home>/mirror/unfiled/sessions` — the Mac's no-project chats, as
    /// it last sent them when "No project" is marked available away (item
    /// 275). Read-only to everything on the server, like [`Self::sessions`].
    pub fn unfiled_sessions(&self) -> PathBuf {
        self.root()
            .join(UNFILED_DIR)
            .join(crate::project::SESSIONS_DIR)
    }

    /// `<home>/mirror/claude`: the Mac's CLI session files, under the Mac's
    /// folder slugs.
    pub fn claude(&self) -> PathBuf {
        self.root().join("claude")
    }

    /// `<home>/sync`.
    pub fn state(&self) -> PathBuf {
        self.home.join(STATE_DIR)
    }

    /// The marked projects the Mac last sent, or none.
    pub fn projects(&self) -> Vec<MirrorProject> {
        std::fs::read(self.root().join(PROJECTS_FILE))
            .ok()
            .and_then(|raw| serde_json::from_slice(&raw).ok())
            .unwrap_or_default()
    }

    /// Whether a mirror path has one of the shapes above.
    pub fn allowed(rel: &str) -> bool {
        if !manifest::safe_rel(rel) {
            return false;
        }
        let parts: Vec<&str> = rel.split('/').collect();
        match parts.as_slice() {
            ["AGENTS.md"] | ["projects.json"] | ["model-list.json"] => true,
            ["knowledge", _, ..] => true,
            ["projects", _, "AGENTS.md"] => true,
            ["projects", _, "sessions", name] | ["unfiled", "sessions", name] => {
                name.ends_with(".jsonl") && crate::store::is_log_id(name.trim_end_matches(".jsonl"))
            }
            ["claude", _, name] => name.ends_with(".jsonl"),
            _ => false,
        }
    }

    /// Whether a send to the chat whose log is `log` must fork it first:
    /// a mirrored chat (the Mac owns it) or a server chat the Mac has
    /// already taken down (read-only on the server since, see
    /// [`SyncServer::ack`]). What `serve`'s send path asks before it opens
    /// a chat for a turn.
    pub fn needs_fork(&self, log: &Path) -> bool {
        if log.starts_with(self.root()) {
            return true;
        }
        let id = log
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        mirror::read_acked(&self.state()).contains(&id)
    }
}

/// The Mac's side of the wire: the away server's base URL and token.
#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    base: String,
    token: String,
}

impl std::fmt::Debug for Client {
    // Never the token.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Client").field("base", &self.base).finish()
    }
}

/// How long one request may take. A chat log can be tens of megabytes; a
/// slow uplink gets the time, a dead one is reported.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

impl Client {
    /// `base` is the server's URL (`https://nightloom-away-….fly.dev`, or
    /// `http://127.0.0.1:<port>` in a test); a trailing `/` is ignored.
    pub fn new(base: &str, token: &str) -> Result<Self, String> {
        let base = base.trim().trim_end_matches('/').to_string();
        if !(base.starts_with("https://") || base.starts_with("http://")) {
            return Err(format!(
                "the away server's address must start with https:// (got {base:?})"
            ));
        }
        let http = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .connect_timeout(Duration::from_secs(15))
            .build()
            .map_err(|e| format!("could not set up the connection: {e}"))?;
        Ok(Self {
            http,
            base,
            token: token.trim().to_string(),
        })
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    fn url(&self, path: &str) -> String {
        format!("{}/api/sync/{path}", self.base)
    }

    pub(crate) async fn post_json<B: Serialize, R: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<R, String> {
        let resp = self
            .http
            .post(self.url(path))
            .bearer_auth(&self.token)
            .json(body)
            .send()
            .await
            .map_err(|e| self.unreachable(e))?;
        let resp = self.checked(resp).await?;
        resp.json()
            .await
            .map_err(|e| format!("the away server's answer was not understood: {e}"))
    }

    pub(crate) async fn post_empty<B: Serialize>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<(), String> {
        let resp = self
            .http
            .post(self.url(path))
            .bearer_auth(&self.token)
            .json(body)
            .send()
            .await
            .map_err(|e| self.unreachable(e))?;
        self.checked(resp).await.map(|_| ())
    }

    pub(crate) async fn get_json<R: serde::de::DeserializeOwned>(
        &self,
        path: &str,
    ) -> Result<R, String> {
        let resp = self
            .http
            .get(self.url(path))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|e| self.unreachable(e))?;
        let resp = self.checked(resp).await?;
        resp.json()
            .await
            .map_err(|e| format!("the away server's answer was not understood: {e}"))
    }

    pub(crate) async fn get_bytes(&self, path: &str) -> Result<Vec<u8>, String> {
        let resp = self
            .http
            .get(self.url(path))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|e| self.unreachable(e))?;
        let resp = self.checked(resp).await?;
        resp.bytes()
            .await
            .map(|b| b.to_vec())
            .map_err(|e| format!("the download from the away server broke off: {e}"))
    }

    pub(crate) async fn put_file(
        &self,
        rel: &str,
        sha256: &str,
        body: Vec<u8>,
    ) -> Result<(), String> {
        let path: Vec<String> = rel.split('/').map(encode_segment).collect();
        let resp = self
            .http
            .put(self.url(&format!("files/{}", path.join("/"))))
            .bearer_auth(&self.token)
            .header(SHA_HEADER, sha256)
            .body(body)
            .send()
            .await
            .map_err(|e| self.unreachable(e))?;
        self.checked(resp).await.map(|_| ())
    }

    fn unreachable(&self, e: reqwest::Error) -> String {
        if e.is_timeout() {
            format!("the away server at {} did not answer in time", self.base)
        } else if e.is_connect() {
            format!(
                "could not reach the away server at {} — is it deployed and running?",
                self.base
            )
        } else {
            format!(
                "the request to the away server at {} failed: {e}",
                self.base
            )
        }
    }

    async fn checked(&self, resp: reqwest::Response) -> Result<reqwest::Response, String> {
        let status = resp.status();
        if status.is_success() {
            return Ok(resp);
        }
        let body = resp.text().await.unwrap_or_default();
        let body: String = body.chars().take(300).collect();
        Err(match status.as_u16() {
            401 => format!(
                "the away server refused the token in ~/.nightloom/remote/{AWAY_TOKEN_FILE} — \
                 it does not match the server's"
            ),
            404 => format!(
                "the server at {} has no sync routes — is it a Nightloom away server \
                 from this build or later?",
                self.base
            ),
            code => format!("the away server answered {code}: {body}"),
        })
    }
}

/// The header a file's SHA-256 rides in on `PUT /api/sync/files/…`.
pub const SHA_HEADER: &str = "x-nightloom-sha256";

/// Percent-encode one path segment (everything but RFC 3986's unreserved
/// characters), so a file name with a space or `#` survives the URL.
pub fn encode_segment(seg: &str) -> String {
    let mut out = String::with_capacity(seg.len());
    for b in seg.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The away token's path for a config dir: `<config>/remote/away-token`.
pub fn away_token_path(config: &Path) -> PathBuf {
    config.join("remote").join(AWAY_TOKEN_FILE)
}

/// The away token, if the file is there and not empty. The value goes only
/// into a [`Client`]; callers that show anything show "token found".
pub fn read_away_token(config: &Path) -> Option<String> {
    std::fs::read_to_string(away_token_path(config))
        .ok()
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
}

/// Whether a listener answers at `url` (`…/api/state`), and how fast: the
/// Remote card's "Test from this Mac" (backlog 154's Mac half). `Ok(ms)`
/// for any HTTP answer but a refused token, which is its own sentence; the
/// reason in words otherwise.
pub async fn probe(url: &str, token: Option<&str>) -> Result<u128, String> {
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("could not set up the test: {e}"))?;
    let mut req = http.get(url);
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let started = Instant::now();
    match req.send().await {
        Ok(resp) => {
            let ms = started.elapsed().as_millis();
            match resp.status().as_u16() {
                401 => Err(format!(
                    "answers in {ms} ms, but refused this Mac's token — regenerate it and scan again"
                )),
                _ => Ok(ms),
            }
        }
        Err(e) if e.is_timeout() => Err("no answer within 8 seconds — the listener is not \
             reachable at its own address (a firewall, or Tailscale is reconnecting)"
            .into()),
        Err(e) if e.is_connect() => Err(format!(
            "nothing answers at {url} — the listener is not running there (connection refused \
             or no route)"
        )),
        Err(e) => Err(format!("the test failed: {e}")),
    }
}

#[cfg(test)]
mod tests;
