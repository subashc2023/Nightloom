//! Research threads (nightshift backlog 271, step 1, 2026-10-02).
//!
//! A thread is one line of inquiry inside a project, carried across chats
//! by files the model keeps, under `<workspace>/.agents/threads/<slug>/`:
//!
//! - `thread.md` — the running file, edited in small deltas. Its
//!   `## Start here` (≤ ~600 words) is the only part loaded automatically,
//!   as the thread prompt layer ([`thread_segment`]); the rest (Queue,
//!   Claims, His view, …) is read on demand.
//! - `log.md` — one dated paragraph per round, appended, never edited.
//! - `archive.md` — struck lines moved out of `thread.md`, verbatim, with a
//!   `[struck DATE -> archive.md]` pointer left where each stood.
//!
//! and one generated file per project, `threads/INDEX.md`: one line per
//! thread (slug, status, last touched, pointer, upkeep flags), most
//! recently touched first — so switching threads, or picking a dormant one
//! up days later, starts from one small file (his ask, 2026-10-02 ~12:25 AM:
//! threads last "five days max" and he switches between them often).
//!
//! **Upkeep** ([`upkeep`]) is the mechanical half of keeping the files
//! small, and needs no model turn. It mirrors the practices file's rules
//! for the Nightshift notes (`~/.claude/practices/practices.md` §1, §2, §5):
//!
//! - *Supersede, never delete; archive by size and rounds, not age.* A
//!   dated `~~strike~~` from an earlier round (dated before the newest
//!   `log.md` entry) moves to `archive.md` verbatim; once `thread.md` is
//!   past [`THREAD_CAP_TOKENS`], every dated strike moves. An undated strike
//!   never moves (the tidy step's rule). ~~Older than 30 days~~ — the
//!   spec's first rule, dropped on his word the same night: no thread lives
//!   that long.
//! - *Duplicate queue rows are merged, both pointers kept*: the first row
//!   takes the second's pointer, and the second is struck (dated) with
//!   `→ <first id>` beside it, so the id still resolves.
//! - *Flag, never trim* (`mdcheck.py`'s rule): a Start here over
//!   [`START_HERE_WORDS`], a `## His view` quote over
//!   [`HIS_VIEW_SENTENCES`] sentences and a pasted block over
//!   [`PASTE_LINES`] lines are *flagged*. Condensing needs judgement, so the
//!   flags go to the model — in the thread layer and in the wrap-up — which
//!   condenses claim by claim with each claim's pointer kept (ACE's
//!   "context collapse" warning; practices §1) and replaces pastes with
//!   pointers.
//!
//! Who runs it: the shell at *Continue* (the wrapped chat has stopped
//! writing, the next has not started — no second writer), the daily pass
//! ([`crate::dream::tidy_threads`]), and a dry run for the wrap-up's flags.

use chrono::NaiveDate;
use nightloom_core::{Segment, SegmentKind};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// The threads folder inside the docspace: `<workspace>/.agents/threads`.
pub const THREADS_DIR: &str = "threads";
pub const THREAD_FILE: &str = "thread.md";
pub const LOG_FILE: &str = "log.md";
pub const ARCHIVE_FILE: &str = "archive.md";
pub const INDEX_FILE: &str = "INDEX.md";
pub const TEMPLATE_FILE: &str = "TEMPLATE.md";
/// Past this many words, Start here is flagged for condensing.
pub const START_HERE_WORDS: usize = 600;
/// Past this many sentences, a `## His view` quote is flagged.
pub const HIS_VIEW_SENTENCES: usize = 3;
/// Past this many lines, a pasted block (a fence or a quote run) is flagged.
pub const PASTE_LINES: usize = 15;
/// Past this many estimated tokens of `thread.md`, every dated strike
/// moves, not only the earlier rounds'. ~10k is the design's "full
/// thread after ~10 rounds" (271 note §5), read only on demand.
pub const THREAD_CAP_TOKENS: u64 = 10_000;
/// Ceiling on the Start here text the layer carries; a runaway section
/// costs a read, not the window.
const LAYER_CAP: usize = 12 * 1024;

/// A slug names a folder: lowercase letters, digits, `-` and `_`, starting
/// with a letter or digit, at most 64 characters. Never a path.
pub fn valid_slug(slug: &str) -> bool {
    let b = slug.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-' || *c == b'_')
}

/// A slug from a name: lowercase, runs of anything else become one `-`.
pub fn slug_from(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-').to_string();
    out.chars().take(64).collect()
}

pub fn threads_dir(notes_dir: &Path) -> PathBuf {
    notes_dir.join(THREADS_DIR)
}

/// The folder of thread `slug`, or `None` for a slug that is not one.
pub fn thread_dir(notes_dir: &Path, slug: &str) -> Option<PathBuf> {
    valid_slug(slug).then(|| threads_dir(notes_dir).join(slug))
}

/// What the prompt needs to know about the chat's thread.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadContext {
    pub slug: String,
    /// `<workspace>/.agents/threads/<slug>`.
    pub dir: PathBuf,
    /// How the model types the folder: `.agents/threads/<slug>`.
    pub rel: String,
}

impl ThreadContext {
    /// The context for `slug` in the docspace at `notes_dir`; `None` for an
    /// invalid slug.
    pub fn new(notes_dir: &Path, slug: &str) -> Option<Self> {
        let dir = thread_dir(notes_dir, slug)?;
        let docspace = notes_dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| ".agents".into());
        Some(Self {
            slug: slug.to_string(),
            dir,
            rel: format!("{docspace}/{THREADS_DIR}/{slug}"),
        })
    }
}

// ---- sections ----

/// The body of `## <heading>` (exact heading text, case-insensitive): the
/// 0-based line range after the heading up to the next `## ` heading or
/// the end, fenced code skipped when looking for headings.
pub fn section_range(lines: &[&str], heading: &str) -> Option<(usize, usize)> {
    let mut in_fence = false;
    let mut start = None;
    for (i, line) in lines.iter().enumerate() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        if let Some(h) = line.strip_prefix("## ") {
            if start.is_some() {
                return start.map(|s| (s, i));
            }
            if h.trim().eq_ignore_ascii_case(heading) {
                start = Some(i + 1);
            }
        }
    }
    start.map(|s| (s, lines.len()))
}

