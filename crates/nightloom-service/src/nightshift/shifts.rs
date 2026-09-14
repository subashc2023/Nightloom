//! Shifts — `shifts/<shift-id>/` (§6): `plan.json` (the GUI's, written
//! before launch and never after), `status.json` (the runner's, rewritten
//! atomically at every phase change and at least once a minute), and
//! `run.log`.
//!
//! `status.json` here follows `shiftctl.py`, which is ahead of the contract's
//! §6 example: it also carries `started`, `plan`, `pass`, per-unit `pass` and
//! `landing`, and a `landing` phase (§13.5). Every field is optional on the
//! way in and unknown keys are kept, so a runner one release ahead of this
//! GUI still renders.

use super::items::{self, PlanItem};
use super::{Config, launch, read_text, write_json_atomic};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// `plan.json`. `until`, `max_units` and `budget_usd` are `null` when the
/// plan does not bound that axis, which is how `shiftctl plan synth` writes
/// them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Plan {
    pub shift_id: String,
    #[serde(default)]
    pub created: String,
    /// `manual` or `schedule:<schedule-id>`.
    #[serde(default = "manual")]
    pub source: String,
    /// Written under §13.1 (round 5); struck by §13.1a (2026-09-11 night): a
    /// shift has no kind. Kept so older plans still parse; never written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default)]
    pub items: Vec<PlanItem>,
    #[serde(default)]
    pub until: Option<String>,
    #[serde(default)]
    pub max_units: Option<u32>,
    #[serde(default)]
    pub budget_usd: Option<f64>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

fn manual() -> String {
    "manual".into()
}

impl Plan {
    /// Selected ids in plan order — `shiftctl plan items`.
    pub fn selected(&self) -> Vec<String> {
        self.items
            .iter()
            .filter(|i| i.selected)
            .map(|i| i.id.clone())
            .collect()
    }

    /// What `shiftctl plan synth` would write: every item in global order,
    /// selected when it is `todo` or `in-progress` — whatever its kind
    /// (§13.1a: a shift has no kind; each pass follows its item's). The
    /// GUI's plan form starts from this and the user edits it.
    pub fn synthesise(
        root: &Path,
        config: &Config,
        shift_id: &str,
        max_units: Option<u32>,
        until: Option<String>,
        budget_usd: Option<f64>,
    ) -> Plan {
        let (items, _) = items::list_items(root, config);
        let items = items
            .into_iter()
            .map(|it| PlanItem {
                selected: it.status == "todo" || it.status == "in-progress",
                id: it.id,
            })
            .collect();
        Plan {
            shift_id: shift_id.to_string(),
            created: now(),
            source: manual(),
            kind: None,
            items,
            until,
            max_units,
            budget_usd,
            extra: serde_json::Map::new(),
        }
    }
}

/// One `units[]` entry of `status.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UnitStatus {
    pub n: u32,
    #[serde(default)]
    pub item_id: Option<String>,
    #[serde(default)]
    pub pass: Option<u32>,
    #[serde(default)]
    pub started: Option<String>,
    #[serde(default)]
    pub ended: Option<String>,
    /// `done | partial | failed | wip`, `null` while running (§13.2).
    #[serde(default)]
    pub outcome: Option<String>,
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub cost_usd: Option<f64>,
    #[serde(default)]
    pub turns: Option<u32>,
    #[serde(default)]
    pub continuation_commit: Option<String>,
    /// The pass ended in a landing pass (§13.5).
    #[serde(default)]
    pub landing: bool,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// `status.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Status {
    #[serde(default)]
    pub shift_id: String,
    #[serde(default)]
    pub pid: Option<u32>,
    /// `preflight | gate | unit | landing | continuation | checkpoint |
    /// review | page | sleeping | done | failed`.
    #[serde(default)]
    pub phase: String,
    #[serde(default)]
    pub phase_started: Option<String>,
    #[serde(default)]
    pub started: Option<String>,
    #[serde(default)]
    pub updated: Option<String>,
    #[serde(default)]
    pub head_at_start: Option<String>,
    /// Repo-relative path of the plan.
    #[serde(default)]
    pub plan: Option<String>,
    #[serde(default)]
    pub unit_index: u32,
    #[serde(default)]
    pub item_id: Option<String>,
    #[serde(default)]
    pub pass: Option<u32>,
    #[serde(default)]
    pub units: Vec<UnitStatus>,
    /// The usage snapshot as the runner wrote it; its keys have moved once
    /// already (`sampled` became `sampled_age_seconds`), so it is passed
    /// through rather than typed.
    #[serde(default)]
    pub usage: serde_json::Value,
    #[serde(default)]
    pub next_wake: Option<String>,
    /// The morning page, once written. The runner has written this as an
    /// absolute path; [`resolve_in`] handles both.
    #[serde(default)]
    pub page: Option<String>,
    /// The review note, once written, repo-relative.
    #[serde(default)]
    pub review: Option<String>,
    /// The exit code once finished; `null` while running — or interrupted,
    /// which is `null` with a dead pid.
    #[serde(default)]
    pub exit: Option<i32>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// A path from `status.json` — absolute as written, or relative to the
