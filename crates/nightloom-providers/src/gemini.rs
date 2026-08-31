use crate::{api_error, parse, transport};
use async_stream::try_stream;
use eventsource_stream::Eventsource;
use futures::StreamExt;
use nightloom_core::{
    ChatRequest, ContentBlock, EventStream, Message, Provider, ProviderError, Role, StreamEvent,
    Thinking, Usage,
};
use serde_json::{Value, json};

pub(crate) const DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com";

/// Native adapter for the Google Generative Language API
/// (`models/{model}:streamGenerateContent?alt=sse`). Thought summaries stream
/// as parts flagged `"thought": true` when `includeThoughts` is set.
pub struct Gemini {
    client: reqwest::Client,
    api_key: String,
    base_url: String,
}

impl Gemini {
    pub fn new(api_key: impl Into<String>, base_url: Option<String>) -> Self {
        Self {
            client: reqwest::Client::new(),
            api_key: api_key.into(),
            base_url: base_url.unwrap_or_else(|| DEFAULT_BASE_URL.to_string()),
        }
    }

    fn body(request: &ChatRequest) -> Value {
        let contents: Vec<Value> = request.messages.iter().map(to_wire_message).collect();
        let mut generation = json!({ "maxOutputTokens": request.max_tokens });
        if let Some(t) = request.temperature {
            generation["temperature"] = json!(t);
        }
        // Gemini 2.5+ models think by default; always ask for the thought
        // summaries so default requests stream thinking too.
        generation["thinkingConfig"] = match &request.thinking {
            Thinking::Default => json!({ "includeThoughts": true }),
            Thinking::Budget(n) => json!({ "thinkingBudget": n, "includeThoughts": true }),
            // Gemini 3 replaces budgets with a discrete level (low|high).
            Thinking::Effort(e) => json!({ "thinkingLevel": e, "includeThoughts": true }),
        };
        let mut body = json!({ "contents": contents, "generationConfig": generation });
        if let Some(system) = request.system.render_flat() {
            body["systemInstruction"] = json!({ "parts": [{ "text": system }] });
        }
        // One tools entry wrapping every declaration; Gemini takes the JSON
        // Schema under `parameters`.
        if !request.tools.is_empty() {
            let declarations: Vec<Value> = request
                .tools
                .iter()
                .map(|t| {
                    json!({
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.input_schema,
                    })
                })
                .collect();
            body["tools"] = json!([{ "functionDeclarations": declarations }]);
        }
        body
    }
}

fn to_wire_message(message: &Message) -> Value {
    let role = match message.role {
        Role::User => "user",
        Role::Assistant => "model",
    };
    // Thought summary parts are dropped: Google only *recommends* replaying
    // the signature that lands on a text-only response, and doing it
    // faithfully would mean signing a canonical Text block. Function calls
    // are the mandatory case and are handled below.
    //
    // Part order is the contract here. Google requires the parts of a
    // response to come back exactly as they arrived, so a parallel-call
    // round trips as `model:[FC1+sig, FC2]` then `user:[FR1, FR2]` — never
    // interleaved call/result pairs. That holds because this maps one
    // canonical message to one `contents` entry and preserves block order,
    // and because the session projection coalesces a round's tool results
    // into one user message in call order. Gemini has no call ids in replay;
    // function name + ordering pairs calls with results.
    // Images ride in the user turn only; a `model` turn carrying inline
    // image data is not something the API accepts back.
    let is_user = message.role == Role::User;
    let parts: Vec<Value> = message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(json!({ "text": text })),
            // Both spellings are accepted; camelCase matches the rest of
            // this body (`functionCall`, `thoughtSignature`).
            ContentBlock::Image { media_type, data } if is_user => Some(json!({
                "inlineData": { "mimeType": media_type, "data": data },
            })),
            // A PDF rides in as an image does — an inline blob typed by its
            // mime. The filename is the one thing this dialect cannot carry:
            // a blob part has no field for it, and inventing one would risk
            // a 400 on the whole request to pass on a label the caption
            // usually repeats anyway.
            ContentBlock::Document {
                media_type, data, ..
            } if is_user => Some(json!({
                "inlineData": { "mimeType": media_type, "data": data },
            })),
            ContentBlock::ToolUse {
                name,
                input,
                signature,
                ..
            } => {
                let mut part = json!({ "functionCall": { "name": name, "args": input } });
                // Gemini 3 hard-fails a replayed call that lost its thought
                // signature ("Function call ... is missing a
                // `thought_signature`"), and the field sits on the *part*,
                // beside `functionCall`, not inside it. Google signs only the
                // first call of a response, so an unsigned sibling stays
                // unsigned — replay what we were handed, nothing more.
                // Gemini 2.5 never signs and never validates, so `None` here
                // reproduces today's body byte for byte.
                if let Some(sig) = signature {
                    part["thoughtSignature"] = json!(sig);
                }
                Some(part)
            }
            ContentBlock::ToolResult {
                name,
                content,
                is_error,
                ..
            } => {
                let response = if *is_error {
                    json!({ "error": content })
                } else {
                    json!({ "result": content })
                };
                Some(json!({ "functionResponse": { "name": name, "response": response } }))
            }
            _ => None,
        })
        .collect();
    json!({ "role": role, "parts": parts })
}

