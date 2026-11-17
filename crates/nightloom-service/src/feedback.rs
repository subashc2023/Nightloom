//! Feedback from him to the agent (nightshift item 805, 2026-11-17).
//!
//! From any chat ("send feedback: …", the `send_feedback` tool) or by his
//! own hand (the feedback box on the Mac, the phone page's sheet), his words
//! become **one backlog item** in the project they are about — the Nightshift
//! repo (nightshift-code) unless he names another — with his words verbatim
//! under `What Swaraag said` and the context (chat, build, time, where it was
//! sent from) under `Pointers`. A line under "New feedback from him" at the
//! top of that project's `backlog/INDEX.md` is what the next session start
//! sees: the read order opens INDEX.md second, so nothing new has to be read.
//!
//! **Nothing he sends is lost.** Every note is first saved as one JSON file
//! under `<config>/feedback/`; filing it is a second step. When the item
//! cannot be written — a shift is live (the item writer refuses then), or no
//! Nightshift project is registered here — the record stays `pending` and is
//! filed on the next send (or the desktop's next start, `flush`). The reply
//! says which happened.
//!
//! The item is written by `items::new_item_from`, the same writer the Mac's
//! New item and the phone's Add use, so the id rule (one past the highest,
//! files and `order.json` both) and the shift guard are theirs.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::nightshift::{self, ContractRoot, items, launch};

/// The folder under the config dir where every note is saved first.
pub const DIR: &str = "feedback";

/// The heading of the list at the top of `backlog/INDEX.md`. The practices'
/// `backlogctl.py index` writes the same heading from the items' front
/// matter (`source: feedback`, status `todo`), so the list survives the
/// index being regenerated.
pub const INDEX_HEADING: &str = "## New feedback from him";

/// The build this binary is, when the build script could ask git.
pub const BUILD: Option<&str> = option_env!("NIGHTLOOM_GIT_SHA");

/// What he sent, and from where. `text` is his words; everything else is
/// context the sender attaches.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Note {
    pub text: String,
    /// Where it was sent from, in plain words: "the Mac (a chat)", "an
    /// aside", "Home", "the phone page", "a chat, through the send_feedback
    /// tool".
    #[serde(default)]
    pub surface: String,
    /// `box` (he typed it into the feedback box) or `tool` (a model called
    /// `send_feedback`).
    #[serde(default)]
    pub via: String,
    /// The chat open when he sent it.
    #[serde(default)]
    pub chat: Option<String>,
    #[serde(default)]
    pub chat_title: Option<String>,
    /// The project that chat is in, by name.
    #[serde(default)]
    pub project: Option<String>,
    /// Which project it is about, by id or name; `None` is Nightloom itself,
    /// filed in the Nightshift repo.
    #[serde(default)]
    pub about: Option<String>,
    /// What the model that sent it adds (the tool's `context`), kept apart
    /// from his words.
    #[serde(default)]
    pub model_note: Option<String>,
    /// The tool's text when it was not found verbatim in his messages: his
    /// own message is then `text`, and this is what the model wrote.
    #[serde(default)]
    pub model_wording: Option<String>,
}

/// Where a note was filed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FiledAs {
    /// The project's name.
    pub project: String,
    /// The item's id, `807`.
    pub item: String,
    /// `backlog/807-….md`.
    pub file: String,
}

/// One saved note: what `<config>/feedback/<stamp>.json` holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    /// When he sent it, RFC 3339.
    pub at: String,
    /// The Nightloom build that took it.
    #[serde(default)]
    pub build: Option<String>,
    #[serde(flatten)]
    pub note: Note,
    /// Set once the item is written.
    #[serde(default)]
    pub filed: Option<FiledAs>,
    /// Why the last try to file it failed, in words.
    #[serde(default)]
    pub pending_why: Option<String>,
}

