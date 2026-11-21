//! Feedback from him to the agent (nightshift item 805, 2026-11-17).
//!
//! From any chat ("send feedback: …", the `send_feedback` tool) or by his
//! own hand (the feedback box on the Mac, the phone page's sheet), his words
//! become **one backlog item** in Nightloom's own backlog — the Nightshift
//! repo (nightshift-code), always: feedback is only for Nightloom's
//! development (item 816, blocker 2109) — with his words verbatim
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

/// The lock file under [`DIR`] that keeps two flushes from filing one note
/// twice. Not `.json`, so [`pending`] never reads it.
const LOCK_FILE: &str = "flush.lock";

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
    /// Ignored (item 816): feedback always goes to Nightloom's own backlog.
    /// Kept so a record saved, or a draft sent, by an older build — which
    /// may name another project here — still reads and files, to Nightloom.
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
    /// The tool's words could not be checked against his messages (no chat,
    /// or its log unreadable): the item says so rather than vouch for them.
    #[serde(default)]
    pub words_unchecked: bool,
    /// Images he attached (item 815), as the box or the phone sends them.
    /// [`send`] moves each to a file beside the record and empties this:
    /// a record never holds image bytes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attach: Vec<Attachment>,
    /// The images [`send`] saved, under `<home>/feedback/` (item 815). Set
    /// only by `send`: what a sender puts here is dropped.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<SavedImage>,
}

/// An image as a sender gives it (item 815): base64 bytes (a `data:` URL's
/// prefix is allowed and dropped) and how it came — `paste` (⌘V, a drop,
/// the phone's photo button) or `page` (the box's shot of the page).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Attachment {
    pub data: String,
    #[serde(default)]
    pub kind: String,
}

/// One image saved with a record: its file name under `<home>/feedback/`
/// (and, once filed, under `backlog/shots/` as `feedback-<file>`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedImage {
    pub file: String,
    #[serde(default)]
    pub kind: String,
}

/// One image's cap, decoded: the composer's image cap (10 MB of base64,
/// `MAX_IMAGE_BASE64`), so what a chat could take a note can too.
pub const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024 / 4 * 3;
/// At most this many images on one note.
pub const MAX_IMAGES: usize = 8;
/// The folder under a project's `backlog/` the images are filed in.
pub const SHOTS_DIR: &str = "shots";

/// The file extension for an image's bytes — PNG, JPEG, WebP or GIF,
/// judged by the bytes, never the sender's word — or `None`.
pub fn image_ext(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("jpg")
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("webp")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("gif")
    } else {
        None
    }
}

/// The attachments' bytes and extensions, checked: at most [`MAX_IMAGES`],
/// each a known image type under [`MAX_IMAGE_BYTES`]. An error names the
/// image (1-based) and why, before anything is saved.
pub fn decode_images(attach: &[Attachment]) -> Result<Vec<(Vec<u8>, &'static str)>, String> {
    use base64::Engine as _;
    if attach.len() > MAX_IMAGES {
        return Err(format!(
            "a note takes at most {MAX_IMAGES} images; this one has {}",
            attach.len()
        ));
    }
    attach
        .iter()
        .enumerate()
        .map(|(i, a)| {
            let n = i + 1;
            let raw = a.data.trim();
            let raw = match raw.find(";base64,") {
                Some(at) if raw.starts_with("data:") => &raw[at + 8..],
                _ => raw,
            };
            // A cheap bound before decoding: base64 is 4 chars per 3 bytes.
            if raw.len() / 4 * 3 > MAX_IMAGE_BYTES + 3 {
                return Err(format!("image {n} is over the 10 MB limit"));
            }
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(raw)
                .map_err(|_| format!("image {n} could not be read (not base64)"))?;
            if bytes.len() > MAX_IMAGE_BYTES {
                return Err(format!("image {n} is over the 10 MB limit"));
            }
            let ext = image_ext(&bytes)
                .ok_or_else(|| format!("image {n} is not a PNG, JPEG, WebP or GIF"))?;
            Ok((bytes, ext))
        })
        .collect()
}