#[async_trait::async_trait]
impl Provider for Gemini {
    fn name(&self) -> &'static str {
        "gemini"
    }

    async fn stream_chat(&self, request: ChatRequest) -> Result<EventStream, ProviderError> {
        if self.api_key.is_empty() {
            return Err(ProviderError::Config(
                "missing Gemini API key (set GEMINI_API_KEY)".into(),
            ));
        }
        let resp = self
            .client
            .post(format!(
                "{}/v1beta/models/{}:streamGenerateContent?alt=sse",
                self.base_url, request.model
            ))
            .header("x-goog-api-key", &self.api_key)
            .json(&Self::body(&request))
            .send()
            .await
            .map_err(transport)?;
        if !resp.status().is_success() {
            return Err(api_error(resp).await);
        }
        Ok(normalize(resp.bytes_stream()))
    }
}

/// Turn Gemini's SSE body into `StreamEvent`s.
///
/// Split from the request half so a canned body can reach the parts that are
/// particular to this dialect: thought parts flagged rather than typed, a
/// signature that rides on the *part* and may arrive on one carrying nothing
/// else, ids synthesized for calls that have none, and usage arithmetic that
/// has to be re-normalized on the way through.
pub(crate) fn normalize<S, B, E>(body: S) -> EventStream
where
    S: futures::Stream<Item = Result<B, E>> + Send + 'static,
    B: AsRef<[u8]> + Send + 'static,
    E: std::error::Error + Send + Sync + 'static,
{
    Box::pin(try_stream! {
            let mut events = Box::pin(body).eventsource();
            let mut usage = Usage::default();
            let mut stop_reason: Option<String> = None;
            let mut started = false;
            // Gemini functionCall parts don't always carry an id; canonical
            // ToolUse needs one, so synthesize call-N in stream order.
            let mut call_index = 0u32;
            // A thought signature seen on a part that isn't a function call.
            // Streaming can deliver one on a part with *empty text* just
            // before the finish reason, so parts are never skipped for being
            // textless. On a text-only response this is the optional,
            // never-validated signature and we let it go; on a response
            // whose first call somehow arrived unsigned it is that call's.
            let mut pending_signature: Option<String> = None;

            while let Some(event) = events.next().await {
                let event = event.map_err(transport)?;
                if event.data.is_empty() {
                    continue;
                }
                let v: Value = serde_json::from_str(&event.data).map_err(parse)?;
                if let Some(err) = v.get("error") {
                    Err(ProviderError::Api {
                        status: err["code"].as_u64().unwrap_or(200) as u16,
                        message: err["message"]
                            .as_str()
                            .unwrap_or("unknown mid-stream error")
                            .to_string(),
                    })?;
                }
                if !started {
                    started = true;
                    yield StreamEvent::Start;
                }
                // usageMetadata grows across chunks; the last one is complete.
                if let Some(u) = v.get("usageMetadata") {
                    let thoughts = u["thoughtsTokenCount"].as_u64();
                    // Each field falls back to what a previous chunk reported
                    // rather than to zero. A late chunk that carries only some
                    // of them — a `usageMetadata` announcing the thought count
                    // alone, say — would otherwise overwrite the prompt count
                    // with 0 and leave the session's totals reading low, which
                    // is the one direction a cost figure must never be wrong
                    // in.
                    usage.input_tokens = u["promptTokenCount"]
                        .as_u64()
                        .unwrap_or(usage.input_tokens);
                    // Normalized convention: output_tokens includes reasoning
                    // (as Anthropic and OpenAI count it); Gemini reports the
                    // two separately. The carry-forward has to reach the
                    // thought count *here* and not only in `reasoning_tokens`
                    // below: a later chunk repeating the candidate count
                    // without repeating the thought count would otherwise
                    // recompute the sum with zero reasoning, leaving a `Usage`
                    // that contradicts itself — reasoning_tokens larger than
                    // the output_tokens supposedly containing them.
                    let thoughts = thoughts.or(usage.reasoning_tokens);
                    if let Some(candidates) = u["candidatesTokenCount"].as_u64() {
                        usage.output_tokens = candidates + thoughts.unwrap_or(0);
                    }
                    usage.reasoning_tokens = thoughts;
                    // Already counted inside promptTokenCount; implicit
                    // caching reports it, explicit cached content too.
                    usage.cache_read_tokens = u["cachedContentTokenCount"]
                        .as_u64()
                        .or(usage.cache_read_tokens);
                }
                let Some(candidate) = v["candidates"].get(0) else {
                    continue;
                };
                if let Some(reason) = candidate["finishReason"].as_str() {
                    stop_reason = Some(reason.to_string());
                }
                if let Some(parts) = candidate["content"]["parts"].as_array() {
                    for part in parts {
                        // Read the signature before anything else: it rides
                        // on the part, not inside functionCall, and a part
                        // carrying one may have no text and no call at all.
                        let signature = part["thoughtSignature"]
                            .as_str()
                            .map(str::to_string);
                        if let Some(text) = part["text"].as_str()
                            && !text.is_empty()
                        {
                            if part["thought"].as_bool().unwrap_or(false) {
                                yield StreamEvent::ThinkingDelta(text.to_string());
                            } else {
                                yield StreamEvent::TextDelta(text.to_string());
                            }
                        }
                        // functionCall parts arrive complete — no argument
                        // deltas to buffer.
                        if let Some(call) = part.get("functionCall") {
                            let id = match call["id"].as_str() {
                                Some(id) => id.to_string(),
                                None => crate::synthetic_call_id(),
                            };
                            // Only the first call of a response is signed;
                            // parallel siblings must stay unsigned, so the
                            // stray-signature fallback applies to the first
                            // call and no other.
                            let signature = signature.or_else(|| {
                                if call_index == 0 {
                                    pending_signature.take()
                                } else {
                                    None
                                }
                            });
                            call_index += 1;
                            yield StreamEvent::ToolUse {
                                id,
                                name: call["name"].as_str().unwrap_or_default().to_string(),
                                input: call.get("args").cloned().unwrap_or_else(|| json!({})),
                                signature,
                            };
                        } else if signature.is_some() {
                            pending_signature = signature;
                        }
                    }
                }
            }
            // No terminator event; the server just closes the stream after
            // the chunk carrying finishReason + final usage. So the finish
            // reason is the only evidence the close was the end of a response
            // rather than a connection dropping partway through one — and
            // ending quietly on the second would hand the engine a fragment
            // that looks exactly like a finished turn.
            if stop_reason.is_none() {
                Err(crate::truncated("gemini"))?;
            }
            yield StreamEvent::Usage(usage);
            yield StreamEvent::End { stop_reason };
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use nightloom_core::{SystemPrompt, ToolDef};

    fn request(messages: Vec<Message>, tools: Vec<ToolDef>) -> ChatRequest {
        ChatRequest {
            model: "gemini-test".into(),
            system: SystemPrompt::default(),
            messages,
            max_tokens: 64,
            temperature: None,
            thinking: Thinking::Default,
            tools,
        }
    }

    #[test]
    fn tools_map_to_function_declarations() {
        let schema = json!({ "type": "object", "properties": { "city": { "type": "string" } } });
        let body = Gemini::body(&request(
            vec![Message::user("hi")],
            vec![ToolDef {
                name: "get_weather".into(),
                description: "Look up weather".into(),
                input_schema: schema.clone(),
            }],
        ));
        assert_eq!(
            body["tools"],
            json!([{ "functionDeclarations": [{
                "name": "get_weather",
                "description": "Look up weather",
                "parameters": schema,
            }] }])
        );
    }

    #[test]
    fn empty_tools_omit_the_field() {
        let body = Gemini::body(&request(vec![Message::user("hi")], vec![]));
        assert!(body.get("tools").is_none());
    }

    /// A Gemini 2.5-shaped call: nothing signed anything, so the body must
    /// come out exactly as it did before signatures existed.
    #[test]
    fn tool_use_replays_as_function_call() {
        let wire = to_wire_message(&Message::assistant(vec![ContentBlock::ToolUse {
            id: "call-0".into(),
            name: "get_weather".into(),
            input: json!({ "city": "Oslo" }),
            signature: None,
        }]));
        assert_eq!(
            wire,
            json!({ "role": "model", "parts": [
                { "functionCall": { "name": "get_weather", "args": { "city": "Oslo" } } }
            ]})
        );
    }

    /// The Gemini 3 requirement: the signature the stream handed us has to
    /// reappear on the part, beside `functionCall`, in the replayed body.
    #[test]
    fn signature_survives_into_the_replayed_body() {
        let body = Gemini::body(&request(
            vec![
                Message::user("weather in Oslo?"),
                Message::assistant(vec![ContentBlock::ToolUse {
                    id: "call-0".into(),
                    name: "get_weather".into(),
                    input: json!({ "city": "Oslo" }),
                    signature: Some("sig-A".into()),
                }]),
                Message {
                    role: Role::User,
                    content: vec![ContentBlock::ToolResult {
                        tool_use_id: "call-0".into(),
                        name: "get_weather".into(),
                        content: "12C".into(),
                        is_error: false,
                    }],
                },
            ],
            vec![],
        ));
        assert_eq!(
            body["contents"][1],
            json!({ "role": "model", "parts": [{
                "functionCall": { "name": "get_weather", "args": { "city": "Oslo" } },
                "thoughtSignature": "sig-A",
            }]})
        );
    }

    /// Parallel calls: Google signs only the first part, and every part must
    /// come back in position — all calls in the model turn, all results in
    /// the user turn, never interleaved as call/result pairs.
    #[test]
    fn parallel_calls_sign_only_the_first_part_and_keep_order() {
        let body = Gemini::body(&request(
            vec![
                Message::user("weather in Oslo and Paris?"),
                Message::assistant(vec![
                    ContentBlock::ToolUse {
                        id: "call-0".into(),
                        name: "get_weather".into(),
                        input: json!({ "city": "Oslo" }),
                        signature: Some("sig-A".into()),
                    },
                    ContentBlock::ToolUse {
                        id: "call-1".into(),
                        name: "get_weather".into(),
                        input: json!({ "city": "Paris" }),
                        signature: None,
                    },
                ]),
                Message {
                    role: Role::User,
                    content: vec![
                        ContentBlock::ToolResult {
                            tool_use_id: "call-0".into(),
                            name: "get_weather".into(),
                            content: "12C".into(),
                            is_error: false,
                        },
                        ContentBlock::ToolResult {
                            tool_use_id: "call-1".into(),
                            name: "get_weather".into(),
                            content: "19C".into(),
                            is_error: false,
                        },
                    ],
                },
            ],
            vec![],
        ));
        let model = &body["contents"][1];
        assert_eq!(model["parts"][0]["thoughtSignature"], json!("sig-A"));
        assert_eq!(model["parts"][0]["functionCall"]["args"]["city"], "Oslo");
        // The sibling stays unsigned — inventing a signature for it would
        // not match what the model produced.
        assert!(model["parts"][1].get("thoughtSignature").is_none());
        assert_eq!(model["parts"][1]["functionCall"]["args"]["city"], "Paris");
        assert_eq!(model["parts"].as_array().unwrap().len(), 2);
        // Results follow as their own turn, in call order.
        let results = &body["contents"][2];
        assert_eq!(results["role"], "user");
        assert_eq!(
            results["parts"][0]["functionResponse"]["response"]["result"],
            "12C"
        );
        assert_eq!(
            results["parts"][1]["functionResponse"]["response"]["result"],
            "19C"
        );
    }

    /// Thinking blocks still never reach the wire, signed or not.
    #[test]
    fn thinking_blocks_are_still_dropped_on_replay() {
        let wire = to_wire_message(&Message::assistant(vec![
            ContentBlock::Thinking {
                text: "hmm".into(),
                signature: Some("sig-A".into()),
            },
            ContentBlock::Text {
                text: "hello".into(),
            },
        ]));
        assert_eq!(
            wire,
            json!({ "role": "model", "parts": [{ "text": "hello" }] })
        );
    }

    #[test]
    fn user_image_becomes_an_inline_data_part() {
        let wire = to_wire_message(&Message {
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
            wire,
            json!({ "role": "user", "parts": [
                { "inlineData": { "mimeType": "image/png", "data": "iVBORw0KGgo=" } },
                { "text": "what is this?" },
            ]})
        );
    }

    /// A blob part is typed by its mime and nothing else, so a PDF takes the
    /// same shape an image does — and the filename has nowhere to go.
    #[test]
    fn a_pdf_rides_in_as_inline_data_without_its_name() {
        let wire = to_wire_message(&Message {
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
            wire,
            json!({ "role": "user", "parts": [
                { "inlineData": { "mimeType": "application/pdf", "data": "JVBERi0=" } },
                { "text": "summarize" },
            ]})
        );
    }

    #[test]
    fn assistant_image_is_dropped_on_replay() {
        let wire = to_wire_message(&Message::assistant(vec![
            ContentBlock::Image {
                media_type: "image/png".into(),
                data: "iVBORw0KGgo=".into(),
            },
            ContentBlock::Text {
                text: "hello".into(),
            },
        ]));
        assert_eq!(
            wire,
            json!({ "role": "model", "parts": [{ "text": "hello" }] })
        );
    }

    #[test]
    fn tool_result_replays_as_function_response() {
        let wire = to_wire_message(&Message {
            role: Role::User,
            content: vec![ContentBlock::ToolResult {
                tool_use_id: "call-0".into(),
                name: "get_weather".into(),
                content: "12C, clear".into(),
                is_error: false,
            }],
        });
        assert_eq!(
            wire,
            json!({ "role": "user", "parts": [
                { "functionResponse": {
                    "name": "get_weather",
                    "response": { "result": "12C, clear" },
                } }
            ]})
        );
    }

    #[test]
    fn errored_tool_result_uses_error_shape() {
        let wire = to_wire_message(&Message {
            role: Role::User,
            content: vec![ContentBlock::ToolResult {
                tool_use_id: "call-0".into(),
                name: "get_weather".into(),
                content: "city not found".into(),
                is_error: true,
            }],
        });
        assert_eq!(
            wire["parts"][0]["functionResponse"]["response"],
            json!({ "error": "city not found" })
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
    /// these arrive in is half of what is being pinned. Calls are described
    /// by name and signature rather than by id — the id is synthesized and
    /// deliberately not stable across runs.
    fn shapes(events: &[StreamEvent]) -> Vec<String> {
        events
            .iter()
            .map(|e| match e {
                StreamEvent::Start => "start".to_string(),
                StreamEvent::TextDelta(t) => format!("text {t}"),
                StreamEvent::ThinkingDelta(t) => format!("thinking {t}"),
                StreamEvent::ToolUse {
                    name,
                    input,
                    signature,
                    ..
                } => format!("tool {name} {input} sig={signature:?}"),
                StreamEvent::Usage(_) => "usage".to_string(),
                StreamEvent::End { stop_reason } => format!("end {stop_reason:?}"),
                other => format!("{other:?}"),
            })
            .collect()
    }

    fn call_ids(events: &[StreamEvent]) -> Vec<&str> {
        events
            .iter()
            .filter_map(|e| match e {
                StreamEvent::ToolUse { id, .. } => Some(id.as_str()),
                _ => None,
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

    /// Gemini flags a thought part rather than typing it, so the model's
    /// reasoning is told from its answer by one boolean sitting beside the
    /// text. Missing it renders the reasoning as the reply.
    #[tokio::test]
    async fn thought_parts_become_thinking_and_plain_parts_become_text() {
        let body = [
            sse(json!({ "candidates": [{ "content": { "parts": [
                { "text": "weighing the options", "thought": true },
            ] } }] })),
            sse(json!({ "candidates": [{ "content": { "parts": [
                { "text": "it is " },
                { "text": "12C" },
            ] } }] })),
            sse(json!({
                "candidates": [{ "content": { "parts": [] }, "finishReason": "STOP" }],
                "usageMetadata": { "promptTokenCount": 12, "candidatesTokenCount": 5 },
            })),
        ]
        .concat();
        // The wire break lands inside the answer's first part.
        let cut = body.find("it is ").expect("the answer");
        let (head, tail) = body.split_at(cut);
        let seen = events(&[head, tail]).await;
        assert_eq!(
            shapes(&seen),
            [
                "start",
                "thinking weighing the options",
                "text it is ",
                "text 12C",
                "usage",
                "end Some(\"STOP\")",
            ]
        );
    }

    /// The signature rides on the *part*, not inside `functionCall`, and
    /// streaming delivers one on a part with empty text just before the
    /// finish reason. Skipping textless parts loses it and Gemini 3 refuses
    /// the replay; handing it to every call in the chunk signs a sibling
    /// Google never signed, which it refuses just as hard.
    #[tokio::test]
    async fn a_signature_on_a_textless_part_attaches_to_the_first_call_only() {
        let body = [
            sse(json!({ "candidates": [{ "content": { "parts": [
                { "text": "", "thoughtSignature": "sig-A" },
            ] } }] })),
            sse(json!({
                "candidates": [{
                    "content": { "parts": [
                        { "functionCall": { "name": "get_weather", "args": { "city": "Oslo" } } },
                        { "functionCall": { "name": "get_weather", "args": { "city": "Paris" } } },
                    ] },
                    "finishReason": "STOP",
                }],
                "usageMetadata": { "promptTokenCount": 40, "candidatesTokenCount": 12 },
            })),
        ]
        .concat();
        let seen = events(&[&body]).await;
        assert_eq!(
            shapes(&seen),
            [
                "start",
                "tool get_weather {\"city\":\"Oslo\"} sig=Some(\"sig-A\")",
                "tool get_weather {\"city\":\"Paris\"} sig=None",
                "usage",
                "end Some(\"STOP\")",
            ]
        );
    }

    /// Gemini usually omits call ids, and canonical `ToolUse` needs one. Two
    /// calls sharing an id collide in the session log and in the approval
    /// table, which keys the prompt a user is answering by exactly that id.
    #[tokio::test]
    async fn parallel_calls_without_ids_get_distinct_synthesized_ones() {
        let body = sse(json!({
            "candidates": [{
                "content": { "parts": [
                    { "functionCall": { "name": "read", "args": { "path": "a" } } },
                    { "functionCall": { "name": "read", "args": { "path": "b" } } },
                    // A host that does supply one keeps it: the synthesized
                    // id is a fallback, not a rewrite.
                    { "functionCall": { "id": "fc_9", "name": "read", "args": { "path": "c" } } },
                ] },
                "finishReason": "STOP",
            }],
            "usageMetadata": { "promptTokenCount": 40, "candidatesTokenCount": 12 },
        }));
        let seen = events(&[&body]).await;
        let ids = call_ids(&seen);
        assert_eq!(ids.len(), 3, "{seen:?}");
        assert_eq!(ids[2], "fc_9");
        assert!(ids.iter().all(|id| !id.is_empty()), "{ids:?}");
        assert_ne!(ids[0], ids[1], "two calls answered to one id");
    }

    /// Gemini reports thought tokens beside the candidate count rather than
    /// inside it. Passing the candidate count through undercounts the output
    /// of every reasoning turn, and the bill computed from it.
    #[tokio::test]
    async fn output_tokens_fold_in_the_thought_tokens() {
        let body = sse(json!({
            "candidates": [{ "content": { "parts": [{ "text": "hi" }] }, "finishReason": "STOP" }],
            "usageMetadata": {
                "promptTokenCount": 1200,
                "candidatesTokenCount": 30,
                "thoughtsTokenCount": 480,
                "cachedContentTokenCount": 900,
            },
        }));
        let seen = events(&[&body]).await;
        assert_eq!(
            reported_usage(&seen),
            Usage {
                input_tokens: 1200,
                output_tokens: 510,
                reasoning_tokens: Some(480),
                cache_read_tokens: Some(900),
                cache_write_tokens: None,
            }
        );
    }

    /// `usageMetadata` grows across chunks, but a late one need not repeat
    /// what an earlier one said. Reading each field at face value lets a
    /// chunk carrying only the thought count overwrite the prompt count with
    /// zero, leaving the session's totals reading low — the one direction a
    /// cost figure must not be wrong in.
    #[tokio::test]
    async fn a_later_partial_usage_chunk_does_not_zero_what_was_already_reported() {
        let body = [
            sse(json!({
                "candidates": [{ "content": { "parts": [{ "text": "hi" }] } }],
                "usageMetadata": {
                    "promptTokenCount": 1200,
                    "candidatesTokenCount": 30,
                    "cachedContentTokenCount": 900,
                },
            })),
            sse(json!({
                "candidates": [{ "content": { "parts": [] }, "finishReason": "STOP" }],
                "usageMetadata": { "thoughtsTokenCount": 480 },
            })),
        ]
        .concat();
        let seen = events(&[&body]).await;
        let usage = reported_usage(&seen);
        assert_eq!(usage.input_tokens, 1200, "the prompt count was overwritten");
        assert_eq!(usage.cache_read_tokens, Some(900));
        assert_eq!(usage.reasoning_tokens, Some(480));
    }

    /// The mirror of the case above, and the one the carry-forward originally
    /// missed: a later chunk that repeats the candidate count without
    /// repeating the thought count. `output_tokens` is recomputed from the
    /// two, so a thought count that fell back to zero there took reasoning out
    /// of the total while `reasoning_tokens` kept it — a `Usage` contradicting
    /// itself, with more reasoning in it than output supposedly containing the
    /// reasoning.
    #[tokio::test]
    async fn a_repeated_candidate_count_does_not_drop_reasoning_out_of_the_total() {
        let body = [
            sse(json!({
                "candidates": [{ "content": { "parts": [{ "text": "hi" }] } }],
                "usageMetadata": {
                    "promptTokenCount": 1200,
                    "candidatesTokenCount": 30,
                    "thoughtsTokenCount": 480,
                },
            })),
            sse(json!({
                "candidates": [{ "content": { "parts": [] }, "finishReason": "STOP" }],
                "usageMetadata": { "promptTokenCount": 1200, "candidatesTokenCount": 30 },
            })),
        ]
        .concat();
        let usage = reported_usage(&events(&[&body]).await);
        assert_eq!(usage.reasoning_tokens, Some(480));
        assert_eq!(
            usage.output_tokens, 510,
            "reasoning fell out of the output total"
        );
        assert!(
            usage.output_tokens >= usage.reasoning_tokens.unwrap_or(0),
            "output_tokens must contain the reasoning it is counted with"
        );
    }

    /// Gemini sends no terminator — the server just closes after the chunk
    /// carrying the finish reason. That reason is therefore the only
    /// evidence the close was an ending rather than a dropped connection,
    /// and ending quietly on the second hands the engine a fragment wearing
    /// the shape of a finished turn.
    #[tokio::test]
    async fn a_stream_that_closes_without_a_finish_reason_is_an_error() {
        let body = sse(json!({
            "candidates": [{ "content": { "parts": [{ "text": "half an ans" }] } }],
            "usageMetadata": { "promptTokenCount": 12 },
        }));
        let seen = drain(&[&body]).await;
        assert!(
            !seen
                .iter()
                .any(|e| matches!(e, Ok(StreamEvent::End { .. }) | Ok(StreamEvent::Usage(_)))),
            "a truncated stream was closed out as a finished one: {seen:?}"
        );
        let Some(Err(ProviderError::Transport(message))) = seen.last() else {
            panic!("the truncated stream ended quietly: {seen:?}");
        };
        assert!(message.contains("incomplete"), "{message}");
    }
}
