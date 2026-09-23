//! Checkpoint forks (nightshift backlog 104, pass 3, 2026-09-22).
//!
//! The 104 interview's design, in his words (`backlog/interviews/104.md`):
//! a chat's helpers are picked **by task**. A short side task is a *fork
//! subagent* — the CLI's own `subagent_type: "fork"`, on once fork mode is
//! on, which starts with the whole conversation at cache-read cost. Long
//! research forks from the chat's **checkpoint**: the message that ends
//! the chat's general context (the preamble plus his opening exchange, set
//! automatically; moved by "fork from here" on any message), so the helper
//! starts with that context — read from the cache while it stays warm —
//! and none of the later turns. The CLI does that as a session fork from a
//! chosen message: `--resume <id> --resume-session-at <uuid>
//! --fork-session` (measured on 2.1.263 in the survey, M3: read 35,034 /
//! wrote 231, the later turn absent).
//!
//! **Who runs it.** The model asks for it through the `Agent` tool with
//! `subagent_type: "checkpoint"` — a named agent Nightloom declares with
//! `--agents` ([`agents_json`]) so the roster offers it and says when to
//! use which. The brief hook (`brief::decide`) sees the spawn, and when the
//! chat's directory holds a [`ForkSpec`] (the chat's own command line,
//! written before each turn by `set_ask_dir`) and a resolved
//! [`Checkpoint`], it runs the fork itself — a second CLI process on the
//! chat's session file — waits for its `result` line, and answers the
//! spawn with **`deny` carrying the fork's report as the reason**. That is
//! the Agent call's tool-result slot (blocker 287, his answer: "as the
//! tool result"): an `is_error` result carrying the text, the same shape
//! the Chat policy's and the budget's refusals take, and the model reads
//! it as the report (the hooks reference, `external`, gives a `PreToolUse`
//! hook no way to supply a tool's result and skip the tool — nightshift
//! blocker 296). When either file is missing the hook lets the spawn
//! through as a fresh agent under the roster's own prompt, which says it
//! did not get the context.
//!
//! **What the fork keeps.** Everything that shapes the cached prefix — the
//! model, the tools, the MCP server, the prompt tool, the system prompt,
//! the `--agents` roster — as the chat has it ([`super::AgentSpec::checkpoint_fork`]),
//! so the fork reads the checkpoint's prefix rather than re-writing it.
//! Its own tool calls run the same hook against the same directory, so
//! its spend counts against the message's budget (165's 35 %) and its own
//! spawns against the caps.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// The chat's checkpoint, beside the brief: `checkpoint.json`.
pub const CHECKPOINT_FILE: &str = "checkpoint.json";
/// The chat's fork command line, beside the brief: `fork-spec.json`.
pub const FORK_SPEC_FILE: &str = "fork-spec.json";
/// Where a fork's stream is kept, under the chat's directory.
pub const FORKS_DIR: &str = "forks";
/// The `subagent_type` that means a checkpoint fork.
pub const CHECKPOINT_AGENT: &str = "checkpoint";
/// How long the hook waits on a fork before stopping it: 45 minutes,
/// under the hook's own registration timeout (`brief::HOOK_TIMEOUT_S`).
pub const FORK_WALL_MS: u64 = 45 * 60 * 1000;

/// Who set the checkpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckpointSetBy {
    /// Set at the end of the chat's first exchange (blocker 289).
    Auto,
    /// Moved by "fork from here" on a message.
    User,
}

/// The message helpers fork from. `index` is the position in the chat's
/// log (an event index, as `rewind`/`fork_session` count them); the fork
/// starts after the **exchange** that message is part of — his message
/// and the reply that answered it — so `uuid` is the last node of that
/// turn's reply in the CLI's session file, resolved when the file exists
/// and the CLI session is the one in `resolved_in`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Checkpoint {
    pub index: usize,
    #[serde(default)]
    pub uuid: Option<String>,
    /// The CLI session id the uuid was read from; a chat whose CLI
    /// session changed (an edit fork, a rewind) resolves again.
    #[serde(default)]
    pub resolved_in: Option<String>,
    pub set_by: CheckpointSetBy,
    pub at_ms: i64,
}