/// What a send answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sent {
    /// The item it became, when it was filed now.
    pub filed: Option<FiledAs>,
    /// Why it is waiting, when it was not.
    pub pending_why: Option<String>,
    /// Where it was saved first (absent where no config dir is known).
    pub saved: Option<String>,
    /// Earlier pending notes filed on the way.
    #[serde(default)]
    pub also_filed: Vec<FiledAs>,
}

impl Sent {
    /// One sentence for a toast or a tool reply.
    pub fn sentence(&self) -> String {
        let mut out = match (&self.filed, &self.pending_why) {
            (Some(f), _) => format!(
                "Sent: filed as item {} in {} ({}).",
                f.item, f.project, f.file
            ),
            (None, Some(why)) => format!(
                "Saved, not filed yet — {why}. It is filed the next time feedback is sent or Nightloom starts."
            ),
            (None, None) => "Saved.".to_string(),
        };
        if !self.also_filed.is_empty() {
            let ids: Vec<&str> = self.also_filed.iter().map(|f| f.item.as_str()).collect();
            out.push_str(&format!(
                " Earlier feedback waiting to be filed went in too: item {}.",
                ids.join(", ")
            ));
        }
        out
    }
}

/// A project feedback can be filed in: a registered project with Nightshift
/// on.
#[derive(Debug, Clone)]
pub struct Target {
    pub id: String,
    pub name: String,
    pub root: ContractRoot,
}

/// The targets on this machine, from the registry under `config`.
pub fn targets_in(config: &Path) -> Vec<Target> {
    crate::project::Registry::load_in(config)
        .projects()
        .into_iter()
        .filter_map(|p| {
            let root = p.workspace.as_deref().and_then(nightshift::detect)?;
            Some(Target {
                id: p.id,
                name: p.name,
                root,
            })
        })
        .collect()
}

/// The project a note goes to. `about` empty, "nightloom" or "nightshift"
/// is the Nightshift repo: the root that carries its own runner script, else
/// the only target there is.
pub fn pick<'a>(targets: &'a [Target], about: Option<&str>) -> Result<&'a Target, String> {
    let about = about.map(str::trim).filter(|a| !a.is_empty());
    let is_default = about.is_none_or(|a| {
        let a = a.to_lowercase();
        a == "nightloom" || a == "nightshift"
    });
    if !is_default {
        let a = about.unwrap_or_default().to_lowercase();
        if let Some(t) = targets
            .iter()
            .find(|t| t.id.to_lowercase() == a || t.name.to_lowercase() == a)
        {
            return Ok(t);
        }
        if let Some(t) = targets.iter().find(|t| {
            t.root
                .root
                .file_name()
                .is_some_and(|n| n.to_string_lossy().to_lowercase() == a)
        }) {
            return Ok(t);
        }
        let names: Vec<&str> = targets.iter().map(|t| t.name.as_str()).collect();
        return Err(format!(
            "no Nightshift project called {:?} here; the ones there are: {}",
            about.unwrap_or_default(),
            if names.is_empty() {
                "none".to_string()
            } else {
                names.join(", ")
            }
        ));
    }
    targets
        .iter()
        .find(|t| t.root.root.join(launch::RUNNER).is_file())
        .or(if targets.len() == 1 {
            targets.first()
        } else {
            None
        })
        .ok_or_else(|| "no Nightshift project is registered in Nightloom on this machine".into())
}

