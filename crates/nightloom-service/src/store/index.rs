//! A ranked index over the conversations in one session directory, kept
//! beside the logs as `.index.json`.
//!
//! `search` answers "which chat contains this phrase"; the `search_chats`
//! tool needs "which chat is *about* this", and a substring has no notion of
//! about. Measured on a 32-chat project, ten hand-picked questions found the
//! expected chat in the top five eight times, and both misses were topics a
//! dozen chats mention in passing, where the one that wrote the thing lost
//! to the one that discussed it. Term frequency against document length —
//! BM25, the ranking function every full-text engine defaults to — is the
//! cheapest fix, and it needs a count of every term in every chat, which is
//! the one thing a substring scan throws away.
//!
//! Counts, not positions: the index says how often a chat says a word, never
//! where, so it ranks and something else excerpts. It is built from
//! [`said`] — user messages, assistant text, the title — and never from a
//! tool result, for `search`'s reason and the tool's: a tool result is
//! whatever file a chat read.
//!
//! Beside the logs rather than in the config dir (blocker 051): the listing
//! cache lives there for the same reason, a project moved with its folder
//! keeps its index, and a directory that is deleted takes its derived data
//! with it. And it is kept the way [`Listing`](super::Listing) is kept —
//! validated against every log on each load, extended from a byte offset
//! when a log grew, rebuilt when anything disagrees — so the logs stay the
//! only source of truth and the worst a stale or corrupt file can do is cost
//! one rebuild.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use nightloom_core::SessionEvent;
use serde::{Deserialize, Serialize};

use super::{Log, StoreError, Summarizing, io_err, log_files, peek_at, said, skip_deleted};

pub(crate) const INDEX_FILE: &str = ".index.json";

/// Bumped whenever [`Indexed`] or the tokeniser changes. An older file is
/// rebuilt rather than migrated: it is derived data. 2 since the chat mode
/// (2026-09-15): a record written without it would count an incognito
/// chat's words, which is the one thing the index must not do. 3 since the
/// counts are per turn (item 749, 2026-11-16).
const INDEX_VERSION: u32 = 3;

/// How many times a word in the title counts, against once in the body. The
/// title answered three of ten questions on its own in the substring
/// measurement; a chat's name is the most compressed statement of what it
/// was about.
const TITLE_WEIGHT: u32 = 3;

/// BM25's two constants, at the values the literature settled on: `K1` is
/// how fast repeating a term stops adding to the score, `B` how much a long
/// chat is penalised for being long.
const K1: f64 = 1.2;
const B: f64 = 0.75;
/// Days after which a chat's score is halved. His rule (nightshift blocker
/// 052, 2026-09-14): "chats that are referenced should be very close to the
/// actual chat we're involved in"; a year-old chat that happens to share
/// the words should not outrank last week's. The prior is a factor, never
/// a cut: a chat with no younger competitor still comes back — "if no other
/// chat exists on the topic except something ancient … I'm really just
/// asking about something from a while ago" — only lower, and the model
/// reads further down the list when the user says it was long ago.
const RECENCY_HALF_LIFE_DAYS: f64 = 30.0;

/// The `event` tags the index is built from, matched against the raw line
/// before parsing, exactly as [`LISTED`](super::LISTED) is and for the same
/// reason: a 60 KB tool result would otherwise cost 60 KB of parse to learn
/// it is not conversation. A tool result whose *content* happens to contain
/// one of these still parses as a tool result and is dropped.
const INDEXED: [&str; 4] = [
    r#""event":"session_created""#,
    r#""event":"user_message""#,
    r#""event":"assistant_message""#,
    r#""event":"title""#,
];

/// The words of a text as the index counts them: lowercased runs of
/// alphanumeric characters, two or more long, English plurals folded. No
/// stop-list — BM25's inverse document frequency already makes a word every
/// chat says worth nothing — and no stemmer beyond the plural, which is a
/// second thing to be wrong in.
///
/// One character is dropped because "a", "I" and the letter a formula uses
/// are noise, and a one-letter query has the substring fallback.
pub(crate) fn tokenize(text: &str) -> Vec<String> {
    let mut terms = Vec::new();
    let mut run = String::new();
    for c in text.chars() {
        if c.is_alphanumeric() {
            run.extend(c.to_lowercase());
        } else if !run.is_empty() {
            if run.chars().count() >= 2 {
                terms.push(singular(std::mem::take(&mut run)));
            } else {
                run.clear();
            }
        }
    }
    if run.chars().count() >= 2 {
        terms.push(singular(run));
    }
    terms
}

/// One plural ending taken off, and nothing else: `ies` to `y`, `es` to
/// `e`, a final `s` dropped, each with the exceptions that keep "does",
/// "class" and "bus" whole. Harman's S-stemmer (1991), which found that
/// this rule alone gets most of what a full stemmer buys. The measurement
/// that put it here: the spec's tokeniser had no fold, and a query for
/// `competitor` could not find the chat named "Checking competitors" — the
/// one question a whole-word match lost that the substring had won. Applied
/// on both sides, so an odd stem ("thi" for "this") matches itself.
///
/// Three characters or fewer are left alone: "is", "was", "yes", "gas".
fn singular(term: String) -> String {
    if term.chars().count() <= 3 {
        return term;
    }
    // The first ending that matches decides, exception included: "does"
    // matches the `es` rule and is excepted there, and must not then fall
    // through to lose its `s` under the next one.
    let mut t = term;
    if t.ends_with("ies") {
        if !t.ends_with("eies") && !t.ends_with("aies") {
            t.truncate(t.len() - 3);
            t.push('y');
        }
    } else if t.ends_with("es") {
        if !t.ends_with("aes") && !t.ends_with("ees") && !t.ends_with("oes") {
            t.pop();
        }
    } else if t.ends_with('s') && !t.ends_with("us") && !t.ends_with("ss") {
        t.pop();
    }
    t
}

