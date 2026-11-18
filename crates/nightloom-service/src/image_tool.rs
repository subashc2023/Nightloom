//! `generate_image`, a tool that is not built yet (nightshift item 823,
//! stage 1; blocker 2111, 2026-11-17).
//!
//! His words: build the mechanism for the model to call it "and then just
//! have it fail … then we can see like in practice, does that even ever
//! fire in the first place?" So every chat on both engines has the tool,
//! and a call **never touches the network**: it appends one JSON line to
//! `<config>/logs/image-tool-calls.jsonl` (time, chat, project, prompt, the
//! size and style asked) and fails with [`REPLY`], which tells the model to
//! draw it with code instead. Settings → Usage shows the count (total and
//! the last 14 days) and the prompts. Stage 2 — a real tool, with a company
//! asked of him then — only if the count is non-trivial after two weeks.
//!
//! A chat that writes nothing (incognito, ephemeral) has the tool too, so
//! its calls count, but its line carries no prompt, chat or project: that
//! chat promised to leave nothing of its words behind.
//!
//! Nothing in this file names a network client; a test holds it to that.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The tool's name; the CLI calls it `mcp__nightloom__generate_image`.
pub const TOOL_NAME: &str = "generate_image";

/// The log's file name, under `<config>/logs/`.
pub const LOG_FILE: &str = "image-tool-calls.jsonl";

/// What every call returns (as a failed call).
pub const REPLY: &str = "Image generation is not built yet — draw it with code instead (matplotlib, SVG, an HTML page).";

/// How far back the "recent" count reaches.
pub const RECENT_DAYS: i64 = 14;

/// How many calls the summary carries for reading, newest first.
pub const RECENT_CAP: usize = 200;

/// Where the log lives under a config dir.
pub fn log_path(config: &Path) -> PathBuf {
    config.join("logs").join(LOG_FILE)
}

/// One call, as one line of the log.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Call {
    /// When, RFC 3339 in local time.
    pub at: String,
    /// `claude-code` or `api`.
    #[serde(default)]
    pub engine: String,
    /// Nightloom's chat id, when the server or connection knew it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat: Option<String>,
    /// The project's name; `None` for an unfiled chat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// What the model asked for; `None` for a chat that writes nothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    /// The image it wanted edited, when it asked for an edit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edit: Option<String>,
    /// A chat that writes nothing: counted, its words not kept.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub private: bool,
}

/// `generate_image`, served to every chat. `Session`: it writes only
/// Nightloom's own log, so no approval card asks about it.
pub struct GenerateImage {
    config: PathBuf,
    engine: &'static str,
    chat: Option<String>,
    project: Option<String>,
    private: bool,
}

impl GenerateImage {
    /// `private` is a chat that writes nothing: its line keeps only the
    /// time, the engine and the size and style asked.
    pub fn new(
        config: PathBuf,
        engine: &'static str,
        chat: Option<String>,
        project: Option<String>,
        private: bool,
    ) -> Self {
        Self {
            config,
            engine,
            chat,
            project,
            private,
        }
    }

    /// The line one call writes.
    pub fn record(&self, input: &serde_json::Value) -> Call {
        let text = |k: &str| {
            input[k]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        let keep = |v: Option<String>| v.filter(|_| !self.private);
        Call {
            at: chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false),
            engine: self.engine.to_string(),
            chat: keep(self.chat.clone()),
            project: keep(self.project.clone()),
            prompt: keep(text("prompt")),
            size: text("size"),
            style: text("style"),
            edit: keep(text("edit")),
            private: self.private,
        }
    }
}

/// Append one call to the log, creating `logs/` if need be.
pub fn append(config: &Path, call: &Call) -> Result<(), String> {
    let path = log_path(config);
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let mut line = serde_json::to_string(call).map_err(|e| e.to_string())?;
    line.push('\n');
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| f.write_all(line.as_bytes()))
        .map_err(|e| format!("{}: {e}", path.display()))
}

#[async_trait::async_trait]
impl nightloom_core::tool::Tool for GenerateImage {
    fn effect(&self) -> nightloom_core::tool::Effect {
        nightloom_core::tool::Effect::Session
    }

    fn def(&self) -> nightloom_core::ToolDef {
        nightloom_core::ToolDef {
            name: TOOL_NAME.into(),
            description: "Generate a picture from a text prompt — an illustration, a photo-like \
                 image, a logo or icon — or edit an existing image. Only for a generated \
                 picture: a chart, plot, diagram or table is drawn with code, not with this. \
                 Not available yet: every call fails and is counted, so call it only when you \
                 would really want a generated image."
                .into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "description": "What the picture should show."},
                    "size": {"type": "string", "description": "Optional: the size or aspect wanted, e.g. 1024x1024 or 16:9."},
                    "style": {"type": "string", "description": "Optional: photo, illustration, icon, …"},
                    "edit": {"type": "string", "description": "Optional: the path of an image to edit instead of making a new one."}
                },
                "required": ["prompt"]
            }),
        }
    }

    async fn call(
        &self,
        input: serde_json::Value,
        _cancel: &nightloom_core::tool::CancellationToken,
    ) -> Result<String, String> {
        let call = self.record(&input);
        let config = self.config.clone();
        // A log that cannot be written is his loss of a count, never the
        // model's problem: the reply is the same either way.
        let written = tokio::task::spawn_blocking(move || append(&config, &call)).await;
        if let Ok(Err(e)) | Err(e) = written.map_err(|e| e.to_string()) {
            eprintln!("generate_image: the call was not logged: {e}");
        }
        Err(REPLY.to_string())
    }
}

