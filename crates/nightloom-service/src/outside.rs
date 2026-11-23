//! Claude Code sessions Nightloom did not start, mirrored so its tools can
//! read them (nightshift item 751, from item 736's survey §3 item 5).
//!
//! He runs Claude Code in three places besides Nightloom — the terminal,
//! the Claude desktop app's Code tab, VS Code — and all three write the
//! CLI's own logs under `~/.claude/projects/<folder>/<session>.jsonl`.
//! `search_chats`, `read_chat` and the capture pass read Nightloom's logs
//! only, so a decision made in any of those sessions was invisible to all
//! three. This module copies **what was said** in those sessions into
//! Nightloom-format logs in a folder of its own
//! (`<config>/outside/claude-code/sessions/`), and every reader then
//! treats that folder as one more session directory, named
//! [`OUTSIDE_NAME`]: the chat index ranks it, a hit is labelled by it, and
//! capture folds it through the same `store::said` filter and stamps each
//! observation's `source` with it.
//!
//! **Said only, at the copy.** A CLI log holds tool calls, tool results,
//! request bodies, file snapshots and hook output beside the conversation;
//! the mirror keeps the user's typed messages and the assistant's text
//! replies and nothing else — no tool results, no thinking, no subagent
//! (sidechain) lines, no `isMeta` injections, and the harness's own tags
//! (`<system-reminder>`, `<task-notification>`, slash-command echoes)
//! stripped. The readers' own filter applies again on top.
//!
//! **Which sessions.** A session is mirrored only when its `entrypoint` —
//! the field the CLI stamps on every line — names an interactive surface
//! (`cli`, `claude-desktop`, `claude-vscode`, …). Every `sdk-*` entrypoint
//! is a program driving `claude -p`, and on this machine that is almost
//! always Nightloom itself: its chats, its capture and dream passes, its
//! title calls, its incognito chats (measured 2026-11-16 over 7,750 logs:
//! 1,317 `sdk-cli`, every one with an opening that is a Nightloom chat or
//! a Nightloom pass). So a Nightloom incognito chat on the Claude Code
//! engine, whose CLI log exists (an incognito chat does not pass
//! `--no-session-persistence`), is never mirrored, and its words reach no
//! reader through here. Belt and braces: a session whose id any Nightloom
//! log records as its `agent_session` is skipped whatever its entrypoint,
//! and so is one whose working folder is under Nightloom's config dir. A
//! log with conversation but no entrypoint at all (an old CLI) is skipped
//! as of unknown origin. The cost of the rule, stated: a scripted
//! `claude -p` run of his own (a Nightshift unit) is not mirrored either.
//!
//! **Incremental, on the listing's terms.** `state.json` keeps, per source
//! log, the byte offset read to (complete lines only), the decision, and
//! the title last written; a log that grew costs the bytes it gained, one
//! that shrank was replaced and is mirrored again from the top. The mirror
//! is derived data in Nightloom's own folder: it is the only thing written,
//! the source logs are only ever opened to read, and a mirrored log found
//! later to be Nightloom's is deleted from the mirror.
//!
//! **Test and scratch sessions (item 900).** Many sessions here were not
//! him talking: a probe or harness an agent ran with `claude` from a shell
//! inherits the desktop's entrypoint, so the rule above admits it, and its
//! made-up prompts ("an errand list", "a flight to SEA") read as his facts
//! once captured. Each admitted session's working folder (and the
//! permission mode it started in) is kept in `state.json`, and every sync
//! writes [`TESTS_FILE`]: the mirrored sessions the capture pass skips —
//! working folder in a temporary folder, a cache folder, a test harness's
//! folder or a Nightloom build worktree ([`test_mark`]) — and the borderline
//! ones it reads but tags "test session". They stay mirrored and
//! searchable; only capture (live and backfill) treats them differently.
//!
//! **One writer.** Only the desktop app syncs (on launch and on the
//! bell's clock), under a process lock; the CLI's `capture` reads what is
//! there.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use nightloom_core::{ContentBlock, Session, SessionEvent, Usage};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// What a mirrored chat's directory is called in a result line, and the
/// `source` its captured observations carry.
pub const OUTSIDE_NAME: &str = "Claude Code, outside Nightloom";
const STATE_VERSION: u32 = 1;
/// The most read from one source log in one sync: a 300 MB log is mirrored
/// over several syncs rather than held in memory at once.
const CHUNK: u64 = 32 * 1024 * 1024;

/// The mirror's folder under the config dir.
pub fn root(config: &Path) -> PathBuf {
    config.join("outside").join("claude-code")
}

/// Where the mirrored logs are: one more session directory.
pub fn sessions_dir(config: &Path) -> PathBuf {
    root(config).join("sessions")
}