/// One turn of a chat (item 749): a user message and the replies until the
/// next one — the unit LongMemEval (a benchmark of questions over long
/// multi-session chat histories, Wu et al., ICLR 2025) found retrieval should
/// score, rather than a whole session. Counts by speaker, so a search can ask
/// for only what the user said, or only what the model did.
#[derive(Clone, Default, Serialize, Deserialize)]
pub(crate) struct Turn {
    /// When the turn began (its first message), in Unix seconds.
    at: i64,
    /// `(term id, count)`, sorted by id: the user's words, then the
    /// replies'. Ids index the chat's own `terms`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    u: Vec<(u32, u32)>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    a: Vec<(u32, u32)>,
    /// How many words each side said.
    #[serde(default)]
    ul: u32,
    #[serde(default)]
    al: u32,
}

/// Which side of the conversation a search counts (item 749).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Speaker {
    User,
    Assistant,
}

fn bump(counts: &mut Vec<(u32, u32)>, id: u32) {
    match counts.binary_search_by_key(&id, |(t, _)| *t) {
        Ok(i) => counts[i].1 += 1,
        Err(i) => counts.insert(i, (id, 1)),
    }
}

fn count_of(counts: &[(u32, u32)], id: u32) -> u32 {
    counts
        .binary_search_by_key(&id, |(t, _)| *t)
        .map_or(0, |i| counts[i].1)
}

impl Turn {
    pub(crate) fn at(&self) -> DateTime<Utc> {
        DateTime::from_timestamp(self.at, 0).unwrap_or_default()
    }

    fn tf(&self, id: u32, speaker: Option<Speaker>) -> u32 {
        match speaker {
            Some(Speaker::User) => count_of(&self.u, id),
            Some(Speaker::Assistant) => count_of(&self.a, id),
            None => count_of(&self.u, id) + count_of(&self.a, id),
        }
    }

    fn len(&self, speaker: Option<Speaker>) -> u32 {
        match speaker {
            Some(Speaker::User) => self.ul,
            Some(Speaker::Assistant) => self.al,
            None => self.ul + self.al,
        }
    }

    /// Every term id the turn says, each once.
    fn ids(&self) -> impl Iterator<Item = u32> + '_ {
        let mut u = self.u.iter().map(|(t, _)| *t).peekable();
        let mut a = self.a.iter().map(|(t, _)| *t).peekable();
        std::iter::from_fn(move || match (u.peek().copied(), a.peek().copied()) {
            (Some(x), Some(y)) if x == y => {
                u.next();
                a.next()
            }
            (Some(x), Some(y)) if x < y => u.next(),
            (Some(_), Some(_)) => a.next(),
            (Some(_), None) => u.next(),
            (None, Some(_)) => a.next(),
            (None, None) => None,
        })
    }
}

/// One log's term counts, plus what they were derived from.
///
/// ~~One bag of words per chat~~ — per turn since item 749 (2026-11-16):
/// whole-chat scoring under-ranks the chat that discussed a topic for five
/// turns out of five hundred, which is every chat once hand-offs made them
/// long. The title is no longer counted into the bag; it is read off the
/// summary when ranking and adds [`TITLE_WEIGHT`] to every turn's count.
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Indexed {
    /// Size and mtime of the log when this was taken; any disagreement with
    /// the file falls through to re-reading it, as in the listing.
    size: u64,
    modified: DateTime<Utc>,
    /// How much of the log the turns account for, always at a line boundary.
    bytes: u64,
    /// The chat's words, each with the id its turns count it under.
    terms: HashMap<String, u32>,
    turns: Vec<Turn>,
    /// The listing fields, folded from the same events, so a result line
    /// can be labelled the way the sidebar labels it without a second read.
    summary: Summarizing,
}

impl Indexed {
    fn empty(size: u64, modified: DateTime<Utc>) -> Self {
        Indexed {
            size,
            modified,
            bytes: 0,
            terms: HashMap::new(),
            turns: Vec::new(),
            summary: Summarizing::default(),
        }
    }

    fn add(&mut self, text: &str, user: bool, at: DateTime<Utc>) {
        // A user message opens a turn; a reply joins the open one, or
        // opens the first when a chat starts with the model speaking.
        if user || self.turns.is_empty() {
            self.turns.push(Turn {
                at: at.timestamp(),
                ..Turn::default()
            });
        }
        let turn = self.turns.last_mut().expect("pushed above");
        for term in tokenize(text) {
            let next = self.terms.len() as u32;
            let id = *self.terms.entry(term).or_insert(next);
            if user {
                bump(&mut turn.u, id);
                turn.ul += 1;
            } else {
                bump(&mut turn.a, id);
                turn.al += 1;
            }
        }
    }

    /// Whether this log is one the index must not admit. Decided by the
    /// creation line, which is folded first, so a record for an incognito
    /// chat exists — the cache needs something to validate the file against
    /// — and holds no term, which is what keeps it out of every ranking.
    fn unread(&self) -> bool {
        self.summary.unread_by_others()
    }

    fn saw(&mut self, event: &SessionEvent) {
        // The listing fields first: the creation event is what says whether
        // anything after it may be counted at all.
        if let Some(p) = peek_at(event) {
            self.summary.saw(p);
        }
        if self.unread() {
            return;
        }
        if let Some(s) = said(event)
            && s.conversation
        {
            self.add(&s.text, s.who == "you", s.at);
        }
    }

