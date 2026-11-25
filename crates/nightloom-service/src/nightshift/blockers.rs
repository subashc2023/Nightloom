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

impl Blocker {
    /// Open and `default: held` in its front matter: nothing proceeds
    /// without him (item 968 — the one kind of blocker that "needs you").
    pub fn is_held(&self) -> bool {
        self.status == "open"
            && self
                .fields
                .get("default")
                .is_some_and(|d| d.trim() == "held")
    }
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

/// Where a chat's answered question is filed (item 753): the project's
/// Nightshift root when it has one, else the workspace itself when it
/// keeps a `blockers/` folder (the practices layout); `None` for a project
/// with neither — its answer is sent and no file is written.
pub fn filing_root(workspace: &Path) -> Option<PathBuf> {
    if let Some(root) = super::detect(workspace) {
        return Some(root.root);
    }
    workspace
        .join("blockers")
        .is_dir()
        .then(|| workspace.to_path_buf())
}

/// What [`file_answered`] is given: a question a chat asked and what he
/// answered, in his words.
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct AnsweredAsk {
    pub question: String,
    /// His answer as sent — a button's label, with his comment, or what he typed.
    pub answer: String,
    /// The answers the card offered, the model's default first.
    #[serde(default)]
    pub options: Vec<String>,
    /// The chat that asked, as its lists name it.
    #[serde(default)]
    pub chat: String,
    /// When he answered, as the file should say it ("2026-11-16 9:05 AM").
    #[serde(default)]
    pub when: String,
}

/// File a question he answered in a chat as a new blocker, `status:
/// answered`, `source: chat`, his words under `## Answer` (item 753; the
/// contract's "decisions answered in chat are blockers too"). A new file
/// under the next free id; nothing existing is touched. Refused while a
/// shift is live (the runner allots ids then) and for an empty question or
/// answer.
pub fn file_answered(root: &Path, ask: &AnsweredAsk) -> Result<Blocker, String> {
    launch::ensure_not_live(root)?;
    let one_line = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let question = one_line(&ask.question);
    let answer = ask.answer.trim();
    if question.is_empty() || answer.is_empty() {
        return Err("a blocker needs the question and the answer".into());
    }
    let dir = root.join("blockers");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let next = blocker_files(root)
        .keys()
        .filter_map(|k| k.parse::<u64>().ok())
        .max()
        .unwrap_or(0)
        + 1;
    let id = format!("{next:03}");
    let slug = question
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|p| !p.is_empty())
        .take(8)
        .collect::<Vec<_>>()
        .join("-");
    let slug = if slug.is_empty() {
        "ask".to_string()
    } else {
        slug
    };
    let path = dir.join(format!("{id}-{slug}.md"));
    if path.exists() {
        return Err(format!("blocker {id} already exists"));
    }
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let offered = if ask.options.is_empty() {
        "The chat offered no answers of its own.".to_string()
    } else {
        format!(
            "The chat offered, its default first: {}.",
            ask.options
                .iter()
                .map(|o| format!("\"{}\"", one_line(o)))
                .collect::<Vec<_>>()
                .join("; ")
        )
    };
    let chat = one_line(&ask.chat);
    let asked_in = if chat.is_empty() {
        "A chat's turn-end question.".to_string()
    } else {
        format!("The turn-end question of the chat \"{chat}\".")
    };
    let when = one_line(&ask.when);
    let stamp = if when.is_empty() { today.clone() } else { when };
    let body = format!(
        "---\nid: {id}\nstatus: answered\nraised: {today}\nsource: chat\nitem: \n---\n\n## Question\n{question}\n\n## What I would have done, and why\n{offered}\n\n## What it blocks\n{asked_in}\n\n## Answer\n"
    );
    let text = replace_answer(
        &body,
        &format!("His answer ({stamp}, chat, `user_stated`): {answer}"),
    );
    write_atomic(&path, &text)?;
    read_at(&path, &id)
}

