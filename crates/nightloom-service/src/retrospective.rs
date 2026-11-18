//! The chat retrospective at hand-off (nightshift item 796, from item 793's
//! survey §4 #3 — Devin's "Session Insights": an issue timeline, what the
//! agent was told and then corrected on, a better prompt).
//!
//! Two halves, the first free:
//!
//! 1. **The digest** ([`digest_text`], [`digest_file`], [`render`]) — no
//!    model. It reads the chat's Claude Code transcript
//!    (`~/.claude/projects/<dir>/<session>.jsonl`, the file
//!    `session_figures` reads) line by line and lists, each with the line
//!    it comes from: tool errors and denials; calls repeated with the same
//!    input; requests whose cache read fell short of the context they
//!    resumed (a miss), with what the write cost; tokens by tool (a tool
//!    result's characters over four — an estimate, and said so) and by
//!    helper (the subagent split `session_figures` already makes); the
//!    instruction and memory files the chat read; and his messages that
//!    read like a correction, quoted verbatim.
//! 2. **The review pass** ([`review_prompt`]) — one model request, sent as
//!    an aside (`AgentSpec::aside`: a throwaway fork of the chat's own
//!    session, on its warm cache, nothing recorded), so the whole
//!    transcript is already in the model's context and only the digest is
//!    new. It turns the digest into the page: an issue timeline, the
//!    instructions or memories that were read and then contradicted by
//!    him, and at most three proposed rule changes as diffs, each citing
//!    a transcript line. [`page`] puts the answer above the digest;
//!    [`save_page`] keeps it in the chat's thread (or the project's
//!    `retrospectives/` folder), so it outlives the hand-off. Nothing is
//!    applied: each proposed change is a `- [ ]` line for his tick.
//!
//! Every reader here is pure over its text, so the suite drives it from
//! fixtures; nothing is sent anywhere.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::session_figures::Spender;
use crate::usage::Rates;

/// A quoted message longer than this is cut, and the cut is said.
pub const QUOTE_MAX: usize = 1_200;
/// An error or denial's text is cut to this many characters.
const ISSUE_MAX: usize = 240;
/// A repeated call's input is shown to this many characters.
const INPUT_MAX: usize = 160;
/// A request is a miss when its cache read is under this share of the
/// context the request before it carried (`bin/cachecheck.py`'s rule).
const MISS_SHARE: f64 = 0.8;
/// Requests resuming less than this are never a miss: a fresh chat's first
/// rounds write their prefix by design.
const MISS_MIN_CONTEXT: u64 = 20_000;
/// Claude Code's cache writes live an hour: a miss after a longer gap is
/// the cache's age, not a fault.
const CACHE_LIFE_MIN: f64 = 60.0;
/// At most this many rows of each list reach the page; the rest are counted.
pub const LIST_MAX: usize = 40;
/// At most this many proposed rule changes (793 §4 #3).
pub const MAX_DIFFS: usize = 3;

/// One tool call that failed or was refused.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolIssue {
    /// The transcript line (1-based) of the result.
    pub line: usize,
    pub tool: String,
    /// `denied` (refused by him, a rule or a hook) or `error`.
    pub kind: String,
    /// The result's first characters.
    pub text: String,
}

/// Calls of one tool with the same input, more than once.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Repeat {
    pub tool: String,
    /// The input, as JSON, cut to [`INPUT_MAX`].
    pub input: String,
    pub count: usize,
    pub lines: Vec<usize>,
}

/// A request whose cache read fell short of the context it resumed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Miss {
    pub line: usize,
    pub at: String,
    pub model: String,
    pub read: u64,
    pub write: u64,
    /// The context the request before it carried.
    pub before: u64,
    /// Minutes since the request before it; `None` without timestamps.
    pub gap_min: Option<f64>,
    /// The gap was over the cache's hour: expected, not a fault.
    pub expired: bool,
    /// What the write cost at the rates table's prices; `None` when the
    /// table does not price the model.
    pub cost_usd: Option<f64>,
}

/// One tool's calls and the estimated size of what they returned.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolTokens {
    pub tool: String,
    pub calls: usize,
    /// Characters of its results over four — an estimate.
    pub result_tokens: u64,
}

/// An instruction or memory file the chat read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InstructionRead {
    pub line: usize,
    pub path: String,
}

/// One of his messages that reads like a correction, verbatim.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Correction {
    pub line: usize,
    pub at: String,
    pub text: String,
    /// The message was longer than [`QUOTE_MAX`] and is cut.
    pub cut: bool,
    /// He stopped the turn (`[Request interrupted by user…]`).
    pub interrupt: bool,
}