    /// The title's words, as the ranking counts them.
    fn title_terms(&self) -> Vec<String> {
        self.summary
            .title
            .as_deref()
            .map(tokenize)
            .unwrap_or_default()
    }

    /// How many turns the chat has.
    pub(crate) fn turn_count(&self) -> usize {
        self.turns.len()
    }

    /// When turn `i` began.
    pub(crate) fn turn_at(&self, i: usize) -> Option<DateTime<Utc>> {
        self.turns.get(i).map(Turn::at)
    }

    /// The chat this one continues after a hand-off (item 737): the
    /// creation line's `forked_from` when its reason is `handoff`, else
    /// `None` — an edit-and-send fork shares its parent's opening and is
    /// not a continuation of it.
    pub(crate) fn handoff_parent(&self) -> Option<&str> {
        self.summary
            .forked_from
            .as_ref()
            .filter(|f| f.reason.as_deref() == Some("handoff"))
            .map(|f| f.session.as_str())
    }

    /// Every turn's count of `term`, plus [`TITLE_WEIGHT`] when the name
    /// says it — the whole-chat count the tests pin.
    #[cfg(test)]
    fn count(&self, term: &str) -> u32 {
        let body: u32 = self
            .terms
            .get(term)
            .map_or(0, |&id| self.turns.iter().map(|t| t.tf(id, None)).sum());
        let named = self.title_terms().iter().filter(|t| *t == term).count() as u32;
        body + named * TITLE_WEIGHT
    }

    #[cfg(test)]
    fn body_len(&self) -> u32 {
        self.turns.iter().map(|t| t.len(None)).sum()
    }

    /// The chat's id: what the log says it is, else the file's name.
    pub(crate) fn id(&self, path: &Path) -> String {
        self.summary.summary(path, self.modified).id
    }

    pub(crate) fn modified(&self) -> DateTime<Utc> {
        self.modified
    }

    /// What to call the chat, on the listing's terms: its name, else its
    /// opening message, clipped.
    pub(crate) fn label(&self, path: &Path, max: usize) -> String {
        self.summary.summary(path, self.modified).label(max)
    }
}

/// Fold a log's terms, starting `from` a byte offset and a record carried
/// over from a previous build. Returns how far it got. The same shape as the
/// listing's `fold_from` — bytes not `read_to_string`, whole lines only, the
/// torn tail re-read next time — with a full parse of the lines that pass
/// the prefilter, because an assistant message's text is inside its blocks.
fn fold_terms(path: &Path, from: u64, mut acc: Indexed) -> Result<(Indexed, u64), StoreError> {
    let mut file = fs::File::open(path).map_err(io_err(path))?;
    if from > 0 {
        file.seek(SeekFrom::Start(from)).map_err(io_err(path))?;
    }
    let mut raw = Vec::new();
    file.read_to_end(&mut raw).map_err(io_err(path))?;
    let complete = raw.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
    for line in raw[..complete].split(|b| *b == b'\n') {
        let decoded = String::from_utf8_lossy(line);
        let line = decoded.trim_end_matches('\r');
        if !INDEXED.iter().any(|tag| line.contains(tag)) {
            continue;
        }
        // A line this crate cannot parse is a newer event or a damaged one;
        // either costs that line, as everywhere else in the store — except
        // a creation line with a mode or kind this build does not know,
        // which is read closed so the log is not admitted (backlog 134).
        if let Ok(event) = serde_json::from_str::<SessionEvent>(line) {
            acc.saw(&event);
        } else if let Some(p) = super::peek(line) {
            acc.summary.saw(p);
        }
    }
    Ok((acc, from + complete as u64))
}

/// The index of one directory: every log's term counts and the corpus
/// statistics BM25 needs over them.
#[derive(Serialize, Deserialize)]
pub struct ChatIndex {
    version: u32,
    /// How many turns, their mean length, and how many turns each term
    /// appears in (item 749: turns are BM25's documents now, not chats) —
    /// recomputed from `logs` whenever one changes and kept so a load that
    /// changed nothing does not walk every term again.
    n: u32,
    avg_len: f64,
    df: HashMap<String, u32>,
    /// Keyed by file name, as the listing is.
    logs: BTreeMap<String, Indexed>,
    /// Where the logs are, so a record can be turned back into a path.
    #[serde(skip)]
    dir: PathBuf,
}

/// One chat a query matched, and how well.
pub(crate) struct Ranked<'a> {
    pub(crate) path: PathBuf,
    pub(crate) log: &'a Indexed,
    pub(crate) score: f64,
    /// The turn that scored best (an index into the chat's turns), and how
    /// many of its turns matched at all (item 749).
    pub(crate) turn: usize,
    pub(crate) matched: usize,
}

/// What a ranking is limited to (items 737, 749). The default is the whole
/// directory, both speakers, any date, with the recency prior.
#[derive(Clone, Copy)]
pub(crate) struct Filter<'a> {
    /// Only these logs (file names) — a hand-off chain.
    pub(crate) only: Option<&'a std::collections::BTreeSet<String>>,
    pub(crate) recency_prior: bool,
    /// Turns that began at or after `after` and before `before`.
    pub(crate) after: Option<DateTime<Utc>>,
    pub(crate) before: Option<DateTime<Utc>>,
    pub(crate) speaker: Option<Speaker>,
}

impl Default for Filter<'_> {
    fn default() -> Self {
        Filter {
            only: None,
            recency_prior: true,
            after: None,
            before: None,
            speaker: None,
        }
    }
}

