//! A Claude Code chat's own totals — the "This session" block of the CLI's
//! `/usage` (nightshift item 569, 2026-11-10) — read from files Nightloom
//! does not own.
//!
//! **The source.** After every turn Claude Code appends a `cost-state` line
//! to the session's transcript, `~/.claude/projects/<dir>/<session>.jsonl`,
//! and restores it on `--resume`, so the newest line is the whole chat's
//! running total (measured 2026-11-10 on CLI 2.1.322: in all 200 of the
//! newest transcripts on his Mac, `claude -p` runs included; a 32-prompt
//! print-mode chat carried 11 such lines, cost rising $7.95 → $86.08 under
//! one `startTime`). Its fields are what `/usage` prints:
//!
//! ```text
//! {"type":"cost-state","totalCostUSD","totalAPIDuration","totalDuration",
//!  "totalLinesAdded","totalLinesRemoved",
//!  "modelUsage":{"<model>":{"inputTokens","outputTokens","cacheReadInputTokens",
//!                           "cacheCreationInputTokens","costUSD",…}}, …}
//! ```
//!
//! The totals count the chat's subagents too (their requests are billed to
//! the session). `/usage`'s "Active" time is not here: the CLI keeps it as
//! an in-memory telemetry counter and never writes it, so it is left out;
//! `totalDuration` (Claude Code's own clock over its runs) is offered as
//! run time instead, under its own name.
//!
//! **What's using the limits.** `/usage` splits the session by who spent
//! it: the main thread and each subagent type. The subagents' transcripts
//! sit beside the session, `<session>/subagents/agent-<id>.jsonl`, each
//! with a `.meta.json` naming its `agentType`. Each model's CLI cost
//! (`modelUsage.<model>.costUSD`, the CLI's own pricing) is divided between
//! the main transcript and the agent types by their tokens' weight at that
//! model's rates — `~/.claude/usage-rates.json` when it prices the model
//! (the ledger's table, `usage.rs`), else the API's standard shape (output
//! 5×, cache read 0.1×, writes 1.25× / 2× input). Within one model only the
//! shape matters, so the shares sum to the CLI's own total. That `/usage`
//! weighs its split the same way is `inferred`.
//!
//! Reads are cached by file length: a finished subagent's transcript is
//! read once, the growing main transcript from where the last read ended.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// One model's share of the chat, as `cost-state.modelUsage` has it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ModelFigures {
    pub model: String,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub cost_usd: f64,
}

/// One spender of the chat: `main` or a subagent type.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Spender {
    /// `main`, or the subagent type (`general-purpose`, `reusable`, …).
    pub who: String,
    /// How many subagents of this type ran (0 for `main`).
    pub agents: u32,
    pub cost_usd: f64,
    /// Of the chat's cost, 0–1.
    pub share: f64,
}

/// What the right column's "This chat" shows. `found: false` — no transcript
/// for the session, or one with no `cost-state` line yet — and every figure
/// is empty; nothing is estimated.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SessionFigures {
    pub found: bool,
    pub cost_usd: Option<f64>,
    pub api_ms: Option<u64>,
    /// `totalDuration`: Claude Code's own clock over the chat's runs.
    pub run_ms: Option<u64>,
    pub lines_added: Option<u64>,
    pub lines_removed: Option<u64>,
    /// Costliest first.
    pub models: Vec<ModelFigures>,
    /// Cache read over every input token (input + cache read + cache write).
    pub cache_hit: Option<f64>,
    /// Costliest first; empty when the chat ran no subagent.
    pub using: Vec<Spender>,
    /// The CLI could not price some model, so the cost is low.
    pub unknown_cost: bool,
    /// Of `cost_usd`, what the chat spent on replies a rewind (or a fresh
    /// CLI session) later left behind (nightshift item 675): the newest
    /// transcript's running total no longer holds them, and money spent
    /// stays counted. `None` when there is none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rewound_usd: Option<f64>,
}

