//! `mark_file` (nightshift backlog 377, 2026-10-18): the model says, for
//! each file or folder it makes, whether it is **for the user** — something
//! he should open: a report, a draft, a document he asked for — or **for
//! itself** — scratch, intermediate data, working notes. The desktop lists
//! the ones for him under a folder button in the top bar (a dot for new
//! ones) and near the top of the + new-tab list, each opening in a
//! Nightloom tab or in the Finder.
//!
//! A tool rather than a manifest the model writes itself, for the reasons
//! `send_file` is one (blocker 1386): a tool is listed on every request
//! with a fixed shape, and the path it names is one Nightloom checks — the
//! same [`Root`] every file tool is confined by, so `..`, an absolute path
//! elsewhere and a symlink out of the folder are refused. A file the model
//! edits by hand (`.agents/for-you.json`) would be JSON edited with two
//! engines' different write tools, by several chats at once, with nothing
//! checking the paths in it.
//!
//! **The record.** One JSON line per call ([`Mark`]) appended to
//! `<config>/for-you.jsonl` ([`manifest_in`]) — Nightloom's own folder, not
//! the project's: the project's `.agents` is committed notes about the
//! code, and an unfiled chat has no `.agents` at all. Append-only, never
//! rewritten: a later mark of the same path supersedes an earlier one
//! (marked for him, then for itself, leaves the list), and a path no longer
//! on disk drops out of the list but stays in the file. Appends of one short
//! line under `O_APPEND` do not interleave between chats.
//!
//! `Effect::Session`: it changes nothing of the user's — the file is only
//! looked at — so it needs no approval. Not served to a chat that writes
//! nothing (incognito, ephemeral): such a chat promised to leave no trace in
//! Nightloom's folder, and its files are not ones to point at later.

use std::io::Write as _;
use std::path::{Path, PathBuf};

use nightloom_core::ToolDef;
use nightloom_core::tool::{CancellationToken, Effect, Tool};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{Root, blocking, path_arg};

/// The tool's name on the API engine, and its middle on the CLI's:
/// `mcp__nightloom__mark_file`.
pub const NAME: &str = "mark_file";

/// The manifest's file name under the config dir.
pub const MANIFEST: &str = "for-you.jsonl";

/// The manifest under `config`.
pub fn manifest_in(config: &Path) -> PathBuf {
    config.join(MANIFEST)
}

/// Who a file is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum For {
    /// The user: something to open.
    User,
    /// The model itself: working material.
    #[serde(rename = "self")]
    Itself,
}

/// One mark, as a line of the manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Mark {
    /// When it was marked, RFC 3339 UTC.
    pub at: String,
    /// The file or folder, absolute (resolved through the chat's folder).
    pub path: String,
    #[serde(rename = "for")]
    pub for_: For,
    /// A folder rather than a file.
    #[serde(default)]
    pub folder: bool,
    /// The project's id, or none for an unfiled chat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// The chat's folder the path was resolved in, absolute.
    pub root: String,
    /// A few words of the model's about what it is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// Mark one path: the whole rule, synchronous, for the tool's blocking
/// thread and for tests.
pub fn mark(
    root: &Path,
    manifest: &Path,
    project: Option<&str>,
    arg: &str,
    for_: For,
    title: Option<String>,
) -> Result<Mark, String> {
    let outside = || {
        format!(
            "\"{arg}\" is outside this chat's folder ({}); mark_file marks only files and \
             folders inside it. If the user should have it, copy it into the folder first, \
             then mark the copy.",
            root.display()
        )
    };
    let path = Root::new(root.to_path_buf())
        .resolve(arg)
        .map_err(|_| outside())?;
    let meta = std::fs::metadata(&path).map_err(|_| {
        format!(
            "there is nothing at \"{arg}\" in this chat's folder ({}). Create the file or \
             folder first, then mark it.",
            root.display()
        )
    })?;
    let real = path.canonicalize().map_err(|e| e.to_string())?;
    let real_root = root.canonicalize().map_err(|_| outside())?;
    if !real.starts_with(&real_root) {
        return Err(outside());
    }
    let title = title
        .map(|t| t.trim().chars().take(200).collect::<String>())
        .filter(|t| !t.is_empty());
    let m = Mark {
        at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        path: real.to_string_lossy().into_owned(),
        for_,
        folder: meta.is_dir(),
        project: project.map(String::from),
        root: real_root.to_string_lossy().into_owned(),
        title,
    };
    append(manifest, &m).map_err(|e| format!("could not record the mark: {e}"))?;
    Ok(m)
}

