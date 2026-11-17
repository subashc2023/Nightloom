//! Who runs a job's run: the Mac or the away server, never both (nightshift
//! item 781, blockers 2022 + 2040).
//!
//! The Mac's jobs run on the Mac — in the app, or in the background runner
//! when the app is quit ([`crate::jobs::runner`]). While the Mac sleeps,
//! the away server runs its copy of each job of a project marked "available
//! away": the Mac sends the list with every sync ([`put_mac_jobs`]), and a
//! GitHub workflow knocks the server awake ~15 minutes before each run
//! (`crate::jobs::knock`).
//!
//! **The lease** is the one record of who took a run, kept on the server
//! (`<home>/sync/leases.json`, written here only): a run is named by its
//! job and the time it was due, and the first to [`claim`] it holds it. The
//! Mac asks over `POST /api/sync/lease` before every run of an away job;
//! the server asks itself. A second claim by the same holder is granted
//! again (a run that could not start retries), one by the other is
//! [`Claim::Taken`] and that side moves the job on without running it.
//!
//! **The Mac goes first:** the server claims a run only once it is
//! [`AWAY_GRACE_MINUTES`] past due and the Mac has been silent (no sync, no
//! lease ask) for [`MAC_SILENT_MINUTES`] ([`away_may_claim`]); an awake
//! Mac's runner asks within a minute of the time. When the Mac cannot reach
//! the server it runs the job anyway — the one case two runs are possible
//! is a Mac with no network whose job the server also ran.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use crate::jobs::Job;

/// The server waits this long past a run's time before it claims it, so an
/// awake Mac (whose runner looks every minute) takes it first.
pub const AWAY_GRACE_MINUTES: i64 = 3;
/// … and only when the Mac has said nothing for this long.
pub const MAC_SILENT_MINUTES: i64 = 20;

/// The holders' names in the lease.
pub const MAC: &str = "mac";
pub const AWAY: &str = "away";

/// One writer at a time on the files below (one server process).
static LOCK: Mutex<()> = Mutex::new(());

fn guard() -> std::sync::MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

fn sync_dir(home: &Path) -> PathBuf {
    home.join("sync")
}

/// A run taken: the time it was due, by whom, when.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Lease {
    pub due: DateTime<Utc>,
    pub by: String,
    pub at: DateTime<Utc>,
}

/// `POST /api/sync/lease`'s body.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LeaseRequest {
    pub job: String,
    pub due: DateTime<Utc>,
}

/// The answer to a claim.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "claim", rename_all = "snake_case")]
pub enum Claim {
    /// Run it.
    Granted,
    /// The other side took this run (or a later one): move on, do not run.
    Taken { by: String, at: DateTime<Utc> },
    /// Not yet (the server's grace, or the Mac not silent long enough).
    Wait,
}

fn write_json(path: &Path, value: &impl Serialize) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    std::fs::rename(&tmp, path)
}

