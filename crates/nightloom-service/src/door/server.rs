//! The holder's side of the door: the socket, and each call answered over
//! a [`Host`] — the desktop's window or `nightloom serve`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use nightloom_core::ChatKind;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use super::{Live, Request, Sent};
use crate::jobs::Prep;
use crate::remote::Host;

/// A holder's door: the home it serves and the host that runs its turns.
pub struct Door {
    config: PathBuf,
    host: Arc<dyn Host>,
    /// One write at a time: two starts must not interleave their
    /// prepare-then-send, nor their lines in the started list.
    writing: tokio::sync::Mutex<()>,
}

impl Door {
    pub fn new(config: PathBuf, host: Arc<dyn Host>) -> Arc<Self> {
        Arc::new(Self {
            config,
            host,
            writing: tokio::sync::Mutex::new(()),
        })
    }

    /// What the host knows now. `Err` when it could not say (the window
    /// did not answer): a wait must not read that as "idle".
    async fn live(&self) -> Result<Live, String> {
        let running = self.host.running().await?;
        let paused = self.host.limit_pause().await.and_then(|p| {
            let chat = p.chat?;
            let when = p
                .resets_at
                .and_then(|s| chrono::DateTime::from_timestamp(s, 0))
                .map(|at| format!("; the window opens again at {}", super::stamp12(&at)))
                .unwrap_or_default();
            Some((
                chat,
                format!("it stopped at the plan's usage limit{when} — Resume it in Nightloom"),
            ))
        });
        Ok(Live {
            running: running
                .chats
                .into_iter()
                .filter_map(|c| Some((c.chat?, c.waiting)))
                .collect(),
            paused,
            holder: Some(self.host.kind().to_string()),
        })
    }

    /// `live`, or what is known without the host for a read that shows a
    /// log anyway.
    async fn live_or_unknown(&self) -> Live {
        self.live().await.unwrap_or_else(|_| Live {
            holder: Some(self.host.kind().to_string()),
            ..Live::default()
        })
    }

    /// Answer one call: the reply's JSON, or the sentence why not.
    pub async fn answer(&self, req: Request) -> Result<Value, String> {
        match req {
            Request::List { project, limit } => {
                let live = self.live_or_unknown().await;
                let config = self.config.clone();
                json(blocking(move || super::list(&config, project.as_deref(), limit, &live)).await)
            }
            Request::Show { chat, last } => {
                let live = self.live_or_unknown().await;
                let config = self.config.clone();
                json(blocking(move || super::show(&config, &chat, last, &live)).await)
            }
            Request::Status { chat } => json(self.live().await.map(|l| l.status(&chat))),
            Request::Start {
                project,
                text,
                title,
                read_only,
                by,
            } => json(self.start(project, text, title, read_only, by).await),
            Request::Send { chat, text, by: _ } => json(self.send(chat, text).await),
        }
    }

    fn may_write(&self) -> Result<(), String> {
        if super::access(&self.config).writes {
            Ok(())
        } else {
            Err(super::WRITES_OFF.into())
        }
    }

