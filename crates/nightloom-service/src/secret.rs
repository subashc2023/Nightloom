//! The secret-request card (nightshift item 766, 2026-11-17): a chat that
//! needs a token, a password or a key calls `request_secret`; a card asks
//! him for it; the value he types goes to a file only he can read, removed
//! within a day, and **never** into the transcript, the chat's log, the
//! CLI's own session file, an app log or `search_chats`.
//!
//! The ways a value could be kept, and what stops each (the 766 report has
//! the trace, with the test that checks it):
//!
//! - **The call and its answer.** The tool's input is a name and a reason,
//!   never a value; the value travels only from the card to [`Store::put`]
//!   (the desktop's `store_secret` command, the phone's `POST /api/secret`),
//!   and the approval that follows is a bare *Allow* — so `decision.json`,
//!   the waiting file and the log's `tool_use` hold the name alone.
//! - **The tool's result.** [`RequestSecret`] answers with the file's path
//!   and how to read it inside a command (`"$(cat '<path>')"`); it never
//!   opens the file.
//! - **Anything that echoes it later** (a command that prints it, the model
//!   repeating it): [`Scrub`] replaces it with `[secret NAME]` in every raw
//!   line the CLI prints before the window or the phone sees it, in every
//!   block the recorder writes to the chat's log, and — at the turn's end —
//!   in the CLI's own session file and its helpers' files
//!   ([`scrub_cli_files`]).
//! - **Panics and app logs.** [`Secret`]'s `Debug` prints the name only, and
//!   nothing on its road logs.
//! - **Drafts.** The card's field is the card's own state: never a draft,
//!   never localStorage, emptied on submit and on unmount.
//!
//! What is *not* stopped, said plainly: the model reads whatever a command
//! prints in its own context (that is how a tool result works), and the
//! CLI's background-command output files under its temp folder are the
//! CLI's and are not rewritten.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use nightloom_core::ToolDef;
use nightloom_core::tool::{CancellationToken, Effect, Tool};
use serde_json::{Value, json};

/// The tool's name: `mcp__nightloom__request_secret` on the CLI.
pub const TOOL_NAME: &str = "request_secret";

/// Its gate's `PreToolUse` matcher: the tool alone, by its CLI name. Kept
/// out of the Ask hook's `mcp__` alternative for the reason `add_folder`
/// is (`ask::MATCHER`): two hooks on one call race for its decision file.
pub const GATE_MATCHER: &str = "mcp__nightloom__request_secret";

/// The note the shell leaves in the chat's directory once his value is
/// stored: `{"<NAME>": "<path>"}` — paths, never values.
pub const STORED_FILE: &str = "secrets-stored.json";

/// How long a stored value lives.
pub const LIFETIME: Duration = Duration::from_secs(24 * 60 * 60);

/// The shortest value [`Scrub`] replaces: shorter strings are too likely to
/// be ordinary text ("ok", "1234" in a date), and rewriting those would
/// garble the record more than it protects.
pub const SCRUB_MIN: usize = 6;

/// The longest name.
const NAME_MAX: usize = 64;

/// The longest value the card takes (a private key fits; a file does not).
pub const VALUE_MAX: usize = 16 * 1024;

/// What a subagent reads: no card can wait at that depth.
pub const SUBAGENT_REFUSED: &str = "Not run: only the main chat can ask the user for a secret — no card can wait on a helper. Say in your report which secret you need and why.";

/// What a side process (an aside, a checkpoint fork) reads.
pub const SIDE_REFUSED: &str =
    "Not run: a secret can be asked for only from the chat itself, where the user can answer.";

/// What the model reads when he declined, or pressed Allow on an empty
/// field.
pub const DECLINED: &str = "The user did not enter it. Do not ask again in this reply unless they say to; carry on without it or say what you could not do.";

/// The name the model asked for, checked: letters, digits and `_`, a
/// letter first, at most 64 — the shape of an environment variable, so it
/// can be used as one. Lowercase is raised. The `Err` is what the model
/// reads.
pub fn requested_name(input: &Value) -> Result<String, String> {
    let raw = input
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            "request_secret needs `name`: what to call it, like GITHUB_TOKEN.".to_string()
        })?;
    let name = raw.to_ascii_uppercase();
    let ok = name.len() <= NAME_MAX
        && name.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    if !ok {
        return Err(format!(
            "Not asked: {raw:?} is not a usable name. Use letters, digits and _ , starting with a letter (like GITHUB_TOKEN), at most {NAME_MAX}."
        ));
    }
    Ok(name)
}

