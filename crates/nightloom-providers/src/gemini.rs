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

        let stream = try_stream! {
            let mut events = resp.bytes_stream().eventsource();
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
                    usage.input_tokens = u["promptTokenCount"].as_u64().unwrap_or(0);
                    // Normalized convention: output_tokens includes reasoning
                    // (as Anthropic and OpenAI count it); Gemini reports the
                    // two separately.
                    usage.output_tokens = u["candidatesTokenCount"].as_u64().unwrap_or(0)
                        + thoughts.unwrap_or(0);
                    usage.reasoning_tokens = thoughts.or(usage.reasoning_tokens);
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
                                None => format!("call-{call_index}"),
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
            // the chunk carrying finishReason + final usage.
            yield StreamEvent::Usage(usage);
            yield StreamEvent::End { stop_reason };
        };
        Ok(Box::pin(stream))
    }
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
}
