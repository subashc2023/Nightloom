use crate::{api_error, parse, transport};
use async_stream::try_stream;
use eventsource_stream::Eventsource;
use futures::StreamExt;
use nightloom_core::{
    ChatRequest, ContentBlock, EventStream, Message, Provider, ProviderError, Role, StreamEvent,
    Thinking, Usage,
};
use serde_json::{Value, json};

const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";

/// Native adapter for the OpenAI Responses API — OpenAI's current-generation
/// endpoint. Unlike `chat/completions`, it streams reasoning *summaries*
/// (`response.reasoning_summary_text.delta`), so reasoning models produce
/// visible thinking instead of only billing hidden tokens.
pub struct OpenAiResponses {
    client: reqwest::Client,
    api_key: String,
    base_url: String,
}

impl OpenAiResponses {
    pub fn new(api_key: impl Into<String>, base_url: Option<String>) -> Self {
        Self {
            client: reqwest::Client::new(),
            api_key: api_key.into(),
            base_url: base_url.unwrap_or_else(|| DEFAULT_BASE_URL.to_string()),
        }
    }

    fn body(request: &ChatRequest) -> Result<Value, ProviderError> {
        Self::body_with(request, true)
    }

    /// `keep_reasoning: false` drops every replayed `reasoning` item.
    ///
    /// The one caller that passes `false` is the retry in [`Provider::
    /// stream_chat`]. Dropping them is always safe on the wire: a reasoning
    /// item is a standalone input item, and the only ordering rule about them
    /// — that one must be followed by the item it produced — cannot be broken
    /// by removing all of them.
    fn body_with(request: &ChatRequest, keep_reasoning: bool) -> Result<Value, ProviderError> {
        let input: Vec<Value> = request
            .messages
            .iter()
            .flat_map(to_wire_items)
            .filter(|item| keep_reasoning || item["type"].as_str() != Some("reasoning"))
            .collect();
        let mut body = json!({
            "model": request.model,
            "stream": true,
            "input": input,
            "max_output_tokens": request.max_tokens,
        });
        if let Some(system) = request.system.render_flat() {
            body["instructions"] = json!(system);
        }
        if !request.tools.is_empty() {
            // Responses puts name/description/parameters at the top level of
            // the tool object, unlike chat/completions' nested "function".
            let tools: Vec<Value> = request
                .tools
                .iter()
                .map(|t| {
                    json!({
                        "type": "function",
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.input_schema,
                    })
                })
                .collect();
            body["tools"] = json!(tools);
        }
        if let Some(t) = request.temperature {
            body["temperature"] = json!(t);
        }
        match &request.thinking {
            Thinking::Default => {}
            // summary: "auto" asks for the richest reasoning summary the
            // model supports; without it nothing thinking-shaped streams.
            Thinking::Effort(e) => body["reasoning"] = json!({ "effort": e, "summary": "auto" }),
            Thinking::Budget(n) => {
                return Err(ProviderError::Config(format!(
                    "openai does not support budget={n}; use effort=minimal|low|medium|high"
                )));
            }
        }
        Ok(body)
    }
}

