//! Home on the phone (nightshift item 763, build item H8; item 741's
//! screen): what the phone's first screen reads beyond the routes it
//! already has (`/push/feed`, `/jobs`, `/running`, `/home/today`).
//!
//! | Route | What |
//! |---|---|
//! | `GET /home/feed` | Home's feed (the newest [`FEED_ROWS`]) (`home/feed.jsonl`) newest first, his last look (`seen.json`), when the feed was last written, and Home's project and chat |
//! | `POST /home/seen` | mark the feed seen now → `{seen_at}` |
//! | `GET /home/scan` | today's scan page (`home/scans/<date>.md`), else the newest, with when it ran and, for a skipped scan, why |
//! | `GET /home/held` | the held blockers of every Nightshift project (status `open`, `default: held`) — the phone's Home shows them as one folded line, not as Needs-you rows (item 945) — and (item 995) how many proposals are pending, so the phone's count is the Mac's |
//! | `GET /shortcut/needs` | one plain sentence for Siri: "Three things need you: …" (approvals, questions, stuck chats, jobs, and since item 995 held blockers and proposals — the Mac pill's number) |
//! | `GET /home/tasks` | the tasks on Home's stage (item 845: `home/tasks/<id>.json`, what Home's `update_task` wrote), oldest first |
//! | `POST /home/tasks/event` | one click of his on a task view, `{task, view, line}`, for Home's next look (the Mac only) |
//! | `POST /home/tasks/{id}/close` | his × on a task's tab: the tab goes, the work is not stopped (the Mac only) |
//! | `GET /home/steps` | Home's steps (item 872): the last [`STEP_TURNS`] turns of Home's chat, its messages only — what the Steps panel draws |
//!
//! Both hosts serve these from their own config folder
//! ([`super::Host::home_config`]): the away server's copy is the synced
//! one, so the phone can say "as of 11:40 PM" from `as_of` when only the
//! away server answers. Nothing here runs a turn or a model call.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::Json;
use axum::Router;
use axum::extract::{Path as UrlPath, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde::{Deserialize, Serialize};

use super::api::NOT_AVAILABLE;
use super::{Shared, answer};
use crate::home::{self, FeedRow};

pub(super) fn router() -> Router<Arc<Shared>> {
    Router::new()
        .route("/home/feed", get(feed))
        .route("/home/seen", post(seen))
        .route("/home/scan", get(scan))
        .route("/home/held", get(held))
        .route("/shortcut/needs", get(needs))
        .route("/home/today", get(today))
        .route("/home/tasks", get(tasks))
        .route("/home/tasks/event", post(task_event))
        .route("/home/tasks/{id}/close", post(task_close))
        .route("/home/tasks/focus", post(task_focus))
        .route("/home/steps", get(steps))
}

/// The turns of Home's chat the phone's Steps panel gets (the Mac's panel
/// draws three, `stepsOf` in `homeStage/steps.ts`).
pub const STEP_TURNS: usize = 3;
/// The most events one reply carries.
const STEP_EVENTS_MAX: usize = 400;

/// The tail the phone's Steps panel draws (item 872): from the start of
/// the last `turns` turns (his messages), his messages and Home's replies
/// only — no tool results, no other rows — at most [`STEP_EVENTS_MAX`],
/// the newest kept. Pure.
pub fn steps_tail(
    events: Vec<nightloom_core::SessionEvent>,
    turns: usize,
) -> Vec<nightloom_core::SessionEvent> {
    use nightloom_core::SessionEvent as E;
    let kept: Vec<E> = events
        .into_iter()
        .filter(|e| matches!(e, E::UserMessage { .. } | E::AssistantMessage { .. }))
        .collect();
    let starts: Vec<usize> = kept
        .iter()
        .enumerate()
        .filter(|(_, e)| matches!(e, E::UserMessage { .. }))
        .map(|(i, _)| i)
        .collect();
    let from = if starts.len() > turns {
        starts[starts.len() - turns]
    } else {
        0
    };
    let mut tail: Vec<E> = kept.into_iter().skip(from).collect();
    // His photos and documents are not steps: only his words go.
    for e in &mut tail {
        if let E::UserMessage {
            images, documents, ..
        } = e
        {
            images.clear();
            documents.clear();
        }
    }
    if tail.len() > STEP_EVENTS_MAX {
        tail.drain(..tail.len() - STEP_EVENTS_MAX);
    }
    tail
}

/// `GET /home/steps`: Home's chat is the host's own (the scan job's), never
/// one the phone names, and reading it does not mark it seen on the phone
/// (the transcript route does) — the panel is not him opening the chat.
/// No Home chat yet → an empty list.
async fn steps(State(shared): State<Arc<Shared>>) -> Response {
    let w = home_where(&shared);
    let Some(chat) = w.chat else {
        return answer(Ok::<_, String>(Vec::<nightloom_core::SessionEvent>::new()));
    };
    match shared.host.transcript(w.project.as_deref(), &chat).await {
        Ok(events) => answer(Ok::<_, String>(steps_tail(events, STEP_TURNS))),
        Err(e) => (StatusCode::NOT_FOUND, e).into_response(),
    }
}

/// The most feed rows the phone is sent.
pub const FEED_ROWS: usize = 60;

/// Home's project and the chat its scan runs in, when the host knows them.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct HomeWhere {
    pub project: Option<String>,
    pub chat: Option<String>,
}