/// What Settings shows: the count, and the calls to read.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Summary {
    pub total: usize,
    /// Calls in the last [`RECENT_DAYS`] days.
    pub recent: usize,
    pub recent_days: i64,
    /// Newest first, at most [`RECENT_CAP`].
    pub calls: Vec<Call>,
    /// The log's path, for "open the log".
    pub path: String,
}

/// Read the log. A missing log is zero calls; an unreadable line is skipped.
pub fn summary(config: &Path) -> Summary {
    summary_at(config, chrono::Local::now().fixed_offset())
}

/// [`summary`] as of `now`, for the tests.
pub fn summary_at(config: &Path, now: chrono::DateTime<chrono::FixedOffset>) -> Summary {
    let path = log_path(config);
    let text = fs::read_to_string(&path).unwrap_or_default();
    let all: Vec<Call> = text
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    let since = now - chrono::Duration::days(RECENT_DAYS);
    let recent = all
        .iter()
        .filter(|c| {
            chrono::DateTime::parse_from_rfc3339(&c.at).is_ok_and(|t| t >= since && t <= now)
        })
        .count();
    Summary {
        total: all.len(),
        recent,
        recent_days: RECENT_DAYS,
        calls: all.iter().rev().take(RECENT_CAP).cloned().collect(),
        path: path.display().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nightloom_core::tool::{CancellationToken, Effect, Tool};

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "nl-image-{name}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[tokio::test]
    async fn one_call_writes_one_line_and_returns_the_message() {
        let config = scratch("one");
        let tool = GenerateImage::new(
            config.clone(),
            "claude-code",
            Some("chat-1".into()),
            Some("Nightloom".into()),
            false,
        );
        let out = tool
            .call(
                serde_json::json!({"prompt": "a fox in snow", "size": "1024x1024", "style": "photo"}),
                &CancellationToken::new(),
            )
            .await;
        assert_eq!(out, Err(REPLY.to_string()));
        let text = fs::read_to_string(log_path(&config)).unwrap();
        assert_eq!(text.lines().count(), 1, "{text}");
        let call: Call = serde_json::from_str(text.lines().next().unwrap()).unwrap();
        assert_eq!(call.prompt.as_deref(), Some("a fox in snow"));
        assert_eq!(call.size.as_deref(), Some("1024x1024"));
        assert_eq!(call.style.as_deref(), Some("photo"));
        assert_eq!(call.chat.as_deref(), Some("chat-1"));
        assert_eq!(call.project.as_deref(), Some("Nightloom"));
        assert_eq!(call.engine, "claude-code");
        assert!(chrono::DateTime::parse_from_rfc3339(&call.at).is_ok());
        assert_eq!(tool.effect(), Effect::Session);
        let s = summary(&config);
        assert_eq!((s.total, s.recent), (1, 1));
        let _ = fs::remove_dir_all(&config);
    }

    #[tokio::test]
    async fn a_chat_that_writes_nothing_is_counted_without_its_words() {
        let config = scratch("private");
        let tool = GenerateImage::new(
            config.clone(),
            "api",
            Some("chat-2".into()),
            Some("P".into()),
            true,
        );
        let _ = tool
            .call(
                serde_json::json!({"prompt": "secret", "size": "16:9"}),
                &CancellationToken::new(),
            )
            .await;
        let text = fs::read_to_string(log_path(&config)).unwrap();
        assert!(
            !text.contains("secret") && !text.contains("chat-2"),
            "{text}"
        );
        let call: Call = serde_json::from_str(text.trim()).unwrap();
        assert!(call.private);
        assert_eq!(call.size.as_deref(), Some("16:9"));
        let _ = fs::remove_dir_all(&config);
    }

    #[test]
    fn the_summary_counts_all_and_the_last_fourteen_days_newest_first() {
        let config = scratch("summary");
        let now = chrono::DateTime::parse_from_rfc3339("2026-11-17T20:00:00-08:00").unwrap();
        for at in [
            "2026-10-01T10:00:00-07:00",
            "2026-11-10T10:00:00-08:00",
            "2026-11-17T19:00:00-08:00",
        ] {
            let call = Call {
                at: at.into(),
                engine: "api".into(),
                chat: None,
                project: None,
                prompt: Some(at.into()),
                size: None,
                style: None,
                edit: None,
                private: false,
            };
            append(&config, &call).unwrap();
        }
        let s = summary_at(&config, now);
        assert_eq!((s.total, s.recent, s.recent_days), (3, 2, 14));
        assert_eq!(s.calls[0].at, "2026-11-17T19:00:00-08:00");
        assert_eq!(summary(&scratch("empty")).total, 0);
        let _ = fs::remove_dir_all(&config);
    }

    /// No network client is reachable from the tool: this file names none
    /// (the words are built here so this test does not name them either).
    #[test]
    fn no_network_client_is_reachable_from_the_tool() {
        let source = include_str!("image_tool.rs");
        let body = source.split("#[cfg(test)]").next().unwrap();
        for word in [
            ["req", "west"].concat(),
            ["hy", "per"].concat(),
            ["ure", "q"].concat(),
            ["Tcp", "Stream"].concat(),
            ["http", "://"].concat(),
            ["https", "://"].concat(),
            ["Url", "Session"].concat(),
            ["cu", "rl"].concat(),
        ] {
            assert!(!body.contains(&word), "image_tool.rs names {word}");
        }
    }
}
