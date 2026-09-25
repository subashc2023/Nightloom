//! The composer's exact token count (nightshift backlog 155): one command,
//! asked by the composer once a long draft on the provider engine has been
//! still for a moment. The Claude Code engine never asks — it has no count
//! endpoint — and keeps the estimate.

use nightloom_service::ProviderKind;
use nightloom_service::credentials;

/// The draft's exact size on `provider`'s `model`, or `None` where the
/// provider has no counter Nightloom asks (everything but Anthropic today).
/// An error — no key, a refused or failed request — is returned as text; the
/// composer then keeps its estimate and says nothing more.
#[tauri::command]
pub async fn count_draft_tokens(
    provider: String,
    model: Option<String>,
    base_url: Option<String>,
    text: String,
) -> Result<Option<u64>, String> {
    let kind: ProviderKind = provider.parse()?;
    nightloom_service::count_tokens(
        kind,
        credentials::provider_key(kind),
        base_url,
        model,
        &text,
    )
    .await
    .map_err(|e| e.to_string())
}
