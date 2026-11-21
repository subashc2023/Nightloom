//! `/api/shortcut/…` (nightshift item 744): two routes shaped for Apple's
//! Shortcuts app, so a Shortcut on his iPhone — run by Siri, the Action
//! Button or the Lock Screen — can reach Nightloom without the page.
//!
//! - `POST /shortcut/send` — `{ "text": "…", "chat": "optional name" }`:
//!   the dictated message goes to the chat named (the most recent whose
//!   name matches, ignoring case: an exact match first, then one that
//!   starts with it, then one that holds it), or with no name to the last
//!   chat — the one open on the Mac, else the one he wrote in last. The
//!   answer is one plain sentence a Shortcut can speak ("Sent to Scorer
//!   review."); a refusal is the usual 409 with its sentence, an unknown
//!   name a 404 that says so.
//! - `GET /shortcut/running` — one plain sentence of what runs now: the
//!   chats with a turn running, how long each has run, and the approvals
//!   waiting ("Nothing is running." when nothing is).
//!
//! Plain text, not JSON: Shortcuts' *Get Contents of URL* hands the body
//! straight to *Speak Text* or *Show Result*. Both routes sit behind the
//! same bearer check as every `/api` route — the Shortcut carries the
//! token as an `Authorization: Bearer …` header (docs/remote.md
//! "Siri and the Action Button"). Nothing here runs a turn in Rust: the
//! send is the host's own `send_with`, as the phone page's is.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;

use super::api::{NOT_AVAILABLE, Running};
use super::{ChatRow, Handed, SendRequest, Shared};

pub(super) fn router() -> Router<Arc<Shared>> {
    Router::new()
        .route("/shortcut/send", post(send))
        .route("/shortcut/running", get(running))
}

/// The Shortcut's body: the dictated text and, optionally, a chat's name.
#[derive(Debug, Clone, Deserialize)]
pub struct ShortcutSend {
    pub text: String,
    #[serde(default)]
    pub chat: Option<String>,
}

fn say(status: StatusCode, sentence: impl Into<String>) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        sentence.into(),
    )
        .into_response()
}

/// The newest of a row's two clocks: when he last wrote, else the file's.
fn recency(r: &ChatRow) -> chrono::DateTime<chrono::Utc> {
    r.last_message.unwrap_or(r.modified)
}

/// The chat a Shortcut means. `name` empty or absent: `active` (the chat
/// open on the Mac) when it is listed, else the most recent row. A name:
/// the most recent row whose label equals it, else starts with it, else
/// holds it, ignoring case and surrounding spaces. `Err` is the sentence
/// to speak. Pure.
pub fn resolve_chat<'a>(
    rows: &'a [ChatRow],
    active: Option<&str>,
    name: Option<&str>,
) -> Result<&'a ChatRow, String> {
    let want = name.map(|n| n.trim().to_lowercase()).unwrap_or_default();
    let newest = |pred: &dyn Fn(&ChatRow) -> bool| {
        rows.iter().filter(|r| pred(r)).max_by_key(|r| recency(r))
    };
    if want.is_empty() {
        if let Some(a) = active
            && let Some(r) = rows.iter().find(|r| r.id == a)
        {
            return Ok(r);
        }
        return newest(&|_| true).ok_or_else(|| "There is no chat to send to.".to_string());
    }
    let label = |r: &ChatRow| r.label.trim().to_lowercase();
    newest(&|r| label(r) == want)
        .or_else(|| newest(&|r| label(r).starts_with(&want)))
        .or_else(|| newest(&|r| label(r).contains(&want)))
        .ok_or_else(|| format!("No chat is called “{}”.", name.unwrap_or_default().trim()))
}

/// "4 minutes", "1 hour 5 minutes", "under a minute". Pure.
fn spoken_span(ms: i64) -> String {
    let min = (ms.max(0) / 60_000) as u64;
    let plural = |n: u64, w: &str| {
        if n == 1 {
            format!("1 {w}")
        } else {
            format!("{n} {w}s")
        }
    };
    match min {
        0 => "under a minute".into(),
        m if m < 60 => plural(m, "minute"),
        m if m % 60 == 0 => plural(m / 60, "hour"),
        m => format!("{} {}", plural(m / 60, "hour"), plural(m % 60, "minute")),
    }
}

/// What runs, as one sentence for Siri to speak. `pending` is the open
/// chat's approvals the host's state reports, counted when no running row
/// carries its own. Pure.
pub fn running_sentence(run: &Running, pending: usize, now_ms: i64) -> String {
    if run.chats.is_empty() {
        return if pending > 0 {
            format!(
                "Nothing is running, but {} waiting for you.",
                if pending == 1 {
                    "1 approval is".to_string()
                } else {
                    format!("{pending} approvals are")
                }
            )
        } else {
            "Nothing is running.".into()
        };
    }
    let parts: Vec<String> = run
        .chats
        .iter()
        .map(|c| {
            let title = if c.title.trim().is_empty() {
                "a new chat"
            } else {
                c.title.trim()
            };
            let mut s = title.to_string();
            if let Some(since) = c.since {
                s.push_str(&format!(", {} in", spoken_span(now_ms - since)));
            }
            let waiting = if c.waiting > 0 {
                c.waiting
            } else if c.on_screen {
                pending
            } else {
                0
            };
            if waiting > 0 {
                s.push_str(&format!(
                    ", waiting on {}",
                    if waiting == 1 {
                        "1 approval".to_string()
                    } else {
                        format!("{waiting} approvals")
                    }
                ));
            }
            s
        })
        .collect();
    let n = parts.len();
    let head = if n == 1 {
        "1 chat is running".to_string()
    } else {
        format!("{n} chats are running")
    };
    format!("{head}: {}.", parts.join("; "))
}

