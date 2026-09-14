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
/// rebuilt rather than migrated: it is derived data.
const INDEX_VERSION: u32 = 1;

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

/// One log's term counts, plus what they were derived from.
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Indexed {
    /// Size and mtime of the log when this was taken; any disagreement with
    /// the file falls through to re-reading it, as in the listing.
    size: u64,
    modified: DateTime<Utc>,
    /// How much of the log `tf` accounts for, always at a line boundary.
    bytes: u64,
    /// Terms in the chat, the title counted [`TITLE_WEIGHT`] times.
    len: u32,
    tf: HashMap<String, u32>,
    /// The listing fields, folded from the same events, so a result line
    /// can be labelled the way the sidebar labels it without a second read.
    summary: Summarizing,
}

impl Indexed {
    fn add(&mut self, text: &str, weight: u32) {
        for term in tokenize(text) {
            *self.tf.entry(term).or_default() += weight;
            self.len += weight;
        }
    }

    /// The title is latest-wins, so a rename has to take the old name's
    /// words back out before the new one's go in.
    fn remove(&mut self, text: &str, weight: u32) {
        for term in tokenize(text) {
            if let Some(n) = self.tf.get_mut(&term) {
                *n = n.saturating_sub(weight);
                if *n == 0 {
                    self.tf.remove(&term);
                }
            }
            self.len = self.len.saturating_sub(weight);
        }
    }

    fn saw(&mut self, event: &SessionEvent) {
        if let Some(s) = said(event) {
            if s.conversation {
                self.add(&s.text, 1);
            } else {
                if let Some(old) = self.summary.title.clone() {
                    self.remove(&old, TITLE_WEIGHT);
                }
                self.add(&s.text, TITLE_WEIGHT);
            }
        }
        if let Some(p) = peek_at(event) {
            self.summary.saw(p);
        }
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
        // either costs that line, as everywhere else in the store.
        if let Ok(event) = serde_json::from_str::<SessionEvent>(line) {
            acc.saw(&event);
        }
    }
    Ok((acc, from + complete as u64))
}

/// The index of one directory: every log's term counts and the corpus
/// statistics BM25 needs over them.
#[derive(Serialize, Deserialize)]
pub struct ChatIndex {
    version: u32,
    /// How many logs, the mean of their `len`, and how many logs each term
    /// appears in — recomputed from `logs` whenever one changes and kept so
    /// a load that changed nothing does not walk every term again.
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
}

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

    /// The corpus statistics, from the records.
    fn recount(&mut self) {
        self.n = self.logs.len() as u32;
        let total: u64 = self.logs.values().map(|l| u64::from(l.len)).sum();
        self.avg_len = if self.n == 0 {
            0.0
        } else {
            total as f64 / f64::from(self.n)
        };
        self.df.clear();
        for log in self.logs.values() {
            for term in log.tf.keys() {
                *self.df.entry(term.clone()).or_default() += 1;
            }
        }
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
                    let fresh = Indexed {
                        size: len,
                        modified,
                        bytes: 0,
                        len: 0,
                        tf: HashMap::new(),
                        summary: Summarizing::default(),
                    };
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

    /// How many logs are indexed.
    pub fn len(&self) -> usize {
        self.logs.len()
    }

    pub fn is_empty(&self) -> bool {
        self.logs.is_empty()
    }

    /// Every chat that says at least one of the query's terms, best first,
    /// and how many there were before `limit` cut the list. Ties break
    /// newest first, so two chats that say the same thing equally come back
    /// in the order the sidebar would show them.
    ///
    /// The score is BM25: for each query term, how rare it is across the
    /// corpus times how often this chat says it, the latter saturating so a
    /// chat that says a word fifty times is not fifty times more about it
    /// than one that says it five, and discounted for a long chat, which
    /// says every word more. A chat with no term in common scores nothing
    /// and is not returned.
    pub(crate) fn rank(&self, query: &str, limit: usize) -> (Vec<Ranked<'_>>, usize) {
        let mut terms = tokenize(query);
        terms.sort();
        terms.dedup();
        let mut scores: HashMap<&str, f64> = HashMap::new();
        for term in &terms {
            let Some(&df) = self.df.get(term) else {
                continue;
            };
            let idf =
                (1.0 + (f64::from(self.n) - f64::from(df) + 0.5) / (f64::from(df) + 0.5)).ln();
            for (name, log) in &self.logs {
                let Some(&tf) = log.tf.get(term) else {
                    continue;
                };
                let tf = f64::from(tf);
                let norm = 1.0 - B + B * f64::from(log.len) / self.avg_len.max(1.0);
                *scores.entry(name).or_default() += idf * tf * (K1 + 1.0) / (tf + K1 * norm);
            }
        }
        let mut hits: Vec<Ranked<'_>> = scores
            .into_iter()
            .map(|(name, score)| Ranked {
                path: self.dir.join(name),
                log: &self.logs[name],
                score,
            })
            .collect();
        hits.sort_by(|a, b| {
            b.score
                .total_cmp(&a.score)
                .then_with(|| b.log.modified.cmp(&a.log.modified))
        });
        let total = hits.len();
        hits.truncate(limit);
        (hits, total)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nightloom_core::{ContentBlock, Session, Usage};

    fn scratch() -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("nightloom-index-{nanos}"));
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
        assert_eq!(rec.tf["rewind"], 2);
        assert_eq!(rec.tf["rewinding"], TITLE_WEIGHT);
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
            assert_eq!(r.tf["aaaaaaaa"], 1);
            (r.len, r.bytes)
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
        assert!(r.len > len, "the appended turn was missed");
        assert_eq!(r.tf["zebra"], 1);
        assert_eq!(
            r.tf.get("aaaaaaaa"),
            Some(&1),
            "the prefix was re-read, so nothing was saved"
        );
        assert!(!r.tf.contains_key("bbbbbbbb"));

        fs::remove_file(dir.join(INDEX_FILE)).unwrap();
        let rebuilt = ChatIndex::load_or_build(&dir).unwrap();
        assert!(record(&rebuilt, &id).tf.contains_key("bbbbbbbb"));

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
        assert_eq!(record(&first, &id).tf["parsnip"], TITLE_WEIGHT);

        Session::load(&path).unwrap().record_title("Turnips");
        let second = ChatIndex::load_or_build(&dir).unwrap();
        let r = record(&second, &id);
        assert!(!r.tf.contains_key("parsnip"));
        assert_eq!(r.tf["turnip"], TITLE_WEIGHT);
        assert_eq!(r.len, first.logs[&format!("{id}.jsonl")].len);

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
