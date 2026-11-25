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
        five_before: None,
        five_resets_at: None,
        forced: false,
        reading: None,
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

/// Item 952: two fetches of the same week carry reset times a fraction
/// of a second apart (microseconds change on every fetch, measured in
/// `~/.claude.json` on 2026-11-24); the run's points are the real move,
/// not the 0 a string compare gave. A different week is still unknown.
#[test]
fn the_cost_counts_across_two_fetches_of_the_same_week() {
    let mark = RunMark {
        started: at(2026, 11, 24, 16, 0),
        writable: false,
        week_before: Some(91),
        resets_at: Some("2026-11-25T09:59:59.974567+00:00".into()),
        five_before: Some(2),
        five_resets_at: Some("2026-11-24T20:00:00.000001+00:00".into()),
        forced: false,
        reading: None,
    };
    let after = |week_reset: &str, five_reset: &str| PlanUsage {
        seven_day: Some(93),
        five_hour: Some(7),
        seven_day_resets_at: Some(week_reset.into()),
        five_hour_resets_at: Some(five_reset.into()),
        ..PlanUsage::default()
    };
    let same = after(
        "2026-11-25T10:00:00.120000+00:00",
        "2026-11-24T19:59:59.880000+00:00",
    );
    assert_eq!(week_points(&mark, &same), Some(2));
    assert_eq!(five_points(&mark, &same), Some(5));
    let next = after(
        "2026-12-02T10:00:00.120000+00:00",
        "2026-11-25T01:00:00.000000+00:00",
    );
    assert_eq!(week_points(&mark, &next), None);
    assert_eq!(five_points(&mark, &next), None);
    assert!(same_reset(None, None));
    assert!(!same_reset(Some("2026-11-25T10:00:00Z"), None));
    assert!(!same_reset(
        Some("2026-11-25T10:00:00Z"),
        Some("2026-11-25T10:01:01Z")
    ));
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
    /// Item 951: what `usage_fresh` answers; `None` falls back to `usage`.
    fresh: Mutex<Option<Result<PlanUsage, String>>>,
    /// Item 951: how many times the guard asked for a fresh reading.
    fresh_asks: Mutex<u32>,
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
        fresh: Mutex::default(),
        fresh_asks: Mutex::default(),
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
    async fn usage_fresh(&self, max_age: std::time::Duration) -> Result<PlanUsage, String> {
        assert_eq!(max_age, crate::home::guard::GUARD_MAX_AGE);
        *self.fresh_asks.lock().unwrap() += 1;
        let set = self.fresh.lock().unwrap().clone();
        match set {
            Some(r) => r,
            None => self.usage().await.map(|u| u.plan),
        }
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
            pace: serde_json::Value::Null,
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

/// Item 784: a finished run's tool calls are kept as the measure of the
/// next one; the guard finds the job by its chat; a run he stopped on the
/// guard's card is listed as stopped and is not the measure.
#[tokio::test]
async fn a_runs_calls_are_kept_and_a_stopped_run_is_listed_as_stopped() {
    let h = host();
    let made = at(2026, 11, 16, 15, 0);
    h.jobs.create(new_job("every morning"), made).unwrap();
    let text = "check CI and tell me what failed";
    let run = |calls: usize, reply: &str| -> Vec<SessionEvent> {
        let mut blocks: Vec<serde_json::Value> = (0..calls)
            .map(|i| serde_json::json!({"type": "tool_use", "id": format!("t{i}"), "name": "Bash", "input": {}}))
            .collect();
        blocks.push(serde_json::json!({"type": "text", "text": reply}));
        serde_json::from_value(serde_json::json!([
            {"event": "user_message", "text": text, "at": "2026-11-16T16:00:00Z"},
            {"event": "assistant_message", "model": "m", "blocks": blocks,
             "stop_reason": null, "usage": {"input_tokens": 1, "output_tokens": 1}, "at": "2026-11-16T16:01:00Z"},
        ]))
        .unwrap()
    };
    let mut t = at(2026, 11, 16, 16, 0);
    for (calls, reply) in [
        (7, "all green".to_string()),
        (
            300,
            crate::runaway::stopped_line(&crate::runaway::Trip::Calls {
                made: 300,
                ceiling: 200,
                usual: None,
            }),
        ),
    ] {
        h.jobs.run_now(&h.jobs.list()[0].job.id).unwrap();
        *h.running.lock().unwrap() = Some("job-chat".into());
        h.jobs.tick(h.as_ref(), t).await;
        *h.running.lock().unwrap() = None;
        *h.log.lock().unwrap() = run(calls, &reply);
        h.jobs.tick(h.as_ref(), t + Duration::seconds(120)).await;
        t += Duration::hours(1);
        if calls == 7 {
            let j = h.jobs.list().remove(0).job;
            assert_eq!(j.last.as_ref().unwrap().calls, Some(7));
            assert_eq!(j.recent_calls, vec![7]);
            let usual = h
                .jobs
                .usual_for_chat("job-chat")
                .expect("found by its chat");
            assert_eq!(usual.recent_calls, vec![7]);
            assert_eq!(usual.title, text);
        }
    }
    let j = h.jobs.list().remove(0).job;
    let last = j.last.unwrap();
    assert_eq!(last.outcome, Outcome::Stopped);
    assert!(
        last.summary.starts_with(crate::runaway::STOPPED_PREFIX),
        "{}",
        last.summary
    );
    assert_eq!(
        j.recent_calls,
        vec![7],
        "the stopped run is not the measure"
    );
    assert!(h.jobs.usual_for_chat("other").is_none());
}

/// A host whose jobs live under `<config>/remote/jobs`, so Home's files go
/// to a folder of the test's own.
fn home_host() -> (Arc<FakeHost>, PathBuf) {
    let cfg = std::env::temp_dir().join(format!("nightloom-home-guard-{}", uuid::Uuid::new_v4()));
    let (tx, _) = broadcast::channel(8);
    let h = Arc::new(FakeHost {
        jobs: Jobs::open_in(cfg.join("remote").join("jobs"), None),
        tx,
        preps: Mutex::default(),
        sends: Mutex::default(),
        running: Mutex::default(),
        refuse: Mutex::default(),
        week: Mutex::new(Some(40)),
        five: Mutex::new(Some(10)),
        log: Mutex::default(),
        fresh: Mutex::default(),
        fresh_asks: Mutex::default(),
    });
    (h, cfg)
}

/// Item 763 H6: each stop of the spend guard — the 5-hour window at 80%,
/// the weekly window at 80%, today's cap — skips Home's scan before it is
/// prepared, says why on its row, moves it to its next time and writes the
/// code-only page; a job outside Home runs at the same figures.
#[tokio::test]
async fn homes_scan_stops_at_80_percent_or_the_daily_cap_and_says_why() {
    let (h, cfg) = home_host();
    let t0 = at(2026, 11, 17, 15, 0);
    assert!(h.jobs.ensure_home_scan("home-p", t0));
    let other = h.jobs.create(new_job("every hour"), t0).unwrap().job.id;
    let scan = crate::home::SCAN_JOB_ID;
    let row = |id: &str| {
        h.jobs
            .list()
            .into_iter()
            .find(|j| j.job.id == id)
            .unwrap()
            .job
    };

    *h.five.lock().unwrap() = Some(82);
    h.jobs.run_now(scan).unwrap();
    h.jobs.run_now(&other).unwrap();
    let t1 = at(2026, 11, 17, 16, 0);
    h.jobs.tick(h.as_ref(), t1).await;
    let j = row(scan);
    let last = j.last.clone().unwrap();
    assert_eq!(last.outcome, Outcome::Skipped);
    assert_eq!(last.summary, "skipped — the 5-hour window was at 82%");
    assert!(!j.run_now && j.next_run > t1 && j.retry_at.is_none());
    assert_eq!(
        h.preps.lock().unwrap().len(),
        1,
        "only the other job was prepared"
    );
    assert!(row(&other).running.is_some(), "a job outside Home runs");
    // Item 812: a pressed run asks (the Run anyway card) instead of
    // writing the code-only page; a scheduled skip writes it (below, in
    // `a_scheduled_home_run_is_still_refused_after_run_anyway`).
    assert_eq!(
        j.confirm.as_ref().map(|c| c.why.as_str()),
        Some("the 5-hour window was at 82%")
    );
    let date = super::local_date(t1, &j.zone()).unwrap();
    assert!(
        !crate::home::dir_in(&cfg)
            .join("scans")
            .join(format!("{date}.md"))
            .is_file()
    );

    *h.five.lock().unwrap() = Some(10);
    *h.week.lock().unwrap() = Some(80);
    h.jobs.run_now(scan).unwrap();
    h.jobs.tick(h.as_ref(), t1 + Duration::minutes(1)).await;
    assert_eq!(
        row(scan).last.unwrap().summary,
        "skipped — the weekly window was at 80%"
    );

    *h.week.lock().unwrap() = Some(40);
    crate::home::guard::record(&cfg, date, Some(1));
    h.jobs.run_now(scan).unwrap();
    h.jobs.tick(h.as_ref(), t1 + Duration::minutes(2)).await;
    assert_eq!(
        row(scan).last.unwrap().summary,
        "skipped — Home has used today's 1% of the week"
    );
    assert_eq!(h.preps.lock().unwrap().len(), 1, "never prepared");

    // Under every stop it runs.
    std::fs::write(crate::home::dir_in(&cfg).join("guard.json"), r#"{"cap":2}"#).unwrap();
    h.jobs.run_now(scan).unwrap();
    h.jobs.tick(h.as_ref(), t1 + Duration::minutes(3)).await;
    assert_eq!(h.preps.lock().unwrap().len(), 2);
    assert!(row(scan).running.is_some());
    let _ = std::fs::remove_dir_all(&cfg);
}

/// Item 951: Home's guard decides on a fresh reading (asked for with the
/// two-minute limit), cites it, and keeps it on the row; a reading still
/// stale after the refresh skips with its age; no reading at all runs and
/// says on the row that the 80% stop was not checked. A job outside Home
/// never asks for the refresh.
#[tokio::test]
async fn homes_guard_refreshes_cites_and_keeps_the_reading_it_used() {
    let (h, cfg) = home_host();
    let t0 = at(2026, 11, 24, 15, 0);
    assert!(h.jobs.ensure_home_scan("home-p", t0));
    let scan = crate::home::SCAN_JOB_ID;
    let sampled = at(2026, 11, 24, 15, 55);
    let reading = |week: Option<u8>, stale: bool, age: f64| PlanUsage {
        five_hour: week.map(|_| 0),
        seven_day: week,
        sampled_at_ms: Some(sampled.timestamp_millis()),
        age_seconds: Some(age),
        stale,
        source: "cli-usage".into(),
        ..PlanUsage::default()
    };

    // Fresh and over 80: skipped, the reading cited and kept. The files
    // (`usage`) say 40%: the fresh reading is the one that decides.
    *h.fresh.lock().unwrap() = Some(Ok(reading(Some(91), false, 20.0)));
    h.jobs.run_now(scan).unwrap();
    let t1 = at(2026, 11, 24, 16, 0);
    h.jobs.tick(h.as_ref(), t1).await;
    assert_eq!(*h.fresh_asks.lock().unwrap(), 1);
    let last = home_row(&h, scan).last.unwrap();
    assert_eq!(last.outcome, Outcome::Skipped);
    let zone = home_row(&h, scan).zone();
    let when = crate::home::guard::clock(sampled, &zone);
    assert_eq!(
        last.summary,
        format!("skipped — the weekly window was at 91% at {when} (a /usage run)")
    );
    assert_eq!(
        last.reading,
        Some(crate::home::guard::GuardReading {
            five_hour: Some(0),
            week: Some(91),
            sampled_at: Some(sampled),
            source: "cli-usage".into(),
        })
    );

    // Still stale after the refresh: skipped with its age.
    *h.fresh.lock().unwrap() = Some(Ok(reading(Some(50), true, 41.0 * 60.0)));
    h.jobs.run_now(scan).unwrap();
    h.jobs.tick(h.as_ref(), t1 + Duration::minutes(1)).await;
    let last = home_row(&h, scan).last.unwrap();
    assert_eq!(
        last.summary,
        "skipped — usage could not be read (last reading 41 min old)"
    );
    assert_eq!(last.reading.unwrap().week, Some(50));
    assert_eq!(h.preps.lock().unwrap().len(), 0, "never prepared");

    // Missing (no figure from either read): runs, the row says the stop
    // was not checked, and the run's mark keeps the empty reading.
    *h.fresh.lock().unwrap() = Some(Err("no reading".into()));
    *h.week.lock().unwrap() = None;
    *h.five.lock().unwrap() = None;
    // A job outside Home, due in the same tick, never refreshes.
    let other = h.jobs.create(new_job("every hour"), t1).unwrap().job.id;
    h.jobs.run_now(&other).unwrap();
    let asks = *h.fresh_asks.lock().unwrap();
    h.jobs.run_now(scan).unwrap();
    h.jobs.tick(h.as_ref(), t1 + Duration::minutes(2)).await;
    assert_eq!(
        *h.fresh_asks.lock().unwrap(),
        asks + 1,
        "the scan's ask alone"
    );
    assert!(home_row(&h, &other).running.unwrap().reading.is_none());
    let j = home_row(&h, scan);
    let mark = j.running.clone().expect("it runs");
    assert_eq!(mark.reading.unwrap().source, "none");
    assert_eq!(
        j.note.as_deref(),
        Some("usage could not be read — Home's 80% stop was not checked")
    );

    let _ = std::fs::remove_dir_all(&cfg);
}

/// Item 812: the job's row on a Home host.
fn home_row(h: &FakeHost, id: &str) -> Job {
    h.jobs
        .list()
        .into_iter()
        .find(|j| j.job.id == id)
        .unwrap()
        .job
}

/// Item 812: one finished run of Home's scan — started at `t`, its plan
/// figures moved to `week` / `five`, ended two minutes later.
async fn one_scan_run(h: &FakeHost, t: DateTime<Utc>, week: u8, five: u8) {
    let scan = crate::home::SCAN_JOB_ID;
    h.jobs.tick(h, t).await;
    assert!(home_row(h, scan).running.is_some(), "the run started");
    *h.running.lock().unwrap() = None;
    *h.week.lock().unwrap() = Some(week);
    *h.five.lock().unwrap() = Some(five);
    let text = home_row(h, scan).text;
    *h.log.lock().unwrap() = said(&text, "three things today");
    h.jobs.tick(h, t + Duration::seconds(120)).await;
    assert!(home_row(h, scan).running.is_none(), "the run ended");
}

/// Item 812: his Run now on a Home job the spend guard refuses is skipped
/// at once — nothing prepared, no code-only page — and carries the Run
/// anyway card: the guard's reason, the mean cost of its last runs, and
/// his 5-hour and weekly figures at the press.
#[tokio::test]
async fn run_now_past_the_spend_guard_skips_and_asks_with_the_estimate() {
    let (h, cfg) = home_host();
    let t0 = at(2026, 11, 17, 15, 0);
    let scan = crate::home::SCAN_JOB_ID;
    assert!(h.jobs.ensure_home_scan("home-p", t0));
    // A first run measures 2% of the week and 5% of the 5-hour window —
    // and uses today's 1% cap.
    h.jobs.run_now(scan).unwrap();
    one_scan_run(&h, at(2026, 11, 17, 16, 0), 42, 15).await;
    let j = home_row(&h, scan);
    assert_eq!(
        j.recent_cost,
        vec![RunCost {
            week: 2,
            five: Some(5)
        }]
    );
    assert!(!j.last.as_ref().unwrap().forced);

    let t1 = at(2026, 11, 17, 17, 0);
    let v = h.jobs.press_run(h.as_ref(), scan, t1).await.unwrap();
    let c = v.job.confirm.clone().expect("the card asks");
    assert_eq!(c.why, "Home has used today's 1% of the week");
    assert_eq!(
        (c.est_week, c.est_five, c.est_runs),
        (Some(2.0), Some(5.0), 1)
    );
    assert_eq!((c.five_hour, c.week, c.stale), (Some(15), Some(42), false));
    let last = v.job.last.clone().unwrap();
    assert_eq!(last.outcome, Outcome::Skipped);
    assert_eq!(
        last.summary,
        "skipped — Home has used today's 1% of the week"
    );
    assert!(!v.job.run_now && !v.job.force_once);
    assert_eq!(h.preps.lock().unwrap().len(), 1, "nothing more prepared");
    let date = super::local_date(t1, &v.job.zone()).unwrap();
    let page = crate::home::dir_in(&cfg)
        .join("scans")
        .join(format!("{date}.md"));
    assert!(
        std::fs::read_to_string(page).map_or(true, |p| !p.contains("Skipped:")),
        "a pressed run writes no skipped page"
    );
    // The tick after starts nothing.
    h.jobs.tick(h.as_ref(), t1 + Duration::minutes(1)).await;
    assert_eq!(h.preps.lock().unwrap().len(), 1);
    // A job outside Home runs at once from the same press.
    let other = h.jobs.create(new_job("every hour"), t0).unwrap().job.id;
    let v = h.jobs.press_run(h.as_ref(), &other, t1).await.unwrap();
    assert!(v.job.confirm.is_none() && v.job.run_now);
    let _ = std::fs::remove_dir_all(&cfg);
}

/// Item 812: Run anyway starts the job once, past the guard, and its run
/// row says `forced`; a second press while it waits is the same run.
#[tokio::test]
async fn run_anyway_starts_one_run_marked_forced() {
    let (h, cfg) = home_host();
    let t0 = at(2026, 11, 17, 15, 0);
    let scan = crate::home::SCAN_JOB_ID;
    assert!(h.jobs.ensure_home_scan("home-p", t0));
    *h.five.lock().unwrap() = Some(82);
    let v = h.jobs.press_run(h.as_ref(), scan, t0).await.unwrap();
    assert!(v.job.confirm.is_some());

    let anyway = JobPatch {
        run_anyway: Some(true),
        ..JobPatch::default()
    };
    let v = h.jobs.patch(scan, anyway.clone(), t0).unwrap();
    assert!(v.job.confirm.is_none() && v.job.run_now && v.job.force_once);
    h.jobs.patch(scan, anyway.clone(), t0).unwrap();
    // A Run now pressed meanwhile does not ask again: it is the same run.
    let v = h.jobs.press_run(h.as_ref(), scan, t0).await.unwrap();
    assert!(v.job.confirm.is_none() && v.job.force_once);

    one_scan_run(&h, t0 + Duration::minutes(1), 41, 86).await;
    assert_eq!(h.preps.lock().unwrap().len(), 1, "one run");
    assert_eq!(h.sends.lock().unwrap().len(), 1);
    let j = home_row(&h, scan);
    let last = j.last.clone().unwrap();
    assert_eq!(last.outcome, Outcome::Done);
    assert!(last.forced, "the run row says forced");
    assert_eq!((last.week_points, last.five_points), (Some(1), Some(4)));
    assert!(!j.force_once && !j.run_now && j.confirm.is_none());
    let row = serde_json::to_value(&last).unwrap();
    assert_eq!(row["forced"], true);
    // The next tick starts nothing more.
    h.jobs.tick(h.as_ref(), t0 + Duration::minutes(5)).await;
    assert_eq!(h.preps.lock().unwrap().len(), 1);
    let _ = std::fs::remove_dir_all(&cfg);
}

/// Item 812: Cancel on the card starts nothing; the row stays skipped with
/// its reason. A first run has no estimate yet.
#[tokio::test]
async fn cancel_on_the_run_anyway_card_starts_nothing() {
    let (h, cfg) = home_host();
    let t0 = at(2026, 11, 17, 15, 0);
    let scan = crate::home::SCAN_JOB_ID;
    assert!(h.jobs.ensure_home_scan("home-p", t0));
    *h.week.lock().unwrap() = Some(91);
    let v = h.jobs.press_run(h.as_ref(), scan, t0).await.unwrap();
    let c = v.job.confirm.unwrap();
    assert_eq!(c.why, "the weekly window was at 91%");
    assert_eq!((c.est_week, c.est_five, c.est_runs), (None, None, 0));

    let v = h
        .jobs
        .patch(
            scan,
            JobPatch {
                dismiss_confirm: Some(true),
                ..JobPatch::default()
            },
            t0,
        )
        .unwrap();
    assert!(v.job.confirm.is_none() && !v.job.run_now && !v.job.force_once);
    assert_eq!(
        v.job.last.unwrap().summary,
        "skipped — the weekly window was at 91%"
    );
    h.jobs.tick(h.as_ref(), t0 + Duration::minutes(1)).await;
    assert!(h.preps.lock().unwrap().is_empty(), "nothing started");
    let _ = std::fs::remove_dir_all(&cfg);
}

/// Item 812: the guard still refuses Home's scheduled runs, as before —
/// after a Run anyway too — and a scheduled skip raises no card.
#[tokio::test]
async fn a_scheduled_home_run_is_still_refused_after_run_anyway() {
    let (h, cfg) = home_host();
    let scan = crate::home::SCAN_JOB_ID;
    assert!(h.jobs.ensure_home_scan("home-p", at(2026, 11, 17, 0, 0)));
    // An hour before the scan's first 8:00 AM on this host's clock, so the
    // forced run and the scheduled one after it share a local date in any
    // zone (item 864: CI runs on UTC, where 15:00 UTC put them a day apart).
    let t0 = home_row(&h, scan).next_run - Duration::hours(1);
    *h.five.lock().unwrap() = Some(82);
    h.jobs.press_run(h.as_ref(), scan, t0).await.unwrap();
    h.jobs
        .patch(
            scan,
            JobPatch {
                run_anyway: Some(true),
                ..JobPatch::default()
            },
            t0,
        )
        .unwrap();
    one_scan_run(&h, t0 + Duration::minutes(1), 41, 85).await;
    assert_eq!(h.preps.lock().unwrap().len(), 1);

    let due = home_row(&h, scan).next_run;
    assert!(due > t0);
    h.jobs.tick(h.as_ref(), due + Duration::minutes(1)).await;
    let j = home_row(&h, scan);
    let last = j.last.clone().unwrap();
    assert_eq!(last.outcome, Outcome::Skipped);
    assert_eq!(last.summary, "skipped — the 5-hour window was at 85%");
    assert!(!last.forced);
    assert!(j.confirm.is_none(), "a scheduled skip does not ask");
    // That day's page is the forced run's (never written over); the next
    // scheduled skip, on a day with no page, writes its code-only page.
    let page = |at: DateTime<Utc>| {
        let date = super::local_date(at, &j.zone()).unwrap();
        std::fs::read_to_string(
            crate::home::dir_in(&cfg)
                .join("scans")
                .join(format!("{date}.md")),
        )
        .unwrap()
    };
    assert!(page(due).contains("three things today"));
    let next = j.next_run;
    assert!(next > due);
    h.jobs.tick(h.as_ref(), next + Duration::minutes(1)).await;
    assert!(page(next).contains("Skipped: the 5-hour window was at 85%\n"));
    assert!(home_row(&h, scan).confirm.is_none());
    assert_eq!(
        h.preps.lock().unwrap().len(),
        1,
        "the scheduled run did not start"
    );
    let _ = std::fs::remove_dir_all(&cfg);
}

/// Item 2105: the Mac's job rows are Home's jobs only, and the row's Run
/// now (the same `press_run` as the phone's) starts one under the guard and
/// raises the Run anyway card past it; a second press while it waits to
/// start is the same run.
#[tokio::test]
async fn the_macs_home_rows_run_now_starts_under_the_guard_and_asks_past_it() {
    let (h, cfg) = home_host();
    let t0 = at(2026, 11, 17, 15, 0);
    let scan = crate::home::SCAN_JOB_ID;
    assert!(h.jobs.ensure_home_scan("home-p", t0));
    let other = h.jobs.create(new_job("every hour"), t0).unwrap().job.id;
    let rows: Vec<String> = h.jobs.home_list().into_iter().map(|v| v.job.id).collect();
    assert_eq!(
        rows,
        vec![scan.to_string()],
        "only Home's jobs: {other} is not"
    );

    // Under the guard (10% / 40%, nothing spent today): it starts, no card.
    let v = h.jobs.press_run(h.as_ref(), scan, t0).await.unwrap();
    assert!(v.job.run_now && v.job.confirm.is_none());
    let v = h.jobs.press_run(h.as_ref(), scan, t0).await.unwrap();
    assert!(
        v.job.run_now && v.job.confirm.is_none(),
        "a second press is the same run"
    );
    one_scan_run(&h, t0 + Duration::minutes(1), 40, 10).await;
    assert_eq!(h.preps.lock().unwrap().len(), 1, "one run");

    // Past it (the 5-hour window at 82%): skipped, the card asks.
    *h.five.lock().unwrap() = Some(82);
    let v = h
        .jobs
        .press_run(h.as_ref(), scan, t0 + Duration::minutes(10))
        .await
        .unwrap();
    let c = v.job.confirm.clone().expect("the card asks");
    assert_eq!(c.why, "the 5-hour window was at 82%");
    assert!(!v.job.run_now);
    assert_eq!(
        h.jobs.home_list()[0]
            .job
            .confirm
            .as_ref()
            .map(|c| c.why.clone()),
        Some(c.why)
    );
    let _ = std::fs::remove_dir_all(&cfg);
}

/// Item 794: a host whose jobs live under a home of their own, so a
/// watch's note (`<home>/watch/…` for an unfiled job) lands in scratch.
fn host_with_home() -> (Arc<FakeHost>, std::path::PathBuf) {
    let home = std::env::temp_dir().join(format!("nightloom-794-{}", uuid::Uuid::new_v4()));
    let (tx, _) = broadcast::channel(8);
    let h = Arc::new(FakeHost {
        jobs: Jobs::open_in(Jobs::dir_under(&home), None),
        tx,
        preps: Mutex::default(),
        sends: Mutex::default(),
        running: Mutex::default(),
        refuse: Mutex::default(),
        week: Mutex::new(Some(40)),
        five: Mutex::new(Some(10)),
        log: Mutex::default(),
        fresh: Mutex::default(),
        fresh_asks: Mutex::default(),
    });
    (h, home)
}

fn watch_log(sent: &str, fetched: &[&str], reply: &str) -> Vec<SessionEvent> {
    let calls: Vec<serde_json::Value> = fetched
        .iter()
        .enumerate()
        .map(|(i, u)| serde_json::json!({"type": "tool_use", "id": format!("w{i}"), "name": "WebFetch", "input": {"url": u}}))
        .collect();
    serde_json::from_value(serde_json::json!([
        {"event": "user_message", "text": sent, "at": "2026-11-16T16:00:00Z"},
        {"event": "assistant_message", "model": "m", "blocks": calls,
         "stop_reason": null, "usage": {"input_tokens": 1, "output_tokens": 1}, "at": "2026-11-16T16:00:30Z"},
        {"event": "assistant_message", "model": "m", "blocks": [{"type": "text", "text": reply}],
         "stop_reason": null, "usage": {"input_tokens": 1, "output_tokens": 1}, "at": "2026-11-16T16:01:00Z"},
    ]))
    .unwrap()
}

#[tokio::test]
async fn a_watch_appends_what_changed_to_its_note_and_says_nothing_new_in_one_line() {
    let (h, home) = host_with_home();
    let made = at(2026, 11, 16, 15, 0);
    let v = h
        .jobs
        .create(
            NewJob {
                every: "every morning".into(),
                text: "Keep my ACE note current.".into(),
                offset_min: -480,
                tz: Some("America/Los_Angeles".into()),
                watch: Some(watch::Watch {
                    topic: "concept extrapolation".into(),
                    sources: vec!["https://aligned.ai/blog".into()],
                    note: String::new(),
                }),
                ..NewJob::default()
            },
            made,
        )
        .unwrap();
    assert!(
        v.read_only,
        "a watch is read-only: the host writes its note"
    );
    assert_eq!(v.job.title, "Watch — concept extrapolation");
    assert_eq!(
        v.job.watch.as_ref().unwrap().note,
        "watch-concept-extrapolation.md"
    );

    // Run 1: the message is his words plus the block; its turn end is quiet.
    let start = at(2026, 11, 16, 16, 0);
    h.jobs.tick(h.as_ref(), start).await;
    let sent = h.sends.lock().unwrap()[0].2.clone();
    assert!(sent.starts_with("Keep my ACE note current."));
    assert!(sent.contains(watch::WATCH_LINE));
    assert!(sent.contains("The note is new"));
    assert!(watch::is_quiet("job-chat"));
    *h.running.lock().unwrap() = None;
    *h.log.lock().unwrap() = watch_log(
        &sent,
        &["https://arxiv.org/abs/2511.00001"],
        "A preprint extends it to images.\n- Lee extends it to images — https://arxiv.org/abs/2511.00001\n- A rumour — https://rumour.example/x",
    );
    h.jobs
        .tick(h.as_ref(), start + Duration::seconds(120))
        .await;
    assert!(!watch::is_quiet("job-chat"));
    let j = h.jobs.list().remove(0).job;
    assert_eq!(
        j.last.as_ref().unwrap().summary,
        "A preprint extends it to images. (1 new, 1 unverified)"
    );
    let note = home.join("watch").join("watch-concept-extrapolation.md");
    let one = std::fs::read_to_string(&note).unwrap();
    assert!(one.contains("## 2026-11-16 8:00 AM — A preprint extends it to images."));
    assert!(one.contains("2511.00001 `external`"));
    assert!(one.contains("rumour.example/x `unverified: not opened in this run`"));

    // Run 2: the note's entries go into the message; nothing new is one line.
    let start2 = at(2026, 11, 17, 16, 0);
    h.jobs.tick(h.as_ref(), start2).await;
    let sent2 = h.sends.lock().unwrap()[1].2.clone();
    assert!(sent2.contains("Lee extends it to images"));
    *h.running.lock().unwrap() = None;
    *h.log.lock().unwrap() = watch_log(&sent2, &[], "Nothing new.");
    h.jobs
        .tick(h.as_ref(), start2 + Duration::seconds(120))
        .await;
    let j = h.jobs.list().remove(0).job;
    assert_eq!(j.last.as_ref().unwrap().summary, "Nothing new.");
    let two = std::fs::read_to_string(&note).unwrap();
    assert!(two.starts_with(&one), "earlier entries are never rewritten");
    assert_eq!(&two[one.len()..], "- 2026-11-17 8:00 AM — Nothing new.\n");

    // A patch changes the topic and pages; the note keeps its name.
    let p = h
        .jobs
        .patch(
            &j.id,
            JobPatch {
                watch: Some(watch::Watch {
                    topic: "ACE".into(),
                    sources: vec![],
                    note: "other.md".into(),
                }),
                ..JobPatch::default()
            },
            start2,
        )
        .unwrap();
    let w = p.job.watch.unwrap();
    assert_eq!(
        (w.topic.as_str(), w.note.as_str()),
        ("ACE", "watch-concept-extrapolation.md")
    );
    let _ = std::fs::remove_dir_all(&home);
}

/// Item 947 (jobs slice): a run's cost is the move between two readings;
/// a stale reading on either side is no measure — the same old sample
/// twice reads as "under 1%", which is not what it cost.
#[test]
fn a_stale_reading_on_either_side_gives_no_cost() {
    let mark = RunMark {
        started: at(2026, 11, 25, 6, 0),
        writable: false,
        week_before: Some(41),
        resets_at: Some("w1".into()),
        five_before: Some(10),
        five_resets_at: Some("f1".into()),
        forced: false,
        reading: None,
    };
    let after = |stale: bool| PlanUsage {
        seven_day: Some(41),
        seven_day_resets_at: Some("w1".into()),
        five_hour: Some(10),
        five_hour_resets_at: Some("f1".into()),
        stale,
        ..PlanUsage::default()
    };
    assert_eq!(week_points(&mark, &after(false)), Some(0));
    assert_eq!(week_points(&mark, &after(true)), None);
    assert_eq!(five_points(&mark, &after(true)), None);
}

/// Item 947: a Home run that ends while the usage reading cannot be
/// refreshed (an old cached figure) records no cost — not "under 1%" —
/// and adds no zero to the estimate the Run anyway card is built on.
#[tokio::test]
async fn a_home_run_ending_on_a_stale_reading_records_no_cost() {
    let (h, cfg) = home_host();
    let scan = crate::home::SCAN_JOB_ID;
    assert!(h.jobs.ensure_home_scan("home-p", at(2026, 11, 25, 5, 0)));
    h.jobs.run_now(scan).unwrap();
    let t = at(2026, 11, 25, 6, 0);
    h.jobs.tick(h.as_ref(), t).await;
    assert!(home_row(&h, scan).running.is_some());
    *h.running.lock().unwrap() = None;
    let text = home_row(&h, scan).text;
    *h.log.lock().unwrap() = said(&text, "three things today");
    *h.fresh.lock().unwrap() = Some(Ok(PlanUsage {
        five_hour: Some(10),
        seven_day: Some(40),
        seven_day_resets_at: Some("w1".into()),
        stale: true,
        age_seconds: Some(45.0 * 60.0),
        source: "cli-cache".into(),
        ..PlanUsage::default()
    }));
    h.jobs.tick(h.as_ref(), t + Duration::seconds(120)).await;
    let j = home_row(&h, scan);
    assert!(j.running.is_none(), "the run ended");
    let last = j.last.unwrap();
    assert_eq!(last.week_points, None);
    assert_eq!(last.five_points, None);
    assert!(j.recent_cost.is_empty());
    let _ = std::fs::remove_dir_all(&cfg);
}

/// Item 947: at 100% of a window Home's scan is skipped like at 80% — its
/// row, feed line and code-only page say why — instead of waiting for the
/// plan's reset with nothing on Home's page.
#[tokio::test]
async fn home_at_100_percent_skips_with_a_page_instead_of_waiting_silently() {
    let (h, cfg) = home_host();
    let scan = crate::home::SCAN_JOB_ID;
    assert!(h.jobs.ensure_home_scan("home-p", at(2026, 11, 25, 5, 0)));
    *h.week.lock().unwrap() = Some(100);
    let t = at(2026, 11, 25, 16, 0);
    h.jobs.tick(h.as_ref(), t).await;
    let j = home_row(&h, scan);
    let last = j.last.clone().expect("a skip, not a wait");
    assert_eq!(last.outcome, Outcome::Skipped);
    assert!(last.summary.contains("100%"), "{}", last.summary);
    assert!(j.retry_at.is_none() && j.next_run > t);
    let date = super::local_date(t, &j.zone()).unwrap();
    assert!(
        crate::home::dir_in(&cfg)
            .join("scans")
            .join(format!("{date}.md"))
            .is_file()
    );
    // Another job still waits for the reset, as before.
    let other = h.jobs.create(new_job("every hour"), t).unwrap().job.id;
    h.jobs.run_now(&other).unwrap();
    h.jobs.tick(h.as_ref(), t + Duration::minutes(1)).await;
    assert!(
        home_row(&h, &other)
            .note
            .is_some_and(|n| n.starts_with("waiting"))
    );
    let _ = std::fs::remove_dir_all(&cfg);
}
