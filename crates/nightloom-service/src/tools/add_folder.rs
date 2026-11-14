//! `add_folder` (nightshift item 613, 2026-11-11): the model asks for a
//! folder outside the ones its chat may see — "look in my ICS 46 folder" —
//! and, once he allows it, the folder joins the chat's or the project's
//! Folders list, the same list the rail's *Add for this chat…* and *Add for
//! the project…* write (backlog 143), kept across turns the way the notes
//! vault is.
//!
//! **The tool grants nothing.** The grant is the approval card's, in the
//! turn's shell (`agent_turn`): the call is deferred by its own gate in
//! every position ([`GATE_MATCHER`], `ask::decide_in`), he sees the
//! folder on the card (backlog 143's "outside the folders this chat can
//! see" row), and his *Allow* makes the resume carry `--add-dir` — so the
//! folder is readable in the same turn — and records it on the chat's log
//! or in the project's registry. The shell then notes the grant in the
//! chat's directory ([`note_granted`]), and only then does the tool say
//! the folder was added: a call that reached the tool by any other road (a
//! side process, a position with no gate) is told plainly that nothing was
//! granted, so the model never reads a promise the CLI will not keep.
//!
//! **No card** for a folder inside the chat's working folder — the
//! project's folder on a Claude Code chat — which it can already read (the
//! gate allows it on the hook's `cwd`), nor for one already among its
//! folders (the shell answers for him). A path that is relative, not an
//! existing folder, the filesystem root or the home folder is refused
//! without a card ([`requested_dir`]).

use std::path::{Path, PathBuf};

use nightloom_core::ToolDef;
use nightloom_core::tool::{CancellationToken, Effect, Tool};
use serde_json::{Value, json};

/// The tool's name: `mcp__nightloom__add_folder` on the CLI.
pub const NAME: &str = "add_folder";

/// The gate's `PreToolUse` matcher: the tool alone, by its CLI name. The
/// Ask hook's `mcp__` alternative leaves it out (`ask::MATCHER`), since
/// the CLI runs every matching entry at once and two hooks on one call
/// would race for its one-shot decision file.
pub const GATE_MATCHER: &str = "mcp__nightloom__add_folder";

/// The file in the chat's directory where the shell notes each folder
/// his answer granted — `{"<dir>": "chat" | "project"}`.
pub const GRANTED_FILE: &str = "folders-granted.json";

/// The scope noted for a folder that was among the chat's folders before
/// the call ([`note_granted`]): nothing new was granted.
pub const ALREADY: &str = "already";

/// What the model reads when a subagent asks: no card can wait at that
/// depth (the CLI drops a deferral there).
pub const SUBAGENT_REFUSED: &str = "Not run: only the main chat can add a folder — no approval card can wait on a helper. Say in your report which folder you need and why.";

/// What a side process (an aside, a checkpoint fork) reads: no card waits
/// on it either.
pub const SIDE_REFUSED: &str =
    "Not run: a folder can be added only from the chat itself, where the user can approve it.";

/// Who keeps a folder: the chat, or every chat in the project.
pub fn requested_scope(input: &Value) -> &'static str {
    match input.get("scope").and_then(Value::as_str).map(str::trim) {
        Some("project") => "project",
        _ => "chat",
    }
}

/// The folder a call asks for, checked: absolute (a leading `~` is the
/// home folder), an existing directory, and neither `/` nor the home
/// folder itself — a grant of either is everything. The `Err` is what
/// the model reads.
pub fn requested_dir(input: &Value) -> Result<PathBuf, String> {
    let raw = input
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "add_folder needs `path`: the folder's absolute path.".to_string())?;
    let home = home_dir();
    let path = match (raw.strip_prefix('~'), &home) {
        (Some(rest), Some(h)) if rest.is_empty() || rest.starts_with('/') => {
            h.join(rest.trim_start_matches('/'))
        }
        _ => PathBuf::from(raw),
    };
    if !path.has_root() {
        return Err(format!(
            "Not added: {raw} is not an absolute path. Give the folder's full path (find it with Glob or ls first if you need to)."
        ));
    }
    let path = normalise(&path);
    if path.parent().is_none() || home.as_deref().is_some_and(|h| normalise(h) == path) {
        return Err(format!(
            "Not added: {} is too broad to grant. Ask for the folder you need inside it.",
            path.display()
        ));
    }
    if !path.is_dir() {
        return Err(format!(
            "Not added: {} is not a folder on this computer. Check the path (Glob or ls a parent you can see), or ask the user where it is.",
            path.display()
        ));
    }
    Ok(path)
}

