//! The tidy step (2026-09-16, nightshift backlog 072, blocker 091's default):
//! a struck-through line older than a month moves out of the live note.
//!
//! The dream supersedes by strikethrough-with-date rather than erasing —
//! what the user believed in March is still information — and the cost of
//! that is paid on every read: a note amended ten times is mostly history
//! by the time anyone opens it. So a `~~struck~~` span whose date is older
//! than `days` moves, verbatim, to `archive/struck/<same relative path>.md`
//! with a short pointer left where it stood:
//!
//! ```text
//! [struck 2026-08-10 -> archive/struck/topic.md]
//! ```
//!
//! Nothing is deleted, nothing younger moves, and a strike **without a
//! date** never moves — the pass is asked to date every strike, and one
//! without a date is a finding, not a tidy candidate. `[[links]]` inside a
//! moved span go with it unchanged.
//!
//! This is the Rust twin of Nightshift's `bin/tidy_struck.py`, same rules
//! and the same fixture in its tests, so the two stores age alike. A span
//! is `~~` to the next `~~` (three tildes are a code fence, never a
//! strike), may run across lines but not across a blank one, and its date
//! is the *latest* `YYYY-MM-DD` on the lines it touches — the date beside a
//! strike is the supersession's, and a line may also carry the older date
//! of the claim it struck. Fenced code is skipped whole. The daily pass
//! (backlog 069) runs this last, on every folder it dreamed into.

use chrono::NaiveDate;
use regex::Regex;
use serde::Serialize;
use std::path::Path;
use std::sync::OnceLock;

/// Where moved spans go, under the tidied folder.
pub const ARCHIVE_DIR: &str = "archive/struck";
/// The default age.
pub const DEFAULT_DAYS: i64 = 30;

/// One struck span: 0-based line range, character offsets on its first and
/// last line, its text, its date, and its age.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Span {
    pub start_line: usize,
    pub start_col: usize,
    pub end_line: usize,
    pub end_col: usize,
    pub text: String,
    pub date: Option<NaiveDate>,
    pub age: Option<i64>,
    /// A blank line (or the file's end) closed it: left alone, listed.
    pub unterminated: bool,
}

impl Span {
    pub fn movable(&self, days: i64) -> bool {
        !self.unterminated && self.age.is_some_and(|a| a > days)
    }
}

fn date_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\b(20\d{2}-\d{2}-\d{2})\b").unwrap())
}

/// Every `~~` on a line that is exactly two tildes — not part of a `~~~`
/// fence or longer run — as byte offsets of the marker's start. The
/// Python's lookbehind and lookahead, by hand.
fn markers(line: &str) -> Vec<usize> {
    let b = line.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < b.len() {
        let two = b[i] == b'~' && b[i + 1] == b'~';
        let before = i == 0 || b[i - 1] != b'~';
        let after = i + 2 >= b.len() || b[i + 2] != b'~';
        if two && before && after {
            out.push(i);
            i += 2;
        } else {
            i += 1;
        }
    }
    out
}

/// Walk the lines once. `~~` toggles; a blank line closes an open span as
/// unterminated; fenced code blocks are skipped whole.
pub fn find_spans(lines: &[&str], today: NaiveDate) -> Vec<Span> {
    let mut spans = Vec::new();
    let mut open_at: Option<(usize, usize)> = None;
    let mut in_fence = false;
    let unterminated = |sl: usize, sc: usize, el: usize, ec: usize| Span {
        start_line: sl,
        start_col: sc,
        end_line: el,
        end_col: ec,
        text: String::new(),
        date: None,
        age: None,
        unterminated: true,
    };
    for (i, line) in lines.iter().enumerate() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        if let Some((sl, sc)) = open_at
            && line.trim().is_empty()
        {
            spans.push(unterminated(
                sl,
                sc,
                i.saturating_sub(1),
                lines[i.saturating_sub(1)].len(),
            ));
            open_at = None;
        }
        for start in markers(line) {
            match open_at {
                None => open_at = Some((i, start)),
                Some((sl, sc)) => {
                    let (el, ec) = (i, start + 2);
                    let text = if sl == el {
                        line[sc..ec].to_string()
                    } else {
                        let mut parts = vec![lines[sl][sc..].to_string()];
                        parts.extend(lines[sl + 1..el].iter().map(|s| s.to_string()));
                        parts.push(line[..ec].to_string());
                        parts.join("\n")
                    };
                    let touched = lines[sl..=el].join("\n");
                    let date = date_re()
                        .captures_iter(&touched)
                        .filter_map(|c| NaiveDate::parse_from_str(&c[1], "%Y-%m-%d").ok())
                        .max();
                    spans.push(Span {
                        start_line: sl,
                        start_col: sc,
                        end_line: el,
                        end_col: ec,
                        text,
                        date,
                        age: date.map(|d| (today - d).num_days()),
                        unterminated: false,
                    });
                    open_at = None;
                }
            }
        }
    }
    if let Some((sl, sc)) = open_at {
        let last = lines.len().saturating_sub(1);
        spans.push(unterminated(
            sl,
            sc,
            last,
            lines.get(last).map_or(0, |l| l.len()),
        ));
    }
    spans
}

