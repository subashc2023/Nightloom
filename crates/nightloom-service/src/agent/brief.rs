//! The subagent brief: the preamble reaching every subagent (2026-09-17,
//! nightshift backlog 152, piece 2).
//!
//! A subagent — the CLI's `Agent` tool, a second model run inside the
//! same process — starts with "the agent's own prompt plus environment
//! details … not the Claude Code system prompt" (`external`, the
//! sub-agents doc), so nothing Nightloom sends with `--append-system-prompt`
//! reaches it: not the project's instructions, not the engine note that
//! names the vault alias, the search rule and Nightloom's own tools.
//! Measured on 2.1.263 (nightshift `104-survey-2026-09-17.md`, M2a): a
//! parent told a code word spawned a child asked for it, and the child
//! said `NO CODE WORD`.
//!
//! **The way through is a second `PreToolUse` hook, on the `Agent` tool
//! itself.** A hook may answer `allow` with `updatedInput`, which
//! "replaces the entire input object" (`external`, the hooks doc; the
//! Ask hook already uses it for a question's answers). This one returns
//! the call's input with the brief prepended to `prompt`, so the CLI
//! spawns the child on the brief plus the task the model wrote — with no
//! reliance on the model remembering to brief it. Measured 2026-09-17
//! (nightshift `152-report-2026-09-17.md`, M-B): the `system/task_started`
//! line's `prompt` began with the injected block, the child's first
//! `user` line carried it, and the child answered the code word the
//! parent never knew — `ZEBRAFISH`. The hook's input names the tool
//! **`Agent`** (the init line's `tools` still lists `Task`; the matcher
//! takes both).
//!
//! **The same binary is the hook** (`nightloom-desktop --subagent-hook
//! <dir>`; [`run_hook`]), for the reason the Ask hook is: the CLI spawns
//! whatever path it is given, and this binary is the one always present
//! inside the signed `.app`. The brief is a file in the chat's directory
//! ([`BRIEF_FILE`] beside the Ask position's `rules.json`), written by
//! [`super::ClaudeCodeAgent::set_ask_dir`] before each turn, so the hook
//! — another process, which sees only the directory — reads the chat's
//! current preamble.
//!
//! **What the brief carries, and what it cuts.** [`compose`] keeps two of
//! the preamble's segments — the project's instructions (`AGENTS.md`)
//! and the engine note (the file tools' names, the vault alias and its
//! directory, Nightloom's own tools by their full names, the search rule,
//! `remember`) — plus the extra-folders note when the chat has one. It
//! cuts the project-notes and vault **indexes** (the largest segments;
//! they exist for the parent to choose what to read, and a child's task
//! should name what it needs), the user's and the model's standing
//! instructions (about how the assistant talks to the user — a child
//! reports to its parent), the Chat instructions (a Chat cannot spawn:
//! the policy refuses `Agent`), the library prompt (the parent's persona,
//! not the child's), and the ask-note (a subagent cannot pause for the
//! card; telling it a person answers would be false). Every child's first
//! request writes its own cache anyway (104's table: 26k for a Haiku
//! child), so the brief's few hundred to few thousand tokens ride on a
//! write that was already being paid.

use super::ask::{HookReply, shell_quote};
use nightloom_core::{SegmentKind, SystemPrompt};
use serde::Deserialize;
use serde_json::Value;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// The brief's file name inside the chat's directory.
pub const BRIEF_FILE: &str = "subagent-brief.txt";

/// The hook's matcher: the tool's current name and its older one.
pub const BRIEF_MATCHER: &str = "Agent|Task";

/// The brief's opening tag — also the mark [`decide`] looks for at the
/// top of a task, so a task that already carries a brief (a nested
/// subagent's, spawned by a child whose own task began with one and who
/// copied it) is not given a second.
pub const BRIEF_OPEN: &str = "<nightloom-subagent-brief>";
const BRIEF_CLOSE: &str = "</nightloom-subagent-brief>";

