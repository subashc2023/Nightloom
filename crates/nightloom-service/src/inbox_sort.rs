//! The notes Inbox and its "Sort inbox" (nightshift backlog 488).
//!
//! Anything can be dropped in a notes folder's `Inbox/` (item 492 lands a
//! drop on a folder row in that folder). Sort inbox asks a cheap model
//! where each entry should go and shows the plan; he unticks or edits a
//! destination and Apply moves the ticked ones. Three rules:
//!
//! - **The main chat is never touched.** The sort is a throwaway one-shot
//!   turn on Haiku in its own CLI process — chat_name's shape: `--tools ""`,
//!   strict MCP, one round, no session file, an empty scratch folder.
//! - **The model reads only what Nightloom hands it** (blocker 1639): the
//!   folder list and each entry's name, size and first few hundred
//!   characters, written into the one message by [`gather`] and
//!   [`compose`]. It has no tools, so it cannot open anything else, and one
//!   API call is the cheapest the sort can be.
//! - **Nothing is deleted or overwritten.** [`apply`] moves with
//!   [`crate::project::move_note`] (which refuses a taken name); a taken name
//!   is numbered as item 492's Keep both numbers it, `x (2).txt`.
//!
//! An entry is a top-level entry of `Inbox/`: a file, or a folder that moves
//! whole (a dropped zip unpacks into `Inbox/<zip name>/`; blocker 1640).

use crate::agent::{AgentSpec, PassSpec};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// The inbox folder, at the top of the notes.
pub const INBOX: &str = "Inbox";

/// The model a sort runs on, whatever the chat's own model is: the cheapest
/// the Claude Code engine offers.
pub const SORT_MODEL: &str = "haiku";

/// Entries shown to the model in one sort; the rest wait for the next.
pub const MAX_ITEMS: usize = 60;

/// How much of a text file the model sees.
pub const HEAD_CHARS: usize = 300;

/// Destination folders listed in the message.
pub const MAX_FOLDERS: usize = 300;

/// A reason is one short line.
pub const MAX_REASON: usize = 140;

/// His instruction, bounded.
pub const MAX_INSTRUCTION: usize = 2000;

/// One top-level entry of the inbox, as the model and the sheet see it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InboxItem {
    /// Notes-relative, `Inbox/<name>`.
    pub path: String,
    pub folder: bool,
    pub bytes: u64,
    /// What it is in a few words: `text`, `PDF`, `folder of 3 files`.
    pub kind: String,
    /// The first [`HEAD_CHARS`] of a text file, whitespace collapsed; a
    /// folder's first names; empty for other files.
    pub head: String,
}

/// What a sort is planned from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Digest {
    pub items: Vec<InboxItem>,
    /// Existing folders outside the inbox, notes-relative, sorted.
    pub folders: Vec<String>,
    /// Entries past [`MAX_ITEMS`], left for the next sort.
    pub left_out: usize,
}

/// One line of the plan the sheet shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Proposal {
    pub item: String,
    pub folder: bool,
    /// Destination folder, notes-relative; `""` is the top of the notes;
    /// [`INBOX`] when it stays.
    pub to: String,
    pub reason: String,
    /// The destination does not exist yet; Apply makes it.
    pub new_folder: bool,
    /// Ticked for Apply. A line that stays is unticked.
    pub tick: bool,
}

/// One move Apply is asked for.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
pub struct Move {
    pub item: String,
    pub to: String,
}

/// What came of one move.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Moved {
    pub item: String,
    /// Where it is now, notes-relative.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub landed: Option<String>,
    /// The name was taken, so it was numbered (Keep both).
    pub renamed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Make `Inbox/` if it is not there. An existing one is not an error.
pub fn ensure_inbox(dir: &Path) -> Result<(), String> {
    crate::project::make_note_folder(dir, INBOX).map(|_| ())
}

fn hidden(name: &str) -> bool {
    name.starts_with('.')
}

fn in_inbox(rel: &str) -> bool {
    rel.eq_ignore_ascii_case(INBOX)
        || rel
            .get(..INBOX.len() + 1)
            .is_some_and(|p| p.eq_ignore_ascii_case(&format!("{INBOX}/")))
}

