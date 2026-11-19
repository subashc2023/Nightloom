//! Home's sources on this Mac, from the phone (nightshift item 808):
//!
//! - `GET /home/sources` — `[{id, name, status, on, why, settings_url}]`
//!   for Messages, Contacts, Reminders and the Calendar app
//!   ([`crate::home::sources::Row`]). A host that does not read them (the
//!   away server) answers every one "not on this Mac".
//! - `POST /home/sources/{id}/ask` — `{said}`: the Mac shows its Allow for
//!   that source (Settings → Home opened at the row). The macOS dialog
//!   itself opens only when he presses Allow on the Mac, never from here.
//!
//! Home's Start cards (item 763 H5, [`crate::home::route`]):
//!
//! - `GET /home/routes` — `{cards, held, started}`: the routes waiting for
//!   his tap, oldest first; the ones waiting on something else (a closed
//!   project, a night run); and the chats Home started (the lists' mark).
//! - `POST /home/routes/{id}/start` — `{prompt?, pick?}`: his tap. The
//!   prompt as he left it; `pick` (`new` | `into`) on a cold card. The
//!   route as it is after the host was asked to start it.
//! - `POST /home/routes/{id}/dismiss` — the card goes; nothing starts.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use super::{Shared, answer, bad};
use crate::home::route::{self, Pick, Route};
use crate::home::sources::Source;

pub(super) fn router() -> Router<Arc<Shared>> {
    Router::new()
        .route("/home/sources", get(list))
        .route("/home/sources/{id}/ask", post(ask))
        .route("/home/routes", get(routes))
        .route("/home/routes/{id}/start", post(route_start))
        .route("/home/routes/{id}/dismiss", post(route_dismiss))
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

/// `GET /home/routes`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RoutesReply {
    pub cards: Vec<Route>,
    /// Routes that need nothing from him but cannot start yet (a project
    /// that is not open, a night run going in it), each with why.
    #[serde(default)]
    pub held: Vec<Route>,
    /// The chats a route of Home's began.
    pub started: Vec<String>,
    /// The chats a route of Home's is running now (item 872): the only
    /// chats Run's Stop now may stop — never one a task's data merely
    /// names. An older host sends none.
    #[serde(default)]
    pub running: Vec<String>,
}

/// The reply from the folder. Pure apart from reading `config`.
pub fn routes_reply(config: &std::path::Path) -> RoutesReply {
    RoutesReply {
        cards: route::cards(config),
        held: route::held(config),
        started: route::started_by_home(config),
        running: route::running_chats(config),
    }
}

async fn routes(State(shared): State<Arc<Shared>>) -> Response {
    answer(
        shared
            .host
            .home_config()
            .map(|c| routes_reply(&c))
            .ok_or_else(|| super::api::NOT_AVAILABLE.to_string()),
    )
}

/// His tap's body.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct StartBody {
    prompt: Option<String>,
    pick: Option<Pick>,
}

async fn route_start(
    State(shared): State<Arc<Shared>>,
    Path(id): Path<String>,
    body: Option<Json<StartBody>>,
) -> Response {
    let body = body.map(|Json(b)| b).unwrap_or_default();
    answer(
        route::confirm_and_run(
            shared.host.as_ref(),
            &id,
            body.prompt.as_deref(),
            body.pick,
            chrono::Utc::now(),
        )
        .await,
    )
}

async fn route_dismiss(State(shared): State<Arc<Shared>>, Path(id): Path<String>) -> Response {
    answer(match shared.host.home_config() {
        Some(config) => route::dismiss(&config, &id, chrono::Utc::now()),
        None => Err(super::api::NOT_AVAILABLE.to_string()),
    })
}
