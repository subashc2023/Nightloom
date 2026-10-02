use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    User,
    Assistant,
}

/// Canonical content block. Modeled as a superset of provider formats;
/// adapters translate down and drop what a given API can't express.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[non_exhaustive]
pub enum ContentBlock {
    Text {
        text: String,
    },
    /// An image supplied by the user. Lives in user messages; no model emits
    /// one, so an adapter that meets one in an assistant message drops it.
    ///
    /// The bytes are carried inline rather than by path or URL because the
    /// session log is the source of truth and has to replay on its own: a
    /// path stops meaning anything the moment the file is moved or the log
    /// is opened on another machine, and a remote URL hands replay to
    /// whoever is still hosting it. Inline base64 costs log size and buys a
    /// transcript that stays valid.
    Image {
        /// IANA media type, e.g. `image/png`. Adapters that name the type
        /// separately use it as-is; the ones that want a data URL build one.
        media_type: String,
        /// Base64-encoded bytes, with no `data:` URL prefix.
        data: String,
    },
    /// A document supplied by the user, carried whole rather than as text
    /// somebody extracted from it first. Lives in user messages on the same
    /// footing as [`ContentBlock::Image`] — no model emits one, so an
    /// adapter meeting one in an assistant message drops it — and inline for
    /// the same reason: a session log that pointed at a file would stop
    /// meaning anything once the file moved.
    ///
    /// `name` is a required field on two of the four wire dialects, but it
    /// would earn its place here without that. It is the handle the model
    /// and the user share for the thing ("clause 4 of contract.pdf"), and a
    /// turn carrying three unnamed attachments leaves them nothing to say
    /// but "the first document".
    Document {
        /// IANA media type. `application/pdf` is the only one every vendor
        /// that accepts documents at all agrees on, and the only one the
        /// shells offer.
        media_type: String,
        /// The filename as the user had it.
        name: String,
        /// Base64-encoded bytes, with no `data:` URL prefix.
        data: String,
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

/// An image attached to a user turn, as the session log stores it.
///
/// Same two fields as [`ContentBlock::Image`], kept as its own type because
/// the log records a user turn as a caption plus attachments. A
/// `Vec<ContentBlock>` there would also admit thinking blocks and tool
/// results, which the projection would then have to police at read time
/// instead of the type ruling them out at write time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageInput {
    pub media_type: String,
    /// Base64-encoded bytes, with no `data:` URL prefix.
    pub data: String,
}

impl DocumentInput {
    /// A text attachment (nightshift item 277): a `text/*` media type whose
    /// bytes are UTF-8 — a `.csv`, a `.py`, a notebook's cells, or the text
    /// pulled out of a slide deck when no converter could render it. Stored
    /// like a PDF (base64 in the log, a chip in the transcript) and sent as
    /// a *text block*, because text is the one thing every dialect carries:
    /// a `document` block of type text exists on Anthropic alone, and a
    /// `text/csv` blob 400s on the hosts that take only PDFs.
    pub fn is_text(&self) -> bool {
        self.media_type.starts_with("text/")
    }

    /// The block this attachment projects to: a text block for a text
    /// attachment ([`text_attachment`]), a [`ContentBlock::Document`] for
    /// everything else.
    pub fn to_block(&self) -> ContentBlock {
        if self.is_text() {
            return ContentBlock::Text {
                text: text_attachment(&self.name, &self.decoded_text()),
            };
        }
        ContentBlock::Document {
            media_type: self.media_type.clone(),
            name: self.name.clone(),
            data: self.data.clone(),
        }
    }

    /// The text of a text attachment. Bytes that are not valid base64 say
    /// so rather than vanishing, for the reason `undeliverable_document`
    /// gives; invalid UTF-8 is replaced, not refused.
    pub fn decoded_text(&self) -> String {
        use base64::Engine as _;
        match base64::engine::general_purpose::STANDARD.decode(self.data.trim()) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(_) => "[the attachment's bytes could not be decoded]".to_string(),
        }
    }
}