/// Save `note`, then file it and every earlier pending one. `home` is the
/// config dir (records go in `<home>/feedback/`); with none, the note is
/// filed directly and an item that cannot be written is an error.
pub fn send(home: Option<&Path>, targets: &[Target], note: Note) -> Result<Sent, String> {
    let mut note = note;
    note.text = note.text.trim_end().to_string();
    if note.text.trim().is_empty() {
        return Err("there is nothing to send: the feedback is empty".into());
    }
    // A named project that is not here is the sender's mistake to fix now,
    // before anything is saved.
    if note.about.as_deref().is_some_and(|a| !a.trim().is_empty()) {
        pick(targets, note.about.as_deref())?;
    }
    let record = Record {
        at: chrono::Local::now().to_rfc3339(),
        build: BUILD.map(str::to_string),
        note,
        filed: None,
        pending_why: None,
    };
    let Some(home) = home else {
        let filed = file(targets, &record)?;
        return Ok(Sent {
            filed: Some(filed),
            pending_why: None,
            saved: None,
            also_filed: Vec::new(),
        });
    };
    let dir = home.join(DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("could not make {}: {e}", dir.display()))?;
    let path = dir.join(format!(
        "{}-{:04x}.json",
        chrono::Local::now().format("%Y%m%d-%H%M%S"),
        std::process::id() as u16 ^ (chrono::Utc::now().timestamp_subsec_nanos() as u16)
    ));
    nightshift::write_json_atomic(&path, &record)?;
    let mut filed = flush(home, targets);
    let mine = filed.iter().position(|(p, _)| *p == path);
    let this = mine.map(|i| filed.remove(i).1);
    let pending_why = if this.is_none() {
        read_record(&path).and_then(|r| r.pending_why)
    } else {
        None
    };
    Ok(Sent {
        filed: this,
        pending_why,
        saved: Some(path.to_string_lossy().into_owned()),
        also_filed: filed.into_iter().map(|(_, f)| f).collect(),
    })
}

/// File every pending record under `<home>/feedback/`, oldest first.
/// Returns what was filed; a record that still cannot be filed keeps its
/// reason in `pending_why`.
pub fn flush(home: &Path, targets: &[Target]) -> Vec<(PathBuf, FiledAs)> {
    let mut out = Vec::new();
    for (path, mut rec) in pending(home) {
        match file(targets, &rec) {
            Ok(f) => {
                rec.filed = Some(f.clone());
                rec.pending_why = None;
                let _ = nightshift::write_json_atomic(&path, &rec);
                out.push((path, f));
            }
            Err(why) => {
                if rec.pending_why.as_deref() != Some(why.as_str()) {
                    rec.pending_why = Some(why);
                    let _ = nightshift::write_json_atomic(&path, &rec);
                }
            }
        }
    }
    out
}

/// The records not filed yet, oldest first.
pub fn pending(home: &Path) -> Vec<(PathBuf, Record)> {
    let Ok(entries) = fs::read_dir(home.join(DIR)) else {
        return Vec::new();
    };
    let mut paths: Vec<PathBuf> = entries
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    paths.sort();
    paths
        .into_iter()
        .filter_map(|p| read_record(&p).map(|r| (p, r)))
        .filter(|(_, r)| r.filed.is_none())
        .collect()
}

fn read_record(path: &Path) -> Option<Record> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

/// Write the item and its INDEX line.
fn file(targets: &[Target], rec: &Record) -> Result<FiledAs, String> {
    let target = pick(targets, rec.note.about.as_deref())?;
    let root = &target.root.root;
    let when = sent_at(&rec.at);
    let title = title_of(&rec.note.text);
    let from = rec.note.surface.trim();
    let from = if from.is_empty() { "Nightloom" } else { from };
    let id = items::new_item_from(
        root,
        &title,
        "build",
        &body(rec, root),
        "feedback",
        &[("feedback_at", &when), ("feedback_from", from)],
    )?;
    let file = items::item_files(root)
        .get(&id)
        .and_then(|p| {
            p.file_name()
                .map(|n| format!("backlog/{}", n.to_string_lossy()))
        })
        .unwrap_or_else(|| format!("backlog/{id}-….md"));
    // Best-effort: the item is what matters, and the next `index` lists it.
    let _ = note_in_index(root, &index_line(&id, &title, &when, from, &file));
    Ok(FiledAs {
        project: target.name.clone(),
        item: id,
        file,
    })
}

/// "Feedback: " and the first line of his words, at most ~90 characters.
pub fn title_of(text: &str) -> String {
    let first = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    let cut: String = first.chars().take(90).collect();
    let cut = if cut.chars().count() < first.chars().count() {
        format!("{}…", cut.trim_end())
    } else {
        cut
    };
    format!("Feedback: {cut}")
}

