use std::sync::Mutex;

use chrono::TimeZone;
use nightloom_core::SessionEvent;
use tokio::sync::broadcast;

use super::*;
use crate::remote::api::{Running, RunningChat, UsageReply};
use crate::remote::{
    ApproveRequest, Asset, ChatRow, Event, ProjectRow, RemoteState, SendRequest, Server,
};

fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
}

#[test]
fn his_words_read_as_schedules() {
    let p = |s: &str| Every::parse(s, 2).unwrap();
    assert_eq!(p("every 30 minutes"), Every::Minutes { n: 30 });
    assert_eq!(p("Repeat every hour"), Every::Hours { n: 1 });
    assert_eq!(p("every 2 hours."), Every::Hours { n: 2 });
    assert_eq!(p("every half hour"), Every::Minutes { n: 30 });
    assert_eq!(p("every other hour"), Every::Hours { n: 2 });
    let days = |at_min: u32, days: &[u8]| Every::Days {
        at_min,
        days: days.to_vec(),
    };
    assert_eq!(p("every morning"), days(480, &[]));
    assert_eq!(p("every day at 7:15am"), days(435, &[]));
    assert_eq!(p("daily at noon"), days(720, &[]));
    assert_eq!(p("every evening"), days(1080, &[]));
    assert_eq!(p("every night at 11 pm"), days(1380, &[]));
    assert_eq!(p("every weekday at 9"), days(540, &[0, 1, 2, 3, 4]));
    assert_eq!(p("every weekend"), days(480, &[5, 6]));
    assert_eq!(p("every Monday and Thursday at 9:30am"), days(570, &[0, 3]));
    assert_eq!(p("each fri at 17:00"), days(1020, &[4]));
    // "every week": the day it was made on (here Wednesday).
    assert_eq!(p("every week"), days(480, &[2]));
}

#[test]
fn words_that_are_no_schedule_are_refused_with_the_forms() {
    for bad in [
        "",
        "every",
        "every so often",
        "every day at 25",
        "every 2 hours at 9am",
        "every 0 minutes",
        "every blursday",
    ] {
        let e = Every::parse(bad, 0).unwrap_err();
        assert!(e.contains("every 30 minutes"), "{bad}: {e}");
    }
    // Too often is its own sentence: the cost is why.
    let e = Every::parse("every 5 minutes", 0).unwrap_err();
    assert!(e.contains("at most every 15 minutes"), "{e}");
}

#[test]
fn a_schedule_reads_back_in_his_words_with_12_hour_times() {
    let w = |s: &str| Every::parse(s, 0).unwrap().words();
    assert_eq!(w("every 45 min"), "Every 45 minutes");
    assert_eq!(w("every hour"), "Every hour");
    assert_eq!(w("every morning"), "Every day at 8:00 AM");
    assert_eq!(w("every weekday at 9"), "Weekdays at 9:00 AM");
    assert_eq!(w("every day at midnight"), "Every day at 12:00 AM");
    assert_eq!(w("every day at 13:05"), "Every day at 1:05 PM");
    assert_eq!(
        w("every mon, wed and fri at 6pm"),
        "Mondays, Wednesdays and Fridays at 6:00 PM"
    );
    assert_eq!(w("every sunday"), "Sundays at 8:00 AM");
}

#[test]
fn the_next_run_is_on_the_phones_clock_not_the_hosts() {
    // 2026-11-16 is a Monday. He is at UTC-8 (offset -480).
    let every = Every::parse("every morning", 0).unwrap();
    // 7:00 AM his time (15:00 UTC): today's 8:00 AM is next.
    assert_eq!(
        every.next_after(at(2026, 11, 16, 15, 0), -480),
        at(2026, 11, 16, 16, 0)
    );
    // Exactly 8:00 AM: strictly after — tomorrow's.
    assert_eq!(
        every.next_after(at(2026, 11, 16, 16, 0), -480),
        at(2026, 11, 17, 16, 0)
    );
    // The same words on a UTC clock are 8:00 UTC.
    assert_eq!(
        every.next_after(at(2026, 11, 16, 15, 0), 0),
        at(2026, 11, 17, 8, 0)
    );
    // Weekdays: Friday 9 PM his time (Saturday 05:00 UTC) → Monday.
    let weekdays = Every::parse("every weekday at 9am", 0).unwrap();
    assert_eq!(
        weekdays.next_after(at(2026, 11, 21, 5, 0), -480),
        at(2026, 11, 23, 17, 0)
    );
    // One named day: a week on when today's time has passed.
    let mondays = Every::parse("every monday at 9am", 0).unwrap();
    assert_eq!(
        mondays.next_after(at(2026, 11, 16, 18, 0), -480),
        at(2026, 11, 23, 17, 0)
    );
    // Intervals count from the moment given.
    assert_eq!(
        Every::Minutes { n: 30 }.next_after(at(2026, 11, 16, 15, 10), -480),
        at(2026, 11, 16, 15, 40)
    );
}