/// `GET /home/feed`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HomeFeedReply {
    /// Newest first, at most [`FEED_ROWS`].
    pub rows: Vec<FeedRow>,
    /// His last look (RFC 3339), when he has looked.
    pub seen_at: Option<String>,
    /// When `feed.jsonl` was last written, unix milliseconds.
    pub as_of: Option<i64>,
    pub home: HomeWhere,
}

/// One scan page.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ScanPage {
    /// `2026-11-17`, the page's own date.
    pub date: String,
    /// The page as written, its `# Morning scan — <date>` heading taken off.
    pub text: String,
    /// When the page was written, unix milliseconds.
    pub ran_at: Option<i64>,
    /// The page is today's on the host's clock.
    pub today: bool,
    /// A skipped scan's reason: the page's `Skipped: …` line (the spend
    /// guard's code-only page writes one); `None` for a full scan.
    pub skipped: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ScanReply {
    pub scan: Option<ScanPage>,
}

/// One held blocker.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HeldBlocker {
    /// The Nightshift project's id (the `/nightshift/{p}` routes' `p`).
    pub project: String,
    pub project_name: String,
    pub id: String,
    pub item: String,
    pub question: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HeldReply {
    pub blockers: Vec<HeldBlocker>,
    /// Item 995: how many proposed changes to instructions or memory wait
    /// on his review — in the one Needs-you number the Mac's pill shows, so
    /// the phone's count agrees. Reviewed on the Mac (no route here).
    #[serde(default)]
    pub proposals: usize,
}

fn config(shared: &Shared) -> Result<PathBuf, Box<Response>> {
    shared
        .host
        .home_config()
        .ok_or_else(|| Box::new((StatusCode::NOT_IMPLEMENTED, NOT_AVAILABLE).into_response()))
}

fn mtime_ms(path: &Path) -> Option<i64> {
    let t = std::fs::metadata(path).ok()?.modified().ok()?;
    let d = t.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(d.as_millis() as i64)
}

/// Home's project and chat: the built-in scan job's (H3 makes it in
/// Home's project, and it carries the chat once it has run).
fn home_where(shared: &Shared) -> HomeWhere {
    shared
        .host
        .jobs()
        .and_then(|j| j.list().into_iter().find(|v| v.job.id == home::SCAN_JOB_ID))
        .map(|v| HomeWhere {
            project: v.job.project.clone(),
            chat: v.job.chat.clone(),
        })
        .unwrap_or_default()
}

/// The feed reply from the folder. Pure apart from reading `config`.
pub fn feed_reply(config: &Path, limit: usize, home: HomeWhere) -> HomeFeedReply {
    let mut rows = home::read_feed(config);
    rows.reverse();
    rows.truncate(limit.clamp(1, 200));
    HomeFeedReply {
        rows,
        seen_at: home::seen_at(config).map(|t| t.to_rfc3339()),
        as_of: mtime_ms(&home::dir_in(config).join("feed.jsonl")),
        home,
    }
}

