//! `POST /api/feedback` (nightshift item 805): the phone page's feedback
//! sheet. `{text, chat?, chat_title?, project?, nonce?, images?}` →
//! [`crate::feedback::Sent`] — the same `feedback::send` the Mac's box and
//! the chats' `send_feedback` tool call, so a note from the phone is the
//! same item. Filed in Nightloom's own backlog, picked from the host's
//! Nightshift projects ([`super::Host::nightshift_roots`]) by
//! `feedback::pick`; an `about` an older page sends is ignored (item 816:
//! feedback is only for Nightloom's development). Saved first under the host's
//! [`super::Host::feedback_home`]. A host with neither answers 501.

use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;

use super::Shared;
use super::api::NOT_AVAILABLE;
use crate::feedback::{self, Attachment, Note, Target};

/// The body cap: four full-size images and the words (item 815; the
/// phone's sheet takes at most [`PHONE_IMAGES`]). A note
/// with more or bigger images is refused by its size, not read whole.
/// At most this many images from the phone's sheet (item 815).
pub const PHONE_IMAGES: usize = 4;
const BODY_LIMIT: usize = PHONE_IMAGES * (feedback::MAX_IMAGE_BYTES / 3 * 4) + 512 * 1024;

#[derive(Debug, Deserialize)]
struct FeedbackRequest {
    #[serde(default)]
    text: String,
    /// Item 815: photos or pasted screenshots, base64 (`feature::FEEDBACK_IMAGES`).
    #[serde(default)]
    images: Vec<Attachment>,
    #[serde(default)]
    chat: Option<String>,
    #[serde(default)]
    chat_title: Option<String>,
    #[serde(default)]
    project: Option<String>,
    #[serde(default)]
    nonce: Option<String>,
}

pub(super) fn router() -> Router<Arc<Shared>> {
    Router::new().route(
        "/feedback",
        post(send).layer(DefaultBodyLimit::max(BODY_LIMIT)),
    )
}

async fn send(State(shared): State<Arc<Shared>>, Json(req): Json<FeedbackRequest>) -> Response {
    if req.text.trim().is_empty() && req.images.is_empty() {
        return (StatusCode::BAD_REQUEST, "there is nothing to send").into_response();
    }
    let home = shared.host.feedback_home();
    let roots = shared.host.nightshift_roots().await;
    if home.is_none() && roots.is_empty() {
        return (StatusCode::NOT_IMPLEMENTED, NOT_AVAILABLE).into_response();
    }
    let once = "feedback";
    let nonce = req.nonce.clone();
    match shared.items.claim(once, nonce.as_deref()) {
        super::resent::Seen::First => {}
        super::resent::Seen::Done(json) => {
            return (
                StatusCode::CREATED,
                [("content-type", "application/json")],
                json,
            )
                .into_response();
        }
        super::resent::Seen::Running => {
            return (StatusCode::CONFLICT, "this feedback is being sent now").into_response();
        }
    }
    let targets: Vec<Target> = roots
        .into_iter()
        .map(|r| Target {
            id: r.id,
            name: r.name,
            root: r.root,
        })
        .collect();
    let host_kind = shared.host.kind();
    let note = Note {
        text: req.text,
        surface: if host_kind == "serve" {
            "the phone page (the away server)".into()
        } else {
            "the phone page".into()
        },
        via: "box".into(),
        chat: req.chat,
        chat_title: req.chat_title,
        project: req.project,
        about: None,
        model_note: None,
        model_wording: None,
        words_unchecked: false,
        attach: req.images,
        images: Vec::new(),
    };
    let sent = tokio::task::spawn_blocking(move || feedback::send(home.as_deref(), &targets, note))
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r)
        .and_then(|s| serde_json::to_string(&s).map_err(|e| e.to_string()));
    shared.items.settle(once, nonce.as_deref(), &sent);
    match sent {
        Ok(json) => (
            StatusCode::CREATED,
            [("content-type", "application/json")],
            json,
        )
            .into_response(),
        Err(e) if e.starts_with("no Nightshift project called") => {
            (StatusCode::NOT_FOUND, e).into_response()
        }
        Err(e) => (StatusCode::CONFLICT, e).into_response(),
    }
}