/// The text of `## Start here`, trimmed; `None` when the file has none.
pub fn start_here(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.split('\n').collect();
    let (a, b) = section_range(&lines, "Start here")?;
    Some(lines[a..b].join("\n").trim().to_string())
}

pub fn words(text: &str) -> usize {
    text.split_whitespace().count()
}

/// Sentences in a quote: runs ended by `.`, `!` or `?` followed by a space
/// or the end, plus a trailing run without one.
pub fn sentences(text: &str) -> usize {
    let chars: Vec<char> = text.chars().collect();
    let mut count = 0;
    let mut any = false;
    for (i, c) in chars.iter().enumerate() {
        if matches!(c, '.' | '!' | '?') {
            let next = chars.get(i + 1);
            let ends = next.is_none_or(|n| n.is_whitespace() || *n == '"' || *n == '”');
            let prev_punct = i > 0 && matches!(chars[i - 1], '.' | '!' | '?');
            if ends && any && !prev_punct {
                count += 1;
                any = false;
            }
        } else if c.is_alphanumeric() {
            any = true;
        }
    }
    count + usize::from(any)
}

// ---- the prompt layer ----

/// The thread layer: the rules of a bound chat, then the file's
/// `## Start here` as it stood at connect. Stable for the life of the
/// connection like the notes index, so it caches; a Start here the model
/// rewrites mid-chat reaches the layer at the next connect (on Claude
/// Code, at the next cold moment — `prompt_hold`).
pub fn thread_segment(ctx: &ThreadContext) -> Segment {
    let file = ctx.dir.join(THREAD_FILE);
    match std::fs::read_to_string(&file) {
        Ok(text) => {
            let body = start_here(&text).unwrap_or_default();
            let flags = check_text(&text, None).flags();
            segment(ctx, Some(&body), &flags)
        }
        Err(_) => segment(ctx, None, &[]),
    }
}

/// The layer around a chat's own text in place of the file's Start here.
pub fn thread_segment_from(ctx: &ThreadContext, body: &str) -> Segment {
    segment(ctx, Some(body), &[])
}

/// The file's Start here, for the Context page's *Edit for this chat*.
pub fn layer_source(ctx: &ThreadContext) -> Option<String> {
    let text = std::fs::read_to_string(ctx.dir.join(THREAD_FILE)).ok()?;
    start_here(&text)
}

fn segment(ctx: &ThreadContext, body: Option<&str>, flags: &[String]) -> Segment {
    let slug = &ctx.slug;
    let rel = &ctx.rel;
    let mut text = format!("<thread slug=\"{slug}\" dir=\"{rel}\">\n");
    let Some(body) = body else {
        text.push_str(&format!(
            "This chat is bound to the research thread `{slug}`, but {rel}/{THREAD_FILE} does \
             not exist. Say so to the user before relying on any thread.\n</thread>"
        ));
        return Segment::new(SegmentKind::Thread, format!("thread/{slug}"), text);
    };
    text.push_str(&format!(
        "This chat works from a research thread: one line of inquiry carried across chats by \
         files you keep. Only its \"## Start here\" is below. Read the rest of \
         {rel}/{THREAD_FILE} (Queue, Claims, His view, Vocabulary), {rel}/{LOG_FILE} and the \
         chats it cites (read_chat at the cited event) only when a task needs them, by section \
         rather than whole: list the headings first (`grep -n '^## '`), then read one section \
         by its line range, one file per command — never print the whole file, since a \
         command's output is cut past about 10,000 characters.\n\n\
         Keep it as you go, not only at the wrap-up: after each round that changes the queue \
         or the claims, edit {THREAD_FILE} in small deltas (never a rewrite; only Start here \
         is rewritten, at most {START_HERE_WORDS} words, starting with an \"As of <date, \
         time> — <one line>\" line) and append one dated paragraph to {LOG_FILE}. Strike, \
         never delete: ~~old~~ (struck <date>: why) → new id. Tag every claim user_stated, \
         inferred or external (\"source X claims Y\", with its verification state). \"## His \
         view\" takes only the user's verbatim words, at most about three sentences per \
         quote, each with a chat-event pointer. Point, don't paste: long outputs go to \
         .agents/notes/ (never /tmp), cited by file and chat event. One writer: this chat; if \
         another open chat is bound to the same thread, append to {LOG_FILE} only.\n"
    ));
    if !flags.is_empty() {
        text.push_str("\nUpkeep due (fix in a small edit when convenient, and at the wrap-up):\n");
        for f in flags {
            text.push_str(&format!("- {f}\n"));
        }
    }
    let mut body = body.trim().to_string();
    if body.len() > LAYER_CAP {
        let mut cut = LAYER_CAP;
        while !body.is_char_boundary(cut) {
            cut -= 1;
        }
        body.truncate(cut);
        body.push_str("\n…(Start here truncated here; read the file for the rest)");
    }
    text.push_str("\n## Start here\n");
    if body.is_empty() {
        text.push_str("(empty — write it at the end of this round)\n");
    } else {
        text.push_str(&body);
        text.push('\n');
    }
    text.push_str("</thread>");
    Segment::new(SegmentKind::Thread, format!("thread/{slug}"), text)
}

// ---- the checks (read only) ----

/// What the read-only checks found in one thread's files.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Checks {
    pub start_here_words: usize,
    /// Estimated tokens of `thread.md`.
    pub tokens: u64,
    /// `## His view` quotes over the sentence limit: (1-based line, sentences).
    pub long_quotes: Vec<(usize, usize)>,
    /// Pasted blocks over the line limit: (file, 1-based first line, lines).
    pub long_pastes: Vec<(String, usize, usize)>,
}

