//! Evidence tables with checked quotes (nightshift item 798, from 793 #5).
//!
//! In a research chat the model reads a set of sources — PDFs in the
//! project, pages it fetched — and answers the same questions of each. It
//! hands the answers to `evidence_table`: sources as rows, questions as
//! columns, each cell a short answer, a **verbatim quote** and a locator
//! (page or section). This module then does the one thing a model cannot be
//! trusted to do about its own quotes: it looks each one up in the stored
//! text of its source, and marks a cell whose quote is not there
//! **"not found in source"** — never dropping it, so a reader sees what was
//! claimed and that the check failed.
//!
//! **Stored source text.** A project file is read as it is (a PDF through
//! poppler's `pdftotext`, in reading order rather than `-layout`, so a
//! sentence that runs across a column break stays one sentence; an HTML
//! file through the fetch's own `html_to_text`). A web page is the copy
//! `fetch_page` saved under `<config>/fetched/` when the model read it —
//! the check itself **never fetches**: the text the quote is checked
//! against is the text the model was shown. Each source's text is copied
//! into the table's own folder, so the check can be read again, and a cell
//! opened at its quote, after the fetch cache is pruned.
//!
//! **What "appears" means.** Both texts are reduced to their letters and
//! digits, lower-cased, with ligatures (ﬁ, ﬂ) spelled out — so line breaks,
//! a word hyphenated across a line, curly versus straight quotes and dashes
//! do not fail a quote that is really there, and a changed word does. An
//! ellipsis (`...`, `…`) or a bracketed insertion (`[the model]`) in the
//! quote is a gap: the parts must appear in order, close together. A quote
//! under [`MIN_QUOTE_CHARS`] letters is too short to mean anything and is
//! marked so, not passed.
//!
//! **Locators.** A PDF's page is counted from `pdftotext`'s form feeds; the
//! cell keeps the model's locator and gains the PDF page the quote was found
//! on (a paper's printed page numbers often differ, so a mismatch is shown,
//! not failed). A web page's locator gains the nearest heading above the
//! quote.
//!
//! **What is written**, under `<root>/.agents/evidence/` (the project's
//! notes folder, so the note shows in the notes panel): `<slug>.md` (the
//! note: questions, the table, the sources, and an HTML comment line
//! `evidence-check: …` the morning page counts), and `<slug>/` holding
//! `table.json` (what the reply's ```` ```evidence ```` block is drawn
//! from), `table.csv` and `sources/<id>.txt`.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use nightloom_core::ToolDef;
use nightloom_core::tool::{CancellationToken, Effect, Tool};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// The tool's name on the CLI's side: `mcp__nightloom__evidence_table`.
pub const TOOL_NAME: &str = "evidence_table";
/// The fence a reply draws the table from: ```` ```evidence ```` holding the
/// path of `table.json`.
pub const FENCE: &str = "evidence";
/// The folder under the notes folder (`.agents`) the tables go in.
pub const DIR: &str = "evidence";
/// A quote with fewer letters and digits than this is too short to check.
pub const MIN_QUOTE_CHARS: usize = 12;
/// How far apart (in letters) two parts of a quote split by an ellipsis may be.
const GAP_MAX: usize = 3_000;
/// The desktop binary's flag for a night's check (`--evidence-check <request.json>`).
pub const CLI_FLAG: &str = "--evidence-check";
/// The sentence `initialize` adds when the tool is served.
pub const INSTRUCTION: &str = " When the user asks for an evidence table (sources as rows, \
     questions as columns), read each source first (fetch_page for a web page; a PDF or file \
     in the folder by path), then call evidence_table with every cell's short answer, a \
     verbatim quote copied from the source, and its locator (page or section); it checks each \
     quote against the stored text and saves the note and the CSV. Put the ```evidence block it \
     returns in your reply, and keep cells marked \"not found in source\" in the table.";

// ---- the request ------------------------------------------------------------

/// What the model sends.
#[derive(Debug, Clone, Deserialize)]
pub struct Request {
    pub title: String,
    pub questions: Vec<String>,
    pub sources: Vec<SourceIn>,
    #[serde(default)]
    pub cells: Vec<CellIn>,
    /// The table's file name; from the title when absent.
    #[serde(default)]
    pub slug: Option<String>,
}

/// One source: a file (`path`) or a page read with `fetch_page` (`url`).
#[derive(Debug, Clone, Deserialize)]
pub struct SourceIn {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
}

/// One cell, as the model wrote it.
#[derive(Debug, Clone, Deserialize)]
pub struct CellIn {
    pub source: String,
    /// The question's number (1-based) or its text.
    pub question: Value,
    #[serde(default)]
    pub answer: String,
    #[serde(default)]
    pub quote: String,
    #[serde(default)]
    pub locator: Option<String>,
}

// ---- the checked table --------------------------------------------------------

/// What the check found for one cell.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Check {
    /// The quote is in its source's stored text.
    Found,
    /// It is not: "not found in source".
    NotFound,
    /// Too few letters to check.
    TooShort,
    /// The cell has no quote.
    NoQuote,
    /// The source's text could not be read, so nothing was checked.
    NoSource,
}

impl Check {
    /// The words the note, the CSV and the reply's table use.
    pub fn words(self) -> &'static str {
        match self {
            Check::Found => "found in source",
            Check::NotFound => "not found in source",
            Check::TooShort => "quote too short to check",
            Check::NoQuote => "no quote given",
            Check::NoSource => "source text missing",
        }
    }
}

/// One source in the saved table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Source {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// The stored text, relative to the table's folder (`sources/S1.txt`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// A PDF's page count (form feeds + 1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pages: Option<usize>,
    #[serde(default)]
    pub chars: usize,
    /// Why the text could not be read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// One checked cell.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cell {
    pub source: String,
    /// 0-based index into `questions`.
    pub question: usize,
    pub answer: String,
    pub quote: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locator: Option<String>,
    pub check: Check,
    /// Where in the stored text the quote is, in characters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<usize>,
    /// The PDF page the quote was found on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<usize>,
    /// The nearest heading above it (a web page or a Markdown file).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section: Option<String>,
    /// The locator names a page the quote is not on.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub page_differs: bool,
    /// A quote not found in its own source but found in this one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elsewhere: Option<String>,
}