/// root — as an absolute path.
pub fn resolve_in(root: &Path, p: &str) -> PathBuf {
    let path = Path::new(p);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    }
}

/// What the Runs page lists.
#[derive(Debug, Clone, Serialize)]
pub struct ShiftSummary {
    pub id: String,
    pub dir: PathBuf,
    pub plan: Option<Plan>,
    pub status: Option<Status>,
    /// A file that exists but did not parse — shown, not swallowed.
    pub plan_error: Option<String>,
    pub status_error: Option<String>,
    /// `exit` is null and the pid is alive.
    pub live: bool,
    /// `exit` is null and the pid is dead: the exit trap committed WIP and
    /// the next shift redoes the pass (§6).
    pub interrupted: bool,
    /// `exit` is null and this platform cannot ask about the pid.
    pub unknown: bool,
    pub log_bytes: u64,
}

fn read_summary(root: &Path, dir: PathBuf) -> ShiftSummary {
    let id = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let (plan, plan_error) = read_optional::<Plan>(&dir.join("plan.json"));
    let (status, status_error) = read_optional::<Status>(&dir.join("status.json"));
    let (mut live, mut interrupted, mut unknown) = (false, false, false);
    if let Some(s) = &status
        && s.exit.is_none()
    {
        match s.pid.and_then(launch::pid_alive) {
            Some(true) => live = true,
            Some(false) => interrupted = true,
            None => unknown = true,
        }
    }
    let _ = root;
    ShiftSummary {
        id,
        log_bytes: fs::metadata(dir.join("run.log"))
            .map(|m| m.len())
            .unwrap_or(0),
        dir,
        plan,
        status,
        plan_error,
        status_error,
        live,
        interrupted,
        unknown,
    }
}

fn read_optional<T: for<'de> Deserialize<'de>>(path: &Path) -> (Option<T>, Option<String>) {
    match fs::read_to_string(path) {
        Err(_) => (None, None),
        Ok(text) => match serde_json::from_str::<T>(&text) {
            Ok(v) => (Some(v), None),
            Err(e) => (None, Some(format!("{}: {e}", path.display()))),
        },
    }
}

/// Every shift directory, newest first.
pub fn list_shifts(root: &Path) -> Vec<ShiftSummary> {
    let Ok(entries) = fs::read_dir(root.join("shifts")) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .collect();
    dirs.sort();
    dirs.reverse();
    dirs.into_iter().map(|d| read_summary(root, d)).collect()
}

pub fn read_shift(root: &Path, shift_id: &str) -> Result<ShiftSummary, String> {
    check_id(shift_id)?;
    let dir = root.join("shifts").join(shift_id);
    if !dir.is_dir() {
        return Err(format!("no shift {shift_id}"));
    }
    Ok(read_summary(root, dir))
}