/// The model's one line for the card.
pub fn requested_why(input: &Value) -> Option<String> {
    input
        .get("why")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// A value he typed. `Debug` names it and never shows it, so a panic
/// message or a `{:?}` cannot carry it.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret {
    pub name: String,
    value: String,
}

impl Secret {
    pub fn value(&self) -> &str {
        &self.value
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Secret({}, hidden)", self.name)
    }
}

/// A chat id as a folder name: anything but letters, digits, `-` and `_`
/// becomes `_`, so no id can climb out of the store.
fn chat_folder(chat: &str) -> String {
    let s: String = chat
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if s.is_empty() { "_".into() } else { s }
}

/// Where values live: one folder per chat, one file per name, the folders
/// `0700` and the files `0600`. The default root is the user's own temp
/// folder (`$TMPDIR` on macOS, itself private to him), outside every log
/// folder, every project, iCloud and search.
#[derive(Debug, Clone)]
pub struct Store {
    root: PathBuf,
}

impl Default for Store {
    fn default() -> Self {
        Self::at(std::env::temp_dir().join("nightloom-secrets"))
    }
}

impl Store {
    pub fn at(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// The file `name` is kept in for `chat` (whether or not it exists).
    pub fn path(&self, chat: &str, name: &str) -> PathBuf {
        self.root.join(chat_folder(chat)).join(name)
    }

    /// Keep his value. Refuses an empty or oversized value and a bad name;
    /// clears values past their day first. Says nothing of the value in any
    /// error.
    pub fn put(&self, chat: &str, name: &str, value: &str) -> Result<PathBuf, String> {
        let name = requested_name(&json!({ "name": name }))?;
        if value.is_empty() {
            return Err("nothing was entered".into());
        }
        if value.len() > VALUE_MAX {
            return Err(format!("too long (over {} KB)", VALUE_MAX / 1024));
        }
        self.sweep(LIFETIME);
        let dir = self.root.join(chat_folder(chat));
        private_dir(&self.root).map_err(|e| format!("could not make the secrets folder: {e}"))?;
        private_dir(&dir).map_err(|e| format!("could not make the secrets folder: {e}"))?;
        let path = dir.join(&name);
        let tmp = dir.join(format!(".{name}.{}", uuid::Uuid::new_v4()));
        write_private(&tmp, value.as_bytes())
            .and_then(|_| std::fs::rename(&tmp, &path))
            .map_err(|e| {
                let _ = std::fs::remove_file(&tmp);
                format!("could not keep it: {e}")
            })?;
        Ok(path)
    }

    /// One stored value, if it is there and not past its day.
    pub fn get(&self, chat: &str, name: &str) -> Option<Secret> {
        let path = self.path(chat, name);
        if expired(&path, LIFETIME) {
            let _ = std::fs::remove_file(&path);
            return None;
        }
        let value = std::fs::read_to_string(&path).ok()?;
        (!value.is_empty()).then(|| Secret {
            name: name.to_string(),
            value,
        })
    }

    /// Every value stored for `chat`, for the scrub.
    pub fn all(&self, chat: &str) -> Vec<Secret> {
        let dir = self.root.join(chat_folder(chat));
        let Ok(entries) = std::fs::read_dir(&dir) else {
            return Vec::new();
        };
        let mut out: Vec<Secret> = entries
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') {
                    return None;
                }
                self.get(chat, &name)
            })
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    /// Remove every value older than `age`, and the chat folders left
    /// empty. Best-effort: called at launch, before a turn, on every put.
    pub fn sweep(&self, age: Duration) {
        let Ok(chats) = std::fs::read_dir(&self.root) else {
            return;
        };
        for chat in chats.flatten() {
            let dir = chat.path();
            if !dir.is_dir() {
                continue;
            }
            if let Ok(files) = std::fs::read_dir(&dir) {
                for f in files.flatten() {
                    if expired(&f.path(), age) {
                        let _ = std::fs::remove_file(f.path());
                    }
                }
            }
            let _ = std::fs::remove_dir(&dir);
        }
    }

    /// Forget every value of `chat` now (the chat deleted, or his word).
    pub fn forget_chat(&self, chat: &str) {
        let _ = std::fs::remove_dir_all(self.root.join(chat_folder(chat)));
    }
}