/// How many subagents one turn may spawn (2026-09-17 ~20:40, his report:
/// a research turn spun up fourteen and "it's gonna kill my usage very
/// quickly"). The hook counts spawns in [`SPAWNS_FILE`] and refuses past
/// this with [`spawn_cap_reason`]; [`reset_spawns`] zeroes the count when
/// a turn starts (not when a deferred call resumes — that is the same
/// turn). A per-chat setting for the number is nightshift backlog 164.
pub const SPAWN_CAP: usize = 6;
/// The per-turn spawn count, beside the brief.
pub const SPAWNS_FILE: &str = "subagent-spawns.txt";

/// The refusal the model reads when the cap is reached — his wording.
/// ~~"The limit is set beside \"Subagents run on auto\""~~ — struck
/// 2026-09-18 (the review of `a4a681f`): no such setting exists; the cap
/// is this constant until backlog 165 builds the per-chat number, and a
/// sentence naming a control that is not there is one the parent repeats
/// to him.
pub fn spawn_cap_reason(cap: usize) -> String {
    format!(
        "Nightloom's limit is {cap} subagents in one turn, and this turn has spawned {cap}. \
         Wait for the running ones to finish and use their reports; if what is left is \
         small enough, do it yourself."
    )
}

/// Zero the turn's spawn count. Called when a turn starts.
pub fn reset_spawns(dir: &Path) {
    let _ = std::fs::remove_file(dir.join(SPAWNS_FILE));
}

/// Take one spawn of the turn's allowance, or say how many were taken.
///
/// One hook process runs per `Agent` call, and a turn that fans out puts
/// its calls in one assistant message, which the CLI runs — hooks
/// included — at once. The first shape (2026-09-17, `a4a681f`) read the
/// count and wrote it back with no lock, so fourteen hooks at once each
/// read 0 and wrote 1, and the cap held only for a model that spawned one
/// at a time — the opposite of the report that raised it (the review of
/// 2026-09-18). So: the file is opened, locked exclusively for the
/// read-and-write (`File::lock`, an advisory lock the other hooks wait
/// on), and released with the handle. A directory or file that cannot be
/// opened counts as no spawns taken: the brief still goes in, the cap
/// does not bind — the failure is logged nowhere the model reads, and a
/// refusal for a bookkeeping error would be worse than an uncounted
/// spawn.
fn claim_spawn(dir: &Path, cap: usize) -> Result<(), usize> {
    use std::io::{Read as _, Seek as _, Write as _};
    let _ = std::fs::create_dir_all(dir);
    let Ok(mut file) = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.join(SPAWNS_FILE))
    else {
        return Ok(());
    };
    if file.lock().is_err() {
        return Ok(());
    }
    let mut have = String::new();
    let _ = file.read_to_string(&mut have);
    let n: usize = have.trim().parse().unwrap_or(0);
    if n >= cap {
        return Err(n);
    }
    let _ = file.set_len(0);
    let _ = file.seek(std::io::SeekFrom::Start(0));
    let _ = file.write_all((n + 1).to_string().as_bytes());
    Ok(())
}

/// The sentence at the top of the brief, so the child knows what the
/// block is and what it is not.
const BRIEF_LEAD: &str = "You are a subagent of a chat running in Nightloom. What follows reached the \
     main conversation as its system prompt and reaches you here, in front of your \
     task: the project's instructions, and how the tools and names read on this \
     engine. You see nothing else of the conversation — only your task below.";

/// The segment kinds the brief keeps, in the preamble's own order.
const KEPT: [SegmentKind; 2] = [SegmentKind::ProjectInstructions, SegmentKind::EngineNote];

/// What a connection carries for the brief (mirrors [`super::AskSpec`]).
#[derive(Debug, Clone)]
pub struct BriefSpec {
    /// The hook program and its leading arguments — `[<this binary>,
    /// "--subagent-hook"]`; the directory is appended per turn.
    pub hook: Vec<String>,
    /// The chat's directory, where [`BRIEF_FILE`] is written; empty until
    /// the shell points it at the open chat.
    pub dir: PathBuf,
    /// The brief's text, composed once per connection by [`compose`].
    pub text: String,
}