/// The last `max_bytes` of `run.log`, cut to a line boundary.
pub fn log_tail(root: &Path, shift_id: &str, max_bytes: usize) -> Result<String, String> {
    check_id(shift_id)?;
    let path = root.join("shifts").join(shift_id).join("run.log");
    let bytes = fs::read(&path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    let start = bytes.len().saturating_sub(max_bytes);
    let mut slice = &bytes[start..];
    if start > 0
        && let Some(nl) = slice.iter().position(|&b| b == b'\n')
    {
        slice = &slice[nl + 1..];
    }
    Ok(String::from_utf8_lossy(slice).into_owned())
}

/// A shift id is the runner's run id, `YYYY-MM-DDTHH-MM-SS` — and never a
/// path.
fn check_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == 'T')
    {
        return Err(format!("{id:?} is not a shift id"));
    }
    Ok(())
}

/// A fresh shift id from the local clock, the format the runner uses.
pub fn next_shift_id() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H-%M-%S").to_string()
}

fn now() -> String {
    chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string()
}

/// Write `shifts/<id>/plan.json` for a shift about to launch. Refuses while
/// a shift is live and when the plan already exists: a plan is never edited
/// after it is written (§6), so a second write is a second shift.
pub fn write_plan(root: &Path, plan: &Plan) -> Result<String, String> {
    launch::ensure_not_live(root)?;
    check_id(&plan.shift_id)?;
    let dir = root.join("shifts").join(&plan.shift_id);
    let path = dir.join("plan.json");
    if path.exists() {
        return Err(format!(
            "shifts/{}/plan.json already exists; a plan is never edited after it is written",
            plan.shift_id
        ));
    }
    fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let mut plan = plan.clone();
    if plan.created.is_empty() {
        plan.created = now();
    }
    write_json_atomic(&path, &plan)?;
    Ok(format!("shifts/{}/plan.json", plan.shift_id))
}