/// The table's totals: `failed` is every cell not `found`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Counts {
    pub cells: usize,
    pub found: usize,
    pub not_found: usize,
    pub unchecked: usize,
    pub failed: usize,
}

/// The saved table, `table.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Table {
    pub version: u32,
    pub title: String,
    pub slug: String,
    pub checked_at: String,
    pub questions: Vec<String>,
    pub sources: Vec<Source>,
    pub cells: Vec<Cell>,
    pub counts: Counts,
}

// ---- matching ----------------------------------------------------------------

/// A text reduced to its letters and digits, lower-cased, ligatures spelled
/// out, with the character index each came from in the original.
pub struct Canon {
    pub chars: Vec<char>,
    pub at: Vec<usize>,
}

fn ligature(c: char) -> Option<&'static str> {
    Some(match c {
        '\u{fb00}' => "ff",
        '\u{fb01}' => "fi",
        '\u{fb02}' => "fl",
        '\u{fb03}' => "ffi",
        '\u{fb04}' => "ffl",
        '\u{fb05}' | '\u{fb06}' => "st",
        _ => return None,
    })
}

/// See [`Canon`].
pub fn canon(text: &str) -> Canon {
    let mut chars = Vec::with_capacity(text.len());
    let mut at = Vec::with_capacity(text.len());
    for (i, c) in text.chars().enumerate() {
        if let Some(s) = ligature(c) {
            for l in s.chars() {
                chars.push(l);
                at.push(i);
            }
        } else if c.is_alphanumeric() {
            for l in c.to_lowercase() {
                chars.push(l);
                at.push(i);
            }
        }
    }
    Canon { chars, at }
}

/// A quote's parts: split at an ellipsis or a bracketed insertion, each
/// reduced as [`canon`] reduces the source; empty parts dropped.
pub fn quote_parts(quote: &str) -> Vec<Vec<char>> {
    let gap = Regex::new(r"\[[^\]]*\]|\.\s*\.\s*\.|…").expect("gap pattern");
    gap.split(quote)
        .map(|p| canon(p).chars)
        .filter(|p| !p.is_empty())
        .collect()
}

fn find_from(hay: &[char], needle: &[char], from: usize) -> Option<usize> {
    if needle.is_empty() || needle.len() > hay.len() {
        return None;
    }
    let first = needle[0];
    let last_start = hay.len() - needle.len();
    let mut i = from;
    while i <= last_start {
        if hay[i] == first && hay[i..i + needle.len()] == *needle {
            return Some(i);
        }
        i += 1;
    }
    None
}

/// Every place the quote's parts appear in order (canon start, canon end),
/// at most `cap` of them.
fn matches(src: &Canon, parts: &[Vec<char>], cap: usize) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let Some(first) = parts.first() else {
        return out;
    };
    let mut from = 0;
    while let Some(s) = find_from(&src.chars, first, from) {
        let mut end = s + first.len();
        let mut ok = true;
        for p in &parts[1..] {
            match find_from(&src.chars, p, end) {
                Some(n) if n - end <= GAP_MAX => end = n + p.len(),
                _ => {
                    ok = false;
                    break;
                }
            }
        }
        if ok {
            out.push((s, end));
            if out.len() >= cap {
                break;
            }
        }
        from = s + 1;
    }
    out
}

/// The page numbers a locator names: `p. 4`, `pp. 4–5`, `page 12`.
pub fn locator_pages(locator: &str) -> Option<(usize, usize)> {
    let re = Regex::new(r"(?i)\b(?:pp?|pages?|pg)\.?\s*(\d{1,4})(?:\s*[-–—]\s*(\d{1,4}))?")
        .expect("page pattern");
    let c = re.captures(locator)?;
    let a: usize = c.get(1)?.as_str().parse().ok()?;
    let b: usize = c.get(2).and_then(|m| m.as_str().parse().ok()).unwrap_or(a);
    Some((a.min(b), a.max(b)))
}

/// One source's text, ready to search.
pub struct Searchable {
    pub text: String,
    pub canon: Canon,
    /// Character offsets of the form feeds (page breaks).
    feeds: Vec<usize>,
}

impl Searchable {
    pub fn new(text: String) -> Self {
        let canon = canon(&text);
        let feeds = text
            .chars()
            .enumerate()
            .filter(|(_, c)| *c == '\u{c}')
            .map(|(i, _)| i)
            .collect();
        Self { text, canon, feeds }
    }

    /// Pages, when the text has page breaks.
    pub fn pages(&self) -> Option<usize> {
        if self.feeds.is_empty() {
            return None;
        }
        // A trailing form feed ends the last page rather than starting one.
        let n = self.text.chars().count();
        let trailing = self.feeds.last().is_some_and(|f| *f + 1 >= n);
        Some(self.feeds.len() + usize::from(!trailing))
    }

    fn page_of(&self, offset: usize) -> Option<usize> {
        if self.feeds.is_empty() {
            return None;
        }
        Some(self.feeds.iter().filter(|f| **f < offset).count() + 1)
    }

    /// The nearest Markdown heading at or above `offset`.
    fn section_of(&self, offset: usize) -> Option<String> {
        let mut pos = 0usize;
        let mut last = None;
        for line in self.text.split('\n') {
            if pos > offset {
                break;
            }
            let t = line.trim_start();
            if t.starts_with('#') {
                let h = t.trim_start_matches('#').trim();
                if !h.is_empty() {
                    last = Some(h.chars().take(90).collect());
                }
            }
            pos += line.chars().count() + 1;
        }
        last
    }
}

/// What looking one quote up in one source found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    pub start: usize,
    pub end: usize,
    pub page: Option<usize>,
    pub section: Option<String>,
    pub page_differs: bool,
}

