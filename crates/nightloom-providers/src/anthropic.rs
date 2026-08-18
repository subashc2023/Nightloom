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

const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
const API_VERSION: &str = "2023-06-01";

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
        let messages: Vec<Value> = request.messages.iter().map(to_wire_message).collect();
        let mut body = json!({
            "model": request.model,
            "max_tokens": request.max_tokens,
            "stream": true,
            "messages": messages,
        });
        if let Some(system) = &request.system {
            body["system"] = json!(system);
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
            Thinking::Effort(e) => {
                body["thinking"] = json!({ "type": "adaptive" });
                body["output_config"] = json!({ "effort": e });
            }
        }
        Ok(body)
    }
}

fn to_wire_message(message: &Message) -> Value {
    let role = match message.role {
        Role::User => "user",
        Role::Assistant => "assistant",
    };
    // Signed thinking and redacted_thinking blocks are replayed verbatim;
    // unsigned thinking is filtered out below.
    let content: Vec<Value> = message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(json!({ "type": "text", "text": text })),
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
            ContentBlock::ToolUse { id, name, input } => Some(json!({
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
                        usage.input_tokens =
                            v["message"]["usage"]["input_tokens"].as_u64().unwrap_or(0);
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
                            yield StreamEvent::ToolUse { id, name, input };
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
    use nightloom_core::ToolDef;

    fn request(tools: Vec<ToolDef>) -> ChatRequest {
        ChatRequest {
            model: "claude-sonnet-5".into(),
            system: None,
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
