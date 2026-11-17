//! Approval rules he can see and change (nightshift item 743): **allow**,
//! **ask** and **block**, by tool and by what the call names, for one chat or
//! for every chat — on the Mac and the away server alike (item 783: the
//! every-chat rules are one set, exchanged by [`shared`] in the Mac's sync
//! pass).
//!
//! The Ask position's hook ([`crate::agent::ask`]) decided a call three ways
//! before this — a tool granted by "Allow for this chat", the subagent
//! switch, or a card — and nothing listed what was in force or let it be
//! changed. This module is the store, the matcher and the listing; the hook
//! asks [`verdict`] and the phone's `/api/rules` routes
//! ([`crate::remote`]) call [`list`] and [`edit`].
//!
//! **Two files, one shape.** `approval-rules.json` in the chat's ask
//! directory holds the chat's rules; the same name in the config directory
//! (`~/.nightloom`) holds the rules for every chat. The hook is a separate
//! process that is handed only the chat's directory, so the entry point
//! ([`crate::agent::ask::run_hook`]) passes the config directory in; the pure
//! decision takes both and a test never reads his real rules.
//!
//! **Order: block, then ask, then allow** — across both files, as Claude
//! Code orders its own deny / ask / allow (`external`, code.claude.com
//! "Permissions": deny rules are checked first). A rule that says *ask*
//! therefore takes back a standing allow, and nothing takes back a block.
//!
//! **What a rule matches.** Its `tool` is the tool's name as the hook sees
//! it (`Bash`, `Write`, `mcp__server__tool`), or a name ending in `*` for a
//! prefix (`mcp__github__*`). Its `text`, when not empty, is looked for in
//! the call's subject ([`subject`]): Bash's command, a file tool's path,
//! WebFetch's address, WebSearch's query, otherwise the input as JSON. `*`
//! in the text stands for anything. Ask and block rules match the text
//! **anywhere**; an **allow rule on Bash is narrower** — the command must
//! *start* with the text and be one plain command ([`plain_command`]), so
//! "allow `git status`" does not also allow `git status && rm -rf ~`.
//!
//! **Only what the hook sees can be ruled.** The hook is registered on
//! [`crate::agent::ask::MATCHER`] and only while a chat is on Ask (or Plan);
//! on Auto the CLI's classifier decides and no rule is read. So [`check`]
//! refuses a rule for a tool the hook is never asked about (it would list
//! as in force and never fire), for the model's question and the plan
//! tools (an allow without the answer runs them empty), and for the two
//! tools with a gate of their own (Playwright, `add_folder`).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// The rules file's name, in a chat's ask directory and in the config
/// directory.
pub const FILE: &str = "approval-rules.json";

/// The tools a rule may name besides a connector's (`mcp__…`): the ones
/// [`crate::agent::ask::MATCHER`] puts in front of the hook, less the
/// question and the plan tool.
pub const TOOLS: [&str; 12] = [
    "Bash",
    "Write",
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "WebFetch",
    "WebSearch",
    "EnterWorktree",
    "ExitWorktree",
    "CronCreate",
    "CronDelete",
    "ScheduleWakeup",
];

/// The longest text a rule keeps: a rule is a line he reads on a phone.
pub const TEXT_MAX: usize = 300;

/// The id prefix of a row that is not in a rules file but in the chat's
/// "Allow for this chat" list ([`crate::agent::ask::AskDir::allowed`]).
const GRANT_PREFIX: &str = "grant:";

/// The id prefix of a row that is a connector tool allowed for good in
/// read-only chats ([`Store::reads`], item 783).
const READ_PREFIX: &str = "read:";

/// Whether he allowed `tool` for good in read-only chats (item 783).
pub fn is_read(home: Option<&Path>, tool: &str) -> bool {
    home.is_some_and(|dir| read(dir).reads.iter().any(|t| t == tool))
}

/// "Allow always" on a read-only chat's connector card: `tool` joins the
/// reads, on this host now and on the other at the next sync.
pub fn allow_read(home: &Path, tool: &str) -> Result<(), String> {
    let mut store = read(home);
    if store.reads.iter().any(|t| t == tool) {
        return Ok(());
    }
    store.reads.push(tool.to_string());
    write(home, &store)
}

/// What a matching rule does with a call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    /// Run it without a card.
    Allow,
    /// Show the card, whatever was allowed before.
    Ask,
    /// Refuse it without a card; the model is told a rule blocked it.
    Block,
}