/// Look a quote up: `Err(check)` when it is not checkable or not there.
/// With several places, the one on the locator's page wins, else the first.
pub fn look_up(src: &Searchable, quote: &str, locator: Option<&str>) -> Result<Hit, Check> {
    if quote.trim().is_empty() {
        return Err(Check::NoQuote);
    }
    let parts = quote_parts(quote);
    if parts.iter().map(Vec::len).sum::<usize>() < MIN_QUOTE_CHARS {
        return Err(Check::TooShort);
    }
    let found = matches(&src.canon, &parts, 50);
    if found.is_empty() {
        return Err(Check::NotFound);
    }
    let wanted = locator.and_then(locator_pages);
    let place = |(s, e): (usize, usize)| {
        let start = src.canon.at[s];
        let end = src.canon.at[e - 1] + 1;
        (start, end, src.page_of(start))
    };
    let mut best = place(found[0]);
    if let Some((a, b)) = wanted {
        for m in &found {
            let p = place(*m);
            if p.2.is_some_and(|pg| pg >= a && pg <= b) {
                best = p;
                break;
            }
        }
    }
    let (start, end, page) = best;
    let page_differs = match (wanted, page) {
        (Some((a, b)), Some(p)) => p < a || p > b,
        _ => false,
    };
    Ok(Hit {
        start,
        end,
        page,
        section: if page.is_none() {
            src.section_of(start)
        } else {
            None
        },
        page_differs,
    })
}

// ---- reading sources -----------------------------------------------------------

/// Where the check reads from and writes to.
#[derive(Debug, Clone)]
pub struct Places {
    /// The chat's folder: a relative source path is read inside it.
    pub root: PathBuf,
    /// Where the tables go (`<root>/.agents/evidence` by default).
    pub out: PathBuf,
    /// `fetch_page`'s saved pages (`<config>/fetched`).
    pub fetched: Option<PathBuf>,
    /// `pdftotext`, when installed.
    pub pdftotext: Option<PathBuf>,
}

impl Places {
    /// A chat's: tables in its notes folder.
    pub fn in_root(root: PathBuf, fetched: Option<PathBuf>) -> Self {
        let out = root.join(crate::project::AGENTS_DIR).join(DIR);
        Self {
            root,
            out,
            fetched,
            pdftotext: crate::attach::find_pdftotext(),
        }
    }
}

