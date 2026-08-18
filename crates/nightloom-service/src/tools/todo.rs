//! The model's task list.

use chrono::Utc;
use nightloom_core::tool::Tool;
use nightloom_core::{SessionEvent, TodoItem, TodoStatus, ToolDef};
use serde_json::{Value, json};
use std::sync::Mutex;

const TODO_WRITE_DESC: &str = "Record the task list for the work in progress. Always send the \
     WHOLE list, not a delta — it replaces the previous one. The current list is shown back to \
     you at the top of each turn, so this is how you keep track of multi-step work across \
     turns. Use it once a task needs three or more steps: write the plan out first, then \
     re-send the list with a task marked in_progress as you start it and completed the moment \
     it is done. Keep exactly one task in_progress at a time.";

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
            description: TODO_WRITE_DESC.into(),
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
}
