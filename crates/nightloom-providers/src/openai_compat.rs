use crate::{api_error, parse, transport};
use async_stream::try_stream;
use eventsource_stream::Eventsource;
use futures::StreamExt;
use nightloom_core::{
    ChatRequest, EventStream, Message, Provider, ProviderError, Role, StreamEvent, Thinking, Usage,
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
            messages.push(to_wire_message(m));
        }
        let mut body = json!({
            "model": request.model,
            "stream": true,
            "messages": messages,
        });
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

fn to_wire_message(message: &Message) -> Value {
    let role = match message.role {
        Role::User => "user",
        Role::Assistant => "assistant",
    };
    // This dialect takes flat strings; thinking blocks are never replayed.
    json!({ "role": role, "content": message.text() })
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

            while let Some(event) = events.next().await {
                let event = event.map_err(transport)?;
                if event.data.is_empty() {
                    continue;
                }
                if event.data.trim() == "[DONE]" {
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
            }
        };
        Ok(Box::pin(stream))
    }
}
