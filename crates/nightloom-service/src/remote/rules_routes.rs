//! `/api/rules` (nightshift item 743): the allow / ask / block rules in
//! force, listed and changed from the phone — over
//! [`crate::approval_rules`], which is also what the Ask position's hook
//! reads.
//!
//! - `GET /rules?chat=<id>&project=<id>` — the listing: his rules for every
//!   chat on this host and, when a chat is named, that chat's (its "Allow
//!   for this chat" grants among them), in the order they decide, with the
//!   built-in defaults beside them.
//! - `POST /rules?chat=<id>&project=<id>` — one change
//!   ([`crate::approval_rules::Edit`]: `add`, `change`, `remove`), answered
//!   with the listing after it. A refusal is 409 with the sentence the
//!   sheet shows; nothing is written then.
//!
//! The host's part is one lookup — the chat's ask directory
//! ([`super::Host::ask_dir`]); the files are read and written here, so the
//! Mac and the away server cannot drift. Behind the bearer check like
//! every `/api` route; a host that does not name the `rules` feature
//! answers 501.

use std::sync::Arc;

use axum::extract::{RawQuery, State};
use axum::response::Response;
use axum::routing::get;
use axum::{Json, Router};

use super::api::{NOT_AVAILABLE, feature, query_param};
use super::{Shared, answer, refused};
use crate::approval_rules::{self, Edit, Listing, Places};

pub(super) fn router() -> Router<Arc<Shared>> {
    Router::new().route("/rules", get(listing).post(change))
}

/// The two files' places for this request, or the host's refusal.
async fn places(shared: &Shared, query: Option<&str>) -> Result<Places, String> {
    if !shared
        .host
        .features()
        .iter()
        .any(|f| f.as_str() == feature::RULES)
    {
        return Err(NOT_AVAILABLE.into());
    }
    let chat = query_param(query, "chat").filter(|c| !c.trim().is_empty());
    let project = query_param(query, "project").filter(|p| !p.trim().is_empty());
    let chat = match chat {
        Some(c) => Some(shared.host.ask_dir(project.as_deref(), &c).await?),
        None => None,
    };
    Ok(Places {
        all: crate::project::config_dir(),
        chat,
    })
}

async fn listing(State(shared): State<Arc<Shared>>, RawQuery(query): RawQuery) -> Response {
    let places = match places(&shared, query.as_deref()).await {
        Ok(p) => p,
        Err(e) => return refused(e),
    };
    let listed: Result<Listing, String> =
        tokio::task::spawn_blocking(move || approval_rules::list(&places))
            .await
            .map_err(|e| e.to_string());
    answer(listed)
}

async fn change(
    State(shared): State<Arc<Shared>>,
    RawQuery(query): RawQuery,
    Json(edit): Json<Edit>,
) -> Response {
    let places = match places(&shared, query.as_deref()).await {
        Ok(p) => p,
        Err(e) => return refused(e),
    };
    let done = tokio::task::spawn_blocking(move || approval_rules::edit(&places, edit))
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
    answer(done)
}