async fn feed(State(shared): State<Arc<Shared>>) -> Response {
    let config = match config(&shared) {
        Ok(c) => c,
        Err(r) => return *r,
    };
    let home = home_where(&shared);
    answer(Ok::<_, String>(feed_reply(&config, FEED_ROWS, home)))
}

/// `GET /home/today` (item 763 H6): what Home's unattended runs used of
/// the week today, the cap, both windows, and why runs are stopped now.
async fn today(State(shared): State<Arc<Shared>>) -> Response {
    let config = match config(&shared) {
        Ok(c) => c,
        Err(r) => return *r,
    };
    let plan = shared.host.usage().await.ok().map(|u| u.plan);
    let pace = home::guard::pace_in(&config, chrono::Utc::now());
    let date = chrono::Local::now().date_naive();
    answer(Ok::<_, String>(home::guard::today(
        &config,
        plan.as_ref(),
        Some(&pace),
        date,
    )))
}

async fn seen(State(shared): State<Arc<Shared>>) -> Response {
    let config = match config(&shared) {
        Ok(c) => c,
        Err(r) => return *r,
    };
    let now = chrono::Utc::now();
    answer(
        home::mark_seen(&config, now).map(|()| serde_json::json!({ "seen_at": now.to_rfc3339() })),
    )
}

// ---- item 845: Home's stage on the phone ------------------------------------

/// `GET /home/tasks`: what Home's `update_task` wrote, oldest first (a done
/// task older than a day is left out). A file read; no model.
async fn tasks(State(shared): State<Arc<Shared>>) -> Response {
    let config = match config(&shared) {
        Ok(c) => c,
        Err(r) => return *r,
    };
    answer(Ok::<_, String>(home::tasks::read(
        &config,
        chrono::Utc::now(),
    )))
}

/// His clicks reach Home only on the Mac: the away server's copy of the
/// folder is a synced one Home never reads, so a click there would be lost
/// without a word. The phone says so instead.
pub const STAGE_ON_THE_MAC: &str = "Home's stage answers only from the Mac — your click was not sent. Try again when the Mac is reachable.";

fn mac_only(shared: &Shared) -> Result<(), Box<Response>> {
    if shared.host.kind() == "mac" {
        Ok(())
    } else {
        Err(Box::new(
            (StatusCode::SERVICE_UNAVAILABLE, STAGE_ON_THE_MAC).into_response(),
        ))
    }
}

/// One click of his on a task view (a "kind B" control).
#[derive(Debug, Clone, Deserialize)]
pub struct TaskEvent {
    pub task: String,
    pub view: String,
    pub line: String,
}

/// `POST /home/tasks/event`: the line Home reads at its next look.
async fn task_event(State(shared): State<Arc<Shared>>, Json(ev): Json<TaskEvent>) -> Response {
    if let Err(r) = mac_only(&shared) {
        return *r;
    }
    let config = match config(&shared) {
        Ok(c) => c,
        Err(r) => return *r,
    };
    answer(
        home::tasks::record(&config, &ev.task, &ev.view, &ev.line, chrono::Utc::now())
            .map(|()| serde_json::json!({ "ok": true })),
    )
}

#[derive(Debug, Deserialize)]
struct TaskFocus {
    view: String,
    #[serde(default)]
    task: String,
}

/// `POST /home/tasks/focus`: the phone's view in focus, sent just before
/// his Tell Home message, for the header Home reads with it (846 §7 step 3).
async fn task_focus(State(shared): State<Arc<Shared>>, Json(f): Json<TaskFocus>) -> Response {
    if let Err(r) = mac_only(&shared) {
        return *r;
    }
    let config = match config(&shared) {
        Ok(c) => c,
        Err(r) => return *r,
    };
    answer(
        home::tasks::set_focus(&config, &f.view, &f.task, chrono::Utc::now())
            .map(|()| serde_json::json!({ "ok": true })),
    )
}

