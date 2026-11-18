//! "From Bitwarden" on the secret-request card (nightshift item 766 part 2,
//! 2026-11-17; his pick, blocker 2034: Bitwarden Free). He picks a vault
//! item and one of its fields on the card; Nightloom — never the model —
//! reads that one value through the `bw` CLI and writes it into the same
//! 0600 file a typed value goes to ([`crate::secret::Store`]), so every
//! scrub path of part 1 is unchanged.
//!
//! **The session.** `bw` opens the whole vault with a session key that
//! lives only in the shell that ran `bw unlock`; a session he unlocked in
//! Terminal is not visible to this app. So he unlocks it himself and pastes
//! the key `bw unlock --raw` prints onto the card once ([`Vault::use_session`]).
//! Nightloom keeps it **in memory only** — never a file, never a log, never
//! a command line (it reaches `bw` as `BW_SESSION` in the child's
//! environment) — and forgets it after [`IDLE`] without use, on *Forget*
//! in Settings, and at quit. Nightloom never runs `bw unlock` or `bw login`
//! and never sees his master password.
//!
//! **Once or always.** *Use once* writes the value for this card. *Always
//! for this command* also keeps a rule (secret name, item id, field,
//! command prefix — [`Rule`]) in `bitwarden-rules.json` in the config
//! directory: a later `request_secret` with the same name whose `command`
//! starts with that prefix is answered without a card while the session is
//! open; any other command, or a locked vault, asks again. Rules are listed
//! and removed in Settings → Subscription → Bitwarden.
//!
//! **What the model sees.** The card's item list goes to the window alone
//! (names, a host, field names — never a value); the tool's result is the
//! file's path, as for a typed value. ~~What is *not* enforced, said
//! plainly: the `command` is what the model declared; once the file
//! exists, any command of that chat can read it within its day~~ (struck
//! 2026-11-17, item 825): an answer by a rule only *holds* the value; the
//! hook releases it into the file just before a command that runs the
//! rule's words, and refuses every other call that names it
//! ([`crate::secret::release_gate`]). A wrapper prefix (a shell, `env`,
//! `sudo`, `xargs`, an interpreter alone — [`wrapper_refusal`]) cannot be
//! kept, and one saved before is dropped on load with a note.
//!
//! Never `bw serve` (it opens the whole vault to every local process, 2034
//! report §3), never `bw get` output in a tool result or an error.

use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The rules file, in the config directory (`~/.nightloom`).
pub const RULES_FILE: &str = "bitwarden-rules.json";

/// A held session is forgotten after this long without use (bw has no
/// idle lock of its own, 2034 report §3).
pub const IDLE: Duration = Duration::from_secs(30 * 60);

/// The longest a `bw` call may take (it is a Node program; a first run
/// after an update can be slow).
const BW_TIMEOUT: Duration = Duration::from_secs(30);

/// The most items one search lists.
pub const SEARCH_MAX: usize = 25;

/// Where `bw` is looked for after `PATH` (an app opened from the Dock has a
/// short `PATH`): Homebrew on Apple silicon and Intel.
const FALLBACK_DIRS: [&str; 2] = ["/opt/homebrew/bin", "/usr/local/bin"];

/// Whether the card can read from Bitwarden, and if not, why.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Ready {
    /// No `bw` on this computer.
    Missing,
    /// `bw` is there, signed in to no account.
    Unauthenticated,
    /// Signed in, and Nightloom holds no open session.
    Locked,
    /// Nightloom holds a session that `bw` says is open.
    Unlocked,
}

/// One vault item as the card lists it: never a value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ItemView {
    pub id: String,
    pub name: String,
    /// The first website's host, to tell two items of one name apart.
    pub host: Option<String>,
    /// The fields that hold something: `password`, `username`, `notes`, or
    /// `field:<name>` for a custom field.
    pub fields: Vec<String>,
}