// One canonical message can span several Responses input items: tool calls
// and tool results are top-level items there, not content parts.
fn to_wire_items(message: &Message) -> Vec<Value> {
    // Responses distinguishes input (user) from output (assistant) text parts.
    let (role, part_type) = match message.role {
        Role::User => ("user", "input_text"),
        Role::Assistant => ("assistant", "output_text"),
    };
    let mut items = Vec::new();
    if message.role == Role::User {
        // Results must precede any commentary so they pair with the calls
        // that immediately precede them in the replayed transcript.
        for block in &message.content {
            if let ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
                ..
            } = block
            {
                // function_call_output has no error flag; fold it into the
                // output text. (`name` is only carried for Gemini — drop it.)
                let output = if *is_error {
                    format!("ERROR: {content}")
                } else {
                    content.clone()
                };
                items.push(json!({
                    "type": "function_call_output",
                    "call_id": tool_use_id,
                    "output": output,
                }));
            }
        }
    }
    if message.role == Role::Assistant {
        // Assistant blocks are walked in stream order rather than grouped by
        // kind: Responses requires a `reasoning` item to be immediately
        // followed by the item it produced, so the recorded order is the
        // wire order.
        let mut text_parts: Vec<Value> = Vec::new();
        let flush = |items: &mut Vec<Value>, text_parts: &mut Vec<Value>| {
            if !text_parts.is_empty() {
                items.push(json!({ "role": role, "content": std::mem::take(text_parts) }));
            }
        };
        for block in &message.content {
            match block {
                ContentBlock::Text { text } => {
                    text_parts.push(json!({ "type": part_type, "text": text }));
                }
                // Replayed statelessly by id rather than via
                // `previous_response_id`: the session log is already the one
                // source of truth, and a server-side conversation handle
                // would be a second one that can drift from it. The tradeoff
                // is that we depend on the item still being retrievable —
                // requests are stored by default, which is what makes the
                // bare id enough. A zero-data-retention mode (`store: false`)
                // would instead need the item's `encrypted_content`, which is
                // a second opaque field and deliberately not modelled here.
                ContentBlock::ReasoningRef { id } => {
                    flush(&mut items, &mut text_parts);
                    items.push(json!({ "type": "reasoning", "id": id, "summary": [] }));
                }
                ContentBlock::ToolUse {
                    id, name, input, ..
                } => {
                    flush(&mut items, &mut text_parts);
                    items.push(json!({
                        "type": "function_call",
                        "call_id": id,
                        "name": name,
                        // Responses carries arguments as a JSON-encoded string.
                        "arguments": input.to_string(),
                    }));
                }
                _ => {}
            }
        }
        flush(&mut items, &mut text_parts);
        // A reasoning item with nothing after it is rejected ("provided
        // without its required following item"). That happens whenever a
        // turn was cancelled or errored after the reasoning item but before
        // the call it was leading to, which the engine then strips.
        while items
            .last()
            .is_some_and(|i| i["type"].as_str() == Some("reasoning"))
        {
            items.pop();
        }
        return items;
    }
    // Only the user path reaches here — the assistant branch above returns —
    // which is also why attachments need no role guard: an image or document
    // recorded against an assistant turn falls into that branch's `_ => {}`
    // and is dropped.
    let parts: Vec<Value> = message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(json!({ "type": part_type, "text": text })),
            // Responses takes the media type folded into a data URL rather
            // than named separately, so the canonical pair is rejoined here.
            ContentBlock::Image { media_type, data } => Some(json!({
                "type": "input_image",
                "image_url": format!("data:{media_type};base64,{data}"),
            })),
            // `filename` is required here rather than optional, which is one
            // of the two reasons the canonical block carries a name at all.
            ContentBlock::Document {
                media_type,
                name,
                data,
            } => Some(json!({
                "type": "input_file",
                "filename": name,
                "file_data": format!("data:{media_type};base64,{data}"),
            })),
            _ => None,
        })
        .collect();
    if !parts.is_empty() {
        items.push(json!({ "role": role, "content": parts }));
    }
    items
}

#[async_trait::async_trait]
impl Provider for OpenAiResponses {
    fn name(&self) -> &'static str {
        "openai"
    }

    async fn stream_chat(&self, request: ChatRequest) -> Result<EventStream, ProviderError> {
        if self.api_key.is_empty() {
            return Err(ProviderError::Config(
                "missing OpenAI API key (set OPENAI_API_KEY)".into(),
            ));
        }
        let send = async |body: Value| {
            self.client
                .post(format!("{}/responses", self.base_url))
                .bearer_auth(&self.api_key)
                .json(&body)
                .send()
                .await
                .map_err(transport)
        };

        let resp = send(Self::body(&request)?).await?;
        if !resp.status().is_success() {
            let err = api_error(resp).await;
            // A reasoning item is the one thing this harness replays that the
            // log does not actually hold: it is a handle into OpenAI's store,
            // and the store forgets. Images are inlined precisely so a log
            // replays on its own; this cannot be, so the failure it produces
            // has to be survivable instead. Left alone it is the worst shape
            // available — a session that reopens after the retention window
            // fails on this turn and on every turn after it, permanently,
            // over reasoning that was never part of the conversation.
            //
            // So: drop the handles and ask once more. What is lost is the
            // model's own prior reasoning, which had already expired; what is
            // kept is the conversation.
            if is_missing_reasoning_item(&err) && replays_reasoning(&request) {
                let resp = send(Self::body_with(&request, false)?).await?;
                if !resp.status().is_success() {
                    return Err(api_error(resp).await);
                }
                return Ok(normalize(resp.bytes_stream()));
            }
            return Err(err);
        }

        Ok(normalize(resp.bytes_stream()))
    }
}

