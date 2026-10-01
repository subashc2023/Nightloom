//! `/api/nightshift/…`: Nightshift on the phone (nightshift item 246 wave
//! 5; blocker 669's default, as the wave-3 spec narrows it).
//!
//! The phone reads the queue, an item, the open blockers and the morning
//! pages; it answers a blocker and adds an item. **No diffs, no reverts, no
//! launching a shift** — those stay on the Mac, where reading a diff is
//! practical. Every write is the desktop's own function
//! (`nightshift::blockers::answer_blocker`, `items::new_item_with_body`),
//! so a phone's answer is byte-for-byte what the Mac's Answer box writes,
//! and both are refused while a shift is live.
//!
//! Merged into the listener's `/api` router inside the bearer layer. The
//! projects come from [`super::Host::nightshift_roots`]; a host with none
//! answers every route here [`NOT_AVAILABLE`] (501), and `/api/state`'s
//! `features` leaves out `nightshift`.
//!
//! | Route | What |
//! |---|---|
//! | `GET /nightshift` | the Nightshift projects, with their counts |
//! | `GET /nightshift/{p}/queue` | the items in `order.json`'s order |
//! | `GET /nightshift/{p}/items/{id}` | one item: front matter and body |
//! | `POST /nightshift/{p}/items` | `{title, said, kind?}` → `{id}` |
//! | `GET /nightshift/{p}/blockers` | the open blockers |
//! | `GET /nightshift/{p}/blockers/{id}` | one blocker |
//! | `POST /nightshift/{p}/blockers/{id}/answer` | `{answer}` → the blocker after |
//! | `GET /nightshift/{p}/mornings` | the morning pages, newest first |
//! | `GET /nightshift/{p}/mornings/{name}` | one page's text |

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use super::Shared;
use super::api::NOT_AVAILABLE;
use crate::nightshift::{self, ContractRoot, blockers, frontmatter, items, launch, mornings};

/// A Nightshift project a host offers the phone: the id the routes name
/// it by (the Mac's project id; the away server's own), the name the
/// phone shows, and its detected contract root.
#[derive(Debug, Clone)]
pub struct NightshiftProject {
    pub id: String,
    pub name: String,
    pub root: ContractRoot,
}

/// One row of `GET /nightshift`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProjectRow {
    pub id: String,
    pub name: String,
    /// `research` or `build`.
    pub kind: String,
    /// A shift is running: the writes here are refused until it ends.
    pub live: bool,
    pub items: usize,
    pub open_blockers: usize,
    /// The newest morning page's file name.
    pub newest_morning: Option<String>,
    /// Why `nightshift.json` did not read, when it did not.
    pub config_error: Option<String>,
}

/// One item of the queue.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ItemRow {
    pub id: String,
    pub title: String,
    pub kind: String,
    /// `todo | in-progress | done | killed | deferred`; empty when unset.
    pub status: String,
    /// Its place in `order.json` (0-based); `None` when unlisted.
    pub order: Option<usize>,
}

/// `GET /nightshift/{p}/queue`: the items, listed ones in their order
/// first, then the unlisted by id; and the files that did not read.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Queue {
    pub items: Vec<ItemRow>,
    pub errors: Vec<String>,
}

/// One item as the phone reads it: its front matter lifted, and the body
/// below the front matter as written (the phone renders it as Markdown).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ItemView {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub status: String,
    pub created: String,
    pub source: String,
    pub order: Option<usize>,
    /// Every front-matter field, verbatim.
    pub fields: BTreeMap<String, String>,
    pub body: String,
}

/// `POST /nightshift/{p}/items`: a title and his words, which go under
/// `## What Swaraag said` as typed. `kind` defaults to the project's.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewItem {
    pub title: String,
    #[serde(default)]
    pub said: String,
    #[serde(default)]
    pub kind: Option<String>,
}

/// The new item's id.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NewItemReply {
    pub id: String,
}

/// One row of the open blockers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BlockerRow {
    pub id: String,
    pub status: String,
    pub raised: String,
    pub item: String,
    /// The question, as written (one sentence by the contract).
    pub question: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BlockerList {
    pub blockers: Vec<BlockerRow>,
    pub errors: Vec<String>,
}

