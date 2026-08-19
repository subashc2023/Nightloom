use crate::approval::{Approver, Decision, PendingCall, denial_message};
use crate::sidecar::{self, SidecarContext, SidecarPart};
use crate::store::one_line;
use crate::tools::{CompactContext, CompactSignal, Subagent, TurnHandle};
use futures::StreamExt;
use nightloom_core::{
    ChatRequest, ContentBlock, Effect, ImageInput, Message, Provider, ProviderError, Role, Session,
    StreamEvent, SystemPrompt, Thinking, Usage, WireView,
    tool::{Tool, defs, effect_of, run_tool},
};
use nightloom_providers::pricing::Price;
use serde::Serialize;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

/// Streaming progress of one turn, for a shell to render as it happens.
/// Serializable so app shells can forward events across an IPC boundary.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[non_exhaustive]
pub enum TurnEvent {
    TextDelta {
        text: String,
    },
    ThinkingDelta {
        text: String,
    },
    /// The provider encrypted a thinking block instead of streaming it.
    RedactedThinking,
    /// The model requested a tool call (recorded; about to execute).
    ToolCall {
        id: String,
        name: String,
        input: serde_json::Value,
    },
    /// One executed call's result, as fed back to the model.
    ToolResult {
        tool_use_id: String,
        name: String,
        content: String,
        is_error: bool,
    },
    /// The user refused a call, so it never ran.
    ///
    /// There is no matching [`ToolResult`](TurnEvent::ToolResult) for it —
    /// nothing was executed, and a result event would say otherwise. The
    /// session log does record a `ToolResult` with `is_error: true`, because
    /// the model has to be told and a `tool_use` block without a result is
    /// invalid on replay; `reason` is what the shell put in it.
    ToolDenied {
        tool_use_id: String,
        name: String,
        reason: String,
    },
    /// The per-turn tool-round cap was hit: the final round's results are
    /// recorded, but the model gets no further reply this turn.
    RoundLimit {
        rounds: usize,
    },
    /// The model asked to compact and the engine did, once the reply was
    /// finished. The session's projection now restarts from `summary`, so a
    /// shell holding a live transcript buffer has to re-read it.
    Compacted {
        summary: String,
    },
    /// One round's token accounting, as soon as the provider reports it.
    ///
    /// `input_tokens + output_tokens` is what the *next* request will carry
    /// as its prefix, which makes this the live reading a context gauge
    /// wants — not the turn total, which double-counts the prefix once per
    /// round. Shells that only refresh between turns can ignore it and read
    /// the same number off the trailing `AssistantMessage` instead.
    Usage {
        usage: Usage,
    },
}

/// What the user is sending this turn.
///
/// A bare `&str` or `String` converts, so the common text-only call reads the
/// way it always did; attachments are the case that has to say so.
#[derive(Debug, Clone, Default)]
pub struct TurnInput {
    pub text: String,
    pub images: Vec<ImageInput>,
}

impl From<&str> for TurnInput {
    fn from(text: &str) -> Self {
        Self {
            text: text.to_string(),
            images: Vec::new(),
        }
    }
}

impl From<String> for TurnInput {
    fn from(text: String) -> Self {
        Self {
            text,
            images: Vec::new(),
        }
    }
}

/// One call from a round with consent already settled, on its way to running.
struct PlannedCall {
    id: String,
    name: String,
    input: serde_json::Value,
    /// The user's reason, when they refused it. Nothing runs.
    denial: Option<String>,
    /// Whether this call may overlap its neighbours: approved, and read-only,
    /// so it cannot change what another call in the round sees.
    concurrent: bool,
}

/// Announce an executed call's result. Denials never reach here — nothing ran,
/// and a `ToolResult` event would say otherwise.
fn emit_result(result: &ContentBlock, on_event: &mut (dyn FnMut(TurnEvent) + Send)) {
    if let ContentBlock::ToolResult {
        tool_use_id,
        name,
        content,
        is_error,
    } = result
    {
        on_event(TurnEvent::ToolResult {
            tool_use_id: tool_use_id.clone(),
            name: name.clone(),
            content: content.clone(),
            is_error: *is_error,
        });
    }
}

/// How a turn ended. `usage` and `stop_reason` cover the whole turn: usage
/// sums every round, stop_reason is the final round's.
#[derive(Debug, Clone, Serialize)]
pub struct TurnOutcome {
    pub interrupted: bool,
    pub stop_reason: Option<String>,
    pub usage: Usage,
}

/// Result of [`Chat::compact`]. `summary` is empty when `interrupted`.
#[derive(Debug, Clone, Serialize)]
pub struct CompactOutcome {
    pub interrupted: bool,
    pub summary: String,
    pub usage: Usage,
}

/// A configured conversation engine: provider + model + tools + knobs. Owns
/// no session — callers pass one per turn, so one `Chat` can serve many.
pub struct Chat {
    pub provider: Box<dyn Provider>,
    pub model: String,
    /// The static, cache-stable preamble. Assemble it once (see
    /// [`crate::prompt::assemble`]) and leave it alone — every byte that
    /// changes between turns costs a full cache miss.
    pub system: SystemPrompt,
    pub thinking: Thinking,
    pub max_tokens: u32,
    pub tools: Vec<Box<dyn Tool>>,
    /// How many tool rounds one turn may take before the engine stops it.
    ///
    /// A runaway guard, not a budget, and it was measurably too tight at 8.
    /// The `rename-across-files` eval — four files, one small edit each — took
    /// Gemini 2.5 Flash ten rounds, and at 8 it was cut off mid-task on every
    /// attempt while still working correctly. A cap that truncates ordinary
    /// work is indistinguishable from a model that cannot do it, which is the
    /// worse of the two failures because nothing in the transcript says which
    /// happened. Raised to 24, which still bounds a loop.
    pub max_rounds: usize,
    /// Everything the preamble deliberately can't hold: the clock, the task
    /// list, how full the window is. Rendered fresh each turn onto the tail
    /// of the user's message. Empty disables it.
    pub sidecar: Vec<Box<dyn SidecarPart>>,
    /// The model's input-token limit, for the context gauge. `None` leaves
    /// the gauge reporting usage without a percentage rather than inventing
    /// a limit.
    pub context_limit: Option<u64>,
    /// What this model charges, for the per-exchange cost recorded in the
    /// log. `None` leaves the cost unrecorded rather than recorded as zero;
    /// see [`SessionCost`](nightloom_core::SessionCost).
    pub price: Option<Price>,
    /// Who decides whether a tool call may run. `None` runs everything.
    ///
    /// Allow-by-default is deliberate. The alternative — refusing until a
    /// policy is installed — would silently turn every existing caller
    /// (the CLI, the probe, any embedder) into one whose tools all fail,
    /// and it would do so at runtime rather than at the type level, since
    /// the field has to have a default. A shell that wants a gate installs
    /// one; see [`AutoApprove`](crate::AutoApprove) for the policy nearly
    /// every shell wants.
    pub approver: Option<Arc<dyn Approver>>,
    /// Set when the model holds the `compact_context` tool. Read once per
    /// turn, after the reply lands.
    compact_signal: Option<CompactSignal>,
    /// Whether an unnamed session gets a name at the end of a turn. See
    /// [`Chat::enable_titles`].
    auto_title: bool,
    /// Set when the model holds the `task` tool. Refreshed each round so a
    /// subagent inherits the live cancellation token and approval policy.
    subagents: Option<Arc<TurnHandle>>,
}

impl Chat {
    pub fn new(provider: Box<dyn Provider>, model: impl Into<String>) -> Self {
        Self {
            provider,
            model: model.into(),
            system: SystemPrompt::default(),
            thinking: Thinking::Default,
            max_tokens: 8192,
            tools: Vec::new(),
            max_rounds: 24,
            sidecar: sidecar::default_parts(),
            context_limit: None,
            price: None,
            approver: None,
            compact_signal: None,
            auto_title: false,
            subagents: None,
        }
    }

    /// Itemize the request this chat would send for `session` right now.
    ///
    /// Built from the same three pieces [`Chat::run_turn`] assembles — the
    /// preamble, the projection, and a freshly rendered sidecar — rather
    /// than from a description of them. A context view that reimplemented
    /// the assembly would be a second thing to keep in step with the engine,
    /// and it would drift in exactly the places worth looking at, since
    /// those are the places the engine is doing something non-obvious.
    ///
    /// The sidecar is rendered as it would be for the *first* round of a
    /// turn, which is the only round it attaches to and, between turns, also
    /// the next thing that will really be sent. It shows up in the view
    /// marked as unremovable: it is regenerated every turn, so there is
    /// nothing in the log to act on.
    pub fn context_view(&self, session: &Session) -> WireView {
        let sidecar = sidecar::render(
            &self.sidecar,
            &SidecarContext {
                session,
                model: &self.model,
                context_limit: self.context_limit,
                can_self_compact: self.compact_signal.is_some(),
            },
        );
        WireView::assemble(
            Some(&self.system),
            session,
            sidecar.as_deref(),
            self.context_limit,
        )
    }

    /// Hand the model the `task` tool: a subagent with its own context
    /// window, whose only output is its final message.
    ///
    /// `factory` builds the sub-`Chat`, because only the shell knows how to
    /// construct a provider. Whatever it returns has its own `task` tool
    /// stripped and inherits this chat's approver, so a factory cannot open
    /// a recursion or a hole around the approval gate by omission — see
    /// [`TurnHandle`].
    pub fn enable_subagents(
        &mut self,
        factory: Arc<dyn Fn() -> Result<Chat, String> + Send + Sync>,
    ) {
        let handle = Arc::new(TurnHandle::default());
        self.tools
            .push(Box::new(Subagent::new(factory, handle.clone())));
        self.subagents = Some(handle);
    }

    /// Hand the model the `compact_context` tool and honour what it asks for.
    ///
    /// Both halves matter and they live in different places, which is why this
    /// is one call rather than a tool the shell can push on its own: the tool
    /// records the request, and the engine — the only thing that knows when a
    /// turn is over — acts on it. Pushing [`CompactContext`] onto `tools`
    /// without wiring the signal here would advertise a capability that
    /// accepts every request and performs none of them.
    ///
    /// It also switches on the context gauge's advice to use it, so the model
    /// is told the tool exists at the moment the number starts to matter.
    pub fn enable_self_compaction(&mut self) {
        let signal = CompactSignal::new();
        self.tools
            .push(Box::new(CompactContext::new(signal.clone())));
        self.compact_signal = Some(signal);
    }