#[test]
fn the_reply_is_the_last_one_after_the_jobs_own_message() {
    let ev = |v: serde_json::Value| v;
    let log = vec![
        ev(serde_json::json!({"event": "user_message", "text": "check CI"})),
        ev(
            serde_json::json!({"event": "assistant_message", "blocks": [{"type": "text", "text": "yesterday: green"}]}),
        ),
        ev(serde_json::json!({"event": "user_message", "text": "check CI"})),
        ev(
            serde_json::json!({"event": "assistant_message", "blocks": [{"type": "tool_use", "name": "Read"}]}),
        ),
        ev(
            serde_json::json!({"event": "assistant_message", "blocks": [{"type": "text", "text": "today: 2 red"}]}),
        ),
    ];
    assert_eq!(reply_in(&log, "check CI").as_deref(), Some("today: 2 red"));
    // A send with no reply after it is no reply, not yesterday's.
    assert_eq!(reply_in(&log[..3], "check CI"), None);
    assert_eq!(reply_in(&log, "something else"), None);
}

#[test]
fn the_cost_is_the_weekly_figures_move_within_one_window() {
    let mark = RunMark {
        started: at(2026, 11, 16, 16, 0),
        writable: false,
        week_before: Some(41),
        resets_at: Some("w1".into()),
    };
    let plan = |pct: Option<u8>, resets: &str| PlanUsage {
        seven_day: pct,
        seven_day_resets_at: Some(resets.into()),
        ..PlanUsage::default()
    };
    assert_eq!(week_points(&mark, &plan(Some(43), "w1")), Some(2));
    assert_eq!(week_points(&mark, &plan(Some(41), "w1")), Some(0));
    // The window reset during the run, or a reading is missing: unknown.
    assert_eq!(week_points(&mark, &plan(Some(1), "w2")), None);
    assert_eq!(week_points(&mark, &plan(None, "w1")), None);
}

/// A host that records what the clock asks of it.
struct FakeHost {
    jobs: Arc<Jobs>,
    tx: broadcast::Sender<Event>,
    /// `job_prepare`s seen, as (chat asked for, read-only).
    preps: Mutex<Vec<(Option<String>, bool)>>,
    sends: Mutex<Vec<(Option<String>, String, String)>>,
    /// The chat listed as running, when one is.
    running: Mutex<Option<String>>,
    /// What the next send answers.
    refuse: Mutex<Option<String>>,
    week: Mutex<Option<u8>>,
    five: Mutex<Option<u8>>,
    log: Mutex<Vec<SessionEvent>>,
}

fn host() -> Arc<FakeHost> {
    let dir = std::env::temp_dir().join(format!("nightloom-jobs-{}", uuid::Uuid::new_v4()));
    let (tx, _) = broadcast::channel(8);
    Arc::new(FakeHost {
        jobs: Jobs::open_in(dir, None),
        tx,
        preps: Mutex::default(),
        sends: Mutex::default(),
        running: Mutex::default(),
        refuse: Mutex::default(),
        week: Mutex::new(Some(40)),
        five: Mutex::new(Some(10)),
        log: Mutex::default(),
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
        Err("a job never sends this way".into())
    }
    async fn send_with(&self, chat: Option<&str>, req: SendRequest) -> Result<Handed, String> {
        if let Some(why) = self.refuse.lock().unwrap().take() {
            return Err(why);
        }
        let chat = chat.unwrap().to_string();
        self.sends
            .lock()
            .unwrap()
            .push((req.project, chat.clone(), req.text));
        *self.running.lock().unwrap() = Some(chat);
        Ok(Handed::Sent)
    }
    async fn new_chat(&self, _: Option<&str>, _: &str) -> Result<Handed, String> {
        Err("no".into())
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
    fn jobs(&self) -> Option<Arc<Jobs>> {
        Some(self.jobs.clone())
    }
    async fn job_prepare(&self, prep: Prep) -> Result<String, String> {
        self.preps
            .lock()
            .unwrap()
            .push((prep.chat.clone(), prep.read_only));
        Ok(prep.chat.unwrap_or_else(|| "job-chat".into()))
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
                    title: "job".into(),
                    since: None,
                    on_screen: false,
                    waiting: 0,
                })
                .collect(),
            ..Running::default()
        })
    }
    async fn usage(&self) -> Result<UsageReply, String> {
        Ok(UsageReply {
            plan: PlanUsage {
                five_hour: *self.five.lock().unwrap(),
                seven_day: *self.week.lock().unwrap(),
                seven_day_resets_at: Some("w1".into()),
                ..PlanUsage::default()
            },
            ledger: serde_json::Value::Null,
        })
    }
}