fn expired(path: &Path, age: Duration) -> bool {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|d| d >= age)
}

fn private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write as _;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}

// ---- the shell's note, for the tool ---------------------------------------

fn read_stored(chat_dir: &Path) -> serde_json::Map<String, Value> {
    std::fs::read(chat_dir.join(STORED_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| match v {
            Value::Object(m) => Some(m),
            _ => None,
        })
        .unwrap_or_default()
}

/// The shell's note, once his value for `name` is kept at `path`.
pub fn note_stored(chat_dir: &Path, name: &str, path: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(chat_dir)?;
    let mut map = read_stored(chat_dir);
    map.insert(name.to_string(), json!(path.to_string_lossy()));
    let tmp = chat_dir.join(format!("{STORED_FILE}.tmp"));
    std::fs::write(&tmp, serde_json::to_vec(&Value::Object(map))?)?;
    std::fs::rename(tmp, chat_dir.join(STORED_FILE))
}

/// Where the shell noted `name` was kept, if it did and the file is there.
pub fn stored_path(chat_dir: &Path, name: &str) -> Option<PathBuf> {
    read_stored(chat_dir)
        .get(name)
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .filter(|p| p.is_file())
}

// ---- the scrub --------------------------------------------------------------

/// The values to keep out of every record, shared by the turn's agent (raw
/// lines), its recorder (the log) and the turn's end (the CLI's files). A
/// clone is the same list.
#[derive(Clone, Default)]
pub struct Scrub {
    inner: Arc<Mutex<Vec<Secret>>>,
}

impl std::fmt::Debug for Scrub {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Scrub({} values)", self.len())
    }
}

impl Scrub {
    /// Add a value — and, when he pasted it with spaces or a line break
    /// around it, the value without them too: a program that trims it
    /// (a header, a URL) would otherwise print a form the scrub never
    /// matches (merge round T review, 2026-11-17).
    pub fn add(&self, secret: Secret) {
        let trimmed = secret.value.trim();
        if trimmed != secret.value {
            self.add_one(Secret {
                name: secret.name.clone(),
                value: trimmed.to_string(),
            });
        }
        self.add_one(secret);
    }

    fn add_one(&self, secret: Secret) {
        if secret.value.chars().count() < SCRUB_MIN {
            return;
        }
        if let Ok(mut v) = self.inner.lock()
            && !v.iter().any(|s| s.value == secret.value)
        {
            v.push(secret);
            // Longest first, so a value that contains another is replaced whole.
            v.sort_by_key(|s| std::cmp::Reverse(s.value.len()));
        }
    }

