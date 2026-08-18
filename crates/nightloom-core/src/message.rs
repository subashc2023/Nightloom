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
        /// Provider-issued integrity signature (Anthropic). Required to
        /// replay the block; unsigned thinking is dropped by adapters.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },
    /// Thinking the provider encrypted instead of streaming (Anthropic
    /// `redacted_thinking`). Opaque; replayed verbatim, dropped elsewhere.
    RedactedThinking {
        data: String,
    },
    /// A tool invocation the model requested. Lives in assistant messages.
    ToolUse {
        id: String,
        name: String,
        input: serde_json::Value,
        /// Opaque provider replay token for this call, kept verbatim so the
        /// call can be handed back on the next round. Gemini 3 issues one
        /// (`thoughtSignature`) and rejects a replayed call that arrives
        /// without it; nobody else signs tool calls today. An adapter must
        /// only replay a token it issued itself — the value is meaningless,
        /// and possibly a 4xx, to any other vendor.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        signature: Option<String>,
    },
    /// A handle to reasoning the provider retained on its own side (an
    /// OpenAI Responses `reasoning` item). Opaque and carrying no readable
    /// text — the human-visible summary is the neighbouring `Thinking`
    /// block — it exists purely so the reasoning can be replayed with the
    /// tool call it led to. Recorded in stream order; every adapter but the
    /// one that minted it drops the block.
    ReasoningRef {
        id: String,
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Logs written before tool calls carried a replay token have no
    /// `signature` key at all; they must still load.
    #[test]
    fn tool_use_without_signature_deserializes() {
        let json = r#"{"type":"tool_use","id":"c1","name":"add","input":{"a":1}}"#;
        let block: ContentBlock = serde_json::from_str(json).unwrap();
        match block {
            ContentBlock::ToolUse { id, signature, .. } => {
                assert_eq!(id, "c1");
                assert_eq!(signature, None);
            }
            other => panic!("expected tool_use, got {other:?}"),
        }
    }

    /// And an unsigned call must not start writing the key back out, so
    /// older readers keep seeing the shape they know.
    #[test]
    fn unsigned_tool_use_omits_the_signature_key() {
        let block = ContentBlock::ToolUse {
            id: "c1".into(),
            name: "add".into(),
            input: serde_json::json!({}),
            signature: None,
        };
        let v = serde_json::to_value(&block).unwrap();
        assert!(v.get("signature").is_none(), "serialized: {v}");
    }

    #[test]
    fn signed_tool_use_round_trips() {
        let block = ContentBlock::ToolUse {
            id: "c1".into(),
            name: "add".into(),
            input: serde_json::json!({ "a": 1 }),
            signature: Some("sig-abc".into()),
        };
        let text = serde_json::to_string(&block).unwrap();
        assert!(text.contains("\"signature\":\"sig-abc\""), "{text}");
        match serde_json::from_str::<ContentBlock>(&text).unwrap() {
            ContentBlock::ToolUse { signature, .. } => {
                assert_eq!(signature.as_deref(), Some("sig-abc"));
            }
            other => panic!("expected tool_use, got {other:?}"),
        }
    }

    #[test]
    fn reasoning_ref_round_trips() {
        let block = ContentBlock::ReasoningRef {
            id: "rs_123".into(),
        };
        let text = serde_json::to_string(&block).unwrap();
        assert_eq!(text, r#"{"type":"reasoning_ref","id":"rs_123"}"#);
        assert!(matches!(
            serde_json::from_str::<ContentBlock>(&text).unwrap(),
            ContentBlock::ReasoningRef { .. }
        ));
    }
}