pub fn read_checkpoint(dir: &Path) -> Option<Checkpoint> {
    let text = std::fs::read_to_string(dir.join(CHECKPOINT_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn write_checkpoint(dir: &Path, cp: &Checkpoint) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(CHECKPOINT_FILE);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(cp).unwrap_or_default())?;
    std::fs::rename(&tmp, path)
}

/// The chat's command line for a fork, as the hook (another process, with
/// nothing but the directory) needs it: the binary, the cwd, the argv with
/// `-p ""` in front — the hook puts the task in the empty slot and appends
/// `--resume-session-at <uuid>` — and the environment the turn runs with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForkSpec {
    pub binary: String,
    pub workspace: PathBuf,
    pub argv: Vec<String>,
    pub env: Vec<(String, String)>,
    pub env_remove: Vec<String>,
}

pub fn read_fork_spec(dir: &Path) -> Option<ForkSpec> {
    let text = std::fs::read_to_string(dir.join(FORK_SPEC_FILE)).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn write_fork_spec(dir: &Path, spec: &ForkSpec) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(FORK_SPEC_FILE);
    let next = serde_json::to_string_pretty(spec).unwrap_or_default();
    if std::fs::read_to_string(&path).is_ok_and(|have| have == next) {
        return Ok(());
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, next)?;
    std::fs::rename(&tmp, path)
}

/// The roster entry for `--agents`: the name the model asks for, a
/// description that carries the by-task rule (this is what the model reads
/// when it picks a `subagent_type`), and the prompt a *fresh* spawn gets
/// when the hook could not fork — it says so, rather than let the helper
/// answer as if it knew the chat.
pub fn agents_json() -> String {
    serde_json::json!({
        CHECKPOINT_AGENT: {
            "description": "Long research or a many-step side task, as a fork of this chat from its \
                checkpoint: the helper starts with the chat's general context (instructions and the \
                opening exchange) at cache-read cost and none of the later turns, and its report comes \
                back as this call's result. Pick this for a helper that will read many files or run many \
                steps. For a short side task that needs the whole conversation so far, use subagent_type \
                fork instead; for a task that needs no context of this chat, general-purpose.",
            "prompt": "You are a research helper spawned from a chat running in Nightloom. Nightloom meant \
                to fork you from the chat's checkpoint so you would start with its general context; that \
                fork did not happen, so you have only the task below and any brief in front of it. Read by \
                pointer — open only the files the task names — and if the task assumes context you do \
                not have, say so in your report rather than guess."
        }
    })
    .to_string()
}

/// Whether a spawn's input asks for a checkpoint fork.
pub fn is_checkpoint_spawn(fields: &serde_json::Map<String, Value>) -> bool {
    fields.get("subagent_type").and_then(Value::as_str) == Some(CHECKPOINT_AGENT)
}

/// How a fork ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ForkEnd {
    /// A `result` line arrived.
    Result,
    /// The wall clock ran out; the process was killed.
    Timeout,
    /// The process exited without a `result` line.
    NoResult,
}

/// What the hook learned from a fork's stream.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ForkOutcome {
    pub text: String,
    pub session_id: Option<String>,
    pub cache_read: u64,
    pub cache_write: u64,
    pub cost_usd: Option<f64>,
    pub num_turns: u64,
    pub duration_ms: u64,
    pub is_error: bool,
    pub end: ForkEnd,
    pub stream_path: PathBuf,
}