/// What the script found, before any model.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Digest {
    /// The transcript's file name.
    pub transcript: String,
    pub lines: usize,
    /// Model requests (distinct assistant message ids with a usage).
    pub requests: usize,
    /// The largest context one request carried.
    pub peak_context: u64,
    /// His typed messages, all of them (the corrections are a subset).
    pub his_messages: usize,
    pub issues: Vec<ToolIssue>,
    pub repeats: Vec<Repeat>,
    pub misses: Vec<Miss>,
    /// The priced misses' write cost, expired ones left out.
    pub miss_cost_usd: f64,
    /// Costliest first.
    pub by_tool: Vec<ToolTokens>,
    /// The subagent split (`session_figures`); empty when none ran.
    pub helpers: Vec<Spender>,
    pub reads: Vec<InstructionRead>,
    pub corrections: Vec<Correction>,
    /// The chat's running cost, as the CLI's newest `cost-state` has it.
    pub cost_usd: Option<f64>,
}

fn cut(s: &str, max: usize) -> (String, bool) {
    if s.chars().count() <= max {
        return (s.to_string(), false);
    }
    (s.chars().take(max).collect::<String>(), true)
}

fn one_line(s: &str, max: usize) -> String {
    let flat: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    let (t, c) = cut(&flat, max);
    if c { format!("{t}…") } else { t }
}

fn u(v: &Value, k: &str) -> u64 {
    v.get(k).and_then(Value::as_u64).unwrap_or(0)
}

/// The text of a tool result's `content`: a string, or text blocks.
fn result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// A refusal rather than a failure: his "no" on a prompt, a permission
/// rule, a hook. The phrases are Claude Code's own (CLI 2.1.x).
fn is_denial(text: &str) -> bool {
    let t = text.to_lowercase();
    [
        "doesn't want to proceed",
        "tool use was rejected",
        "permission to use",
        "has been denied",
        "haven't granted it yet",
        "blocked by hook",
        "hook denied",
        "denied by",
        "not allowed",
    ]
    .iter()
    .any(|p| t.contains(p))
}

/// An instruction or memory file: what a correction may contradict.
fn is_instruction(path: &str) -> bool {
    let p = path.to_lowercase();
    p.ends_with("claude.md")
        || p.ends_with("agents.md")
        || p.ends_with("practices.md")
        || p.ends_with("contract.md")
        || p.ends_with("procedures.md")
        || p.contains("/memory/")
        || p.contains("/.claude/agents/")
        || p.contains("/.claude/skills/")
        || p.contains("/.claude/practices/")
}

/// Not something he typed: the CLI's own wrappers and notices.
fn wrapper(text: &str) -> bool {
    let t = text.trim_start();
    t.is_empty()
        || t.starts_with("<command-")
        || t.starts_with("<local-command")
        || t.starts_with("<task-notification")
        || t.starts_with("<system-reminder")
        || t.starts_with("<bash-")
        || t.starts_with("Caveat:")
}

/// His message reads like a correction: it opens with a "no", a "stop", a
/// "why did you", or says "I said", "not what I", "still broken" — a
/// heuristic, named as one on the page; the review pass judges from the
/// transcript, which it has whole.
pub fn reads_as_correction(text: &str) -> bool {
    let t = text.trim().to_lowercase();
    let t = t.trim_start_matches(|c: char| !c.is_alphanumeric());
    const OPENS: &[&str] = &[
        "no",
        "nope",
        "nah",
        "don't",
        "dont",
        "do not",
        "stop",
        "wait",
        "wrong",
        "that's not",
        "thats not",
        "that is not",
        "not ",
        "why ",
        "why?",
        "you didn't",
        "you did not",
        "you didnt",
        "i said",
        "i told you",
        "i asked",
        "never ",
        "instead",
        "actually",
        "undo",
        "revert",
        "what the",
        "wtf",
        "ugh",
        "again",
        "still ",
    ];
    const ANYWHERE: &[&str] = &[
        " i said ",
        "i told you",
        "not what i",
        "you forgot",
        "i asked you",
        "still broken",
        "still not",
        "doesn't work",
        "didn't work",
        "not working",
        "that's wrong",
        "this is wrong",
        "you broke",
        "why did you",
        "why are you",
        "i never said",
        "stop doing",
        "many times",
    ];
    let opens = OPENS.iter().any(|o| {
        t.starts_with(o)
            && (o.ends_with(' ')
                || o.ends_with('?')
                || t[o.len()..]
                    .chars()
                    .next()
                    .is_none_or(|c| !c.is_alphanumeric()))
    });
    opens || ANYWHERE.iter().any(|a| t.contains(a))
}