impl Filter<'_> {
    fn admits(&self, name: &str) -> bool {
        self.only.is_none_or(|o| o.contains(name))
    }

    fn in_range(&self, turn: &Turn) -> bool {
        let at = turn.at;
        self.after.is_none_or(|a| at >= a.timestamp())
            && self.before.is_none_or(|b| at < b.timestamp())
    }
}

/// How a chat's turn scores make its score (item 749): its best turn, plus
/// a damped share of its next two — a chat that came back to a topic three
/// times beats one that touched it once by a margin, never by a multiple.
const SECOND_TURN: f64 = 0.5;
const THIRD_TURN: f64 = 0.25;

impl ChatIndex {
    /// The index as written, or nothing for a file that is missing,
    /// malformed or from another version — every one of which is a rebuild.
    fn read(dir: &Path) -> Option<ChatIndex> {
        fs::read(dir.join(INDEX_FILE))
            .ok()
            .and_then(|raw| serde_json::from_slice::<ChatIndex>(&raw).ok())
            .filter(|i| i.version == INDEX_VERSION)
    }

    /// Write it out, or don't, on the listing's terms: a failure here costs
    /// one rebuild, through a process-named temp file and a rename so two
    /// searches at once lose an update rather than a file.
    fn write(&self) {
        let Ok(body) = serde_json::to_vec(self) else {
            return;
        };
        let tmp = self
            .dir
            .join(format!("{INDEX_FILE}.{}.tmp", std::process::id()));
        if fs::write(&tmp, body).is_ok() && fs::rename(&tmp, self.dir.join(INDEX_FILE)).is_err() {
            fs::remove_file(&tmp).ok();
        }
    }

    /// The records that are in the corpus: every log the directory holds
    /// except the incognito ones, which have a record for the cache's sake
    /// and are nothing to rank against.
    fn admitted(&self) -> impl Iterator<Item = &Indexed> {
        self.logs.values().filter(|l| !l.unread())
    }

    /// The corpus statistics, from the admitted records' turns.
    fn recount(&mut self) {
        let mut n: u32 = 0;
        let mut total: u64 = 0;
        let mut by_id: HashMap<u32, u32> = HashMap::new();
        let mut df: HashMap<String, u32> = HashMap::new();
        for log in self.admitted() {
            by_id.clear();
            for turn in &log.turns {
                n += 1;
                total += u64::from(turn.ul + turn.al);
                for id in turn.ids() {
                    *by_id.entry(id).or_default() += 1;
                }
            }
            for (term, id) in &log.terms {
                if let Some(&k) = by_id.get(id) {
                    *df.entry(term.clone()).or_default() += k;
                }
            }
        }
        self.n = n;
        self.avg_len = if n == 0 {
            0.0
        } else {
            total as f64 / f64::from(n)
        };
        self.df = df;
    }

    /// The directory's index, current as of now: read from `.index.json`,
    /// checked against every log on disk, extended or rebuilt where a log
    /// disagrees with its record, and written back if anything changed. A
    /// missing directory is an empty index, as it is an empty listing.
    ///
    /// The three arms are the listing's, in the same order: untouched,
    /// grown, anything else.
    pub fn load_or_build(dir: &Path) -> Result<ChatIndex, StoreError> {
        let mut index = ChatIndex {
            version: INDEX_VERSION,
            n: 0,
            avg_len: 0.0,
            df: HashMap::new(),
            logs: BTreeMap::new(),
            dir: dir.to_path_buf(),
        };
        if !dir.is_dir() {
            return Ok(index);
        }
        // The records to validate, and the statistics they were written
        // with — good again only if every record survives unchanged.
        let (mut known, stats) = match Self::read(dir) {
            Some(stored) => (stored.logs, Some((stored.n, stored.avg_len, stored.df))),
            None => (BTreeMap::new(), None),
        };
        let mut changed = false;

        for Log {
            path,
            len,
            modified,
        } in log_files(dir)?
        {
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            let entry = match known.remove(name.as_ref()) {
                Some(r) if r.size == len && r.modified == modified => r,
                Some(r) if len > r.size && modified >= r.modified && r.bytes <= len => {
                    changed = true;
                    let Some((acc, bytes)) = skip_deleted(fold_terms(&path, r.bytes, r))? else {
                        continue;
                    };
                    Indexed {
                        size: len,
                        modified,
                        bytes,
                        ..acc
                    }
                }
                _ => {
                    changed = true;
                    let fresh = Indexed::empty(len, modified);
                    let Some((acc, bytes)) = skip_deleted(fold_terms(&path, 0, fresh))? else {
                        continue;
                    };
                    Indexed { bytes, ..acc }
                }
            };
            index.logs.insert(name.into_owned(), entry);
        }

        // Whatever is left in `known` is a log that has since been deleted.
        if changed || !known.is_empty() {
            index.recount();
            index.write();
        } else if let Some(stats) = stats {
            // Nothing moved, so the statistics on disk are the ones this
            // set of records would produce.
            (index.n, index.avg_len, index.df) = stats;
        } else {
            index.recount();
        }
        Ok(index)
    }

