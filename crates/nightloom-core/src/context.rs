//! What is actually on the wire, itemized.
//!
//! Every other projection off the session log answers "what happened". This
//! one answers "what is this costing me, and which log event do I blame for
//! it" — the question you cannot answer from a transcript, because the
//! transcript is a rendering of events while a request is a rendering of
//! [`Session::messages_with_sidecar`], and the two differ in exactly the
//! places that matter: tool results coalesce, a compaction replaces
//! everything before it, images arrive as base64 the transcript shows as a
//! thumbnail, and the sidecar is composed at projection time and never
//! logged at all.
//!
//! ## The numbers here are estimates, and say so
//!
//! There is no tokenizer in this workspace and there deliberately isn't one:
//! every vendor tokenizes differently, and the only exact answer is a round
//! trip to a counting endpoint that just one provider offers. So
//! [`estimate_tokens`] is a heuristic, and everything downstream carries
//! [`Size::tokens`] as an `Option` rather than a number that looks measured.
//!
//! That `Option` is the same shape [`crate::SessionCost`] uses for an
//! unpriced exchange, and for the same reason: an image contributes tokens
//! that cannot be estimated from its base64 length, and folding a guess into
//! the total would make the total look complete when it is not.
//! [`ContextTotals::unestimated`] counts what was left out, so a shell can
//! render "≥ 12,400" exactly where it renders "≥ $0.40".

use serde::{Deserialize, Serialize};

use crate::message::{ContentBlock, Role};
use crate::prompt::{SegmentKind, SystemPrompt};
use crate::session::{Session, SourcedBlock};

/// How much of a block's text a view carries for display.
const PREVIEW_CHARS: usize = 280;

/// Characters per token, for the estimate.
///
/// Four is the figure every vendor quotes for English prose and it is
/// roughly right for prose. It is *wrong*, in both directions, for the
/// content that actually fills an agentic context: JSON tool arguments and
/// source code run denser, and long runs of whitespace or repeated
/// punctuation run sparser. The estimate is here to rank items by size and
/// to answer "is this the thing eating my window", which it does well; it is
/// not here to predict a bill, which is what the recorded `Usage` on each
/// exchange is for.
const CHARS_PER_TOKEN: usize = 4;

/// Estimated tokens for a run of text. Never exact — see the module docs.
pub fn estimate_tokens(text: &str) -> u64 {
    let chars = text.chars().count();
    chars.div_ceil(CHARS_PER_TOKEN) as u64
}

/// How big one item is.
///
/// `bytes` is a fact; `tokens` is an estimate, and `None` where even an
/// estimate would be invention (an image, whose token cost depends on pixel
/// dimensions this crate never decodes).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Size {
    pub bytes: usize,
    pub tokens: Option<u64>,
}

impl Size {
    /// A run of text: byte length measured, tokens estimated.
    pub fn of_text(text: &str) -> Self {
        Self {
            bytes: text.len(),
            tokens: Some(estimate_tokens(text)),
        }
    }

    /// A payload whose token cost cannot be estimated from its bytes.
    pub fn opaque(bytes: usize) -> Self {
        Self {
            bytes,
            tokens: None,
        }
    }
}

/// A sum of [`Size`]s that keeps track of what it could not count.
///
/// `unestimated` is not a rounding detail, for the same reason
/// [`crate::SessionCost::unpriced_exchanges`] is not: a view whose items are
/// all images totals zero tokens, and rendering that as "0 tokens" would
/// claim the context is empty rather than unmeasured. Non-zero means
/// `tokens` is a floor.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ContextTotals {
    pub tokens: u64,
    pub bytes: usize,
    /// How many items contributed bytes but no token estimate.
    pub unestimated: usize,
}

impl ContextTotals {
    pub fn add(&mut self, size: Size) {
        self.bytes += size.bytes;
        match size.tokens {
            Some(t) => self.tokens += t,
            None => self.unestimated += 1,
        }
    }

    /// Whether every item in the sum could be estimated.
    pub fn is_complete(&self) -> bool {
        self.unestimated == 0
    }
}

/// Which kind of content a wire block carries.
///
/// Mirrors [`ContentBlock`] one-for-one, plus [`BlockKind::Sidecar`] for the
/// per-turn block that has no `ContentBlock` variant of its own because it is
/// a plain `Text` block by the time it reaches an adapter. A view that showed
/// it as text would be accurate about the wire and useless to a reader, who
/// needs to know that this particular text is regenerated every turn and
/// cannot be removed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum BlockKind {
    Text,
    Image,
    Thinking,
    RedactedThinking,
    ToolUse,
    ReasoningRef,
    ToolResult,
    Sidecar,
}

