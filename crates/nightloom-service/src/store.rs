//! Session-log discovery: listing, prefix lookup, most-recent — everything a
//! shell needs to offer "resume". Loading and appending stay on
//! `nightloom_core::Session`.

use chrono::{DateTime, Utc};
use nightloom_core::{ContentBlock, SessionEvent};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read, Seek, SeekFrom};
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

/// `Ok(None)` for a log that was in the directory scan and gone by the time it
/// was opened.
///
/// One window deleting a chat while another lists is an ordinary thing to do,
/// and the row it removes is the row that should disappear — failing the whole
/// listing over it empties a picker of a thousand good sessions because of one
/// the user meant to throw away. Every *other* error still propagates: a log
/// that cannot be read for some other reason is a real fault, and quietly
/// returning a short list would be the same silently-truncated answer this
/// module already refuses to give elsewhere.
fn skip_deleted<T>(result: Result<T, StoreError>) -> Result<Option<T>, StoreError> {
    match result {
        Err(StoreError::Io { ref source, .. }) if source.kind() == io::ErrorKind::NotFound => {
            Ok(None)
        }
        other => other.map(Some),
    }
}

/// One session log, as the directory scan already described it.
struct Log {
    path: PathBuf,
    len: u64,
    modified: DateTime<Utc>,
}

/// Every session log in the dir, with the size and mtime that came back with
/// it.
///
/// Taken from the `DirEntry` rather than by calling `fs::metadata` on each
/// path, which is not a micro-optimization here: on Windows the directory scan
/// already carries both fields, so reading them off the entry is free, while a
/// `metadata` call per file re-opens it. Over a thousand imported chats that
/// was measured at 34 ms of the 40 ms a warm listing took — more than
/// everything else in [`list`] put together. On Unix it costs what it always
/// did.
fn log_files(log_dir: &Path) -> Result<Vec<Log>, StoreError> {
    let entries = fs::read_dir(log_dir).map_err(io_err(log_dir))?;
    let mut logs = Vec::new();
    for entry in entries {
        let entry = entry.map_err(io_err(log_dir))?;
        let path = entry.path();
        if !is_log(&path) {
            continue;
        }
        // Deleted between the scan and the stat: a row that is going away, not
        // a failed listing. See [`skip_deleted`].
        let Some(meta) = skip_deleted(entry.metadata().map_err(io_err(&path)))? else {
            continue;
        };
        // A directory called `something.jsonl` is not a session log, and
        // opening one fails with a different error on every platform.
        if meta.is_dir() {
            continue;
        }
        let modified = meta.modified().map_err(io_err(&path))?;
        logs.push(Log {
            path,
            len: meta.len(),
            modified: modified.into(),
        });
    }
    Ok(logs)
}

fn is_log(path: &Path) -> bool {
    path.extension().is_some_and(|e| e == "jsonl")
}

/// Just the paths, for the lookups that do not care how big a log is.
///
/// Its own walk rather than [`log_files`] discarding half of what it gathered:
/// reading size and mtime is free from a Windows `DirEntry` but a syscall each
/// on Unix, and a caller that only wants names should not pay for either.
fn log_paths(log_dir: &Path) -> Result<Vec<PathBuf>, StoreError> {
    let entries = fs::read_dir(log_dir).map_err(io_err(log_dir))?;
    let mut paths = Vec::new();
    for entry in entries {
        let entry = entry.map_err(io_err(log_dir))?;
        let path = entry.path();
        // The same "not a directory" test [`log_files`] makes, from the entry
        // type rather than a stat, so counting stays a walk with no syscall
        // per file. The two must agree: a count that disagrees with the list
        // it labels is worse than either being wrong.
        let listable = entry.file_type().map(|t| !t.is_dir()).unwrap_or(false);
        if is_log(&path) && listable {
            paths.push(path);
        }
    }
    Ok(paths)
}

/// The only three events a listing is built from.
///
/// A separate, much smaller mirror of [`SessionEvent`] because `list` used to
/// deserialize whole logs — every tool result, every attachment, every content
/// block — and then read four fields off them. The listing is the hot path
/// (see [`list`]); the events it does not name are the overwhelming majority
/// of the bytes.
#[derive(serde::Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
enum Peek {
    SessionCreated {
        id: String,
    },
    UserMessage {
        text: String,
    },
    Title {
        text: String,
    },
    /// Everything else. Present so a line that gets past [`peek`]'s prefilter
    /// parses to "not interesting" rather than to an error.
    #[serde(other)]
    Other,
}