fn new_job(every: &str) -> NewJob {
    NewJob {
        every: every.into(),
        text: "check CI and tell me what failed".into(),
        project: Some("p1".into()),
        offset_min: -480,
        ..NewJob::default()
    }
}

fn said(text: &str, reply: &str) -> Vec<SessionEvent> {
    serde_json::from_value(serde_json::json!([
        {"event": "user_message", "text": text, "at": "2026-11-16T16:00:00Z"},
        {"event": "assistant_message", "model": "m", "blocks": [{"type": "text", "text": reply}],
         "stop_reason": null, "usage": {"input_tokens": 1, "output_tokens": 1}, "at": "2026-11-16T16:01:00Z"},
    ]))
    .unwrap()
}

#[tokio::test]
async fn a_due_job_runs_read_only_in_its_own_chat_and_records_result_and_cost() {
    let h = host();
    let made = at(2026, 11, 16, 15, 0);
    let job = h.jobs.create(new_job("every morning"), made).unwrap();
    assert!(job.read_only);
    assert_eq!(job.job.title, "check CI and tell me what failed");
    assert_eq!(job.job.next_run, at(2026, 11, 16, 16, 0));

    // Not due: nothing is asked of the host.
    h.jobs.tick(h.as_ref(), at(2026, 11, 16, 15, 59)).await;
    assert!(h.preps.lock().unwrap().is_empty());

    // Due: its chat is prepared read-only, then the message goes into it.
    let start = at(2026, 11, 16, 16, 0);
    h.jobs.tick(h.as_ref(), start).await;
    assert_eq!(*h.preps.lock().unwrap(), vec![(None, true)]);
    assert_eq!(
        *h.sends.lock().unwrap(),
        vec![(
            Some("p1".into()),
            "job-chat".into(),
            "check CI and tell me what failed".into()
        )]
    );
    let j = h.jobs.list().remove(0).job;
    assert_eq!(j.chat.as_deref(), Some("job-chat"));
    assert_eq!(j.running.as_ref().unwrap().week_before, Some(40));
    assert_eq!(j.next_run, at(2026, 11, 17, 16, 0));

    // Still listed as running: not finished, and not started twice.
    h.jobs.tick(h.as_ref(), start + Duration::seconds(60)).await;
    assert!(h.jobs.list()[0].job.last.is_none());
    assert_eq!(h.sends.lock().unwrap().len(), 1);

    // Ended: the reply's words and the weekly figure's move are kept.
    *h.running.lock().unwrap() = None;
    *h.log.lock().unwrap() = said(
        "check CI and tell me what failed",
        "2 red:\n- lint\n- clippy",
    );
    *h.week.lock().unwrap() = Some(42);
    let end = start + Duration::seconds(120);
    h.jobs.tick(h.as_ref(), end).await;
    let j = h.jobs.list().remove(0).job;
    assert!(j.running.is_none());
    let last = j.last.unwrap();
    assert_eq!(last.outcome, Outcome::Done);
    assert_eq!(last.summary, "2 red: - lint - clippy");
    assert_eq!((last.week_points, last.week_after), (Some(2), Some(42)));
    assert_eq!(last.ended, end);
    assert_eq!((j.week.points, j.week.runs), (2, 1));

    // The store is the file: a fresh open reads the same job.
    let again = Jobs::open_in(h.jobs.dir.clone(), None).list().remove(0).job;
    assert_eq!(again.week.points, 2);
    assert_eq!(again.chat.as_deref(), Some("job-chat"));
}

