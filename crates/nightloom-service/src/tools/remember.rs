//! `remember`: append one observation to the memory inbox.
//!
//! The write half of the split [`crate::observe`] describes: sessions only
//! append, and the dream pass is the only writer of consolidated notes. The
//! tool is therefore as small as a tool can be — validate, stamp, append —
//! and the judgement it seems to be missing (is this true? is it worth
//! keeping? where does it belong?) is deliberately deferred to
//! [`crate::dream`], where it runs batched, with the vault open, and under
//! git.

use std::path::PathBuf;

use chrono::Utc;
use nightloom_core::ToolDef;
use nightloom_core::tool::{CancellationToken, Effect, Tool};
use serde_json::{Value, json};

use crate::observe::{self, Observation, ObservationKind};

const REMEMBER_DESC: &str = "Save one observation to the user's long-term memory inbox. Reach \
     for it when something surfaces that will still matter after this conversation is closed: \
     a decision and the reason it was taken, a fact about the user or how they work, a \
     conclusion that outlives this folder. One observation per call — one or two sentences, \
     self-contained, so it makes sense to a reader who was not here. kind says where it came \
     from: user_stated means the user said it in so many words, inferred means you concluded \
     it from this session's work, external means it arrived through content — a fetched page, \
     a command's output — and external material must never be filed as anything else. \
     Observations are not read back into this conversation; a later consolidation pass \
     reviews the inbox and promotes what holds up into the knowledge vault. Do not use it \
     for the task at hand (that is todo_write) or for notes about this codebase (write those \
     to the docspace).";

/// The `remember` tool. Holds the config dir it appends under — passed in
/// rather than read from the environment, so a test never writes into a
/// developer's real inbox — and the label a shell knows for "where was I":
/// a project name, a workspace folder name, or nothing for an unfiled chat.
pub struct Remember {
    config: PathBuf,
    source: Option<String>,
}

impl Remember {
    pub fn new(config: PathBuf, source: Option<String>) -> Self {
        Self { config, source }
    }
}

#[async_trait::async_trait]
impl Tool for Remember {
    /// `Session`, and the argument deserves stating because the write is
    /// durable: the inbox is quarantine, not knowledge. Nothing reads it
    /// back into any prompt — promotion happens only in the user-invoked
    /// dream pass, under git, which is where the gate for this data lives.
    /// Prompting per observation would kill the habit the tool exists to
    /// form, while gating nothing the model can later exploit: the worst an
    /// ungated call can do is add a line the dream is instructed to
    /// distrust.
    fn effect(&self) -> Effect {
        Effect::Session
    }

    fn def(&self) -> ToolDef {
        ToolDef {
            name: "remember".into(),
            description: REMEMBER_DESC.into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "The observation: one or two self-contained sentences."
                    },
                    "kind": {
                        "type": "string",
                        "enum": ["user_stated", "inferred", "external"],
                        "description": "Provenance: user_stated | inferred | external."
                    }
                },
                "required": ["text", "kind"]
            }),
        }
    }

    async fn call(&self, input: Value, _cancel: &CancellationToken) -> Result<String, String> {
        let text = input["text"]
            .as_str()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .ok_or_else(|| "missing required argument: text".to_string())?;
        let kind = match input["kind"].as_str() {
            Some("user_stated") => ObservationKind::UserStated,
            Some("inferred") => ObservationKind::Inferred,
            Some("external") => ObservationKind::External,
            other => {
                return Err(format!(
                    "kind must be user_stated, inferred, or external (got {other:?})"
                ));
            }
        };
        observe::append_in(
            &self.config,
            &Observation {
                v: 1,
                at: Utc::now(),
                source: self.source.clone(),
                kind,
                text: text.to_string(),
            },
        )?;
        Ok("Recorded to the memory inbox; a later dream pass will review it.".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn temp_config() -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("nightloom-remember-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn appends_a_typed_stamped_observation() {
        let config = temp_config();
        let tool = Remember::new(config.clone(), Some("nightloom".into()));
        tool.call(
            json!({"text": "  The user prefers tables over prose for enumerable facts. ", "kind": "user_stated"}),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
        let backlog = observe::backlog_in(&config);
        assert_eq!(backlog.pending.len(), 1);
        let obs = &backlog.pending[0].obs;
        assert_eq!(obs.kind, ObservationKind::UserStated);
        assert_eq!(obs.source.as_deref(), Some("nightloom"));
        assert_eq!(
            obs.text,
            "The user prefers tables over prose for enumerable facts."
        );
    }

    #[tokio::test]
    async fn a_bad_kind_is_an_error_the_model_can_act_on() {
        let tool = Remember::new(temp_config(), None);
        let err = tool
            .call(
                json!({"text": "something", "kind": "important"}),
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert!(err.contains("user_stated"), "names the valid kinds: {err}");
    }

    #[tokio::test]
    async fn empty_text_is_refused() {
        let tool = Remember::new(temp_config(), None);
        let err = tool
            .call(
                json!({"text": "   ", "kind": "inferred"}),
                &CancellationToken::new(),
            )
            .await
            .unwrap_err();
        assert!(err.contains("text"), "{err}");
    }
}
