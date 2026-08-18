//! Built-in tools: enough capability to exercise the tool-call round trip
//! without any external dependencies. Every shell (CLI, desktop) offers the
//! same set.

use chrono::{Local, Utc};
use nightloom_core::tool::Tool;
use nightloom_core::{SessionEvent, TodoItem, TodoStatus, ToolDef};
use serde_json::{Value, json};
use std::fs;
use std::sync::Mutex;

const READ_LIMIT: usize = 16 * 1024;

pub fn builtin() -> Vec<Box<dyn Tool>> {
    vec![
        Box::new(CurrentTime),
        Box::new(ReadFile),
        Box::new(ListDir),
        Box::new(TodoWrite::default()),
    ]
}

fn path_arg(input: &Value) -> Result<String, String> {
    input["path"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| "missing required argument: path".to_string())
}

struct CurrentTime;

#[async_trait::async_trait]
impl Tool for CurrentTime {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "current_time".into(),
            description: "Get the current date and time, local and UTC.".into(),
            input_schema: json!({ "type": "object", "properties": {} }),
        }
    }

    async fn call(&self, _input: Value) -> Result<String, String> {
        Ok(format!(
            "local: {}\nutc:   {}",
            Local::now().format("%Y-%m-%d %H:%M:%S %:z"),
            Utc::now().format("%Y-%m-%d %H:%M:%S UTC"),
        ))
    }
}

struct ReadFile;

#[async_trait::async_trait]
impl Tool for ReadFile {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "read_file".into(),
            description: "Read a UTF-8 text file. Output is truncated to 16 KiB.".into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Path of the file to read" }
                },
                "required": ["path"]
            }),
        }
    }

    async fn call(&self, input: Value) -> Result<String, String> {
        let path = path_arg(&input)?;
        let bytes = fs::read(&path).map_err(|e| format!("cannot read {path}: {e}"))?;
        let text = String::from_utf8(bytes).map_err(|_| format!("{path} is not valid UTF-8"))?;
        Ok(truncated(text))
    }
}

fn truncated(text: String) -> String {
    if text.len() <= READ_LIMIT {
        return text;
    }
    let mut cut = READ_LIMIT;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}… (truncated)", &text[..cut])
}

struct ListDir;

#[async_trait::async_trait]
impl Tool for ListDir {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "list_dir".into(),
            description: "List directory entries, one per line; directories end with '/'.".into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Path of the directory to list" }
                },
                "required": ["path"]
            }),
        }
    }

    async fn call(&self, input: Value) -> Result<String, String> {
        let path = path_arg(&input)?;
        let entries = fs::read_dir(&path).map_err(|e| format!("cannot list {path}: {e}"))?;
        let mut lines = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|e| format!("cannot list {path}: {e}"))?;
            let mut name = entry.file_name().to_string_lossy().into_owned();
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                name.push('/');
            }
            lines.push(name);
        }
        lines.sort();
        Ok(lines.join("\n"))
    }
}

/// The model's scratchpad.
///
/// The tool call itself is only half of it: what makes a task list actually
/// steer a long task is the read-back. Writes land in the session log as
/// [`SessionEvent::TodoState`] via [`Tool::drain_events`], and the per-turn
/// sidecar renders the current list into every following turn. Without that
/// loop the model plans once and then forgets it planned.
#[derive(Default)]
pub struct TodoWrite {
    /// Set by `call`, taken by `drain_events` once the turn engine records
    /// it. `Tool::call` takes `&self`, so the handoff needs interior
    /// mutability; the alternative is handing tools a `&mut Session`.
    pending: Mutex<Option<Vec<TodoItem>>>,
}

