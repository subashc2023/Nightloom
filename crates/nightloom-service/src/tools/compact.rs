//! Model-initiated compaction.
//!
//! Compaction is the one built-in whose work the tool cannot do itself.
//! Summarizing means calling the provider, and the tool runs *inside* an open
//! turn — recursing into the model there would interleave two streams over one
//! session and rewrite the history the current turn is still reading from.
//!
//! So the tool only raises a flag. The engine reads it once the reply is
//! finished and compacts at the turn boundary, which is also the only moment
//! where discarding history is safe.
//!
//! Why a tool at all, rather than the engine compacting on its own once the
//! gauge crosses a line: the engine knows how full the window is, but not
//! whether this is a sensible place to stop. Firing automatically halfway
//! through a multi-step task throws away the details the next step needed. The
//! model is the only party that knows both, so the sidecar tells it the number
//! and leaves the timing to it.

use nightloom_core::ToolDef;
use nightloom_core::tool::{CancellationToken, Effect, Tool};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

const COMPACT_DESC: &str = "Compact the conversation: everything so far is replaced by a summary, \
     freeing the context window. The session status block each turn tells you how full the window \
     is; when it warns you, call this at the next natural stopping point — after finishing a \
     piece of work, never in the middle of one. It takes effect once your current reply is \
     complete, so say what you were going to say first. Detail that is not in the summary is gone \
     afterwards, so record anything still outstanding in your task list before you call it.";

/// The request itself, shared between the tool and the turn engine.
///
/// Clones share one flag. [`take`](Self::take) both reads and clears it, so a
/// request is honoured exactly once even if the model calls the tool twice in
/// one turn.
#[derive(Clone, Default)]
pub struct CompactSignal(Arc<AtomicBool>);

impl CompactSignal {
    pub fn new() -> Self {
        Self::default()
    }

    fn raise(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    /// Take a pending request, clearing it.
    pub fn take(&self) -> bool {
        self.0.swap(false, Ordering::SeqCst)
    }
}

/// The `compact_context` tool. Construct it through
/// [`Chat::enable_self_compaction`], which wires the signal to the engine —
/// a tool holding a signal nothing reads would accept the model's request and
/// then quietly never act on it.
///
/// [`Chat::enable_self_compaction`]: crate::turn::Chat::enable_self_compaction
pub struct CompactContext {
    signal: CompactSignal,
}

impl CompactContext {
    pub fn new(signal: CompactSignal) -> Self {
        Self { signal }
    }
}

#[async_trait::async_trait]
impl Tool for CompactContext {
    /// Shortening the projection only rewrites what the model can see;
    /// the log keeps every event either way.
    fn effect(&self) -> Effect {
        Effect::Session
    }

    fn def(&self) -> ToolDef {
        ToolDef {
            name: "compact_context".into(),
            description: COMPACT_DESC.into(),
            input_schema: json!({ "type": "object", "properties": {} }),
        }
    }

    async fn call(&self, _input: Value, _cancel: &CancellationToken) -> Result<String, String> {
        self.signal.raise();
        // Phrased as a deadline rather than a receipt: the model has one more
        // reply in which to say anything that depends on history it is about
        // to lose.
        Ok(
            "Compaction scheduled. It runs once this reply is complete; \
            everything before the summary is unavailable to you after that."
                .into(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn calling_the_tool_raises_the_signal_once() {
        let signal = CompactSignal::new();
        let tool = CompactContext::new(signal.clone());
        assert!(!signal.take(), "starts unraised");

        tool.call(json!({}), &CancellationToken::new())
            .await
            .unwrap();
        assert!(signal.take(), "raised by the call");
        assert!(!signal.take(), "and cleared by the taking");
    }

    /// Two calls in one turn are one compaction, not two.
    #[tokio::test]
    async fn repeated_calls_collapse_into_one_request() {
        let signal = CompactSignal::new();
        let tool = CompactContext::new(signal.clone());
        tool.call(json!({}), &CancellationToken::new())
            .await
            .unwrap();
        tool.call(json!({}), &CancellationToken::new())
            .await
            .unwrap();
        assert!(signal.take());
        assert!(!signal.take());
    }
}