    /// Name a session once, at the end of the first turn that leaves it
    /// with a completed exchange and no name.
    ///
    /// Opt-in rather than always on, because the caller is the one paying:
    /// titling is a second provider request, and switching it on for
    /// everybody would put one at the end of every eval workspace and every
    /// probe, where it buys nothing and spends against the numbers being
    /// measured. A subagent should not have it either — its session is
    /// in-memory and nobody will ever pick it out of a list — which is why
    /// this is a call a shell makes on the chat it built rather than
    /// something `build_chat` turns on for everything it returns.
    ///
    /// It fires on the next turn of a session that has no name, not only on
    /// a new one, so a log written before any of this existed gets a name
    /// the first time it is picked up again.
    pub fn enable_titles(&mut self) {
        self.auto_title = true;
    }

    /// Run one user turn: record it, stream the reply into the session and
    /// `on_event`, execute tool calls and loop their results back to the
    /// provider until it answers in text (capped at `max_rounds`).
    ///
    /// Cancelling the token mid-stream records the partial reply with
    /// pending tool calls stripped (a `tool_use` without a result is invalid
    /// on replay) and returns with `interrupted: true`; a mid-stream error
    /// records the same way, then surfaces as `Err`.
    ///
    /// If the model called `compact_context` during the turn (see
    /// [`enable_self_compaction`](Self::enable_self_compaction)), the session
    /// is compacted here — after the reply is complete, never mid-loop.
    pub async fn run_turn(
        &self,
        session: &mut Session,
        input: impl Into<TurnInput>,
        cancel: &CancellationToken,
        on_event: &mut (dyn FnMut(TurnEvent) + Send),
    ) -> Result<TurnOutcome, ProviderError> {
        let outcome = self
            .turn_rounds(session, input.into(), cancel, on_event)
            .await;
        // The request is taken either way: a compaction the model asked for
        // during a turn that then failed is stale, and leaving the flag up
        // would fire it at the end of the *next* turn instead.
        if self.compact_signal.as_ref().is_some_and(|s| s.take())
            && matches!(&outcome, Ok(o) if !o.interrupted)
        {
            // A failed summarization leaves the session untouched and does
            // not fail the turn, which already succeeded. The model finds the
            // window still full next turn and is advised again — the loop is
            // self-correcting, and losing the reply over it would not be.
            if let Ok(done) = self.compact(session, cancel).await
                && !done.interrupted
            {
                on_event(TurnEvent::Compacted {
                    summary: done.summary,
                });
            }
        }
        // A name for the session, from the exchange that settled what it is
        // about. Failures are silent and deliberately so: a title is a label
        // on a file, the session is still unnamed and will be tried again
        // next turn, and there is no version of "the reply is lost because
        // naming it did not work" that is the right trade.
        if self.auto_title
            && matches!(&outcome, Ok(o) if !o.interrupted)
            && session.title().is_none()
        {
            let _ = self.title(session, cancel).await;
        }
        outcome
    }

    /// The streaming tool loop itself. [`run_turn`](Self::run_turn) wraps it
    /// to settle a pending compaction at the boundary.
    async fn turn_rounds(
        &self,
        session: &mut Session,
        input: TurnInput,
        cancel: &CancellationToken,
        on_event: &mut (dyn FnMut(TurnEvent) + Send),
    ) -> Result<TurnOutcome, ProviderError> {
        session.record_user_with_images(input.text, input.images);
        let mut turn_usage = Usage::default();

        for round in 1..=self.max_rounds.max(1) {
            // A turn cancelled while the previous round's tools ran must not
            // open another request. The select below is not enough on its
            // own: both of its branches are ready, so which one wins is a
            // coin flip per event, and a fast stream can win every flip and
            // carry the round — and any compaction it requested — through to
            // completion after the user has already interrupted.
            if cancel.is_cancelled() {
                return Ok(TurnOutcome {
                    interrupted: true,
                    stop_reason: None,
                    usage: turn_usage,
                });
            }
            // Lend this turn's token and approval policy to any subagent the
            // model spawns. Refreshed per round rather than captured at setup
            // so the order a shell configures `Chat` in cannot matter.
            if let Some(handle) = &self.subagents {
                handle.lend(cancel, self.approver.clone());
            }
            // Composed per round, but it only lands on round one: the
            // projection attaches it to a trailing *user text* message, and
            // later rounds end in tool results. Rounds 2+ still see round
            // one's copy in the replayed history.
            let sidecar = sidecar::render(
                &self.sidecar,
                &SidecarContext {
                    session,
                    model: &self.model,
                    context_limit: self.context_limit,
                    can_self_compact: self.compact_signal.is_some(),
                },
            );
            let request = ChatRequest {
                model: self.model.clone(),
                system: self.system.clone(),
                messages: session.messages_with_sidecar(sidecar.as_deref()),
                max_tokens: self.max_tokens,
                temperature: None,
                thinking: self.thinking.clone(),
                tools: defs(&self.tools),
            };

            // Blocks are assembled in stream order: Anthropic requires
            // thinking to precede the tool_use it led to, and interleaved
            // thinking means thinking/text/tool_use can alternate within one
            // message. A signature with no visible text still marks a real
            // block (adaptive models can emit only empty deltas); it must be
            // kept for replay.
            fn flush_thinking(
                buf: &mut String,
                blocks: &mut Vec<ContentBlock>,
                signature: Option<String>,
            ) {
                if !buf.is_empty() || signature.is_some() {
                    blocks.push(ContentBlock::Thinking {
                        text: std::mem::take(buf),
                        signature,
                    });
                }
            }
            fn flush_text(buf: &mut String, blocks: &mut Vec<ContentBlock>) {
                if !buf.is_empty() {
                    blocks.push(ContentBlock::Text {
                        text: std::mem::take(buf),
                    });
                }
            }

            let mut stream = self.provider.stream_chat(request).await?;
            let mut blocks = Vec::new();
            let mut text_buf = String::new();
            let mut thinking_buf = String::new();
            let mut usage = Usage::default();
            let mut stop_reason = None;
            let mut calls = Vec::new();
            let mut interrupted = false;
            let mut stream_err = None;

            loop {
                let event = tokio::select! {
                    _ = cancel.cancelled() => {
                        interrupted = true;
                        break;
                    }
                    next = stream.next() => match next {
                        Some(Ok(event)) => event,
                        Some(Err(e)) => {
                            stream_err = Some(e);
                            break;
                        }
                        None => break,
                    },
                };
                match event {
                    StreamEvent::TextDelta(delta) => {
                        // Signed thinking was already flushed by
                        // ThinkingSignature; this closes unsigned thinking
                        // when text starts.
                        flush_thinking(&mut thinking_buf, &mut blocks, None);
                        on_event(TurnEvent::TextDelta {
                            text: delta.clone(),
                        });
                        text_buf.push_str(&delta);
                    }
                    StreamEvent::ThinkingDelta(delta) => {
                        flush_text(&mut text_buf, &mut blocks);
                        on_event(TurnEvent::ThinkingDelta {
                            text: delta.clone(),
                        });
                        thinking_buf.push_str(&delta);
                    }
                    StreamEvent::ThinkingSignature(sig) => {
                        flush_thinking(&mut thinking_buf, &mut blocks, Some(sig));
                    }
                    StreamEvent::RedactedThinking { data } => {
                        flush_thinking(&mut thinking_buf, &mut blocks, None);
                        flush_text(&mut text_buf, &mut blocks);
                        on_event(TurnEvent::RedactedThinking);
                        blocks.push(ContentBlock::RedactedThinking { data });
                    }
                    StreamEvent::ToolUse {
                        id,
                        name,
                        input,
                        signature,
                    } => {
                        flush_thinking(&mut thinking_buf, &mut blocks, None);
                        flush_text(&mut text_buf, &mut blocks);
                        on_event(TurnEvent::ToolCall {
                            id: id.clone(),
                            name: name.clone(),
                            input: input.clone(),
                        });
                        // The signature is recorded but never rendered: it is
                        // a wire artifact the next round has to hand back,
                        // not something a shell has any use for.
                        blocks.push(ContentBlock::ToolUse {
                            id: id.clone(),
                            name: name.clone(),
                            input: input.clone(),
                            signature,
                        });
                        calls.push((id, name, input));
                    }
                    // Invisible to shells — it carries no text — but it has
                    // to land between the thinking it summarizes and the
                    // call it led to, which is why it is a block and not a
                    // field on the message.
                    StreamEvent::ReasoningRef { id } => {
                        flush_thinking(&mut thinking_buf, &mut blocks, None);
                        flush_text(&mut text_buf, &mut blocks);
                        blocks.push(ContentBlock::ReasoningRef { id });
                    }
                    StreamEvent::Usage(u) => usage = u,
                    StreamEvent::End { stop_reason: r } => stop_reason = r,
                    _ => {}
                }
            }
            // Cancel the in-flight request before touching the session.
            drop(stream);

            flush_thinking(&mut thinking_buf, &mut blocks, None);
            flush_text(&mut text_buf, &mut blocks);
            turn_usage.add(usage);
            on_event(TurnEvent::Usage { usage });

            if interrupted || stream_err.is_some() {
                // These calls will never get results, and a tool_use without
                // a result is invalid on replay — drop them from the record.
                // The thinking/text streamed so far is kept.
                blocks.retain(|b| !matches!(b, ContentBlock::ToolUse { .. }));
                if !blocks.is_empty() {
                    let reason = if interrupted { "interrupted" } else { "error" };
                    let cost = self.price.map(|p| p.cost(&usage));
                    session.record_assistant_priced(
                        &self.model,
                        blocks,
                        Some(reason.into()),
                        usage,
                        cost,
                    );
                }
                if let Some(e) = stream_err {
                    return Err(e);
                }
                return Ok(TurnOutcome {
                    interrupted: true,
                    stop_reason: None,
                    usage: turn_usage,
                });
            }

            // A tool-only response has no text; recording an empty text
            // block would replay as one, which providers reject. An entirely
            // empty reply still records one.
            if calls.is_empty()
                && !blocks
                    .iter()
                    .any(|b| matches!(b, ContentBlock::Text { .. }))
            {
                blocks.push(ContentBlock::Text {
                    text: String::new(),
                });
            }
            // Per round, not per turn: a tool loop bills each round, and the
            // last one's usage is not the turn's total.
            let cost = self.price.map(|p| p.cost(&usage));
            session.record_assistant_priced(&self.model, blocks, stop_reason.clone(), usage, cost);

            if calls.is_empty() {
                return Ok(TurnOutcome {
                    interrupted: false,
                    stop_reason,
                    usage: turn_usage,
                });
            }
            // Execute even on the last round so no call is left without a
            // result in the session; just don't go back to the provider.
            // Approval is asked for on this round too, for the same reason:
            // the call runs, so the user gets to stop it.
            let plan = self.plan_round(calls, on_event).await;
            for result in self.execute(plan, on_event).await {
                session.record_tool_result(&result);
            }
            // Some tools write conversation state rather than just returning
            // a result to read once (the task list). Fold that into the log
            // now, so the next round's sidecar renders it.
            for tool in &self.tools {
                for event in tool.drain_events() {
                    session.record(event);
                }
            }
            if round == self.max_rounds.max(1) {
                on_event(TurnEvent::RoundLimit {
                    rounds: self.max_rounds,
                });
                return Ok(TurnOutcome {
                    interrupted: false,
                    stop_reason,
                    usage: turn_usage,
                });
            }
        }
        unreachable!("every round either returns or continues the tool loop")
    }