/// The `event` tags [`Peek`] cares about, as they appear in a written log.
///
/// Matched against the raw line before any JSON parsing, because parsing an
/// internally-tagged enum buffers the whole object even to discard it — so
/// without this, a 60 KB tool result still costs 60 KB of parse to learn it is
/// not a title. Correct only while the writer emits compact JSON with no space
/// after the colon, which `a_listing_reads_the_tags_the_writer_actually_emits`
/// pins against `Session`'s own output rather than against a literal here.
///
/// A false positive is harmless — it parses to [`Peek::Other`] and is dropped.
const LISTED: [&str; 3] = [
    r#""event":"session_created""#,
    r#""event":"user_message""#,
    r#""event":"title""#,
];

/// One log line as the listing sees it, or `None` for the ~95% of lines that
/// hold no listing field.
fn peek(line: &str) -> Option<Peek> {
    if !LISTED.iter().any(|tag| line.contains(tag)) {
        return None;
    }
    // Unknown or malformed lines shouldn't sink the whole listing; future
    // SessionEvent variants show up here before this crate learns them.
    serde_json::from_str::<Peek>(line)
        .ok()
        .filter(|p| !matches!(p, Peek::Other))
}

/// The listing fields, accumulated over a log's events in order.
///
/// Shared by both readers rather than written twice: `list` folds [`Peek`]s
/// and `search` folds the full events it has to parse anyway, and two shells
/// listing the same directory should not be able to disagree about what a
/// chat is called — the same reason [`SessionSummary::label`] lives here.
#[derive(Default, Clone, Serialize, Deserialize)]
struct Summarizing {
    id: Option<String>,
    user_turns: usize,
    first_user: Option<String>,
    title: Option<String>,
}

impl Summarizing {
    fn saw(&mut self, event: Peek) {
        match event {
            Peek::SessionCreated { id } => self.id = Some(id),
            Peek::UserMessage { text } => {
                if self.first_user.is_none() {
                    self.first_user = Some(text);
                }
                self.user_turns += 1;
            }
            // Latest wins, matching `Session::title`. This is the raw log
            // rather than the live projection — like `user_turns` beside it,
            // which counts superseded turns too — and the two agree in
            // practice anyway: a rewind that supersedes a name leaves the
            // session unnamed, and the next turn records a fresh one after it.
            Peek::Title { text } => self.title = Some(text),
            Peek::Other => {}
        }
    }

    /// By reference: a cached entry is summarized once per listing and kept.
    fn summary(&self, path: &Path, modified: DateTime<Utc>) -> SessionSummary {
        SessionSummary {
            id: self
                .id
                .clone()
                .or_else(|| path.file_stem().map(|s| s.to_string_lossy().into_owned()))
                .unwrap_or_default(),
            path: path.to_path_buf(),
            modified,
            user_turns: self.user_turns,
            first_user: self.first_user.clone(),
            title: self.title.clone(),
        }
    }
}

/// Fold a log's listing fields, starting `from` a byte offset and an
/// accumulator carried over from a previous pass. Returns how far it got.
///
/// Bytes rather than `read_to_string`, for the same reason `Session::load`
/// reads bytes: one line that is not UTF-8 should cost that line, not the
/// whole listing. Read as a string, a single bad byte in one log turns the
/// session picker empty.
fn fold_from(
    path: &Path,
    from: u64,
    mut acc: Summarizing,
) -> Result<(Summarizing, u64), StoreError> {
    let mut file = fs::File::open(path).map_err(io_err(path))?;
    if from > 0 {
        file.seek(SeekFrom::Start(from)).map_err(io_err(path))?;
    }
    let mut raw = Vec::new();
    file.read_to_end(&mut raw).map_err(io_err(path))?;
    // Whole lines only. A log being appended to right now can end mid-line,
    // and half an event is not an event — so the offset advances over what
    // was completely read and the torn tail is re-read next time. The same
    // rule as the dream's watermark, for the same reason.
    let complete = raw.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
    for line in raw[..complete].split(|b| *b == b'\n') {
        let decoded = String::from_utf8_lossy(line);
        if let Some(event) = peek(decoded.trim_end_matches('\r')) {
            acc.saw(event);
        }
    }
    Ok((acc, from + complete as u64))
}

/// One log's listing fields, plus what they were derived from.
#[derive(Clone, Serialize, Deserialize)]
struct Cached {
    /// Size and mtime of the log when this was taken. Both are checked, and
    /// any disagreement falls through to a full rescan — the cheap arm is an
    /// optimization, the expensive arm is the definition.
    len: u64,
    modified: DateTime<Utc>,
    /// How much of the log `summary` accounts for, always at a line boundary.
    scanned: u64,
    summary: Summarizing,
}

