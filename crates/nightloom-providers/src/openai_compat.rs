use crate::{api_error, parse, transport};
use async_stream::try_stream;
use eventsource_stream::Eventsource;
use futures::StreamExt;
use nightloom_core::{
    ChatRequest, ContentBlock, EventStream, Message, Provider, ProviderError, Role, StreamEvent,
    Thinking, Usage, undeliverable_document,
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

impl Flavor {
    /// Whether this host accepts a `file` content part.
    ///
    /// OpenRouter does and documents it. `Generic` is the awkward one: it
    /// covers OpenAI's own `chat/completions`, which takes a file part, and
    /// every local server reached through `base_url`, which does not — and
    /// the flavor cannot tell which end it is pointed at. The two mistakes
    /// are not symmetric, which is what settles it. A part a local host does
    /// not understand fails the whole request, and every later turn of that
    /// conversation with it; declining to send one costs a single attachment
    /// the model is then told, in words, that it cannot see.
    fn takes_documents(self) -> bool {
        matches!(self, Flavor::OpenRouter)
    }
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
            messages.extend(to_wire_messages(m, self.flavor));
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
            Flavor::Groq => {
                body["max_completion_tokens"] = json!(request.max_tokens);
                body["stream_options"] = json!({ "include_usage": true });
            }
            Flavor::Generic => {
                // Both spellings, because this flavor is aimed at whatever is
                // listening on a `--base-url`. `max_completion_tokens` is what
                // current OpenAI wants and what it needs to see; the servers
                // that predate it — llama.cpp, Ollama, vLLM, LM Studio and the
                // rest — know only `max_tokens`, and a field a server does not
                // recognize it simply ignores. Sending only the new name meant
                // an unbounded reply on exactly the local endpoints this
                // flavor exists to serve, which surfaces as a hang rather than
                // as an error.
                body["max_completion_tokens"] = json!(request.max_tokens);
                body["max_tokens"] = json!(request.max_tokens);
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
fn to_wire_messages(message: &Message, flavor: Flavor) -> Vec<Value> {
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
        // An attachment forces `content` from a plain string into an array
        // of parts, and that is a real compatibility cliff: plenty of the
        // local and hosted servers behind this adapter only ever parse the
        // string form. So the array shape appears only when there is
        // something to carry — a text-only turn still serializes exactly as
        // it always did, string and all, and nothing changes for hosts
        // without vision.
        //
        // A document on a host that has no file part is therefore *not*
        // reason enough: it goes out as a notice, and a notice is text. A
        // turn that stepped into the array form to say "this could not be
        // delivered" would break the string-only servers on exactly the
        // request it exists to keep working.
        let needs_parts = message.content.iter().any(|b| match b {
            ContentBlock::Image { .. } => true,
            ContentBlock::Document { .. } => flavor.takes_documents(),
            _ => false,
        });
        if needs_parts {
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
                    ContentBlock::Document {
                        media_type,
                        name,
                        data,
                    } => Some(if flavor.takes_documents() {
                        json!({
                            "type": "file",
                            "file": {
                                "filename": name,
                                "file_data": format!("data:{media_type};base64,{data}"),
                            },
                        })
                    } else {
                        json!({
                            "type": "text",
                            "text": undeliverable_document(name, media_type),
                        })
                    }),
                    _ => None,
                })
                .collect();
            out.push(json!({ "role": "user", "content": parts }));
            return out;
        }
        // Undeliverable documents lead, where the attachments they stand in
        // for would have.
        let notices: Vec<String> = message
            .content
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Document {
                    media_type, name, ..
                } => Some(undeliverable_document(name, media_type)),
                _ => None,
            })
            .collect();
        let caption = message.text();
        let text = match (notices.is_empty(), caption.is_empty()) {
            (true, _) => caption,
            (false, true) => notices.join("\n"),
            (false, false) => format!("{}\n{caption}", notices.join("\n")),
        };
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
    // Carried forward rather than defaulted to zero, like the two fields
    // below: a host that sends usage more than once — Groq sends it twice, by
    // two different routes — must not be able to erase a count by omitting it
    // the second time. Zero is a figure, and the wrong one.
    usage.input_tokens = u["prompt_tokens"].as_u64().unwrap_or(usage.input_tokens);
    usage.output_tokens = u["completion_tokens"]
        .as_u64()
        .unwrap_or(usage.output_tokens);
    usage.reasoning_tokens = u["completion_tokens_details"]["reasoning_tokens"]
        .as_u64()
        .or(usage.reasoning_tokens);
    // A subset of prompt_tokens, as on the Responses API. Hosts that do no
    // caching omit the field entirely, which stays None rather than becoming
    // a reported 0% hit rate.
    usage.cache_read_tokens = u["prompt_tokens_details"]["cached_tokens"]
        .as_u64()
        .or(usage.cache_read_tokens);
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
        Ok(normalize(resp.bytes_stream()))
    }
}

