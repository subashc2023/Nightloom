//! Search everywhere (nightshift backlog 117, with 106's second half): every
//! chat in a scope — this project, or every project and the unfiled ones —
//! and every note, for a phrase, answered as *messages* rather than chats.
//!
//! [`search`](super::search) beside this answers "which chat", one row per
//! chat with the first excerpt. The panel this serves (`SearchPanel.svelte`)
//! is drawn the other way round: results grouped by chat, one row per
//! matching message — who said it, the passage around the first hit with
//! the hit marked, when, how many more — and ↵ on a row opens the chat *at
//! that message* with every hit lit. So every row carries the message's
//! position in its log, which is the one address a message has: the log
//! has no message ids, and the transcript anchors each turn as
//! `data-turn={index}` (the 065 navigator's anchor).
//!
//! That index has to be the transcript's. `Session::load` keeps a line it
//! cannot parse as `Unknown` *in place*, so nothing after it moves; the
//! listing's `scan` drops one. This module counts lines the load's way.
//!
//! A substring scan, not the BM25 index: the index keeps counts and never
//! positions, and the question here is "where did I say that", which needs
//! the text. Measured on his store (2026-09-16, 969 logs, 62 MB, the number
//! is in the report): a scan pre-filtered on the raw line answers in the
//! budget the spec set, so there is no index file. Conversation only, as
//! `search` is: user messages, the model's text blocks, the chat's name;
//! never a tool result, which is whatever file the chat read.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use std::borrow::Cow;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::{SessionSummary, StoreError, io_err, list, log_files, one_line};
use crate::project;

/// The most rows the answer carries. Everything is still *counted* — the
/// count line says "200 of 1,340 · narrow it" — but a list past this is
/// nothing anyone reads.
pub const ROW_LIMIT: usize = 200;

/// Characters of passage before the hit, and after it: two lines of the
/// panel's 12.5px column, the hit somewhere in the first.
const BEFORE: usize = 60;
const AFTER: usize = 110;

/// A directory of chats and the project it belongs to (`None` for the
/// unfiled ones).
#[derive(Debug, Clone)]
pub struct ChatSource {
    pub project: Option<ProjectRef>,
    pub dir: PathBuf,
}

