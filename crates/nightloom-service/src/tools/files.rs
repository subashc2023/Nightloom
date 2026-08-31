//! Reading, writing, and editing files inside the workspace root.

use super::{Root, path_arg, str_arg, truncated};
use nightloom_core::ToolDef;
use nightloom_core::tool::{CancellationToken, Effect, Tool};
use serde_json::{Value, json};
use std::fs;

const READ_FILE_DESC: &str = "Read a UTF-8 text file from the workspace. Always read a file \
     before editing it: edit_file needs the exact existing text, and guessing at it wastes a \
     round trip. Output is truncated at 16 KiB, so for a large file use grep to find the region \
     you care about first.";

const WRITE_FILE_DESC: &str = "Write a file, creating any missing parent directories. An \
     existing file is overwritten in full. Prefer edit_file for changing a file that already \
     exists — rewriting a whole file to change a few lines is slow, loses anything you did not \
     remember to reproduce, and is the most common way to accidentally revert someone else's \
     work. Use this to create new files, or when a file is being replaced wholesale.";

const EDIT_FILE_DESC: &str = "Replace an exact string in a file. This is the preferred way to \
     change existing code. Read the file first and copy old_string from what you read, \
     character for character including indentation; the match is literal, not a regex or a \
     fuzzy match. old_string must identify exactly one place in the file, so include enough \
     surrounding lines to make it unique — a bare identifier or a lone closing brace will not \
     be. Set replace_all when you intend to change every occurrence, such as renaming a symbol.";

const LIST_DIR_DESC: &str = "List the entries of a directory, one per line, with directories \
     marked by a trailing '/'. Use this to orient yourself in an unfamiliar part of the tree. \
     When you are looking for files by name or extension use glob instead, and when you are \
     looking for files by their contents use grep — both search the tree in one call rather \
     than walking it a directory at a time.";

pub struct ReadFile {
    root: Root,
}

impl ReadFile {
    pub fn new(root: Root) -> Self {
        Self { root }
    }
}

#[async_trait::async_trait]
impl Tool for ReadFile {
    fn effect(&self) -> Effect {
        Effect::ReadOnly
    }

    fn def(&self) -> ToolDef {
        ToolDef {
            name: "read_file".into(),
            description: READ_FILE_DESC.into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": format!(
                            "File to read, relative to the workspace root.{}",
                            self.root.path_hint()
                        )
                    }
                },
                "required": ["path"]
            }),
        }
    }

    async fn call(&self, input: Value, _cancel: &CancellationToken) -> Result<String, String> {
        let arg = path_arg(&input)?;
        let path = self.root.resolve(&arg)?;
        let shown = self.root.show(&path);
        let bytes = fs::read(&path).map_err(|e| format!("cannot read {shown}: {e}"))?;
        let text = String::from_utf8(bytes)
            .map_err(|_| format!("{shown} is not valid UTF-8; it looks like a binary file"))?;
        Ok(truncated(text))
    }
}

pub struct WriteFile {
    root: Root,
}

impl WriteFile {
    pub fn new(root: Root) -> Self {
        Self { root }
    }
}

#[async_trait::async_trait]
// No `effect` override: writing a file changes the workspace, which is
// what the `Mutating` default already says. Same for `EditFile` below.
impl Tool for WriteFile {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "write_file".into(),
            description: WRITE_FILE_DESC.into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": format!(
                            "File to write, relative to the workspace root. Missing parent \
                             directories are created.{}",
                            self.root.path_hint()
                        )
                    },
                    "content": {
                        "type": "string",
                        "description": "The complete contents of the file."
                    }
                },
                "required": ["path", "content"]
            }),
        }
    }

    async fn call(&self, input: Value, _cancel: &CancellationToken) -> Result<String, String> {
        let arg = path_arg(&input)?;
        let content = str_arg(&input, "content")?;
        let path = self.root.resolve(&arg)?;
        let shown = self.root.show(&path);
        if path.is_dir() {
            return Err(format!("{shown} is a directory, not a file"));
        }
        let existed = path.exists();
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            fs::create_dir_all(parent)
                .map_err(|e| format!("cannot create the parent directory of {shown}: {e}"))?;
        }
        fs::write(&path, content.as_bytes()).map_err(|e| format!("cannot write {shown}: {e}"))?;
        let verb = if existed { "Overwrote" } else { "Created" };
        Ok(format!("{verb} {shown} ({} bytes)", content.len()))
    }
}

pub struct EditFile {
    root: Root,
}

impl EditFile {
    pub fn new(root: Root) -> Self {
        Self { root }
    }
}

