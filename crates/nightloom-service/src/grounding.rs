//! The no-invention check (nightshift item 280, 2026-10-02): every proper
//! name, number and date in a line the memory passes write must appear in
//! the user's own messages in the chat the line cites.
//!
//! Why it exists: the 278 sample found a memory line naming "Wickey Wang"
//! where his message said "Jiewen Wang", calling a group "tied to Stuart"
//! where his message never named Stuart, and dated Oct 2 for a Sep 22
//! message. The observation was already wrong when capture wrote it: the
//! name and the link came from the assistant's web-research reply in the
//! same chat, and capture filed them as `user_stated`. A prompt rule did
//! not stop it, so this is a mechanical gate in front of the write, used
//! by both stages ([`crate::capture`] before appending, [`crate::dream`]
//! after its turn, taking back any line that fails).
//!
//! What counts, and how it is compared — light on purpose, so the check
//! refuses inventions and not paraphrase:
//!
//! - **Names:** a word that starts with a capital letter anywhere but the
//!   start of a sentence, or has a capital or a digit inside it (`RStudio`,
//!   `GPT4`). Sentence-initial words are skipped because English capitalises
//!   them; a name that opens a sentence is usually named again inside one.
//!   Compared case-insensitively as whole words, possessives stripped
//!   (`Jiewen's` → `jiewen`), so "wickey" inside an email address in his
//!   message does not vouch for "Wickey".
//! - **Numbers:** digit runs, thousands separators dropped, `$` and `%`
//!   ignored. His "two" vouches for a 2 (zero to twenty).
//! - **Dates:** ISO (`2026-09-22`), `9/22`, `Sep 22`, `22 September`,
//!   `September 2026`, a capitalised month alone, a bare year. A date in the
//!   line agrees with one in his text when every part both have is equal
//!   (`2026-09-22` agrees with his "sep 22"), and also with the day any of
//!   his messages in that chat was sent — the date a memory is filed under
//!   is the message's own.
//!
//! Source text is **the user's messages only** (blocker 930): the
//! assistant's replies are exactly where "Wickey" came from. Content he
//! pasted is inside his message and counts.

use std::collections::HashSet;
use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use chrono::{DateTime, Datelike, Local, Utc};
use regex::Regex;

/// One of the user's messages: when it was sent and what it said.
#[derive(Debug, Clone)]
pub struct Said {
    pub at: DateTime<Utc>,
    pub text: String,
}

/// A date at whatever precision the text gave it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Date {
    y: Option<i32>,
    m: Option<u32>,
    d: Option<u32>,
}

impl Date {
    fn of(at: DateTime<Utc>) -> [Date; 2] {
        let local = at.with_timezone(&Local);
        [
            Date {
                y: Some(at.year()),
                m: Some(at.month()),
                d: Some(at.day()),
            },
            Date {
                y: Some(local.year()),
                m: Some(local.month()),
                d: Some(local.day()),
            },
        ]
    }

    /// Whether the evidence date `e` vouches for this one: every part this
    /// date has, `e` has and agrees on — except a year `e` lacks when `e`
    /// names the month ("sep 22" vouches for 2026-09-22).
    fn agrees(&self, e: &Date) -> bool {
        let part = |a: Option<u32>, b: Option<u32>| match (a, b) {
            (Some(a), Some(b)) => a == b,
            (Some(_), None) => false,
            (None, _) => true,
        };
        let year = match (self.y, e.y) {
            (Some(a), Some(b)) => a == b,
            (Some(_), None) => e.m.is_some(),
            (None, _) => true,
        };
        year && part(self.m, e.m) && part(self.d, e.d)
    }

    fn shown(&self) -> String {
        match (self.y, self.m, self.d) {
            (Some(y), Some(m), Some(d)) => format!("{y:04}-{m:02}-{d:02}"),
            (Some(y), Some(m), None) => format!("{y:04}-{m:02}"),
            (None, Some(m), Some(d)) => format!("{} {d}", month_name(m)),
            (None, Some(m), None) => month_name(m).to_string(),
            (Some(y), None, _) => format!("{y}"),
            _ => "a date".into(),
        }
    }
}

