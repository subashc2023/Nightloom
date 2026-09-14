//! Blockers — `blockers/<id>-<slug>.md`, one per file (§5), so the GUI's
//! answer write and the runner's new-blocker write never touch the same
//! file. The runner creates them and never edits one after (its one
//! exception is the `follow_up` key, §13.6). The GUI writes `## Answer` and
//! `status`, and nothing else.

use super::frontmatter::{self, section};
use super::items::{Section, fields_map, id_files, parse_sections};
use super::{launch, read_text, write_atomic};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
pub struct Blocker {
    pub id: String,
    pub file: String,
    pub path: PathBuf,
    /// `open | answered | withdrawn | applied`.
    pub status: String,
    pub raised: String,
    /// The shift that raised it; empty for one raised by a human-facing
    /// instance or migrated from before the contract.
    pub shift: String,
    pub item: String,
    /// The follow-up item the runner created from the answer (§13.6).
    pub follow_up: Option<String>,
    pub question: String,
    /// `## What I would have done, and why`.
    pub guess: String,
    /// `## What it blocks`.
    pub blocks: String,
    pub answer: String,
    /// `## Where the guess lives` — build blockers name the path(s) (§13.3).
    pub where_guess_lives: String,
    pub fields: BTreeMap<String, String>,
    pub sections: Vec<Section>,
}

pub fn blocker_files(root: &Path) -> BTreeMap<String, PathBuf> {
    id_files(&root.join("blockers"))
}

/// Every blocker, open first, then by id. One unreadable file is reported
/// in `errors` and costs that row.
pub fn list_blockers(root: &Path) -> (Vec<Blocker>, Vec<String>) {
    let mut out = Vec::new();
    let mut errors = Vec::new();
    for (id, path) in blocker_files(root) {
        match read_at(&path, &id) {
            Ok(b) => out.push(b),
            Err(e) => errors.push(e),
        }
    }
    out.sort_by_key(|b| (b.status != "open", b.id.clone()));
    (out, errors)
}

pub fn read_blocker(root: &Path, id: &str) -> Result<Blocker, String> {
    let files = blocker_files(root);
    let path = files
        .get(id)
        .ok_or_else(|| format!("no blocker with id {id}"))?;
    read_at(path, id)
}

fn read_at(path: &Path, id: &str) -> Result<Blocker, String> {
    let text = read_text(path)?;
    let s = frontmatter::split(&text);
    let (_, sections) = parse_sections(&s.body);
    let body = &s.body;
    Ok(Blocker {
        id: id.to_string(),
        file: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: path.to_path_buf(),
        status: s.get("status").unwrap_or("").to_string(),
        raised: s.get("raised").unwrap_or("").to_string(),
        shift: s.get("shift").unwrap_or("").to_string(),
        item: s.get("item").unwrap_or("").to_string(),
        follow_up: s.get_nonempty("follow_up").map(str::to_string),
        question: section(body, "Question"),
        guess: section(body, "What I would have done, and why"),
        blocks: section(body, "What it blocks"),
        answer: section(body, "Answer"),
        where_guess_lives: section(body, "Where the guess lives"),
        fields: fields_map(&s),
        sections,
    })
}

/// Write the answer under `## Answer` and flip `status` to `answered`. The
/// two are the only edits the contract lets the GUI make to a blocker, and
/// they are made together — an answer with `status: open` would be re-asked
/// by the next unit, and `answered` with no answer would be a decision
/// nobody made. Refused while a shift is live, and for a withdrawn or
/// applied blocker, whose question is no longer open to answer.
pub fn answer_blocker(root: &Path, id: &str, answer: &str) -> Result<Blocker, String> {
    launch::ensure_not_live(root)?;
    let files = blocker_files(root);
    let path = files
        .get(id)
        .ok_or_else(|| format!("no blocker with id {id}"))?;
    let answer = answer.trim();
    if answer.is_empty() {
        return Err(
            "an empty answer would mark the blocker answered with no decision; write the decision"
                .into(),
        );
    }
    let text = read_text(path)?;
    let s = frontmatter::split(&text);
    match s.get("status").unwrap_or("") {
        "open" | "answered" => {}
        other => {
            return Err(format!(
                "blocker {id} is {other}; only an open or answered blocker takes an answer"
            ));
        }
    }
    let body = replace_answer(&s.body, answer);
    let mut fm = String::from("---\n");
    fm.push_str(&s.raw.join("\n"));
    fm.push_str("\n---\n");
    let rebuilt = frontmatter::set(&format!("{fm}{body}"), "status", "answered");
    write_atomic(path, &rebuilt)?;
    read_at(path, id)
}