impl Action {
    pub fn parse(word: &str) -> Option<Self> {
        match word {
            "allow" => Some(Self::Allow),
            "ask" => Some(Self::Ask),
            "block" => Some(Self::Block),
            _ => None,
        }
    }
}

/// One rule, as stored.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct Rule {
    pub id: String,
    pub action: Action,
    pub tool: String,
    /// Looked for in the call's subject; empty matches every call.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub text: String,
}

#[derive(Debug, Default, Deserialize, Serialize)]
pub(crate) struct Store {
    #[serde(default)]
    pub(crate) rules: Vec<Rule>,
    /// The next id's number: never reused, so a removed rule's id cannot
    /// come back naming another rule under a sheet that is still open.
    #[serde(default)]
    pub(crate) next: u64,
    /// Connector tools he allowed for good from a read-only chat's card
    /// (item 783, blocker 2033): they count as reads there. Only in the
    /// every-chat file; shared between the hosts like its rules.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) reads: Vec<String>,
    /// What a sync had to say (item 783): a rule both hosts changed, kept
    /// twice. Shown above the list until he dismisses it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) notes: Vec<String>,
}

/// Where the two files live. Either may be absent: a host with no config
/// directory has no "every chat" rules, a listing with no chat named shows
/// only those.
#[derive(Debug, Clone, Default)]
pub struct Places {
    /// The config directory (`~/.nightloom`).
    pub all: Option<PathBuf>,
    /// The chat's ask directory.
    pub chat: Option<PathBuf>,
}

/// A chat's ask directory from its log's path: `<log folder>/ask/<log
/// stem>`, as the turn names it. For a host answering
/// [`crate::remote::Host::ask_dir`].
pub fn ask_dir_of_log(log: &Path) -> Result<PathBuf, String> {
    match (log.parent(), log.file_stem()) {
        (Some(dir), Some(stem)) => Ok(dir.join("ask").join(stem)),
        _ => Err("that chat has no log to keep rules beside".into()),
    }
}