/// `2026-11-17 11:02 AM`, local time, from the record's stamp.
fn sent_at(at: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(at)
        .map(|t| {
            t.with_timezone(&chrono::Local)
                .format("%Y-%m-%d %-I:%M %p")
                .to_string()
        })
        .unwrap_or_else(|_| at.to_string())
}

/// The INDEX line, the same shape `backlogctl.py index` writes.
pub fn index_line(id: &str, title: &str, when: &str, from: &str, file: &str) -> String {
    format!("- **{id}** — {title} — sent {when} from {from} (`{file}`)")
}

/// The item's body: his words, what the sender added, the context.
fn body(rec: &Record, root: &Path) -> String {
    let n = &rec.note;
    let mut inferred = Vec::new();
    if let Some(m) = n.model_note.as_deref().filter(|m| !m.trim().is_empty()) {
        inferred.push(format!(
            "From the chat's model when it sent this (`inferred`): {}",
            m.trim()
        ));
    }
    if let Some(w) = n.model_wording.as_deref() {
        inferred.push(format!(
            "The model's wording was not found verbatim in his messages, so his latest message is \
             quoted above; what the model sent was: {}",
            w.trim()
        ));
    }
    if inferred.is_empty() {
        inferred.push("Nothing yet: no agent has read this.".into());
    }
    let via = match n.via.as_str() {
        "tool" => "the send_feedback tool (the chat's model called it)",
        "box" => "the feedback box (he typed it himself)",
        "" => "Nightloom",
        other => other,
    };
    let from = if n.surface.trim().is_empty() {
        "Nightloom"
    } else {
        n.surface.trim()
    };
    let mut pointers = vec![format!(
        "- Sent {} from {from}, through {via}",
        sent_at(&rec.at)
    )];
    if let Some(chat) = n.chat.as_deref() {
        let title = n
            .chat_title
            .as_deref()
            .map(|t| format!(" \"{}\"", t.trim()))
            .unwrap_or_default();
        let project = n
            .project
            .as_deref()
            .map(|p| format!(" in project {p}"))
            .unwrap_or_default();
        pointers.push(format!("- Chat: `{chat}`{title}{project}"));
    } else if let Some(p) = n.project.as_deref() {
        pointers.push(format!("- Project open: {p}"));
    }
    let build = rec
        .build
        .clone()
        .map(|b| format!("`{}` (the build that took it)", short(&b)))
        .or_else(|| {
            fs::read_to_string(root.join("state/installed.txt"))
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .map(|s| format!("`{}` (state/installed.txt)", short(&s)))
        })
        .unwrap_or_else(|| "not known".into());
    pointers.push(format!("- Nightloom build: {build}"));
    format!(
        "## What Swaraag said\n{}\n\n## What the agent inferred\n{}\n\n## Definition of done\n\n\n## Pointers\n{}\n\n## Not to do\n",
        n.text.trim_end(),
        inferred.join("\n\n"),
        pointers.join("\n"),
    )
}

fn short(sha: &str) -> &str {
    sha.get(..8).unwrap_or(sha)
}