fn month_name(m: u32) -> &'static str {
    [
        "?",
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ]
    .get(m as usize)
    .copied()
    .unwrap_or("?")
}

fn month_of(word: &str) -> Option<u32> {
    let w = word.to_ascii_lowercase();
    let w = w.trim_end_matches('.');
    let m = match w.get(..3)? {
        "jan" => 1,
        "feb" => 2,
        "mar" => 3,
        "apr" => 4,
        "may" => 5,
        "jun" => 6,
        "jul" => 7,
        "aug" => 8,
        "sep" => 9,
        "oct" => 10,
        "nov" => 11,
        "dec" => 12,
        _ => return None,
    };
    Some(m)
}

const MONTH: &str = r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

static ISO: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(\d{4})-(\d{1,2})(?:-(\d{1,2}))?\b").unwrap());
static SLASH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\b").unwrap());
static MONTH_DAY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i)\b({MONTH})\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?\b(?:,?\s+(\d{{4}})\b)?"
    ))
    .unwrap()
});
static DAY_MONTH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i)\b(\d{{1,2}})(?:st|nd|rd|th)?\s+(?:of\s+)?({MONTH})\b\.?(?:,?\s+(\d{{4}})\b)?"
    ))
    .unwrap()
});
static MONTH_YEAR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"(?i)\b({MONTH})\.?,?\s+(\d{{4}})\b")).unwrap());
/// A month named alone counts only capitalised: "may" and "march" are verbs.
static BARE_MONTH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\b",
    )
    .unwrap()
});
static YEAR: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b((?:19|20)\d{2})\b").unwrap());
static NUMBER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:^|[^\p{L}\p{N}_.,])(\d+(?:[.,]\d+)*)").unwrap());
static WORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[\p{L}\p{N}_]+(?:['’][\p{L}]+)?").unwrap());
/// A provenance cite: a parenthetical naming a kind, or one naming a chat.
static CITE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\([^()]*\b(?:user_stated|inferred|external|chats?\s+[0-9a-f]{8})\b[^()]*\)")
        .unwrap()
});
static CHAT_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bchats?\s+((?:[0-9a-f]{8}\b[,;\s]*(?:and\s+)?)+)").unwrap());
static HEX8: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b[0-9a-f]{8}\b").unwrap());
static WIKILINK: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\[\[[^\]]*\]\]").unwrap());
static MD_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\]\([^)]*\)").unwrap());

/// Words that are capitalised mid-sentence without naming anything.
const STOP: &[&str] = &[
    "i",
    "i'm",
    "i've",
    "i'd",
    "i'll",
    "ok",
    "okay",
    "user",
    "nightloom",
];

/// The user's own name, which the memory passes write ("Swaraag prefers
/// …") and he never types: the account's full name (`id -F` on macOS),
/// read once, lowercased word by word. Empty where `id -F` is not a thing.
static OWN_NAME: LazyLock<Vec<String>> = LazyLock::new(|| {
    std::process::Command::new("id")
        .arg("-F")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            WORD.find_iter(&String::from_utf8_lossy(&o.stdout))
                .map(|m| norm_word(m.as_str()))
                .collect()
        })
        .unwrap_or_default()
});

const NUMBER_WORDS: &[&str] = &[
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
    "twenty",
];

/// `Jiewen's` → `jiewen`, `Stuart’s` → `stuart`, `parents'` → `parents`.
fn norm_word(w: &str) -> String {
    let w = w.to_lowercase().replace('’', "'");
    let w = w.strip_suffix("'s").unwrap_or(&w).to_string();
    w.trim_end_matches('\'').to_string()
}