fn pdf_to_text(binary: Option<&Path>, pdf: &Path) -> Result<String, String> {
    let Some(binary) = binary else {
        return Err("no PDF text extractor is installed (poppler's pdftotext; \
                    `brew install poppler`)"
            .into());
    };
    let out = std::process::Command::new(binary)
        .args(["-enc", "UTF-8"])
        .arg(pdf)
        .arg("-")
        .output()
        .map_err(|e| format!("pdftotext could not run: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "pdftotext failed ({}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn is_ext(path: &Path, exts: &[&str]) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| exts.iter().any(|x| e.eq_ignore_ascii_case(x)))
}

/// A source's stored text, or why there is none.
pub fn source_text(src: &SourceIn, places: &Places) -> Result<String, String> {
    if let Some(p) = src.path.as_deref().filter(|p| !p.trim().is_empty()) {
        let path = if Path::new(p).is_absolute() {
            PathBuf::from(p)
        } else {
            crate::tools::Root::new(places.root.clone()).resolve(p)?
        };
        if !path.is_file() {
            return Err(format!("there is no file at {}", path.display()));
        }
        if is_ext(&path, &["pdf"]) {
            return pdf_to_text(places.pdftotext.as_deref(), &path);
        }
        let bytes =
            std::fs::read(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        let text = String::from_utf8_lossy(&bytes).into_owned();
        if is_ext(&path, &["html", "htm"]) {
            let base = reqwest::Url::parse("file:///").expect("file url");
            return Ok(crate::tools::html_to_text(&text, &base));
        }
        return Ok(text);
    }
    if let Some(url) = src.url.as_deref().filter(|u| !u.trim().is_empty()) {
        let Some(dir) = &places.fetched else {
            return Err("this check has no saved pages to read".into());
        };
        let stem = crate::mcp_server::page_file_stem(url.trim());
        let pdf = dir.join(format!("{stem}.pdf"));
        if pdf.is_file() {
            return pdf_to_text(places.pdftotext.as_deref(), &pdf);
        }
        let txt = dir.join(format!("{stem}.txt"));
        return std::fs::read_to_string(&txt).map_err(|_| {
            "no stored text for this page: read it with fetch_page first (the check never \
             fetches, so the quote is checked against the text you were shown)"
                .to_string()
        });
    }
    Err("the source names neither a path nor a url".into())
}

// ---- the check -----------------------------------------------------------------

/// A file-name-safe form of `s`: letters, digits and `-`, at most 48.
pub fn slug_of(s: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in s.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
        if out.len() >= 48 {
            break;
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() { "table".into() } else { out }
}

fn file_id(id: &str) -> String {
    let s: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(40)
        .collect();
    if s.is_empty() { "source".into() } else { s }
}

fn question_index(q: &Value, questions: &[String]) -> Option<usize> {
    if let Some(n) = q.as_u64() {
        let n = n as usize;
        return (n >= 1 && n <= questions.len()).then(|| n - 1);
    }
    let s = q.as_str()?.trim();
    if let Ok(n) = s.trim_start_matches(['Q', 'q']).parse::<usize>()
        && n >= 1
        && n <= questions.len()
    {
        return Some(n - 1);
    }
    questions.iter().position(|x| x.trim() == s)
}

/// Check every cell of `req` and write the table under `places.out`.
/// Returns the table and the paths written. Pure but for the files.
pub fn check_and_save(req: &Request, places: &Places, now: &str) -> Result<(Table, Saved), String> {
    if req.questions.is_empty() {
        return Err("the table has no questions".into());
    }
    if req.sources.is_empty() {
        return Err("the table has no sources".into());
    }
    let mut seen = HashMap::new();
    for s in &req.sources {
        if s.id.trim().is_empty() {
            return Err("every source needs an id (S1, S2, …)".into());
        }
        if seen.insert(s.id.trim().to_string(), ()).is_some() {
            return Err(format!("two sources have the id {:?}", s.id));
        }
    }
    let slug = slug_of(req.slug.as_deref().unwrap_or(&req.title));
    let dir = places.out.join(&slug);
    std::fs::create_dir_all(dir.join("sources"))
        .map_err(|e| format!("cannot make {}: {e}", dir.display()))?;

    let mut sources = Vec::new();
    let mut texts: Vec<Option<Searchable>> = Vec::new();
    for s in &req.sources {
        let id = s.id.trim().to_string();
        let title = s
            .title
            .clone()
            .filter(|t| !t.trim().is_empty())
            .or_else(|| s.path.clone())
            .or_else(|| s.url.clone())
            .unwrap_or_else(|| id.clone());
        let mut out = Source {
            id: id.clone(),
            title,
            path: s.path.clone(),
            url: s.url.clone(),
            text: None,
            pages: None,
            chars: 0,
            error: None,
        };
        match source_text(s, places) {
            Ok(text) => {
                let rel = format!("sources/{}.txt", file_id(&id));
                std::fs::write(dir.join(&rel), &text)
                    .map_err(|e| format!("cannot save the text of {id}: {e}"))?;
                let sr = Searchable::new(text);
                out.text = Some(rel);
                out.pages = sr.pages();
                out.chars = sr.text.chars().count();
                texts.push(Some(sr));
            }
            Err(e) => {
                out.error = Some(e);
                texts.push(None);
            }
        }
        sources.push(out);
    }

    let index: HashMap<&str, usize> = sources
        .iter()
        .enumerate()
        .map(|(i, s)| (s.id.as_str(), i))
        .collect();
    let mut cells = Vec::new();
    let mut counts = Counts::default();
    for c in &req.cells {
        let sid = c.source.trim();
        let Some(&si) = index.get(sid) else {
            return Err(format!(
                "a cell names the source {sid:?}, which is not in sources"
            ));
        };
        let Some(qi) = question_index(&c.question, &req.questions) else {
            return Err(format!(
                "a cell of {sid} names the question {}, which is not one of the {} questions \
                 (give its number, 1 to {})",
                c.question,
                req.questions.len(),
                req.questions.len()
            ));
        };
        let mut cell = Cell {
            source: sid.to_string(),
            question: qi,
            answer: c.answer.trim().to_string(),
            quote: c.quote.trim().to_string(),
            locator: c.locator.clone().filter(|l| !l.trim().is_empty()),
            check: Check::NoSource,
            start: None,
            end: None,
            page: None,
            section: None,
            page_differs: false,
            elsewhere: None,
        };
        if let Some(src) = &texts[si] {
            match look_up(src, &cell.quote, cell.locator.as_deref()) {
                Ok(hit) => {
                    cell.check = Check::Found;
                    cell.start = Some(hit.start);
                    cell.end = Some(hit.end);
                    cell.page = hit.page;
                    cell.section = hit.section;
                    cell.page_differs = hit.page_differs;
                }
                Err(check) => {
                    cell.check = check;
                    if check == Check::NotFound {
                        cell.elsewhere = texts.iter().enumerate().find_map(|(j, t)| {
                            (j != si
                                && t.as_ref()
                                    .is_some_and(|t| look_up(t, &cell.quote, None).is_ok()))
                            .then(|| sources[j].id.clone())
                        });
                    }
                }
            }
        } else if cell.quote.is_empty() {
            cell.check = Check::NoQuote;
        }
        counts.cells += 1;
        match cell.check {
            Check::Found => counts.found += 1,
            Check::NotFound => counts.not_found += 1,
            _ => counts.unchecked += 1,
        }
        cells.push(cell);
    }
    counts.failed = counts.cells - counts.found;
    let table = Table {
        version: 1,
        title: req.title.trim().to_string(),
        slug: slug.clone(),
        checked_at: now.to_string(),
        questions: req.questions.iter().map(|q| q.trim().to_string()).collect(),
        sources,
        cells,
        counts,
    };
    let json_path = dir.join("table.json");
    let csv_path = dir.join("table.csv");
    let note_path = places.out.join(format!("{slug}.md"));
    let json = serde_json::to_string_pretty(&table).map_err(|e| e.to_string())?;
    std::fs::write(&json_path, json).map_err(|e| format!("cannot save table.json: {e}"))?;
    std::fs::write(&csv_path, to_csv(&table)).map_err(|e| format!("cannot save table.csv: {e}"))?;
    std::fs::write(&note_path, to_note(&table, &slug))
        .map_err(|e| format!("cannot save the note: {e}"))?;
    Ok((
        table,
        Saved {
            json: json_path,
            csv: csv_path,
            note: note_path,
        },
    ))
}

/// The three files a check writes.
#[derive(Debug, Clone)]
pub struct Saved {
    pub json: PathBuf,
    pub csv: PathBuf,
    pub note: PathBuf,
}

/// A cell's locator as shown: the model's, then the PDF page or section found.
pub fn locator_words(c: &Cell) -> String {
    let mut parts = Vec::new();
    if let Some(l) = &c.locator {
        parts.push(l.clone());
    }
    match (c.page, &c.section) {
        (Some(p), _) if c.page_differs || c.locator.is_none() => parts.push(format!("PDF p. {p}")),
        (None, Some(s)) if c.locator.is_none() => parts.push(format!("§ {s}")),
        _ => {}
    }
    parts.join(" · ")
}

fn cell_check_words(c: &Cell) -> String {
    let mut w = c.check.words().to_string();
    if let Some(o) = &c.elsewhere {
        let _ = write!(w, " (it is in {o})");
    }
    if c.check == Check::Found
        && c.page_differs
        && let Some(p) = c.page
    {
        let _ = write!(w, ", on PDF page {p}");
    }
    w
}

fn csv_field(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// Rows the sources, four columns per question: answer, quote, locator, check.
pub fn to_csv(t: &Table) -> String {
    let mut head = vec!["Source".to_string(), "Title".to_string()];
    for i in 1..=t.questions.len() {
        for k in ["answer", "quote", "locator", "check"] {
            head.push(format!("Q{i} {k}"));
        }
    }
    let mut out = head
        .iter()
        .map(|h| csv_field(h))
        .collect::<Vec<_>>()
        .join(",");
    out.push('\n');
    for s in &t.sources {
        let mut row = vec![s.id.clone(), s.title.clone()];
        for qi in 0..t.questions.len() {
            let cs: Vec<&Cell> = t
                .cells
                .iter()
                .filter(|c| c.source == s.id && c.question == qi)
                .collect();
            let join = |f: &dyn Fn(&Cell) -> String| {
                cs.iter().map(|c| f(c)).collect::<Vec<_>>().join("\n")
            };
            row.push(join(&|c| c.answer.clone()));
            row.push(join(&|c| c.quote.clone()));
            row.push(join(&locator_words));
            row.push(join(&cell_check_words));
        }
        out.push_str(
            &row.iter()
                .map(|f| csv_field(f))
                .collect::<Vec<_>>()
                .join(","),
        );
        out.push('\n');
    }
    out
}

fn md_cell(s: &str) -> String {
    s.replace('|', "\\|").replace(['\n', '\r'], " ")
}

/// The machine line the morning page counts (an HTML comment in the note).
pub fn count_line(c: &Counts) -> String {
    format!(
        "<!-- evidence-check: cells={} found={} failed={} not_found={} unchecked={} -->",
        c.cells, c.found, c.failed, c.not_found, c.unchecked
    )
}

/// The note: totals, the questions, the table, the sources and the files.
pub fn to_note(t: &Table, slug: &str) -> String {
    let c = &t.counts;
    let mut out = format!("# Evidence: {}\n\n", t.title);
    let _ = writeln!(
        out,
        "Checked {} · {} sources × {} questions · {} of {} quotes found in their source text; \
         {} not found in source{}.\n",
        t.checked_at,
        t.sources.len(),
        t.questions.len(),
        c.found,
        c.cells,
        c.not_found,
        if c.unchecked > 0 {
            format!(", {} not checkable", c.unchecked)
        } else {
            String::new()
        }
    );
    out.push_str(&count_line(c));
    out.push_str("\n\n## Questions\n\n");
    for (i, q) in t.questions.iter().enumerate() {
        let _ = writeln!(out, "{}. {}", i + 1, q);
    }
    out.push_str("\n## Table\n\n| Source |");
    for i in 1..=t.questions.len() {
        let _ = write!(out, " Q{i} |");
    }
    out.push_str("\n|---|");
    for _ in &t.questions {
        out.push_str("---|");
    }
    out.push('\n');
    for s in &t.sources {
        let _ = write!(out, "| **{}** {} |", md_cell(&s.id), md_cell(&s.title));
        for qi in 0..t.questions.len() {
            let parts: Vec<String> = t
                .cells
                .iter()
                .filter(|c| c.source == s.id && c.question == qi)
                .map(|c| {
                    let mark = if c.check == Check::Found {
                        "✓"
                    } else {
                        "✗"
                    };
                    let mut x = md_cell(&c.answer);
                    if !c.quote.is_empty() {
                        let _ = write!(x, "<br>“{}”", md_cell(&c.quote));
                    }
                    let loc = locator_words(c);
                    if !loc.is_empty() {
                        let _ = write!(x, " — {}", md_cell(&loc));
                    }
                    if c.check == Check::Found {
                        let _ = write!(x, " {mark}");
                    } else {
                        let _ = write!(x, " {mark} **{}**", md_cell(&cell_check_words(c)));
                    }
                    x
                })
                .collect();
            let body = if parts.is_empty() {
                "—".to_string()
            } else {
                parts.join("<br><br>")
            };
            let _ = write!(out, " {body} |");
        }
        out.push('\n');
    }
    out.push_str("\n## Sources\n\n");
    for s in &t.sources {
        let whence = s.path.as_deref().or(s.url.as_deref()).unwrap_or("");
        let _ = write!(out, "- **{}** {} — {}", s.id, s.title, whence);
        if let Some(e) = &s.error {
            let _ = write!(out, " — text could not be read: {e}");
        } else if let Some(p) = s.pages {
            let _ = write!(out, " — {p} pages");
        }
        out.push('\n');
    }
    let _ = writeln!(
        out,
        "\nFiles: `{slug}/table.csv`, `{slug}/table.json`, the stored texts in `{slug}/sources/`."
    );
    out
}

/// What the tool says back: the totals, each failed cell by name, the
/// files, and the block to put in the reply.
pub fn reply(t: &Table, saved: &Saved) -> String {
    let c = &t.counts;
    let mut out = format!(
        "Checked {} quotes against the stored source text: {} found, {} not found in source, \
         {} not checkable.\n",
        c.cells, c.found, c.not_found, c.unchecked
    );
    for s in t.sources.iter().filter(|s| s.error.is_some()) {
        let _ = writeln!(
            out,
            "Source {} could not be read: {}",
            s.id,
            s.error.as_deref().unwrap_or("")
        );
    }
    let failed: Vec<&Cell> = t.cells.iter().filter(|c| c.check != Check::Found).collect();
    if !failed.is_empty() {
        out.push_str(
            "Cells that failed the check (fix the quote and call again, or leave them marked):\n",
        );
        for f in failed.iter().take(40) {
            let head: String = f.quote.chars().take(60).collect();
            let _ = writeln!(
                out,
                "- {} × Q{}: {} — \"{}{}\"",
                f.source,
                f.question + 1,
                cell_check_words(f),
                head,
                if f.quote.chars().count() > 60 {
                    "…"
                } else {
                    ""
                }
            );
        }
    }
    let _ = writeln!(
        out,
        "Saved: the note {}, the CSV {}.\nTo show the table in your reply, put this block where \
         it goes, exactly as it is (the app draws it from the checked file):\n\n```{FENCE}\n{}\n```\n\n\
         Keep cells marked \"not found in source\" in the table and say so; never drop them.",
        saved.note.display(),
        saved.csv.display(),
        saved.json.display()
    );
    out
}

// ---- the tool --------------------------------------------------------------------

/// `evidence_table`, served with a chat's folder.
pub struct EvidenceTable {
    places: Places,
}

impl EvidenceTable {
    pub fn new(places: Places) -> Self {
        Self { places }
    }
}

fn now_words() -> String {
    chrono::Local::now()
        .format("%Y-%m-%d %-I:%M %p")
        .to_string()
}

/// The tool's schema, shared with the CLI's help.
pub fn input_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "title": { "type": "string", "description": "What the table is about; also its file name." },
            "questions": { "type": "array", "items": { "type": "string" }, "description": "The columns, in order." },
            "sources": {
                "type": "array",
                "description": "The rows. Each has an id (S1, S2, …), a title, and either path (a file in the folder: a PDF, text, Markdown or HTML) or url (a page already read with fetch_page).",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string" },
                        "title": { "type": "string" },
                        "path": { "type": "string" },
                        "url": { "type": "string" }
                    },
                    "required": ["id"]
                }
            },
            "cells": {
                "type": "array",
                "description": "One per source and question.",
                "items": {
                    "type": "object",
                    "properties": {
                        "source": { "type": "string", "description": "The source's id." },
                        "question": { "type": "integer", "description": "The question's number, from 1." },
                        "answer": { "type": "string", "description": "A short answer, a phrase or a sentence." },
                        "quote": { "type": "string", "description": "Copied verbatim from the source: the words that support the answer. Use ... for a gap." },
                        "locator": { "type": "string", "description": "Where: a page (p. 4) or a section name." }
                    },
                    "required": ["source", "question", "answer", "quote"]
                }
            },
            "slug": { "type": "string", "description": "The file name, when the title's is not wanted. The same slug again replaces that table (a re-check after fixing quotes)." }
        },
        "required": ["title", "questions", "sources", "cells"]
    })
}