/// `plan.json` alone, for the launch command.
pub fn read_plan(root: &Path, shift_id: &str) -> Result<Plan, String> {
    check_id(shift_id)?;
    let path = root.join("shifts").join(shift_id).join("plan.json");
    serde_json::from_str(&read_text(&path)?).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::super::testutil::{fixture, scratch};
    use super::*;

    const REAL: &str = "2026-09-11T02-16-40";

    #[test]
    fn the_real_shift_reads_whole_and_round_trips_its_unknown_keys() {
        let s = read_shift(&fixture(), REAL).unwrap();
        assert_eq!(s.id, REAL);
        assert!(s.plan_error.is_none() && s.status_error.is_none());
        let plan = s.plan.unwrap();
        assert_eq!(plan.kind.as_deref(), Some("research"));
        assert_eq!(plan.max_units, Some(1));
        assert_eq!(plan.budget_usd, Some(75.0));
        assert_eq!(plan.until, None);
        assert_eq!(plan.selected().first().map(String::as_str), Some("017"));
        let st = s.status.unwrap();
        assert_eq!(st.phase, "done");
        assert_eq!(st.exit, Some(0));
        assert_eq!(st.pid, Some(66594));
        assert_eq!(st.pass, Some(1));
        assert_eq!(
            st.plan.as_deref(),
            Some("shifts/2026-09-11T02-16-40/plan.json")
        );
        assert_eq!(st.units.len(), 1);
        assert_eq!(st.units[0].outcome.as_deref(), Some("done"));
        assert_eq!(st.units[0].turns, Some(80));
        assert!(!st.units[0].landing);
        assert_eq!(st.usage["weekly_pct"], serde_json::json!(17));
        assert!(
            st.page
                .as_deref()
                .unwrap()
                .ends_with("mornings/2026-09-11.md")
        );
        assert!(!s.live && !s.interrupted && !s.unknown, "exit is set");
        assert!(s.log_bytes > 0);
        // A finished shift's absolute page path and relative review path both
        // resolve to something under a root.
        let root = Path::new("/r");
        assert!(resolve_in(root, st.page.as_deref().unwrap()).is_absolute());
        assert_eq!(
            resolve_in(root, st.review.as_deref().unwrap()),
            root.join("notes/reviews/2026-09-11-review-2026-09-11T02-16-40.md")
        );
        // Serialising keeps every key the runner wrote.
        let text =
            fs::read_to_string(fixture().join("shifts").join(REAL).join("status.json")).unwrap();
        let raw: serde_json::Value = serde_json::from_str(&text).unwrap();
        let back = serde_json::to_value(&st).unwrap();
        for key in raw.as_object().unwrap().keys() {
            assert!(back.get(key).is_some(), "lost {key}");
        }
    }

    #[test]
    fn an_unfinished_shift_is_live_interrupted_or_unknown_by_its_pid() {
        let ws = scratch();
        let dir = ws.join("shifts").join(REAL);
        let mut st: Status =
            serde_json::from_str(&fs::read_to_string(dir.join("status.json")).unwrap()).unwrap();
        st.exit = None;
        st.pid = Some(std::process::id());
        write_json_atomic(&dir.join("status.json"), &st).unwrap();
        let s = read_shift(&ws, REAL).unwrap();
        assert!(s.live || s.unknown);
        assert!(!s.interrupted);
        st.pid = Some(4194304);
        write_json_atomic(&dir.join("status.json"), &st).unwrap();
        let s = read_shift(&ws, REAL).unwrap();
        match launch::pid_alive(4194304) {
            Some(false) => assert!(s.interrupted && !s.live),
            _ => assert!(s.unknown),
        }
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn a_torn_status_is_reported_and_costs_only_that_field() {
        let ws = scratch();
        fs::write(
            ws.join("shifts").join(REAL).join("status.json"),
            "{\"shift_id\": ",
        )
        .unwrap();
        let s = read_shift(&ws, REAL).unwrap();
        assert!(s.status.is_none());
        assert!(s.status_error.is_some());
        assert!(s.plan.is_some());
        assert_eq!(list_shifts(&ws).len(), 1);
        assert!(read_shift(&ws, "../x").is_err());
        assert!(read_shift(&ws, "2000-01-01T00-00-00").is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn the_log_tail_cuts_to_a_line_boundary() {
        let tail = log_tail(&fixture(), REAL, 60).unwrap();
        assert!(tail.starts_with('['), "{tail:?}");
        assert!(tail.ends_with('\n'));
        let all = log_tail(&fixture(), REAL, 1 << 20).unwrap();
        assert!(all.starts_with("[02:16:46]"));
    }

    #[test]
    fn synthesise_matches_shiftctl_and_write_plan_writes_once() {
        let ws = scratch();
        let config = super::super::detect(&ws).unwrap().config;
        fs::write(
            ws.join("backlog/002-b.md"),
            "---\nid: 002\ntitle: b\nkind: build\nstatus: todo\n---\n",
        )
        .unwrap();
        fs::write(
            ws.join("backlog/003-c.md"),
            "---\nid: 003\ntitle: c\nstatus: done\n---\n",
        )
        .unwrap();
        let id = "2026-09-12T01-00-00";
        let plan = Plan::synthesise(&ws, &config, id, Some(2), None, Some(50.0));
        assert!(plan.kind.is_none(), "a shift has no kind (§13.1a)");
        let sel: Vec<(String, bool)> = plan
            .items
            .iter()
            .map(|i| (i.id.clone(), i.selected))
            .collect();
        // 017 (research, in-progress) and 002 (build, todo) are both
        // selected; 003 is done.
        assert_eq!(
            sel,
            vec![
                ("017".into(), true),
                ("002".into(), true),
                ("003".into(), false)
            ]
        );

        let rel = write_plan(&ws, &plan).unwrap();
        assert_eq!(rel, format!("shifts/{id}/plan.json"));
        let back = read_plan(&ws, id).unwrap();
        assert_eq!(back, plan);
        assert!(
            write_plan(&ws, &plan)
                .unwrap_err()
                .contains("already exists")
        );
        // The file has the shape shiftctl writes.
        let text = fs::read_to_string(ws.join(&rel)).unwrap();
        assert!(text.starts_with("{\n  \"shift_id\": "));
        assert!(text.ends_with("}\n"));
        assert!(text.contains("\"until\": null"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn shift_ids_have_the_runner_shape() {
        let id = next_shift_id();
        assert_eq!(id.len(), 19);
        assert_eq!(&id[10..11], "T");
        assert!(check_id(&id).is_ok());
        assert!(check_id("a/b").is_err());
        assert!(check_id("").is_err());
    }
}