/// `.` and `..` resolved by hand, without touching the disk, and a
/// trailing slash dropped — so `starts_with` against the trees compares
/// like with like.
fn normalise(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

fn home_dir() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .filter(|h| !h.is_empty())
        .or_else(|| std::env::var("USERPROFILE").ok().filter(|h| !h.is_empty()))
        .map(PathBuf::from)
}

/// Whether `dir` is one of `trees` or inside one.
pub fn inside(dir: &Path, trees: &[PathBuf]) -> bool {
    trees
        .iter()
        .filter(|t| !t.as_os_str().is_empty())
        .any(|t| dir.starts_with(normalise(t)))
}

fn read_granted(chat_dir: &Path) -> serde_json::Map<String, Value> {
    std::fs::read(chat_dir.join(GRANTED_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| match v {
            Value::Object(m) => Some(m),
            _ => None,
        })
        .unwrap_or_default()
}

/// The shell's note, after his answer granted `dir` (`scope` as kept:
/// `chat`, or `project`), for the tool to read when the resumed call runs.
pub fn note_granted(chat_dir: &Path, dir: &Path, scope: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(chat_dir)?;
    let mut map = read_granted(chat_dir);
    map.insert(dir.to_string_lossy().into_owned(), json!(scope));
    let tmp = chat_dir.join(format!("{GRANTED_FILE}.tmp"));
    std::fs::write(&tmp, serde_json::to_vec(&Value::Object(map))?)?;
    std::fs::rename(tmp, chat_dir.join(GRANTED_FILE))
}

/// Who keeps `dir`, if the shell noted a grant of it in this chat.
pub fn granted_scope(chat_dir: &Path, dir: &Path) -> Option<String> {
    read_granted(chat_dir)
        .get(&*dir.to_string_lossy())
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// `add_folder`, served beside `set_budget` (the chat's directory named),
/// to a chat that writes.
pub struct AddFolder {
    /// The chat's directory, where the shell notes the grants.
    chat_dir: PathBuf,
    /// The chat's working folder, when the server was told it.
    root: Option<PathBuf>,
}

impl AddFolder {
    pub fn new(chat_dir: impl Into<PathBuf>, root: Option<PathBuf>) -> Self {
        Self {
            chat_dir: chat_dir.into(),
            root,
        }
    }
}

#[async_trait::async_trait]
impl Tool for AddFolder {
    fn effect(&self) -> Effect {
        // It widens what the chat may read: the card asks first.
        Effect::Mutating
    }

    fn def(&self) -> ToolDef {
        ToolDef {
            name: NAME.into(),
            description: "Add a folder outside the ones this chat can see to its Folders \
                 list, so you can read it now and in later turns. Call it when the user asks \
                 you to look in a folder on their computer that is outside your working \
                 folder (\"look in my ICS 46 folder\"): find its absolute path first if you \
                 need to, then call this, then read it with Read, Glob or Grep by that path. \
                 The user approves it on a card; a folder inside your working folder needs \
                 no call. scope chat (the default) keeps it for this chat; scope project \
                 for every chat in the project — use project only when the user says so. \
                 The main chat only, never a subagent."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "The folder's absolute path (a leading ~ is the home folder)."
                    },
                    "scope": {
                        "type": "string",
                        "enum": ["chat", "project"],
                        "description": "Who keeps it: this chat (default) or every chat in the project."
                    },
                    "why": {
                        "type": "string",
                        "description": "One line for the card: what you will look for there."
                    }
                },
                "required": ["path"]
            }),
        }
    }

    async fn call(&self, input: Value, _cancel: &CancellationToken) -> Result<String, String> {
        let dir = requested_dir(&input)?;
        if let Some(root) = &self.root
            && inside(&dir, std::slice::from_ref(root))
        {
            return Ok(format!(
                "{} is inside your working folder: read it directly, nothing needed adding.",
                dir.display()
            ));
        }
        match granted_scope(&self.chat_dir, &dir) {
            Some(scope) if scope == ALREADY => Ok(format!(
                "{} is already one of this chat's folders: read it directly with Read, Glob or Grep by its absolute path.",
                dir.display()
            )),
            Some(scope) => {
                let who = if scope == "project" {
                    "every chat in this project"
                } else {
                    "this chat"
                };
                Ok(format!(
                    "Added {} for {who}: it is in the Folders list in Nightloom's right column and stays for later turns. Read it now with Read, Glob or Grep by its absolute path.",
                    dir.display()
                ))
            }
            None => Err(format!(
                "Not added: {} was not granted — the user's approval did not reach this call. Ask the user to add it from Folders in the right column, or call add_folder again from the main chat.",
                dir.display()
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "nl-613-{name}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_relative_missing_or_too_broad_path_is_refused_in_words() {
        assert!(requested_dir(&json!({})).is_err());
        let e = requested_dir(&json!({"path": "ics46"})).unwrap_err();
        assert!(e.contains("absolute"), "{e}");
        let e = requested_dir(&json!({"path": "/"})).unwrap_err();
        assert!(e.contains("too broad"), "{e}");
        let e = requested_dir(&json!({"path": "/no/such/folder/613"})).unwrap_err();
        assert!(e.contains("not a folder"), "{e}");
        let d = temp("ok");
        let with_dots = format!("{}/./x/..", d.display());
        assert_eq!(requested_dir(&json!({"path": with_dots})).unwrap(), d);
    }

    #[test]
    fn the_scope_is_the_chat_unless_the_project_is_named() {
        assert_eq!(requested_scope(&json!({})), "chat");
        assert_eq!(requested_scope(&json!({"scope": "nonsense"})), "chat");
        assert_eq!(requested_scope(&json!({"scope": "project"})), "project");
    }

    #[test]
    fn inside_compares_whole_components() {
        let trees = vec![PathBuf::from("/p/ics")];
        assert!(inside(Path::new("/p/ics/hw1"), &trees));
        assert!(!inside(Path::new("/p/ics46"), &trees));
        assert!(!inside(Path::new("/p/ics46"), &[PathBuf::new()]));
    }

    #[tokio::test]
    async fn the_tool_says_added_only_after_the_shell_noted_the_grant() {
        let chat = temp("chat");
        let folder = temp("ics46");
        let tool = AddFolder::new(&chat, Some(PathBuf::from("/somewhere/else")));
        let call = json!({"path": folder.to_string_lossy(), "scope": "chat"});
        let e = tool
            .call(call.clone(), &CancellationToken::new())
            .await
            .unwrap_err();
        assert!(e.contains("was not granted"), "{e}");
        note_granted(&chat, &folder, "project").unwrap();
        let ok = tool.call(call, &CancellationToken::new()).await.unwrap();
        assert!(ok.contains("every chat in this project"), "{ok}");
    }

    #[tokio::test]
    async fn a_folder_inside_the_working_folder_needs_nothing() {
        let root = temp("root");
        std::fs::create_dir_all(root.join("notes")).unwrap();
        let tool = AddFolder::new(temp("chat2"), Some(root.clone()));
        let ok = tool
            .call(
                json!({"path": root.join("notes").to_string_lossy()}),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(ok.contains("inside your working folder"), "{ok}");
    }
}