/// Add `line` under [`INDEX_HEADING`] in `<root>/backlog/INDEX.md`, making
/// the section (just above the items table) when it is not there. A project
/// with no INDEX.md is left alone: its read order is not known.
pub fn note_in_index(root: &Path, line: &str) -> Result<(), String> {
    let path = root.join("backlog").join("INDEX.md");
    let Ok(text) = fs::read_to_string(&path) else {
        return Ok(());
    };
    if text.contains(line) {
        return Ok(());
    }
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    if let Some(h) = lines.iter().position(|l| l.trim() == INDEX_HEADING) {
        // After the section's last list line.
        let mut at = h + 1;
        let mut i = h + 1;
        while i < lines.len() && !lines[i].starts_with("## ") && !lines[i].starts_with('|') {
            if lines[i].starts_with("- ") {
                at = i + 1;
            }
            i += 1;
        }
        if at == h + 1 {
            // Heading with no rows yet: skip its blank/hint lines.
            while at < lines.len() && !lines[at].trim().is_empty() && !lines[at].starts_with("- ") {
                at += 1;
            }
        }
        lines.insert(at, line.to_string());
    } else {
        let at = lines
            .iter()
            .position(|l| l.starts_with("| order |") || l.starts_with("|"))
            .unwrap_or(lines.len());
        let block = [
            INDEX_HEADING.to_string(),
            "His own words, sent through Nightloom; read each before the queue.".to_string(),
            line.to_string(),
            String::new(),
        ];
        for (k, l) in block.into_iter().enumerate() {
            lines.insert(at + k, l);
        }
    }
    let mut out = lines.join("\n");
    if text.ends_with('\n') {
        out.push('\n');
    }
    nightshift::write_atomic(&path, &out)
}

/// Whether the tool's `words` are his, verbatim: found in one of his
/// messages in the chat's log (whitespace and surrounding quotes aside).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Words {
    Found,
    /// Not found; his latest message, to quote instead.
    NotFound {
        last: String,
    },
    /// The log could not be read.
    Unchecked,
}

/// Check `words` against the user messages of the chat `chat` under
/// `log_dir`. Also returns the chat's title, when it has one.
pub fn check_words(log_dir: &Path, chat: &str, words: &str) -> (Words, Option<String>) {
    let Ok(path) = crate::store::find_by_prefix(log_dir, chat) else {
        return (Words::Unchecked, None);
    };
    let modified = fs::metadata(&path)
        .and_then(|m| m.modified())
        .map(chrono::DateTime::<chrono::Utc>::from)
        .unwrap_or_else(|_| chrono::Utc::now());
    let Ok((summary, events)) = crate::store::scan(&path, modified) else {
        return (Words::Unchecked, None);
    };
    let title = summary.title.clone();
    let his: Vec<String> = events
        .iter()
        .filter_map(|e| match e {
            nightloom_core::SessionEvent::UserMessage { text, .. } => Some(text.clone()),
            _ => None,
        })
        .collect();
    let Some(last) = his.last().cloned() else {
        return (Words::Unchecked, title);
    };
    let want = squash(words);
    if want.is_empty() || his.iter().any(|m| squash(m).contains(&want)) {
        (Words::Found, title)
    } else {
        (Words::NotFound { last }, title)
    }
}

