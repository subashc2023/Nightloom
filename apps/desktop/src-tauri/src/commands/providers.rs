//! Provider commands: providers and API keys, search backends, models and context limits (moved from main.rs, item 642).

#[allow(unused_imports)]
use crate::*;

/// Every provider Nightloom knows, with whether credentials are present
/// (stored in-app or in the environment).
#[tauri::command]
pub(crate) fn providers() -> Vec<ProviderInfo> {
    ProviderKind::ALL
        .into_iter()
        .map(|kind| ProviderInfo {
            kind: kind.label().to_string(),
            available: credentials::provider_key_source(kind).is_some(),
            default_model: kind.default_model().map(String::from),
            key_source: credentials::provider_key_source(kind),
        })
        .collect()
}

/// Store (or, with an empty key, remove) an API key in the OS credential
/// store. The key is write-only from the UI's perspective: it is never sent
/// back, only its presence (`key_source`) is.
#[tauri::command]
pub(crate) fn set_api_key(provider: String, key: String) -> Result<(), String> {
    let kind: ProviderKind = provider.parse()?;
    credentials::set_provider_key(kind, &key).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn clear_api_key(provider: String) -> Result<(), String> {
    let kind: ProviderKind = provider.parse()?;
    credentials::clear_provider_key(kind).map_err(|e| e.to_string())
}

/// A search backend as the settings pane shows it.
#[derive(Serialize)]
pub(crate) struct SearchBackendInfo {
    name: String,
    label: String,
    /// Named in the UI because it is the other way to set this, and the one
    /// a user who scripts the CLI already uses.
    env_key: String,
    key_source: Option<KeySource>,
    /// Where this backend sits in the chain, 1-based, or `None` with no key.
    /// A position rather than a flag because every key is used: they are
    /// asked in turn, and a pane showing three filled boxes with no hint of
    /// the order would leave the reader to guess at the whole behaviour.
    order: Option<u32>,
}

/// The search backends, with whether each has a key and where in the chain
/// `web_search` will reach it.
#[tauri::command]
pub(crate) fn search_backends() -> Vec<SearchBackendInfo> {
    let chain = nightloom_service::tools::search_backends(credentials::search_key);
    SearchBackend::ALL
        .into_iter()
        .map(|backend| SearchBackendInfo {
            name: backend.name().to_string(),
            label: backend.label().to_string(),
            env_key: backend.env_key().to_string(),
            key_source: credentials::search_key_source(backend),
            order: chain
                .iter()
                .position(|b| *b == backend)
                .map(|i| i as u32 + 1),
        })
        .collect()
}

/// Store (or, with an empty key, remove) a search backend's API key.
/// Write-only from the UI's perspective, exactly like a provider key.
#[tauri::command]
pub(crate) fn set_search_key(backend: String, key: String) -> Result<(), String> {
    let backend = SearchBackend::from_name(&backend)
        .ok_or_else(|| format!("no search backend named {backend}"))?;
    credentials::set_search_key(backend, &key).map_err(|e| e.to_string())
}

/// Model ids the provider's API currently offers (for the settings modal).
#[tauri::command]
pub(crate) async fn list_models(
    provider: String,
    base_url: Option<String>,
) -> Result<Vec<String>, String> {
    let kind: ProviderKind = provider.parse()?;
    let key = credentials::stored_provider_key(kind);
    nightloom_service::list_models(kind, key, base_url)
        .await
        .map_err(|e| e.to_string())
}

/// Context windows for a batch of model ids on one provider, from the static
/// limits table — `None` where the table does not know the model. The model
/// popover and the Settings picker print these beside each id (chat-surface
/// redesign, 2026-09-13); one round trip per list rather than one per row.
#[tauri::command]
pub(crate) fn context_limits(
    provider: String,
    models: Vec<String>,
) -> Result<Vec<Option<u64>>, String> {
    let kind: ProviderKind = provider.parse()?;
    Ok(models
        .iter()
        .map(|m| nightloom_service::context_limit(kind, m))
        .collect())
}
