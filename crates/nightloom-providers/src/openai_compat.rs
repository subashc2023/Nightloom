use crate::{api_error, parse, transport};
use async_stream::try_stream;
use eventsource_stream::Eventsource;
use futures::StreamExt;
use nightloom_core::{
    ChatRequest, ContentBlock, EventStream, Message, Provider, ProviderError, Role, StreamEvent,
    Thinking, Usage,
};
use serde_json::{Value, json};

pub(crate) const OPENAI_BASE_URL: &str = "https://api.openai.com/v1";
pub(crate) const GROQ_BASE_URL: &str = "https://api.groq.com/openai/v1";
pub(crate) const OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api/v1";

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
        if let Some(system) = request.system.render_flat() {
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
        // An image forces `content` from a plain string into an array of
        // parts, and that is a real compatibility cliff: plenty of the local
        // and hosted servers behind this adapter only ever parse the string
        // form. So the array shape appears only when there is an image to
        // carry — a text-only turn still serializes exactly as it always
        // did, string and all, and nothing changes for hosts without vision.
        if message
            .content
            .iter()
            .any(|b| matches!(b, ContentBlock::Image { .. }))
        {
            let parts: Vec<Value> = message
                .content
                .iter()
                .filter_map(|block| match block {
                    // Empty text blocks are skipped: harmless folded into a
                    // concatenated string, a rejected part on their own.
                    ContentBlock::Text { text } if !text.is_empty() => {
                        Some(json!({ "type": "text", "text": text }))
                    }
                    // This dialect names no media type of its own; it reads
                    // one off the data URL.
                    ContentBlock::Image { media_type, data } => Some(json!({
                        "type": "image_url",
                        "image_url": { "url": format!("data:{media_type};base64,{data}") },
                    })),
                    _ => None,
                })
                .collect();
            out.push(json!({ "role": "user", "content": parts }));
            return out;
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
            ContentBlock::ToolUse {
                id, name, input, ..
            } => Some(json!({
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
                            // No chat/completions host signs calls.
                            signature: None,
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
    use nightloom_core::{Segment, SegmentKind, SystemPrompt, ToolDef};

    fn request(messages: Vec<Message>, tools: Vec<ToolDef>) -> ChatRequest {
        ChatRequest {
            model: "test-model".into(),
            system: SystemPrompt::default(),
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
    fn system_segments_collapse_into_one_leading_system_message() {
        let mut prompt = SystemPrompt::new();
        prompt
            .push(Segment::new(SegmentKind::Custom, "a", "first"))
            .push(Segment::new(SegmentKind::Custom, "b", "second"));
        let mut req = request(vec![Message::user("hi")], vec![]);
        req.system = prompt;
        let body = OpenAiCompat::new("k", None).body(&req).unwrap();
        assert_eq!(
            body["messages"][0],
            json!({ "role": "system", "content": "first\n\nsecond" })
        );
        assert_eq!(body["messages"][1]["role"], "user");
    }

    #[test]
    fn no_system_message_when_prompt_empty() {
        let provider = OpenAiCompat::new("k", None);
        let body = provider
            .body(&request(vec![Message::user("hi")], vec![]))
            .unwrap();
        assert_eq!(body["messages"][0]["role"], "user");
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
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
            signature: None,
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

    #[test]
    fn user_image_becomes_a_content_part_array() {
        let wire = to_wire_messages(&Message {
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
            vec![json!({
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": { "url": "data:image/png;base64,iVBORw0KGgo=" },
                    },
                    { "type": "text", "text": "what is this?" },
                ],
            })]
        );
    }

    /// The array form is contagious if you let it be: the whole reason it is
    /// gated on an image is that hosts which take only a string must keep
    /// seeing the byte-identical body they saw before vision existed.
    #[test]
    fn imageless_bodies_are_byte_identical_to_the_string_form() {
        let provider = OpenAiCompat::new("k", None);
        let messages = vec![
            Message::user("hello"),
            Message::assistant(vec![ContentBlock::Text {
                text: "hi there".into(),
            }]),
            Message {
                role: Role::User,
                content: vec![ContentBlock::ToolResult {
                    tool_use_id: "call-1".into(),
                    name: "get_weather".into(),
                    content: "sunny".into(),
                    is_error: false,
                }],
            },
        ];
        let body = provider.body(&request(messages, vec![])).unwrap();
        assert_eq!(
            body["messages"],
            json!([
                { "role": "user", "content": "hello" },
                { "role": "assistant", "content": "hi there" },
                { "role": "tool", "tool_call_id": "call-1", "content": "sunny" },
            ])
        );
    }

    /// No model emits an image, so one recorded against an assistant turn is
    /// a replay hazard; it must not drag the turn into the array form.
    #[test]
    fn assistant_image_is_dropped_and_keeps_string_content() {
        let wire = to_wire_messages(&Message::assistant(vec![
            ContentBlock::Image {
                media_type: "image/png".into(),
                data: "iVBORw0KGgo=".into(),
            },
            ContentBlock::Text {
                text: "answer".into(),
            },
        ]));
        assert_eq!(
            wire,
            vec![json!({ "role": "assistant", "content": "answer" })]
        );
    }

    /// An image with no accompanying text still has to produce a message —
    /// the old string path would have emitted `"content": ""`.
    #[test]
    fn image_only_message_carries_just_the_image_part() {
        let wire = to_wire_messages(&Message {
            role: Role::User,
            content: vec![ContentBlock::Image {
                media_type: "image/jpeg".into(),
                data: "/9j/4AAQ".into(),
            }],
        });
        assert_eq!(
            wire,
            vec![json!({
                "role": "user",
                "content": [{
                    "type": "image_url",
                    "image_url": { "url": "data:image/jpeg;base64,/9j/4AAQ" },
                }],
            })]
        );
    }

    /// Tool results still come out as their own `role: "tool"` messages and
    /// stay ahead of the image-bearing user turn.
    #[test]
    fn tool_results_still_precede_an_image_bearing_user_turn() {
        let wire = to_wire_messages(&Message {
            role: Role::User,
            content: vec![
                ContentBlock::ToolResult {
                    tool_use_id: "call-1".into(),
                    name: "screenshot".into(),
                    content: "captured".into(),
                    is_error: false,
                },
                ContentBlock::Image {
                    media_type: "image/png".into(),
                    data: "iVBORw0KGgo=".into(),
                },
            ],
        });
        assert_eq!(wire.len(), 2);
        assert_eq!(
            wire[0],
            json!({ "role": "tool", "tool_call_id": "call-1", "content": "captured" })
        );
        assert_eq!(wire[1]["content"][0]["type"], "image_url");
    }
}