/// Turn a `chat/completions` SSE body into `StreamEvent`s.
///
/// Split from the request half so a canned body can reach what varies across
/// the hosts this one adapter serves: tool-call fragments accumulated by index
/// and flushed at the end, two spellings of exposed reasoning, usage arriving
/// under three different keys, and servers that close without `[DONE]`.
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
            // Whether `[DONE]` arrived. Tool calls are buffered until it does,
            // so a stream that stops short loses them outright — the reply
            // would arrive looking complete and simply not have called
            // anything.
            let mut done = false;
            // Keyed by fragment index; BTreeMap keeps emission in call order.
            let mut tool_calls: std::collections::BTreeMap<u64, PendingToolCall> =
                std::collections::BTreeMap::new();

            while let Some(event) = events.next().await {
                let event = event.map_err(transport)?;
                if event.data.is_empty() {
                    continue;
                }
                if event.data.trim() == "[DONE]" {
                    done = true;
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

            // A stream that stopped with neither `[DONE]` nor a
            // `finish_reason` did not finish — whatever text arrived is a
            // fragment, and any tool call still in the buffer never happened.
            // Ending quietly here would hand the engine a truncated reply
            // wearing the shape of a complete one.
            //
            // Either terminator is enough, though. `[DONE]` is a convention
            // plenty of compatible servers skip, closing the connection the
            // moment the last chunk is out, and the model's own
            // `finish_reason` is the stronger statement of the two.
            if !done && stop_reason.is_none() {
                Err(crate::truncated("chat/completions"))?;
            }
            // Drained in index order, which is call order: the id a server
            // omitted is synthesized here, and the model reads the calls in
            // the order they are yielded.
            for (_index, call) in std::mem::take(&mut tool_calls) {
                // Models signal "no arguments" with an empty string.
                let input = if call.arguments.trim().is_empty() {
                    json!({})
                } else {
                    serde_json::from_str(&call.arguments).map_err(parse)?
                };
                yield StreamEvent::ToolUse {
                    // Some local servers omit ids entirely.
                    id: call.id.unwrap_or_else(crate::synthetic_call_id),
                    name: call.name,
                    input,
                    // No chat/completions host signs calls.
                    signature: None,
                };
            }
            yield StreamEvent::Usage(usage);
            yield StreamEvent::End { stop_reason };
    })
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
        let wire = to_wire_messages(
            &Message::assistant(vec![ContentBlock::ToolUse {
                id: "call-1".into(),
                name: "get_weather".into(),
                input: json!({ "city": "Oslo" }),
                signature: None,
            }]),
            Flavor::Generic,
        );
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
        let wire = to_wire_messages(
            &Message {
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
            },
            Flavor::Generic,
        );
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
        let wire = to_wire_messages(&Message::user("hello"), Flavor::Generic);
        assert_eq!(wire, vec![json!({ "role": "user", "content": "hello" })]);
    }

    #[test]
    fn user_image_becomes_a_content_part_array() {
        let wire = to_wire_messages(
            &Message {
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
            },
            Flavor::Generic,
        );
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
    /// OpenRouter documents a `file` part and parses the PDF on its side.
    #[test]
    fn openrouter_carries_a_pdf_as_a_file_part() {
        let wire = to_wire_messages(
            &Message {
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
            },
            Flavor::OpenRouter,
        );
        assert_eq!(
            wire,
            vec![json!({
                "role": "user",
                "content": [
                    {
                        "type": "file",
                        "file": {
                            "filename": "contract.pdf",
                            "file_data": "data:application/pdf;base64,JVBERi0=",
                        },
                    },
                    { "type": "text", "text": "summarize" },
                ],
            })]
        );
    }

    /// A host that cannot take a file part is told in words, and the model
    /// with it. The alternative shapes are both worse: sending the part
    /// anyway 400s the request against every local server behind this
    /// adapter, and dropping the block silently leaves a caption asking
    /// about a document the model will answer as though it had read.
    ///
    /// And the notice stays in the *string* form. A notice is text, so
    /// stepping into the parts array to deliver it would break the
    /// string-only servers on exactly the request meant to keep working.
    #[test]
    fn a_host_without_document_support_gets_a_notice_not_the_bytes() {
        let wire = to_wire_messages(
            &Message {
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
            },
            Flavor::Generic,
        );
        assert_eq!(wire.len(), 1);
        assert_eq!(wire[0]["role"], "user");
        let content = wire[0]["content"].as_str().expect("the string form");
        assert!(content.contains("contract.pdf"), "{content}");
        assert!(
            !content.contains("JVBERi0="),
            "the bytes went out anyway: {content}"
        );
        assert!(content.ends_with("summarize"), "the caption still trails");
    }

    /// An image alongside an undeliverable document does force the array,
    /// because the image needs it. The document is a text part there.
    #[test]
    fn a_notice_rides_as_a_text_part_when_an_image_forces_the_array() {
        let wire = to_wire_messages(
            &Message {
                role: Role::User,
                content: vec![
                    ContentBlock::Image {
                        media_type: "image/png".into(),
                        data: "iVBORw0KGgo=".into(),
                    },
                    ContentBlock::Document {
                        media_type: "application/pdf".into(),
                        name: "contract.pdf".into(),
                        data: "JVBERi0=".into(),
                    },
                ],
            },
            Flavor::Generic,
        );
        let parts = wire[0]["content"].as_array().expect("parts");
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0]["type"], "image_url");
        assert_eq!(parts[1]["type"], "text");
        assert!(
            parts[1]["text"]
                .as_str()
                .is_some_and(|t| t.contains("contract.pdf")),
            "{:?}",
            parts[1]
        );
    }

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
        let wire = to_wire_messages(
            &Message::assistant(vec![
                ContentBlock::Image {
                    media_type: "image/png".into(),
                    data: "iVBORw0KGgo=".into(),
                },
                ContentBlock::Text {
                    text: "answer".into(),
                },
            ]),
            Flavor::Generic,
        );
        assert_eq!(
            wire,
            vec![json!({ "role": "assistant", "content": "answer" })]
        );
    }

    /// An image with no accompanying text still has to produce a message —
    /// the old string path would have emitted `"content": ""`.
    #[test]
    fn image_only_message_carries_just_the_image_part() {
        let wire = to_wire_messages(
            &Message {
                role: Role::User,
                content: vec![ContentBlock::Image {
                    media_type: "image/jpeg".into(),
                    data: "/9j/4AAQ".into(),
                }],
            },
            Flavor::Generic,
        );
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
        let wire = to_wire_messages(
            &Message {
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
            },
            Flavor::Generic,
        );
        assert_eq!(wire.len(), 2);
        assert_eq!(
            wire[0],
            json!({ "role": "tool", "tool_call_id": "call-1", "content": "captured" })
        );
        assert_eq!(wire[1]["content"][0]["type"], "image_url");
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
    /// these arrive in is half of what is being pinned.
    fn shapes(events: &[StreamEvent]) -> Vec<String> {
        events
            .iter()
            .map(|e| match e {
                StreamEvent::Start => "start".to_string(),
                StreamEvent::TextDelta(t) => format!("text {t}"),
                StreamEvent::ThinkingDelta(t) => format!("thinking {t}"),
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

    /// A tool-call fragment carries an index and nothing else tying it to
    /// its call, and the socket splits the argument pieces again on top of
    /// that. Accumulating by arrival order splices two parallel calls
    /// together; draining by arrival order hands the model the calls in an
    /// order it did not ask for.
    #[tokio::test]
    async fn tool_arguments_split_across_chunks_arrive_as_one_call_per_index() {
        let fragment = |f: Value| sse(json!({ "choices": [{ "delta": { "tool_calls": [f] } }] }));
        let body = [
            fragment(json!({
                "index": 0,
                "id": "call_a",
                "function": { "name": "get_weather", "arguments": "" },
            })),
            fragment(json!({
                "index": 1,
                "id": "call_b",
                "function": { "name": "get_time", "arguments": "" },
            })),
            // The server finishes the second call's arguments first.
            fragment(json!({ "index": 1, "function": { "arguments": "{\"zone\":" } })),
            fragment(json!({ "index": 1, "function": { "arguments": "\"CET\"}" } })),
            fragment(json!({ "index": 0, "function": { "arguments": "{\"city\":" } })),
            fragment(json!({ "index": 0, "function": { "arguments": "\"Oslo\"}" } })),
            sse(json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }] })),
            "data: [DONE]\n\n".to_string(),
        ]
        .concat();
        // The wire break lands inside one of the argument fragments.
        let cut = body.find("Oslo").expect("the last fragment");
        let (head, tail) = body.split_at(cut);
        let seen = events(&[head, tail]).await;
        assert_eq!(
            shapes(&seen),
            [
                "start",
                "tool call_a get_weather {\"city\":\"Oslo\"}",
                "tool call_b get_time {\"zone\":\"CET\"}",
                "usage",
                "end Some(\"tool_calls\")",
            ]
        );
    }

    /// Exposed reasoning goes by two names across the servers behind this
    /// one adapter — DeepSeek-style `reasoning_content` against Groq's and
    /// OpenRouter's `reasoning`. Reading one spelling renders the other
    /// host's thinking as nothing at all.
    #[tokio::test]
    async fn both_reasoning_spellings_stream_as_thinking() {
        for key in ["reasoning_content", "reasoning"] {
            let body = [
                sse(json!({ "choices": [{ "delta": { key: "weighing it" } }] })),
                sse(json!({ "choices": [{ "delta": { "content": "12C" } }] })),
                sse(json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }] })),
                "data: [DONE]\n\n".to_string(),
            ]
            .concat();
            let seen = events(&[&body]).await;
            assert_eq!(
                shapes(&seen),
                [
                    "start",
                    "thinking weighing it",
                    "text 12C",
                    "usage",
                    "end Some(\"stop\")"
                ],
                "under {key}"
            );
        }
    }

    /// Groq reports the turn's usage under `x_groq` on the final chunk while
    /// every other host uses `usage`. Reading only the shared key bills a
    /// Groq turn at zero.
    #[tokio::test]
    async fn usage_is_read_from_both_the_shared_key_and_groqs() {
        let counts = json!({
            "prompt_tokens": 1200,
            "completion_tokens": 64,
            "completion_tokens_details": { "reasoning_tokens": 40 },
            "prompt_tokens_details": { "cached_tokens": 1024 },
        });
        let expected = Usage {
            input_tokens: 1200,
            output_tokens: 64,
            reasoning_tokens: Some(40),
            cache_read_tokens: Some(1024),
            cache_write_tokens: None,
        };
        for final_chunk in [
            json!({ "choices": [], "usage": counts }),
            // Groq's final chunk leaves the shared key null and puts the
            // real counts one level down.
            json!({ "choices": [], "usage": null, "x_groq": { "usage": counts } }),
        ] {
            let body = [
                sse(
                    json!({ "choices": [{ "delta": { "content": "hi" }, "finish_reason": null }] }),
                ),
                sse(json!({ "choices": [{ "delta": {}, "finish_reason": "stop" }] })),
                sse(final_chunk.clone()),
                "data: [DONE]\n\n".to_string(),
            ]
            .concat();
            let seen = events(&[&body]).await;
            assert_eq!(reported_usage(&seen), expected, "under {final_chunk}");
        }
    }

    /// Plenty of compatible servers — the local ones this flavor exists to
    /// serve — close the connection the moment the last chunk is out and
    /// never send `[DONE]`. Insisting on it fails a turn that finished, and
    /// takes the calls buffered until the terminator down with it: the reply
    /// would arrive looking complete and simply not have called anything.
    #[tokio::test]
    async fn a_server_that_closes_without_done_still_delivers_its_buffered_calls() {
        let body = [
            sse(json!({ "choices": [{ "delta": { "tool_calls": [{
                "index": 0,
                "id": "call_a",
                "function": { "name": "get_weather", "arguments": "{\"city\":\"Oslo\"}" },
            }] } }] })),
            sse(json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }] })),
        ]
        .concat();
        let seen = events(&[&body]).await;
        assert_eq!(
            shapes(&seen),
            [
                "start",
                "tool call_a get_weather {\"city\":\"Oslo\"}",
                "usage",
                "end Some(\"tool_calls\")",
            ]
        );
    }

    /// The same local servers omit call ids and send `""` for a call that
    /// takes no arguments. An empty id collides with every other empty id in
    /// the approval table, and `""` handed to the JSON parser is an error
    /// that fails the whole turn rather than a call.
    #[tokio::test]
    async fn a_call_with_no_id_and_no_arguments_is_still_usable() {
        let body = [
            sse(json!({ "choices": [{ "delta": { "tool_calls": [{
                "index": 0,
                "function": { "name": "list_notes", "arguments": "" },
            }] } }] })),
            sse(json!({ "choices": [{ "delta": {}, "finish_reason": "tool_calls" }] })),
            "data: [DONE]\n\n".to_string(),
        ]
        .concat();
        let seen = events(&[&body]).await;
        let Some(StreamEvent::ToolUse {
            id, name, input, ..
        }) = seen
            .iter()
            .find(|e| matches!(e, StreamEvent::ToolUse { .. }))
        else {
            panic!("the call was dropped: {seen:?}");
        };
        assert!(!id.is_empty(), "a call with no id of its own got none");
        assert_eq!(name, "list_notes");
        assert_eq!(*input, json!({}));
    }

    /// Neither terminator means the stream stopped rather than finished:
    /// whatever text arrived is a fragment, and the call still in the buffer
    /// never happened.
    #[tokio::test]
    async fn a_stream_with_neither_done_nor_a_finish_reason_is_an_error() {
        let body = [
            sse(json!({ "choices": [{ "delta": { "content": "half an ans" } }] })),
            sse(json!({ "choices": [{ "delta": { "tool_calls": [{
                "index": 0,
                "id": "call_a",
                "function": { "name": "bash", "arguments": "{\"cmd\":" },
            }] } }] })),
        ]
        .concat();
        let seen = drain(&[&body]).await;
        assert!(
            !seen.iter().any(|e| matches!(
                e,
                Ok(StreamEvent::ToolUse { .. }) | Ok(StreamEvent::End { .. })
            )),
            "a truncated stream was closed out as a finished one: {seen:?}"
        );
        let Some(Err(ProviderError::Transport(message))) = seen.last() else {
            panic!("the truncated stream ended quietly: {seen:?}");
        };
        assert!(message.contains("incomplete"), "{message}");
    }
}