#[async_trait::async_trait]
impl Tool for EvidenceTable {
    fn effect(&self) -> Effect {
        // It writes only its own new files in the notes folder.
        Effect::Session
    }

    fn def(&self) -> ToolDef {
        ToolDef {
            name: TOOL_NAME.into(),
            description: "An evidence table: sources as rows, questions as columns, each cell a \
                 short answer, a verbatim quote from the source and a locator (page or \
                 section). Read every source first. Each quote is checked against the source's \
                 stored text (a file in the folder, or the copy fetch_page saved — this tool \
                 never fetches), and a cell whose quote is not there is marked \"not found in \
                 source\", never dropped. Saves a note and a CSV in the project's notes folder \
                 and returns an ```evidence block to put in the reply, where the app draws the \
                 table; a click on a cell opens the source at the quote."
                .into(),
            input_schema: input_schema(),
        }
    }

    async fn call(&self, input: Value, _cancel: &CancellationToken) -> Result<String, String> {
        let req: Request = serde_json::from_value(input)
            .map_err(|e| format!("the table is not in the shape the schema gives: {e}"))?;
        let places = self.places.clone();
        tokio::task::spawn_blocking(move || {
            let (t, saved) = check_and_save(&req, &places, &now_words())?;
            Ok(reply(&t, &saved))
        })
        .await
        .map_err(|e| format!("the check stopped: {e}"))?
    }
}

