//! An exact token count for a draft, from the provider's own counter
//! (nightshift backlog 155). A management-plane helper like
//! [`crate::models::list_models`]: it lives outside the `Provider` trait,
//! which stays chat-only.
//!
//! Only Anthropic is asked. Its Messages API has a `count_tokens` endpoint
//! (`POST /v1/messages/count_tokens`, answering `{"input_tokens": N}`) that
//! costs a request and no tokens — `external`: Anthropic's documentation
//! claims both. Every other provider answers `Ok(None)` and the composer keeps
//! its estimate; the tooltip says which it is.

use crate::registry::ProviderKind;
use crate::{api_error, parse, transport};
use nightloom_core::ProviderError;
use serde_json::{Value, json};

/// The draft as one user message, the shape `count_tokens` counts. Public to
/// the crate so a test can pin it without a server.
pub(crate) fn anthropic_count_body(model: &str, text: &str) -> Value {
    json!({
        "model": model,
        "messages": [{ "role": "user", "content": text }],
    })
}

/// `{"input_tokens": N}` → N.
pub(crate) fn read_input_tokens(body: &Value) -> Result<u64, ProviderError> {
    body["input_tokens"]
        .as_u64()
        .ok_or_else(|| ProviderError::Parse("count_tokens response carried no input_tokens".into()))
}

/// Count `text` as one user message on `model`. `Ok(None)` means this
/// provider has no count endpoint Nightloom asks, and the caller keeps its
/// estimate. An explicit `api_key` wins over the environment, as in
/// [`ProviderKind::build`]; `base_url` overrides the default endpoint.
pub async fn count_tokens(
    kind: ProviderKind,
    api_key: Option<String>,
    base_url: Option<String>,
    model: Option<String>,
    text: &str,
) -> Result<Option<u64>, ProviderError> {
    if kind != ProviderKind::Anthropic {
        return Ok(None);
    }
    let key = api_key.or_else(|| kind.key_from_env()).ok_or_else(|| {
        ProviderError::Config(format!("no API key available for provider {kind}"))
    })?;
    let model = model
        .filter(|m| !m.is_empty())
        .or_else(|| kind.default_model().map(String::from))
        .unwrap_or_default();
    let base = base_url.unwrap_or_else(|| crate::anthropic::DEFAULT_BASE_URL.into());
    let resp = reqwest::Client::new()
        .post(format!("{base}/v1/messages/count_tokens"))
        .header("x-api-key", key)
        .header("anthropic-version", crate::anthropic::API_VERSION)
        .json(&anthropic_count_body(&model, text))
        .send()
        .await
        .map_err(transport)?;
    if !resp.status().is_success() {
        return Err(api_error(resp).await);
    }
    let body: Value = resp.json().await.map_err(parse)?;
    read_input_tokens(&body).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn the_draft_goes_out_as_one_user_message() {
        assert_eq!(
            anthropic_count_body("claude-sonnet-5", "hello"),
            json!({
                "model": "claude-sonnet-5",
                "messages": [{ "role": "user", "content": "hello" }],
            })
        );
    }

    #[test]
    fn the_count_is_read_from_input_tokens() {
        assert_eq!(
            read_input_tokens(&json!({"input_tokens": 1240})).unwrap(),
            1240
        );
        assert!(read_input_tokens(&json!({"tokens": 1240})).is_err());
    }

    #[tokio::test]
    async fn providers_without_a_counter_keep_the_estimate() {
        for kind in ProviderKind::ALL {
            if kind == ProviderKind::Anthropic {
                continue;
            }
            let got = count_tokens(kind, Some("k".into()), None, None, "hi").await;
            assert_eq!(got.unwrap(), None, "{kind}");
        }
    }

    /// One canned HTTP exchange on a local port: the request as received, and
    /// the answer `count_tokens` made of the reply. No real API is called.
    async fn exchange(reply: &'static str) -> (String, Result<Option<u64>, ProviderError>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            // Read until the headers and the declared body have arrived.
            loop {
                let n = sock.read(&mut chunk).await.unwrap();
                buf.extend_from_slice(&chunk[..n]);
                let s = String::from_utf8_lossy(&buf).to_string();
                if let Some(end) = s.find("\r\n\r\n") {
                    let len = s[..end]
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if buf.len() >= end + 4 + len {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            sock.write_all(reply.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&buf).to_string()
        });
        let got = count_tokens(
            ProviderKind::Anthropic,
            Some("test-key".into()),
            Some(base),
            Some("claude-sonnet-5".into()),
            "count me",
        )
        .await;
        (server.await.unwrap(), got)
    }

    #[tokio::test]
    async fn anthropic_posts_to_count_tokens_and_reads_the_figure() {
        let body = r#"{"input_tokens":1240}"#;
        let reply: &'static str = Box::leak(
            format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            )
            .into_boxed_str(),
        );
        let (request, got) = exchange(reply).await;
        assert_eq!(got.unwrap(), Some(1240));
        assert!(
            request.starts_with("POST /v1/messages/count_tokens HTTP/1.1"),
            "{request}"
        );
        let lower = request.to_ascii_lowercase();
        assert!(lower.contains("x-api-key: test-key"));
        assert!(lower.contains("anthropic-version: 2023-06-01"));
        assert!(request.contains(r#""content":"count me""#));
        assert!(request.contains(r#""model":"claude-sonnet-5""#));
    }

    #[tokio::test]
    async fn a_refused_count_is_an_error_not_a_zero() {
        let (_, got) = exchange(
            "HTTP/1.1 401 Unauthorized\r\ncontent-length: 3\r\nconnection: close\r\n\r\nbad",
        )
        .await;
        assert!(
            matches!(got, Err(ProviderError::Api { status: 401, .. })),
            "{got:?}"
        );
    }

    #[tokio::test]
    async fn no_key_is_a_config_error_without_a_request() {
        // An env key would make this reach the network; skip then.
        if ProviderKind::Anthropic.has_credentials() {
            return;
        }
        let got = count_tokens(ProviderKind::Anthropic, None, None, None, "hi").await;
        assert!(matches!(got, Err(ProviderError::Config(_))), "{got:?}");
    }
}