pub(crate) fn read(dir: &Path) -> Store {
    std::fs::read(dir.join(FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub(crate) fn write(dir: &Path, store: &Store) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(FILE);
    let tmp = dir.join(format!("{FILE}.tmp"));
    let bytes = serde_json::to_vec_pretty(store).map_err(|e| e.to_string())?;
    // A sibling and a rename: the hook may be reading at this moment.
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// What a rule's text is looked for in.
pub fn subject(tool: &str, input: &Value) -> String {
    let key = match tool {
        "Bash" => "command",
        "Write" | "Edit" | "MultiEdit" => "file_path",
        "NotebookEdit" => "notebook_path",
        "WebFetch" => "url",
        "WebSearch" => "query",
        _ => "",
    };
    match input.get(key).and_then(Value::as_str) {
        Some(s) => s.to_string(),
        None if input.is_null() => String::new(),
        None => input.to_string(),
    }
}

/// One plain command: nothing that chains, pipes, substitutes or redirects.
/// The test an allow rule on Bash needs — a prefix says nothing about what
/// follows an `&&`.
pub fn plain_command(command: &str) -> bool {
    !["&", "|", ";", "`", "$(", "\n", ">", "<"]
        .iter()
        .any(|op| command.contains(op))
}

/// `text`'s pieces (split on `*`) found in `subject` in order; `anchored`
/// makes the first piece a prefix.
fn text_matches(text: &str, subject: &str, anchored: bool) -> bool {
    let text = text.trim();
    if text.is_empty() {
        return true;
    }
    let subject = subject.trim_start();
    let mut at = 0;
    for (i, piece) in text.split('*').enumerate() {
        if piece.is_empty() {
            continue;
        }
        if i == 0 && anchored {
            if !subject.starts_with(piece) {
                return false;
            }
            at = piece.len();
            continue;
        }
        match subject[at..].find(piece) {
            Some(found) => at += found + piece.len(),
            None => return false,
        }
    }
    true
}

fn tool_matches(rule: &str, tool: &str) -> bool {
    match rule.strip_suffix('*') {
        Some(prefix) => tool.starts_with(prefix),
        None => rule == tool,
    }
}

/// Whether `rule` covers this call.
pub fn matches(rule: &Rule, tool: &str, input: &Value) -> bool {
    if !tool_matches(&rule.tool, tool) {
        return false;
    }
    if rule.text.trim().is_empty() {
        return true;
    }
    let subject = subject(tool, input);
    if rule.action == Action::Allow && tool == "Bash" {
        return plain_command(&subject) && text_matches(&rule.text, &subject, true);
    }
    text_matches(&rule.text, &subject, false)
}

/// The rule that decides this call, if one does: a block before an ask
/// before an allow, the chat's before every chat's within one action.
pub fn verdict(places: &Places, tool: &str, input: &Value) -> Option<Rule> {
    let mut rules = Vec::new();
    if let Some(dir) = &places.chat {
        rules.extend(read(dir).rules);
    }
    if let Some(dir) = &places.all {
        rules.extend(read(dir).rules);
    }
    [Action::Block, Action::Ask, Action::Allow]
        .into_iter()
        .find_map(|action| {
            rules
                .iter()
                .find(|r| r.action == action && matches(r, tool, input))
                .cloned()
        })
}

/// A rule as he would say it: `Bash "git push"`, `Write`, `mcp__github__*`.
pub fn describe(rule: &Rule) -> String {
    if rule.text.trim().is_empty() {
        rule.tool.clone()
    } else {
        format!("{} \"{}\"", rule.tool, rule.text.trim())
    }
}

/// What the model reads when a rule blocked its call.
pub fn blocked_message(rule: &Rule) -> String {
    format!(
        "A rule the user set blocks this call ({}), so it did not run. Do not try to reach the same result another way. Say what you wanted to do, and carry on with whatever does not need it.",
        describe(rule)
    )
}

/// Whether a rule for `tool` could ever fire, and if not, why — in a
/// sentence the sheet shows.
pub fn check(tool: &str, text: &str) -> Result<(), String> {
    let tool = tool.trim();
    if tool.is_empty() {
        return Err("Name the tool the rule is for.".into());
    }
    if text.trim().chars().count() > TEXT_MAX {
        return Err(format!(
            "The rule's text is too long (over {TEXT_MAX} characters)."
        ));
    }
    if crate::agent::own_browser::is_playwright(tool) || tool.starts_with("mcp__playwright__") {
        return Err(
            "Claude's own browser has its own switch (Model and settings), not a rule.".into(),
        );
    }
    if tool == crate::mcp_server::mcp_name(crate::tools::add_folder::NAME) {
        return Err("Adding a folder always shows its card; a rule cannot answer it.".into());
    }
    if tool.starts_with("mcp__") {
        return Ok(());
    }
    if tool.contains('*') {
        return Err("Only a connector's tools take a * (mcp__name__*).".into());
    }
    if matches!(tool, "AskUserQuestion" | "ExitPlanMode" | "EnterPlanMode") {
        return Err(
            "The model's questions and plans always come to you; a rule cannot answer them.".into(),
        );
    }
    if TOOLS.contains(&tool) {
        return Ok(());
    }
    Err(format!(
        "{tool} is not a tool Nightloom is asked about. Rules cover {} and connector tools (mcp__…).",
        TOOLS.join(", ")
    ))
}

/// One row of the listing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Row {
    pub id: String,
    pub action: Action,
    pub tool: String,
    pub text: String,
    /// `all` (every chat, on both hosts) or `chat`.
    pub scope: &'static str,
    /// `rule`; `grant` — the card's "Allow for this chat", which lives
    /// in the chat's own list and reads here as an allow rule; or `read`
    /// — a connector tool he allowed for good in read-only chats (item
    /// 783), which lists as an allow and can only be removed.
    pub source: &'static str,
}

/// What the sheet shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Listing {
    /// His rules, in the order they decide: block, ask, allow.
    pub rules: Vec<Row>,
    /// What happens to a call no rule names, in sentences. Fixed.
    pub defaults: Vec<&'static str>,
    /// What the last sync between the Mac and the away server had to say
    /// (item 783): empty unless both changed the same rule.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
    /// The tools the add form offers by name.
    pub tools: Vec<&'static str>,
    /// Whether a chat was named — the sheet offers "this chat" only then.
    pub chat: bool,
    /// The chat's *Subagents run on auto* switch, when a chat was named.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subagents_auto: Option<bool>,
}

/// What is in force when no rule names a call.
pub const DEFAULTS: [&str; 5] = [
    "Ask: commands (Bash), file edits (Write, Edit, MultiEdit, NotebookEdit), the web (WebFetch, WebSearch), worktrees, schedules, and every connector tool.",
    "Allow: reading and searching inside the chat's folders.",
    "Block: reading outside the chat's folders, until you add the folder.",
    "In a read-only chat: connector actions that send, create, change or delete are refused; one whose name says neither read nor write asks you first (Allow once, Allow always, Deny), and so does remembering something.",
    "These are read while a chat is on Ask or Plan. On Auto, Claude Code decides each call itself and no rule here is consulted.",
];

fn row(rule: Rule, scope: &'static str) -> Row {
    Row {
        id: rule.id,
        action: rule.action,
        tool: rule.tool,
        text: rule.text,
        scope,
        source: "rule",
    }
}

/// Every rule in force for `places`.
pub fn list(places: &Places) -> Listing {
    let mut rules: Vec<Row> = Vec::new();
    if let Some(dir) = &places.chat {
        rules.extend(read(dir).rules.into_iter().map(|r| row(r, "chat")));
        let ask = crate::agent::ask::AskDir::new(dir);
        rules.extend(ask.allowed().into_iter().map(|tool| Row {
            id: format!("{GRANT_PREFIX}{tool}"),
            action: Action::Allow,
            tool,
            text: String::new(),
            scope: "chat",
            source: "grant",
        }));
    }
    let mut notes = Vec::new();
    if let Some(dir) = &places.all {
        let store = shared::migrated(dir);
        rules.extend(store.rules.into_iter().map(|r| row(r, "all")));
        rules.extend(store.reads.into_iter().map(|tool| Row {
            id: format!("{READ_PREFIX}{tool}"),
            action: Action::Allow,
            tool,
            text: String::new(),
            scope: "all",
            source: "read",
        }));
        notes = store.notes;
    }
    // Stable: within an action the chat's stay before every chat's.
    rules.sort_by_key(|r| match r.action {
        Action::Block => 0,
        Action::Ask => 1,
        Action::Allow => 2,
    });
    Listing {
        rules,
        defaults: DEFAULTS.to_vec(),
        notes,
        tools: TOOLS.to_vec(),
        chat: places.chat.is_some(),
        subagents_auto: places
            .chat
            .as_ref()
            .map(|d| crate::agent::ask::AskDir::new(d).subagents_auto()),
    }
}

/// One change from the sheet.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Edit {
    Add {
        /// `all` or `chat`.
        scope: String,
        action: String,
        tool: String,
        #[serde(default)]
        text: String,
    },
    /// The rule `id` becomes this. Its scope stays.
    Change {
        id: String,
        action: String,
        tool: String,
        #[serde(default)]
        text: String,
    },
    Remove {
        id: String,
    },
    /// The sync's notes were read: clear them.
    Dismiss,
}

