use crate::{api_error, parse, transport};
use async_stream::try_stream;
use eventsource_stream::Eventsource;
use futures::StreamExt;
use nightloom_core::{
    ChatRequest, ContentBlock, EventStream, Message, Provider, ProviderError, Role, StreamEvent,
    Thinking, Usage,
};
use serde_json::{Value, json};

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
    // Thinking blocks from past turns are dropped: replaying them requires
    // the signed originals, which we don't retain yet.
    let content: Vec<Value> = message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(json!({ "type": "text", "text": text })),
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
                    // ping, content_block_start/stop, signature deltas, etc.
                    _ => {}
                }
            }
        };
        Ok(Box::pin(stream))
    }
}