fn norm_number(n: &str) -> String {
    // "12,938" → "12938"; a decimal point is kept.
    let n = n.replace(',', "");
    n.trim_end_matches('.').to_string()
}

/// Every date in `text`, with the byte spans it took.
fn dates_in(text: &str) -> Vec<(Date, std::ops::Range<usize>)> {
    let mut out: Vec<(Date, std::ops::Range<usize>)> = Vec::new();
    let taken = |out: &Vec<(Date, std::ops::Range<usize>)>, r: &std::ops::Range<usize>| {
        out.iter().any(|(_, s)| s.start < r.end && r.start < s.end)
    };
    let num = |m: Option<regex::Match>| m.and_then(|m| m.as_str().parse::<u32>().ok());
    for c in ISO.captures_iter(text) {
        let r = c.get(0).unwrap().range();
        let (y, m, d) = (num(c.get(1)), num(c.get(2)), num(c.get(3)));
        if m.is_some_and(|m| (1..=12).contains(&m)) && d.is_none_or(|d| (1..=31).contains(&d)) {
            out.push((
                Date {
                    y: y.map(|y| y as i32),
                    m,
                    d,
                },
                r,
            ));
        }
    }
    for c in MONTH_DAY.captures_iter(text) {
        let r = c.get(0).unwrap().range();
        let d = num(c.get(2));
        if taken(&out, &r) || !d.is_some_and(|d| (1..=31).contains(&d)) {
            continue;
        }
        out.push((
            Date {
                y: num(c.get(3)).map(|y| y as i32),
                m: month_of(c.get(1).unwrap().as_str()),
                d,
            },
            r,
        ));
    }
    for c in DAY_MONTH.captures_iter(text) {
        let r = c.get(0).unwrap().range();
        let d = num(c.get(1));
        if taken(&out, &r) || !d.is_some_and(|d| (1..=31).contains(&d)) {
            continue;
        }
        out.push((
            Date {
                y: num(c.get(3)).map(|y| y as i32),
                m: month_of(c.get(2).unwrap().as_str()),
                d,
            },
            r,
        ));
    }
    for c in MONTH_YEAR.captures_iter(text) {
        let r = c.get(0).unwrap().range();
        if taken(&out, &r) {
            continue;
        }
        out.push((
            Date {
                y: num(c.get(2)).map(|y| y as i32),
                m: month_of(c.get(1).unwrap().as_str()),
                d: None,
            },
            r,
        ));
    }
    for c in SLASH.captures_iter(text) {
        let r = c.get(0).unwrap().range();
        let (m, d) = (num(c.get(1)), num(c.get(2)));
        if taken(&out, &r)
            || !m.is_some_and(|m| (1..=12).contains(&m))
            || !d.is_some_and(|d| (1..=31).contains(&d))
        {
            continue;
        }
        let y = num(c.get(3)).map(|y| if y < 100 { 2000 + y as i32 } else { y as i32 });
        out.push((Date { y, m, d }, r));
    }
    for c in BARE_MONTH.find_iter(text) {
        let r = c.range();
        // "May work with …" opens a sentence; it is not the month.
        if taken(&out, &r) || initial_at(text, r.start) {
            continue;
        }
        out.push((
            Date {
                y: None,
                m: month_of(c.as_str()),
                d: None,
            },
            r,
        ));
    }
    for c in YEAR.find_iter(text) {
        let r = c.range();
        if taken(&out, &r) {
            continue;
        }
        out.push((
            Date {
                y: c.as_str().parse().ok(),
                m: None,
                d: None,
            },
            r,
        ));
    }
    out
}

/// Whether the word at byte `at` opens a sentence or a list item, where
/// English capitalises whatever comes.
fn initial_at(text: &str, at: usize) -> bool {
    let before = text[..at].trim_end();
    before.is_empty()
        || before.ends_with([
            '.', '!', '?', ':', ';', '—', '–', '-', '(', '"', '“', '|', '*', '>', '#', ']',
        ])
        || before.rsplit(char::is_whitespace).next().is_some_and(|p| {
            p.chars()
                .all(|c| c.is_ascii_digit() || c == '.' || c == ')')
        })
}