impl Checks {
    /// Plain sentences for the model: what to fix, never done for it.
    pub fn flags(&self) -> Vec<String> {
        let mut out = Vec::new();
        if self.start_here_words > START_HERE_WORDS {
            out.push(format!(
                "\"## Start here\" is {} words, over its {START_HERE_WORDS}. Condense it claim by \
                 claim, each claim keeping its pointer; move detail down into Claims or Queue \
                 (by id) rather than deleting it.",
                self.start_here_words
            ));
        }
        for (line, n) in &self.long_quotes {
            out.push(format!(
                "A \"## His view\" quote at {THREAD_FILE} line {line} is {n} sentences (over \
                 ~{HIS_VIEW_SENTENCES}). Keep its key sentences verbatim and replace the rest \
                 with a pointer to where it lives (chat event or his file)."
            ));
        }
        for (file, line, n) in &self.long_pastes {
            out.push(format!(
                "A pasted block in {file} at line {line} runs {n} lines (over {PASTE_LINES}). \
                 Move it to .agents/notes/ (or cite its chat event) and leave a pointer."
            ));
        }
        if self.tokens > THREAD_CAP_TOKENS {
            out.push(format!(
                "{THREAD_FILE} is ~{}k tokens, over its ~{}k cap. Nightloom archives struck \
                 lines; look for detail that belongs in .agents/notes/ behind a pointer.",
                self.tokens / 1000,
                THREAD_CAP_TOKENS / 1000
            ));
        }
        out
    }
}

/// Run the read-only checks over `thread.md`'s text (and `log.md`'s, when
/// given, for pasted blocks).
pub fn check_text(thread: &str, log: Option<&str>) -> Checks {
    let lines: Vec<&str> = thread.split('\n').collect();
    let mut c = Checks {
        start_here_words: start_here(thread).map(|s| words(&s)).unwrap_or(0),
        tokens: nightloom_core::estimate_tokens(thread),
        ..Checks::default()
    };
    if let Some((a, b)) = section_range(&lines, "His view") {
        for (i, line) in lines.iter().enumerate().take(b).skip(a) {
            let t = line.trim_start();
            let Some(item) = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")) else {
                continue;
            };
            let quoted = match (item.find(['"', '“']), item.rfind(['"', '”'])) {
                (Some(x), Some(y)) if y > x => &item[x + 1..y],
                _ => item,
            };
            let n = sentences(quoted);
            if n > HIS_VIEW_SENTENCES {
                c.long_quotes.push((i + 1, n));
            }
        }
    }
    c.long_pastes.extend(pastes(THREAD_FILE, &lines));
    if let Some(log) = log {
        let ll: Vec<&str> = log.split('\n').collect();
        c.long_pastes.extend(pastes(LOG_FILE, &ll));
    }
    c
}

/// Fenced blocks and runs of `>` lines longer than [`PASTE_LINES`].
fn pastes(file: &str, lines: &[&str]) -> Vec<(String, usize, usize)> {
    let mut out = Vec::new();
    let mut fence: Option<usize> = None;
    let mut quote: Option<usize> = None;
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim_start();
        if t.starts_with("```") {
            match fence {
                None => fence = Some(i),
                Some(s) => {
                    let n = i.saturating_sub(s + 1);
                    if n > PASTE_LINES {
                        out.push((file.to_string(), s + 1, n));
                    }
                    fence = None;
                }
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }
        if t.starts_with('>') {
            quote.get_or_insert(i);
        } else if let Some(s) = quote.take() {
            let n = i - s;
            if n > PASTE_LINES {
                out.push((file.to_string(), s + 1, n));
            }
        }
    }
    if let Some(s) = quote {
        let n = lines.len() - s;
        if n > PASTE_LINES {
            out.push((file.to_string(), s + 1, n));
        }
    }
    out
}

// ---- the upkeep (writes) ----

/// What one upkeep run found and (with `apply`) did to one thread.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct Upkeep {
    pub slug: String,
    pub checks: Checks,
    /// The flags for the model ([`Checks::flags`]).
    pub flags: Vec<String>,
    /// Struck spans moved (or, on a dry run, that would move) to `archive.md`.
    pub struck_moved: usize,
    /// Dated strikes left in place: this round's, under the cap.
    pub struck_kept: usize,
    /// Strikes with no date: never moved.
    pub struck_undated: usize,
    /// Queue rows merged: (kept id, merged id).
    pub merged: Vec<(String, String)>,
    /// Bytes `thread.md` shed (or would shed).
    pub saved: usize,
    /// The newest date in `log.md` — the last round's — when there is one.
    pub last_round: Option<NaiveDate>,
}

/// The newest `YYYY-MM-DD` in `log.md`: the date of the last round. An
/// aside's fold entry (between [`FOLD_BEGIN`] and [`FOLD_END`], backlog
/// 282) is not a round — the bound chat's wrap-up is — so its dates do not
/// count.
pub fn last_round(log: &str) -> Option<NaiveDate> {
    let re = regex::Regex::new(r"\b(20\d{2}-\d{2}-\d{2})\b").expect("valid regex");
    let mut inside = false;
    let mut newest = None;
    for line in log.lines() {
        let t = line.trim();
        if t.starts_with(FOLD_END) {
            inside = false;
            continue;
        }
        if t.starts_with(FOLD_BEGIN) {
            inside = true;
            continue;
        }
        if inside {
            continue;
        }
        for c in re.captures_iter(line) {
            if let Ok(d) = NaiveDate::parse_from_str(&c[1], "%Y-%m-%d") {
                newest = newest.max(Some(d));
            }
        }
    }
    newest
}

/// The first line of an aside's fold entry in `log.md` (backlog 282); the
/// rest of the marker line names the chat and the aside.
pub const FOLD_BEGIN: &str = "<!-- aside fold";
/// The fold entry's last line.
pub const FOLD_END: &str = "<!-- /aside fold -->";