/// A cached listing, kept beside the logs it summarizes.
///
/// A **cache**, deliberately, and not an index: the logs remain the only
/// source of truth, every entry is re-validated against its file on each
/// listing, and anything unexpected — a missing file, a bad version, a size
/// that shrank, a clock that went backwards — falls back to reading the log.
/// The worst a stale or corrupt cache can do is cost one rescan. An index
/// that writers maintained could instead be *wrong*, and the way it would
/// show is a session that exists not appearing in the picker.
///
/// It is cheap because session logs only ever grow: every field here is fixed
/// at its first occurrence (`id`, `first_user`), counts upward (`user_turns`)
/// or is latest-wins (`title`), so a log that gained a turn costs the bytes it
/// gained rather than the bytes it holds.
#[derive(Serialize, Deserialize)]
struct Listing {
    version: u32,
    entries: BTreeMap<String, Cached>,
}

const LISTING_FILE: &str = ".listing.json";

/// Bumped whenever [`Summarizing`] or [`Cached`] changes shape. An older file
/// is discarded rather than migrated: it is derived data.
const LISTING_VERSION: u32 = 1;

impl Listing {
    fn read(dir: &Path) -> BTreeMap<String, Cached> {
        fs::read(dir.join(LISTING_FILE))
            .ok()
            .and_then(|raw| serde_json::from_slice::<Listing>(&raw).ok())
            .filter(|l| l.version == LISTING_VERSION)
            .map(|l| l.entries)
            .unwrap_or_default()
    }

    /// Write it out, or don't. Every failure here costs one rescan and
    /// nothing else, so a read-only session directory still lists — the same
    /// terms as the importer's `stamp`.
    fn write(self, dir: &Path) {
        let Ok(body) = serde_json::to_vec(&self) else {
            return;
        };
        // Named for this process: two shells listing at once should not write
        // through each other's half-finished file. The rename is atomic, so
        // the loser of the race is a lost update, which is a rescan.
        let tmp = dir.join(format!("{LISTING_FILE}.{}.tmp", std::process::id()));
        if fs::write(&tmp, body).is_ok() && fs::rename(&tmp, dir.join(LISTING_FILE)).is_err() {
            fs::remove_file(&tmp).ok();
        }
    }
}

/// The same three events, read off a fully parsed one. The search path already
/// has these in hand, so it folds them through [`Summarizing`] too.
fn peek_at(event: &SessionEvent) -> Option<Peek> {
    match event {
        SessionEvent::SessionCreated { id, .. } => Some(Peek::SessionCreated { id: id.clone() }),
        SessionEvent::UserMessage { text, .. } => Some(Peek::UserMessage { text: text.clone() }),
        SessionEvent::Title { text, .. } => Some(Peek::Title { text: text.clone() }),
        _ => None,
    }
}

/// Full scan of one log: the summary *and* every event, for the one caller
/// that has to look inside the conversation.
///
/// Not cached, and not cacheable by [`Listing`]: `search` needs the text of
/// every message, which is the part a summary throws away. What would help it
/// is a full-text index, which is a much larger thing than this — and search
/// is something a user asks for, where listing happens on its own.
fn scan(
    path: &Path,
    modified: DateTime<Utc>,
) -> Result<(SessionSummary, Vec<SessionEvent>), StoreError> {
    let raw = fs::read(path).map_err(io_err(path))?;
    let events: Vec<SessionEvent> = raw
        .split(|b| *b == b'\n')
        .map(String::from_utf8_lossy)
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<SessionEvent>(l.trim_end_matches('\r')).ok())
        .collect();
    let mut acc = Summarizing::default();
    for event in events.iter().filter_map(peek_at) {
        acc.saw(event);
    }
    Ok((acc.summary(path, modified), events))
}

/// How many session logs are in the dir, without reading any of them.
///
/// Beside [`list`] because `list(dir).len()` is the version that reads a
/// hundred megabytes to count files, and it is what a project row wants.
pub fn count(log_dir: &Path) -> usize {
    log_paths(log_dir).map_or(0, |paths| paths.len())
}