/// `nightloom-desktop --evidence-check <request.json> [--root <dir>] [--out
/// <dir>] [--fetched <dir>]`: the same check for a night, which has no
/// Nightloom chat. Prints what the tool would say.
pub fn run_cli(args: &[String]) -> Result<String, String> {
    let mut file = None;
    let mut root = None;
    let mut out = None;
    let mut fetched = None;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--root" => root = it.next().map(PathBuf::from),
            "--out" => out = it.next().map(PathBuf::from),
            "--fetched" => fetched = it.next().map(PathBuf::from),
            _ if file.is_none() => file = Some(PathBuf::from(a)),
            _ => return Err(format!("unexpected argument {a:?}")),
        }
    }
    let file = file.ok_or(
        "usage: --evidence-check <request.json> [--root <dir>] [--out <dir>] [--fetched <dir>]",
    )?;
    let text = std::fs::read_to_string(&file)
        .map_err(|e| format!("cannot read {}: {e}", file.display()))?;
    let req: Request =
        serde_json::from_str(&text).map_err(|e| format!("{}: {e}", file.display()))?;
    let root = match root {
        Some(r) => r,
        None => std::env::current_dir().map_err(|e| e.to_string())?,
    };
    let fetched = fetched
        .or_else(|| crate::project::config_dir().map(|c| c.join(crate::mcp_server::FETCHED_DIR)));
    let mut places = Places::in_root(root, fetched);
    if let Some(o) = out {
        places.out = o;
    }
    let (t, saved) = check_and_save(&req, &places, &now_words())?;
    Ok(reply(&t, &saved))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "nl-evidence-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn places(root: &Path) -> Places {
        Places {
            root: root.to_path_buf(),
            out: root.join(".agents").join(DIR),
            fetched: Some(root.join("fetched")),
            pdftotext: None,
        }
    }

    #[test]
    fn a_quote_survives_line_breaks_hyphenation_curly_quotes_and_ligatures() {
        let src = Searchable::new(
            "The model was trained on 1.2 tril-\nlion tokens; its “de\u{fb01}ning” trait is\nscale.".into(),
        );
        let hit = look_up(
            &src,
            "trained on 1.2 trillion tokens; its \"defining\" trait",
            None,
        )
        .unwrap();
        assert_eq!(
            &src.text.chars().skip(hit.start).take(7).collect::<String>(),
            "trained"
        );
        assert!(src.text.chars().nth(hit.end - 1) == Some('t'));
        assert_eq!(
            look_up(&src, "trained on 1.3 trillion tokens", None),
            Err(Check::NotFound)
        );
        assert_eq!(look_up(&src, "1.2", None), Err(Check::TooShort));
        assert_eq!(look_up(&src, "  ", None), Err(Check::NoQuote));
    }

    #[test]
    fn an_ellipsis_or_a_bracketed_insertion_is_a_gap_and_order_counts() {
        let src = Searchable::new("Alpha beta gamma delta. Epsilon zeta eta theta iota.".into());
        assert!(look_up(&src, "Alpha beta gamma ... eta theta iota", None).is_ok());
        assert!(look_up(&src, "Alpha beta gamma […] eta theta iota", None).is_ok());
        assert!(look_up(&src, "[It] Epsilon zeta eta theta", None).is_ok());
        assert_eq!(
            look_up(&src, "eta theta iota ... Alpha beta gamma", None),
            Err(Check::NotFound)
        );
    }

    #[test]
    fn pages_come_from_form_feeds_and_the_locator_page_is_preferred() {
        let src = Searchable::new(
            "page one has the phrase here\u{c}page two\u{c}the phrase here again on three\u{c}"
                .into(),
        );
        assert_eq!(src.pages(), Some(3));
        let first = look_up(&src, "the phrase here", None).unwrap();
        assert_eq!(first.page, Some(1));
        let third = look_up(&src, "the phrase here", Some("p. 3")).unwrap();
        assert_eq!(third.page, Some(3));
        assert!(!third.page_differs);
        let off = look_up(&src, "page two the phrase", Some("pp. 7–8"));
        let off = off.unwrap();
        assert_eq!(off.page, Some(2));
        assert!(off.page_differs);
        assert_eq!(locator_pages("Section 2, p. 14"), Some((14, 14)));
        assert_eq!(locator_pages("pages 4-6"), Some((4, 6)));
        assert_eq!(locator_pages("§ Methods"), None);
    }

    #[test]
    fn a_web_page_quote_gets_its_section() {
        let src = Searchable::new(
            "# Title\nintro text here\n## Results\nThe effect size was 0.4 overall.\n".into(),
        );
        let hit = look_up(&src, "The effect size was 0.4", None).unwrap();
        assert_eq!(hit.section.as_deref(), Some("Results"));
        assert_eq!(hit.page, None);
    }

    #[test]
    fn the_check_marks_a_missing_quote_rather_than_dropping_it_and_saves_csv_note_and_json() {
        let tmp = scratch("save");
        let root = tmp.as_path();
        std::fs::write(
            root.join("a.txt"),
            "Sleep improves memory consolidation in adults.",
        )
        .unwrap();
        std::fs::write(
            root.join("b.md"),
            "# B\n## Findings\nNo effect of sleep on recall was observed.",
        )
        .unwrap();
        std::fs::create_dir_all(root.join("fetched")).unwrap();
        let url = "https://example.org/paper";
        std::fs::write(
            root.join("fetched")
                .join(format!("{}.txt", crate::mcp_server::page_file_stem(url))),
            "Naps of twenty minutes improved alertness.",
        )
        .unwrap();
        let req: Request = serde_json::from_value(json!({
            "title": "Sleep and memory",
            "questions": ["Effect on memory?", "Population?"],
            "sources": [
                {"id": "S1", "title": "Paper A", "path": "a.txt"},
                {"id": "S2", "title": "Paper B", "path": "b.md"},
                {"id": "S3", "title": "Page C", "url": url},
                {"id": "S4", "title": "Unread page", "url": "https://example.org/unread"}
            ],
            "cells": [
                {"source": "S1", "question": 1, "answer": "Improves", "quote": "Sleep improves memory consolidation", "locator": "abstract"},
                {"source": "S1", "question": 2, "answer": "Adults", "quote": "consolidation in adults"},
                {"source": "S2", "question": 1, "answer": "None", "quote": "No effect of sleep on memory was observed"},
                {"source": "S3", "question": "Q1", "answer": "Alertness", "quote": "Naps of twenty minutes improved alertness"},
                {"source": "S4", "question": 1, "answer": "?", "quote": "something we never read at all"},
                {"source": "S2", "question": 2, "answer": "Adults", "quote": "Sleep improves memory consolidation"}
            ]
        }))
        .unwrap();
        let (t, saved) = check_and_save(&req, &places(root), "2026-11-18 7:00 AM").unwrap();
        let checks: Vec<Check> = t.cells.iter().map(|c| c.check).collect();
        assert_eq!(
            checks,
            vec![
                Check::Found,
                Check::Found,
                Check::NotFound,
                Check::Found,
                Check::NoSource,
                Check::NotFound
            ]
        );
        assert_eq!(t.cells[5].elsewhere.as_deref(), Some("S1"));
        assert_eq!(t.cells[3].section, None);
        assert_eq!(
            t.counts,
            Counts {
                cells: 6,
                found: 3,
                not_found: 2,
                unchecked: 1,
                failed: 3
            }
        );
        assert!(
            t.sources[3]
                .error
                .as_deref()
                .unwrap()
                .contains("fetch_page first")
        );
        // Every cell is kept, the failed ones marked.
        let note = std::fs::read_to_string(&saved.note).unwrap();
        assert!(note.contains("✗ **not found in source**"), "{note}");
        assert!(
            note.contains(
                "<!-- evidence-check: cells=6 found=3 failed=3 not_found=2 unchecked=1 -->"
            )
        );
        assert!(note.contains("| **S1** Paper A |"));
        let csv = std::fs::read_to_string(&saved.csv).unwrap();
        let mut lines = csv.lines();
        assert!(
            lines
                .next()
                .unwrap()
                .starts_with("Source,Title,Q1 answer,Q1 quote,Q1 locator,Q1 check,Q2 answer")
        );
        assert!(csv.contains("not found in source (it is in S1)"));
        let back: Table =
            serde_json::from_str(&std::fs::read_to_string(&saved.json).unwrap()).unwrap();
        assert_eq!(back, t);
        // The stored text is copied beside the table, and a cell's offsets land on its quote.
        let s1 =
            std::fs::read_to_string(saved.json.parent().unwrap().join("sources/S1.txt")).unwrap();
        let c = &t.cells[0];
        let got: String = s1
            .chars()
            .skip(c.start.unwrap())
            .take(c.end.unwrap() - c.start.unwrap())
            .collect();
        assert_eq!(got, "Sleep improves memory consolidation");
        assert_eq!(
            saved.note,
            root.join(".agents/evidence/sleep-and-memory.md")
        );
        let r = reply(&t, &saved);
        assert!(
            r.contains(&format!("```evidence\n{}\n```", saved.json.display())),
            "{r}"
        );
        assert!(r.contains("S2 × Q1: not found in source"));
    }

    #[test]
    fn bad_requests_say_what_is_wrong() {
        let tmp = scratch("bad");
        let p = places(&tmp);
        let mk = |v: Value| serde_json::from_value::<Request>(v).unwrap();
        let e = check_and_save(&mk(json!({"title":"t","questions":["q"],"sources":[{"id":"S1","path":"x"},{"id":"S1","path":"y"}],"cells":[]})), &p, "now").unwrap_err();
        assert!(e.contains("two sources"));
        let e = check_and_save(&mk(json!({"title":"t","questions":["q"],"sources":[{"id":"S1","path":"x"}],"cells":[{"source":"S9","question":1,"answer":"a","quote":"b"}]})), &p, "now").unwrap_err();
        assert!(e.contains("S9"));
        let e = check_and_save(&mk(json!({"title":"t","questions":["q"],"sources":[{"id":"S1","path":"x"}],"cells":[{"source":"S1","question":4,"answer":"a","quote":"b"}]})), &p, "now").unwrap_err();
        assert!(e.contains("1 to 1"));
        // A path outside the folder is refused through the chat's root.
        let r = source_text(
            &SourceIn {
                id: "S".into(),
                title: None,
                path: Some("../../etc/passwd".into()),
                url: None,
            },
            &p,
        );
        assert!(r.is_err());
        assert_eq!(
            slug_of("Sleep & memory: a review!"),
            "sleep-memory-a-review"
        );
        assert_eq!(slug_of("???"), "table");
    }

    #[test]
    fn a_real_pdf_is_read_through_pdftotext_when_it_is_installed() {
        // Skipped quietly where poppler is not installed (CI).
        let Some(bin) = crate::attach::find_pdftotext() else {
            return;
        };
        let tmp = scratch("pdf");
        let mut p = places(&tmp);
        p.pdftotext = Some(bin);
        // A one-page PDF with the text "Hello evidence table world".
        let pdf = b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 58>>stream\nBT /F1 12 Tf 10 50 Td (Hello evidence table world) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";
        std::fs::write(tmp.join("p.pdf"), pdf).unwrap();
        let text = source_text(
            &SourceIn {
                id: "S".into(),
                title: None,
                path: Some("p.pdf".into()),
                url: None,
            },
            &p,
        )
        .unwrap();
        let s = Searchable::new(text);
        let hit = look_up(&s, "evidence table world", Some("p. 1")).unwrap();
        assert_eq!(hit.page, Some(1));
    }

    /// Item 798's measurement on real papers, run by hand (it reads the
    /// PDFs `fetch_page` saved on this Mac): `NIGHTLOOM_EVIDENCE_BENCH=<dir>
    /// cargo test -p nightloom-service --lib evidence::tests::bench -- --ignored
    /// --nocapture`. For each `<stem>.pdf` with its `<stem>.txt` (the
    /// `-layout` text the model was shown), quotes are taken from that text
    /// the way a model copies them — runs of words inside one column, some
    /// across a line break — and checked against the stored text the check
    /// reads (reading order, not `-layout`). Each is also checked with one
    /// word changed, which must fail. Prints one line per paper and the totals.
    #[test]
    #[ignore]
    fn bench() {
        let Ok(dir) = std::env::var("NIGHTLOOM_EVIDENCE_BENCH") else {
            return;
        };
        let bin = crate::attach::find_pdftotext().expect("pdftotext");
        let mut p = places(Path::new(&dir));
        p.pdftotext = Some(bin);
        let mut names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| is_ext(p, &["pdf"]) && p.with_extension("txt").is_file())
            .collect();
        names.sort();
        let (mut all, mut ok, mut neg, mut neg_ok) = (0, 0, 0, 0);
        let mut misses = Vec::new();
        for pdf in names.iter().take(10) {
            let shown = std::fs::read_to_string(pdf.with_extension("txt")).unwrap();
            let src = SourceIn {
                id: "S".into(),
                title: None,
                path: Some(pdf.display().to_string()),
                url: None,
            };
            let stored = Searchable::new(source_text(&src, &p).unwrap());
            // Column runs: a layout line split at gaps of 3+ spaces, each
            // with the column it starts at, so a two-line quote stays in
            // one column as a reader's eye does.
            let runs = |l: &str| -> Vec<(usize, String)> {
                let mut out = Vec::new();
                let mut at = 0;
                for part in l.split("   ") {
                    let lead = part.len() - part.trim_start().len();
                    let t = part.trim();
                    if t.split_whitespace().count() >= 4 {
                        out.push((at + lead, t.to_string()));
                    }
                    at += part.len() + 3;
                }
                out
            };
            let lines: Vec<Vec<(usize, String)>> = shown.lines().map(runs).collect();
            let mut quotes = Vec::new();
            for (n, l) in lines.iter().enumerate() {
                if let Some((col, first)) = l.first() {
                    let words: Vec<&str> = first.split_whitespace().collect();
                    if words.len() >= 6 && n % 7 == 0 {
                        quotes.push(words.join(" "));
                    } else if n % 11 == 0
                        && let Some((ncol, next)) = lines.get(n + 1).and_then(|x| x.first())
                        && col.abs_diff(*ncol) <= 2
                    {
                        let tail: Vec<&str> = words.iter().rev().take(4).rev().copied().collect();
                        let head: Vec<&str> = next.split_whitespace().take(4).collect();
                        quotes.push(format!("{} {}", tail.join(" "), head.join(" ")));
                    }
                }
                if quotes.len() >= 20 {
                    break;
                }
            }
            let (mut found, mut tried) = (0, 0);
            for q in &quotes {
                match look_up(&stored, q, None) {
                    Ok(_) => found += 1,
                    Err(Check::TooShort) => continue,
                    Err(_) => misses.push(format!(
                        "{}: {q}",
                        pdf.file_name().unwrap().to_string_lossy()
                    )),
                }
                tried += 1;
                let mut w: Vec<String> = q.split_whitespace().map(String::from).collect();
                let mid = w.len() / 2;
                w[mid] = "zebraquartz".into();
                neg += 1;
                if look_up(&stored, &w.join(" "), None) == Err(Check::NotFound) {
                    neg_ok += 1;
                }
            }
            println!(
                "{} pages={:?} quotes={tried} found={found}",
                pdf.file_name().unwrap().to_string_lossy(),
                stored.pages()
            );
            all += tried;
            ok += found;
        }
        println!("TOTAL genuine found {ok}/{all}; altered rejected {neg_ok}/{neg}");
        for m in misses.iter().take(30) {
            println!("MISS {m}");
        }
    }

    /// The night's check run by hand, without the desktop binary:
    /// `NIGHTLOOM_EVIDENCE_ARGS="<request.json> --out <dir>" cargo test -p
    /// nightloom-service --lib evidence::tests::check_by_hand -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn check_by_hand() {
        let Ok(args) = std::env::var("NIGHTLOOM_EVIDENCE_ARGS") else {
            return;
        };
        let args: Vec<String> = args.split_whitespace().map(String::from).collect();
        println!("{}", run_cli(&args).unwrap());
    }
}
