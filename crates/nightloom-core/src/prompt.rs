//! System-prompt composition.
//!
//! A system prompt is a list of ordered [`Segment`]s rather than one opaque
//! string, for two reasons. First, adapters render it differently: Anthropic
//! takes an array of text blocks and can place cache breakpoints between
//! them, while Gemini and OpenAI take a single string. Second, the segment
//! list is *stable* — assembled once when a `Chat` is configured and never
//! mutated per turn, because prompt caching keys on an exact prefix match.
//! Anything that changes turn-to-turn belongs in a sidecar on the last user
//! message, not here.
//!
//! Core defines the structure and nothing else: the text of each segment is
//! composed by `nightloom-service`, which is where knowledge of the
//! filesystem and the host environment lives.

use serde::{Deserialize, Serialize};

/// What a segment carries. Adapters ignore this; it exists so shells can
/// introspect an assembled prompt (show what's in play, drop one layer)
/// without parsing text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum SegmentKind {
    /// Who the assistant is and how it should behave.
    Identity,
    /// Stable facts about the host: cwd, OS, shell, repo. Never the clock.
    Environment,
    /// Instructions discovered in the project tree (NIGHTLOOM.md, AGENTS.md).
    ProjectInstructions,
    /// User-level standing preferences, from the config dir.
    UserMemory,
    /// Anything a shell supplies directly (`--system`, the desktop textarea).
    Custom,
}

/// One addressable piece of the system prompt.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Segment {
    pub kind: SegmentKind,
    /// Short label, for introspection and debugging. Not sent to providers.
    pub name: String,
    /// The segment's text, already fully formed — core adds no headings,
    /// wrappers, or separators of its own beyond joining.
    pub text: String,
    /// Request a cache breakpoint at the end of this segment. Only adapters
    /// whose vendor takes explicit breakpoints (Anthropic) act on it; the
    /// rest cache on prefix automatically and ignore it.
    #[serde(default)]
    pub cache_anchor: bool,
}

impl Segment {
    pub fn new(kind: SegmentKind, name: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            kind,
            name: name.into(),
            text: text.into(),
            cache_anchor: false,
        }
    }

    /// Mark a cache breakpoint at the end of this segment.
    pub fn anchored(mut self) -> Self {
        self.cache_anchor = true;
        self
    }
}

/// An ordered, cache-stable system prompt.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SystemPrompt {
    segments: Vec<Segment>,
}

impl SystemPrompt {
    pub fn new() -> Self {
        Self::default()
    }

    /// A single-segment prompt from plain text — the shape a shell that only
    /// has a `--system` string produces.
    pub fn from_text(text: impl Into<String>) -> Self {
        let mut p = Self::new();
        p.push(Segment::new(SegmentKind::Custom, "custom", text));
        p
    }

    pub fn push(&mut self, mut segment: Segment) -> &mut Self {
        // An empty segment would render as stray blank lines and, worse,
        // could carry a cache anchor that splits the prefix for no content.
        if segment.text.trim().is_empty() {
            return self;
        }
        // Normalize on the way in, not at render time: an adapter that emits
        // one block per segment and an adapter that joins into a single
        // string must produce byte-identical text, or the same prompt caches
        // differently depending on the vendor.
        if segment.text.trim().len() != segment.text.len() {
            segment.text = segment.text.trim().to_string();
        }
        self.segments.push(segment);
        self
    }

    pub fn segments(&self) -> &[Segment] {
        &self.segments
    }

    pub fn is_empty(&self) -> bool {
        self.segments.is_empty()
    }

    /// Render to one string, for vendors that take a single system field.
    /// `None` when empty, so adapters can omit the field entirely rather
    /// than send `""`.
    pub fn render_flat(&self) -> Option<String> {
        if self.segments.is_empty() {
            return None;
        }
        Some(
            self.segments
                .iter()
                .map(|s| s.text.as_str())
                .collect::<Vec<_>>()
                .join("\n\n"),
        )
    }

    /// Indices of segments carrying a cache breakpoint, capped to `max`.
    ///
    /// Anthropic allows at most four breakpoints per request. When more are
    /// requested we keep the *last* ones: a breakpoint near the end of the
    /// prompt covers the longest prefix, which is the hit that matters when
    /// nothing changed, and earlier ones only pay off on partial
    /// invalidation.
    pub fn cache_anchors(&self, max: usize) -> Vec<usize> {
        let all: Vec<usize> = self
            .segments
            .iter()
            .enumerate()
            .filter(|(_, s)| s.cache_anchor)
            .map(|(i, _)| i)
            .collect();
        if all.len() <= max {
            all
        } else {
            all[all.len() - max..].to_vec()
        }
    }
}

impl From<String> for SystemPrompt {
    fn from(text: String) -> Self {
        Self::from_text(text)
    }
}

impl From<&str> for SystemPrompt {
    fn from(text: &str) -> Self {
        Self::from_text(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(name: &str) -> Segment {
        Segment::new(SegmentKind::Custom, name, format!("text of {name}"))
    }

    #[test]
    fn empty_prompt_renders_to_none() {
        assert!(SystemPrompt::new().render_flat().is_none());
        assert!(SystemPrompt::new().is_empty());
    }

    #[test]
    fn blank_segments_are_dropped() {
        let mut p = SystemPrompt::new();
        p.push(Segment::new(SegmentKind::Custom, "blank", "   \n "));
        assert!(p.is_empty());
    }

    #[test]
    fn segment_text_is_normalized_on_push() {
        let mut p = SystemPrompt::new();
        p.push(Segment::new(
            SegmentKind::Custom,
            "padded",
            "
  body  

",
        ));
        // Both renderings read `text` directly, so they cannot diverge.
        assert_eq!(p.segments()[0].text, "body");
        assert_eq!(p.render_flat().unwrap(), "body");
    }

    #[test]
    fn flat_render_joins_with_blank_lines() {
        let mut p = SystemPrompt::new();
        p.push(seg("a")).push(seg("b"));
        assert_eq!(p.render_flat().unwrap(), "text of a\n\ntext of b");
    }

    #[test]
    fn anchors_beyond_the_cap_keep_the_last_ones() {
        let mut p = SystemPrompt::new();
        for n in ["a", "b", "c", "d", "e"] {
            p.push(seg(n).anchored());
        }
        assert_eq!(p.cache_anchors(4), vec![1, 2, 3, 4]);
        assert_eq!(p.cache_anchors(10), vec![0, 1, 2, 3, 4]);
    }
}