#[tokio::test]
async fn an_approved_plan_lets_the_next_run_write_and_new_words_take_it_back() {
    let h = host();
    let t0 = at(2026, 11, 16, 15, 0);
    let id = h.jobs.create(new_job("every hour"), t0).unwrap().job.id;
    let approve = JobPatch {
        approve_plan: Some(true),
        ..JobPatch::default()
    };
    assert!(!h.jobs.patch(&id, approve, t0).unwrap().read_only);
    h.jobs.tick(h.as_ref(), at(2026, 11, 16, 16, 0)).await;
    assert_eq!(*h.preps.lock().unwrap(), vec![(None, false)]);

    // New words: what he approved was the old plan.
    let reword = JobPatch {
        text: Some("check CI and fix the lint".into()),
        ..JobPatch::default()
    };
    assert!(h.jobs.patch(&id, reword, t0).unwrap().read_only);
    *h.running.lock().unwrap() = None;
    h.jobs.tick(h.as_ref(), at(2026, 11, 16, 16, 5)).await; // finishes run 1
    h.jobs.tick(h.as_ref(), at(2026, 11, 16, 17, 0)).await;
    assert_eq!(
        h.preps.lock().unwrap().last(),
        Some(&(Some("job-chat".into()), true))
    );
}

#[tokio::test]
async fn a_run_that_cannot_start_waits_with_its_reason_and_tries_again() {
    let h = host();
    let id = h
        .jobs
        .create(new_job("every hour"), at(2026, 11, 16, 15, 0))
        .unwrap()
        .job
        .id;
    *h.refuse.lock().unwrap() = Some("its project is not open on the Mac".into());
    let due = at(2026, 11, 16, 16, 0);
    h.jobs.tick(h.as_ref(), due).await;
    let j = h.jobs.list().remove(0).job;
    assert_eq!(
        j.note.as_deref(),
        Some("waiting — its project is not open on the Mac")
    );
    assert!(j.running.is_none());
    assert_eq!(j.next_run, due, "still due");
    // Not before the retry time; then it goes, in the chat already made.
    h.jobs.tick(h.as_ref(), due + Duration::seconds(30)).await;
    assert!(h.sends.lock().unwrap().is_empty());
    h.jobs.tick(h.as_ref(), due + Duration::seconds(61)).await;
    assert_eq!(h.sends.lock().unwrap().len(), 1);
    assert_eq!(
        h.preps.lock().unwrap().last(),
        Some(&(Some("job-chat".into()), true))
    );
    let j = h.jobs.list().remove(0).job;
    assert_eq!(j.note, None);
    assert_eq!(j.next_run, at(2026, 11, 16, 17, 1) + Duration::seconds(1));

    // At the plan's limit nothing is sent at all.
    *h.running.lock().unwrap() = None;
    h.jobs.tick(h.as_ref(), at(2026, 11, 16, 16, 30)).await;
    *h.five.lock().unwrap() = Some(100);
    h.jobs.run_now(&id).unwrap();
    h.jobs.tick(h.as_ref(), at(2026, 11, 16, 16, 31)).await;
    assert_eq!(h.sends.lock().unwrap().len(), 1);
    assert!(
        h.jobs.list()[0]
            .job
            .note
            .as_deref()
            .unwrap()
            .contains("usage limit")
    );
}

#[tokio::test]
async fn pause_holds_it_run_now_runs_it_once_and_delete_goes_to_the_trash() {
    let h = host();
    let t0 = at(2026, 11, 16, 15, 0);
    let id = h.jobs.create(new_job("every hour"), t0).unwrap().job.id;
    let pause = |paused| JobPatch {
        paused: Some(paused),
        ..JobPatch::default()
    };
    h.jobs.patch(&id, pause(true), t0).unwrap();
    h.jobs.tick(h.as_ref(), at(2026, 11, 16, 18, 0)).await;
    assert!(h.sends.lock().unwrap().is_empty(), "paused");

    // Run now: once, and it stays paused.
    h.jobs.run_now(&id).unwrap();
    h.jobs.tick(h.as_ref(), at(2026, 11, 16, 18, 1)).await;
    assert_eq!(h.sends.lock().unwrap().len(), 1);
    assert_eq!(h.jobs.run_now(&id).unwrap_err(), "it is running now");
    *h.running.lock().unwrap() = None;
    h.jobs.tick(h.as_ref(), at(2026, 11, 16, 18, 5)).await;
    h.jobs.tick(h.as_ref(), at(2026, 11, 16, 20, 0)).await;
    assert_eq!(h.sends.lock().unwrap().len(), 1, "still paused");
    // No reply in the log: the run is recorded as failed, in words.
    let last = h.jobs.list().remove(0).job.last.unwrap();
    assert_eq!(last.outcome, Outcome::Failed);

    // Resumed: from its next time, not the hours it sat out.
    let resumed = h
        .jobs
        .patch(&id, pause(false), at(2026, 11, 16, 20, 0))
        .unwrap();
    assert_eq!(resumed.job.next_run, at(2026, 11, 16, 21, 0));

    h.jobs.delete(&id).unwrap();
    assert!(h.jobs.list().is_empty());
    let trash: serde_json::Value =
        serde_json::from_slice(&std::fs::read(h.jobs.dir.join("trash.json")).unwrap()).unwrap();
    assert_eq!(trash[0]["job"]["id"], id.as_str());
    assert_eq!(h.jobs.delete(&id).unwrap_err(), "that job is gone");
}

