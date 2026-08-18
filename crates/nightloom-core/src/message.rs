use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
}

/// Canonical content block. Modeled as a superset of provider formats;
/// adapters translate down and drop what a given API can't express.
/// Images and documents will be added as further variants.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[non_exhaustive]
pub enum ContentBlock {
    Text {
        text: String,
    },
    Thinking {
        text: String,
    },
    /// A tool invocation the model requested. Lives in assistant messages.
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    /// The outcome of executing a tool call. Lives in user messages, paired
    /// to its call by `tool_use_id`. `name` is carried redundantly because
    /// Gemini addresses results by function name, not call id.
    ToolResult {
        tool_use_id: String,
        name: String,
        content: String,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        is_error: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    pub content: Vec<ContentBlock>,
}

impl Message {
    pub fn user(text: impl Into<String>) -> Self {
        Self {
            role: Role::User,
            content: vec![ContentBlock::Text { text: text.into() }],
        }
    }

    pub fn assistant(content: Vec<ContentBlock>) -> Self {
        Self {
            role: Role::Assistant,
            content,
        }
    }

    /// Concatenated text of all `Text` blocks (thinking excluded).
    pub fn text(&self) -> String {
        self.content
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }
}