fn squash(s: &str) -> String {
    s.trim()
        .trim_matches(|c| matches!(c, '"' | '\'' | '“' | '”' | '‘' | '’'))
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

// ---- the tool ----------------------------------------------------------------

/// The tool's name; the CLI calls it `mcp__nightloom__send_feedback`.
pub const TOOL_NAME: &str = "send_feedback";

/// The sentence `initialize` adds when the tool is served.
pub const INSTRUCTION: &str = " When the user asks to send feedback (to the agent that \
     builds Nightloom, or about one of their Nightshift projects), call send_feedback with \
     their words copied exactly; it files them as a backlog item.";

/// `send_feedback`, served to a chat that writes (not incognito, not
/// ephemeral). Its words are checked against his messages in this chat.
pub struct SendFeedbackTool {
    config: PathBuf,
    /// The chat's project: id (where its logs are) and name.
    project_id: Option<String>,
    project_name: Option<String>,
    chat: Option<String>,
}

impl SendFeedbackTool {
    pub fn new(
        config: PathBuf,
        project_id: Option<String>,
        project_name: Option<String>,
        chat: Option<String>,
    ) -> Self {
        Self {
            config,
            project_id,
            project_name,
            chat,
        }
    }

    fn log_dir(&self) -> PathBuf {
        match self.project_id.as_deref() {
            Some(id) => self
                .config
                .join(crate::project::PROJECTS_DIR)
                .join(id)
                .join(crate::project::SESSIONS_DIR),
            None => self
                .config
                .join(crate::capture::UNFILED)
                .join(crate::project::SESSIONS_DIR),
        }
    }

    /// The note the tool files, his words checked.
    pub fn note(&self, words: &str, context: Option<&str>, about: Option<&str>) -> Note {
        let (check, title) = match self.chat.as_deref() {
            Some(chat) => check_words(&self.log_dir(), chat, words),
            None => (Words::Unchecked, None),
        };
        let (text, model_wording) = match check {
            Words::NotFound { last } => (last, Some(words.to_string())),
            Words::Found | Words::Unchecked => (words.to_string(), None),
        };
        Note {
            text,
            surface: "a chat, through the send_feedback tool".into(),
            via: "tool".into(),
            chat: self.chat.clone(),
            chat_title: title,
            project: self.project_name.clone(),
            about: about.map(str::to_string),
            model_note: context.map(str::to_string),
            model_wording,
        }
    }
}

#[async_trait::async_trait]
impl nightloom_core::tool::Tool for SendFeedbackTool {
    fn effect(&self) -> nightloom_core::tool::Effect {
        nightloom_core::tool::Effect::Session
    }

    fn def(&self) -> nightloom_core::ToolDef {
        nightloom_core::ToolDef {
            name: TOOL_NAME.into(),
            description: "Send the user's feedback to the agent that builds Nightloom (or to \
                 one of their Nightshift projects): it becomes a new backlog item with their \
                 words verbatim, this chat's id, the build and the time, and the next work \
                 session sees it first. Call it when the user says to send feedback. `words` \
                 must be the user's own words, copied exactly from their message (the part \
                 that is the feedback) — never a summary; if they are not found in their \
                 messages, their latest message is filed instead. Put anything you add in \
                 `context`. Leave `project` out for feedback about Nightloom."
                .into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "words": {"type": "string", "description": "The user's feedback, verbatim."},
                    "context": {"type": "string", "description": "Optional: what you add (what they were looking at, what went wrong). Filed apart from their words."},
                    "project": {"type": "string", "description": "Optional: the Nightshift project it is about, by name. Default: Nightloom (the nightshift repo)."}
                },
                "required": ["words"]
            }),
        }
    }

    async fn call(
        &self,
        input: serde_json::Value,
        _cancel: &nightloom_core::tool::CancellationToken,
    ) -> Result<String, String> {
        let words = input["words"]
            .as_str()
            .map(str::trim)
            .filter(|w| !w.is_empty())
            .ok_or("words is required: the user's feedback, verbatim")?
            .to_string();
        let context = input["context"].as_str().map(str::to_string);
        let about = input["project"].as_str().map(str::to_string);
        let note = self.note(&words, context.as_deref(), about.as_deref());
        let config = self.config.clone();
        let sent = tokio::task::spawn_blocking(move || {
            let targets = targets_in(&config);
            send(Some(&config), &targets, note)
        })
        .await
        .map_err(|e| e.to_string())??;
        Ok(sent.sentence())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "nl-feedback-{name}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// A Nightshift repo like nightshift-code: nightshift.json, its runner,
    /// a backlog with an INDEX.
    fn repo(dir: &Path) -> Target {
        fs::create_dir_all(dir.join("backlog")).unwrap();
        fs::create_dir_all(dir.join("bin")).unwrap();
        fs::write(dir.join("bin/nightshift.sh"), "#!/bin/sh\n").unwrap();
        fs::write(
            dir.join("nightshift.json"),
            r#"{"version": 2, "name": "nightshift-code", "kind": "build"}"#,
        )
        .unwrap();
        fs::write(
            dir.join("backlog/804-home.md"),
            "---\nid: 804\ntitle: Home\nkind: build\nstatus: todo\n---\n\n## What Swaraag said\nx\n",
        )
        .unwrap();
        fs::write(dir.join("backlog/order.json"), "{\"order\": [\"804\"]}\n").unwrap();
        fs::write(
            dir.join("backlog/INDEX.md"),
            "# Backlog INDEX — regenerated\n\nOne file per item.\n**Live items (1): not done.**\n\n| order | id | status | kind | title | file |\n|---:|---|---|---|---|---|\n| 1 | 804 | todo | build | Home | `backlog/804-home.md` |\n",
        )
        .unwrap();
        Target {
            id: "p1".into(),
            name: "nightshift-code".into(),
            root: nightshift::detect(dir).expect("detected"),
        }
    }

    #[test]
    fn a_note_becomes_one_item_with_his_words_verbatim_and_an_index_line() {
        let home = scratch("home");
        let ns = scratch("ns");
        let t = repo(&ns);
        let words =
            "The aside button is too small.\n\n  Second line, kept as typed: \"quotes\" too.";
        let sent = send(
            Some(&home),
            &[t],
            Note {
                text: words.into(),
                surface: "the Mac (a chat)".into(),
                via: "box".into(),
                chat: Some("abcdef12".into()),
                chat_title: Some("Asides".into()),
                project: Some("Nightloom".into()),
                ..Note::default()
            },
        )
        .unwrap();
        let f = sent.filed.expect("filed");
        assert_eq!(f.item, "805");
        let item = fs::read_to_string(ns.join(&f.file)).unwrap();
        assert!(item.contains(&format!(
            "## What Swaraag said\n{words}\n\n## What the agent inferred"
        )));
        assert!(item.contains("source: feedback"));
        assert!(item.contains("feedback_from: \"the Mac (a chat)\""));
        assert!(item.contains("- Chat: `abcdef12` \"Asides\" in project Nightloom"));
        assert!(item.contains("## Progress"));
        let order = fs::read_to_string(ns.join("backlog/order.json")).unwrap();
        assert!(order.contains("805"));
        let index = fs::read_to_string(ns.join("backlog/INDEX.md")).unwrap();
        let h = index.find(INDEX_HEADING).expect("heading");
        let table = index.find("| order |").unwrap();
        assert!(h < table, "the list sits above the table");
        assert!(index.contains("- **805** — Feedback: The aside button is too small. — sent "));
        // The record is marked filed.
        let rec = read_record(Path::new(sent.saved.as_deref().unwrap())).unwrap();
        assert_eq!(rec.filed.unwrap().item, "805");
        assert!(pending(&home).is_empty());
        // A second one joins the same list.
        let sent2 = send(
            Some(&home),
            &[repo_again(&ns)],
            Note {
                text: "Second.".into(),
                ..Note::default()
            },
        )
        .unwrap();
        assert_eq!(sent2.filed.unwrap().item, "806");
        let index = fs::read_to_string(ns.join("backlog/INDEX.md")).unwrap();
        assert_eq!(index.matches(INDEX_HEADING).count(), 1);
        let a = index.find("- **805**").unwrap();
        let b = index.find("- **806**").unwrap();
        assert!(a < b && b < index.find("| order |").unwrap());
    }

    fn repo_again(dir: &Path) -> Target {
        Target {
            id: "p1".into(),
            name: "nightshift-code".into(),
            root: nightshift::detect(dir).unwrap(),
        }
    }

    #[test]
    fn with_nowhere_to_file_it_is_kept_and_filed_later() {
        let home = scratch("home2");
        let sent = send(
            Some(&home),
            &[],
            Note {
                text: "Kept for later.".into(),
                ..Note::default()
            },
        )
        .unwrap();
        assert!(sent.filed.is_none());
        assert!(
            sent.pending_why
                .as_deref()
                .unwrap()
                .contains("no Nightshift project")
        );
        assert!(sent.sentence().starts_with("Saved, not filed yet"));
        assert_eq!(pending(&home).len(), 1);
        let ns = scratch("ns2");
        let t = repo(&ns);
        let filed = flush(&home, &[t]);
        assert_eq!(filed.len(), 1);
        assert!(pending(&home).is_empty());
        let item = fs::read_to_string(ns.join(&filed[0].1.file)).unwrap();
        assert!(item.contains("## What Swaraag said\nKept for later.\n"));
    }

    #[test]
    fn a_live_shift_keeps_it_pending() {
        let home = scratch("home3");
        let ns = scratch("ns3");
        let t = repo(&ns);
        fs::create_dir_all(ns.join("state")).unwrap();
        fs::write(ns.join("state/run.lock"), std::process::id().to_string()).unwrap();
        let sent = send(
            Some(&home),
            &[t],
            Note {
                text: "During a shift.".into(),
                ..Note::default()
            },
        )
        .unwrap();
        // Whether this platform can tell the lock is live or not, the item
        // writer refuses and the note waits.
        assert!(sent.filed.is_none(), "{sent:?}");
        assert_eq!(pending(&home).len(), 1);
    }

    #[test]
    fn empty_feedback_and_an_unknown_project_are_refused_before_saving() {
        let home = scratch("home4");
        assert!(
            send(
                Some(&home),
                &[],
                Note {
                    text: "  \n ".into(),
                    ..Note::default()
                }
            )
            .is_err()
        );
        let err = send(
            Some(&home),
            &[],
            Note {
                text: "x".into(),
                about: Some("Nope".into()),
                ..Note::default()
            },
        )
        .unwrap_err();
        assert!(err.contains("no Nightshift project called"));
        assert!(pending(&home).is_empty());
    }

    #[test]
    fn titles_are_the_first_line_capped() {
        assert_eq!(title_of("\n  hi there \nmore"), "Feedback: hi there");
        let long = "a".repeat(200);
        let t = title_of(&long);
        assert!(t.ends_with('…') && t.chars().count() == "Feedback: ".len() + 91);
    }

    /// The tool's words are his when they are in one of his messages;
    /// otherwise his latest message is filed and the model's text is kept
    /// apart.
    #[test]
    fn the_tool_files_his_words_and_never_a_paraphrase() {
        let config = scratch("tool");
        let dir = config
            .join(crate::capture::UNFILED)
            .join(crate::project::SESSIONS_DIR);
        fs::create_dir_all(&dir).unwrap();
        let mut s = nightloom_core::Session::with_log(&dir).unwrap();
        s.record_user("send feedback: the   aside close button is\ntoo small on the phone");
        s.record_title("Phone asides");
        let chat = s.id.clone();
        let tool = SendFeedbackTool::new(config.clone(), None, None, Some(chat.clone()));
        let ok = tool.note(
            "the aside close button is too small on the phone",
            Some("He was on the phone page."),
            None,
        );
        assert_eq!(ok.text, "the aside close button is too small on the phone");
        assert_eq!(ok.model_wording, None);
        assert_eq!(ok.chat_title.as_deref(), Some("Phone asides"));
        assert_eq!(ok.via, "tool");
        let para = tool.note("The user finds the close control undersized.", None, None);
        assert_eq!(
            para.text,
            "send feedback: the   aside close button is\ntoo small on the phone"
        );
        assert_eq!(
            para.model_wording.as_deref(),
            Some("The user finds the close control undersized.")
        );
        // And the item says so, apart from his words.
        let ns = scratch("tool-ns");
        let t = repo(&ns);
        let sent = send(Some(&config), &[t], para).unwrap();
        let item = fs::read_to_string(ns.join(sent.filed.unwrap().file)).unwrap();
        assert!(item.contains(
            "## What Swaraag said\nsend feedback: the   aside close button is\ntoo small on the phone\n"
        ));
        assert!(
            item.contains("what the model sent was: The user finds the close control undersized.")
        );
        assert!(item.contains(&format!("- Chat: `{chat}` \"Phone asides\"")));
    }

    #[test]
    fn squash_ignores_spacing_and_quotes() {
        assert_eq!(squash("  \"a   b\n c\" "), "a b c");
    }
}
