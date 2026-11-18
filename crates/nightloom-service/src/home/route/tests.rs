//! H5's Definition of done as tests (item 763): "Start X in project Y"
//! from the Mac and from the phone opens the right chat; a write-capable
//! start waits for the tap; a cold 300k target is never sent into without
//! his pick. Every host here is a stand-in: no engine, no real chat.

use std::sync::{Arc, Mutex};

use chrono::Duration;
use nightloom_core::{ContentBlock, SessionEvent, Usage};
use tokio::sync::broadcast;

use super::*;
use crate::jobs::Prep;
use crate::remote::api::{Running, RunningChat};
use crate::remote::{ApproveRequest, Asset, ChatRow, Event, ProjectRow, RemoteState};

fn scratch(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("nightloom-route-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn t0() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-11-18T12:00:00Z")
        .unwrap()
        .with_timezone(&Utc)
}

/// A config with Home and two projects; their ids.
struct World {
    config: PathBuf,
    home: String,
    loom: String,
    shift: String,
}

fn world(tag: &str) -> World {
    let config = scratch(tag);
    let mut r = Registry::load_in(&config);
    let home = crate::home::ensure_project(&mut r, &config).unwrap();
    let loom = r.create("Nightloom", None, None).unwrap().id;
    let shift = r.create("Nightshift", None, None).unwrap().id;
    World {
        config,
        home,
        loom,
        shift,
    }
}