/// `POST /home/tasks/{id}/close`: his × on the tab. The work goes on.
async fn task_close(State(shared): State<Arc<Shared>>, UrlPath(id): UrlPath<String>) -> Response {
    if let Err(r) = mac_only(&shared) {
        return *r;
    }
    let config = match config(&shared) {
        Ok(c) => c,
        Err(r) => return *r,
    };
    answer(
        home::tasks::close(&config, &id, chrono::Utc::now())
            .map(|()| serde_json::json!({ "ok": true })),
    )
}

/// A skipped scan's `Skipped: why` line (with or without a quote mark or
/// bold), among the page's first lines. Pure.
pub fn skipped_line(text: &str) -> Option<String> {
    text.lines().take(8).find_map(|l| {
        let l = l
            .trim()
            .trim_start_matches('>')
            .trim()
            .trim_start_matches("**")
            .trim();
        let rest = l
            .strip_prefix("Skipped:")
            .or_else(|| l.strip_prefix("skipped:"))?;
        let why = rest.trim().trim_start_matches("**").trim();
        (!why.is_empty()).then(|| why.to_string())
    })
}

/// The page `scans/<today>.md`, else the newest page there. Pure apart
/// from reading `config`.
pub fn scan_page(config: &Path, today: chrono::NaiveDate) -> Option<ScanPage> {
    let dir = home::dir_in(config).join("scans");
    let want = dir.join(format!("{today}.md"));
    let path = if want.is_file() {
        want
    } else {
        let mut pages: Vec<PathBuf> = std::fs::read_dir(&dir)
            .ok()?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "md"))
            .collect();
        pages.sort();
        pages.pop()?
    };
    let date = path.file_stem()?.to_string_lossy().to_string();
    let raw = std::fs::read_to_string(&path).ok()?;
    let text = raw
        .strip_prefix(&format!("# Morning scan — {date}"))
        .unwrap_or(&raw)
        .trim()
        .to_string();
    Some(ScanPage {
        skipped: skipped_line(&text),
        today: date == today.to_string(),
        ran_at: mtime_ms(&path),
        date,
        text,
    })
}

async fn scan(State(shared): State<Arc<Shared>>) -> Response {
    let config = match config(&shared) {
        Ok(c) => c,
        Err(r) => return *r,
    };
    let today = chrono::Local::now().date_naive();
    answer(Ok::<_, String>(ScanReply {
        scan: scan_page(&config, today),
    }))
}

/// The held blockers of every Nightshift project the host offers.
async fn held_blockers(shared: &Shared) -> Vec<HeldBlocker> {
    let roots = shared.host.nightshift_roots().await;
    tokio::task::spawn_blocking(move || {
        let mut out = Vec::new();
        for p in roots {
            let (all, _) = crate::nightshift::blockers::list_blockers(&p.root.root);
            for b in all {
                if b.is_held() {
                    out.push(HeldBlocker {
                        project: p.id.clone(),
                        project_name: p.name.clone(),
                        id: b.id,
                        item: b.item,
                        question: b.question,
                    });
                }
            }
        }
        out
    })
    .await
    .unwrap_or_default()
}

/// Item 995: the proposals pending under this host's config folder (the
/// Mac's bell and Needs-you view read the same `centre::proposals_in`).
async fn pending_proposals(shared: &Shared) -> usize {
    let Some(config) = shared.host.home_config() else {
        return 0;
    };
    tokio::task::spawn_blocking(move || crate::centre::proposals_in(&config).len())
        .await
        .unwrap_or_default()
}

async fn held(State(shared): State<Arc<Shared>>) -> Response {
    answer(Ok::<_, String>(HeldReply {
        blockers: held_blockers(&shared).await,
        proposals: pending_proposals(&shared).await,
    }))
}

// ---- the spoken sentence ------------------------------------------------------

/// One thing that waits on him, for the sentence.
#[derive(Debug, Clone, PartialEq)]
pub enum Need {
    /// A tool call waits for Allow or Deny in the chat named.
    Approval(String),
    /// A question (or a plan) waits in the chat named.
    Question(String),
    /// The runaway guard paused the chat named.
    Stuck(String),
    /// A job's read-only run wanted changes: the job's name.
    Job(String),
    /// Item 947: his Run now was stopped by the spend guard and the job asks Run anyway or Cancel (the phone page's
    /// "Run anyway" card): the job's name.
    JobRun(String),
    /// Item 910: the job's scheduled run skipped itself to save his limits and asks Run it now / Keep skipping.
    JobSkipped(String),
    /// A held blocker.
    Blocker,
    /// Item 995: a proposed change to instructions or memory, pending his review.
    Proposal,
}

