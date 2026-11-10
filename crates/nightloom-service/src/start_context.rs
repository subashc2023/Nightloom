//! What a new chat already holds before its first message (nightshift
//! item 574, 2026-11-10): the new-chat dial's parts.
//!
//! A Claude Code chat's first request carries four things nobody typed:
//!
//! 1. **Claude Code's own part** — its system prompt, the tool
//!    definitions, the skill and agent listings, the environment block.
//!    Not visible before a send, so it is **measured** from the newest chat
//!    in the same folder: the CLI writes the first request's real size into
//!    its session file (the first `assistant` line's `usage`), and Nightloom's
//!    append, the instructions attachment and the first message are taken
//!    back out of it ([`Baseline::measure`]).
//! 2. **Nightloom's layers** — the open chat's built prompt, segment by
//!    segment, as `--append-system-prompt` sends it (switched-off layers are
//!    already gone from it, and edits are already in it).
//! 3. **Instructions the CLI loads itself** — `~/.claude/CLAUDE.md` (not
//!    under safe mode or incognito, whose empty `--setting-sources` drops
//!    it), and the folder's `CLAUDE.md` / `AGENTS.md` up the tree, with their
//!    `@` imports ([`instruction_files`]). Measured on 2.1.318–2.1.322
//!    (574 report §1): they ride as an `instructions` attachment on the
//!    first message.
//! 4. **Claude Code's auto memory** — `MEMORY.md` for the folder, unless the
//!    chat switched it off.
//!
//! Every size but the measured one is [`nightloom_core::estimate_tokens`]
//! (chars ÷ 4), and the measured one is computed with the same estimate on
//! the parts it subtracts, so the two errors cancel when nothing changed
//! between that chat and this one. Only these file names are ever opened —
//! never a credential file (an `@` import naming one is skipped).

use nightloom_core::{SegmentKind, SystemPrompt, estimate_tokens};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

/// One part of the starting context.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StartPart {
    /// Shown on hover: "Claude Code's prompt and tools", "Memory", …
    pub name: String,
    /// `claude_code`, `layer`, `instructions` or `memory` — the dial's shade.
    pub kind: &'static str,
    /// The Nightloom layer, for a `layer` part.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layer: Option<SegmentKind>,
    pub tokens: u64,
    /// An estimate (chars ÷ 4, or measured from another chat).
    pub approx: bool,
}

/// The dial's answer: the parts in drawing order and their sum.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StartContext {
    pub parts: Vec<StartPart>,
    pub total: u64,
    /// The CLI session file Claude Code's part was measured from, when
    /// there was one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub measured_from: Option<String>,
}

/// What one chat's first request said about Claude Code's own part.
#[derive(Debug, Clone, PartialEq)]
pub struct Baseline {
    /// The first request's whole context, as the API counted it.
    pub first_turn: u64,
    /// Claude Code's own part of it (≈).
    pub claude_code: u64,
}

impl Baseline {
    /// Read a CLI session file's first request. `None` when the file has no
    /// reply yet, was not started by Nightloom (`entrypoint` other than
    /// `sdk-cli`: the last system section would not be our append), or does
    /// not parse. Stops at the first `assistant` line — a long chat's file
    /// is not read past its first turn.
    pub fn measure(path: &Path) -> Option<Baseline> {
        let file = std::fs::File::open(path).ok()?;
        Self::measure_lines(BufReader::new(file).lines().map_while(Result::ok))
    }