const READ_FIXED: &str =
    "This one only says the action may run in read-only chats. Remove it to be asked again.";
const NO_CHAT: &str = "Open a chat to make a rule for one chat.";
const NO_HOME: &str = "This host has no settings folder to keep a rule for every chat.";
const GONE: &str = "That rule is no longer there.";

fn dir_of<'a>(places: &'a Places, scope: &str) -> Result<&'a Path, String> {
    match scope {
        "chat" => places.chat.as_deref().ok_or_else(|| NO_CHAT.to_string()),
        "all" => places.all.as_deref().ok_or_else(|| NO_HOME.to_string()),
        other => Err(format!("unknown scope: {other}")),
    }
}

fn parsed(action: &str, tool: &str, text: &str) -> Result<(Action, String, String), String> {
    let action = Action::parse(action).ok_or_else(|| format!("unknown action: {action}"))?;
    check(tool, text)?;
    Ok((action, tool.trim().to_string(), text.trim().to_string()))
}

fn add_to(
    dir: &Path,
    prefix: &str,
    action: Action,
    tool: String,
    text: String,
) -> Result<(), String> {
    let mut store = read(dir);
    // The same rule twice is one rule.
    if store
        .rules
        .iter()
        .any(|r| r.action == action && r.tool == tool && r.text == text)
    {
        return Ok(());
    }
    store.next += 1;
    // An every-chat rule's id is unique across hosts (item 783): the Mac's
    // third rule and the away server's third are different rules.
    let id = if prefix == "a" {
        shared::new_id()
    } else {
        format!("{prefix}{}", store.next)
    };
    store.rules.push(Rule {
        id,
        action,
        tool,
        text,
    });
    write(dir, &store)
}