fn number_word(n: usize) -> String {
    const WORDS: [&str; 11] = [
        "Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
    ];
    WORDS
        .get(n)
        .map_or_else(|| n.to_string(), |w| (*w).to_string())
}

fn named(label: &str) -> &str {
    let l = label.trim();
    if l.is_empty() { "a new chat" } else { l }
}

/// What needs him, as one sentence for Siri to speak: "Three things need
/// you: an approval in Scorer review, a question from Home, one held
/// blocker." At most four named, then "and N more". Pure.
pub fn needs_sentence(needs: &[Need]) -> String {
    if needs.is_empty() {
        return "Nothing needs you.".into();
    }
    let blockers = needs.iter().filter(|n| **n == Need::Blocker).count();
    let proposals = needs.iter().filter(|n| **n == Need::Proposal).count();
    let mut parts: Vec<String> = needs
        .iter()
        .filter_map(|n| match n {
            Need::Approval(c) => Some(format!("an approval in {}", named(c))),
            Need::Question(c) => Some(format!("a question from {}", named(c))),
            Need::Stuck(c) => Some(format!("a stuck run in {}", named(c))),
            Need::Job(j) => Some(format!("the job {} wants to make changes", named(j))),
            Need::JobRun(j) => Some(format!(
                "the job {} is asking whether to run anyway",
                named(j)
            )),
            Need::JobSkipped(j) => Some(format!(
                "{} skipped itself to save your limits and asks whether to run it",
                named(j)
            )),
            Need::Blocker | Need::Proposal => None,
        })
        .collect();
    if blockers > 0 {
        let w = number_word(blockers).to_lowercase();
        parts.push(if blockers == 1 {
            "one held blocker".into()
        } else {
            format!("{w} held blockers")
        });
    }
    if proposals > 0 {
        let w = number_word(proposals).to_lowercase();
        parts.push(if proposals == 1 {
            "one proposal to review".into()
        } else {
            format!("{w} proposals to review")
        });
    }
    let total = needs.len();
    let head = if total == 1 {
        "One thing needs you".to_string()
    } else {
        format!("{} things need you", number_word(total))
    };
    const NAMED: usize = 4;
    if parts.len() > NAMED {
        let rest = parts.len() - NAMED;
        parts.truncate(NAMED);
        parts.push(format!("and {rest} more"));
    }
    format!("{head}: {}.", parts.join(", "))
}

/// The needs a push feed, the jobs and the held blockers hold, in that
/// order. `pending` is the open chat's approvals in the host's state,
/// counted only when no feed row stands for that chat. Pure.
pub fn needs_from(
    feed: &[crate::push::FeedRow],
    jobs: &[crate::jobs::JobView],
    blockers: usize,
    pending: usize,
    active: Option<(&str, &str)>,
) -> Vec<Need> {
    use crate::push::What;
    let mut out = Vec::new();
    for r in feed {
        let label = r.label.clone().unwrap_or_default();
        match r.what {
            What::Approval | What::Reminder | What::SetAside | What::Unattended => {
                out.push(Need::Approval(label))
            }
            What::Question => out.push(Need::Question(label)),
            What::Stuck => out.push(Need::Stuck(label)),
            What::Changes | What::Done | What::Failed | What::Limit | What::Scan | What::Watch => {}
        }
    }
    if pending > 0
        && let Some((chat, label)) = active
        && !feed.iter().any(|r| r.chat == chat)
    {
        // Item 947: one need however many approvals the open chat holds — the page shows one row ("2 approvals
        // waiting") and counts one, so Siri says the same number.
        out.push(Need::Approval(label.to_string()));
    }
    for j in jobs {
        match &j.job.confirm {
            Some(c) if c.scheduled => out.push(Need::JobSkipped(j.job.title.clone())),
            Some(_) => out.push(Need::JobRun(j.job.title.clone())),
            None => {}
        }
        if j.job.wanted.is_some() {
            out.push(Need::Job(j.job.title.clone()));
        }
    }
    out.extend(std::iter::repeat_n(Need::Blocker, blockers));
    out
}