fn read_leases(home: &Path) -> std::collections::BTreeMap<String, Lease> {
    std::fs::read(sync_dir(home).join("leases.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Claim job `job`'s run due at `due` for `by`. Granted when nobody holds
/// it, or `by` already does; [`Claim::Taken`] when the other side holds it
/// or a later run of the job. A lease that cannot be written is still
/// granted to the asker (the run is worth more than the record).
pub fn claim(home: &Path, job: &str, due: DateTime<Utc>, by: &str, now: DateTime<Utc>) -> Claim {
    let _one = guard();
    let mut leases = read_leases(home);
    if let Some(l) = leases.get(job)
        && l.due >= due
        && (l.due > due || l.by != by)
    {
        return Claim::Taken {
            by: l.by.clone(),
            at: l.at,
        };
    }
    leases.insert(
        job.to_string(),
        Lease {
            due,
            by: by.to_string(),
            at: now,
        },
    );
    let _ = write_json(&sync_dir(home).join("leases.json"), &leases);
    Claim::Granted
}

/// The Mac said something now (any `/api/sync` request).
pub fn mac_seen(home: &Path, now: DateTime<Utc>) {
    let _one = guard();
    let _ = write_json(&sync_dir(home).join("mac-seen.json"), &now);
}

/// When the Mac last said something; `None` before it ever did.
pub fn mac_last_seen(home: &Path) -> Option<DateTime<Utc>> {
    std::fs::read(sync_dir(home).join("mac-seen.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
}

/// Whether the server may claim a run due at `due` now: the grace has
/// passed and the Mac has been silent long enough. Pure.
pub fn away_may_claim(
    mac_last_seen: Option<DateTime<Utc>>,
    due: DateTime<Utc>,
    now: DateTime<Utc>,
) -> bool {
    now >= due + Duration::minutes(AWAY_GRACE_MINUTES)
        && mac_last_seen.is_none_or(|seen| now - seen >= Duration::minutes(MAC_SILENT_MINUTES))
}

/// Keep the Mac's list of away jobs (`PUT /api/sync/jobs`): the server's
/// copy, which only this route writes.
pub fn put_mac_jobs(home: &Path, jobs: &[Job]) -> std::io::Result<()> {
    let _one = guard();
    write_json(&sync_dir(home).join("mac-jobs.json"), &jobs)
}

/// The Mac's last list, `None` before it sent one.
pub fn read_mac_jobs(home: &Path) -> Option<Vec<Job>> {
    std::fs::read(sync_dir(home).join("mac-jobs.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
}

/// The Mac's side: where its away server is and which of its jobs it may
/// also run — read from `~/.nightloom/away.json` (the desktop's file, read
/// only here), the token file and the registry's "available away" marks.
#[derive(Debug, Clone)]
pub struct MacAway {
    url: String,
    token: String,
    marked: std::collections::HashSet<String>,
    no_project: bool,
}

#[derive(Deserialize, Default)]
struct AwayFile {
    #[serde(default)]
    url: String,
    #[serde(default)]
    no_project: Option<bool>,
}

impl MacAway {
    /// `None` while sync is off (no URL) or no token is kept.
    pub fn load(config: &Path, projects: &[crate::project::Project]) -> Option<Self> {
        let file: AwayFile = std::fs::read(config.join("away.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        if file.url.trim().is_empty() {
            return None;
        }
        Some(Self {
            url: file.url,
            token: super::read_away_token(config)?,
            marked: projects
                .iter()
                .filter(|p| p.available_away)
                .map(|p| p.id.clone())
                .collect(),
            no_project: file.no_project.unwrap_or(true),
        })
    }

    /// Whether the away server has a copy of `job` (its project is marked).
    pub fn covers(&self, job: &Job) -> bool {
        !job.stand_in
            && match job.project.as_deref() {
                Some(p) => self.marked.contains(p),
                None => self.no_project,
            }
    }

    /// The Mac's jobs the away server keeps a copy of.
    pub fn away_jobs(&self, jobs: &[Job]) -> Vec<Job> {
        jobs.iter().filter(|j| self.covers(j)).cloned().collect()
    }

    pub fn client(&self) -> Result<super::Client, String> {
        super::Client::new(&self.url, &self.token)
    }

    /// May the Mac run this run? Granted for a job the server has no copy
    /// of, and whenever the server cannot be asked (the Mac goes first).
    pub async fn claim(&self, job: &Job, due: DateTime<Utc>) -> Claim {
        if !self.covers(job) {
            return Claim::Granted;
        }
        let Ok(client) = self.client() else {
            return Claim::Granted;
        };
        let req = LeaseRequest {
            job: job.id.clone(),
            due,
        };
        match client.lease(&req).await {
            Ok(Claim::Taken { by, at }) => Claim::Taken { by, at },
            _ => Claim::Granted,
        }
    }
}

/// The away server's claim on its stand-in copy of a Mac job.
pub fn away_claim(home: &Path, job: &Job, due: DateTime<Utc>, now: DateTime<Utc>) -> Claim {
    // The Mac already took it: no need to wait out its silence.
    if let Some(l) = read_leases(home).get(&job.id)
        && l.due >= due
        && l.by != AWAY
    {
        return Claim::Taken {
            by: l.by.clone(),
            at: l.at,
        };
    }
    if !away_may_claim(mac_last_seen(home), due, now) {
        return Claim::Wait;
    }
    claim(home, &job.id, due, AWAY, now)
}

impl super::Client {
    /// `POST /api/sync/lease`: may the Mac run this run? Asked with a short
    /// wait (a stopped server starts in seconds); any failure is `Err` and
    /// the Mac runs it (the Mac goes first).
    pub async fn lease(&self, req: &LeaseRequest) -> Result<Claim, String> {
        match tokio::time::timeout(
            std::time::Duration::from_secs(30),
            self.post_json::<_, Claim>("lease", req),
        )
        .await
        {
            Ok(r) => r,
            Err(_) => Err("the away server did not answer in 30 s".into()),
        }
    }

    /// `PUT /api/sync/jobs`: the Mac's away jobs, whole.
    pub async fn put_jobs(&self, jobs: &[Job]) -> Result<(), String> {
        self.post_empty("jobs", &jobs).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn home(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nl-lease-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn at(s: &str) -> DateTime<Utc> {
        s.parse().unwrap()
    }

    /// Item 781: a run the Mac took is the server's `Taken`, and the other
    /// way; the same holder asking again is granted; a later run is free.
    #[test]
    fn a_run_has_one_holder() {
        let h = home("one");
        let due = at("2026-11-17T16:00:00Z");
        let now = at("2026-11-17T16:00:30Z");
        assert_eq!(claim(&h, "j1", due, MAC, now), Claim::Granted);
        assert_eq!(claim(&h, "j1", due, MAC, now), Claim::Granted, "a retry");
        assert_eq!(
            claim(&h, "j1", due, AWAY, now),
            Claim::Taken {
                by: MAC.into(),
                at: now
            }
        );
        let next = at("2026-11-18T16:00:00Z");
        assert_eq!(claim(&h, "j1", next, AWAY, next), Claim::Granted);
        assert!(
            matches!(claim(&h, "j1", due, MAC, next), Claim::Taken { by, .. } if by == AWAY),
            "an older run asked after a later one was taken"
        );
        assert_eq!(claim(&h, "j2", due, AWAY, now), Claim::Granted);
        let _ = std::fs::remove_dir_all(&h);
    }

    #[test]
    fn the_server_waits_for_its_grace_and_a_silent_mac() {
        let due = at("2026-11-17T16:00:00Z");
        let long_ago = Some(at("2026-11-17T09:00:00Z"));
        assert!(!away_may_claim(long_ago, due, due));
        assert!(!away_may_claim(long_ago, due, at("2026-11-17T16:02:59Z")));
        assert!(away_may_claim(long_ago, due, at("2026-11-17T16:03:00Z")));
        assert!(away_may_claim(None, due, at("2026-11-17T16:03:00Z")));
        let lately = Some(at("2026-11-17T15:50:00Z"));
        assert!(!away_may_claim(lately, due, at("2026-11-17T16:05:00Z")));
        assert!(away_may_claim(lately, due, at("2026-11-17T16:10:00Z")));
    }
}