/// Append an aside's fold entry to a thread's `log.md` (backlog 282) — the
/// app writes it, not the model, so `thread.md` keeps its one writer (the
/// bound chat, whose next wrap-up folds the entry in). Append-only: the
/// file is opened for appending and nothing before the entry is touched;
/// a blank line separates it from what was there. Refused for a folder
/// with no `thread.md`. Returns the bytes appended.
pub fn append_log(dir: &Path, entry: &str) -> Result<usize, String> {
    use std::io::Write as _;
    if !dir.join(THREAD_FILE).is_file() {
        return Err(format!("{} has no {THREAD_FILE}", dir.display()));
    }
    let entry = entry.trim_matches('\n');
    if entry.trim().is_empty() {
        return Err("nothing to append".to_string());
    }
    let path = dir.join(LOG_FILE);
    let before = std::fs::read(&path).unwrap_or_default();
    let sep = if before.is_empty() || before.ends_with(b"\n\n") {
        ""
    } else if before.ends_with(b"\n") {
        "\n"
    } else {
        "\n\n"
    };
    let text = format!("{sep}{entry}\n");
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    f.write_all(text.as_bytes())
        .map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(text.len())
}

/// The upkeep of one thread folder. A dry run (`apply` false) reports what
/// would change; an apply rewrites `thread.md` whole (temp file, then a
/// rename) and appends to `archive.md`. Nothing is deleted.
pub fn upkeep(dir: &Path, today: NaiveDate, apply: bool) -> Result<Upkeep, String> {
    let slug = dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let path = dir.join(THREAD_FILE);
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let log = std::fs::read_to_string(dir.join(LOG_FILE)).unwrap_or_default();
    let mut up = Upkeep {
        slug,
        last_round: last_round(&log),
        ..Upkeep::default()
    };

    // 1. Duplicate queue rows.
    let (merged_text, merged) = merge_queue(&text, today);
    up.merged = merged;

    // 2. Struck spans from earlier rounds (all of them past the cap).
    let over_cap = nightloom_core::estimate_tokens(&merged_text) > THREAD_CAP_TOKENS;
    let lines: Vec<&str> = merged_text.split('\n').collect();
    let spans = crate::tidy::find_spans(&lines, today);
    let mut moving = Vec::new();
    for s in spans {
        // An unterminated span is left alone, and so is one inside inline
        // code: the "How to edit" example `~~old~~ (struck <date>: …)` is
        // a rule, not a strike (found on the real Stuart thread, whose
        // example carries a real date).
        if s.unterminated || in_inline_code(lines[s.start_line], s.start_col) {
            continue;
        }
        match s.date {
            None => up.struck_undated += 1,
            Some(d) if over_cap || up.last_round.is_some_and(|r| d < r) => moving.push(s),
            Some(_) => up.struck_kept += 1,
        }
    }
    up.struck_moved = moving.len();
    let (out, entries) = move_spans(&merged_text, &moving);
    up.saved = text.len().saturating_sub(out.len());
    up.checks = check_text(&out, Some(&log));
    up.flags = up.checks.flags();

    if apply && out != text {
        if !entries.is_empty() {
            let apath = dir.join(ARCHIVE_FILE);
            let mut archive = std::fs::read_to_string(&apath).unwrap_or_default();
            if archive.is_empty() {
                archive.push_str(&format!(
                    "# Archive: struck lines from `{THREAD_FILE}`\n\nMoved by Nightloom's thread \
                     upkeep (nightshift backlog 271): each entry is a struck span verbatim, \
                     with the line it stood on when it moved. Nothing here is deleted; a \
                     `[struck DATE -> {ARCHIVE_FILE}]` pointer marks the spot in the live \
                     file. Newest run last.\n\n"
                ));
            }
            archive.push_str(&format!("## upkeep run {}\n\n", today.format("%Y-%m-%d")));
            for e in &entries {
                archive.push_str(e);
                archive.push('\n');
            }
            crate::tidy::write_whole(&apath, &archive)?;
        }
        crate::tidy::write_whole(&path, &out)?;
    }
    Ok(up)
}

/// Whether byte `col` of `line` sits inside an inline code span: an odd
/// number of backticks before it.
fn in_inline_code(line: &str, col: usize) -> bool {
    line[..col.min(line.len())].matches('`').count() % 2 == 1
}

/// Replace each span with its pointer, bottom-up so offsets hold; the
/// archive entries come back in file order.
fn move_spans(text: &str, spans: &[crate::tidy::Span]) -> (String, Vec<String>) {
    let mut lines: Vec<String> = text.split('\n').map(String::from).collect();
    let mut todo: Vec<&crate::tidy::Span> = spans.iter().collect();
    todo.sort_by_key(|s| std::cmp::Reverse((s.start_line, s.start_col)));
    let mut entries = Vec::new();
    for s in todo {
        let date = s.date.map(|d| d.format("%Y-%m-%d").to_string());
        let date = date.unwrap_or_default();
        entries.push(format!(
            "### {THREAD_FILE} line {}, struck {date}\n\n{}\n",
            s.start_line + 1,
            s.text
        ));
        let head = lines[s.start_line][..s.start_col].to_string();
        let tail = lines[s.end_line][s.end_col..].to_string();
        let joined = format!("{head}[struck {date} -> {ARCHIVE_FILE}]{tail}");
        lines.splice(s.start_line..=s.end_line, std::iter::once(joined));
    }
    entries.reverse();
    (lines.join("\n"), entries)
}

fn cells(line: &str) -> Option<Vec<String>> {
    let t = line.trim();
    if !t.starts_with('|') || !t.ends_with('|') || t.len() < 2 {
        return None;
    }
    Some(
        t[1..t.len() - 1]
            .split('|')
            .map(|c| c.trim().to_string())
            .collect(),
    )
}

fn normalized(item: &str) -> String {
    let mut out = String::new();
    for w in item
        .to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
    {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(w);
    }
    out
}