const TOKEN: &str = "0123456789abcdef0123456789abcdef";

#[tokio::test]
async fn the_routes_list_make_change_and_delete_a_job_and_name_the_feature() {
    let h = host();
    let server = Server::start_for_test("127.0.0.1:0".parse().unwrap(), TOKEN.into(), h.clone())
        .await
        .unwrap();
    let base = format!("http://{}/api", server.addr());
    let c = reqwest::Client::builder().no_proxy().build().unwrap();
    let state: serde_json::Value = c
        .get(format!("{base}/state"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        state["features"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f == "jobs")
    );

    // No token, no jobs.
    assert_eq!(
        c.get(format!("{base}/jobs")).send().await.unwrap().status(),
        401
    );

    let bad = c
        .post(format!("{base}/jobs"))
        .bearer_auth(TOKEN)
        .json(&serde_json::json!({"every": "every so often", "text": "x"}))
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), 400);
    assert!(bad.text().await.unwrap().contains("every 30 minutes"));

    let made: serde_json::Value = c
        .post(format!("{base}/jobs"))
        .bearer_auth(TOKEN)
        .json(&serde_json::json!({"every": "every weekday at 9am", "text": "check CI", "offset_min": -480}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(made["every_words"], "Weekdays at 9:00 AM");
    assert_eq!(made["read_only"], true);
    let id = made["id"].as_str().unwrap();

    let patched: serde_json::Value = c
        .post(format!("{base}/jobs/{id}"))
        .bearer_auth(TOKEN)
        .json(&serde_json::json!({"paused": true, "approve_plan": true}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        (patched["paused"].clone(), patched["read_only"].clone()),
        (true.into(), false.into())
    );

    let listed: serde_json::Value = c
        .get(format!("{base}/jobs"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(listed["jobs"].as_array().unwrap().len(), 1);
    assert!(listed["now"].is_string());

    let gone = c
        .delete(format!("{base}/jobs/{id}"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(gone.status(), 204);
    let again = c
        .delete(format!("{base}/jobs/{id}"))
        .bearer_auth(TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(again.status(), 409);
}

/// Item 746's review: a log that refuses the write (0444, as the Mac's
/// take-down leaves it) is not reported held — the run waits.
#[cfg(unix)]
#[test]
fn a_kind_that_does_not_reach_the_file_is_not_held() {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!("nightloom-holdkind-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let s = nightloom_core::Session::start(
        &dir,
        nightloom_core::ChatMode::Normal,
        nightloom_core::ChatKind::Build,
    )
    .unwrap();
    let path = s.log_path().unwrap().to_path_buf();
    let id = s.id.clone();
    drop(s);
    assert_eq!(hold_kind_on_disk(&path, kind_for(true)).unwrap(), id);
    assert_eq!(
        nightloom_core::Session::load(&path).unwrap().kind(),
        nightloom_core::ChatKind::Chat
    );
    assert_eq!(hold_kind_on_disk(&path, kind_for(false)).unwrap(), id);
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444)).unwrap();
    assert_eq!(
        hold_kind_on_disk(&path, kind_for(true)).unwrap_err(),
        UNHELD
    );
    assert_eq!(
        nightloom_core::Session::load(&path).unwrap().kind(),
        nightloom_core::ChatKind::Build,
        "still writable-kind on disk"
    );
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644));
    let _ = std::fs::remove_dir_all(&dir);
}

// ---- item 780: real time zones ----

const LA: &str = "America/Los_Angeles";

fn la_job(every: &str) -> NewJob {
    NewJob {
        tz: Some(LA.into()),
        ..new_job(every)
    }
}

/// The check's fake clock: a job saved at 8:00 AM on 2026-11-17 (Pacific
/// standard time, UTC−8) runs at 8:00 AM on 2027-03-15 (daylight time,
/// UTC−7) — 15:00 UTC, not the 16:00 a fixed offset would give.
#[tokio::test]
async fn a_job_saved_at_8am_in_november_runs_at_8am_after_the_march_change() {
    let h = host();
    let saved = at(2026, 11, 17, 16, 0); // 8:00 AM PST
    let job = h
        .jobs
        .create(la_job("every day at 8am"), saved)
        .unwrap()
        .job;
    assert_eq!(job.tz.as_deref(), Some(LA));
    assert_eq!(job.next_run, at(2026, 11, 18, 16, 0));

    // The host was off until 6:00 AM on 2027-03-15 (13:00 UTC): it runs
    // once, and its next time is that day's 8:00 AM — daylight time.
    h.jobs.tick(h.as_ref(), at(2027, 3, 15, 13, 0)).await;
    assert_eq!(h.sends.lock().unwrap().len(), 1);
    assert_eq!(h.jobs.list()[0].job.next_run, at(2027, 3, 15, 15, 0));
    *h.running.lock().unwrap() = None;
    *h.log.lock().unwrap() = said("check CI and tell me what failed", "all green");
    h.jobs.tick(h.as_ref(), at(2027, 3, 15, 13, 5)).await; // finishes it

    // 7:59 AM local: nothing. 8:00 AM local: the run.
    h.jobs.tick(h.as_ref(), at(2027, 3, 15, 14, 59)).await;
    assert_eq!(h.sends.lock().unwrap().len(), 1);
    h.jobs.tick(h.as_ref(), at(2027, 3, 15, 15, 0)).await;
    assert_eq!(h.sends.lock().unwrap().len(), 2);
    assert_eq!(h.jobs.list()[0].job.next_run, at(2027, 3, 16, 15, 0));

    // A job saved before zones were kept, on the fixed offset: 16:00 UTC,
    // 9:00 AM daylight time — the drift this fixes.
    let fixed = Every::parse("every day at 8am", 0).unwrap();
    assert_eq!(
        fixed.next_after(at(2027, 3, 15, 13, 0), -480),
        at(2027, 3, 15, 16, 0)
    );
}

#[test]
fn change_day_hours_that_do_not_exist_or_happen_twice_run_once() {
    let zone = zone_of(Some(LA), 0);
    // 2027-03-14: 2:00 AM jumps to 3:00 AM. 2:30 AM does not exist; it
    // runs at 3:30 AM daylight time (10:30 UTC), once.
    let gap = Every::parse("every day at 2:30am", 0).unwrap();
    let first = gap.next_in(at(2027, 3, 14, 8, 0), &zone);
    assert_eq!(first, at(2027, 3, 14, 10, 30));
    assert_eq!(gap.next_in(first, &zone), at(2027, 3, 15, 9, 30));
    // 2026-11-01: 2:00 AM falls back to 1:00 AM. 1:30 AM happens twice;
    // it runs at the first (daylight, 08:30 UTC), not again an hour later.
    let fold = Every::parse("every day at 1:30am", 0).unwrap();
    let first = fold.next_in(at(2026, 11, 1, 7, 0), &zone);
    assert_eq!(first, at(2026, 11, 1, 8, 30));
    assert_eq!(fold.next_in(first, &zone), at(2026, 11, 2, 9, 30));
    // A weekday schedule names the weekday on the job's own clock: 4:00 PM
    // Sunday in Los Angeles is already Monday in UTC.
    let monday = Every::parse("every Monday at 9am", 0).unwrap();
    assert_eq!(
        monday.next_in(at(2027, 3, 15, 0, 0), &zone),
        at(2027, 3, 15, 16, 0)
    );
}

#[test]
fn the_jobs_zone_rules_whatever_the_hosts_clock_or_the_phones_now() {
    // Saved on a phone in India (UTC+5:30, no daylight saving): 8:00 AM
    // there is 02:30 UTC, on the Mac or on the away server (UTC) alike.
    let h = host();
    let req = NewJob {
        tz: Some("Asia/Kolkata".into()),
        offset_min: 330,
        ..new_job("every morning")
    };
    let job = h.jobs.create(req, at(2026, 11, 17, 0, 0)).unwrap().job;
    assert_eq!(job.next_run, at(2026, 11, 17, 2, 30));
    // A name that is not a zone, or a path, is not kept: the offset rules.
    for bad in ["Not/AZone", "../../etc/passwd", "/usr/share/zoneinfo/UTC"] {
        let req = NewJob {
            tz: Some(bad.into()),
            ..new_job("every morning")
        };
        assert_eq!(
            h.jobs.create(req, at(2026, 11, 17, 0, 0)).unwrap().job.tz,
            None
        );
    }
}

#[test]
fn saved_jobs_with_only_an_offset_move_to_a_zone_that_had_it() {
    let dir = std::env::temp_dir().join(format!("nightloom-jobs-{}", uuid::Uuid::new_v4()));
    let old = Jobs::open_in(dir.clone(), None);
    let made = at(2026, 11, 16, 15, 0);
    let pacific = old
        .create(new_job("every day at 8am"), made)
        .unwrap()
        .job
        .id;
    let india = NewJob {
        offset_min: 330,
        ..new_job("every day at 8am")
    };
    let india = old.create(india, made).unwrap().job.id;
    drop(old);
    // The Mac in Los Angeles: the job saved at UTC−8 in November takes its
    // zone; the one saved at UTC+5:30 keeps its offset for the phone.
    let mac = Jobs::open_in(dir.clone(), Some(LA.into()));
    let tz_of = |jobs: &Jobs, id: &str| {
        jobs.list()
            .into_iter()
            .find(|j| j.job.id == id)
            .unwrap()
            .job
            .tz
    };
    assert_eq!(tz_of(&mac, &pacific).as_deref(), Some(LA));
    assert_eq!(tz_of(&mac, &india), None);
    // Saved so: a host that names no zone reads it back.
    let again = Jobs::open_in(dir.clone(), None);
    assert_eq!(tz_of(&again, &pacific).as_deref(), Some(LA));

    // The phone names its zone: taken by the job with none when it had the
    // job's offset that day; a job with a zone keeps its own.
    let patch = |tz: &str| JobPatch {
        tz: Some(tz.into()),
        ..JobPatch::default()
    };
    let now = at(2026, 11, 17, 0, 0);
    again.patch(&india, patch("Europe/London"), now).unwrap();
    assert_eq!(tz_of(&again, &india), None, "London is not UTC+5:30");
    again.patch(&india, patch("Asia/Kolkata"), now).unwrap();
    assert_eq!(tz_of(&again, &india).as_deref(), Some("Asia/Kolkata"));
    again.patch(&pacific, patch("Asia/Tokyo"), now).unwrap();
    assert_eq!(tz_of(&again, &pacific).as_deref(), Some(LA));
}

// ---- item 780: Approve once / Approve always ----

fn approve(how: &str) -> JobPatch {
    JobPatch {
        approve: Some(how.into()),
        ..JobPatch::default()
    }
}

/// One run, start to end, at `t`: the clock starts it, it ends with
/// `log`, the clock finishes it.
async fn one_run(h: &Arc<FakeHost>, id: &str, t: DateTime<Utc>, log: Vec<SessionEvent>) {
    h.jobs.run_now(id).unwrap();
    h.jobs.tick(h.as_ref(), t).await;
    *h.running.lock().unwrap() = None;
    *h.log.lock().unwrap() = log;
    h.jobs.tick(h.as_ref(), t + Duration::seconds(60)).await;
}

fn read_only_of_preps(h: &FakeHost) -> Vec<bool> {
    h.preps.lock().unwrap().iter().map(|p| p.1).collect()
}

#[tokio::test]
async fn approve_once_lets_one_run_write_then_it_asks_again() {
    let h = host();
    let t0 = at(2026, 11, 16, 15, 0);
    let id = h
        .jobs
        .create(new_job("every day at 8am"), t0)
        .unwrap()
        .job
        .id;
    let v = h.jobs.patch(&id, approve("once"), t0).unwrap();
    assert_eq!((v.read_only, v.approval.as_str()), (false, "once"));
    let reply = || said("check CI and tell me what failed", "done");
    one_run(&h, &id, at(2026, 11, 16, 16, 0), reply()).await;
    let v = h.jobs.list().remove(0);
    assert_eq!((v.read_only, v.approval.as_str()), (true, "ask"));
    one_run(&h, &id, at(2026, 11, 16, 17, 0), reply()).await;
    assert_eq!(read_only_of_preps(&h), vec![false, true]);
}

/// The check: Approve always lets the next run write; editing the job's
/// message drops it back to asking.
#[tokio::test]
async fn approve_always_lets_every_run_write_until_the_message_changes() {
    let h = host();
    let t0 = at(2026, 11, 16, 15, 0);
    let id = h
        .jobs
        .create(new_job("every day at 8am"), t0)
        .unwrap()
        .job
        .id;
    let v = h.jobs.patch(&id, approve("always"), t0).unwrap();
    assert_eq!((v.read_only, v.approval.as_str()), (false, "always"));
    let reply = || said("check CI and tell me what failed", "done");
    one_run(&h, &id, at(2026, 11, 16, 16, 0), reply()).await;
    one_run(&h, &id, at(2026, 11, 16, 17, 0), reply()).await;
    assert_eq!(read_only_of_preps(&h), vec![false, false]);
    assert_eq!(h.jobs.list()[0].approval, "always");

    // The same words saved again change nothing; new words ask.
    let same = JobPatch {
        text: Some("check CI and tell me what failed".into()),
        ..JobPatch::default()
    };
    assert_eq!(h.jobs.patch(&id, same, t0).unwrap().approval, "always");
    let reword = JobPatch {
        text: Some("check CI and fix the lint".into()),
        ..JobPatch::default()
    };
    let v = h.jobs.patch(&id, reword, t0).unwrap();
    assert_eq!((v.read_only, v.approval.as_str()), (true, "ask"));
    one_run(
        &h,
        &id,
        at(2026, 11, 16, 18, 0),
        said("check CI and fix the lint", "ok"),
    )
    .await;
    assert_eq!(read_only_of_preps(&h), vec![false, false, true]);

    // Taken back by hand ("ask"), and the old page's switch still works.
    h.jobs.patch(&id, approve("always"), t0).unwrap();
    assert_eq!(
        h.jobs.patch(&id, approve("ask"), t0).unwrap().approval,
        "ask"
    );
    let old_page = JobPatch {
        approve_plan: Some(true),
        ..JobPatch::default()
    };
    assert_eq!(h.jobs.patch(&id, old_page, t0).unwrap().approval, "always");
    assert!(h.jobs.patch(&id, approve("forever"), t0).is_err());
}

fn refused(text: &str, tool: &str) -> Vec<SessionEvent> {
    serde_json::from_value(serde_json::json!([
        {"event": "user_message", "text": text, "at": "2026-11-16T16:00:00Z"},
        {"event": "tool_result", "tool_use_id": "t1", "name": tool, "is_error": true,
         "content": crate::agent::CHAT_POLICY_REASON, "at": "2026-11-16T16:00:30Z"},
        {"event": "tool_result", "tool_use_id": "t2", "name": "Read", "is_error": true,
         "content": "no such file", "at": "2026-11-16T16:00:31Z"},
        {"event": "assistant_message", "model": "m", "blocks": [{"type": "text", "text": "I could not run it"}],
         "stop_reason": null, "usage": {"input_tokens": 1, "output_tokens": 1}, "at": "2026-11-16T16:01:00Z"},
    ]))
    .unwrap()
}

#[test]
fn a_refusal_reads_as_what_it_wanted_in_his_words() {
    let events: Vec<serde_json::Value> = refused("go", "Bash")
        .iter()
        .map(|e| serde_json::to_value(e).unwrap())
        .collect();
    assert_eq!(refused_in(&events, "go"), vec!["run commands".to_string()]);
    // Only after the job's own message; an ordinary failed read is not one.
    assert!(refused_in(&events, "another message").is_empty());
}

#[tokio::test]
async fn a_read_only_run_refused_a_change_asks_and_approving_runs_it_again() {
    let h = host();
    let t0 = at(2026, 11, 16, 15, 0);
    let id = h
        .jobs
        .create(new_job("every day at 8am"), t0)
        .unwrap()
        .job
        .id;
    let text = "check CI and tell me what failed";
    one_run(&h, &id, at(2026, 11, 16, 16, 0), refused(text, "Edit")).await;
    let j = h.jobs.list().remove(0).job;
    let wanted = j.wanted.expect("the card asks");
    assert_eq!(wanted.what, vec!["edit files".to_string()]);

    // Approve once from the card: the run goes again at the next tick,
    // writable, and the card is gone.
    let v = h.jobs.patch(&id, approve("once"), t0).unwrap();
    assert!(v.job.wanted.is_none() && v.job.run_now);
    h.jobs.tick(h.as_ref(), at(2026, 11, 16, 16, 5)).await;
    assert_eq!(read_only_of_preps(&h), vec![true, false]);
    // A writable run's errors are its own: no card.
    *h.running.lock().unwrap() = None;
    *h.log.lock().unwrap() = refused(text, "Edit");
    h.jobs.tick(h.as_ref(), at(2026, 11, 16, 16, 7)).await;
    assert!(h.jobs.list()[0].job.wanted.is_none());

    // Keep read-only: the card goes, nothing runs, it stays read-only.
    one_run(&h, &id, at(2026, 11, 16, 17, 0), refused(text, "Bash")).await;
    assert!(h.jobs.list()[0].job.wanted.is_some());
    let keep = JobPatch {
        dismiss_wanted: Some(true),
        ..JobPatch::default()
    };
    let v = h.jobs.patch(&id, keep, t0).unwrap();
    assert!(v.job.wanted.is_none() && !v.job.run_now && v.read_only);
}