/// Whether this request replays a reasoning handle at all. Without one there
/// is nothing for the retry to drop, and retrying would only spend a second
/// request on the same rejection.
fn replays_reasoning(request: &ChatRequest) -> bool {
    request
        .messages
        .iter()
        .flat_map(|m| &m.content)
        .any(|b| matches!(b, ContentBlock::ReasoningRef { .. }))
}

/// Whether a rejection is the API saying it no longer has an item we replayed.
///
/// Matched on the message because the status and code do not distinguish it:
/// it arrives as an ordinary 400 `invalid_request_error` naming the item id.
/// Deliberately narrow — a 400 that is genuinely about the request must not be
/// retried into a second identical failure, so this asks for the item shape
/// (`rs_…` or the word reasoning) *and* for the API's not-found phrasing.
fn is_missing_reasoning_item(err: &ProviderError) -> bool {
    let ProviderError::Api {
        status: 400,
        message,
    } = err
    else {
        return false;
    };
    let m = message.to_ascii_lowercase();
    (m.contains("not found") || m.contains("expired") || m.contains("no longer exists"))
        && (m.contains("rs_") || m.contains("reasoning"))
}

/// Turn the Responses API's SSE body into `StreamEvent`s.
///
/// Split from the request half so a canned body can reach the two things this
/// dialect does that no other does: reasoning that arrives as a server-side
/// handle to be replayed by id, and tool calls read whole off an item-done
/// event rather than assembled from argument deltas.
pub(crate) fn normalize<S, B, E>(body: S) -> EventStream
where
    S: futures::Stream<Item = Result<B, E>> + Send + 'static,
    B: AsRef<[u8]> + Send + 'static,
    E: std::error::Error + Send + Sync + 'static,
{
    Box::pin(try_stream! {
            let mut events = Box::pin(body).eventsource();
            // Whether a terminal `response.*` event arrived. Without one the
            // stream ending is a dropped connection, not a finished turn.
            let mut completed = false;

            while let Some(event) = events.next().await {
                let event = event.map_err(transport)?;
                if event.data.is_empty() || event.data.trim() == "[DONE]" {
                    continue;
                }
                let v: Value = serde_json::from_str(&event.data).map_err(parse)?;
                match v["type"].as_str().unwrap_or_default() {
                    "response.created" => yield StreamEvent::Start,
                    "response.output_text.delta" => {
                        if let Some(text) = v["delta"].as_str()
                            && !text.is_empty()
                        {
                            yield StreamEvent::TextDelta(text.to_string());
                        }
                    }
                    // Summaries for hidden-CoT models; raw reasoning text for
                    // models that expose it (e.g. gpt-oss).
                    "response.reasoning_summary_text.delta"
                    | "response.reasoning_text.delta" => {
                        if let Some(text) = v["delta"].as_str()
                            && !text.is_empty()
                        {
                            yield StreamEvent::ThinkingDelta(text.to_string());
                        }
                    }
                    // The done item carries the full call, so we can skip
                    // stitching function_call_arguments deltas ourselves.
                    "response.output_item.done" => {
                        let item = &v["item"];
                        // The reasoning *summary* streams as thinking deltas
                        // above; the replayable artifact is the reasoning
                        // item itself. Capturing its id here — after its
                        // summary deltas, before the next item's — puts it in
                        // the recorded position the API expects it back in.
                        if item["type"].as_str() == Some("reasoning")
                            && let Some(id) = item["id"].as_str()
                        {
                            yield StreamEvent::ReasoningRef { id: id.to_string() };
                        }
                        if item["type"].as_str() == Some("function_call") {
                            let args = item["arguments"].as_str().unwrap_or_default();
                            // Empty string means a zero-argument call.
                            let input: Value = if args.is_empty() {
                                json!({})
                            } else {
                                serde_json::from_str(args).map_err(parse)?
                            };
                            yield StreamEvent::ToolUse {
                                id: item["call_id"].as_str().unwrap_or_default().to_string(),
                                name: item["name"].as_str().unwrap_or_default().to_string(),
                                input,
                                // OpenAI doesn't sign calls; its reasoning
                                // travels as its own item.
                                signature: None,
                            };
                        }
                    }
                    "response.completed" | "response.incomplete" => {
                        let r = &v["response"];
                        let u = &r["usage"];
                        yield StreamEvent::Usage(Usage {
                            input_tokens: u["input_tokens"].as_u64().unwrap_or(0),
                            output_tokens: u["output_tokens"].as_u64().unwrap_or(0),
                            reasoning_tokens: u["output_tokens_details"]["reasoning_tokens"]
                                .as_u64(),
                            // Already a subset of `input_tokens` here, unlike
                            // Anthropic. Cache writes are not billed or
                            // reported separately.
                            cache_read_tokens: u["input_tokens_details"]["cached_tokens"].as_u64(),
                            cache_write_tokens: None,
                        });
                        // "completed", or the incomplete reason (e.g.
                        // "max_output_tokens") when the response was cut off.
                        let stop_reason = r["incomplete_details"]["reason"]
                            .as_str()
                            .or(r["status"].as_str())
                            .map(String::from);
                        yield StreamEvent::End { stop_reason };
                        completed = true;
                        break;
                    }
                    "response.failed" => {
                        Err(ProviderError::Api {
                            status: 200,
                            message: v["response"]["error"]["message"]
                                .as_str()
                                .unwrap_or("response failed")
                                .to_string(),
                        })?;
                    }
                    "error" => {
                        Err(ProviderError::Api {
                            status: 200,
                            message: v["message"]
                                .as_str()
                                .unwrap_or("unknown mid-stream error")
                                .to_string(),
                        })?;
                    }
                    // output_item.added, content_part events, incremental
                    // function_call_arguments deltas, deltas we don't render
                    // yet (refusals, annotations), etc.
                    _ => {}
                }
            }
            if !completed {
                Err(crate::truncated("openai"))?;
            }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use nightloom_core::{SystemPrompt, ToolDef};

    fn request(messages: Vec<Message>, tools: Vec<ToolDef>) -> ChatRequest {
        ChatRequest {
            model: "gpt-test".into(),
            system: SystemPrompt::default(),
            messages,
            max_tokens: 128,
            temperature: None,
            thinking: Thinking::Default,
            tools,
        }
    }

    #[test]
    fn tools_serialize_flat() {
        let body = OpenAiResponses::body(&request(
            vec![Message::user("hi")],
            vec![ToolDef {
                name: "get_weather".into(),
                description: "Look up weather".into(),
                input_schema: json!({ "type": "object", "properties": {} }),
            }],
        ))
        .unwrap();
        assert_eq!(
            body["tools"],
            json!([{
                "type": "function",
                "name": "get_weather",
                "description": "Look up weather",
                "parameters": { "type": "object", "properties": {} },
            }])
        );
    }

    #[test]
    fn no_tools_field_when_empty() {
        let body = OpenAiResponses::body(&request(vec![Message::user("hi")], vec![])).unwrap();
        assert!(body.get("tools").is_none());
    }

    #[test]
    fn assistant_tool_use_becomes_function_call_item() {
        let items = to_wire_items(&Message::assistant(vec![
            ContentBlock::Text {
                text: "checking".into(),
            },
            ContentBlock::ToolUse {
                id: "call_1".into(),
                name: "get_weather".into(),
                input: json!({ "city": "Paris" }),
                signature: None,
            },
        ]));
        assert_eq!(
            items,
            vec![
                json!({
                    "role": "assistant",
                    "content": [{ "type": "output_text", "text": "checking" }],
                }),
                json!({
                    "type": "function_call",
                    "call_id": "call_1",
                    "name": "get_weather",
                    "arguments": "{\"city\":\"Paris\"}",
                }),
            ]
        );
    }

    #[test]
    fn user_tool_results_precede_text() {
        let items = to_wire_items(&Message {
            role: Role::User,
            content: vec![
                ContentBlock::Text {
                    text: "follow-up".into(),
                },
                ContentBlock::ToolResult {
                    tool_use_id: "call_1".into(),
                    name: "get_weather".into(),
                    content: "sunny".into(),
                    is_error: false,
                },
                ContentBlock::ToolResult {
                    tool_use_id: "call_2".into(),
                    name: "get_weather".into(),
                    content: "city not found".into(),
                    is_error: true,
                },
            ],
        });
        assert_eq!(
            items,
            vec![
                json!({
                    "type": "function_call_output",
                    "call_id": "call_1",
                    "output": "sunny",
                }),
                json!({
                    "type": "function_call_output",
                    "call_id": "call_2",
                    "output": "ERROR: city not found",
                }),
                json!({
                    "role": "user",
                    "content": [{ "type": "input_text", "text": "follow-up" }],
                }),
            ]
        );
    }

    #[test]
    fn user_image_becomes_an_input_image_part() {
        let items = to_wire_items(&Message {
            role: Role::User,
            content: vec![
                ContentBlock::Image {
                    media_type: "image/png".into(),
                    data: "iVBORw0KGgo=".into(),
                },
                ContentBlock::Text {
                    text: "what is this?".into(),
                },
            ],
        });
        assert_eq!(
            items,
            vec![json!({
                "role": "user",
                "content": [
                    {
                        "type": "input_image",
                        "image_url": "data:image/png;base64,iVBORw0KGgo=",
                    },
                    { "type": "input_text", "text": "what is this?" },
                ],
            })]
        );
    }

    /// `filename` is required on an `input_file`, not optional, which is one
    /// of the two reasons the canonical block carries a name.
    #[test]
    fn a_pdf_becomes_an_input_file_named_for_its_source() {
        let items = to_wire_items(&Message {
            role: Role::User,
            content: vec![
                ContentBlock::Document {
                    media_type: "application/pdf".into(),
                    name: "contract.pdf".into(),
                    data: "JVBERi0=".into(),
                },
                ContentBlock::Text {
                    text: "summarize".into(),
                },
            ],
        });
        assert_eq!(
            items,
            vec![json!({
                "role": "user",
                "content": [
                    {
                        "type": "input_file",
                        "filename": "contract.pdf",
                        "file_data": "data:application/pdf;base64,JVBERi0=",
                    },
                    { "type": "input_text", "text": "summarize" },
                ],
            })]
        );
    }

    #[test]
    fn assistant_image_is_dropped() {
        let items = to_wire_items(&Message::assistant(vec![
            ContentBlock::Image {
                media_type: "image/png".into(),
                data: "iVBORw0KGgo=".into(),
            },
            ContentBlock::Text {
                text: "it is sunny".into(),
            },
        ]));
        assert_eq!(
            items,
            vec![json!({
                "role": "assistant",
                "content": [{ "type": "output_text", "text": "it is sunny" }],
            })]
        );
    }

    /// A reasoning item is replayed in the position it was recorded in:
    /// after the summary it produced (which never reaches the wire) and
    /// immediately before the call it led to.
    #[test]
    fn reasoning_item_replays_before_the_call_it_led_to() {
        let items = to_wire_items(&Message::assistant(vec![
            ContentBlock::Thinking {
                text: "the user wants weather".into(),
                signature: None,
            },
            ContentBlock::ReasoningRef {
                id: "rs_abc".into(),
            },
            ContentBlock::ToolUse {
                id: "call_1".into(),
                name: "get_weather".into(),
                input: json!({ "city": "Paris" }),
                signature: None,
            },
        ]));
        assert_eq!(
            items,
            vec![
                json!({ "type": "reasoning", "id": "rs_abc", "summary": [] }),
                json!({
                    "type": "function_call",
                    "call_id": "call_1",
                    "name": "get_weather",
                    "arguments": "{\"city\":\"Paris\"}",
                }),
            ]
        );
    }

    /// A reasoning handle points into OpenAI's store rather than at anything
    /// the log holds, and the store forgets. Reopening a session past the
    /// retention window then fails on this turn and on every turn after it,
    /// forever, over reasoning that was never part of the conversation — so
    /// the rejection is recognized and the handles are dropped for one retry.
    #[test]
    fn an_expired_reasoning_handle_is_recognized_and_droppable() {
        let convo = vec![
            Message::user("what is the weather"),
            Message::assistant(vec![
                ContentBlock::ReasoningRef {
                    id: "rs_abc".into(),
                },
                ContentBlock::Text {
                    text: "sunny".into(),
                },
            ]),
            Message::user("and tomorrow"),
        ];
        let req = request(convo, vec![]);
        assert!(replays_reasoning(&req));

        // What OpenAI actually answers with, as an ordinary 400 whose only
        // distinguishing mark is the sentence.
        let stale = ProviderError::Api {
            status: 400,
            message: "Item with id 'rs_abc' not found. Items are not persisted \
                      when `store` is set to false."
                .into(),
        };
        assert!(is_missing_reasoning_item(&stale));

        // The retry sends the same conversation with the handles gone, and
        // nothing else removed — dropping a reasoning item cannot strand the
        // item it preceded, since that rule is only about a *trailing* one.
        let body = OpenAiResponses::body_with(&req, false).unwrap();
        let input = body["input"].as_array().unwrap();
        assert!(
            !input.iter().any(|i| i["type"] == "reasoning"),
            "{input:#?}"
        );
        assert_eq!(
            input.len(),
            3,
            "the conversation itself was cut: {input:#?}"
        );
    }

    #[test]
    fn an_ordinary_bad_request_is_not_retried_as_an_expiry() {
        // The retry has to be narrow. A 400 that is genuinely about the
        // request would otherwise be sent a second time to fail identically,
        // and the user would wait twice for one error.
        for message in [
            "Invalid value for 'max_output_tokens'",
            "model gpt-nonexistent not found",
            "Unsupported parameter: 'reasoning.effort' for this model",
        ] {
            let err = ProviderError::Api {
                status: 400,
                message: message.into(),
            };
            assert!(!is_missing_reasoning_item(&err), "{message}");
        }
        // Nor is a request that replays no handle worth a second attempt.
        assert!(!replays_reasoning(&request(
            vec![Message::user("hi")],
            vec![]
        )));
    }

    #[test]
    fn reasoning_item_precedes_the_message_it_produced() {
        let items = to_wire_items(&Message::assistant(vec![
            ContentBlock::ReasoningRef {
                id: "rs_abc".into(),
            },
            ContentBlock::Text {
                text: "it is sunny".into(),
            },
        ]));
        assert_eq!(
            items,
            vec![
                json!({ "type": "reasoning", "id": "rs_abc", "summary": [] }),
                json!({
                    "role": "assistant",
                    "content": [{ "type": "output_text", "text": "it is sunny" }],
                }),
            ]
        );
    }

    /// An interrupted turn leaves a reasoning item with nothing after it;
    /// the API rejects that, so it is dropped rather than replayed.
    #[test]
    fn dangling_reasoning_item_is_dropped() {
        let items = to_wire_items(&Message::assistant(vec![
            ContentBlock::Text {
                text: "checking".into(),
            },
            ContentBlock::ReasoningRef {
                id: "rs_abc".into(),
            },
        ]));
        assert_eq!(
            items,
            vec![json!({
                "role": "assistant",
                "content": [{ "type": "output_text", "text": "checking" }],
            })]
        );
    }

    // ---- normalize: the streaming half ----

    /// One SSE frame, framed the way the wire frames it.
    fn sse(data: Value) -> String {
        format!("data: {data}\n\n")
    }

    /// Feed a canned body through [`normalize`], in the chunks given, and
    /// collect everything it yields.
    ///
    /// Where the chunks break is part of the input on purpose: a socket
    /// splits wherever it likes, including halfway through a frame, and the
    /// eventsource layer under `normalize` is what has to survive it.
    async fn drain(chunks: &[&str]) -> Vec<Result<StreamEvent, ProviderError>> {
        let body = futures::stream::iter(
            chunks
                .iter()
                .map(|c| Ok::<_, std::io::Error>(c.to_string()))
                .collect::<Vec<_>>(),
        );
        normalize(body).collect::<Vec<_>>().await
    }

    /// The same, for a body expected to stream to a clean end.
    async fn events(chunks: &[&str]) -> Vec<StreamEvent> {
        drain(chunks)
            .await
            .into_iter()
            .collect::<Result<Vec<_>, _>>()
            .expect("the canned body streams to a clean end")
    }

    /// A line per event. `StreamEvent` has no `PartialEq`, and the order
    /// these arrive in is most of what is being pinned here.
    fn shapes(events: &[StreamEvent]) -> Vec<String> {
        events
            .iter()
            .map(|e| match e {
                StreamEvent::Start => "start".to_string(),
                StreamEvent::TextDelta(t) => format!("text {t}"),
                StreamEvent::ThinkingDelta(t) => format!("thinking {t}"),
                StreamEvent::ReasoningRef { id } => format!("reasoning {id}"),
                StreamEvent::ToolUse {
                    id, name, input, ..
                } => format!("tool {id} {name} {input}"),
                StreamEvent::Usage(_) => "usage".to_string(),
                StreamEvent::End { stop_reason } => format!("end {stop_reason:?}"),
                other => format!("{other:?}"),
            })
            .collect()
    }

    fn reported_usage(events: &[StreamEvent]) -> Usage {
        events
            .iter()
            .find_map(|e| match e {
                StreamEvent::Usage(u) => Some(*u),
                _ => None,
            })
            .expect("a usage event")
    }

    /// The reasoning item is the replayable artifact, and Responses rejects
    /// it on the next turn unless it comes back immediately before the item
    /// it produced. Emitting it anywhere but where it fell in the stream —
    /// with the tool calls, or all at the end — records a position the API
    /// will refuse.
    #[tokio::test]
    async fn the_reasoning_ref_lands_between_its_summary_and_the_call_it_led_to() {
        let body = [
            sse(json!({ "type": "response.created" })),
            sse(json!({ "type": "response.reasoning_summary_text.delta", "delta": "weighing " })),
            sse(json!({ "type": "response.reasoning_summary_text.delta", "delta": "options" })),
            sse(json!({
                "type": "response.output_item.done",
                "item": { "type": "reasoning", "id": "rs_abc" },
            })),
            sse(json!({ "type": "response.output_text.delta", "delta": "checking" })),
            sse(json!({
                "type": "response.output_item.done",
                "item": {
                    "type": "function_call",
                    "call_id": "call_1",
                    "name": "get_weather",
                    "arguments": "{\"city\":\"Oslo\"}",
                },
            })),
            sse(json!({
                "type": "response.completed",
                "response": { "status": "completed", "usage": {} },
            })),
        ]
        .concat();
        let seen = events(&[&body]).await;
        assert_eq!(
            shapes(&seen),
            [
                "start",
                "thinking weighing ",
                "thinking options",
                "reasoning rs_abc",
                "text checking",
                "tool call_1 get_weather {\"city\":\"Oslo\"}",
                "usage",
                "end Some(\"completed\")",
            ]
        );
    }

    /// The done item carries the whole call, so the incremental
    /// `function_call_arguments.delta` frames beside it are noise —
    /// stitching those too would emit every call twice.
    #[tokio::test]
    async fn a_tool_call_is_read_whole_off_item_done_not_from_its_argument_deltas() {
        let body = [
            sse(json!({ "type": "response.created" })),
            sse(json!({
                "type": "response.function_call_arguments.delta",
                "item_id": "fc_1",
                "delta": "{\"city\":",
            })),
            sse(json!({
                "type": "response.function_call_arguments.delta",
                "item_id": "fc_1",
                "delta": "\"Oslo\"}",
            })),
            sse(json!({
                "type": "response.function_call_arguments.done",
                "item_id": "fc_1",
                "arguments": "{\"city\":\"Oslo\"}",
            })),
            sse(json!({
                "type": "response.output_item.done",
                "item": {
                    "type": "function_call",
                    "id": "fc_1",
                    "call_id": "call_1",
                    "name": "get_weather",
                    "arguments": "{\"city\":\"Oslo\"}",
                },
            })),
            sse(json!({
                "type": "response.completed",
                "response": { "status": "completed", "usage": {} },
            })),
        ]
        .concat();
        // The wire break lands inside the done item's arguments string.
        let cut = body.rfind("Oslo").expect("the done item");
        let (head, tail) = body.split_at(cut);
        let seen = events(&[head, tail]).await;
        assert_eq!(
            shapes(&seen),
            [
                "start",
                "tool call_1 get_weather {\"city\":\"Oslo\"}",
                "usage",
                "end Some(\"completed\")",
            ]
        );
    }

    /// Reasoning is billed as output and cached input at a discount.
    /// Dropping either reports a cost that is not the one charged, and the
    /// cached count in particular is a subset of the input rather than an
    /// addition to it.
    #[tokio::test]
    async fn completed_usage_carries_the_reasoning_and_cached_counts() {
        let body = sse(json!({
            "type": "response.completed",
            "response": {
                "status": "completed",
                "usage": {
                    "input_tokens": 1200,
                    "output_tokens": 512,
                    "output_tokens_details": { "reasoning_tokens": 448 },
                    "input_tokens_details": { "cached_tokens": 1024 },
                },
            },
        }));
        let seen = events(&[&body]).await;
        assert_eq!(
            reported_usage(&seen),
            Usage {
                input_tokens: 1200,
                output_tokens: 512,
                reasoning_tokens: Some(448),
                cache_read_tokens: Some(1024),
                cache_write_tokens: None,
            }
        );
    }

    /// A response cut off at the token ceiling still closes its stream
    /// properly — as `response.incomplete`, whose status is only ever
    /// "incomplete". The reason sits one level down, and it is what tells a
    /// truncated reply from a finished one.
    #[tokio::test]
    async fn an_incomplete_response_reports_why_it_stopped() {
        let body = [
            sse(json!({ "type": "response.created" })),
            sse(json!({ "type": "response.output_text.delta", "delta": "as far as I" })),
            sse(json!({
                "type": "response.incomplete",
                "response": {
                    "status": "incomplete",
                    "incomplete_details": { "reason": "max_output_tokens" },
                    "usage": { "input_tokens": 12, "output_tokens": 128 },
                },
            })),
        ]
        .concat();
        let seen = events(&[&body]).await;
        assert_eq!(
            shapes(&seen),
            [
                "start",
                "text as far as I",
                "usage",
                "end Some(\"max_output_tokens\")",
            ]
        );
        assert_eq!(reported_usage(&seen).output_tokens, 128);
    }

    /// A failure arrives inside a 200 response, after tokens have already
    /// streamed. Treating it as one more unknown event type ends the turn
    /// quietly and records the fragment as the model's answer.
    #[tokio::test]
    async fn a_failed_response_fails_the_stream() {
        let body = [
            sse(json!({ "type": "response.created" })),
            sse(json!({
                "type": "response.failed",
                "response": { "error": { "message": "the model overloaded" } },
            })),
        ]
        .concat();
        let seen = drain(&[&body]).await;
        let Some(Err(ProviderError::Api { status, message })) = seen.last() else {
            panic!("the failure did not end the stream: {seen:?}");
        };
        assert_eq!(*status, 200);
        assert_eq!(message, "the model overloaded");
    }

    /// The bare `error` frame is the same fact with the message one level
    /// higher up; reading it out of `response.error` finds nothing and
    /// reports an unknown failure instead of the one that happened.
    #[tokio::test]
    async fn a_bare_error_event_fails_the_stream_with_its_own_message() {
        let body = [
            sse(json!({ "type": "response.created" })),
            sse(json!({ "type": "error", "code": "server_error", "message": "upstream timeout" })),
        ]
        .concat();
        let seen = drain(&[&body]).await;
        let Some(Err(ProviderError::Api { message, .. })) = seen.last() else {
            panic!("the error did not end the stream: {seen:?}");
        };
        assert_eq!(message, "upstream timeout");
    }

    /// A dropped connection ends the byte stream in silence, which from
    /// above looks exactly like a model that finished — so a truncated reply
    /// gets recorded as a complete one, with no usage and no stop reason to
    /// give it away.
    #[tokio::test]
    async fn a_stream_that_stops_before_a_terminal_event_is_an_error() {
        let body = [
            sse(json!({ "type": "response.created" })),
            sse(json!({ "type": "response.output_text.delta", "delta": "half an ans" })),
        ]
        .concat();
        let seen = drain(&[&body]).await;
        assert!(
            !seen
                .iter()
                .any(|e| matches!(e, Ok(StreamEvent::End { .. }))),
            "a truncated stream was closed out as a finished one: {seen:?}"
        );
        let Some(Err(ProviderError::Transport(message))) = seen.last() else {
            panic!("the truncated stream ended quietly: {seen:?}");
        };
        assert!(message.contains("incomplete"), "{message}");
    }
}