    pub fn len(&self) -> usize {
        self.inner.lock().map(|v| v.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn each(&self, mut f: impl FnMut(&Secret)) {
        if let Ok(v) = self.inner.lock() {
            for s in v.iter() {
                f(s);
            }
        }
    }

    /// Plain text with every value replaced by `[secret NAME]`.
    pub fn text(&self, text: &str) -> String {
        let mut out = text.to_string();
        self.each(|s| {
            if out.contains(&s.value) {
                out = out.replace(&s.value, &mark(&s.name));
            }
        });
        out
    }

    /// One line of JSON (the CLI's stream, its session file): the value as
    /// JSON writes it inside a string, and raw, both replaced. The mark has
    /// nothing JSON escapes, so the line stays valid.
    pub fn json_line(&self, line: &str) -> String {
        let mut out = line.to_string();
        self.each(|s| {
            let escaped = json_inner(&s.value);
            if out.contains(&escaped) {
                out = out.replace(&escaped, &mark(&s.name));
            }
            if escaped != s.value && out.contains(&s.value) {
                out = out.replace(&s.value, &mark(&s.name));
            }
        });
        out
    }

    /// A JSON value, every string in it scrubbed.
    pub fn value(&self, v: &Value) -> Value {
        match v {
            Value::String(s) => Value::String(self.text(s)),
            Value::Array(a) => Value::Array(a.iter().map(|x| self.value(x)).collect()),
            Value::Object(m) => Value::Object(
                m.iter()
                    .map(|(k, x)| (self.text(k), self.value(x)))
                    .collect(),
            ),
            other => other.clone(),
        }
    }

    /// One block of the log, scrubbed.
    pub fn block(&self, block: nightloom_core::ContentBlock) -> nightloom_core::ContentBlock {
        use nightloom_core::ContentBlock as B;
        if self.is_empty() {
            return block;
        }
        match block {
            B::Text { text } => B::Text {
                text: self.text(&text),
            },
            B::Thinking { text, signature } => B::Thinking {
                text: self.text(&text),
                signature,
            },
            B::ToolUse {
                id,
                name,
                input,
                signature,
            } => B::ToolUse {
                id,
                name,
                input: self.value(&input),
                signature,
            },
            B::ToolResult {
                tool_use_id,
                name,
                content,
                is_error,
            } => B::ToolResult {
                tool_use_id,
                name,
                content: self.text(&content),
                is_error,
            },
            other => other,
        }
    }
}

impl Scrub {
    /// The longest end of `text` that is the start of a value (and not the
    /// whole value), in bytes — what a live view must hold back until the
    /// next delta says whether the value follows.
    fn held_suffix(&self, text: &str) -> usize {
        let mut best = 0;
        self.each(|s| {
            for k in (1..s.value.len()).rev() {
                if k <= best {
                    break;
                }
                if s.value.is_char_boundary(k) && text.ends_with(&s.value[..k]) {
                    best = k;
                    break;
                }
            }
        });
        best
    }
}

/// The live view's side of the scrub (item 766): text and thinking deltas
/// pass through with every value replaced, even a value the stream split
/// across two deltas — the end of a delta that could be a value's start is
/// held until the next one. Any other event, and a change between prose
/// and thinking, lets the held text go first; [`finish`](Self::finish)
/// lets go of what is held when the stream ends. The log does not need
/// this (the recorder scrubs whole blocks); the window, the phone and an
/// aside's card do.
///
/// Thinking is held as prose is (merge round T review, 2026-11-17): the
/// CLI streams it in pieces too, and a value the model repeats while
/// thinking reached the window whole when it fell across two of them.
pub struct DeltaHold {
    scrub: Scrub,
    pending: String,
    /// Whether `pending` is thinking (else prose).
    thinking: bool,
}

impl DeltaHold {
    pub fn new(scrub: Scrub) -> Self {
        Self {
            scrub,
            pending: String::new(),
            thinking: false,
        }
    }

    fn delta(thinking: bool, text: String) -> crate::turn::TurnEvent {
        use crate::turn::TurnEvent;
        if thinking {
            TurnEvent::ThinkingDelta { text }
        } else {
            TurnEvent::TextDelta { text }
        }
    }

    /// What to show for `event`, in order.
    pub fn pass(&mut self, event: &crate::turn::TurnEvent) -> Vec<crate::turn::TurnEvent> {
        use crate::turn::TurnEvent;
        let (text, thinking) = match event {
            TurnEvent::TextDelta { text } => (text, false),
            TurnEvent::ThinkingDelta { text } => (text, true),
            other => {
                let mut out = self.finish();
                out.push(other.clone());
                return out;
            }
        };
        let mut out = Vec::with_capacity(2);
        if thinking != self.thinking {
            out.extend(self.finish());
            self.thinking = thinking;
        }
        self.pending.push_str(text);
        let clean = self.scrub.text(&self.pending);
        let keep = self.scrub.held_suffix(&clean);
        let cut = clean.len() - keep;
        self.pending = clean[cut..].to_string();
        if cut > 0 {
            out.push(Self::delta(thinking, clean[..cut].to_string()));
        }
        out
    }

    /// What is still held, let go: the stream has ended (or another kind
    /// of event follows), so no value can complete it.
    pub fn finish(&mut self) -> Vec<crate::turn::TurnEvent> {
        if self.pending.is_empty() {
            return Vec::new();
        }
        vec![Self::delta(
            self.thinking,
            std::mem::take(&mut self.pending),
        )]
    }
}

fn mark(name: &str) -> String {
    format!("[secret {name}]")
}

fn json_inner(value: &str) -> String {
    let quoted = serde_json::to_string(value).unwrap_or_default();
    quoted
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .unwrap_or(&quoted)
        .to_string()
}

/// Rewrite one file with every value replaced, line by line, through a
/// temporary file renamed over it — only when a value is in it. Returns
/// whether it changed.
pub fn scrub_file(scrub: &Scrub, path: &Path) -> std::io::Result<bool> {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
    };
    let clean = scrub.json_line(&text);
    if clean == text {
        return Ok(false);
    }
    // The rewritten file keeps the mode it had (merge round T review,
    // 2026-11-17): the CLI writes its session files 0600, and a plain
    // write here left the whole transcript readable by every account on
    // the Mac. Made 0600 first, so it is never wider on the way.
    let perms = std::fs::metadata(path)?.permissions();
    let tmp = path.with_extension(format!("scrub-{}", uuid::Uuid::new_v4()));
    let written = write_private(&tmp, clean.as_bytes())
        .and_then(|_| std::fs::set_permissions(&tmp, perms))
        .and_then(|_| std::fs::rename(&tmp, path));
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(true)
}

/// The CLI's own record of a session: `<projects>/<cwd folder>/<id>.jsonl`
/// and everything under `<id>/` (its helpers' transcripts, saved tool
/// results). Scrubbed at the turn's end, after its last process exited.
/// Returns how many files changed.
pub fn scrub_cli_files(scrub: &Scrub, session_file: &Path) -> usize {
    if scrub.is_empty() {
        return 0;
    }
    let mut changed = 0;
    if scrub_file(scrub, session_file).unwrap_or(false) {
        changed += 1;
    }
    let dir = session_file.with_extension("");
    let mut stack = vec![dir];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if scrub_file(scrub, &p).unwrap_or(false) {
                changed += 1;
            }
        }
    }
    changed
}