/// The scope a stored rule's id names (`a…` every chat, `c…` this chat).
fn scope_of(id: &str) -> Option<&'static str> {
    match id.as_bytes().first() {
        Some(b'a') => Some("all"),
        Some(b'c') => Some("chat"),
        _ => None,
    }
}

/// Apply one change and return the listing after it. Every refusal is a
/// sentence for the sheet; nothing is written when one is returned.
pub fn edit(places: &Places, change: Edit) -> Result<Listing, String> {
    match change {
        Edit::Add {
            scope,
            action,
            tool,
            text,
        } => {
            let dir = dir_of(places, &scope)?;
            let (action, tool, text) = parsed(&action, &tool, &text)?;
            let prefix = if scope == "all" { "a" } else { "c" };
            add_to(dir, prefix, action, tool, text)?;
        }
        Edit::Change {
            id,
            action,
            tool,
            text,
        } => {
            if id.starts_with(READ_PREFIX) {
                return Err(READ_FIXED.into());
            }
            let (action, tool, text) = parsed(&action, &tool, &text)?;
            if let Some(granted) = id.strip_prefix(GRANT_PREFIX) {
                // An "Allow for this chat" changed: it leaves the chat's
                // list and becomes a rule, so the change is one he can see.
                let dir = dir_of(places, "chat")?;
                let ask = crate::agent::ask::AskDir::new(dir);
                if !ask.allowed().iter().any(|t| t == granted) {
                    return Err(GONE.into());
                }
                add_to(dir, "c", action, tool, text)?;
                ask.disallow_tool(granted).map_err(|e| e.to_string())?;
            } else {
                let dir = dir_of(places, scope_of(&id).ok_or(GONE)?)?;
                let mut store = read(dir);
                let rule = store.rules.iter_mut().find(|r| r.id == id).ok_or(GONE)?;
                rule.action = action;
                rule.tool = tool;
                rule.text = text;
                write(dir, &store)?;
            }
        }
        Edit::Dismiss => {
            if let Some(dir) = places.all.as_deref() {
                let mut store = read(dir);
                if !store.notes.is_empty() {
                    store.notes.clear();
                    write(dir, &store)?;
                }
            }
        }
        Edit::Remove { id } => {
            if let Some(tool) = id.strip_prefix(READ_PREFIX) {
                let dir = dir_of(places, "all")?;
                let mut store = read(dir);
                let before = store.reads.len();
                store.reads.retain(|t| t != tool);
                if store.reads.len() == before {
                    return Err(GONE.into());
                }
                write(dir, &store)?;
            } else if let Some(granted) = id.strip_prefix(GRANT_PREFIX) {
                let dir = dir_of(places, "chat")?;
                crate::agent::ask::AskDir::new(dir)
                    .disallow_tool(granted)
                    .map_err(|e| e.to_string())?;
            } else {
                let dir = dir_of(places, scope_of(&id).ok_or(GONE)?)?;
                let mut store = read(dir);
                let before = store.rules.len();
                store.rules.retain(|r| r.id != id);
                if store.rules.len() == before {
                    return Err(GONE.into());
                }
                write(dir, &store)?;
            }
        }
    }
    Ok(list(places))
}