/// What the user's messages vouch for.
#[derive(Debug, Default)]
pub struct Evidence {
    words: HashSet<String>,
    numbers: HashSet<String>,
    dates: Vec<Date>,
    /// The days his messages were sent: what a date filed with a memory
    /// may be (item 280: "dates are the message's date").
    sent: Vec<Date>,
}

impl Evidence {
    pub fn from_said(said: &[Said]) -> Self {
        let mut e = Evidence::default();
        for s in said {
            e.add_text(&s.text);
            e.sent.extend(Date::of(s.at));
        }
        e
    }

    fn add_text(&mut self, text: &str) {
        for m in WORD.find_iter(text) {
            let w = norm_word(m.as_str());
            if let Some(i) = NUMBER_WORDS.iter().position(|n| *n == w) {
                self.numbers.insert(i.to_string());
            }
            self.words.insert(w);
        }
        for c in NUMBER.captures_iter(text) {
            self.numbers.insert(norm_number(&c[1]));
        }
        for (d, _) in dates_in(text) {
            self.dates.push(d);
        }
    }

    fn vouches_date(&self, d: &Date) -> bool {
        self.dates.iter().chain(&self.sent).any(|e| d.agrees(e))
            || (d.m.is_none() && d.y.is_some_and(|y| self.numbers.contains(&y.to_string())))
    }
}

/// A line with its provenance cites, wikilinks and link targets taken
/// out: what is left is the claim.
fn claim_text(line: &str) -> String {
    let t = CITE.replace_all(line, " ");
    let t = WIKILINK.replace_all(&t, " ");
    let t = MD_URL.replace_all(&t, "] ");
    t.into_owned()
}

/// The checkable tokens in a claim: names, numbers and dates, as shown.
#[derive(Debug, Default)]
struct Claims {
    names: Vec<String>,
    numbers: Vec<String>,
    dates: Vec<Date>,
}

fn claims_in(line: &str, exempt: &[String]) -> Claims {
    let text = claim_text(line);
    let mut out = Claims::default();
    let mut blanked = text.clone();
    for (d, r) in dates_in(&text) {
        out.dates.push(d);
        blanked.replace_range(r.clone(), &" ".repeat(r.len()));
    }
    for c in NUMBER.captures_iter(&blanked) {
        out.numbers.push(norm_number(&c[1]));
    }
    let exempt: HashSet<String> = exempt
        .iter()
        .flat_map(|e| {
            WORD.find_iter(e)
                .map(|m| norm_word(m.as_str()))
                .collect::<Vec<_>>()
        })
        .collect();
    for m in WORD.find_iter(&blanked) {
        let w = m.as_str();
        let has_letter = w.chars().any(char::is_alphabetic);
        if !has_letter {
            continue;
        }
        let first_upper = w.chars().next().is_some_and(char::is_uppercase);
        let inner = w
            .chars()
            .skip(1)
            .any(|c| c.is_uppercase() || c.is_ascii_digit())
            && !w.chars().all(|c| c.is_uppercase() || c == '\'' || c == '’');
        let acronym = w.chars().filter(|c| c.is_alphabetic()).count() >= 2
            && w.chars().all(|c| !c.is_lowercase());
        let initial = initial_at(&blanked, m.start());
        let is_name = inner || (acronym && !initial) || (first_upper && !initial);
        if !is_name {
            continue;
        }
        let n = norm_word(w);
        if STOP.contains(&n.as_str()) || exempt.contains(&n) || OWN_NAME.contains(&n) {
            continue;
        }
        let shown = w.trim_end_matches("'s").trim_end_matches("’s").to_string();
        if !out.names.contains(&shown) {
            out.names.push(shown);
        }
    }
    out
}