/// The brief from the chat's preamble: the kept segments and `notes`
/// (the extra-folders note, when there is one), wrapped and led. `None`
/// when nothing of it exists — a chat with the preamble off — so no hook
/// is registered for nothing.
pub fn compose(prompt: &SystemPrompt, notes: &[String]) -> Option<String> {
    let mut parts: Vec<&str> = prompt
        .segments()
        .iter()
        .filter(|s| KEPT.contains(&s.kind))
        .map(|s| s.text.as_str())
        .collect();
    parts.extend(
        notes
            .iter()
            .map(String::as_str)
            .filter(|n| !n.trim().is_empty()),
    );
    if parts.is_empty() {
        return None;
    }
    Some(format!(
        "{BRIEF_OPEN}\n{BRIEF_LEAD}\n\n{}\n{BRIEF_CLOSE}",
        parts.join("\n\n")
    ))
}

/// The `PreToolUse` entry that registers the hook, for the one
/// `--settings` JSON beside the Ask hook's entry: the command quoted word
/// by word as [`super::ask::settings_json`] quotes its own.
pub fn hook_entry(hook: &[String], dir: &Path) -> Value {
    let mut words: Vec<String> = hook.iter().map(|w| shell_quote(w)).collect();
    words.push(shell_quote(&dir.to_string_lossy()));
    serde_json::json!({
        "matcher": BRIEF_MATCHER,
        "hooks": [{ "type": "command", "command": words.join(" ") }]
    })
}

/// Write the brief into `dir`, only when it differs from what is there —
/// the hook may be reading at the same moment, and an unchanged file is
/// not rewritten under it.
pub fn write(dir: &Path, text: &str) -> std::io::Result<()> {
    let path = dir.join(BRIEF_FILE);
    if std::fs::read_to_string(&path).is_ok_and(|have| have == text) {
        return Ok(());
    }
    std::fs::create_dir_all(dir)?;
    let tmp = path.with_extension("txt.tmp");
    std::fs::write(&tmp, text.as_bytes())?;
    std::fs::rename(&tmp, path)
}

/// The fields of the hook's stdin line read here.
#[derive(Debug, Deserialize)]
struct HookInput {
    #[serde(default)]
    tool_input: Value,
}

/// The hook's whole decision, pure: the CLI's stdin line and the chat's
/// directory in, the reply out. `{}` — no opinion, the CLI's own flow —
/// whenever there is nothing to add: no brief on disk, torn input, a
/// call whose `prompt` is not a string, or a task that already begins
/// with the brief's tag. Otherwise `allow` with the whole input back and
/// `prompt` prefixed. `allow` rather than a decision-less update because
/// `updatedInput` rides on a permission decision (`external`, the hooks
/// doc), and `Agent` is a call every mode runs unasked — the Chat
/// policy's own `deny` on it still stands, since the CLI runs every
/// matching entry and any deny wins (measured, backlog 147).
pub fn decide(dir: &Path, stdin_json: &str) -> HookReply {
    let Ok(input) = serde_json::from_str::<HookInput>(stdin_json) else {
        return HookReply::pass();
    };
    // The cap first, before the brief: a torn brief must not lift it. The
    // claim is under a file lock, since the turn's hooks run at once.
    if claim_spawn(dir, SPAWN_CAP).is_err() {
        return HookReply::deny(spawn_cap_reason(SPAWN_CAP));
    }
    let brief = std::fs::read_to_string(dir.join(BRIEF_FILE)).unwrap_or_default();
    if brief.trim().is_empty() {
        return HookReply::pass();
    }
    let Value::Object(mut fields) = input.tool_input else {
        return HookReply::pass();
    };
    let Some(Value::String(prompt)) = fields.get("prompt") else {
        return HookReply::pass();
    };
    if prompt.trim_start().starts_with(BRIEF_OPEN) {
        return HookReply::pass();
    }
    let briefed = format!("{}\n\n{prompt}", brief.trim_end());
    fields.insert("prompt".into(), Value::String(briefed));
    HookReply::allow(Some(Value::Object(fields)))
}