    /// Settle consent for one round's calls, in the order the model made them.
    ///
    /// Sequential, deliberately, and it stays that way even though execution
    /// no longer is: a shell asked for three approvals at once has no sensible
    /// rendering, and the user should be shown the calls in the order the
    /// model asked for them rather than in whatever order three prompts
    /// happened to resolve.
    async fn plan_round(
        &self,
        calls: Vec<(String, String, serde_json::Value)>,
        on_event: &mut (dyn FnMut(TurnEvent) + Send),
    ) -> Vec<PlannedCall> {
        let mut plan = Vec::with_capacity(calls.len());
        for (id, name, input) in calls {
            let denial = self.decide(&id, &name, &input).await;
            if let Some(reason) = &denial {
                on_event(TurnEvent::ToolDenied {
                    tool_use_id: id.clone(),
                    name: name.clone(),
                    reason: reason.clone(),
                });
            }
            // Read-only is the whole test, and it is the classification the
            // approval gate already sorts on rather than a second axis every
            // future tool has to answer. A refused call is never concurrent
            // because it never runs.
            let concurrent =
                denial.is_none() && matches!(effect_of(&self.tools, &name), Some(Effect::ReadOnly));
            plan.push(PlannedCall {
                id,
                name,
                input,
                denial,
                concurrent,
            });
        }
        plan
    }

    /// Run a planned round, returning its results in call order.
    ///
    /// A *run of adjacent read-only calls* overlaps; everything else keeps its
    /// position and runs alone. Adjacency is the load-bearing half. Hoisting
    /// every read to the front of the round would be faster still and would
    /// reorder a round that reads what another call in that same round writes,
    /// turning a slow answer into a wrong one — where adjacent reads cannot
    /// affect what each other sees, so overlapping them changes nothing but
    /// the clock.
    ///
    /// Mutating calls stay serial for the reason the two failures are not
    /// symmetric: two `edit_file` calls racing on one file silently lose an
    /// edit, while run one after another the second fails loudly with an
    /// `old_string` that no longer matches, which the model can see and act
    /// on. A tool this engine cannot classify (a hallucinated name, anything
    /// arriving over MCP) is serial by the same default that makes it
    /// `Mutating`.
    async fn execute(
        &self,
        plan: Vec<PlannedCall>,
        on_event: &mut (dyn FnMut(TurnEvent) + Send),
    ) -> Vec<ContentBlock> {
        let mut results = Vec::with_capacity(plan.len());
        let mut batch: Vec<PlannedCall> = Vec::new();
        for call in plan {
            if call.concurrent {
                batch.push(call);
                continue;
            }
            self.drain_batch(&mut batch, &mut results, on_event).await;
            // A refusal was already announced as `ToolDenied` when consent was
            // settled, and must not also arrive as a `ToolResult`: nothing
            // ran, so a result event would be a lie, and a shell with a live
            // buffer closes the pending call on one or the other.
            let denied = call.denial.is_some();
            let result = self.run_one(call).await;
            if !denied {
                emit_result(&result, on_event);
            }
            results.push(result);
        }
        self.drain_batch(&mut batch, &mut results, on_event).await;
        results
    }

    /// Run everything gathered so far at once, appending results in order.
    async fn drain_batch(
        &self,
        batch: &mut Vec<PlannedCall>,
        results: &mut Vec<ContentBlock>,
        on_event: &mut (dyn FnMut(TurnEvent) + Send),
    ) {
        let batch = std::mem::take(batch);
        if batch.is_empty() {
            return;
        }
        let done =
            futures::future::join_all(batch.into_iter().map(|call| self.run_one(call))).await;
        // Emitted after the batch rather than as each call lands, so the
        // events a shell renders stay in the order the model called them.
        // What that costs is the difference between the fastest and the
        // slowest read in one batch, which is not a difference anybody sees.
        for result in done {
            emit_result(&result, on_event);
            results.push(result);
        }
    }

    /// One call: the refusal it already collected, or the tool.
    async fn run_one(&self, call: PlannedCall) -> ContentBlock {
        let PlannedCall {
            id,
            name,
            input,
            denial,
            ..
        } = call;
        match denial {
            // Recorded like any failed call, even though nothing ran: the
            // model has to be told, and the tool_use block needs the matching
            // result replay requires.
            Some(reason) => {
                let content = denial_message(&name, &reason);
                ContentBlock::ToolResult {
                    tool_use_id: id,
                    name,
                    content,
                    is_error: true,
                }
            }
            None => run_tool(&self.tools, &id, &name, input).await,
        }
    }

    /// Put one call to the approver, if there is one. `Some(reason)` means
    /// refused — the reason is the shell's, verbatim, and may be empty.
    ///
    /// A name that matches no registered tool is never asked about: there is
    /// nothing to consent to, and [`run_tool`] already tells the model it
    /// hallucinated the tool.
    async fn decide(&self, id: &str, name: &str, input: &serde_json::Value) -> Option<String> {
        let approver = self.approver.as_ref()?;
        let effect = effect_of(&self.tools, name)?;
        match approver
            .approve(&PendingCall {
                id,
                name,
                input,
                effect,
            })
            .await
        {
            // `AllowAlways` is a promise about later calls that only the
            // policy can keep; here it is simply a yes.
            Decision::Allow | Decision::AllowAlways => None,
            Decision::Deny(reason) => Some(reason),
        }
    }

    /// Compact the session: ask the model for a briefing-style summary of the
    /// conversation so far and record it as a [`SessionEvent::Compaction`],
    /// after which the provider projection restarts from the summary. The
    /// summarization request runs without thinking or tools.
    ///
    /// Nothing is recorded on cancellation (`interrupted: true`) or error —
    /// a partial summary would silently lose context.
    ///
    /// [`SessionEvent::Compaction`]: nightloom_core::SessionEvent::Compaction
    pub async fn compact(
        &self,
        session: &mut Session,
        cancel: &CancellationToken,
    ) -> Result<CompactOutcome, ProviderError> {
        let mut messages = session.messages();
        if !messages.iter().any(|m| m.role == Role::Assistant) {
            return Err(ProviderError::Config(
                "nothing to compact: the session has no completed exchanges".into(),
            ));
        }
        messages.push(Message::user(COMPACT_PROMPT));

        let request = ChatRequest {
            model: self.model.clone(),
            // Deliberately bare: the summarizer is not the assistant, and a
            // preamble telling it who to be only skews the summary.
            system: SystemPrompt::default(),
            messages,
            max_tokens: self.max_tokens,
            temperature: None,
            thinking: Thinking::Default,
            tools: Vec::new(),
        };
        let mut stream = self.provider.stream_chat(request).await?;
        let mut summary = String::new();
        let mut usage = Usage::default();
        loop {
            let event = tokio::select! {
                _ = cancel.cancelled() => {
                    return Ok(CompactOutcome {
                        interrupted: true,
                        summary: String::new(),
                        usage,
                    });
                }
                next = stream.next() => match next {
                    Some(Ok(event)) => event,
                    Some(Err(e)) => return Err(e),
                    None => break,
                },
            };
            match event {
                StreamEvent::TextDelta(delta) => summary.push_str(&delta),
                StreamEvent::Usage(u) => usage = u,
                _ => {}
            }
        }
        let summary = summary.trim().to_string();
        if summary.is_empty() {
            return Err(ProviderError::Parse(
                "empty summary from provider; session left unchanged".into(),
            ));
        }
        session.record_compaction(&summary);
        Ok(CompactOutcome {
            interrupted: false,
            summary,
            usage,
        })
    }

    /// Name this session from its first exchange, recording the result as a
    /// [`SessionEvent::Title`].
    ///
    /// The *first* exchange, not the conversation so far, and that is the
    /// whole shape of it. A title answers "which chat was that", a question
    /// already settled once the model has replied once — so titling from the
    /// full history would cost more every turn it fired and would make the
    /// name depend on when it happened to run rather than on what the
    /// conversation is. Two clipped excerpts is the entire request.
    ///
    /// Runs bare like [`compact`](Self::compact): no preamble, no sidecar,
    /// no tools, no thinking. `Ok(None)` means cancelled, with the session
    /// left unnamed; a model that spends its whole allowance thinking and
    /// returns no text is an `Err` for the same reason, and both are
    /// recoverable by the session simply staying nameless until next turn.
    ///
    /// [`SessionEvent::Title`]: nightloom_core::SessionEvent::Title
    pub async fn title(
        &self,
        session: &mut Session,
        cancel: &CancellationToken,
    ) -> Result<Option<String>, ProviderError> {
        let Some(excerpt) = first_exchange(session) else {
            return Err(ProviderError::Config(
                "nothing to title: the session has no completed exchanges".into(),
            ));
        };

        let request = ChatRequest {
            model: self.model.clone(),
            system: SystemPrompt::default(),
            messages: vec![Message::user(format!("{TITLE_PROMPT}\n\n{excerpt}"))],
            // Room for a model that thinks before answering, which some hosts
            // do by default; the answer itself is six words.
            max_tokens: TITLE_MAX_TOKENS,
            temperature: None,
            thinking: Thinking::Default,
            tools: Vec::new(),
        };
        let mut stream = self.provider.stream_chat(request).await?;
        let mut raw = String::new();
        loop {
            let event = tokio::select! {
                _ = cancel.cancelled() => return Ok(None),
                next = stream.next() => match next {
                    Some(Ok(event)) => event,
                    Some(Err(e)) => return Err(e),
                    None => break,
                },
            };
            if let StreamEvent::TextDelta(delta) = event {
                raw.push_str(&delta);
            }
        }

        let title = clean_title(&raw);
        if title.is_empty() {
            return Err(ProviderError::Parse(
                "empty title from provider; session left unnamed".into(),
            ));
        }
        session.record_title(&title);
        Ok(Some(title))
    }
}

