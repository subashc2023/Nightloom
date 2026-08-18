use crate::message::{ContentBlock, ImageInput, Message, Role};
use crate::provider::Usage;
use crate::todo::TodoItem;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

/// One entry in a session's append-only event log.
///
/// The log is the source of truth; the message list sent to a provider and
/// anything a UI renders are projections of it. Future variants (tool calls,
/// permission decisions, checkpoints, compaction markers) extend this enum.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
#[non_exhaustive]
pub enum SessionEvent {
    SessionCreated {
        id: String,
        at: DateTime<Utc>,
    },
    UserMessage {
        text: String,
        /// Images the user attached to this turn. Absent from every log
        /// written before attachments existed, hence the `default`.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<ImageInput>,
        at: DateTime<Utc>,
    },
    AssistantMessage {
        model: String,
        blocks: Vec<ContentBlock>,
        stop_reason: Option<String>,
        usage: Usage,
        at: DateTime<Utc>,
    },
    /// One executed tool call. Consecutive results project into a single
    /// user message of `ToolResult` blocks (the shape every provider
    /// expects results in).
    ToolResult {
        tool_use_id: String,
        name: String,
        content: String,
        is_error: bool,
        at: DateTime<Utc>,
    },
    /// Everything before this event is superseded by `summary`: the provider
    /// projection restarts here, re-seeded with the summary as a user
    /// message. The log itself stays append-only — earlier events remain on
    /// disk for UIs and audit.
    Compaction {
        summary: String,
        at: DateTime<Utc>,
    },
    /// The model's task list, as of this point. Each write records the whole
    /// list; the latest event wins. Not part of the message projection — it
    /// reaches the model through the per-turn sidecar instead, so the list
    /// is always current rather than a trail of stale copies.
    TodoState {
        todos: Vec<TodoItem>,
        at: DateTime<Utc>,
    },
}

pub struct Session {
    pub id: String,
    events: Vec<SessionEvent>,
    log: Option<JsonlLog>,
}

impl Session {
    /// In-memory session with no persistence.
    pub fn new() -> Self {
        let id = uuid::Uuid::new_v4().to_string();
        let mut s = Self {
            id: id.clone(),
            events: Vec::new(),
            log: None,
        };
        s.record(SessionEvent::SessionCreated { id, at: Utc::now() });
        s
    }

    /// Session persisted as JSONL under `dir/<session-id>.jsonl`.
    pub fn with_log(dir: impl AsRef<Path>) -> io::Result<Self> {
        let id = uuid::Uuid::new_v4().to_string();
        let log = JsonlLog::create(dir.as_ref().join(format!("{id}.jsonl")))?;
        let mut s = Self {
            id: id.clone(),
            events: Vec::new(),
            log: Some(log),
        };
        s.record(SessionEvent::SessionCreated { id, at: Utc::now() });
        Ok(s)
    }