    async fn start(
        &self,
        project: String,
        text: String,
        title: Option<String>,
        read_only: bool,
        by: String,
    ) -> Result<Sent, String> {
        self.may_write()?;
        if text.trim().is_empty() {
            return Err("nothing to send".into());
        }
        let _one = self.writing.lock().await;
        let projects: Vec<(String, String)> = self
            .host
            .projects()
            .await?
            .into_iter()
            .map(|p| (p.id, p.name))
            .collect();
        let (id, name) = super::pick_project(&projects, &project)?;
        let title = title
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| crate::jobs::title_from(&text));
        let chat = self
            .host
            .outside_prepare(Prep {
                project: Some(id.clone()),
                chat: None,
                title,
                read_only,
                auto_hand_off: None,
                model: None,
                connectors: false,
            })
            .await?;
        // Marked before the message goes: the row is never seen unmarked.
        if let Err(e) = super::note_started(&self.config, &chat, &by) {
            eprintln!("door: {chat} started by {by:?}, but the mark was not kept: {e}");
        }
        match self.host.job_send(Some(&id), &chat, &text).await {
            Ok(_) => Ok(Sent {
                chat,
                project: Some(name),
                replies: 0,
            }),
            Err(e) => Err(format!(
                "the chat {chat} was made in {name}, but its first message did not start: {e} — send it again with: chat send {chat} \"…\""
            )),
        }
    }

    async fn send(&self, chat: String, text: String) -> Result<Sent, String> {
        self.may_write()?;
        if text.trim().is_empty() {
            return Err("nothing to send".into());
        }
        let _one = self.writing.lock().await;
        let config = self.config.clone();
        let r = blocking(move || super::read(&config, &chat)).await?;
        if self.live().await?.status(&r.found.id).state != super::State::Idle {
            return Err(super::RUNNING.into());
        }
        let project = r.found.project.clone();
        let id = self
            .host
            .outside_prepare(Prep {
                project: project.as_ref().map(|(id, _)| id.clone()),
                chat: Some(r.found.id.clone()),
                title: r.title.clone(),
                // Its kind is kept as it is: a Chat stays read-only.
                read_only: r.kind == ChatKind::Chat,
                auto_hand_off: None,
                model: None,
                connectors: false,
            })
            .await?;
        self.host
            .job_send(project.as_ref().map(|(id, _)| id.as_str()), &id, &text)
            .await?;
        Ok(Sent {
            chat: id,
            project: project.map(|(_, n)| n),
            replies: r.replies,
        })
    }
}

fn json<T: serde::Serialize>(r: Result<T, String>) -> Result<Value, String> {
    r.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

/// The wire's reply: `{"ok": …}` or `{"error": "…"}`.
pub fn reply_line(r: Result<Value, String>) -> String {
    let v = match r {
        Ok(v) => serde_json::json!({ "ok": v }),
        Err(e) => serde_json::json!({ "error": e }),
    };
    let mut line = v.to_string();
    line.push('\n');
    line
}

/// Bind the door's socket in `config`. `Err` when the home's path is too
/// long for a socket, or the folder cannot be written.
#[cfg(unix)]
pub fn bind(config: &Path) -> Result<std::os::unix::net::UnixListener, String> {
    let path = super::socket_path(config);
    crate::preview::bind_socket(&path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Answer calls on `listener` for as long as the holder lives: any number
/// of lines per connection, each answered in turn.
#[cfg(unix)]
pub async fn serve(listener: std::os::unix::net::UnixListener, door: Arc<Door>) {
    let Ok(listener) = tokio::net::UnixListener::from_std(listener) else {
        return;
    };
    while let Ok((stream, _)) = listener.accept().await {
        let door = Arc::clone(&door);
        tokio::spawn(async move {
            let (read, mut write) = stream.into_split();
            let mut lines = BufReader::new(read).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                let reply = match serde_json::from_str::<Request>(&line) {
                    Ok(req) => door.answer(req).await,
                    Err(e) => Err(format!("not a door request: {e}")),
                };
                if write.write_all(reply_line(reply).as_bytes()).await.is_err() {
                    return;
                }
                let _ = write.flush().await;
            }
        });
    }
}

/// Open the door for this holder: bind now, serve on the runtime the
/// caller is in. The socket's path, or why there is no door.
#[cfg(unix)]
pub fn open(config: &Path, host: Arc<dyn Host>) -> Result<PathBuf, String> {
    let listener = bind(config)?;
    tokio::spawn(serve(listener, Door::new(config.to_path_buf(), host)));
    Ok(super::socket_path(config))
}

#[cfg(not(unix))]
pub fn open(_config: &Path, _host: Arc<dyn Host>) -> Result<PathBuf, String> {
    Err("the door needs a Unix socket".into())
}
