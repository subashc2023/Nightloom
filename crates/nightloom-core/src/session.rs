use crate::context::{BlockSource, estimate_tokens};
use crate::message::{ContentBlock, DocumentInput, ImageInput, Message, Role};
use crate::prompt::SegmentKind;
use crate::provider::{CacheTtl, Usage};
use crate::todo::TodoItem;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// A point a session can be rewound to.
#[derive(Debug, Clone, PartialEq)]
pub struct Checkpoint {
    /// Position in the event log, and the argument to [`Session::rewind`].
    pub index: usize,
    /// The user's message at that point, for a UI to label it with.
    pub text: String,
    /// How many images and documents were attached, which the text alone
    /// does not say — an uncaptioned attachment is a real turn with an empty
    /// `text`.
    pub images: usize,
    pub documents: usize,
    pub at: DateTime<Utc>,
}

/// What a session has cost, as far as the log can say.
///
/// `unpriced_exchanges` is not a rounding detail: a session that ran entirely
/// on a model with no verified price has `usd == 0.0`, and rendering that as
/// "$0.00" would claim it was free. Non-zero means `usd` is a floor.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct SessionCost {
    pub usd: f64,
    pub unpriced_exchanges: usize,
}

impl SessionCost {
    /// Whether every exchange in the session had a known price.
    pub fn is_complete(&self) -> bool {
        self.unpriced_exchanges == 0
    }
}

/// What a chat was started as, decided at its birth and never changed.
///
/// One field with three values rather than two booleans, because the two
/// modes that are not `Normal` are a ladder and not a pair of switches:
/// `Ephemeral` drops everything `Incognito` drops and then also the log.
/// A shell that asks "may this chat write anything" wants
/// [`ChatMode::writes_nothing`], not a comparison against one variant.
///
/// Fixed at creation on purpose. The pipeline that an incognito chat is
/// hidden from — the chat index, the capture pass, the other chats' tools —
/// reads every log from its first line, and a chat that was ordinary for
/// ten turns has already been indexed and captured by then. A later event
/// promising "incognito from here" would be a promise nobody downstream
/// could keep; a mark on the first line is one every reader sees before it
/// reads anything else.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatMode {
    /// Logged, listed, indexed, captured — every chat before 2026-09-15.
    #[default]
    Normal,
    /// Kept and reopenable, marked as such, but it writes nothing — no
    /// file tools, no `remember` — and no other chat can read it: the index,
    /// `search_chats`, `read_chat` and the capture pass all skip it.
    Incognito,
    /// Everything `Incognito` drops, and no log at all: the session lives in
    /// memory and is gone when it is closed or switched away from. On an
    /// engine that keeps its own history the shell asks it not to.
    Ephemeral,
}

impl ChatMode {
    /// Whether this chat may reach any writer — file tools, a shell, the
    /// memory inbox. False for both non-normal modes, which is the question
    /// a tool set is built from.
    pub fn writes_nothing(self) -> bool {
        !matches!(self, ChatMode::Normal)
    }

    /// Whether other chats may read this one. The same answer as
    /// [`writes_nothing`](Self::writes_nothing) today, named separately
    /// because the two are different promises and a reader of a log should
    /// be asking the one it means.
    pub fn unread_by_others(self) -> bool {
        !matches!(self, ChatMode::Normal)
    }

