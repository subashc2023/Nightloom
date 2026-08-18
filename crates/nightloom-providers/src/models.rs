//! Live model discovery: query a provider's `/models` endpoint and return
//! plain model ids. This is a management-plane helper for shells (settings
//! UIs, pickers) — it deliberately lives outside the `Provider` trait, which
//! stays chat-only.

use crate::registry::ProviderKind;
use crate::{api_error, parse, transport};
use nightloom_core::ProviderError;
use serde_json::Value;

/// Model ids OpenAI's `/models` returns that can't hold a chat conversation;
/// listing them in a picker is pure noise.
const OPENAI_NON_CHAT: &[&str] = &[
    "embedding",
    "whisper",
    "tts",
    "dall-e",
    "davinci",
    "babbage",
    "moderation",
    "audio",
    "realtime",
    "transcribe",
    "image",
];

/// Fetch the model ids a provider currently offers. An explicit `api_key`
/// wins over environment credentials (matching [`ProviderKind::build`]);
/// `base_url` overrides the default endpoint (required for `openai-chat`
/// pointed at a local server).
pub async fn list_models(
    kind: ProviderKind,
    api_key: Option<String>,
    base_url: Option<String>,
) -> Result<Vec<String>, ProviderError> {
    let key = api_key.or_else(|| kind.key_from_env());
    let client = reqwest::Client::new();

    let request = match kind {
        ProviderKind::Anthropic => {
            let base = base_url.unwrap_or_else(|| crate::anthropic::DEFAULT_BASE_URL.into());
            client
                .get(format!("{base}/v1/models?limit=1000"))
                .header("x-api-key", key.ok_or_else(|| missing(kind))?)
                .header("anthropic-version", crate::anthropic::API_VERSION)
        }
        ProviderKind::Openai | ProviderKind::OpenaiChat => {
            let base = base_url.unwrap_or_else(|| crate::openai_compat::OPENAI_BASE_URL.into());
            let mut req = client.get(format!("{base}/models"));
            // A local server needs no key; api.openai.com does.
            match key {
                Some(k) => req = req.bearer_auth(k),
                None if kind == ProviderKind::Openai => return Err(missing(kind)),
                None => {}
            }
            req
        }
        ProviderKind::Gemini => {
            let base = base_url.unwrap_or_else(|| crate::gemini::DEFAULT_BASE_URL.into());
            client
                .get(format!("{base}/v1beta/models?pageSize=1000"))
                .header("x-goog-api-key", key.ok_or_else(|| missing(kind))?)
        }
        ProviderKind::Groq => {
            let base = base_url.unwrap_or_else(|| crate::openai_compat::GROQ_BASE_URL.into());
            client
                .get(format!("{base}/models"))
                .bearer_auth(key.ok_or_else(|| missing(kind))?)
        }
        ProviderKind::Openrouter => {
            let base = base_url.unwrap_or_else(|| crate::openai_compat::OPENROUTER_BASE_URL.into());
            // OpenRouter's model list is public; send the key if we have one.
            let mut req = client.get(format!("{base}/models"));
            if let Some(k) = key {
                req = req.bearer_auth(k);
            }
            req
        }
    };

    let resp = request.send().await.map_err(transport)?;
    if !resp.status().is_success() {
        return Err(api_error(resp).await);
    }
    let body: Value = resp.json().await.map_err(parse)?;

    let mut ids = match kind {
        ProviderKind::Gemini => gemini_ids(&body),
        _ => openai_style_ids(&body),
    };
    if ids.is_empty() {
        return Err(ProviderError::Parse(
            "models response contained no model ids".into(),
        ));
    }
    if kind == ProviderKind::Openai {
        ids.retain(|id| !OPENAI_NON_CHAT.iter().any(|frag| id.contains(frag)));
    }
    ids.sort_by_key(|id| id.to_lowercase());
    ids.dedup();
    Ok(ids)
}

fn missing(kind: ProviderKind) -> ProviderError {
    ProviderError::Config(format!("no API key available for provider {kind}"))
}

/// `{"data": [{"id": "..."}]}` — Anthropic, OpenAI, Groq, OpenRouter.
fn openai_style_ids(body: &Value) -> Vec<String> {
    body["data"]
        .as_array()
        .map(|models| {
            models
                .iter()
                .filter_map(|m| m["id"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// `{"models": [{"name": "models/...", "supportedGenerationMethods": [...]}]}`
/// — keep only chat-capable entries and strip the `models/` prefix.
fn gemini_ids(body: &Value) -> Vec<String> {
    body["models"]
        .as_array()
        .map(|models| {
            models
                .iter()
                .filter(|m| {
                    m["supportedGenerationMethods"]
                        .as_array()
                        .is_some_and(|ms| ms.iter().any(|v| v == "generateContent"))
                })
                .filter_map(|m| m["name"].as_str())
                .map(|name| name.strip_prefix("models/").unwrap_or(name).to_string())
                .collect()
        })
        .unwrap_or_default()
}