    /// Rebuild a session from a previously written JSONL log and reopen it
    /// for appending.
    pub fn load(path: impl AsRef<Path>) -> io::Result<Self> {
        let path = path.as_ref();
        let reader = BufReader::new(File::open(path)?);
        let mut events = Vec::new();
        for line in reader.lines() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let event: SessionEvent = serde_json::from_str(&line)
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
            events.push(event);
        }
        let id = events
            .iter()
            .find_map(|e| match e {
                SessionEvent::SessionCreated { id, .. } => Some(id.clone()),
                _ => None,
            })
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        Ok(Self {
            id,
            events,
            log: Some(JsonlLog::append_to(path)?),
        })
    }

    pub fn record(&mut self, event: SessionEvent) {
        if let Some(log) = &mut self.log {
            // Persistence failure shouldn't lose the in-memory turn; surface
            // it on stderr and carry on.
            if let Err(e) = log.append(&event) {
                eprintln!("nightloom: failed to write session log: {e}");
            }
        }
        self.events.push(event);
    }

    pub fn record_user(&mut self, text: impl Into<String>) {
        self.record_user_with_images(text, Vec::new());
    }

    pub fn record_user_with_images(&mut self, text: impl Into<String>, images: Vec<ImageInput>) {
        self.record(SessionEvent::UserMessage {
            text: text.into(),
            images,
            at: Utc::now(),
        });
    }

    pub fn record_assistant(
        &mut self,
        model: impl Into<String>,
        blocks: Vec<ContentBlock>,
        stop_reason: Option<String>,
        usage: Usage,
    ) {
        self.record(SessionEvent::AssistantMessage {
            model: model.into(),
            blocks,
            stop_reason,
            usage,
            at: Utc::now(),
        });
    }

    pub fn record_compaction(&mut self, summary: impl Into<String>) {
        self.record(SessionEvent::Compaction {
            summary: summary.into(),
            at: Utc::now(),
        });
    }

    pub fn record_todos(&mut self, todos: Vec<TodoItem>) {
        self.record(SessionEvent::TodoState {
            todos,
            at: Utc::now(),
        });
    }

    pub fn events(&self) -> &[SessionEvent] {
        &self.events
    }

    /// The current task list: the most recent `TodoState`, or empty. A
    /// compaction clears it — the summary supersedes the plan that produced
    /// it, and a stale list would outlive the work it described.
    pub fn todos(&self) -> &[TodoItem] {
        for e in self.events.iter().rev() {
            match e {
                SessionEvent::TodoState { todos, .. } => return todos,
                SessionEvent::Compaction { .. } => return &[],
                _ => {}
            }
        }
        &[]
    }

    /// Projection: the message list to send to a provider.
    pub fn messages(&self) -> Vec<Message> {
        self.messages_with_sidecar(None)
    }

    /// The same projection with a per-turn sidecar appended to the user's
    /// message: current time, task list, context gauge — whatever the shell
    /// wants the model to know about *now*.
    ///
    /// The sidecar is deliberately not an event. It is composed at
    /// projection time and never written to the log, so replaying an old
    /// session can't resurrect last week's clock or a task list that has
    /// since moved on.
    ///
    /// It attaches only when the projection ends in a user message carrying
    /// no tool results — the first round of a turn. On tool-continuation
    /// rounds the tail is a tool-result message, where an extra text block is
    /// a wire hazard (Gemini pairs function responses strictly), and the
    /// sidecar from round one is still in context anyway.
    ///
    /// The test is for the absence of `ToolResult`, not the presence of only
    /// `Text`: a turn where the user attached an image is still round one,
    /// and an "all blocks are text" rule would quietly drop the clock, the
    /// gauge and the task list for exactly the turns that carry an image.
    pub fn messages_with_sidecar(&self, sidecar: Option<&str>) -> Vec<Message> {
        let mut messages = self.project();
        let Some(sidecar) = sidecar.map(str::trim).filter(|s| !s.is_empty()) else {
            return messages;
        };
        if let Some(last) = messages.last_mut()
            && last.role == Role::User
            && !last
                .content
                .iter()
                .any(|b| matches!(b, ContentBlock::ToolResult { .. }))
        {
            last.content.push(ContentBlock::Text {
                text: sidecar.to_string(),
            });
        }
        messages
    }

    fn project(&self) -> Vec<Message> {
        let mut messages: Vec<Message> = Vec::new();
        for e in &self.events {
            match e {
                SessionEvent::UserMessage { text, images, .. } => {
                    let mut content: Vec<ContentBlock> = images
                        .iter()
                        .map(|i| ContentBlock::Image {
                            media_type: i.media_type.clone(),
                            data: i.data.clone(),
                        })
                        .collect();
                    // Images lead, as both Anthropic and OpenAI advise, and
                    // an empty caption is omitted rather than sent: an empty
                    // text block is rejected on the wire, and "here is an
                    // image" with nothing said about it is a real turn.
                    if !text.is_empty() || content.is_empty() {
                        content.push(ContentBlock::Text { text: text.clone() });
                    }
                    messages.push(Message {
                        role: Role::User,
                        content,
                    });
                }
                SessionEvent::AssistantMessage { blocks, .. } => {
                    messages.push(Message {
                        role: Role::Assistant,
                        content: blocks.clone(),
                    });
                }
                SessionEvent::ToolResult {
                    tool_use_id,
                    name,
                    content,
                    is_error,
                    ..
                } => {
                    let block = ContentBlock::ToolResult {
                        tool_use_id: tool_use_id.clone(),
                        name: name.clone(),
                        content: content.clone(),
                        is_error: *is_error,
                    };
                    // Results from one round of calls coalesce into the user
                    // message a provider expects them in.
                    match messages.last_mut() {
                        Some(m)
                            if m.role == Role::User
                                && matches!(
                                    m.content.last(),
                                    Some(ContentBlock::ToolResult { .. })
                                ) =>
                        {
                            m.content.push(block)
                        }
                        _ => messages.push(Message {
                            role: Role::User,
                            content: vec![block],
                        }),
                    }
                }
                SessionEvent::Compaction { summary, .. } => {
                    // The summary supersedes everything projected so far.
                    messages.clear();
                    messages.push(Message::user(format!(
                        "The conversation so far was compacted into this summary:\n\n{summary}"
                    )));
                }
                _ => {}
            }
        }
        messages
    }

    pub fn record_tool_result(&mut self, block: &ContentBlock) {
        if let ContentBlock::ToolResult {
            tool_use_id,
            name,
            content,
            is_error,
        } = block
        {
            self.record(SessionEvent::ToolResult {
                tool_use_id: tool_use_id.clone(),
                name: name.clone(),
                content: content.clone(),
                is_error: *is_error,
                at: Utc::now(),
            });
        }
    }

    pub fn total_usage(&self) -> Usage {
        let mut total = Usage::default();
        for e in &self.events {
            if let SessionEvent::AssistantMessage { usage, .. } = e {
                total.add(*usage);
            }
        }
        total
    }

    pub fn log_path(&self) -> Option<&Path> {
        self.log.as_ref().map(|l| l.path.as_path())
    }
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