    pub fn measure_lines(lines: impl Iterator<Item = String>) -> Option<Baseline> {
        let mut append = 0usize;
        let mut instructions = 0usize;
        let mut first_message: Option<usize> = None;
        let mut nightloom = false;
        for line in lines {
            // Cheap guards before a parse: most lines are none of these.
            if !(line.contains("\"assistant\"")
                || line.contains("\"user\"")
                || line.contains("prompt_snapshot")
                || line.contains("\"instructions\""))
            {
                continue;
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if v["entrypoint"] == "sdk-cli" {
                nightloom = true;
            }
            match v["type"].as_str() {
                Some("attachment") => match v["attachment"]["type"].as_str() {
                    Some("prompt_snapshot") if append == 0 => {
                        append = v["attachment"]["systemPrompt"]
                            .as_array()
                            .and_then(|a| a.last())
                            .and_then(|s| s.as_str())
                            .map_or(0, |s| s.chars().count());
                    }
                    Some("instructions") if instructions == 0 => {
                        instructions = rendered_chars(&v);
                    }
                    _ => {}
                },
                Some("user") if first_message.is_none() && v["isMeta"] != true => {
                    first_message = Some(message_chars(&v["message"]["content"]));
                }
                Some("assistant") => {
                    let u = &v["message"]["usage"];
                    // A record holding several API calls (item 562): the
                    // first call is the first request.
                    let u = u["iterations"]
                        .as_array()
                        .and_then(|a| a.first())
                        .unwrap_or(u);
                    let n = |k: &str| u[k].as_u64().unwrap_or(0);
                    let first_turn = n("input_tokens")
                        + n("cache_creation_input_tokens")
                        + n("cache_read_input_tokens");
                    if first_turn == 0 || !nightloom || append == 0 {
                        return None;
                    }
                    let est = |c: usize| c.div_ceil(4) as u64;
                    let ours = est(append) + est(instructions) + est(first_message.unwrap_or(0));
                    return Some(Baseline {
                        first_turn,
                        claude_code: first_turn.saturating_sub(ours),
                    });
                }
                _ => {}
            }
        }
        None
    }
}

fn rendered_chars(v: &serde_json::Value) -> usize {
    match v["rendered"].as_array() {
        Some(r) => r
            .iter()
            .filter_map(|x| x["content"].as_str())
            .map(|s| s.chars().count())
            .sum(),
        None => 0,
    }
}

fn message_chars(c: &serde_json::Value) -> usize {
    match c {
        serde_json::Value::String(s) => s.chars().count(),
        serde_json::Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| b["text"].as_str())
            .map(|s| s.chars().count())
            .sum(),
        _ => 0,
    }
}

/// How many of a folder's newest session files are tried for a baseline.
const NEWEST_TRIED: usize = 8;

/// The newest measurable chat among `dirs` (each a CLI project folder),
/// first folder first: a later folder is only looked in when no file of an
/// earlier one measured. Results are cached by path, length and mtime.
pub fn newest_baseline(dirs: &[PathBuf]) -> Option<(PathBuf, Baseline)> {
    for dir in dirs {
        let Ok(rd) = std::fs::read_dir(dir) else {
            continue;
        };
        let mut files: Vec<(SystemTime, u64, PathBuf)> = rd
            .flatten()
            .filter_map(|e| {
                let p = e.path();
                if p.extension().is_none_or(|x| x != "jsonl") {
                    return None;
                }
                let m = e.metadata().ok()?;
                if !m.is_file() {
                    return None;
                }
                Some((m.modified().ok()?, m.len(), p))
            })
            .collect();
        files.sort_by(|a, b| b.0.cmp(&a.0));
        for (mtime, len, path) in files.into_iter().take(NEWEST_TRIED) {
            if let Some(b) = cached(&path, mtime, len) {
                return Some((path, b));
            }
        }
    }
    None
}

type Cache = HashMap<PathBuf, (SystemTime, u64, Option<Baseline>)>;
static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

fn cached(path: &Path, mtime: SystemTime, len: u64) -> Option<Baseline> {
    if let Ok(g) = CACHE.lock()
        && let Some((m, l, b)) = g.as_ref().and_then(|c| c.get(path))
        && *m == mtime
        && *l == len
    {
        return b.clone();
    }
    let b = Baseline::measure(path);
    if let Ok(mut g) = CACHE.lock() {
        g.get_or_insert_with(HashMap::new)
            .insert(path.to_path_buf(), (mtime, len, b.clone()));
    }
    b
}

/// One instruction file the CLI would load, read.
#[derive(Debug, Clone, PartialEq)]
pub struct InstructionFile {
    pub path: PathBuf,
    /// `true` for the user's own (`~/.claude/CLAUDE.md` and its imports).
    pub user: bool,
    pub text: String,
}