#[async_trait::async_trait]
impl Tool for TodoWrite {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: "todo_write".into(),
            description: "Record the task list for the work in progress. Always send the                  WHOLE list, not a delta — it replaces the previous one. The current list is                  shown back to you at the top of each turn, so this is how you keep track of                  multi-step work across turns. Use it once a task needs three or more steps:                  write the plan out first, then re-send the list with a task marked                  in_progress as you start it and completed the moment it is done. Keep exactly                  one task in_progress at a time."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "todos": {
                        "type": "array",
                        "description": "The complete task list, in order.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "content": {
                                    "type": "string",
                                    "description": "The task, as a short imperative phrase."
                                },
                                "status": {
                                    "type": "string",
                                    "enum": ["pending", "in_progress", "completed"]
                                }
                            },
                            "required": ["content", "status"]
                        }
                    }
                },
                "required": ["todos"]
            }),
        }
    }

    async fn call(&self, input: Value) -> Result<String, String> {
        let items = input["todos"]
            .as_array()
            .ok_or_else(|| "missing required argument: todos (an array)".to_string())?;
        let mut todos = Vec::with_capacity(items.len());
        for (i, item) in items.iter().enumerate() {
            let content = item["content"]
                .as_str()
                .ok_or_else(|| format!("todos[{i}]: missing \"content\""))?;
            let status = match item["status"].as_str() {
                Some("pending") => TodoStatus::Pending,
                Some("in_progress") => TodoStatus::InProgress,
                Some("completed") => TodoStatus::Completed,
                other => {
                    return Err(format!(
                        "todos[{i}]: status must be pending, in_progress, or completed (got {other:?})"
                    ));
                }
            };
            todos.push(TodoItem::new(content, status));
        }
        let open = todos
            .iter()
            .filter(|t| t.status != TodoStatus::Completed)
            .count();
        let summary = format!("Task list updated: {} tasks, {open} open.", todos.len());
        *self.pending.lock().unwrap() = Some(todos);
        Ok(summary)
    }

    fn drain_events(&self) -> Vec<SessionEvent> {
        match self.pending.lock().unwrap().take() {
            Some(todos) => vec![SessionEvent::TodoState {
                todos,
                at: Utc::now(),
            }],
            None => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nightloom_core::tool::run_tool;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("nightloom-tools-{}-{name}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn current_time_reports_local_and_utc() {
        let out = CurrentTime.call(json!({})).await.unwrap();
        assert!(out.starts_with("local: "));
        assert!(out.contains("\nutc:   "));
        assert!(out.ends_with(" UTC"));
    }

    #[tokio::test]
    async fn read_file_truncates_large_files() {
        let dir = temp_dir("read");
        let path = dir.join("big.txt");
        fs::write(&path, "x".repeat(READ_LIMIT + 100)).unwrap();
        let out = ReadFile
            .call(json!({ "path": path.to_str().unwrap() }))
            .await
            .unwrap();
        assert!(out.ends_with("… (truncated)"));
        assert_eq!(out.len(), READ_LIMIT + "… (truncated)".len());
        fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn read_file_errors_on_missing_and_non_utf8() {
        let dir = temp_dir("read-err");
        let missing = ReadFile
            .call(json!({ "path": dir.join("nope.txt").to_str().unwrap() }))
            .await;
        assert!(missing.unwrap_err().contains("cannot read"));

        let binary = dir.join("bin.dat");
        fs::write(&binary, [0xff, 0xfe, 0x00, 0x80]).unwrap();
        let err = ReadFile
            .call(json!({ "path": binary.to_str().unwrap() }))
            .await
            .unwrap_err();
        assert!(err.contains("not valid UTF-8"));
        fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn list_dir_marks_directories() {
        let dir = temp_dir("list");
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("file.txt"), "hi").unwrap();
        let out = ListDir
            .call(json!({ "path": dir.to_str().unwrap() }))
            .await
            .unwrap();
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines, ["file.txt", "sub/"]);
        fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn todo_write_stages_one_event_per_write() {
        let tool = TodoWrite::default();
        let out = tool
            .call(json!({"todos": [
                {"content": "read the config", "status": "completed"},
                {"content": "wire the sidecar", "status": "in_progress"}
            ]}))
            .await
            .unwrap();
        assert_eq!(out, "Task list updated: 2 tasks, 1 open.");

        let events = tool.drain_events();
        assert_eq!(events.len(), 1);
        match &events[0] {
            SessionEvent::TodoState { todos, .. } => {
                assert_eq!(todos.len(), 2);
                assert_eq!(todos[1].status, TodoStatus::InProgress);
            }
            other => panic!("unexpected event: {other:?}"),
        }
        // Drained once; a second drain must not re-record the same list.
        assert!(tool.drain_events().is_empty());
    }

    #[tokio::test]
    async fn todo_write_rejects_a_bad_status_without_staging() {
        let tool = TodoWrite::default();
        let err = tool
            .call(json!({"todos": [{"content": "x", "status": "done"}]}))
            .await
            .unwrap_err();
        assert!(err.contains("status must be"), "{err}");
        assert!(tool.drain_events().is_empty());
    }

    #[tokio::test]
    async fn unknown_tool_becomes_error_result() {
        let tools = builtin();
        let block = run_tool(&tools, "c1", "no_such_tool", json!({})).await;
        assert!(matches!(
            block,
            nightloom_core::ContentBlock::ToolResult { is_error: true, .. }
        ));
    }
}
