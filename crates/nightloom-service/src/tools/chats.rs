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
use crate::store::index::{self, ChatIndex, Filter, Speaker};
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
/// Turns either side of the one `read_chat` is asked for (item 749).
const DEFAULT_NEIGHBOURS: usize = 1;
const MAX_NEIGHBOURS: usize = 5;
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
     matter. Scored per turn (a user message and its replies), so a long chat that discussed \
     it in a few turns ranks by those turns. Returns one line per chat, best first: short id, \
     title, date last active, score, the best turn's number and date, and an excerpt from that \
     turn. Then call read_chat with the id and that turn to read it with its neighbours. after \
     and before (YYYY-MM-DD) keep only turns from that range; with them and no query, it \
     lists the chats active in the range instead, newest first — for questions like 'what \
     did we do yesterday'. speaker counts only the user's words or only the assistant's. scope is the open project's chats by default; all searches every \
     project and the unfiled chats; chain searches only this chat's hand-off chain — the chats \
     it continues from (each started from the one before when it filled up) and any that \
     continue it, which are one long conversation cut into pieces — with no recency discount, \
     each line labelled by how many hand-offs back it is; give session to search the chain of \
     another chat instead. When you use something you found, cite the chat by its title and \
     date.";

const READ_DESC: &str = "Read part of one of the user's other chats, found with search_chats. \
     session is the short id from a result line. With query, returns a window of the \
     conversation centred on the first message containing it; without, the start of the \
     conversation. With turn (the number on a search_chats line), only that turn and \
     neighbours turns either side of it (default 1), so a hit deep in a long chat is read in \
     its context. Each message is prefixed user: or assistant: with its date; tool results are \
     never included. max_chars bounds the window (default 6000, at most 20000) — ask for more \
     only when the passage is long, and call again with a different query rather than paging \
     through a whole chat. The first line names the chat's title and date: cite both when you \
     quote or rely on what you read.";

/// The `search_chats` tool.
pub struct SearchChats {
    dirs: ChatDirs,
    /// The chat asking, when the shell knows it (item 737): where
    /// `scope: chain` starts when the model names no chat. The Claude Code
    /// engine's server is told it before every turn; the in-process tools
    /// are built before a session exists and go without.
    current: Option<String>,
}

impl SearchChats {
    pub fn new(dirs: ChatDirs) -> Self {
        Self {
            dirs,
            current: None,
        }
    }

    /// The same tool, knowing which chat is asking.
    pub fn in_chat(mut self, current: Option<String>) -> Self {
        self.current = current.filter(|c| store::is_log_id(c));
        self
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
                        "description": "A few distinctive words the chat would have said; case-insensitive, any order. May be omitted when after or before is given, to list the chats active then."
                    },
                    "after": {
                        "type": "string",
                        "description": "YYYY-MM-DD: only turns on or after this day (local time)."
                    },
                    "before": {
                        "type": "string",
                        "description": "YYYY-MM-DD: only turns before this day (local time)."
                    },
                    "speaker": {
                        "type": "string",
                        "enum": ["user", "assistant"],
                        "description": "Count only what the user said, or only what the assistant said."
                    },
                    "scope": {
                        "type": "string",
                        "enum": ["project", "all", "chain"],
                        "description": "project (default): the open project's chats. all: every project and the unfiled chats. chain: this chat's hand-off chain only — the earlier chats it continues and any later ones."
                    },
                    "session": {
                        "type": "string",
                        "description": "With scope chain: a chat id (or the short id from a result line) whose chain to search, instead of this chat's."
                    },
                    "limit": {
                        "type": "integer",
                        "description": "How many chats to return, best first. Default 10, at most 25."
                    }
                },
                "required": []
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
        let after = day(&input["after"], "after")?;
        let before = day(&input["before"], "before")?;
        let speaker = match input["speaker"].as_str() {
            None => None,
            Some("user") => Some(Speaker::User),
            Some("assistant") => Some(Speaker::Assistant),
            Some(other) => {
                return Err(format!("speaker must be user or assistant (got {other:?})"));
            }
        };
        let query = input["query"]
            .as_str()
            .map(str::trim)
            .filter(|q| !q.is_empty())
            .map(str::to_string);
        let query = match query {
            Some(q) => q,
            // Browsing by date needs no words.
            None if after.is_some() || before.is_some() => String::new(),
            None => {
                return Err(
                    "missing required argument: query — give a short distinctive phrase to \
                     look for, or after/before (YYYY-MM-DD) to list the chats active then"
                        .to_string(),
                );
            }
        };
        let opts = Opts {
            after,
            before,
            speaker,
        };
        let scope = match input["scope"].as_str() {
            None | Some("project") => Scope::Project,
            Some("all") => Scope::All,
            Some("chain") => Scope::Chain,
            Some(other) => {
                return Err(format!(
                    "scope must be project, all or chain (got {other:?})"
                ));
            }
        };
        let session = input["session"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        // Clamped rather than refused: a model that asks for fifty wants
        // "many", and a page is the most it can usefully read.
        let limit = input["limit"]
            .as_u64()
            .map_or(DEFAULT_LIMIT, |n| n as usize)
            .clamp(1, MAX_LIMIT);
        let dirs = self.dirs.clone();
        if scope == Scope::Chain {
            let current = self.current.clone();
            return blocking(move || {
                search_chain(
                    &dirs,
                    &query,
                    session.as_deref(),
                    current.as_deref(),
                    limit,
                    opts,
                )
            })
            .await;
        }
        blocking(move || search(&dirs, &query, scope, limit, opts)).await
    }
}

