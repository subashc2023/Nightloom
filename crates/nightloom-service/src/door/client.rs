//! The caller's side of the door: one call over the socket, the disk when
//! nothing listens, and the wait both shells share.

use std::path::Path;
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
use serde_json::Value;

use super::{ChatView, Live, Request, State, Status};

/// How often a wait asks where the chat stands.
const POLL: Duration = Duration::from_millis(1500);
/// How long a sent message may take to show as a running turn before the
/// wait calls it not started.
const START_GRACE: Duration = Duration::from_secs(30);
/// How many status calls in a row may fail before a wait gives up.
const MAX_MISSES: u32 = 20;

/// One call: over the socket when a holder listens; else a read answered
/// from the disk here, and a write refused with [`super::NO_HOLDER`].
pub async fn ask(config: &Path, req: &Request) -> Result<Value, String> {
    match over_socket(config, req).await {
        Some(reply) => reply,
        None => on_disk(config, req.clone()).await,
    }
}

/// [`ask`], read as the op's own answer.
pub async fn ask_as<T: DeserializeOwned>(config: &Path, req: &Request) -> Result<T, String> {
    serde_json::from_value(ask(config, req).await?)
        .map_err(|e| format!("the door's answer could not be read: {e}"))
}

/// `None` when nothing listens (no socket, or a dead holder's file).
#[cfg(unix)]
async fn over_socket(config: &Path, req: &Request) -> Option<Result<Value, String>> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let mut stream = tokio::net::UnixStream::connect(super::socket_path(config))
        .await
        .ok()?;
    let exchange = async {
        let mut line = serde_json::to_string(req).map_err(|e| e.to_string())?;
        line.push('\n');
        stream
            .write_all(line.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        let mut reply = String::new();
        BufReader::new(&mut stream)
            .read_line(&mut reply)
            .await
            .map_err(|e| e.to_string())?;
        if reply.trim().is_empty() {
            return Err("Nightloom closed the connection without answering".to_string());
        }
        let v: Value = serde_json::from_str(&reply).map_err(|e| e.to_string())?;
        match v.get("error").and_then(Value::as_str) {
            Some(e) => Err(e.to_string()),
            None => Ok(v.get("ok").cloned().unwrap_or(Value::Null)),
        }
    };
    Some(exchange.await)
}

#[cfg(not(unix))]
async fn over_socket(_config: &Path, _req: &Request) -> Option<Result<Value, String>> {
    None
}

async fn on_disk(config: &Path, req: Request) -> Result<Value, String> {
    let config = config.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let none = Live::default();
        let v = match req {
            Request::List { project, limit } => {
                serde_json::to_value(super::list(&config, project.as_deref(), limit, &none)?)
            }
            Request::Show { chat, last } => {
                serde_json::to_value(super::show(&config, &chat, last, &none)?)
            }
            Request::Status { .. } => serde_json::to_value(Status::default()),
            Request::Start { .. } | Request::Send { .. } => {
                return Err(if super::access(&config).writes {
                    super::NO_HOLDER.to_string()
                } else {
                    super::WRITES_OFF.to_string()
                });
            }
        };
        v.map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// How a wait ended.
#[derive(Debug, Clone, PartialEq)]
pub enum Waited {
    /// The turn ended and the chat holds its reply (exit 0).
    Replied(ChatView),
    /// It did not get a reply: the sentence why (exit 1).
    Failed(String),
    /// The chat needs him before it can go on (exit 2).
    NeedsHim(ChatView),
    /// Still running when the time was up (exit 3).
    StillRunning(ChatView),
}

impl Waited {
    pub fn exit_code(&self) -> i32 {
        match self {
            Waited::Replied(_) => 0,
            Waited::Failed(_) => 1,
            Waited::NeedsHim(_) => 2,
            Waited::StillRunning(_) => 3,
        }
    }
}

/// Wait for `chat` (a whole id) to stop running. With `after` — the
/// reply count before a message went — the wait is for that message's
/// reply: an idle chat with no new reply is a turn that failed (or, for
/// the first [`START_GRACE`], one not started yet). Without it, any idle
/// moment ends the wait.
pub async fn wait(
    config: &Path,
    chat: &str,
    after: Option<usize>,
    timeout: Duration,
    last: Option<usize>,
) -> Waited {
    wait_with(config, chat, after, timeout, last, POLL, START_GRACE).await
}

pub(crate) async fn wait_with(
    config: &Path,
    chat: &str,
    after: Option<usize>,
    timeout: Duration,
    last: Option<usize>,
    poll: Duration,
    grace: Duration,
) -> Waited {
    let began = Instant::now();
    let show = Request::Show {
        chat: chat.to_string(),
        last,
    };
    let status = Request::Status {
        chat: chat.to_string(),
    };
    let mut seen_running = false;
    let mut misses = 0u32;
    loop {
        match ask_as::<Status>(config, &status).await {
            Err(e) => {
                misses += 1;
                if misses > MAX_MISSES {
                    return Waited::Failed(format!("Nightloom stopped answering: {e}"));
                }
            }
            Ok(s) => {
                misses = 0;
                match s.state {
                    State::Running => seen_running = true,
                    State::Waiting | State::Paused => {
                        return match ask_as::<ChatView>(config, &show).await {
                            Ok(view) => Waited::NeedsHim(view),
                            Err(e) => Waited::Failed(e),
                        };
                    }
                    State::Idle => {
                        let view = match ask_as::<ChatView>(config, &show).await {
                            Ok(view) => view,
                            Err(e) => return Waited::Failed(e),
                        };
                        // The holder may have said "idle" a moment before
                        // the prompt showed: the log's read is the newer.
                        if view.line.state.needs_him() {
                            return Waited::NeedsHim(view);
                        }
                        // Or a turn began between the two calls: its
                        // first lines are not its reply.
                        let began_now = view.line.state == State::Running;
                        seen_running |= began_now;
                        match after {
                            _ if began_now => {}
                            None => return Waited::Replied(view),
                            Some(n) if view.replies > n => return Waited::Replied(view),
                            Some(_) if seen_running => {
                                return Waited::Failed(
                                    "the turn ended without a reply — open the chat in Nightloom to see why".into(),
                                );
                            }
                            Some(_) if began.elapsed() >= grace => {
                                return Waited::Failed(
                                    "the message was taken but no turn started".into(),
                                );
                            }
                            Some(_) => {}
                        }
                    }
                }
            }
        }
        if began.elapsed() >= timeout {
            return match ask_as::<ChatView>(config, &show).await {
                Ok(view) => Waited::StillRunning(view),
                Err(e) => Waited::Failed(e),
            };
        }
        tokio::time::sleep(poll).await;
    }
}