/// The process entry: `<binary> --subagent-hook <dir>`. Reads stdin to
/// EOF, prints one JSON line, exits 0 — never non-zero on purpose, for
/// the reason [`super::ask::run_hook`] gives.
pub fn run_hook(args: &[String]) -> std::io::Result<()> {
    let dir = args.first().map(PathBuf::from).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "--subagent-hook needs the chat directory",
        )
    })?;
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let reply = decide(&dir, &input);
    let mut out = std::io::stdout().lock();
    out.write_all(serde_json::to_string(&reply)?.as_bytes())?;
    out.write_all(b"\n")?;
    out.flush()
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_seventh_spawn_of_a_turn_is_refused_and_a_new_turn_starts_over() {
        let dir = std::env::temp_dir().join(format!("nightloom-spawn-cap-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        super::write(
            &dir,
            "<nightloom-subagent-brief>x</nightloom-subagent-brief>",
        )
        .unwrap();
        let call = r#"{"tool_name":"Agent","tool_input":{"prompt":"go"}}"#;
        for _ in 0..super::SPAWN_CAP {
            assert_eq!(super::decide(&dir, call).decision(), "allow");
        }
        let r = super::decide(&dir, call);
        assert_eq!(r.decision(), "deny");
        assert!(r.reason().is_some_and(|s| s.contains("do it yourself")));
        super::reset_spawns(&dir);
        assert_eq!(super::decide(&dir, call).decision(), "allow");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The case he reported (a research turn spawning fourteen at once):
    /// the hooks run concurrently, and exactly `SPAWN_CAP` of them are
    /// allowed — the claim is under the file lock, so no two read the
    /// same count (the review of 2026-09-18; before it, all fourteen read
    /// 0). Threads stand in for the hook processes: `File::lock` is per
    /// open handle, so separate opens in one process contend as separate
    /// processes do.
    #[test]
    fn fourteen_spawns_at_once_get_exactly_the_cap() {
        let dir =
            std::env::temp_dir().join(format!("nightloom-spawn-race-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        super::write(
            &dir,
            "<nightloom-subagent-brief>x</nightloom-subagent-brief>",
        )
        .unwrap();
        let call = r#"{"tool_name":"Agent","tool_input":{"prompt":"go"}}"#;
        let gate = std::sync::Arc::new(std::sync::Barrier::new(14));
        let handles: Vec<_> = (0..14)
            .map(|_| {
                let dir = dir.clone();
                let gate = gate.clone();
                std::thread::spawn(move || {
                    gate.wait();
                    super::decide(&dir, call).decision() == "allow"
                })
            })
            .collect();
        let allowed = handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .filter(|ok| *ok)
            .count();
        assert_eq!(allowed, super::SPAWN_CAP);
        assert_eq!(
            std::fs::read_to_string(dir.join(super::SPAWNS_FILE))
                .unwrap()
                .trim(),
            super::SPAWN_CAP.to_string()
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    use super::*;
    use nightloom_core::Segment;
    use serde_json::json;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nightloom-brief-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The parent's `Agent` call as the CLI handed it to the hook on
    /// 2026-09-17 (`152-evidence-2026-09-17/mb-hook.log`), the fields
    /// nothing here reads trimmed.
    const STDIN: &str = r#"{"session_id":"0ec12560","cwd":"/tmp","hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{"description":"Check for code word in task","prompt":"Reply with the code word if your task text states one.","subagent_type":"general-purpose","model":"haiku","run_in_background":false},"tool_use_id":"toolu_01Bs4UKADSZoWWJ73dAkY3aG","permission_mode":"default"}"#;

    fn preamble() -> SystemPrompt {
        let mut p = SystemPrompt::new();
        p.push(Segment::new(
            SegmentKind::ProjectInstructions,
            "project-instructions",
            "<project-instructions>\nWrite notes under notes/.\n</project-instructions>",
        ));
        p.push(Segment::new(
            SegmentKind::Knowledge,
            "knowledge",
            "<knowledge>\n@kb/a.md\n@kb/b.md\n</knowledge>",
        ));
        p.push(Segment::new(
            SegmentKind::UserMemory,
            "user-memory",
            "<user-memory>\nBe terse.\n</user-memory>",
        ));
        p.push(Segment::new(
            SegmentKind::EngineNote,
            "engine-note",
            "<engine-note>\n@kb stands for the vault directory /v.\n</engine-note>",
        ));
        p.push(Segment::new(SegmentKind::Custom, "custom", "You are Rex."));
        p
    }

    /// The brief keeps the project's instructions and the engine note,
    /// takes the notes it is given, and cuts the indexes, the standing
    /// instructions and the library prompt.
    #[test]
    fn the_brief_keeps_two_segments_and_the_notes() {
        let text = compose(
            &preamble(),
            &["<extra-folders>\n/x\n</extra-folders>".into()],
        )
        .unwrap();
        assert!(text.starts_with(BRIEF_OPEN), "{text}");
        assert!(text.ends_with(BRIEF_CLOSE), "{text}");
        assert!(text.contains("Write notes under notes/."));
        assert!(text.contains("@kb stands for the vault directory /v."));
        assert!(text.contains("<extra-folders>"));
        for cut in ["@kb/a.md", "Be terse.", "You are Rex."] {
            assert!(!text.contains(cut), "{cut} should be cut: {text}");
        }
        let p = text.find("<project-instructions>").unwrap();
        let e = text.find("<engine-note>").unwrap();
        let x = text.find("<extra-folders>").unwrap();
        assert!(p < e && e < x, "the preamble's order, the notes last");
        // Nothing to brief with: no brief, so no hook is registered.
        assert_eq!(compose(&SystemPrompt::new(), &[]), None);
        assert_eq!(compose(&SystemPrompt::from_text("You are Rex."), &[]), None);
        assert_eq!(compose(&SystemPrompt::new(), &["  ".into()]), None);
    }

    /// The hook prepends the brief to the task and hands the whole input
    /// back; without a brief on disk, or on a task already briefed, it
    /// has no opinion.
    #[test]
    fn the_hook_prepends_the_brief_once() {
        let dir = scratch();
        assert_eq!(decide(&dir, STDIN), HookReply::pass());
        let brief = compose(&preamble(), &[]).unwrap();
        write(&dir, &brief).unwrap();
        let reply = decide(&dir, STDIN);
        assert_eq!(reply.decision(), "allow");
        let updated = reply.updated_input().unwrap();
        let prompt = updated["prompt"].as_str().unwrap();
        assert!(prompt.starts_with(BRIEF_OPEN), "{prompt}");
        assert!(
            prompt.ends_with("\n\nReply with the code word if your task text states one."),
            "{prompt}"
        );
        // The rest of the input rides along untouched.
        assert_eq!(updated["subagent_type"], "general-purpose");
        assert_eq!(updated["model"], "haiku");
        assert_eq!(updated["run_in_background"], false);
        // A second pass over the briefed task adds nothing.
        let again = STDIN.replace(
            r#""prompt":"Reply with the code word if your task text states one.""#,
            &format!(r#""prompt":{}"#, Value::String(prompt.to_string())),
        );
        assert_eq!(decide(&dir, &again), HookReply::pass());
        // Torn input and a call with no string prompt: no opinion.
        assert_eq!(decide(&dir, "{not json"), HookReply::pass());
        let no_prompt = STDIN.replace(r#""prompt":"Reply"#, r#""task":"Reply"#);
        assert_eq!(decide(&dir, &no_prompt), HookReply::pass());
        // The documented reply shape, key for key.
        let json = serde_json::to_string(&reply).unwrap();
        assert!(json.contains(r#""permissionDecision":"allow""#), "{json}");
        assert!(json.contains(r#""updatedInput":{"#), "{json}");
        // Writing the same brief again leaves the file as it is; a new one
        // replaces it.
        write(&dir, &brief).unwrap();
        write(&dir, "other").unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join(BRIEF_FILE)).unwrap(),
            "other"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The registration: the matcher names both spellings of the tool,
    /// the command is quoted word by word.
    #[test]
    fn the_hook_entry_is_quoted_and_matches_both_names() {
        let entry = hook_entry(
            &[
                "/Applications/Night loom.app/Contents/MacOS/nightloom-desktop".into(),
                "--subagent-hook".into(),
            ],
            Path::new("/tmp/ask/chat-1"),
        );
        assert_eq!(entry["matcher"], BRIEF_MATCHER);
        assert_eq!(
            entry["hooks"][0]["command"],
            "'/Applications/Night loom.app/Contents/MacOS/nightloom-desktop' '--subagent-hook' '/tmp/ask/chat-1'"
        );
        assert_eq!(entry["hooks"][0]["type"], "command");
        assert_eq!(json!(BRIEF_MATCHER), "Agent|Task");
    }
}
