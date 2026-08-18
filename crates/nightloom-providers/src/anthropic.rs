use crate::{api_error, parse, transport};
use async_stream::try_stream;
use eventsource_stream::Eventsource;
use futures::StreamExt;
use nightloom_core::{
    ChatRequest, ContentBlock, EventStream, Message, Provider, ProviderError, Role, StreamEvent,
    Thinking, Usage,
};
use serde_json::{Value, json};
use std::collections::HashMap;

pub(crate) const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
pub(crate) const API_VERSION: &str = "2023-06-01";

pub struct Anthropic {
    client: reqwest::Client,
    api_key: String,
    base_url: String,
}

impl Anthropic {
    pub fn new(api_key: impl Into<String>, base_url: Option<String>) -> Self {
        Self {
            client: reqwest::Client::new(),
            api_key: api_key.into(),
            base_url: base_url.unwrap_or_else(|| DEFAULT_BASE_URL.to_string()),
        }
    }

    fn body(request: &ChatRequest) -> Result<Value, ProviderError> {
        let mut messages: Vec<Value> = request.messages.iter().map(to_wire_message).collect();
        mark_conversation_prefix(&mut messages);
        let mut body = json!({
            "model": request.model,
            "max_tokens": request.max_tokens,
            "stream": true,
            "messages": messages,
        });
        // `system` goes out as an array of text blocks rather than a plain
        // string: block boundaries are the only place Anthropic accepts a
        // cache breakpoint, so one block per segment is what makes
        // `cache_anchor` expressible at all. Four is the per-request limit.
        if !request.system.is_empty() {
            let anchors = request.system.cache_anchors(SYSTEM_ANCHOR_BUDGET);
            let blocks: Vec<Value> = request
                .system
                .segments()
                .iter()
                .enumerate()
                .map(|(i, s)| {
                    let mut block = json!({ "type": "text", "text": s.text });
                    if anchors.contains(&i) {
                        block["cache_control"] = json!({ "type": "ephemeral" });
                    }
                    block
                })
                .collect();
            body["system"] = json!(blocks);
        }
        if !request.tools.is_empty() {
            let tools: Vec<Value> = request
                .tools
                .iter()
                .map(|t| {
                    json!({
                        "name": t.name,
                        "description": t.description,
                        "input_schema": t.input_schema,
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
            Thinking::Budget(n) => {
                if *n >= request.max_tokens {
                    return Err(ProviderError::Config(format!(
                        "thinking budget ({n}) must be below max_tokens ({})",
                        request.max_tokens
                    )));
                }
                body["thinking"] = json!({ "type": "enabled", "budget_tokens": n });
            }
            // Claude 5 family: budget-style thinking is rejected; these
            // models take adaptive thinking plus an output effort level.
            //
            // `display` is sent explicitly because its default is
            // `"omitted"` on these models, and omitted means the server
            // skips streaming thinking tokens entirely — you get one
            // thinking block holding a real signature and no text.
            // Measured on claude-sonnet-5 with a prompt hard enough to
            // force reasoning: adaptive alone streamed a single empty
            // thinking_delta, adaptive + summarized streamed sixteen. A
            // shell that asked for thinking and rendered nothing would
            // look broken, so asking for it is the honest default; the
            // cost is the summary's output tokens.
            Thinking::Effort(e) => {
                body["thinking"] = json!({ "type": "adaptive", "display": "summarized" });
                body["output_config"] = json!({ "effort": e });
            }
        }
        Ok(body)
    }
}

/// Breakpoints available to the system prompt, out of Anthropic's four per
/// request. The fourth is reserved for [`mark_conversation_prefix`]; a fifth
/// breakpoint is a 400, so the reservation has to come out of this budget
/// rather than be added on top of it.
const SYSTEM_ANCHOR_BUDGET: usize = 3;

/// Put a rolling cache breakpoint at the end of the conversation *minus its
/// last message*.
///
/// Without this the only cacheable prefix is the system prompt, and a preamble
/// under Anthropic's 1024-token minimum is silently ignored — measured on this
/// harness, a four-turn session reported `cache_read_input_tokens: 0` on every
/// turn while the prompt grew from 299 to 369 tokens. The cache-boundary
/// design the preamble and sidecar are split along was protecting a cache that
/// never existed.
///
/// The last message is deliberately left outside. On round one of a turn it
/// carries the sidecar, whose clock changes every turn: inside the breakpoint
/// it would move the cached bytes each time and turn every read into a miss.
/// Everything up to the previous message is byte-stable by construction, so
/// each turn reads back the whole prior conversation and writes only the
/// delta.
fn mark_conversation_prefix(messages: &mut [Value]) {
    let Some(i) = messages.len().checked_sub(2) else {
        return;
    };
    // The breakpoint attaches to a content *block*, so it marks the last
    // block of that message rather than the message itself.
    if let Some(last) = messages[i]["content"]
        .as_array_mut()
        .and_then(|blocks| blocks.last_mut())
    {
        last["cache_control"] = json!({ "type": "ephemeral" });
    }
}

fn to_wire_message(message: &Message) -> Value {
    let role = match message.role {
        Role::User => "user",
        Role::Assistant => "assistant",
    };
    // Images are user input only — no model emits one, and an `image` block
    // in an assistant turn is a 400 rather than something the API ignores.
    let is_user = message.role == Role::User;
    // Signed thinking and redacted_thinking blocks are replayed verbatim;
    // unsigned thinking is filtered out below.
    let content: Vec<Value> = message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(json!({ "type": "text", "text": text })),
            ContentBlock::Image { media_type, data } if is_user => Some(json!({
                "type": "image",
                "source": { "type": "base64", "media_type": media_type, "data": data },
            })),
            ContentBlock::Thinking {
                text,
                signature: Some(sig),
            } => Some(json!({
                "type": "thinking", "thinking": text, "signature": sig,
            })),
            // Anthropic rejects thinking blocks without a valid signature.
            ContentBlock::Thinking {
                signature: None, ..
            } => None,
            ContentBlock::RedactedThinking { data } => Some(json!({
                "type": "redacted_thinking", "data": data,
            })),
            // The replay token (Gemini's) means nothing here; Anthropic
            // signs thinking blocks, not calls.
            ContentBlock::ToolUse {
                id, name, input, ..
            } => Some(json!({
                "type": "tool_use", "id": id, "name": name, "input": input,
            })),
            // The canonical block's `name` is for Gemini's benefit;
            // Anthropic addresses results by call id only.
            ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
                ..
            } => {
                let mut result = json!({
                    "type": "tool_result", "tool_use_id": tool_use_id, "content": content,
                });
                if *is_error {
                    result["is_error"] = json!(true);
                }
                Some(result)
            }
            _ => None,
        })
        .collect();
    json!({ "role": role, "content": content })
}

/// Read the prompt side of `message_start.message.usage`.
///
/// Anthropic's `input_tokens` counts only the tokens that missed the cache
/// entirely: the read and write counters sit *beside* it, not inside it.
/// [`Usage`] is normalized the other way — inclusive, the way OpenAI and
/// Gemini report it — so the three have to be summed. Skipping this makes the
/// context gauge read near-empty on exactly the turns where the cache is
/// working, which is the reverse of the truth.
fn read_input_usage(u: &Value, usage: &mut Usage) {
    let read = u["cache_read_input_tokens"].as_u64();
    let write = u["cache_creation_input_tokens"].as_u64();
    usage.input_tokens =
        u["input_tokens"].as_u64().unwrap_or(0) + read.unwrap_or(0) + write.unwrap_or(0);
    usage.cache_read_tokens = read;
    usage.cache_write_tokens = write;
}

#[async_trait::async_trait]
impl Provider for Anthropic {
    fn name(&self) -> &'static str {
        "anthropic"
    }

