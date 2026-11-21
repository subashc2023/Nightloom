//! Item 781's runner, end to end over a stand-in `claude`: a job due at a
//! fake time runs with no app process holding the home; a woken away server
//! runs the Mac's copy once; the lease keeps the Mac from running it again.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use chrono::{DateTime, Duration, Utc};

use super::*;
use crate::jobs::{Jobs, NewJob, Outcome};
use crate::project::Registry;
use crate::remote::Host;
use crate::serve::{HomeLock, ServeConfig, ServeHost};
use crate::sync::lease;

fn root(name: &str) -> PathBuf {
    let r = std::env::temp_dir().join(format!("nl-runner-{name}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(r.join("ws")).unwrap();
    std::fs::create_dir_all(r.join("unfiled").join("sessions")).unwrap();
    r
}

fn cfg(root: &Path) -> ServeConfig {
    std::fs::write(root.join("mode"), "reply").unwrap();
    ServeConfig {
        binary: crate::serve::tests::stand_in(root),
        model: None,
        hook_exe: Some(PathBuf::from("/usr/bin/true")),
        assets: None,
        unfiled_dir: root.join("unfiled").join("sessions"),
        home: root.to_path_buf(),
        unfiled_workspace: root.join("ws"),
        nightshift_root: None,
    }
}

/// A day ahead of the real clock, so a listener's own clock (real time)
/// never finds the job due.
fn due_at() -> DateTime<Utc> {
    (Utc::now() + Duration::days(1))
        .with_timezone(&Utc)
        .date_naive()
        .and_hms_opt(8, 0, 0)
        .unwrap()
        .and_utc()
}

/// A job saved under `home`, due at `due`; its id.
fn save_job(home: &Path, due: DateTime<Utc>) -> String {
    let jobs = Jobs::open_in(Jobs::dir_under(home), None);
    let v = jobs
        .create(
            NewJob {
                every: "every day at 8am".into(),
                text: "check the CI".into(),
                title: Some("Check CI".into()),
                tz: Some("UTC".into()),
                ..Default::default()
            },
            due - Duration::hours(1),
        )
        .unwrap();
    assert_eq!(v.job.next_run, due);
    v.job.id
}

fn read_job(home: &Path, id: &str) -> crate::jobs::Job {
    let all: Vec<crate::jobs::Job> =
        serde_json::from_slice(&std::fs::read(Jobs::dir_under(home).join("jobs.json")).unwrap())
            .unwrap();
    all.into_iter().find(|j| j.id == id).unwrap()
}

/// A fake clock that starts at `from` and runs 100 times faster than real
/// time (a run's 20 s grace passes in 0.2 s).
fn fast_clock(from: DateTime<Utc>) -> impl Fn() -> DateTime<Utc> {
    let start = Instant::now();
    move || from + Duration::milliseconds(start.elapsed().as_millis() as i64 * 100)
}

fn runs(root: &Path) -> usize {
    std::fs::read_to_string(root.join("runs"))
        .map(|s| s.lines().count())
        .unwrap_or(0)
}

#[tokio::test]
async fn a_due_job_runs_with_no_app_holding_the_home_and_the_runner_lets_go() {
    let r = root("mac");
    let due = due_at();
    let id = save_job(&r, due);
    let make = |r: PathBuf| {
        move || {
            ServeHost::new_mac_runner(cfg(&r), Registry::load_from(r.join("projects.json")))
                as Arc<dyn Host>
        }
    };

    // Not yet due: the lock is not even taken.
    let before = run(
        &r,
        make(r.clone()),
        || due - Duration::minutes(5),
        std::time::Duration::from_millis(50),
    )
    .await;
    assert_eq!(before, Ran::NothingDue);

    // The app holds the home: its clock runs the job, the runner leaves it.
    {
        let _app = HomeLock::take(&r, "the Nightloom desktop app").unwrap();
        let held = run(
            &r,
            make(r.clone()),
            || due + Duration::seconds(10),
            std::time::Duration::from_millis(50),
        )
        .await;
        assert_eq!(held, Ran::HomeHeld);
        assert_eq!(runs(&r), 0);
    }

    // The app quit: the runner runs it, records it, and lets go.
    let ran = tokio::time::timeout(
        std::time::Duration::from_secs(60),
        run(
            &r,
            make(r.clone()),
            fast_clock(due + Duration::seconds(10)),
            std::time::Duration::from_millis(50),
        ),
    )
    .await
    .expect("the runner ends once the run ends");
    assert!(matches!(ran, Ran::Ticked(n) if n >= 2), "{ran:?}");
    assert_eq!(runs(&r), 1, "one run");
    let job = read_job(&r, &id);
    let last = job.last.expect("the run is recorded");
    assert_eq!(last.outcome, Outcome::Done);
    assert!(
        last.summary.contains("hi from the stand-in"),
        "{}",
        last.summary
    );
    assert!(job.running.is_none());
    assert!(job.next_run > due, "moved to its next time");
    // The desktop binary's flag form of the hooks.
    let args = std::fs::read_to_string(r.join("last-args")).unwrap();
    assert!(
        args.contains("--permission-hook") || args.contains("--mcp-serve"),
        "{args}"
    );
    // The home is free again (the app can open).
    assert!(HomeLock::take(&r, "the Nightloom desktop app").is_ok());
    let _ = std::fs::remove_dir_all(&r);
}

#[tokio::test]
async fn the_runner_starts_nothing_new_once_the_app_asks_for_the_home() {
    let r = root("yield");
    let due = due_at();
    save_job(&r, due);
    ask_to_yield(&r);
    let ran = run(
        &r,
        || {
            ServeHost::new_mac_runner(cfg(&r), Registry::load_from(r.join("projects.json")))
                as Arc<dyn Host>
        },
        || due + Duration::seconds(10),
        std::time::Duration::from_millis(50),
    )
    .await;
    assert_eq!(ran, Ran::Ticked(1));
    assert_eq!(runs(&r), 0, "nothing started");
    assert!(!r.join("runner-yield").exists(), "the ask is spent");
    let _ = std::fs::remove_dir_all(&r);
}

/// The away server, woken (the knock), runs its copy of the Mac's job once
/// the Mac has been silent and the grace has passed, and finishes it; the
/// Mac's runner, waking later, asks the lease over HTTP, is told the server
/// had it, and moves on without a second run.
#[tokio::test]
async fn a_woken_away_server_finishes_the_macs_job_and_the_lease_keeps_the_mac_from_a_second_run() {
    let mac = root("lease-mac");
    let away = root("lease-away");
    let due = due_at();
    let id = save_job(&mac, due);

    // The Mac's last sync sent its away jobs (unfiled: "No project" is
    // marked by default) and was an hour before the run.
    let mac_jobs: Vec<crate::jobs::Job> = vec![read_job(&mac, &id)];
    lease::put_mac_jobs(&away, &mac_jobs).unwrap();
    lease::mac_seen(&away, due - Duration::hours(1));

    let server_host = ServeHost::new(cfg(&away), Registry::load_from(away.join("projects.json")));
    let jobs = server_host.jobs().unwrap();
    // Before its grace: the server waits for the Mac.
    jobs.tick(server_host.as_ref(), due + Duration::minutes(1))
        .await;
    assert_eq!(runs(&away), 0);
    assert!(
        jobs.list().is_empty(),
        "a stand-in is never listed to the phone"
    );
    // Past it: claimed and run.
    let clock = fast_clock(due + Duration::minutes(4));
    jobs.tick(server_host.as_ref(), clock()).await;
    let started = Instant::now();
    while jobs.any_running() {
        assert!(
            started.elapsed() < std::time::Duration::from_secs(60),
            "the run ends"
        );
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        jobs.tick(server_host.as_ref(), clock()).await;
    }
    assert_eq!(runs(&away), 1);
    let copy = read_job(&away, &id);
    assert!(copy.stand_in);
    assert_eq!(copy.last.unwrap().outcome, Outcome::Done);
    // A stale list from the Mac (it slept through) does not make it due again.
    lease::put_mac_jobs(&away, &mac_jobs).unwrap();
    jobs.tick(server_host.as_ref(), clock()).await;
    assert_eq!(runs(&away), 1, "no second run on the server");
    assert!(read_job(&away, &id).next_run > due);

    // The server's listener, as Fly serves it; the Mac knows its URL and token.
    let token = "t0k3n".to_string();
    let server = crate::remote::Server::start_for_test(
        "127.0.0.1:0".parse().unwrap(),
        token.clone(),
        server_host.clone() as Arc<dyn Host>,
    )
    .await
    .unwrap();
    std::fs::write(
        mac.join("away.json"),
        format!(r#"{{"url":"http://{}"}}"#, server.addr()),
    )
    .unwrap();
    let tok = crate::sync::away_token_path(&mac);
    std::fs::create_dir_all(tok.parent().unwrap()).unwrap();
    std::fs::write(&tok, &token).unwrap();

    // The Mac wakes 20 minutes late; its runner asks, and moves on.
    let ran = run(
        &mac,
        || {
            ServeHost::new_mac_runner(cfg(&mac), Registry::load_from(mac.join("projects.json")))
                as Arc<dyn Host>
        },
        || due + Duration::minutes(20),
        std::time::Duration::from_millis(50),
    )
    .await;
    assert!(matches!(ran, Ran::Ticked(_)), "{ran:?}");
    assert_eq!(runs(&mac), 0, "the Mac did not run it again");
    let mine = read_job(&mac, &id);
    assert!(mine.next_run > due);
    assert_eq!(
        mine.note.as_deref(),
        Some("its 8:00 AM run ran on the away server")
    );
    assert!(mine.last.is_none());
    server.stop().await;
    let _ = std::fs::remove_dir_all(&mac);
    let _ = std::fs::remove_dir_all(&away);
}

#[test]
fn the_agent_runs_the_apps_own_binary_every_minute_and_only_from_an_installed_app() {
    let p = plist(
        Path::new("/Applications/Nightloom.app/Contents/MacOS/nightloom-desktop"),
        Path::new("/Users/x/.nightloom"),
        "/Users/x/.local/bin:/usr/bin:/bin",
    );
    assert!(
        p.contains("<string>/Applications/Nightloom.app/Contents/MacOS/nightloom-desktop</string>")
    );
    assert!(p.contains("<string>--jobs-runner</string>"));
    assert!(p.contains("<integer>60</integer>"));
    assert!(p.contains("/Users/x/.nightloom/logs/jobs-runner.log"));
    assert!(installs_from(
        Path::new("/Applications/Nightloom.app/Contents/MacOS/nightloom-desktop"),
        false
    ));
    assert!(!installs_from(
        Path::new("/Applications/Nightloom.app/Contents/MacOS/nightloom-desktop"),
        true
    ));
    assert!(!installs_from(
        Path::new("/x/target/debug/nightloom-desktop"),
        false
    ));
    assert!(!installs_from(
        Path::new("/x/target/release/bundle/macos/Nightloom.app/Contents/MacOS/nightloom-desktop"),
        false
    ));
}

/// Item 803 (merge round P): a `bootstrap` launchd refuses straight after
/// the `bootout` (its race) is tried again, and the install succeeds; one
/// that keeps failing stops after the tries, with pauses between.
#[test]
fn a_bootstrap_refused_right_after_a_bootout_is_tried_again() {
    let mut calls = 0;
    let mut pauses = Vec::new();
    assert!(bootstrap_retrying(
        || {
            calls += 1;
            calls >= 3
        },
        |n| pauses.push(n),
    ));
    assert_eq!((calls, pauses), (3, vec![1, 2]));
    let mut calls = 0;
    let mut pauses = Vec::new();
    assert!(!bootstrap_retrying(
        || {
            calls += 1;
            false
        },
        |n| pauses.push(n),
    ));
    assert_eq!(calls, BOOTSTRAP_TRIES);
    assert_eq!(pauses.len() as u32, BOOTSTRAP_TRIES - 1);
}

/// Item 803 (merge round P): an app opened from a DMG, from Downloads, or
/// from macOS's translocated copy never points the agent at itself; his
/// own `~/Applications` does.
#[test]
fn the_agent_installs_only_from_an_applications_folder_never_a_dmg_or_downloads() {
    let mac = "Nightloom.app/Contents/MacOS/nightloom-desktop";
    for away in [
        format!("/Volumes/Nightloom/{mac}"),
        format!("/Users/x/Downloads/{mac}"),
        format!("/Users/x/Desktop/{mac}"),
        format!("/private/var/folders/ab/xyz/T/AppTranslocation/1234/d/{mac}"),
        format!("/Volumes/Nightloom/Applications/{mac}"),
    ] {
        assert!(!installs_from(Path::new(&away), false), "{away}");
    }
    for home in [
        format!("/Applications/{mac}"),
        format!("/Users/x/Applications/{mac}"),
    ] {
        assert!(installs_from(Path::new(&home), false), "{home}");
    }
}

/// Item 781 (b): the away server stays up while a job is due or running
/// and while it is used; the bare `GET /` of Fly's health check is not use.
#[test]
fn the_away_server_stays_up_until_the_run_ends_then_exits_when_quiet() {
    use crate::serve::idle_exit_due;
    let t0: DateTime<Utc> = "2026-11-17T15:45:00Z".parse().unwrap();
    let idle = Duration::minutes(10);
    let later = t0 + Duration::minutes(30);
    assert!(!idle_exit_due(
        t0,
        None,
        t0 + Duration::minutes(5),
        idle,
        false,
        false
    ));
    assert!(idle_exit_due(t0, None, later, idle, false, false));
    assert!(
        !idle_exit_due(t0, None, later, idle, true, false),
        "a turn is running"
    );
    assert!(
        !idle_exit_due(t0, None, later, idle, false, true),
        "a job is due or running"
    );
    assert!(!idle_exit_due(
        t0,
        Some(later - Duration::minutes(2)),
        later,
        idle,
        false,
        false
    ));
    assert!(!crate::remote::counts_as_use("/", None));
    assert!(crate::remote::counts_as_use("/", Some("wake=job")));
    assert!(crate::remote::counts_as_use("/api/state", None));

    // The jobs' side: a run due in 15 minutes, or one running, keeps it up.
    let r = root("keep");
    let due = due_at();
    let id = save_job(&r, due);
    let jobs = Jobs::open_in(Jobs::dir_under(&r), None);
    let ahead = Duration::minutes(crate::serve::KEEP_UP_AHEAD_MINUTES);
    assert!(
        jobs.keeps_up(due - Duration::minutes(15), ahead),
        "knocked 15 min early"
    );
    assert!(!jobs.keeps_up(due - Duration::minutes(40), ahead));
    assert!(
        jobs.keeps_up(due + Duration::minutes(3), ahead),
        "waiting for its grace"
    );
    assert!(
        !jobs.keeps_up(due + Duration::hours(3), ahead),
        "a stuck run does not hold it all day"
    );
    let _ = id;
    let _ = std::fs::remove_dir_all(&r);
}
