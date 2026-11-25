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
//! - *Over the cap, the trim is queued, never asked at the wrap-up*
//!   (nightshift item 708; practices §2, "Do not trim at wrap-up — a tired
//!   session cuts what matters"): an upkeep run that leaves `thread.md` past
//!   [`THREAD_CAP_TOKENS`] puts a [`TRIM_ITEM`] row at the top of its
//!   `## Queue` ([`queue_trim`]), and the thread layer of every chat that
//!   opens on an over-cap file carries the method ([`trim_method`]): the
//!   practices Trim, for a thread — rows moved verbatim to `archive.md`
//!   with pointers, every row accounted for in `log.md`.
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
/// The Queue row an over-cap upkeep puts first (item 708).
pub const TRIM_ITEM: &str = "trim thread.md";
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
            let checks = check_text(&text, None);
            segment(ctx, Some(&body), &checks.flags(), checks.over_cap())
        }
        Err(_) => segment(ctx, None, &[], None),
    }
}

/// The layer around a chat's own text in place of the file's Start here.
/// The trim method still rides along when the file is over its cap: the
/// chat's own Start here does not shrink the file.
pub fn thread_segment_from(ctx: &ThreadContext, body: &str) -> Segment {
    let over = std::fs::read_to_string(ctx.dir.join(THREAD_FILE))
        .ok()
        .and_then(|t| check_text(&t, None).over_cap());
    segment(ctx, Some(body), &[], over)
}

/// How a chat trims an over-cap `thread.md` (item 708): the practices Trim
/// method (`~/.claude/practices/procedures.md` §Trim, item 524) for a
/// thread's rows. Carried by the thread layer of the next chat — never by
/// the wrap-up, where a tired session cuts what matters.
pub fn trim_method() -> String {
    format!(
        "How to trim {THREAD_FILE} (in a chat that has just started, before other work; one row \
         at a time, never by rewriting the file):\n\
         1. Measure: `wc -c {THREAD_FILE}` (tokens are about characters / 4). Aim for about 9k, \
         under the ~{cap}k cap.\n\
         2. Move rows in this order until it is under: (a) Queue rows that are done, superseded, \
         answered, merged or parked, and Claims that are struck, superseded or rejected, unless \
         Start here or a live or open Queue row cites them; (b) Claims from earlier rounds, \
         oldest id first, that neither Start here nor a live or open Queue row cites; (c) last \
         of all, the oldest \"## His view\" quotes, never the newest. Never move Start here, a \
         live or open Queue row, this round's claims or How to edit. A \"## His view\" quote \
         over the cap moves whole to {ARCHIVE_FILE}, never shortened in place.\n\
         3. Move, don't paraphrase: each row goes verbatim to {ARCHIVE_FILE} under one \"## trim \
         <date>\" heading, by section, under its table header, with the line it stood on. Under \
         each section's heading in {THREAD_FILE} leave one line, \"Moved <date> to \
         {ARCHIVE_FILE} (## trim <date>), verbatim: <ids>.\", so every id still resolves.\n\
         4. Account for every row: append a dated paragraph to {LOG_FILE} with the tokens \
         before and after, each moved id with its section, and the kept ids, none missing.\n\
         5. Mark the \"{TRIM_ITEM}\" Queue row done, with the date and the tokens after.\n\
         6. Check: copy {THREAD_FILE} before you start; at the end diff the copy against the \
         new {THREAD_FILE} and {ARCHIVE_FILE}. Every removed line must be in {ARCHIVE_FILE} \
         word for word (or be a row edited in place). Nightloom's next upkeep re-checks this \
         against the last .agents commit and archives anything missing.\n\
         7. Tell him what moved and where, one line each, in your reply.\n",
        cap = THREAD_CAP_TOKENS / 1000
    )
}

/// The file's Start here, for the Context page's *Edit for this chat*.
pub fn layer_source(ctx: &ThreadContext) -> Option<String> {
    let text = std::fs::read_to_string(ctx.dir.join(THREAD_FILE)).ok()?;
    start_here(&text)
}

