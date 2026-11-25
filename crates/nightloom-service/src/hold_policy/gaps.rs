//! His idle moments (item 878): every gap of more than an hour after a
//! request in a Nightloom chat's Claude Code session, on Opus 5.5 or
//! Fable 5.2, since [`SINCE_S`] — the population of items 541/579's
//! `features.py` exactly (same sessions, same main-chain requests, same
//! models; the last gap runs to now, censored). Reads from Nightloom
//! session files only the `agent_session` ids, and from the CLI's
//! transcripts only usage numbers, model, ids and timestamps — never a
//! message's text.

use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::io::BufRead;
use std::path::Path;

/// 2026-10-08 00:00 UTC: the population's start (579's; the price table
/// holds for the models since).
pub const SINCE_S: i64 = 1_791_417_600;
/// The models the price table knows.
pub const MODELS: [&str; 2] = ["claude-opus-5-5", "claude-fable-5-2"];

/// One idle moment.
#[derive(Debug, Clone, PartialEq)]
pub struct Gap {
    /// When the request before the gap was sent, unix seconds.
    pub t0: i64,
    /// Minutes to the next request (to now when censored).
    pub gap_min: f64,
    /// He has not come back yet.
    pub censored: bool,
    /// The context the next request would send, tokens.
    pub ctx: u64,
    pub fable: bool,
}

impl Gap {
    /// Pings needed to keep it warm to his return: ceil((gap − 60) / 55);
    /// a censored gap never resumes.
    pub fn need(&self) -> u32 {
        if self.censored {
            u32::MAX
        } else {
            ((self.gap_min - 60.0) / 55.0).ceil().max(0.0) as u32
        }
    }
}

fn ts(s: &str) -> Option<f64> {
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|t| t.timestamp_millis() as f64 / 1000.0)
}

/// Every `agent_session` id of a Nightloom chat file touched since `since`.
fn session_ids(config_dir: &Path, since: i64) -> HashSet<String> {
    #[derive(Deserialize)]
    struct Ev {
        event: Option<String>,
        id: Option<String>,
    }
    let mut ids = HashSet::new();
    let Ok(projects) = std::fs::read_dir(config_dir.join("projects")) else {
        return ids;
    };
    for p in projects.flatten() {
        let Ok(files) = std::fs::read_dir(p.path().join("sessions")) else {
            continue;
        };
        for f in files.flatten() {
            let path = f.path();
            if path.extension().is_none_or(|e| e != "jsonl") {
                continue;
            }
            let fresh = f
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
                .is_some_and(|d| d.as_secs() as i64 >= since);
            if !fresh {
                continue;
            }
            let Ok(file) = std::fs::File::open(&path) else {
                continue;
            };
            for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
                if !line.contains("\"agent_session\"") {
                    continue;
                }
                if let Ok(ev) = serde_json::from_str::<Ev>(&line)
                    && ev.event.as_deref() == Some("agent_session")
                    && let Some(id) = ev.id
                {
                    ids.insert(id);
                }
            }
        }
    }
    ids
}

/// One session's main-chain requests on the known models: (sent s,
/// context, fable), from every copy of its transcript (the CLI's folder
/// holds one session under several project folders after a move: 460
/// such on 2026-11-23), each message once.
fn requests(paths: &[std::path::PathBuf]) -> Vec<(f64, u64, bool)> {
    #[derive(Deserialize)]
    struct Line {
        #[serde(rename = "type")]
        kind: Option<String>,
        #[serde(rename = "isSidechain")]
        sidechain: Option<bool>,
        timestamp: Option<String>,
        message: Option<Msg>,
    }
    #[derive(Deserialize)]
    struct Msg {
        id: Option<String>,
        model: Option<String>,
        usage: Option<U>,
    }
    #[derive(Deserialize)]
    struct U {
        input_tokens: Option<u64>,
        cache_read_input_tokens: Option<u64>,
        cache_creation_input_tokens: Option<u64>,
    }
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for path in paths {
        let Ok(file) = std::fs::File::open(path) else {
            continue;
        };
        for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
            if !line.contains("\"usage\"") {
                continue;
            }
            let Ok(l) = serde_json::from_str::<Line>(&line) else {
                continue;
            };
            if l.kind.as_deref() != Some("assistant") || l.sidechain == Some(true) {
                continue;
            }
            let (Some(m), Some(t)) = (l.message, l.timestamp.as_deref().and_then(ts)) else {
                continue;
            };
            let (Some(id), Some(u)) = (m.id, m.usage) else {
                continue;
            };
            let Some(model) = m.model.filter(|m| MODELS.contains(&m.as_str())) else {
                continue;
            };
            if !seen.insert(id) {
                continue;
            }
            let c = u.input_tokens.unwrap_or(0)
                + u.cache_read_input_tokens.unwrap_or(0)
                + u.cache_creation_input_tokens.unwrap_or(0);
            out.push((t, c, model == MODELS[1]));
        }
    }
    out.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    out
}

/// Every idle moment since `since` (unix s), the last gap of each
/// session running to `now` (unix s), sorted by start.
pub fn extract(config_dir: &Path, claude_projects: &Path, since: i64, now: i64) -> Vec<Gap> {
    let ids = session_ids(config_dir, since);
    let mut files: HashMap<String, Vec<std::path::PathBuf>> = HashMap::new();
    if let Ok(dirs) = std::fs::read_dir(claude_projects) {
        for d in dirs.flatten() {
            let Ok(fs) = std::fs::read_dir(d.path()) else {
                continue;
            };
            for f in fs.flatten() {
                let p = f.path();
                if p.extension().is_some_and(|e| e == "jsonl")
                    && let Some(stem) = p.file_stem().and_then(|s| s.to_str())
                    && ids.contains(stem)
                {
                    files.entry(stem.to_string()).or_default().push(p);
                }
            }
        }
    }
    let mut sessions: Vec<_> = files.into_iter().collect();
    sessions.sort_by(|a, b| a.0.cmp(&b.0));
    let mut rows = Vec::new();
    for (_, paths) in &mut sessions {
        paths.sort();
        let reqs = requests(paths);
        rows.extend(gaps_of(&reqs, since, now));
    }
    let mut rows = dedupe(rows);
    rows.sort_by_key(|g| g.t0);
    rows
}

/// Item 961/970: a resumed or handed-off Claude Code session carries the
/// earlier sessions' history, so one idle moment shows up once per session
/// that holds it (194 of 482 on 2026-11-25). Keep the first copy of each
/// (t0, gap length) — rows arrive in session-id order, as the Python
/// features script keeps them.
pub fn dedupe(rows: Vec<Gap>) -> Vec<Gap> {
    let mut seen = std::collections::HashSet::new();
    rows.into_iter()
        .filter(|g| seen.insert((g.t0, g.gap_min.to_bits())))
        .collect()
}

/// One session's idle moments from its requests (sorted).
pub fn gaps_of(reqs: &[(f64, u64, bool)], since: i64, now: i64) -> Vec<Gap> {
    let mut out = Vec::new();
    for (i, &(t0, c0, f0)) in reqs.iter().enumerate() {
        let (t1, cens) = match reqs.get(i + 1) {
            Some(n) => (n.0, false),
            None => (now as f64, true),
        };
        let g = (t1 - t0) / 60.0;
        if g <= 60.0 || t0 < since as f64 {
            continue;
        }
        out.push(Gap {
            t0: t0.round() as i64,
            gap_min: (g * 10.0).round() / 10.0,
            censored: cens,
            ctx: c0,
            fable: f0,
        });
    }
    out
}