/// The first user message and the first assistant reply as plain text,
/// clipped — or `None` when there is no reply yet, which is the same test
/// [`Chat::compact`] makes and for the same reason: there is nothing to
/// summarize or to name until the model has said something.
///
/// Read off the *projection* rather than the raw log, so a compacted session
/// is named from its summary rather than from history the model can no
/// longer see. Images are skipped: `Message::text` takes text blocks only,
/// and an uncaptioned attachment leaves the assistant's reply to name the
/// turn on its own.
fn first_exchange(session: &Session) -> Option<String> {
    let messages = session.messages();
    let first = |role: Role| -> String {
        messages
            .iter()
            .find(|m| m.role == role)
            .map(Message::text)
            .unwrap_or_default()
    };
    if !messages.iter().any(|m| m.role == Role::Assistant) {
        return None;
    }
    let asked = one_line(&first(Role::User), TITLE_EXCERPT);
    let replied = one_line(&first(Role::Assistant), TITLE_EXCERPT);
    Some(format!("User: {asked}\n\nAssistant: {replied}"))
}

/// Trim a model's answer down to a name.
///
/// They answer this question well and package it variously: quoted, bolded,
/// with a trailing period, occasionally with a line of commentary under it.
/// Taking the first non-empty line and stripping the wrapping is cheaper
/// than a stricter prompt and, unlike a validator, does not throw away a
/// good title over its punctuation.
fn clean_title(raw: &str) -> String {
    let line = raw.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    let stripped = line
        .trim()
        .trim_matches(|c: char| matches!(c, '"' | '\'' | '\u{201c}' | '\u{201d}' | '*' | '#'))
        .trim()
        .trim_end_matches(['.', ':']);
    one_line(stripped, TITLE_MAX_CHARS)
}

/// The instruction, sent as the whole request alongside the excerpt.
const TITLE_PROMPT: &str = "Name the conversation below, for a list of saved \
chats. At most six words. Say what it is about, using the user's own words \
for it where they gave you any, and prefer the specific noun to the general \
one. Write the title by itself: no quotes, no trailing period, no preamble.";

/// How much of each side of the first exchange the namer is shown.
const TITLE_EXCERPT: usize = 600;

/// Long enough for a model that thinks before it answers.
const TITLE_MAX_TOKENS: u32 = 512;

/// A name, not a sentence — and a column in a sidebar.
const TITLE_MAX_CHARS: usize = 60;