    /// For serde: a normal chat is the absence of the field, so a log
    /// written today with no mode is byte-identical to yesterday's.
    fn is_normal(&self) -> bool {
        matches!(self, ChatMode::Normal)
    }
}

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
        /// What the chat was started as. Absent from every log written
        /// before the modes existed and from every normal log after, hence
        /// the `default` and the skip. See [`ChatMode`] for why it is here
        /// and not on an event of its own.
        #[serde(default, skip_serializing_if = "ChatMode::is_normal")]
        mode: ChatMode,
    },
    UserMessage {
        text: String,
        /// Images the user attached to this turn. Absent from every log
        /// written before attachments existed, hence the `default`.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        images: Vec<ImageInput>,
        /// Documents the user attached, on the same terms as `images`.
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        documents: Vec<DocumentInput>,
        at: DateTime<Utc>,
    },
    AssistantMessage {
        model: String,
        blocks: Vec<ContentBlock>,
        stop_reason: Option<String>,
        usage: Usage,
        /// What this exchange cost in USD, recorded rather than derived.
        ///
        /// Cost is the one figure a projection cannot reconstruct: it needs
        /// the provider (a model id alone does not name one — the same model
        /// is billed differently direct and through OpenRouter) and it needs
        /// the price *as it was that day*. Re-deriving an old session's cost
        /// from today's table would quietly restate history every time a
        /// vendor changes a rate. `None` where the model had no verified
        /// price, which is not the same as free.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cost: Option<f64>,
        /// When the request that produced this message was *sent* — the
        /// origin of its prompt cache's lifetime, which the API measures
        /// from the start of the request and not its end (2026-09-15,
        /// nightshift backlog 063). `at` below is the end, and a turn that
        /// ran four minutes leaves one minute on a five-minute entry, so
        /// the end is the wrong clock for a timer. On an engine that runs
        /// its own rounds the instant is the closest lower bound the stream
        /// gives — never later than the real send, so the timer can run
        /// short but not long.
        ///
        /// A field on this event rather than an event of its own because
        /// the two facts it needs — the start and the usage that names the
        /// lifetime — belong to one request, and a second event would be a
        /// second thing a rewind has to supersede in step. Absent on every
        /// log written before the field and skipped when unknown, so those
        /// lines stay byte-identical.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sent_at: Option<DateTime<Utc>>,
        /// How long the cache entry this request left lives from `sent_at`:
        /// read from the usage breakdown when it wrote, the engine's usual
        /// lifetime when it only read (a read refreshes the entry it hit),
        /// and absent when the request touched no cache — see
        /// [`Usage::cache_ttl`]. Recorded rather than re-derived because the
        /// engine's usual lifetime is a fact about the engine that ran the
        /// turn, and the log is the only place that still knows which one
        /// did.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cache_ttl: Option<CacheTtl>,
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
    /// Events `to..` (up to this marker) are superseded: the projection skips
    /// them, as though the conversation had stopped just before `to`.
    ///
    /// A marker rather than a truncation, for the same reason `Compaction` is
    /// one — the log stays append-only and a UI can still show what was
    /// dropped. It also means a rewind can supersede a `Compaction` event
    /// itself and bring the full history back, which a destructive rewind
    /// could not: the summary would be gone and the originals with it.
    Rewind {
        /// Index into the event log of the first superseded event. Always a
        /// `UserMessage`; see [`Session::rewind`].
        to: usize,
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
    /// What to call this session in a list of them. The latest one wins, the
    /// same way a `TodoState` does.
    ///
    /// Recorded rather than derived, for the reason a cost is: it is written
    /// by a model call that has already been paid for, and re-deriving it
    /// would mean paying again on every listing, on every log, every time a
    /// sidebar repainted. Deriving it *without* a model — the opening
    /// message, clipped — is what both shells did before, and it is the
    /// thing that stops working: forty chats whose names all begin "can you
    /// help me" are a list you have to open one by one.
    Title {
        text: String,
        at: DateTime<Utc>,
    },
    /// The external agent session this log mirrors, when a turn was run by
    /// one instead of by a provider call.
    ///
    /// Recorded because otherwise a conversation ends when the window does.
    /// An agent that owns its own history — Claude Code does — replays it
    /// from a handle of its own, and Nightloom's log is a *record* of that
    /// conversation rather than the thing replayed. Without the handle
    /// written down, reopening the chat tomorrow shows every turn and then
    /// starts a fresh one with no memory of any of it: a transcript that
    /// lies about being continuous, which is worse than a chat that plainly
    /// did not persist.
    ///
    /// Latest wins, the way a [`Title`] does, since one Nightloom session
    /// can span several of the agent's own (each turn opens one and resumes
    /// it next time). `agent` names which agent the handle belongs to, so a
    /// second one later cannot have its ids read as the first one's.
    ///
    /// Not part of the message projection: it is metadata about where the
    /// conversation is kept, not a turn in it.
    ///
    /// [`Title`]: SessionEvent::Title
    AgentSession {
        /// Which agent, e.g. `claude-code`.
        agent: String,
        /// The agent's own session id — what it takes to resume.
        id: String,
        at: DateTime<Utc>,
    },
    /// Which system-prompt layers this chat has switched off. The latest one
    /// wins, the way a [`Title`] does; an empty set is "all on", which is
    /// also what a log with no such event means.
    ///
    /// A log event rather than a field on the shell's connection, because
    /// the exclusion is a fact *about the chat* — a blind test that must not
    /// see the project's instructions is still that test when the chat is
    /// reopened tomorrow, or when the rail switches engines under it — and
    /// the log is where facts about the chat live. The shell reads it back
    /// at connect time and builds the prompt without those layers; it is
    /// not part of the message projection, since the prompt is assembled
    /// from it rather than replayed as a turn.
    ///
    /// Kinds, not names: a layer is switched off as a category (every
    /// `AGENTS.md` on the walk, not one of them), and a name is a path that
    /// changes when the workspace does.
    ///
    /// `edits` (2026-09-15) is the chat's own text for a layer, keyed by
    /// kind: the body the shell assembles in place of the file's — the
    /// user's memory as this chat should read it, say — wrapped and capped
    /// as the file would be. The same event as the off set rather than a
    /// sibling, because the two are one fact (what this chat does to its
    /// prompt) with one latest-wins rule, one rewind rule and one reconnect
    /// comparison; a second event that superseded on its own would leave a
    /// shell comparing two things that only ever move together. Only the
    /// kinds in [`SegmentKind::EDITABLE`] are kept, and only non-blank text:
    /// an empty override is not "send nothing" — the switch is — so it is
    /// dropped rather than stored. Absent in every log written before the
    /// field existed, and left out of the line when empty, so a log written
    /// today with no edit is byte-identical to yesterday's.
    ///
    /// [`Title`]: SessionEvent::Title
    PromptLayers {
        off: Vec<SegmentKind>,
        #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
        edits: BTreeMap<SegmentKind, String>,
        at: DateTime<Utc>,
    },
    /// The listed events keep their place in the conversation but stop
    /// carrying their content: the projection substitutes a marker naming
    /// roughly what was removed.
    ///
    /// Elision is *content* removal, never *structural* removal, and that
    /// distinction is the whole safety argument. Dropping an event outright
    /// would be the obvious implementation and it is unusable: an assistant
    /// `tool_use` whose `tool_result` vanished — or the reverse — is a 400
    /// on every provider, which is the same trap that forces
    /// [`Session::rewind`] to cut only at a user message. Because an elided
    /// event still projects a block of the same kind in the same position,
    /// with `tool_use` and reasoning handles kept verbatim, an elision
    /// cannot produce an invalid request by construction rather than by a
    /// validity check somebody has to remember to run.
    ///
    /// It is also a marker rather than a rewrite, like [`SessionEvent::Rewind`]
    /// and [`SessionEvent::Compaction`]: the log keeps the content, so a UI
    /// can still show it, [`Session::unelide`] can bring it back, and a
    /// rewind that supersedes *this* event restores what it hid.
    ///
    /// What it does not do is refund the cache. An elision in the middle of
    /// a conversation changes the bytes at that point, so every cached
    /// prefix past it is invalidated and the next turn pays full price for
    /// the remainder. That is usually a good trade — a 40k-token tool result
    /// costs more than one missed prefix — but it is a cost, and a shell
    /// should say so.
    Elide {
        /// Indices into the event log. Always live, and always events that
        /// [`Session::is_elidable`] accepts.
        targets: Vec<usize>,
        at: DateTime<Utc>,
    },
    /// Restores content hidden by an earlier [`SessionEvent::Elide`].
    ///
    /// Exists because the alternative to an undo is a user who does not dare
    /// use the feature: elision looks destructive even though it never was,
    /// and the log has held the content the whole time.
    Unelide {
        targets: Vec<usize>,
        at: DateTime<Utc>,
    },
    /// A log entry this build cannot read: an event written by a newer
    /// Nightloom, or a line the filesystem left damaged.
    ///
    /// It exists so that loading a log is *total*. The enum being
    /// `#[non_exhaustive]` says new variants are expected and protects
    /// downstream `match` arms, but it does nothing for serde — without a
    /// catch-all, one unrecognized tag makes the whole session refuse to
    /// open, and the session written by yesterday's build is not a session
    /// anybody agreed to lose.
    ///
    /// It is kept *in place* rather than skipped, and that is the load-bearing
    /// part. [`SessionEvent::Rewind`] and [`SessionEvent::Elide`] address
    /// events by index, so dropping an unreadable line would renumber every
    /// event after it and silently re-aim every marker in the log at the
    /// wrong turn. A placeholder holds the position; the raw line stays on
    /// disk untouched, so a newer build reading the same file still gets the
    /// real event back.
    ///
    /// The projection ignores it, which is the honest thing an old build can
    /// do and not a free one: if the unknown event was itself a marker that
    /// supersedes content, that content is on the wire again. Hence
    /// [`LoadReport`] — a shell is expected to say so rather than let it pass
    /// unremarked.
    #[serde(other)]
    Unknown,
}

/// A projected content block with the log event that produced it.
///
/// The mapping exists only inside the projection — by the time a
/// [`Message`] is built, a tool result has been coalesced with its
/// neighbours and a compaction summary has replaced the events it
/// superseded. A shell that wants to *act* on an item in the context needs
/// the index back, so the projection hands it out rather than making every
/// caller re-derive it.
#[derive(Debug, Clone)]
pub struct SourcedBlock {
    pub block: ContentBlock,
    pub source: BlockSource,
}

impl SourcedBlock {
    fn event(block: ContentBlock, index: usize) -> Self {
        Self {
            block,
            source: BlockSource::Event { index },
        }
    }
}

/// A projected message with per-block provenance.
#[derive(Debug, Clone)]
pub struct SourcedMessage {
    pub role: Role,
    pub content: Vec<SourcedBlock>,
}

/// What an elided event says in place of its content.
///
/// Prompt text, addressed to the model, like a tool description or a denial
/// reason. It names a size because the model can otherwise only see that
/// something is missing, and it says the content still exists because the
/// useful next move — asking for it — is only available if the model knows
/// it is there to ask for.
pub fn elision_marker(tokens: u64, images: usize, documents: usize) -> String {
    let mut parts: Vec<String> = Vec::new();
    if tokens > 0 {
        parts.push(format!("about {tokens} tokens of content"));
    }
    if images > 0 {
        parts.push(format!("{images} image{}", n_plural(images)));
    }
    if documents > 0 {
        parts.push(format!("{documents} document{}", n_plural(documents)));
    }
    // A lone attachment is the only singular case: a token count reads as
    // plural however small it is, and so does any list of two things.
    let singular = parts.is_empty() || (parts.len() == 1 && images + documents == 1);
    let what = match parts.len() {
        0 => "content".to_string(),
        1 => parts.remove(0),
        _ => {
            let last = parts.pop().expect("more than one part");
            format!("{} and {last}", parts.join(", "))
        }
    };
    format!(
        "[{} {} removed from the context by the user to save space. \
         It is still in the session log; ask if you need it.]",
        capitalized(&what),
        if singular { "was" } else { "were" }
    )
}

fn capitalized(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// What stands in for a tool result that was never recorded.
///
/// Prompt text addressed to the model, like [`elision_marker`] and like a
/// denial reason. It says the result is *missing* rather than empty, because
/// those call for opposite moves: an empty result is an answer, and a missing
/// one is a call to make again. It declines to claim the tool did not run,
/// which the log genuinely does not know — the process may have died after the
/// work was done and before it was written down.
pub fn orphan_marker(name: &str) -> String {
    format!(
        "[No result was recorded for this call: Nightloom stopped before \
         `{name}` returned. Whether it ran at all is unknown, so check rather \
         than assume, and call it again if you still need it.]"
    )
}

/// Give every `tool_use` in the projection a `tool_result` to match.
///
/// A turn records the assistant's calls and then records what they returned,
/// which leaves a window between the two — as long as a `bash` timeout, an MCP
/// round trip, or a whole subagent turn — in which the process can die. What
/// is left on disk is an assistant message holding a `tool_use` that nothing
/// answers, and every provider rejects that on replay. Untreated it is the
/// worst shape of bug this log can produce: the session lists normally, opens
/// normally, renders its whole history, and then fails with a 400 on every
/// turn forever, with nothing anywhere saying which of the events is at fault.
///
/// It is answered in the projection rather than repaired in the log, and that
/// follows the rule the rest of this module already keeps: the log records
/// what happened, and no tool result happened. `Elide` makes the same trade —
/// keep the structure valid by construction on the way to the wire, and leave
/// the history saying exactly what it said.
///
/// A partly-recorded round is the ordinary case here, not an edge one: three
/// calls with two results is precisely what a crash between them looks like.
/// So the check is per call id, and a supplied result joins the round's
/// existing results rather than forming a second message that would split the
/// round in two.
fn answer_orphaned_calls(messages: &mut Vec<SourcedMessage>) {
    let mut i = 0;
    while i < messages.len() {
        if messages[i].role != Role::Assistant {
            i += 1;
            continue;
        }
        let calls: Vec<(String, String)> = messages[i]
            .content
            .iter()
            .filter_map(|b| match &b.block {
                ContentBlock::ToolUse { id, name, .. } => Some((id.clone(), name.clone())),
                _ => None,
            })
            .collect();
        if calls.is_empty() {
            i += 1;
            continue;
        }
        // The round's results, if any of them were recorded before the stop.
        let round = messages.get(i + 1).filter(|m| {
            m.role == Role::User
                && m.content
                    .iter()
                    .any(|b| matches!(b.block, ContentBlock::ToolResult { .. }))
        });
        let answered: Vec<&str> = round
            .map(|m| {
                m.content
                    .iter()
                    .filter_map(|b| match &b.block {
                        ContentBlock::ToolResult { tool_use_id, .. } => Some(tool_use_id.as_str()),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default();
        let had_round = round.is_some();
        let missing: Vec<SourcedBlock> = calls
            .iter()
            .filter(|(id, _)| !answered.contains(&id.as_str()))
            .map(|(id, name)| SourcedBlock {
                block: ContentBlock::ToolResult {
                    tool_use_id: id.clone(),
                    name: name.clone(),
                    content: orphan_marker(name),
                    is_error: true,
                },
                source: BlockSource::Repair,
            })
            .collect();
        if missing.is_empty() {
            i += 1;
            continue;
        }
        if had_round {
            messages[i + 1].content.extend(missing);
        } else {
            messages.insert(
                i + 1,
                SourcedMessage {
                    role: Role::User,
                    content: missing,
                },
            );
        }
        i += 1;
    }
}

/// An elided assistant message: readable content replaced by a marker,
/// replay tokens kept verbatim.
///
/// `ToolUse` survives because a call whose result went missing — or the
/// reverse — is rejected by every provider, and because its `signature`
/// carries Gemini's `thoughtSignature`, which round two of a tool loop
/// hard-requires. `ReasoningRef` survives for the same reason on the OpenAI
/// side. What goes is what a reader would call content: the text and the
/// thinking.
///
/// Dropping thinking is safe *between* turns and would not be inside one.
/// Anthropic wants the final assistant turn's thinking blocks back while a
/// tool loop is still open and ignores them on earlier turns; elision acts
/// on a session whose last round has already closed, so the loop that needed
/// them is over.
fn elide_assistant(blocks: &[ContentBlock], index: usize) -> Vec<SourcedBlock> {
    let mut dropped = 0u64;
    let mut kept: Vec<SourcedBlock> = Vec::new();
    for b in blocks {
        match b {
            ContentBlock::ToolUse { .. } | ContentBlock::ReasoningRef { .. } => {
                kept.push(SourcedBlock::event(b.clone(), index));
            }
            ContentBlock::Text { text } | ContentBlock::Thinking { text, .. } => {
                dropped += estimate_tokens(text);
            }
            // `RedactedThinking` goes too, and is not counted: its payload is
            // an opaque blob whose length says nothing about how many tokens
            // it stands for, and a size the user cannot act on is worse in the
            // marker than absent from it. Dropping it is safe on the same
            // ground as dropping thinking — a signature is only required
            // *within* the turn that produced it, and an elision only applies
            // to a round that has already closed.
            ContentBlock::RedactedThinking { .. } => {}
            _ => {}
        }
    }
    // The marker leads. An assistant message that opens with text and then
    // calls a tool is the ordinary shape, and it keeps any `ReasoningRef`
    // adjacent to the call it produced, which OpenAI Responses requires.
    let mut out = vec![SourcedBlock::event(
        ContentBlock::Text {
            text: elision_marker(dropped, 0, 0),
        },
        index,
    )];
    out.extend(kept);
    out
}

fn n_plural(n: usize) -> &'static str {
    if n == 1 { "" } else { "s" }
}

/// What [`Session::load`] had to work around to open a log.
///
/// The log is the source of truth for a conversation, so opening one is not
/// allowed to be all-or-nothing: a single line this build cannot read must
/// not cost every turn recorded before it. That tolerance has to be visible,
/// though, or it becomes silent damage — hence a report rather than a
/// `Result`, and [`LoadReport::summary`] so both shells say the same sentence
/// about it instead of each inventing one.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LoadReport {
    /// Entries whose `event` tag this build does not know, held in place as
    /// [`SessionEvent::Unknown`]. Almost always a log written by a newer
    /// Nightloom.
    pub unknown_events: usize,
    /// Entries that were not readable JSON, held in place the same way.
    pub damaged_lines: usize,
    /// A final partial record, discarded. Distinct from a damaged line
    /// because it is the one entry that may never have finished being
    /// written, which makes discarding it recovery rather than loss.
    pub torn_tail: bool,
}

impl LoadReport {
    /// Whether the log read back exactly as written.
    pub fn is_clean(&self) -> bool {
        self.unknown_events == 0 && self.damaged_lines == 0 && !self.torn_tail
    }

    /// One line for a shell to show, or `None` when there is nothing to say.
    ///
    /// It names the consequence rather than the count alone: an unreadable
    /// event that happened to be a `Rewind` or an `Elide` is not being
    /// honoured, so content the user had hidden is on the wire again, and
    /// that is the part worth knowing.
    pub fn summary(&self) -> Option<String> {
        if self.is_clean() {
            return None;
        }
        let mut parts = Vec::new();
        if self.unknown_events > 0 {
            parts.push(format!(
                "{} event{} written by a newer version",
                self.unknown_events,
                n_plural(self.unknown_events)
            ));
        }
        if self.damaged_lines > 0 {
            parts.push(format!(
                "{} damaged line{}",
                self.damaged_lines,
                n_plural(self.damaged_lines)
            ));
        }
        if self.torn_tail {
            parts.push("an unfinished final entry".to_string());
        }
        let mut out = format!("session log: {} could not be read", parts.join(" and "));
        if self.unknown_events > 0 || self.damaged_lines > 0 {
            out.push_str(
                "; they keep their place in the log, but anything they hid or undid \
                 is no longer being applied",
            );
        }
        out.push('.');
        Some(out)
    }
}

/// The point at which a session stopped reaching its log, and why.
///
/// A write failure is not allowed to be a gap. `Rewind` and `Elide` name their
/// targets by index, so a log missing one event in the middle renumbers every
/// event after it and re-aims every marker recorded since at a different turn —
/// the same quiet corruption [`SessionEvent::Unknown`] holds its place to
/// prevent, arriving instead through the error path. So the first failed append
/// seals the log: what is on disk stays a correctly numbered *prefix* of the
/// conversation, which is the recoverable half of a bad situation, and the
/// turns after it live in memory for as long as the process does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteFailure {
    /// Index of the first event that did not reach the log. Everything before
    /// it is on disk, at the index it has in memory.
    pub from_event: usize,
    /// What the filesystem said.
    pub error: String,
}

impl WriteFailure {
    /// One line for a shell to show. Says what stopped rather than what
    /// failed, because a stderr line no GUI has is how this went unnoticed.
    pub fn summary(&self) -> String {
        format!(
            "session log: writing stopped at event {} ({}); this conversation \
             is no longer being saved.",
            self.from_event, self.error
        )
    }
}

pub struct Session {
    pub id: String,
    events: Vec<SessionEvent>,
    log: Option<JsonlLog>,
    load_report: LoadReport,
    write_failure: Option<WriteFailure>,
}

impl Session {
    /// In-memory session with no persistence.
    ///
    /// Its mode is [`ChatMode::Normal`], not `Ephemeral`, although nothing
    /// here reaches a disk either: this is what a capture turn, a dream
    /// turn and a test use, and none of those is a chat the user asked to
    /// forget. [`Session::ephemeral`] is the one that says so.
    pub fn new() -> Self {
        Self::create(
            uuid::Uuid::new_v4().to_string(),
            Utc::now(),
            None,
            ChatMode::Normal,
        )
    }

    /// An in-memory session that *is* the user's chat, started as
    /// [`ChatMode::Ephemeral`]: no file is ever created for it, so closing
    /// it or switching away is the end of it, and there is no listing entry
    /// to reopen it from. The events still accumulate in memory — that is
    /// what the engine projects the next turn from.
    pub fn ephemeral() -> Self {
        Self::create(
            uuid::Uuid::new_v4().to_string(),
            Utc::now(),
            None,
            ChatMode::Ephemeral,
        )
    }

    /// Session persisted as JSONL under `dir/<session-id>.jsonl`.
    pub fn with_log(dir: impl AsRef<Path>) -> io::Result<Self> {
        Self::with_log_in_mode(dir, ChatMode::Normal)
    }

    /// The same log, marked [`ChatMode::Incognito`] on its first line so
    /// every reader that walks the directory can skip it before reading a
    /// second byte. Kept and reopenable like any other log; what differs is
    /// what the shell builds around it and who else may read it.
    pub fn incognito(dir: impl AsRef<Path>) -> io::Result<Self> {
        Self::with_log_in_mode(dir, ChatMode::Incognito)
    }

    /// A persisted session in the given mode. `Ephemeral` is refused: a
    /// mode whose whole meaning is "no log" cannot be the mode of a log,
    /// and a caller asking for one has confused the two constructors.
    pub fn with_log_in_mode(dir: impl AsRef<Path>, mode: ChatMode) -> io::Result<Self> {
        if mode == ChatMode::Ephemeral {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "an ephemeral session has no log; use Session::ephemeral()",
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let log = JsonlLog::create(dir.as_ref().join(format!("{id}.jsonl")))?;
        Ok(Self::create(id, Utc::now(), Some(log), mode))
    }

    /// The one constructor behind the four above: record the creation
    /// event and nothing else.
    fn create(id: String, at: DateTime<Utc>, log: Option<JsonlLog>, mode: ChatMode) -> Self {
        let mut s = Self {
            id: id.clone(),
            events: Vec::new(),
            log,
            load_report: LoadReport::default(),
            write_failure: None,
        };
        s.record(SessionEvent::SessionCreated { id, at, mode });
        s
    }

    /// The same log under an id and a creation time the *caller* supplies.
    ///
    /// This is what importing a conversation that happened somewhere else
    /// needs, and both of the things [`Session::with_log`] decides for itself
    /// are wrong for it. A fresh uuid would make re-running an import a second
    /// copy of every chat rather than a no-op, and `Utc::now()` would date a
    /// year-old conversation to this afternoon — which is not a cosmetic loss,
    /// since every listing in both shells sorts on it, so an afternoon of
    /// importing would flatten a year of history into one timestamp.
    ///
    /// Idempotency is the file, not a check somebody remembers to run: the id
    /// *is* the filename and the log is created with `create_new`, so a second
    /// import of the same conversation fails here with
    /// [`io::ErrorKind::AlreadyExists`] and a caller walking a thousand of them
    /// reads that as "already have this one" rather than as a failure.
    ///
    /// The id is validated because it becomes a path segment and, unlike the
    /// generated one, it came from outside — an export is a zip that arrived by
    /// email, and `../../..` in a conversation id would otherwise be a write
    /// wherever it pointed.
    pub fn with_log_as(
        dir: impl AsRef<Path>,
        id: impl Into<String>,
        at: DateTime<Utc>,
    ) -> io::Result<Self> {
        let id = id.into();
        if id.is_empty()
            || !id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{id:?} is not usable as a session id"),
            ));
        }
        let log = JsonlLog::create(dir.as_ref().join(format!("{id}.jsonl")))?;
        // An import is an ordinary chat: what it was on the other side was
        // never one of these modes.
        Ok(Self::create(id, at, Some(log), ChatMode::Normal))
    }

    /// Rebuild a session from a previously written JSONL log and reopen it
    /// for appending.
    ///
    /// Reading is *total*: every line becomes exactly one event, and one this
    /// build cannot parse becomes [`SessionEvent::Unknown`] rather than an
    /// error. A log is not a document that is either valid or worthless — it
    /// is the only copy of a conversation, and the failure it has to survive
    /// is the process dying mid-write, which is exactly when refusing to open
    /// would cost the most. [`Session::load_report`] says what was worked
    /// around; only I/O failures are still `Err` — including a line the
    /// filesystem left as bytes that are not text, which costs that line and
    /// nothing else.
    ///
    /// The placeholder holds its position deliberately. `Rewind` and `Elide`
    /// name their targets by index, so skipping a line would renumber the log
    /// and re-aim every marker in it at a different turn — a quiet corruption
    /// where the loud one was merely an inconvenience.
    ///
    /// Nothing is written here. A torn final record is noted and put right on
    /// the first append, so viewing a session never modifies it and a log on
    /// read-only media still opens.
    pub fn load(path: impl AsRef<Path>) -> io::Result<Self> {
        let path = path.as_ref();
        // Read bytes and decode a line at a time, rather than the whole file at
        // once: a log the filesystem mangled a byte of is exactly the damaged
        // line this reader exists to survive, and requiring the file to be
        // valid UTF-8 end to end would spend the entire conversation on it. A
        // line that will not decode fails to parse and becomes `Unknown` in
        // place, like any other line this build cannot read. Offsets stay on
        // the raw bytes, since that is what `Repair::TruncateTo` cuts.
        let raw = fs::read(path)?;
        let mut events = Vec::new();
        let mut report = LoadReport::default();

        // A record is committed when its newline is: `writeln!` puts the
        // payload and the terminator down together, so a file that does not
        // end in one stopped in the middle of a write.
        let torn = raw.last().is_some_and(|b| *b != b'\n');
        let last_start = raw.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
        let mut repair = None;

        let mut offset = 0usize;
        for line in raw.split_inclusive(|b| *b == b'\n') {
            let start = offset;
            offset += line.len();
            let decoded = String::from_utf8_lossy(line);
            let text = decoded.trim_end_matches(['\n', '\r']);
            if text.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<SessionEvent>(text) {
                Ok(SessionEvent::Unknown) => {
                    report.unknown_events += 1;
                    events.push(SessionEvent::Unknown);
                }
                Ok(event) => events.push(event),
                // The final partial record is the one entry that may never
                // have happened, and the only one whose removal moves no
                // index.
                Err(_) if torn && start == last_start => {
                    report.torn_tail = true;
                    repair = Some(Repair::TruncateTo(start as u64));
                }
                Err(_) => {
                    report.damaged_lines += 1;
                    events.push(SessionEvent::Unknown);
                }
            }
        }
        if torn && repair.is_none() {
            // The last record parsed but its terminator never landed. Left
            // alone, the next append would fuse onto the end of it.
            repair = Some(Repair::Separator);
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
            log: Some(JsonlLog::append_to(path, repair)?),
            load_report: report,
            write_failure: None,
        })
    }

    /// What opening this session's log had to work around. Clean for a
    /// session that was created rather than loaded.
    pub fn load_report(&self) -> LoadReport {
        self.load_report
    }

    pub fn record(&mut self, event: SessionEvent) {
        if let Some(log) = &mut self.log {
            // A persistence failure must not lose the in-memory turn, and must
            // not write the *next* one either: an event missing from the middle
            // of the log renumbers everything after it, so a `Rewind` or
            // `Elide` recorded later — carrying the in-memory index — would
            // come back aimed at a different turn. Sealing the log keeps what
            // reached the disk a correctly numbered prefix. See
            // [`WriteFailure`].
            if let Err(e) = log.append(&event) {
                eprintln!("nightloom: failed to write session log: {e}");
                self.write_failure = Some(WriteFailure {
                    from_event: self.events.len(),
                    error: e.to_string(),
                });
                self.log = None;
            }
        }
        self.events.push(event);
    }

    /// Where this session stopped being written to disk, if it did.
    ///
    /// `None` for a healthy session and for one that never had a log. A shell
    /// that shows nothing here is telling the user their conversation is being
    /// saved when it stopped being saved some turns ago, which is why this is a
    /// queryable state rather than the stderr line it used to be — a GUI has no
    /// stderr to lose it to.
    pub fn write_failure(&self) -> Option<&WriteFailure> {
        self.write_failure.as_ref()
    }

    pub fn record_user(&mut self, text: impl Into<String>) {
        self.record_user_with_attachments(text, Vec::new(), Vec::new());
    }

    pub fn record_user_with_attachments(
        &mut self,
        text: impl Into<String>,
        images: Vec<ImageInput>,
        documents: Vec<DocumentInput>,
    ) {
        self.record(SessionEvent::UserMessage {
            text: text.into(),
            images,
            documents,
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
        self.record_assistant_priced(model, blocks, stop_reason, usage, None);
    }

    pub fn record_assistant_priced(
        &mut self,
        model: impl Into<String>,
        blocks: Vec<ContentBlock>,
        stop_reason: Option<String>,
        usage: Usage,
        cost: Option<f64>,
    ) {
        self.record(SessionEvent::AssistantMessage {
            model: model.into(),
            blocks,
            stop_reason,
            usage,
            cost,
            sent_at: None,
            cache_ttl: None,
            at: Utc::now(),
        });
    }

    /// [`record_assistant_priced`](Self::record_assistant_priced) with the
    /// request's start and the cache lifetime it left behind (nightshift
    /// backlog 063). `default_ttl` is what the engine writes with when the
    /// usage does not say — the API adapter's `cache_control` lifetime, or
    /// the one measured on the agent — and `None` for a host whose cache
    /// this build cannot time. The lifetime is resolved here, once, by
    /// [`Usage::cache_ttl`], so every engine records the same rule.
    #[allow(clippy::too_many_arguments)]
    pub fn record_assistant_timed(
        &mut self,
        model: impl Into<String>,
        blocks: Vec<ContentBlock>,
        stop_reason: Option<String>,
        usage: Usage,
        cost: Option<f64>,
        sent_at: DateTime<Utc>,
        default_ttl: Option<CacheTtl>,
    ) {
        self.record(SessionEvent::AssistantMessage {
            model: model.into(),
            blocks,
            stop_reason,
            usage,
            cost,
            sent_at: Some(sent_at),
            cache_ttl: usage.cache_ttl(default_ttl),
            at: Utc::now(),
        });
    }

    pub fn record_compaction(&mut self, summary: impl Into<String>) {
        self.record(SessionEvent::Compaction {
            summary: summary.into(),
            at: Utc::now(),
        });
    }

    pub fn record_title(&mut self, text: impl Into<String>) {
        self.record(SessionEvent::Title {
            text: text.into(),
            at: Utc::now(),
        });
    }

    /// Note which of an external agent's sessions this log now mirrors.
    ///
    /// A no-op when it is already the current one: the handle usually
    /// survives a turn unchanged, and appending an identical event per turn
    /// would bury the conversation in bookkeeping.
    pub fn record_agent_session(&mut self, agent: impl Into<String>, id: impl Into<String>) {
        let agent = agent.into();
        let id = id.into();
        if self.agent_session() == Some((agent.as_str(), id.as_str())) {
            return;
        }
        self.record(SessionEvent::AgentSession {
            agent,
            id,
            at: Utc::now(),
        });
    }

    /// Note which prompt layers this chat now excludes. The chat's own
    /// texts ([`record_prompt_layer_edits`](Self::record_prompt_layer_edits))
    /// are carried forward unchanged: flipping a switch is not a way to lose
    /// an edit.
    ///
    /// Normalized — ladder order, duplicates dropped — so two ways of saying
    /// the same set compare equal, and a no-op when the set is unchanged,
    /// for the reason [`record_agent_session`](Self::record_agent_session)
    /// is: a shell that re-sends the current set on every reconnect must
    /// not fill the log with it.
    pub fn record_prompt_layers(&mut self, off: impl IntoIterator<Item = SegmentKind>) {
        let edits = self.prompt_layer_edits().clone();
        self.record_prompt_layer_choice(off, edits);
    }

    /// Note the chat's own text for its layers — the whole map, replacing
    /// the last one, so removing an override is recording the map without
    /// it. The off set is carried forward unchanged, as
    /// [`record_prompt_layers`](Self::record_prompt_layers) carries these.
    ///
    /// Normalized the same way: kinds outside [`SegmentKind::EDITABLE`] are
    /// dropped, each text is trimmed, and a text that trims to nothing is
    /// dropped too (see the event's doc for why). A no-op when the result is
    /// what the log already says.
    pub fn record_prompt_layer_edits(&mut self, edits: BTreeMap<SegmentKind, String>) {
        let off = self.prompt_layers_off().to_vec();
        self.record_prompt_layer_choice(off, edits);
    }

    /// The one writer behind the two above: both halves normalized, one
    /// event, skipped when nothing changed.
    fn record_prompt_layer_choice(
        &mut self,
        off: impl IntoIterator<Item = SegmentKind>,
        edits: BTreeMap<SegmentKind, String>,
    ) {
        let wanted: Vec<SegmentKind> = off.into_iter().collect();
        let off: Vec<SegmentKind> = SegmentKind::LAYERS
            .iter()
            .copied()
            .filter(|k| wanted.contains(k))
            .collect();
        let edits: BTreeMap<SegmentKind, String> = edits
            .into_iter()
            .filter(|(k, _)| SegmentKind::EDITABLE.contains(k))
            .map(|(k, t)| (k, t.trim().to_string()))
            .filter(|(_, t)| !t.is_empty())
            .collect();
        if self.prompt_layers_off() == off.as_slice() && *self.prompt_layer_edits() == edits {
            return;
        }
        self.record(SessionEvent::PromptLayers {
            off,
            edits,
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

    /// Which events still count, after every [`SessionEvent::Rewind`] in the
    /// log has been applied.
    ///
    /// Chained and overlapping rewinds fall out of this without a special
    /// case: each one clears its own range, and a later rewind reaching
    /// further back simply clears a superset of an earlier one's range.
    fn live_flags(&self) -> Vec<bool> {
        let mut live = vec![true; self.events.len()];
        for (i, e) in self.events.iter().enumerate() {
            if let SessionEvent::Rewind { to, .. } = e {
                // The marker is not itself part of the conversation.
                live[i] = false;
                for flag in live.iter_mut().take(i).skip(*to) {
                    *flag = false;
                }
            }
        }
        live
    }

    /// The usage the next request's size is estimated from.
    ///
    /// The last *live* assistant turn's, and nothing from before a compaction.
    /// Input plus output of that turn is very close to what the next request
    /// bills as input, which beats summing every turn — that double-counts the
    /// whole prefix on each round.
    ///
    /// The two boundaries are the point. A rewound turn is not on the wire, and
    /// neither is anything before a `Compaction`: that marker clears everything
    /// projected before it, so a figure from the far side of one describes a
    /// conversation no longer being sent. Reading past it had the gauge report
    /// a window still 90% full on the turn immediately after the summary that
    /// emptied it — and the advisory built on that number then asked the model
    /// to compact the conversation it had just compacted. `None` rather than a
    /// guess for the one turn in between, since the next reply reports its own
    /// usage and there is no honest estimate until it does.
    pub fn context_usage(&self) -> Option<Usage> {
        let live = self.live_flags();
        self.events
            .iter()
            .enumerate()
            .rev()
            .filter(|(i, _)| live[*i])
            .find_map(|(_, e)| match e {
                SessionEvent::AssistantMessage { usage, .. } => Some(Some(*usage)),
                SessionEvent::Compaction { .. } => Some(None),
                _ => None,
            })
            .flatten()
    }

    /// The events that still count, with their positions in the full log.
    ///
    /// A UI wants both: the index is what [`Session::rewind`] takes, and
    /// rendering the superseded ones greyed out beside the live ones is the
    /// whole reason the log keeps them.
    pub fn live_events(&self) -> Vec<(usize, &SessionEvent)> {
        let live = self.live_flags();
        self.events
            .iter()
            .enumerate()
            .filter(|(i, _)| live[*i])
            .collect()
    }

    /// Points the session can be rewound to: every user message still live,
    /// oldest first.
    ///
    /// Every user message is a checkpoint, rather than only the ones somebody
    /// thought to plant. Planted checkpoints are the wrong shape for this —
    /// you find out which turn you wanted back *after* the turn that spoiled
    /// it, and by then it is too late to have marked it.
    pub fn checkpoints(&self) -> Vec<Checkpoint> {
        self.live_events()
            .into_iter()
            .filter_map(|(index, e)| match e {
                SessionEvent::UserMessage {
                    text,
                    images,
                    documents,
                    at,
                } => Some(Checkpoint {
                    index,
                    text: text.clone(),
                    images: images.len(),
                    documents: documents.len(),
                    at: *at,
                }),
                _ => None,
            })
            .collect()
    }

    /// Supersede everything from event `to` onward, returning how many live
    /// events that dropped.
    ///
    /// `to` must be a live `UserMessage`, and the restriction is load-bearing
    /// rather than tidiness: cutting anywhere else can land inside a tool
    /// round and leave an assistant `tool_use` whose `tool_result` was
    /// superseded, which every provider rejects on replay. A user message is
    /// the one position where the preceding exchange is always complete.
    ///
    /// Nothing on disk is removed and no cost is refunded — the tokens were
    /// spent, and [`Session::cost`] keeps counting them.
    pub fn rewind(&mut self, to: usize) -> Result<usize, String> {
        let live = self.live_flags();
        match self.events.get(to) {
            None => return Err(format!("no event at {to}")),
            Some(SessionEvent::UserMessage { .. }) => {}
            Some(_) => {
                return Err(format!(
                    "event {to} is not a user message; a session can only be rewound to the start of a turn"
                ));
            }
        }
        if !live[to] {
            return Err(format!("event {to} was already rewound away"));
        }
        let dropped = live[to..].iter().filter(|l| **l).count();
        self.record(SessionEvent::Rewind { to, at: Utc::now() });
        Ok(dropped)
    }

    /// Which events are currently standing in for their content.
    ///
    /// Elide and unelide markers are applied in log order, so the last word
    /// on any index wins. Only *live* markers count, which is what makes
    /// rewind compose with elision for free: rewinding past an elision
    /// supersedes the marker along with everything else in the range, and
    /// the content comes back — the same property that lets a rewind undo a
    /// compaction.
    pub(crate) fn elide_flags(&self) -> Vec<bool> {
        let live = self.live_flags();
        let mut elided = vec![false; self.events.len()];
        for (i, e) in self.events.iter().enumerate() {
            if !live[i] {
                continue;
            }
            let (targets, on) = match e {
                SessionEvent::Elide { targets, .. } => (targets, true),
                SessionEvent::Unelide { targets, .. } => (targets, false),
                _ => continue,
            };
            for &t in targets {
                if let Some(flag) = elided.get_mut(t) {
                    *flag = on;
                }
            }
        }
        elided
    }

    /// Whether the event at `index` carries content that elision can remove.
    ///
    /// The three that do are the three that put bytes on the wire: a user
    /// message, an assistant reply, and a tool result. A `Compaction` is
    /// excluded deliberately even though its summary is content — it is
    /// already the compressed form of everything behind it, and hiding it
    /// would leave the projection restarting from a marker that explains
    /// nothing.
    pub fn is_elidable(&self, index: usize) -> bool {
        matches!(
            self.events.get(index),
            Some(
                SessionEvent::UserMessage { .. }
                    | SessionEvent::AssistantMessage { .. }
                    | SessionEvent::ToolResult { .. }
            )
        )
    }

    /// Replace the content of `targets` with a marker, returning how many
    /// were newly hidden.
    ///
    /// Nothing is deleted, no cost is refunded, and the files a hidden tool
    /// call wrote are still on disk — this removes bytes from the *next
    /// request*, not from history. Already-elided targets are accepted and
    /// not counted, so a UI can re-send a selection without special-casing.
    pub fn elide(&mut self, targets: impl IntoIterator<Item = usize>) -> Result<usize, String> {
        let targets: Vec<usize> = targets.into_iter().collect();
        let live = self.live_flags();
        let already = self.elide_flags();
        let mut fresh = Vec::new();
        for t in targets {
            match self.events.get(t) {
                None => return Err(format!("no event at {t}")),
                Some(_) if !self.is_elidable(t) => {
                    return Err(format!(
                        "event {t} carries no removable content; only user messages, assistant replies and tool results do"
                    ));
                }
                Some(_) => {}
            }
            if !live[t] {
                return Err(format!(
                    "event {t} is not part of the live conversation and is already costing nothing"
                ));
            }
            if !already[t] && !fresh.contains(&t) {
                fresh.push(t);
            }
        }
        if fresh.is_empty() {
            return Ok(0);
        }
        let n = fresh.len();
        self.record(SessionEvent::Elide {
            targets: fresh,
            at: Utc::now(),
        });
        Ok(n)
    }

    /// Bring back content hidden by [`Session::elide`], returning how many
    /// were restored.
    pub fn unelide(&mut self, targets: impl IntoIterator<Item = usize>) -> Result<usize, String> {
        let elided = self.elide_flags();
        let mut restore = Vec::new();
        for t in targets {
            if t >= self.events.len() {
                return Err(format!("no event at {t}"));
            }
            if elided[t] && !restore.contains(&t) {
                restore.push(t);
            }
        }
        if restore.is_empty() {
            return Ok(0);
        }
        let n = restore.len();
        self.record(SessionEvent::Unelide {
            targets: restore,
            at: Utc::now(),
        });
        Ok(n)
    }

    /// The current task list: the most recent `TodoState`, or empty. A
    /// compaction clears it — the summary supersedes the plan that produced
    /// it, and a stale list would outlive the work it described.
    pub fn todos(&self) -> &[TodoItem] {
        for (_, e) in self.live_events().into_iter().rev() {
            match e {
                SessionEvent::TodoState { todos, .. } => return todos,
                SessionEvent::Compaction { .. } => return &[],
                _ => {}
            }
        }
        &[]
    }

    /// The session's name: the most recent live [`SessionEvent::Title`].
    ///
    /// A [`Compaction`] does *not* clear it, and that is where this parts
    /// company with [`todos`](Self::todos). A summary supersedes the plan
    /// that produced it, so a task list outliving its work is stale; a
    /// summary does not make the conversation a *different* conversation,
    /// so its name still fits.
    ///
    /// A [`Rewind`] does supersede it, like anything else it reaches back
    /// past, and that is worth having rather than an exception to write
    /// down: a rewind to the opening message is the one edit that makes the
    /// old name describe a turn that no longer counts, and leaving the
    /// session unnamed is what gets it named again from what it became.
    ///
    /// [`Compaction`]: SessionEvent::Compaction
    /// [`Rewind`]: SessionEvent::Rewind
    pub fn title(&self) -> Option<&str> {
        self.live_events()
            .into_iter()
            .rev()
            .find_map(|(_, e)| match e {
                SessionEvent::Title { text, .. } => Some(text.as_str()),
                _ => None,
            })
    }

    /// Projection: the external agent session this log currently mirrors.
    ///
    /// Read off the live events like a [`title`](Self::title), so a rewind
    /// that supersedes the marker gives back whichever one was current
    /// before it — which is the honest answer, even though a shell driving
    /// an agent should be refusing the rewind in the first place: the
    /// agent's history is not this log's to cut.
    pub fn agent_session(&self) -> Option<(&str, &str)> {
        self.live_events()
            .into_iter()
            .rev()
            .find_map(|(_, e)| match e {
                SessionEvent::AgentSession { agent, id, .. } => Some((agent.as_str(), id.as_str())),
                _ => None,
            })
    }

    /// What this chat was started as.
    ///
    /// Read off the first [`SessionEvent::SessionCreated`] in the log, and
    /// off the raw events rather than the live ones: a rewind cuts only at a
    /// user message, so the creation line is never superseded, and the mode
    /// is not a thing a rewind could honestly take back anyway — a chat that
    /// was incognito at turn one was incognito at turn one. A log that has no
    /// creation event (damaged, or foreign) is `Normal`, which is the
    /// reading every pipeline stage would have given it before the field
    /// existed.
    pub fn mode(&self) -> ChatMode {
        self.events
            .iter()
            .find_map(|e| match e {
                SessionEvent::SessionCreated { mode, .. } => Some(*mode),
                _ => None,
            })
            .unwrap_or_default()
    }

    /// Projection: the prompt layers this chat has switched off — the most
    /// recent live [`SessionEvent::PromptLayers`], or none.
    ///
    /// Read off the live events like a [`title`](Self::title), and for the
    /// same reasons on both counts: a compaction does not make the chat a
    /// different chat, so its exclusions still hold; a rewind past the event
    /// restores whatever set was current before it, which is the honest
    /// answer to "what did the model know at that turn".
    pub fn prompt_layers_off(&self) -> &[SegmentKind] {
        self.live_events()
            .into_iter()
            .rev()
            .find_map(|(_, e)| match e {
                SessionEvent::PromptLayers { off, .. } => Some(off.as_slice()),
                _ => None,
            })
            .unwrap_or(&[])
    }

    /// Projection: the chat's own text per layer — the `edits` of the most
    /// recent live [`SessionEvent::PromptLayers`], or none. The same event
    /// and the same terms as [`prompt_layers_off`](Self::prompt_layers_off):
    /// a compaction leaves it, a rewind past it restores what was current
    /// before.
    pub fn prompt_layer_edits(&self) -> &BTreeMap<SegmentKind, String> {
        static NONE: BTreeMap<SegmentKind, String> = BTreeMap::new();
        self.live_events()
            .into_iter()
            .rev()
            .find_map(|(_, e)| match e {
                SessionEvent::PromptLayers { edits, .. } => Some(edits),
                _ => None,
            })
            .unwrap_or(&NONE)
    }

    /// Projection: what this session has cost so far.
    ///
    /// Sums every recorded exchange, including ones a compaction or a rewind
    /// has superseded — both save future tokens, neither refunds past ones,
    /// and a bill that shrank when you rewound would be fiction. Exchanges
    /// with no recorded price are counted separately rather than as zero, so
    /// a caller can tell "$0.40" from "at least $0.40".
    pub fn cost(&self) -> SessionCost {
        let mut total = SessionCost::default();
        for e in &self.events {
            if let SessionEvent::AssistantMessage { cost, .. } = e {
                match cost {
                    Some(c) => total.usd += c,
                    None => total.unpriced_exchanges += 1,
                }
            }
        }
        total
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
        self.messages_sourced(sidecar)
            .into_iter()
            .map(|m| Message {
                role: m.role,
                content: m.content.into_iter().map(|b| b.block).collect(),
            })
            .collect()
    }

    /// The same projection, with each block tagged by the event that
    /// produced it.
    ///
    /// This is the projection; [`Session::messages_with_sidecar`] is it with
    /// the tags dropped. One implementation rather than two, because a
    /// context view that itemized a *different* list from the one the engine
    /// sends would be worse than no view at all.
    pub fn messages_sourced(&self, sidecar: Option<&str>) -> Vec<SourcedMessage> {
        let mut messages = self.project_sourced();
        let Some(sidecar) = sidecar.map(str::trim).filter(|s| !s.is_empty()) else {
            return messages;
        };
        if let Some(last) = messages.last_mut()
            && last.role == Role::User
            && !last
                .content
                .iter()
                .any(|b| matches!(b.block, ContentBlock::ToolResult { .. }))
        {
            last.content.push(SourcedBlock {
                block: ContentBlock::Text {
                    text: sidecar.to_string(),
                },
                source: BlockSource::Sidecar,
            });
        }
        messages
    }

    fn project_sourced(&self) -> Vec<SourcedMessage> {
        let elided = self.elide_flags();
        let mut messages: Vec<SourcedMessage> = Vec::new();
        for (i, e) in self.live_events() {
            match e {
                SessionEvent::UserMessage {
                    text,
                    images,
                    documents,
                    ..
                } => {
                    let content = if elided[i] {
                        vec![SourcedBlock::event(
                            ContentBlock::Text {
                                text: elision_marker(
                                    estimate_tokens(text),
                                    images.len(),
                                    documents.len(),
                                ),
                            },
                            i,
                        )]
                    } else {
                        let mut content: Vec<SourcedBlock> = images
                            .iter()
                            .map(|img| {
                                SourcedBlock::event(
                                    ContentBlock::Image {
                                        media_type: img.media_type.clone(),
                                        data: img.data.clone(),
                                    },
                                    i,
                                )
                            })
                            .collect();
                        content.extend(documents.iter().map(|doc| {
                            SourcedBlock::event(
                                ContentBlock::Document {
                                    media_type: doc.media_type.clone(),
                                    name: doc.name.clone(),
                                    data: doc.data.clone(),
                                },
                                i,
                            )
                        }));
                        // Attachments lead, as both Anthropic and OpenAI
                        // advise, and an empty caption is omitted rather than
                        // sent: an empty text block is rejected on the wire,
                        // and "here is a file" with nothing said about it is a
                        // real turn.
                        if !text.is_empty() || content.is_empty() {
                            content.push(SourcedBlock::event(
                                ContentBlock::Text { text: text.clone() },
                                i,
                            ));
                        }
                        content
                    };
                    messages.push(SourcedMessage {
                        role: Role::User,
                        content,
                    });
                }
                SessionEvent::AssistantMessage { blocks, .. } => {
                    let content = if elided[i] {
                        elide_assistant(blocks, i)
                    } else {
                        blocks
                            .iter()
                            .map(|b| SourcedBlock::event(b.clone(), i))
                            .collect()
                    };
                    messages.push(SourcedMessage {
                        role: Role::Assistant,
                        content,
                    });
                }
                SessionEvent::ToolResult {
                    tool_use_id,
                    name,
                    content,
                    is_error,
                    ..
                } => {
                    // Elided or not, this stays a `ToolResult` block with the
                    // same id: it is the other half of a `tool_use`, and a
                    // result that turned into plain text would orphan the
                    // call it answers.
                    let block = ContentBlock::ToolResult {
                        tool_use_id: tool_use_id.clone(),
                        name: name.clone(),
                        content: if elided[i] {
                            elision_marker(estimate_tokens(content), 0, 0)
                        } else {
                            content.clone()
                        },
                        is_error: *is_error,
                    };
                    let block = SourcedBlock::event(block, i);
                    // Results from one round of calls coalesce into the user
                    // message a provider expects them in.
                    match messages.last_mut() {
                        Some(m)
                            if m.role == Role::User
                                && matches!(
                                    m.content.last().map(|b| &b.block),
                                    Some(ContentBlock::ToolResult { .. })
                                ) =>
                        {
                            m.content.push(block)
                        }
                        _ => messages.push(SourcedMessage {
                            role: Role::User,
                            content: vec![block],
                        }),
                    }
                }
                SessionEvent::Compaction { summary, .. } => {
                    // The summary supersedes everything projected so far.
                    messages.clear();
                    messages.push(SourcedMessage {
                        role: Role::User,
                        content: vec![SourcedBlock::event(
                            ContentBlock::Text {
                                text: format!(
                                    "The conversation so far was compacted into this summary:\n\n{summary}"
                                ),
                            },
                            i,
                        )],
                    });
                }
                _ => {}
            }
        }
        answer_orphaned_calls(&mut messages);
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

/// A half-written record at the end of a log, and what putting it right takes.
///
/// Held until the first append rather than applied when the log is opened:
/// reading a session is not allowed to modify it, both because a viewer that
/// silently rewrites what it is showing is hard to trust and because a log on
/// read-only media would otherwise fail to open at all. Nothing needs the
/// repair until something needs to write past it.
#[derive(Debug, Clone, Copy)]
enum Repair {
    /// Discard a partial final record by cutting the file back to this length.
    TruncateTo(u64),
    /// The final record is intact but its newline never landed; supply one so
    /// the next record does not fuse onto it.
    Separator,
}

struct JsonlLog {
    path: PathBuf,
    file: File,
    repair: Option<Repair>,
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
        Ok(Self {
            path,
            file,
            repair: None,
        })
    }

    fn append_to(path: &Path, repair: Option<Repair>) -> io::Result<Self> {
        let file = OpenOptions::new().append(true).open(path)?;
        Ok(Self {
            path: path.to_path_buf(),
            file,
            repair,
        })
    }

    fn append(&mut self, event: &SessionEvent) -> io::Result<()> {
        if let Some(repair) = self.repair.take() {
            self.repair_tail(repair)?;
        }
        let line = serde_json::to_string(event)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        writeln!(self.file, "{line}")?;
        self.file.flush()
    }

    fn repair_tail(&mut self, repair: Repair) -> io::Result<()> {
        match repair {
            // Through a second handle on purpose: an append-mode file has no
            // write access to the bytes already in it on Windows, where
            // `set_len` through `self.file` would fail. Appends afterwards
            // still land at the end, since append mode seeks there per write.
            Repair::TruncateTo(len) => OpenOptions::new()
                .write(true)
                .open(&self.path)?
                .set_len(len),
            Repair::Separator => self.file.write_all(b"\n"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::{BlockKind, BlockSource, WireView};
    use crate::prompt::{Segment, SegmentKind, SystemPrompt};

    /// The content of a `ToolResult` block, for assertions.
    fn tool_content(block: &ContentBlock) -> &str {
        match block {
            ContentBlock::ToolResult { content, .. } => content,
            other => panic!("expected a tool result, got {other:?}"),
        }
    }

    /// One tool round: user (1), assistant with thinking + tool_use (2), the
    /// result (3), the final reply (4).
    fn tool_round_session() -> Session {
        let mut s = Session::new();
        s.record_user("read the file");
        s.record_assistant(
            "test-model",
            vec![
                ContentBlock::Thinking {
                    text: "I should read it".into(),
                    signature: Some("sig".into()),
                },
                ContentBlock::ToolUse {
                    id: "c1".into(),
                    name: "read_file".into(),
                    input: serde_json::json!({"path": "a.txt"}),
                    signature: Some("gemini-sig".into()),
                },
            ],
            Some("tool_use".into()),
            Usage::default(),
        );
        s.record_tool_result(&ContentBlock::ToolResult {
            tool_use_id: "c1".into(),
            name: "read_file".into(),
            content: "x".repeat(4_000),
            is_error: false,
        });
        s.record_assistant(
            "test-model",
            vec![ContentBlock::Text {
                text: "it says x a lot".into(),
            }],
            Some("end_turn".into()),
            Usage::default(),
        );
        s
    }

    #[test]
    fn eliding_a_tool_result_keeps_it_paired_to_its_call() {
        let mut s = tool_round_session();
        assert_eq!(s.elide([3]).unwrap(), 1);

        let msgs = s.messages();
        // Same four messages in the same roles: elision removes content, not
        // structure.
        assert_eq!(msgs.len(), 4);
        match &msgs[2].content[0] {
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                ..
            } => {
                assert_eq!(tool_use_id, "c1", "the call must keep its answer");
                assert!(content.contains("removed from the context"), "{content}");
                assert!(content.contains("1000 tokens"), "size named: {content}");
                assert!(content.len() < 400, "the marker replaced the payload");
            }
            other => panic!("expected a tool result, got {other:?}"),
        }
    }

    #[test]
    fn eliding_an_assistant_turn_keeps_its_tool_calls_and_replay_tokens() {
        let mut s = tool_round_session();
        s.elide([2]).unwrap();

        let blocks = &s.messages()[1].content;
        // Marker first, then the call — thinking is gone, the call is not.
        assert!(matches!(&blocks[0], ContentBlock::Text { text } if text.contains("removed")));
        match &blocks[1] {
            ContentBlock::ToolUse { id, signature, .. } => {
                assert_eq!(id, "c1");
                assert_eq!(
                    signature.as_deref(),
                    Some("gemini-sig"),
                    "a replay token is not content and must survive elision"
                );
            }
            other => panic!("expected the tool call to survive, got {other:?}"),
        }
        assert_eq!(blocks.len(), 2, "thinking dropped, nothing else");
    }

    #[test]
    fn elision_is_reversible_and_the_log_kept_everything() {
        let mut s = tool_round_session();
        s.elide([3]).unwrap();
        assert!(tool_content(&s.messages()[2].content[0]).contains("removed"));

        assert_eq!(s.unelide([3]).unwrap(), 1);
        assert!(
            tool_content(&s.messages()[2].content[0]).starts_with("xxxx"),
            "the payload was never gone from the log"
        );
        // Both markers are on the log, appended rather than rewritten.
        assert!(
            s.events()
                .iter()
                .any(|e| matches!(e, SessionEvent::Elide { .. }))
        );
        assert!(
            s.events()
                .iter()
                .any(|e| matches!(e, SessionEvent::Unelide { .. }))
        );
    }

    /// A rewind that supersedes the elide marker takes the elision with it,
    /// the same way it can undo a compaction.
    #[test]
    fn a_rewind_past_an_elision_restores_the_content() {
        let mut s = tool_round_session();
        s.elide([3]).unwrap();
        s.record_user("another turn");
        let checkpoint = s.checkpoints().last().unwrap().index;
        s.rewind(checkpoint).unwrap();

        // That cut at the later user message, which is after the elide
        // marker, so the elision still stands.
        assert!(s.elide_flags()[3]);

        // Rewinding to the first user message supersedes everything after
        // it, the marker included.
        s.rewind(1).unwrap();
        assert!(!s.elide_flags()[3], "the elide marker was superseded too");
    }

    #[test]
    fn elision_refuses_what_it_cannot_do_safely() {
        let mut s = tool_round_session();
        assert!(s.elide([0]).is_err(), "session_created carries no content");
        assert!(s.elide([99]).is_err(), "no such event");
        // Idempotent rather than an error: a UI re-sending a selection is
        // not a mistake.
        s.elide([3]).unwrap();
        assert_eq!(s.elide([3]).unwrap(), 0);
    }

    #[test]
    fn the_wire_view_itemizes_the_same_list_the_engine_sends() {
        let s = tool_round_session();
        let mut prompt = SystemPrompt::new();
        prompt.push(Segment::new(SegmentKind::Identity, "identity", "be brief").anchored());

        let view = WireView::assemble(Some(&prompt), &s, Some("<status>now</status>"), Some(1_000));

        assert_eq!(view.system.len(), 1);
        assert!(view.system[0].cache_anchor);

        let sent = s.messages_with_sidecar(Some("<status>now</status>"));
        assert_eq!(view.messages.len(), sent.len());
        for (m, w) in sent.iter().zip(&view.messages) {
            assert_eq!(m.role, w.role);
            assert_eq!(m.content.len(), w.blocks.len());
        }

        // The 4,000-character tool result dominates, and its block points
        // back at the event that would remove it.
        let biggest = view
            .messages
            .iter()
            .flat_map(|m| &m.blocks)
            .max_by_key(|b| b.size.bytes)
            .unwrap();
        assert_eq!(biggest.kind, BlockKind::ToolResult);
        assert_eq!(biggest.source, BlockSource::Event { index: 3 });
        assert!(biggest.elidable);
        assert!(!biggest.elided);
        assert!(biggest.truncated, "a preview, not the payload");

        assert!(view.totals.tokens > 1_000);
        assert!(view.totals.is_complete());
        assert!(view.fraction_used().unwrap() > 1.0);
    }

    /// The sidecar is in the view because it is on the wire, and marked as
    /// something no log index can act on.
    #[test]
    fn the_view_marks_the_sidecar_as_unremovable() {
        let mut s = Session::new();
        s.record_user("hi");
        let view = WireView::assemble(None, &s, Some("<status>now</status>"), None);

        let last = view.messages.last().unwrap().blocks.last().unwrap();
        assert_eq!(last.kind, BlockKind::Sidecar);
        assert_eq!(last.source, BlockSource::Sidecar);
        assert!(!last.elidable);
        assert!(view.fraction_used().is_none(), "no limit, no percentage");
    }

    /// An image contributes bytes it cannot contribute an estimate for, so
    /// the total has to declare itself a floor rather than read low.
    #[test]
    fn an_image_makes_the_view_total_a_floor() {
        let mut s = Session::new();
        s.record_user_with_attachments(
            "what is this?",
            vec![ImageInput {
                media_type: "image/png".into(),
                data: "A".repeat(40_000),
            }],
            Vec::new(),
        );
        let view = WireView::assemble(None, &s, None, None);
        assert_eq!(view.totals.unestimated, 1);
        assert!(!view.totals.is_complete());
        assert!(view.totals.bytes > 29_000, "decoded size counted");
    }

    #[test]
    fn an_elided_view_reports_what_would_restore_it() {
        let mut s = tool_round_session();
        s.elide([3]).unwrap();
        let view = WireView::assemble(None, &s, None, None);
        assert_eq!(view.elided_events(), vec![3]);
        assert!(
            view.messages
                .iter()
                .flat_map(|m| &m.blocks)
                .any(|b| b.elided && b.elidable)
        );
    }

    #[test]
    fn elide_markers_round_trip_through_jsonl() {
        let dir = std::env::temp_dir().join(format!("nightloom-elide-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut s = Session::with_log(&dir).unwrap();
        s.record_user("hello");
        s.record_assistant(
            "test-model",
            vec![ContentBlock::Text {
                text: "a long reply".into(),
            }],
            Some("end_turn".into()),
            Usage::default(),
        );
        s.elide([2]).unwrap();
        let path = s.log_path().unwrap().to_path_buf();
        let reloaded = Session::load(&path).unwrap();

        assert!(reloaded.elide_flags()[2]);
        assert!(reloaded.messages()[1].text().contains("removed"));

        std::fs::remove_dir_all(&dir).ok();
    }

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
                ..Default::default()
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
        session.record_user_with_attachments("what is this?", one_image(), Vec::new());
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
        session.record_user_with_attachments("", one_image(), Vec::new());
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
        session.record_user_with_attachments("look", one_image(), Vec::new());
        let messages = session.messages_with_sidecar(Some("time: now"));
        assert_eq!(messages[0].content.len(), 3);
        assert!(messages[0].text().contains("time: now"));
    }

    fn one_document() -> Vec<DocumentInput> {
        vec![DocumentInput {
            media_type: "application/pdf".into(),
            name: "contract.pdf".into(),
            data: "JVBERi0=".into(),
        }]
    }

    #[test]
    fn a_document_turn_projects_the_document_before_the_caption() {
        let mut session = Session::new();
        session.record_user_with_attachments("summarize", Vec::new(), one_document());
        assert!(matches!(
            session.messages()[0].content.as_slice(),
            [ContentBlock::Document { .. }, ContentBlock::Text { .. }]
        ));
    }

    /// Attachments of both kinds lead, and the caption still trails them.
    #[test]
    fn a_turn_can_carry_an_image_and_a_document_at_once() {
        let mut session = Session::new();
        session.record_user_with_attachments("compare these", one_image(), one_document());
        assert!(matches!(
            session.messages()[0].content.as_slice(),
            [
                ContentBlock::Image { .. },
                ContentBlock::Document { .. },
                ContentBlock::Text { .. }
            ]
        ));
    }

    /// The same argument the `images` key makes: a log written before
    /// documents existed has no key for them and must round-trip without
    /// growing an empty one.
    #[test]
    fn a_user_message_without_documents_loads_and_stays_that_shape() {
        let json = r#"{"event":"user_message","text":"hi","at":"2026-01-01T00:00:00Z"}"#;
        let event: SessionEvent = serde_json::from_str(json).unwrap();
        assert!(
            matches!(&event, SessionEvent::UserMessage { documents, .. } if documents.is_empty())
        );
        let back = serde_json::to_string(&event).unwrap();
        assert!(!back.contains("documents"), "{back}");
    }

    /// The marker is the only thing the model sees of an elided turn, so it
    /// has to name what went missing rather than only that something did.
    #[test]
    fn the_elision_marker_names_every_kind_of_attachment() {
        let both = elision_marker(120, 2, 1);
        assert!(both.contains("2 images"), "{both}");
        assert!(both.contains("1 document"), "{both}");
        assert!(both.contains("were removed"), "{both}");

        let one = elision_marker(0, 0, 1);
        assert!(one.starts_with("[1 document was removed"), "{one}");

        let neither = elision_marker(0, 0, 0);
        assert!(neither.starts_with("[Content was removed"), "{neither}");
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

    /// One completed exchange: user, assistant. Returns the log index the
    /// user message landed at.
    fn exchange(s: &mut Session, user: &str, reply: &str) -> usize {
        let at = s.events().len();
        s.record_user(user);
        s.record_assistant(
            "test-model",
            vec![ContentBlock::Text { text: reply.into() }],
            Some("end_turn".into()),
            Usage::default(),
        );
        at
    }

    #[test]
    fn rewinding_drops_the_turn_and_everything_after_it() {
        let mut s = Session::new();
        exchange(&mut s, "one", "first");
        let second = exchange(&mut s, "two", "second");
        exchange(&mut s, "three", "third");
        assert_eq!(s.messages().len(), 6);

        assert_eq!(s.rewind(second).unwrap(), 4);
        let msgs = s.messages();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].text(), "one");
        assert_eq!(msgs[1].text(), "first");
        // Superseded, not deleted: the log still holds every event, plus the
        // marker. That is what lets a UI show what was dropped.
        // SessionCreated + three exchanges + the marker.
        assert_eq!(s.events().len(), 8);
    }

    #[test]
    fn a_rewind_refuses_to_cut_inside_a_tool_round() {
        let mut s = Session::new();
        s.record_user("go");
        s.record_assistant(
            "test-model",
            vec![ContentBlock::ToolUse {
                id: "c1".into(),
                name: "t".into(),
                input: serde_json::json!({}),
                signature: None,
            }],
            Some("tool_use".into()),
            Usage::default(),
        );
        s.record_tool_result(&ContentBlock::ToolResult {
            tool_use_id: "c1".into(),
            name: "t".into(),
            content: "done".into(),
            is_error: false,
        });
        // Cutting at the tool result would leave the assistant's `tool_use`
        // with no matching result, which every provider rejects on replay.
        let err = s.rewind(2).unwrap_err();
        assert!(err.contains("not a user message"), "{err}");
        assert_eq!(s.messages().len(), 3);
    }

    #[test]
    fn rewinds_chain_and_the_wider_one_wins() {
        let mut s = Session::new();
        let first = exchange(&mut s, "one", "first");
        let second = exchange(&mut s, "two", "second");
        exchange(&mut s, "three", "third");

        s.rewind(second).unwrap();
        assert_eq!(s.messages().len(), 2);
        // Reaching further back over ground an earlier rewind already
        // cleared: the ranges overlap, and the result is their union.
        s.rewind(first).unwrap();
        assert!(s.messages().is_empty());
        assert!(s.checkpoints().is_empty());

        // The same point cannot be rewound twice — it is already gone.
        let err = s.rewind(second).unwrap_err();
        assert!(err.contains("already rewound"), "{err}");
    }

    #[test]
    fn a_rewind_can_undo_a_compaction() {
        let mut s = Session::new();
        exchange(&mut s, "one", "first");
        let second = exchange(&mut s, "two", "second");
        s.record(SessionEvent::Compaction {
            summary: "they said things".into(),
            at: Utc::now(),
        });
        // The compaction has superseded the history.
        assert_eq!(s.messages().len(), 1);
        assert!(s.messages()[0].text().contains("they said things"));

        // Rewinding past it supersedes the compaction event itself, and the
        // originals come back — which is only possible because neither
        // operation deletes anything.
        s.rewind(second).unwrap();
        let msgs = s.messages();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[0].text(), "one");
    }

    #[test]
    fn a_rewind_refunds_nothing() {
        let mut s = Session::new();
        let first = exchange(&mut s, "one", "first");
        s.record_assistant_priced(
            "test-model",
            vec![ContentBlock::Text { text: "x".into() }],
            Some("end_turn".into()),
            Usage::default(),
            Some(0.25),
        );
        s.rewind(first).unwrap();
        assert!(s.messages().is_empty());
        // The tokens were spent. A bill that shrank on rewind would be
        // fiction, and the same is true of the token totals.
        assert_eq!(s.cost().usd, 0.25);
    }

    #[test]
    fn a_rewound_task_list_reverts_to_the_earlier_one() {
        use crate::todo::{TodoItem, TodoStatus};
        let mut s = Session::new();
        exchange(&mut s, "one", "first");
        s.record_todos(vec![TodoItem::new("early plan", TodoStatus::Pending)]);
        let second = exchange(&mut s, "two", "second");
        s.record_todos(vec![TodoItem::new("later plan", TodoStatus::InProgress)]);
        assert_eq!(s.todos()[0].content, "later plan");

        s.rewind(second).unwrap();
        // The panel and the copy the model reads in its sidecar both come
        // from here, so a stale list would desync them from the transcript.
        assert_eq!(s.todos().len(), 1);
        assert_eq!(s.todos()[0].content, "early plan");
    }

    #[test]
    fn checkpoints_are_the_live_user_messages() {
        let mut s = Session::new();
        exchange(&mut s, "one", "first");
        let second = exchange(&mut s, "two", "second");
        exchange(&mut s, "three", "third");
        let points = s.checkpoints();
        let texts: Vec<&str> = points.iter().map(|c| c.text.as_str()).collect();
        assert_eq!(texts, ["one", "two", "three"]);

        s.rewind(second).unwrap();
        let points = s.checkpoints();
        let texts: Vec<&str> = points.iter().map(|c| c.text.as_str()).collect();
        assert_eq!(texts, ["one"]);
    }

    #[test]
    fn a_rewound_log_round_trips_through_jsonl() {
        let dir = std::env::temp_dir().join(format!("nightloom-rewind-{}", uuid::Uuid::new_v4()));
        let mut s = Session::with_log(&dir).unwrap();
        exchange(&mut s, "one", "first");
        let second = exchange(&mut s, "two", "second");
        s.rewind(second).unwrap();
        let path = s.log_path().unwrap().to_path_buf();
        let events = s.events().len();
        drop(s);

        let loaded = Session::load(&path).unwrap();
        assert_eq!(loaded.events().len(), events);
        assert_eq!(loaded.messages().len(), 2);
        assert_eq!(loaded.checkpoints().len(), 1);
        std::fs::remove_dir_all(&dir).ok();
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
        assert!(loaded.load_report().is_clean());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A temp dir plus a session logged into it, for the crash-recovery tests.
    fn logged_session(tag: &str) -> (PathBuf, Session) {
        let dir = std::env::temp_dir().join(format!("nightloom-{tag}-{}", uuid::Uuid::new_v4()));
        let s = Session::with_log(&dir).unwrap();
        (dir, s)
    }

    /// The shape a crash between a call and its result leaves on disk: an
    /// assistant `tool_use` that nothing answers.
    fn orphaned_call_session() -> Session {
        let mut s = Session::new();
        s.record_user("read the file");
        s.record_assistant(
            "test-model",
            vec![ContentBlock::ToolUse {
                id: "c1".into(),
                name: "read_file".into(),
                input: serde_json::json!({ "path": "a.txt" }),
                signature: None,
            }],
            Some("tool_use".into()),
            Usage::default(),
        );
        s
    }

    #[test]
    fn an_unanswered_call_gets_a_result_on_the_wire() {
        let s = orphaned_call_session();
        let messages = s.messages();

        // user, assistant(tool_use), user(result) — the shape a provider
        // accepts, rather than the two-message shape it 400s on.
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[2].role, Role::User);
        match &messages[2].content[0] {
            ContentBlock::ToolResult {
                tool_use_id,
                name,
                content,
                is_error,
            } => {
                assert_eq!(tool_use_id, "c1");
                assert_eq!(name, "read_file");
                assert!(*is_error);
                assert!(content.contains("No result was recorded"));
                // It must not claim the call did not run: the process may
                // have died after the work was done and before it was logged.
                assert!(content.contains("Whether it ran at all is unknown"));
            }
            other => panic!("expected a supplied tool result, got {other:?}"),
        }
    }

    #[test]
    fn a_supplied_result_is_marked_as_the_projections_own() {
        let s = orphaned_call_session();
        let blocks = &s.messages_sourced(None)[2].content;
        assert_eq!(blocks[0].source, BlockSource::Repair);
        // Nothing in the log produced it, so nothing in the log can act on it.
        let view = WireView::assemble(None, &s, None, None);
        let repaired = &view.messages[2].blocks[0];
        assert!(!repaired.elidable);
        assert!(!repaired.elided);
    }

    #[test]
    fn a_half_recorded_round_is_completed_call_by_call() {
        let mut s = Session::new();
        s.record_user("read both");
        s.record_assistant(
            "test-model",
            vec![
                ContentBlock::ToolUse {
                    id: "c1".into(),
                    name: "read_file".into(),
                    input: serde_json::json!({ "path": "a.txt" }),
                    signature: None,
                },
                ContentBlock::ToolUse {
                    id: "c2".into(),
                    name: "read_file".into(),
                    input: serde_json::json!({ "path": "b.txt" }),
                    signature: None,
                },
            ],
            Some("tool_use".into()),
            Usage::default(),
        );
        // Only the first call's result was written before the stop.
        s.record_tool_result(&ContentBlock::ToolResult {
            tool_use_id: "c1".into(),
            name: "read_file".into(),
            content: "contents of a".into(),
            is_error: false,
        });

        let messages = s.messages();
        assert_eq!(messages.len(), 3);
        // Both results land in the one message the round belongs in, rather
        // than the supplied one splitting the round across two.
        assert_eq!(messages[2].content.len(), 2);
        assert_eq!(tool_content(&messages[2].content[0]), "contents of a");
        assert!(tool_content(&messages[2].content[1]).contains("No result was recorded"));
    }

    #[test]
    fn a_completed_round_is_left_alone() {
        let s = tool_round_session();
        let before = s.messages();
        // Every call already has its result; nothing is supplied, and in
        // particular no block is appended to a round that was fine.
        assert_eq!(before.len(), 4);
        assert_eq!(before[2].content.len(), 1);
        assert!(
            s.messages_sourced(None)
                .iter()
                .flat_map(|m| &m.content)
                .all(|b| b.source != BlockSource::Repair)
        );
    }

    #[test]
    fn an_elided_call_still_gets_its_missing_result() {
        let mut s = orphaned_call_session();
        // Eliding the assistant turn keeps the `tool_use` verbatim, so the
        // call it holds still needs answering.
        s.elide([2]).unwrap();
        let messages = s.messages();
        assert_eq!(messages.len(), 3);
        assert!(tool_content(&messages[2].content[0]).contains("No result was recorded"));
    }

    #[test]
    fn a_rewound_orphan_needs_no_result() {
        let mut s = orphaned_call_session();
        // Rewinding past the turn supersedes the call itself.
        s.rewind(1).unwrap();
        assert!(s.messages().is_empty());
    }

    #[test]
    fn a_torn_final_record_costs_only_itself() {
        let (dir, mut s) = logged_session("torn");
        s.record_user("hello");
        s.record_assistant(
            "test-model",
            vec![ContentBlock::Text { text: "hi".into() }],
            Some("end_turn".into()),
            Usage::default(),
        );
        let path = s.log_path().unwrap().to_path_buf();
        drop(s);

        // A write that stopped partway: no terminator, so no committed record.
        let mut raw = std::fs::read_to_string(&path).unwrap();
        raw.push_str("{\"event\":\"user_message\",\"text\":\"trunc");
        std::fs::write(&path, raw).unwrap();

        let mut loaded = Session::load(&path).unwrap();
        assert_eq!(loaded.messages().len(), 2);
        assert!(loaded.load_report().torn_tail);
        assert_eq!(loaded.load_report().damaged_lines, 0);

        // The next append has to land on its own line rather than fusing onto
        // the fragment, so the log still reads back as what is in memory.
        loaded.record_user("after the crash");
        let events = loaded.events().len();
        drop(loaded);
        let again = Session::load(&path).unwrap();
        assert!(again.load_report().is_clean());
        assert_eq!(again.events().len(), events);
        assert_eq!(again.messages().len(), 3);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_record_whose_newline_never_landed_is_kept() {
        let (dir, mut s) = logged_session("nonewline");
        s.record_user("hello");
        let path = s.log_path().unwrap().to_path_buf();
        drop(s);

        // The payload is all there; only the terminator is missing.
        let raw = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, raw.trim_end_matches('\n')).unwrap();

        let mut loaded = Session::load(&path).unwrap();
        assert_eq!(loaded.messages().len(), 1);
        assert!(loaded.load_report().is_clean());

        loaded.record_user("second");
        drop(loaded);
        let again = Session::load(&path).unwrap();
        assert_eq!(again.messages().len(), 2);
        assert!(again.load_report().is_clean());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn viewing_a_session_never_writes_to_its_log() {
        let (dir, mut s) = logged_session("readonly");
        s.record_user("hello");
        let path = s.log_path().unwrap().to_path_buf();
        drop(s);
        let mut raw = std::fs::read_to_string(&path).unwrap();
        raw.push_str("{\"event\":\"user_me");
        std::fs::write(&path, &raw).unwrap();

        let loaded = Session::load(&path).unwrap();
        assert!(loaded.load_report().torn_tail);
        drop(loaded);
        // The repair is owed, not done: nothing needed to write past it.
        assert_eq!(std::fs::read_to_string(&path).unwrap(), raw);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_event_this_build_cannot_read_keeps_its_place() {
        let (dir, mut s) = logged_session("unknown");
        s.record_user("one");
        s.record_assistant(
            "test-model",
            vec![ContentBlock::Text {
                text: "first".into(),
            }],
            Some("end_turn".into()),
            Usage::default(),
        );
        let path = s.log_path().unwrap().to_path_buf();
        drop(s);

        // Two lines a future build might write, and one the disk mangled.
        let mut raw = std::fs::read_to_string(&path).unwrap();
        raw.push_str("{\"event\":\"future_marker\",\"at\":\"2026-01-01T00:00:00Z\"}\n");
        raw.push_str("{\"event\":\"user_message\",\"text\":\n");
        std::fs::write(&path, raw).unwrap();

        let mut loaded = Session::load(&path).unwrap();
        let report = loaded.load_report();
        assert_eq!(report.unknown_events, 1);
        assert_eq!(report.damaged_lines, 1);
        assert!(!report.torn_tail);
        assert!(report.summary().unwrap().contains("newer version"));

        // The conversation is intact and the placeholders hold their indices,
        // which is what keeps an index-addressed marker aimed at the right
        // turn: the reply is still event 2, so rewinding to the user message
        // at 1 drops exactly that exchange.
        assert_eq!(loaded.messages().len(), 2);
        assert_eq!(loaded.events().len(), 5);
        assert!(matches!(loaded.events()[3], SessionEvent::Unknown));
        assert!(matches!(loaded.events()[4], SessionEvent::Unknown));
        assert_eq!(loaded.checkpoints()[0].index, 1);
        loaded.rewind(1).unwrap();
        assert!(loaded.messages().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_unreadable_log_is_still_a_session_to_append_to() {
        let (dir, mut s) = logged_session("append-after");
        s.record_user("one");
        let path = s.log_path().unwrap().to_path_buf();
        drop(s);
        let mut raw = std::fs::read_to_string(&path).unwrap();
        raw.push_str("{\"event\":\"future_marker\",\"at\":\"2026-01-01T00:00:00Z\"}\n");
        std::fs::write(&path, raw).unwrap();

        let mut loaded = Session::load(&path).unwrap();
        loaded.record_user("two");
        drop(loaded);

        // The unknown line is untouched on disk, so the build that understands
        // it still gets it back.
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("future_marker"));
        let again = Session::load(&path).unwrap();
        assert_eq!(again.load_report().unknown_events, 1);
        assert_eq!(again.messages().len(), 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_clean_load_says_nothing() {
        assert_eq!(LoadReport::default().summary(), None);
        assert!(Session::new().load_report().is_clean());
    }

    #[test]
    fn a_line_of_bytes_that_are_not_text_costs_only_itself() {
        let (dir, mut s) = logged_session("mangled");
        s.record_user("one");
        s.record_assistant(
            "test-model",
            vec![ContentBlock::Text {
                text: "first".into(),
            }],
            Some("end_turn".into()),
            Usage::default(),
        );
        let path = s.log_path().unwrap().to_path_buf();
        drop(s);

        // A line the filesystem left as bytes that do not decode. Reading the
        // whole file as text used to fail the load outright, spending the
        // entire conversation on one damaged line — the loud failure this
        // reader exists to turn into a placeholder.
        let mut raw = std::fs::read(&path).unwrap();
        raw.extend_from_slice(b"{\"event\":\"user_message\",\"text\":\"\xff\xfe\"}\n");
        raw.extend_from_slice(b"{\"event\":\"user_message\",\"text\":\"after\",");
        raw.extend_from_slice(b"\"images\":[],\"documents\":[],");
        raw.extend_from_slice(b"\"at\":\"2026-01-01T00:00:00Z\"}\n");
        std::fs::write(&path, raw).unwrap();

        let mut loaded = Session::load(&path).unwrap();
        assert_eq!(loaded.load_report().damaged_lines, 1);
        assert!(!loaded.load_report().torn_tail);

        // The turns on either side of it survive, and the placeholder holds its
        // index, so a marker still lands on the turn it names.
        assert_eq!(loaded.events().len(), 5);
        assert!(matches!(loaded.events()[3], SessionEvent::Unknown));
        assert_eq!(loaded.messages().len(), 3);
        loaded.rewind(1).unwrap();
        assert!(loaded.messages().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_failed_append_seals_the_log_rather_than_writing_past_the_gap() {
        let (dir, mut s) = logged_session("write-fail");
        s.record_user("one");
        let path = s.log_path().unwrap().to_path_buf();
        drop(s);

        // A torn tail leaves a repair owed, and the repair opens the path
        // again — so deleting the file makes the next append fail for a
        // reason that has nothing to do with the event being written.
        let mut raw = std::fs::read_to_string(&path).unwrap();
        raw.push_str("{\"event\":\"user_me");
        std::fs::write(&path, raw).unwrap();
        let mut loaded = Session::load(&path).unwrap();
        assert!(loaded.load_report().torn_tail);
        let before = loaded.events().len();
        std::fs::remove_file(&path).unwrap();

        loaded.record_user("two");
        let failure = loaded.write_failure().expect("the failure is a state");
        assert_eq!(failure.from_event, before);
        assert!(failure.summary().contains("no longer being saved"));

        // The log is let go of, not merely complained about. Were it kept,
        // these two events would land in a log missing the one before them,
        // and every index in it from there on would name a different turn than
        // it does in memory — so a `Rewind` recorded now would come back aimed
        // one turn early.
        assert!(loaded.log_path().is_none());
        std::fs::write(&path, b"").unwrap();
        loaded.record_user("three");
        loaded.record_user("four");
        assert_eq!(std::fs::read(&path).unwrap(), b"");

        // The turns are still here; only their persistence stopped.
        assert_eq!(loaded.events().len(), before + 3);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The latest name wins, and a compaction is not a rename: the summary
    /// supersedes the history, not the subject.
    #[test]
    fn a_title_is_the_latest_one_and_outlives_a_compaction() {
        let mut s = Session::new();
        assert_eq!(s.title(), None);

        exchange(&mut s, "one", "first");
        s.record_title("A first guess");
        assert_eq!(s.title(), Some("A first guess"));

        s.record_title("What it turned out to be");
        assert_eq!(s.title(), Some("What it turned out to be"));

        // Unlike the task list, which a compaction clears.
        s.record_compaction("a summary");
        assert_eq!(s.title(), Some("What it turned out to be"));
    }

    /// Rewinding past the name that describes a turn drops the name with it,
    /// which is what gets the session named again from what it became.
    #[test]
    fn a_rewind_past_a_title_leaves_the_session_unnamed() {
        let mut s = Session::new();
        let first = exchange(&mut s, "one", "first");
        s.record_title("Named from the first turn");
        exchange(&mut s, "two", "second");
        assert_eq!(s.title(), Some("Named from the first turn"));

        s.rewind(first).unwrap();
        assert_eq!(s.title(), None);
        // The log kept it, like every other marker in here.
        assert!(
            s.events()
                .iter()
                .any(|e| matches!(e, SessionEvent::Title { .. }))
        );
    }

    #[test]
    fn an_agent_session_is_the_latest_handle_and_is_not_a_message() {
        let mut s = Session::new();
        s.record_user("one");
        s.record_agent_session("claude-code", "abc");
        s.record_assistant(
            "m",
            vec![ContentBlock::Text {
                text: "first".into(),
            }],
            None,
            Usage::default(),
        );
        s.record_agent_session("claude-code", "def");

        assert_eq!(s.agent_session(), Some(("claude-code", "def")));
        // Metadata about where the conversation is kept, not a turn in it.
        assert_eq!(s.messages().len(), 2);
    }

    #[test]
    fn an_unchanged_agent_session_is_not_recorded_twice() {
        let mut s = Session::new();
        s.record_agent_session("claude-code", "abc");
        s.record_agent_session("claude-code", "abc");
        assert_eq!(
            s.events()
                .iter()
                .filter(|e| matches!(e, SessionEvent::AgentSession { .. }))
                .count(),
            1
        );
        // A different agent's identical id is a different handle.
        s.record_agent_session("codex", "abc");
        assert_eq!(s.agent_session(), Some(("codex", "abc")));
    }

    /// The exclusion is a fact about the chat, so it has to come back from
    /// the log — and as kinds, so a build that reads it can act on it
    /// without parsing names.
    #[test]
    fn prompt_layers_round_trip_through_jsonl() {
        let dir = std::env::temp_dir().join(format!("nightloom-test-{}", uuid::Uuid::new_v4()));
        let mut s = Session::with_log(&dir).unwrap();
        assert!(
            s.prompt_layers_off().is_empty(),
            "a fresh chat has every layer on"
        );
        s.record_prompt_layers([SegmentKind::ProjectNotes, SegmentKind::ProjectInstructions]);
        let path = s.log_path().unwrap().to_path_buf();
        drop(s);

        let loaded = Session::load(&path).unwrap();
        assert!(loaded.load_report().is_clean());
        // Ladder order, whatever order they were given in.
        assert_eq!(
            loaded.prompt_layers_off(),
            &[SegmentKind::ProjectInstructions, SegmentKind::ProjectNotes]
        );
        // Metadata, not a turn.
        assert!(loaded.messages().is_empty());
        // On the wire as the kinds' snake_case names, which is what a shell
        // sends back.
        let line = std::fs::read_to_string(&path).unwrap();
        assert!(line.contains(r#""event":"prompt_layers""#), "{line}");
        assert!(
            line.contains(r#""off":["project_instructions","project_notes"]"#),
            "{line}"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn prompt_layers_take_the_latest_set_and_are_not_recorded_unchanged() {
        let mut s = Session::new();
        s.record_prompt_layers([SegmentKind::Identity]);
        s.record_prompt_layers([SegmentKind::Identity, SegmentKind::Identity]);
        assert_eq!(s.prompt_layers_off(), &[SegmentKind::Identity]);
        assert_eq!(
            s.events()
                .iter()
                .filter(|e| matches!(e, SessionEvent::PromptLayers { .. }))
                .count(),
            1
        );
        // Back to all on is a set of its own and is recorded.
        s.record_prompt_layers([]);
        assert!(s.prompt_layers_off().is_empty());
        assert_eq!(
            s.events()
                .iter()
                .filter(|e| matches!(e, SessionEvent::PromptLayers { .. }))
                .count(),
            2
        );
        // Outlives a compaction, like a title: the chat is the same chat.
        s.record_prompt_layers([SegmentKind::Knowledge]);
        s.record_compaction("a summary");
        assert_eq!(s.prompt_layers_off(), &[SegmentKind::Knowledge]);
    }

    /// A rewind past the event restores the set that was current before it,
    /// which is what the model knew at the turn being returned to.
    #[test]
    fn a_rewind_past_prompt_layers_restores_the_earlier_set() {
        let mut s = Session::new();
        s.record_prompt_layers([SegmentKind::UserMemory]);
        let first = exchange(&mut s, "one", "first");
        s.record_prompt_layers([SegmentKind::Environment]);
        exchange(&mut s, "two", "second");
        assert_eq!(s.prompt_layers_off(), &[SegmentKind::Environment]);

        s.rewind(first).unwrap();
        assert_eq!(s.prompt_layers_off(), &[SegmentKind::UserMemory]);
    }

    fn edits(pairs: &[(SegmentKind, &str)]) -> BTreeMap<SegmentKind, String> {
        pairs.iter().map(|(k, t)| (*k, t.to_string())).collect()
    }

    /// A chat's own text for a layer is a fact about the chat like its off
    /// set, so it comes back from the log — under the same event, as the
    /// kind's name keyed to the body, and absent from the line when there
    /// is none, so a log with no edit reads exactly as it did before the
    /// field existed.
    #[test]
    fn prompt_layer_edits_round_trip_through_jsonl() {
        let dir = std::env::temp_dir().join(format!("nightloom-test-{}", uuid::Uuid::new_v4()));
        let mut s = Session::with_log(&dir).unwrap();
        assert!(
            s.prompt_layer_edits().is_empty(),
            "a fresh chat has no override"
        );
        s.record_prompt_layers([SegmentKind::Knowledge]);
        s.record_prompt_layer_edits(edits(&[(SegmentKind::UserMemory, "Be terse.")]));
        let path = s.log_path().unwrap().to_path_buf();
        drop(s);

        let loaded = Session::load(&path).unwrap();
        assert!(loaded.load_report().is_clean());
        assert_eq!(
            loaded.prompt_layer_edits(),
            &edits(&[(SegmentKind::UserMemory, "Be terse.")])
        );
        // Recording the text carried the off set forward.
        assert_eq!(loaded.prompt_layers_off(), &[SegmentKind::Knowledge]);
        assert!(loaded.messages().is_empty());

        let text = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = text
            .lines()
            .filter(|l| l.contains(r#""event":"prompt_layers""#))
            .collect();
        assert_eq!(lines.len(), 2, "{text}");
        // The first event had no edit and says nothing about one.
        assert!(!lines[0].contains("edits"), "{}", lines[0]);
        assert!(
            lines[1].contains(r#""edits":{"user_memory":"Be terse."}"#),
            "{}",
            lines[1]
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A line written before `edits` existed is the common case in every
    /// log on disk, and it must read as "no override".
    #[test]
    fn a_prompt_layers_line_without_edits_still_loads() {
        let line = r#"{"event":"prompt_layers","off":["identity"],"at":"2026-09-14T00:00:00Z"}"#;
        let event: SessionEvent = serde_json::from_str(line).unwrap();
        match event {
            SessionEvent::PromptLayers { off, edits, .. } => {
                assert_eq!(off, vec![SegmentKind::Identity]);
                assert!(edits.is_empty());
            }
            other => panic!("wrong event: {other:?}"),
        }
    }

    #[test]
    fn prompt_layer_edits_are_normalized_and_not_recorded_unchanged() {
        let mut s = Session::new();
        let count = |s: &Session| {
            s.events()
                .iter()
                .filter(|e| matches!(e, SessionEvent::PromptLayers { .. }))
                .count()
        };
        s.record_prompt_layer_edits(edits(&[
            // Trimmed on the way in.
            (SegmentKind::ModelInstructions, "  Short answers.\n"),
            // Not a file the user wrote: dropped.
            (SegmentKind::Knowledge, "not a thing"),
            // Blank is not "send nothing" — the switch is — so it is dropped.
            (SegmentKind::ProjectInstructions, "   "),
        ]));
        assert_eq!(
            s.prompt_layer_edits(),
            &edits(&[(SegmentKind::ModelInstructions, "Short answers.")])
        );
        assert_eq!(count(&s), 1);
        // The same text again, said differently: nothing to record.
        s.record_prompt_layer_edits(edits(&[(
            SegmentKind::ModelInstructions,
            "Short answers.  ",
        )]));
        assert_eq!(count(&s), 1);
        // A switch flipped keeps the text; the text changed keeps the switch.
        s.record_prompt_layers([SegmentKind::EngineNote]);
        assert_eq!(count(&s), 2);
        assert_eq!(
            s.prompt_layer_edits(),
            &edits(&[(SegmentKind::ModelInstructions, "Short answers.")])
        );
        s.record_prompt_layer_edits(BTreeMap::new());
        assert_eq!(count(&s), 3);
        assert!(s.prompt_layer_edits().is_empty());
        assert_eq!(s.prompt_layers_off(), &[SegmentKind::EngineNote]);
        // Outlives a compaction, like the off set: the chat is the same chat.
        s.record_prompt_layer_edits(edits(&[(SegmentKind::UserMemory, "Be terse.")]));
        s.record_compaction("a summary");
        assert_eq!(
            s.prompt_layer_edits(),
            &edits(&[(SegmentKind::UserMemory, "Be terse.")])
        );
    }

    /// A rewind past the event restores the text that was current before it,
    /// for the reason it restores the off set.
    #[test]
    fn a_rewind_past_prompt_layer_edits_restores_the_earlier_text() {
        let mut s = Session::new();
        s.record_prompt_layer_edits(edits(&[(SegmentKind::UserMemory, "first")]));
        let first = exchange(&mut s, "one", "first");
        s.record_prompt_layer_edits(edits(&[(SegmentKind::UserMemory, "second")]));
        exchange(&mut s, "two", "second");
        assert_eq!(
            s.prompt_layer_edits(),
            &edits(&[(SegmentKind::UserMemory, "second")])
        );

        s.rewind(first).unwrap();
        assert_eq!(
            s.prompt_layer_edits(),
            &edits(&[(SegmentKind::UserMemory, "first")])
        );
    }
    /// The mark is on the first line and comes back through `load`; a normal
    /// log's first line carries no `mode` key at all, so nothing written
    /// before the field existed can be told from something written today.
    #[test]
    fn the_chat_mode_is_on_the_creation_line_and_survives_a_reload() {
        let dir = std::env::temp_dir().join(format!("nightloom-mode-{}", uuid::Uuid::new_v4()));
        let incognito = Session::incognito(&dir).unwrap();
        let normal = Session::with_log(&dir).unwrap();
        assert_eq!(incognito.mode(), ChatMode::Incognito);
        assert_eq!(normal.mode(), ChatMode::Normal);

        let first = |id: &str| {
            let raw = fs::read_to_string(dir.join(format!("{id}.jsonl"))).unwrap();
            raw.lines().next().unwrap().to_string()
        };
        assert!(first(&incognito.id).contains(r#""mode":"incognito""#));
        assert!(!first(&normal.id).contains("mode"), "{}", first(&normal.id));

        let back = Session::load(dir.join(format!("{}.jsonl", incognito.id))).unwrap();
        assert_eq!(back.mode(), ChatMode::Incognito);
        assert!(back.mode().writes_nothing());
        assert!(back.mode().unread_by_others());
        let back = Session::load(dir.join(format!("{}.jsonl", normal.id))).unwrap();
        assert_eq!(back.mode(), ChatMode::Normal);
        assert!(!back.mode().writes_nothing());
        fs::remove_dir_all(&dir).ok();
    }

    /// An ephemeral session is marked in memory and creates nothing on
    /// disk, however many turns it records; `Session::new()` stays normal,
    /// since a capture turn is not a chat the user asked to forget.
    #[test]
    fn an_ephemeral_session_is_marked_and_leaves_no_file() {
        let dir = std::env::temp_dir().join(format!("nightloom-eph-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let mut s = Session::ephemeral();
        assert_eq!(s.mode(), ChatMode::Ephemeral);
        assert!(s.mode().writes_nothing());
        exchange(&mut s, "hello", "hi");
        s.record_title("a name");
        assert!(s.write_failure().is_none());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
        assert_eq!(s.events().len(), 4, "the turns are still in memory");
        assert_eq!(Session::new().mode(), ChatMode::Normal);
        fs::remove_dir_all(&dir).ok();
    }

    /// The mode is not a thing a rewind can reach: the creation line is
    /// index 0 and a rewind cuts at a user message.
    #[test]
    fn a_rewind_cannot_take_the_mode_back() {
        let mut s = Session::ephemeral();
        let first = exchange(&mut s, "one", "1");
        exchange(&mut s, "two", "2");
        s.rewind(first).unwrap();
        assert_eq!(s.mode(), ChatMode::Ephemeral);
    }

    /// Asking for a *log* in the mode whose meaning is "no log" is a
    /// confusion, refused rather than quietly honoured either way.
    #[test]
    fn a_logged_ephemeral_session_is_refused() {
        let dir = std::env::temp_dir().join(format!("nightloom-eph-log-{}", uuid::Uuid::new_v4()));
        let Err(err) = Session::with_log_in_mode(&dir, ChatMode::Ephemeral) else {
            panic!("a logged ephemeral session was created");
        };
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
        assert!(!dir.exists() || fs::read_dir(&dir).unwrap().count() == 0);
    }

    /// The cache timer's two fields (nightshift backlog 063): the lifetime
    /// is the write's own when the breakdown names one, the engine's usual
    /// when the request only touched the cache, and nothing when it touched
    /// none — so a host that reports no caching records no timer rather
    /// than a wrong one.
    #[test]
    fn the_cache_lifetime_is_read_from_the_write_and_falls_back_to_the_engine() {
        let ttl_of = |usage: Usage, default: Option<CacheTtl>| {
            let mut s = Session::new();
            s.record_user("q");
            let sent = Utc::now();
            s.record_assistant_timed("m", vec![], None, usage, None, sent, default);
            match s.events().last().unwrap() {
                SessionEvent::AssistantMessage {
                    sent_at, cache_ttl, ..
                } => {
                    assert_eq!(*sent_at, Some(sent));
                    *cache_ttl
                }
                other => panic!("{other:?}"),
            }
        };
        let wrote_1h = Usage {
            cache_write_tokens: Some(8375),
            cache_write_1h_tokens: Some(8375),
            cache_write_5m_tokens: Some(0),
            ..Usage::default()
        };
        let wrote_5m = Usage {
            cache_write_tokens: Some(120),
            cache_write_5m_tokens: Some(120),
            cache_write_1h_tokens: Some(0),
            ..Usage::default()
        };
        let read_only = Usage {
            cache_read_tokens: Some(4000),
            cache_write_tokens: Some(0),
            cache_write_5m_tokens: Some(0),
            cache_write_1h_tokens: Some(0),
            ..Usage::default()
        };
        let wrote_unsaid = Usage {
            cache_write_tokens: Some(120),
            ..Usage::default()
        };
        let untouched = Usage {
            input_tokens: 300,
            cache_read_tokens: Some(0),
            cache_write_tokens: Some(0),
            ..Usage::default()
        };
        // The write names its lifetime; the engine's default does not win.
        assert_eq!(
            ttl_of(wrote_1h, Some(CacheTtl::FiveMinutes)),
            Some(CacheTtl::OneHour)
        );
        assert_eq!(
            ttl_of(wrote_5m, Some(CacheTtl::OneHour)),
            Some(CacheTtl::FiveMinutes)
        );
        // A read refreshes the entry for the engine's usual lifetime.
        assert_eq!(
            ttl_of(read_only, Some(CacheTtl::OneHour)),
            Some(CacheTtl::OneHour)
        );
        // An older host that reports the write but not its breakdown.
        assert_eq!(
            ttl_of(wrote_unsaid, Some(CacheTtl::FiveMinutes)),
            Some(CacheTtl::FiveMinutes)
        );
        // No entry, no timer — with or without an engine default.
        assert_eq!(ttl_of(untouched, Some(CacheTtl::FiveMinutes)), None);
        assert_eq!(ttl_of(read_only, None), None);
        assert_eq!(ttl_of(Usage::default(), None), None);
    }

    /// The fields serialize as the API's own suffixes and are skipped when
    /// absent, so an old line loads and a line written without them today
    /// is the line yesterday's build would have written.
    #[test]
    fn the_cache_fields_round_trip_and_are_absent_when_unknown() {
        let old = r#"{"event":"assistant_message","model":"m","blocks":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":1},"at":"2026-01-01T00:00:00Z"}"#;
        let event: SessionEvent = serde_json::from_str(old).unwrap();
        assert!(matches!(
            &event,
            SessionEvent::AssistantMessage {
                sent_at: None,
                cache_ttl: None,
                ..
            }
        ));
        let back = serde_json::to_string(&event).unwrap();
        assert!(
            !back.contains("sent_at") && !back.contains("cache_ttl"),
            "{back}"
        );

        let mut s = Session::new();
        s.record_user("q");
        s.record_assistant_timed(
            "m",
            vec![],
            None,
            Usage {
                cache_write_1h_tokens: Some(10),
                ..Usage::default()
            },
            None,
            Utc::now(),
            None,
        );
        let line = serde_json::to_string(s.events().last().unwrap()).unwrap();
        assert!(line.contains(r#""cache_ttl":"1h""#), "{line}");
        assert!(line.contains(r#""sent_at":""#), "{line}");
        assert!(line.contains(r#""cache_write_1h_tokens":10"#), "{line}");
        let again: SessionEvent = serde_json::from_str(&line).unwrap();
        assert!(matches!(
            again,
            SessionEvent::AssistantMessage {
                cache_ttl: Some(CacheTtl::OneHour),
                ..
            }
        ));
    }
}