#[async_trait::async_trait]
impl Tool for EditFile {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "edit_file".into(),
            description: EDIT_FILE_DESC.into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": format!(
                            "File to edit, relative to the workspace root.{}",
                            self.root.path_hint()
                        )
                    },
                    "old_string": {
                        "type": "string",
                        "description": "Exact text to replace, copied from the file. Must match one place unless replace_all is set."
                    },
                    "new_string": {
                        "type": "string",
                        "description": "Text to put in its place. Use an empty string to delete."
                    },
                    "replace_all": {
                        "type": "boolean",
                        "description": "Replace every occurrence instead of requiring a unique match. Defaults to false."
                    }
                },
                "required": ["path", "old_string", "new_string"]
            }),
        }
    }

    async fn call(&self, input: Value, _cancel: &CancellationToken) -> Result<String, String> {
        let arg = path_arg(&input)?;
        let old = str_arg(&input, "old_string")?;
        let new = str_arg(&input, "new_string")?;
        let replace_all = input["replace_all"].as_bool().unwrap_or(false);
        if old.is_empty() {
            return Err(
                "old_string is empty. edit_file replaces existing text; to create a \
                        file, use write_file."
                    .to_string(),
            );
        }
        if old == new {
            return Err(
                "old_string and new_string are identical, so this edit would change nothing. \
                 Send the text you actually want in place of old_string."
                    .to_string(),
            );
        }

        let path = self.root.resolve(&arg)?;
        let shown = self.root.show(&path);
        let bytes = fs::read(&path).map_err(|e| format!("cannot read {shown}: {e}"))?;
        let text = String::from_utf8(bytes)
            .map_err(|_| format!("{shown} is not valid UTF-8; it looks like a binary file"))?;

        // These two errors are prompts, not log lines: they are handed back to
        // the model as the tool result, so they say what to do next rather
        // than only what went wrong.
        let count = text.matches(&old).count();
        if count == 0 {
            return Err(format!(
                "old_string was not found in {shown}. The match is literal — whitespace, \
                 indentation and line endings all have to be identical. Read {shown} again and \
                 copy the text to replace straight out of what you read."
            ));
        }
        if count > 1 && !replace_all {
            return Err(format!(
                "old_string matches {count} places in {shown}, so it is ambiguous. Do not retry \
                 the same string: extend old_string with the lines above and below the one \
                 occurrence you mean until it is unique, or set replace_all to true to change \
                 all {count}."
            ));
        }

        let edited = if replace_all {
            text.replace(&old, &new)
        } else {
            text.replacen(&old, &new, 1)
        };
        fs::write(&path, edited.as_bytes()).map_err(|e| format!("cannot write {shown}: {e}"))?;
        let changed = if replace_all { count } else { 1 };
        let plural = if changed == 1 { "" } else { "s" };
        Ok(format!(
            "Edited {shown}: replaced {changed} occurrence{plural}."
        ))
    }
}

pub struct ListDir {
    root: Root,
}

impl ListDir {
    pub fn new(root: Root) -> Self {
        Self { root }
    }
}

#[async_trait::async_trait]
impl Tool for ListDir {
    fn effect(&self) -> Effect {
        Effect::ReadOnly
    }