/// Every session log in the dir, newest first. A missing dir is an empty
/// listing, not an error — no session has been recorded yet.
///
/// Reads each log only as far as it must: see [`Listing`] for why that is a
/// cache rather than an index, and why it is safe for it to be wrong.
pub fn list(log_dir: &Path) -> Result<Vec<SessionSummary>, StoreError> {
    if !log_dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut known = Listing::read(log_dir);
    let mut entries = BTreeMap::new();
    let mut sessions = Vec::new();
    // Only rewrite the file when it would say something different, so opening
    // a picker twice does not rewrite a listing of a thousand chats twice.
    let mut changed = false;

    for Log {
        path,
        len,
        modified,
    } in log_files(log_dir)?
    {
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        let entry = match known.remove(name.as_ref()) {
            // Untouched since it was summarized: nothing to read.
            Some(c) if c.len == len && c.modified == modified => c,
            // Grew, and the part already read is still there: read the tail.
            Some(c) if len > c.len && modified >= c.modified && c.scanned <= len => {
                changed = true;
                // Deleted since the directory was scanned: drop the row and
                // keep the listing. See [`skip_deleted`].
                let Some((summary, scanned)) =
                    skip_deleted(fold_from(&path, c.scanned, c.summary))?
                else {
                    continue;
                };
                Cached {
                    len,
                    modified,
                    scanned,
                    summary,
                }
            }
            // Shrank, rewritten, backdated, or never seen: read all of it.
            _ => {
                changed = true;
                let Some((summary, scanned)) =
                    skip_deleted(fold_from(&path, 0, Summarizing::default()))?
                else {
                    continue;
                };
                Cached {
                    len,
                    modified,
                    scanned,
                    summary,
                }
            }
        };
        sessions.push(entry.summary.summary(&path, modified));
        entries.insert(name.into_owned(), entry);
    }

    // Whatever is left in `known` is a log that has since been deleted.
    if changed || !known.is_empty() {
        Listing {
            version: LISTING_VERSION,
            entries,
        }
        .write(log_dir);
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
    for log in log_files(log_dir)? {
        // Deleted mid-search, exactly as in `list`.
        let Some((summary, events)) = skip_deleted(scan(&log.path, log.modified))? else {
            continue;
        };
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
    let mut matches: Vec<PathBuf> = log_paths(log_dir)?
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
    log_files(log_dir)?
        .into_iter()
        .max_by_key(|l| l.modified)
        .map(|l| l.path)
        .ok_or_else(|| StoreError::Empty {
            dir: log_dir.to_path_buf(),
        })
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

    /// [`peek`] skips a line whose raw text carries none of [`LISTED`], so a
    /// writer that stopped emitting them in that exact form would empty every
    /// listing while every test that builds a summary by hand still passed.
    /// Pinned against `Session`'s own output rather than against a literal.
    #[test]
    fn a_listing_reads_the_tags_the_writer_actually_emits() {
        let dir = scratch();
        let id = logged(&dir, "the opening question", "a reply", "");
        let path = dir.join(format!("{id}.jsonl"));
        nightloom_core::Session::load(&path)
            .unwrap()
            .record_title("A name");

        let raw = fs::read_to_string(&path).unwrap();
        for tag in LISTED {
            assert!(raw.contains(tag), "the writer no longer emits {tag}");
        }

        let listed = list(&dir).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, id);
        assert_eq!(listed[0].user_turns, 1);
        assert_eq!(
            listed[0].first_user.as_deref(),
            Some("the opening question")
        );
        assert_eq!(listed[0].title.as_deref(), Some("A name"));

        fs::remove_dir_all(&dir).ok();
    }

    /// The whole point of the cache: a log that grew is read from where the
    /// last listing stopped, not from the top.
    ///
    /// Proved by changing the part that was already read, in place and to the
    /// same length, and then appending. A listing that re-read the file would
    /// report the changed opening; one that resumed at the watermark cannot
    /// see it. Deleting the cache then shows the file really did change, so
    /// this cannot pass by the summary simply being stale.
    #[test]
    fn a_grown_log_is_read_from_where_the_last_listing_stopped() {
        let dir = scratch();
        let id = logged(&dir, "AAAAAAAA", "a reply", "");
        let path = dir.join(format!("{id}.jsonl"));

        assert_eq!(
            list(&dir).unwrap()[0].first_user.as_deref(),
            Some("AAAAAAAA")
        );

        let raw = fs::read(&path).unwrap();
        let swapped: Vec<u8> = String::from_utf8(raw)
            .unwrap()
            .replace("AAAAAAAA", "BBBBBBBB")
            .into_bytes();
        fs::write(&path, swapped).unwrap();
        nightloom_core::Session::load(&path)
            .unwrap()
            .record_user("a second question");

        let listed = list(&dir).unwrap();
        assert_eq!(listed[0].user_turns, 2, "the appended turn was missed");
        assert_eq!(
            listed[0].first_user.as_deref(),
            Some("AAAAAAAA"),
            "the prefix was re-read, so nothing was saved"
        );

        fs::remove_file(dir.join(LISTING_FILE)).unwrap();
        assert_eq!(
            list(&dir).unwrap()[0].first_user.as_deref(),
            Some("BBBBBBBB")
        );

        fs::remove_dir_all(&dir).ok();
    }

    /// A log can end mid-line while it is being appended to, and half an
    /// event is not an event. The watermark stops at the last newline, so the
    /// torn line is counted once — when it is finished — and not before.
    #[test]
    fn a_torn_final_line_is_not_counted_until_it_is_finished() {
        let dir = scratch();
        let id = logged(&dir, "the opening question", "a reply", "");
        let path = dir.join(format!("{id}.jsonl"));

        let whole = fs::read_to_string(&path).unwrap();
        let torn = r#"{"event":"user_message","text":"half a th"#;
        fs::write(&path, format!("{whole}{torn}")).unwrap();
        assert_eq!(list(&dir).unwrap()[0].user_turns, 1);

        let finished =
            r#"{"event":"user_message","text":"half a thought","at":"2024-01-01T00:00:00Z"}"#;
        fs::write(&path, format!("{whole}{finished}\n")).unwrap();
        let listed = list(&dir).unwrap();
        assert_eq!(listed[0].user_turns, 2);
        assert_eq!(
            listed[0].first_user.as_deref(),
            Some("the opening question")
        );

        fs::remove_dir_all(&dir).ok();
    }

    /// The cache is derived data and never authoritative: anything unexpected
    /// in it costs a rescan and nothing else. A listing that could be broken
    /// by its own cache would be an index, which is the thing this is not.
    #[test]
    fn a_nonsense_cache_costs_a_rescan_and_not_the_listing() {
        let dir = scratch();
        logged(&dir, "the opening question", "a reply", "");
        let cache = dir.join(LISTING_FILE);

        for bad in [
            "not json at all".to_string(),
            "{}".to_string(),
            format!(r#"{{"version":{},"entries":{{}}}}"#, LISTING_VERSION + 1),
        ] {
            fs::write(&cache, &bad).unwrap();
            let listed = list(&dir).unwrap();
            assert_eq!(listed.len(), 1, "{bad}");
            assert_eq!(
                listed[0].first_user.as_deref(),
                Some("the opening question"),
                "{bad}"
            );
        }

        fs::remove_dir_all(&dir).ok();
    }

    /// A log that shrank or was rewritten is not an append, so the summary
    /// standing beside it is not a prefix of it and cannot be extended.
    #[test]
    fn a_log_that_shrank_is_read_again_rather_than_extended() {
        let dir = scratch();
        let id = logged(&dir, "the opening question", "a reply", "");
        let path = dir.join(format!("{id}.jsonl"));
        assert_eq!(list(&dir).unwrap()[0].user_turns, 1);

        let mut s = nightloom_core::Session::with_log(&dir).unwrap();
        s.record_user("a different opening");
        let replacement = fs::read(dir.join(format!("{}.jsonl", s.id))).unwrap();
        fs::remove_file(dir.join(format!("{}.jsonl", s.id))).unwrap();
        fs::write(&path, replacement).unwrap();

        let listed = list(&dir).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].first_user.as_deref(), Some("a different opening"));

        fs::remove_dir_all(&dir).ok();
    }

    /// The cache lives beside the logs, so it has to be invisible to
    /// everything that walks the directory looking for one.
    #[test]
    fn the_cache_is_not_mistaken_for_a_session() {
        let dir = scratch();
        let id = logged(&dir, "the opening question", "a reply", "");
        assert_eq!(list(&dir).unwrap().len(), 1);
        assert!(dir.join(LISTING_FILE).is_file(), "no cache was written");

        assert_eq!(list(&dir).unwrap().len(), 1);
        assert_eq!(count(&dir), 1);
        assert_eq!(latest(&dir).unwrap().file_stem().unwrap(), id.as_str());
        assert!(search(&dir, "opening").unwrap().len() == 1);

        fs::remove_dir_all(&dir).ok();
    }

    /// A deleted log leaves an entry behind that names a file that is gone.
    /// It has to drop out, or the picker keeps offering a chat that cannot be
    /// opened.
    #[test]
    fn a_deleted_log_leaves_the_listing() {
        let dir = scratch();
        logged(&dir, "the first", "a reply", "");
        let id = logged(&dir, "the second", "a reply", "");
        assert_eq!(list(&dir).unwrap().len(), 2);

        delete(&dir, &id).unwrap();
        let listed = list(&dir).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].first_user.as_deref(), Some("the first"));

        fs::remove_dir_all(&dir).ok();
    }

    /// One byte that is not text used to be an `InvalidData` error out of
    /// `read_to_string`, which `list` propagated — so a single damaged log
    /// anywhere in the directory showed the user an empty session picker
    /// rather than the other thousand chats. Same rule as `Session::load`:
    /// a bad line costs that line.
    #[test]
    fn a_log_with_a_byte_that_is_not_text_still_lists() {
        let dir = scratch();
        logged(&dir, "the readable one", "a reply", "");
        let mut damaged = fs::read(dir.join("broken.jsonl")).unwrap_or_default();
        damaged.extend_from_slice(&[0xff, 0xfe, b'\n']);
        fs::write(dir.join("broken.jsonl"), damaged).unwrap();

        let listed = list(&dir).unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().any(|s| s.id == "broken"));
        assert!(
            listed
                .iter()
                .any(|s| s.first_user.as_deref() == Some("the readable one"))
        );
        assert_eq!(search(&dir, "readable").unwrap().len(), 1);

        fs::remove_dir_all(&dir).ok();
    }

    /// `count` answers from the directory entries. A file it never opens is
    /// the point: this runs on every rail refresh, where `list().len()` read
    /// every byte of every log to arrive at the same number.
    #[test]
    fn count_answers_without_reading_the_logs() {
        let dir = scratch();
        assert_eq!(count(&dir), 0);
        logged(&dir, "the opening question", "a reply", "");
        fs::write(dir.join("garbage.jsonl"), [0xff, 0x00, 0xff]).unwrap();
        fs::write(dir.join("notes.txt"), "not a session").unwrap();

        assert_eq!(count(&dir), 2);
        // A directory that was never written to is nothing to report.
        assert_eq!(count(&dir.join("nowhere")), 0);

        fs::remove_dir_all(&dir).ok();
    }

    /// A directory called `something.jsonl` is not a session, and opening one
    /// fails differently on every platform — `IsADirectory` on Linux,
    /// permission denied on Windows — so leaving it in took the whole listing
    /// down rather than one row. All three readers have to agree it is not
    /// there, or a project row promises a chat the picker cannot show.
    #[test]
    fn a_directory_named_like_a_log_is_not_a_session() {
        let dir = scratch();
        logged(&dir, "the only chat", "a reply", "");
        fs::create_dir(dir.join("not-a-chat.jsonl")).unwrap();

        let listed = list(&dir).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].first_user.as_deref(), Some("the only chat"));
        assert_eq!(count(&dir), 1);
        assert_eq!(search(&dir, "only").unwrap().len(), 1);

        fs::remove_dir_all(&dir).ok();
    }

    /// Deleting a chat in one window while another lists used to fail that
    /// listing: the log is in the directory scan and gone by the time it is
    /// opened, so a thousand good sessions vanished from the picker over one
    /// the user meant to throw away. The race itself is not reproducible, but
    /// what it raises is — a link to nothing is listed by `read_dir` and
    /// `NotFound` on every read after that.
    #[test]
    fn a_log_that_is_gone_by_the_time_it_is_read_drops_out() {
        let dir = scratch();
        logged(&dir, "the surviving chat", "a reply", "");
        let (gone, link) = (dir.join("gone.jsonl"), dir.join("dangling.jsonl"));
        // The predicate both readers lean on, checked everywhere: a log that
        // is not there reads as `NotFound` and is a dropped row rather than a
        // failure.
        let missing = fold_from(&gone, 0, Summarizing::default());
        assert!(skip_deleted(missing).unwrap().is_none());

        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(&gone, &link).is_ok();
        // Windows only allows this to an administrator or under developer
        // mode. Where it is not allowed there is nothing to set up and so
        // nothing to assert; the Linux half of CI still covers the arm.
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(&gone, &link).is_ok();
        if !linked {
            fs::remove_dir_all(&dir).ok();
            return;
        }

        let listed = list(&dir).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].first_user.as_deref(), Some("the surviving chat"));
        assert_eq!(search(&dir, "surviving").unwrap().len(), 1);

        fs::remove_dir_all(&dir).ok();
    }
}