/// Merge `## Queue` rows whose item text is the same once case and
/// punctuation are set aside. The first row keeps its place and takes the
/// later row's pointer; the later row is struck, dated, pointing at the
/// first, and marked merged. Rows already struck or merged are skipped.
pub fn merge_queue(text: &str, today: NaiveDate) -> (String, Vec<(String, String)>) {
    let mut lines: Vec<String> = text.split('\n').map(String::from).collect();
    let view: Vec<&str> = text.split('\n').collect();
    let Some((a, b)) = section_range(&view, "Queue") else {
        return (text.to_string(), Vec::new());
    };
    let mut seen: Vec<(String, usize)> = Vec::new();
    let mut merged = Vec::new();
    let day = today.format("%Y-%m-%d").to_string();
    for i in a..b {
        let Some(row) = cells(&lines[i]) else {
            continue;
        };
        if row.len() < 3 || row[0].eq_ignore_ascii_case("id") || row[0].starts_with("---") {
            continue;
        }
        let item = &row[1];
        let status = row.get(2).map(String::as_str).unwrap_or("");
        if item.contains("~~") || status.starts_with("merged") {
            continue;
        }
        let key = normalized(item);
        if key.is_empty() {
            continue;
        }
        match seen.iter().find(|(k, _)| *k == key) {
            None => seen.push((key, i)),
            Some((_, keep)) => {
                let keep = *keep;
                let mut first = cells(&lines[keep]).expect("a row seen is a row");
                let dup_id = row[0].clone();
                let keep_id = first[0].clone();
                let dup_ptr = row.last().cloned().unwrap_or_default();
                if let Some(p) = first.last_mut() {
                    *p = format!("{p}; {dup_ptr} (merged from {dup_id} {day})");
                }
                lines[keep] = format!("| {} |", first.join(" | "));
                let mut dup = row.clone();
                dup[1] = format!("~~{item}~~ (struck {day}: duplicate of {keep_id}) → {keep_id}");
                dup[2] = format!("merged → {keep_id}");
                lines[i] = format!("| {} |", dup.join(" | "));
                merged.push((keep_id, dup_id));
            }
        }
    }
    (lines.join("\n"), merged)
}

// ---- listing, creating, the index ----

/// One thread as the picker and the index show it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ThreadInfo {
    pub slug: String,
    /// The `# Thread: <name>` heading, else the slug.
    pub title: String,
    /// One line: a `Status:` or `As of` line in Start here, else its first line.
    pub status: String,
    /// `thread.md`'s last change, `YYYY-MM-DD`, local time.
    pub touched: Option<String>,
    pub start_here_words: usize,
    pub tokens: u64,
    pub flags: usize,
}

fn title_of(text: &str, slug: &str) -> String {
    text.lines()
        .find_map(|l| l.strip_prefix("# "))
        .map(|h| h.trim().trim_start_matches("Thread:").trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| slug.to_string())
}

fn status_of(start: &str) -> String {
    let clean = |l: &str| l.replace("**", "").replace('|', "/").trim().to_string();
    // A `Status:` or `As of` line wins; else the first paragraph, its
    // wrapped lines joined.
    let marked = start.lines().map(clean).find(|c| {
        let c = c.to_lowercase();
        c.starts_with("status:") || c.starts_with("as of")
    });
    let pick = marked.unwrap_or_else(|| {
        start
            .split("\n\n")
            .map(|p| p.lines().map(clean).collect::<Vec<_>>().join(" "))
            .find(|p| !p.trim().is_empty())
            .unwrap_or_default()
    });
    if pick.chars().count() <= 160 {
        return pick;
    }
    let mut cut: String = pick.chars().take(157).collect();
    if let Some(sp) = cut.rfind(' ') {
        cut.truncate(sp);
    }
    format!("{cut}…")
}

fn touched(path: &Path) -> Option<String> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let local: chrono::DateTime<chrono::Local> = modified.into();
    Some(local.format("%Y-%m-%d").to_string())
}

/// Every thread in the docspace — each folder under `threads/` with a
/// `thread.md` — most recently touched first.
pub fn list_threads(notes_dir: &Path) -> Vec<ThreadInfo> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(threads_dir(notes_dir)) else {
        return out;
    };
    for entry in rd.filter_map(Result::ok) {
        let slug = entry.file_name().to_string_lossy().into_owned();
        if !valid_slug(&slug) {
            continue;
        }
        let file = entry.path().join(THREAD_FILE);
        let Ok(text) = std::fs::read_to_string(&file) else {
            continue;
        };
        let start = start_here(&text).unwrap_or_default();
        let checks = check_text(&text, None);
        out.push(ThreadInfo {
            title: title_of(&text, &slug),
            status: status_of(&start),
            touched: touched(&file),
            start_here_words: checks.start_here_words,
            tokens: checks.tokens,
            flags: checks.flags().len(),
            slug,
        });
    }
    out.sort_by(|a, b| b.touched.cmp(&a.touched).then_with(|| a.slug.cmp(&b.slug)));
    out
}

/// The generated `threads/INDEX.md`: one line per thread, most recently
/// touched first (practices §5's generated INDEX). Rewritten whole each
/// time; nobody edits it.
pub fn index_text(threads: &[ThreadInfo]) -> String {
    let mut s = String::from(
        "# Threads\n\nGenerated by Nightloom (thread upkeep, nightshift backlog 271); do not \
         edit — it is rewritten whole. One line per thread, most recently touched first. To \
         pick a thread up, read its `thread.md` `## Start here` first, then `## Queue`.\n\n\
         | thread | status | last touched | pointer | upkeep |\n|---|---|---|---|---|\n",
    );
    if threads.is_empty() {
        s.push_str("| (none yet) | | | | |\n");
    }
    for t in threads {
        let flags = if t.flags == 0 {
            "—".to_string()
        } else {
            format!("{} flag{}", t.flags, if t.flags == 1 { "" } else { "s" })
        };
        s.push_str(&format!(
            "| `{}` — {} | {} | {} | `{}/{}` ({} words of Start here, ~{}k tokens) | {} |\n",
            t.slug,
            t.title.replace('|', "/"),
            t.status,
            t.touched.as_deref().unwrap_or("?"),
            t.slug,
            THREAD_FILE,
            t.start_here_words,
            (t.tokens + 500) / 1000,
            flags
        ));
    }
    s
}

