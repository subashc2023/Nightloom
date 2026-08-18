//! nightloom-core: canonical conversation model, provider trait, and
//! event-sourced sessions.
//!
//! Nothing in this crate knows about HTTP, any specific vendor API, or any UI.
//! Providers translate the canonical types down to their wire format; the UI
//! and CLI are projections of the session event log.

pub mod message;
pub mod prompt;
pub mod provider;
pub mod session;
pub mod todo;
pub mod tool;

pub use message::{ContentBlock, ImageInput, Message, Role};
pub use prompt::{Segment, SegmentKind, SystemPrompt};
pub use provider::{
    ChatRequest, EventStream, Provider, ProviderError, StreamEvent, Thinking, ToolDef, Usage,
};
pub use session::{Session, SessionEvent};
pub use todo::{TodoItem, TodoStatus};
pub use tool::{Effect, Tool};