    /// How many logs are indexed — the admitted ones, not the incognito
    /// records kept beside them.
    pub fn len(&self) -> usize {
        self.admitted().count()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Every chat that says at least one of the query's terms, best first,
    /// and how many there were before `limit` cut the list. Ties break
    /// newest first, so two chats that say the same thing equally come back
    /// in the order the sidebar would show them.
    ///
    /// The score is BM25 over turns (item 749): for each query term, how
    /// rare it is across every turn in the directory times how often the
    /// turn says it, the latter saturating so a turn that says a word fifty
    /// times is not fifty times more about it than one that says it five,
    /// and discounted for a long turn, which says every word more. A word
    /// in the chat's name counts [`TITLE_WEIGHT`] times in every turn. A
    /// chat scores its best turn plus [`SECOND_TURN`] and [`THIRD_TURN`] of
    /// its next two; one with no term in common scores nothing and is not
    /// returned.
    #[cfg(test)]
    pub(crate) fn rank(&self, query: &str, limit: usize) -> (Vec<Ranked<'_>>, usize) {
        self.rank_at(query, limit, Utc::now())
    }

    /// `rank` with the clock injected, so a test can age a chat.
    #[cfg(test)]
    pub(crate) fn rank_at(
        &self,
        query: &str,
        limit: usize,
        now: DateTime<Utc>,
    ) -> (Vec<Ranked<'_>>, usize) {
        self.rank_among(query, limit, now, Filter::default())
    }

    /// Every record, by file name — what a walk over the hand-off links
    /// (item 737) needs: each chat's id and the chat it continues.
    pub(crate) fn records(&self) -> impl Iterator<Item = (&str, &Indexed)> {
        self.logs.iter().map(|(n, l)| (n.as_str(), l))
    }

    /// Where a record's log is.
    pub(crate) fn path_of(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    /// `rank_at` under a [`Filter`]. The corpus statistics stay the
    /// directory's whatever is filtered: a word is as rare as the whole
    /// directory says. The recency prior is off for a hand-off chain (item
    /// 737): its chats are one conversation cut up, and the prior would bury
    /// the earlier pieces it exists to reach.
    pub(crate) fn rank_among(
        &self,
        query: &str,
        limit: usize,
        now: DateTime<Utc>,
        filter: Filter<'_>,
    ) -> (Vec<Ranked<'_>>, usize) {
        let mut terms = tokenize(query);
        terms.sort();
        terms.dedup();
        // Each term's weight across the corpus. A term no turn says can
        // still be in a name; it is then as rare as a word one turn says.
        let idf: Vec<(&str, f64)> = terms
            .iter()
            .map(|t| {
                let df = f64::from(self.df.get(t).copied().unwrap_or(0).max(1));
                let n = f64::from(self.n.max(1));
                (
                    t.as_str(),
                    (1.0 + (n - df + 0.5) / (df + 0.5)).ln().max(0.0),
                )
            })
            .collect();
        let avg = self.avg_len.max(1.0);
        let mut hits = Vec::new();
        for (name, log) in &self.logs {
            if log.unread() || !filter.admits(name) {
                continue;
            }
            let title = log.title_terms();
            // The query's terms this chat has at all, by id, and whether the
            // name says each: a chat with neither is skipped unread.
            let mut any = false;
            let ids: Vec<(Option<u32>, bool, f64)> = idf
                .iter()
                .map(|(t, w)| {
                    let id = log.terms.get(*t).copied();
                    let named = title.iter().any(|x| x == t);
                    any |= id.is_some() || named;
                    (id, named, *w)
                })
                .collect();
            if !any {
                continue;
            }
            let score_of = |turn: &Turn| -> f64 {
                let norm = 1.0 - B + B * f64::from(turn.len(filter.speaker)) / avg;
                ids.iter()
                    .map(|(id, named, w)| {
                        let tf = id.map_or(0, |id| turn.tf(id, filter.speaker))
                            + if *named { TITLE_WEIGHT } else { 0 };
                        if tf == 0 {
                            return 0.0;
                        }
                        let tf = f64::from(tf);
                        w * tf * (K1 + 1.0) / (tf + K1 * norm)
                    })
                    .sum()
            };
            // The best three turns in range, and how many matched.
            let mut top = [(0.0f64, 0usize); 3];
            let mut matched = 0;
            let mut seen_in_range = false;
            for (i, turn) in log.turns.iter().enumerate() {
                if !filter.in_range(turn) {
                    continue;
                }
                seen_in_range = true;
                let sc = score_of(turn);
                if sc <= 0.0 {
                    continue;
                }
                matched += 1;
                if sc > top[0].0 {
                    top = [(sc, i), top[0], top[1]];
                } else if sc > top[1].0 {
                    top = [top[0], (sc, i), top[1]];
                } else if sc > top[2].0 {
                    top[2] = (sc, i);
                }
            }
            // A named chat with no turn yet (or none that says the words)
            // still answers a query for its name, as one empty turn would —
            // but not under a date range none of its turns falls in.
            if matched == 0 {
                let unbounded = filter.after.is_none() && filter.before.is_none();
                if !(unbounded || seen_in_range) || !ids.iter().any(|(_, named, _)| *named) {
                    continue;
                }
                top[0] = (score_of(&Turn::default()), 0);
                if top[0].0 <= 0.0 {
                    continue;
                }
            }
            let score = top[0].0 + SECOND_TURN * top[1].0 + THIRD_TURN * top[2].0;
            // BM25 says how much a chat is about the words; the recency
            // prior says how likely it is the chat he means. Age is
            // measured from the log's last write — a chat he is still
            // adding to is current however old its first message.
            let recency = if filter.recency_prior {
                let age_days = (now - log.modified).num_seconds().max(0) as f64 / 86_400.0;
                1.0 / (1.0 + age_days / RECENCY_HALF_LIFE_DAYS)
            } else {
                1.0
            };
            hits.push(Ranked {
                path: self.dir.join(name),
                log,
                score: score * recency,
                turn: top[0].1,
                matched,
            });
        }
        hits.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then_with(|| b.log.modified.cmp(&a.log.modified))
        });
        let total = hits.len();
        hits.truncate(limit);
        (hits, total)
    }