/// Whether a line says anything this check can test: a line with no name,
/// number or date cannot invent one, and needs no pointer (blocker 931).
pub fn needs_pointer(line: &str, exempt: &[String]) -> bool {
    let c = claims_in(line, exempt);
    !(c.names.is_empty() && c.numbers.is_empty() && c.dates.is_empty())
}

/// The tokens in `line` the evidence does not vouch for, as shown in the
/// line, deduplicated. Empty means the line passes. `exempt` is words the
/// line may use freely — the project's own name.
pub fn missing(line: &str, evidence: &Evidence, exempt: &[String]) -> Vec<String> {
    let c = claims_in(line, exempt);
    let mut out: Vec<String> = Vec::new();
    let mut push = |s: String| {
        if !out.contains(&s) {
            out.push(s);
        }
    };
    for n in c.names {
        if !evidence.words.contains(&norm_word(&n)) {
            push(n);
        }
    }
    for n in c.numbers {
        if !evidence.numbers.contains(&n) {
            push(n);
        }
    }
    for d in c.dates {
        if !evidence.vouches_date(&d) {
            push(d.shown());
        }
    }
    out
}

/// The chats a memory line cites: every 8-hex id after "chat"/"chats".
pub fn cited_chats(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    for c in CHAT_ID.captures_iter(line) {
        for id in HEX8.find_iter(&c[1]) {
            let id = id.as_str().to_ascii_lowercase();
            if !out.contains(&id) {
                out.push(id);
            }
        }
    }
    out
}

/// The dates inside a line's cites — the date a claim is filed under,
/// which must be a day one of his cited messages was sent.
fn cite_dates(line: &str) -> Vec<Date> {
    CITE.find_iter(line)
        .filter(|m| HEX8.is_match(m.as_str()))
        .flat_map(|m| dates_in(m.as_str()).into_iter().map(|(d, _)| d))
        .collect()
}

/// Why a memory line was not kept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    /// The chats it cited, joined, or empty when it cited none.
    pub chat: String,
    pub missing: Vec<String>,
}

/// The dream's check on one line it wrote. `messages` reads the user's
/// messages of a chat by its 8-character id, `None` when no log has it.
pub fn check_memory_line(
    line: &str,
    exempt: &[String],
    messages: &mut dyn FnMut(&str) -> Option<Vec<Said>>,
) -> Result<(), Refusal> {
    if !needs_pointer(line, exempt) {
        return Ok(());
    }
    let chats = cited_chats(line);
    if chats.is_empty() {
        return Err(Refusal {
            chat: String::new(),
            missing: vec!["no chat cited".into()],
        });
    }
    let mut said = Vec::new();
    for id in &chats {
        match messages(id) {
            Some(s) => said.extend(s),
            None => {
                return Err(Refusal {
                    chat: chats.join(","),
                    missing: vec![format!("chat {id} cannot be read")],
                });
            }
        }
    }
    let evidence = Evidence::from_said(&said);
    let mut gone = missing(line, &evidence, exempt);
    for d in cite_dates(line) {
        if !evidence.sent.iter().any(|e| d.agrees(e)) {
            gone.push(format!("{} (no message of his that day)", d.shown()));
        }
    }
    if gone.is_empty() {
        Ok(())
    } else {
        Err(Refusal {
            chat: chats.join(","),
            missing: gone,
        })
    }
}

