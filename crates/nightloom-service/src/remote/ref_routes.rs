//! A typed link's card on the phone (nightshift item 993f): the sheet's
//! reads and his taps, run on the Mac.
//!
//! | Route | What |
//! |---|---|
//! | `GET /home/ref/reach` | the accounts Home reaches, as the last check left them (nothing is run) |
//! | `POST /home/ref/read` | `{item}`: an email's own headers (the read-only `get_message`), for who a mail goes to |
//! | `POST /home/ref/key` | `{public}`: where this phone's key stands → `{state: allowed \| waiting \| none, id, code?}` |
//! | `POST /home/ref/enroll` | `{public, name}`: the phone asks to be allowed; the Mac shows the ask (the code only the phone shows; he types it on the Mac). Allows nothing. One new ask a minute, five a day, per bearer; refused while three wait |
//! | `POST /home/ref/tap` | `{item, act, key}`: his press on the sheet's confirm, from an allowed phone → `{tap, challenge, hold_ms}` ([`crate::ref_gate`]) |
//! | `POST /home/ref/act` | `{tap, item, act, sig}`: the tap let go (for a mail, after its hold), signed by that phone → the receipt |
//! | `POST /home/ref/undo` | `{tap}`: his Undo; the tap goes |
//! | `POST /home/ref/lock` | `{key, mark?}`: `{maybe, going, held}` (a `mark` is kept first) — the "may have gone" lock and whether a send is on its way. Only ever adds a lock |
//! | `POST /home/ref/checking` | `{key, phone}`: a one-time challenge for an allowed phone's "I checked" |
//! | `POST /home/ref/checked` | `{key, phone, challenge, sig}`: he checked Gmail's Sent, signed by that phone over the item and the challenge; the lock goes |
//!
//! **Nothing here sends without his tap** (blocker 2304): `/act` runs
//! only a call a live, unspent tap was minted for — the same tool, every
//! pinned argument, the same words — and the Mac then runs 993d/993e's
//! path unchanged (one pass, the hook, the send guard). A host without the
//! Mac's runner (the away server) refuses all but `reach` and `lock`.
//!
//! **The bearer alone taps nothing** (item 993g, blocker 2359): it is one
//! secret shared by every phone and kept on the Mac, so a process on the
//! Mac could hold it. `/tap` mints only for a phone he allowed, and `/act`
//! runs only with that phone's signature over the tap and its challenge
//! ([`crate::phone_keys`]). **No route here allows a phone**: `/enroll`
//! asks, and the Allow is his click in the Mac's window.

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
        .route("/home/ref/key", post(key))
        .route("/home/ref/enroll", post(enroll))
        .route("/home/ref/tap", post(tap))
        .route("/home/ref/act", post(act))
        .route("/home/ref/undo", post(undo))
        .route("/home/ref/lock", post(lock))
        .route("/home/ref/checking", post(checking))
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
struct PhoneBody {
    /// The phone's public key: the uncompressed P-256 point, base64url.
    public: String,
    /// What the phone calls itself, for the Mac's list.
    #[serde(default)]
    name: String,
}

/// The phones of this host, read (the first time, from the Keychain, off
/// the async threads); or the refusal for a host that has none, or whose
/// store could not be read: then nothing is allowed.
async fn keys_of(shared: &Shared) -> Result<Arc<crate::phone_keys::Keys>, Box<Response>> {
    let none = || Box::new(answer::<()>(Err(NOT_AVAILABLE.into())));
    if !shared.host.ref_acts() {
        return Err(none());
    }
    let keys = shared.host.phone_keys().ok_or_else(none)?;
    let k = keys.clone();
    match tokio::task::spawn_blocking(move || k.allowed().map(|_| ())).await {
        Ok(Ok(())) => Ok(keys),
        Ok(Err(e)) => Err(Box::new(no(e))),
        Err(e) => Err(Box::new(no(e.to_string()))),
    }
}

async fn key(State(shared): State<Arc<Shared>>, Json(b): Json<PhoneBody>) -> Response {
    let keys = match keys_of(&shared).await {
        Ok(k) => k,
        Err(r) => return *r,
    };
    if let Err(e) = crate::phone_keys::key_id(&b.public) {
        return bad(e);
    }
    answer(keys.standing(&b.public, chrono::Utc::now()))
}

/// The phone asks to be allowed. The ask waits on the Mac; nothing here,
/// and no other route, allows it.
async fn enroll(State(shared): State<Arc<Shared>>, Json(b): Json<PhoneBody>) -> Response {
    let keys = match keys_of(&shared).await {
        Ok(k) => k,
        Err(r) => return *r,
    };
    if let Err(e) = crate::phone_keys::key_id(&b.public) {
        return bad(e);
    }
    match keys.ask_over_listener(&shared.token, &b.public, &b.name, chrono::Utc::now()) {
        Ok((standing, new)) => {
            if let Some(ask) = new {
                shared.host.phone_key_asked(&ask);
            }
            Json(standing).into_response()
        }
        Err(crate::phone_keys::Refused::Limit(e)) => {
            (StatusCode::TOO_MANY_REQUESTS, e).into_response()
        }
        Err(crate::phone_keys::Refused::Store(e)) => answer::<()>(Err(e)),
    }
}

#[derive(Deserialize)]
struct TapBody {
    item: Item,
    act: Act,
    /// The id of this phone's key ([`crate::phone_keys::key_id`]). Without
    /// an allowed one, no tap is minted.
    #[serde(default)]
    key: Option<String>,
}

