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
        let input: Vec<Value> = request.messages.iter().map(to_wire_message).collect();
        let mut body = json!({
            "model": request.model,
            "stream": true,
            "input": input,
            "max_output_tokens": request.max_tokens,
        });
        if let Some(system) = &request.system {
            body["instructions"] = json!(system);
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

fn to_wire_message(message: &Message) -> Value {
    // Responses distinguishes input (user) from output (assistant) text parts.
    let (role, part_type) = match message.role {
        Role::User => ("user", "input_text"),
        Role::Assistant => ("assistant", "output_text"),
    };
    let content: Vec<Value> = message
        .content
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(json!({ "type": part_type, "text": text })),
            _ => None,
        })
        .collect();
    json!({ "role": role, "content": content })
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
                    // output_item added/done, content_part events, deltas we
                    // don't render yet (refusals, annotations), etc.
                    _ => {}
                }
            }
        };
        Ok(Box::pin(stream))
    }
}