/// A folder of notes and the scope the note commands know it as
/// (`project` or `knowledge`), so a hit can be opened with `read_note`.
#[derive(Debug, Clone)]
pub struct NoteSource {
    pub scope: &'static str,
    pub dir: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectRef {
    pub id: String,
    pub name: String,
}

/// One matching message. The passage is handed over already split so the
/// panel marks the hit without doing offset arithmetic over text it did
/// not fold.
#[derive(Debug, Clone, Serialize)]
pub struct ChatRow {
    /// The message's position in its log — the transcript's `data-turn`.
    pub index: usize,
    /// `you`, or the model's id; `name` for a hit in the chat's title.
    pub who: String,
    pub at: DateTime<Utc>,
    pub before: String,
    pub matched: String,
    pub after: String,
    /// Hits in this message; the row says "3 matches" past one.
    pub matches: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChatGroup {
    #[serde(flatten)]
    pub chat: SessionSummary,
    /// Set under *all chats* so a group from another project can carry
    /// its pill and a jump can switch to it (blocker 154).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<ProjectRef>,
    /// Hits across the chat.
    pub hits: usize,
    pub rows: Vec<ChatRow>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NoteRow {
    /// 1-based, the editor's numbering.
    pub line: usize,
    pub before: String,
    pub matched: String,
    pub after: String,
    pub matches: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct NoteGroup {
    pub scope: String,
    pub name: String,
    pub modified: DateTime<Utc>,
    pub hits: usize,
    pub rows: Vec<NoteRow>,
}

/// The answer, with the counts the panel's count line reads —
/// `14 matches in 9 messages · 4 chats · 0.2 s`.
#[derive(Debug, Clone, Default, Serialize)]
pub struct SearchResult {
    /// Every hit, counted past the row limit.
    pub matches: usize,
    /// Matching messages and note lines.
    pub messages: usize,
    /// Matching chats and notes.
    pub chats: usize,
    /// Rows actually returned; under `messages` when capped.
    pub shown: usize,
    pub elapsed_ms: u64,
    pub groups: Vec<ChatGroup>,
    pub notes: Vec<NoteGroup>,
}

/// Search the chat directories and note folders for `query`. Chats come
/// back newest first, rows in message order; notes by name. A missing
/// directory is an empty one, as it is for the listing.
pub fn search(
    chats: &[ChatSource],
    notes: &[NoteSource],
    query: &str,
) -> Result<SearchResult, StoreError> {
    let started = Instant::now();
    let mut out = SearchResult::default();
    let needle = Needle::new(query);
    if needle.lower.is_empty() {
        return Ok(out);
    }
    let mut budget = ROW_LIMIT;
    for source in chats {
        search_dir(source, &needle, &mut out, &mut budget)?;
    }
    out.groups
        .sort_by_key(|g| std::cmp::Reverse(g.chat.modified));
    for source in notes {
        search_notes(source, &needle, &mut out, &mut budget);
    }
    out.elapsed_ms = started.elapsed().as_millis() as u64;
    Ok(out)
}

/// The query, folded once, with what the raw-line pre-filter may assume.
///
/// The saving is skipping the parse: a line that cannot hold a hit is
/// never deserialised. What the raw line may be asked depends on the
/// needle. Printable ASCII without a quote or backslash appears in the
/// JSON verbatim, so an ASCII-folded byte scan is exact. Anything else in
/// the needle may be escaped in the line — `\"`, `\\`, or `\u00e9` from a
/// writer that escapes non-ASCII (serde does not; an imported log's
/// writer might) — so a needle with a quote or backslash gets no
/// pre-filter, and a non-ASCII needle is pre-filtered on the lower-cased
/// line only when the line carries no `\u` escape.
struct Needle {
    lower: String,
    filter: Filter,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Filter {
    /// Byte scan, ASCII-folded: exact.
    Ascii,
    /// Lower-case the line and `contains`, unless the line has `\u`.
    Folded,
    /// Parse every message line.
    None,
}

impl Needle {
    fn new(query: &str) -> Self {
        let lower = query.trim().to_lowercase();
        let filter = if lower.bytes().any(|b| b == b'"' || b == b'\\' || b < 0x20) {
            Filter::None
        } else if lower.is_ascii() {
            Filter::Ascii
        } else {
            Filter::Folded
        };
        Self { lower, filter }
    }

    /// Whether a raw line can hold a hit. `true` is "maybe".
    fn may_hold(&self, line: &[u8]) -> bool {
        match self.filter {
            Filter::Ascii => contains_fold_ascii(line, self.lower.as_bytes()),
            Filter::Folded => {
                if contains(line, b"\\u") {
                    return true;
                }
                String::from_utf8_lossy(line)
                    .to_lowercase()
                    .contains(&self.lower)
            }
            Filter::None => true,
        }
    }
}

/// The `event` tags a hit can live in, matched on the raw line before
/// parsing, as `LISTED` and `INDEXED` are and for the same reason: a 60 KB
/// tool result is not worth 60 KB of parse to learn it is not conversation.
/// Serde writes an internally tagged enum's tag first, so the check is a
/// `starts_with`; a line that does not open that way — written by hand,
/// or by something else — is scanned whole.
const SPOKEN: [&str; 3] = [
    r#"{"event":"user_message""#,
    r#"{"event":"assistant_message""#,
    r#"{"event":"title""#,
];

fn spoken(line: &[u8]) -> bool {
    if line.starts_with(br#"{"event":""#) {
        SPOKEN.iter().any(|tag| line.starts_with(tag.as_bytes()))
    } else {
        SPOKEN
            .iter()
            .any(|tag| contains(line, &tag.as_bytes()[1..]))
    }
}

/// The conversation of one line, and nothing else of it. The same
/// definition as [`said`](super::said) — a user message's text, a reply's
/// text blocks, the chat's name; never thinking, a tool call or a tool
/// result — read through a shape that borrows what it can and skips the
/// rest, so a message carrying an image's base64 or a reply carrying a
/// tool's input costs the tokeniser's pass and no allocation. Measured:
/// the full `SessionEvent` parse was most of a common word's time.
#[derive(Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum Spoken<'a> {
    UserMessage {
        #[serde(borrow)]
        text: Cow<'a, str>,
        at: DateTime<Utc>,
    },
    AssistantMessage {
        #[serde(borrow)]
        model: Cow<'a, str>,
        #[serde(borrow)]
        blocks: Vec<Block<'a>>,
        at: DateTime<Utc>,
    },
    Title {
        #[serde(borrow)]
        text: Cow<'a, str>,
        at: DateTime<Utc>,
    },
    #[serde(other)]
    Other,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum Block<'a> {
    Text {
        #[serde(borrow)]
        text: Cow<'a, str>,
    },
    #[serde(other)]
    Other,
}

impl<'a> Spoken<'a> {
    /// Who, when, and the text — or `None` for a line with nothing to say.
    fn said(self) -> Option<(String, DateTime<Utc>, Cow<'a, str>)> {
        match self {
            Spoken::UserMessage { text, at } => Some(("you".into(), at, text)),
            Spoken::AssistantMessage { model, blocks, at } => {
                let texts: Vec<Cow<'a, str>> = blocks
                    .into_iter()
                    .filter_map(|b| match b {
                        Block::Text { text } => Some(text),
                        Block::Other => None,
                    })
                    .collect();
                let text = match texts.len() {
                    0 => return None,
                    1 => texts.into_iter().next().unwrap(),
                    _ => Cow::Owned(texts.join(" ")),
                };
                Some((model.into_owned(), at, text))
            }
            Spoken::Title { text, at } => Some(("name".into(), at, text)),
            Spoken::Other => None,
        }
    }
}

fn search_dir(
    source: &ChatSource,
    needle: &Needle,
    out: &mut SearchResult,
    budget: &mut usize,
) -> Result<(), StoreError> {
    if !source.dir.is_dir() {
        return Ok(());
    }
    // The summaries come from the listing cache; the logs are read here
    // only for their text.
    let summaries: BTreeMap<PathBuf, SessionSummary> = list(&source.dir)?
        .into_iter()
        .map(|s| (s.path.clone(), s))
        .collect();
    for log in log_files(&source.dir)? {
        let Some(summary) = summaries.get(&log.path) else {
            continue;
        };
        let raw = match fs::read(&log.path) {
            Ok(raw) => raw,
            // Deleted mid-search: the row that should disappear, as in `list`.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(io_err(&log.path)(e)),
        };
        let rows = scan_log(&raw, needle);
        if rows.is_empty() {
            continue;
        }
        let hits: usize = rows.iter().map(|r| r.matches).sum();
        out.matches += hits;
        out.messages += rows.len();
        out.chats += 1;
        let keep = rows.len().min(*budget);
        *budget -= keep;
        out.shown += keep;
        // A chat past the budget still counts, and is still listed with its
        // count and no rows — the group header is the reader's cue that
        // there is more than the panel shows.
        out.groups.push(ChatGroup {
            chat: summary.clone(),
            project: source.project.clone(),
            hits,
            rows: rows.into_iter().take(keep).collect(),
        });
    }
    Ok(())
}

/// Every matching message of one log, in order, each with its position
/// counted the way `Session::load` counts: blank lines skipped, a line that
/// will not parse still holding its place, the torn tail (no newline after
/// it) dropped — it is last, so dropping it moves nothing.
fn scan_log(raw: &[u8], needle: &Needle) -> Vec<ChatRow> {
    let mut rows = Vec::new();
    let torn = raw.last().is_some_and(|b| *b != b'\n');
    let last_start = raw.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
    let mut index = 0usize;
    let mut offset = 0usize;
    for line in raw.split_inclusive(|b| *b == b'\n') {
        let start = offset;
        offset += line.len();
        if line.iter().all(|b| b.is_ascii_whitespace()) {
            continue;
        }
        if torn && start == last_start {
            break;
        }
        let at = index;
        index += 1;
        if !spoken(line) || !needle.may_hold(line) {
            continue;
        }
        let Ok(text) = std::str::from_utf8(line) else {
            continue;
        };
        let Ok(event) = serde_json::from_str::<Spoken>(text.trim_end_matches(['\n', '\r'])) else {
            continue;
        };
        let Some((who, when, text)) = event.said() else {
            continue;
        };
        let found = fold_matches(&text, &needle.lower);
        if found.is_empty() {
            continue;
        }
        let (before, matched, after) = passage(&text, found[0]);
        rows.push(ChatRow {
            index: at,
            who,
            at: when,
            before,
            matched,
            after,
            matches: found.len(),
        });
    }
    rows
}

fn search_notes(source: &NoteSource, needle: &Needle, out: &mut SearchResult, budget: &mut usize) {
    if !source.dir.is_dir() {
        return;
    }
    for note in project::list_notes(&source.dir) {
        let Ok(text) = project::read_note(&source.dir, &note.name) else {
            continue;
        };
        let mut rows = Vec::new();
        for (n, line) in text.lines().enumerate() {
            let found = fold_matches(line, &needle.lower);
            if found.is_empty() {
                continue;
            }
            let (before, matched, after) = passage(line, found[0]);
            rows.push(NoteRow {
                line: n + 1,
                before,
                matched,
                after,
                matches: found.len(),
            });
        }
        if rows.is_empty() {
            continue;
        }
        let hits: usize = rows.iter().map(|r| r.matches).sum();
        out.matches += hits;
        out.messages += rows.len();
        out.chats += 1;
        let keep = rows.len().min(*budget);
        *budget -= keep;
        out.shown += keep;
        out.notes.push(NoteGroup {
            scope: source.scope.to_string(),
            name: note.name,
            modified: note.modified,
            hits,
            rows: rows.into_iter().take(keep).collect(),
        });
    }
}

/// Plain substring over bytes; `str::contains` on a lossy copy would cost
/// the copy on every line.
fn contains(hay: &[u8], needle: &[u8]) -> bool {
    needle.is_empty() || hay.windows(needle.len()).any(|w| w == needle)
}

/// Case-insensitive ASCII substring, no allocation: `needle` is already
/// lower-case. Only sound as a *pre-filter* on a JSON line for a plain
/// needle (see [`Needle::plain`]); the parsed text is matched properly
/// afterwards by [`fold_matches`].
fn contains_fold_ascii(hay: &[u8], needle: &[u8]) -> bool {
    let n = needle.len();
    if n == 0 || hay.len() < n {
        return n == 0;
    }
    let first = needle[0];
    let upper = first.to_ascii_uppercase();
    let mut i = 0;
    while i + n <= hay.len() {
        let b = hay[i];
        if (b == first || b == upper) && hay[i..i + n].eq_ignore_ascii_case(needle) {
            return true;
        }
        i += 1;
    }
    false
}

/// Every case-insensitive occurrence of `needle` (already lower-case) in
/// `text`, as `(byte start, byte length)` into the *original* — a folded
/// copy can change length, so the walk stays on the original as
/// `find_fold` does. Non-overlapping, as the ⌘F bar's are.
pub(crate) fn fold_matches(text: &str, needle: &str) -> Vec<(usize, usize)> {
    let mut found = Vec::new();
    if needle.is_empty() {
        return found;
    }
    if needle.is_ascii() {
        // The byte scan: an ASCII byte never sits inside a multi-byte
        // character, so a match is on character boundaries by construction.
        // What it gives up is the handful of non-ASCII characters that
        // lower-case to ASCII (the Kelvin sign to `k`) — a miss on those,
        // as `find_fold` accepts, against a walk that was most of a common
        // word's time.
        let hay = text.as_bytes();
        let n = needle.len();
        let mut i = 0;
        while i + n <= hay.len() {
            if contains_fold_ascii(&hay[i..i + n], needle.as_bytes()) {
                found.push((i, n));
                i += n;
            } else {
                i += 1;
            }
        }
        return found;
    }
    let mut from = 0;
    while from < text.len() {
        let Some((at, len)) = fold_find(&text[from..], needle) else {
            break;
        };
        found.push((from + at, len));
        from += at + len.max(1);
    }
    found
}

/// The first fold-match in `text`: its byte offset and the byte length of
/// the original characters that folded to `needle`.
fn fold_find(text: &str, needle: &str) -> Option<(usize, usize)> {
    for (i, _) in text.char_indices() {
        if let Some(len) = fold_prefix(&text[i..], needle) {
            return Some((i, len));
        }
    }
    None
}

/// If `text` starts with characters that lower-case to `needle`, how many
/// bytes of `text` they are.
fn fold_prefix(text: &str, needle: &str) -> Option<usize> {
    let mut want = needle.chars();
    let mut next = want.next();
    let mut consumed = 0;
    for (i, c) in text.char_indices() {
        if next.is_none() {
            return Some(i);
        }
        for l in c.to_lowercase() {
            if next != Some(l) {
                return None;
            }
            next = want.next();
        }
        consumed = i + c.len_utf8();
    }
    next.is_none().then_some(consumed)
}

/// The text around a hit in three pieces, flattened to one line each:
/// up to `BEFORE` characters before it (from a word boundary where there is
/// one), the hit, up to `AFTER` after it. An ellipsis on the cut ends.
fn passage(text: &str, (at, len): (usize, usize)) -> (String, String, String) {
    let head = &text[..at];
    let start = head.char_indices().rev().nth(BEFORE).map_or(0, |(i, _)| i);
    let tail = &text[at + len..];
    let end = tail
        .char_indices()
        .nth(AFTER)
        .map_or(tail.len(), |(i, _)| i);
    let mut before = one_line(&head[start..], usize::MAX);
    if start > 0 {
        before.insert(0, '…');
    }
    // `one_line` trims; the space a word boundary needs goes back so the
    // pieces read as one sentence when joined.
    if !before.is_empty() && head.ends_with(char::is_whitespace) {
        before.push(' ');
    }
    let mut after = one_line(&tail[..end], usize::MAX);
    if !after.is_empty() && tail.starts_with(char::is_whitespace) {
        after.insert(0, ' ');
    }
    if end < tail.len() {
        after.push('…');
    }
    (before, one_line(&text[at..at + len], usize::MAX), after)
}

/// The chat sources for a scope: the one directory, or every project's
/// plus the unfiled ones. Here rather than in the shell so the MCP tools
/// and the panel cannot disagree about what "all chats" is.
pub fn all_sources(projects: &[project::Project], unfiled: &Path) -> Vec<ChatSource> {
    let mut all: Vec<ChatSource> = projects
        .iter()
        .map(|p| ChatSource {
            project: Some(ProjectRef {
                id: p.id.clone(),
                name: p.name.clone(),
            }),
            dir: p.session_dir(),
        })
        .collect();
    all.push(ChatSource {
        project: None,
        dir: unfiled.to_path_buf(),
    });
    all
}

#[cfg(test)]
mod tests {
    use super::*;
    use nightloom_core::{ContentBlock, Session, SessionEvent, Usage};

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nightloom-search-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn logged(dir: &Path, turns: &[(&str, &str)]) -> String {
        let mut s = Session::with_log(dir).unwrap();
        for (user, reply) in turns {
            s.record_user(*user);
            s.record_assistant(
                "opus",
                vec![ContentBlock::Text {
                    text: reply.to_string(),
                }],
                Some("end_turn".into()),
                Usage::default(),
            );
        }
        s.id.clone()
    }

    fn one(dir: &Path) -> ChatSource {
        ChatSource {
            project: None,
            dir: dir.to_path_buf(),
        }
    }

    #[test]
    fn rows_carry_the_transcripts_index_and_the_hit_split_out() {
        let dir = scratch();
        logged(
            &dir,
            &[
                (
                    "Which runs used the mean reward?",
                    "Two: both report the Mean Reward over 200 episodes.",
                ),
                ("thanks", "welcome"),
            ],
        );
        let r = search(&[one(&dir)], &[], "mean reward").unwrap();
        assert_eq!((r.matches, r.messages, r.chats, r.shown), (2, 2, 1, 2));
        let g = &r.groups[0];
        assert_eq!(g.hits, 2);
        // Line 0 is the creation event; the first user message is index 1.
        assert_eq!(g.rows[0].index, 1);
        assert_eq!(g.rows[0].who, "you");
        assert_eq!(g.rows[0].matched, "mean reward");
        assert_eq!(g.rows[0].before, "Which runs used the ");
        assert_eq!(g.rows[0].after, "?");
        assert_eq!(g.rows[1].index, 2);
        assert_eq!(g.rows[1].who, "opus");
        assert_eq!(g.rows[1].matched, "Mean Reward");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_damaged_line_keeps_its_place_as_the_load_does() {
        let dir = scratch();
        let id = logged(&dir, &[("first", "one")]);
        let path = dir.join(format!("{id}.jsonl"));
        let mut raw = fs::read_to_string(&path).unwrap();
        raw.push_str("{not json\n");
        raw.push_str(
            r#"{"event":"user_message","text":"needle here","at":"2026-09-16T00:00:00Z"}"#,
        );
        raw.push('\n');
        fs::write(&path, raw).unwrap();
        let loaded = Session::load(&path).unwrap();
        let from_load = loaded
            .events()
            .iter()
            .position(
                |e| matches!(e, SessionEvent::UserMessage { text, .. } if text == "needle here"),
            )
            .unwrap();
        let r = search(&[one(&dir)], &[], "needle").unwrap();
        assert_eq!(r.groups[0].rows[0].index, from_load);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_torn_tail_is_not_a_row() {
        let dir = scratch();
        let id = logged(&dir, &[("first", "one")]);
        let path = dir.join(format!("{id}.jsonl"));
        let mut raw = fs::read_to_string(&path).unwrap();
        raw.push_str(r#"{"event":"user_message","text":"torn needle","at":"2026-09-16T00:00:00Z""#);
        fs::write(&path, raw).unwrap();
        let r = search(&[one(&dir)], &[], "needle").unwrap();
        assert!(r.groups.is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn tool_output_and_thinking_are_not_searched() {
        let dir = scratch();
        let mut s = Session::with_log(&dir).unwrap();
        s.record_user("read it");
        s.record_assistant(
            "opus",
            vec![
                ContentBlock::Thinking {
                    text: "the needle is in the thinking".into(),
                    signature: None,
                },
                ContentBlock::ToolUse {
                    id: "t1".into(),
                    name: "read".into(),
                    input: serde_json::json!({"path": "needle.md"}),
                    signature: None,
                },
            ],
            Some("tool_use".into()),
            Usage::default(),
        );
        s.record_tool_result(&ContentBlock::ToolResult {
            tool_use_id: "t1".into(),
            name: "read".into(),
            content: "a file full of needle".into(),
            is_error: false,
        });
        let r = search(&[one(&dir)], &[], "needle").unwrap();
        assert!(r.groups.is_empty(), "{r:?}");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_row_limit_caps_rows_and_not_counts() {
        let dir = scratch();
        let turns: Vec<(String, String)> = (0..120)
            .map(|i| (format!("needle {i}"), format!("needle back {i}")))
            .collect();
        let refs: Vec<(&str, &str)> = turns
            .iter()
            .map(|(a, b)| (a.as_str(), b.as_str()))
            .collect();
        logged(&dir, &refs);
        logged(&dir, &refs);
        let r = search(&[one(&dir), one(&dir)], &[], "needle").unwrap();
        // Two dirs, the same one twice: four chats of 240 messages.
        assert_eq!(r.messages, 960);
        assert_eq!(r.chats, 4);
        assert_eq!(r.shown, ROW_LIMIT);
        assert_eq!(
            r.groups.iter().map(|g| g.rows.len()).sum::<usize>(),
            ROW_LIMIT
        );
        assert_eq!(r.groups.len(), 4);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_non_ascii_query_is_found_without_the_prefilter() {
        let dir = scratch();
        logged(&dir, &[("Le café est ouvert", "CAFÉ noted")]);
        let r = search(&[one(&dir)], &[], "café").unwrap();
        assert_eq!(r.matches, 2);
        assert_eq!(r.groups[0].rows[1].matched, "CAFÉ");
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_query_with_a_quote_is_found_in_the_decoded_text() {
        let dir = scratch();
        logged(&dir, &[(r#"he said "hi" twice"#, "ok")]);
        let r = search(&[one(&dir)], &[], r#""hi""#).unwrap();
        assert_eq!(r.matches, 1);
        assert_eq!(r.groups[0].rows[0].matched, r#""hi""#);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn notes_are_searched_by_line() {
        let dir = scratch();
        fs::write(
            dir.join("q5.md"),
            "# q5\n\nthe mean reward diverges\nnot here\nMean reward again, mean reward\n",
        )
        .unwrap();
        let src = NoteSource {
            scope: "project",
            dir: dir.clone(),
        };
        let r = search(&[], &[src], "mean reward").unwrap();
        assert_eq!((r.matches, r.messages, r.chats), (3, 2, 1));
        let n = &r.notes[0];
        assert_eq!(n.name, "q5.md");
        assert_eq!(n.rows[0].line, 3);
        assert_eq!(n.rows[1].line, 5);
        assert_eq!(n.rows[1].matches, 2);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn fold_matches_walks_the_original() {
        assert_eq!(fold_matches("İstanbul istanbul", "i̇stanbul"), vec![(0, 9)]);
        assert_eq!(fold_matches("aaa", "aa"), vec![(0, 2)]);
        assert_eq!(fold_matches("x", ""), Vec::<(usize, usize)>::new());
        assert!(contains_fold_ascii(b"the Mean Reward", b"mean reward"));
        assert!(!contains_fold_ascii(b"the mean", b"mean reward"));
    }

    #[test]
    fn a_passage_is_cut_around_the_hit() {
        let text = format!("{} needle {}", "a".repeat(100), "b".repeat(200));
        let (before, matched, after) = passage(&text, (101, 6));
        assert!(before.starts_with('…'));
        assert!(before.ends_with(' '));
        assert_eq!(matched, "needle");
        assert!(after.starts_with(' '));
        assert!(after.ends_with('…'));
        // `AFTER` characters of the tail, the leading space among them, plus
        // the ellipsis.
        assert_eq!(after.chars().count(), AFTER + 1);
    }

    /// The measurement the spec asks for, on a real store: set
    /// `NIGHTLOOM_SEARCH_TIMING_DIR` to a `sessions` directory (or a
    /// `projects` folder — every `*/sessions` under it is taken) and run
    /// with `--ignored --nocapture`. Read-only.
    #[test]
    #[ignore]
    fn timing_on_a_real_store() {
        let Ok(root) = std::env::var("NIGHTLOOM_SEARCH_TIMING_DIR") else {
            return;
        };
        let root = PathBuf::from(root);
        let mut sources = Vec::new();
        if root.join("sessions").is_dir() {
            sources.push(one(&root.join("sessions")));
        } else if let Ok(rd) = fs::read_dir(&root) {
            for e in rd.flatten() {
                let d = e.path().join("sessions");
                if d.is_dir() {
                    sources.push(one(&d));
                }
            }
        }
        if sources.is_empty() {
            sources.push(one(&root));
        }
        for q in ["the", "mean reward", "zzzzqqq", "café"] {
            for pass in 0..3 {
                let r = search(&sources, &[], q).unwrap();
                eprintln!(
                    "{q:?} pass {pass}: {} ms — {} matches in {} messages · {} chats ({} rows shown)",
                    r.elapsed_ms, r.matches, r.messages, r.chats, r.shown
                );
            }
        }
    }
}
