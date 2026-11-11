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
        if let Some(id) = m.get("id").and_then(Value::as_str) {
            if !p.seen.insert(id.to_string()) {
                continue;
            }
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
    if len > p.len {
        if let Ok(mut f) = std::fs::File::open(path) {
            if f.seek(SeekFrom::Start(p.len)).is_ok() {
                let mut buf = Vec::new();
                if f.take(len - p.len).read_to_end(&mut buf).is_ok() {
                    // Only whole lines: a line being written waits for the next read.
                    let end = buf.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
                    fold(p, &String::from_utf8_lossy(&buf[..end]));
                    p.len += end as u64;
                }
            }
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
            if line.contains("\"cost-state\"") {
                if let Ok(v) = serde_json::from_str::<Value>(line) {
                    if v.get("type").and_then(Value::as_str) == Some("cost-state") {
                        return Some(v);
                    }
                }
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
    }
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
    let Some(dir) = crate::usage::claude_dir() else {
        return SessionFigures::default();
    };
    let Some(main) = find_transcript(&dir.join("projects"), id) else {
        return SessionFigures::default();
    };
    let rates = crate::usage::load_rates_in(&dir).ok();
    read_transcript(&main, rates.as_ref())
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