/// Where a projected block came from.
///
/// The whole point of the view: a UI that wants to *act* on an item — remove
/// it, jump to it in the transcript — needs the log index, and the
/// projection is the only place that mapping exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "from", rename_all = "snake_case")]
#[non_exhaustive]
pub enum BlockSource {
    /// Produced by the log event at this index.
    Event { index: usize },
    /// Composed at projection time and never written to the log. Nothing can
    /// be done to it from the log side; it changes on its own next turn.
    Sidecar,
}

/// One block as it will reach the provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WireBlock {
    pub kind: BlockKind,
    /// The leading [`PREVIEW_CHARS`] characters, for display. Never the whole
    /// payload: a view of a context is a thing you page through, and the
    /// 40 KB tool result is exactly the item you are looking for.
    pub preview: String,
    /// Whether `preview` stops short of the full content.
    pub truncated: bool,
    pub size: Size,
    pub source: BlockSource,
    /// Whether the source event is currently elided — the block on the wire
    /// is a marker standing in for content the log still holds.
    pub elided: bool,
    /// Whether [`Session::elide`] would accept this block's source event.
    /// Computed here so a shell does not reimplement the rule and drift.
    pub elidable: bool,
}

/// One message as it will reach the provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WireMessage {
    pub role: Role,
    pub blocks: Vec<WireBlock>,
    pub totals: ContextTotals,
}

/// One system-prompt segment as it will reach the provider.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WireSegment {
    pub kind: SegmentKind,
    pub name: String,
    pub preview: String,
    pub truncated: bool,
    pub size: Size,
    /// Whether this segment carries a cache breakpoint. Worth surfacing: a
    /// reader looking at a context that is re-uploading in full every turn
    /// wants to see where the cached prefix is claimed to end.
    pub cache_anchor: bool,
}

/// The complete request payload, itemized — system prompt, every projected
/// message, and the sidecar, each with its size and its provenance.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WireView {
    pub system: Vec<WireSegment>,
    pub messages: Vec<WireMessage>,
    /// Sum over system and messages both, which is the number that should be
    /// compared against `context_limit` — a gauge that counted only the
    /// conversation would under-read by the whole preamble.
    pub totals: ContextTotals,
    /// The model's input window, when the shell knows it. `None` renders as
    /// a raw count and no percentage rather than a guessed denominator, the
    /// same rule the sidecar gauge follows.
    pub context_limit: Option<u64>,
}

impl WireView {
    /// Itemize what a request built from `session` right now would carry.
    ///
    /// `sidecar` is the same string the turn engine would pass to
    /// [`Session::messages_with_sidecar`], so the view is the request rather
    /// than an approximation of it — including the engine's rule that the
    /// sidecar attaches only on the first round of a turn. Pass `None` to
    /// see the conversation without it.
    pub fn assemble(
        system: Option<&SystemPrompt>,
        session: &Session,
        sidecar: Option<&str>,
        context_limit: Option<u64>,
    ) -> Self {
        let mut totals = ContextTotals::default();

        let system: Vec<WireSegment> = system
            .map(|p| p.segments())
            .unwrap_or_default()
            .iter()
            .map(|seg| {
                let size = Size::of_text(&seg.text);
                totals.add(size);
                let (preview, truncated) = preview_of(&seg.text);
                WireSegment {
                    kind: seg.kind,
                    name: seg.name.clone(),
                    preview,
                    truncated,
                    size,
                    cache_anchor: seg.cache_anchor,
                }
            })
            .collect();

        let elided = session.elide_flags();
        let messages: Vec<WireMessage> = session
            .messages_sourced(sidecar)
            .into_iter()
            .map(|m| {
                let mut msg_totals = ContextTotals::default();
                let blocks: Vec<WireBlock> = m
                    .content
                    .iter()
                    .map(|sb| {
                        let block = wire_block(sb, &elided, session);
                        msg_totals.add(block.size);
                        totals.add(block.size);
                        block
                    })
                    .collect();
                WireMessage {
                    role: m.role,
                    blocks,
                    totals: msg_totals,
                }
            })
            .collect();

        Self {
            system,
            messages,
            totals,
            context_limit,
        }
    }

    /// How full the window is, `0.0..=1.0`, or `None` with no known limit.
    pub fn fraction_used(&self) -> Option<f64> {
        let limit = self.context_limit.filter(|l| *l > 0)?;
        Some(self.totals.tokens as f64 / limit as f64)
    }

