//! Session-log discovery: listing, prefix lookup, most-recent — everything a
//! shell needs to offer "resume". Loading and appending stay on
//! `nightloom_core::Session`.

use chrono::{DateTime, Utc};
use nightloom_core::{ContentBlock, SessionEvent};
use serde::Serialize;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("cannot read {}: {source}", path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("no session matching {prefix:?} in {}", dir.display())]
    NotFound { prefix: String, dir: PathBuf },
    #[error("session prefix {prefix:?} is ambiguous: {}", ids.join(", "))]
    Ambiguous { prefix: String, ids: Vec<String> },
    #[error("no session logs in {}", dir.display())]
    Empty { dir: PathBuf },
}

/// One session log, summarized for a picker listing.
#[derive(Debug, Clone, Serialize)]
pub struct SessionSummary {
    pub id: String,
    pub path: PathBuf,
    pub modified: DateTime<Utc>,
    pub user_turns: usize,
    pub first_user: Option<String>,
    /// The session's name, if it has been given one. `None` is ordinary
    /// rather than exceptional — a chat one turn old has not been named yet,
    /// and a log written before titles existed never will be — so a picker
    /// wants [`SessionSummary::label`] rather than this field on its own.
    pub title: Option<String>,
}

impl SessionSummary {
    /// What to show in a picker: the session's name, or failing that its
    /// opening message, clipped to `max`.
    ///
    /// Here rather than in each shell because the fallback is the part worth
    /// agreeing on. Two shells listing the same directory should not be able
    /// to disagree about what a chat is called.
    pub fn label(&self, max: usize) -> String {
        let text = self.title.as_deref().or(self.first_user.as_deref());
        text.map(|t| one_line(t, max)).unwrap_or_default()
    }
}

fn io_err(path: &Path) -> impl FnOnce(io::Error) -> StoreError {
    let path = path.to_path_buf();
    move |source| StoreError::Io { path, source }
}

fn log_files(log_dir: &Path) -> Result<Vec<PathBuf>, StoreError> {
    let entries = fs::read_dir(log_dir).map_err(io_err(log_dir))?;
    let mut paths = Vec::new();
    for entry in entries {
        let path = entry.map_err(io_err(log_dir))?.path();
        if path.extension().is_some_and(|e| e == "jsonl") {
            paths.push(path);
        }
    }
    Ok(paths)
}