/// When the mirror first ran — the capture pass reads only mirrored chats
/// active since, so the first sync does not turn years of history into a
/// backlog of capture turns. `None` before the first sync.
pub fn since(config: &Path) -> Option<DateTime<Utc>> {
    load_state(config).since
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct State {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    since: Option<DateTime<Utc>>,
    #[serde(default)]
    sources: BTreeMap<String, Source>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct Source {
    /// Bytes read, to the end of the last complete line.
    offset: u64,
    /// Why it is not mirrored; set once and never cleared.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    excluded: Option<String>,
    /// The surface it ran on, once decided.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    app: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    folder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    custom_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    first_user: Option<String>,
    /// The title last recorded in the mirror.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last: Option<DateTime<Utc>>,
    /// The working folder, whole (item 900): `folder` is its last two
    /// parts, for a person; the test rules need the rest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
    /// The permission mode it started in (item 900): a script's are the
    /// modes that never ask.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    perm: Option<String>,
    /// A source admitted before item 900 had its head read once for the
    /// two fields above; set so it is not read again.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    probed: bool,
}

/// What one sync did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct SyncOutcome {
    /// Source logs seen.
    pub sources: usize,
    /// Logs with new conversation written to the mirror this sync.
    pub mirrored: usize,
    /// Messages written.
    pub messages: usize,
    /// Source logs skipped, by reason, in total (not only this sync).
    pub excluded: BTreeMap<String, usize>,
    /// Source logs whose mirror exists.
    pub admitted: usize,
    /// Of those, the test and scratch sessions capture skips (item 900).
    pub tests: usize,
    /// And the borderline ones it reads tagged "test session".
    pub tagged: usize,
}

fn state_path(config: &Path) -> PathBuf {
    root(config).join("state.json")
}

fn load_state(config: &Path) -> State {
    fs::read(state_path(config))
        .ok()
        .and_then(|b| serde_json::from_slice::<State>(&b).ok())
        .filter(|s| s.version == STATE_VERSION)
        .unwrap_or_default()
}

fn save_state(config: &Path, state: &State) -> Result<(), String> {
    let path = state_path(config);
    let tmp = path.with_extension(format!("json.{}", std::process::id()));
    let bytes = serde_json::to_vec(state).map_err(|e| e.to_string())?;
    fs::write(&tmp, bytes).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// The CLI's session logs, top level only: `<claude>/projects/*/*.jsonl`.
/// A subagent's transcript (`<session>/subagents/…`) is agent-to-agent,
/// not something he said, and is not walked.
fn source_logs(claude: &Path) -> Vec<(PathBuf, u64)> {
    let mut out = Vec::new();
    let Ok(dirs) = fs::read_dir(claude.join("projects")) else {
        return out;
    };
    for dir in dirs.flatten() {
        if !dir.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let Ok(files) = fs::read_dir(dir.path()) else {
            continue;
        };
        for f in files.flatten() {
            let path = f.path();
            if path.extension().is_none_or(|e| e != "jsonl") {
                continue;
            }
            let Ok(meta) = f.metadata() else { continue };
            if meta.is_file() {
                out.push((path, meta.len()));
            }
        }
    }
    out.sort();
    out
}

/// Every CLI session id a Nightloom log records (`agent_session`), across
/// every session dir capture reads — the mirror's own excepted.
fn nightloom_ids(config: &Path) -> HashSet<String> {
    let mut ids = HashSet::new();
    let mirror = sessions_dir(config);
    for d in crate::capture::session_dirs(config) {
        if d.dir == mirror {
            continue;
        }
        let Ok(logs) = crate::store::log_files(&d.dir) else {
            continue;
        };
        for log in logs {
            let Ok(bytes) = fs::read(&log.path) else {
                continue;
            };
            for line in bytes.split(|b| *b == b'\n') {
                if !contains(line, b"\"agent_session\"") {
                    continue;
                }
                if let Ok(v) = serde_json::from_slice::<Value>(line)
                    && let Some(id) = v.get("id").and_then(Value::as_str)
                {
                    ids.insert(id.to_string());
                }
            }
        }
    }
    ids
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// One message on its way to the mirror.
enum Said {
    User {
        text: String,
        at: DateTime<Utc>,
    },
    Assistant {
        id: Option<String>,
        model: String,
        text: String,
        at: DateTime<Utc>,
    },
}

/// Bring the mirror up to date with `<claude>/projects`. `claude` is the
/// CLI's folder; passed in so a test never reads the real one.
pub fn sync(config: &Path, claude: &Path) -> Result<SyncOutcome, String> {
    let mirror = sessions_dir(config);
    fs::create_dir_all(&mirror).map_err(|e| format!("cannot create {}: {e}", mirror.display()))?;
    let mut state = load_state(config);
    if state.version != STATE_VERSION {
        state = State {
            version: STATE_VERSION,
            ..State::default()
        };
    }
    if state.since.is_none() {
        state.since = Some(Utc::now());
    }
    let config_canon = config
        .canonicalize()
        .unwrap_or_else(|_| config.to_path_buf());
    let mut ours: Option<HashSet<String>> = None;
    let mut out = SyncOutcome::default();
    let logs = source_logs(claude);
    out.sources = logs.len();
    for (path, len) in logs {
        let Some(id) = path.file_stem().map(|s| s.to_string_lossy().into_owned()) else {
            continue;
        };
        if !crate::store::is_log_id(&id) {
            continue;
        }
        let key = path.to_string_lossy().into_owned();
        let mut src = state.sources.get(&key).cloned().unwrap_or_default();
        let target = mirror.join(format!("{id}.jsonl"));
        if src.excluded.is_some() {
            src.offset = len;
            state.sources.insert(key, src);
            continue;
        }
        if len < src.offset {
            // Replaced: mirror it again from the top.
            let _ = fs::remove_file(&target);
            src = Source::default();
        }
        if src.folder.is_some() && src.cwd.is_none() && !src.probed {
            // Admitted before item 900: read the head once for the
            // working folder and the permission mode.
            probe(&path, &mut src);
        }
        if len == src.offset {
            state.sources.insert(key, src);
            continue;
        }
        let Some((chunk, end)) = read_lines(&path, src.offset, len) else {
            state.sources.insert(key, src);
            continue;
        };
        let mut pending: Vec<Said> = Vec::new();
        let mut conversation = false;
        let mut title_changed = false;
        for line in chunk.split(|b| *b == b'\n') {
            if line.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_slice::<Value>(line) else {
                continue;
            };
            if src.app.is_none()
                && let Some(e) = v.get("entrypoint").and_then(Value::as_str)
            {
                if e.starts_with("sdk") {
                    src.excluded = Some("run by a program (sdk entrypoint)".into());
                    break;
                }
                src.app = Some(e.to_string());
            }
            if src.folder.is_none()
                && let Some(cwd) = v.get("cwd").and_then(Value::as_str)
            {
                let cwd = Path::new(cwd);
                let canon = cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf());
                if canon.starts_with(&config_canon) || cwd.starts_with(config) {
                    src.excluded = Some("in Nightloom's own folder".into());
                    break;
                }
                src.folder = Some(folder_label(cwd));
                src.cwd = Some(cwd.to_string_lossy().into_owned());
            }
            if src.perm.is_none()
                && let Some(m) = v.get("permissionMode").and_then(Value::as_str)
            {
                src.perm = Some(m.to_string());
            }
            let ty = v.get("type").and_then(Value::as_str).unwrap_or("");
            if ty == "custom-title" {
                if let Some(t) = v.get("customTitle").and_then(Value::as_str) {
                    let t = t.trim();
                    if !t.is_empty() && src.custom_title.as_deref() != Some(t) {
                        src.custom_title = Some(t.to_string());
                        title_changed = true;
                    }
                }
                continue;
            }
            if ty != "user" && ty != "assistant" {
                continue;
            }
            conversation = true;
            if flag(&v, "isSidechain") || flag(&v, "isMeta") || flag(&v, "isCompactSummary") {
                continue;
            }
            let at = v
                .get("timestamp")
                .and_then(Value::as_str)
                .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
                .map(|t| t.with_timezone(&Utc))
                .or(src.last)
                .unwrap_or_else(Utc::now);
            let Some(message) = v.get("message") else {
                continue;
            };
            if ty == "user" {
                if let Some(text) = user_text(message.get("content")) {
                    if src.first_user.is_none() {
                        src.first_user = Some(first_line(&text));
                        title_changed = true;
                    }
                    pending.push(Said::User { text, at });
                }
            } else if let Some(text) = assistant_text(message.get("content")) {
                let mid = message
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let model = message
                    .get("model")
                    .and_then(Value::as_str)
                    .unwrap_or("claude-code")
                    .to_string();
                // One reply is one line per content block in the CLI's log;
                // consecutive lines of one message are one message here.
                if let Some(Said::Assistant {
                    id: Some(prev),
                    text: t,
                    at: a,
                    ..
                }) = pending.last_mut()
                    && mid.as_deref() == Some(prev.as_str())
                {
                    t.push_str("\n\n");
                    t.push_str(&text);
                    *a = at;
                    continue;
                }
                pending.push(Said::Assistant {
                    id: mid,
                    model,
                    text,
                    at,
                });
            }
        }
        if src.excluded.is_some() {
            let _ = fs::remove_file(&target);
            src.offset = len;
            state.sources.insert(key, src);
            continue;
        }
        if src.app.is_none() {
            if conversation {
                src.excluded = Some("no entrypoint (unknown origin)".into());
                src.offset = len;
            }
            // Else nothing decided and nothing said yet: read again next time.
            state.sources.insert(key, src);
            continue;
        }
        if !target.exists() && !pending.is_empty() {
            // First write of this session: is it one Nightloom started?
            let ids = ours.get_or_insert_with(|| nightloom_ids(config));
            if ids.contains(&id) {
                src.excluded = Some("started by Nightloom".into());
                src.offset = len;
                state.sources.insert(key, src);
                continue;
            }
        }
        if !pending.is_empty() || (title_changed && target.exists()) {
            match write(&mirror, &id, &mut src, &pending) {
                Ok(n) => {
                    out.mirrored += 1;
                    out.messages += n;
                }
                Err(e) => {
                    // Not advanced: the same bytes are offered next sync.
                    state.sources.insert(key, src);
                    save_state(config, &state)?;
                    return Err(e);
                }
            }
        }
        src.offset = end;
        state.sources.insert(key, src);
    }
    let mut marks = BTreeMap::new();
    for (key, s) in &state.sources {
        match &s.excluded {
            Some(why) => *out.excluded.entry(why.clone()).or_default() += 1,
            None if s.title.is_some() => {
                out.admitted += 1;
                let id = Path::new(key)
                    .file_stem()
                    .map(|x| x.to_string_lossy().into_owned());
                if let (Some(id), Some(m)) = (
                    id,
                    test_mark(s.cwd.as_deref(), s.folder.as_deref(), s.perm.as_deref()),
                ) {
                    if m.skip {
                        out.tests += 1;
                    } else {
                        out.tagged += 1;
                    }
                    marks.insert(id, m);
                }
            }
            None => {}
        }
    }
    save_state(config, &state)?;
    save_marks(config, &marks)?;
    Ok(out)
}

/// The mirrored sessions that are tests (item 900), by mirrored id: written
/// by every sync, read by the capture pass.
pub const TESTS_FILE: &str = "tests.json";

/// Why a mirrored session is a test or scratch session, and whether the
/// capture pass skips it (`skip`) or reads it tagged "test session".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TestMark {
    pub rule: String,
    pub skip: bool,
}

/// The `source` a tagged session's observations carry (item 900).
pub const OUTSIDE_TEST_NAME: &str = "Claude Code, outside Nightloom (test session)";

/// The test rules (item 900), on what a session's header says. Skipped:
/// a working folder in a temporary folder (`/tmp`, `/private/tmp`,
/// `/var/folders` — where a probe's `claude` runs, and Claude Code's own
/// per-session scratch `/private/tmp/claude-<uid>/…`), in a cache folder
/// (`Library/Caches`), in a test harness's folder (`*-harness` under
/// `runner-design`) or in a Nightloom build worktree (`local/nightloom-*`).
/// Tagged: one started in a mode that never asks (`bypassPermissions`,
/// `dontAsk` — how scripts run it), or one whose source is gone and whose
/// folder's label is all that is left and starts in a `tmp` folder.
pub fn test_mark(cwd: Option<&str>, folder: Option<&str>, perm: Option<&str>) -> Option<TestMark> {
    let mark = |rule: &str, skip: bool| {
        Some(TestMark {
            rule: rule.to_string(),
            skip,
        })
    };
    if let Some(cwd) = cwd {
        let parts: Vec<&str> = cwd.split('/').filter(|p| !p.is_empty()).collect();
        let under = |root: &[&str]| parts.len() >= root.len() && parts[..root.len()] == *root;
        if under(&["tmp"])
            || under(&["private", "tmp"])
            || under(&["var", "folders"])
            || under(&["private", "var", "folders"])
        {
            return mark("a temporary folder", true);
        }
        let pair =
            |a: &str, b: &dyn Fn(&str) -> bool| parts.windows(2).any(|w| w[0] == a && b(w[1]));
        if pair("Library", &|b| b == "Caches") {
            return mark("a cache folder (Library/Caches)", true);
        }
        if pair("runner-design", &|b| b.ends_with("-harness")) {
            return mark("a test harness folder (runner-design/*-harness)", true);
        }
        if pair("local", &|b| b.starts_with("nightloom-")) {
            return mark("a Nightloom build worktree (local/nightloom-*)", true);
        }
    } else if let Some(f) = folder
        && (f.starts_with("tmp/") || f == "tmp")
    {
        return mark("a tmp folder (source gone; label only)", false);
    }
    if matches!(perm, Some("bypassPermissions" | "dontAsk")) {
        return mark("started in a mode that never asks (as scripts run)", false);
    }
    None
}

/// The marks the last sync wrote; empty before the first.
pub fn test_marks(config: &Path) -> BTreeMap<String, TestMark> {
    fs::read(root(config).join(TESTS_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

fn save_marks(config: &Path, marks: &BTreeMap<String, TestMark>) -> Result<(), String> {
    let path = root(config).join(TESTS_FILE);
    let tmp = path.with_extension(format!("json.{}", std::process::id()));
    let bytes = serde_json::to_vec(marks).map_err(|e| e.to_string())?;
    fs::write(&tmp, bytes).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, &path).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// The head of a source admitted before item 900 (at most 1 MB), for its
/// working folder and permission mode. A gone or unreadable log leaves
/// both unset and is not read again.
fn probe(path: &Path, src: &mut Source) {
    src.probed = true;
    let Ok(f) = fs::File::open(path) else { return };
    let mut buf = Vec::new();
    if f.take(1024 * 1024).read_to_end(&mut buf).is_err() {
        return;
    }
    for line in buf.split(|b| *b == b'\n') {
        if src.cwd.is_some() && src.perm.is_some() {
            break;
        }
        let Ok(v) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        if src.cwd.is_none()
            && let Some(c) = v.get("cwd").and_then(Value::as_str)
        {
            src.cwd = Some(c.to_string());
        }
        if src.perm.is_none()
            && let Some(m) = v.get("permissionMode").and_then(Value::as_str)
        {
            src.perm = Some(m.to_string());
        }
    }
}

fn flag(v: &Value, name: &str) -> bool {
    v.get(name).and_then(Value::as_bool).unwrap_or(false)
}

/// `[from, to)` of `path`, cut back to the last newline (a line being
/// written now is read next time), at most [`CHUNK`] bytes. Returns the
/// bytes and the offset they end at; `None` when no complete line is new.
fn read_lines(path: &Path, from: u64, to: u64) -> Option<(Vec<u8>, u64)> {
    let mut f = fs::File::open(path).ok()?;
    f.seek(SeekFrom::Start(from)).ok()?;
    let want = (to - from).min(CHUNK);
    let mut buf = Vec::with_capacity(want as usize);
    f.take(want).read_to_end(&mut buf).ok()?;
    let cut = buf.iter().rposition(|b| *b == b'\n')? + 1;
    buf.truncate(cut);
    Some((buf, from + cut as u64))
}

/// The harness's wrappers inside a user message: removed with their
/// contents.
const STRIP: [&str; 4] = [
    "system-reminder",
    "ide_opened_file",
    "ide_selection",
    "ide_diagnostics",
];
/// A user message that opens with one of these is the harness talking
/// (a slash command's echo, a background task's notice, a shell escape's
/// output), not him.
const DROP: [&str; 9] = [
    "<task-notification",
    "<command-name",
    "<command-message",
    "<command-args",
    "<local-command-stdout",
    "<local-command-caveat",
    "<bash-input",
    "<bash-stdout",
    "<bash-stderr",
];

fn user_text(content: Option<&Value>) -> Option<String> {
    let raw = match content? {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => return None,
    };
    let mut text = raw;
    for tag in STRIP {
        text = strip_tag(&text, tag);
    }
    let text = text.trim();
    if text.is_empty() || DROP.iter().any(|d| text.starts_with(d)) {
        return None;
    }
    if text.starts_with(
        "Caveat: The messages below were generated by the user while running local commands",
    ) {
        return None;
    }
    Some(text.to_string())
}

fn assistant_text(content: Option<&Value>) -> Option<String> {
    let text = match content? {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => return None,
    };
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// `text` with every `<tag …>…</tag>` removed; an unclosed one runs to the
/// end.
fn strip_tag(text: &str, tag: &str) -> String {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find(&open) {
        out.push_str(&rest[..i]);
        match rest[i..].find(&close) {
            Some(j) => rest = &rest[i + j + close.len()..],
            None => {
                rest = "";
                break;
            }
        }
    }
    out.push_str(rest);
    out
}

fn first_line(text: &str) -> String {
    let line = text
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim();
    let mut s: String = line.chars().take(60).collect();
    if line.chars().count() > 60 {
        s.push('…');
    }
    s
}

/// The working folder's last two parts, for a person.
fn folder_label(cwd: &Path) -> String {
    let parts: Vec<String> = cwd
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    match parts.len() {
        0 => cwd.display().to_string(),
        1 => parts[0].clone(),
        n => format!("{}/{}", parts[n - 2], parts[n - 1]),
    }
}

/// The surface an entrypoint names, for a person.
fn app_label(entrypoint: &str) -> String {
    match entrypoint {
        "cli" => "terminal".into(),
        "claude-desktop" => "desktop app".into(),
        "claude-vscode" => "VS Code".into(),
        other => other.to_string(),
    }
}

/// The mirrored chat's title: the session's own name (or its opening
/// line) and where it ran — the source label every result line carries.
fn title_of(src: &Source) -> Option<String> {
    let name = src.custom_title.as_deref().or(src.first_user.as_deref())?;
    let app = app_label(src.app.as_deref().unwrap_or("?"));
    Some(match &src.folder {
        Some(f) => format!("{name} · Claude Code {app}, {f}"),
        None => format!("{name} · Claude Code {app}"),
    })
}

/// Append `pending` (and a changed title) to the mirrored log, creating
/// it on first write; stamp it with the last message's time, which is what
/// the listing and the ranking's recency read. Returns messages written.
fn write(dir: &Path, id: &str, src: &mut Source, pending: &[Said]) -> Result<usize, String> {
    let path = dir.join(format!("{id}.jsonl"));
    let first_at = pending
        .first()
        .map(|p| match p {
            Said::User { at, .. } | Said::Assistant { at, .. } => *at,
        })
        .or(src.last)
        .unwrap_or_else(Utc::now);
    let mut session = match Session::with_log_as(dir, id, first_at) {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            Session::load(&path).map_err(|e| format!("cannot open {}: {e}", path.display()))?
        }
        Err(e) => return Err(format!("cannot create {}: {e}", path.display())),
    };
    if let Some(t) = title_of(src)
        && src.title.as_deref() != Some(t.as_str())
    {
        session.record(SessionEvent::Title {
            text: t.clone(),
            at: first_at,
            by: None,
        });
        src.title = Some(t);
    }
    for p in pending {
        match p {
            Said::User { text, at } => {
                session.record(SessionEvent::UserMessage {
                    text: text.clone(),
                    images: Vec::new(),
                    documents: Vec::new(),
                    spoken: false,
                    at: *at,
                });
                src.last = Some(*at);
            }
            Said::Assistant {
                model, text, at, ..
            } => {
                session.record(SessionEvent::AssistantMessage {
                    model: model.clone(),
                    blocks: vec![ContentBlock::Text { text: text.clone() }],
                    stop_reason: None,
                    // Copied history: no counts, and no cost claimed.
                    usage: Usage::default(),
                    cost: None,
                    sent_at: None,
                    cache_ttl: None,
                    cache_key: None,
                    at: *at,
                });
                src.last = Some(*at);
            }
        }
    }
    if let Some(f) = session.write_failure() {
        return Err(format!("cannot write {}: {f:?}", path.display()));
    }
    drop(session);
    if let Some(last) = src.last
        && let Ok(file) = fs::OpenOptions::new().write(true).open(&path)
    {
        let _ = file.set_modified(std::time::SystemTime::from(last));
    }
    Ok(pending.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::project::{PROJECTS_DIR, SESSIONS_DIR};
    use std::io::Write;
    use std::time::SystemTime;

    pub(crate) fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "nl-outside-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn line(ty: &str, entry: &str, cwd: &str, content: Value, extra: Value) -> String {
        let mut v = serde_json::json!({
            "type": ty,
            "entrypoint": entry,
            "cwd": cwd,
            "sessionId": "x",
            "timestamp": "2026-11-16T10:00:00Z",
            "message": {"role": ty, "content": content, "id": "m1", "model": "claude-opus-5-5"},
        });
        if let (Value::Object(a), Value::Object(b)) = (&mut v, extra) {
            a.extend(b);
        }
        v.to_string() + "\n"
    }

    /// A session the terminal ran, as the CLI logs it: his message, a tool
    /// call and its result, the reply in two lines, a harness reminder and
    /// a background-task notice.
    pub(crate) fn cli_log(entry: &str, cwd: &str, said: &str, tool_secret: &str) -> String {
        let mut s = String::new();
        s += &serde_json::json!({"type":"custom-title","customTitle":"Roll watcher","sessionId":"x"}).to_string();
        s += "\n";
        s += &line(
            "user",
            entry,
            cwd,
            Value::String(format!(
                "{said}<system-reminder>hidden harness text</system-reminder>"
            )),
            serde_json::json!({}),
        );
        s += &line(
            "assistant",
            entry,
            cwd,
            serde_json::json!([{"type":"tool_use","id":"t","name":"Read","input":{}}]),
            serde_json::json!({}),
        );
        s += &line(
            "user",
            entry,
            cwd,
            serde_json::json!([{"type":"tool_result","tool_use_id":"t","content": tool_secret}]),
            serde_json::json!({}),
        );
        s += &line(
            "assistant",
            entry,
            cwd,
            serde_json::json!([{"type":"text","text":"The watcher matched itself."}]),
            serde_json::json!({}),
        );
        s += &line(
            "assistant",
            entry,
            cwd,
            serde_json::json!([{"type":"thinking","thinking":"private reasoning"}, {"type":"text","text":"Fixed by path."}]),
            serde_json::json!({}),
        );
        s += &line(
            "user",
            entry,
            cwd,
            Value::String("<task-notification>agent done</task-notification>".into()),
            serde_json::json!({}),
        );
        s += &line(
            "user",
            entry,
            cwd,
            Value::String("a sidechain prompt".into()),
            serde_json::json!({"isSidechain": true}),
        );
        s
    }

    fn put(claude: &Path, folder: &str, id: &str, body: &str) -> PathBuf {
        let d = claude.join("projects").join(folder);
        fs::create_dir_all(&d).unwrap();
        let p = d.join(format!("{id}.jsonl"));
        fs::write(&p, body).unwrap();
        p
    }

    fn mirrored(config: &Path, id: &str) -> Option<String> {
        fs::read_to_string(sessions_dir(config).join(format!("{id}.jsonl"))).ok()
    }

    #[test]
    fn a_terminal_session_is_mirrored_said_only_with_its_source_in_the_title() {
        let root = scratch("said");
        let (config, claude) = (root.join("config"), root.join("claude"));
        let id = "11111111-2222-3333-4444-555555555555";
        let src = put(
            &claude,
            "-Users-me-code-app",
            id,
            &cli_log(
                "cli",
                "/Users/me/code/app",
                "Why does the roll never install?",
                "TOOLSECRET",
            ),
        );
        let before = fs::read(&src).unwrap();
        let out = sync(&config, &claude).unwrap();
        assert_eq!(out.mirrored, 1);
        assert_eq!(
            fs::read(&src).unwrap(),
            before,
            "the source is never written"
        );
        let log = mirrored(&config, id).expect("mirrored");
        assert!(log.contains("Why does the roll never install?"));
        assert!(
            log.contains("The watcher matched itself.\\n\\nFixed by path."),
            "{log}"
        );
        assert!(
            log.contains("Roll watcher · Claude Code terminal, code/app"),
            "{log}"
        );
        for absent in [
            "TOOLSECRET",
            "hidden harness text",
            "private reasoning",
            "agent done",
            "a sidechain prompt",
        ] {
            assert!(!log.contains(absent), "{absent} leaked: {log}");
        }

        // It grows: only the new bytes are read, appended once.
        let mut f = fs::OpenOptions::new().append(true).open(&src).unwrap();
        f.write_all(
            line(
                "user",
                "cli",
                "/Users/me/code/app",
                Value::String("And the phone listener?".into()),
                serde_json::json!({"timestamp":"2026-11-16T11:00:00Z"}),
            )
            .as_bytes(),
        )
        .unwrap();
        // Closed, as the CLI's appends are: Windows' directory listing (where
        // the size is read) shows an open file's old size (item 864).
        drop(f);
        let again = sync(&config, &claude).unwrap();
        assert_eq!(again.messages, 1);
        let log = mirrored(&config, id).unwrap();
        assert_eq!(log.matches("Why does the roll never install?").count(), 1);
        assert!(log.contains("And the phone listener?"));
        assert_eq!(sync(&config, &claude).unwrap().messages, 0, "nothing new");
    }

    /// Exclusions hold: a program's run (every Nightloom chat, incognito
    /// included, and every Nightloom pass), a session a Nightloom log
    /// names as its own whatever its entrypoint, and one in Nightloom's
    /// folder are never mirrored.
    #[test]
    fn nightloom_runs_and_incognito_chats_are_never_mirrored() {
        let root = scratch("excl");
        let (config, claude) = (root.join("config"), root.join("claude"));
        let sdk = "aaaaaaaa-0000-0000-0000-000000000001";
        put(
            &claude,
            "-tmp-a",
            sdk,
            &cli_log("sdk-cli", "/tmp/a", "INCOGNITOWORD", "x"),
        );
        // A Nightloom incognito chat that recorded this CLI session.
        let named = "aaaaaaaa-0000-0000-0000-000000000002";
        put(
            &claude,
            "-tmp-b",
            named,
            &cli_log("claude-desktop", "/tmp/b", "RECORDEDWORD", "x"),
        );
        let unfiled = config.join(crate::capture::UNFILED).join(SESSIONS_DIR);
        let mut s = Session::start(
            &unfiled,
            nightloom_core::ChatMode::Incognito,
            Default::default(),
        )
        .unwrap();
        s.record_user("hello");
        s.record_agent_session("claude-code", named);
        drop(s);
        let own = "aaaaaaaa-0000-0000-0000-000000000003";
        let cwd = config.join("scratch");
        fs::create_dir_all(&cwd).unwrap();
        put(
            &claude,
            "-cfg",
            own,
            &cli_log("cli", &cwd.to_string_lossy(), "OWNWORD", "x"),
        );
        let kept = "aaaaaaaa-0000-0000-0000-000000000004";
        put(
            &claude,
            "-tmp-c",
            kept,
            &cli_log("claude-vscode", "/tmp/c", "KEPTWORD", "x"),
        );

        let out = sync(&config, &claude).unwrap();
        assert_eq!(out.mirrored, 1, "{out:?}");
        assert!(mirrored(&config, sdk).is_none());
        assert!(mirrored(&config, named).is_none());
        assert!(mirrored(&config, own).is_none());
        assert!(mirrored(&config, kept).unwrap().contains("KEPTWORD"));
        let all: String = fs::read_dir(sessions_dir(&config))
            .unwrap()
            .flatten()
            .map(|e| fs::read_to_string(e.path()).unwrap_or_default())
            .collect();
        for w in ["INCOGNITOWORD", "RECORDEDWORD", "OWNWORD"] {
            assert!(!all.contains(w), "{w} reached the mirror");
        }
        assert_eq!(out.excluded.values().sum::<usize>(), 3, "{out:?}");
        let _ = PROJECTS_DIR;
    }

    /// The Claude Code engine's `search_chats` (served by Nightloom's MCP
    /// server, which every Claude Code chat uses) finds the mirrored
    /// session in `scope: all`, labelled by its source, and `read_chat`
    /// opens it; the excluded run's words find nothing.
    /// The test rules (item 900), each on the header field it reads.
    #[test]
    fn the_test_rules_skip_scratch_folders_and_tag_the_borderline() {
        let skip = |cwd: &str| test_mark(Some(cwd), None, Some("default")).map(|m| m.skip);
        for cwd in [
            "/tmp/x",
            "/private/tmp/claude-501/-Users-me/abc",
            "/private/var/folders/9b/xyz",
            "/Users/me/Library/Caches/nightloom-779-check",
            "/Users/me/n/nightshift-code/notes/runner-design/847-harness/run",
            "/Users/me/PersonalProjects/Nightloom/local/nightloom-900",
        ] {
            assert_eq!(skip(cwd), Some(true), "{cwd}");
        }
        for cwd in [
            "/Users/me/code/app",
            "/Users/me/tmp-notes",
            "/Users/me/Library/Application Support/Claude/scratch-workspaces/a",
            "/Users/me/.claude-bridge/workdir",
            "/Users/me/local/other",
        ] {
            assert_eq!(skip(cwd), None, "{cwd}");
        }
        let tag = test_mark(Some("/Users/me/code/app"), None, Some("dontAsk")).unwrap();
        assert!(!tag.skip);
        assert!(!test_mark(None, Some("tmp/2037m-work"), None).unwrap().skip);
        assert_eq!(test_mark(None, Some("code/app"), None), None);
    }

    /// The Check's count (item 900), never in CI: the real rules over a
    /// file of real session headers (`NL900_HEADERS`: a JSON list of `{id,
    /// cwd, folder, perm, older}` extracted read-only, metadata only).
    /// Prints the count per rule, split older (backfill) and newer (live).
    #[test]
    #[ignore]
    fn test_rules_over_real_headers() {
        let path = std::env::var("NL900_HEADERS").expect("NL900_HEADERS");
        let rows: Vec<Value> = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        let mut by: BTreeMap<(String, bool, bool), usize> = BTreeMap::new();
        let (mut older, mut newer) = (0, 0);
        for r in &rows {
            let s = |k: &str| r.get(k).and_then(Value::as_str);
            let old = r.get("older").and_then(Value::as_bool).unwrap_or(false);
            if old {
                older += 1;
            } else {
                newer += 1;
            }
            let label = match test_mark(s("cwd"), s("folder"), s("perm")) {
                Some(m) => (m.rule, m.skip, old),
                None => ("(not a test)".to_string(), false, old),
            };
            *by.entry(label).or_default() += 1;
        }
        println!("sessions {} (older {older}, newer {newer})", rows.len());
        for ((rule, skip, old), n) in by {
            let what = if skip { "skip" } else { "read" };
            let when = if old { "older" } else { "newer" };
            println!("{n:>5}  {what}  {when}  {rule}");
        }
    }

    /// A source admitted before item 900 has no working folder in the
    /// state: the next sync reads its head once, and the marks follow.
    #[test]
    fn a_source_admitted_before_900_is_probed_once_for_its_folder() {
        let base = scratch("probe900");
        let (config, claude) = (base.join("config"), base.join("claude"));
        let id = "00000000-0000-0000-0000-000000000900";
        let log = put(
            &claude,
            "-tmp-probe",
            id,
            &cli_log("claude-desktop", "/private/tmp/probe", "PROBEWORD", "x"),
        );
        sync(&config, &claude).unwrap();
        assert!(test_marks(&config).get(id).is_some_and(|m| m.skip));
        // Forget the folder as a pre-900 state would.
        let mut state = load_state(&config);
        let key = log.to_string_lossy().into_owned();
        let src = state.sources.get_mut(&key).unwrap();
        (src.cwd, src.perm, src.probed) = (None, None, false);
        save_state(&config, &state).unwrap();
        fs::remove_file(root(&config).join(TESTS_FILE)).unwrap();
        let out = sync(&config, &claude).unwrap();
        assert_eq!(out.tests, 1, "{out:?}");
        let state = load_state(&config);
        let src = &state.sources[&key];
        assert_eq!(src.cwd.as_deref(), Some("/private/tmp/probe"));
        assert!(src.probed);
    }

    #[tokio::test]
    async fn search_chats_finds_an_outside_session_labelled_by_its_source() {
        let root = scratch("search");
        let (config, claude) = (root.join("config"), root.join("claude"));
        fs::create_dir_all(config.join(crate::capture::UNFILED).join(SESSIONS_DIR)).unwrap();
        let id = "bbbbbbbb-0000-0000-0000-000000000001";
        put(
            &claude,
            "-Users-me-code-app",
            id,
            &cli_log(
                "claude-desktop",
                "/Users/me/code/app",
                "Why does the lanternfish roll stall?",
                "x",
            ),
        );
        put(
            &claude,
            "-tmp-n",
            "bbbbbbbb-0000-0000-0000-000000000002",
            &cli_log("sdk-cli", "/tmp/n", "zebrafish incognito words", "x"),
        );
        sync(&config, &claude).unwrap();
        let tools = crate::mcp_server::tools_in(&config, None, false).unwrap();
        let search = tools
            .iter()
            .find(|t| t.def().name == "search_chats")
            .unwrap();
        let read = tools.iter().find(|t| t.def().name == "read_chat").unwrap();
        let cancel = nightloom_core::tool::CancellationToken::new();
        let hit = search
            .call(
                serde_json::json!({"query": "lanternfish roll", "scope": "all"}),
                &cancel,
            )
            .await
            .unwrap();
        assert!(hit.contains(&format!("[{OUTSIDE_NAME}]")), "{hit}");
        assert!(
            hit.contains("Roll watcher · Claude Code desktop app, code/app"),
            "{hit}"
        );
        assert!(
            hit.contains("Claude Code sessions outside Nightloom"),
            "{hit}"
        );
        let body = read
            .call(serde_json::json!({"session": &id[..8]}), &cancel)
            .await
            .unwrap();
        assert!(
            body.contains("Why does the lanternfish roll stall?"),
            "{body}"
        );
        let miss = search
            .call(
                serde_json::json!({"query": "zebrafish", "scope": "all"}),
                &cancel,
            )
            .await
            .unwrap();
        assert!(!miss.contains("zebrafish incognito words"), "{miss}");
        assert!(miss.starts_with("no chats"), "{miss}");
    }

    /// Measured on his machine, never in CI: the real `~/.claude` read
    /// (read-only) into a scratch config. `cargo test --release -p
    /// nightloom-service mirror_timings -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn mirror_timings_over_the_real_corpus() {
        let Some(claude) = crate::usage::claude_dir() else {
            return;
        };
        let config = scratch("real");
        let t = std::time::Instant::now();
        let first = sync(&config, &claude).unwrap();
        let cold = t.elapsed();
        let t = std::time::Instant::now();
        let warm = sync(&config, &claude).unwrap();
        let warm_t = t.elapsed();
        let dir = sessions_dir(&config);
        let (n, bytes) = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter_map(|e| e.metadata().ok())
            .fold((0usize, 0u64), |(n, b), m| (n + 1, b + m.len()));
        let t = std::time::Instant::now();
        let index = crate::store::index::ChatIndex::load_or_build(&dir).unwrap();
        let index_cold = t.elapsed();
        let t = std::time::Instant::now();
        let _ = crate::store::index::ChatIndex::load_or_build(&dir).unwrap();
        let index_warm = t.elapsed();
        let index_bytes = fs::metadata(dir.join(".index.json"))
            .map(|m| m.len())
            .unwrap_or(0);
        let t = std::time::Instant::now();
        let mem = crate::claude_memory::sync(&config, &claude).unwrap();
        let mem_cold = t.elapsed();
        let t = std::time::Instant::now();
        let _ = crate::claude_memory::sync(&config, &claude).unwrap();
        let mem_warm = t.elapsed();
        println!(
            "sources {} mirrored {} messages {} excluded {:?}; cold {:?}, warm {:?} ({} messages); \
             mirror {} logs {:.1} MB; index cold {:?} warm {:?} {:.1} MB ({} admitted); \
             memory folders {} files {} cold {:?} warm {:?}",
            first.sources,
            first.mirrored,
            first.messages,
            first.excluded,
            cold,
            warm_t,
            warm.messages,
            n,
            bytes as f64 / 1e6,
            index_cold,
            index_warm,
            index_bytes as f64 / 1e6,
            index.len(),
            mem.folders,
            mem.changed,
            mem_cold,
            mem_warm,
        );
        let _ = fs::remove_dir_all(&config);
    }

    /// One real log, by `NL_OUTSIDE_ONE=<path>`: what the mirror makes of it.
    #[test]
    #[ignore]
    fn mirror_one_real_log() {
        let Ok(one) = std::env::var("NL_OUTSIDE_ONE") else {
            return;
        };
        let root = scratch("one");
        let folder = root.join("claude").join("projects").join("x");
        fs::create_dir_all(&folder).unwrap();
        let src = Path::new(&one);
        fs::copy(src, folder.join(src.file_name().unwrap())).unwrap();
        let out = sync(&root.join("config"), &root.join("claude")).unwrap();
        println!("{out:?}");
        let state = fs::read_to_string(state_path(&root.join("config"))).unwrap();
        println!("{}", &state[..state.len().min(600)]);
    }
}