/// The search's limits beyond its words (item 749).
#[derive(Clone, Copy, Default, Debug)]
struct Opts {
    after: Option<DateTime<Utc>>,
    before: Option<DateTime<Utc>>,
    speaker: Option<Speaker>,
}

impl Opts {
    fn filter<'a>(&self, only: Option<&'a std::collections::BTreeSet<String>>) -> Filter<'a> {
        Filter {
            only,
            recency_prior: only.is_none(),
            after: self.after,
            before: self.before,
            speaker: self.speaker,
        }
    }

    /// What the header says about the limits, or nothing.
    fn said(&self) -> String {
        let mut out = String::new();
        if let Some(a) = self.after {
            out.push_str(&format!(
                " from {}",
                a.with_timezone(&chrono::Local).format("%Y-%m-%d")
            ));
        }
        if let Some(b) = self.before {
            out.push_str(&format!(
                " before {}",
                b.with_timezone(&chrono::Local).format("%Y-%m-%d")
            ));
        }
        match self.speaker {
            Some(Speaker::User) => out.push_str(", the user's words only"),
            Some(Speaker::Assistant) => out.push_str(", the assistant's words only"),
            None => {}
        }
        out
    }
}

/// A `YYYY-MM-DD` argument as the start of that day, local time.
fn day(v: &Value, name: &str) -> Result<Option<DateTime<Utc>>, String> {
    let Some(text) = v.as_str().map(str::trim).filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    let date = chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d")
        .map_err(|_| format!("{name} must be a date as YYYY-MM-DD (got {text:?})"))?;
    let midnight = date.and_hms_opt(0, 0, 0).expect("midnight exists");
    Ok(Some(
        midnight
            .and_local_timezone(chrono::Local)
            .earliest()
            .map_or_else(|| midnight.and_utc(), |t| t.with_timezone(&Utc)),
    ))
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Scope {
    Project,
    All,
    /// One chat's hand-off chain (item 737).
    Chain,
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
        // Never reached: a chain is walked by `search_chain`, which finds
        // its own directory.
        Scope::Chain => (Vec::new(), "this chat's hand-off chain".to_string()),
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
/// index; the header says which happened. No query with a date range is a
/// browse by date (item 749).
fn search(
    dirs: &ChatDirs,
    query: &str,
    scope: Scope,
    limit: usize,
    opts: Opts,
) -> Result<String, String> {
    let (covered, where_) = covered(dirs, scope);
    if query.is_empty() {
        return browse(&covered, &where_, limit, opts, None);
    }
    let words = index::tokenize(query);
    if words.is_empty() {
        return substring(&covered, &where_, query, scope, limit);
    }

    let mut hits = Vec::new();
    let mut total = 0;
    for (dir, project) in &covered {
        let index = ChatIndex::load_or_build(dir).map_err(|e| e.to_string())?;
        let (ranked, found) = index.rank_among(query, limit, Utc::now(), opts.filter(None));
        total += found;
        for r in ranked {
            hits.push(Hit::of(&r, project.clone(), None));
        }
    }
    // Across directories the scores are merged as they are. Each index has
    // its own idea of how rare a word is, so a hit from a small project can
    // outscore one from a large one for the same words — a known unfairness
    // in `all` scope, and the alternative is a second ranking pass over
    // every directory's statistics that nothing has asked for yet.
    hits.sort_by(|a, b| {
        b.score
            .unwrap_or(0.0)
            .total_cmp(&a.score.unwrap_or(0.0))
            .then_with(|| b.modified.cmp(&a.modified))
    });
    hits.truncate(limit);

    if hits.is_empty() {
        return Ok(nothing(&format!("{where_}{}", opts.said()), query, scope));
    }
    let shown = hits.len();
    let mut out = format!(
        "{total} chat{} in {where_}{} mention {query:?}{}, best first. Lines are: id · title · \
         last active · score · best turn · excerpt from it. Call read_chat with an id and \
         that turn to read it with its neighbours.\n",
        if total == 1 { "" } else { "s" },
        opts.said(),
        if shown < total {
            format!("; the best {shown}")
        } else {
            String::new()
        },
    );
    for hit in &hits {
        hit.line(&mut out, &words, opts);
    }
    Ok(out)
}

/// Each chain chat's label by file name (item 737).
type ChainPlaces = std::collections::HashMap<String, String>;

/// The chats with turns in a date range, newest first (item 749), for a
/// question with no words in it: "what did we do yesterday".
fn browse(
    covered: &[(&Path, Option<String>)],
    where_: &str,
    limit: usize,
    opts: Opts,
    chain: Option<(&std::collections::BTreeSet<String>, &ChainPlaces)>,
) -> Result<String, String> {
    let mut hits = Vec::new();
    let mut total = 0;
    for (dir, project) in covered {
        let index = ChatIndex::load_or_build(dir).map_err(|e| e.to_string())?;
        let (found, n) = index.browse(limit, opts.filter(chain.map(|c| c.0)));
        total += n;
        for (path, log, inside, first) in found {
            let place = chain.and_then(|c| file_name(&path).and_then(|f| c.1.get(&f).cloned()));
            hits.push((
                log.turn_at(first).unwrap_or_else(|| log.modified()),
                Hit {
                    id: log.id(&path),
                    title: log.label(&path, TITLE_WIDTH),
                    modified: log.modified(),
                    score: None,
                    in_range: inside,
                    project: project.clone(),
                    place,
                    turn: first,
                    turns: log.turn_count(),
                    turn_at: log.turn_at(first),
                    path,
                },
            ));
        }
    }
    // Newest activity in the range first, across directories too.
    hits.sort_by(|a, b| b.1.modified.cmp(&a.1.modified).then(b.0.cmp(&a.0)));
    hits.truncate(limit);
    if hits.is_empty() {
        return Ok(format!(
            "no chats in {where_} have turns{}. Try a wider range.",
            opts.said()
        ));
    }
    let shown = hits.len();
    let mut out = format!(
        "{total} chat{} in {where_} have turns{}{}, newest first. Lines are: id · title · last \
         active · turns in the range · the first of them · its opening. Call read_chat with an \
         id and that turn to read it with its neighbours.\n",
        if total == 1 { "" } else { "s" },
        opts.said(),
        if shown < total {
            format!("; the newest {shown}")
        } else {
            String::new()
        },
    );
    for (_, hit) in &hits {
        hit.line(&mut out, &[], opts);
    }
    Ok(out)
}

fn file_name(path: &Path) -> Option<String> {
    path.file_name().map(|n| n.to_string_lossy().into_owned())
}

/// A chat's place in a hand-off chain: 0 for the chat the walk started
/// from, -n for n hand-offs before it, +n for n after.
fn chain_label(steps: i32, from_current: bool) -> String {
    match steps {
        0 if from_current => "this chat".to_string(),
        0 => "the chat named".to_string(),
        -1 => "1 hand-off back".to_string(),
        1 => "1 hand-off on".to_string(),
        n if n < 0 => format!("{} hand-offs back", -n),
        n => format!("{n} hand-offs on"),
    }
}

/// The hand-off chain through the chat in `name`, as file names with their
/// steps from it: back through each chat's `forked_from` while its reason
/// is `handoff`, and on through every chat that continues one of these.
/// Within one directory: a hand-off starts the next chat beside the full
/// one (`Session::continued_from`). A link to a chat that is gone, or a
/// loop in damaged logs, ends the walk there.
fn chain_of(index: &ChatIndex, name: &str) -> Vec<(String, i32)> {
    use std::collections::{BTreeMap, HashSet};
    let mut by_id: BTreeMap<String, (String, Option<String>)> = BTreeMap::new();
    for (n, rec) in index.records() {
        by_id.insert(
            rec.id(&index.path_of(n)),
            (n.to_string(), rec.handoff_parent().map(str::to_string)),
        );
    }
    let mut children: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for (id, (_, parent)) in &by_id {
        if let Some(p) = parent {
            children.entry(p.as_str()).or_default().push(id.as_str());
        }
    }
    let Some(start) = by_id
        .iter()
        .find(|(_, (n, _))| n == name)
        .map(|(id, _)| id.clone())
    else {
        return vec![(name.to_string(), 0)];
    };
    let mut seen: HashSet<String> = HashSet::from([start.clone()]);
    let mut out = vec![(name.to_string(), 0)];
    let mut at = start.clone();
    let mut steps = 0;
    while let Some(parent) = by_id.get(&at).and_then(|(_, p)| p.clone()) {
        let Some((pname, _)) = by_id.get(&parent) else {
            break;
        };
        if !seen.insert(parent.clone()) {
            break;
        }
        steps -= 1;
        out.push((pname.clone(), steps));
        at = parent;
    }
    let mut frontier = vec![(start, 0)];
    while let Some((id, steps)) = frontier.pop() {
        for child in children.get(id.as_str()).into_iter().flatten() {
            if seen.insert(child.to_string()) {
                out.push((by_id[*child].0.clone(), steps + 1));
                frontier.push((child.to_string(), steps + 1));
            }
        }
    }
    out
}

/// `search_chats` with `scope: chain` (item 737, his question: "all the
/// chats that are technically a part of the same chat except arbitrarily
/// split up by 300k handoff checkpoints"): ranked as the other scopes are,
/// over only the chain's chats and without the recency prior, each line
/// labelled with its place in the chain.
fn search_chain(
    dirs: &ChatDirs,
    query: &str,
    session: Option<&str>,
    current: Option<&str>,
    limit: usize,
    opts: Opts,
) -> Result<String, String> {
    let Some(start) = session.or(current) else {
        return Err(
            "scope chain needs a chat to start from, and this engine does not say which \
             chat is asking: give session (a chat id, or the short id from a search_chats line)"
                .to_string(),
        );
    };
    let path = resolve(dirs, start)?;
    if store::mode_of(&path).unread_by_others() {
        return Err(format!(
            "that chat is incognito: it was started so that no other chat can read it, \
             and this one cannot ({start:?})"
        ));
    }
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let from_current = current == Some(stem.as_str());
    let dir = path.parent().unwrap_or(Path::new("."));
    let name = file_name(&path).unwrap_or_default();
    let index = ChatIndex::load_or_build(dir).map_err(|e| e.to_string())?;
    let chain = chain_of(&index, &name);
    let back = chain.iter().filter(|(_, s)| *s < 0).count();
    let on = chain.iter().filter(|(_, s)| *s > 0).count();
    let where_ = match (back, on) {
        (0, 0) => format!(
            "{} chat alone (it has no hand-offs either way)",
            if from_current { "this" } else { "that" }
        ),
        _ => format!(
            "the hand-off chain of {} chats ({back} before it, {on} after)",
            chain.len()
        ),
    };
    let only: std::collections::BTreeSet<String> = chain.iter().map(|(n, _)| n.clone()).collect();
    let places: ChainPlaces = chain
        .iter()
        .map(|(n, s)| (n.clone(), chain_label(*s, from_current)))
        .collect();
    if query.is_empty() {
        drop(index);
        return browse(&[(dir, None)], &where_, limit, opts, Some((&only, &places)));
    }
    let words = index::tokenize(query);
    if words.is_empty() {
        return Err(
            "scope chain ranks by words, and this query has none: use a few distinctive words"
                .to_string(),
        );
    }
    let (ranked, total) = index.rank_among(query, limit, Utc::now(), opts.filter(Some(&only)));
    if ranked.is_empty() {
        return Ok(format!(
            "no chat in {where_}{} mentions {query:?}. Try different or fewer words, or scope: \
             project for the other chats.",
            opts.said()
        ));
    }
    let shown = ranked.len();
    let mut out = format!(
        "{total} chat{} in {where_}{} mention {query:?}{}, best first, with no recency discount. \
         Lines are: id · [place in the chain] title · last active · score · best turn · excerpt \
         from it. Call read_chat with an id and that turn to read it with its neighbours.\n",
        if total == 1 { "" } else { "s" },
        opts.said(),
        if shown < total {
            format!("; the best {shown}")
        } else {
            String::new()
        },
    );
    for r in &ranked {
        let place = file_name(&r.path).and_then(|f| places.get(&f).cloned());
        Hit::of(r, None, place).line(&mut out, &words, opts);
    }
    Ok(out)
}

/// One chat in a result, owned, so the index it came out of can be dropped.
struct Hit {
    id: String,
    title: String,
    modified: DateTime<Utc>,
    path: PathBuf,
    /// The ranking's score; `None` in a browse by date.
    score: Option<f64>,
    /// In a browse, how many of its turns fall in the range.
    in_range: usize,
    project: Option<String>,
    /// Its place in a hand-off chain.
    place: Option<String>,
    /// The best turn (or, browsing, the first in range), of how many.
    turn: usize,
    turns: usize,
    turn_at: Option<DateTime<Utc>>,
}

impl Hit {
    fn of(r: &index::Ranked<'_>, project: Option<String>, place: Option<String>) -> Hit {
        Hit {
            id: r.log.id(&r.path),
            title: r.log.label(&r.path, TITLE_WIDTH),
            modified: r.log.modified(),
            path: r.path.clone(),
            score: Some(r.score),
            in_range: r.matched,
            project,
            place,
            turn: r.turn,
            turns: r.log.turn_count(),
            turn_at: r.log.turn_at(r.turn),
        }
    }

    /// The result line. A log gone between the ranking and the read is a
    /// row that is going away, as in `store::list`, not a failed search.
    fn line(&self, out: &mut String, words: &[String], opts: Opts) {
        let Some(excerpt) = turn_excerpt(&self.path, self.modified, self.turn, words, opts.speaker)
        else {
            return;
        };
        out.push_str(&format!(
            "{} · {}{}{} · {} · {} · turn {} of {}{} · {}\n",
            short_id(&self.id),
            self.project
                .as_deref()
                .map(|p| format!("[{p}] "))
                .unwrap_or_default(),
            self.place
                .as_deref()
                .map(|p| format!("[{p}] "))
                .unwrap_or_default(),
            if self.title.is_empty() {
                "(untitled)"
            } else {
                &self.title
            },
            self.modified.format("%Y-%m-%d"),
            match self.score {
                Some(score) => format!("{score:.2}"),
                None => format!(
                    "{} turn{}",
                    self.in_range,
                    if self.in_range == 1 { "" } else { "s" }
                ),
            },
            self.turn + 1,
            self.turns.max(1),
            self.turn_at
                .map(|t| format!(" ({})", t.format("%Y-%m-%d")))
                .unwrap_or_default(),
            excerpt,
        ));
    }
}

/// Each conversational message of a log with its turn's index, numbered as
/// the index numbers them (item 749): a user message opens a turn, and a
/// reply before any user message opens the first.
fn turns_of(events: &[nightloom_core::SessionEvent]) -> Vec<(usize, store::Said<'_>)> {
    let mut turn: Option<usize> = None;
    events
        .iter()
        .filter_map(store::said)
        .filter(|s| s.conversation)
        .map(|s| {
            if s.who == "you" || turn.is_none() {
                turn = Some(turn.map_or(0, |t| t + 1));
            }
            (turn.unwrap_or(0), s)
        })
        .collect()
}

/// Text from turn `turn` around the first of the query's words it says,
/// prefixed with who said it — on the speaker's side only when the search
/// was limited to one. The index keeps counts and not positions, so this
/// is the read that shows *why* a chat ranked. When no word is found as a
/// substring — the ranking matched on the title alone, which the line
/// already shows — the turn's opening stands in, then the chat's. `None`
/// for a log that could not be read.
fn turn_excerpt(
    path: &Path,
    modified: DateTime<Utc>,
    turn: usize,
    words: &[String],
    speaker: Option<Speaker>,
) -> Option<String> {
    let (_, events) = store::scan(path, modified).ok()?;
    let side = |who: &str| match speaker {
        Some(Speaker::User) => who == "you",
        Some(Speaker::Assistant) => who == "model",
        None => true,
    };
    let said = turns_of(&events);
    let mut opening = None;
    for (t, s) in said
        .iter()
        .filter(|(t, s)| *t == turn && !s.text.trim().is_empty())
    {
        let _ = t;
        if !side(s.who) {
            continue;
        }
        if let Some(at) = words
            .iter()
            .filter_map(|w| store::find_fold(&s.text, w))
            .min()
        {
            return Some(relabel(&format!(
                "{}: {}",
                s.who,
                store::excerpt_around(&s.text, at, store::EXCERPT_WIDTH)
            )));
        }
        opening.get_or_insert_with(|| {
            relabel(&format!(
                "{}: {}",
                s.who,
                store::excerpt_around(&s.text, 0, store::EXCERPT_WIDTH)
            ))
        });
    }
    if opening.is_none() {
        opening = said
            .iter()
            .find(|(_, s)| !s.text.trim().is_empty())
            .map(|(_, s)| {
                relabel(&format!(
                    "{}: {}",
                    s.who,
                    store::excerpt_around(&s.text, 0, store::EXCERPT_WIDTH)
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
            // The sidebar's scan finds an incognito chat for the user, who
            // owns it; this reader is another chat, which may not. The
            // ranked path above never gets this far — the index holds no
            // term for such a log — so the fallback has to draw the same
            // line itself.
            if found.summary.mode.unread_by_others() {
                continue;
            }
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

/// What the server tells a chat that continues another (item 749): that
/// an earlier chat holds what came before, and how to reach it without
/// filling this one — `scope: chain`, or a subagent sent to read it. `None`
/// for a chat that is not a hand-off's continuation, or not found in `dir`.
pub fn handoff_note(dir: &Path, current: &str) -> Option<String> {
    use std::io::BufRead;
    if !store::is_log_id(current) {
        return None;
    }
    let path = store::find_by_prefix(dir, current).ok()?;
    let mut first = String::new();
    std::io::BufReader::new(fs::File::open(path).ok()?)
        .read_line(&mut first)
        .ok()?;
    let nightloom_core::SessionEvent::SessionCreated {
        forked_from: Some(from),
        ..
    } = serde_json::from_str(first.trim_end()).ok()?
    else {
        return None;
    };
    if from.reason.as_deref() != Some("handoff") {
        return None;
    }
    Some(format!(
        " This chat continues an earlier one (chat {}) that was handed off when its context \
         filled, and that one may continue others: they are one conversation cut into pieces. \
         When the user refers to something from before this chat, search them with \
         search_chats scope chain before asking; to go through the earlier chat in depth, send \
         a subagent to read it with read_chat (session {}) and report what matters, so its \
         text does not fill this window.",
        short_id(&from.session),
        short_id(&from.session),
    ))
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
                    },
                    "turn": {
                        "type": "integer",
                        "description": "The turn number from a search_chats line: read that turn and its neighbours."
                    },
                    "neighbours": {
                        "type": "integer",
                        "description": "With turn: how many turns before and after it to include. Default 1, at most 5."
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
        // 1-based as the search line prints it; 0 reads as the first.
        let turns = input["turn"].as_u64().map(|t| {
            let at = (t as usize).saturating_sub(1);
            let n = input["neighbours"]
                .as_u64()
                .map_or(DEFAULT_NEIGHBOURS, |n| n as usize)
                .min(MAX_NEIGHBOURS);
            (at.saturating_sub(n), at + n)
        });
        let dirs = self.dirs.clone();
        blocking(move || read(&dirs, &session, query.as_deref(), max_chars, turns)).await
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
    turns: Option<(usize, usize)>,
) -> Result<String, String> {
    let path = resolve(dirs, prefix)?;
    // Refused by id as well as hidden from search: a model that has the id
    // from the user, or from a result line written before the chat was
    // started as incognito, still gets no window onto it. The first line
    // says so before the log is read.
    if store::mode_of(&path).unread_by_others() {
        return Err(format!(
            "that chat is incognito: it was started so that no other chat can read it, \
             and this one cannot ({prefix:?})"
        ));
    }
    let modified: DateTime<Utc> = fs::metadata(&path)
        .and_then(|m| m.modified())
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?
        .into();
    let (summary, events) = store::scan(&path, modified).map_err(|e| e.to_string())?;

    // The same filter as the search, minus the title, which goes in the
    // header. A reply that was nothing but tool calls has no text and is
    // skipped rather than printed as an empty `assistant:` line.
    let numbered = turns_of(&events);
    let total_turns = numbered.last().map_or(0, |(t, _)| t + 1);
    let messages: Vec<Message> = numbered
        .into_iter()
        .filter(|(t, _)| turns.is_none_or(|(a, b)| (a..=b).contains(t)))
        .map(|(_, s)| s)
        .filter(|s| !s.text.trim().is_empty())
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
        "chat {} · {title} · last active {} · {} messages{}\n\n",
        short_id(&summary.id),
        modified.format("%Y-%m-%d"),
        messages.len(),
        match turns {
            Some((a, b)) => format!(
                " · turns {}–{} of {total_turns}",
                a + 1,
                (b + 1).min(total_turns.max(1))
            ),
            None => String::new(),
        },
    );
    if messages.is_empty() {
        out.push_str(if turns.is_some() {
            "(nothing was said in those turns)\n"
        } else {
            "(nothing was said in this chat)\n"
        });
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
        assert!(err.contains("project, all or chain"), "{err}");
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

    /// An incognito chat is invisible to both tools: absent from the ranked
    /// search and from the substring fallback (a query with no word in it),
    /// and refused by `read_chat` with a sentence that says why, by the
    /// short id and the full one — while the ordinary chat beside it is
    /// found and read as before.
    #[tokio::test]
    async fn an_incognito_chat_is_hidden_from_search_and_refused_by_read() {
        let (dirs, _) = dirs_for("chats-incognito");
        let mut inc = Session::incognito(&dirs.active).unwrap();
        inc.record_user("the secret word is xylophone ★");
        inc.record_assistant(
            "m",
            vec![ContentBlock::Text {
                text: "xylophone ★ noted".into(),
            }],
            Some("end_turn".into()),
            Usage::default(),
        );
        inc.record_title("Xylophone plans");
        let plain = logged(
            &dirs.active,
            "Ordinary",
            "an ordinary question",
            "an answer",
            "",
        );

        let search = SearchChats::new(dirs.clone());
        let out = call(&search, json!({"query": "xylophone"})).await.unwrap();
        assert!(!out.contains("Xylophone"), "ranked: {out}");
        assert!(
            out.contains("No chat") || out.contains("0 chat") || !out.contains(&short_id(&inc.id)),
            "{out}"
        );
        // A lone symbol has no word to rank by and goes to the substring
        // scan, which has to draw the same line.
        let out = call(&search, json!({"query": "★"})).await.unwrap();
        assert!(!out.contains(&short_id(&inc.id)), "substring: {out}");
        let out = call(&search, json!({"query": "ordinary"})).await.unwrap();
        assert!(out.contains(&short_id(&plain)), "{out}");

        let read = ReadChat::new(dirs);
        for id in [short_id(&inc.id), inc.id.clone()] {
            let err = call(&read, json!({"session": id})).await.unwrap_err();
            assert!(err.contains("that chat is incognito"), "{err}");
            assert!(!err.contains("xylophone"), "the refusal leaks: {err}");
        }
        let out = call(&read, json!({"session": short_id(&plain)}))
            .await
            .unwrap();
        assert!(out.contains("an ordinary question"), "{out}");
    }

    /// Item 737: `scope: chain` searches the chats a hand-off chain is cut
    /// into and nothing else, labels each by its place, and drops the
    /// recency prior; it starts from the chat asking, or from `session`.
    #[tokio::test]
    async fn chain_scope_follows_the_hand_offs_and_labels_each_chat() {
        let (dirs, _) = dirs_for("chats-chain");
        let say = |s: &mut Session, user: &str, title: &str| {
            s.record_user(user);
            s.record_assistant(
                "m",
                vec![ContentBlock::Text {
                    text: "noted".into(),
                }],
                Some("end_turn".into()),
                Usage::default(),
            );
            s.record_title(title);
        };
        let mut first = Session::with_log(&dirs.active).unwrap();
        say(
            &mut first,
            "the pelican migration plan, in detail",
            "Part one",
        );
        let mut second = first.continued_from(&dirs.active).unwrap();
        say(&mut second, "now the otters", "Part two");
        let mut third = second.continued_from(&dirs.active).unwrap();
        say(&mut third, "and the finale", "Part three");
        // Old, so a recency prior would have buried it under the newer
        // outsider in project scope.
        age(&dirs.active, &first.id, Duration::from_secs(120 * 86_400));
        let outsider = logged(&dirs.active, "Pelicans", "pelican pelican", "yes", "");

        let tool = SearchChats::new(dirs.clone()).in_chat(Some(third.id.clone()));
        let out = call(&tool, json!({"query": "pelican", "scope": "chain"}))
            .await
            .unwrap();
        assert!(
            out.starts_with("1 chat in the hand-off chain of 3 chats (2 before it, 0 after)"),
            "{out}"
        );
        assert!(out.contains("no recency discount"), "{out}");
        let lines: Vec<&str> = out.lines().skip(1).collect();
        assert_eq!(lines.len(), 1, "{out}");
        assert!(lines[0].starts_with(&short_id(&first.id)), "{out}");
        assert!(lines[0].contains("[2 hand-offs back] Part one"), "{out}");
        assert!(!out.contains(&short_id(&outsider)), "{out}");

        let out = call(&tool, json!({"query": "finale", "scope": "chain"}))
            .await
            .unwrap();
        assert!(out.contains("[this chat] Part three"), "{out}");

        // From a named chat, forward: the later pieces are "on".
        let plain = SearchChats::new(dirs.clone());
        let out = call(
            &plain,
            json!({"query": "otters", "scope": "chain", "session": short_id(&first.id)}),
        )
        .await
        .unwrap();
        assert!(out.contains("(0 before it, 2 after)"), "{out}");
        assert!(out.contains("[1 hand-off on] Part two"), "{out}");

        // Nothing to start from.
        let err = call(&plain, json!({"query": "pelican", "scope": "chain"}))
            .await
            .unwrap_err();
        assert!(err.contains("give session"), "{err}");

        // A chat with no hand-offs is searched alone, and says so.
        let out = call(
            &plain,
            json!({"query": "pelican", "scope": "chain", "session": short_id(&outsider)}),
        )
        .await
        .unwrap();
        assert!(out.contains("that chat alone"), "{out}");

        // Project scope is unchanged: both, the outsider first.
        let out = call(&plain, json!({"query": "pelican"})).await.unwrap();
        assert!(
            out.lines()
                .nth(1)
                .unwrap()
                .starts_with(&short_id(&outsider)),
            "{out}"
        );
        assert!(out.contains(&short_id(&first.id)), "{out}");
    }

    /// A chat of turns, each `(day, user, reply)`, its messages dated to
    /// noon UTC on that day by rewriting the log the engine wrote.
    fn dated(dir: &Path, title: &str, turns: &[(&str, &str, &str)]) -> String {
        let mut s = Session::with_log(dir).unwrap();
        for (_, user, reply) in turns {
            s.record_user(*user);
            s.record_assistant(
                "m",
                vec![ContentBlock::Text {
                    text: (*reply).into(),
                }],
                Some("end_turn".into()),
                Usage::default(),
            );
        }
        s.record_title(title);
        let path = dir.join(format!("{}.jsonl", s.id));
        let mut k = 0usize;
        let mut day = "";
        let body: Vec<String> = fs::read_to_string(&path)
            .unwrap()
            .lines()
            .map(|l| {
                let mut v: Value = serde_json::from_str(l).unwrap();
                match v["event"].as_str() {
                    Some("user_message") => {
                        day = turns[k].0;
                        k += 1;
                        v["at"] = json!(format!("{day}T12:00:00Z"));
                    }
                    Some("assistant_message") => v["at"] = json!(format!("{day}T12:00:00Z")),
                    _ => {}
                }
                v.to_string()
            })
            .collect();
        fs::write(&path, body.join("\n") + "\n").unwrap();
        s.id.clone()
    }

    /// Item 749: a long chat that discussed something in one turn of many
    /// outranks a short one that says a word in passing, and its line
    /// names that turn and quotes it.
    #[tokio::test]
    async fn a_long_chat_ranks_by_its_best_turn_and_names_it() {
        let (dirs, _) = dirs_for("chats-turns");
        let filler = "we talked about the weather and the garden and the bus timetable";
        let mut long: Vec<(&str, &str, &str)> = vec![("2026-11-01", filler, filler); 40];
        long[20] = (
            "2026-11-01",
            "the kestrel nesting boxes need moving",
            "move the kestrel nesting boxes east",
        );
        let deep = dated(&dirs.active, "Long one", &long);
        let passing = format!("{filler} kestrel {filler} nesting {filler}");
        let short = dated(&dirs.active, "Short one", &[("2026-11-01", &passing, "ok")]);
        let out = call(
            &SearchChats::new(dirs.clone()),
            json!({"query": "kestrel nesting"}),
        )
        .await
        .unwrap();
        let lines: Vec<&str> = out.lines().skip(1).collect();
        assert!(lines[0].starts_with(&short_id(&deep)), "{out}");
        assert!(lines[0].contains("turn 21 of 40 (2026-11-01)"), "{out}");
        assert!(
            lines[0].contains("user: the kestrel nesting boxes"),
            "{out}"
        );
        assert!(lines[1].starts_with(&short_id(&short)), "{out}");

        // read_chat reads that turn with its neighbours and nothing else.
        let read = ReadChat::new(dirs.clone());
        let out = call(
            &read,
            json!({"session": short_id(&deep), "turn": 21, "neighbours": 1}),
        )
        .await
        .unwrap();
        assert!(out.contains("turns 20–22 of 40"), "{out}");
        assert!(out.contains("kestrel nesting boxes need moving"), "{out}");
        assert_eq!(out.matches("user (").count(), 3, "{out}");
    }

    /// Item 749: after/before keep only turns from the range; no query with
    /// a range browses by date; speaker counts one side only.
    #[tokio::test]
    async fn dates_speaker_and_browsing_by_date() {
        let (dirs, _) = dirs_for("chats-dates");
        let early = dated(
            &dirs.active,
            "Early",
            &[("2026-10-01", "the heron survey", "noted the heron")],
        );
        let both = dated(
            &dirs.active,
            "Both",
            &[
                ("2026-10-02", "something else entirely", "fine"),
                ("2026-10-20", "the heron again", "yes the heron"),
            ],
        );
        let told = dated(
            &dirs.active,
            "Told",
            &[("2026-10-21", "what bird was it", "it was a heron")],
        );
        let tool = SearchChats::new(dirs.clone());
        let out = call(&tool, json!({"query": "heron", "after": "2026-10-15"}))
            .await
            .unwrap();
        assert!(out.contains(" from 2026-10-15"), "{out}");
        assert!(!out.contains(&short_id(&early)), "{out}");
        assert!(out.contains(&short_id(&both)), "{out}");
        let out = call(&tool, json!({"query": "heron", "before": "2026-10-15"}))
            .await
            .unwrap();
        assert!(out.contains(&short_id(&early)), "{out}");
        assert!(!out.contains(&short_id(&both)), "{out}");

        let out = call(&tool, json!({"query": "heron", "speaker": "user"}))
            .await
            .unwrap();
        assert!(
            !out.contains(&short_id(&told)),
            "only the reply said it: {out}"
        );
        let out = call(&tool, json!({"query": "heron", "speaker": "assistant"}))
            .await
            .unwrap();
        assert!(out.contains("assistant: it was a heron"), "{out}");

        // Browse: no query, a range — newest activity first, with a count.
        let out = call(
            &tool,
            json!({"after": "2026-10-02", "before": "2026-10-21"}),
        )
        .await
        .unwrap();
        assert!(
            out.starts_with("1 chat in the chats of Active have turns"),
            "{out}"
        );
        assert!(
            out.contains(&short_id(&both)) && out.contains(" · 2 turns · "),
            "{out}"
        );
        let err = call(&tool, json!({})).await.unwrap_err();
        assert!(err.contains("after/before"), "{err}");
        let err = call(&tool, json!({"query": "heron", "after": "15 Oct"}))
            .await
            .unwrap_err();
        assert!(err.contains("YYYY-MM-DD"), "{err}");
    }

    /// Item 749: the server's note for a chat that continues another.
    #[test]
    fn a_handed_off_chat_is_told_where_the_rest_is() {
        let (dirs, _) = dirs_for("chats-note");
        let mut first = Session::with_log(&dirs.active).unwrap();
        first.record_user("hello");
        let mut next = first.continued_from(&dirs.active).unwrap();
        next.record_user("again");
        let note = handoff_note(&dirs.active, &next.id).unwrap();
        assert!(
            note.contains(&format!("chat {}", short_id(&first.id))),
            "{note}"
        );
        assert!(
            note.contains("scope chain") && note.contains("subagent"),
            "{note}"
        );
        assert_eq!(handoff_note(&dirs.active, &first.id), None);
        assert_eq!(handoff_note(&dirs.active, "nope"), None);
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

    /// Item 749's recall check, over copies of the real corpora (never the
    /// live directories: an index of another version written there would
    /// cost the running app a rebuild). `NIGHTLOOM_RECALL_ROOT` holds
    /// `<project id>/sessions/` copies; `NIGHTLOOM_RECALL_SET` is the JSON
    /// `bin/recall_set.py` writes. Prints rank of the expected chat only —
    /// no excerpt, no query text — through the tool's own output, so the
    /// same test measures any ranker. Then the 2026-09-14 ten questions,
    /// by title, in Value Generalization.
    #[test]
    #[ignore]
    fn recall_set_over_the_real_corpora() {
        let (Some(root), Some(set)) = (
            std::env::var_os("NIGHTLOOM_RECALL_ROOT").map(PathBuf::from),
            std::env::var_os("NIGHTLOOM_RECALL_SET").map(PathBuf::from),
        ) else {
            println!("set NIGHTLOOM_RECALL_ROOT and NIGHTLOOM_RECALL_SET");
            return;
        };
        let rank_of = |out: &str, id: &str| -> Option<usize> {
            out.lines()
                .skip(1)
                .position(|l| l.starts_with(&short_id(id)))
                .map(|i| i + 1)
        };
        let qs: Vec<Value> = serde_json::from_slice(&fs::read(set).unwrap()).unwrap();
        let (mut top1, mut top5, mut found) = (0, 0, 0);
        for (i, q) in qs.iter().enumerate() {
            let dir = root.join(q["project"].as_str().unwrap()).join("sessions");
            let dirs = ChatDirs {
                active: dir.clone(),
                all: vec![ChatDir {
                    name: "p".into(),
                    dir: dir.clone(),
                }],
            };
            let query = q["query"].as_str().unwrap();
            let expected = q["expected"].as_str().unwrap();
            let t = std::time::Instant::now();
            let out = match q["from"].as_str() {
                Some(from) => {
                    search_chain(&dirs, query, None, Some(from), MAX_LIMIT, Opts::default())
                }
                None => search(&dirs, query, Scope::Project, MAX_LIMIT, Opts::default()),
            }
            .unwrap();
            let ms = t.elapsed().as_millis();
            let r = rank_of(&out, expected);
            let project_rank = q["from"].as_str().map(|_| {
                rank_of(
                    &search(&dirs, query, Scope::Project, MAX_LIMIT, Opts::default()).unwrap(),
                    expected,
                )
            });
            found += usize::from(r.is_some());
            top1 += usize::from(r == Some(1));
            top5 += usize::from(r.is_some_and(|r| r <= 5));
            println!(
                "Q{:02} {} turn {}/{}{}: rank {}{} ({ms} ms)",
                i + 1,
                q["corpus"].as_str().unwrap(),
                q["turn"],
                q["turns"],
                if q["from"].is_string() {
                    " [chain]"
                } else {
                    ""
                },
                r.map_or("miss".to_string(), |r| r.to_string()),
                project_rank
                    .map(|p| format!(
                        ", project scope {}",
                        p.map_or("miss".to_string(), |r| r.to_string())
                    ))
                    .unwrap_or_default(),
            );
        }
        println!(
            "recall set: {} questions; rank 1: {top1}; top 5: {top5}; in top {MAX_LIMIT}: {found}",
            qs.len()
        );

        let dir = root
            .join("513c3418-df79-48f9-976d-cdae760ee6cc")
            .join("sessions");
        let dirs = ChatDirs {
            active: dir.clone(),
            all: Vec::new(),
        };
        for (query, title) in [
            ("legal neg", "Stuart 4"),
            ("rational choice", "Value Gen 8"),
            ("luck surface", "Value Gen 12"),
            ("lesswrong", "LessWrong post"),
            ("experimental design", "Value Gen 11"),
            ("competitor", "Stuart 3"),
            ("reading list", "Value Gen Reading List"),
            ("revealing ip", "revealing IP"),
            ("moral uncertainty", "moral uncertainty"),
            ("resume", "Stuart Armstrong collaboration"),
        ] {
            let out = search(&dirs, query, Scope::Project, MAX_LIMIT, Opts::default()).unwrap();
            let r = out
                .lines()
                .skip(1)
                .position(|l| l.split(" · ").nth(1).is_some_and(|t| t.contains(title)))
                .map(|i| i + 1);
            println!(
                "sept-14 {query:?} → {title:?}: rank {}",
                r.map_or("miss".to_string(), |r| r.to_string())
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