async fn needs(State(shared): State<Arc<Shared>>) -> Response {
    let state = shared.host.state().await;
    let feed = shared.host.push().map(|p| p.feed()).unwrap_or_default();
    let jobs = shared.host.jobs().map(|j| j.list()).unwrap_or_default();
    // Item 995: the sentence counts what the Mac's pill counts — held
    // blockers and pending proposals included (item 968's one number); before
    // 995 it left them out (item 945) and said "Nothing needs you" beside a
    // pill that said 5.
    let blockers = held_blockers(&shared).await.len();
    let proposals = pending_proposals(&shared).await;
    let active_label = match state.active_chat.as_deref() {
        Some(id) => shared
            .host
            .chats(None)
            .await
            .ok()
            .and_then(|rows| rows.into_iter().find(|r| r.id == id))
            .map(|r| r.label),
        None => None,
    };
    let active = state
        .active_chat
        .as_deref()
        .map(|id| (id, active_label.as_deref().unwrap_or("")));
    let mut list = needs_from(&feed, &jobs, blockers, state.pending.len(), active);
    list.extend(std::iter::repeat_n(Need::Proposal, proposals));
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        needs_sentence(&list),
    )
        .into_response()
}

#[cfg(test)]
mod tests {

    #[test]
    fn the_steps_tail_is_the_last_turns_messages_only() {
        let ev = |v: serde_json::Value| {
            serde_json::from_value::<nightloom_core::SessionEvent>(v).unwrap()
        };
        let at = "2026-11-19T12:00:00Z";
        let mut all = vec![ev(
            serde_json::json!({"event": "session_created", "id": "h", "at": at}),
        )];
        for n in 0..5 {
            all.push(ev(
                serde_json::json!({"event": "user_message", "text": format!("ask {n}"), "at": at,
                "images": [{"media_type": "image/png", "data": "AAAA"}]}),
            ));
            all.push(ev(serde_json::json!({"event": "assistant_message", "at": at, "model": "m", "stop_reason": null, "usage": {"input_tokens": 0, "output_tokens": 0}, "blocks": [{"type": "text", "text": format!("reply {n}")}]})));
        }
        let tail = steps_tail(all.clone(), 3);
        let v = serde_json::to_value(&tail).unwrap();
        assert_eq!(tail.len(), 6, "{v}");
        assert_eq!(v[0]["text"], "ask 2");
        assert!(v[0].get("images").is_none(), "his photos are not sent: {v}");
        assert_eq!(
            steps_tail(all[..3].to_vec(), 3).len(),
            2,
            "fewer turns than asked: all of them"
        );
        assert!(steps_tail(vec![], 3).is_empty());
    }

    use super::*;

    fn row(what: crate::push::What, chat: &str, label: &str) -> crate::push::FeedRow {
        crate::push::FeedRow {
            what,
            chat: chat.into(),
            label: Some(label.into()),
            project: None,
            at: 0,
        }
    }

    #[test]
    fn the_needs_sentence_names_each_thing_and_counts_the_blockers() {
        assert_eq!(needs_sentence(&[]), "Nothing needs you.");
        // Item 995: proposals are in the count, named after the blockers.
        assert_eq!(
            needs_sentence(&[Need::Blocker, Need::Blocker, Need::Proposal]),
            "Three things need you: two held blockers, one proposal to review."
        );
        assert_eq!(
            needs_sentence(&[
                Need::Approval("Scorer review".into()),
                Need::Question("Home".into()),
                Need::Blocker,
            ]),
            "Three things need you: an approval in Scorer review, a question from Home, one held blocker."
        );
        assert_eq!(
            needs_sentence(&[Need::Blocker, Need::Blocker]),
            "Two things need you: two held blockers."
        );
        assert_eq!(
            needs_sentence(&[Need::Job("Morning scan".into())]),
            "One thing needs you: the job Morning scan wants to make changes."
        );
        let many: Vec<Need> = (0..6).map(|i| Need::Stuck(format!("c{i}"))).collect();
        assert_eq!(
            needs_sentence(&many),
            "Six things need you: a stuck run in c0, a stuck run in c1, a stuck run in c2, a stuck run in c3, and 2 more."
        );
    }