    /// Every block currently standing in for elided content, with the log
    /// index that would restore it.
    pub fn elided_events(&self) -> Vec<usize> {
        let mut out: Vec<usize> = self
            .messages
            .iter()
            .flat_map(|m| &m.blocks)
            .filter(|b| b.elided)
            .filter_map(|b| match b.source {
                BlockSource::Event { index } => Some(index),
                BlockSource::Sidecar => None,
            })
            .collect();
        out.sort_unstable();
        out.dedup();
        out
    }
}

fn wire_block(sb: &SourcedBlock, elided: &[bool], session: &Session) -> WireBlock {
    let (kind, preview, truncated, size) = match &sb.block {
        ContentBlock::Text { text } => {
            let (p, t) = preview_of(text);
            (BlockKind::Text, p, t, Size::of_text(text))
        }
        ContentBlock::Image { media_type, data } => (
            BlockKind::Image,
            media_type.clone(),
            false,
            // Base64 carries three bytes in every four characters. The
            // decoded size is what a reader means by "how big is this
            // image"; the token cost of it is not derivable from either.
            Size::opaque(data.len() / 4 * 3),
        ),
        ContentBlock::Thinking { text, .. } => {
            let (p, t) = preview_of(text);
            (BlockKind::Thinking, p, t, Size::of_text(text))
        }
        ContentBlock::RedactedThinking { data } => (
            BlockKind::RedactedThinking,
            String::new(),
            false,
            Size::opaque(data.len()),
        ),
        ContentBlock::ToolUse { name, input, .. } => {
            let rendered = format!("{name}({input})");
            let (p, t) = preview_of(&rendered);
            (BlockKind::ToolUse, p, t, Size::of_text(&rendered))
        }
        ContentBlock::ReasoningRef { id } => (
            BlockKind::ReasoningRef,
            id.clone(),
            false,
            // An opaque handle the provider expands on its own side. Its few
            // characters are not what it costs, and what it costs is not
            // ours to know.
            Size::opaque(id.len()),
        ),
        ContentBlock::ToolResult { name, content, .. } => {
            let (p, t) = preview_of(content);
            (
                BlockKind::ToolResult,
                format!("{name}: {p}"),
                t,
                Size::of_text(content),
            )
        } // No catch-all arm: `ContentBlock` is `#[non_exhaustive]` only to
          // other crates, so a new variant added here breaks this match rather
          // than silently sizing itself at zero. A block missing from the view
          // is worse than a compile error — it is a chunk of the window that
          // reads as free.
    };

    let (kind, source, is_elided, elidable) = match sb.source {
        BlockSource::Sidecar => (BlockKind::Sidecar, BlockSource::Sidecar, false, false),
        BlockSource::Event { index } => (
            kind,
            BlockSource::Event { index },
            elided.get(index).copied().unwrap_or(false),
            session.is_elidable(index),
        ),
    };

    WireBlock {
        kind,
        preview,
        truncated,
        size,
        source,
        elided: is_elided,
        elidable,
    }
}

fn preview_of(text: &str) -> (String, bool) {
    let mut out = String::new();
    for (n, c) in text.chars().enumerate() {
        if n == PREVIEW_CHARS {
            return (out, true);
        }
        out.push(c);
    }
    (out, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimates_round_up_and_count_characters_not_bytes() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcde"), 2);
        // Four multi-byte characters are still four characters: a byte-based
        // estimate would triple this and read as a context three times as
        // full on any non-ASCII transcript.
        assert_eq!(estimate_tokens("é".repeat(4).as_str()), 1);
    }

    #[test]
    fn an_unestimated_item_makes_the_total_a_floor() {
        let mut t = ContextTotals::default();
        t.add(Size::of_text("abcd"));
        assert!(t.is_complete());
        t.add(Size::opaque(9_000));
        assert_eq!(t.tokens, 1);
        assert_eq!(t.bytes, 9_004);
        assert_eq!(t.unestimated, 1);
        assert!(!t.is_complete(), "an image must not read as zero tokens");
    }

    #[test]
    fn previews_cut_on_a_character_boundary() {
        let long = "é".repeat(PREVIEW_CHARS + 10);
        let (preview, truncated) = preview_of(&long);
        assert!(truncated);
        assert_eq!(preview.chars().count(), PREVIEW_CHARS);

        let (preview, truncated) = preview_of("short");
        assert!(!truncated);
        assert_eq!(preview, "short");
    }
}