/// One blocker, its sections lifted: what the phone shows before an answer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BlockerView {
    pub id: String,
    pub status: String,
    pub raised: String,
    pub item: String,
    pub question: String,
    /// `## What I would have done, and why` — the default taken.
    pub guess: String,
    pub blocks: String,
    pub answer: String,
    /// The whole body below the front matter, for anything not lifted.
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnswerRequest {
    pub answer: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MorningRow {
    pub name: String,
    pub size: u64,
    pub modified: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MorningPage {
    pub name: String,
    pub text: String,
}

/// The routes, over the listener's shared state.
pub(super) fn router() -> Router<Arc<Shared>> {
    Router::new()
        .route("/nightshift", get(projects))
        .route("/nightshift/{p}/queue", get(queue))
        .route("/nightshift/{p}/items", post(new_item))
        .route("/nightshift/{p}/items/{id}", get(item))
        .route("/nightshift/{p}/blockers", get(blocker_list))
        .route("/nightshift/{p}/blockers/{id}", get(blocker))
        .route("/nightshift/{p}/blockers/{id}/answer", post(answer))
        .route("/nightshift/{p}/mornings", get(morning_list))
        .route("/nightshift/{p}/mornings/{name}", get(morning))
}

/// A refusal: the status and the sentence.
type Failure = (StatusCode, String);

fn failed(f: Failure) -> Response {
    f.into_response()
}

/// The project `p`, or why not: 501 when this host has none at all (the
/// phone's LACKS), 404 when it has others.
async fn root(shared: &Shared, p: &str) -> Result<ContractRoot, Failure> {
    let roots = shared.host.nightshift_roots().await;
    if roots.is_empty() {
        return Err((StatusCode::NOT_IMPLEMENTED, NOT_AVAILABLE.into()));
    }
    roots
        .into_iter()
        .find(|r| r.id == p)
        .map(|r| r.root)
        .ok_or_else(|| (StatusCode::NOT_FOUND, format!("no Nightshift project {p}")))
}

/// Run the file work off the runtime.
async fn blocking<T, F>(f: F) -> Result<T, Failure>
where
    F: FnOnce() -> Result<T, Failure> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
}

/// A service read's `Err(sentence)`: "no … with id" is a 404, the rest
/// (a shift live, a refused answer) the sentence as a 409.
fn sentence(e: String) -> Failure {
    if e.starts_with("no ") {
        (StatusCode::NOT_FOUND, e)
    } else {
        (StatusCode::CONFLICT, e)
    }
}

fn reply<T: Serialize>(r: Result<T, Failure>) -> Response {
    match r {
        Ok(v) => Json(v).into_response(),
        Err(f) => failed(f),
    }
}

async fn projects(State(shared): State<Arc<Shared>>) -> Response {
    let roots = shared.host.nightshift_roots().await;
    if roots.is_empty() {
        return (StatusCode::NOT_IMPLEMENTED, NOT_AVAILABLE).into_response();
    }
    reply(
        blocking(move || {
            Ok(roots
                .into_iter()
                .map(|p| {
                    let r = &p.root.root;
                    let (bl, _) = blockers::list_blockers(r);
                    ProjectRow {
                        kind: p.root.config.kind.clone(),
                        live: launch::read_lock(r).is_some_and(|l| l.blocks_writes()),
                        items: items::item_files(r).len(),
                        open_blockers: bl.iter().filter(|b| b.status == "open").count(),
                        newest_morning: mornings::newest_morning(r).map(|m| m.name),
                        config_error: p.root.config_error.clone(),
                        id: p.id,
                        name: p.name,
                    }
                })
                .collect::<Vec<_>>())
        })
        .await,
    )
}

/// The rows of `items` in the queue's order: listed by `order.json`'s
/// position, the unlisted after them by id.
pub fn in_order(list: Vec<items::Item>) -> Vec<ItemRow> {
    let mut rows: Vec<ItemRow> = list
        .into_iter()
        .map(|i| ItemRow {
            id: i.id,
            title: i.title,
            kind: i.kind,
            status: i.status,
            order: i.order,
        })
        .collect();
    rows.sort_by(|a, b| match (a.order, b.order) {
        (Some(x), Some(y)) => x.cmp(&y),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => a.id.cmp(&b.id),
    });
    rows
}

async fn queue(State(shared): State<Arc<Shared>>, Path(p): Path<String>) -> Response {
    let root = match root(&shared, &p).await {
        Ok(r) => r,
        Err(f) => return failed(f),
    };
    reply(
        blocking(move || {
            let (list, errors) = items::list_items(&root.root, &root.config);
            Ok(Queue {
                items: in_order(list),
                errors,
            })
        })
        .await,
    )
}

async fn item(
    State(shared): State<Arc<Shared>>,
    Path((p, id)): Path<(String, String)>,
) -> Response {
    let root = match root(&shared, &p).await {
        Ok(r) => r,
        Err(f) => return failed(f),
    };
    reply(
        blocking(move || {
            let i = items::read_item(&root.root, &root.config, &id).map_err(sentence)?;
            let text = nightshift::read_text(&i.path).map_err(sentence)?;
            Ok(ItemView {
                body: frontmatter::split(&text).body,
                id: i.id,
                title: i.title,
                kind: i.kind,
                status: i.status,
                created: i.created,
                source: i.source,
                order: i.order,
                fields: i.fields,
            })
        })
        .await,
    )
}

/// The body a phone's new item is written with: the scaffold
/// `items::new_item` writes, with his words under `## What Swaraag said`.
pub fn new_item_body(said: &str) -> String {
    let said = said.trim();
    let said = if said.is_empty() {
        String::new()
    } else {
        format!("{said}\n")
    };
    format!(
        "## What Swaraag said\n\n{said}\n## What the agent inferred\n\n\n## Definition of done\n\n\n## Pointers\n\n\n## Not to do\n\n\n"
    )
}

async fn new_item(
    State(shared): State<Arc<Shared>>,
    Path(p): Path<String>,
    Json(req): Json<NewItem>,
) -> Response {
    if req.title.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "an item needs a title").into_response();
    }
    let root = match root(&shared, &p).await {
        Ok(r) => r,
        Err(f) => return failed(f),
    };
    let resp = blocking(move || {
        let kind = req
            .kind
            .filter(|k| !k.trim().is_empty())
            .unwrap_or_else(|| {
                if root.config.kind == "build" {
                    "build".into()
                } else {
                    "research".into()
                }
            });
        items::new_item_with_body(&root.root, &req.title, &kind, &new_item_body(&req.said))
            .map(|id| NewItemReply { id })
            .map_err(|e| (StatusCode::CONFLICT, e))
    })
    .await;
    match resp {
        Ok(v) => (StatusCode::CREATED, Json(v)).into_response(),
        Err(f) => failed(f),
    }
}