/// Token counts of one transcript, by model, deduplicated by message id.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct Tokens {
    input: u64,
    output: u64,
    read: u64,
    w5m: u64,
    w1h: u64,
}

#[derive(Default)]
struct Parsed {
    len: u64,
    by_model: HashMap<String, Tokens>,
    seen: HashSet<String>,
}

static CACHE: Mutex<Option<HashMap<PathBuf, Parsed>>> = Mutex::new(None);

fn u(v: &Value, k: &str) -> u64 {
    v.get(k).and_then(Value::as_u64).unwrap_or(0)
}

/// Fold the assistant lines of `text` into `p`.
fn fold(p: &mut Parsed, text: &str) {
    for line in text.lines() {
        if !line.contains("\"assistant\"") {
            continue;
        }
        let Ok(o) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if o.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(m) = o.get("message") else { continue };
        let Some(usage) = m.get("usage") else {
            continue;
        };
        if let Some(id) = m.get("id").and_then(Value::as_str)
            && !p.seen.insert(id.to_string())
        {
            continue;
        }
        let model = m.get("model").and_then(Value::as_str).unwrap_or("unknown");
        let total_w = u(usage, "cache_creation_input_tokens");
        let (w5m, w1h) = match usage.get("cache_creation") {
            Some(c) => (
                u(c, "ephemeral_5m_input_tokens"),
                u(c, "ephemeral_1h_input_tokens"),
            ),
            None => (total_w, 0),
        };
        let t = p.by_model.entry(model.to_string()).or_default();
        t.input += u(usage, "input_tokens");
        t.output += u(usage, "output_tokens");
        t.read += u(usage, "cache_read_input_tokens");
        t.w5m += w5m;
        t.w1h += w1h;
    }
}

/// A transcript's tokens by model, read from where the last read of the
/// same file ended (only whole lines); from the start if it shrank.
fn tokens_of(path: &Path) -> HashMap<String, Tokens> {
    let Ok(meta) = std::fs::metadata(path) else {
        return HashMap::new();
    };
    let len = meta.len();
    let mut guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let cache = guard.get_or_insert_with(HashMap::new);
    let p = cache.entry(path.to_path_buf()).or_default();
    if len < p.len {
        *p = Parsed::default();
    }
    if len > p.len
        && let Ok(mut f) = std::fs::File::open(path)
        && f.seek(SeekFrom::Start(p.len)).is_ok()
    {
        let mut buf = Vec::new();
        if f.take(len - p.len).read_to_end(&mut buf).is_ok() {
            // Only whole lines: a line being written waits for the next read.
            let end = buf.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
            fold(p, &String::from_utf8_lossy(&buf[..end]));
            p.len += end as u64;
        }
    }
    p.by_model.clone()
}

/// The newest `cost-state` line of a transcript, read from its tail.
fn last_cost_state(path: &Path) -> Option<Value> {
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let mut window: u64 = 256 * 1024;
    loop {
        let start = len.saturating_sub(window);
        f.seek(SeekFrom::Start(start)).ok()?;
        let mut buf = Vec::new();
        (&mut f).take(len - start).read_to_end(&mut buf).ok()?;
        let text = String::from_utf8_lossy(&buf);
        // The first line of a window that does not start the file may be cut.
        let whole = if start == 0 {
            &text[..]
        } else {
            text.split_once('\n').map_or("", |(_, r)| r)
        };
        for line in whole.lines().rev() {
            if line.contains("\"cost-state\"")
                && let Ok(v) = serde_json::from_str::<Value>(line)
                && v.get("type").and_then(Value::as_str) == Some("cost-state")
            {
                return Some(v);
            }
        }
        if start == 0 {
            return None;
        }
        window *= 4;
    }
}