/// "Always for this command": the next `request_secret` for `name` whose
/// command starts with `prefix` gets `field` of item `item_id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rule {
    pub id: String,
    /// The secret's name, as the model asks for it (GITHUB_TOKEN).
    pub name: String,
    pub item_id: String,
    /// The item's name when the rule was made, for the Settings list.
    pub item_name: String,
    pub field: String,
    /// The command's first words ([`command_prefix`]).
    pub prefix: String,
    /// When he made it (RFC 3339).
    pub added: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct RulesFile {
    #[serde(default)]
    rules: Vec<Rule>,
    /// Rules dropped on load because their prefix is a wrapper (item 825),
    /// kept until he presses OK in Settings.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    dropped: Vec<Dropped>,
}

/// An "always" rule dropped on load (item 825): its prefix is a wrapper
/// that runs any command, so it cannot be kept. Never a value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Dropped {
    pub name: String,
    pub item_name: String,
    pub prefix: String,
    /// Why, in one short line ([`wrapper_refusal`]).
    pub why: String,
    /// When it was dropped (RFC 3339).
    pub when: String,
}

/// A session key he pasted. `Debug` never shows it.
struct Held {
    key: String,
    used: Instant,
}

impl std::fmt::Debug for Held {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Held(hidden, used {:?} ago)", self.used.elapsed())
    }
}

/// The `bw` Nightloom drives and the session it holds. One per process
/// ([`Vault::global`]); a test makes its own with a stand-in `bw`.
#[derive(Debug)]
pub struct Vault {
    /// The `PATH` to look for `bw` in; `None` is the process's own.
    path_var: Option<String>,
    /// Extra environment for every `bw` call (tests only).
    env: Vec<(String, String)>,
    held: Mutex<Option<Held>>,
    idle: Duration,
}

impl Vault {
    pub fn new() -> Self {
        Self {
            path_var: None,
            env: Vec::new(),
            held: Mutex::new(None),
            idle: IDLE,
        }
    }

    /// A vault whose `bw` is found on `path_var` alone (no fallbacks), with
    /// `env` added to each call: a test's stand-in.
    pub fn on_path(path_var: impl Into<String>, env: Vec<(String, String)>) -> Self {
        Self {
            path_var: Some(path_var.into()),
            env,
            held: Mutex::new(None),
            idle: IDLE,
        }
    }

    /// Forget a session after `idle` without use (tests).
    pub fn with_idle(mut self, idle: Duration) -> Self {
        self.idle = idle;
        self
    }

    /// The process's one vault.
    pub fn global() -> Arc<Vault> {
        static V: OnceLock<Arc<Vault>> = OnceLock::new();
        V.get_or_init(|| Arc::new(Vault::new())).clone()
    }

    /// Where `bw` is, if anywhere.
    pub fn program(&self) -> Option<PathBuf> {
        match &self.path_var {
            Some(p) => find_in(p, &[]),
            None => find_in(&std::env::var("PATH").unwrap_or_default(), &FALLBACK_DIRS),
        }
    }

    /// The held key, if not idle past its time; a use renews it.
    fn key(&self) -> Option<String> {
        let mut held = self.held.lock().ok()?;
        match held.as_mut() {
            Some(h) if h.used.elapsed() < self.idle => {
                h.used = Instant::now();
                Some(h.key.clone())
            }
            Some(_) => {
                *held = None;
                None
            }
            None => None,
        }
    }

    /// Whether a session is held now (no `bw` call).
    pub fn holds_session(&self) -> bool {
        self.held
            .lock()
            .map(|h| h.as_ref().is_some_and(|h| h.used.elapsed() < self.idle))
            .unwrap_or(false)
    }

    /// Forget the held session (Settings' *Forget*, a session `bw` calls
    /// locked, an idle lapse).
    pub fn forget_session(&self) {
        if let Ok(mut h) = self.held.lock() {
            *h = None;
        }
    }