/// The body with its `## Answer` section's text replaced (or the section
/// appended when absent). Everything else is byte-identical. A line of the
/// answer that starts `## ` gets one leading space, so it stays inside the
/// section: unescaped it began a section of its own, which the next
/// re-answer left behind (review B1 finding 5).
fn replace_answer(body: &str, answer: &str) -> String {
    let answer = answer
        .split('\n')
        .map(|l| {
            if l.starts_with("## ") {
                format!(" {l}")
            } else {
                l.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let answer = answer.as_str();
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
    fn an_answer_with_a_heading_line_stays_in_its_section() {
        let once = replace_answer(
            "## Q\nq\n\n## Answer\n\n## Later\nl\n",
            "yes\n## Not a section\nok",
        );
        assert_eq!(
            once,
            "## Q\nq\n\n## Answer\nyes\n ## Not a section\nok\n\n## Later\nl\n"
        );
        // A re-answer replaces all of it: nothing stray is left behind.
        assert_eq!(
            replace_answer(&once, "no"),
            "## Q\nq\n\n## Answer\nno\n\n## Later\nl\n"
        );
    }

    #[test]
    fn an_answered_ask_is_filed_as_a_new_answered_blocker_in_his_words() {
        let root = scratch();
        let before = blocker_files(&root).len();
        let b = file_answered(
            &root,
            &AnsweredAsk {
                question: "Roll the release\nnow, or after the merge?".into(),
                answer: "After the merge (note: not before lunch)\n## not a heading".into(),
                options: vec!["Now".into(), "After the merge".into()],
                chat: "Wave F".into(),
                when: "2026-11-16 9:05 AM".into(),
            },
        )
        .unwrap();
        assert_eq!(b.status, "answered");
        assert_eq!(b.question, "Roll the release now, or after the merge?");
        assert!(b.answer.starts_with(
            "His answer (2026-11-16 9:05 AM, chat, `user_stated`): After the merge (note: not before lunch)"
        ));
        assert!(b.guess.contains("\"Now\"; \"After the merge\""));
        assert_eq!(b.fields.get("source").map(String::as_str), Some("chat"));
        assert_eq!(blocker_files(&root).len(), before + 1);
        // The next one takes the next id; an empty answer files nothing.
        let c = file_answered(
            &root,
            &AnsweredAsk {
                question: "Again?".into(),
                answer: "Yes".into(),
                ..AnsweredAsk::default()
            },
        )
        .unwrap();
        assert_eq!(
            c.id.parse::<u64>().unwrap(),
            b.id.parse::<u64>().unwrap() + 1
        );
        assert!(
            file_answered(
                &root,
                &AnsweredAsk {
                    question: "Q".into(),
                    answer: "  ".into(),
                    ..AnsweredAsk::default()
                }
            )
            .is_err()
        );
        // Its section survives a re-read as one section.
        assert!(
            read_blocker(&root, &b.id)
                .unwrap()
                .answer
                .contains(" ## not a heading")
        );
    }

    #[test]
    fn an_answer_is_filed_in_the_nightshift_root_or_a_blockers_folder_only() {
        let dir = std::env::temp_dir().join(format!("nl-753-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(filing_root(&dir), None);
        std::fs::create_dir_all(dir.join("blockers")).unwrap();
        assert_eq!(filing_root(&dir), Some(dir.clone()));
        std::fs::remove_dir_all(&dir).unwrap();
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

    #[test]
    fn only_an_open_blocker_with_default_held_is_held() {
        let ws = scratch();
        for (f, body) in [
            (
                "040-a.md",
                "---\nid: 040\nstatus: open\ndefault: held\n---\n\n## Question\nq\n",
            ),
            (
                "041-b.md",
                "---\nid: 041\nstatus: open\ndefault: applied\n---\n\n## Question\nq\n",
            ),
            (
                "042-c.md",
                "---\nid: 042\nstatus: answered\ndefault: held\n---\n\n## Question\nq\n",
            ),
            (
                "043-d.md",
                "---\nid: 043\nstatus: open\ndefault:  held \n---\n\n## Question\nq\n",
            ),
        ] {
            fs::write(ws.join("blockers").join(f), body).unwrap();
        }
        let (list, _) = list_blockers(&ws);
        let held: Vec<_> = list
            .iter()
            .filter(|b| b.is_held())
            .map(|b| b.id.as_str())
            .collect();
        assert_eq!(held, vec!["040", "043"]);
        let _ = fs::remove_dir_all(&ws);
    }
}
