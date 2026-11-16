//! `/api/jobs…` (nightshift item 746): the phone's recurring jobs, over
//! the host's [`crate::jobs::Jobs`].
//!
//! - `GET /jobs` — every job: its schedule in words, its next run, its
//!   last result, what it cost of the weekly window, whether it is
//!   read-only.
//! - `POST /jobs` — `{every, text, title?, project?, from_chat?,
//!   offset_min}`: a new job, read-only. `every` is his words ("every
//!   morning"); a schedule that does not read is a 400 with the forms.
//! - `POST /jobs/{id}` — pause or resume, new words or a new time, and
//!   `approve_plan`: `true` lets its runs write from now, `false` makes it
//!   read-only again.
//! - `POST /jobs/{id}/run` — one run now.
//! - `DELETE /jobs/{id}` — to the trash file; the page confirms first.
//!
//! All behind the bearer check like every `/api` route; a host with no
//! jobs answers 501 and `/api/state` does not list the `jobs` feature.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;

use super::api::NOT_AVAILABLE;
use super::{Shared, answer, bad, done, refused};
use crate::jobs::{JobPatch, JobView, Jobs, NewJob};

pub(super) fn router() -> Router<Arc<Shared>> {
    Router::new()
        .route("/jobs", get(list).post(create))
        .route("/jobs/{id}", post(patch).delete(delete))
        .route("/jobs/{id}/run", post(run))
}

#[derive(Serialize)]
struct Listed {
    jobs: Vec<JobView>,
    /// This host's clock, so the page's "in 2 hours" does not lean on the
    /// phone's.
    now: chrono::DateTime<chrono::Utc>,
}

fn jobs(shared: &Shared) -> Option<Arc<Jobs>> {
    shared.host.jobs()
}

fn no_jobs() -> Response {
    refused(NOT_AVAILABLE.into())
}

/// A job that is gone is a 409 with the sentence; a bad field a 400.
fn said(r: Result<JobView, String>) -> Response {
    match r {
        Err(e) if e == "that job is gone" || e == "it is running now" => refused(e),
        Err(e) => bad(e),
        ok => answer(ok),
    }
}

async fn list(State(shared): State<Arc<Shared>>) -> Response {
    match jobs(&shared) {
        Some(j) => answer(Ok(Listed {
            jobs: j.list(),
            now: chrono::Utc::now(),
        })),
        None => no_jobs(),
    }
}

async fn create(State(shared): State<Arc<Shared>>, Json(req): Json<NewJob>) -> Response {
    match jobs(&shared) {
        Some(j) => said(j.create(req, chrono::Utc::now())),
        None => no_jobs(),
    }
}

async fn patch(
    State(shared): State<Arc<Shared>>,
    Path(id): Path<String>,
    Json(req): Json<JobPatch>,
) -> Response {
    match jobs(&shared) {
        Some(j) => said(j.patch(&id, req, chrono::Utc::now())),
        None => no_jobs(),
    }
}

async fn run(State(shared): State<Arc<Shared>>, Path(id): Path<String>) -> Response {
    match jobs(&shared) {
        Some(j) => said(j.run_now(&id)),
        None => no_jobs(),
    }
}

async fn delete(State(shared): State<Arc<Shared>>, Path(id): Path<String>) -> Response {
    match jobs(&shared) {
        Some(j) => done(j.delete(&id).map_err(|e| {
            if e == "that job is gone" {
                e
            } else {
                format!("the job could not be deleted: {e}")
            }
        })),
        None => no_jobs(),
    }
}
