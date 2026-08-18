use futures::StreamExt;
use nightloom_core::{
    ChatRequest, ContentBlock, Provider, ProviderError, Session, StreamEvent, Thinking, Usage,
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

/// A configured conversation engine: provider + model + tools + knobs. Owns
/// no session — callers pass one per turn, so one `Chat` can serve many.
pub struct Chat {
    pub provider: Box<dyn Provider>,
    pub model: String,
    pub system: Option<String>,
    pub thinking: Thinking,
    pub max_tokens: u32,
    pub tools: Vec<Box<dyn Tool>>,
    pub max_rounds: usize,
}

impl Chat {
    pub fn new(provider: Box<dyn Provider>, model: impl Into<String>) -> Self {
        Self {
            provider,
            model: model.into(),
            system: None,
            thinking: Thinking::Default,
            max_tokens: 8192,
            tools: Vec::new(),
            max_rounds: 8,
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
            let request = ChatRequest {
                model: self.model.clone(),
                system: self.system.clone(),
                messages: session.messages(),
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use nightloom_core::{EventStream, SessionEvent, ToolDef};
    use serde_json::json;
    use std::sync::Mutex;

    /// Yields one scripted stream per `stream_chat` call, in order.
    struct Scripted(Mutex<Vec<Vec<StreamEvent>>>);

    impl Scripted {
        fn provider(scripts: Vec<Vec<StreamEvent>>) -> Box<dyn Provider> {
            Box::new(Self(Mutex::new(scripts)))
        }
    }

    #[async_trait::async_trait]
    impl Provider for Scripted {
        fn name(&self) -> &'static str {
            "scripted"
        }

        async fn stream_chat(&self, _: ChatRequest) -> Result<EventStream, ProviderError> {
            let mut scripts = self.0.lock().unwrap();
            assert!(!scripts.is_empty(), "provider called more than scripted");
            let events = scripts.remove(0);
            Ok(Box::pin(futures::stream::iter(events.into_iter().map(Ok))))
        }
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