/// Light-weight scan of one log: enough for a listing without reopening the
/// file for append the way `Session::load` does.
///
/// Returns the events too, because the two callers want the same read.
/// `list` drops them; `search` looks through them.
fn scan(path: &Path) -> Result<(SessionSummary, Vec<SessionEvent>), StoreError> {
    let modified = fs::metadata(path)
        .and_then(|m| m.modified())
        .map_err(io_err(path))?;
    let content = fs::read_to_string(path).map_err(io_err(path))?;
    let events: Vec<SessionEvent> = content
        .lines()
        .filter(|l| !l.trim().is_empty())
        // Unknown or malformed lines shouldn't sink the whole listing; future
        // SessionEvent variants show up here before this crate learns them.
        .filter_map(|l| serde_json::from_str::<SessionEvent>(l).ok())
        .collect();

    let mut id = None;
    let mut user_turns = 0;
    let mut first_user = None;
    let mut title = None;
    for event in &events {
        match event {
            SessionEvent::SessionCreated { id: found, .. } => id = Some(found.clone()),
            SessionEvent::UserMessage { text, .. } => {
                if first_user.is_none() {
                    first_user = Some(text.clone());
                }
                user_turns += 1;
            }
            // Latest wins, matching `Session::title`. This scan is the raw
            // log rather than the live projection — like `user_turns` beside
            // it, which counts superseded turns too — and the two agree in
            // practice anyway: a rewind that supersedes a name leaves the
            // session unnamed, and the next turn records a fresh one after it.
            SessionEvent::Title { text, .. } => title = Some(text.clone()),
            _ => {}
        }
    }
    let id = id
        .or_else(|| path.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_default();
    Ok((
        SessionSummary {
            id,
            path: path.to_path_buf(),
            modified: modified.into(),
            user_turns,
            first_user,
            title,
        },
        events,
    ))
}

/// Every session log in the dir, newest first. A missing dir is an empty
/// listing, not an error — no session has been recorded yet.
pub fn list(log_dir: &Path) -> Result<Vec<SessionSummary>, StoreError> {
    if !log_dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut sessions = Vec::new();
    for path in log_files(log_dir)? {
        sessions.push(scan(&path)?.0);
    }
    sessions.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(sessions)
}

/// One session that matched a search, and the first place it did.
#[derive(Debug, Clone, Serialize)]
pub struct SessionMatch {
    #[serde(flatten)]
    pub summary: SessionSummary,
    /// How many messages contain the query. A count rather than a bool
    /// because it is the one cheap signal for which of two hits is the
    /// conversation that was *about* the thing.
    pub hits: usize,
    /// Text around the first hit, prefixed with who said it.
    pub excerpt: String,
}

/// Every session in `log_dir` whose conversation contains `query`, newest
/// first. Case-insensitive, substring, no syntax — the question this answers
/// is "which chat was that", and a query language would be a second thing to
/// learn in order to ask it.
///
/// **Conversation only**: user messages, assistant replies and the title, not
/// tool results. A tool result is whatever a file happened to contain, so
/// including them would return every session that ever read a file mentioning
/// the word, which is close to all of them and never the one being looked
/// for. A session is about what was said in it.
///
/// Superseded turns are searched like any other, deliberately: a chat you
/// rewound is still the chat you are trying to find, and hiding what it said
/// would make the thing you remember the one thing that cannot be found.
pub fn search(log_dir: &Path, query: &str) -> Result<Vec<SessionMatch>, StoreError> {
    let needle: String = query.trim().to_lowercase();
    if needle.is_empty() || !log_dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut found = Vec::new();
    for path in log_files(log_dir)? {
        let (summary, events) = scan(&path)?;
        let mut hits = 0;
        let mut excerpt = None;
        let mut named = None;
        for said in events.iter().filter_map(said) {
            let Some(at) = find_fold(&said.text, &needle) else {
                continue;
            };
            hits += 1;
            let slot = if said.conversation {
                &mut excerpt
            } else {
                &mut named
            };
            slot.get_or_insert_with(|| {
                format!(
                    "{}: {}",
                    said.who,
                    excerpt_around(&said.text, at, EXCERPT_WIDTH)
                )
            });
        }
        // A hit in the name is the last resort, not the first: the name is
        // already the row's label, so an excerpt repeating it tells the
        // reader nothing they are not looking at.
        if let Some(excerpt) = excerpt.or(named) {
            found.push(SessionMatch {
                summary,
                hits,
                excerpt,
            });
        }
    }
    found.sort_by(|a, b| b.summary.modified.cmp(&a.summary.modified));
    Ok(found)
}

/// Something a search can look through, tagged with who said it.
struct Said<'a> {
    who: &'static str,
    /// False only for the session's name, which is shown beside the excerpt
    /// rather than in it.
    conversation: bool,
    text: std::borrow::Cow<'a, str>,
}