/// [`scrub_cli_files`] for the session `id` the CLI keeps for `workspace`,
/// found as the turn finds it. `0` when there is nothing to scrub or no
/// such file.
pub fn scrub_cli_session(scrub: &Scrub, workspace: &Path, id: &str) -> usize {
    match crate::agent::cli_session::projects_dir() {
        Some(projects) => scrub_cli_session_in(scrub, &projects, workspace, id),
        None => 0,
    }
}

/// [`scrub_cli_session`] under a named projects folder.
pub fn scrub_cli_session_in(scrub: &Scrub, projects: &Path, workspace: &Path, id: &str) -> usize {
    if scrub.is_empty() {
        return 0;
    }
    match crate::agent::cli_session::find(projects, workspace, id) {
        Ok(file) => scrub_cli_files(scrub, &file),
        Err(_) => 0,
    }
}

/// Sweep `store` of values older than `age`, every `every`, for as long as
/// the app runs (merge round T review, 2026-11-17): the sweeps at launch,
/// before a turn and on a put never ran in an app left open and idle, so a
/// value outlived its day until the next message. The thread sleeps
/// between sweeps and ends with the process.
pub fn keep_swept(store: Store, age: Duration, every: Duration) {
    let _ = std::thread::Builder::new()
        .name("secret-sweep".into())
        .spawn(move || {
            loop {
                std::thread::sleep(every);
                store.sweep(age);
            }
        });
}

// ---- the tool ---------------------------------------------------------------

/// The sentence `initialize` adds when the tool is served.
pub const INSTRUCTION: &str = " When a task needs a token, password, API key or other secret \
     the user has not given you, call request_secret (ToolSearch mcp__nightloom__request_secret) \
     instead of asking them to paste it into the chat; it asks them on a card and gives you a \
     file path to read it from inside a command. Never print or repeat a secret.";

/// `request_secret`, served beside `add_folder` (the chat's directory
/// named). It asks nothing itself: the card does, and the shell notes the
/// stored path for it ([`note_stored`]).
pub struct RequestSecret {
    chat_dir: PathBuf,
}

impl RequestSecret {
    pub fn new(chat_dir: impl Into<PathBuf>) -> Self {
        Self {
            chat_dir: chat_dir.into(),
        }
    }
}

/// What the model reads once his value is kept at `path`.
pub fn stored_reply(name: &str, path: &Path) -> String {
    let p = path.display();
    format!(
        "Stored: the user entered {name} on the card. It is in a file only they can read, removed within a day: {p}\n\
         Use it only inside a command, read from that file as the command runs — for example `{name}=\"$(cat '{p}')\" some-command` or `some-command --token \"$(cat '{p}')\"`.\n\
         Never print, echo or cat it on its own, never write it into a project file, a message or another tool's input, and never show it to the user. Anything that shows it is replaced by [secret {name}] in this chat's record."
    )
}

