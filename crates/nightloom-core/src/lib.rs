//! nightloom-core: canonical conversation model, provider trait, and
//! event-sourced sessions.
//!
//! Nothing in this crate knows about HTTP, any specific vendor API, or any UI.
//! Providers translate the canonical types down to their wire format; the UI
//! and CLI are projections of the session event log.

pub mod context;
pub mod message;
pub mod prompt;
pub mod provider;
pub mod session;
pub mod todo;
pub mod tool;

pub use context::{
    BlockKind, BlockSource, ContextTotals, Size, WireBlock, WireMessage, WireSegment, WireView,
    estimate_tokens,
};
pub use message::{ContentBlock, ImageInput, Message, Role};
pub use prompt::{Segment, SegmentKind, SystemPrompt};
pub use provider::{
    ChatRequest, EventStream, Provider, ProviderError, StreamEvent, Thinking, ToolDef, Usage,
};
pub use session::{
    Checkpoint, LoadReport, Session, SessionCost, SessionEvent, SourcedBlock, SourcedMessage,
    elision_marker, orphan_marker,
};
pub use todo::{TodoItem, TodoStatus};
pub use tool::{Effect, Tool};