/// How deep `@` imports are followed (the CLI's documented limit is 5).
const IMPORT_DEPTH: usize = 5;

/// The instruction files the CLI loads for `cwd`: the user's
/// `CLAUDE.md` (when `user_level`), then, from the filesystem root down to
/// `cwd`, each folder's `CLAUDE.md`, `.claude/CLAUDE.md` and
/// `CLAUDE.local.md` — or its `AGENTS.md` when it has no `CLAUDE.md`
/// (`inferred` from 2.1.32x loading `AGENTS.md` in folders with no
/// `CLAUDE.md`, 574 report §1) — each followed by its `@` imports.
pub fn instruction_files(
    cwd: &Path,
    claude_dir: Option<&Path>,
    user_level: bool,
) -> Vec<InstructionFile> {
    let mut out: Vec<InstructionFile> = Vec::new();
    let mut seen: Vec<PathBuf> = Vec::new();
    if user_level && let Some(dir) = claude_dir {
        read_with_imports(&dir.join("CLAUDE.md"), true, 0, &mut out, &mut seen);
    }
    let mut chain: Vec<&Path> = cwd.ancestors().collect();
    chain.reverse();
    for dir in chain {
        let claude = dir.join("CLAUDE.md");
        let had = claude.is_file();
        read_with_imports(&claude, false, 0, &mut out, &mut seen);
        read_with_imports(
            &dir.join(".claude").join("CLAUDE.md"),
            false,
            0,
            &mut out,
            &mut seen,
        );
        read_with_imports(&dir.join("CLAUDE.local.md"), false, 0, &mut out, &mut seen);
        if !had {
            read_with_imports(&dir.join("AGENTS.md"), false, 0, &mut out, &mut seen);
        }
    }
    out
}

/// A name never opened, whatever an import says.
fn looks_secret(p: &Path) -> bool {
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    name.starts_with(".env")
        || [
            "credential",
            "secret",
            "token",
            "password",
            "keychain",
            ".pem",
            ".key",
            "id_rsa",
            "id_ed25519",
        ]
        .iter()
        .any(|w| name.contains(w))
}

fn read_with_imports(
    path: &Path,
    user: bool,
    depth: usize,
    out: &mut Vec<InstructionFile>,
    seen: &mut Vec<PathBuf>,
) {
    if depth > IMPORT_DEPTH || looks_secret(path) {
        return;
    }
    let key = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    if seen.contains(&key) {
        return;
    }
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    seen.push(key);
    let imports = imports_in(&text, path.parent().unwrap_or(Path::new("/")));
    out.push(InstructionFile {
        path: path.to_path_buf(),
        user,
        text,
    });
    for p in imports {
        read_with_imports(&p, user, depth + 1, out, seen);
    }
}

/// `@path` references in a memory file, outside fenced code: `@~/x` from
/// home, `@/x` absolute, `@x` beside the file. A token must look like a
/// path (a `/` or a `.` in it) so an `@name` in prose is not one.
pub fn imports_in(text: &str, base: &Path) -> Vec<PathBuf> {
    let home = std::env::var("HOME").ok().filter(|h| !h.is_empty());
    let mut fenced = false;
    let mut out = Vec::new();
    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        for (i, _) in line.match_indices('@') {
            if i > 0 && !line[..i].ends_with(char::is_whitespace) {
                continue;
            }
            let tok: String = line[i + 1..]
                .chars()
                .take_while(|c| !c.is_whitespace() && *c != '`' && *c != ')' && *c != ',')
                .collect();
            if tok.is_empty() || !(tok.contains('/') || tok.contains('.')) {
                continue;
            }
            let p = if let Some(rest) = tok.strip_prefix("~/") {
                match &home {
                    Some(h) => Path::new(h).join(rest),
                    None => continue,
                }
            } else if tok.starts_with('/') {
                PathBuf::from(&tok)
            } else {
                base.join(&tok)
            };
            out.push(p);
        }
    }
    out
}

