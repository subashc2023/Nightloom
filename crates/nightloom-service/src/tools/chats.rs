//! `search_chats` and `read_chat`: what the model can find in the user's
//! other conversations.
//!
//! Cross-chat retrieval as a tool call, deliberately: a lookup the user can
//! see in the transcript, and the description tells the model to name the
//! chat and its date when it uses what it found. No embeddings and no
//! automatic injection — a passage from another chat reaching the model on
//! its own is a separate piece of work (blocker 052).
//!
//! `search_chats` ranks through [`store::index::ChatIndex`], a BM25 index
//! kept beside each directory's logs, and falls back to the sidebar's
//! substring scan only for a query the index cannot count. The first version
//! had no index and returned chats newest first; measured on ten questions
//! over one project it missed twice, both times a topic a dozen chats
//! mention in passing, and ranking is what those needed. `read_chat` is as
//! it was.
//!
//! Both read **the conversation only** — user messages, assistant text and
//! titles — through the same [`store::said`] filter the sidebar search uses,
//! so a tool result never comes back through here. That is not only the
//! false-positive argument `search` makes: a chat's tool results are whatever
//! files it read, and handing another chat a window onto them would be a
//! second `read_file` that no [`super::Root`] confines.
//!
//! The chat asking is itself a log in the active directory, so it can appear
//! in its own results. Nothing here knows which session is live — the tools
//! are built before one exists — and a hit in the current chat costs a row
//! rather than a wrong answer, so it is left alone in this version.

use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use nightloom_core::ToolDef;
use nightloom_core::tool::{CancellationToken, Effect, Tool};
use serde_json::{Value, json};

use super::blocking;
use crate::store::index::{self, ChatIndex};
use crate::store::{self, SessionMatch, StoreError};

/// Where the chats live, for the two tools to look through.
///
/// Passed in rather than discovered, the way `Remember` takes its config
/// dir: a test must never search a developer's real logs, and the shell is
/// the one that knows which project is open.
#[derive(Clone, Debug)]
pub struct ChatDirs {
    /// The open project's sessions, or the unfiled ones when none is open —
    /// the directory the sidebar lists. The default scope.
    pub active: PathBuf,
    /// Every project's sessions plus the unfiled ones, `active` among them.
    /// Named, so a result that spans projects can say which one each chat
    /// belongs to.
    pub all: Vec<ChatDir>,
}

/// One session directory and what to call it in a result.
#[derive(Clone, Debug)]
pub struct ChatDir {
    pub name: String,
    pub dir: PathBuf,
}

impl ChatDirs {
    /// What the active directory is called, for naming an empty result's
    /// scope. Falls back to the directory's own name for a shell that did
    /// not list it under `all`.
    fn active_name(&self) -> String {
        self.all
            .iter()
            .find(|d| d.dir == self.active)
            .map(|d| d.name.clone())
            .unwrap_or_else(|| {
                self.active
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default()
            })
    }

    /// The directories a prefix is resolved in: the active one first, then
    /// the rest, each once. `read_chat` takes no scope because an id is
    /// already unambiguous — the model has it from a result line, and making
    /// it repeat which scope that line came from is a way to get it wrong.
    fn resolve_order(&self) -> Vec<&Path> {
        let mut order: Vec<&Path> = vec![&self.active];
        for d in &self.all {
            if !order.contains(&d.dir.as_path()) {
                order.push(&d.dir);
            }
        }
        order
    }
}

/// Best first, and at most this many: a result is prompt text, and
/// twenty-five excerpts is already a page the model has to read.
const DEFAULT_LIMIT: usize = 10;
const MAX_LIMIT: usize = 25;
const DEFAULT_WINDOW: usize = 6000;
const MAX_WINDOW: usize = 20000;
/// A title in a result line. Longer than a sidebar row's, since here the
/// name is what the model will cite.
const TITLE_WIDTH: usize = 80;

const SEARCH_DESC: &str = "Find which of the user's other chats are about something. Use it the \
     way you would use a web search — not on every message, but when this message points \
     outside this chat: the user refers to an earlier conversation, a decision they made \
     before, a name or thing you have no context for, or something they say they already \
     discussed with you. Search before asking them to repeat it, and before answering from \
     memory about their past work. Ranks chats by how much they say the query's words \
     (case-insensitive, whole words, the chat's title counting extra) over what was said in \
     each chat — user messages, assistant replies and the title — never over tool results, so \
     a word that only appeared in a file a chat read will not find it. Recent chats rank \
     first: a chat's score halves for every month since it was last written, so what the user \
     means is almost always near the top; an old chat is never dropped, only lower, so when \
     they say it was a while ago read further down the list. Use a few distinctive words rather than a sentence: \
     every word you add that the chat did not say dilutes the ranking, and word order does not \
     matter. Returns one line per chat, best first: short id, title, date last active, score, \
     and an excerpt around the first of your words it says. Then call read_chat with the id to \
     read around the passage. scope is the open project's chats by default; all searches every \
     project and the unfiled chats. When you use something you found, cite the chat by its \
     title and date.";