    async fn stream_chat(&self, request: ChatRequest) -> Result<EventStream, ProviderError> {
        if self.api_key.is_empty() {
            return Err(ProviderError::Config(
                "missing Anthropic API key (set ANTHROPIC_API_KEY)".into(),
            ));
        }
        let resp = self
            .client
            .post(format!("{}/v1/messages", self.base_url))
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", API_VERSION)
            .json(&Self::body(&request)?)
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
            // Tool-call arguments stream as partial JSON keyed by block
            // index; buffer per index and emit one event at block stop.
            let mut tool_blocks: HashMap<u64, (String, String, String)> = HashMap::new();
            // Thinking signatures also stream as fragments keyed by block
            // index; buffer and emit one event at block stop.
            let mut thinking_sigs: HashMap<u64, String> = HashMap::new();

            while let Some(event) = events.next().await {
                let event = event.map_err(transport)?;
                if event.data.is_empty() {
                    continue;
                }
                let v: Value = serde_json::from_str(&event.data).map_err(parse)?;
                match v["type"].as_str().unwrap_or_default() {
                    "message_start" => {
                        read_input_usage(&v["message"]["usage"], &mut usage);
                        yield StreamEvent::Start;
                    }
                    "content_block_start" => {
                        match v["content_block"]["type"].as_str().unwrap_or_default() {
                            "tool_use" => {
                                if let Some(index) = v["index"].as_u64() {
                                    let id = v["content_block"]["id"]
                                        .as_str()
                                        .unwrap_or_default()
                                        .to_string();
                                    let name = v["content_block"]["name"]
                                        .as_str()
                                        .unwrap_or_default()
                                        .to_string();
                                    tool_blocks.insert(index, (id, name, String::new()));
                                }
                            }
                            "thinking" => {
                                if let Some(index) = v["index"].as_u64() {
                                    thinking_sigs.insert(index, String::new());
                                }
                            }
                            // Redacted blocks arrive whole, with no deltas.
                            "redacted_thinking" => {
                                if let Some(data) = v["content_block"]["data"].as_str() {
                                    yield StreamEvent::RedactedThinking {
                                        data: data.to_string(),
                                    };
                                }
                            }
                            _ => {}
                        }
                    }
                    "content_block_stop" => {
                        if let Some(index) = v["index"].as_u64()
                            && let Some((id, name, buf)) = tool_blocks.remove(&index)
                        {
                            // No deltas at all means a no-argument call.
                            let input = if buf.is_empty() {
                                json!({})
                            } else {
                                serde_json::from_str(&buf).map_err(parse)?
                            };
                            yield StreamEvent::ToolUse { id, name, input, signature: None };
                        }
                        if let Some(index) = v["index"].as_u64()
                            && let Some(buf) = thinking_sigs.remove(&index)
                            && !buf.is_empty()
                        {
                            yield StreamEvent::ThinkingSignature(buf);
                        }
                    }
                    "content_block_delta" => {
                        let delta = &v["delta"];
                        match delta["type"].as_str().unwrap_or_default() {
                            // Empty deltas carry no information (adaptive
                            // models emit one at thinking-block start) and
                            // would skew delta counts and TTFT measurement.
                            "text_delta" => {
                                if let Some(text) = delta["text"].as_str()
                                    && !text.is_empty()
                                {
                                    yield StreamEvent::TextDelta(text.to_string());
                                }
                            }
                            "thinking_delta" => {
                                if let Some(text) = delta["thinking"].as_str()
                                    && !text.is_empty()
                                {
                                    yield StreamEvent::ThinkingDelta(text.to_string());
                                }
                            }
                            "signature_delta" => {
                                if let Some(index) = v["index"].as_u64()
                                    && let Some(buf) = thinking_sigs.get_mut(&index)
                                    && let Some(sig) = delta["signature"].as_str()
                                {
                                    buf.push_str(sig);
                                }
                            }
                            "input_json_delta" => {
                                if let Some(index) = v["index"].as_u64()
                                    && let Some((_, _, buf)) = tool_blocks.get_mut(&index)
                                    && let Some(partial) = delta["partial_json"].as_str()
                                {
                                    buf.push_str(partial);
                                }
                            }
                            _ => {}
                        }
                    }
                    "message_delta" => {
                        if let Some(reason) = v["delta"]["stop_reason"].as_str() {
                            stop_reason = Some(reason.to_string());
                        }
                        if let Some(out) = v["usage"]["output_tokens"].as_u64() {
                            usage.output_tokens = out;
                        }
                    }
                    "message_stop" => {
                        yield StreamEvent::Usage(usage);
                        yield StreamEvent::End { stop_reason: stop_reason.clone() };
                        break;
                    }
                    "error" => {
                        Err(ProviderError::Api {
                            status: 200,
                            message: v["error"]["message"]
                                .as_str()
                                .unwrap_or("unknown mid-stream error")
                                .to_string(),
                        })?;
                    }
                    // ping, etc.
                    _ => {}
                }
            }
        };
        Ok(Box::pin(stream))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_conversation_prefix_is_cached_but_the_trailing_message_is_not() {
        let req = ChatRequest {
            model: "claude-sonnet-5".into(),
            system: SystemPrompt::default(),
            messages: vec![
                Message::user("first"),
                Message::assistant(vec![ContentBlock::Text {
                    text: "reply".into(),
                }]),
                // Carries the sidecar in real use: the clock inside it moves
                // every turn, so marking it would make every read a miss.
                Message::user("second"),
            ],
            max_tokens: 16,
            temperature: None,
            thinking: Thinking::Default,
            tools: Vec::new(),
        };
        let body = Anthropic::body(&req).unwrap();
        let msgs = body["messages"].as_array().unwrap();
        assert!(msgs[0]["content"][0]["cache_control"].is_null());
        assert_eq!(msgs[1]["content"][0]["cache_control"]["type"], "ephemeral");
        assert!(msgs[2]["content"][0]["cache_control"].is_null());
    }