    /// Chats with turns in a date range, newest turn first, for browsing
    /// by date with no words (item 749: "what did we do yesterday" has no
    /// keywords). Each with how many of its turns fall in the range and the
    /// first of them.
    pub(crate) fn browse(
        &self,
        limit: usize,
        filter: Filter<'_>,
    ) -> (Vec<(PathBuf, &Indexed, usize, usize)>, usize) {
        let mut rows = Vec::new();
        for (name, log) in &self.logs {
            if log.unread() || !filter.admits(name) {
                continue;
            }
            let inside: Vec<usize> = (0..log.turns.len())
                .filter(|&i| filter.in_range(&log.turns[i]))
                .collect();
            let (Some(&first), Some(&last)) = (inside.first(), inside.last()) else {
                continue;
            };
            rows.push((
                log.turns[last].at,
                self.dir.join(name),
                log,
                inside.len(),
                first,
            ));
        }
        rows.sort_by_key(|r| std::cmp::Reverse(r.0));
        let total = rows.len();
        rows.truncate(limit);
        (
            rows.into_iter()
                .map(|(_, p, l, n, f)| (p, l, n, f))
                .collect(),
            total,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nightloom_core::{ContentBlock, Session, Usage};

    fn scratch() -> PathBuf {
        // A counter beside the clock (2026-09-15): macOS reports the time in
        // microseconds, so two tests starting in the same tick shared a
        // directory and one of them found the other's logs — a flake that
        // moved between tests from run to run.
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("nightloom-index-{nanos}-{n}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A real log through `Session`, with a tool result and a thought in it
    /// so the tests can pin what is not indexed.
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
        if !title.is_empty() {
            s.record_title(title);
        }
        s.id.clone()
    }

    fn record<'a>(index: &'a ChatIndex, id: &str) -> &'a Indexed {
        &index.logs[&format!("{id}.jsonl")]
    }

    fn titles(hits: &[Ranked<'_>]) -> Vec<String> {
        hits.iter().map(|h| h.log.label(&h.path, 80)).collect()
    }

    #[test]
    fn the_tokeniser_lowercases_splits_on_anything_not_alphanumeric_and_drops_singles() {
        // The possessive's "s", the "a", the Greek letter and the digits of
        // "3.5" are all one character long and go.
        assert_eq!(
            tokenize("Stuart's LessWrong post, v2 — a Δ of 3.5%!"),
            ["stuart", "lesswrong", "post", "v2", "of"]
        );
        assert_eq!(tokenize("ÉCOLE naïve"), ["école", "naïve"]);
        assert!(tokenize("→ … !").is_empty());
        assert!(tokenize("").is_empty());
        // Plurals fold to the word the query would use; the exceptions and
        // short words are left whole.
        assert_eq!(
            tokenize("competitors choices theories does class bus yes"),
            [
                "competitor",
                "choice",
                "theory",
                "does",
                "class",
                "bus",
                "yes"
            ]
        );
        assert_eq!(tokenize("competitor"), ["competitor"]);
    }

    /// The whole thing, once: a build writes the file, counts every log,
    /// weights the title, and a second load with nothing changed reads the
    /// same statistics back rather than recounting them.
    #[test]
    fn a_build_writes_the_file_and_counts_every_log() {
        let dir = scratch();
        let a = logged(
            &dir,
            "Rewinding",
            "how do I rewind?",
            "A rewind is a marker.",
            "",
        );
        logged(&dir, "", "something else", "an answer", "");

        let index = ChatIndex::load_or_build(&dir).unwrap();
        assert!(dir.join(INDEX_FILE).is_file(), "no index was written");
        assert_eq!(index.len(), 2);
        assert_eq!(index.n, 2);
        let rec = record(&index, &a);
        // Once in the question, once in the reply, three times for the name.
        assert_eq!(rec.count("rewind"), 2);
        assert_eq!(rec.count("rewinding"), TITLE_WEIGHT);
        assert_eq!(rec.id(&dir.join(format!("{a}.jsonl"))), a);
        assert_eq!(index.df["rewind"], 1);
        assert_eq!(index.df["an"], 1);

        let again = ChatIndex::load_or_build(&dir).unwrap();
        assert_eq!(again.n, index.n);
        assert_eq!(again.df, index.df);
        assert_eq!(again.avg_len, index.avg_len);

        fs::remove_dir_all(&dir).ok();
    }

    /// A log that grew is read from where the last build stopped: the part
    /// already read is changed in place, then a turn is appended, and the
    /// new count reflects the turn but not the change.
    #[test]
    fn a_grown_log_is_indexed_from_its_offset() {
        let dir = scratch();
        let id = logged(&dir, "", "AAAAAAAA is here", "a reply", "");
        let path = dir.join(format!("{id}.jsonl"));
        let before = ChatIndex::load_or_build(&dir).unwrap();
        let (len, bytes) = {
            let r = record(&before, &id);
            assert_eq!(r.count("aaaaaaaa"), 1);
            (r.body_len(), r.bytes)
        };
        assert_eq!(bytes, fs::metadata(&path).unwrap().len());

        let raw = fs::read(&path).unwrap();
        let swapped = String::from_utf8(raw)
            .unwrap()
            .replace("AAAAAAAA", "BBBBBBBB");
        fs::write(&path, swapped).unwrap();
        Session::load(&path)
            .unwrap()
            .record_user("a second question about zebras");

        let after = ChatIndex::load_or_build(&dir).unwrap();
        let r = record(&after, &id);
        assert!(r.body_len() > len, "the appended turn was missed");
        assert_eq!(r.count("zebra"), 1);
        assert_eq!(
            Some(r.count("aaaaaaaa")).filter(|n| *n > 0),
            Some(1),
            "the prefix was re-read, so nothing was saved"
        );
        assert!(!(r.count("bbbbbbbb") > 0));

        fs::remove_file(dir.join(INDEX_FILE)).unwrap();
        let rebuilt = ChatIndex::load_or_build(&dir).unwrap();
        assert!((record(&rebuilt, &id).count("bbbbbbbb") > 0));

        fs::remove_dir_all(&dir).ok();
    }

    /// A rename takes the old name's words out before the new one's go in,
    /// or a chat stays findable by a name it no longer has.
    #[test]
    fn a_renamed_chat_drops_the_old_names_words() {
        let dir = scratch();
        let id = logged(&dir, "Parsnips", "a question", "a reply", "");
        let path = dir.join(format!("{id}.jsonl"));
        let first = ChatIndex::load_or_build(&dir).unwrap();
        assert_eq!(record(&first, &id).count("parsnip"), TITLE_WEIGHT);

        Session::load(&path).unwrap().record_title("Turnips");
        let second = ChatIndex::load_or_build(&dir).unwrap();
        let r = record(&second, &id);
        assert!(!(r.count("parsnip") > 0));
        assert_eq!(r.count("turnip"), TITLE_WEIGHT);
        assert_eq!(r.body_len(), first.logs[&format!("{id}.jsonl")].body_len());

        fs::remove_dir_all(&dir).ok();
    }

    /// An incognito log is never admitted: its words are not counted, it is
    /// not in `n` or `df`, and a query for the one word only it says finds
    /// nothing — on a cold build, on a warm load, and after it grows.
    #[test]
    fn an_incognito_log_is_never_admitted() {
        let dir = scratch();
        let mut inc = Session::incognito(&dir).unwrap();
        inc.record_user("the secret word is xylophone");
        inc.record_assistant(
            "m",
            vec![ContentBlock::Text {
                text: "xylophone noted".into(),
            }],
            None,
            Usage::default(),
        );
        inc.record_title("Xylophone plans");
        logged(
            &dir,
            "Rewinding",
            "how do I rewind?",
            "A rewind is a marker.",
            "",
        );

        for pass in ["cold", "warm"] {
            let index = ChatIndex::load_or_build(&dir).unwrap();
            assert_eq!(index.len(), 1, "{pass}");
            assert_eq!(index.n, 1, "{pass}");
            assert!(!index.df.contains_key("xylophone"), "{pass}");
            let rec = record(&index, &inc.id);
            assert!(rec.terms.is_empty() && rec.turns.is_empty(), "{pass}");
            assert_eq!(rec.body_len(), 0, "{pass}");
            let (hits, total) = index.rank("xylophone", 10);
            assert!(hits.is_empty() && total == 0, "{pass}");
            let (hits, _) = index.rank("rewind", 10);
            assert_eq!(hits.len(), 1, "{pass}");
        }

        // Grows from its offset, like any log, and still counts nothing.
        inc.record_user("more about the xylophone");
        let index = ChatIndex::load_or_build(&dir).unwrap();
        assert!(record(&index, &inc.id).terms.is_empty());
        assert_eq!(index.n, 1);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_deleted_log_leaves_the_index() {
        let dir = scratch();
        logged(&dir, "", "the first", "a reply", "");
        let id = logged(&dir, "", "the second", "a reply", "");
        assert_eq!(ChatIndex::load_or_build(&dir).unwrap().len(), 2);

        super::super::delete(&dir, &id).unwrap();
        let index = ChatIndex::load_or_build(&dir).unwrap();
        assert_eq!(index.len(), 1);
        assert_eq!(index.n, 1);
        assert!(!index.df.contains_key("second"));

        fs::remove_dir_all(&dir).ok();
    }

    /// Derived data, never authoritative: anything unexpected in the file
    /// costs a rebuild and nothing else.
    #[test]
    fn a_corrupt_index_is_rebuilt() {
        let dir = scratch();
        logged(&dir, "", "the opening question", "a reply", "");
        let file = dir.join(INDEX_FILE);

        for bad in [
            "not json at all".to_string(),
            "{}".to_string(),
            format!(
                r#"{{"version":{},"n":0,"avg_len":0.0,"df":{{}},"logs":{{}}}}"#,
                INDEX_VERSION + 1
            ),
        ] {
            fs::write(&file, &bad).unwrap();
            let index = ChatIndex::load_or_build(&dir).unwrap();
            assert_eq!(index.len(), 1, "{bad}");
            assert_eq!(index.df.get("opening"), Some(&1), "{bad}");
            let (hits, _) = index.rank("opening", 5);
            assert_eq!(hits.len(), 1, "{bad}");
        }

        fs::remove_dir_all(&dir).ok();
    }

    /// The ranking's two promises: saying a word more puts a chat above one
    /// that says it once, and a word in the name outweighs one in the body.
    #[test]
    fn rank_prefers_repetition_and_the_title() {
        let dir = scratch();
        let once = logged(&dir, "", "one mention of kestrels", "noted", "");
        let thrice = logged(
            &dir,
            "",
            "kestrels, kestrels and more kestrels",
            "kestrels indeed",
            "",
        );
        let named = logged(&dir, "Kestrels", "a question", "a reply", "");
        logged(&dir, "", "nothing relevant", "no", "");
        let index = ChatIndex::load_or_build(&dir).unwrap();

        let (hits, total) = index.rank("kestrels", 10);
        assert_eq!(total, 3);
        let ids: Vec<String> = hits.iter().map(|h| h.log.id(&h.path)).collect();
        assert_eq!(ids[2], once, "{ids:?}");
        assert!(ids[0] == named || ids[0] == thrice, "{ids:?}");
        assert!(hits[0].score >= hits[1].score && hits[1].score > hits[2].score);

        // A single body mention against a title mention, nothing else.
        let two = scratch();
        let body = logged(&two, "", "one mention of kestrels", "noted", "");
        let name = logged(&two, "Kestrels", "a question", "a reply", "");
        let index = ChatIndex::load_or_build(&two).unwrap();
        let (hits, _) = index.rank("KESTRELS", 2);
        assert_eq!(titles(&hits)[0], "Kestrels");
        assert_eq!(hits[0].log.id(&hits[0].path), name);
        assert_eq!(hits[1].log.id(&hits[1].path), body);

        // A term nobody says, and a query with no term at all.
        assert_eq!(index.rank("ospreys", 5).1, 0);
        assert_eq!(index.rank("→", 5).1, 0);

        fs::remove_dir_all(&dir).ok();
        fs::remove_dir_all(&two).ok();
    }

    /// Recency is a prior on the score, never a cut: a year-old chat that
    /// says the word three times loses to last week's that says it once,
    /// and still comes back alone when nothing newer says it at all.
    #[test]
    fn an_old_chat_ranks_below_a_recent_one_and_is_never_dropped() {
        let dir = scratch();
        let old = logged(&dir, "", "kestrels, kestrels and kestrels again", "yes", "");
        let new = logged(&dir, "", "one kestrels mention", "noted", "");
        let mut index = ChatIndex::load_or_build(&dir).unwrap();
        let now = Utc::now();
        // Both fresh: repetition wins, as before.
        let (hits, _) = index.rank_at("kestrels", 2, now);
        assert_eq!(hits[0].log.id(&hits[0].path), old);
        // Age the repetitive one by a year (the field, not the file: the
        // prior reads the index's record of the last write).
        index
            .logs
            .get_mut(&format!("{old}.jsonl"))
            .unwrap()
            .modified = now - chrono::Duration::days(365);
        let (hits, total) = index.rank_at("kestrels", 2, now);
        assert_eq!(total, 2);
        assert_eq!(hits[0].log.id(&hits[0].path), new, "{:?}", titles(&hits));
        assert_eq!(hits[1].log.id(&hits[1].path), old);
        // Half-life: at 30 days the factor is one half.
        let (fresh, _) = index.rank_at("kestrels", 2, now);
        let (aged, _) = index.rank_at("kestrels", 2, now + chrono::Duration::days(30));
        let f = fresh
            .iter()
            .find(|h| h.log.id(&h.path) == new)
            .unwrap()
            .score;
        let a = aged
            .iter()
            .find(|h| h.log.id(&h.path) == new)
            .unwrap()
            .score;
        assert!((a / f - 0.5).abs() < 0.02, "{f} → {a}");
        // Only the old chat says it: it is still the answer.
        let (hits, total) = index.rank_at("again", 5, now);
        assert_eq!(total, 1);
        assert_eq!(hits[0].log.id(&hits[0].path), old);
        fs::remove_dir_all(&dir).ok();
    }

    /// Pinned: a word that appears only in a tool result, or only in a
    /// thought, is not a term.
    #[test]
    fn no_tool_result_or_thinking_term_is_indexed() {
        let dir = scratch();
        logged(
            &dir,
            "Config check",
            "check the config",
            "It looks fine.",
            "max_rounds = 24\nlicense = MIT",
        );
        let index = ChatIndex::load_or_build(&dir).unwrap();
        assert!(!index.df.contains_key("license"));
        assert!(!index.df.contains_key("max"));
        assert!(!index.df.contains_key("parsnip"));
        assert_eq!(index.rank("license", 5).1, 0);
        assert_eq!(index.rank("config", 5).1, 1);

        fs::remove_dir_all(&dir).ok();
    }

    /// The prefilter is pinned against the writer's output, as the
    /// listing's is: a tag emitted in another form would silently empty
    /// every index.
    #[test]
    fn the_index_reads_the_tags_the_writer_actually_emits() {
        let dir = scratch();
        let id = logged(&dir, "A name", "a question", "a reply", "");
        let raw = fs::read_to_string(dir.join(format!("{id}.jsonl"))).unwrap();
        for tag in INDEXED {
            assert!(raw.contains(tag), "the writer no longer emits {tag}");
        }
        fs::remove_dir_all(&dir).ok();
    }

    /// The index lives beside the logs and must be invisible to everything
    /// that walks the directory looking for one.
    #[test]
    fn the_index_is_not_mistaken_for_a_session() {
        let dir = scratch();
        logged(&dir, "", "a question", "a reply", "");
        ChatIndex::load_or_build(&dir).unwrap();
        assert!(dir.join(INDEX_FILE).is_file());
        assert_eq!(super::super::count(&dir), 1);
        assert_eq!(super::super::list(&dir).unwrap().len(), 1);
        assert_eq!(ChatIndex::load_or_build(&dir).unwrap().len(), 1);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_dir_is_an_empty_index() {
        let dir = std::env::temp_dir().join("nightloom-index-does-not-exist");
        let index = ChatIndex::load_or_build(&dir).unwrap();
        assert!(index.is_empty());
        assert_eq!(index.rank("anything", 5).1, 0);
    }
}