/// A saved image's name is one plain file name — never a path (a record
/// edited by hand must not copy some other file into the backlog).
fn plain_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
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

/// The project every note goes to: Nightloom's own backlog, the Nightshift
/// repo — the root that carries its own runner script, else the only target
/// there is. Feedback is only for Nightloom's development (item 816, his
/// words in blocker 2109), so a note's `about` never picks another project.
pub fn pick(targets: &[Target]) -> Result<&Target, String> {
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
    // Item 815: images ride along; only `send` names saved ones.
    let attach = std::mem::take(&mut note.attach);
    note.images.clear();
    let decoded = decode_images(&attach)?;
    if note.text.trim().is_empty() && decoded.is_empty() {
        return Err("there is nothing to send: the feedback is empty".into());
    }
    let stem = format!(
        "{}-{:04x}",
        chrono::Local::now().format("%Y%m%d-%H%M%S"),
        std::process::id() as u16 ^ (chrono::Utc::now().timestamp_subsec_nanos() as u16)
    );
    note.images = decoded
        .iter()
        .zip(&attach)
        .enumerate()
        .map(|(i, ((_, ext), a))| SavedImage {
            file: format!("{stem}-{}.{ext}", i + 1),
            kind: a.kind.clone(),
        })
        .collect();
    let bytes: Vec<(String, Vec<u8>)> = note
        .images
        .iter()
        .zip(decoded)
        .map(|(s, (b, _))| (s.file.clone(), b))
        .collect();
    let record = Record {
        at: chrono::Local::now().to_rfc3339(),
        build: BUILD.map(str::to_string),
        note,
        filed: None,
        pending_why: None,
    };
    let Some(home) = home else {
        let filed = file(targets, &record, &bytes)?;
        return Ok(Sent {
            filed: Some(filed),
            pending_why: None,
            saved: None,
            also_filed: Vec::new(),
        });
    };
    let dir = home.join(DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("could not make {}: {e}", dir.display()))?;
    let path = dir.join(format!("{stem}.json"));
    // The images first: a record on disk names only files that are there.
    for (name, b) in &bytes {
        write_atomic(&dir.join(name), b)?;
    }
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
    // One flush at a time, across processes (review of 805): the desktop,
    // its phone listener, the away server and each chat's MCP server all
    // flush, and two reading the same pending record would each file it —
    // a duplicate item. An advisory lock (`flock`), released on drop or
    // when the process dies; `pending` is read only once it is held, so a
    // record the other one filed is seen as filed. A lock that cannot be
    // taken (the folder unwritable) files nothing: the notes stay saved.
    let dir = home.join(DIR);
    let _ = fs::create_dir_all(&dir);
    let Ok(lock) = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(LOCK_FILE))
    else {
        return out;
    };
    if lock.lock().is_err() {
        return out;
    }
    for (path, mut rec) in pending(home) {
        let images = saved_images(&dir, &rec);
        match file(targets, &rec, &images) {
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

/// Write `bytes` to `path` whole or not at all (a temp file, then a rename).
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("part");
    fs::write(&tmp, bytes)
        .and_then(|_| fs::rename(&tmp, path))
        .map_err(|e| format!("could not save {}: {e}", path.display()))
}

/// A record's saved images, read back from `dir` (item 815). One that is
/// gone, or whose name is not a plain file name, is left out; the item
/// says so.
fn saved_images(dir: &Path, rec: &Record) -> Vec<(String, Vec<u8>)> {
    rec.note
        .images
        .iter()
        .filter(|i| plain_name(&i.file))
        .filter_map(|i| Some((i.file.clone(), fs::read(dir.join(&i.file)).ok()?)))
        .collect()
}

/// Write the item and its INDEX line; then its images under
/// `backlog/shots/` (item 815), named in the item already.
fn file(targets: &[Target], rec: &Record, images: &[(String, Vec<u8>)]) -> Result<FiledAs, String> {
    let target = pick(targets)?;
    let root = &target.root.root;
    let when = sent_at(&rec.at);
    let title = if rec.note.text.trim().is_empty() {
        match rec.note.images.len() {
            1 => "Feedback: a screenshot".to_string(),
            n => format!("Feedback: {n} screenshots"),
        }
    } else {
        title_of(&rec.note.text)
    };
    let from = rec.note.surface.trim();
    let from = if from.is_empty() { "Nightloom" } else { from };
    let id = items::new_item_from(
        root,
        &title,
        "build",
        &body(rec, root, images),
        "feedback",
        &[("feedback_at", &when), ("feedback_from", from)],
    )?;
    // The item exists: its images go beside it. Best-effort per image — the
    // item already holds his words, and a copy that failed stays in the
    // record's folder.
    if !images.is_empty() {
        let shots = root.join("backlog").join(SHOTS_DIR);
        if fs::create_dir_all(&shots).is_ok() {
            for (name, b) in images {
                let _ = write_atomic(&shots.join(format!("feedback-{name}")), b);
            }
        }
    }
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
fn body(rec: &Record, root: &Path, images: &[(String, Vec<u8>)]) -> String {
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
            "The model's wording was not found verbatim in his messages, so his message closest to \
             it is quoted above; what the model sent was: {}",
            w.trim()
        ));
    }
    if n.words_unchecked {
        inferred.push(
            "A chat's model sent these words and they could not be checked against his messages \
             (the chat's log was not found), so they may not be verbatim."
                .into(),
        );
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
    // Item 815: each image he attached, linked from beside the item.
    for (i, img) in n.images.iter().enumerate() {
        let what = match img.kind.as_str() {
            "page" => "a shot of the page he was on (taken by Nightloom when he asked)",
            _ => "an image he pasted",
        };
        if images.iter().any(|(name, _)| *name == img.file) {
            pointers.push(format!(
                "- Image {}: {what} — ![image {}]({SHOTS_DIR}/feedback-{})",
                i + 1,
                i + 1,
                img.file
            ));
        } else {
            pointers.push(format!(
                "- Image {}: {what} — its file `{}` was not found when this was filed",
                i + 1,
                img.file
            ));
        }
    }
    let words = if n.text.trim().is_empty() {
        "(no words — only the attached images, under Pointers)"
    } else {
        n.text.trim_end()
    };
    format!(
        "## What Swaraag said\n{}\n\n## What the agent inferred\n{}\n\n## Definition of done\n\n\n## Pointers\n{}\n\n## Not to do\n",
        words,
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
    /// Not found; his message closest to the words, to quote instead.
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
    if his.is_empty() {
        return (Words::Unchecked, title);
    }
    let want = squash(words);
    if want.is_empty() || his.iter().any(|m| squash(m).contains(&want)) {
        (Words::Found, title)
    } else {
        (
            Words::NotFound {
                last: closest(&his, words),
            },
            title,
        )
    }
}

/// His message that shares the most words with the model's `words`, the
/// latest on a tie (review of 805): the latest alone would file a "yes, send
/// it" that came after the feedback itself.
fn closest(his: &[String], words: &str) -> String {
    let bag = |s: &str| -> std::collections::HashSet<String> {
        s.split(|c: char| !c.is_alphanumeric())
            .filter(|w| w.chars().count() > 2)
            .map(str::to_lowercase)
            .collect()
    };
    let want = bag(words);
    let mut best = (0usize, his.len() - 1);
    for (i, m) in his.iter().enumerate() {
        let shared = bag(m).intersection(&want).count();
        if shared >= best.0 && shared > 0 {
            best = (shared, i);
        }
    }
    his[best.1].clone()
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
     builds Nightloom), call send_feedback with their words copied exactly; it files them as \
     a backlog item in Nightloom's backlog.";

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
    pub fn note(&self, words: &str, context: Option<&str>) -> Note {
        let (check, title) = match self.chat.as_deref() {
            Some(chat) => check_words(&self.log_dir(), chat, words),
            None => (Words::Unchecked, None),
        };
        let unchecked = check == Words::Unchecked;
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
            about: None,
            model_note: context.map(str::to_string),
            model_wording,
            words_unchecked: unchecked,
            ..Note::default()
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
            description: "Send the user's feedback to the agent that builds Nightloom: it \
                 becomes a new item in Nightloom's backlog with their words verbatim, this chat's id, the build and the time, and the next work \
                 session sees it first. Call it when the user says to send feedback. `words` \
                 must be the user's own words, copied exactly from their message (the part \
                 that is the feedback) — never a summary; if they are not found in their \
                 messages, their message closest to them is filed instead. Put anything you add in \
                 `context`."
                .into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "words": {"type": "string", "description": "The user's feedback, verbatim."},
                    "context": {"type": "string", "description": "Optional: what you add (what they were looking at, what went wrong). Filed apart from their words."}
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
        // A `project` an older prompt still passes is ignored (item 816).
        let note = self.note(&words, context.as_deref());
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

    /// A 1×1 PNG, the smallest real image.
    const PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x60,
        0x00, 0x02, 0x00, 0x00, 0x05, 0x00, 0x01, 0xE9, 0xFA, 0xDC, 0xD8, 0x00, 0x00, 0x00, 0x00,
        0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    fn b64(b: &[u8]) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(b)
    }

    /// Item 815: a note with a pasted image and a page shot round-trips —
    /// saved beside the record (never inside it), filed under
    /// `backlog/shots/` byte for byte, and linked from the item.
    #[test]
    fn a_note_with_images_files_them_beside_the_item_and_links_them() {
        let home = scratch("home815");
        let ns = scratch("ns815");
        let t = repo(&ns);
        let mut jpeg = vec![0xFF, 0xD8, 0xFF, 0xE0];
        jpeg.extend_from_slice(b"rest of a jpeg");
        let sent = send(
            Some(&home),
            &[t],
            Note {
                text: "The chip overlaps.".into(),
                attach: vec![
                    Attachment {
                        data: format!("data:image/png;base64,{}", b64(PNG)),
                        kind: "paste".into(),
                    },
                    Attachment {
                        data: b64(&jpeg),
                        kind: "page".into(),
                    },
                ],
                // A sender cannot name saved files: dropped.
                images: vec![SavedImage {
                    file: "../../etc/passwd".into(),
                    kind: "paste".into(),
                }],
                ..Note::default()
            },
        )
        .unwrap();
        let f = sent.filed.expect("filed");
        let saved = PathBuf::from(sent.saved.unwrap());
        let raw = fs::read_to_string(&saved).unwrap();
        assert!(!raw.contains(&b64(PNG)), "no bytes in the record");
        let rec = read_record(&saved).unwrap();
        assert_eq!(rec.note.images.len(), 2);
        assert!(rec.note.attach.is_empty());
        let (a, b) = (&rec.note.images[0], &rec.note.images[1]);
        assert!(
            a.file.ends_with("-1.png") && b.file.ends_with("-2.jpg"),
            "{a:?} {b:?}"
        );
        assert_eq!(fs::read(home.join(DIR).join(&a.file)).unwrap(), PNG);
        assert_eq!(
            fs::read(
                ns.join("backlog/shots")
                    .join(format!("feedback-{}", a.file))
            )
            .unwrap(),
            PNG
        );
        assert_eq!(
            fs::read(
                ns.join("backlog/shots")
                    .join(format!("feedback-{}", b.file))
            )
            .unwrap(),
            jpeg
        );
        let item = fs::read_to_string(ns.join(&f.file)).unwrap();
        assert!(item.contains("## What Swaraag said\nThe chip overlaps.\n"));
        assert!(item.contains(&format!(
            "- Image 1: an image he pasted — ![image 1](shots/feedback-{})",
            a.file
        )));
        assert!(item.contains("- Image 2: a shot of the page he was on"));
        assert!(!item.contains("passwd"));
    }

    /// Item 815: a screenshot alone is feedback; it waits like words do
    /// when it cannot be filed, and files with its image later.
    #[test]
    fn an_image_alone_is_sent_and_waits_with_its_image() {
        let home = scratch("home815b");
        let sent = send(
            Some(&home),
            &[],
            Note {
                attach: vec![Attachment {
                    data: b64(PNG),
                    kind: "paste".into(),
                }],
                ..Note::default()
            },
        )
        .unwrap();
        assert!(sent.filed.is_none());
        let ns = scratch("ns815b");
        let filed = flush(&home, &[repo(&ns)]);
        assert_eq!(filed.len(), 1);
        let item = fs::read_to_string(ns.join(&filed[0].1.file)).unwrap();
        assert!(
            item.contains("title: \"Feedback: a screenshot\"")
                || item.contains("title: Feedback: a screenshot"),
            "{item}"
        );
        assert!(item.contains("(no words — only the attached images, under Pointers)"));
        assert!(item.contains("![image 1](shots/feedback-"));
    }

    /// Item 815: what is not an image, or too many, is refused before
    /// anything is saved.
    #[test]
    fn a_bad_image_is_refused_before_saving() {
        let home = scratch("home815c");
        let bad = |attach: Vec<Attachment>| {
            send(
                Some(&home),
                &[],
                Note {
                    text: "words".into(),
                    attach,
                    ..Note::default()
                },
            )
            .unwrap_err()
        };
        let one = |data: String| Attachment {
            data,
            kind: "paste".into(),
        };
        assert!(bad(vec![one(b64(b"<svg></svg>"))]).contains("not a PNG, JPEG, WebP or GIF"));
        assert!(bad(vec![one("%%%".into())]).contains("not base64"));
        assert!(bad(vec![one(b64(PNG)); MAX_IMAGES + 1]).contains("at most"));
        let mut big = PNG.to_vec();
        big.resize(MAX_IMAGE_BYTES + 1, 0);
        assert!(bad(vec![one(b64(&big))]).contains("10 MB"));
        assert!(pending(&home).is_empty());
        assert!(fs::read_dir(home.join(DIR)).map(|d| d.count()).unwrap_or(0) == 0);
        assert_eq!(image_ext(b"RIFF\0\0\0\0WEBPVP8 "), Some("webp"));
        assert_eq!(image_ext(b"GIF89a.."), Some("gif"));
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
    fn empty_feedback_is_refused_before_saving() {
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
        assert!(pending(&home).is_empty());
    }

    /// Item 816: feedback is only for Nightloom's development. A note naming
    /// another Nightshift project (Value Generalization) — from an older
    /// box's draft, the phone, or a record saved before — files into
    /// Nightloom's own backlog, never that project's.
    #[test]
    fn a_note_about_another_project_files_into_nightloom() {
        let home = scratch("home816");
        let ns = scratch("ns816");
        let nightloom = repo(&ns);
        let vg_dir = scratch("vg816");
        fs::create_dir_all(vg_dir.join("nightshift")).unwrap();
        fs::create_dir_all(vg_dir.join("nightshift/backlog")).unwrap();
        fs::write(
            vg_dir.join("nightshift/nightshift.json"),
            r#"{"version": 2, "name": "value-gen", "kind": "research"}"#,
        )
        .unwrap();
        let vg = Target {
            id: "vg".into(),
            name: "Value Generalization".into(),
            root: nightshift::detect(&vg_dir).expect("detected"),
        };
        let vg_root = vg.root.root.clone();
        let targets = [vg, nightloom];
        let sent = send(
            Some(&home),
            &targets,
            Note {
                text: "About value gen, filed anyway.".into(),
                about: Some("Value Generalization".into()),
                ..Note::default()
            },
        )
        .unwrap();
        let f = sent.filed.expect("filed");
        assert_eq!(f.project, "nightshift-code");
        assert!(ns.join(&f.file).is_file());
        // A record an older build saved with `about` naming that project's
        // id, still pending, files into Nightloom too.
        let old = Record {
            at: chrono::Local::now().to_rfc3339(),
            build: None,
            note: Note {
                text: "Saved before 816.".into(),
                about: Some("vg".into()),
                ..Note::default()
            },
            filed: None,
            pending_why: Some("a shift was live".into()),
        };
        nightshift::write_json_atomic(&home.join(DIR).join("00000000-old.json"), &old).unwrap();
        let filed = flush(&home, &targets);
        assert_eq!(filed.len(), 1);
        assert_eq!(filed[0].1.project, "nightshift-code");
        let item = fs::read_to_string(ns.join(&filed[0].1.file)).unwrap();
        assert!(item.contains("## What Swaraag said\nSaved before 816.\n"));
        // Nothing went to Value Generalization's backlog.
        assert_eq!(
            fs::read_dir(vg_root.join("backlog")).unwrap().count(),
            0,
            "value gen's backlog stays empty"
        );
        // The chat tool no longer offers a project to pick.
        let tool = SendFeedbackTool::new(home.clone(), None, None, None);
        let def = nightloom_core::tool::Tool::def(&tool);
        assert!(def.input_schema["properties"].get("project").is_none());
        assert!(!def.description.contains("Nightshift projects"));
    }

    #[test]
    fn titles_are_the_first_line_capped() {
        assert_eq!(title_of("\n  hi there \nmore"), "Feedback: hi there");
        let long = "a".repeat(200);
        let t = title_of(&long);
        assert!(t.ends_with('…') && t.chars().count() == "Feedback: ".len() + 91);
    }

    /// The tool's words are his when they are in one of his messages;
    /// otherwise his closest message is filed and the model's text is kept
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
        );
        assert_eq!(ok.text, "the aside close button is too small on the phone");
        assert_eq!(ok.model_wording, None);
        assert_eq!(ok.chat_title.as_deref(), Some("Phone asides"));
        assert_eq!(ok.via, "tool");
        let para = tool.note("The user finds the close control undersized.", None);
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

    /// Review of 805: a "yes, send it" after the feedback is not what gets
    /// filed when the model's words are off; his closest message is.
    #[test]
    fn a_paraphrase_files_his_closest_message_not_his_latest() {
        let config = scratch("closest");
        let dir = config
            .join(crate::capture::UNFILED)
            .join(crate::project::SESSIONS_DIR);
        fs::create_dir_all(&dir).unwrap();
        let mut s = nightloom_core::Session::with_log(&dir).unwrap();
        s.record_user("the aside close button is too small on the phone, send that as feedback");
        s.record_user("yes, send it");
        let tool = SendFeedbackTool::new(config.clone(), None, None, Some(s.id.clone()));
        let n = tool.note("The aside close button is undersized on phones.", None);
        assert_eq!(
            n.text,
            "the aside close button is too small on the phone, send that as feedback"
        );
        assert!(!n.words_unchecked);
        // No chat to check against: filed, and the item says unchecked.
        let blind = SendFeedbackTool::new(config.clone(), None, None, None);
        let b = blind.note("words", None);
        assert!(b.words_unchecked);
        let ns = scratch("closest-ns");
        let sent = send(Some(&config), &[repo(&ns)], b).unwrap();
        let item = fs::read_to_string(ns.join(sent.filed.unwrap().file)).unwrap();
        assert!(item.contains("could not be checked against his messages"));
    }

    /// Review of 805: flushes racing over the same pending notes file each
    /// note once.
    #[test]
    fn racing_flushes_file_each_note_once() {
        let home = scratch("race");
        for i in 0..4 {
            send(
                Some(&home),
                &[],
                Note {
                    text: format!("waiting {i}"),
                    ..Note::default()
                },
            )
            .unwrap();
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert_eq!(pending(&home).len(), 4);
        let ns = scratch("race-ns");
        repo(&ns);
        let threads: Vec<_> = (0..4)
            .map(|_| {
                let home = home.clone();
                let ns = ns.clone();
                std::thread::spawn(move || flush(&home, &[repo_again(&ns)]).len())
            })
            .collect();
        let filed: usize = threads.into_iter().map(|t| t.join().unwrap()).sum();
        assert_eq!(filed, 4);
        let items = fs::read_dir(ns.join("backlog"))
            .unwrap()
            .filter(|e| {
                e.as_ref()
                    .is_ok_and(|e| e.file_name().to_string_lossy().contains("feedback-waiting"))
            })
            .count();
        assert_eq!(items, 4);
    }

    #[test]
    fn squash_ignores_spacing_and_quotes() {
        assert_eq!(squash("  \"a   b\n c\" "), "a b c");
    }
}