const READ_DESC: &str = "Read part of one of the user's other chats, found with search_chats. \
     session is the short id from a result line. With query, returns a window of the \
     conversation centred on the first message containing it; without, the start of the \
     conversation. Each message is prefixed user: or assistant: with its date; tool results are \
     never included. max_chars bounds the window (default 6000, at most 20000) — ask for more \
     only when the passage is long, and call again with a different query rather than paging \
     through a whole chat. The first line names the chat's title and date: cite both when you \
     quote or rely on what you read.";

/// The `search_chats` tool.
pub struct SearchChats {
    dirs: ChatDirs,
}

impl SearchChats {
    pub fn new(dirs: ChatDirs) -> Self {
        Self { dirs }
    }
}

/// The `read_chat` tool.
pub struct ReadChat {
    dirs: ChatDirs,
}

impl ReadChat {
    pub fn new(dirs: ChatDirs) -> Self {
        Self { dirs }
    }
}

#[async_trait::async_trait]
impl Tool for SearchChats {
    /// A read of the user's own logs, on this machine, that changes nothing:
    /// the same classification as `read_file`, and the same consequence —
    /// no approval, and it may run beside its neighbours.
    fn effect(&self) -> Effect {
        Effect::ReadOnly
    }

    fn def(&self) -> ToolDef {
        ToolDef {
            name: "search_chats".into(),
            description: SEARCH_DESC.into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "A few distinctive words the chat would have said; case-insensitive, any order."
                    },
                    "scope": {
                        "type": "string",
                        "enum": ["project", "all"],
                        "description": "project (default): the open project's chats. all: every project and the unfiled chats."
                    },
                    "limit": {
                        "type": "integer",
                        "description": "How many chats to return, best first. Default 10, at most 25."
                    }
                },
                "required": ["query"]
            }),
        }
    }

    /// `_cancel`, on the terms `blocking` sets out: a walk over the logs is
    /// not abandonable. The cost is the index's freshness check — a stat of
    /// every log and a read of the ones that grew — plus one full scan per
    /// returned chat for its excerpt; the numbers are in `chat-index-report`
    /// beside the spec. The first build of a directory's index reads every
    /// log once, the way the substring scan used to on every call.
    async fn call(&self, input: Value, _cancel: &CancellationToken) -> Result<String, String> {
        let query = input["query"]
            .as_str()
            .map(str::trim)
            .filter(|q| !q.is_empty())
            .ok_or_else(|| {
                "missing required argument: query — give a short distinctive phrase to look for"
                    .to_string()
            })?
            .to_string();
        let scope = match input["scope"].as_str() {
            None | Some("project") => Scope::Project,
            Some("all") => Scope::All,
            Some(other) => {
                return Err(format!("scope must be project or all (got {other:?})"));
            }
        };
        // Clamped rather than refused: a model that asks for fifty wants
        // "many", and a page is the most it can usefully read.
        let limit = input["limit"]
            .as_u64()
            .map_or(DEFAULT_LIMIT, |n| n as usize)
            .clamp(1, MAX_LIMIT);
        let dirs = self.dirs.clone();
        blocking(move || search(&dirs, &query, scope, limit)).await
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Scope {
    Project,
    All,
}

/// The directories a scope covers, each with the name a hit from it carries
/// — `None` in project scope, where every hit is from the same place — and
/// what to call the scope in the header.
fn covered(dirs: &ChatDirs, scope: Scope) -> (Vec<(&Path, Option<String>)>, String) {
    match scope {
        Scope::Project => (
            vec![(dirs.active.as_path(), None)],
            format!("the chats of {}", dirs.active_name()),
        ),
        Scope::All => (
            dirs.all
                .iter()
                .map(|d| (d.dir.as_path(), Some(d.name.clone())))
                .collect(),
            "every project's chats and the unfiled ones".to_string(),
        ),
    }
}

/// An empty result names its scope, for the reason `grep`'s does: "no
/// chats" reads as an answer about everything the user ever said, and in
/// the default scope it is an answer about one project.
fn nothing(where_: &str, query: &str, scope: Scope) -> String {
    format!(
        "no chats in {where_} mention {query:?}. Try different or fewer words{}.",
        if scope == Scope::Project {
            ", or scope: all to search every project"
        } else {
            ""
        }
    )
}

/// The whole `search_chats` answer, as text the model reads.
///
/// Ranked through each directory's [`ChatIndex`], which is brought up to
/// date on the way. A query the index has no term for — a lone symbol, a
/// single letter, an emoji — cannot be ranked and goes to the substring
/// scan instead, newest first, which is what the tool did before it had an
/// index; the header says which happened.
fn search(dirs: &ChatDirs, query: &str, scope: Scope, limit: usize) -> Result<String, String> {
    let (covered, where_) = covered(dirs, scope);
    let words = index::tokenize(query);
    if words.is_empty() {
        return substring(&covered, &where_, query, scope, limit);
    }

    let mut hits = Vec::new();
    let mut total = 0;
    for (dir, project) in &covered {
        let index = ChatIndex::load_or_build(dir).map_err(|e| e.to_string())?;
        let (ranked, found) = index.rank(query, limit);
        total += found;
        for r in ranked {
            hits.push(Hit {
                id: r.log.id(&r.path),
                title: r.log.label(&r.path, TITLE_WIDTH),
                modified: r.log.modified(),
                path: r.path,
                score: r.score,
                project: project.clone(),
            });
        }
    }
    // Across directories the scores are merged as they are. Each index has
    // its own idea of how rare a word is, so a hit from a small project can
    // outscore one from a large one for the same words — a known unfairness
    // in `all` scope, and the alternative is a second ranking pass over
    // every directory's statistics that nothing has asked for yet.
    hits.sort_by(|a, b| {
        b.score
            .total_cmp(&a.score)
            .then_with(|| b.modified.cmp(&a.modified))
    });
    hits.truncate(limit);

    if hits.is_empty() {
        return Ok(nothing(&where_, query, scope));
    }
    let shown = hits.len();
    let mut out = format!(
        "{total} chat{} in {where_} mention {query:?}{}, best first. Lines are: id · title · \
         last active · score · excerpt. Call read_chat with an id to read around a passage.\n",
        if total == 1 { "" } else { "s" },
        if shown < total {
            format!("; the best {shown}")
        } else {
            String::new()
        },
    );
    for hit in &hits {
        // Gone between the ranking and the read: a row that is going away,
        // as in `store::list`, not a failed search.
        let Some(excerpt) = excerpt(&hit.path, hit.modified, &words) else {
            continue;
        };
        out.push_str(&format!(
            "{} · {}{} · {} · {:.1} · {}\n",
            short_id(&hit.id),
            hit.project
                .as_deref()
                .map(|p| format!("[{p}] "))
                .unwrap_or_default(),
            if hit.title.is_empty() {
                "(untitled)"
            } else {
                &hit.title
            },
            hit.modified.format("%Y-%m-%d"),
            hit.score,
            excerpt,
        ));
    }
    Ok(out)
}

/// One ranked chat, owned, so the index it came out of can be dropped.
struct Hit {
    id: String,
    title: String,
    modified: DateTime<Utc>,
    path: PathBuf,
    score: f64,
    project: Option<String>,
}

/// Text around the first of the query's words a chat says, prefixed with
/// who said it — the first version's excerpt, made from one scan of the
/// chat the index chose. The index keeps counts and not positions, so this
/// is the read that shows *why* a chat ranked. When no word is found as a
/// substring — the ranking matched on the title alone, which the line
/// already shows — the chat's opening stands in, so the row still says
/// what the chat is. `None` for a log that could not be read.
fn excerpt(path: &Path, modified: DateTime<Utc>, words: &[String]) -> Option<String> {
    let (_, events) = store::scan(path, modified).ok()?;
    let mut opening = None;
    for said in events.iter().filter_map(store::said) {
        if !said.conversation || said.text.trim().is_empty() {
            continue;
        }
        if let Some(at) = words
            .iter()
            .filter_map(|w| store::find_fold(&said.text, w))
            .min()
        {
            return Some(relabel(&format!(
                "{}: {}",
                said.who,
                store::excerpt_around(&said.text, at, store::EXCERPT_WIDTH)
            )));
        }
        opening.get_or_insert_with(|| {
            relabel(&format!(
                "{}: {}",
                said.who,
                store::excerpt_around(&said.text, 0, store::EXCERPT_WIDTH)
            ))
        });
    }
    Some(opening.unwrap_or_default())
}

/// The substring scan, for a query with no word in it. Newest first and a
/// count of matching messages per chat: the first version's answer, kept
/// because a symbol is still something a chat can be remembered by.
fn substring(
    covered: &[(&Path, Option<String>)],
    where_: &str,
    query: &str,
    scope: Scope,
    limit: usize,
) -> Result<String, String> {
    let mut hits: Vec<(SessionMatch, Option<String>)> = Vec::new();
    for (dir, project) in covered {
        for found in store::search(dir, query).map_err(|e| e.to_string())? {
            hits.push((found, project.clone()));
        }
    }
    // Each directory came back newest first; across several they have to be
    // merged, and the sort is stable so ties keep their order.
    hits.sort_by_key(|(m, _)| std::cmp::Reverse(m.summary.modified));

    if hits.is_empty() {
        return Ok(nothing(where_, query, scope));
    }
    let total = hits.len();
    let shown = total.min(limit);
    let mut out = format!(
        "{total} chat{} in {where_} mention {query:?}{} — matched as text, since it has no \
         word to rank by; newest first. Lines are: id · title · last active · matching \
         messages · excerpt. Call read_chat with an id to read around a passage.\n",
        if total == 1 { "" } else { "s" },
        if shown < total {
            format!("; the newest {shown}")
        } else {
            String::new()
        },
    );
    for (found, project) in hits.iter().take(shown) {
        let s = &found.summary;
        let title = match s.label(TITLE_WIDTH) {
            t if t.is_empty() => "(untitled)".to_string(),
            t => t,
        };
        out.push_str(&format!(
            "{} · {}{} · {} · {} · {}\n",
            short_id(&s.id),
            project
                .as_deref()
                .map(|p| format!("[{p}] "))
                .unwrap_or_default(),
            title,
            s.modified.format("%Y-%m-%d"),
            found.hits,
            relabel(&found.excerpt),
        ));
    }
    Ok(out)
}

/// The first eight characters of a session id: unique in practice, and what
/// the sidebar shows. `read_chat` resolves it as a prefix, so a longer one
/// works too.
fn short_id(id: &str) -> String {
    id.chars().take(8).collect()
}

/// The sidebar's excerpt is addressed to the user, so it says `you:` and
/// `model:`. Fed back to a model it is the wrong second person on both
/// sides, and `read_chat`'s prefixes are the ones the description promises.
fn relabel(excerpt: &str) -> String {
    if let Some(rest) = excerpt.strip_prefix("you: ") {
        format!("user: {rest}")
    } else if let Some(rest) = excerpt.strip_prefix("model: ") {
        format!("assistant: {rest}")
    } else {
        // `name:` — the hit was in the title, which the line already shows.
        excerpt.to_string()
    }
}

/// `read_chat`'s prefix for what [`store::said`] labels.
fn role(who: &str) -> &str {
    match who {
        "you" => "user",
        "model" => "assistant",
        other => other,
    }
}

#[async_trait::async_trait]
impl Tool for ReadChat {
    /// As for `search_chats`: a local read of the user's own logs.
    fn effect(&self) -> Effect {
        Effect::ReadOnly
    }

    fn def(&self) -> ToolDef {
        ToolDef {
            name: "read_chat".into(),
            description: READ_DESC.into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "session": {
                        "type": "string",
                        "description": "The chat's id, or the short id from a search_chats result line."
                    },
                    "query": {
                        "type": "string",
                        "description": "A phrase to centre the window on; the first message containing it. Omit to read from the start."
                    },
                    "max_chars": {
                        "type": "integer",
                        "description": "Size of the window in characters. Default 6000, at most 20000."
                    }
                },
                "required": ["session"]
            }),
        }
    }

    async fn call(&self, input: Value, _cancel: &CancellationToken) -> Result<String, String> {
        let session = input["session"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                "missing required argument: session — the id from a search_chats result line"
                    .to_string()
            })?
            .to_string();
        let query = input["query"]
            .as_str()
            .map(str::trim)
            .filter(|q| !q.is_empty())
            .map(str::to_string);
        let max_chars = input["max_chars"]
            .as_u64()
            .map_or(DEFAULT_WINDOW, |n| n as usize)
            .clamp(1, MAX_WINDOW);
        let dirs = self.dirs.clone();
        blocking(move || read(&dirs, &session, query.as_deref(), max_chars)).await
    }
}