    /// Run `bw <args> --nointeraction` with the held session (or `key`) in
    /// its environment. `Err` is a plain sentence that never carries what
    /// `bw` printed on stdout.
    fn run(&self, args: &[&str], key: Option<&str>) -> Result<(i32, String, String), String> {
        let program = self
            .program()
            .ok_or_else(|| "Bitwarden's bw is not installed.".to_string())?;
        let mut cmd = Command::new(&program);
        cmd.args(args)
            .arg("--nointeraction")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_remove("BW_SESSION");
        // A Homebrew `bw` is a Node script: its folder (where `node` sits
        // beside it) goes first on the child's PATH.
        let mut path = program
            .parent()
            .map(|d| d.display().to_string())
            .unwrap_or_default();
        let base = self
            .path_var
            .clone()
            .unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());
        let mut dirs = vec![base.as_str()];
        if self.path_var.is_none() {
            dirs.extend(FALLBACK_DIRS);
        }
        for p in dirs {
            if !p.is_empty() {
                path.push(':');
                path.push_str(p);
            }
        }
        cmd.env("PATH", path);
        if let Some(k) = key {
            cmd.env("BW_SESSION", k);
        }
        for (k, v) in &self.env {
            cmd.env(k, v);
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Bitwarden's bw could not be started ({}).", e.kind()))?;
        let mut out = child.stdout.take();
        let mut err = child.stderr.take();
        let out_t = std::thread::spawn(move || {
            let mut s = String::new();
            if let Some(o) = out.as_mut() {
                let _ = o.read_to_string(&mut s);
            }
            s
        });
        let err_t = std::thread::spawn(move || {
            let mut s = String::new();
            if let Some(e) = err.as_mut() {
                let _ = e.read_to_string(&mut s);
            }
            s
        });
        let start = Instant::now();
        let status = loop {
            match child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) if start.elapsed() > BW_TIMEOUT => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("Bitwarden's bw did not answer in 30 seconds.".into());
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(20)),
                Err(e) => return Err(format!("Bitwarden's bw failed ({}).", e.kind())),
            }
        };
        let stdout = out_t.join().unwrap_or_default();
        let stderr = err_t.join().unwrap_or_default();
        Ok((status.code().unwrap_or(-1), stdout, stderr))
    }

    /// `bw status`, by the held session if any. Never prompts, never
    /// unlocks. A held session `bw` calls locked is forgotten.
    pub fn ready(&self) -> Ready {
        if self.program().is_none() {
            return Ready::Missing;
        }
        let key = self.key();
        let Ok((_, out, _)) = self.run(&["status"], key.as_deref()) else {
            return Ready::Missing;
        };
        let state = serde_json::from_str::<Value>(out.trim())
            .ok()
            .and_then(|v| v.get("status").and_then(Value::as_str).map(str::to_string));
        match state.as_deref() {
            Some("unauthenticated") => {
                self.forget_session();
                Ready::Unauthenticated
            }
            Some("unlocked") if key.is_some() => Ready::Unlocked,
            _ => {
                if key.is_some() {
                    self.forget_session();
                }
                Ready::Locked
            }
        }
    }

    /// The key he pasted from `bw unlock --raw`: kept (in memory) only if
    /// `bw` says it opens the vault. Returns the state it leaves.
    pub fn use_session(&self, key: &str) -> Result<Ready, String> {
        let key = key.trim();
        if key.is_empty() {
            return Err("Nothing was pasted.".into());
        }
        if key.len() > 512 || key.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err(
                "That is not a session key: paste the one line `bw unlock --raw` prints.".into(),
            );
        }
        if self.program().is_none() {
            return Ok(Ready::Missing);
        }
        let (_, out, _) = self.run(&["status"], Some(key))?;
        let state = serde_json::from_str::<Value>(out.trim())
            .ok()
            .and_then(|v| v.get("status").and_then(Value::as_str).map(str::to_string));
        match state.as_deref() {
            Some("unlocked") => {
                if let Ok(mut h) = self.held.lock() {
                    *h = Some(Held {
                        key: key.to_string(),
                        used: Instant::now(),
                    });
                }
                Ok(Ready::Unlocked)
            }
            Some("unauthenticated") => Ok(Ready::Unauthenticated),
            _ => Err("That key does not open the vault: run `bw unlock --raw` again and paste what it prints.".into()),
        }
    }

    /// Items matching `query` (`bw list items --search`), at most
    /// [`SEARCH_MAX`]: names and field names, never a value.
    pub fn search(&self, query: &str) -> Result<Vec<ItemView>, String> {
        let query = query.trim();
        if query.is_empty() {
            return Err("Type part of the item's name.".into());
        }
        let key = self.key().ok_or_else(locked_words)?;
        let (code, out, err) = self.run(&["list", "items", "--search", query], Some(&key))?;
        if code != 0 {
            return Err(self.failed(&err));
        }
        let items: Vec<Value> = serde_json::from_str(out.trim())
            .map_err(|_| "Bitwarden's answer could not be read.".to_string())?;
        Ok(items
            .iter()
            .filter_map(item_view)
            .take(SEARCH_MAX)
            .collect())
    }

    /// The one value: `field` of item `item_id` (`bw get item`). Never
    /// logged; an error never carries it.
    pub fn value(&self, item_id: &str, field: &str) -> Result<(String, String), String> {
        if !valid_id(item_id) {
            return Err("That is not a Bitwarden item id.".into());
        }
        let key = self.key().ok_or_else(locked_words)?;
        let (code, out, err) = self.run(&["get", "item", item_id], Some(&key))?;
        if code != 0 {
            return Err(self.failed(&err));
        }
        let item: Value = serde_json::from_str(out.trim())
            .map_err(|_| "Bitwarden's answer could not be read.".to_string())?;
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("the item")
            .to_string();
        match field_value(&item, field) {
            Some(v) if !v.is_empty() => Ok((name, v)),
            _ => Err(format!("{name} has nothing in {}.", field_label(field))),
        }
    }

    /// What a failed call says: from `bw`'s stderr only, in known words.
    fn failed(&self, stderr: &str) -> String {
        let e = stderr.to_ascii_lowercase();
        if e.contains("locked") {
            self.forget_session();
            locked_words()
        } else if e.contains("not logged in") || e.contains("unauthenticated") {
            self.forget_session();
            "Bitwarden is signed out: run `bw login` in Terminal.".into()
        } else if e.contains("not found") {
            "That item is no longer in the vault.".into()
        } else {
            "Bitwarden could not read it.".into()
        }
    }
}