/// The body with its `## Answer` section's text replaced (or the section
/// appended when absent). Everything else is byte-identical.
fn replace_answer(body: &str, answer: &str) -> String {
    let heading = regex::Regex::new(r"(?m)^## Answer[^\n]*\n").expect("answer regex");
    let Some(m) = heading.find(body) else {
        let mut out = body.to_string();
        if !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&format!("\n## Answer\n{answer}\n"));
        return out;
    };
    let head = &body[..m.end()];
    let rest = &body[m.end()..];
    let next = regex::Regex::new(r"(?m)^## ").expect("next regex");
    match next.find(rest) {
        Some(n) => format!("{head}{answer}\n\n{}", &rest[n.start()..]),
        None => format!("{head}{answer}\n"),
    }
}

#[cfg(test)]
mod tests {
    use super::super::testutil::{fixture, scratch};
    use super::*;
    use std::fs;

    #[test]
    fn the_migrated_blocker_reads_open_with_its_question() {
        let (list, errors) = list_blockers(&fixture());
        assert!(errors.is_empty(), "{errors:?}");
        assert_eq!(list.len(), 1);
        let b = &list[0];
        assert_eq!(b.id, "021");
        assert_eq!(b.status, "open");
        assert_eq!(b.raised, "2026-09-09");
        assert_eq!(b.shift, "");
        assert!(b.question.contains("pdftotext"), "{}", b.question);
        assert!(b.answer.is_empty());
        assert_eq!(b.follow_up, None);
        assert!(!b.guess.is_empty());
    }

    #[test]
    fn answering_writes_the_answer_and_the_status_and_nothing_else() {
        let ws = scratch();
        let before = fs::read_to_string(blocker_files(&ws)["021"].clone()).unwrap();
        let b = answer_blocker(&ws, "021", "  Stop recommending PDFs.  ").unwrap();
        assert_eq!(b.status, "answered");
        assert_eq!(b.answer, "Stop recommending PDFs.");
        let after = fs::read_to_string(&b.path).unwrap();
        // Frontmatter: exactly one line changed.
        let (fb, fa) = (frontmatter::split(&before), frontmatter::split(&after));
        let changed: Vec<_> = fb
            .raw
            .iter()
            .zip(fa.raw.iter())
            .filter(|(x, y)| x != y)
            .collect();
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0].1, "status: answered");
        // Body: identical outside the Answer section.
        assert_eq!(section(&fb.body, "Question"), section(&fa.body, "Question"));
        assert_eq!(
            section(&fb.body, "What I would have done, and why"),
            section(&fa.body, "What I would have done, and why")
        );
        assert_eq!(
            section(&fb.body, "What it blocks"),
            section(&fa.body, "What it blocks")
        );
        // Re-answering an answered blocker is allowed; a withdrawn one is not.
        assert_eq!(
            answer_blocker(&ws, "021", "Grant curl.").unwrap().answer,
            "Grant curl."
        );
        let withdrawn =
            frontmatter::set(&fs::read_to_string(&b.path).unwrap(), "status", "withdrawn");
        fs::write(&b.path, withdrawn).unwrap();
        assert!(answer_blocker(&ws, "021", "x").is_err());
        assert!(answer_blocker(&ws, "999", "x").is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn an_empty_answer_is_refused() {
        let ws = scratch();
        assert!(answer_blocker(&ws, "021", "   ").is_err());
        assert_eq!(read_blocker(&ws, "021").unwrap().status, "open");
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn replace_answer_handles_a_middle_section_a_last_section_and_none() {
        assert_eq!(
            replace_answer("## Q\nq\n\n## Answer\n\n## Later\nl\n", "yes"),
            "## Q\nq\n\n## Answer\nyes\n\n## Later\nl\n"
        );
        assert_eq!(
            replace_answer("## Q\nq\n\n## Answer\nold\n", "new"),
            "## Q\nq\n\n## Answer\nnew\n"
        );
        assert_eq!(replace_answer("## Q\nq", "a"), "## Q\nq\n\n## Answer\na\n");
    }

    #[test]
    fn open_blockers_list_first() {
        let ws = scratch();
        fs::write(
            ws.join("blockers/005-x.md"),
            "---\nid: 005\nstatus: answered\n---\n\n## Question\nq\n\n## Answer\na\n",
        )
        .unwrap();
        fs::write(
            ws.join("blockers/030-y.md"),
            "---\nid: 030\nstatus: open\n---\n\n## Question\nq2\n",
        )
        .unwrap();
        let (list, _) = list_blockers(&ws);
        let ids: Vec<_> = list.iter().map(|b| b.id.as_str()).collect();
        assert_eq!(ids, vec!["021", "030", "005"]);
        let _ = fs::remove_dir_all(&ws);
    }
}