/// The token weight of `t` at a model's rate shape: input rate 1 and the
/// rest as multiples of it, the way `usage::cost` prices a row.
fn weight(t: &Tokens, shape: (f64, f64, f64, f64, f64)) -> f64 {
    let (i, o, crm, m5, m1) = shape;
    t.input as f64 * i
        + t.output as f64 * o
        + t.read as f64 * i * crm
        + t.w5m as f64 * i * m5
        + t.w1h as f64 * i * m1
}

const STANDARD_SHAPE: (f64, f64, f64, f64, f64) = (1.0, 5.0, 0.1, 1.25, 2.0);

fn shape_for(model: &str, rates: Option<&crate::usage::Rates>) -> (f64, f64, f64, f64, f64) {
    rates
        .and_then(|r| {
            let m = r.models.get(model)?;
            (m.input > 0.0).then_some((
                1.0,
                m.output / m.input,
                m.cache_read_mult,
                r.write_mult_5m,
                r.write_mult_1h,
            ))
        })
        .unwrap_or(STANDARD_SHAPE)
}

/// The figures of the transcript at `main` (its subagents in the folder
/// beside it), costed with `rates` where it prices a model. Pure over its
/// paths so a test drives it from fixtures.
pub fn read_transcript(main: &Path, rates: Option<&crate::usage::Rates>) -> SessionFigures {
    let Some(cs) = last_cost_state(main) else {
        return SessionFigures::default();
    };
    let f64_of = |k: &str| cs.get(k).and_then(Value::as_f64);
    let u64_of = |k: &str| cs.get(k).and_then(Value::as_f64).map(|v| v.max(0.0) as u64);
    let mut models: Vec<ModelFigures> = cs
        .get("modelUsage")
        .and_then(Value::as_object)
        .map(|o| {
            o.iter()
                .map(|(name, v)| ModelFigures {
                    model: name.clone(),
                    input: u(v, "inputTokens"),
                    output: u(v, "outputTokens"),
                    cache_read: u(v, "cacheReadInputTokens"),
                    cache_write: u(v, "cacheCreationInputTokens"),
                    cost_usd: v.get("costUSD").and_then(Value::as_f64).unwrap_or(0.0),
                })
                .collect()
        })
        .unwrap_or_default();
    models.sort_by(|a, b| b.cost_usd.total_cmp(&a.cost_usd));
    let (read, all) = models.iter().fold((0u64, 0u64), |(r, a), m| {
        (r + m.cache_read, a + m.input + m.cache_read + m.cache_write)
    });
    let cost = f64_of("totalCostUSD");

    // Who spent it: main and each subagent type.
    let mut buckets: BTreeMap<String, (u32, HashMap<String, Tokens>)> = BTreeMap::new();
    buckets.insert("main".into(), (0, tokens_of(main)));
    let sub_dir = main.with_extension("").join("subagents");
    if let Ok(rd) = std::fs::read_dir(&sub_dir) {
        let mut files: Vec<PathBuf> = rd
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
            .collect();
        files.sort();
        for p in files {
            let who = std::fs::read_to_string(p.with_extension("meta.json"))
                .ok()
                .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                .and_then(|v| {
                    v.get("agentType")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_else(|| "subagent".into());
            let b = buckets.entry(who).or_default();
            b.0 += 1;
            for (m, t) in tokens_of(&p) {
                let e = b.1.entry(m).or_default();
                e.input += t.input;
                e.output += t.output;
                e.read += t.read;
                e.w5m += t.w5m;
                e.w1h += t.w1h;
            }
        }
    }
    let mut using = Vec::new();
    if buckets.len() > 1 {
        let mut spent: BTreeMap<String, f64> = BTreeMap::new();
        for m in &models {
            let shape = shape_for(&m.model, rates);
            let ws: Vec<(&String, f64)> = buckets
                .iter()
                .map(|(who, (_, by))| (who, by.get(&m.model).map_or(0.0, |t| weight(t, shape))))
                .collect();
            let total: f64 = ws.iter().map(|w| w.1).sum();
            for (who, w) in ws {
                let part = if total > 0.0 {
                    m.cost_usd * w / total
                } else if who == "main" {
                    m.cost_usd
                } else {
                    0.0
                };
                *spent.entry(who.clone()).or_default() += part;
            }
        }
        let sum: f64 = spent.values().sum();
        if sum > 0.0 {
            using = spent
                .into_iter()
                .map(|(who, c)| Spender {
                    agents: buckets.get(&who).map_or(0, |b| b.0),
                    who,
                    cost_usd: c,
                    share: c / sum,
                })
                .collect();
            using.sort_by(|a, b| b.cost_usd.total_cmp(&a.cost_usd));
        }
    }
    SessionFigures {
        found: true,
        cost_usd: cost,
        api_ms: u64_of("totalAPIDuration"),
        run_ms: u64_of("totalDuration"),
        lines_added: u64_of("totalLinesAdded"),
        lines_removed: u64_of("totalLinesRemoved"),
        cache_hit: (all > 0).then(|| read as f64 / all as f64),
        models,
        using,
        unknown_cost: cs
            .get("hasUnknownModelCost")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        rewound_usd: None,
    }
}

/// Every `cost-state` of a transcript, oldest first: its `startTime` (the
/// CLI restores it with the cost, so it names the lineage) and its
/// `totalCostUSD`.
fn cost_states(path: &Path) -> Vec<(Option<f64>, f64)> {
    let Ok(text) = std::fs::read(path) else {
        return Vec::new();
    };
    String::from_utf8_lossy(&text)
        .lines()
        .filter(|l| l.contains("\"cost-state\""))
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|v| v.get("type").and_then(Value::as_str) == Some("cost-state"))
        .filter_map(|v| {
            Some((
                v.get("startTime").and_then(Value::as_f64),
                v.get("totalCostUSD").and_then(Value::as_f64)?,
            ))
        })
        .collect()
}

/// What `earlier` spent that `later` — the chat's next CLI session — did
/// not carry on (nightshift item 675). A rewind's session is a copy of the
/// one before it, cut at the rewind, so the two share their first
/// `cost-state` lines and the later one's total restarts from the last
/// shared line: the earlier session's total past that line is the rewound
/// replies' spend. Measured 2026-11-12 on his ICS 46 chat: 9.13 at the
/// rewind, the copy restarting from 8.91 — $0.22 the newest total lost.
///
/// With no shared line: the same `startTime` means the later session
/// restored the earlier one's cost without its lines, and it carries what
/// the earlier one had reached by the later one's first total; another
/// `startTime` (a fresh session) carries nothing. Pure.
fn left_behind(earlier: &[(Option<f64>, f64)], later: &[(Option<f64>, f64)]) -> f64 {
    let Some(&(start, last)) = earlier.last() else {
        return 0.0;
    };
    let shared = earlier
        .iter()
        .zip(later)
        .take_while(|(a, b)| a == b)
        .count();
    let carried = if shared > 0 {
        earlier[shared - 1].1
    } else {
        match later.first() {
            Some(&(s, first)) if s.is_some() && s == start => earlier
                .iter()
                .map(|e| e.1)
                .filter(|c| *c <= first)
                .fold(0.0, f64::max),
            _ => 0.0,
        }
    };
    (last - carried).max(0.0)
}

/// [`read_transcript`] for a chat that has run on several CLI sessions
/// (nightshift item 675): `chain` is every session the chat has had,
/// oldest first, the last one live. The figures are the live session's;
/// the cost adds what each earlier session spent that its successor left
/// behind, so a rewind never lowers it.
pub fn read_chain(chain: &[PathBuf], rates: Option<&crate::usage::Rates>) -> SessionFigures {
    let Some(main) = chain.last() else {
        return SessionFigures::default();
    };
    let mut f = read_transcript(main, rates);
    if !f.found || chain.len() < 2 {
        return f;
    }
    let states: Vec<_> = chain.iter().map(|p| cost_states(p)).collect();
    let lost: f64 = states.windows(2).map(|w| left_behind(&w[0], &w[1])).sum();
    // Under a cent of drift is float noise between two lines, not spend.
    if lost >= 0.005 {
        f.rewound_usd = Some(lost);
        f.cost_usd = Some(f.cost_usd.unwrap_or(0.0) + lost);
    }
    f
}

/// What the CLI restores as session `id`'s running cost on `--resume`:
/// its transcript's newest `cost-state` total (nightshift item 675). The
/// `result` line's `total_cost_usd` of a resumed or forked process starts
/// from it (measured 2026-11-12, CLI 2.1.322: a session at $0.00198, its
/// `--fork-session --no-session-persistence` fork answering one word for
/// $0.00135 reported `total_cost_usd` 0.00333). `None` with no transcript
/// or no `cost-state` in it, when the CLI restores nothing.
pub fn restored_cost_in(projects: &Path, id: &str) -> Option<f64> {
    let main = find_transcript(projects, id)?;
    last_cost_state(&main)?
        .get("totalCostUSD")
        .and_then(Value::as_f64)
}

/// [`restored_cost_in`] under the CLI's own projects folder.
pub fn restored_cost(id: &str) -> Option<f64> {
    restored_cost_in(&crate::agent::cli_session::projects_dir()?, id)
}

/// What one CLI process itself spent (nightshift item 675): its `result`
/// line's `total_cost_usd` less the running cost it restored at launch.
/// Never negative; `None` when the CLI named no cost.
pub fn own_cost(total: Option<f64>, restored: Option<f64>) -> Option<f64> {
    total.map(|t| (t - restored.unwrap_or(0.0)).max(0.0))
}

/// A session id is a file name here: letters, digits and dashes only.
fn plain_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// The transcript of Claude Code session `id` under `projects` (any
/// project folder: the CLI names it after the working directory, which a
/// chat may have changed), or `None`.
pub fn find_transcript(projects: &Path, id: &str) -> Option<PathBuf> {
    if !plain_id(id) {
        return None;
    }
    let name = format!("{id}.jsonl");
    std::fs::read_dir(projects)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path().join(&name))
        .find(|p| p.is_file())
}