/// The log a prefix names, looked for in every directory the tools can see.
///
/// A prefix that matches in two directories is refused the way one that
/// matches two logs in one directory is: the model asked for one chat, and
/// guessing which would hand it the wrong conversation with a confident
/// header on it.
fn resolve(dirs: &ChatDirs, prefix: &str) -> Result<PathBuf, String> {
    let mut found = Vec::new();
    for dir in dirs.resolve_order() {
        // A project whose logs have not been created yet, or whose folder is
        // on an unplugged drive: nothing to look in, not a failure.
        if !dir.is_dir() {
            continue;
        }
        match store::find_by_prefix(dir, prefix) {
            Ok(path) => found.push(path),
            Err(StoreError::NotFound { .. }) => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    match found.len() {
        0 => Err(format!(
            "no chat whose id starts with {prefix:?}; use the id from a search_chats result line"
        )),
        1 => Ok(found.remove(0)),
        _ => Err(format!(
            "{prefix:?} matches a chat in more than one project; give more of the id: {}",
            found
                .iter()
                .filter_map(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned()))
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

/// One conversational message, as `read_chat` prints it.
struct Message {
    /// `user (2026-09-01 14:02)` — the prefix a continued message repeats.
    head: String,
    text: String,
}

/// The whole `read_chat` answer, as text the model reads.
fn read(
    dirs: &ChatDirs,
    prefix: &str,
    query: Option<&str>,
    max_chars: usize,
) -> Result<String, String> {
    let path = resolve(dirs, prefix)?;
    let modified: DateTime<Utc> = fs::metadata(&path)
        .and_then(|m| m.modified())
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?
        .into();
    let (summary, events) = store::scan(&path, modified).map_err(|e| e.to_string())?;

    // The same filter as the search, minus the title, which goes in the
    // header. A reply that was nothing but tool calls has no text and is
    // skipped rather than printed as an empty `assistant:` line.
    let messages: Vec<Message> = events
        .iter()
        .filter_map(store::said)
        .filter(|s| s.conversation && !s.text.trim().is_empty())
        .map(|s| Message {
            head: format!("{} ({})", role(s.who), s.at.format("%Y-%m-%d %H:%M")),
            text: s.text.trim().to_string(),
        })
        .collect();

    let title = match summary.label(TITLE_WIDTH) {
        t if t.is_empty() => "(untitled)".to_string(),
        t => t,
    };
    let mut out = format!(
        "chat {} · {title} · last active {} · {} messages\n\n",
        short_id(&summary.id),
        modified.format("%Y-%m-%d"),
        messages.len(),
    );
    if messages.is_empty() {
        out.push_str("(nothing was said in this chat)\n");
        return Ok(out);
    }

    // One string, with where each message starts in it, so the window can
    // be cut anywhere and still say whose words it opens in the middle of.
    let mut transcript = String::new();
    let mut starts = Vec::with_capacity(messages.len());
    for m in &messages {
        starts.push(transcript.len());
        transcript.push_str(&m.head);
        transcript.push_str(": ");
        transcript.push_str(&m.text);
        transcript.push_str("\n\n");
    }

    // Byte offsets throughout, found by walking chars, for the reason
    // `find_fold` gives: `max_chars` is a count of characters, and a byte
    // offset computed from it does not land on a boundary.
    let start = match query {
        Some(q) => {
            let at = store::find_fold(&transcript, &q.to_lowercase()).ok_or_else(|| {
                format!(
                    "no message in this chat contains {q:?}; call read_chat without query to \
                     read from the start, or search_chats to find the chat that has it"
                )
            })?;
            chars_back(&transcript, at, max_chars / 2)
        }
        None => 0,
    };
    let end = chars_forward(&transcript, start, max_chars);

    if start > 0 {
        // The message the window opens inside, named so a fragment is not
        // mistaken for the other speaker's.
        let inside = starts.iter().rposition(|&s| s <= start).unwrap_or(0);
        if starts[inside] < start {
            out.push_str(&format!("{}, continued: …", messages[inside].head));
        } else {
            out.push('…');
        }
    }
    out.push_str(transcript[start..end].trim_end());
    out.push('\n');
    if end < transcript.len() {
        let total = transcript.chars().count();
        let shown = transcript[start..end].chars().count();
        out.push_str(&format!(
            "… ({shown} of {total} characters shown; call again with a query near what you \
             need, or a larger max_chars, for more)\n"
        ));
    }
    Ok(out)
}

/// The byte offset `n` characters before `at`, or the start of the text.
fn chars_back(text: &str, at: usize, n: usize) -> usize {
    text[..at]
        .char_indices()
        .rev()
        .nth(n.saturating_sub(1))
        .map_or(0, |(i, _)| i)
}

/// The byte offset `n` characters after `from`, or the end of the text.
fn chars_forward(text: &str, from: usize, n: usize) -> usize {
    text[from..]
        .char_indices()
        .nth(n)
        .map_or(text.len(), |(i, _)| from + i)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nightloom_core::{ContentBlock, Session, Usage};
    use std::time::Duration;

    /// A real log through `Session`, as `store`'s tests write theirs, so the
    /// tools are tested against the format the engine actually produces.
    fn logged(dir: &Path, title: &str, user: &str, reply: &str, tool_output: &str) -> String {
        let mut s = Session::with_log(dir).unwrap();
        s.record_user(user);
        s.record_assistant(
            "test-model",
            vec![
                ContentBlock::Thinking {
                    text: "a private thought about parsnips".into(),
                    signature: None,
                },
                ContentBlock::Text { text: reply.into() },
            ],
            Some("end_turn".into()),
            Usage::default(),
        );
        s.record_tool_result(&ContentBlock::ToolResult {
            tool_use_id: "c1".into(),
            name: "read_file".into(),
            content: tool_output.into(),
            is_error: false,
        });
        s.record_title(title);
        s.id.clone()
    }

    /// Backdate a log, so "newest first" is testable without sleeping.
    fn age(dir: &Path, id: &str, by: Duration) {
        let path = dir.join(format!("{id}.jsonl"));
        let f = fs::File::options().write(true).open(&path).unwrap();
        f.set_modified(std::time::SystemTime::now() - by).unwrap();
    }

    fn dirs_for(name: &str) -> (ChatDirs, PathBuf) {
        let active = super::super::test_dir(name);
        let other = super::super::test_dir(&format!("{name}-other"));
        let dirs = ChatDirs {
            active: active.clone(),
            all: vec![
                ChatDir {
                    name: "Active".into(),
                    dir: active.clone(),
                },
                ChatDir {
                    name: "Other".into(),
                    dir: other.clone(),
                },
            ],
        };
        (dirs, other)
    }

    async fn call(tool: &dyn Tool, input: Value) -> Result<String, String> {
        tool.call(input, &CancellationToken::new()).await
    }

    /// Ranked, not newest first: the older chat that says the word on both
    /// sides outranks the newer one that says it once, and the line carries
    /// title, date, score and an excerpt addressed to a model.
    #[tokio::test]
    async fn search_ranks_the_chat_that_says_it_most_first_with_an_excerpt() {
        let (dirs, _) = dirs_for("chats-search");
        let old = logged(
            &dirs.active,
            "Rewinding",
            "how do I rewind a session?",
            "A rewind is a marker that supersedes.",
            "",
        );
        age(&dirs.active, &old, Duration::from_secs(3600));
        let new = logged(
            &dirs.active,
            "Also going back",
            "rewind again, please",
            "Done.",
            "",
        );
        logged(&dirs.active, "Unrelated", "a question", "an answer", "");

        let out = call(&SearchChats::new(dirs.clone()), json!({"query": "REWIND"}))
            .await
            .unwrap();
        assert!(
            out.starts_with("2 chats in the chats of Active mention"),
            "{out}"
        );
        assert!(out.contains("best first"), "{out}");
        let lines: Vec<&str> = out.lines().skip(1).collect();
        assert_eq!(lines.len(), 2, "{out}");
        assert!(lines[0].starts_with(&short_id(&old)), "{out}");
        assert!(lines[1].starts_with(&short_id(&new)), "{out}");
        assert!(lines[0].contains("Rewinding"), "{out}");
        assert!(
            lines[1].contains(&Utc::now().format("%Y-%m-%d").to_string()),
            "{out}"
        );
        assert!(lines[0].contains("user: how do I rewind"), "{out}");
        // The score is a number the model can compare across lines.
        let score = |line: &str| -> f64 { line.split(" · ").nth(3).unwrap().parse().unwrap() };
        assert!(score(lines[0]) > score(lines[1]), "{out}");

        // A word in the name outranks the same word once in a body: the
        // title is the most compressed statement of what a chat was about.
        let named = logged(&dirs.active, "Kestrels", "a question", "a reply", "");
        logged(&dirs.active, "Birds", "kestrels are birds", "they are", "");
        let out = call(
            &SearchChats::new(dirs.clone()),
            json!({"query": "kestrels"}),
        )
        .await
        .unwrap();
        assert!(out.starts_with("2 chats"), "{out}");
        assert!(
            out.lines().nth(1).unwrap().starts_with(&short_id(&named)),
            "{out}"
        );
        // Nothing in the body says it, so the excerpt is the chat's opening.
        assert!(out.contains("user: a question"), "{out}");

        let out = call(
            &SearchChats::new(dirs.clone()),
            json!({"query": "rewind", "limit": 1}),
        )
        .await
        .unwrap();
        assert_eq!(out.lines().count(), 2, "limit: {out}");
        assert!(out.contains("the best 1"), "{out}");
        assert!(
            dirs.active.join(index::INDEX_FILE).is_file(),
            "no index written"
        );
    }

    /// A query the index has no word for is matched as text, newest first,
    /// as the first version did, and the header says so.
    #[tokio::test]
    async fn a_query_with_no_word_falls_back_to_the_substring_scan() {
        let (dirs, _) = dirs_for("chats-fallback");
        let old = logged(&dirs.active, "Arrows", "a → b", "yes", "");
        age(&dirs.active, &old, Duration::from_secs(3600));
        let new = logged(&dirs.active, "More arrows", "b → c", "yes", "");
        let out = call(&SearchChats::new(dirs), json!({"query": "→"}))
            .await
            .unwrap();
        assert!(out.contains("matched as text"), "{out}");
        assert!(out.contains("newest first"), "{out}");
        let lines: Vec<&str> = out.lines().skip(1).collect();
        assert!(lines[0].starts_with(&short_id(&new)), "{out}");
        assert!(lines[1].starts_with(&short_id(&old)), "{out}");
        assert!(lines[0].contains(" · 1 · "), "{out}");
    }

    #[tokio::test]
    async fn an_empty_query_is_refused_and_a_miss_names_its_scope() {
        let (dirs, _) = dirs_for("chats-empty");
        logged(&dirs.active, "Something", "something", "anything", "");
        let tool = SearchChats::new(dirs);
        let err = call(&tool, json!({"query": "   "})).await.unwrap_err();
        assert!(err.contains("query"), "{err}");
        let out = call(&tool, json!({"query": "absent"})).await.unwrap();
        assert!(
            out.starts_with("no chats in the chats of Active mention"),
            "{out}"
        );
        assert!(out.contains("scope: all"), "{out}");
    }

    #[tokio::test]
    async fn all_scope_reaches_the_other_projects_and_names_them() {
        let (dirs, other) = dirs_for("chats-scope");
        logged(&dirs.active, "Here", "here", "yes", "");
        logged(&other, "There", "there is a needle", "yes", "");
        let tool = SearchChats::new(dirs);
        let out = call(&tool, json!({"query": "needle"})).await.unwrap();
        assert!(out.starts_with("no chats"), "project scope only: {out}");
        let out = call(&tool, json!({"query": "needle", "scope": "all"}))
            .await
            .unwrap();
        assert!(out.contains("[Other] There"), "{out}");
        let err = call(&tool, json!({"query": "needle", "scope": "everywhere"}))
            .await
            .unwrap_err();
        assert!(err.contains("project or all"), "{err}");
    }

    /// Searching never looks at tool output, and neither does reading.
    #[tokio::test]
    async fn neither_tool_returns_a_tool_result() {
        let (dirs, _) = dirs_for("chats-tool-results");
        let id = logged(
            &dirs.active,
            "Config check",
            "check the config",
            "It looks fine.",
            "max_rounds = 24\nlicense = MIT",
        );
        let search = SearchChats::new(dirs.clone());
        assert!(
            call(&search, json!({"query": "max_rounds"}))
                .await
                .unwrap()
                .starts_with("no chats")
        );
        let out = call(&ReadChat::new(dirs), json!({"session": short_id(&id)}))
            .await
            .unwrap();
        assert!(!out.contains("max_rounds"), "{out}");
        assert!(
            !out.contains("parsnips"),
            "thinking is not conversation: {out}"
        );
        assert!(out.contains("user ("), "{out}");
        assert!(out.contains("assistant ("), "{out}");
    }

    #[tokio::test]
    async fn read_chat_windows_around_the_query_and_respects_max_chars() {
        let (dirs, _) = dirs_for("chats-window");
        let long = format!(
            "{}the needle{}",
            "padding ".repeat(1000),
            " and after".repeat(100)
        );
        let id = logged(&dirs.active, "Long one", "a short opener", &long, "");
        let tool = ReadChat::new(dirs);

        let out = call(&tool, json!({"session": short_id(&id)}))
            .await
            .unwrap();
        assert!(
            out.starts_with(&format!("chat {} · Long one · ", short_id(&id))),
            "{out}"
        );
        assert!(out.contains("user ("), "{out}");
        assert!(
            !out.contains("needle"),
            "default window is the start: {out}"
        );
        assert!(out.contains("characters shown"), "{out}");

        let out = call(
            &tool,
            json!({"session": short_id(&id), "query": "THE NEEDLE", "max_chars": 200}),
        )
        .await
        .unwrap();
        assert!(out.contains("the needle"), "{out}");
        assert!(
            out.contains("assistant (") && out.contains("continued: …"),
            "{out}"
        );
        let body = out.lines().nth(2).unwrap_or_default();
        assert!(body.chars().count() < 300, "{}", body.chars().count());

        let err = call(&tool, json!({"session": short_id(&id), "query": "absent"}))
            .await
            .unwrap_err();
        assert!(err.contains("without query"), "{err}");
    }

    #[tokio::test]
    async fn an_unknown_prefix_is_an_error_the_model_can_act_on() {
        let (dirs, _) = dirs_for("chats-unknown");
        logged(&dirs.active, "Known", "known", "yes", "");
        let tool = ReadChat::new(dirs);
        let err = call(&tool, json!({"session": "zzzzzzzz"}))
            .await
            .unwrap_err();
        assert!(err.contains("search_chats"), "{err}");
        let err = call(&tool, json!({"session": ""})).await.unwrap_err();
        assert!(err.contains("session"), "{err}");
    }

    /// A chat in another project is readable by the id a scope-all search
    /// returned, without saying which project again.
    #[tokio::test]
    async fn read_chat_resolves_across_projects() {
        let (dirs, other) = dirs_for("chats-across");
        let id = logged(&other, "Elsewhere", "over here", "indeed", "");
        let out = call(&ReadChat::new(dirs), json!({"session": short_id(&id)}))
            .await
            .unwrap();
        assert!(out.contains("Elsewhere"), "{out}");
    }

    // ---- measurements, on the real corpora; `--ignored --nocapture` --------

    /// From `$HOME` rather than `config_dir()`, which `test_dir` repoints at
    /// the temp tree for the whole process.
    fn real(project: &str) -> Option<PathBuf> {
        let dir = PathBuf::from(std::env::var_os("HOME")?)
            .join(".nightloom")
            .join("projects")
            .join(project)
            .join(crate::project::SESSIONS_DIR);
        dir.is_dir().then_some(dir)
    }

    /// `store::search` over the two real corpora, first run then repeats.
    /// "Cold" is only as cold as the OS page cache happens to be; a test
    /// cannot drop it.
    #[test]
    #[ignore]
    fn latency_over_the_real_corpora() {
        for (name, id) in [
            ("Unfiled chats", "c84a6276-0d2c-4394-bbe4-f0dbc196a3bb"),
            (
                "Value Generalization",
                "513c3418-df79-48f9-976d-cdae760ee6cc",
            ),
        ] {
            let Some(dir) = real(id) else {
                println!("{name}: not on this machine");
                continue;
            };
            let logs = store::count(&dir);
            for query in ["moral uncertainty", "resume", "experiment"] {
                let mut times = Vec::new();
                let mut hits = 0;
                for _ in 0..4 {
                    let t = std::time::Instant::now();
                    hits = store::search(&dir, query).unwrap().len();
                    times.push(t.elapsed().as_millis());
                }
                println!(
                    "{name} ({logs} logs) {query:?}: {hits} hits; first {} ms, then {:?} ms",
                    times[0],
                    &times[1..]
                );
            }
        }
    }

    /// The index over the two real corpora: a cold build (the file removed
    /// first — it is derived data and comes straight back), a warm load with
    /// nothing changed, one ranking, and the file's size.
    #[test]
    #[ignore]
    fn index_timings_over_the_real_corpora() {
        for (name, id) in [
            ("Unfiled chats", "c84a6276-0d2c-4394-bbe4-f0dbc196a3bb"),
            (
                "Value Generalization",
                "513c3418-df79-48f9-976d-cdae760ee6cc",
            ),
        ] {
            let Some(dir) = real(id) else {
                println!("{name}: not on this machine");
                continue;
            };
            let logs = store::count(&dir);
            fs::remove_file(dir.join(index::INDEX_FILE)).ok();
            let t = std::time::Instant::now();
            let built = ChatIndex::load_or_build(&dir).unwrap();
            let cold = t.elapsed().as_millis();
            let mut warm = Vec::new();
            for _ in 0..3 {
                let t = std::time::Instant::now();
                ChatIndex::load_or_build(&dir).unwrap();
                warm.push(t.elapsed().as_millis());
            }
            let mut ranks = Vec::new();
            for query in ["moral uncertainty", "resume", "experimental design"] {
                let t = std::time::Instant::now();
                let (_, total) = built.rank(query, MAX_LIMIT);
                ranks.push((query, total, t.elapsed().as_micros()));
            }
            let size = fs::metadata(dir.join(index::INDEX_FILE))
                .map(|m| m.len())
                .unwrap_or(0);
            println!(
                "{name} ({logs} logs, {} indexed): cold build {cold} ms; warm load {warm:?} ms; \
                 rank {ranks:?} (query, chats matched, µs); file {size} bytes",
                built.len()
            );
        }
    }

    /// The ten questions from the spec, with the same query strings the
    /// first version's measurement used, through the index — rank, title
    /// and score only, since the titles are what the report may quote.
    #[test]
    #[ignore]
    fn ten_questions_over_value_generalization() {
        let Some(dir) = real("513c3418-df79-48f9-976d-cdae760ee6cc") else {
            println!("Value Generalization: not on this machine");
            return;
        };
        let index = ChatIndex::load_or_build(&dir).unwrap();
        for query in [
            "legal neg",
            "rational choice",
            "luck surface",
            "lesswrong",
            "experimental design",
            "competitor",
            "reading list",
            "revealing ip",
            "moral uncertainty",
            "resume",
        ] {
            let (hits, total) = index.rank(query, MAX_LIMIT);
            println!("=== {query:?}: {total} chats");
            for (i, h) in hits.iter().enumerate() {
                println!(
                    "{:>2}. {:.2}  {}",
                    i + 1,
                    h.score,
                    h.log.label(&h.path, TITLE_WIDTH)
                );
            }
        }
    }
}