    fn def(&self) -> ToolDef {
        ToolDef {
            name: "list_dir".into(),
            description: LIST_DIR_DESC.into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": format!(
                            "Directory to list, relative to the workspace root. Defaults to the \
                             root.{}",
                            self.root.path_hint()
                        )
                    }
                }
            }),
        }
    }

    async fn call(&self, input: Value, _cancel: &CancellationToken) -> Result<String, String> {
        let arg = input["path"].as_str().unwrap_or(".").to_string();
        let path = self.root.resolve(&arg)?;
        let shown = self.root.show(&path);
        let entries = fs::read_dir(&path).map_err(|e| format!("cannot list {shown}: {e}"))?;
        let mut lines = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|e| format!("cannot list {shown}: {e}"))?;
            let mut name = entry.file_name().to_string_lossy().into_owned();
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                name.push('/');
            }
            lines.push(name);
        }
        lines.sort();
        if lines.is_empty() {
            return Ok(format!("{shown} is empty"));
        }
        Ok(truncated(lines.join("\n")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{READ_LIMIT, test_dir};

    fn tools(dir: &std::path::Path) -> (ReadFile, WriteFile, EditFile, ListDir) {
        let root = Root::new(dir);
        (
            ReadFile::new(root.clone()),
            WriteFile::new(root.clone()),
            EditFile::new(root.clone()),
            ListDir::new(root),
        )
    }

    #[tokio::test]
    async fn write_then_read_round_trips_through_nested_directories() {
        let dir = test_dir("files-round-trip");
        let (read, write, ..) = tools(&dir);

        let created = write
            .call(
                json!({ "path": "a/b/note.txt", "content": "hello" }),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(created, "Created a/b/note.txt (5 bytes)");

        let back = read
            .call(json!({ "path": "a/b/note.txt" }), &CancellationToken::new())
            .await
            .unwrap();
        assert_eq!(back, "hello");

        let again = write
            .call(
                json!({ "path": "a/b/note.txt", "content": "goodbye" }),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(again, "Overwrote a/b/note.txt (7 bytes)");
        fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn read_file_truncates_large_files() {
        let dir = test_dir("files-truncate");
        let (read, ..) = tools(&dir);
        fs::write(dir.join("big.txt"), "x".repeat(READ_LIMIT + 100)).unwrap();
        let out = read
            .call(json!({ "path": "big.txt" }), &CancellationToken::new())
            .await
            .unwrap();
        assert!(out.ends_with("… (truncated)"));
        assert_eq!(out.len(), READ_LIMIT + "… (truncated)".len());
        fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn read_file_errors_on_missing_and_non_utf8() {
        let dir = test_dir("files-read-err");
        let (read, ..) = tools(&dir);
        let missing = read
            .call(json!({ "path": "nope.txt" }), &CancellationToken::new())
            .await;
        assert!(missing.unwrap_err().contains("cannot read"));

        fs::write(dir.join("bin.dat"), [0xff, 0xfe, 0x00, 0x80]).unwrap();
        let err = read
            .call(json!({ "path": "bin.dat" }), &CancellationToken::new())
            .await
            .unwrap_err();
        assert!(err.contains("not valid UTF-8"));
        fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn path_arguments_cannot_escape_the_root() {
        let dir = test_dir("files-escape");
        let (read, write, ..) = tools(&dir);

        let relative = read
            .call(
                json!({ "path": "../../secrets" }),
                &CancellationToken::new(),
            )
            .await;
        assert!(
            relative.unwrap_err().contains("outside the workspace root"),
            "relative escape must be rejected"
        );

        let outside = dir.parent().unwrap().join("escaped.txt");
        let absolute = write
            .call(
                json!({ "path": outside.to_str().unwrap(), "content": "nope" }),
                &CancellationToken::new(),
            )
            .await;
        assert!(absolute.unwrap_err().contains("outside the workspace root"));
        assert!(!outside.exists(), "the write must not have happened");
        fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn edit_file_replaces_a_unique_match() {
        let dir = test_dir("files-edit-one");
        let (_, _, edit, _) = tools(&dir);
        fs::write(dir.join("s.txt"), "alpha\nbeta\ngamma\n").unwrap();
        let out = edit
            .call(
                json!({ "path": "s.txt", "old_string": "beta", "new_string": "BETA" }),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(out, "Edited s.txt: replaced 1 occurrence.");
        assert_eq!(
            fs::read_to_string(dir.join("s.txt")).unwrap(),
            "alpha\nBETA\ngamma\n"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn edit_file_reports_the_occurrence_count_when_ambiguous() {
        let dir = test_dir("files-edit-ambiguous");
        let (_, _, edit, _) = tools(&dir);
        fs::write(dir.join("s.txt"), "x = 1;\ny = 1;\nz = 1;\n").unwrap();
        let err = edit
            .call(
                json!({ "path": "s.txt", "old_string": "= 1;", "new_string": "= 2;" }),
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert!(err.contains("matches 3 places"), "{err}");
        assert!(err.contains("replace_all"), "{err}");
        // Nothing was written.
        assert_eq!(
            fs::read_to_string(dir.join("s.txt")).unwrap(),
            "x = 1;\ny = 1;\nz = 1;\n"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn edit_file_replace_all_changes_every_occurrence() {
        let dir = test_dir("files-edit-all");
        let (_, _, edit, _) = tools(&dir);
        fs::write(dir.join("s.txt"), "old old old\n").unwrap();
        let out = edit
            .call(
                json!({
                    "path": "s.txt",
                    "old_string": "old",
                    "new_string": "new",
                    "replace_all": true
                }),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(out, "Edited s.txt: replaced 3 occurrences.");
        assert_eq!(
            fs::read_to_string(dir.join("s.txt")).unwrap(),
            "new new new\n"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn edit_file_explains_a_missing_match() {
        let dir = test_dir("files-edit-missing");
        let (_, _, edit, _) = tools(&dir);
        fs::write(dir.join("s.txt"), "alpha\n").unwrap();
        let err = edit
            .call(
                json!({ "path": "s.txt", "old_string": "omega", "new_string": "x" }),
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert!(err.contains("was not found"), "{err}");
        assert!(err.contains("literal"), "{err}");
        fs::remove_dir_all(&dir).ok();
    }

    /// The docspace is inside the workspace, so the tools reach it with no
    /// special case at all — which is the argument for putting it there.
    #[tokio::test]
    async fn the_docspace_is_readable_and_writable_as_an_ordinary_path() {
        let dir = test_dir("files-docspace");
        let (read, write, ..) = tools(&dir);
        fs::create_dir_all(dir.join(".agents")).unwrap();
        fs::write(dir.join(".agents").join("decisions.md"), "# Decisions").unwrap();

        let out = read
            .call(
                json!({ "path": ".agents/decisions.md" }),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(out.contains("# Decisions"), "{out}");

        // A new note in a subdirectory: `write_file` creates parents, which is
        // why the docspace needs no tool of its own.
        write
            .call(
                json!({ "path": ".agents/plans/next.md", "content": "plan" }),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            fs::read_to_string(dir.join(".agents").join("plans").join("next.md")).unwrap(),
            "plan"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn list_dir_marks_directories_and_defaults_to_the_root() {
        let dir = test_dir("files-list");
        let (.., list) = tools(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("file.txt"), "hi").unwrap();
        let out = list
            .call(json!({}), &CancellationToken::new())
            .await
            .unwrap();
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines, ["file.txt", "sub/"]);
        fs::remove_dir_all(&dir).ok();
    }
}