/// Read the inbox and the folders around it. A missing inbox is empty.
pub fn gather(dir: &Path) -> Result<Digest, String> {
    let inbox = dir.join(INBOX);
    let mut names: Vec<String> = match std::fs::read_dir(&inbox) {
        Ok(rd) => rd
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| !hidden(n))
            .collect(),
        Err(_) => Vec::new(),
    };
    names.sort_by_key(|n| n.to_lowercase());
    let left_out = names.len().saturating_sub(MAX_ITEMS);
    let items = names
        .into_iter()
        .take(MAX_ITEMS)
        .filter_map(|n| item_of(&inbox.join(&n), &n))
        .collect();
    let mut folders: Vec<String> = crate::project::list_note_tree(dir)
        .folders
        .into_iter()
        .filter(|f| !in_inbox(f) && !f.split('/').any(hidden))
        .collect();
    folders.truncate(MAX_FOLDERS);
    Ok(Digest {
        items,
        folders,
        left_out,
    })
}

fn item_of(path: &Path, name: &str) -> Option<InboxItem> {
    // Not through a symlink: what moves is what is in the inbox.
    let meta = std::fs::symlink_metadata(path).ok()?;
    if meta.file_type().is_symlink() {
        return None;
    }
    let rel = format!("{INBOX}/{name}");
    if meta.is_dir() {
        let mut inside: Vec<String> = Vec::new();
        let mut count = 0usize;
        walk_names(path, "", &mut inside, &mut count, 0);
        inside.sort();
        let shown: Vec<&str> = inside.iter().take(12).map(String::as_str).collect();
        let more = count.saturating_sub(shown.len());
        let mut head = shown.join(", ");
        if more > 0 {
            head.push_str(&format!(", and {more} more"));
        }
        return Some(InboxItem {
            path: rel,
            folder: true,
            bytes: 0,
            kind: format!(
                "folder of {count} file{}",
                if count == 1 { "" } else { "s" }
            ),
            head,
        });
    }
    let bytes = meta.len();
    let (kind, head) = head_of(path, name);
    Some(InboxItem {
        path: rel,
        folder: false,
        bytes,
        kind,
        head,
    })
}

/// Names under a folder entry, bounded (the model needs a taste, not all).
fn walk_names(dir: &Path, prefix: &str, out: &mut Vec<String>, count: &mut usize, depth: usize) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let n = e.file_name().to_string_lossy().into_owned();
        if hidden(&n) || *count > 5000 {
            continue;
        }
        let rel = format!("{prefix}{n}");
        match e.file_type() {
            Ok(t) if t.is_dir() && depth < 6 => {
                walk_names(&e.path(), &format!("{rel}/"), out, count, depth + 1)
            }
            Ok(t) if t.is_file() => {
                *count += 1;
                if out.len() < 40 {
                    out.push(rel);
                }
            }
            _ => {}
        }
    }
}

/// A file's kind and its first characters (text only).
fn head_of(path: &Path, name: &str) -> (String, String) {
    let ext = Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let named = match ext.as_str() {
        "pdf" => Some("PDF"),
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "heic" | "tiff" | "bmp" => Some("image"),
        "zip" | "gz" | "tar" | "7z" => Some("archive"),
        "docx" | "doc" | "pages" => Some("Word document"),
        "pptx" | "ppt" | "key" => Some("slide deck"),
        "xlsx" | "xls" | "numbers" => Some("spreadsheet"),
        "mp3" | "m4a" | "wav" | "mp4" | "mov" => Some("audio or video"),
        _ => None,
    };
    if let Some(k) = named {
        return (k.to_string(), String::new());
    }
    let mut buf = vec![0u8; 4096];
    let n = std::fs::File::open(path)
        .and_then(|mut f| std::io::Read::read(&mut f, &mut buf))
        .unwrap_or(0);
    buf.truncate(n);
    if buf.contains(&0) {
        return ("binary file".to_string(), String::new());
    }
    let text = match std::str::from_utf8(&buf) {
        Ok(s) => s,
        // A cut multi-byte character at the 4 KiB edge is still text.
        Err(e) if e.valid_up_to() + 4 >= buf.len() => {
            std::str::from_utf8(&buf[..e.valid_up_to()]).unwrap_or("")
        }
        Err(_) => return ("binary file".to_string(), String::new()),
    };
    ("text".to_string(), clip(text, HEAD_CHARS))
}

