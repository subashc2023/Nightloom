use crate::{api_error, parse, transport};
use async_stream::try_stream;
use eventsource_stream::Eventsource;
use futures::StreamExt;
use nightloom_core::{
    ChatRequest, ContentBlock, EventStream, Message, Provider, ProviderError, Role, StreamEvent,
    Thinking, Usage,
};
use serde_json::{Value, json};

const OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
const GROQ_BASE_URL: &str = "https://api.groq.com/openai/v1";
const OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api/v1";

/// Which `chat/completions` dialect this instance speaks. The wire format is
/// nearly shared, but reasoning controls and usage accounting differ by host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Flavor {
    /// OpenAI itself, plus compatible local servers (Ollama, llama.cpp,
    /// LM Studio, vLLM) via `base_url`.
    Generic,
    /// Groq: `reasoning_effort` knob, usage also arrives in `x_groq.usage`.
    Groq,
    /// OpenRouter: unified `reasoning` object (effort or max_tokens),
    /// usage requested via `usage: {include: true}`.
    OpenRouter,
}

pub struct OpenAiCompat {
    client: reqwest::Client,
    api_key: String,
    base_url: String,
    flavor: Flavor,
}

impl OpenAiCompat {
    /// OpenAI or any compatible server. `api_key` may be empty for local
    /// servers that don't check auth.
    pub fn new(api_key: impl Into<String>, base_url: Option<String>) -> Self {
        Self::with_flavor(
            api_key,
            base_url.unwrap_or_else(|| OPENAI_BASE_URL.into()),
            Flavor::Generic,
        )
    }

    pub fn groq(api_key: impl Into<String>, base_url: Option<String>) -> Self {
        Self::with_flavor(
            api_key,
            base_url.unwrap_or_else(|| GROQ_BASE_URL.into()),
            Flavor::Groq,
        )
    }

    pub fn openrouter(api_key: impl Into<String>, base_url: Option<String>) -> Self {
        Self::with_flavor(
            api_key,
            base_url.unwrap_or_else(|| OPENROUTER_BASE_URL.into()),
            Flavor::OpenRouter,
        )
    }

    fn with_flavor(api_key: impl Into<String>, base_url: String, flavor: Flavor) -> Self {
        Self {
            client: reqwest::Client::new(),
            api_key: api_key.into(),
            base_url,
            flavor,
        }
    }

    fn body(&self, request: &ChatRequest) -> Result<Value, ProviderError> {
        let mut messages: Vec<Value> = Vec::new();
        if let Some(system) = &request.system {
            messages.push(json!({ "role": "system", "content": system }));
        }
        for m in &request.messages {
            messages.extend(to_wire_messages(m));
        }
        let mut body = json!({
            "model": request.model,
            "stream": true,
            "messages": messages,
        });
        if !request.tools.is_empty() {
            // chat/completions nests each tool under a "function" wrapper,
            // unlike the flat Responses-API shape.
            let tools: Vec<Value> = request
                .tools
                .iter()
                .map(|t| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": t.name,
                            "description": t.description,
                            "parameters": t.input_schema,
                        },
                    })
                })
                .collect();
            body["tools"] = json!(tools);
        }
        match self.flavor {
            Flavor::OpenRouter => {
                body["max_tokens"] = json!(request.max_tokens);
                body["usage"] = json!({ "include": true });
            }
            Flavor::Generic | Flavor::Groq => {
                body["max_completion_tokens"] = json!(request.max_tokens);
                body["stream_options"] = json!({ "include_usage": true });
            }
        }
        if self.flavor == Flavor::Groq {
            // Splits hybrid reasoners' inline <think> text into the reasoning
            // field; verified accepted by both gpt-oss and qwen on Groq.
            body["reasoning_format"] = json!("parsed");
        }
        if let Some(t) = request.temperature {
            body["temperature"] = json!(t);
        }
        match &request.thinking {
            Thinking::Default => {}
            Thinking::Effort(e) => match self.flavor {
                Flavor::OpenRouter => body["reasoning"] = json!({ "effort": e }),
                Flavor::Generic | Flavor::Groq => body["reasoning_effort"] = json!(e),
            },
            Thinking::Budget(n) => match self.flavor {
                // OpenRouter normalizes a token budget per upstream model.
                Flavor::OpenRouter => body["reasoning"] = json!({ "max_tokens": n }),
                Flavor::Generic | Flavor::Groq => {
                    return Err(ProviderError::Config(format!(
                        "{} does not support budget={n}; use effort=low|medium|high",
                        self.name()
                    )));
                }
            },
        }
        Ok(body)
    }
}