/// The message a captured line most likely came from, by the words they
/// share (names, numbers and dates count triple); ties go to the earlier
/// message. `None` when no message shares a word — the caller keeps the
/// excerpt's date then.
pub fn best_message(line: &str, said: &[Said]) -> Option<DateTime<Utc>> {
    let words: HashSet<String> = WORD
        .find_iter(&claim_text(line))
        .map(|m| norm_word(m.as_str()))
        .filter(|w| w.chars().count() >= 4)
        .collect();
    let names = claims_in(line, &[]).names;
    let mut best: Option<(usize, DateTime<Utc>)> = None;
    for s in said {
        let theirs: HashSet<String> = WORD
            .find_iter(&s.text)
            .map(|m| norm_word(m.as_str()))
            .collect();
        let score = words.intersection(&theirs).count()
            + 2 * names
                .iter()
                .filter(|n| theirs.contains(&norm_word(n)))
                .count();
        if score == 0 {
            continue;
        }
        let better = match best {
            None => true,
            Some((b, at)) => score > b || (score == b && s.at < at),
        };
        if better {
            best = Some((score, s.at));
        }
    }
    best.map(|(_, at)| at)
}

/// "2 refused — named something his messages do not contain (…log)", the
/// clause both shells print after a capture or a dream, or `None` when the
/// check sent nothing back. One function so the CLI and the toast cannot
/// drift.
pub fn refused_line(refused: usize, retried: usize, config: &Path) -> Option<String> {
    if refused == 0 && retried == 0 {
        return None;
    }
    let fixed = retried.saturating_sub(refused);
    Some(format!(
        "{refused} refused — named something his messages do not contain{}{}",
        if fixed > 0 {
            format!("; {fixed} more fixed on a second look")
        } else {
            String::new()
        },
        if refused > 0 {
            format!(" (listed in {})", log_path(config).display())
        } else {
            String::new()
        }
    ))
}

/// Where refused lines are logged: `<config>/logs/dream-refusals.log`.
pub fn log_path(config: &Path) -> PathBuf {
    config.join("logs").join("dream-refusals.log")
}

/// Append one refused line to the log: time, chat, the line, the missing
/// tokens, the stage — tab-separated, one line each, tabs and newlines in
/// the fields flattened to spaces. A log that cannot be written is not
/// fatal: the refusal is still counted in the outcome.
pub fn log_refusal(config: &Path, stage: &str, chat: &str, line: &str, missing: &[String]) {
    let path = log_path(config);
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let flat = |s: &str| s.replace(['\t', '\n', '\r'], " ");
    let row = format!(
        "{}\t{}\t{}\t{}\t{}\n",
        Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        if chat.is_empty() { "-" } else { chat },
        flat(line.trim()),
        flat(&missing.join(", ")),
        stage
    );
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(row.as_bytes());
    }
}

/// The user's messages in the chat whose log id starts with `short`,
/// searched across every session dir capture reads. `None` when no log
/// has that id or it cannot be read.
pub fn user_messages_of(config: &Path, short: &str) -> Option<Vec<Said>> {
    let short = short.to_ascii_lowercase();
    for dir in crate::capture::session_dirs(config) {
        let Ok(entries) = fs::read_dir(&dir.dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let is_log = path.extension().is_some_and(|e| e == "jsonl");
            let stem = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            if is_log && stem.starts_with(&short) {
                return user_messages_in(&path);
            }
        }
    }
    None
}