/// Collapse whitespace and clip to `max` characters, with an ellipsis.
fn clip(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        flat
    } else {
        let mut s: String = flat.chars().take(max).collect();
        s.push('…');
        s
    }
}

fn size_words(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.0} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

/// The one message of a sort.
pub fn compose(digest: &Digest, instruction: &str) -> String {
    let mut folders = String::new();
    if digest.folders.is_empty() {
        folders.push_str("(no folders yet)\n");
    }
    for f in &digest.folders {
        folders.push_str(f);
        folders.push('\n');
    }
    let mut items = String::new();
    for it in &digest.items {
        let size = if it.folder {
            String::new()
        } else {
            format!(", {}", size_words(it.bytes))
        };
        items.push_str(&format!("- {} ({}{size})", it.path, it.kind));
        if !it.head.is_empty() {
            let label = if it.folder { "holds" } else { "begins" };
            items.push_str(&format!(" {label}: {}", it.head));
        }
        items.push('\n');
    }
    let ask = clip(instruction, MAX_INSTRUCTION);
    let ask = if ask.is_empty() {
        String::new()
    } else {
        format!(
            "The user's instruction for this sort (follow it over your own judgement):\n\
             <instruction>\n{ask}\n</instruction>\n\n"
        )
    };
    format!(
        "Sort the entries of a notes folder's Inbox into its other folders. For each \
         inbox entry choose the folder it belongs in: an existing folder from the list \
         when one fits, else a short new folder path in the style of the existing ones \
         (use / to nest). Use \"\" for the top level of the notes, and \"{INBOX}\" to leave \
         an entry where it is when you cannot tell. Entries are moved as they are, never \
         renamed, and a folder entry moves whole.\n\n\
         {ask}\
         Reply with JSON only, no prose and no code fence: an array with one object per \
         inbox entry, each entry exactly once, in this shape:\n\
         [{{\"item\": \"{INBOX}/<name>\", \"to\": \"<folder>\", \"reason\": \"<under 12 words>\"}}]\n\n\
         <folders>\n{folders}</folders>\n\n<inbox>\n{items}</inbox>\n"
    )
}

/// A destination as written, checked: `Ok(None)` stays in the inbox;
/// `Ok(Some(rel))` is a usable folder (`""` the top). Matched to an
/// existing folder regardless of case.
pub fn clean_dest(to: &str, folders: &[String]) -> Result<Option<String>, String> {
    let t = to.trim().trim_matches('/').trim();
    if in_inbox(t) {
        return Ok(None);
    }
    let (_, rel) = crate::keep::note_folder(Path::new(""), t)?;
    if let Some(have) = folders.iter().find(|f| f.eq_ignore_ascii_case(&rel)) {
        return Ok(Some(have.clone()));
    }
    Ok(Some(rel))
}

/// The plan from the model's reply, one line per inbox entry in the
/// digest's order. An entry the reply left out, or sent somewhere that
/// cannot be used, stays (unticked) with the reason said. `Err` when the
/// reply holds no JSON array at all.
pub fn parse_plan(raw: &str, digest: &Digest) -> Result<Vec<Proposal>, String> {
    let start = raw.find('[');
    let end = raw.rfind(']');
    let rows: Vec<serde_json::Value> = match (start, end) {
        (Some(s), Some(e)) if e > s => serde_json::from_str(&raw[s..=e])
            .map_err(|e| format!("the sorter's reply was not a plan ({e})"))?,
        _ => return Err("the sorter's reply was not a plan".to_string()),
    };
    let mut out: Vec<Proposal> = digest
        .items
        .iter()
        .map(|it| Proposal {
            item: it.path.clone(),
            folder: it.folder,
            to: INBOX.to_string(),
            reason: "the sorter did not place this one".to_string(),
            new_folder: false,
            tick: false,
        })
        .collect();
    let mut placed = vec![false; out.len()];
    for row in rows {
        let Some(item) = row.get("item").and_then(|v| v.as_str()) else {
            continue;
        };
        let item = item.trim().trim_start_matches("./");
        // A reply that dropped the `Inbox/` is matched by name.
        let Some(i) = digest.items.iter().position(|it| {
            it.path == item || it.path.strip_prefix(&format!("{INBOX}/")) == Some(item)
        }) else {
            continue;
        };
        if placed[i] {
            continue;
        }
        placed[i] = true;
        let reason = row
            .get("reason")
            .and_then(|v| v.as_str())
            .map(|r| clip(r, MAX_REASON))
            .unwrap_or_default();
        let to = row.get("to").and_then(|v| v.as_str()).unwrap_or(INBOX);
        let p = &mut out[i];
        match clean_dest(to, &digest.folders) {
            Ok(None) => {
                p.reason = if reason.is_empty() {
                    "the sorter left it in the inbox".to_string()
                } else {
                    reason
                };
            }
            Ok(Some(rel)) => {
                p.new_folder = !rel.is_empty() && !digest.folders.contains(&rel);
                p.to = rel;
                p.reason = reason;
                p.tick = true;
            }
            Err(why) => {
                p.reason = format!("the sorter named a folder that cannot be used: {why}");
            }
        }
    }
    Ok(out)
}

