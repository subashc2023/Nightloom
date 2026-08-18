use crate::sidecar::{self, SidecarContext, SidecarPart};
use futures::StreamExt;
use nightloom_core::{
    ChatRequest, ContentBlock, Message, Provider, ProviderError, Role, Session, StreamEvent,
    SystemPrompt, Thinking, Usage,
    tool::{Tool, defs, run_tool},
};
use serde::Serialize;
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
    /// The per-turn tool-round cap was hit: the final round's results are
    /// recorded, but the model gets no further reply this turn.
    RoundLimit {
        rounds: usize,
    },
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
    pub max_rounds: usize,
    /// Everything the preamble deliberately can't hold: the clock, the task
    /// list, how full the window is. Rendered fresh each turn onto the tail
    /// of the user's message. Empty disables it.
    pub sidecar: Vec<Box<dyn SidecarPart>>,
    /// The model's input-token limit, for the context gauge. `None` leaves
    /// the gauge reporting usage without a percentage rather than inventing
    /// a limit.
    pub context_limit: Option<u64>,
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
            max_rounds: 8,
            sidecar: sidecar::default_parts(),
            context_limit: None,
        }
    }

    /// Run one user turn: record it, stream the reply into the session and
    /// `on_event`, execute tool calls and loop their results back to the
    /// provider until it answers in text (capped at `max_rounds`).
    ///
    /// Cancelling the token mid-stream records the partial reply with
    /// pending tool calls stripped (a `tool_use` without a result is invalid
    /// on replay) and returns with `interrupted: true`; a mid-stream error
    /// records the same way, then surfaces as `Err`.
    pub async fn run_turn(
        &self,
        session: &mut Session,
        input: &str,
        cancel: &CancellationToken,
        on_event: &mut (dyn FnMut(TurnEvent) + Send),
    ) -> Result<TurnOutcome, ProviderError> {
        session.record_user(input);
        let mut turn_usage = Usage::default();

        for round in 1..=self.max_rounds.max(1) {
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
                    StreamEvent::ToolUse { id, name, input } => {
                        flush_thinking(&mut thinking_buf, &mut blocks, None);
                        flush_text(&mut text_buf, &mut blocks);
                        on_event(TurnEvent::ToolCall {
                            id: id.clone(),
                            name: name.clone(),
                            input: input.clone(),
                        });
                        blocks.push(ContentBlock::ToolUse {
                            id: id.clone(),
                            name: name.clone(),
                            input: input.clone(),
                        });
                        calls.push((id, name, input));
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

            if interrupted || stream_err.is_some() {
                // These calls will never get results, and a tool_use without
                // a result is invalid on replay — drop them from the record.
                // The thinking/text streamed so far is kept.
                blocks.retain(|b| !matches!(b, ContentBlock::ToolUse { .. }));
                if !blocks.is_empty() {
                    let reason = if interrupted { "interrupted" } else { "error" };
                    session.record_assistant(&self.model, blocks, Some(reason.into()), usage);
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
            session.record_assistant(&self.model, blocks, stop_reason.clone(), usage);

            if calls.is_empty() {
                return Ok(TurnOutcome {
                    interrupted: false,
                    stop_reason,
                    usage: turn_usage,
                });
            }
            // Execute even on the last round so no call is left without a
            // result in the session; just don't go back to the provider.
            for (id, name, input) in calls {
                let result = run_tool(&self.tools, &id, &name, input).await;
                if let ContentBlock::ToolResult {
                    tool_use_id,
                    name,
                    content,
                    is_error,
                } = &result
                {
                    on_event(TurnEvent::ToolResult {
                        tool_use_id: tool_use_id.clone(),
                        name: name.clone(),
                        content: content.clone(),
                        is_error: *is_error,
                    });
                }
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
}

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
    use crate::tools::TodoWrite;
    use nightloom_core::TodoStatus;
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
            },
            StreamEvent::End {
                stop_reason: Some("tool_use".into()),
            },
        ]
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

    #[tokio::test]
    async fn cancel_strips_pending_tool_calls_and_records_partial() {
        let provider: Box<dyn Provider> = Box::new(Stall(Mutex::new(vec![
            StreamEvent::TextDelta("partial".into()),
            StreamEvent::ToolUse {
                id: "c1".into(),
                name: "echo".into(),
                input: json!({}),
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
}