/// The CLI's framing around each file in the attachment ("Contents of
/// <path> (<what it is>):" and blank lines), measured ≈ 60 chars plus the
/// path; and the `<system-reminder>` around them all, ≈ 230.
const FILE_FRAME_CHARS: usize = 60;
const ATTACHMENT_FRAME_CHARS: usize = 230;

/// The auto memory's index as the CLI loads it: the first 200 lines.
const MEMORY_LINES: usize = 200;

/// A layer's name as the Context panel shows it.
pub fn layer_name(kind: SegmentKind) -> &'static str {
    match kind {
        SegmentKind::Identity => "Identity",
        SegmentKind::Environment => "Environment",
        SegmentKind::UserMemory => "Memory",
        SegmentKind::ModelInstructions => "Model instructions",
        SegmentKind::ChatInstructions => "Chat instructions",
        SegmentKind::ProjectInstructions => "Project instructions",
        SegmentKind::ProjectNotes => "Notes index",
        SegmentKind::Thread => "Thread",
        SegmentKind::Knowledge => "Vault index",
        SegmentKind::EngineNote => "Engine note",
        SegmentKind::Pacing => "Pacing",
        SegmentKind::Subagents => "Subagents",
        SegmentKind::SubagentRules => "Subagent rules",
        SegmentKind::CliMemory => "Claude Code memory",
        _ => "Other",
    }
}

/// The inputs [`compose`] sizes. Everything is already read: this is pure.
pub struct StartInputs<'a> {
    pub baseline: Option<&'a Baseline>,
    /// Nightloom's built prompt for the open chat.
    pub layers: Option<&'a SystemPrompt>,
    pub instructions: &'a [InstructionFile],
    /// `MEMORY.md`'s text, when the CLI will load it.
    pub memory: Option<&'a str>,
}