    #[test]
    fn a_single_message_conversation_has_nothing_stable_to_cache() {
        let req = ChatRequest {
            model: "claude-sonnet-5".into(),
            system: SystemPrompt::default(),
            messages: vec![Message::user("only")],
            max_tokens: 16,
            temperature: None,
            thinking: Thinking::Default,
            tools: Vec::new(),
        };
        let body = Anthropic::body(&req).unwrap();
        assert!(body["messages"][0]["content"][0]["cache_control"].is_null());
    }

    #[test]
    fn the_system_prompt_cannot_spend_the_conversation_breakpoint() {
        // Five anchored segments plus the rolling conversation breakpoint
        // would be six; Anthropic's limit is four and a fifth is a 400.
        let mut system = SystemPrompt::default();
        for i in 0..5 {
            system.push(Segment::new(SegmentKind::Custom, format!("s{i}"), "text").anchored());
        }
        let req = ChatRequest {
            model: "claude-sonnet-5".into(),
            system,
            messages: vec![
                Message::user("a"),
                Message::assistant(vec![ContentBlock::Text { text: "b".into() }]),
            ],
            max_tokens: 16,
            temperature: None,
            thinking: Thinking::Default,
            tools: Vec::new(),
        };
        let body = Anthropic::body(&req).unwrap();
        let marked = |v: &Value| {
            v.as_array()
                .unwrap()
                .iter()
                .filter(|b| !b["cache_control"].is_null())
                .count()
        };
        assert_eq!(marked(&body["system"]), 3);
        let in_messages: usize = body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|m| marked(&m["content"]))
            .sum();
        assert_eq!(in_messages, 1);
        assert!(marked(&body["system"]) + in_messages <= 4);
    }

    #[test]
    fn cached_prompt_tokens_are_summed_into_the_inclusive_total() {
        // A warm cache: 10 fresh tokens, 4000 read back, 0 written. Taking
        // `input_tokens` at face value would report a 10-token prompt.
        let mut usage = Usage::default();
        read_input_usage(
            &json!({
                "input_tokens": 10,
                "cache_read_input_tokens": 4000,
                "cache_creation_input_tokens": 0
            }),
            &mut usage,
        );
        assert_eq!(usage.input_tokens, 4010);
        assert_eq!(usage.cache_read_tokens, Some(4000));
        assert_eq!(usage.uncached_input_tokens(), 10);
    }

    #[test]
    fn a_response_without_cache_fields_reports_no_cache_rather_than_zero() {
        // Caching off is not a 0% hit rate — there is no rate to report.
        let mut usage = Usage::default();
        read_input_usage(&json!({ "input_tokens": 512 }), &mut usage);
        assert_eq!(usage.input_tokens, 512);
        assert_eq!(usage.cache_read_tokens, None);
        assert_eq!(usage.cache_hit_rate(), None);
    }

    use nightloom_core::{Segment, SegmentKind, SystemPrompt, ToolDef};

    fn request(tools: Vec<ToolDef>) -> ChatRequest {
        ChatRequest {
            model: "claude-sonnet-5".into(),
            system: SystemPrompt::default(),
            messages: vec![Message::user("hi")],
            max_tokens: 1024,
            temperature: None,
            thinking: Thinking::Default,
            tools,
        }
    }

    #[test]
    fn body_includes_tools_when_present() {
        let body = Anthropic::body(&request(vec![ToolDef {
            name: "get_weather".into(),
            description: "Look up current weather".into(),
            input_schema: json!({
                "type": "object",
                "properties": { "city": { "type": "string" } },
                "required": ["city"],
            }),
        }]))
        .unwrap();
        assert_eq!(body["tools"][0]["name"], "get_weather");
        assert_eq!(body["tools"][0]["description"], "Look up current weather");
        assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
    }

    #[test]
    fn system_becomes_text_blocks_with_cache_control_on_anchors() {
        let mut prompt = SystemPrompt::new();
        prompt
            .push(Segment::new(SegmentKind::Custom, "identity", "who you are"))
            .push(Segment::new(SegmentKind::Custom, "env", "where you are").anchored())
            .push(Segment::new(SegmentKind::Custom, "extra", "what to do"));
        let mut req = request(vec![]);
        req.system = prompt;
        let body = Anthropic::body(&req).unwrap();
        assert_eq!(
            body["system"],
            json!([
                { "type": "text", "text": "who you are" },
                {
                    "type": "text",
                    "text": "where you are",
                    "cache_control": { "type": "ephemeral" },
                },
                { "type": "text", "text": "what to do" },
            ])
        );
    }

    #[test]
    fn body_omits_system_key_when_prompt_empty() {
        let body = Anthropic::body(&request(vec![])).unwrap();
        assert!(body.get("system").is_none());
    }

    #[test]
    fn body_omits_tools_key_when_empty() {
        let body = Anthropic::body(&request(vec![])).unwrap();
        assert!(body.get("tools").is_none());
    }

    #[test]
    fn wire_message_maps_tool_use() {
        let msg = Message::assistant(vec![ContentBlock::ToolUse {
            id: "toolu_01".into(),
            name: "get_weather".into(),
            input: json!({ "city": "Oslo" }),
            signature: None,
        }]);
        assert_eq!(
            to_wire_message(&msg),
            json!({
                "role": "assistant",
                "content": [{
                    "type": "tool_use",
                    "id": "toolu_01",
                    "name": "get_weather",
                    "input": { "city": "Oslo" },
                }],
            })
        );
    }

    #[test]
    fn wire_message_maps_tool_result() {
        let msg = Message {
            role: Role::User,
            content: vec![ContentBlock::ToolResult {
                tool_use_id: "toolu_01".into(),
                name: "get_weather".into(),
                content: "12C, overcast".into(),
                is_error: false,
            }],
        };
        // No `name` (Gemini-only) and no `is_error` unless set.
        assert_eq!(
            to_wire_message(&msg),
            json!({
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": "toolu_01",
                    "content": "12C, overcast",
                }],
            })
        );
    }

    #[test]
    fn wire_message_keeps_is_error_flag() {
        let msg = Message {
            role: Role::User,
            content: vec![ContentBlock::ToolResult {
                tool_use_id: "toolu_01".into(),
                name: "get_weather".into(),
                content: "city not found".into(),
                is_error: true,
            }],
        };
        assert_eq!(to_wire_message(&msg)["content"][0]["is_error"], json!(true));
    }

    #[test]
    fn wire_message_maps_signed_thinking() {
        let msg = Message::assistant(vec![
            ContentBlock::Thinking {
                text: "considering options".into(),
                signature: Some("sig_abc".into()),
            },
            ContentBlock::Text {
                text: "answer".into(),
            },
        ]);
        assert_eq!(
            to_wire_message(&msg),
            json!({
                "role": "assistant",
                "content": [
                    {
                        "type": "thinking",
                        "thinking": "considering options",
                        "signature": "sig_abc",
                    },
                    { "type": "text", "text": "answer" },
                ],
            })
        );
    }

    #[test]
    fn wire_message_drops_unsigned_thinking() {
        let msg = Message::assistant(vec![
            ContentBlock::Thinking {
                text: "unsigned musings".into(),
                signature: None,
            },
            ContentBlock::Text {
                text: "answer".into(),
            },
        ]);
        assert_eq!(
            to_wire_message(&msg)["content"],
            json!([{ "type": "text", "text": "answer" }])
        );
    }

    #[test]
    fn wire_message_maps_user_image() {
        let msg = Message {
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
        };
        assert_eq!(
            to_wire_message(&msg),
            json!({
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/png",
                            "data": "iVBORw0KGgo=",
                        },
                    },
                    { "type": "text", "text": "what is this?" },
                ],
            })
        );
    }

    #[test]
    fn wire_message_drops_assistant_image() {
        let msg = Message::assistant(vec![
            ContentBlock::Image {
                media_type: "image/png".into(),
                data: "iVBORw0KGgo=".into(),
            },
            ContentBlock::Text {
                text: "answer".into(),
            },
        ]);
        assert_eq!(
            to_wire_message(&msg)["content"],
            json!([{ "type": "text", "text": "answer" }])
        );
    }

    #[test]
    fn wire_message_maps_redacted_thinking() {
        let msg = Message::assistant(vec![ContentBlock::RedactedThinking {
            data: "opaque-payload".into(),
        }]);
        assert_eq!(
            to_wire_message(&msg)["content"][0],
            json!({ "type": "redacted_thinking", "data": "opaque-payload" })
        );
    }
}