struct JsonlLog {
    path: PathBuf,
    file: File,
}

impl JsonlLog {
    fn create(path: PathBuf) -> io::Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new()
            .create_new(true)
            .append(true)
            .open(&path)?;
        Ok(Self { path, file })
    }

    fn append_to(path: &Path) -> io::Result<Self> {
        let file = OpenOptions::new().append(true).open(path)?;
        Ok(Self {
            path: path.to_path_buf(),
            file,
        })
    }

    fn append(&mut self, event: &SessionEvent) -> io::Result<()> {
        let line = serde_json::to_string(event)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        writeln!(self.file, "{line}")?;
        self.file.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projection_skips_non_message_events() {
        let mut s = Session::new();
        s.record_user("hello");
        s.record_assistant(
            "test-model",
            vec![ContentBlock::Text { text: "hi".into() }],
            Some("end_turn".into()),
            Usage {
                input_tokens: 10,
                output_tokens: 2,
                reasoning_tokens: None,
            },
        );
        let msgs = s.messages();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].text(), "hello");
        assert_eq!(msgs[1].text(), "hi");
        assert_eq!(s.total_usage().input_tokens, 10);
    }

    #[test]
    fn tool_results_project_into_one_user_message() {
        let mut s = Session::new();
        s.record_user("what's 2+2 and 3+3?");
        s.record_assistant(
            "test-model",
            vec![
                ContentBlock::ToolUse {
                    id: "c1".into(),
                    name: "add".into(),
                    input: serde_json::json!({"a": 2, "b": 2}),
                    signature: None,
                },
                ContentBlock::ToolUse {
                    id: "c2".into(),
                    name: "add".into(),
                    input: serde_json::json!({"a": 3, "b": 3}),
                    signature: None,
                },
            ],
            Some("tool_use".into()),
            Usage::default(),
        );
        for (id, out) in [("c1", "4"), ("c2", "6")] {
            s.record_tool_result(&ContentBlock::ToolResult {
                tool_use_id: id.into(),
                name: "add".into(),
                content: out.into(),
                is_error: false,
            });
        }
        let msgs = s.messages();
        // user question, assistant tool calls, ONE user message of results
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[2].role, Role::User);
        assert_eq!(msgs[2].content.len(), 2);
        assert!(matches!(
            &msgs[2].content[0],
            ContentBlock::ToolResult { tool_use_id, .. } if tool_use_id == "c1"
        ));
    }

    #[test]
    fn compaction_resets_the_projection_but_keeps_the_log() {
        let mut s = Session::new();
        s.record_user("first question");
        s.record_assistant(
            "test-model",
            vec![ContentBlock::Text {
                text: "first answer".into(),
            }],
            Some("end_turn".into()),
            Usage::default(),
        );
        s.record_compaction("the user asked a question and got an answer");
        s.record_user("follow-up");

        let msgs = s.messages();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].role, Role::User);
        assert!(msgs[0].text().contains("compacted into this summary"));
        assert!(
            msgs[0]
                .text()
                .contains("the user asked a question and got an answer")
        );
        assert_eq!(msgs[1].text(), "follow-up");
        // The log itself keeps the pre-compaction events.
        assert_eq!(s.events().len(), 5);
    }

    #[test]
    fn sidecar_attaches_to_a_trailing_user_message() {
        let mut s = Session::new();
        s.record_user("hello");
        let msgs = s.messages_with_sidecar(Some("<status>now</status>"));
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].content.len(), 2);
        assert_eq!(msgs[0].text(), "hello<status>now</status>");
        // …and it stays out of the log, so replay never resurrects it.
        assert_eq!(s.messages()[0].content.len(), 1);
    }

    fn one_image() -> Vec<ImageInput> {
        vec![ImageInput {
            media_type: "image/png".into(),
            data: "aGk=".into(),
        }]
    }

    #[test]
    fn an_image_turn_projects_images_before_the_caption() {
        let mut session = Session::new();
        session.record_user_with_images("what is this?", one_image());
        let messages = session.messages();
        assert_eq!(messages.len(), 1);
        assert!(matches!(
            messages[0].content.as_slice(),
            [ContentBlock::Image { .. }, ContentBlock::Text { .. }]
        ));
    }

    /// An uncaptioned attachment is a real turn, and an empty text block is
    /// rejected on the wire — so the caption is omitted, not sent empty.
    #[test]
    fn an_uncaptioned_image_carries_no_empty_text_block() {
        let mut session = Session::new();
        session.record_user_with_images("", one_image());
        assert!(matches!(
            session.messages()[0].content.as_slice(),
            [ContentBlock::Image { .. }]
        ));
    }

    /// A turn with an attachment is still round one. The old guard asked
    /// whether every block was text, which quietly dropped the clock, the
    /// gauge and the task list for exactly the turns carrying an image.
    #[test]
    fn sidecar_still_attaches_to_a_user_turn_with_an_image() {
        let mut session = Session::new();
        session.record_user_with_images("look", one_image());
        let messages = session.messages_with_sidecar(Some("time: now"));
        assert_eq!(messages[0].content.len(), 3);
        assert!(messages[0].text().contains("time: now"));
    }

    /// Logs written before attachments existed have no `images` key at all.
    #[test]
    fn a_user_message_without_images_loads_and_stays_that_shape() {
        let json = r#"{"event":"user_message","text":"hi","at":"2026-01-01T00:00:00Z"}"#;
        let event: SessionEvent = serde_json::from_str(json).unwrap();
        assert!(matches!(&event, SessionEvent::UserMessage { images, .. } if images.is_empty()));
        let back = serde_json::to_string(&event).unwrap();
        assert!(!back.contains("images"), "{back}");
    }

    #[test]
    fn sidecar_skips_a_trailing_tool_result_message() {
        let mut s = Session::new();
        s.record_user("go");
        s.record_assistant(
            "test-model",
            vec![ContentBlock::ToolUse {
                id: "c1".into(),
                name: "add".into(),
                input: serde_json::json!({}),
                signature: None,
            }],
            Some("tool_use".into()),
            Usage::default(),
        );
        s.record_tool_result(&ContentBlock::ToolResult {
            tool_use_id: "c1".into(),
            name: "add".into(),
            content: "4".into(),
            is_error: false,
        });
        let msgs = s.messages_with_sidecar(Some("<status>now</status>"));
        // The tail is a tool-result message: appending text there is a wire
        // hazard, and round one already carried the sidecar.
        assert_eq!(msgs.last().unwrap().content.len(), 1);
    }

    #[test]
    fn todos_take_the_latest_state_and_reset_on_compaction() {
        use crate::todo::{TodoItem, TodoStatus};
        let mut s = Session::new();
        s.record_todos(vec![TodoItem::new("first", TodoStatus::Pending)]);
        s.record_todos(vec![TodoItem::new("second", TodoStatus::InProgress)]);
        assert_eq!(s.todos().len(), 1);
        assert_eq!(s.todos()[0].content, "second");
        // The list is not part of the message projection.
        assert!(s.messages().is_empty());

        s.record_user("q");
        s.record_assistant(
            "test-model",
            vec![ContentBlock::Text { text: "a".into() }],
            None,
            Usage::default(),
        );
        s.record_compaction("summary");
        // The summary supersedes the plan that produced it.
        assert!(s.todos().is_empty());
    }

    #[test]
    fn round_trips_through_jsonl() {
        let dir = std::env::temp_dir().join(format!("nightloom-test-{}", uuid::Uuid::new_v4()));
        let mut s = Session::with_log(&dir).unwrap();
        s.record_user("persisted?");
        let path = s.log_path().unwrap().to_path_buf();
        drop(s);

        let loaded = Session::load(&path).unwrap();
        assert_eq!(loaded.messages().len(), 1);
        assert_eq!(loaded.messages()[0].text(), "persisted?");
        std::fs::remove_dir_all(&dir).ok();
    }
}
