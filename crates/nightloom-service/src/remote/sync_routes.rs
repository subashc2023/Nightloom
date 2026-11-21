//! `/api/sync/*`: the away server's half of the Mac ↔ server sync
//! (nightshift item 268 step 3; `crate::sync`).
//!
//! Merged into the listener's `/api` router *inside* the bearer layer, so
//! every route here needs the same token as the phone's. Present only on a
//! host that has a sync home ([`super::Host::sync`] — `serve`); on the
//! desktop the router is empty and every path is the API's 404.
//!
//! | Route | What |
//! |---|---|
//! | `POST /sync/manifest` | the Mac's manifest → `{need, removed}` |
//! | `PUT /sync/files/{*path}` | one file, its SHA-256 in `x-nightloom-sha256` |
//! | `GET /sync/outbox` | server chats the Mac has not taken down |
//! | `GET /sync/outbox/{chat}/log` | one outbox chat's Nightloom log |
//! | `GET /sync/outbox/{chat}/cli` | its Claude Code session file |
//! | `POST /sync/ack` | `{chats}`: these are on the Mac now |
//! | `POST /sync/lease` | `{job, due}`: may the Mac run it (item 781, `sync::lease`) |
//! | `POST /sync/jobs` | the Mac's away jobs, whole (item 781) |
//!
//! Every request here marks the Mac as heard from ([`crate::sync::lease::mac_seen`]).

use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};

use crate::sync::manifest::Manifest;
use crate::sync::mirror::{AckRequest, PutError};
use crate::sync::{SHA_HEADER, SyncServer};

/// The largest single file the Mac may send: a long chat's CLI session
/// file runs to tens of megabytes.
pub const FILE_LIMIT: usize = 512 * 1024 * 1024;
/// The largest manifest: ~150 bytes an entry.
pub const MANIFEST_LIMIT: usize = 32 * 1024 * 1024;

/// The sync routes over `sync`, or none when this host has no sync home.
pub fn router<S>(sync: Option<Arc<SyncServer>>) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    let Some(sync) = sync else {
        return Router::new();
    };
    Router::new()
        .route(
            "/sync/manifest",
            post(manifest).layer(DefaultBodyLimit::max(MANIFEST_LIMIT)),
        )
        .route(
            "/sync/files/{*path}",
            put(file).layer(DefaultBodyLimit::max(FILE_LIMIT)),
        )
        .route("/sync/outbox", get(outbox))
        .route("/sync/outbox/{chat}/log", get(outbox_log))
        .route("/sync/outbox/{chat}/cli", get(outbox_cli))
        .route("/sync/ack", post(ack))
        .route("/sync/lease", post(lease))
        .route(
            "/sync/jobs",
            post(mac_jobs).layer(DefaultBodyLimit::max(MANIFEST_LIMIT)),
        )
        .route_layer(axum::middleware::from_fn_with_state(sync.clone(), heard))
        .with_state(sync)
}

/// Item 781: any sync request is the Mac awake.
async fn heard(
    State(sync): State<Arc<SyncServer>>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    crate::sync::lease::mac_seen(sync.layout().home(), chrono::Utc::now());
    next.run(req).await
}

/// `POST /sync/lease`: the Mac asks to run one run of a job.
async fn lease(
    State(sync): State<Arc<SyncServer>>,
    Json(req): Json<crate::sync::lease::LeaseRequest>,
) -> Response {
    let home = sync.layout().home().to_path_buf();
    let claim = crate::sync::lease::claim(
        &home,
        &req.job,
        req.due,
        crate::sync::lease::MAC,
        chrono::Utc::now(),
    );
    Json(claim).into_response()
}

/// `POST /sync/jobs`: the Mac's away jobs, kept whole.
async fn mac_jobs(
    State(sync): State<Arc<SyncServer>>,
    Json(jobs): Json<Vec<crate::jobs::Job>>,
) -> Response {
    let home = sync.layout().home().to_path_buf();
    match blocking(move || crate::sync::lease::put_mac_jobs(&home, &jobs).map_err(io_failure)).await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(r) => *r,
    }
}

fn io_status(e: &std::io::Error) -> StatusCode {
    match e.kind() {
        std::io::ErrorKind::NotFound => StatusCode::NOT_FOUND,
        std::io::ErrorKind::InvalidInput => StatusCode::BAD_REQUEST,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

/// A failure on its way to the Mac: the status and the sentence.
type Failure = (StatusCode, String);

fn io_failure(e: std::io::Error) -> Failure {
    (io_status(&e), e.to_string())
}

/// Run the file work off the runtime; the answer as a response.
async fn blocking<T, F>(f: F) -> Result<T, Box<Response>>
where
    F: FnOnce() -> Result<T, Failure> + Send + 'static,
    T: Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(fail)) => Err(Box::new(fail.into_response())),
        Err(e) => Err(Box::new(
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("the task failed: {e}"),
            )
                .into_response(),
        )),
    }
}

async fn manifest(State(sync): State<Arc<SyncServer>>, Json(m): Json<Manifest>) -> Response {
    match blocking(move || sync.apply_manifest(&m).map_err(io_failure)).await {
        Ok(reply) => Json(reply).into_response(),
        Err(r) => *r,
    }
}

async fn file(
    State(sync): State<Arc<SyncServer>>,
    Path(path): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(sha) = headers
        .get(SHA_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
    else {
        return (StatusCode::BAD_REQUEST, format!("{SHA_HEADER} is missing")).into_response();
    };
    match blocking(move || {
        sync.put(&path, &sha, &body).map_err(|e| {
            let status = match &e {
                PutError::Path(_) | PutError::Hash => StatusCode::BAD_REQUEST,
                PutError::Io(io) => io_status(io),
            };
            (status, e.to_string())
        })
    })
    .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(r) => *r,
    }
}

async fn outbox(State(sync): State<Arc<SyncServer>>) -> Response {
    match blocking(move || sync.outbox().map_err(io_failure)).await {
        Ok(rows) => Json(rows).into_response(),
        Err(r) => *r,
    }
}

async fn outbox_log(State(sync): State<Arc<SyncServer>>, Path(chat): Path<String>) -> Response {
    match blocking(move || sync.outbox_log(&chat).map_err(io_failure)).await {
        Ok(bytes) => bytes.into_response(),
        Err(r) => *r,
    }
}

async fn outbox_cli(State(sync): State<Arc<SyncServer>>, Path(chat): Path<String>) -> Response {
    match blocking(move || sync.outbox_cli(&chat).map_err(io_failure)).await {
        Ok(bytes) => bytes.into_response(),
        Err(r) => *r,
    }
}

async fn ack(State(sync): State<Arc<SyncServer>>, Json(req): Json<AckRequest>) -> Response {
    match blocking(move || sync.ack(&req.chats).map_err(io_failure)).await {
        Ok(_) => StatusCode::NO_CONTENT.into_response(),
        Err(r) => *r,
    }
}