/// The summarization instruction appended as the final user message when
/// compacting.
const COMPACT_PROMPT: &str = "Summarize this conversation so far as a briefing \
for someone who will continue it: the user's goals, key facts and decisions, \
relevant details from tool results, open questions, and the current state. Be \
thorough but do not pad; write only the summary, with no preamble or \
commentary.";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::AutoApprove;
    use crate::tools::TodoWrite;
    use nightloom_core::TodoStatus;
    use nightloom_core::tool::Effect;
    use nightloom_core::{EventStream, SessionEvent, ToolDef};
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    /// Yields one scripted stream per `stream_chat` call, in order, and keeps
    /// every request it was handed so tests can assert on what actually went
    /// over the wire.
    struct Scripted {
        scripts: Mutex<Vec<Vec<StreamEvent>>>,
        seen: Arc<Mutex<Vec<ChatRequest>>>,
    }

    type Seen = Arc<Mutex<Vec<ChatRequest>>>;

    impl Scripted {
        fn provider(scripts: Vec<Vec<StreamEvent>>) -> Box<dyn Provider> {
            Self::recording(scripts).0
        }

        fn recording(scripts: Vec<Vec<StreamEvent>>) -> (Box<dyn Provider>, Seen) {
            let seen: Seen = Arc::new(Mutex::new(Vec::new()));
            let provider = Box::new(Self {
                scripts: Mutex::new(scripts),
                seen: Arc::clone(&seen),
            });
            (provider, seen)
        }
    }

    #[async_trait::async_trait]
    impl Provider for Scripted {
        fn name(&self) -> &'static str {
            "scripted"
        }

        async fn stream_chat(&self, request: ChatRequest) -> Result<EventStream, ProviderError> {
            self.seen.lock().unwrap().push(request);
            let mut scripts = self.scripts.lock().unwrap();
            assert!(!scripts.is_empty(), "provider called more than scripted");
            let events = scripts.remove(0);
            Ok(Box::pin(futures::stream::iter(events.into_iter().map(Ok))))
        }
    }

    fn tool_call(name: &str, input: serde_json::Value) -> Vec<StreamEvent> {
        vec![
            StreamEvent::ToolUse {
                id: "c1".into(),
                name: name.into(),
                input,
                signature: None,
            },
            StreamEvent::End {
                stop_reason: Some("tool_use".into()),
            },
        ]
    }

    /// A round of several calls, the shape a model emits when it decides the
    /// work is independent.
    fn tool_calls(calls: &[(&str, &str)]) -> Vec<StreamEvent> {
        let mut events: Vec<StreamEvent> = calls
            .iter()
            .map(|(id, name)| StreamEvent::ToolUse {
                id: (*id).into(),
                name: (*name).into(),
                input: json!({ "msg": id }),
                signature: None,
            })
            .collect();
        events.push(StreamEvent::End {
            stop_reason: Some("tool_use".into()),
        });
        events
    }

    fn says(text: &str) -> Vec<StreamEvent> {
        vec![
            StreamEvent::TextDelta(text.into()),
            StreamEvent::End {
                stop_reason: Some("end_turn".into()),
            },
        ]
    }

    /// Text of the last message in a captured request.
    fn tail_text(requests: &[ChatRequest], i: usize) -> String {
        requests[i].messages.last().unwrap().text()
    }

    /// Yields its events, then never terminates — for cancellation tests.
    struct Stall(Mutex<Vec<StreamEvent>>);

    #[async_trait::async_trait]
    impl Provider for Stall {
        fn name(&self) -> &'static str {
            "stall"
        }

        async fn stream_chat(&self, _: ChatRequest) -> Result<EventStream, ProviderError> {
            let events = std::mem::take(&mut *self.0.lock().unwrap());
            Ok(Box::pin(
                futures::stream::iter(events.into_iter().map(Ok)).chain(futures::stream::pending()),
            ))
        }
    }

    /// Streams a text delta, then dies mid-stream.
    struct Erroring;

    #[async_trait::async_trait]
    impl Provider for Erroring {
        fn name(&self) -> &'static str {
            "erroring"
        }

        async fn stream_chat(&self, _: ChatRequest) -> Result<EventStream, ProviderError> {
            Ok(Box::pin(futures::stream::iter(vec![
                Ok(StreamEvent::TextDelta("half".into())),
                Err(ProviderError::Transport("connection reset".into())),
            ])))
        }
    }

    struct Echo;

    #[async_trait::async_trait]
    impl Tool for Echo {
        fn def(&self) -> ToolDef {
            ToolDef {
                name: "echo".into(),
                description: "echo the msg argument".into(),
                input_schema: json!({ "type": "object" }),
            }
        }

        async fn call(&self, input: serde_json::Value) -> Result<String, String> {
            Ok(input["msg"].as_str().unwrap_or_default().to_string())
        }
    }

    /// A second mutating tool, so a per-tool approval can be shown not to
    /// cover its neighbour.
    struct Shout;

    #[async_trait::async_trait]
    impl Tool for Shout {
        fn def(&self) -> ToolDef {
            ToolDef {
                name: "shout".into(),
                description: "echo the msg argument, loudly".into(),
                input_schema: json!({ "type": "object" }),
            }
        }

        async fn call(&self, input: serde_json::Value) -> Result<String, String> {
            Ok(input["msg"].as_str().unwrap_or_default().to_uppercase())
        }
    }

    /// A tool that only reports its name, for asserting on what a sub-chat
    /// was actually offered.
    struct Named(&'static str);

    #[async_trait::async_trait]
    impl Tool for Named {
        fn def(&self) -> ToolDef {
            ToolDef {
                name: self.0.into(),
                description: "a tool".into(),
                input_schema: json!({ "type": "object" }),
            }
        }

        async fn call(&self, _input: serde_json::Value) -> Result<String, String> {
            Ok("ran".into())
        }
    }

    /// Only the subagent's final message crosses back — that is the whole
    /// bargain, and the reason the sub-session is never logged.
    #[tokio::test]
    async fn a_subagent_returns_only_its_final_answer() {
        let (provider, _) = Scripted::recording(vec![
            tool_call("task", json!({"prompt": "go find out"})),
            says("the parent's reply"),
        ]);
        let mut chat = Chat::new(provider, "test-model");
        chat.enable_subagents(Arc::new(|| {
            Ok(Chat::new(
                Scripted::provider(vec![tool_call("peek", json!({})), says("  THE ANSWER  ")]),
                "sub-model",
            ))
        }));
        // The sub-chat above calls `peek`, which it does not have; that is
        // deliberate — the failure is the subagent's to handle and must not
        // reach the parent, which sees only the final text.
        let mut session = Session::new();
        let (_, events) = run(&chat, &mut session, "question").await;

        let result = events.iter().find_map(|e| match e {
            TurnEvent::ToolResult { name, content, .. } if name == "task" => Some(content.clone()),
            _ => None,
        });
        assert_eq!(result.as_deref(), Some("THE ANSWER"));

        // The parent's log holds one exchange plus the task result — none of
        // the subagent's own turns.
        assert!(
            !session
                .events()
                .iter()
                .any(|e| matches!(e, SessionEvent::AssistantMessage { model, .. } if model == "sub-model")),
            "the subagent's turns leaked into the parent log"
        );
    }

    /// A subagent that can spawn subagents recurses until something runs out,
    /// and a fresh window is the point anyway — so the tool is stripped from
    /// whatever the factory hands back, rather than trusted not to be there.
    #[tokio::test]
    async fn a_subagent_is_not_offered_the_task_tool() {
        let (sub_provider, sub_seen) = Scripted::recording(vec![says("done")]);
        let sub_provider = Mutex::new(Some(sub_provider));
        let (provider, _) =
            Scripted::recording(vec![tool_call("task", json!({"prompt": "go"})), says("ok")]);
        let mut chat = Chat::new(provider, "test-model");
        chat.enable_subagents(Arc::new(move || {
            let mut sub = Chat::new(
                sub_provider.lock().unwrap().take().expect("one spawn"),
                "sub-model",
            );
            // A factory that hands back the parent's whole tool set — the
            // mistake the stripping exists to survive.
            sub.tools = vec![Box::new(Named("task")), Box::new(Named("grep"))];
            Ok(sub)
        }));
        run(&chat, &mut Session::new(), "question").await.0.unwrap();

        let offered: Vec<String> = sub_seen.lock().unwrap()[0]
            .tools
            .iter()
            .map(|t| t.name.clone())
            .collect();
        assert_eq!(offered, ["grep"], "the subagent was offered a task tool");
    }

    /// Without this the `task` tool is a door beside the approval gate: the
    /// model could reach every mutating tool by asking a subagent to run it.
    #[tokio::test]
    async fn a_subagent_inherits_the_approval_policy() {
        // Allow the spawn, refuse what the subagent then tries: the gate has
        // to bite *inside* the subagent, not merely at its front door.
        let (gate, asked) = Gate::new(|name| match name {
            "task" => Decision::Allow,
            _ => Decision::Deny("not this time".into()),
        });
        let (provider, _) =
            Scripted::recording(vec![tool_call("task", json!({"prompt": "go"})), says("ok")]);
        let mut chat = Chat::new(provider, "test-model");
        chat.approver = Some(gate);
        chat.enable_subagents(Arc::new(|| {
            let mut sub = Chat::new(
                Scripted::provider(vec![
                    tool_call("echo", json!({"msg": "hi"})),
                    says("finished anyway"),
                ]),
                "sub-model",
            );
            sub.tools = vec![Box::new(Echo)];
            Ok(sub)
        }));
        run(&chat, &mut Session::new(), "question").await.0.unwrap();

        // Both the parent's `task` call and the subagent's `echo` call were
        // put to the same policy — the second is the one that matters.
        assert_eq!(*asked.lock().unwrap(), ["task", "echo"]);
    }

    /// The whole point of routing compaction through a tool: it must land
    /// *after* the reply, not in the middle of the loop that produced it.
    #[tokio::test]
    async fn a_requested_compaction_runs_once_the_reply_is_done() {
        let (provider, seen) = Scripted::recording(vec![
            tool_call("compact_context", json!({})),
            says("here is the answer"),
            says("SUMMARY OF EVERYTHING"),
        ]);
        let mut chat = Chat::new(provider, "test-model");
        chat.enable_self_compaction();
        let mut session = Session::new();
        let (out, events) = run(&chat, &mut session, "question").await;
        assert!(!out.unwrap().interrupted);

        // Three requests: the call, the reply, then the summarizer — in that
        // order. A compaction that fired mid-loop would have summarized a
        // conversation the model had not finished having.
        assert_eq!(seen.lock().unwrap().len(), 3);
        assert!(
            matches!(events.last(), Some(TurnEvent::Compacted { summary }) if summary == "SUMMARY OF EVERYTHING"),
            "{events:?}"
        );

        // The reply survives compaction in the log even though the model can
        // no longer see it: the log is the source of truth, the projection is
        // what got shortened.
        assert!(matches!(
            session.events().last(),
            Some(SessionEvent::Compaction { .. })
        ));
        let projected = session.messages();
        assert_eq!(projected.len(), 1);
        assert!(projected[0].text().contains("SUMMARY OF EVERYTHING"));
    }

    /// The tool has to be wired, not merely constructed: a shell that pushes
    /// `CompactContext` itself gets a tool that accepts every request and
    /// honours none, so `enable_self_compaction` is the only way in.
    #[tokio::test]
    async fn without_enabling_it_the_tool_is_not_offered() {
        let (provider, seen) = Scripted::recording(vec![says("hi")]);
        let chat = Chat::new(provider, "test-model");
        let mut session = Session::new();
        run(&chat, &mut session, "question").await.0.unwrap();
        let requests = seen.lock().unwrap();
        assert!(
            !requests[0]
                .tools
                .iter()
                .any(|t| t.name == "compact_context"),
            "compact_context offered without being enabled"
        );
    }

    /// An interrupted turn drops the request rather than carrying it into the
    /// next one, where it would compact a conversation nobody asked to lose.
    #[tokio::test]
    async fn a_cancelled_turn_discards_the_compaction_request() {
        let provider = Scripted::provider(vec![
            tool_call("compact_context", json!({})),
            says("reply"),
            says("SUMMARY"),
        ]);
        let mut chat = Chat::new(provider, "test-model");
        chat.enable_self_compaction();
        let mut session = Session::new();

        // Cancel from the callback, the moment the tool has actually run —
        // pre-cancelling would race the tool call and could pass without ever
        // raising the request the test is about.
        let cancel = CancellationToken::new();
        let mut events = Vec::new();
        chat.run_turn(&mut session, "q", &cancel, &mut |e| {
            if matches!(e, TurnEvent::ToolResult { .. }) {
                cancel.cancel();
            }
            events.push(e);
        })
        .await
        .unwrap();
        assert!(
            events.iter().any(
                |e| matches!(e, TurnEvent::ToolResult { name, .. } if name == "compact_context")
            ),
            "the tool never ran, so the test proves nothing: {events:?}"
        );
        assert!(
            !events
                .iter()
                .any(|e| matches!(e, TurnEvent::Compacted { .. }))
        );

        // And the stale request must not fire at the end of the next turn.
        let mut events = Vec::new();
        let cancel = CancellationToken::new();
        chat.run_turn(&mut session, "q2", &cancel, &mut |e| events.push(e))
            .await
            .unwrap();
        assert!(
            !events
                .iter()
                .any(|e| matches!(e, TurnEvent::Compacted { .. })),
            "a request from a cancelled turn leaked into the next one"
        );
        assert!(
            !session
                .events()
                .iter()
                .any(|e| matches!(e, SessionEvent::Compaction { .. })),
            "session was compacted despite the request being cancelled"
        );
    }

    #[tokio::test]
    async fn the_sidecar_rides_the_first_round_and_stays_out_of_the_log() {
        let (provider, seen) =
            Scripted::recording(vec![tool_call("echo", json!({"msg": "hi"})), says("done")]);
        let mut chat = Chat::new(provider, "test-model");
        chat.tools = vec![Box::new(Echo)];
        let mut session = Session::new();
        run(&chat, &mut session, "question").await.0.unwrap();

        let requests = seen.lock().unwrap();
        assert_eq!(requests.len(), 2);
        // Round one: the user's text, then the status block beside it.
        assert!(tail_text(&requests, 0).starts_with("question"));
        assert!(tail_text(&requests, 0).contains("<session-status>"));
        // Round two ends in tool results — appending text there is the wire
        // hazard the projection refuses to create.
        assert!(!tail_text(&requests, 1).contains("<session-status>"));

        // And none of it is in the log, so replay stays clean.
        assert_eq!(session.messages()[0].text(), "question");
        assert!(matches!(
            &session.events()[1],
            SessionEvent::UserMessage { text, .. } if text == "question"
        ));
    }

    #[tokio::test]
    async fn an_empty_sidecar_sends_the_user_text_alone() {
        let (provider, seen) = Scripted::recording(vec![says("ok")]);
        let mut chat = Chat::new(provider, "test-model");
        chat.sidecar = Vec::new();
        let mut session = Session::new();
        run(&chat, &mut session, "question").await.0.unwrap();

        let requests = seen.lock().unwrap();
        assert_eq!(requests[0].messages[0].content.len(), 1);
        assert_eq!(tail_text(&requests, 0), "question");
    }

    #[tokio::test]
    async fn a_todo_write_is_logged_and_read_back_on_the_next_turn() {
        let (provider, seen) = Scripted::recording(vec![
            tool_call(
                "todo_write",
                json!({"todos": [
                    {"content": "write the docs", "status": "in_progress"},
                    {"content": "ship it", "status": "pending"}
                ]}),
            ),
            says("planned"),
            says("still going"),
        ]);
        let mut chat = Chat::new(provider, "test-model");
        chat.tools = vec![Box::new(TodoWrite::default())];
        let mut session = Session::new();
        run(&chat, &mut session, "plan the work").await.0.unwrap();

        // The tool's write reached the log through `drain_events`.
        assert_eq!(session.todos().len(), 2);
        assert_eq!(session.todos()[0].status, TodoStatus::InProgress);
        assert!(
            session
                .events()
                .iter()
                .any(|e| matches!(e, SessionEvent::TodoState { .. }))
        );

        run(&chat, &mut session, "carry on").await.0.unwrap();

        // …and comes back to the model on the next turn. This read-back is
        // the whole point: a list the model can't see is a list it forgets.
        let requests = seen.lock().unwrap();
        let next = tail_text(&requests, 2);
        assert!(next.contains("tasks:"), "{next}");
        assert!(next.contains("[~] write the docs"), "{next}");
        assert!(next.contains("[ ] ship it"), "{next}");
    }

    async fn run(
        chat: &Chat,
        session: &mut Session,
        input: &str,
    ) -> (Result<TurnOutcome, ProviderError>, Vec<TurnEvent>) {
        let mut events = Vec::new();
        let cancel = CancellationToken::new();
        let out = chat
            .run_turn(session, input, &cancel, &mut |e| events.push(e))
            .await;
        (out, events)
    }

    #[tokio::test]
    async fn records_blocks_in_stream_order() {
        let provider = Scripted::provider(vec![vec![
            StreamEvent::ThinkingDelta("hm".into()),
            StreamEvent::ThinkingSignature("sig-1".into()),
            StreamEvent::TextDelta("hi".into()),
            StreamEvent::End {
                stop_reason: Some("end_turn".into()),
            },
        ]]);
        let chat = Chat::new(provider, "test-model");
        let mut session = Session::new();
        let (out, _) = run(&chat, &mut session, "hello").await;
        assert_eq!(out.unwrap().stop_reason.as_deref(), Some("end_turn"));

        let msgs = session.messages();
        assert_eq!(msgs.len(), 2);
        assert!(matches!(
            &msgs[1].content[0],
            ContentBlock::Thinking { text, signature: Some(s) } if text == "hm" && s == "sig-1"
        ));
        assert!(matches!(
            &msgs[1].content[1],
            ContentBlock::Text { text } if text == "hi"
        ));
    }

    #[tokio::test]
    async fn tool_calls_execute_and_loop_back() {
        let provider = Scripted::provider(vec![
            vec![
                StreamEvent::ToolUse {
                    id: "c1".into(),
                    name: "echo".into(),
                    input: json!({ "msg": "pong" }),
                    signature: None,
                },
                StreamEvent::End {
                    stop_reason: Some("tool_use".into()),
                },
            ],
            vec![
                StreamEvent::TextDelta("done".into()),
                StreamEvent::End {
                    stop_reason: Some("end_turn".into()),
                },
            ],
        ]);
        let mut chat = Chat::new(provider, "test-model");
        chat.tools = vec![Box::new(Echo)];
        let mut session = Session::new();
        let (out, events) = run(&chat, &mut session, "call echo").await;
        assert_eq!(out.unwrap().stop_reason.as_deref(), Some("end_turn"));

        // user, assistant tool_use, user tool result, assistant text
        assert_eq!(session.messages().len(), 4);
        assert!(
            events
                .iter()
                .any(|e| matches!(e, TurnEvent::ToolCall { name, .. } if name == "echo"))
        );
        assert!(events.iter().any(|e| matches!(
            e,
            TurnEvent::ToolResult { content, is_error: false, .. } if content == "pong"
        )));
    }

    /// Replay tokens are opaque to the engine but must survive the trip
    /// into the log and back out into the next round's request — Gemini 3
    /// rejects a function call replayed without its thought signature.
    #[tokio::test]
    async fn tool_call_signature_survives_into_the_next_round() {
        let (provider, seen) = Scripted::recording(vec![
            vec![
                StreamEvent::ThinkingDelta("need the tool".into()),
                StreamEvent::ToolUse {
                    id: "c1".into(),
                    name: "echo".into(),
                    input: json!({ "msg": "pong" }),
                    signature: Some("sig-A".into()),
                },
                // A parallel sibling: unsigned by design, and it has to stay
                // that way rather than inherit the first call's signature.
                StreamEvent::ToolUse {
                    id: "c2".into(),
                    name: "echo".into(),
                    input: json!({ "msg": "ping" }),
                    signature: None,
                },
                StreamEvent::End {
                    stop_reason: Some("tool_use".into()),
                },
            ],
            says("done"),
        ]);
        let mut chat = Chat::new(provider, "test-model");
        chat.tools = vec![Box::new(Echo)];
        let mut session = Session::new();
        run(&chat, &mut session, "call echo").await.0.unwrap();

        let requests = seen.lock().unwrap();
        let replayed = &requests[1].messages[1].content;
        assert!(
            matches!(
                &replayed[..],
                [
                    ContentBlock::Thinking { .. },
                    ContentBlock::ToolUse { signature: Some(a), .. },
                    ContentBlock::ToolUse { signature: None, .. },
                ] if a == "sig-A"
            ),
            "replayed blocks: {replayed:?}"
        );
    }

    /// The OpenAI Responses artifact: recorded between the thinking it
    /// summarizes and the call it led to, so the adapter can put it back in
    /// the position the API validates.
    #[tokio::test]
    async fn reasoning_ref_is_recorded_in_stream_order() {
        let (provider, seen) = Scripted::recording(vec![
            vec![
                StreamEvent::ThinkingDelta("planning".into()),
                StreamEvent::ReasoningRef {
                    id: "rs_abc".into(),
                },
                StreamEvent::ToolUse {
                    id: "c1".into(),
                    name: "echo".into(),
                    input: json!({ "msg": "pong" }),
                    signature: None,
                },
                StreamEvent::End {
                    stop_reason: Some("tool_use".into()),
                },
            ],
            says("done"),
        ]);
        let mut chat = Chat::new(provider, "test-model");
        chat.tools = vec![Box::new(Echo)];
        let mut session = Session::new();
        run(&chat, &mut session, "call echo").await.0.unwrap();

        let requests = seen.lock().unwrap();
        let replayed = &requests[1].messages[1].content;
        assert!(
            matches!(
                &replayed[..],
                [
                    ContentBlock::Thinking { .. },
                    ContentBlock::ReasoningRef { id },
                    ContentBlock::ToolUse { .. },
                ] if id == "rs_abc"
            ),
            "replayed blocks: {replayed:?}"
        );
    }

    #[tokio::test]
    async fn cancel_strips_pending_tool_calls_and_records_partial() {
        let provider: Box<dyn Provider> = Box::new(Stall(Mutex::new(vec![
            StreamEvent::TextDelta("partial".into()),
            StreamEvent::ToolUse {
                id: "c1".into(),
                name: "echo".into(),
                input: json!({}),
                signature: None,
            },
        ])));
        let chat = Chat::new(provider, "test-model");
        let mut session = Session::new();
        let cancel = CancellationToken::new();
        let trigger = cancel.clone();
        let out = chat
            .run_turn(&mut session, "hi", &cancel, &mut move |e| {
                // Cancel once the call arrives, as a user would mid-stream.
                if matches!(e, TurnEvent::ToolCall { .. }) {
                    trigger.cancel();
                }
            })
            .await
            .unwrap();
        assert!(out.interrupted);

        let msgs = session.messages();
        assert_eq!(msgs.len(), 2);
        assert!(matches!(
            &msgs[1].content[..],
            [ContentBlock::Text { text }] if text == "partial"
        ));
        assert!(matches!(
            session.events().last(),
            Some(SessionEvent::AssistantMessage { stop_reason: Some(r), .. }) if r == "interrupted"
        ));
    }

    #[tokio::test]
    async fn mid_stream_error_records_partial_and_surfaces() {
        let chat = Chat::new(Box::new(Erroring), "test-model");
        let mut session = Session::new();
        let (out, _) = run(&chat, &mut session, "hi").await;
        assert!(matches!(out, Err(ProviderError::Transport(_))));
        assert!(matches!(
            session.events().last(),
            Some(SessionEvent::AssistantMessage { stop_reason: Some(r), .. }) if r == "error"
        ));
    }

    #[tokio::test]
    async fn round_cap_executes_final_results_but_stops() {
        let call = || {
            vec![
                StreamEvent::ToolUse {
                    id: "c".into(),
                    name: "echo".into(),
                    input: json!({ "msg": "again" }),
                    signature: None,
                },
                StreamEvent::End {
                    stop_reason: Some("tool_use".into()),
                },
            ]
        };
        let provider = Scripted::provider(vec![call(), call()]);
        let mut chat = Chat::new(provider, "test-model");
        chat.tools = vec![Box::new(Echo)];
        chat.max_rounds = 2;
        let mut session = Session::new();
        let (out, events) = run(&chat, &mut session, "loop forever").await;
        assert!(!out.unwrap().interrupted);
        assert!(
            events
                .iter()
                .any(|e| matches!(e, TurnEvent::RoundLimit { rounds: 2 }))
        );
        // The final round's call still has its result in the session.
        assert!(matches!(
            session.events().last(),
            Some(SessionEvent::ToolResult { .. })
        ));
    }

    #[tokio::test]
    async fn compact_records_summary_and_resets_projection() {
        let provider = Scripted::provider(vec![
            vec![
                StreamEvent::TextDelta("the answer".into()),
                StreamEvent::End {
                    stop_reason: Some("end_turn".into()),
                },
            ],
            vec![
                StreamEvent::TextDelta("summary of it all".into()),
                StreamEvent::End {
                    stop_reason: Some("end_turn".into()),
                },
            ],
        ]);
        let chat = Chat::new(provider, "test-model");
        let mut session = Session::new();
        run(&chat, &mut session, "question").await.0.unwrap();

        let cancel = CancellationToken::new();
        let out = chat.compact(&mut session, &cancel).await.unwrap();
        assert!(!out.interrupted);
        assert_eq!(out.summary, "summary of it all");
        assert!(matches!(
            session.events().last(),
            Some(SessionEvent::Compaction { summary, .. }) if summary == "summary of it all"
        ));
        // The projection restarts from the summary alone.
        let msgs = session.messages();
        assert_eq!(msgs.len(), 1);
        assert!(msgs[0].text().contains("summary of it all"));
    }

    #[tokio::test]
    async fn compact_refuses_a_session_with_no_exchanges() {
        let chat = Chat::new(Scripted::provider(vec![]), "test-model");
        let mut session = Session::new();
        session.record_user("unanswered");
        let cancel = CancellationToken::new();
        let out = chat.compact(&mut session, &cancel).await;
        assert!(matches!(out, Err(ProviderError::Config(_))));
        assert_eq!(session.events().len(), 2); // nothing recorded
    }

    #[tokio::test]
    async fn cancelled_compact_records_nothing() {
        let provider: Box<dyn Provider> =
            Box::new(Stall(Mutex::new(vec![StreamEvent::TextDelta(
                "the answer".into(),
            )])));
        // First build a completed exchange with a scripted provider…
        let seed = Chat::new(
            Scripted::provider(vec![vec![
                StreamEvent::TextDelta("hi".into()),
                StreamEvent::End {
                    stop_reason: Some("end_turn".into()),
                },
            ]]),
            "test-model",
        );
        let mut session = Session::new();
        run(&seed, &mut session, "hello").await.0.unwrap();
        let before = session.events().len();

        // …then compact against one that stalls, cancelling mid-stream.
        let chat = Chat::new(provider, "test-model");
        let cancel = CancellationToken::new();
        cancel.cancel();
        let out = chat.compact(&mut session, &cancel).await.unwrap();
        assert!(out.interrupted);
        assert_eq!(session.events().len(), before);
    }

    /// A read-only sibling of `Echo`, for proving the gate sorts on effect.
    struct Peek;

    #[async_trait::async_trait]
    impl Tool for Peek {
        fn def(&self) -> ToolDef {
            ToolDef {
                name: "peek".into(),
                description: "look at something".into(),
                input_schema: json!({ "type": "object" }),
            }
        }

        fn effect(&self) -> Effect {
            Effect::ReadOnly
        }

        async fn call(&self, _input: serde_json::Value) -> Result<String, String> {
            Ok("looked".into())
        }
    }

    /// Answers from a closure and records every question, so a test can
    /// assert on the questions that were *not* asked.
    struct Gate {
        asked: Arc<Mutex<Vec<String>>>,
        answer: Box<dyn Fn(&str) -> Decision + Send + Sync>,
    }

    impl Gate {
        fn new<F>(answer: F) -> (Arc<Self>, Arc<Mutex<Vec<String>>>)
        where
            F: Fn(&str) -> Decision + Send + Sync + 'static,
        {
            let asked = Arc::new(Mutex::new(Vec::new()));
            let gate = Arc::new(Self {
                asked: Arc::clone(&asked),
                answer: Box::new(answer),
            });
            (gate, asked)
        }
    }

    #[async_trait::async_trait]
    impl Approver for Gate {
        async fn approve(&self, call: &PendingCall<'_>) -> Decision {
            self.asked.lock().unwrap().push(call.name.to_string());
            (self.answer)(call.name)
        }
    }

    /// A refusal is a message to the model, not an abort: the call is
    /// recorded as a failed result and the model gets a round to react.
    #[tokio::test]
    async fn a_denied_call_is_recorded_as_an_error_and_the_turn_continues() {
        let (provider, seen) = Scripted::recording(vec![
            tool_call("echo", json!({ "msg": "pong" })),
            says("understood, I'll leave it alone"),
        ]);
        let mut chat = Chat::new(provider, "test-model");
        chat.tools = vec![Box::new(Echo)];
        let (gate, _) = Gate::new(|_| Decision::Deny("not that file".into()));
        chat.approver = Some(gate);
        let mut session = Session::new();
        let (out, events) = run(&chat, &mut session, "call echo").await;

        // The model was asked again after the refusal — that second request
        // is the turn continuing.
        assert_eq!(out.unwrap().stop_reason.as_deref(), Some("end_turn"));
        assert_eq!(seen.lock().unwrap().len(), 2);

        assert!(
            events
                .iter()
                .any(|e| matches!(e, TurnEvent::ToolDenied { name, reason, .. }
                    if name == "echo" && reason == "not that file"))
        );
        // Nothing executed, so nothing may claim to be a result of executing.
        assert!(
            !events
                .iter()
                .any(|e| matches!(e, TurnEvent::ToolResult { .. }))
        );

        // But the log has one, or the tool_use block above it is invalid on
        // replay — and its content is the denial, not the tool's output.
        assert!(matches!(
            session.events().iter().find(|e| matches!(e, SessionEvent::ToolResult { .. })),
            Some(SessionEvent::ToolResult { is_error: true, content, .. })
                if content.contains("refused permission") && content.contains("not that file")
        ));
        // user, assistant tool_use, user tool result, assistant text
        assert_eq!(session.messages().len(), 4);
    }

    /// `AllowAlways` is remembered by the policy, not the engine — so it
    /// only works if a shell wraps its prompt in [`AutoApprove`], which is
    /// the arrangement this asserts end to end.
    #[tokio::test]
    async fn allow_always_stops_asking_for_that_tool_but_not_others() {
        let (gate, asked) = Gate::new(|_| Decision::AllowAlways);
        let provider = Scripted::provider(vec![
            vec![
                StreamEvent::ToolUse {
                    id: "c1".into(),
                    name: "echo".into(),
                    input: json!({ "msg": "one" }),
                    signature: None,
                },
                StreamEvent::ToolUse {
                    id: "c2".into(),
                    name: "echo".into(),
                    input: json!({ "msg": "two" }),
                    signature: None,
                },
                StreamEvent::ToolUse {
                    id: "c3".into(),
                    name: "shout".into(),
                    input: json!({ "msg": "three" }),
                    signature: None,
                },
                StreamEvent::End {
                    stop_reason: Some("tool_use".into()),
                },
            ],
            says("done"),
        ]);
        let mut chat = Chat::new(provider, "test-model");
        chat.tools = vec![Box::new(Echo), Box::new(Shout)];
        chat.approver = Some(Arc::new(AutoApprove::new(gate)));
        let mut session = Session::new();
        let (out, events) = run(&chat, &mut session, "call them").await;
        assert!(!out.unwrap().interrupted);

        assert_eq!(*asked.lock().unwrap(), ["echo", "shout"]);
        // All three still ran: remembering the answer is not skipping the
        // call.
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, TurnEvent::ToolResult { .. }))
                .count(),
            3
        );
    }

    /// Prompting on reads is how a user learns to answer without reading —
    /// the gate has to stay quiet for anything that cannot act.
    #[tokio::test]
    async fn read_only_tools_are_never_asked_about() {
        let (gate, asked) = Gate::new(|_| Decision::Deny("no".into()));
        let provider = Scripted::provider(vec![tool_call("peek", json!({})), says("saw it")]);
        let mut chat = Chat::new(provider, "test-model");
        chat.tools = vec![Box::new(Peek)];
        chat.approver = Some(Arc::new(AutoApprove::new(gate)));
        let mut session = Session::new();
        let (_, events) = run(&chat, &mut session, "have a look").await;

        assert!(asked.lock().unwrap().is_empty());
        assert!(events.iter().any(|e| matches!(
            e,
            TurnEvent::ToolResult { content, .. } if content == "looked"
        )));
    }

    /// The default has to leave every existing caller — CLI, probe, any
    /// embedder — running exactly as it did before the gate existed.
    #[tokio::test]
    async fn no_approver_runs_every_call() {
        let provider = Scripted::provider(vec![
            tool_call("echo", json!({ "msg": "pong" })),
            says("done"),
        ]);
        let mut chat = Chat::new(provider, "test-model");
        chat.tools = vec![Box::new(Echo)];
        assert!(chat.approver.is_none());
        let mut session = Session::new();
        let (out, events) = run(&chat, &mut session, "call echo").await;
        assert_eq!(out.unwrap().stop_reason.as_deref(), Some("end_turn"));
        assert!(events.iter().any(|e| matches!(
            e,
            TurnEvent::ToolResult { content, is_error: false, .. } if content == "pong"
        )));
        assert!(
            !events
                .iter()
                .any(|e| matches!(e, TurnEvent::ToolDenied { .. }))
        );
    }

    /// The final round executes its calls precisely so none is left without
    /// a result; a refusal there has to hold the same line.
    #[tokio::test]
    async fn a_denial_on_the_final_round_still_records_a_result() {
        let (gate, asked) = Gate::new(|_| Decision::Deny(String::new()));
        let provider = Scripted::provider(vec![tool_call("echo", json!({ "msg": "pong" }))]);
        let mut chat = Chat::new(provider, "test-model");
        chat.tools = vec![Box::new(Echo)];
        chat.approver = Some(gate);
        chat.max_rounds = 1;
        let mut session = Session::new();
        let (out, events) = run(&chat, &mut session, "call echo").await;
        assert!(!out.unwrap().interrupted);

        assert_eq!(*asked.lock().unwrap(), ["echo"]);
        assert!(
            events
                .iter()
                .any(|e| matches!(e, TurnEvent::RoundLimit { rounds: 1 }))
        );
        assert!(matches!(
            session.events().last(),
            Some(SessionEvent::ToolResult { is_error: true, .. })
        ));
    }

    /// A name no tool answers to is not a consent question. The model
    /// invented the tool; there is nothing for a user to permit.
    #[tokio::test]
    async fn an_unknown_tool_is_not_put_to_the_user() {
        let (gate, asked) = Gate::new(|_| Decision::Deny("no".into()));
        let provider = Scripted::provider(vec![tool_call("no_such_tool", json!({})), says("oops")]);
        let mut chat = Chat::new(provider, "test-model");
        chat.tools = vec![Box::new(Echo)];
        chat.approver = Some(gate);
        let mut session = Session::new();
        let (_, events) = run(&chat, &mut session, "go").await;

        assert!(asked.lock().unwrap().is_empty());
        assert!(events.iter().any(|e| matches!(
            e,
            TurnEvent::ToolResult { content, is_error: true, .. } if content.contains("unknown tool")
        )));
    }

    #[tokio::test]
    async fn empty_reply_records_placeholder_text_block() {
        let provider = Scripted::provider(vec![vec![StreamEvent::End {
            stop_reason: Some("end_turn".into()),
        }]]);
        let chat = Chat::new(provider, "test-model");
        let mut session = Session::new();
        let (out, _) = run(&chat, &mut session, "hi").await;
        assert!(out.is_ok());
        let msgs = session.messages();
        assert!(matches!(
            &msgs[1].content[..],
            [ContentBlock::Text { text }] if text.is_empty()
        ));
    }

    #[tokio::test]
    async fn each_round_of_a_tool_loop_is_costed_separately() {
        let round = |input: u64, output: u64, events: Vec<StreamEvent>| {
            let mut v = vec![StreamEvent::Usage(Usage {
                input_tokens: input,
                output_tokens: output,
                ..Default::default()
            })];
            v.extend(events);
            v
        };
        let provider = Scripted::provider(vec![
            round(1_000, 100, tool_call("current_time", json!({}))),
            round(1_500, 50, says("half past")),
        ]);
        let mut chat = Chat::new(provider, "test-model");
        chat.tools = crate::tools::builtin();
        // $1/MTok in, $10/MTok out, no caching.
        chat.price = Some(Price {
            input: 1.0,
            output: 10.0,
            cache_read: None,
            cache_write: None,
        });
        let mut session = Session::new();
        let (out, _) = run(&chat, &mut session, "when").await;
        assert!(out.is_ok());

        let costs: Vec<Option<f64>> = session
            .events()
            .iter()
            .filter_map(|e| match e {
                SessionEvent::AssistantMessage { cost, .. } => Some(*cost),
                _ => None,
            })
            .collect();
        // Two rounds, each billed on its own usage. Costing the turn total
        // once would charge the cached prefix a single time and undercount.
        assert_eq!(costs.len(), 2);
        let expected = [
            (1_000.0 * 1.0 + 100.0 * 10.0) / 1e6,
            (1_500.0 * 1.0 + 50.0 * 10.0) / 1e6,
        ];
        for (got, want) in costs.iter().zip(expected) {
            assert!((got.unwrap() - want).abs() < 1e-12, "{got:?} vs {want}");
        }
        let total = session.cost();
        assert!(total.is_complete());
        assert!((total.usd - expected.iter().sum::<f64>()).abs() < 1e-12);
    }

    #[tokio::test]
    async fn an_unpriced_model_records_no_cost_rather_than_zero() {
        let provider = Scripted::provider(vec![says("hi")]);
        let chat = Chat::new(provider, "some-local-model");
        let mut session = Session::new();
        let (out, _) = run(&chat, &mut session, "hi").await;
        assert!(out.is_ok());
        let total = session.cost();
        assert_eq!(total.usd, 0.0);
        // Zero dollars across one unpriced exchange is not a free session,
        // and a UI has to be able to tell the two apart.
        assert!(!total.is_complete());
        assert_eq!(total.unpriced_exchanges, 1);
    }

    /// Records the order calls actually ran in, and the peak number in flight
    /// at once. `effect` is what the engine sorts on, so one type covers both
    /// sides of the concurrency rule.
    struct Observer {
        name: &'static str,
        effect: Effect,
        log: Arc<Mutex<Vec<String>>>,
        active: Arc<std::sync::atomic::AtomicUsize>,
        peak: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl Observer {
        fn boxed(name: &'static str, effect: Effect, w: &Watch) -> Box<dyn Tool> {
            Box::new(Self {
                name,
                effect,
                log: Arc::clone(&w.log),
                active: Arc::clone(&w.active),
                peak: Arc::clone(&w.peak),
            })
        }
    }

    /// The shared counters an `Observer` writes to.
    #[derive(Clone, Default)]
    struct Watch {
        log: Arc<Mutex<Vec<String>>>,
        active: Arc<std::sync::atomic::AtomicUsize>,
        peak: Arc<std::sync::atomic::AtomicUsize>,
    }

    impl Watch {
        fn order(&self) -> Vec<String> {
            self.log.lock().unwrap().clone()
        }
        fn peak(&self) -> usize {
            self.peak.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    #[async_trait::async_trait]
    impl Tool for Observer {
        fn def(&self) -> ToolDef {
            ToolDef {
                name: self.name.into(),
                description: "an observed tool".into(),
                input_schema: json!({ "type": "object" }),
            }
        }

        fn effect(&self) -> Effect {
            self.effect
        }

        async fn call(&self, input: serde_json::Value) -> Result<String, String> {
            use std::sync::atomic::Ordering::SeqCst;
            let msg = input["msg"].as_str().unwrap_or_default().to_string();
            let now = self.active.fetch_add(1, SeqCst) + 1;
            self.peak.fetch_max(now, SeqCst);
            self.log.lock().unwrap().push(msg.clone());
            // Long enough that sequential execution cannot look concurrent.
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
            self.active.fetch_sub(1, SeqCst);
            Ok(msg)
        }
    }

    /// The win: a model that asks for three reads at once gets three reads at
    /// once, rather than one after another.
    #[tokio::test]
    async fn adjacent_read_only_calls_run_at_the_same_time() {
        let watch = Watch::default();
        let provider = Scripted::provider(vec![
            tool_calls(&[("a", "look"), ("b", "look"), ("c", "look")]),
            says("done"),
        ]);
        let mut chat = Chat::new(provider, "test-model");
        chat.tools = vec![Observer::boxed("look", Effect::ReadOnly, &watch)];
        let mut session = Session::new();
        let (out, _) = run(&chat, &mut session, "read three things").await;

        assert!(out.is_ok());
        assert_eq!(watch.peak(), 3);
    }

    /// A mutating call is not something to race, so it runs alone.
    #[tokio::test]
    async fn a_mutating_call_never_overlaps_anything() {
        let watch = Watch::default();
        let provider = Scripted::provider(vec![
            tool_calls(&[("a", "edit"), ("b", "edit"), ("c", "edit")]),
            says("done"),
        ]);
        let mut chat = Chat::new(provider, "test-model");
        chat.tools = vec![Observer::boxed("edit", Effect::Mutating, &watch)];
        let mut session = Session::new();
        let _ = run(&chat, &mut session, "edit three things").await;

        assert_eq!(watch.peak(), 1);
        assert_eq!(watch.order(), ["a", "b", "c"]);
    }

    /// Only *adjacent* reads overlap. Hoisting every read to the front of the
    /// round would be faster and would let a read see the file as it was
    /// before a write in the same round — a wrong answer instead of a slow
    /// one.
    #[tokio::test]
    async fn a_write_between_two_reads_keeps_its_place() {
        let watch = Watch::default();
        let provider = Scripted::provider(vec![
            tool_calls(&[("a", "look"), ("b", "edit"), ("c", "look")]),
            says("done"),
        ]);
        let mut chat = Chat::new(provider, "test-model");
        chat.tools = vec![
            Observer::boxed("look", Effect::ReadOnly, &watch),
            Observer::boxed("edit", Effect::Mutating, &watch),
        ];
        let mut session = Session::new();
        let _ = run(&chat, &mut session, "read, write, read").await;

        assert_eq!(watch.order(), ["a", "b", "c"]);
        assert_eq!(watch.peak(), 1);
    }

    /// Whatever order they finished in, the model sees them in the order it
    /// asked — Gemini pairs function responses by position, and a shell
    /// renders the events as a transcript.
    #[tokio::test]
    async fn results_are_recorded_and_announced_in_call_order() {
        let watch = Watch::default();
        let provider = Scripted::provider(vec![
            tool_calls(&[("a", "look"), ("b", "look"), ("c", "look")]),
            says("done"),
        ]);
        let mut chat = Chat::new(provider, "test-model");
        chat.tools = vec![Observer::boxed("look", Effect::ReadOnly, &watch)];
        let mut session = Session::new();
        let (_, events) = run(&chat, &mut session, "read three things").await;

        let announced: Vec<String> = events
            .iter()
            .filter_map(|e| match e {
                TurnEvent::ToolResult { content, .. } => Some(content.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(announced, ["a", "b", "c"]);

        let logged: Vec<String> = session
            .events()
            .iter()
            .filter_map(|e| match e {
                SessionEvent::ToolResult { content, .. } => Some(content.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(logged, ["a", "b", "c"]);
    }

    /// A refusal is settled before anything runs, and still arrives as
    /// `ToolDenied` rather than `ToolResult` — with the neighbouring reads
    /// unaffected.
    #[tokio::test]
    async fn a_denial_in_a_batch_stops_only_itself() {
        let watch = Watch::default();
        let provider = Scripted::provider(vec![
            tool_calls(&[("a", "look"), ("b", "edit"), ("c", "look")]),
            says("done"),
        ]);
        let mut chat = Chat::new(provider, "test-model");
        chat.tools = vec![
            Observer::boxed("look", Effect::ReadOnly, &watch),
            Observer::boxed("edit", Effect::Mutating, &watch),
        ];
        chat.approver = Some(Arc::new(Denies));
        let mut session = Session::new();
        let (_, events) = run(&chat, &mut session, "read, write, read").await;

        // The write never ran; the reads did, in place.
        assert_eq!(watch.order(), ["a", "c"]);
        assert!(events.iter().any(|e| matches!(
            e,
            TurnEvent::ToolDenied { name, .. } if name == "edit"
        )));
        assert!(!events.iter().any(|e| matches!(
            e,
            TurnEvent::ToolResult { name, .. } if name == "edit"
        )));
        // The log still carries a result for it: a tool_use without one is
        // invalid on replay.
        let logged: Vec<&str> = session
            .events()
            .iter()
            .filter_map(|e| match e {
                SessionEvent::ToolResult { name, .. } => Some(name.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(logged, ["look", "edit", "look"]);
    }

    /// Refuses everything mutating, with a reason.
    struct Denies;

    #[async_trait::async_trait]
    impl Approver for Denies {
        async fn approve(&self, call: &PendingCall<'_>) -> Decision {
            match call.effect {
                Effect::Mutating => Decision::Deny("not this time".into()),
                _ => Decision::Allow,
            }
        }
    }

    /// The point of the feature: a session comes out of its first turn with
    /// a name, generated from that turn and nothing else.
    #[tokio::test]
    async fn a_session_is_named_from_its_first_exchange() {
        let (provider, seen) = Scripted::recording(vec![
            says("Renaming it in four files and one test."),
            says("Renaming fetch_rows across the crate"),
        ]);
        let mut chat = Chat::new(provider, "test-model");
        chat.enable_titles();
        let mut session = Session::new();
        let _ = run(&chat, &mut session, "rename fetch_rows everywhere").await;

        assert_eq!(
            session.title(),
            Some("Renaming fetch_rows across the crate")
        );

        // Two clipped excerpts and the instruction, not the conversation:
        // the naming request must not grow with the session it names.
        let requests = seen.lock().unwrap();
        let naming = &requests[1];
        assert_eq!(naming.messages.len(), 1);
        assert!(naming.tools.is_empty());
        assert!(naming.system.segments().is_empty());
        let sent = naming.messages[0].text();
        assert!(sent.contains("rename fetch_rows everywhere"), "{sent}");
        assert!(sent.contains("four files and one test"), "{sent}");
    }

    /// Once, not once a turn. The scripted provider panics if called a third
    /// time, which is the assertion.
    #[tokio::test]
    async fn a_named_session_is_not_named_again() {
        let provider = Scripted::provider(vec![
            says("first reply"),
            says("A name for it"),
            says("second reply"),
        ]);
        let mut chat = Chat::new(provider, "test-model");
        chat.enable_titles();
        let mut session = Session::new();
        let _ = run(&chat, &mut session, "one").await;
        let _ = run(&chat, &mut session, "two").await;

        assert_eq!(session.title(), Some("A name for it"));
        let names = session
            .events()
            .iter()
            .filter(|e| matches!(e, SessionEvent::Title { .. }))
            .count();
        assert_eq!(names, 1);
    }

    /// Off unless a shell asks, so the probe and the eval suite are not
    /// quietly paying for a second call at the end of every turn.
    #[tokio::test]
    async fn titling_is_off_unless_asked_for() {
        // One script only: a title call would panic the provider.
        let provider = Scripted::provider(vec![says("reply")]);
        let chat = Chat::new(provider, "test-model");
        let mut session = Session::new();
        let _ = run(&chat, &mut session, "one").await;
        assert_eq!(session.title(), None);
    }

    /// A model that answers with nothing usable leaves the session nameless
    /// rather than failing the turn — and gets asked again next turn.
    #[tokio::test]
    async fn an_unusable_title_does_not_cost_the_turn() {
        let provider = Scripted::provider(vec![says("the reply"), says("   ")]);
        let mut chat = Chat::new(provider, "test-model");
        chat.enable_titles();
        let mut session = Session::new();
        let (out, _) = run(&chat, &mut session, "one").await;

        assert!(out.is_ok());
        assert_eq!(session.title(), None);
        assert_eq!(session.messages().len(), 2);
    }

    /// Models package a title variously. Unwrapping it is cheaper than a
    /// stricter prompt and does not throw away a good name over a full stop.
    #[test]
    fn a_title_is_stripped_of_its_packaging() {
        assert_eq!(clean_title("Renaming fetch_rows"), "Renaming fetch_rows");
        assert_eq!(
            clean_title("  \"Renaming fetch_rows.\"  "),
            "Renaming fetch_rows"
        );
        assert_eq!(
            clean_title("**Renaming fetch_rows**"),
            "Renaming fetch_rows"
        );
        assert_eq!(
            clean_title("\u{201c}Renaming fetch_rows\u{201d}"),
            "Renaming fetch_rows"
        );
        assert_eq!(
            clean_title("Renaming fetch_rows\n\nI kept it short as asked."),
            "Renaming fetch_rows"
        );
        assert_eq!(clean_title("\n\n"), "");
        // Long enough to need clipping: a name is a column, not a sentence.
        let long = "a ".repeat(60);
        assert!(clean_title(&long).chars().count() <= TITLE_MAX_CHARS + 1);
    }

    /// Nothing to name until the model has spoken, the same test `compact`
    /// makes before summarizing.
    #[tokio::test]
    async fn titling_refuses_a_session_with_no_reply() {
        let provider = Scripted::provider(vec![]);
        let chat = Chat::new(provider, "test-model");
        let mut session = Session::new();
        session.record_user("just asked");
        let cancel = CancellationToken::new();
        assert!(chat.title(&mut session, &cancel).await.is_err());
    }
}