fn pointer(date: NaiveDate, rel: &str) -> String {
    format!(
        "[struck {} -> {ARCHIVE_DIR}/{rel}]",
        date.format("%Y-%m-%d")
    )
}

/// What a tidy of one folder found and (with `apply`) did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct TidyReport {
    pub files: usize,
    pub spans: usize,
    /// Old enough to move — and moved, when `apply` was set.
    pub movable: usize,
    pub undated: usize,
    pub unterminated: usize,
    pub young: usize,
    /// Bytes the live files shed (or would shed).
    pub saved: usize,
    /// Root-relative paths of the files with a movable span.
    pub touched: Vec<String>,
}

/// Rewrite one file with its movable spans replaced by pointers and append
/// the spans to its archive file. Bottom-up, so earlier offsets stay valid.
/// Returns the bytes saved.
fn apply_file(
    root: &Path,
    rel: &str,
    text: &str,
    spans: &[Span],
    days: i64,
    today: NaiveDate,
) -> Result<usize, String> {
    let mut lines: Vec<String> = text.split('\n').map(String::from).collect();
    let mut todo: Vec<&Span> = spans.iter().filter(|s| s.movable(days)).collect();
    if todo.is_empty() {
        return Ok(0);
    }
    todo.sort_by_key(|s| std::cmp::Reverse((s.start_line, s.start_col)));
    let mut entries = Vec::new();
    for s in &todo {
        let date = s.date.expect("a movable span is dated");
        entries.push(format!(
            "### line {}, struck {}\n\n{}\n",
            s.start_line + 1,
            date.format("%Y-%m-%d"),
            s.text
        ));
        let head = lines[s.start_line][..s.start_col].to_string();
        let tail = lines[s.end_line][s.end_col..].to_string();
        let joined = format!("{head}{}{tail}", pointer(date, rel));
        lines.splice(s.start_line..=s.end_line, std::iter::once(joined));
    }
    let apath = root.join(ARCHIVE_DIR).join(rel);
    if let Some(parent) = apath.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    }
    let mut archive = std::fs::read_to_string(&apath).unwrap_or_default();
    if archive.is_empty() {
        archive.push_str(&format!(
            "# Struck lines archived from `{rel}`\n\nMoved by the tidy step (nightshift backlog 072). \
             Each entry is the struck span verbatim, with the line it stood on at the time it \
             moved. Nothing here is deleted; a `[struck DATE -> ...]` pointer marks the spot in \
             the live file.\n\n"
        ));
    }
    archive.push_str(&format!("## tidy run {}\n\n", today.format("%Y-%m-%d")));
    for e in entries.iter().rev() {
        archive.push_str(e);
        archive.push('\n');
    }
    write_whole(&apath, &archive)?;
    let out = lines.join("\n");
    write_whole(&root.join(rel), &out)?;
    Ok(text.len().saturating_sub(out.len()))
}

/// Replace `path` whole: a process-named temp file beside it, then a
/// rename. A plain `fs::write` truncates before it writes, and a quit in
/// between leaves an empty note — or an empty archive, which is the only
/// copy of every span an earlier run moved.
fn write_whole(path: &Path, body: &str) -> Result<(), String> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = path.with_file_name(format!("{name}.{}.tmp", std::process::id()));
    std::fs::write(&tmp, body).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        std::fs::remove_file(&tmp).ok();
        format!("{}: {e}", path.display())
    })
}

/// Every `.md` under `root`, root-relative with forward slashes, the
/// archive and `.git` left out — the archive holds struck spans by
/// construction and must never be tidied into itself.
fn walk(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    for entry in walkdir::WalkDir::new(root)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy();
            !(name == ".git" || (e.depth() == 1 && name == "archive"))
        })
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(root) else {
            continue;
        };
        let rel = rel.to_string_lossy().replace('\\', "/");
        if rel.ends_with(".md") {
            out.push(rel);
        }
    }
    out
}