/// Write `threads/INDEX.md` when the folder exists and the text changed.
pub fn write_index(notes_dir: &Path) -> Result<(), String> {
    let dir = threads_dir(notes_dir);
    if !dir.is_dir() {
        return Ok(());
    }
    let text = index_text(&list_threads(notes_dir));
    let path = dir.join(INDEX_FILE);
    if std::fs::read_to_string(&path).ok().as_deref() == Some(text.as_str()) {
        return Ok(());
    }
    crate::tidy::write_whole(&path, &text)
}

/// The built-in `thread.md` skeleton, used when the project has no
/// `threads/TEMPLATE.md` (step 0's template, plus the practices mirrors:
/// a dated "As of" line, provenance tags, point-don't-paste).
pub const SKELETON: &str = "# Thread: <name>

Pointer form: `<chat id> ev <n> ¶<k>` = chat, event index, paragraph. Rules: `## How to edit`.

## Start here
As of <date, time AM/PM> — <one line: where the thread stands>

(≤ 600 words: the question; his framing in one verbatim quote with a pointer; the front of the queue; what changed last round; the files that matter.)

## Queue
| id | Item | Status | Pointer |
|---|---|---|---|

## Claims
| id | Claim | Tag | Status | Pointer |
|---|---|---|---|---|

## His view
(His words only, verbatim, each with a pointer. His own write-ups go here unedited, or a pointer to them.)

## The model's reading of his view
(Paraphrase and inference, tagged `inferred`.)

## Tried and failed / rejected
| What | Who rejected | Reason | Pointer |
|---|---|---|---|

## Vocabulary

