use crate::{Anthropic, Gemini, OpenAiCompat, OpenAiResponses};
use nightloom_core::{Provider, ProviderError};
use std::fmt;
use std::str::FromStr;

/// Every provider Nightloom can construct from environment credentials.
/// The big 4 (Anthropic, OpenAI, Gemini, Groq) get native adapters;
/// OpenRouter is the gateway layer for everything else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ProviderKind {
    Anthropic,
    /// OpenAI via its native Responses API (streams reasoning summaries).
    Openai,
    /// Generic `chat/completions` — OpenAI legacy endpoint and local servers
    /// (Ollama, llama.cpp, LM Studio, vLLM) via `--base-url`.
    OpenaiChat,
    Gemini,
    Groq,
    Openrouter,
}

impl ProviderKind {
    pub const ALL: [ProviderKind; 6] = [
        Self::Anthropic,
        Self::Openai,
        Self::OpenaiChat,
        Self::Gemini,
        Self::Groq,
        Self::Openrouter,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Self::Anthropic => "anthropic",
            Self::Openai => "openai",
            Self::OpenaiChat => "openai-chat",
            Self::Gemini => "gemini",
            Self::Groq => "groq",
            Self::Openrouter => "openrouter",
        }
    }

    /// The environment variable a user would set for this provider — the
    /// first one, where several are accepted. Public because a shell has to
    /// *name* it: "no key for anthropic (set ANTHROPIC_API_KEY)" is the whole
    /// content of the message, and a shell deriving that string itself would
    /// be a second copy of this table to keep in step.
    pub fn env_key(self) -> &'static str {
        self.env_keys()[0]
    }

    fn env_keys(self) -> &'static [&'static str] {
        match self {
            Self::Anthropic => &["ANTHROPIC_API_KEY"],
            Self::Openai | Self::OpenaiChat => &["OPENAI_API_KEY"],
            Self::Gemini => &["GEMINI_API_KEY", "GOOGLE_API_KEY"],
            Self::Groq => &["GROQ_API_KEY"],
            Self::Openrouter => &["OPENROUTER_API_KEY"],
        }
    }

    /// This provider's key from the environment.
    ///
    /// Public because credential resolution is stated in one place
    /// (`nightloom_service::credentials`), and a resolver that could read
    /// the store but not the environment would have to leave half the order
    /// to whoever called it next.
    pub fn key_from_env(self) -> Option<String> {
        self.env_keys()
            .iter()
            .find_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty()))
    }

    /// Whether credentials for this provider are present in the environment.
    pub fn has_credentials(self) -> bool {
        self.key_from_env().is_some()
    }

    /// Model used when the caller doesn't name one. `None` means the caller
    /// must be explicit (generic compat has no sensible default).
    pub fn default_model(self) -> Option<&'static str> {
        match self {
            Self::Anthropic => Some("claude-sonnet-5"),
            Self::Openai => Some("gpt-5-mini"),
            Self::OpenaiChat => None,
            Self::Gemini => Some("gemini-2.5-flash"),
            Self::Groq => Some("openai/gpt-oss-120b"),
            Self::Openrouter => Some("openrouter/auto"),
        }
    }

    /// Build the adapter using credentials from the environment. `base_url`
    /// overrides the default endpoint.
    pub fn from_env(self, base_url: Option<String>) -> Result<Box<dyn Provider>, ProviderError> {
        self.build(None, base_url)
    }

    /// Build the adapter. An explicit `api_key` (e.g. one the user stored in
    /// a shell's settings) wins over environment credentials; `base_url`
    /// overrides the default endpoint.
    pub fn build(
        self,
        api_key: Option<String>,
        base_url: Option<String>,
    ) -> Result<Box<dyn Provider>, ProviderError> {
        let key = api_key.or_else(|| self.key_from_env());
        let missing = || ProviderError::Config(format!("{} is not set", self.env_keys()[0]));
        Ok(match self {
            Self::Anthropic => Box::new(Anthropic::new(key.ok_or_else(missing)?, base_url)),
            Self::Openai => Box::new(OpenAiResponses::new(key.ok_or_else(missing)?, base_url)),
            Self::OpenaiChat => {
                // A local server needs no key, but pointing at api.openai.com
                // without one is always a mistake.
                if key.is_none() && base_url.is_none() {
                    return Err(ProviderError::Config(
                        "OPENAI_API_KEY is not set (or pass --base-url for a local server)".into(),
                    ));
                }
                Box::new(OpenAiCompat::new(key.unwrap_or_default(), base_url))
            }
            Self::Gemini => Box::new(Gemini::new(key.ok_or_else(missing)?, base_url)),
            Self::Groq => Box::new(OpenAiCompat::groq(key.ok_or_else(missing)?, base_url)),
            Self::Openrouter => {
                Box::new(OpenAiCompat::openrouter(key.ok_or_else(missing)?, base_url))
            }
        })
    }
}

impl fmt::Display for ProviderKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.label())
    }
}

impl FromStr for ProviderKind {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "anthropic" => Ok(Self::Anthropic),
            "openai" => Ok(Self::Openai),
            "openai-chat" | "compat" => Ok(Self::OpenaiChat),
            "gemini" | "google" => Ok(Self::Gemini),
            "groq" => Ok(Self::Groq),
            "openrouter" => Ok(Self::Openrouter),
            other => Err(format!(
                "unknown provider {other:?} (expected anthropic|openai|openai-chat|gemini|groq|openrouter)"
            )),
        }
    }
}