const INTERRUPT: &str = "[Request interrupted by user";

/// The digest of a transcript's text. `rates` prices a miss's write; the
/// helper split and the running cost need the files and are filled by
/// [`digest_file`].
pub fn digest_text(text: &str, rates: Option<&Rates>) -> Digest {
    let mut d = Digest::default();
    let mut names: HashMap<String, String> = HashMap::new();
    let mut seen_msg: std::collections::HashSet<String> = Default::default();
    let mut calls: BTreeMap<(String, String), Vec<usize>> = BTreeMap::new();
    let mut tools: HashMap<String, ToolTokens> = HashMap::new();
    let mut prev: Option<(u64, Option<chrono::DateTime<chrono::FixedOffset>>)> = None;
    for (i, raw) in text.lines().enumerate() {
        let line = i + 1;
        d.lines = line;
        let Ok(v) = serde_json::from_str::<Value>(raw) else {
            continue;
        };
        let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
        let at = v
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let Some(msg) = v.get("message") else {
            continue;
        };
        let content = msg.get("content");
        match kind {
            "assistant" => {
                if let Some(Value::Array(blocks)) = content {
                    for b in blocks {
                        if b.get("type").and_then(Value::as_str) != Some("tool_use") {
                            continue;
                        }
                        let name = b
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("?")
                            .to_string();
                        if let Some(id) = b.get("id").and_then(Value::as_str) {
                            names.insert(id.to_string(), name.clone());
                        }
                        let input = b.get("input").cloned().unwrap_or(Value::Null);
                        if let Some(p) = input
                            .get("file_path")
                            .or_else(|| input.get("path"))
                            .and_then(Value::as_str)
                            && name == "Read"
                            && is_instruction(p)
                        {
                            d.reads.push(InstructionRead {
                                line,
                                path: p.to_string(),
                            });
                        }
                        let key = serde_json::to_string(&input).unwrap_or_default();
                        calls.entry((name.clone(), key)).or_default().push(line);
                        tools
                            .entry(name.clone())
                            .or_insert_with(|| ToolTokens {
                                tool: name,
                                calls: 0,
                                result_tokens: 0,
                            })
                            .calls += 1;
                    }
                }
                let id = msg.get("id").and_then(Value::as_str).unwrap_or("");
                let Some(usage) = msg.get("usage") else {
                    continue;
                };
                if id.is_empty() || !seen_msg.insert(id.to_string()) {
                    continue;
                }
                d.requests += 1;
                let read = u(usage, "cache_read_input_tokens");
                let write = u(usage, "cache_creation_input_tokens");
                let ctx = u(usage, "input_tokens") + read + write;
                d.peak_context = d.peak_context.max(ctx);
                let when = chrono::DateTime::parse_from_rfc3339(&at).ok();
                if let Some((before, then)) = prev
                    && before >= MISS_MIN_CONTEXT
                    && (read as f64) < MISS_SHARE * before as f64
                {
                    let gap_min = match (then, when) {
                        (Some(a), Some(b)) => Some((b - a).num_seconds() as f64 / 60.0),
                        _ => None,
                    };
                    let expired = gap_min.is_some_and(|g| g > CACHE_LIFE_MIN);
                    let model = msg
                        .get("model")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let one_hour = usage
                        .get("cache_creation")
                        .map(|c| u(c, "ephemeral_1h_input_tokens"))
                        .unwrap_or(0);
                    let cost_usd = rates.and_then(|r| {
                        let m = r.models.get(&model)?;
                        let w1h = one_hour.min(write);
                        let w5m = write - w1h;
                        Some(
                            (w1h as f64 * r.write_mult_1h + w5m as f64 * r.write_mult_5m) * m.input
                                / 1e6,
                        )
                    });
                    if !expired {
                        d.miss_cost_usd += cost_usd.unwrap_or(0.0);
                    }
                    d.misses.push(Miss {
                        line,
                        at: at.clone(),
                        model,
                        read,
                        write,
                        before,
                        gap_min,
                        expired,
                        cost_usd,
                    });
                }
                prev = Some((ctx, when));
            }
            "user" => {
                let is_meta = v.get("isMeta").and_then(Value::as_bool).unwrap_or(false);
                let mut typed: Vec<String> = Vec::new();
                match content {
                    Some(Value::String(s)) => typed.push(s.clone()),
                    Some(Value::Array(blocks)) => {
                        for b in blocks {
                            match b.get("type").and_then(Value::as_str) {
                                Some("tool_result") => {
                                    let id = b.get("tool_use_id").and_then(Value::as_str);
                                    let tool = id
                                        .and_then(|id| names.get(id))
                                        .cloned()
                                        .unwrap_or_else(|| "?".to_string());
                                    let body = result_text(b.get("content"));
                                    if let Some(t) = tools.get_mut(&tool) {
                                        t.result_tokens += body.chars().count() as u64 / 4;
                                    }
                                    let err =
                                        b.get("is_error").and_then(Value::as_bool) == Some(true);
                                    if err {
                                        d.issues.push(ToolIssue {
                                            line,
                                            tool,
                                            kind: if is_denial(&body) { "denied" } else { "error" }
                                                .to_string(),
                                            text: one_line(&body, ISSUE_MAX),
                                        });
                                    }
                                }
                                Some("text") => {
                                    if let Some(t) = b.get("text").and_then(Value::as_str) {
                                        typed.push(t.to_string());
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                    _ => {}
                }
                if is_meta || v.get("isSidechain").and_then(Value::as_bool) == Some(true) {
                    continue;
                }
                for t in typed {
                    if t.trim_start().starts_with(INTERRUPT) {
                        d.corrections.push(Correction {
                            line,
                            at: at.clone(),
                            text: t.trim().to_string(),
                            cut: false,
                            interrupt: true,
                        });
                        continue;
                    }
                    if wrapper(&t) {
                        continue;
                    }
                    d.his_messages += 1;
                    if reads_as_correction(&t) {
                        let (text, cut) = cut(t.trim(), QUOTE_MAX);
                        d.corrections.push(Correction {
                            line,
                            at: at.clone(),
                            text,
                            cut,
                            interrupt: false,
                        });
                    }
                }
            }
            _ => {}
        }
    }
    d.repeats = calls
        .into_iter()
        .filter(|(_, lines)| lines.len() > 1)
        .map(|((tool, input), lines)| Repeat {
            tool,
            input: one_line(&input, INPUT_MAX),
            count: lines.len(),
            lines,
        })
        .collect();
    d.repeats
        .sort_by(|a, b| b.count.cmp(&a.count).then(a.lines[0].cmp(&b.lines[0])));
    d.by_tool = tools.into_values().collect();
    d.by_tool.sort_by(|a, b| {
        b.result_tokens
            .cmp(&a.result_tokens)
            .then(b.calls.cmp(&a.calls))
            .then(a.tool.cmp(&b.tool))
    });
    d
}

/// The digest of the transcript at `path`, with the subagent split and the
/// running cost (`session_figures::read_transcript`).
pub fn digest_file(path: &Path, rates: Option<&Rates>) -> std::io::Result<Digest> {
    let text = std::fs::read_to_string(path)?;
    let mut d = digest_text(&text, rates);
    d.transcript = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let figures = crate::session_figures::read_transcript(path, rates);
    d.helpers = figures
        .using
        .into_iter()
        .filter(|s| s.who != "main")
        .collect();
    d.cost_usd = figures.cost_usd;
    Ok(d)
}

/// The rates table, when `~/.claude/usage-rates.json` reads.
pub fn rates() -> Option<Rates> {
    crate::usage::load_rates_in(&crate::usage::claude_dir()?).ok()
}

/// The digest of Claude Code session `id` (any project folder), or why not.
pub fn digest_session(id: &str) -> Result<Digest, String> {
    let dir = crate::usage::claude_dir().ok_or("no Claude Code folder on this Mac")?;
    let path = crate::session_figures::find_transcript(&dir.join("projects"), id)
        .ok_or("this chat's Claude Code transcript is not on this Mac")?;
    digest_file(&path, rates().as_ref()).map_err(|e| format!("reading the transcript failed: {e}"))
}

fn usd(x: f64) -> String {
    if x < 0.01 && x > 0.0 {
        "<$0.01".to_string()
    } else {
        format!("${x:.2}")
    }
}

fn k(n: u64) -> String {
    if n >= 1_000 {
        format!("{:.1}k", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}

fn more(out: &mut String, total: usize) {
    if total > LIST_MAX {
        out.push_str(&format!("- … and {} more\n", total - LIST_MAX));
    }
}

/// The digest as Markdown: the page's lower half, and the review pass's input.
pub fn render(d: &Digest) -> String {
    let mut o = String::new();
    o.push_str(&format!(
        "Transcript `{}` — {} lines, {} model requests, largest context {} tokens, {} of his messages{}.\n\n",
        d.transcript,
        d.lines,
        d.requests,
        k(d.peak_context),
        d.his_messages,
        d.cost_usd
            .map(|c| format!(", running cost {} (the CLI's estimate)", usd(c)))
            .unwrap_or_default()
    ));

    let errors = d.issues.iter().filter(|i| i.kind == "error").count();
    let denials = d.issues.len() - errors;
    o.push_str(&format!(
        "### Tool errors and denials ({errors} errors, {denials} denials)\n"
    ));
    if d.issues.is_empty() {
        o.push_str("None.\n");
    }
    for i in d.issues.iter().take(LIST_MAX) {
        o.push_str(&format!(
            "- L{} {} {}: {}\n",
            i.line, i.tool, i.kind, i.text
        ));
    }
    more(&mut o, d.issues.len());

    o.push_str(&format!(
        "\n### Repeated identical calls ({})\n",
        d.repeats.len()
    ));
    if d.repeats.is_empty() {
        o.push_str("None.\n");
    }
    for r in d.repeats.iter().take(LIST_MAX) {
        let lines: Vec<String> = r.lines.iter().take(8).map(|l| format!("L{l}")).collect();
        o.push_str(&format!(
            "- {} ×{} ({}{}): `{}`\n",
            r.tool,
            r.count,
            lines.join(", "),
            if r.lines.len() > 8 { ", …" } else { "" },
            r.input.replace('`', "'")
        ));
    }
    more(&mut o, d.repeats.len());

    let unexplained = d.misses.iter().filter(|m| !m.expired).count();
    o.push_str(&format!(
        "\n### Cache misses ({} — {} past the cache's hour, {} not; the latter cost {})\n",
        d.misses.len(),
        d.misses.len() - unexplained,
        unexplained,
        usd(d.miss_cost_usd)
    ));
    if d.misses.is_empty() {
        o.push_str("None.\n");
    }
    for m in d.misses.iter().take(LIST_MAX) {
        o.push_str(&format!(
            "- L{} {}: read {} of {} before, wrote {}{}{}{}\n",
            m.line,
            m.at,
            k(m.read),
            k(m.before),
            k(m.write),
            m.cost_usd
                .map(|c| format!(" ({})", usd(c)))
                .unwrap_or_else(|| " (unpriced)".to_string()),
            m.gap_min
                .map(|g| format!(", {g:.0} min after the request before"))
                .unwrap_or_default(),
            if m.expired { " — expired" } else { "" }
        ));
    }
    more(&mut o, d.misses.len());

    o.push_str("\n### Tokens by tool (results' characters ÷ 4, an estimate)\n");
    if d.by_tool.is_empty() {
        o.push_str("No tool calls.\n");
    }
    for t in d.by_tool.iter().take(LIST_MAX) {
        o.push_str(&format!(
            "- {}: {} calls, ~{} tokens returned\n",
            t.tool,
            t.calls,
            k(t.result_tokens)
        ));
    }
    more(&mut o, d.by_tool.len());

    o.push_str("\n### By helper\n");
    if d.helpers.is_empty() {
        o.push_str("No subagents ran.\n");
    }
    for h in &d.helpers {
        o.push_str(&format!(
            "- {} ×{}: {} ({:.0}% of the chat)\n",
            h.who,
            h.agents,
            usd(h.cost_usd),
            h.share * 100.0
        ));
    }

    o.push_str(&format!(
        "\n### Instructions and memories read ({})\n",
        d.reads.len()
    ));
    if d.reads.is_empty() {
        o.push_str("None read by a tool call (the system prompt's own are not listed).\n");
    }
    for r in d.reads.iter().take(LIST_MAX) {
        o.push_str(&format!("- L{} `{}`\n", r.line, r.path));
    }
    more(&mut o, d.reads.len());

    let stops = d.corrections.iter().filter(|c| c.interrupt).count();
    o.push_str(&format!(
        "\n### His corrections ({} that read like one, {} stops — a heuristic; verbatim)\n",
        d.corrections.len() - stops,
        stops
    ));
    if d.corrections.is_empty() {
        o.push_str("None found.\n");
    }
    for c in d.corrections.iter().take(LIST_MAX) {
        let quoted = c
            .text
            .lines()
            .map(|l| format!("> {l}"))
            .collect::<Vec<_>>()
            .join("\n");
        o.push_str(&format!(
            "- L{} {}{}\n{}{}\n",
            c.line,
            c.at,
            if c.interrupt {
                " (stopped the turn)"
            } else {
                ""
            },
            quoted,
            if c.cut { "\n> [cut]" } else { "" }
        ));
    }
    more(&mut o, d.corrections.len());
    o
}

/// What the review pass is asked, the digest under it. The transcript is
/// the model's own context (the aside forks the chat), so only the digest
/// travels; the line numbers it cites are the transcript file's.
pub fn review_prompt(digest_md: &str) -> String {
    format!(
        "Review this chat as a retrospective for the hand-off. Do not run any tool and change nothing: \
         answer from this conversation and the digest below, which a script built from this chat's \
         Claude Code transcript with no model (\"L123\" is that file's line 123).\n\n\
         Write three sections, in Markdown, plain sentences:\n\
         1. `## Issue timeline` — what went wrong, in order: each issue in one or two sentences with \
         its time, its transcript line (Lnnn), and what it cost (a retry, a cache miss's write, his time).\n\
         2. `## Read, then contradicted` — each instruction or memory this chat read (the digest's list, \
         or your own system prompt) that he then corrected you on: the rule's words, his words verbatim, \
         and both lines. Say \"None\" if there is none.\n\
         3. `## Proposed rule changes` — at most {MAX_DIFFS}, and only for an issue that came up more \
         than once or cost real time or money, where a correction shows a rule is missing or wrong. \
         \"None\" is the expected answer for most chats; never propose a change to have one. Each as one line `- [ ] <file>: <one-sentence change> (from Lnnn)` followed by \
         a fenced `diff` block against that file's current text (practices.md, a memory file, or the \
         project's CLAUDE.md). Nothing is applied until he ticks it. Say \"None\" if nothing earns one.\n\n\
         Lead with nothing else; no preamble, no closing.\n\n---\n\n{digest_md}"
    )
}

/// The saved page: a header, the review, the digest it was written from.
pub fn page(
    chat_title: &str,
    chat: &str,
    when: &str,
    review: &str,
    review_cost: Option<f64>,
    digest_md: &str,
) -> String {
    format!(
        "# Retrospective — {title}\n\n\
         Chat `{chat}`, written {when}. Review pass: one aside on the chat's warm cache{cost}. \
         Nothing below has been applied: a proposed change is applied only after you tick it.\n\n\
         {review}\n\n\
         ## Digest (no model)\n\n{digest}",
        title = if chat_title.trim().is_empty() {
            "this chat"
        } else {
            chat_title.trim()
        },
        cost = review_cost
            .map(|c| format!(", {} (the CLI's estimate)", usd(c)))
            .unwrap_or_default(),
        review = review.trim(),
        digest = digest_md
    )
}

/// The folder retrospectives go in: the chat's thread's
/// `retrospectives/`, or the project's when the chat has no thread.
pub fn page_dir(notes_dir: &Path, thread: Option<&str>) -> Result<PathBuf, String> {
    match thread.map(str::trim).filter(|s| !s.is_empty()) {
        Some(slug) => {
            let dir = crate::thread::thread_dir(notes_dir, slug)
                .ok_or_else(|| format!("{slug:?} is not a thread name"))?;
            if !dir.join(crate::thread::THREAD_FILE).is_file() {
                return Err(format!("no thread {slug} here"));
            }
            Ok(dir.join("retrospectives"))
        }
        None => Ok(notes_dir.join("retrospectives")),
    }
}

fn safe_chat(chat: &str) -> String {
    chat.chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .take(12)
        .collect()
}

/// Keep the page as `<dir>/<date>-<chat>.md`; a second review of the same
/// chat that day gets `-2`, `-3` — an earlier page is never overwritten.
pub fn save_page(
    notes_dir: &Path,
    thread: Option<&str>,
    chat: &str,
    date: &str,
    body: &str,
) -> Result<PathBuf, String> {
    let dir = page_dir(notes_dir, thread)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("making {}: {e}", dir.display()))?;
    let stem = format!("{date}-{}", safe_chat(chat));
    let mut path = dir.join(format!("{stem}.md"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem}-{n}.md"));
        n += 1;
    }
    crate::tidy::write_whole(&path, body)?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(v: Value) -> String {
        v.to_string()
    }

    fn fixture() -> String {
        [
            line(serde_json::json!({"type":"user","timestamp":"2026-11-17T10:00:00Z",
                "message":{"role":"user","content":"Build the thing."}})),
            line(serde_json::json!({"type":"assistant","timestamp":"2026-11-17T10:00:05Z",
                "message":{"id":"m1","model":"claude-opus-5-5","content":[
                    {"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/u/.claude/practices/practices.md"}}],
                "usage":{"input_tokens":10,"cache_read_input_tokens":30000,"cache_creation_input_tokens":1000}}})),
            line(serde_json::json!({"type":"user","timestamp":"2026-11-17T10:00:06Z",
                "message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"x".repeat(400)}]}})),
            line(serde_json::json!({"type":"assistant","timestamp":"2026-11-17T10:00:10Z",
                "message":{"id":"m2","model":"claude-opus-5-5","content":[
                    {"type":"tool_use","id":"t2","name":"Bash","input":{"command":"ls"}},
                    {"type":"tool_use","id":"t3","name":"Bash","input":{"command":"ls"}}],
                "usage":{"input_tokens":10,"cache_read_input_tokens":31000,"cache_creation_input_tokens":500}}})),
            line(serde_json::json!({"type":"user","timestamp":"2026-11-17T10:00:11Z",
                "message":{"role":"user","content":[
                    {"type":"tool_result","tool_use_id":"t2","is_error":true,"content":"exit 1: no such file"},
                    {"type":"tool_result","tool_use_id":"t3","is_error":true,"content":"The user doesn't want to proceed with this tool use."}]}})),
            // m2 again (a split message): counted once.
            line(serde_json::json!({"type":"assistant","timestamp":"2026-11-17T10:00:12Z",
                "message":{"id":"m2","model":"claude-opus-5-5","content":[{"type":"text","text":"ok"}],
                "usage":{"input_tokens":10,"cache_read_input_tokens":31000,"cache_creation_input_tokens":500}}})),
            line(serde_json::json!({"type":"user","timestamp":"2026-11-17T10:05:00Z",
                "message":{"role":"user","content":"No — I said never run ls there."}})),
            line(serde_json::json!({"type":"user","timestamp":"2026-11-17T10:05:01Z","isMeta":true,
                "message":{"role":"user","content":"No meta line counts."}})),
            line(serde_json::json!({"type":"user","timestamp":"2026-11-17T10:05:02Z",
                "message":{"role":"user","content":"<command-name>/usage</command-name>"}})),
            // A miss: 32k before, 1k read, 31k written, 10 minutes later.
            line(serde_json::json!({"type":"assistant","timestamp":"2026-11-17T10:15:12Z",
                "message":{"id":"m3","model":"claude-opus-5-5","content":[],
                "usage":{"input_tokens":10,"cache_read_input_tokens":1000,"cache_creation_input_tokens":31000,
                    "cache_creation":{"ephemeral_1h_input_tokens":31000}}}})),
            line(serde_json::json!({"type":"user","timestamp":"2026-11-17T10:16:00Z",
                "message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}})),
            // An expired miss: two hours later.
            line(serde_json::json!({"type":"assistant","timestamp":"2026-11-17T12:30:00Z",
                "message":{"id":"m4","model":"claude-opus-5-5","content":[],
                "usage":{"input_tokens":10,"cache_read_input_tokens":0,"cache_creation_input_tokens":32000}}})),
            "not json".to_string(),
        ]
        .join("\n")
    }

    fn rates() -> Rates {
        crate::usage::parse_rates(
            r#"{"models":{"claude-opus-5-5":{"input":4,"output":20,"cache_read_mult":0.05}}}"#,
        )
        .unwrap()
    }

    #[test]
    fn the_digest_finds_each_kind_with_its_line() {
        let d = digest_text(&fixture(), Some(&rates()));
        assert_eq!(d.lines, 13);
        assert_eq!(d.requests, 4, "a split message counts once");
        assert_eq!(d.issues.len(), 2);
        assert_eq!((d.issues[0].line, d.issues[0].kind.as_str()), (5, "error"));
        assert_eq!(d.issues[1].kind, "denied");
        assert_eq!(d.repeats.len(), 1);
        assert_eq!(d.repeats[0].tool, "Bash");
        assert_eq!(d.repeats[0].count, 2);
        assert_eq!(d.reads.len(), 1);
        assert_eq!(d.reads[0].line, 2);
        assert_eq!(d.his_messages, 2, "meta and command lines are not his");
        assert_eq!(d.corrections.len(), 2);
        assert_eq!(d.corrections[0].line, 7);
        assert_eq!(d.corrections[0].text, "No — I said never run ls there.");
        assert!(d.corrections[1].interrupt);
        assert_eq!(d.misses.len(), 2);
        let m = &d.misses[0];
        assert_eq!(
            (m.line, m.read, m.write, m.expired),
            (10, 1000, 31000, false)
        );
        // 31k at the 1-hour write: 31,000 × $4 × 2 / 1M = $0.248.
        assert!((m.cost_usd.unwrap() - 0.248).abs() < 1e-9);
        assert!(d.misses[1].expired);
        assert!(
            (d.miss_cost_usd - 0.248).abs() < 1e-9,
            "the expired miss is left out"
        );
        let read = d.by_tool.iter().find(|t| t.tool == "Read").unwrap();
        assert_eq!((read.calls, read.result_tokens), (1, 100));
    }

    #[test]
    fn an_unpriced_model_says_so() {
        let d = digest_text(&fixture(), None);
        assert!(d.misses[0].cost_usd.is_none());
        assert!(render(&d).contains("(unpriced)"));
    }

    #[test]
    fn the_render_cites_lines_and_quotes_him_verbatim() {
        let md = render(&digest_text(&fixture(), Some(&rates())));
        assert!(md.contains("- L5 Bash error: exit 1: no such file"));
        assert!(md.contains("> No — I said never run ls there."));
        assert!(md.contains("Bash ×2 (L4, L4)"));
        assert!(md.contains("L2 `/u/.claude/practices/practices.md`"));
        assert!(md.contains("1 past the cache's hour, 1 not; the latter cost $0.25"));
    }

    #[test]
    fn corrections_are_a_heuristic_on_his_words() {
        for yes in [
            "no, the other one",
            "Stop.",
            "why did you delete it",
            "that's not what I asked",
            "It is still broken",
            "I told you twice",
        ] {
            assert!(reads_as_correction(yes), "{yes}");
        }
        for no in [
            "nothing else, thanks",
            "notes look good",
            "great, ship it",
            "Now build 796",
        ] {
            assert!(!reads_as_correction(no), "{no}");
        }
    }

    #[test]
    fn a_long_message_is_cut_and_says_so() {
        let long = format!("No. {}", "a".repeat(QUOTE_MAX * 2));
        let text =
            line(serde_json::json!({"type":"user","message":{"role":"user","content":long}}));
        let d = digest_text(&text, None);
        assert!(d.corrections[0].cut);
        assert_eq!(d.corrections[0].text.chars().count(), QUOTE_MAX);
        assert!(render(&d).contains("> [cut]"));
    }

    #[test]
    fn the_prompt_caps_the_diffs_and_carries_the_digest() {
        let p = review_prompt("DIGEST-BODY");
        assert!(p.contains("at most 3"));
        assert!(p.contains("- [ ]"));
        assert!(p.ends_with("DIGEST-BODY"));
    }

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "nl-retro-{name}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn pages_go_in_the_thread_or_the_project_and_never_overwrite() {
        let notes = scratch("save");
        let p1 = save_page(&notes, None, "abc-123", "2026-11-18", "one").unwrap();
        let p2 = save_page(&notes, None, "abc-123", "2026-11-18", "two").unwrap();
        assert_eq!(p1, notes.join("retrospectives/2026-11-18-abc-123.md"));
        assert_eq!(p2, notes.join("retrospectives/2026-11-18-abc-123-2.md"));
        assert_eq!(std::fs::read_to_string(&p1).unwrap(), "one");
        assert!(save_page(&notes, Some("no-such"), "c", "d", "x").is_err());
        let t = crate::thread::thread_dir(&notes, "t1").unwrap();
        std::fs::create_dir_all(&t).unwrap();
        std::fs::write(t.join(crate::thread::THREAD_FILE), "# t1\n").unwrap();
        let p3 = save_page(&notes, Some("t1"), "../x", "2026-11-18", "three").unwrap();
        assert_eq!(p3, t.join("retrospectives/2026-11-18-x.md"));
        let _ = std::fs::remove_dir_all(&notes);
    }

    #[test]
    fn the_page_says_nothing_is_applied() {
        let p = page(
            "Chat",
            "c1",
            "6:40 AM",
            "## Issue timeline\nx",
            Some(0.31),
            "D",
        );
        assert!(p.starts_with("# Retrospective — Chat"));
        assert!(p.contains("$0.31"));
        assert!(p.contains("Nothing below has been applied"));
        assert!(p.ends_with("## Digest (no model)\n\nD"));
    }
}