/// `over`: the file's estimated tokens when past [`THREAD_CAP_TOKENS`].
fn segment(
    ctx: &ThreadContext,
    body: Option<&str>,
    flags: &[String],
    over: Option<u64>,
) -> Segment {
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
    if let Some(tokens) = over {
        // Only a chat that has just started trims (merge round T review,
        // 2026-11-17): the layer is rebuilt on every turn, so a chat hours
        // in — the wrapping one included — read "do that row before
        // anything else" too, which is the trim by a tired session item
        // 708 exists to stop.
        text.push_str(&format!(
            "\nTrim first: {THREAD_FILE} is ~{}k tokens, over its ~{}k cap, so Nightloom puts a \
             \"{TRIM_ITEM}\" row at the top of its Queue. If this chat has just started, do \
             that row before anything else. If it is already under way, do not trim in this \
             chat — a long session cuts what matters; the next chat does it first.\n",
            tokens / 1000,
            THREAD_CAP_TOKENS / 1000
        ));
        text.push_str(&trim_method());
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
        // ~~"{THREAD_FILE} is ~Nk tokens, over its ~10k cap. Nightloom archives struck
        // lines; look for detail that belongs in .agents/notes/ behind a pointer."~~ —
        // item 708 (2026-11-17): that flag reached the wrap-up, the worst moment to trim
        // (practices §2). Over the cap is now [`Checks::over_cap`]: a Queue row
        // ([`queue_trim`]) and the method in the next chat's layer ([`trim_method`]).
        out
    }

    /// The estimated tokens when `thread.md` is past [`THREAD_CAP_TOKENS`].
    pub fn over_cap(&self) -> Option<u64> {
        (self.tokens > THREAD_CAP_TOKENS).then_some(self.tokens)
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
    /// `thread.md` is still past [`THREAD_CAP_TOKENS`] after the moves.
    pub over_cap: bool,
    /// The id of the [`TRIM_ITEM`] row this run put at the top of the Queue
    /// (on a dry run, would put); `None` when none was needed or one waits.
    pub trim_queued: Option<String>,
    /// Item 909: non-blank lines the last `.agents` commit had in `thread.md`
    /// that are gone from it, are in no archive line and are not a row
    /// edited in place; each is (on apply) appended to `archive.md`.
    pub lost_lines: Vec<String>,
    /// The old `## Start here` was rewritten since the last commit and has
    /// been (on a dry run, would be) archived whole.
    pub start_here_archived: bool,
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

/// `thread.md` as the last commit of the repo holding `dir` (the `.agents`
/// git repo) had it; `None` without git, a repo or a committed copy.
fn committed_thread(dir: &Path) -> Option<String> {
    let rel = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["rev-parse", "--show-prefix"])
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    let prefix = String::from_utf8_lossy(&rel.stdout).trim().to_string();
    let spec = format!("HEAD:{prefix}{THREAD_FILE}");
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["show", &spec])
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    String::from_utf8(out.stdout).ok()
}

/// The first cell of a table row (its id), when the line is one.
fn row_id(line: &str) -> Option<String> {
    let c = cells(line)?;
    let id = c.first()?.trim().to_string();
    (!id.is_empty() && !id.chars().all(|ch| ch == '-' || ch == ':')).then_some(id)
}

