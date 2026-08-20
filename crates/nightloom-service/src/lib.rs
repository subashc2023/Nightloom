//! nightloom-service: UI-agnostic conversation orchestration over sessions,
//! providers, and tools.
//!
//! Both the CLI REPL and the desktop app drive turns through this crate. It
//! renders nothing and reads no input: streaming progress goes out through a
//! [`TurnEvent`] callback, and interruption comes in through a cancellation
//! token — whatever those mean (stdout + Ctrl-C, IPC events + a button) is
//! the shell's business.

pub mod agent;
pub mod approval;
pub mod credentials;
pub mod import;
pub mod project;
pub mod prompt;
pub mod sidecar;
pub mod store;
pub mod tools;
pub mod turn;

pub use agent::{AgentError, AgentOutcome, AgentSpec, ClaudeCodeAgent, Recorder};
pub use approval::{Approver, AutoApprove, Decision, PendingCall};
pub use credentials::{CredentialError, KeySource, provider_key, search_key};
pub use nightloom_providers::ProviderKind;
pub use nightloom_providers::limits::context_limit;
pub use nightloom_providers::models::list_models;
pub use nightloom_providers::pricing::{Price, price};
/// MCP: tools that live in another process.
///
/// Re-exported rather than wrapped. A shell needs the config type to discover
/// servers, the report type to say which ones failed, and nothing in between
/// that this crate could usefully add.
pub mod mcp {
    pub use nightloom_mcp::{McpConfig, McpError, McpTool, ServerReport, ServerSpec, connect_all};
}
pub use project::{Note, Project, Registry};
pub use prompt::{ProjectContext, PromptConfig, assemble};
pub use sidecar::{SidecarContext, SidecarPart};
pub use turn::{Chat, CompactOutcome, TurnEvent, TurnInput, TurnOutcome};

use nightloom_core::{Provider, ProviderError};
use nightloom_providers::retry::{Retry, RetryNotify};

/// Build a provider and resolve the model, wrapped in retry-on-open
/// (transient failures back off before anything has streamed; mid-stream
/// errors still surface). An explicit `api_key` wins over environment
/// credentials. `on_retry` lets the shell report the stall.
pub fn connect(
    kind: ProviderKind,
    model: Option<String>,
    api_key: Option<String>,
    base_url: Option<String>,
    on_retry: Option<RetryNotify>,
) -> Result<(Box<dyn Provider>, String), ProviderError> {
    let provider = kind.build(api_key, base_url)?;
    let Some(model) = model.or_else(|| kind.default_model().map(String::from)) else {
        return Err(ProviderError::Config(format!(
            "a model is required for provider {kind}"
        )));
    };
    let mut retry = Retry::new(provider);
    if let Some(notify) = on_retry {
        retry = retry.on_retry(notify);
    }
    Ok((Box::new(retry), model))
}
