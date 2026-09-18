//! What a provider says is left on its key (nightshift backlog 149,
//! blocker 244, 2026-09-17).
//!
//! He asked for his OpenRouter credits inside Nightloom, and for the other
//! providers "not exposed" said plainly rather than a guess. Measured
//! against the live endpoints with his stored keys (`external`, one call
//! each, the report has the shapes): OpenRouter's `GET /api/v1/credits`
//! answers `{"data":{"total_credits":…,"total_usage":…}}` for a key, so
//! the remainder is the difference; Anthropic's, OpenAI's, Gemini's and
//! Groq's public APIs offer an ordinary key no balance — their consoles
//! do, behind a login — so those rows say `not exposed` and nothing is
//! fetched.

use serde::{Deserialize, Serialize};

use crate::ProviderKind;
use crate::credentials::provider_key;

/// One provider's row for Settings → Usage · Cost.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProviderCredit {
    pub kind: String,
    /// `available`, `not exposed`, `no key`, or `error`.
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remaining_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

fn row(kind: ProviderKind, status: &str) -> ProviderCredit {
    ProviderCredit {
        kind: kind.label().to_string(),
        status: status.into(),
        remaining_usd: None,
        used_usd: None,
        detail: None,
    }
}

/// Every provider Nightloom knows, in the settings' order, with what its
/// API says. Only OpenRouter is asked anything.
pub async fn provider_credits() -> Vec<ProviderCredit> {
    let mut out = Vec::new();
    for kind in [
        ProviderKind::Anthropic,
        ProviderKind::Openai,
        ProviderKind::Gemini,
        ProviderKind::Groq,
        ProviderKind::Openrouter,
    ] {
        let Some(key) = provider_key(kind) else {
            out.push(row(kind, "no key"));
            continue;
        };
        match kind {
            ProviderKind::Openrouter => out.push(openrouter(&key).await),
            _ => out.push(ProviderCredit {
                detail: Some("this provider's API shows a balance only in its console".into()),
                ..row(kind, "not exposed")
            }),
        }
    }
    out
}

#[derive(Deserialize)]
struct OpenRouterCredits {
    data: OpenRouterCreditsData,
}

#[derive(Deserialize)]
struct OpenRouterCreditsData {
    #[serde(default)]
    total_credits: f64,
    #[serde(default)]
    total_usage: f64,
}

/// `GET /api/v1/credits` (`external`, OpenRouter's reference): the credits
/// bought and the usage on the account, in dollars.
async fn openrouter(key: &str) -> ProviderCredit {
    let kind = ProviderKind::Openrouter;
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return ProviderCredit {
                detail: Some(e.to_string()),
                ..row(kind, "error")
            };
        }
    };
    let res = client
        .get("https://openrouter.ai/api/v1/credits")
        .bearer_auth(key)
        .send()
        .await;
    match res {
        Ok(r) if r.status().is_success() => match r.json::<OpenRouterCredits>().await {
            Ok(c) => ProviderCredit {
                kind: kind.label().to_string(),
                status: "available".into(),
                remaining_usd: Some(c.data.total_credits - c.data.total_usage),
                used_usd: Some(c.data.total_usage),
                detail: Some(format!("{:.2} bought", c.data.total_credits)),
            },
            Err(e) => ProviderCredit {
                detail: Some(format!("unexpected reply: {e}")),
                ..row(kind, "error")
            },
        },
        Ok(r) => ProviderCredit {
            detail: Some(format!("HTTP {}", r.status())),
            ..row(kind, "error")
        },
        Err(e) => ProviderCredit {
            detail: Some(e.to_string()),
            ..row(kind, "error")
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_openrouter_reply_shape_parses_and_the_remainder_is_the_difference() {
        let c: OpenRouterCredits =
            serde_json::from_str(r#"{"data":{"total_credits":25.0,"total_usage":3.5}}"#).unwrap();
        assert!((c.data.total_credits - c.data.total_usage - 21.5).abs() < 1e-9);
        let missing: OpenRouterCredits = serde_json::from_str(r#"{"data":{}}"#).unwrap();
        assert_eq!(missing.data.total_credits, 0.0);
    }
}