/// Item 909, mechanical: the non-blank lines of `before` that `after` no
/// longer holds, minus those a line of `archive` repeats whole and those a
/// row of the same id still stands for (an edit in place). Counted as a
/// multiset, so a line that stood twice and now stands once is not lost.
pub fn lost_lines(before: &str, after: &str, archive: &str) -> Vec<String> {
    use std::collections::{HashMap, HashSet};
    let mut now: HashMap<&str, usize> = HashMap::new();
    for l in after.lines().filter(|l| !l.trim().is_empty()) {
        *now.entry(l.trim_end()).or_default() += 1;
    }
    let archived: HashSet<&str> = archive.lines().map(str::trim_end).collect();
    let ids: HashSet<String> = after.lines().filter_map(row_id).collect();
    let mut lost = Vec::new();
    for l in before.lines().filter(|l| !l.trim().is_empty()) {
        let key = l.trim_end();
        if let Some(n) = now.get_mut(key).filter(|n| **n > 0) {
            *n -= 1;
            continue;
        }
        if archived.contains(key) || row_id(key).is_some_and(|id| ids.contains(&id)) {
            continue;
        }
        lost.push(key.to_string());
    }
    lost
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
    // 3. Still over the cap: the trim goes first in the Queue, for the next
    // chat (item 708), never to the wrap-up.
    let out_tokens = nightloom_core::estimate_tokens(&out);
    up.over_cap = out_tokens > THREAD_CAP_TOKENS;
    let out = if up.over_cap {
        let (queued, id) = queue_trim(&out, today, out_tokens);
        up.trim_queued = id;
        queued
    } else {
        out
    };
    up.saved = text.len().saturating_sub(out.len());
    up.checks = check_text(&out, Some(&log));
    up.flags = up.checks.flags();

    // 4. The trim check (item 909): what the chat left in `thread.md`
    // against the last `.agents` commit and `archive.md`. The old Start here
    // is archived whole when rewritten (the one section a chat may rewrite);
    // any other removed line no archive line repeats is archived too.
    let apath = dir.join(ARCHIVE_FILE);
    let archive_now = std::fs::read_to_string(&apath).unwrap_or_default();
    let mut recover = String::new();
    if let Some(before) = committed_thread(dir) {
        let old_start = start_here(&before).filter(|o| {
            start_here(&text).as_deref() != Some(o.as_str()) && !archive_now.contains(o.as_str())
        });
        let mut skip = String::new();
        if let Some(old) = &old_start {
            up.start_here_archived = true;
            recover.push_str(&format!(
                "### old Start here (rewritten since the last commit), verbatim\n\n{old}\n\n"
            ));
            skip.push_str(old);
        }
        up.lost_lines = lost_lines(&before, &text, &format!("{archive_now}\n{skip}"));
        if !up.lost_lines.is_empty() {
            recover
                .push_str("### lines removed from thread.md and in no archive line, verbatim\n\n");
            for l in &up.lost_lines {
                recover.push_str(l);
                recover.push('\n');
            }
            recover.push('\n');
            for l in &up.lost_lines {
                up.flags.push(format!(
                    "A line left {THREAD_FILE} since the last commit and was in no archive line; \
                     Nightloom archived it (## upkeep run {}): {l}",
                    today.format("%Y-%m-%d")
                ));
            }
        }
    }

    if apply && (out != text || !recover.is_empty()) {
        if !entries.is_empty() || !recover.is_empty() {
            let mut archive = archive_now;
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
            if !entries.is_empty() {
                archive.push('\n');
            }
            archive.push_str(&recover);
            crate::tidy::write_whole(&apath, &archive)?;
        }
        if out != text {
            crate::tidy::write_whole(&path, &out)?;
        }
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

/// Put a [`TRIM_ITEM`] row at the top of `## Queue` (item 708), unless one
/// is already waiting there (not struck, not done). Its id is the Queue's
/// own pattern, max + 1 (`Q-34` → `Q-35`, `T-01` → `T-02`); its pointer
/// says Nightloom put it there and when. A thread with no Queue table is
/// left as it is — the layer still carries the method. Returns the text
/// and the new row's id.
pub fn queue_trim(text: &str, today: NaiveDate, tokens: u64) -> (String, Option<String>) {
    let view: Vec<&str> = text.split('\n').collect();
    let Some((a, b)) = section_range(&view, "Queue") else {
        return (text.to_string(), None);
    };
    let mut header: Option<usize> = None;
    let mut sep: Option<usize> = None;
    let mut best: Option<(String, u64, usize)> = None;
    // An id's prefix, number and width (`T-04` → `T-`, 4, 2).
    let parts = |id: &str| -> Option<(String, u64, usize)> {
        let id = id
            .trim()
            .trim_matches('~')
            .trim_end_matches(['.', ',', ';']);
        let cut = id.rfind('-')?;
        let (prefix, digits) = id.split_at(cut + 1);
        if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        Some((prefix.to_string(), digits.parse().ok()?, digits.len()))
    };
    for (i, line) in view.iter().enumerate().take(b).skip(a) {
        let Some(row) = cells(line) else {
            // The ids a trim moved to the archive still count (merge round T
            // review, 2026-11-17): the method leaves "Moved <date> to
            // archive.md (## trim <date>), verbatim: <ids>." under the
            // heading, and the first rows a trim moves are the done ones —
            // the last trim row among them, often the highest id. Without
            // this the next trim row took an archived row's id.
            if let Some((_, ids)) = line.split_once("verbatim:")
                && line.trim_start().starts_with("Moved ")
            {
                for id in ids.split(',') {
                    if let Some(p) = parts(id)
                        && best.as_ref().is_none_or(|(_, m, _)| p.1 > *m)
                    {
                        best = Some(p);
                    }
                }
            }
            continue;
        };
        if header.is_none() {
            header = Some(row.len());
            continue;
        }
        if sep.is_none() && row.iter().all(|c| c.chars().all(|ch| "-: ".contains(ch))) {
            sep = Some(i);
            continue;
        }
        let item = row.get(1).map(String::as_str).unwrap_or("");
        let status = row.get(2).map(String::as_str).unwrap_or("").to_lowercase();
        if item.to_lowercase().contains(TRIM_ITEM)
            && !item.contains("~~")
            && !item.contains("[struck")
            && !status.starts_with("done")
            && !status.starts_with("merged")
        {
            return (text.to_string(), None);
        }
        if let Some(p) = parts(&row[0])
            && best.as_ref().is_none_or(|(_, m, _)| p.1 > *m)
        {
            best = Some(p);
        }
    }
    let (Some(cols), Some(sep)) = (header, sep) else {
        return (text.to_string(), None);
    };
    let (prefix, n, width) = best.unwrap_or_else(|| ("Q-".to_string(), 0, 1));
    let id = format!("{prefix}{:0width$}", n + 1);
    let mut row = vec![String::new(); cols.max(3)];
    row[0] = id.clone();
    row[1] = format!(
        "{TRIM_ITEM}: ~{}k tokens, over its ~{}k cap. Do this first, by \"How to trim \
         {THREAD_FILE}\" in this chat's thread layer.",
        tokens / 1000,
        THREAD_CAP_TOKENS / 1000
    );
    row[2] = "live (front)".to_string();
    if cols >= 4 {
        let last = row.len() - 1;
        row[last] = format!("Nightloom upkeep {}", today.format("%Y-%m-%d"));
    }
    let mut lines: Vec<String> = view.iter().map(|l| l.to_string()).collect();
    lines.insert(sep + 1, format!("| {} |", row.join(" | ")));
    (lines.join("\n"), Some(id))
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
            // The over-cap trim still counts as one upkeep item for the
            // picker and the index; it is queued, not flagged (item 708).
            flags: checks.flags().len() + usize::from(checks.over_cap().is_some()),
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

/// The heading line a renamed thread gets, from the one it had: a
/// `# Thread: <old>` heading keeps its `Thread:`, a bare `# <old>` stays bare.
fn renamed_heading(old: &str, name: &str) -> String {
    if old.trim_start().starts_with("Thread:") {
        format!("# Thread: {name}")
    } else {
        format!("# {name}")
    }
}

/// Rename a thread (nightshift backlog 424): its title only — the first
/// `# ` heading of `thread.md`, the line [`list_threads`] reads the title
/// from (one is put first when it has none). The slug and folder stay, so
/// the chats bound to it still find it; nothing else in the file changes,
/// and its modified time is put back, so a rename never moves the thread
/// up the most-recently-touched order. The index is rewritten.
pub fn rename_thread(notes_dir: &Path, slug: &str, name: &str) -> Result<ThreadInfo, String> {
    let dir =
        thread_dir(notes_dir, slug).ok_or_else(|| format!("{slug:?} is not a thread name"))?;
    let file = dir.join(THREAD_FILE);
    let text = std::fs::read_to_string(&file).map_err(|_| format!("no thread {slug} here"))?;
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err("a thread needs a name".into());
    }
    let mut lines: Vec<String> = text.split('\n').map(String::from).collect();
    match lines.iter().position(|l| l.starts_with("# ")) {
        Some(i) => lines[i] = renamed_heading(&lines[i][2..], &name),
        None => {
            lines.insert(0, String::new());
            lines.insert(0, format!("# Thread: {name}"));
        }
    }
    let body = lines.join("\n");
    if body != text {
        let modified = std::fs::metadata(&file).and_then(|m| m.modified()).ok();
        crate::tidy::write_whole(&file, &body)?;
        if let Some(t) = modified {
            // Best-effort: a filesystem that refuses leaves the thread "touched now".
            let _ = std::fs::File::options()
                .write(true)
                .open(&file)
                .and_then(|f| f.set_modified(t));
        }
    }
    write_index(notes_dir)?;
    list_threads(notes_dir)
        .into_iter()
        .find(|t| t.slug == slug)
        .ok_or_else(|| format!("the thread {slug} was renamed but does not read back"))
}

/// The docspace's trash folder, `<workspace>/.agents/.trash`: hidden, so
/// neither the notes listing nor the thread listing reads what is in it,
/// and inside the project, so a delete is a rename on the same disk.
pub const TRASH_DIR: &str = ".trash";

/// Where a thread deleted at `when` (a local `YYYY-MM-DD-HHMMSS`) is kept:
/// `.agents/.trash/threads/<slug>-<when>`, with `-2`, `-3`, … when taken.
pub fn thread_trash_path(notes_dir: &Path, slug: &str, when: &str) -> PathBuf {
    let base = notes_dir.join(TRASH_DIR).join(THREADS_DIR);
    let mut n = 1;
    loop {
        let name = if n == 1 {
            format!("{slug}-{when}")
        } else {
            format!("{slug}-{when}-{n}")
        };
        let path = base.join(name);
        if !path.exists() {
            return path;
        }
        n += 1;
    }
}

/// Delete a thread (nightshift backlog 424): its whole folder moves to the
/// docspace's trash ([`thread_trash_path`]), never unlinked (the
/// never-lose-work rule), and the index is rewritten. The chats bound to it
/// are the shell's to unbind, before this runs; their logs are not touched
/// here. Returns where the folder went.
pub fn trash_thread(notes_dir: &Path, slug: &str, when: &str) -> Result<PathBuf, String> {
    let dir =
        thread_dir(notes_dir, slug).ok_or_else(|| format!("{slug:?} is not a thread name"))?;
    if !dir.is_dir() {
        return Err(format!("no thread {slug} here"));
    }
    let to = thread_trash_path(notes_dir, slug, when);
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    std::fs::rename(&dir, &to).map_err(|e| {
        format!(
            "could not move the thread {slug} to {}, so it was not deleted: {e}",
            to.display()
        )
    })?;
    write_index(notes_dir)?;
    Ok(to)
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

    /// The fixture past the cap: padding in Claims, after the Queue.
    fn over_cap_fixture() -> String {
        FIXTURE.replace(
            "## His view",
            &format!(
                "| C-07 | {} | inferred | live | ev 5 |\n\n## His view",
                "pad ".repeat(11000)
            ),
        )
    }

    fn queue_rows(text: &str) -> Vec<String> {
        let lines: Vec<&str> = text.split('\n').collect();
        let (a, b) = section_range(&lines, "Queue").unwrap();
        lines[a..b]
            .iter()
            .filter(|l| l.starts_with("| ") && !l.starts_with("| id"))
            .map(|l| l.to_string())
            .collect()
    }

    #[test]
    fn a_trim_row_never_takes_the_id_of_a_row_a_trim_archived() {
        // Merge round T review (2026-11-17): the trim method moves done
        // Queue rows to archive.md and leaves their ids on a "Moved …
        // verbatim:" line. The next trim row's id counts those, and a
        // struck id cell, so no id is ever given twice.
        let q = "## Queue\nMoved 2026-11-17 to archive.md (## trim 2026-11-17), verbatim: T-02, T-09, T-04.\n\n\
                 | id | Item | Status | Pointer |\n|---|---|---|---|\n\
                 | T-01 | the question | live | ev 1 |\n| T-03 | another | open | ev 2 |\n\n## Claims\n";
        let (out, id) = queue_trim(q, day("2026-11-20"), 12_000);
        assert_eq!(id.as_deref(), Some("T-10"), "past the archived T-09: {out}");
        assert!(out.contains("|---|---|---|---|\n| T-10 | trim thread.md: ~12k tokens"));
        // A struck id cell counts too.
        let q = "## Queue\n| id | Item | Status | Pointer |\n|---|---|---|---|\n\
                 | Q-1 | the question | live | ev 1 |\n| ~~Q-7~~ | ~~old~~ (struck 2026-11-01: dropped) | struck | ev 2 |\n";
        let (_, id) = queue_trim(q, day("2026-11-20"), 12_000);
        assert_eq!(id.as_deref(), Some("Q-8"));
        // Through the upkeep, on files: done trim row archived by the trim,
        // file over the cap again.
        let tmp = scratch();
        let dir = tmp.as_path().join("again");
        let thread = over_cap_fixture().replace(
            "## Queue\n",
            "## Queue\nMoved 2026-10-05 to archive.md (## trim 2026-10-05), verbatim: T-04.\n\n",
        );
        write_fixture(&dir, &thread, "2026-10-01\n");
        let up = upkeep(&dir, day("2026-10-06"), true).unwrap();
        assert_eq!(up.trim_queued.as_deref(), Some("T-05"), "not T-04 again");
    }

    #[test]
    fn an_over_cap_thread_gets_the_trim_first_in_its_queue_once_and_never_a_wrap_up_flag() {
        // Item 708: at Continue (the wrap-up's hand-over) the shell applies
        // the upkeep; over the cap it queues the trim, it does not flag it.
        let tmp = scratch();
        let dir = tmp.as_path().join("big");
        write_fixture(&dir, &over_cap_fixture(), "2026-10-01\n");
        let dry = upkeep(&dir, day("2026-10-02"), false).unwrap();
        assert!(dry.over_cap);
        assert_eq!(dry.trim_queued.as_deref(), Some("T-04"), "max id + 1");
        assert_eq!(
            std::fs::read_to_string(dir.join(THREAD_FILE)).unwrap(),
            over_cap_fixture(),
            "a dry run writes nothing"
        );
        assert!(
            dry.flags.iter().all(|f| !f.contains("cap")),
            "the wrap-up is never asked to trim: {:?}",
            dry.flags
        );

        let up = upkeep(&dir, day("2026-10-02"), true).unwrap();
        assert_eq!(up.trim_queued.as_deref(), Some("T-04"));
        let live = std::fs::read_to_string(dir.join(THREAD_FILE)).unwrap();
        let rows = queue_rows(&live);
        assert!(
            rows[0].starts_with("| T-04 | trim thread.md: ~")
                && rows[0].contains("over its ~10k cap")
                && rows[0].contains("How to trim thread.md")
                && rows[0].ends_with("| live (front) | Nightloom upkeep 2026-10-02 |"),
            "first in the Queue: {rows:?}"
        );
        assert_eq!(rows.len(), 4, "the three rows kept below it: {rows:?}");

        // Idempotent: a waiting trim row is not queued again (the daily pass
        // and the next Continue both run).
        let again = upkeep(&dir, day("2026-10-03"), true).unwrap();
        assert!(again.over_cap && again.trim_queued.is_none(), "{again:?}");
        let live = std::fs::read_to_string(dir.join(THREAD_FILE)).unwrap();
        assert_eq!(live.matches("| trim thread.md").count(), 1, "{live}");

        // Marked done but still over: a new row, the next id.
        let done = live.replacen(
            "| live (front) | Nightloom upkeep",
            "| done 2026-10-03: ~9k | Nightloom upkeep",
            1,
        );
        std::fs::write(dir.join(THREAD_FILE), &done).unwrap();
        let next = upkeep(&dir, day("2026-10-04"), true).unwrap();
        assert_eq!(next.trim_queued.as_deref(), Some("T-05"));

        // Under the cap: no row.
        let small = tmp.as_path().join("small");
        write_fixture(&small, FIXTURE, "2026-10-01\n");
        let up = upkeep(&small, day("2026-10-02"), true).unwrap();
        assert!(!up.over_cap && up.trim_queued.is_none());
        assert!(
            !std::fs::read_to_string(small.join(THREAD_FILE))
                .unwrap()
                .contains(TRIM_ITEM)
        );

        // No Queue table: nothing inserted (the layer still carries the method).
        let (same, id) = queue_trim("## Start here\nx\n", day("2026-10-02"), 20_000);
        assert_eq!((same.as_str(), id), ("## Start here\nx\n", None));
        // An empty Queue table starts at Q-1.
        let empty = "## Queue\n| id | Item | Status | Pointer |\n|---|---|---|---|\n\n## Claims\n";
        let (out, id) = queue_trim(empty, day("2026-10-02"), 12_000);
        assert_eq!(id.as_deref(), Some("Q-1"));
        assert!(
            out.contains("|---|---|---|---|\n| Q-1 | trim thread.md: ~12k tokens"),
            "{out}"
        );
    }

    #[test]
    fn the_layer_of_an_over_cap_thread_carries_the_trim_method_first() {
        let tmp = scratch();
        let notes = tmp.as_path().join(".agents");
        let ctx = ThreadContext::new(&notes, "big").unwrap();
        write_fixture(&ctx.dir, &over_cap_fixture(), "");
        let seg = thread_segment(&ctx);
        assert!(
            seg.text.contains("Trim first: thread.md is ~"),
            "{}",
            seg.text
        );
        // Only a chat that has just started is told to trim: the layer
        // rides every turn, the wrapping chat's included.
        assert!(
            seg.text
                .contains("If this chat has just started, do that row before anything else.")
        );
        assert!(
            seg.text
                .contains("If it is already under way, do not trim in this chat")
        );
        assert!(seg.text.contains("How to trim thread.md"));
        assert!(seg.text.contains("verbatim to archive.md"));
        assert!(seg.text.contains("Account for every row"));
        assert!(
            seg.text.contains("6. Check: copy thread.md"),
            "{}",
            seg.text
        );
        assert!(seg.text.contains("7. Tell him what moved and where"));
        assert!(
            seg.text
                .contains("moves whole to archive.md, never shortened in place")
        );
        assert!(
            seg.text.find("Trim first").unwrap() < seg.text.rfind("\n## Start here\n").unwrap(),
            "before Start here"
        );
        // The chat's own Start here does not drop it; the file is still big.
        assert!(
            thread_segment_from(&ctx, "mine")
                .text
                .contains("How to trim thread.md")
        );
        // Under the cap: no method.
        let small = ThreadContext::new(&notes, "small").unwrap();
        write_fixture(&small.dir, FIXTURE, "");
        assert!(!thread_segment(&small).text.contains("How to trim"));
        // The picker and index still count it as one upkeep item.
        let infos = list_threads(&notes);
        let big = infos.iter().find(|t| t.slug == "big").unwrap();
        let checks = check_text(&over_cap_fixture(), None);
        assert_eq!(big.flags, checks.flags().len() + 1);
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

    // ---- item 909: the mechanical trim check ----

    fn git(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args([
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "-c",
                "commit.gpgsign=false",
            ])
            .args(args)
            .output()
            .unwrap()
            .status
            .success();
        assert!(ok, "git {args:?}");
    }

    /// A docspace repo (`.agents`) with `thread.md` committed as `before`,
    /// then `after` (and `archive`) left in the working tree.
    fn committed_fixture(before: &str, after: &str, archive: Option<&str>) -> (PathBuf, PathBuf) {
        let tmp = scratch();
        let agents = tmp.join(".agents");
        let dir = agents.join("threads").join("fx");
        write_fixture(&dir, before, "2026-10-01\n");
        git(&agents, &["init", "-q"]);
        git(&agents, &["add", "-A"]);
        git(&agents, &["commit", "-q", "-m", "snapshot"]);
        std::fs::write(dir.join(THREAD_FILE), after).unwrap();
        if let Some(a) = archive {
            std::fs::write(dir.join(ARCHIVE_FILE), a).unwrap();
        }
        (tmp, dir)
    }

    const BEFORE: &str = "# Thread: Fixture

## Start here
Old status line one.
Old status line two.

## Queue
| id | Item | Status | Pointer |
|---|---|---|---|
| T-01 | first | live | ev 1 |
| T-02 | second | done | ev 2 |
| T-03 | third | done | ev 3 |

## His view
- \"One. Two. Three. Four. Five.\" (`ev 1 ¶1`)
";

    #[test]
    fn the_check_finds_lost_lines_by_multiset_archive_and_row_id() {
        let after = "# Thread: Fixture\n\n## Start here\nOld status line one.\n\n## Queue\n\
                     | T-01 | first | done 2026-10-02 | ev 1 |\n";
        let archive = "| T-02 | second | done | ev 2 |\n";
        let lost = lost_lines(BEFORE, after, archive);
        // T-01 edited in place and T-02 archived: fine. The rest is lost.
        assert!(
            lost.contains(&"| T-03 | third | done | ev 3 |".to_string()),
            "{lost:?}"
        );
        assert!(lost.contains(&"Old status line two.".to_string()));
        assert!(lost.iter().any(|l| l.contains("Four. Five.")));
        assert!(
            !lost
                .iter()
                .any(|l| l.contains("T-01") || l.contains("T-02")),
            "{lost:?}"
        );
        // A line that stood twice and still stands once is a loss of one.
        assert_eq!(lost_lines("a\na\n", "a\n", "").len(), 1);
        assert!(lost_lines("a\na\n", "a\na\n", "").is_empty());
        // Nothing changed: nothing lost.
        assert!(lost_lines(BEFORE, BEFORE, "").is_empty());
    }

    #[test]
    fn upkeep_archives_a_rewritten_start_here_and_a_shortened_quote_and_only_once() {
        let after = BEFORE
            .replace("Old status line one.\nOld status line two.", "New status.")
            .replace("One. Two. Three. Four. Five.", "One. Two. Three.");
        let (tmp, dir) = committed_fixture(BEFORE, &after, None);

        let dry = upkeep(&dir, day("2026-10-02"), false).unwrap();
        assert!(dry.start_here_archived, "{dry:?}");
        // The two old Start here lines ride in the whole-section entry; the quote is the one lost line.
        assert_eq!(dry.lost_lines.len(), 1, "{:?}", dry.lost_lines);
        assert!(
            dry.flags.iter().any(|f| f.contains("Four. Five.")),
            "{:?}",
            dry.flags
        );
        assert!(!dir.join(ARCHIVE_FILE).exists(), "a dry run writes nothing");
        assert_eq!(
            std::fs::read_to_string(dir.join(THREAD_FILE)).unwrap(),
            after
        );

        let up = upkeep(&dir, day("2026-10-02"), true).unwrap();
        assert!(up.start_here_archived);
        let archive = std::fs::read_to_string(dir.join(ARCHIVE_FILE)).unwrap();
        assert!(archive.contains("## upkeep run 2026-10-02"), "{archive}");
        assert!(
            archive.contains("Old status line one.\nOld status line two."),
            "whole: {archive}"
        );
        assert!(
            archive.contains("- \"One. Two. Three. Four. Five.\" (`ev 1 ¶1`)"),
            "{archive}"
        );
        // The live file is untouched by the check.
        assert_eq!(
            std::fs::read_to_string(dir.join(THREAD_FILE)).unwrap(),
            after
        );

        // Run again against the same commit: already archived, nothing added.
        let again = upkeep(&dir, day("2026-10-03"), true).unwrap();
        assert!(!again.start_here_archived, "{again:?}");
        assert!(again.lost_lines.is_empty(), "{:?}", again.lost_lines);
        assert_eq!(
            std::fs::read_to_string(dir.join(ARCHIVE_FILE)).unwrap(),
            archive
        );
        drop(tmp);
    }

    #[test]
    fn a_clean_trim_with_everything_archived_flags_nothing() {
        // The chat moved T-02 and T-03 verbatim and left Start here alone.
        let after = BEFORE
            .replace("| T-02 | second | done | ev 2 |\n", "")
            .replace("| T-03 | third | done | ev 3 |\n", "");
        let archive =
            "## trim 2026-10-02\n| T-02 | second | done | ev 2 |\n| T-03 | third | done | ev 3 |\n";
        let (tmp, dir) = committed_fixture(BEFORE, &after, Some(archive));
        let up = upkeep(&dir, day("2026-10-02"), true).unwrap();
        assert!(up.lost_lines.is_empty(), "{:?}", up.lost_lines);
        assert!(!up.start_here_archived);
        assert_eq!(
            std::fs::read_to_string(dir.join(ARCHIVE_FILE)).unwrap(),
            archive
        );
        drop(tmp);
    }

    #[test]
    fn no_repo_or_no_commit_means_no_check() {
        let tmp = scratch();
        let dir = tmp.as_path().join("fx");
        write_fixture(&dir, FIXTURE, "# Log\n");
        let up = upkeep(&dir, day("2026-10-02"), false).unwrap();
        assert!(up.lost_lines.is_empty() && !up.start_here_archived);
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

    #[test]
    fn a_rename_changes_the_title_line_only_and_keeps_the_folder_and_its_time() {
        let tmp = scratch();
        let notes = tmp.join(".agents");
        create_thread(&notes, "alpha", "Alpha").unwrap();
        let file = notes.join("threads/alpha/thread.md");
        let before = std::fs::read_to_string(&file).unwrap();
        let old = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        std::fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(old)
            .unwrap();
        let t = rename_thread(&notes, "alpha", "  The  cut\nworks ").unwrap();
        assert_eq!(t.slug, "alpha");
        assert_eq!(t.title, "The cut works");
        let after = std::fs::read_to_string(&file).unwrap();
        assert!(after.starts_with("# Thread: The cut works\n"), "{after}");
        assert_eq!(
            after.split_once('\n').unwrap().1,
            before.split_once('\n').unwrap().1,
            "nothing below the heading changes"
        );
        assert_eq!(
            std::fs::metadata(&file).unwrap().modified().unwrap(),
            old,
            "a rename never moves it up the touched order"
        );
        let index = std::fs::read_to_string(notes.join("threads/INDEX.md")).unwrap();
        assert!(index.contains("| `alpha` — The cut works |"), "{index}");
        // A bare heading stays bare; no heading gets one.
        std::fs::write(&file, "# Plain\n\nbody\n").unwrap();
        rename_thread(&notes, "alpha", "Renamed").unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "# Renamed\n\nbody\n"
        );
        std::fs::write(&file, "## Start here\nx\n").unwrap();
        rename_thread(&notes, "alpha", "Headed").unwrap();
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "# Thread: Headed\n\n## Start here\nx\n"
        );
        assert!(rename_thread(&notes, "alpha", "   ").is_err());
        assert!(rename_thread(&notes, "nope", "x").is_err());
        assert!(rename_thread(&notes, "../alpha", "x").is_err());
    }

    #[test]
    fn a_delete_moves_the_folder_to_the_trash_whole() {
        let tmp = scratch();
        let notes = tmp.join(".agents");
        create_thread(&notes, "alpha", "Alpha").unwrap();
        create_thread(&notes, "beta", "Beta").unwrap();
        std::fs::write(notes.join("threads/alpha/archive.md"), "kept\n").unwrap();
        let to = trash_thread(&notes, "alpha", "2026-10-27-101500").unwrap();
        assert_eq!(to, notes.join(".trash/threads/alpha-2026-10-27-101500"));
        assert!(!notes.join("threads/alpha").exists());
        assert_eq!(
            std::fs::read_to_string(to.join("archive.md")).unwrap(),
            "kept\n"
        );
        assert!(to.join("thread.md").is_file() && to.join("log.md").is_file());
        let slugs: Vec<_> = list_threads(&notes).into_iter().map(|t| t.slug).collect();
        assert_eq!(slugs, ["beta"]);
        let index = std::fs::read_to_string(notes.join("threads/INDEX.md")).unwrap();
        assert!(!index.contains("`alpha`"), "{index}");
        // The same slug deleted again in the same second is kept beside it.
        create_thread(&notes, "alpha", "Alpha again").unwrap();
        let again = trash_thread(&notes, "alpha", "2026-10-27-101500").unwrap();
        assert_eq!(
            again,
            notes.join(".trash/threads/alpha-2026-10-27-101500-2")
        );
        assert!(
            to.join("archive.md").is_file(),
            "the first copy is untouched"
        );
        assert!(trash_thread(&notes, "alpha", "x").is_err(), "gone already");
        assert!(trash_thread(&notes, "../beta", "x").is_err());
        assert!(notes.join("threads/beta/thread.md").is_file());
    }
}