/// The user's messages in one log, through the same filter capture folds
/// with (`store::said`).
pub fn user_messages_in(path: &Path) -> Option<Vec<Said>> {
    let raw = fs::read_to_string(path).ok()?;
    let mut out = Vec::new();
    for line in raw.lines() {
        if let Ok(event) = serde_json::from_str::<nightloom_core::SessionEvent>(line)
            && let Some(said) = crate::store::said(&event)
            && said.conversation
            && said.who == "you"
        {
            out.push(Said {
                at: said.at,
                text: said.text.into_owned(),
            });
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn said(at: &str, text: &str) -> Said {
        Said {
            at: DateTime::parse_from_rfc3339(at)
                .unwrap()
                .with_timezone(&Utc),
            text: text.into(),
        }
    }

    /// Built from the 278 sample's Stuart-contacts message (chat 6826ae55),
    /// redacted to what the test needs: his message names the people with
    /// "Jiewen Wang" and carries "wickey" only inside an email address; the
    /// assistant's research reply is where `Jiewen "Wickey" Wang` and
    /// Stuart came from, and it is not evidence.
    fn stuart_chat() -> Vec<Said> {
        vec![
            said(
                "2026-09-22T16:48:24Z",
                "can you look up these people, i might end up working with some combination \
                 of them, no context: Anders Sandberg, David Johnston, Adam Bell, Jiewen Wang \
                 <wickeyxx@gmail.com>, Charles Pattison",
            ),
            said("2026-10-02T17:19:00Z", "ok thanks, that helps"),
        ]
    }

    const WICKEY_LINE: &str = "The user expects they may end up working with some combination \
         of a group of contacts (including Anders Sandberg, David Johnston, Adam Bell, Wickey \
         Wang, Charles Pattison) tied to Stuart, and wanted background research on each of them.";

    #[test]
    fn the_wickey_line_is_refused_for_wickey_and_stuart() {
        let e = Evidence::from_said(&stuart_chat());
        let gone = missing(WICKEY_LINE, &e, &[]);
        assert!(gone.contains(&"Wickey".to_string()), "{gone:?}");
        assert!(gone.contains(&"Stuart".to_string()), "{gone:?}");
        assert!(
            !gone.iter().any(|g| g == "Anders" || g == "Wang"),
            "{gone:?}"
        );
    }

    #[test]
    fn the_corrected_line_passes() {
        let e = Evidence::from_said(&stuart_chat());
        let right = "The user may end up working with some combination of Anders Sandberg, \
                     David Johnston, Adam Bell, Jiewen Wang and Charles Pattison, and asked for \
                     background research on each with no context given.";
        assert_eq!(missing(right, &e, &[]), Vec::<String>::new());
    }

    #[test]
    fn the_assistants_words_are_not_evidence() {
        // What capture saw beside his message; the check reads his only.
        let e = Evidence::from_said(&stuart_chat());
        let mut lookup = |id: &str| (id == "6826ae55").then(stuart_chat);
        let cited = format!(
            "{WICKEY_LINE} (user_stated 2026-09-22, project Value Generalization, chat 6826ae55)"
        );
        let r = check_memory_line(&cited, &[], &mut lookup).unwrap_err();
        assert_eq!(r.chat, "6826ae55");
        assert!(r.missing.contains(&"Wickey".to_string()));
        assert!(e.words.contains("jiewen"));
    }

    #[test]
    fn a_cite_dated_to_a_day_he_sent_nothing_is_refused() {
        let mut lookup = |_: &str| Some(stuart_chat());
        let line = "Anders Sandberg is among the contacts (user_stated 2026-10-01, chat 6826ae55)";
        let r = check_memory_line(line, &[], &mut lookup).unwrap_err();
        assert!(r.missing[0].starts_with("2026-10-01"), "{r:?}");
        let ok = "Anders Sandberg is among the contacts (user_stated 2026-09-22, chat 6826ae55)";
        assert!(check_memory_line(ok, &[], &mut lookup).is_ok());
    }

    #[test]
    fn no_pointer_fails_only_when_there_is_something_to_check() {
        let mut lookup = |_: &str| Some(stuart_chat());
        let r = check_memory_line("Works with Anders Sandberg.", &[], &mut lookup).unwrap_err();
        assert_eq!(r.missing, vec!["no chat cited".to_string()]);
        assert!(
            check_memory_line(
                "- [[toy-model]] — what was decided about it",
                &[],
                &mut lookup
            )
            .is_ok()
        );
        let mut none = |_: &str| None;
        let r = check_memory_line("Knows Anders (chat deadbeef)", &[], &mut none).unwrap_err();
        assert!(r.missing[0].contains("cannot be read"));
    }

    #[test]
    fn dates_normalise_between_month_names_and_numbers() {
        let e = Evidence::from_said(&[said(
            "2026-09-30T10:00:00Z",
            "we decided on sep 17 to keep |x1| > 2, and the Sep. 3rd draft is dead",
        )]);
        assert!(missing("Decided on 2026-09-17 that |x1| > 2.", &e, &[]).is_empty());
        assert!(missing("Decided on 9/17 to keep it.", &e, &[]).is_empty());
        assert!(missing("Dropped the 3 September draft.", &e, &[]).is_empty());
        // The message's own day, in any spelling.
        assert!(missing("As of September 30, 2026, decided.", &e, &[]).is_empty());
        assert_eq!(
            missing("Decided on 2026-09-22.", &e, &[]),
            vec!["2026-09-22"]
        );
    }

    #[test]
    fn possessives_punctuation_and_sentence_starts() {
        let e = Evidence::from_said(&[said(
            "2026-09-30T10:00:00Z",
            "stuart's venture got incorporated, it's 12,938 chars and costs $20/mo",
        )]);
        let line = "Prefers short notes. Stuart's venture is incorporated; the note is 12938 \
                    characters and the plan costs 20 a month.";
        assert_eq!(missing(line, &e, &[]), Vec::<String>::new());
        // A project's own name is exempt.
        let line = "Works on Value Generalization with Stuart.";
        assert!(missing(line, &e, &["Value Generalization".into()]).is_empty());
        assert_eq!(
            missing("Uses RStudio on a Mac.", &e, &[]),
            vec!["RStudio", "Mac"]
        );
    }

    #[test]
    fn a_leading_tag_opens_the_sentence() {
        // The memory's own "[stated]" tag: the word after it is capitalised
        // because it starts the claim, not because it names anything. A
        // capitalised month there is a verb, not May.
        let e = Evidence::from_said(&[said("2026-09-30T10:00:00Z", "the goal is accuracy")]);
        assert!(missing("- [stated] Ideal goal: accuracy.", &e, &[]).is_empty());
        assert!(missing("May work on accuracy.", &e, &[]).is_empty());
        assert_eq!(missing("Works on it in May.", &e, &[]), vec!["May"]);
    }

    #[test]
    fn number_words_vouch_for_digits() {
        let e = Evidence::from_said(&[said("2026-09-30T10:00:00Z", "i have two exams")]);
        assert!(missing("Has 2 exams.", &e, &[]).is_empty());
        assert_eq!(missing("Has 3 exams.", &e, &[]), vec!["3"]);
    }

    #[test]
    fn cited_chats_reads_one_or_several() {
        assert_eq!(
            cited_chats("x (user_stated 2026-09-22, project P, chats 6826ae55, 1a2b3c4d)"),
            vec!["6826ae55", "1a2b3c4d"]
        );
        assert_eq!(
            cited_chats("x (inferred 2026-09-22, chat 6826AE55)"),
            vec!["6826ae55"]
        );
        assert!(cited_chats("no pointer here").is_empty());
    }

    #[test]
    fn the_best_message_is_the_one_that_said_it() {
        let chat = stuart_chat();
        let at = best_message(WICKEY_LINE, &chat).unwrap();
        assert_eq!(at, Utc.with_ymd_and_hms(2026, 9, 22, 16, 48, 24).unwrap());
        assert!(best_message("Prefers zebras.", &chat).is_none());
    }

    #[test]
    fn a_refusal_is_one_tab_separated_line() {
        let dir = crate::tools::test_dir("grounding-log");
        log_refusal(
            &dir,
            "capture",
            "6826ae55",
            "a\tline\nhere",
            &["Wickey".into(), "Stuart".into()],
        );
        let text = fs::read_to_string(log_path(&dir)).unwrap();
        assert_eq!(text.lines().count(), 1);
        let fields: Vec<&str> = text.trim_end().split('\t').collect();
        assert_eq!(
            fields[1..],
            ["6826ae55", "a line here", "Wickey, Stuart", "capture"]
        );
    }
}