/// The first of `stem (2).ext`, `stem (3).ext`… free in `dir` — item 492's
/// Keep both numbering (`keep::numbered_free`).
fn numbered_free(dir: &Path, leaf: &str) -> String {
    let (stem, ext) = match leaf.rfind('.') {
        Some(i) if i > 0 => (&leaf[..i], &leaf[i..]),
        _ => (leaf, ""),
    };
    (2..10_000)
        .map(|n| format!("{stem} ({n}){ext}"))
        .find(|f| std::fs::symlink_metadata(dir.join(f)).is_err())
        .unwrap_or_else(|| leaf.to_string())
}

/// Move the ticked entries. Each move stands alone: one that fails says why
/// and the rest go on. Nothing is deleted and nothing is written over.
pub fn apply(dir: &Path, moves: &[Move]) -> Vec<Moved> {
    moves.iter().map(|m| apply_one(dir, m)).collect()
}

fn apply_one(dir: &Path, m: &Move) -> Moved {
    let fail = |why: String| Moved {
        item: m.item.clone(),
        landed: None,
        renamed: false,
        error: Some(why),
    };
    let Some(leaf) = m.item.strip_prefix(&format!("{INBOX}/")) else {
        return fail(format!("{} is not in the inbox", m.item));
    };
    if leaf.is_empty() || leaf.contains('/') || leaf.contains('\\') || hidden(leaf) || leaf == ".."
    {
        return fail(format!("{} is not an inbox entry", m.item));
    }
    let src = dir.join(INBOX).join(leaf);
    match std::fs::symlink_metadata(&src) {
        Ok(meta) if meta.file_type().is_symlink() => {
            return fail(format!("{} is a link; it is left where it is", m.item));
        }
        Ok(_) => {}
        Err(_) => return fail(format!("{} is no longer in the inbox", m.item)),
    }
    let to = match clean_dest(&m.to, &[]) {
        Ok(Some(rel)) => rel,
        Ok(None) => return fail("that is the inbox itself".to_string()),
        Err(why) => return fail(why),
    };
    let dest = dir.join(&to);
    if let Err(e) = std::fs::create_dir_all(&dest) {
        return fail(format!("cannot make {to}: {e}"));
    }
    // Not out through a symlinked folder.
    match (dir.canonicalize(), dest.canonicalize()) {
        (Ok(root), Ok(real)) if real.starts_with(&root) => {}
        _ => return fail(format!("{to} leads outside the notes folder")),
    }
    let free = if std::fs::symlink_metadata(dest.join(leaf)).is_ok() {
        numbered_free(&dest, leaf)
    } else {
        leaf.to_string()
    };
    let target = if to.is_empty() {
        free.clone()
    } else {
        format!("{to}/{free}")
    };
    match crate::project::move_note(dir, &m.item, &target) {
        Ok(landed) => Moved {
            item: m.item.clone(),
            landed: Some(landed),
            renamed: free != leaf,
            error: None,
        },
        Err(why) => fail(why),
    }
}

