//! A typed link's card on the phone (nightshift item 993f): the sheet's
//! reads and his taps, run on the Mac.
//!
//! | Route | What |
//! |---|---|
//! | `GET /home/ref/reach` | the accounts Home reaches, as the last check left them (nothing is run) |
//! | `POST /home/ref/read` | `{item}`: an email's own headers (the read-only `get_message`), for who a mail goes to |
//! | `POST /home/ref/tap` | `{item, act}`: his press on the sheet's confirm → `{tap, hold_ms}` ([`crate::ref_gate`]) |
//! | `POST /home/ref/act` | `{tap, item, act}`: the tap let go (for a mail, after its hold) → the receipt |
//! | `POST /home/ref/undo` | `{tap}`: his Undo; the tap goes |
//! | `POST /home/ref/lock` | `{key}`: `{maybe, going, held}` — the "may have gone" lock and whether a send is on its way |
//! | `POST /home/ref/checked` | `{key}`: he checked Gmail's Sent; the lock goes |
//!
//! **Nothing here sends without his tap** (blocker 2304): `/act` runs
//! only a call a live, unspent tap was minted for — the same tool, every
//! pinned argument, the same words — and the Mac then runs 993d/993e's
//! path unchanged (one pass, the hook, the send guard). A host without the
//! Mac's runner (the away server) refuses all but `reach` and `lock`.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use super::api::NOT_AVAILABLE;
use super::{Shared, answer, bad};
use crate::ref_action::{self, Act, Item};
use crate::ref_gate;

pub(super) fn router() -> Router<Arc<Shared>> {
    Router::new()
        .route("/home/ref/reach", get(reach))
        .route("/home/ref/read", post(read))
        .route("/home/ref/tap", post(tap))
        .route("/home/ref/act", post(act))
        .route("/home/ref/undo", post(undo))
        .route("/home/ref/lock", post(lock))
        .route("/home/ref/checked", post(checked))
}

#[derive(Serialize)]
struct Reach {
    checked_at: Option<String>,
    error: Option<String>,
    accounts: Vec<crate::home::reach::Account>,
    locals: Vec<serde_json::Value>,
}

async fn reach(State(shared): State<Arc<Shared>>) -> Response {
    let Some(config) = shared.host.home_config() else {
        return answer::<()>(Err(NOT_AVAILABLE.into()));
    };
    let last = crate::home::reach::load(&config);
    Json(Reach {
        checked_at: last.checked_at.map(|t| t.to_rfc3339()),
        error: last.error,
        accounts: crate::home::reach::accounts(&config),
        locals: Vec::new(),
    })
    .into_response()
}

#[derive(Deserialize)]
struct ReadBody {
    item: Item,
}

async fn read(State(shared): State<Arc<Shared>>, Json(b): Json<ReadBody>) -> Response {
    if !shared.host.ref_acts() {
        return answer::<()>(Err(NOT_AVAILABLE.into()));
    }
    answer(shared.host.ref_read(b.item).await)
}

#[derive(Deserialize)]
struct TapBody {
    item: Item,
    act: Act,
}

/// Refused before anything is minted or run.
fn no(why: String) -> Response {
    (StatusCode::FORBIDDEN, why).into_response()
}

async fn tap(State(shared): State<Arc<Shared>>, Json(b): Json<TapBody>) -> Response {
    if !shared.host.ref_acts() {
        return answer::<()>(Err(NOT_AVAILABLE.into()));
    }
    let call = match ref_action::call_for(&b.item, &b.act) {
        Ok(c) => c,
        Err(e) => return bad(e),
    };
    let key = ref_action::item_key(&b.item);
    if ref_gate::is_mail(&call)
        && let Some(why) = shared
            .host
            .home_config()
            .and_then(|c| ref_gate::maybe_of(&c, &key))
    {
        return no(format!("It may have gone already: {why}"));
    }
    match ref_gate::with(|g| g.tap(&key, &call, chrono::Utc::now())) {
        Ok(t) => Json(t).into_response(),
        Err(e) => no(e),
    }
}

#[derive(Deserialize)]
struct ActBody {
    /// The tap `/tap` gave for exactly this call. Without one, nothing runs.
    #[serde(default)]
    tap: Option<String>,
    item: Item,
    act: Act,
}

async fn act(State(shared): State<Arc<Shared>>, Json(b): Json<ActBody>) -> Response {
    if !shared.host.ref_acts() {
        return answer::<()>(Err(NOT_AVAILABLE.into()));
    }
    let call = match ref_action::call_for(&b.item, &b.act) {
        Ok(c) => c,
        Err(e) => return bad(e),
    };
    let key = ref_action::item_key(&b.item);
    let Some(tap) = b.tap.filter(|t| !t.is_empty()) else {
        return no(ref_gate::NO_TAP.into());
    };
    if let Err(e) = ref_gate::with(|g| g.redeem(&tap, &key, &call, chrono::Utc::now())) {
        return no(e);
    }
    let out = shared.host.ref_act(b.item, b.act).await;
    let done = matches!(&out, Ok(r) if r.outcome == "done");
    ref_gate::with(|g| g.end(&key, done, chrono::Utc::now()));
    if let (Ok(r), Some(config)) = (&out, shared.host.home_config())
        && r.outcome == "unknown"
        && ref_gate::is_mail(&call)
    {
        ref_gate::maybe_mark(&config, &key, &r.text);
    }
    answer(out)
}

#[derive(Deserialize)]
struct UndoBody {
    tap: String,
}

async fn undo(Json(b): Json<UndoBody>) -> Response {
    ref_gate::with(|g| g.undo(&b.tap));
    StatusCode::NO_CONTENT.into_response()
}

#[derive(Deserialize)]
struct KeyBody {
    key: String,
}

#[derive(Serialize)]
struct Lock {
    maybe: Option<String>,
    going: bool,
    held: bool,
}

async fn lock(State(shared): State<Arc<Shared>>, Json(b): Json<KeyBody>) -> Response {
    let maybe = shared
        .host
        .home_config()
        .and_then(|c| ref_gate::maybe_of(&c, &b.key));
    let (going, held) = ref_gate::with(|g| g.busy(&b.key, chrono::Utc::now()));
    Json(Lock { maybe, going, held }).into_response()
}

async fn checked(State(shared): State<Arc<Shared>>, Json(b): Json<KeyBody>) -> Response {
    if let Some(c) = shared.host.home_config() {
        ref_gate::maybe_clear(&c, &b.key);
    }
    StatusCode::NO_CONTENT.into_response()
}