/// Tidy one folder: a dry run when `apply` is false (the report says what
/// would move), a move when true. A file that will not read is skipped,
/// not fatal — the tidy is the last step of a pass whose work is already
/// on disk.
pub fn tidy_dir(root: &Path, days: i64, today: NaiveDate, apply: bool) -> TidyReport {
    let mut report = TidyReport::default();
    for rel in walk(root) {
        let path = root.join(&rel);
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let lines: Vec<&str> = text.split('\n').collect();
        let spans = find_spans(&lines, today);
        report.files += 1;
        if spans.is_empty() {
            continue;
        }
        let mut movable = 0;
        for s in &spans {
            report.spans += 1;
            if s.unterminated {
                report.unterminated += 1;
            } else if s.date.is_none() {
                report.undated += 1;
            } else if s.movable(days) {
                movable += 1;
                report.saved += s
                    .text
                    .len()
                    .saturating_sub(pointer(s.date.unwrap(), &rel).len());
            } else {
                report.young += 1;
            }
        }
        if movable == 0 {
            continue;
        }
        report.movable += movable;
        report.touched.push(rel.clone());
        if apply {
            match apply_file(root, &rel, &text, &spans, days, today) {
                Ok(_) => {}
                Err(e) => {
                    // Counted as found, not as moved; the next pass sees it again.
                    report.movable -= movable;
                    report.touched.pop();
                    eprintln!("tidy: {e}");
                }
            }
        }
    }
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Python script's fixture, verbatim.
    const FIXTURE: &str = "# Fixture

Live line before. ~~old claim, struck 2026-07-01~~ **SUPERSEDED 2026-07-01: new claim.**

Undated: ~~this was never dated~~ and stays.

| col | value |
|---|---|
| a | ~~old cell 2026-07-02~~ new cell |

- list item ~~struck [[link-target]] 2026-07-03~~ kept text
- young item ~~struck yesterday~~ 2099-01-01

~~a paragraph that runs
across two lines, 2026-07-04~~ **SUPERSEDED.**

```
~~inside a code fence, not a strike~~
```

~~unterminated because a blank line follows

end.
";

    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 9, 16).unwrap()
    }

    fn scratch() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nightloom-tidy-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(dir.join("notes")).unwrap();
        dir
    }

    #[test]
    fn classifies_the_fixture_as_the_python_does() {
        let lines: Vec<&str> = FIXTURE.split('\n').collect();
        let spans = find_spans(&lines, today());
        let kinds: Vec<&str> = spans
            .iter()
            .map(|s| {
                if s.unterminated {
                    "unterminated"
                } else if s.date.is_none() {
                    "undated"
                } else if s.movable(30) {
                    "movable"
                } else {
                    "young"
                }
            })
            .collect();
        assert_eq!(
            kinds,
            [
                "movable",
                "undated",
                "movable",
                "movable",
                "young",
                "movable",
                "unterminated"
            ]
        );
    }

    #[test]
    fn apply_moves_the_dated_old_spans_and_nothing_else_then_is_idempotent() {
        let dir = scratch();
        std::fs::write(dir.join("notes/f.md"), FIXTURE).unwrap();
        let dry = tidy_dir(&dir, 30, today(), false);
        assert_eq!(
            (dry.movable, dry.undated, dry.unterminated, dry.young),
            (4, 1, 1, 1)
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("notes/f.md")).unwrap(),
            FIXTURE
        );

        let r = tidy_dir(&dir, 30, today(), true);
        assert_eq!(r.movable, 4);
        assert_eq!(r.touched, ["notes/f.md"]);
        let after = std::fs::read_to_string(dir.join("notes/f.md")).unwrap();
        let p = |d: &str| format!("[struck {d} -> archive/struck/notes/f.md]");
        assert!(
            !after.contains("old claim") && after.contains(&p("2026-07-01")),
            "{after}"
        );
        assert!(after.contains("**SUPERSEDED 2026-07-01: new claim.**"));
        assert!(after.contains("~~this was never dated~~"));
        assert!(
            after.contains(&format!("| a | {} new cell |", p("2026-07-02"))),
            "{after}"
        );
        assert!(
            after.contains(&format!("- list item {} kept text", p("2026-07-03"))),
            "{after}"
        );
        assert!(after.contains("~~struck yesterday~~"));
        assert!(
            !after.contains("across two lines")
                && after.contains(&format!("{} **SUPERSEDED.**", p("2026-07-04"))),
            "{after}"
        );
        assert!(after.contains("~~inside a code fence, not a strike~~"));
        assert!(after.contains("~~unterminated because"));

        let arch = std::fs::read_to_string(dir.join("archive/struck/notes/f.md")).unwrap();
        assert!(arch.contains("~~old claim, struck 2026-07-01~~"));
        assert!(arch.contains("[[link-target]]"));
        assert!(arch.contains("~~a paragraph that runs\nacross two lines, 2026-07-04~~"));

        let again = tidy_dir(&dir, 30, today(), true);
        assert_eq!(again.movable, 0);
        // The archive itself is never walked.
        assert!(!again.touched.iter().any(|t| t.starts_with("archive/")));
        // Written through a rename: no temp file beside either file.
        let tmps: Vec<_> = walkdir::WalkDir::new(&dir)
            .into_iter()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(tmps.is_empty(), "{tmps:?}");
    }

    #[test]
    fn three_tildes_are_never_a_strike() {
        let lines = ["~~~ 2026-01-01", "text", "~~~"];
        assert!(find_spans(&lines, today()).is_empty());
    }
}