## How to edit
- One writer: the chat currently working from this thread; a second open chat only appends to log.md and adds queue ids.
- Small edits after each round that changed the queue or the claims; only Start here is rewritten, and it starts with a dated \"As of\" line.
- Strike, never delete: `~~old~~ (struck <date>: why) → C-nn`. New ids are max + 1. Nightloom moves struck lines from earlier rounds to archive.md, verbatim, with a pointer left behind.
- Provenance on every claim: `user_stated`, `inferred`, or `external` (\"source X claims Y\", with its verification state).
- His view takes only his verbatim words (≤ ~3 sentences per quote) with a pointer.
- Point, don't paste: long outputs go to .agents/notes/ or another durable project path, never /tmp; a pointer names a file and a chat event.
";

/// The skeleton from the project's `threads/TEMPLATE.md` — the first
/// ```` ```markdown ```` fence after its `## thread.md skeleton` heading —
/// else [`SKELETON`].
pub fn skeleton(notes_dir: &Path) -> String {
    let Ok(t) = std::fs::read_to_string(threads_dir(notes_dir).join(TEMPLATE_FILE)) else {
        return SKELETON.to_string();
    };
    let Some(at) = t.find("## thread.md skeleton") else {
        return SKELETON.to_string();
    };
    let rest = &t[at..];
    let Some(open) = rest.find("```markdown\n") else {
        return SKELETON.to_string();
    };
    let body = &rest[open + "```markdown\n".len()..];
    // The skeleton itself holds no fence; its closing one is the first
    // line that is exactly three backticks.
    let mut out = Vec::new();
    for line in body.split('\n') {
        if line.trim_end() == "```" {
            return out.join("\n") + "\n";
        }
        out.push(line);
    }
    SKELETON.to_string()
}

/// Start a thread from the template: `threads/<slug>/thread.md` with the
/// name filled in, an empty `log.md`, and the index rewritten. Refused for
/// an invalid slug or one that exists — nothing is overwritten.
pub fn create_thread(notes_dir: &Path, slug: &str, name: &str) -> Result<ThreadInfo, String> {
    let dir = thread_dir(notes_dir, slug).ok_or_else(|| {
        format!("{slug:?} is not a thread name: lowercase letters, digits, - and _ only")
    })?;
    if dir.exists() {
        return Err(format!("a thread {slug} already exists"));
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let name = if name.trim().is_empty() {
        slug
    } else {
        name.trim()
    };
    let body = skeleton(notes_dir).replace("<name>", name);
    let file = dir.join(THREAD_FILE);
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&file)
        .and_then(|mut f| std::io::Write::write_all(&mut f, body.as_bytes()))
        .map_err(|e| format!("{}: {e}", file.display()))?;
    let log = dir.join(LOG_FILE);
    if !log.exists() {
        std::fs::write(
            &log,
            format!("# Log: {name}\n\nOne dated paragraph per round, appended, never edited.\n"),
        )
        .map_err(|e| format!("{}: {e}", log.display()))?;
    }
    write_index(notes_dir)?;
    list_threads(notes_dir)
        .into_iter()
        .find(|t| t.slug == slug)
        .ok_or_else(|| format!("the thread {slug} was written but does not read back"))
}

/// Upkeep for every thread in one docspace, then its index. A thread that
/// will not read is reported in `errors`, not fatal.
pub fn tidy_threads(notes_dir: &Path, today: NaiveDate, apply: bool) -> (Vec<Upkeep>, Vec<String>) {
    let mut ups = Vec::new();
    let mut errors = Vec::new();
    for t in list_threads(notes_dir) {
        let dir = threads_dir(notes_dir).join(&t.slug);
        match upkeep(&dir, today, apply) {
            Ok(u) => ups.push(u),
            Err(e) => errors.push(e),
        }
    }
    if apply && let Err(e) = write_index(notes_dir) {
        errors.push(e);
    }
    (ups, errors)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nightloom-thread-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn day(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    const FIXTURE: &str = "# Thread: Fixture

## Start here
As of 2026-10-02 1:00 AM — fixture.

The question.

## Queue
| id | Item | Status | Pointer |
|---|---|---|---|
| T-01 | Signal B: surprise on presuppositions | live | ev 64 §1a |
| T-02 | Duhem problem | live | ev 164 ¶1 |
| T-03 | signal b — surprise on presuppositions. | live | ev 197 §1 |

## Claims
| id | Claim | Tag | Status | Pointer |
|---|---|---|---|---|
| C-01 | ~~old claim~~ (struck 2026-09-30: wrong) → C-02 | inferred | struck | ev 1 |
| C-02 | new claim | inferred | live | ev 2 |
| C-03 | ~~this round's~~ (struck 2026-10-02: why) → C-04 | inferred | struck | ev 3 |
| C-05 | ~~no date~~ → C-06 | inferred | struck | ev 4 |

## His view
- \"One. Two. Three.\" (`ev 1 ¶1`)
- \"One. Two. Three. Four! Five?\" (`ev 1 ¶2`)

## How to edit
- Strike, never delete: `~~old~~ (struck <date>: why) → C-nn`.
";

    fn write_fixture(dir: &Path, thread: &str, log: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(THREAD_FILE), thread).unwrap();
        std::fs::write(dir.join(LOG_FILE), log).unwrap();
    }

    #[test]
    fn slugs_are_folder_names_never_paths() {
        assert!(valid_slug("stuart-brainstorm"));
        assert!(valid_slug("t1_x"));
        assert!(!valid_slug(""));
        assert!(!valid_slug("../x"));
        assert!(!valid_slug("Stuart"));
        assert!(!valid_slug("-x"));
        assert!(!valid_slug("a/b"));
        assert_eq!(
            slug_from("  Stuart brainstorm (Deep Thoughts)! "),
            "stuart-brainstorm-deep-thoughts"
        );
    }

    #[test]
    fn start_here_is_the_section_only() {
        assert_eq!(
            start_here(FIXTURE).unwrap(),
            "As of 2026-10-02 1:00 AM — fixture.\n\nThe question."
        );
        assert_eq!(start_here("# x\n\n## Queue\n"), None);
        // A `## ` inside a fence is not a heading.
        let t = "## Start here\na\n```\n## not\n```\nb\n## Queue\n";
        assert_eq!(start_here(t).unwrap(), "a\n```\n## not\n```\nb");
    }

    #[test]
    fn the_layer_carries_start_here_and_the_rules_not_the_rest() {
        let tmp = scratch();
        let notes = tmp.as_path().join(".agents");
        let ctx = ThreadContext::new(&notes, "fx").unwrap();
        assert_eq!(ctx.rel, ".agents/threads/fx");
        write_fixture(&ctx.dir, FIXTURE, "");
        let seg = thread_segment(&ctx);
        assert_eq!(seg.kind, SegmentKind::Thread);
        assert_eq!(seg.name, "thread/fx");
        assert!(seg.text.contains("The question."), "{}", seg.text);
        assert!(seg.text.contains(".agents/threads/fx/thread.md"));
        assert!(!seg.text.contains("Duhem"), "the queue is read on demand");
        // The long quote is flagged in the layer.
        assert!(seg.text.contains("Upkeep due"), "{}", seg.text);
        // The chat's own text stands in for Start here.
        let own = thread_segment_from(&ctx, "my own start");
        assert!(own.text.contains("my own start") && !own.text.contains("The question."));
        // A missing file says so.
        let gone = ThreadContext::new(&notes, "gone").unwrap();
        assert!(thread_segment(&gone).text.contains("does not exist"));
        assert_eq!(layer_source(&ctx).unwrap(), start_here(FIXTURE).unwrap());
    }

    #[test]
    fn size_and_reference_rules_flag_and_never_trim() {
        let long = format!(
            "## Start here\n{}\n## His view\n- \"A. B. C. D.\" (ev 1)\n- \"A. B. C.\" (ev 2)\n\n```\n{}```\n",
            "word ".repeat(601),
            "x\n".repeat(16)
        );
        let c = check_text(&long, None);
        assert_eq!(c.start_here_words, 601);
        assert_eq!(c.long_quotes, vec![(4, 4)]);
        assert_eq!(c.long_pastes, vec![(THREAD_FILE.to_string(), 7, 16)]);
        let flags = c.flags();
        assert_eq!(flags.len(), 3, "{flags:?}");
        assert!(flags[0].contains("claim by claim") && flags[0].contains("pointer"));
        // Exactly at the limits: nothing.
        let ok = format!("## Start here\n{}\n", "w ".repeat(600));
        assert!(check_text(&ok, None).flags().is_empty());
        let quote: String = (0..15).map(|_| "> q\n").collect();
        assert!(check_text(&quote, None).long_pastes.is_empty());
        let quote16: String = (0..16).map(|_| "> q\n").collect();
        assert_eq!(check_text(&quote16, None).long_pastes.len(), 1);
        assert_eq!(sentences("Mr. Smith went. Then?"), 3);
        assert_eq!(sentences("one sentence without a stop"), 1);
        assert_eq!(sentences("Wait... what"), 1, "an ellipsis is not a stop");
    }

    #[test]
    fn duplicate_queue_rows_merge_keeping_both_pointers() {
        let (out, merged) = merge_queue(FIXTURE, day("2026-10-02"));
        assert_eq!(merged, vec![("T-01".to_string(), "T-03".to_string())]);
        assert!(out.contains(
            "| T-01 | Signal B: surprise on presuppositions | live | ev 64 §1a; ev 197 §1 (merged from T-03 2026-10-02) |"
        ), "{out}");
        assert!(out.contains(
            "| T-03 | ~~signal b — surprise on presuppositions.~~ (struck 2026-10-02: duplicate of T-01) → T-01 | merged → T-01 | ev 197 §1 |"
        ), "{out}");
        // Idempotent: a second run merges nothing.
        let (again, more) = merge_queue(&out, day("2026-10-02"));
        assert!(more.is_empty());
        assert_eq!(again, out);
    }

    #[test]
    fn strikes_move_by_rounds_not_age_and_undated_never() {
        let tmp = scratch();
        let dir = tmp.as_path().join("fx");
        // The last round was 2026-10-01: the 2026-09-30 strike is an
        // earlier round's and moves; this round's (10-02) stays.
        write_fixture(&dir, FIXTURE, "**2026-10-01 ~10:45 AM — seed.** x\n");
        let dry = upkeep(&dir, day("2026-10-02"), false).unwrap();
        assert_eq!(dry.struck_moved, 1);
        assert_eq!(
            dry.struck_kept, 2,
            "this round's strike and the merge's own"
        );
        assert_eq!(
            dry.struck_undated, 1,
            "the undated claim; the How-to-edit example is code"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join(THREAD_FILE)).unwrap(),
            FIXTURE,
            "dry run writes nothing"
        );
        assert!(!dir.join(ARCHIVE_FILE).exists());

        let up = upkeep(&dir, day("2026-10-02"), true).unwrap();
        assert_eq!(up.struck_moved, 1);
        let live = std::fs::read_to_string(dir.join(THREAD_FILE)).unwrap();
        assert!(
            live.contains(
                "| C-01 | [struck 2026-09-30 -> archive.md] (struck 2026-09-30: wrong) → C-02 |"
            ),
            "{live}"
        );
        assert!(live.contains("~~this round's~~"));
        assert!(live.contains("~~no date~~"));
        let archive = std::fs::read_to_string(dir.join(ARCHIVE_FILE)).unwrap();
        assert!(archive.contains("~~old claim~~"), "verbatim: {archive}");
        assert!(archive.contains("line 18, struck 2026-09-30"), "{archive}");

        // Past the cap every dated strike moves, this round's too.
        let big = format!("{FIXTURE}\n{}\n", "padding ".repeat(6000));
        write_fixture(&dir, &big, "2026-10-01\n");
        let up = upkeep(&dir, day("2026-10-02"), true).unwrap();
        assert_eq!(up.struck_moved, 3, "{up:?}");
        let archive = std::fs::read_to_string(dir.join(ARCHIVE_FILE)).unwrap();
        assert_eq!(
            archive.matches("## upkeep run").count(),
            2,
            "appended, never rewritten"
        );

        // No log yet (a first round): nothing dated is from an earlier round.
        let dir2 = tmp.as_path().join("fresh");
        write_fixture(&dir2, FIXTURE, "# Log\n");
        assert_eq!(
            upkeep(&dir2, day("2026-10-02"), false)
                .unwrap()
                .struck_moved,
            0
        );
    }

    #[test]
    fn a_dated_strike_inside_inline_code_is_an_example_and_never_moves() {
        let tmp = scratch();
        let dir = tmp.join("ex");
        let thread = "## Start here\nx\n\n## How to edit\n- Strike, never delete: `~~old claim~~ (struck 2026-09-01: why) → C-nn`.\n";
        write_fixture(&dir, thread, "2026-10-01\n");
        let up = upkeep(&dir, day("2026-10-02"), true).unwrap();
        assert_eq!(up.struck_moved, 0);
        assert_eq!(
            std::fs::read_to_string(dir.join(THREAD_FILE)).unwrap(),
            thread
        );
        assert!(!dir.join(ARCHIVE_FILE).exists());
        assert!(in_inline_code("a `~~x~~` b", 3));
        assert!(!in_inline_code("a ~~x~~ `b`", 2));
    }

    #[test]
    fn create_lists_and_indexes_threads() {
        let tmp = scratch();
        let notes = tmp.as_path().join(".agents");
        assert!(list_threads(&notes).is_empty());
        let t = create_thread(&notes, "alpha", "Alpha thread").unwrap();
        assert_eq!(t.title, "Alpha thread");
        assert!(t.status.starts_with("As of"), "{}", t.status);
        assert!(
            create_thread(&notes, "alpha", "again").is_err(),
            "never overwrites"
        );
        assert!(create_thread(&notes, "../x", "bad").is_err());
        let log = std::fs::read_to_string(notes.join("threads/alpha/log.md")).unwrap();
        assert!(log.starts_with("# Log: Alpha thread"));
        let index = std::fs::read_to_string(notes.join("threads/INDEX.md")).unwrap();
        assert!(index.contains("| `alpha` — Alpha thread |"), "{index}");
        assert!(index.contains("Generated by Nightloom"));

        // A project template's skeleton wins over the built-in.
        std::fs::write(
            notes.join("threads/TEMPLATE.md"),
            "# T\n\n## thread.md skeleton\n\n```markdown\n# Thread: <name>\n\n## Start here\nfrom the template\n```\n",
        )
        .unwrap();
        create_thread(&notes, "beta", "Beta").unwrap();
        let beta = std::fs::read_to_string(notes.join("threads/beta/thread.md")).unwrap();
        assert_eq!(beta, "# Thread: Beta\n\n## Start here\nfrom the template\n");
        assert_eq!(
            list_threads(&notes).len(),
            2,
            "TEMPLATE.md and INDEX.md are not threads"
        );
    }

    #[test]
    fn a_fold_entry_is_appended_and_is_not_a_round() {
        let tmp = scratch();
        let dir = tmp.join("fold");
        write_fixture(&dir, FIXTURE, "# Log: Fixture\n\n2026-09-30 — round one.\n");
        let entry = "<!-- aside fold chat=c1 aside=\"idea\" -->\n## 2026-10-02, 5:41 PM — aside 'idea' from chat 'Stuart 9'\nHis words (2026-10-02).\n<!-- /aside fold -->";
        append_log(&dir, entry).unwrap();
        let log = std::fs::read_to_string(dir.join(LOG_FILE)).unwrap();
        assert!(
            log.starts_with("# Log: Fixture\n\n2026-09-30 — round one.\n\n<!-- aside fold"),
            "{log}"
        );
        assert!(log.ends_with("<!-- /aside fold -->\n"));
        // The fold's dates, heading included, are not a round.
        assert_eq!(last_round(&log), Some(day("2026-09-30")));
        assert_eq!(
            last_round(&format!("{log}\n2026-10-03 — wrap-up.\n")),
            Some(day("2026-10-03"))
        );
        // Twice appends twice; nothing earlier changes.
        append_log(&dir, entry).unwrap();
        let again = std::fs::read_to_string(dir.join(LOG_FILE)).unwrap();
        assert!(again.starts_with(&log));
        assert_eq!(again.matches("<!-- /aside fold -->").count(), 2);
        // No thread.md: refused, nothing written.
        let bare = tmp.join("bare");
        std::fs::create_dir_all(&bare).unwrap();
        assert!(append_log(&bare, entry).is_err());
        assert!(!bare.join(LOG_FILE).exists());
        assert!(append_log(&dir, "\n\n").is_err());
    }
}