/// The searchable text of one event, or `None` for the events that are not
/// conversation.
fn said(event: &SessionEvent) -> Option<Said<'_>> {
    match event {
        SessionEvent::UserMessage { text, .. } => Some(Said {
            who: "you",
            conversation: true,
            text: text.into(),
        }),
        SessionEvent::AssistantMessage { blocks, .. } => Some(Said {
            who: "model",
            conversation: true,
            // Text blocks only: thinking is not what the conversation said,
            // and a tool_use block is a call rather than a sentence.
            text: blocks
                .iter()
                .filter_map(|b| match b {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join(" ")
                .into(),
        }),
        // Findable by its name as well as by what was said in it, since the
        // name is the thing most likely to be remembered.
        SessionEvent::Title { text, .. } => Some(Said {
            who: "name",
            conversation: false,
            text: text.into(),
        }),
        _ => None,
    }
}

/// Byte index in `text` of the first case-insensitive match of `needle`,
/// which must already be lowercase.
///
/// Folding both sides and calling `str::find` is the shorter version and it
/// returns an index into a string that no longer exists: lowercasing can
/// change a string's length, so the offset does not point where the caller
/// thinks in the original. Walking the original keeps every index usable for
/// slicing it.
fn find_fold(text: &str, needle: &str) -> Option<usize> {
    if needle.is_empty() {
        return None;
    }
    text.char_indices()
        .find(|&(i, _)| {
            let mut hay = text[i..].chars().flat_map(char::to_lowercase);
            needle.chars().all(|n| hay.next() == Some(n))
        })
        .map(|(i, _)| i)
}

/// The text *around* a hit, not the text before it.
///
/// Clipping from the start of the message is the obvious version and it is
/// useless: a match three thousand characters in would not appear in the
/// excerpt at all, and a result that does not show why it matched reads as a
/// false positive.
fn excerpt_around(text: &str, at: usize, width: usize) -> String {
    let start = text[..at]
        .char_indices()
        .rev()
        .nth(width)
        .map_or(0, |(i, _)| i);
    let end = text[at..]
        .char_indices()
        .nth(width * 2)
        .map_or(text.len(), |(i, _)| at + i);
    let body = one_line(&text[start..end], usize::MAX);
    format!(
        "{}{body}{}",
        if start > 0 { "…" } else { "" },
        if end < text.len() { "…" } else { "" }
    )
}

/// Characters of context before a hit; twice that after it, since what
/// follows a phrase usually says more about it than what precedes it.
const EXCERPT_WIDTH: usize = 40;

/// Resolve a session ID or unique ID prefix to its log file.
pub fn find_by_prefix(log_dir: &Path, prefix: &str) -> Result<PathBuf, StoreError> {
    let mut matches: Vec<PathBuf> = log_files(log_dir)?
        .into_iter()
        .filter(|p| {
            p.file_stem()
                .and_then(|s| s.to_str())
                .is_some_and(|s| s.starts_with(prefix))
        })
        .collect();
    match matches.len() {
        0 => Err(StoreError::NotFound {
            prefix: prefix.into(),
            dir: log_dir.to_path_buf(),
        }),
        1 => Ok(matches.remove(0)),
        _ => {
            matches.sort();
            Err(StoreError::Ambiguous {
                prefix: prefix.into(),
                ids: matches
                    .iter()
                    .filter_map(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned()))
                    .collect(),
            })
        }
    }
}

/// The most recently modified session log in the dir.
pub fn latest(log_dir: &Path) -> Result<PathBuf, StoreError> {
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for path in log_files(log_dir)? {
        let modified = fs::metadata(&path)
            .and_then(|m| m.modified())
            .map_err(io_err(&path))?;
        if best.as_ref().is_none_or(|(t, _)| modified > *t) {
            best = Some((modified, path));
        }
    }
    match best {
        Some((_, path)) => Ok(path),
        None => Err(StoreError::Empty {
            dir: log_dir.to_path_buf(),
        }),
    }
}

/// Delete a session log by ID (or unique prefix). Returns the full ID of the
/// deleted session.
pub fn delete(log_dir: &Path, prefix: &str) -> Result<String, StoreError> {
    let path = find_by_prefix(log_dir, prefix)?;
    let id = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    fs::remove_file(&path).map_err(io_err(&path))?;
    Ok(id)
}