async fn blocker_list(State(shared): State<Arc<Shared>>, Path(p): Path<String>) -> Response {
    let root = match root(&shared, &p).await {
        Ok(r) => r,
        Err(f) => return failed(f),
    };
    reply(
        blocking(move || {
            let (all, errors) = blockers::list_blockers(&root.root);
            Ok(BlockerList {
                blockers: all
                    .into_iter()
                    .filter(|b| b.status == "open")
                    .map(|b| BlockerRow {
                        id: b.id,
                        status: b.status,
                        raised: b.raised,
                        item: b.item,
                        question: b.question,
                    })
                    .collect(),
                errors,
            })
        })
        .await,
    )
}

fn view_of(b: nightshift::Blocker) -> Result<BlockerView, Failure> {
    let text = nightshift::read_text(&b.path).map_err(sentence)?;
    Ok(BlockerView {
        body: frontmatter::split(&text).body,
        id: b.id,
        status: b.status,
        raised: b.raised,
        item: b.item,
        question: b.question,
        guess: b.guess,
        blocks: b.blocks,
        answer: b.answer,
    })
}

async fn blocker(
    State(shared): State<Arc<Shared>>,
    Path((p, id)): Path<(String, String)>,
) -> Response {
    let root = match root(&shared, &p).await {
        Ok(r) => r,
        Err(f) => return failed(f),
    };
    reply(
        blocking(move || view_of(blockers::read_blocker(&root.root, &id).map_err(sentence)?)).await,
    )
}

async fn answer(
    State(shared): State<Arc<Shared>>,
    Path((p, id)): Path<(String, String)>,
    Json(req): Json<AnswerRequest>,
) -> Response {
    if req.answer.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            "an empty answer would mark the blocker answered with no decision; write the decision",
        )
            .into_response();
    }
    let root = match root(&shared, &p).await {
        Ok(r) => r,
        Err(f) => return failed(f),
    };
    reply(
        blocking(move || {
            let b = blockers::answer_blocker(&root.root, &id, &req.answer).map_err(sentence)?;
            view_of(b)
        })
        .await,
    )
}

async fn morning_list(State(shared): State<Arc<Shared>>, Path(p): Path<String>) -> Response {
    let root = match root(&shared, &p).await {
        Ok(r) => r,
        Err(f) => return failed(f),
    };
    reply(
        blocking(move || {
            Ok(mornings::list_mornings(&root.root)
                .into_iter()
                .map(|m| MorningRow {
                    name: m.name,
                    size: m.size,
                    modified: m.modified,
                })
                .collect::<Vec<_>>())
        })
        .await,
    )
}

async fn morning(
    State(shared): State<Arc<Shared>>,
    Path((p, name)): Path<(String, String)>,
) -> Response {
    let root = match root(&shared, &p).await {
        Ok(r) => r,
        Err(f) => return failed(f),
    };
    reply(
        blocking(move || {
            let text = mornings::read_morning(&root.root, &name).map_err(|e| {
                if e.contains("not a morning page name") {
                    (StatusCode::BAD_REQUEST, e)
                } else {
                    (StatusCode::NOT_FOUND, e)
                }
            })?;
            Ok(MorningPage { name, text })
        })
        .await,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_items_body_keeps_his_words_under_his_heading() {
        let b = new_item_body("  make the phone answer blockers \n");
        assert!(b.starts_with(
            "## What Swaraag said\n\nmake the phone answer blockers\n\n## What the agent inferred"
        ));
        // Nothing said: the desktop's empty scaffold.
        assert_eq!(
            new_item_body(""),
            "## What Swaraag said\n\n\n## What the agent inferred\n\n\n## Definition of done\n\n\n## Pointers\n\n\n## Not to do\n\n\n"
        );
    }
}
