//! `GET /api/saved-prompts` (nightshift item 800): the saved message
//! prompts the phone's boxes offer after a `/` — the live ones, name and
//! body, in the order Settings lists them ([`crate::saved_prompts`]). Read
//! only: the Mac's Settings is where they are written. A host with no
//! config directory answers 501, like every feature it does not serve.

use std::sync::Arc;

use axum::Router;
use axum::extract::State;
use axum::response::Response;
use axum::routing::get;
use serde::Serialize;

use super::api::NOT_AVAILABLE;
use super::{Shared, answer, refused};
use crate::saved_prompts::{self, Offered};

pub(super) fn router() -> Router<Arc<Shared>> {
    Router::new().route("/saved-prompts", get(listing))
}

/// The body: `{ "prompts": [{ "name": "wrapup", "body": "…" }] }`.
#[derive(Debug, Serialize)]
pub struct Listing {
    pub prompts: Vec<Offered>,
}

async fn listing(State(shared): State<Arc<Shared>>) -> Response {
    let Some(dir) = shared.host.saved_prompts_home() else {
        return refused(NOT_AVAILABLE.into());
    };
    answer(
        tokio::task::spawn_blocking(move || saved_prompts::offered(&dir))
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r)
            .map(|prompts| Listing { prompts }),
    )
}