#[async_trait::async_trait]
impl Tool for RequestSecret {
    fn effect(&self) -> Effect {
        // It brings a secret into the chat: the card asks first.
        Effect::Mutating
    }

    fn def(&self) -> ToolDef {
        ToolDef {
            name: TOOL_NAME.into(),
            description: "Ask the user for a secret — a token, password, API key — that a \
                 command needs. They type it on a card in Nightloom, never in the chat; you get \
                 back a file path to read it from inside a command (\"$(cat '<path>')\"), never \
                 the value. Call it instead of asking them to paste a secret. `name` is what to \
                 call it, like GITHUB_TOKEN; `why` is one line for the card: what it is for and \
                 where they find it. The main chat only, never a subagent."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "What to call it: letters, digits and _, like GITHUB_TOKEN."
                    },
                    "why": {
                        "type": "string",
                        "description": "One line for the card: what it is for, and where the user finds it."
                    }
                },
                "required": ["name"]
            }),
        }
    }

    async fn call(&self, input: Value, _cancel: &CancellationToken) -> Result<String, String> {
        let name = requested_name(&input)?;
        match stored_path(&self.chat_dir, &name) {
            Some(path) => Ok(stored_reply(&name, &path)),
            None => Err(format!(
                "Not stored: {name} did not reach this call — the user's answer on the card did not arrive. {DECLINED}"
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "nl-766-{name}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_name_is_shaped_like_an_environment_variable() {
        assert_eq!(
            requested_name(&json!({"name": "github_token"})).unwrap(),
            "GITHUB_TOKEN"
        );
        for bad in ["", "1PASS", "A B", "../X", "A-B", &"A".repeat(65)] {
            assert!(requested_name(&json!({ "name": bad })).is_err(), "{bad}");
        }
        assert!(requested_name(&json!({})).is_err());
    }

    #[test]
    fn a_value_is_kept_private_and_gone_after_its_day() {
        let store = Store::at(temp("store"));
        let path = store
            .put("chat/../1", "TOKEN", "fake-secret-value-766")
            .unwrap();
        assert!(path.starts_with(store.root()), "{}", path.display());
        assert_eq!(path.parent().unwrap().file_name().unwrap(), "chat____1");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
            let dir = std::fs::metadata(path.parent().unwrap()).unwrap();
            assert_eq!(dir.permissions().mode() & 0o777, 0o700);
        }
        assert_eq!(
            store.get("chat/../1", "TOKEN").unwrap().value(),
            "fake-secret-value-766"
        );
        assert_eq!(store.all("chat/../1").len(), 1);
        // A sweep at age zero is "past its day" for everything.
        store.sweep(Duration::ZERO);
        assert!(store.get("chat/../1", "TOKEN").is_none());
        assert!(!path.parent().unwrap().exists());
        assert!(store.put("c", "T", "").is_err());
    }

    #[test]
    fn debug_never_shows_the_value() {
        let store = Store::at(temp("debug"));
        store.put("c", "TOKEN", "fake-secret-value-766").unwrap();
        let s = store.get("c", "TOKEN").unwrap();
        let shown = format!("{s:?}");
        assert!(!shown.contains("fake-secret"), "{shown}");
        let scrub = Scrub::default();
        scrub.add(s);
        assert!(!format!("{scrub:?}").contains("fake-secret"));
    }

    #[test]
    fn the_scrub_replaces_raw_and_json_escaped_values_and_keeps_json_valid() {
        let store = Store::at(temp("scrub"));
        store.put("c", "PASS", "p\"a\\ss-wörd-766").unwrap();
        let scrub = Scrub::default();
        scrub.add(store.get("c", "PASS").unwrap());
        let line =
            serde_json::to_string(&json!({"content": "got p\"a\\ss-wörd-766 back"})).unwrap();
        let clean = scrub.json_line(&line);
        let v: Value = serde_json::from_str(&clean).unwrap();
        assert_eq!(v["content"], "got [secret PASS] back");
        assert_eq!(scrub.text("x p\"a\\ss-wörd-766 y"), "x [secret PASS] y");
        // Too short to scrub without garbling ordinary text.
        let short = Scrub::default();
        short.add(Secret {
            name: "PIN".into(),
            value: "1234".into(),
        });
        assert!(short.is_empty());
    }

    #[test]
    fn a_value_split_across_deltas_never_shows_live() {
        use crate::turn::TurnEvent;
        let scrub = Scrub::default();
        scrub.add(Secret {
            name: "TOKEN".into(),
            value: "ghp_fake766value".into(),
        });
        let mut hold = DeltaHold::new(scrub);
        let mut shown = String::new();
        for e in [
            TurnEvent::TextDelta {
                text: "the token is ghp_fa".into(),
            },
            TurnEvent::TextDelta {
                text: "ke766val".into(),
            },
            TurnEvent::TextDelta {
                text: "ue, and ghp".into(),
            },
            TurnEvent::ToolCall {
                id: "t".into(),
                name: "Bash".into(),
                input: json!({}),
            },
        ] {
            for out in hold.pass(&e) {
                if let TurnEvent::TextDelta { text } = out {
                    shown.push_str(&text);
                }
            }
        }
        assert_eq!(shown, "the token is [secret TOKEN], and ghp");
    }

    #[test]
    fn the_cli_files_are_rewritten_only_where_a_value_is() {
        let root = temp("cli");
        let file = root.join("s-1.jsonl");
        let line = |t: &str| serde_json::to_string(&json!({"type":"user","content": t})).unwrap();
        std::fs::write(
            &file,
            format!("{}\n{}\n", line("ran: ghp_fake766value"), line("ok")),
        )
        .unwrap();
        let sub = root.join("s-1").join("subagents");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("agent-1.jsonl"), line("ghp_fake766value")).unwrap();
        std::fs::write(sub.join("agent-2.jsonl"), line("nothing here")).unwrap();
        let scrub = Scrub::default();
        scrub.add(Secret {
            name: "TOKEN".into(),
            value: "ghp_fake766value".into(),
        });
        assert_eq!(scrub_cli_files(&scrub, &file), 2);
        let after = std::fs::read_to_string(&file).unwrap();
        assert!(!after.contains("ghp_fake766value"));
        for l in after.lines() {
            serde_json::from_str::<Value>(l).unwrap();
        }
        assert!(after.contains("[secret TOKEN]"));
        assert_eq!(scrub_cli_files(&scrub, &file), 0);
    }

    // ---- merge round T review, 2026-11-17 ----

    #[test]
    fn a_value_split_across_thinking_deltas_never_shows_live_and_the_tail_is_let_go() {
        use crate::turn::TurnEvent;
        let scrub = Scrub::default();
        scrub.add(Secret {
            name: "TOKEN".into(),
            value: "ghp_fake766value".into(),
        });
        let mut hold = DeltaHold::new(scrub);
        let (mut thought, mut said) = (String::new(), String::new());
        let mut take = |events: Vec<TurnEvent>| {
            for e in events {
                match e {
                    TurnEvent::ThinkingDelta { text } => thought.push_str(&text),
                    TurnEvent::TextDelta { text } => said.push_str(&text),
                    _ => {}
                }
            }
        };
        for e in [
            TurnEvent::ThinkingDelta {
                text: "the file holds ghp_fake".into(),
            },
            TurnEvent::ThinkingDelta {
                text: "766value, so use it; ghp_".into(),
            },
            // Prose after thinking: the held end of the thought goes first,
            // as thinking, never glued onto the prose.
            TurnEvent::TextDelta {
                text: "Done. It starts ghp_fa".into(),
            },
        ] {
            take(hold.pass(&e));
        }
        // The stream ends on a held start: `finish` shows it.
        take(hold.finish());
        assert!(hold.finish().is_empty());
        assert_eq!(thought, "the file holds [secret TOKEN], so use it; ghp_");
        assert_eq!(said, "Done. It starts ghp_fa");
    }

    #[test]
    fn a_value_pasted_with_spaces_around_it_is_scrubbed_trimmed_too() {
        let scrub = Scrub::default();
        scrub.add(Secret {
            name: "TOKEN".into(),
            value: " ghp_fake766value\n".into(),
        });
        // What a program that trims it prints.
        assert_eq!(
            scrub.text("Authorization: Bearer ghp_fake766value\r\n"),
            "Authorization: Bearer [secret TOKEN]\r\n"
        );
        // And the value as typed, whole.
        assert_eq!(scrub.text("[ ghp_fake766value\n]"), "[[secret TOKEN]]");
        let line = serde_json::to_string(&json!({"c": "x ghp_fake766value y"})).unwrap();
        assert!(!scrub.json_line(&line).contains("ghp_fake766value"));
    }

    #[cfg(unix)]
    #[test]
    fn a_scrubbed_file_keeps_the_mode_it_had() {
        use std::os::unix::fs::PermissionsExt as _;
        let root = temp("mode");
        let file = root.join("s-1.jsonl");
        std::fs::write(&file, "{\"content\":\"ran: ghp_fake766value\"}\n").unwrap();
        // As the CLI writes its session files: his alone.
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).unwrap();
        let scrub = Scrub::default();
        scrub.add(Secret {
            name: "TOKEN".into(),
            value: "ghp_fake766value".into(),
        });
        assert!(scrub_file(&scrub, &file).unwrap());
        let mode = std::fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "{mode:o}");
        assert!(
            !std::fs::read_to_string(&file)
                .unwrap()
                .contains("ghp_fake766value")
        );
        // Nothing left beside it.
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
    }

    #[test]
    fn the_session_a_failed_turn_resumed_is_scrubbed_by_its_id() {
        let projects = temp("failed");
        let folder = projects.join("-Users-x-project");
        std::fs::create_dir_all(&folder).unwrap();
        let file = folder.join("s-9.jsonl");
        std::fs::write(&file, "{\"content\":\"token=ghp_fake766value\"}\n").unwrap();
        let scrub = Scrub::default();
        let cwd = Path::new("/Users/x/project");
        // Nothing known: nothing read, nothing changed.
        assert_eq!(scrub_cli_session_in(&scrub, &projects, cwd, "s-9"), 0);
        scrub.add(Secret {
            name: "TOKEN".into(),
            value: "ghp_fake766value".into(),
        });
        // No such session, or an id that is no id: nothing, no panic.
        assert_eq!(scrub_cli_session_in(&scrub, &projects, cwd, "s-none"), 0);
        assert_eq!(scrub_cli_session_in(&scrub, &projects, cwd, "../s-9"), 0);
        assert_eq!(scrub_cli_session_in(&scrub, &projects, cwd, "s-9"), 1);
        assert!(
            !std::fs::read_to_string(&file)
                .unwrap()
                .contains("ghp_fake766value")
        );
    }

    #[test]
    fn an_open_app_sweeps_without_a_turn() {
        let store = Store::at(temp("idle"));
        let path = store.put("c", "TOKEN", "fake-secret-value-766").unwrap();
        assert!(path.exists());
        // Age zero stands in for "past its day"; no turn, launch or put runs.
        keep_swept(store.clone(), Duration::ZERO, Duration::from_millis(20));
        let until = std::time::Instant::now() + Duration::from_secs(5);
        while path.exists() && std::time::Instant::now() < until {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(!path.exists(), "the sweeper removed it");
    }

    #[tokio::test]
    async fn the_tool_answers_with_the_path_and_never_the_value() {
        let chat_dir = temp("tool");
        let store = Store::at(temp("tool-store"));
        let tool = RequestSecret::new(&chat_dir);
        let cancel = CancellationToken::new();
        let e = tool
            .call(json!({"name": "GITHUB_TOKEN"}), &cancel)
            .await
            .unwrap_err();
        assert!(e.contains("Not stored"), "{e}");
        let path = store.put("c", "GITHUB_TOKEN", "ghp_fake766value").unwrap();
        note_stored(&chat_dir, "GITHUB_TOKEN", &path).unwrap();
        let ok = tool
            .call(json!({"name": "github_token"}), &cancel)
            .await
            .unwrap();
        assert!(ok.contains(&path.display().to_string()), "{ok}");
        assert!(!ok.contains("ghp_fake766value"), "{ok}");
        let note = std::fs::read_to_string(chat_dir.join(STORED_FILE)).unwrap();
        assert!(!note.contains("ghp_fake766value"));
    }
}

#[cfg(test)]
#[path = "secret_766_tests.rs"]
mod e2e_tests;