/// Refused before anything is minted or run.
fn no(why: String) -> Response {
    (StatusCode::FORBIDDEN, why).into_response()
}

async fn tap(State(shared): State<Arc<Shared>>, Json(b): Json<TapBody>) -> Response {
    let keys = match keys_of(&shared).await {
        Ok(k) => k,
        Err(r) => return *r,
    };
    let phone = b.key.unwrap_or_default();
    match keys.is_allowed(&phone) {
        Ok(true) => {}
        Ok(false) => return no(crate::phone_keys::NOT_ALLOWED.into()),
        // The Keychain could not be read: nothing is allowed.
        Err(e) => return no(e),
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
    match ref_gate::with(|g| g.tap(&key, &call, &phone, chrono::Utc::now())) {
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
    /// The phone's signature over the tap and its challenge (base64url).
    /// Without the allowed phone's own, nothing runs (993g).
    #[serde(default)]
    sig: Option<String>,
}

async fn act(State(shared): State<Arc<Shared>>, Json(b): Json<ActBody>) -> Response {
    let keys = match keys_of(&shared).await {
        Ok(k) => k,
        Err(r) => return *r,
    };
    let call = match ref_action::call_for(&b.item, &b.act) {
        Ok(c) => c,
        Err(e) => return bad(e),
    };
    let key = ref_action::item_key(&b.item);
    let Some(tap) = b.tap.filter(|t| !t.is_empty()) else {
        return no(ref_gate::NO_TAP.into());
    };
    // The keys are read again here, so a phone he removed during a hold
    // sends nothing.
    let sig = b.sig.unwrap_or_default();
    let signed = |phone: &str, message: &str| keys.verify(phone, message, &sig);
    let run = match ref_gate::with(|g| g.redeem(&tap, &key, &call, chrono::Utc::now(), signed)) {
        Ok(run) => run,
        Err(e) => return no(e),
    };
    // If the phone's connection drops now, this future is dropped mid-call
    // and the lines after the await never run: the guard then settles the
    // item (no longer going; a mail locked as "may have gone") once the
    // hold and the call's deadline have passed (review finding 4).
    let going = ref_gate::Going::new(
        &key,
        run,
        shared.host.home_config(),
        ref_gate::is_mail(&call),
    );
    let out = shared.host.ref_act(b.item, b.act).await;
    going.ended();
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
    /// The other screen's own "may have gone" for this item, not yet told
    /// to the Mac (the phone lost the Mac as a mail went): kept first.
    #[serde(default)]
    mark: Option<String>,
}

#[derive(Serialize)]
struct Lock {
    maybe: Option<String>,
    going: bool,
    held: bool,
}

async fn lock(State(shared): State<Arc<Shared>>, Json(b): Json<KeyBody>) -> Response {
    let config = shared.host.home_config();
    if let (Some(c), Some(why)) = (&config, b.mark.as_deref().filter(|w| !w.is_empty())) {
        ref_gate::maybe_mark(c, &b.key, why);
    }
    let maybe = config.and_then(|c| ref_gate::maybe_of(&c, &b.key));
    let (going, held) = ref_gate::with(|g| g.busy(&b.key, chrono::Utc::now()));
    Json(Lock { maybe, going, held }).into_response()
}

#[derive(Deserialize)]
struct CheckingBody {
    key: String,
    /// The id of this phone's key: only an allowed phone gets a challenge.
    #[serde(default)]
    phone: String,
}

#[derive(Serialize)]
struct Checking {
    challenge: String,
}

/// An allowed phone's "I checked: not sent", first half: a one-time
/// challenge for it to sign (review 2026-11-27, finding 3).
async fn checking(State(shared): State<Arc<Shared>>, Json(b): Json<CheckingBody>) -> Response {
    let keys = match keys_of(&shared).await {
        Ok(k) => k,
        Err(r) => return *r,
    };
    match keys.is_allowed(&b.phone) {
        Ok(true) => {}
        Ok(false) => return no(crate::phone_keys::NOT_ALLOWED.into()),
        Err(e) => return no(e),
    }
    let challenge = ref_gate::with(|g| g.check(&b.key, &b.phone, chrono::Utc::now()));
    Json(Checking { challenge }).into_response()
}

#[derive(Deserialize)]
struct CheckedBody {
    key: String,
    #[serde(default)]
    phone: String,
    #[serde(default)]
    challenge: String,
    /// The phone's signature over the item and the challenge.
    #[serde(default)]
    sig: String,
}

/// He checked Gmail's Sent, on an allowed phone: the lock goes. **The
/// bearer alone clears nothing** (review finding 3): without that phone's
/// signature over this item and a live challenge, the lock stays.
async fn checked(State(shared): State<Arc<Shared>>, Json(b): Json<CheckedBody>) -> Response {
    let keys = match keys_of(&shared).await {
        Ok(k) => k,
        Err(r) => return *r,
    };
    let Some(phone) = ref_gate::with(|g| g.take_check(&b.challenge, &b.key, chrono::Utc::now()))
        .filter(|p| *p == b.phone)
    else {
        return no(
            "No check of yours from an allowed phone stands behind this, so the lock stays.".into(),
        );
    };
    let message = crate::phone_keys::checked_message(&b.key, &b.challenge);
    if let Err(e) = keys.verify(&phone, &message, &b.sig) {
        return no(e);
    }
    if let Some(c) = shared.host.home_config() {
        ref_gate::maybe_clear(&c, &b.key);
    }
    StatusCode::NO_CONTENT.into_response()
}