/// Collapse text to a single line, truncated to at most `max` chars.
pub fn one_line(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        flat
    } else {
        let cut: String = flat.chars().take(max).collect();
        format!("{cut}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir_with(names: &[&str]) -> PathBuf {
        // Unique enough for a test dir without pulling in uuid.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("nightloom-store-test-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        for name in names {
            fs::write(dir.join(format!("{name}.jsonl")), "").unwrap();
        }
        dir
    }

    #[test]
    fn prefix_matching() {
        let dir = dir_with(&["aabbccdd-1111", "aabbeeff-2222", "99887766-3333"]);

        let found = find_by_prefix(&dir, "9988").unwrap();
        assert_eq!(found.file_stem().unwrap(), "99887766-3333");

        let full = find_by_prefix(&dir, "aabbccdd-1111").unwrap();
        assert_eq!(full.file_stem().unwrap(), "aabbccdd-1111");

        assert!(matches!(
            find_by_prefix(&dir, "aabb"),
            Err(StoreError::Ambiguous { ids, .. }) if ids.len() == 2
        ));
        assert!(matches!(
            find_by_prefix(&dir, "zzzz"),
            Err(StoreError::NotFound { .. })
        ));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn delete_removes_by_prefix_and_respects_ambiguity() {
        let dir = dir_with(&["aabbccdd-1111", "aabbeeff-2222"]);

        assert!(matches!(
            delete(&dir, "aabb"),
            Err(StoreError::Ambiguous { .. })
        ));
        let id = delete(&dir, "aabbcc").unwrap();
        assert_eq!(id, "aabbccdd-1111");
        assert!(!dir.join("aabbccdd-1111.jsonl").exists());
        assert!(dir.join("aabbeeff-2222.jsonl").exists());
        assert!(matches!(
            delete(&dir, "aabbcc"),
            Err(StoreError::NotFound { .. })
        ));

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_dir_lists_empty() {
        let dir = std::env::temp_dir().join("nightloom-store-test-does-not-exist");
        assert!(list(&dir).unwrap().is_empty());
    }

    /// A named session is shown by its name; an unnamed one falls back to
    /// what was asked, which is all there was before.
    #[test]
    fn a_label_prefers_the_title_and_falls_back_to_the_opening_message() {
        let mut s = SessionSummary {
            id: "abc".into(),
            path: PathBuf::new(),
            modified: Utc::now(),
            user_turns: 1,
            first_user: Some("can you help me rename a function\neverywhere".into()),
            title: None,
        };
        assert_eq!(s.label(60), "can you help me rename a function everywhere");

        s.title = Some("Renaming fetch_rows across the crate".into());
        assert_eq!(s.label(60), "Renaming fetch_rows across the crate");

        // Nothing to say is empty, not a placeholder: only the shell knows
        // what an empty session should read as in its own listing.
        let blank = SessionSummary {
            first_user: None,
            title: None,
            ..s
        };
        assert_eq!(blank.label(60), "");
    }

    #[test]
    fn one_line_truncates_and_flattens() {
        assert_eq!(one_line("a\nb\tc", 60), "a b c");
        assert_eq!(one_line("abcdef", 3), "abc…");
    }

    /// Build a real log through `Session`, so the search is tested against
    /// the format the engine actually writes rather than a hand-rolled one.
    fn logged(dir: &Path, user: &str, reply: &str, tool_output: &str) -> String {
        use nightloom_core::{ContentBlock, Session, Usage};
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
        s.id.clone()
    }

    fn scratch() -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("nightloom-search-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Either side of the conversation is findable, and case is not part of
    /// remembering what you said.
    #[test]
    fn search_finds_what_was_said_on_either_side() {
        let dir = scratch();
        let wanted = logged(
            &dir,
            "how do I rewind a session?",
            "A rewind is a marker.",
            "",
        );
        logged(&dir, "unrelated question", "unrelated answer", "");

        let ids: Vec<String> = search(&dir, "REWIND")
            .unwrap()
            .into_iter()
            .map(|m| m.summary.id)
            .collect();
        assert_eq!(ids, [wanted]);

        // Both messages carry it, and the count is what separates the chat
        // that was about a thing from the one that mentioned it once.
        let hits = search(&dir, "rewind").unwrap()[0].hits;
        assert_eq!(hits, 2);

        fs::remove_dir_all(&dir).ok();
    }

    /// A tool result is whatever a file happened to contain. Searching it
    /// would return every session that ever read a file mentioning the word.
    #[test]
    fn search_looks_at_the_conversation_and_not_at_tool_output() {
        let dir = scratch();
        logged(
            &dir,
            "check the config",
            "It looks fine.",
            "max_rounds = 24\nlicense = MIT",
        );

        assert!(search(&dir, "config").unwrap().len() == 1);
        assert!(
            search(&dir, "max_rounds").unwrap().is_empty(),
            "tool output should not be searchable"
        );
        // Thinking is not what the conversation said either.
        assert!(search(&dir, "parsnips").unwrap().is_empty());

        fs::remove_dir_all(&dir).ok();
    }

    /// The name is the thing most likely to be remembered, so it is
    /// searchable even when the word never appears in the conversation.
    #[test]
    fn search_matches_the_session_name() {
        let dir = scratch();
        let id = logged(&dir, "opening question", "an answer", "");
        let path = dir.join(format!("{id}.jsonl"));
        let mut s = nightloom_core::Session::load(&path).unwrap();
        s.record_title("Windows file handle trouble");

        let found = search(&dir, "file handle").unwrap();
        assert_eq!(found.len(), 1);
        assert!(
            found[0].excerpt.starts_with("name:"),
            "{}",
            found[0].excerpt
        );

        // But the name is the last resort: a phrase that also appears in the
        // conversation is quoted from there, since the name is already the
        // row's label and an excerpt repeating it says nothing.
        s.record_title("an answer worth remembering");
        let found = search(&dir, "an answer").unwrap();
        assert!(
            found[0].excerpt.starts_with("model:"),
            "{}",
            found[0].excerpt
        );

        fs::remove_dir_all(&dir).ok();
    }

    /// An excerpt clipped from the start of a long message would not contain
    /// the match, which reads as a false positive.
    #[test]
    fn an_excerpt_is_centred_on_the_hit() {
        let long = format!(
            "{}the needle{}",
            "padding ".repeat(60),
            " and after".repeat(20)
        );
        let at = find_fold(&long, "needle").unwrap();
        let excerpt = excerpt_around(&long, at, EXCERPT_WIDTH);

        assert!(excerpt.contains("needle"), "{excerpt}");
        assert!(
            excerpt.starts_with('…') && excerpt.ends_with('…'),
            "{excerpt}"
        );
        // Short: a listing row, not the message.
        assert!(excerpt.chars().count() < 140, "{excerpt}");
    }

    /// A short message is shown whole, with no ellipsis promising more.
    #[test]
    fn a_short_message_needs_no_ellipsis() {
        let at = find_fold("just this", "this").unwrap();
        assert_eq!(excerpt_around("just this", at, EXCERPT_WIDTH), "just this");
    }

    /// Lowercasing can change a string's length, so an index taken in the
    /// folded copy does not point where the caller thinks in the original.
    #[test]
    fn find_fold_returns_an_index_into_the_original() {
        // 'İ' is one char that lowercases to two.
        let text = "İstanbul and the needle";
        let at = find_fold(text, "needle").unwrap();
        assert_eq!(&text[at..], "needle");
        assert_eq!(find_fold("MiXeD", "mixed"), Some(0));
        assert_eq!(find_fold("nothing here", "absent"), None);
        assert_eq!(find_fold("anything", ""), None);
    }

    /// An empty query is not a match-everything: a cleared search box should
    /// go back to the listing, not return every session as a "hit".
    #[test]
    fn an_empty_query_matches_nothing() {
        let dir = scratch();
        logged(&dir, "something", "anything", "");
        assert!(search(&dir, "").unwrap().is_empty());
        assert!(search(&dir, "   ").unwrap().is_empty());
        fs::remove_dir_all(&dir).ok();
    }
}