/// One canonical message can expand to several wire messages: tool results
/// become standalone `role: "tool"` entries in this dialect.
fn to_wire_messages(message: &Message) -> Vec<Value> {
    let mut out = Vec::new();
    if message.role == Role::User {
        // Tool results must directly follow the assistant tool_calls message,
        // so they go before any accompanying user text. The canonical `name`
        // is a Gemini-ism; this dialect addresses results by call id alone.
        for block in &message.content {
            if let ContentBlock::ToolResult {
                tool_use_id,
                content,
                is_error,
                ..
            } = block
            {
                // No error flag in this dialect; surface it in the content.
                let content = if *is_error {
                    format!("ERROR: {content}")
                } else {
                    content.clone()
                };
                out.push(json!({
                    "role": "tool",
                    "tool_call_id": tool_use_id,
                    "content": content,
                }));
            }
        }
        let text = message.text();
        if !text.is_empty() || out.is_empty() {
            out.push(json!({ "role": "user", "content": text }));
        }
        return out;
    }
    let tool_calls: Vec<Value> = message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::ToolUse { id, name, input } => Some(json!({
                "id": id,
                "type": "function",
                // Arguments travel as a JSON-encoded string, not an object.
                "function": { "name": name, "arguments": input.to_string() },
            })),
            _ => None,
        })
        .collect();
    // This dialect takes flat strings; thinking blocks are never replayed.
    if tool_calls.is_empty() {
        out.push(json!({ "role": "assistant", "content": message.text() }));
    } else {
        let text = message.text();
        let content = if text.is_empty() {
            Value::Null
        } else {
            Value::String(text)
        };
        out.push(json!({
            "role": "assistant",
            "content": content,
            "tool_calls": tool_calls,
        }));
    }
    out
}

/// A streamed tool call under assembly: id/name arrive on the first fragment,
/// arguments accumulate as string pieces across fragments.
#[derive(Default)]
struct PendingToolCall {
    id: Option<String>,
    name: String,
    arguments: String,
}

fn read_usage(u: &Value, usage: &mut Usage) {
    usage.input_tokens = u["prompt_tokens"].as_u64().unwrap_or(0);
    usage.output_tokens = u["completion_tokens"].as_u64().unwrap_or(0);
    usage.reasoning_tokens = u["completion_tokens_details"]["reasoning_tokens"]
        .as_u64()
        .or(usage.reasoning_tokens);
}