/// Run the fork to completion and read its result. `Err` only when the
/// process could not start — the hook then lets the spawn through as a
/// fresh helper. The stream is written whole to `<dir>/forks/`.
pub fn run_fork(
    dir: &Path,
    spec: &ForkSpec,
    uuid: &str,
    prompt: &str,
    wall_ms: u64,
) -> std::io::Result<ForkOutcome> {
    let mut argv = spec.argv.clone();
    match argv.iter().position(|a| a == "-p") {
        Some(i) if i + 1 < argv.len() && argv[i + 1].is_empty() => {
            argv[i + 1] = prompt.to_string();
        }
        _ => {
            argv.insert(0, prompt.to_string());
            argv.insert(0, "-p".into());
        }
    }
    argv.push("--resume-session-at".into());
    argv.push(uuid.to_string());

    let forks = dir.join(FORKS_DIR);
    std::fs::create_dir_all(&forks)?;
    let stamp = chrono::Local::now().format("%Y%m%dT%H%M%S%.3f").to_string();
    let stream_path = forks.join(format!("{stamp}.jsonl"));
    let mut stream = std::fs::File::create(&stream_path)?;
    let stderr_path = forks.join(format!("{stamp}.stderr.txt"));

    let mut cmd = Command::new(super::resolve_binary(&spec.binary));
    cmd.args(&argv)
        .current_dir(&spec.workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(std::fs::File::create(&stderr_path)?);
    for k in &spec.env_remove {
        cmd.env_remove(k);
    }
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }
    let started = Instant::now();
    let mut child = cmd.spawn()?;
    let stdout = child.stdout.take();
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        if let Some(out) = stdout {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        }
    });

    let deadline = started + Duration::from_millis(wall_ms);
    let mut result: Option<Value> = None;
    let mut end = ForkEnd::NoResult;
    loop {
        let now = Instant::now();
        if now >= deadline {
            let _ = child.kill();
            end = ForkEnd::Timeout;
            break;
        }
        match rx.recv_timeout(deadline - now) {
            Ok(line) => {
                let _ = writeln!(stream, "{line}");
                if let Ok(v) = serde_json::from_str::<Value>(&line)
                    && v.get("type").and_then(Value::as_str) == Some("result")
                {
                    result = Some(v);
                    end = ForkEnd::Result;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let _ = child.kill();
                end = ForkEnd::Timeout;
                break;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    let _ = child.wait();
    let _ = stream.flush();

    let usage = result.as_ref().and_then(|r| r.get("usage"));
    let num = |k: &str| {
        usage
            .and_then(|u| u.get(k))
            .and_then(Value::as_u64)
            .unwrap_or(0)
    };
    Ok(ForkOutcome {
        text: result
            .as_ref()
            .and_then(|r| r.get("result"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        session_id: result
            .as_ref()
            .and_then(|r| r.get("session_id"))
            .and_then(Value::as_str)
            .map(str::to_string),
        cache_read: num("cache_read_input_tokens"),
        cache_write: num("cache_creation_input_tokens"),
        cost_usd: result
            .as_ref()
            .and_then(|r| r.get("total_cost_usd"))
            .and_then(Value::as_f64),
        num_turns: result
            .as_ref()
            .and_then(|r| r.get("num_turns"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        duration_ms: started.elapsed().as_millis() as u64,
        is_error: result
            .as_ref()
            .and_then(|r| r.get("is_error"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        end,
        stream_path,
    })
}

/// The first line of the report: what the model reads in the tool result.
pub const REPORT_LEAD: &str = "Checkpoint fork done (Nightloom): this Agent call ran as a fork of this \
    chat from its checkpoint — the general context at cache-read cost, none of the later turns — \
    and what follows is the helper's report. The call is complete; do not spawn it again.";

/// The tool result's text for the model: a lead that says what happened,
/// one line of figures, then the fork's own words.
pub fn report(out: &ForkOutcome) -> String {
    let secs = out.duration_ms / 1000;
    match out.end {
        ForkEnd::Result => format!(
            "{REPORT_LEAD}\n[{} round{}, cache read {} / written {} tokens, {secs} s{}]\n\n{}",
            out.num_turns,
            if out.num_turns == 1 { "" } else { "s" },
            out.cache_read,
            out.cache_write,
            if out.is_error {
                ", the fork ended in an error"
            } else {
                ""
            },
            if out.text.trim().is_empty() {
                "(the fork returned no text)"
            } else {
                out.text.trim()
            }
        ),
        ForkEnd::Timeout => format!(
            "Checkpoint fork stopped (Nightloom): the fork of this chat ran {} minutes and was \
             stopped at its wall-clock limit before it reported. Its stream is on disk at {}; \
             do not spawn it again — report what is known and what is not.",
            secs / 60,
            out.stream_path.display()
        ),
        ForkEnd::NoResult => format!(
            "Checkpoint fork ended without a report (Nightloom): the fork of this chat exited \
             after {secs} s with no result line. Its stream is on disk at {}; do not spawn it \
             again — report what is known and what is not.",
            out.stream_path.display()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nightloom-fork-{tag}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_checkpoint_and_the_fork_spec_round_trip() {
        let dir = scratch("rt");
        assert!(read_checkpoint(&dir).is_none());
        let cp = Checkpoint {
            index: 1,
            uuid: Some("063ced21".into()),
            resolved_in: Some("sess-1".into()),
            set_by: CheckpointSetBy::Auto,
            at_ms: 5,
        };
        write_checkpoint(&dir, &cp).unwrap();
        assert_eq!(read_checkpoint(&dir), Some(cp));
        // A file from before `uuid` was resolved reads with `None`.
        std::fs::write(
            dir.join(CHECKPOINT_FILE),
            r#"{"index":3,"set_by":"user","at_ms":9}"#,
        )
        .unwrap();
        let cp = read_checkpoint(&dir).unwrap();
        assert_eq!(
            (cp.index, cp.uuid, cp.set_by),
            (3, None, CheckpointSetBy::User)
        );
        let spec = ForkSpec {
            binary: "claude".into(),
            workspace: PathBuf::from("/w"),
            argv: vec!["-p".into(), String::new(), "--resume".into(), "s".into()],
            env: vec![("CLAUDE_CODE_FORK_SUBAGENT".into(), "1".into())],
            env_remove: vec!["ANTHROPIC_API_KEY".into()],
        };
        write_fork_spec(&dir, &spec).unwrap();
        assert_eq!(read_fork_spec(&dir), Some(spec));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_roster_names_the_checkpoint_agent_and_the_spawn_is_told_apart() {
        let v: Value = serde_json::from_str(&agents_json()).unwrap();
        assert!(
            v[CHECKPOINT_AGENT]["description"]
                .as_str()
                .unwrap()
                .contains("subagent_type fork")
        );
        assert!(
            v[CHECKPOINT_AGENT]["prompt"]
                .as_str()
                .unwrap()
                .contains("did not happen")
        );
        let mut f = serde_json::Map::new();
        f.insert("subagent_type".into(), Value::String("fork".into()));
        assert!(!is_checkpoint_spawn(&f));
        f.insert("subagent_type".into(), Value::String("checkpoint".into()));
        assert!(is_checkpoint_spawn(&f));
    }

    /// A fake CLI — a shell script that echoes its argv and prints a
    /// `result` line — stands in for the binary: the prompt lands in the
    /// `-p` slot, `--resume-session-at` follows with the uuid, the stream
    /// is kept, and the report carries the text and the figures.
    #[test]
    #[cfg(unix)]
    fn a_fork_runs_the_chats_command_line_from_the_checkpoint_and_reports() {
        let dir = scratch("run");
        let fake = dir.join("fake-claude.sh");
        std::fs::write(
            &fake,
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$FORK_ARGS\"\n\
             echo '{\"type\":\"system\",\"subtype\":\"init\"}'\n\
             echo '{\"type\":\"result\",\"result\":\"APPLE only\",\"session_id\":\"fork-9\",\"num_turns\":2,\"is_error\":false,\"total_cost_usd\":0.01,\"usage\":{\"cache_read_input_tokens\":35034,\"cache_creation_input_tokens\":231}}'\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let args_file = dir.join("args.txt");
        let spec = ForkSpec {
            binary: fake.to_string_lossy().into_owned(),
            workspace: dir.clone(),
            argv: vec![
                "-p".into(),
                String::new(),
                "--resume".into(),
                "sess-1".into(),
                "--fork-session".into(),
            ],
            env: vec![("FORK_ARGS".into(), args_file.to_string_lossy().into_owned())],
            env_remove: vec![],
        };
        let out = run_fork(&dir, &spec, "063ced21", "List every code word", 10_000).unwrap();
        let args = std::fs::read_to_string(&args_file).unwrap();
        let args: Vec<&str> = args.lines().collect();
        assert_eq!(
            args,
            [
                "-p",
                "List every code word",
                "--resume",
                "sess-1",
                "--fork-session",
                "--resume-session-at",
                "063ced21"
            ]
        );
        assert_eq!(out.end, ForkEnd::Result);
        assert_eq!(out.text, "APPLE only");
        assert_eq!(
            (out.cache_read, out.cache_write, out.num_turns),
            (35034, 231, 2)
        );
        assert_eq!(out.session_id.as_deref(), Some("fork-9"));
        assert!(out.stream_path.starts_with(dir.join(FORKS_DIR)));
        assert_eq!(
            std::fs::read_to_string(&out.stream_path)
                .unwrap()
                .lines()
                .count(),
            2
        );
        let r = report(&out);
        assert!(r.starts_with(REPORT_LEAD), "{r}");
        assert!(
            r.contains("2 rounds, cache read 35034 / written 231"),
            "{r}"
        );
        assert!(r.ends_with("APPLE only"), "{r}");

        // A fork that never reports is stopped at the wall clock.
        std::fs::write(&fake, "#!/bin/sh\nsleep 30\n").unwrap();
        let out = run_fork(&dir, &spec, "u", "task", 300).unwrap();
        assert_eq!(out.end, ForkEnd::Timeout);
        assert!(out.duration_ms < 5_000, "{}", out.duration_ms);
        assert!(report(&out).contains("stopped at its wall-clock limit"));

        // A binary that cannot start is the caller's to fall back on.
        let mut missing = spec.clone();
        missing.binary = dir.join("no-such-binary").to_string_lossy().into_owned();
        assert!(run_fork(&dir, &missing, "u", "task", 300).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