/// A text attachment as the model reads it: the file's name on a wrapper
/// around its contents, so a turn carrying three files keeps them apart and
/// the model can call each by name — the job `title` does on a PDF.
pub fn text_attachment(name: &str, text: &str) -> String {
    let name = name.replace('"', "'");
    format!("<attached-file name=\"{name}\">\n{text}\n</attached-file>")
}

/// A document attached to a user turn, as the session log stores it.
///
/// The [`ImageInput`] argument applies unchanged: the log records a user
/// turn as a caption plus attachments, and a `Vec<ContentBlock>` there would
/// admit thinking blocks and tool results the projection would then have to
/// police at read time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocumentInput {
    pub media_type: String,
    pub name: String,
    /// Base64-encoded bytes, with no `data:` URL prefix.
    pub data: String,
}

/// What stands in for a document the host on the other end cannot carry.
///
/// Prompt text addressed to the model, like a tool description or a denial
/// reason, and a *substitution* rather than a drop. Dropping the block would
/// leave a caption asking about a document and nothing to say one was ever
/// there, so the model answers as though it had read it. There is no third
/// option worth having: refusing to build the request would be the loud
/// failure this project prefers everywhere else, but content is not a knob —
/// the desktop lets you change provider mid-session and keep the log, and a
/// hard failure would make every later turn of that conversation impossible
/// on that host rather than one attachment unreadable.
///
/// Naming the file is what makes the recovery available. The model can say
/// which document it cannot see, and the log is untouched, so the same turn
/// replays whole on the next provider that can read it.
pub fn undeliverable_document(name: &str, media_type: &str) -> String {
    let opening = format!("[The user attached a document, \"{name}\" ({media_type}), ");
    opening
        + "which this provider cannot accept, so its contents are not in this "
        + "request. Say so rather than answering from the filename; another "
        + "provider may be able to read it.]"
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

/// The marker a subagent's narrative is recorded under, as the text block
/// `<subagent parent="<tool_use_id>">\n…\n</subagent>` (nightshift backlog
/// 075: the Claude Code engine's recorder writes one per subagent, for the
/// window to nest under the parent's call).
///
/// It is for the window and never for a model (nightshift backlog 244,
/// 2026-09-27): the parent agent is owed the Agent tool's result — the
/// child's final report — and nothing of the child's steps, which is all
/// the CLI's own session ever gives it. So the projection leaves these
/// blocks out, and so does every replay built on it.
pub const SUBAGENT_OPEN: &str = "<subagent parent=\"";

impl ContentBlock {
    /// Whether this is a subagent's narrative ([`SUBAGENT_OPEN`]): the
    /// window's, not the model's.
    pub fn is_subagent_narrative(&self) -> bool {
        matches!(self, ContentBlock::Text { text } if text.starts_with(SUBAGENT_OPEN))
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
    fn image_round_trips() {
        let block = ContentBlock::Image {
            media_type: "image/png".into(),
            data: "iVBORw0KGgo=".into(),
        };
        let text = serde_json::to_string(&block).unwrap();
        assert_eq!(
            text,
            r#"{"type":"image","media_type":"image/png","data":"iVBORw0KGgo="}"#
        );
        match serde_json::from_str::<ContentBlock>(&text).unwrap() {
            ContentBlock::Image { media_type, data } => {
                assert_eq!(media_type, "image/png");
                assert_eq!(data, "iVBORw0KGgo=");
            }
            other => panic!("expected image, got {other:?}"),
        }
    }

    /// `text()` is what shells and the compat adapters use to flatten a
    /// message; an image must not leak its base64 into it.
    #[test]
    fn image_contributes_nothing_to_text() {
        let msg = Message {
            role: Role::User,
            content: vec![
                ContentBlock::Image {
                    media_type: "image/png".into(),
                    data: "iVBORw0KGgo=".into(),
                },
                ContentBlock::Text {
                    text: "what is this?".into(),
                },
            ],
        };
        assert_eq!(msg.text(), "what is this?");
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