/// The parts in the dial's order — Claude Code's own first (the largest,
/// and the one that is always there), then Nightloom's layers in ladder
/// order, then the instructions and memory the CLI loads — and their sum.
pub fn compose(input: &StartInputs) -> StartContext {
    let mut parts = Vec::new();
    if let Some(b) = input.baseline
        && b.claude_code > 0
    {
        parts.push(StartPart {
            name: "Claude Code's prompt and tools".into(),
            kind: "claude_code",
            layer: None,
            tokens: b.claude_code,
            approx: true,
        });
    }
    if let Some(p) = input.layers {
        // One part per layer kind, summed: a kind may carry two segments.
        let mut by: Vec<(SegmentKind, u64)> = Vec::new();
        for s in p.segments() {
            let t = estimate_tokens(&s.text);
            match by.iter_mut().find(|(k, _)| *k == s.kind) {
                Some((_, n)) => *n += t,
                None => by.push((s.kind, t)),
            }
        }
        for (k, t) in by {
            parts.push(StartPart {
                name: layer_name(k).into(),
                kind: "layer",
                layer: Some(k),
                tokens: t,
                approx: true,
            });
        }
    }
    let framed = |f: &InstructionFile| {
        f.text.chars().count() + FILE_FRAME_CHARS + f.path.to_string_lossy().chars().count()
    };
    let user: usize = input
        .instructions
        .iter()
        .filter(|f| f.user)
        .map(framed)
        .sum();
    let project: usize = input
        .instructions
        .iter()
        .filter(|f| !f.user)
        .map(framed)
        .sum();
    let memory = input.memory.map(|m| {
        let kept: Vec<&str> = m.lines().take(MEMORY_LINES).collect();
        kept.join("\n").chars().count() + FILE_FRAME_CHARS + 80
    });
    let any = user > 0 || project > 0 || memory.is_some();
    let mut frame = if any { ATTACHMENT_FRAME_CHARS } else { 0 };
    let mut push = |name: &str, kind: &'static str, chars: usize, parts: &mut Vec<StartPart>| {
        if chars == 0 {
            return;
        }
        let chars = chars + std::mem::take(&mut frame);
        parts.push(StartPart {
            name: name.into(),
            kind,
            layer: None,
            tokens: chars.div_ceil(4) as u64,
            approx: true,
        });
    };
    push("Your CLAUDE.md", "instructions", user, &mut parts);
    push(
        "Folder's CLAUDE.md / AGENTS.md",
        "instructions",
        project,
        &mut parts,
    );
    push(
        "Claude Code memory",
        "memory",
        memory.unwrap_or(0),
        &mut parts,
    );
    let total = parts.iter().map(|p| p.tokens).sum();
    StartContext {
        parts,
        total,
        measured_from: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nightloom_core::Segment;

    /// A temporary folder, removed on drop.
    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("nightloom-574-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&p).unwrap();
            Scratch(p)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn line(v: serde_json::Value) -> String {
        v.to_string()
    }

    fn session(
        entry: &str,
        append: &str,
        instr: &str,
        msg: &str,
        usage: (u64, u64, u64),
    ) -> Vec<String> {
        vec![
            line(
                serde_json::json!({"type":"user","entrypoint":entry,"message":{"role":"user","content":[{"type":"text","text":msg}]}}),
            ),
            line(
                serde_json::json!({"type":"attachment","entrypoint":entry,"attachment":{"type":"instructions","files":[]},"rendered":[{"content":instr}]}),
            ),
            line(
                serde_json::json!({"type":"attachment","entrypoint":entry,"attachment":{"type":"prompt_snapshot","systemPrompt":["You are Claude Code", append]}}),
            ),
            line(
                serde_json::json!({"type":"assistant","entrypoint":entry,"message":{"usage":{"input_tokens":usage.0,"cache_creation_input_tokens":usage.1,"cache_read_input_tokens":usage.2}}}),
            ),
            line(
                serde_json::json!({"type":"assistant","entrypoint":entry,"message":{"usage":{"input_tokens":1,"cache_creation_input_tokens":999999,"cache_read_input_tokens":0}}}),
            ),
        ]
    }

    #[test]
    fn a_baseline_takes_our_parts_out_of_the_first_request() {
        // 4000 + 400 + 80 chars → 1000 + 100 + 20 tokens out of 30,000.
        let lines = session(
            "sdk-cli",
            &"a".repeat(4000),
            &"b".repeat(400),
            &"c".repeat(80),
            (2, 20_000, 9_998),
        );
        let b = Baseline::measure_lines(lines.into_iter()).unwrap();
        assert_eq!(b.first_turn, 30_000);
        assert_eq!(b.claude_code, 30_000 - 1_120);
    }

    #[test]
    fn a_chat_not_started_by_nightloom_measures_nothing() {
        let lines = session("cli", "x", "y", "z", (2, 20_000, 0));
        assert_eq!(Baseline::measure_lines(lines.into_iter()), None);
    }

    #[test]
    fn a_chat_with_no_reply_yet_measures_nothing() {
        let mut lines = session("sdk-cli", "x", "y", "z", (2, 20_000, 0));
        lines.truncate(3);
        assert_eq!(Baseline::measure_lines(lines.into_iter()), None);
    }

    #[test]
    fn several_calls_in_one_record_read_the_first() {
        let l = line(
            serde_json::json!({"type":"assistant","entrypoint":"sdk-cli","message":{"usage":{
            "input_tokens":5,"cache_creation_input_tokens":500,"cache_read_input_tokens":90_000,
            "iterations":[{"input_tokens":2,"cache_creation_input_tokens":100,"cache_read_input_tokens":20_000}]}}}),
        );
        let mut lines = session("sdk-cli", "aaaa", "", "", (0, 0, 0));
        lines.truncate(3);
        lines.push(l);
        assert_eq!(
            Baseline::measure_lines(lines.into_iter())
                .unwrap()
                .first_turn,
            20_102
        );
    }

    #[test]
    fn the_parts_come_in_dial_order_and_sum_to_the_total() {
        let mut p = SystemPrompt::new();
        p.push(Segment::new(SegmentKind::UserMemory, "m", "x".repeat(400)));
        p.push(Segment::new(SegmentKind::EngineNote, "e", "y".repeat(800)));
        p.push(Segment::new(SegmentKind::EngineNote, "e2", "z".repeat(40)));
        let files = vec![InstructionFile {
            path: PathBuf::from("/p/AGENTS.md"),
            user: false,
            text: "w".repeat(100),
        }];
        let b = Baseline {
            first_turn: 30_000,
            claude_code: 26_000,
        };
        let c = compose(&StartInputs {
            baseline: Some(&b),
            layers: Some(&p),
            instructions: &files,
            memory: None,
        });
        let names: Vec<&str> = c.parts.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "Claude Code's prompt and tools",
                "Memory",
                "Engine note",
                "Folder's CLAUDE.md / AGENTS.md"
            ]
        );
        assert_eq!(c.parts[2].tokens, 200 + 10);
        // 100 + 60 frame + 12 path + 230 attachment frame = 402 chars.
        assert_eq!(c.parts[3].tokens, 101);
        assert_eq!(c.total, c.parts.iter().map(|p| p.tokens).sum::<u64>());
    }

    #[test]
    fn a_switched_off_layer_is_simply_not_in_the_built_prompt() {
        let mut on = SystemPrompt::new();
        on.push(Segment::new(SegmentKind::UserMemory, "m", "x".repeat(400)));
        on.push(Segment::new(SegmentKind::Knowledge, "k", "y".repeat(4000)));
        let mut off = SystemPrompt::new();
        off.push(Segment::new(SegmentKind::UserMemory, "m", "x".repeat(400)));
        let total = |p: &SystemPrompt| {
            compose(&StartInputs {
                baseline: None,
                layers: Some(p),
                instructions: &[],
                memory: None,
            })
            .total
        };
        assert_eq!(total(&on) - total(&off), 1000);
    }

    #[test]
    fn instruction_files_walk_down_to_the_folder_and_follow_imports() {
        let root = Scratch::new();
        let home = root.path().join("home");
        let proj = root.path().join("work").join("proj");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::write(home.join("CLAUDE.md"), "be terse").unwrap();
        std::fs::write(root.path().join("work").join("AGENTS.md"), "work rules").unwrap();
        std::fs::write(
            proj.join("CLAUDE.md"),
            "see @rules/extra.md and @.env\n```\n@ignored.md\n```",
        )
        .unwrap();
        std::fs::create_dir_all(proj.join("rules")).unwrap();
        std::fs::write(proj.join("rules").join("extra.md"), "extra").unwrap();
        std::fs::write(proj.join(".env"), "SECRET=1").unwrap();
        std::fs::write(proj.join("AGENTS.md"), "not read: there is a CLAUDE.md").unwrap();
        let got = instruction_files(&proj, Some(&home), true);
        let texts: Vec<&str> = got.iter().map(|f| f.text.as_str()).collect();
        assert_eq!(texts[0], "be terse");
        assert!(got[0].user);
        assert!(texts.contains(&"work rules"));
        assert!(texts.contains(&"extra"));
        assert!(!texts.iter().any(|t| t.contains("SECRET")));
        assert!(!texts.iter().any(|t| t.starts_with("not read")));
        let no_user = instruction_files(&proj, Some(&home), false);
        assert!(no_user.iter().all(|f| !f.user));
    }

    #[test]
    fn prose_at_signs_are_not_imports() {
        let got = imports_in(
            "email me @swaraag or see @docs/a.md, and x@y.md",
            Path::new("/b"),
        );
        assert_eq!(got, vec![PathBuf::from("/b/docs/a.md")]);
    }

    #[test]
    fn the_newest_measurable_file_wins_and_a_later_folder_is_a_fallback() {
        let root = Scratch::new();
        let a = root.path().join("a");
        let b = root.path().join("b");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(
            a.join("x.jsonl"),
            session("cli", "x", "", "", (1, 1, 1)).join("\n"),
        )
        .unwrap();
        std::fs::write(
            b.join("y.jsonl"),
            session("sdk-cli", "aaaa", "", "", (0, 10_000, 0)).join("\n"),
        )
        .unwrap();
        let (path, base) = newest_baseline(&[a, b.clone()]).unwrap();
        assert_eq!(path, b.join("y.jsonl"));
        assert_eq!(base.claude_code, 9_999);
    }
}