#[async_trait::async_trait]
impl Provider for OpenAiCompat {
    fn name(&self) -> &'static str {
        match self.flavor {
            Flavor::Generic => "openai-chat",
            Flavor::Groq => "groq",
            Flavor::OpenRouter => "openrouter",
        }
    }

    async fn stream_chat(&self, request: ChatRequest) -> Result<EventStream, ProviderError> {
        let mut req = self
            .client
            .post(format!("{}/chat/completions", self.base_url))
            .json(&self.body(&request)?);
        if !self.api_key.is_empty() {
            req = req.bearer_auth(&self.api_key);
        }
        if self.flavor == Flavor::OpenRouter {
            req = req.header("X-Title", "nightloom");
        }
        let resp = req.send().await.map_err(transport)?;
        if !resp.status().is_success() {
            return Err(api_error(resp).await);
        }

        let stream = try_stream! {
            let mut events = resp.bytes_stream().eventsource();
            let mut usage = Usage::default();
            let mut stop_reason: Option<String> = None;
            let mut started = false;
            // Keyed by fragment index; BTreeMap keeps emission in call order.
            let mut tool_calls: std::collections::BTreeMap<u64, PendingToolCall> =
                std::collections::BTreeMap::new();

            while let Some(event) = events.next().await {
                let event = event.map_err(transport)?;
                if event.data.is_empty() {
                    continue;
                }
                if event.data.trim() == "[DONE]" {
                    for (index, call) in std::mem::take(&mut tool_calls) {
                        // Models signal "no arguments" with an empty string.
                        let input = if call.arguments.trim().is_empty() {
                            json!({})
                        } else {
                            serde_json::from_str(&call.arguments).map_err(parse)?
                        };
                        yield StreamEvent::ToolUse {
                            // Some local servers omit ids entirely.
                            id: call.id.unwrap_or_else(|| format!("call-{index}")),
                            name: call.name,
                            input,
                        };
                    }
                    yield StreamEvent::Usage(usage);
                    yield StreamEvent::End { stop_reason: stop_reason.clone() };
                    break;
                }
                let v: Value = serde_json::from_str(&event.data).map_err(parse)?;
                if !started {
                    started = true;
                    yield StreamEvent::Start;
                }
                if let Some(u) = v.get("usage").filter(|u| !u.is_null()) {
                    read_usage(u, &mut usage);
                }
                // Groq delivers usage on the final chunk under x_groq.
                if let Some(u) = v.pointer("/x_groq/usage") {
                    read_usage(u, &mut usage);
                }
                let Some(choice) = v["choices"].get(0) else {
                    continue;
                };
                if let Some(reason) = choice["finish_reason"].as_str() {
                    stop_reason = Some(reason.to_string());
                }
                let delta = &choice["delta"];
                if let Some(text) = delta["content"].as_str()
                    && !text.is_empty()
                {
                    yield StreamEvent::TextDelta(text.to_string());
                }
                // Exposed reasoning; both field names are in the wild across
                // compatible servers (DeepSeek-style vs Groq/OpenRouter).
                for key in ["reasoning_content", "reasoning"] {
                    if let Some(text) = delta[key].as_str()
                        && !text.is_empty()
                    {
                        yield StreamEvent::ThinkingDelta(text.to_string());
                    }
                }
                if let Some(fragments) = delta["tool_calls"].as_array() {
                    for f in fragments {
                        let index = f["index"].as_u64().unwrap_or(0);
                        let call = tool_calls.entry(index).or_default();
                        if let Some(id) = f["id"].as_str().filter(|s| !s.is_empty()) {
                            call.id.get_or_insert_with(|| id.to_string());
                        }
                        if let Some(name) = f["function"]["name"].as_str()
                            && call.name.is_empty()
                        {
                            call.name = name.to_string();
                        }
                        if let Some(args) = f["function"]["arguments"].as_str() {
                            call.arguments.push_str(args);
                        }
                    }
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

    fn request(messages: Vec<Message>, tools: Vec<ToolDef>) -> ChatRequest {
        ChatRequest {
            model: "test-model".into(),
            system: None,
            messages,
            max_tokens: 64,
            temperature: None,
            thinking: Thinking::Default,
            tools,
        }
    }

    #[test]
    fn tools_use_nested_function_format() {
        let provider = OpenAiCompat::new("k", None);
        let body = provider
            .body(&request(
                vec![Message::user("hi")],
                vec![ToolDef {
                    name: "get_weather".into(),
                    description: "Look up weather".into(),
                    input_schema: json!({ "type": "object" }),
                }],
            ))
            .unwrap();
        assert_eq!(
            body["tools"],
            json!([{
                "type": "function",
                "function": {
                    "name": "get_weather",
                    "description": "Look up weather",
                    "parameters": { "type": "object" },
                },
            }])
        );
    }

    #[test]
    fn no_tools_field_when_tools_empty() {
        let provider = OpenAiCompat::new("k", None);
        let body = provider
            .body(&request(vec![Message::user("hi")], vec![]))
            .unwrap();
        assert!(body.get("tools").is_none());
    }

    #[test]
    fn assistant_tool_use_becomes_tool_calls_with_string_arguments() {
        let wire = to_wire_messages(&Message::assistant(vec![ContentBlock::ToolUse {
            id: "call-1".into(),
            name: "get_weather".into(),
            input: json!({ "city": "Oslo" }),
        }]));
        assert_eq!(
            wire,
            vec![json!({
                "role": "assistant",
                // No text blocks → null content, not an empty string.
                "content": null,
                "tool_calls": [{
                    "id": "call-1",
                    "type": "function",
                    "function": { "name": "get_weather", "arguments": "{\"city\":\"Oslo\"}" },
                }],
            })]
        );
    }

    #[test]
    fn tool_results_precede_user_text() {
        let wire = to_wire_messages(&Message {
            role: Role::User,
            content: vec![
                ContentBlock::Text {
                    text: "thanks".into(),
                },
                ContentBlock::ToolResult {
                    tool_use_id: "call-1".into(),
                    name: "get_weather".into(),
                    content: "sunny".into(),
                    is_error: false,
                },
                ContentBlock::ToolResult {
                    tool_use_id: "call-2".into(),
                    name: "get_weather".into(),
                    content: "no such city".into(),
                    is_error: true,
                },
            ],
        });
        assert_eq!(
            wire,
            vec![
                json!({ "role": "tool", "tool_call_id": "call-1", "content": "sunny" }),
                json!({ "role": "tool", "tool_call_id": "call-2", "content": "ERROR: no such city" }),
                json!({ "role": "user", "content": "thanks" }),
            ]
        );
    }

    #[test]
    fn plain_messages_keep_flat_string_shape() {
        let wire = to_wire_messages(&Message::user("hello"));
        assert_eq!(wire, vec![json!({ "role": "user", "content": "hello" })]);
    }
}