impl Default for Vault {
    fn default() -> Self {
        Self::new()
    }
}

fn locked_words() -> String {
    "Bitwarden is locked: run `bw unlock --raw` in Terminal and paste the key on the card.".into()
}

/// The first executable `bw` in `path_var`'s folders, then in `extra`.
pub fn find_in(path_var: &str, extra: &[&str]) -> Option<PathBuf> {
    path_var
        .split(':')
        .filter(|d| !d.is_empty())
        .chain(extra.iter().copied())
        .map(|d| Path::new(d).join("bw"))
        .find(|p| is_executable(p))
}

fn is_executable(p: &Path) -> bool {
    let Ok(m) = std::fs::metadata(p) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        m.is_file() && m.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        m.is_file()
    }
}

/// A Bitwarden id: letters, digits and `-`, never a flag.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && !id.starts_with('-')
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn nonempty(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// What the card shows of an item: no value read into it.
fn item_view(item: &Value) -> Option<ItemView> {
    let id = item.get("id").and_then(Value::as_str)?.to_string();
    let name = item
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("(no name)")
        .to_string();
    let login = item.get("login");
    let host = login
        .and_then(|l| l.get("uris"))
        .and_then(Value::as_array)
        .and_then(|u| u.first())
        .and_then(|u| u.get("uri"))
        .and_then(Value::as_str)
        .map(host_of);
    let mut fields = Vec::new();
    if nonempty(login.and_then(|l| l.get("password"))).is_some() {
        fields.push("password".to_string());
    }
    if nonempty(login.and_then(|l| l.get("username"))).is_some() {
        fields.push("username".to_string());
    }
    if let Some(custom) = item.get("fields").and_then(Value::as_array) {
        for f in custom {
            if let Some(n) = nonempty(f.get("name"))
                && nonempty(f.get("value")).is_some()
            {
                fields.push(format!("field:{n}"));
            }
        }
    }
    if nonempty(item.get("notes")).is_some() {
        fields.push("notes".to_string());
    }
    Some(ItemView {
        id,
        name,
        host,
        fields,
    })
}

fn host_of(uri: &str) -> String {
    let rest = uri.split_once("://").map(|(_, r)| r).unwrap_or(uri);
    rest.split(['/', '?', '#'])
        .next()
        .unwrap_or(rest)
        .to_string()
}

fn field_value(item: &Value, field: &str) -> Option<String> {
    let login = item.get("login");
    match field {
        "password" => nonempty(login.and_then(|l| l.get("password"))),
        "username" => nonempty(login.and_then(|l| l.get("username"))),
        "notes" => nonempty(item.get("notes")),
        f => {
            let want = f.strip_prefix("field:")?;
            item.get("fields")
                .and_then(Value::as_array)?
                .iter()
                .find(|x| x.get("name").and_then(Value::as_str) == Some(want))
                .and_then(|x| nonempty(x.get("value")))
        }
    }
}

/// The words a field goes by on the card and in Settings.
pub fn field_label(field: &str) -> String {
    match field.strip_prefix("field:") {
        Some(n) => format!("its field \u{201c}{n}\u{201d}"),
        None => format!("its {field}"),
    }
}

// ---- the command prefix ----------------------------------------------------

/// The most words a prefix keeps.
const PREFIX_WORDS: usize = 3;

/// A command's first words, the part "always for this command" keeps: the
/// program and the words after it up to the first flag, quote, variable,
/// path or operator, at most three — `gh release create v1 --notes x` →
/// `gh release create`; `curl -H "…"` → `curl`. `None` when not even the
/// program is a plain word.
pub fn command_prefix(command: &str) -> Option<String> {
    let mut words = Vec::new();
    for (i, w) in command.split_whitespace().enumerate() {
        let plain = |c: char| c.is_ascii_alphanumeric() || "._-+:@".contains(c);
        let ok = if i == 0 {
            // The program may be a path (./deploy.sh, /usr/bin/gh).
            w.chars().all(|c| plain(c) || c == '/')
        } else {
            !w.starts_with('-') && w.chars().all(plain)
        };
        if !ok || words.len() == PREFIX_WORDS {
            break;
        }
        // An assignment in front (`FOO=1 gh …`) is not the program.
        if w.contains('=') {
            break;
        }
        words.push(w);
    }
    (!words.is_empty()).then(|| words.join(" "))
}

/// Whether `command` starts with every word of `prefix`, word by word.
pub fn prefix_matches(prefix: &str, command: &str) -> bool {
    let want: Vec<&str> = prefix.split_whitespace().collect();
    let have: Vec<&str> = command.split_whitespace().collect();
    !want.is_empty() && have.len() >= want.len() && have[..want.len()] == want[..]
}

// ---- wrappers (item 825) ----------------------------------------------------

/// Programs that run another command they are handed — a shell, `env`,
/// `sudo`, `xargs`, `eval` and the like. "Always" for one of them would be
/// "always" for every command, so none can be kept as a prefix, and none
/// is the program of a command the value is released to.
pub const WRAPPERS: &[&str] = &[
    "bash",
    "sh",
    "zsh",
    "dash",
    "ksh",
    "mksh",
    "fish",
    "csh",
    "tcsh",
    "ash",
    "busybox",
    "env",
    "sudo",
    "doas",
    "su",
    "xargs",
    "eval",
    "exec",
    "command",
    "builtin",
    "nohup",
    "time",
    "nice",
    "ionice",
    "timeout",
    "gtimeout",
    "watch",
    "script",
    "parallel",
    "caffeinate",
    "stdbuf",
    "setsid",
    "chroot",
    "flock",
    "arch",
    "unbuffer",
    "expect",
    "launchctl",
    "osascript",
    // Review (merge round V): more that run the command they are handed.
    "sandbox-exec",
    "xcrun",
    "taskset",
    "chrt",
    "pkexec",
    "runuser",
    "unshare",
    "nsenter",
    "strace",
    "ltrace",
    "dtruss",
    "gdb",
    "lldb",
    "valgrind",
    "entr",
    "firejail",
    "bwrap",
    "proxychains",
    "proxychains4",
    "torsocks",
    "fakeroot",
    "faketime",
    "rlwrap",
    "ssh-agent",
    "systemd-run",
    "dbus-run-session",
];

/// Launchers of two or three words (review, merge round V): alone, like an interpreter
/// alone, they run any package or command they are handed (`npm exec -c
/// '…'`, `uv run -- sh`), so "always" cannot be kept for one; with a name
/// after them (`uv run deploy.py`) the prefix names that.
pub const LAUNCHERS: &[&str] = &[
    "npm exec",
    "npm x",
    "pnpm exec",
    "pnpm dlx",
    "yarn exec",
    "yarn dlx",
    "bun x",
    "bun run",
    "deno run",
    "deno eval",
    "uv run",
    "uv tool",
    "uv tool run",
    "poetry run",
    "pipenv run",
    "pdm run",
    "hatch run",
    "rye run",
    "conda run",
    "mamba run",
    "micromamba run",
    "bundle exec",
    "mise exec",
    "mise x",
    "asdf exec",
    "nix run",
    "nix shell",
    "nix develop",
    "direnv exec",
    "go run",
];

/// Interpreters and package runners: alone, the prefix covers `-c`/`-e`
/// and any package (`python3 -c …` keeps only `python3`); with a script
/// after them (`python3 deploy.py`) the prefix names that script.
pub const INTERPRETERS: &[&str] = &[
    "python", "python2", "python3", "pypy", "pypy3", "node", "nodejs", "deno", "bun", "perl",
    "ruby", "php", "lua", "luajit", "tclsh", "wish", "rscript", "awk", "gawk", "mawk", "nawk",
    "npx", "pnpx", "bunx", "uvx", "pipx", "jshell", "irb", "swift",
];

/// A program word's own name: the last part of a path, lower-cased, a
/// version suffix dropped (`/usr/bin/python3.12` → `python3`).
fn program_name(word: &str) -> String {
    let base = word.rsplit('/').next().unwrap_or(word).to_ascii_lowercase();
    // python3.12 → python3; ruby3.3 → ruby3 → ruby (below).
    match base.find('.') {
        Some(i)
            if base[i + 1..]
                .chars()
                .all(|c| c.is_ascii_digit() || c == '.') =>
        {
            base[..i].to_string()
        }
        _ => base,
    }
}

/// Whether `word`, as a command's program, is a wrapper ([`WRAPPERS`]).
pub fn is_wrapper(word: &str) -> bool {
    let name = program_name(word);
    WRAPPERS.contains(&name.as_str())
}

/// Why "always" cannot be kept for `prefix`, in one short line; `None`
/// when it can. A wrapper as its program, or an interpreter alone.
pub fn wrapper_refusal(prefix: &str) -> Option<String> {
    let words: Vec<&str> = prefix.split_whitespace().collect();
    let first = *words.first()?;
    let name = program_name(first);
    let interpreter = INTERPRETERS.contains(&name.as_str())
        || INTERPRETERS.contains(&name.trim_end_matches(|c: char| c.is_ascii_digit()));
    if is_wrapper(first) {
        Some(format!(
            "Not for `{first}`: it runs any command it is given."
        ))
    } else if interpreter && words.len() == 1 {
        Some(format!(
            "Not for `{first}` alone: it runs any code it is given."
        ))
    } else if words.len() > 1
        && LAUNCHERS.contains(&format!("{name} {}", words[1..].join(" ")).as_str())
    {
        Some(format!(
            "Not for `{}` alone: it runs any code it is given.",
            words.join(" ")
        ))
    } else {
        None
    }
}

/// The command the model named on `request_secret`, if any.
pub fn requested_command(input: &Value) -> Option<String> {
    input
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

// ---- the rules -------------------------------------------------------------

/// The rules file as it is on disk, nothing dropped.
fn read_rules_raw(home: &Path) -> RulesFile {
    std::fs::read(home.join(RULES_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// The rules file, with any rule whose prefix is a wrapper dropped (item
/// 825): written back without it, and noted in `dropped` for Settings.
fn read_rules(home: &Path) -> RulesFile {
    read_rules_noting(home).0
}

/// [`read_rules`] and the rules it dropped just now.
fn read_rules_noting(home: &Path) -> (RulesFile, Vec<Dropped>) {
    let mut file = read_rules_raw(home);
    let mut now = Vec::new();
    file.rules.retain(|r| match wrapper_refusal(&r.prefix) {
        Some(why) => {
            now.push(Dropped {
                name: r.name.clone(),
                item_name: r.item_name.clone(),
                prefix: r.prefix.clone(),
                why,
                when: chrono::Utc::now().to_rfc3339(),
            });
            false
        }
        None => true,
    });
    if !now.is_empty() {
        file.dropped.extend(now.iter().cloned());
        // Best-effort: if it cannot be written, the rule is still dropped
        // here and on every read after.
        let _ = write_rules(home, &file);
    }
    (file, now)
}

/// The rules dropped on load and not yet seen (Settings shows them).
pub fn dropped(home: &Path) -> Vec<Dropped> {
    read_rules(home).dropped
}

/// He pressed OK on the dropped notes.
pub fn clear_dropped(home: &Path) -> Result<(), String> {
    let mut file = read_rules(home);
    file.dropped.clear();
    write_rules(home, &file)
}

/// The words a turn says when a read dropped rules (item 825).
pub fn dropped_notice(d: &Dropped) -> String {
    format!(
        "Bitwarden: the Always rule for {} ({}) on `{}` was removed. {}",
        d.name, d.item_name, d.prefix, d.why
    )
}

fn write_rules(home: &Path, file: &RulesFile) -> Result<(), String> {
    std::fs::create_dir_all(home).map_err(|e| format!("could not keep the rule: {e}"))?;
    let tmp = home.join(format!("{RULES_FILE}.{}.tmp", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec_pretty(file).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, bytes)
        .and_then(|_| std::fs::rename(&tmp, home.join(RULES_FILE)))
        .map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            format!("could not keep the rule: {e}")
        })
}

/// Every rule, oldest first.
pub fn rules(home: &Path) -> Vec<Rule> {
    read_rules(home).rules
}

/// Keep "always": `name` from `field` of `item_id` for commands starting
/// with `command`'s prefix. One rule per (name, prefix): a new pick
/// replaces the old.
pub fn add_rule(
    home: &Path,
    name: &str,
    item_id: &str,
    item_name: &str,
    field: &str,
    command: &str,
) -> Result<Rule, String> {
    let prefix = command_prefix(command)
        .ok_or_else(|| "That command has no plain first word to allow it by.".to_string())?;
    if let Some(why) = wrapper_refusal(&prefix) {
        return Err(why);
    }
    if !valid_id(item_id) {
        return Err("That is not a Bitwarden item id.".into());
    }
    let mut file = read_rules(home);
    file.rules
        .retain(|r| !(r.name == name && r.prefix == prefix));
    let rule = Rule {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.to_string(),
        item_id: item_id.to_string(),
        item_name: item_name.to_string(),
        field: field.to_string(),
        prefix,
        added: chrono::Utc::now().to_rfc3339(),
    };
    file.rules.push(rule.clone());
    write_rules(home, &file)?;
    Ok(rule)
}

/// Remove one rule (Settings). Removing one that is gone is not an error.
pub fn remove_rule(home: &Path, id: &str) -> Result<Vec<Rule>, String> {
    let mut file = read_rules(home);
    file.rules.retain(|r| r.id != id);
    write_rules(home, &file)?;
    Ok(file.rules)
}

/// The rule that answers a `request_secret` for `name` naming `command`.
pub fn matching(home: &Path, name: &str, command: Option<&str>) -> Option<Rule> {
    matching_noting(home, name, command).0
}

/// [`matching`], and the wrapper rules the read dropped just now (item 825).
fn matching_noting(home: &Path, name: &str, command: Option<&str>) -> (Option<Rule>, Vec<Dropped>) {
    let (file, dropped) = read_rules_noting(home);
    let rule = command.and_then(|command| {
        file.rules
            .into_iter()
            .rev()
            .find(|r| r.name == name && prefix_matches(&r.prefix, command))
    });
    (rule, dropped)
}

// ---- the card's two roads ---------------------------------------------------

/// The card's *Use once* / *Always*: read the value, write it to the store
/// for `chat` under `name`, and on `always_for` keep the rule. The value
/// goes from `bw` to the 0600 file and nowhere else.
#[allow(clippy::too_many_arguments)]
pub fn store_from_item(
    vault: &Vault,
    store: &crate::secret::Store,
    home: Option<&Path>,
    chat: &str,
    name: &str,
    item_id: &str,
    field: &str,
    always_for: Option<&str>,
) -> Result<(), String> {
    let (item_name, value) = vault.value(item_id, field)?;
    store.put(chat, name, &value)?;
    drop(value);
    if let Some(command) = always_for {
        let home = home.ok_or_else(|| {
            "Used once: Nightloom has no settings folder to keep the rule in.".to_string()
        })?;
        add_rule(home, name, item_id, &item_name, field, command)
            .map_err(|e| format!("Used once: {e}"))?;
    }
    Ok(())
}

/// The turn's check before a card (agent_turn): a rule for this name and
/// command, and an open session → the value is **held** and the call needs
/// no card. Returns the rule used; `None` asks him on the card.
///
/// Item 825: the declared `command` only finds the rule. The value goes to
/// the held copy ([`crate::secret::Store::hold`]), not to the file the
/// model is told of; the hook copies it there only for a command that
/// runs the rule's words ([`crate::secret::release_gate`]).
pub fn answer_by_rule(
    vault: &Vault,
    store: &crate::secret::Store,
    home: Option<&Path>,
    chat: &str,
    name: &str,
    command: Option<&str>,
) -> Option<Rule> {
    answer_by_rule_noting(vault, store, home, chat, name, command).0
}

/// [`answer_by_rule`], and the wrapper rules its read dropped (item 825),
/// for the turn to say so.
pub fn answer_by_rule_noting(
    vault: &Vault,
    store: &crate::secret::Store,
    home: Option<&Path>,
    chat: &str,
    name: &str,
    command: Option<&str>,
) -> (Option<Rule>, Vec<Dropped>) {
    let Some(home) = home else {
        return (None, Vec::new());
    };
    let (rule, dropped) = matching_noting(home, name, command);
    let held = rule.filter(|_| vault.holds_session()).and_then(|rule| {
        let (_, value) = vault.value(&rule.item_id, &rule.field).ok()?;
        store.hold(chat, name, &value).ok()?;
        Some(rule)
    });
    (held, dropped)
}

#[cfg(test)]
#[path = "bitwarden_766b_tests.rs"]
mod tests;