    #[test]
    fn needs_come_from_the_feed_the_open_chat_jobs_and_blockers_without_counting_twice() {
        use crate::push::What;
        let feed = vec![
            row(What::Approval, "a", "Scorer review"),
            row(What::Done, "b", "Signup"),
            row(What::Question, "h", "Home"),
        ];
        let n = needs_from(&feed, &[], 1, 2, Some(("a", "Scorer review")));
        assert_eq!(
            n,
            vec![
                Need::Approval("Scorer review".into()),
                Need::Question("Home".into()),
                Need::Blocker
            ],
            "the open chat's approvals are its feed row"
        );
        let n = needs_from(&[], &[], 0, 1, Some(("z", "Budget")));
        assert_eq!(n, vec![Need::Approval("Budget".into())]);
    }

    #[test]
    fn several_open_chat_approvals_are_one_need_and_a_run_anyway_card_is_a_need_947() {
        // The phone page draws one row ("2 approvals waiting") and counts one; Siri says the same number.
        let n = needs_from(&[], &[], 0, 3, Some(("z", "Budget")));
        assert_eq!(n, vec![Need::Approval("Budget".into())]);
        assert_eq!(
            needs_sentence(&[Need::JobRun("Morning scan".into())]),
            "One thing needs you: the job Morning scan is asking whether to run anyway."
        );
    }

    #[test]
    fn a_scheduled_skip_is_its_own_need_910() {
        assert_eq!(
            needs_sentence(&[Need::JobSkipped("Morning scan".into())]),
            "One thing needs you: Morning scan skipped itself to save your limits and asks whether to run it."
        );
    }

    #[test]
    fn the_scan_route_reads_today_else_the_newest_and_says_why_one_was_skipped() {
        let dir = std::env::temp_dir().join(format!("h8-scan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let scans = home::dir_in(&dir).join("scans");
        std::fs::create_dir_all(&scans).unwrap();
        let today: chrono::NaiveDate = "2026-11-17".parse().unwrap();
        assert!(scan_page(&dir, today).is_none(), "no page yet");
        std::fs::write(
            scans.join("2026-11-16.md"),
            "# Morning scan — 2026-11-16\n\n- CI green\n",
        )
        .unwrap();
        let p = scan_page(&dir, today).unwrap();
        assert_eq!(
            (p.date.as_str(), p.today, p.text.as_str()),
            ("2026-11-16", false, "- CI green")
        );
        assert!(p.skipped.is_none());
        std::fs::write(
            scans.join("2026-11-17.md"),
            "# Morning scan — 2026-11-17\n\n> **Skipped:** the 5-hour window is at 82%\n\n- 2 blockers held\n",
        )
        .unwrap();
        let p = scan_page(&dir, today).unwrap();
        assert!(p.today);
        assert_eq!(p.skipped.as_deref(), Some("the 5-hour window is at 82%"));
        assert!(p.ran_at.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_feed_reply_is_newest_first_with_the_last_look() {
        let dir = std::env::temp_dir().join(format!("h8-feed-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let at = |m: i64| chrono::DateTime::from_timestamp(1_800_000_000 + m * 60, 0).unwrap();
        for (i, kind) in ["done", "failed", "scan"].iter().enumerate() {
            home::append(
                &dir,
                &FeedRow {
                    at: at(i as i64),
                    kind: (*kind).into(),
                    label: Some("x".into()),
                    chat: Some(format!("c{i}")),
                    project: None,
                    line: "l".into(),
                },
            );
        }
        home::mark_seen(&dir, at(1)).unwrap();
        let r = feed_reply(&dir, 2, HomeWhere::default());
        assert_eq!(
            r.rows.iter().map(|r| r.kind.as_str()).collect::<Vec<_>>(),
            ["scan", "failed"]
        );
        assert!(r.seen_at.is_some() && r.as_of.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
