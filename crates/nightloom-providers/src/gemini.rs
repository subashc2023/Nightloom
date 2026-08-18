use crate::{api_error, parse, transport};
use async_stream::try_stream;
use eventsource_stream::Eventsource;
use futures::StreamExt;
use nightloom_core::{
    ChatRequest, ContentBlock, EventStream, Message, Provider, ProviderError, Role, StreamEvent,
    Thinking, Usage,
};
use serde_json::{Value, json};

const DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com";

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
        if let Some(system) = &request.system {
            body["systemInstruction"] = json!({ "parts": [{ "text": system }] });
        }
        body
    }
}

fn to_wire_message(message: &Message) -> Value {
    let role = match message.role {
        Role::User => "user",
        Role::Assistant => "model",
    };
    // Thought parts from past turns are dropped (replaying them requires
    // thought signatures, which we don't retain yet).
    let parts: Vec<Value> = message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(json!({ "text": text })),
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
                }
                let Some(candidate) = v["candidates"].get(0) else {
                    continue;
                };
                if let Some(reason) = candidate["finishReason"].as_str() {
                    stop_reason = Some(reason.to_string());
                }
                if let Some(parts) = candidate["content"]["parts"].as_array() {
                    for part in parts {
                        if let Some(text) = part["text"].as_str()
                            && !text.is_empty()
                        {
                            if part["thought"].as_bool().unwrap_or(false) {
                                yield StreamEvent::ThinkingDelta(text.to_string());
                            } else {
                                yield StreamEvent::TextDelta(text.to_string());
                            }
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
