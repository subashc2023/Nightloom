//! nightloom-core: canonical conversation model, provider trait, and
//! event-sourced sessions.
//!
//! Nothing in this crate knows about HTTP, any specific vendor API, or any UI.
//! Providers translate the canonical types down to their wire format; the UI
//! and CLI are projections of the session event log.

pub mod message;
pub mod provider;
pub mod session;

pub use message::{ContentBlock, Message, Role};
pub use provider::{ChatRequest, EventStream, Provider, ProviderError, StreamEvent, Thinking, Usage};
pub use session::{Session, SessionEvent};