async fn send(State(shared): State<Arc<Shared>>, Json(req): Json<ShortcutSend>) -> Response {
    let text = req.text.trim();
    if text.is_empty() {
        return say(StatusCode::BAD_REQUEST, "There was nothing to send.");
    }
    let state = shared.host.state().await;
    let rows = match shared.host.chats(None).await {
        Ok(r) => r,
        Err(e) => return say(StatusCode::CONFLICT, e),
    };
    let target = match resolve_chat(&rows, state.active_chat.as_deref(), req.chat.as_deref()) {
        Ok(r) => r,
        Err(e) => return say(StatusCode::NOT_FOUND, e),
    };
    let label = target.label.trim().to_string();
    let send = SendRequest {
        text: text.to_string(),
        ..Default::default()
    };
    match shared.host.send_with(Some(&target.id), send).await {
        Ok(Handed::Sent) => say(StatusCode::ACCEPTED, format!("Sent to {label}.")),
        Ok(Handed::Queued) => say(
            StatusCode::ACCEPTED,
            format!("Queued in {label}; it goes when the running turn ends."),
        ),
        Err(e) if e == NOT_AVAILABLE => say(StatusCode::NOT_IMPLEMENTED, e),
        Err(e) => say(StatusCode::CONFLICT, e),
    }
}

async fn running(State(shared): State<Arc<Shared>>) -> Response {
    let state = shared.host.state().await;
    let now = chrono::Utc::now().timestamp_millis();
    match shared.host.running().await {
        Ok(run) => say(
            StatusCode::OK,
            running_sentence(&run, state.pending.len(), now),
        ),
        // A host without the Running sheet: what its state knows.
        Err(e) if e == NOT_AVAILABLE => say(
            StatusCode::OK,
            if state.busy {
                "The open chat is running a turn."
            } else {
                "Nothing is running."
            },
        ),
        Err(e) => say(StatusCode::CONFLICT, e),
    }
}

#[cfg(test)]
mod tests {
    use super::super::api::RunningChat;
    use super::*;

    fn row(id: &str, label: &str, mins_ago: i64) -> ChatRow {
        ChatRow {
            id: id.into(),
            label: label.into(),
            modified: chrono::Utc::now() - chrono::Duration::minutes(mins_ago),
            user_turns: 1,
            kind: "build".into(),
            mode: "normal".into(),
            last_message: None,
        }
    }

    #[test]
    fn a_shortcut_with_no_name_goes_to_the_open_chat_else_the_newest() {
        let rows = vec![row("a", "Scorer review", 5), row("b", "Signup flow", 1)];
        assert_eq!(resolve_chat(&rows, Some("a"), None).unwrap().id, "a");
        assert_eq!(resolve_chat(&rows, Some("a"), Some("  ")).unwrap().id, "a");
        assert_eq!(resolve_chat(&rows, None, None).unwrap().id, "b");
        assert_eq!(resolve_chat(&rows, Some("gone"), None).unwrap().id, "b");
        assert!(resolve_chat(&[], None, None).is_err());
    }

    #[test]
    fn a_name_matches_exactly_then_by_start_then_inside_newest_first() {
        let rows = vec![
            row("a", "Scorer review", 5),
            row("b", "Scorer review, part 2", 1),
            row("c", "The signup flow", 9),
        ];
        assert_eq!(
            resolve_chat(&rows, None, Some("scorer REVIEW")).unwrap().id,
            "a"
        );
        assert_eq!(resolve_chat(&rows, None, Some("scorer")).unwrap().id, "b");
        assert_eq!(resolve_chat(&rows, None, Some("signup")).unwrap().id, "c");
        assert_eq!(
            resolve_chat(&rows, None, Some("budget")).unwrap_err(),
            "No chat is called “budget”."
        );
    }

    #[test]
    fn running_reads_as_one_sentence() {
        let now = 1_800_000_000_000;
        assert_eq!(
            running_sentence(&Running::default(), 0, now),
            "Nothing is running."
        );
        assert_eq!(
            running_sentence(&Running::default(), 2, now),
            "Nothing is running, but 2 approvals are waiting for you."
        );
        let run = Running {
            chats: vec![
                RunningChat {
                    chat: Some("a".into()),
                    project: None,
                    title: "Scorer review".into(),
                    since: Some(now - 4 * 60_000 - 5_000),
                    on_screen: true,
                    waiting: 0,
                },
                RunningChat {
                    chat: None,
                    project: None,
                    title: "".into(),
                    since: Some(now - 65 * 60_000),
                    on_screen: false,
                    waiting: 1,
                },
            ],
            ..Default::default()
        };
        assert_eq!(
            running_sentence(&run, 1, now),
            "2 chats are running: Scorer review, 4 minutes in, waiting on 1 approval; a new chat, 1 hour 5 minutes in, waiting on 1 approval."
        );
    }
}
