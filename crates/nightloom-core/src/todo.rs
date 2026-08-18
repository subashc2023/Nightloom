//! The model's task list.
//!
//! A scratchpad only helps if the loop closes: the model writes the list
//! through a tool, the log keeps it, and the per-turn sidecar reads it back.
//! Core owns the data and the log variant; the tool that writes it and the
//! sidecar part that renders it live in `nightloom-service`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Completed,
}

impl TodoStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            TodoStatus::Pending => "pending",
            TodoStatus::InProgress => "in_progress",
            TodoStatus::Completed => "completed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TodoItem {
    pub content: String,
    pub status: TodoStatus,
}

impl TodoItem {
    pub fn new(content: impl Into<String>, status: TodoStatus) -> Self {
        Self {
            content: content.into(),
            status,
        }
    }
}
