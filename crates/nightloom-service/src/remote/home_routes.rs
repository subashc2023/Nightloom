//! Home's sources on this Mac, from the phone (nightshift item 808):
//!
//! - `GET /home/sources` — `[{id, name, status, on, why, settings_url}]`
//!   for Messages, Contacts, Reminders and the Calendar app
//!   ([`crate::home::sources::Row`]). A host that does not read them (the
//!   away server) answers every one "not on this Mac".
//! - `POST /home/sources/{id}/ask` — `{said}`: the Mac shows its Allow for
//!   that source (Settings → Home opened at the row). The macOS dialog
//!   itself opens only when he presses Allow on the Mac, never from here.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;

use super::{Shared, answer, bad};
use crate::home::sources::Source;

pub(super) fn router() -> Router<Arc<Shared>> {
    Router::new()
        .route("/home/sources", get(list))
        .route("/home/sources/{id}/ask", post(ask))
}

async fn list(State(shared): State<Arc<Shared>>) -> Response {
    Json(shared.host.home_sources().await).into_response()
}

#[derive(Serialize)]
struct Asked {
    said: String,
}

async fn ask(State(shared): State<Arc<Shared>>, Path(id): Path<String>) -> Response {
    let Some(source) = Source::parse(&id) else {
        return bad(format!("no source {id}"));
    };
    answer(
        shared
            .host
            .home_source_ask(source)
            .await
            .map(|said| Asked { said }),
    )
}