/// The CLI spec for one sort, rooted at `scratch` (an empty folder the
/// caller makes, so the CLI reads no project's `CLAUDE.md`). The model is
/// [`SORT_MODEL`] whatever the pass carries.
pub fn spec_for(pass: &PassSpec, scratch: &Path) -> AgentSpec {
    let mut spec = pass.spec_in(scratch);
    spec.model = Some(SORT_MODEL.to_string());
    spec.tools = Some(Vec::new());
    crate::dream::strict_mcp(&mut spec);
    spec.max_turns = Some(1);
    spec.no_session_persistence = true;
    spec.append_system_prompt = Some(IDENTITY.to_string());
    spec
}

const IDENTITY: &str = "You are Nightloom's inbox sorter. You have no tools and you do not \
     chat: your whole reply is the JSON move plan you are asked for.";

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("nightloom-inbox-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn put(dir: &Path, rel: &str, body: &[u8]) {
        let p = dir.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, body).unwrap();
    }

    fn count_files(dir: &Path) -> usize {
        let mut n = 0;
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            if e.file_type().unwrap().is_dir() {
                n += count_files(&e.path());
            } else {
                n += 1;
            }
        }
        n
    }

    #[test]
    fn gather_lists_inbox_entries_with_heads_and_the_folders_outside_it() {
        let d = tmp();
        put(&d, "people/alice.md", b"# Alice");
        put(&d, "courses/cs161/a.md", b"x");
        put(
            &d,
            "Inbox/lecture 4.md",
            b"# Lecture 4\n\nDynamic   programming",
        );
        put(&d, "Inbox/scan.pdf", b"%PDF-1.7\n\xe2\xe3\xcf");
        put(&d, "Inbox/blob.bin", b"ab\0cd");
        put(&d, "Inbox/lab3/src/main.rs", b"fn main(){}");
        put(&d, "Inbox/lab3/README", b"lab");
        put(&d, "Inbox/.DS_Store", b"x");
        let g = gather(&d).unwrap();
        let paths: Vec<&str> = g.items.iter().map(|i| i.path.as_str()).collect();
        assert_eq!(
            paths,
            [
                "Inbox/blob.bin",
                "Inbox/lab3",
                "Inbox/lecture 4.md",
                "Inbox/scan.pdf"
            ]
        );
        assert_eq!(g.items[0].kind, "binary file");
        assert!(g.items[1].folder);
        assert_eq!(g.items[1].kind, "folder of 2 files");
        assert!(g.items[1].head.contains("src/main.rs"), "{:?}", g.items[1]);
        assert_eq!(g.items[2].head, "# Lecture 4 Dynamic programming");
        assert_eq!(g.items[3].kind, "PDF");
        assert!(g.folders.contains(&"people".to_string()));
        assert!(g.folders.contains(&"courses/cs161".to_string()));
        assert!(
            !g.folders.iter().any(|f| f.starts_with("Inbox")),
            "{:?}",
            g.folders
        );
        let msg = compose(&g, "course stuff goes under courses/");
        assert!(msg.contains("<instruction>\ncourse stuff goes under courses/\n</instruction>"));
        assert!(msg.contains("- Inbox/lecture 4.md (text, 34 B) begins: # Lecture 4"));
        assert!(msg.contains("- Inbox/lab3 (folder of 2 files) holds: "));
        assert!(msg.contains("courses/cs161\n"));
        assert!(!compose(&g, "  ").contains("<instruction>"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_missing_inbox_is_empty_and_ensure_makes_it() {
        let d = tmp();
        assert!(gather(&d).unwrap().items.is_empty());
        ensure_inbox(&d).unwrap();
        ensure_inbox(&d).unwrap();
        assert!(d.join(INBOX).is_dir());
        let _ = std::fs::remove_dir_all(&d);
    }

    fn digest() -> Digest {
        let it = |p: &str, folder| InboxItem {
            path: p.into(),
            folder,
            bytes: 1,
            kind: "text".into(),
            head: String::new(),
        };
        Digest {
            items: vec![
                it("Inbox/a.md", false),
                it("Inbox/b.md", false),
                it("Inbox/c.md", false),
                it("Inbox/d.md", false),
                it("Inbox/lab3", true),
            ],
            folders: vec!["People".into(), "courses".into()],
            left_out: 0,
        }
    }

    #[test]
    fn the_plan_reads_the_reply_and_keeps_what_it_cannot_use_in_the_inbox() {
        let raw = "Here you go:\n```json\n[\
            {\"item\": \"Inbox/a.md\", \"to\": \"people\", \"reason\": \"about Alice\"},\
            {\"item\": \"b.md\", \"to\": \"courses/cs161/\", \"reason\": \"lecture\"},\
            {\"item\": \"Inbox/c.md\", \"to\": \"../outside\", \"reason\": \"x\"},\
            {\"item\": \"Inbox/a.md\", \"to\": \"courses\", \"reason\": \"dup\"},\
            {\"item\": \"Inbox/zzz.md\", \"to\": \"courses\"},\
            {\"item\": \"Inbox/lab3\", \"to\": \"Inbox\", \"reason\": \"unsure\"}\
            ]\n```";
        let p = parse_plan(raw, &digest()).unwrap();
        assert_eq!(p.len(), 5);
        assert_eq!(
            (p[0].to.as_str(), p[0].tick, p[0].new_folder),
            ("People", true, false)
        );
        assert_eq!(p[0].reason, "about Alice");
        assert_eq!(
            (p[1].to.as_str(), p[1].tick, p[1].new_folder),
            ("courses/cs161", true, true)
        );
        assert!(!p[2].tick);
        assert_eq!(p[2].to, INBOX);
        assert!(p[2].reason.contains("cannot be used"), "{}", p[2].reason);
        assert!(!p[3].tick, "left out by the reply");
        assert_eq!(p[3].reason, "the sorter did not place this one");
        assert!(!p[4].tick && p[4].folder);
        assert_eq!(p[4].reason, "unsure");
        assert!(parse_plan("I could not sort these.", &digest()).is_err());
        let top = parse_plan(r#"[{"item":"Inbox/a.md","to":"","reason":"r"}]"#, &digest()).unwrap();
        assert_eq!(
            (top[0].to.as_str(), top[0].tick, top[0].new_folder),
            ("", true, false)
        );
    }

    #[test]
    fn apply_moves_numbers_a_taken_name_and_deletes_nothing() {
        let d = tmp();
        put(&d, "people/alice.md", b"old alice");
        put(&d, "Inbox/alice.md", b"new alice");
        put(&d, "Inbox/notes.txt", b"n");
        put(&d, "Inbox/lab3/src/main.rs", b"fn main(){}");
        put(&d, "Inbox/stay.md", b"s");
        let before = count_files(&d);
        let r = apply(
            &d,
            &[
                Move {
                    item: "Inbox/alice.md".into(),
                    to: "people".into(),
                },
                Move {
                    item: "Inbox/notes.txt".into(),
                    to: "".into(),
                },
                Move {
                    item: "Inbox/lab3".into(),
                    to: "courses/cs161".into(),
                },
                Move {
                    item: "Inbox/gone.md".into(),
                    to: "people".into(),
                },
                Move {
                    item: "people/alice.md".into(),
                    to: "courses".into(),
                },
                Move {
                    item: "Inbox/../people/alice.md".into(),
                    to: "courses".into(),
                },
                Move {
                    item: "Inbox/stay.md".into(),
                    to: "../out".into(),
                },
                Move {
                    item: "Inbox/stay.md".into(),
                    to: "Inbox/sub".into(),
                },
            ],
        );
        assert_eq!(r[0].landed.as_deref(), Some("people/alice (2).md"));
        assert!(r[0].renamed);
        assert_eq!(
            std::fs::read(d.join("people/alice.md")).unwrap(),
            b"old alice"
        );
        assert_eq!(r[1].landed.as_deref(), Some("notes.txt"));
        assert_eq!(r[2].landed.as_deref(), Some("courses/cs161/lab3"));
        assert!(d.join("courses/cs161/lab3/src/main.rs").is_file());
        for (i, m) in r.iter().enumerate().skip(3) {
            assert!(m.error.is_some() && m.landed.is_none(), "{i}: {m:?}");
        }
        assert!(d.join("Inbox/stay.md").is_file());
        assert!(!d.join("out").exists());
        assert_eq!(count_files(&d), before, "nothing deleted");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_sort_turn_is_haiku_with_no_tools_no_servers_and_no_session() {
        let mut p = PassSpec::new("claude", Vec::new());
        p.model = Some("opus".into());
        let spec = spec_for(&p, Path::new("/tmp/scratch"));
        let a = spec.args("go");
        let after = |flag: &str| {
            a.iter()
                .position(|x| x == flag)
                .and_then(|i| a.get(i + 1))
                .map(String::as_str)
        };
        assert_eq!(after("--model"), Some("haiku"), "{a:?}");
        assert_eq!(after("--tools"), Some(""), "{a:?}");
        assert!(a.iter().any(|x| x == "--strict-mcp-config"), "{a:?}");
        assert_eq!(after("--max-turns"), Some("1"), "{a:?}");
        assert!(a.iter().any(|x| x == "--no-session-persistence"), "{a:?}");
        assert!(!a.iter().any(|x| x == "--resume"), "{a:?}");
    }

    /// The live check and the cost measurement (not run by the suite: one
    /// real Haiku turn on the subscription, a fake 10-entry inbox).
    /// `cargo test -p nightloom-service inbox_sort::tests::live -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_a_sort_of_a_ten_entry_inbox_on_haiku() {
        use crate::agent::ClaudeCodeAgent;
        use tokio_util::sync::CancellationToken;
        let d = tmp();
        for f in [
            "people",
            "courses/cs161",
            "courses/math120",
            "recipes",
            "admin",
        ] {
            std::fs::create_dir_all(d.join(f)).unwrap();
        }
        put(&d, "people/alice.md", b"# Alice\nLab partner in CS 161.");
        let inbox: [(&str, &[u8]); 10] = [
            (
                "cs161 lecture 7 dynamic programming.md",
                b"# Lecture 7: dynamic programming\nMemoization, the knapsack recurrence, LCS.",
            ),
            (
                "math120 hw3.md",
                b"# Math 120 homework 3\nProve that every finite group of prime order is cyclic.",
            ),
            (
                "sourdough.md",
                b"# Sourdough\n500 g flour, 350 g water, 100 g starter, 10 g salt.",
            ),
            (
                "bob.md",
                b"# Bob Chen\nMet at the hackathon; works on compilers; email in contacts.",
            ),
            (
                "lease renewal.txt",
                b"Lease renewal for apartment 4B, due December 1. Rent $1,850.",
            ),
            ("syllabus.pdf", b"%PDF-1.7\n\xe2\xe3\xcf\xd3"),
            (
                "pad thai.md",
                b"Pad thai: rice noodles, tamarind, fish sauce, palm sugar, peanuts.",
            ),
            (
                "midterm 2 review.md",
                b"# CS 161 midterm 2 review\nGreedy algorithms, MSTs, shortest paths.",
            ),
            (
                "tax 2026 checklist.md",
                b"# Taxes 2026\nW-2, 1098-T tuition form, charitable receipts.",
            ),
            ("random thought.md", b"what if the notes app sorted itself"),
        ];
        for (n, b) in inbox {
            put(&d, &format!("Inbox/{n}"), b);
        }
        let g = gather(&d).unwrap();
        assert_eq!(g.items.len(), 10);
        let msg = compose(&g, "");
        let scratch = tmp();
        let spec = spec_for(&PassSpec::new("claude", Vec::new()), &scratch);
        let out = ClaudeCodeAgent::new(spec)
            .run_turn(msg.as_str(), &CancellationToken::new(), &mut |_| {})
            .await
            .expect("the CLI ran");
        println!("--- message chars: {}", msg.chars().count());
        println!("--- raw: {}", out.text);
        println!("--- model: {:?}", out.model);
        println!("--- usage: {:?}", out.usage);
        println!("--- cost_usd (CLI estimate): {:?}", out.cost_usd);
        assert!(!out.is_error, "{}", out.text);
        let plan = parse_plan(&out.text, &g).expect("a plan");
        for p in &plan {
            println!(
                "{} -> {:?} (tick {}, new {}) — {}",
                p.item, p.to, p.tick, p.new_folder, p.reason
            );
        }
        assert_eq!(plan.len(), 10);
        assert!(plan.iter().filter(|p| p.tick).count() >= 7);
        let _ = std::fs::remove_dir_all(&d);
        let _ = std::fs::remove_dir_all(&scratch);
    }
}
