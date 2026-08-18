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
        let input: Vec<Value> = request.messages.iter().flat_map(to_wire_items).collect();
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
    let text_parts: Vec<Value> = message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(json!({ "type": part_type, "text": text })),
            _ => None,
        })
        .collect();
    if !text_parts.is_empty() {
        items.push(json!({ "role": role, "content": text_parts }));
    }
    if message.role == Role::Assistant {
        for block in &message.content {
            if let ContentBlock::ToolUse { id, name, input } = block {
                items.push(json!({
                    "type": "function_call",
                    "call_id": id,
                    "name": name,
                    // Responses carries arguments as a JSON-encoded string.
                    "arguments": input.to_string(),
                }));
            }
        }
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
        let resp = self
            .client
            .post(format!("{}/responses", self.base_url))
            .bearer_auth(&self.api_key)
            .json(&Self::body(&request)?)
            .send()
            .await
            .map_err(transport)?;
        if !resp.status().is_success() {
            return Err(api_error(resp).await);
        }

        let stream = try_stream! {
            let mut events = resp.bytes_stream().eventsource();

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
                        });
                        // "completed", or the incomplete reason (e.g.
                        // "max_output_tokens") when the response was cut off.
                        let stop_reason = r["incomplete_details"]["reason"]
                            .as_str()
                            .or(r["status"].as_str())
                            .map(String::from);
                        yield StreamEvent::End { stop_reason };
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
}