/// The live figures of Claude Code session `id`.
pub fn read(id: &str) -> SessionFigures {
    read_chat(id, &[])
}

/// The live figures of a chat whose CLI session is `id` and whose earlier
/// sessions — a rewind starts a new one — were `earlier`, oldest first
/// (nightshift item 675; [`read_chain`]). An earlier session with no
/// transcript left is passed over.
pub fn read_chat(id: &str, earlier: &[String]) -> SessionFigures {
    let Some(dir) = crate::usage::claude_dir() else {
        return SessionFigures::default();
    };
    let projects = dir.join("projects");
    let Some(main) = find_transcript(&projects, id) else {
        return SessionFigures::default();
    };
    let mut chain: Vec<PathBuf> = Vec::new();
    for e in earlier {
        if e != id
            && let Some(p) = find_transcript(&projects, e)
            && !chain.contains(&p)
        {
            chain.push(p);
        }
    }
    chain.push(main);
    let rates = crate::usage::load_rates_in(&dir).ok();
    read_chain(&chain, rates.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(label: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nl-569-sf-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn assistant(id: &str, model: &str, inp: u64, out: u64, rd: u64, w1h: u64) -> String {
        format!(
            r#"{{"type":"assistant","message":{{"id":"{id}","model":"{model}","usage":{{"input_tokens":{inp},"output_tokens":{out},"cache_read_input_tokens":{rd},"cache_creation_input_tokens":{w1h},"cache_creation":{{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":{w1h}}}}}}}}}"#
        )
    }

    /// The shape measured in his orchestrator's transcript (770b9872) at
    /// 5:05 PM 2026-11-10, numbers trimmed: the newest `cost-state` wins,
    /// and cache hit is read over all input.
    #[test]
    fn the_newest_cost_state_is_the_chats_total() {
        let d = dir("total");
        let main = d.join("s-1.jsonl");
        let lines = [
            r#"{"type":"user","message":{"content":"hi"}}"#.to_string(),
            r#"{"type":"cost-state","sessionId":"s-1","totalCostUSD":1.0,"totalAPIDuration":10,"totalDuration":20,"totalLinesAdded":1,"totalLinesRemoved":0,"modelUsage":{}}"#.to_string(),
            assistant("m1", "claude-opus-5-5", 360, 6600, 32_800_000, 231_400),
            r#"{"type":"cost-state","sessionId":"s-1","totalCostUSD":64.03,"totalAPIDuration":7380000,"totalDuration":1346000,"totalLinesAdded":3332,"totalLinesRemoved":68,"modelUsage":{"claude-opus-5-5":{"inputTokens":360,"outputTokens":6600,"cacheReadInputTokens":32800000,"cacheCreationInputTokens":231400,"webSearchRequests":0,"costUSD":64.03}},"hasUnknownModelCost":false}"#.to_string(),
        ];
        std::fs::write(&main, lines.join("\n") + "\n").unwrap();
        let f = read_transcript(&main, None);
        assert!(f.found);
        assert_eq!(f.cost_usd, Some(64.03));
        assert_eq!(f.api_ms, Some(7_380_000));
        assert_eq!(f.run_ms, Some(1_346_000));
        assert_eq!((f.lines_added, f.lines_removed), (Some(3332), Some(68)));
        assert_eq!(f.models.len(), 1);
        assert_eq!(f.models[0].cache_write, 231_400);
        // His screenshot: 360 / 32.8M / 231.4k → "Cache hit 99%".
        let hit = f.cache_hit.unwrap();
        assert!((hit - 0.99298).abs() < 1e-4, "{hit}");
        // No subagents: no split.
        assert!(f.using.is_empty());
    }

    #[test]
    fn subagents_split_each_models_cost_by_type() {
        let d = dir("split");
        let main = d.join("s-2.jsonl");
        std::fs::write(
            &main,
            [
                assistant("a", "claude-opus-5-5", 0, 100, 0, 0),
                // A repeated content block of the same message counts once.
                assistant("a", "claude-opus-5-5", 0, 100, 0, 0),
                r#"{"type":"cost-state","totalCostUSD":10.0,"modelUsage":{"claude-opus-5-5":{"inputTokens":0,"outputTokens":500,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,"costUSD":10.0}}}"#.to_string(),
            ]
            .join("\n")
                + "\n",
        )
        .unwrap();
        let subs = d.join("s-2").join("subagents");
        std::fs::create_dir_all(&subs).unwrap();
        for (n, ty, out) in [
            ("x1", "general-purpose", 200u64),
            ("x2", "general-purpose", 100),
            ("x3", "reusable", 100),
        ] {
            std::fs::write(
                subs.join(format!("agent-{n}.jsonl")),
                assistant(&format!("s{n}"), "claude-opus-5-5", 0, out, 0, 0) + "\n",
            )
            .unwrap();
            std::fs::write(
                subs.join(format!("agent-{n}.meta.json")),
                format!(r#"{{"agentType":"{ty}"}}"#),
            )
            .unwrap();
        }
        let f = read_transcript(&main, None);
        let got: Vec<(String, u32, i64)> = f
            .using
            .iter()
            .map(|s| (s.who.clone(), s.agents, (s.share * 100.0).round() as i64))
            .collect();
        assert_eq!(
            got,
            vec![
                ("general-purpose".into(), 2, 60),
                ("main".into(), 0, 20),
                ("reusable".into(), 1, 20),
            ]
        );
        let sum: f64 = f.using.iter().map(|s| s.cost_usd).sum();
        assert!((sum - 10.0).abs() < 1e-9);
    }

    #[test]
    fn the_main_transcript_is_read_on_from_where_it_ended() {
        let d = dir("grow");
        let p = d.join("g.jsonl");
        std::fs::write(&p, assistant("1", "m", 1, 2, 3, 4) + "\n").unwrap();
        assert_eq!(tokens_of(&p)["m"].output, 2);
        // A half-written line waits; the whole one is added once.
        let mut more = std::fs::read_to_string(&p).unwrap();
        more.push_str(&(assistant("2", "m", 0, 5, 0, 0) + "\n"));
        more.push_str(r#"{"type":"assistant","message":{"id":"3""#);
        std::fs::write(&p, &more).unwrap();
        assert_eq!(tokens_of(&p)["m"].output, 7);
        assert_eq!(tokens_of(&p)["m"].output, 7);
    }

    #[test]
    fn no_transcript_or_no_cost_state_reads_as_not_found() {
        let d = dir("none");
        assert_eq!(find_transcript(&d, "../etc"), None);
        assert_eq!(find_transcript(&d, "abc"), None);
        std::fs::create_dir_all(d.join("-proj")).unwrap();
        std::fs::write(
            d.join("-proj").join("abc.jsonl"),
            assistant("1", "m", 1, 1, 1, 1) + "\n",
        )
        .unwrap();
        let p = find_transcript(&d, "abc").unwrap();
        assert_eq!(read_transcript(&p, None), SessionFigures::default());
    }

    /// Live check against a real transcript (item 569's measurement):
    /// `NL_569_SESSION=<id> cargo test … live_session_figures -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_session_figures() {
        let id = std::env::var("NL_569_SESSION").unwrap_or_default();
        let t0 = std::time::Instant::now();
        let f = read(&id);
        let first = t0.elapsed();
        let t1 = std::time::Instant::now();
        let again = read(&id);
        println!("{f:#?}\nfirst read {first:?}, second {:?}", t1.elapsed());
        assert_eq!(f, again);
    }

    fn cost_state(start: u64, total: f64) -> String {
        format!(
            r#"{{"type":"cost-state","sessionId":"x","totalCostUSD":{total},"startTime":{start},"modelUsage":{{}}}}"#
        )
    }

    fn transcript(d: &Path, name: &str, states: &[(u64, f64)]) -> PathBuf {
        let p = d.join(format!("{name}.jsonl"));
        let mut s = String::new();
        for (start, total) in states {
            s.push_str(r#"{"type":"user","message":{"content":"hi"}}"#);
            s.push('\n');
            s.push_str(&cost_state(*start, *total));
            s.push('\n');
        }
        std::fs::write(&p, s).unwrap();
        p
    }

    /// Item 675, the shape of his ICS 46 chat on 2026-11-12: a rewind's
    /// session is a cut copy of the one before, so its total restarts
    /// below where the chat had been — the chat's cost must not fall.
    #[test]
    fn a_rewind_never_lowers_the_chats_cost() {
        let d = dir("chain");
        let first = transcript(&d, "a", &[(7, 1.04), (7, 6.46)]);
        // Rewound at the first session's end: nothing left behind.
        let second = transcript(
            &d,
            "b",
            &[(7, 1.04), (7, 6.46), (7, 8.91), (7, 8.97), (7, 9.13)],
        );
        // Rewound two replies back: 9.13 − 8.91 left behind.
        let third = transcript(
            &d,
            "c",
            &[(7, 1.04), (7, 6.46), (7, 8.91), (7, 9.12), (7, 11.92)],
        );
        assert_eq!(read_transcript(&third, None).cost_usd, Some(11.92));
        let f = read_chain(&[first.clone(), second.clone(), third.clone()], None);
        assert!(
            (f.cost_usd.unwrap() - 12.14).abs() < 1e-9,
            "{:?}",
            f.cost_usd
        );
        assert!((f.rewound_usd.unwrap() - 0.22).abs() < 1e-9);
        // One session, or a chain that lost nothing, is the plain reading.
        assert_eq!(
            read_chain(std::slice::from_ref(&third), None).rewound_usd,
            None
        );
        let f = read_chain(&[first, second], None);
        assert_eq!((f.cost_usd, f.rewound_usd), (Some(9.13), None));
    }

    #[test]
    fn what_a_later_session_did_not_carry_is_left_behind() {
        let s = |v: &[(u64, f64)]| -> Vec<(Option<f64>, f64)> {
            v.iter().map(|(a, b)| (Some(*a as f64), *b)).collect()
        };
        // A fresh session (another start) carries nothing of the old one.
        assert_eq!(left_behind(&s(&[(1, 2.0), (1, 5.0)]), &s(&[(2, 0.5)])), 5.0);
        // The same lineage restored without its lines: all of it carried.
        assert_eq!(left_behind(&s(&[(1, 2.0), (1, 5.0)]), &s(&[(1, 5.5)])), 0.0);
        // … or restored from an earlier point of it.
        assert_eq!(left_behind(&s(&[(1, 2.0), (1, 5.0)]), &s(&[(1, 2.5)])), 3.0);
        // An earlier session with no reading spent nothing we can count.
        assert_eq!(left_behind(&[], &s(&[(1, 1.0)])), 0.0);
        // A successor with no reading yet: the whole earlier total stands.
        assert_eq!(left_behind(&s(&[(1, 2.0)]), &[]), 2.0);
    }

    /// Item 675: a resumed or forked process reports the session's running
    /// total; its own spend is that less what it restored.
    #[test]
    fn a_process_own_cost_is_its_total_less_what_it_restored() {
        let d = dir("own");
        let proj = d.join("projects").join("-some-folder");
        std::fs::create_dir_all(&proj).unwrap();
        transcript(&proj, "sess-1", &[(7, 0.5), (7, 0.0019812)]);
        let base = restored_cost_in(&d.join("projects"), "sess-1");
        assert_eq!(base, Some(0.0019812));
        let own = own_cost(Some(0.00332902), base).unwrap();
        assert!((own - 0.00134782).abs() < 1e-12, "{own}");
        // No transcript: nothing restored, the total is its own.
        assert_eq!(restored_cost_in(&d.join("projects"), "nope"), None);
        assert_eq!(own_cost(Some(0.25), None), Some(0.25));
        assert_eq!(own_cost(None, Some(1.0)), None);
        assert_eq!(own_cost(Some(1.0), Some(1.5)), Some(0.0));
    }

    /// Live check of a chat's chain (item 675's measurement):
    /// `NL_675_CHAIN=<id>,<id>,… cargo test … live_chain_figures -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_chain_figures() {
        let ids: Vec<String> = std::env::var("NL_675_CHAIN")
            .unwrap_or_default()
            .split(',')
            .map(str::to_string)
            .collect();
        let (last, earlier) = ids.split_last().unwrap();
        let alone = read(last);
        let all = read_chat(last, earlier);
        println!(
            "newest alone {:?}; chain {:?}, rewound {:?}",
            alone.cost_usd, all.cost_usd, all.rewound_usd
        );
    }

    #[test]
    fn a_cost_state_far_from_the_tail_is_still_found() {
        let d = dir("far");
        let p = d.join("f.jsonl");
        let mut s = String::from(r#"{"type":"cost-state","totalCostUSD":2.5,"modelUsage":{}}"#);
        s.push('\n');
        let filler = format!(r#"{{"type":"attachment","x":"{}"}}"#, "y".repeat(1000));
        for _ in 0..600 {
            s.push_str(&filler);
            s.push('\n');
        }
        std::fs::write(&p, s).unwrap();
        assert_eq!(read_transcript(&p, None).cost_usd, Some(2.5));
    }
}