fn append(manifest: &Path, m: &Mark) -> std::io::Result<()> {
    if let Some(dir) = manifest.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut line = serde_json::to_string(m).expect("plain fields serialize");
    line.push('\n');
    // One write of the whole line, so two chats appending at once cannot
    // interleave inside it.
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(manifest)?
        .write_all(line.as_bytes())
}

/// Every mark in the manifest, in the order made; unreadable lines skipped.
pub fn read_all(manifest: &Path) -> Vec<Mark> {
    std::fs::read_to_string(manifest)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

/// The marks standing now: the latest per path, newest first.
fn standing(marks: Vec<Mark>) -> Vec<Mark> {
    let mut latest: Vec<Mark> = Vec::new();
    for m in marks {
        latest.retain(|o| o.path != m.path);
        latest.push(m);
    }
    latest.reverse();
    latest
}

/// The files and folders standing as for the user in `project` (`None`:
/// the unfiled chats), newest first, at most `cap`, each still on disk.
pub fn for_user(manifest: &Path, project: Option<&str>, cap: usize) -> Vec<Mark> {
    standing(read_all(manifest))
        .into_iter()
        .filter(|m| m.for_ == For::User && m.project.as_deref() == project)
        .filter(|m| Path::new(&m.path).exists())
        .take(cap)
        .collect()
}

/// Whether `path` stands as marked for the user, in any project — the
/// file tab reads such a file without a chat to vouch for it, since the
/// mark was confined to a chat's folder when it was made.
pub fn is_for_user(manifest: &Path, path: &Path) -> bool {
    let Ok(real) = path.canonicalize() else {
        return false;
    };
    standing(read_all(manifest))
        .iter()
        .any(|m| m.for_ == For::User && Path::new(&m.path) == real)
}

/// The result the model reads.
pub fn result_text(m: &Mark) -> String {
    let what = if m.folder { "folder" } else { "file" };
    match m.for_ {
        For::User => format!(
            "Marked the {what} {} as for the user: it is listed under Nightloom's Files for \
             you button, where they can open it. Mention it in a sentence; do not paste its \
             contents.",
            m.path
        ),
        For::Itself => format!(
            "Marked the {what} {} as your own working material: it stays out of the user's \
             list.",
            m.path
        ),
    }
}

/// The tool. One per chat: `root` is the chat's folder, `manifest` where
/// marks go, `project` the chat's project id.
pub struct MarkFile {
    root: PathBuf,
    manifest: PathBuf,
    project: Option<String>,
}

impl MarkFile {
    pub fn new(
        root: impl Into<PathBuf>,
        manifest: impl Into<PathBuf>,
        project: Option<String>,
    ) -> Self {
        Self {
            root: root.into(),
            manifest: manifest.into(),
            project,
        }
    }
}

/// The tool's description — prompt text, on the API engine the only
/// instruction the model gets to tag what it makes.
pub const DESCRIPTION: &str = "Say who a file or folder you created is for. Call it once for \
     every new file or folder you make in this chat's folder, right after making it: for \
     \"user\" when it is something the user should open — a report, a draft, a document, a \
     table or a folder of results they asked for — and \"self\" when it is your own working \
     material — scratch files, intermediate data, notes to yourself. Files for the user are \
     listed in Nightloom under a Files for you button, one click to open; files for yourself \
     stay out of that list. Mark a folder once rather than every file in it. The path is \
     relative to this chat's folder (or absolute inside it).";

#[async_trait::async_trait]
impl Tool for MarkFile {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: NAME.into(),
            description: DESCRIPTION.into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "The file or folder, relative to this chat's folder (or absolute inside it)."
                    },
                    "for": {
                        "type": "string",
                        "enum": ["user", "self"],
                        "description": "\"user\" for something the user should open; \"self\" for your own working material."
                    },
                    "title": {
                        "type": "string",
                        "description": "Optional, for \"user\": a few words saying what it is, shown in the list."
                    }
                },
                "required": ["path", "for"]
            }),
        }
    }

    fn effect(&self) -> Effect {
        Effect::Session
    }

    async fn call(&self, input: Value, _cancel: &CancellationToken) -> Result<String, String> {
        let arg = path_arg(&input)?;
        let for_ = match input["for"].as_str() {
            Some("user") => For::User,
            Some("self") => For::Itself,
            _ => {
                return Err(
                    "\"for\" must be \"user\" (something the user should open) or \"self\" \
                     (your own working material); call mark_file again with one of them."
                        .into(),
                );
            }
        };
        let title = input["title"].as_str().map(String::from);
        let (root, manifest, project) = (
            self.root.clone(),
            self.manifest.clone(),
            self.project.clone(),
        );
        blocking(move || {
            mark(&root, &manifest, project.as_deref(), &arg, for_, title).map(|m| result_text(&m))
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::test_dir;

    fn setup(name: &str) -> (PathBuf, PathBuf) {
        let base = test_dir(&format!("mark-file-{name}"));
        let root = base.join("chat");
        std::fs::create_dir_all(&root).unwrap();
        (root, base.join("config").join(MANIFEST))
    }

    #[test]
    fn a_file_for_the_user_is_listed_and_one_for_itself_is_not() {
        let (root, manifest) = setup("listed");
        std::fs::write(root.join("report.md"), "# r").unwrap();
        std::fs::write(root.join("scratch.json"), "{}").unwrap();
        std::fs::create_dir_all(root.join("results")).unwrap();
        let p = Some("p1");
        let a = mark(
            &root,
            &manifest,
            p,
            "report.md",
            For::User,
            Some(" The report ".into()),
        )
        .unwrap();
        assert_eq!(a.title.as_deref(), Some("The report"));
        assert!(!a.folder);
        mark(&root, &manifest, p, "scratch.json", For::Itself, None).unwrap();
        let f = mark(&root, &manifest, p, "results", For::User, None).unwrap();
        assert!(f.folder);
        let listed: Vec<String> = for_user(&manifest, p, 10)
            .into_iter()
            .map(|m| m.path)
            .collect();
        let real = root.canonicalize().unwrap();
        assert_eq!(
            listed,
            vec![
                real.join("results").to_string_lossy().into_owned(),
                real.join("report.md").to_string_lossy().into_owned(),
            ],
            "newest first, the one for itself left out"
        );
        // Another project's list and the unfiled one do not see them.
        assert!(for_user(&manifest, Some("p2"), 10).is_empty());
        assert!(for_user(&manifest, None, 10).is_empty());
        assert!(is_for_user(&manifest, &root.join("report.md")));
        assert!(!is_for_user(&manifest, &root.join("scratch.json")));
        // The cap holds.
        assert_eq!(for_user(&manifest, p, 1).len(), 1);
    }

    #[test]
    fn a_later_mark_supersedes_and_a_deleted_file_drops_out_but_stays_recorded() {
        let (root, manifest) = setup("supersede");
        std::fs::write(root.join("a.md"), "a").unwrap();
        std::fs::write(root.join("b.md"), "b").unwrap();
        mark(&root, &manifest, None, "a.md", For::User, None).unwrap();
        mark(&root, &manifest, None, "b.md", For::User, None).unwrap();
        mark(&root, &manifest, None, "a.md", For::Itself, None).unwrap();
        let listed = for_user(&manifest, None, 10);
        assert_eq!(listed.len(), 1);
        assert!(listed[0].path.ends_with("b.md"));
        std::fs::remove_file(root.join("b.md")).unwrap();
        assert!(for_user(&manifest, None, 10).is_empty());
        assert_eq!(read_all(&manifest).len(), 3, "append-only: nothing erased");
    }

    #[test]
    fn a_path_outside_the_folder_or_missing_is_refused_in_words_and_not_recorded() {
        let (root, manifest) = setup("outside");
        let outside = root.parent().unwrap().join("elsewhere.md");
        std::fs::write(&outside, "x").unwrap();
        let e = mark(&root, &manifest, None, "../elsewhere.md", For::User, None).unwrap_err();
        assert!(e.contains("outside this chat's folder"), "{e}");
        let abs = outside.to_string_lossy().into_owned();
        assert!(mark(&root, &manifest, None, &abs, For::User, None).is_err());
        let e = mark(&root, &manifest, None, "nope.md", For::User, None).unwrap_err();
        assert!(e.contains("Create the file"), "{e}");
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, root.join("link.md")).unwrap();
            assert!(mark(&root, &manifest, None, "link.md", For::User, None).is_err());
        }
        assert!(read_all(&manifest).is_empty());
    }

    #[tokio::test]
    async fn the_tool_takes_user_or_self_and_says_what_happened() {
        let (root, manifest) = setup("tool");
        std::fs::write(root.join("x.md"), "x").unwrap();
        let tool = MarkFile::new(&root, &manifest, Some("p".into()));
        assert_eq!(tool.effect(), Effect::Session);
        let cancel = CancellationToken::new();
        let ok = tool
            .call(json!({"path": "x.md", "for": "user"}), &cancel)
            .await
            .unwrap();
        assert!(ok.contains("Files for you"), "{ok}");
        let bad = tool
            .call(json!({"path": "x.md", "for": "them"}), &cancel)
            .await
            .unwrap_err();
        assert!(bad.contains("\"user\""), "{bad}");
        assert_eq!(for_user(&manifest, Some("p"), 5).len(), 1);
    }
}