pub mod shared;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Removed when the test ends, pass or fail.
    struct Root(PathBuf);
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn places() -> (Root, Places) {
        let root = std::env::temp_dir().join(format!("nightloom-rules-{}", uuid::Uuid::new_v4()));
        let p = Places {
            all: Some(root.join("home")),
            chat: Some(root.join("home/sessions/ask/chat1")),
        };
        (Root(root), p)
    }

    fn add(p: &Places, scope: &str, action: &str, tool: &str, text: &str) -> Listing {
        edit(
            p,
            Edit::Add {
                scope: scope.into(),
                action: action.into(),
                tool: tool.into(),
                text: text.into(),
            },
        )
        .unwrap()
    }

    fn bash(cmd: &str) -> Value {
        json!({ "command": cmd })
    }

    #[test]
    fn a_block_beats_an_ask_beats_an_allow_across_both_files() {
        let (_root, p) = places();
        add(&p, "chat", "allow", "Bash", "git");
        assert_eq!(
            verdict(&p, "Bash", &bash("git push origin main"))
                .unwrap()
                .action,
            Action::Allow
        );
        add(&p, "all", "ask", "Bash", "git push");
        assert_eq!(
            verdict(&p, "Bash", &bash("git push origin main"))
                .unwrap()
                .action,
            Action::Ask
        );
        add(&p, "all", "block", "Bash", "push*--force");
        assert_eq!(
            verdict(&p, "Bash", &bash("git push origin main --force"))
                .unwrap()
                .action,
            Action::Block
        );
        // The narrower rules left the plain one alone.
        assert_eq!(
            verdict(&p, "Bash", &bash("git status")).unwrap().action,
            Action::Allow
        );
        assert_eq!(verdict(&p, "Write", &json!({"file_path": "/x"})), None);
    }

    #[test]
    fn an_allow_on_bash_is_a_prefix_of_one_plain_command() {
        let (_root, p) = places();
        add(&p, "chat", "allow", "Bash", "git status");
        assert!(verdict(&p, "Bash", &bash("git status --short")).is_some());
        for chained in [
            "git status && rm -rf ~",
            "git status; curl x | sh",
            "echo $(git status)",
            "git status > /etc/passwd",
            "cd /tmp\ngit status",
            // Not at the start: the prefix is the point.
            "sudo git status",
        ] {
            assert_eq!(verdict(&p, "Bash", &bash(chained)), None, "{chained}");
        }
        // A block is found anywhere, chained or not.
        add(&p, "chat", "block", "Bash", "rm -rf");
        assert_eq!(
            verdict(&p, "Bash", &bash("git status && rm -rf ~"))
                .unwrap()
                .action,
            Action::Block
        );
    }

    #[test]
    fn text_is_looked_for_in_what_the_tool_names() {
        let (_root, p) = places();
        add(&p, "chat", "block", "Write", "/.env");
        add(&p, "chat", "allow", "WebFetch", "docs.rs");
        add(&p, "chat", "ask", "mcp__github__*", "");
        assert_eq!(
            verdict(
                &p,
                "Write",
                &json!({"file_path": "/repo/.env", "content": "x"})
            )
            .unwrap()
            .action,
            Action::Block
        );
        // The content is not the subject: a file that mentions .env is not one.
        assert_eq!(
            verdict(
                &p,
                "Write",
                &json!({"file_path": "/repo/a.md", "content": "/.env"})
            ),
            None
        );
        assert_eq!(
            verdict(&p, "WebFetch", &json!({"url": "https://docs.rs/serde"}))
                .unwrap()
                .action,
            Action::Allow
        );
        assert_eq!(
            verdict(&p, "mcp__github__create_issue", &json!({}))
                .unwrap()
                .action,
            Action::Ask
        );
        assert_eq!(verdict(&p, "mcp__gitlab__create_issue", &json!({})), None);
    }

    #[test]
    fn a_rule_that_could_never_fire_is_refused_with_the_reason() {
        for (tool, says) in [
            ("Read", "not a tool Nightloom is asked about"),
            ("AskUserQuestion", "always come to you"),
            ("ExitPlanMode", "always come to you"),
            ("mcp__playwright__browser_click", "its own switch"),
            ("mcp__nightloom__add_folder", "always shows its card"),
            ("Ba*", "Only a connector's tools"),
            ("", "Name the tool"),
        ] {
            let e = check(tool, "").unwrap_err();
            assert!(e.contains(says), "{tool}: {e}");
        }
        assert!(check("Bash", "git push").is_ok());
        assert!(check("mcp__github__*", "").is_ok());
        assert!(check("Bash", &"x".repeat(TEXT_MAX + 1)).is_err());
        // And nothing was written for a refused add.
        let (_root, p) = places();
        let refused = edit(
            &p,
            Edit::Add {
                scope: "chat".into(),
                action: "allow".into(),
                tool: "Read".into(),
                text: String::new(),
            },
        );
        assert!(refused.is_err());
        assert!(list(&p).rules.is_empty());
    }

    #[test]
    fn add_change_and_remove_read_back_in_deciding_order() {
        let (_root, p) = places();
        add(&p, "chat", "allow", "Bash", "cargo");
        add(&p, "all", "block", "Bash", "git push --force");
        let l = add(&p, "all", "ask", "WebFetch", "");
        let seen: Vec<_> = l
            .rules
            .iter()
            .map(|r| (r.action, r.scope, r.tool.as_str()))
            .collect();
        assert_eq!(
            seen,
            [
                (Action::Block, "all", "Bash"),
                (Action::Ask, "all", "WebFetch"),
                (Action::Allow, "chat", "Bash"),
            ]
        );
        // The same rule again is not a second row.
        assert_eq!(add(&p, "all", "ask", "WebFetch", "").rules.len(), 3);
        let id = l.rules[2].id.clone();
        let l = edit(
            &p,
            Edit::Change {
                id: id.clone(),
                action: "ask".into(),
                tool: "Bash".into(),
                text: "cargo publish".into(),
            },
        )
        .unwrap();
        let changed = l.rules.iter().find(|r| r.id == id).unwrap();
        assert_eq!(
            (changed.action, changed.text.as_str(), changed.scope),
            (Action::Ask, "cargo publish", "chat")
        );
        let l = edit(&p, Edit::Remove { id: id.clone() }).unwrap();
        assert!(l.rules.iter().all(|r| r.id != id));
        // Gone is said, not swallowed; and a new rule never takes its id.
        assert_eq!(edit(&p, Edit::Remove { id: id.clone() }).unwrap_err(), GONE);
        let l = add(&p, "chat", "allow", "Bash", "ls");
        assert!(l.rules.iter().all(|r| r.id != id));
    }

    #[test]
    fn an_allow_for_this_chat_lists_and_can_be_removed_or_changed() {
        let (_root, p) = places();
        let ask = crate::agent::ask::AskDir::new(p.chat.clone().unwrap());
        ask.allow_tool("Bash").unwrap();
        ask.allow_tool("WebFetch").unwrap();
        let l = list(&p);
        assert_eq!(l.rules.len(), 2);
        assert!(
            l.rules
                .iter()
                .all(|r| r.source == "grant" && r.action == Action::Allow)
        );
        assert_eq!(l.subagents_auto, Some(true));
        edit(
            &p,
            Edit::Remove {
                id: "grant:WebFetch".into(),
            },
        )
        .unwrap();
        assert_eq!(ask.allowed(), ["Bash"]);
        // Changed, it becomes a rule and leaves the list.
        let l = edit(
            &p,
            Edit::Change {
                id: "grant:Bash".into(),
                action: "block".into(),
                tool: "Bash".into(),
                text: "sudo".into(),
            },
        )
        .unwrap();
        assert!(ask.allowed().is_empty());
        assert_eq!(l.rules.len(), 1);
        assert_eq!(
            (l.rules[0].action, l.rules[0].source),
            (Action::Block, "rule")
        );
    }

    /// The bodies the phone's sheet posts (`rules.ts`, `editOf`), as JSON.
    #[test]
    fn the_phones_edits_parse_and_the_listing_reads_as_the_sheet_expects() {
        let (_root, p) = places();
        let add: Edit = serde_json::from_str(
            r#"{"op":"add","scope":"chat","action":"block","tool":"Bash","text":"rm -rf"}"#,
        )
        .unwrap();
        let l = edit(&p, add).unwrap();
        let id = l.rules[0].id.clone();
        let change: Edit = serde_json::from_value(
            json!({"op":"change","id":id,"action":"ask","tool":"mcp__github__*"}),
        )
        .unwrap();
        let l = edit(&p, change).unwrap();
        let wire = serde_json::to_value(&l).unwrap();
        assert_eq!(
            wire["rules"][0],
            json!({"id": id, "action": "ask", "tool": "mcp__github__*", "text": "", "scope": "chat", "source": "rule"})
        );
        assert_eq!(wire["chat"], json!(true));
        assert_eq!(wire["subagents_auto"], json!(true));
        assert_eq!(wire["tools"][0], json!("Bash"));
        let remove: Edit = serde_json::from_value(json!({"op":"remove","id":id})).unwrap();
        assert!(edit(&p, remove).unwrap().rules.is_empty());
    }

    #[test]
    fn with_no_chat_only_every_chats_rules_are_listed_and_made() {
        let (_root, mut p) = places();
        add(&p, "chat", "allow", "Bash", "ls");
        add(&p, "all", "block", "Bash", "sudo");
        p.chat = None;
        let l = list(&p);
        assert_eq!(l.rules.len(), 1);
        assert!(!l.chat);
        assert_eq!(l.subagents_auto, None);
        let e = edit(
            &p,
            Edit::Add {
                scope: "chat".into(),
                action: "allow".into(),
                tool: "Bash".into(),
                text: String::new(),
            },
        )
        .unwrap_err();
        assert_eq!(e, NO_CHAT);
    }
}