impl World {
    fn sessions(&self, project: &str) -> PathBuf {
        let d = self
            .config
            .join(PROJECTS_DIR)
            .join(project)
            .join(SESSIONS_DIR);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// A chat in `project` whose newest reply carried `tokens` and was
    /// sent `ago` before now, on the one-hour cache.
    fn chat(&self, project: &str, kind: ChatKind, tokens: u64, ago: Duration) -> Session {
        let mut s = Session::start(self.sessions(project), ChatMode::Normal, kind).unwrap();
        s.record_title_by("778 fix", nightloom_core::TitleBy::User);
        s.record_user_message("look at the build", vec![], vec![], false);
        s.record_assistant_timed(
            "claude-opus-5-5",
            vec![ContentBlock::Text { text: "ok".into() }],
            Some("end_turn".into()),
            Usage {
                input_tokens: tokens,
                output_tokens: 100,
                cache_read_tokens: Some(tokens.saturating_sub(2_000)),
                cache_write_tokens: Some(2_000),
                cache_write_1h_tokens: Some(2_000),
                ..Usage::default()
            },
            None,
            Utc::now() - ago,
            Some(nightloom_core::CacheTtl::OneHour),
        );
        s
    }
}

/// One `job_prepare` seen: (project, chat asked for, read-only).
type Prepared = (Option<String>, Option<String>, bool);

/// A host that records what the routes' clock asks of it.
struct FakeHost {
    config: PathBuf,
    /// The id of the chat a start makes (its own per host: the process's
    /// list of routed runs is shared by every test).
    made: String,
    tx: broadcast::Sender<Event>,
    /// `job_prepare`s seen: (project, chat asked for, read-only).
    preps: Mutex<Vec<Prepared>>,
    /// Sends seen: (project, chat, text).
    sends: Mutex<Vec<(Option<String>, String, String)>>,
    running: Mutex<Option<String>>,
    /// Why the next prepare is refused.
    refuse: Mutex<Option<String>>,
    log: Mutex<Vec<SessionEvent>>,
    /// The send never answers: the app quit mid-send (the review's tests).
    hang: std::sync::atomic::AtomicBool,
    /// Run once inside the next prepare: something he does mid-look.
    on_prepare: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

fn host(config: &Path) -> Arc<FakeHost> {
    let (tx, _) = broadcast::channel(8);
    Arc::new(FakeHost {
        config: config.to_path_buf(),
        made: format!("new-{}", uuid::Uuid::new_v4()),
        tx,
        preps: Mutex::default(),
        sends: Mutex::default(),
        running: Mutex::default(),
        refuse: Mutex::default(),
        log: Mutex::default(),
        hang: std::sync::atomic::AtomicBool::new(false),
        on_prepare: Mutex::default(),
    })
}

#[async_trait::async_trait]
impl Host for FakeHost {
    async fn state(&self) -> RemoteState {
        RemoteState::default()
    }
    async fn chats(&self, _: Option<&str>) -> Result<Vec<ChatRow>, String> {
        Ok(Vec::new())
    }
    async fn projects(&self) -> Result<Vec<ProjectRow>, String> {
        Ok(Vec::new())
    }
    async fn transcript(&self, _: Option<&str>, _: &str) -> Result<Vec<SessionEvent>, String> {
        Ok(self.log.lock().unwrap().clone())
    }
    async fn send(&self, _: Option<&str>, _: &str) -> Result<Handed, String> {
        Err("a route never sends this way".into())
    }
    async fn new_chat(&self, _: Option<&str>, _: &str) -> Result<Handed, String> {
        Err("a route never starts a chat this way".into())
    }
    async fn rename(&self, _: &str, _: &str) -> Result<(), String> {
        Err("no".into())
    }
    async fn open(&self, _: &str) -> Result<(), String> {
        Err("no".into())
    }
    async fn approve(&self, _: ApproveRequest) -> Result<(), String> {
        Err("no".into())
    }
    async fn cancel(&self, _: Option<&str>) -> Result<(), String> {
        Err("no".into())
    }
    fn events(&self) -> broadcast::Receiver<Event> {
        self.tx.subscribe()
    }
    fn asset(&self, _: &str) -> Option<Asset> {
        None
    }
    fn home_config(&self) -> Option<PathBuf> {
        Some(self.config.clone())
    }
    async fn job_prepare(&self, prep: Prep) -> Result<String, String> {
        if let Some(why) = self.refuse.lock().unwrap().take() {
            return Err(why);
        }
        if let Some(f) = self.on_prepare.lock().unwrap().take() {
            f();
        }
        self.preps
            .lock()
            .unwrap()
            .push((prep.project.clone(), prep.chat.clone(), prep.read_only));
        Ok(prep.chat.unwrap_or_else(|| self.made.clone()))
    }
    async fn job_send(
        &self,
        project: Option<&str>,
        chat: &str,
        text: &str,
    ) -> Result<Handed, String> {
        self.sends.lock().unwrap().push((
            project.map(str::to_string),
            chat.to_string(),
            text.to_string(),
        ));
        if self.hang.load(std::sync::atomic::Ordering::SeqCst) {
            std::future::pending::<()>().await;
        }
        *self.running.lock().unwrap() = Some(chat.to_string());
        Ok(Handed::Sent)
    }
    async fn running(&self) -> Result<Running, String> {
        Ok(Running {
            chats: self
                .running
                .lock()
                .unwrap()
                .iter()
                .map(|c| RunningChat {
                    chat: Some(c.clone()),
                    project: None,
                    title: "routed".into(),
                    since: None,
                    on_screen: false,
                    waiting: 0,
                })
                .collect(),
            ..Running::default()
        })
    }
}

fn said(text: &str, reply: &str) -> Vec<SessionEvent> {
    serde_json::from_value(json!([
        {"event": "user_message", "text": text, "at": "2026-11-18T12:00:00Z"},
        {"event": "assistant_message", "model": "m", "blocks": [{"type": "text", "text": reply}],
         "stop_reason": null, "usage": {"input_tokens": 1, "output_tokens": 1}, "at": "2026-11-18T12:01:00Z"},
    ]))
    .unwrap()
}

/// Home's model calls a tool as the MCP server would serve it to Home's
/// chat; the reply is what the model reads.
async fn call(w: &World, tool: &str, input: Value) -> Result<String, String> {
    let served = crate::mcp_server::tools_in_chat(&w.config, Some(&w.home), true, None).unwrap();
    let t = served
        .iter()
        .find(|t| t.def().name == tool)
        .unwrap_or_else(|| panic!("{tool} is served to Home"));
    t.call(input, &CancellationToken::new()).await
}

fn kinds(config: &Path) -> Vec<String> {
    crate::home::read_feed(config)
        .into_iter()
        .map(|r| r.kind)
        .collect()
}

/// From the Mac: he tells Home "look into why CI is red in Nightshift";
/// Home calls `start_chat`; the clock opens a read-only chat in
/// Nightshift — not Nightloom, not Home — with the prompt, by itself; the
/// end lands in the feed with the reply's first line.
#[tokio::test]
async fn start_x_in_project_y_from_the_mac_opens_the_right_chat_and_reports_back() {
    let w = world("mac");
    let h = host(&w.config);
    let reply = call(
        &w,
        START_TOOL,
        json!({"project": "nightshift", "prompt": "Find why CI is red and say what failed."}),
    )
    .await
    .unwrap();
    assert!(reply.starts_with("Queued"), "{reply}");
    assert!(reply.contains("a new chat in Nightshift"), "{reply}");
    let route = read(&w.config).remove(0);
    assert_eq!(route.state, State::Queued);
    assert!(!route.write && route.hold.is_none());

    tick(h.as_ref(), t0()).await;
    assert_eq!(
        *h.preps.lock().unwrap(),
        vec![(Some(w.shift.clone()), None, true)],
        "one chat, in Nightshift, held read-only"
    );
    assert_eq!(
        *h.sends.lock().unwrap(),
        vec![(
            Some(w.shift.clone()),
            h.made.clone(),
            "Find why CI is red and say what failed.".to_string()
        )]
    );
    let route = read(&w.config).remove(0);
    assert_eq!(route.state, State::Started);
    assert_eq!(route.chat.as_deref(), Some(h.made.as_str()));
    assert_eq!(started_by_home(&w.config), vec![h.made.clone()]);
    assert_eq!(kinds(&w.config), vec!["route_started"]);
    assert!(
        crate::home::is_job_run(&h.made),
        "the routed turn's end is the route's row, not also the push's"
    );

    // Still running: nothing more is asked or written.
    tick(h.as_ref(), t0() + Duration::seconds(40)).await;
    assert_eq!(h.sends.lock().unwrap().len(), 1, "never sent twice");
    assert_eq!(read(&w.config).remove(0).state, State::Started);

    // Its turn ended.
    *h.running.lock().unwrap() = None;
    *h.log.lock().unwrap() = said(
        "Find why CI is red and say what failed.",
        "The clippy step failed on jobs.rs:41.\nDetails follow.",
    );
    tick(h.as_ref(), t0() + Duration::seconds(80)).await;
    let route = read(&w.config).remove(0);
    assert_eq!(route.state, State::Finished);
    let feed = crate::home::read_feed(&w.config);
    assert_eq!(feed.last().unwrap().kind, "route_done");
    assert!(
        feed.last()
            .unwrap()
            .line
            .starts_with("The clippy step failed")
    );
    assert_eq!(
        feed.last().unwrap().project.as_deref(),
        Some(w.shift.as_str())
    );
    assert!(!crate::home::is_job_run(&h.made));
    let status = call(&w, STATUS_TOOL, json!({"route": route.id}))
        .await
        .unwrap();
    assert!(
        status.contains("finished") && status.contains("clippy"),
        "{status}"
    );
    // The ledger is append-only: every state it went through is still a line.
    let lines = std::fs::read_to_string(path_in(&w.config)).unwrap();
    assert!(lines.lines().count() >= 4, "{lines}");
}

/// A start that may write is a Start card: no look of the clock, however
/// many, asks the host for anything. His tap — with the prompt as he
/// edited it — starts it; his Dismiss never does.
#[tokio::test]
async fn a_write_capable_start_waits_for_his_tap_and_takes_his_edit() {
    let w = world("write");
    let h = host(&w.config);
    let reply = call(
        &w,
        START_TOOL,
        json!({"project": "Nightloom", "prompt": "Fix the tab-drag bug.", "may_write": true}),
    )
    .await
    .unwrap();
    assert!(reply.starts_with("Not started"), "{reply}");
    let id = cards(&w.config).remove(0).id;
    for k in 0..50 {
        tick(h.as_ref(), t0() + Duration::minutes(k * 30)).await;
    }
    assert!(h.preps.lock().unwrap().is_empty(), "never without his tap");
    assert!(h.sends.lock().unwrap().is_empty());
    let card = cards(&w.config).remove(0);
    assert_eq!((card.state, card.hold), (State::Waiting, Some(Hold::Write)));
    assert!(card.pushed);
    assert_eq!(
        kinds(&w.config),
        vec!["route_waiting"],
        "one row for the card, once"
    );

    // A second card, dismissed: gone from the cards, never started.
    call(
        &w,
        START_TOOL,
        json!({"project": "Nightloom", "prompt": "Delete the old harness.", "may_write": true}),
    )
    .await
    .unwrap();
    let other = cards(&w.config).remove(1).id;
    dismiss(&w.config, &other, t0()).unwrap();
    assert!(dismiss(&w.config, &other, t0()).is_err(), "answered once");
    assert!(
        confirm(&w.config, &other, None, None, t0()).is_err(),
        "a dismissed card cannot be started"
    );

    // An empty edit is refused and the card stays.
    assert!(
        confirm_and_run(h.as_ref(), &id, Some("  "), None, t0())
            .await
            .is_err()
    );
    assert_eq!(cards(&w.config).len(), 1);

    let after = confirm_and_run(
        h.as_ref(),
        &id,
        Some("Fix the tab-drag bug (item 195). Run the tests."),
        None,
        t0(),
    )
    .await
    .unwrap();
    assert_eq!(
        after.state,
        State::Started,
        "under his finger, not at the next look"
    );
    assert_eq!(
        *h.preps.lock().unwrap(),
        vec![(Some(w.loom.clone()), None, false)],
        "write-capable, in Nightloom"
    );
    assert_eq!(
        h.sends.lock().unwrap()[0].2,
        "Fix the tab-drag bug (item 195). Run the tests."
    );
    assert!(cards(&w.config).is_empty());
    tick(h.as_ref(), t0() + Duration::seconds(5)).await;
    assert_eq!(
        h.sends.lock().unwrap().len(),
        1,
        "the dismissed one never runs"
    );
}

/// The gate itself: a ledger line that says "queued" for a route that
/// was held and carries no tap (a damaged or hand-written line, or text a
/// scan read that found its way into the file) is not started.
#[tokio::test]
async fn a_held_route_with_no_tap_is_never_started_whatever_its_line_says() {
    let w = world("gate");
    let h = host(&w.config);
    let mut forged = plan_start(&w.config, "Nightloom", "rm -rf", true, None, t0()).unwrap();
    forged.state = State::Queued;
    record(&w.config, &forged).unwrap();
    assert!(!may_run(&forged));
    tick(h.as_ref(), t0()).await;
    assert!(h.preps.lock().unwrap().is_empty());
}

/// A cold 300k chat: `send_chat` never sends; the card carries the size;
/// a tap with no pick is refused; "new chat" starts a fresh read-only
/// chat in that project and leaves the cold one alone; "into it" sends
/// into it, kept as it was (read-only stays read-only).
#[tokio::test]
async fn a_cold_300k_target_is_never_sent_into_without_his_pick() {
    let w = world("cold");
    let h = host(&w.config);
    let cold = w.chat(&w.shift, ChatKind::Chat, 300_000, Duration::hours(2));
    let id = cold.id.clone();
    drop(cold);
    let reply = call(&w, SEND_TOOL, json!({"chat": id, "text": "and the CI?"}))
        .await
        .unwrap();
    assert!(reply.starts_with("Not sent"), "{reply}");
    assert!(reply.contains("300k"), "{reply}");
    let card = cards(&w.config).remove(0);
    assert_eq!(card.hold, Some(Hold::Cold));
    assert_eq!(card.cold.as_ref().unwrap().tokens, 300_100);
    assert_eq!(card.chat.as_deref(), Some(id.as_str()));
    for k in 0..20 {
        tick(h.as_ref(), t0() + Duration::minutes(k)).await;
    }
    assert!(h.sends.lock().unwrap().is_empty(), "never without his pick");
    assert!(
        confirm_and_run(h.as_ref(), &card.id, None, None, t0())
            .await
            .is_err(),
        "a tap with no pick starts nothing"
    );
    assert!(h.preps.lock().unwrap().is_empty());

    // His pick: a new chat.
    let after = confirm_and_run(h.as_ref(), &card.id, None, Some(Pick::New), t0())
        .await
        .unwrap();
    assert_eq!(after.state, State::Started);
    assert_eq!(
        *h.preps.lock().unwrap(),
        vec![(Some(w.shift.clone()), None, true)],
        "a new read-only chat in the cold chat's project"
    );
    assert_eq!(h.sends.lock().unwrap()[0].1, h.made, "not the cold chat");
    assert!(started_by_home(&w.config).contains(&h.made.clone()));

    // The same ask again; his pick this time: into it anyway.
    call(&w, SEND_TOOL, json!({"chat": id, "text": "and the CI?"}))
        .await
        .unwrap();
    let card = cards(&w.config).remove(0);
    confirm_and_run(h.as_ref(), &card.id, None, Some(Pick::Into), t0())
        .await
        .unwrap();
    assert_eq!(
        h.preps.lock().unwrap()[1],
        (Some(w.shift.clone()), Some(id.clone()), true)
    );
    assert_eq!(h.sends.lock().unwrap()[1].1, id);
    assert!(
        !started_by_home(&w.config).contains(&id),
        "a chat Home only wrote into is not marked as started by Home"
    );
}

/// Warm or small targets: a read-only chat is written into alone; a chat
/// that may write waits for his tap, warm or not.
#[tokio::test]
async fn a_warm_read_only_chat_is_sent_into_alone_and_a_writable_one_waits() {
    let w = world("warm");
    let h = host(&w.config);
    let ro = w.chat(&w.shift, ChatKind::Chat, 300_000, Duration::minutes(5));
    let rw = w.chat(&w.loom, ChatKind::Build, 40_000, Duration::hours(3));
    let (ro, rw) = (ro.id.clone(), rw.id.clone());
    let reply = call(&w, SEND_TOOL, json!({"chat": ro, "text": "status?"}))
        .await
        .unwrap();
    assert!(reply.starts_with("Queued"), "big but warm: {reply}");
    let reply = call(&w, SEND_TOOL, json!({"chat": rw, "text": "carry on"}))
        .await
        .unwrap();
    assert!(
        reply.starts_with("Not started"),
        "small and cold, may write: {reply}"
    );
    tick(h.as_ref(), t0()).await;
    assert_eq!(
        *h.sends.lock().unwrap(),
        vec![(Some(w.shift.clone()), ro.clone(), "status?".to_string())]
    );
    assert_eq!(
        h.preps.lock().unwrap()[0],
        (Some(w.shift.clone()), Some(ro), true)
    );
    assert_eq!(cards(&w.config).len(), 1);
    assert_eq!(cards(&w.config)[0].chat.as_deref(), Some(rw.as_str()));
}

/// A chat that was handed off is not written into: the route goes to the
/// newest chat of its chain, and says so.
#[tokio::test]
async fn a_send_follows_the_hand_off_chain_to_its_newest_chat() {
    let w = world("chain");
    let first = w.chat(&w.shift, ChatKind::Chat, 310_000, Duration::hours(30));
    let second = first.continued_from(w.sessions(&w.shift)).unwrap();
    let third = second.continued_from(w.sessions(&w.shift)).unwrap();
    let (a, c) = (first.id.clone(), third.id.clone());
    drop((first, second, third));
    let reply = call(&w, SEND_TOOL, json!({"chat": a, "text": "what is left?"}))
        .await
        .unwrap();
    assert!(reply.starts_with("Queued"), "the newest is small: {reply}");
    let route = read(&w.config).remove(0);
    assert_eq!(route.chat.as_deref(), Some(c.as_str()), "two hand-offs on");
    assert!(route.note.as_deref().unwrap().contains("handed off"));
    // A short id finds it too.
    let route = plan_send(&w.config, &a[..8], "x", None, t0()).unwrap();
    assert_eq!(route.chat.as_deref(), Some(c.as_str()));
}

/// From the phone: the card is listed over the API, the tap carries his
/// edit, and the right chat opens; the token is required; Dismiss works.
#[tokio::test]
async fn start_x_in_project_y_from_the_phone_opens_the_right_chat_on_his_tap() {
    let w = world("phone");
    let h = host(&w.config);
    let token = "t-phone".to_string();
    let server = crate::remote::Server::start_for_test(
        "127.0.0.1:0".parse().unwrap(),
        token.clone(),
        h.clone(),
    )
    .await
    .unwrap();
    let base = format!("http://{}/api", server.addr());
    let c = reqwest::Client::builder().no_proxy().build().unwrap();
    // "Tell Home…" from the phone is a message in Home's chat; Home's turn
    // (stubbed here: the tool call it would make) plans the route.
    call(
        &w,
        START_TOOL,
        json!({"project": "Nightloom", "prompt": "Start the 778 fix.", "may_write": true}),
    )
    .await
    .unwrap();
    assert_eq!(
        c.get(format!("{base}/home/routes"))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    let listed: Value = c
        .get(format!("{base}/home/routes"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let card = &listed["cards"][0];
    assert_eq!(card["project_name"], "Nightloom");
    assert_eq!(card["prompt"], "Start the 778 fix.");
    assert_eq!(card["write"], true);
    assert_eq!(card["hold"], "write");
    let id = card["id"].as_str().unwrap().to_string();
    assert!(h.preps.lock().unwrap().is_empty(), "listing starts nothing");

    let r = c
        .post(format!("{base}/home/routes/{id}/start"))
        .bearer_auth(&token)
        .json(&json!({"prompt": "Start the 778 fix; read HANDOFF.md first."}))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let after: Value = r.json().await.unwrap();
    assert_eq!(after["state"], "started");
    assert_eq!(
        *h.preps.lock().unwrap(),
        vec![(Some(w.loom.clone()), None, false)]
    );
    assert_eq!(
        *h.sends.lock().unwrap(),
        vec![(
            Some(w.loom.clone()),
            h.made.clone(),
            "Start the 778 fix; read HANDOFF.md first.".to_string()
        )]
    );
    // A second tap (a retry on a bad connection) starts nothing more.
    let again = c
        .post(format!("{base}/home/routes/{id}/start"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(again.status(), 409);
    assert_eq!(h.sends.lock().unwrap().len(), 1);
    let listed: Value = c
        .get(format!("{base}/home/routes"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(listed["cards"].as_array().unwrap().len(), 0);
    assert_eq!(listed["started"][0], h.made.as_str());

    // Dismiss from the phone.
    call(
        &w,
        START_TOOL,
        json!({"project": "Nightloom", "prompt": "Another.", "may_write": true}),
    )
    .await
    .unwrap();
    let id = cards(&w.config).remove(0).id;
    let r = c
        .post(format!("{base}/home/routes/{id}/dismiss"))
        .bearer_auth(&token)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert!(cards(&w.config).is_empty());
    assert_eq!(h.sends.lock().unwrap().len(), 1);
    server.stop().await;
}

/// A project that is not open on the Mac: the route waits, says why, and
/// starts at a later look — one chat, not two.
#[tokio::test]
async fn a_start_the_host_cannot_take_yet_waits_and_says_why() {
    let w = world("wait");
    let h = host(&w.config);
    call(
        &w,
        START_TOOL,
        json!({"project": "Nightloom", "prompt": "Look."}),
    )
    .await
    .unwrap();
    *h.refuse.lock().unwrap() = Some("its project is not open on the Mac".into());
    tick(h.as_ref(), t0()).await;
    let route = read(&w.config).remove(0);
    assert_eq!(route.state, State::Queued);
    assert_eq!(
        route.note.as_deref(),
        Some("waiting — its project is not open on the Mac")
    );
    assert!(status_line(&route).contains("not open on the Mac"));
    tick(h.as_ref(), t0() + Duration::seconds(30)).await;
    assert_eq!(h.sends.lock().unwrap().len(), 1);
    assert_eq!(read(&w.config).remove(0).state, State::Started);
    // A route nobody could start in a day fails, and the feed says so.
    call(
        &w,
        START_TOOL,
        json!({"project": "Nightloom", "prompt": "Later."}),
    )
    .await
    .unwrap();
    *h.refuse.lock().unwrap() = Some("Claude Code is not connected on the Mac".into());
    tick(h.as_ref(), Utc::now() + Duration::hours(25)).await;
    let last = read(&w.config).pop().unwrap();
    assert_eq!(last.state, State::Failed);
    assert_eq!(kinds(&w.config).last().unwrap(), "route_failed");
}

/// Only Home's chats get the tools; names resolve without guessing; Home
/// never routes into itself.
#[tokio::test]
async fn only_home_is_served_the_tools_and_a_project_is_never_guessed() {
    let w = world("served");
    let names = |project: &str, remember: bool| -> Vec<String> {
        crate::mcp_server::tools_in_chat(&w.config, Some(project), remember, None)
            .unwrap()
            .iter()
            .map(|t| t.def().name)
            .collect()
    };
    for tool in [START_TOOL, SEND_TOOL, STATUS_TOOL] {
        assert!(names(&w.home, true).contains(&tool.to_string()));
        assert!(!names(&w.loom, true).contains(&tool.to_string()), "{tool}");
        assert!(!names(&w.home, false).contains(&tool.to_string()), "{tool}");
        assert!(
            !crate::agent::connector_writes::writes(&crate::mcp_server::mcp_name(tool)),
            "{tool} passes Home's read-only hold"
        );
    }
    let err = call(&w, START_TOOL, json!({"project": "night", "prompt": "x"}))
        .await
        .unwrap_err();
    assert!(
        err.contains("could be") && err.contains("Nightloom") && err.contains("Nightshift"),
        "{err}"
    );
    let err = call(&w, START_TOOL, json!({"project": "Scorer", "prompt": "x"}))
        .await
        .unwrap_err();
    assert!(
        err.contains("there are:")
            && err.contains("Nightloom")
            && err.contains("Nightshift")
            && !err.contains("Home"),
        "{err}"
    );
    let err = call(&w, START_TOOL, json!({"project": "Home", "prompt": "x"}))
        .await
        .unwrap_err();
    assert!(err.contains("does not start work in itself"), "{err}");
    assert!(
        call(
            &w,
            START_TOOL,
            json!({"project": "Nightloom", "prompt": " "})
        )
        .await
        .is_err()
    );
    assert!(read(&w.config).is_empty(), "a refused call leaves no route");
    let listed = call(&w, STATUS_TOOL, json!({})).await.unwrap();
    assert_eq!(listed, "Nothing routed in the last day.");
}

#[test]
fn a_night_run_is_read_from_the_newest_night_log() {
    let ws = scratch("night");
    let dir = ws.join("notes").join("runner-design");
    std::fs::create_dir_all(&dir).unwrap();
    let now = std::time::SystemTime::now();
    assert!(!night_running(&ws, now));
    std::fs::write(
        dir.join("night-log-2026-11-18.md"),
        "NIGHT START 1:00 AM\n- pass 1\n",
    )
    .unwrap();
    assert!(night_running(&ws, now));
    assert!(
        !night_running(&ws, now + std::time::Duration::from_secs(13 * 3600)),
        "a log untouched for half a day is a night that ended without saying so"
    );
    std::fs::write(
        dir.join("night-log-2026-11-18.md"),
        "NIGHT START 1:00 AM\n- pass 1\nNIGHT DONE 5:00 AM\n",
    )
    .unwrap();
    assert!(!night_running(&ws, now));
}

/// The Start card's push is "Home — Waiting for your approval": a state,
/// never the prompt; and the card's own row is its only feed row.
#[test]
fn the_cards_push_says_a_state_and_is_not_a_second_feed_row() {
    let note = crate::push::Note {
        what: crate::push::What::Approval,
        chat: None,
        label: Some("Home".into()),
        project: None,
        at_the_mac: false,
        detail: Some(CARD_PUSH.into()),
    };
    assert!(!crate::home::push_is_a_row(&note));
    let plain = crate::push::Note {
        detail: None,
        ..note
    };
    assert!(
        crate::home::push_is_a_row(&plain),
        "every other approval is a row"
    );
}

mod review;
