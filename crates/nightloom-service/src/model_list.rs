//! The Claude Code models the pickers offer, and the away server's default
//! (nightshift item 272): a file he edits in Settings, so a model released
//! after the build is a choice without a new build.
//!
//! `<home>/model-list.json`:
//!
//! ```json
//! { "models": ["fable", "opus", "sonnet", "haiku"], "away_default": "sonnet" }
//! ```
//!
//! `models` are what the desktop's and the phone's pickers offer, in order
//! — the CLI's aliases or full ids (`--model` takes either; `claude --help`,
//! 2.1.286, lists no command that prints the models an account can reach,
//! so the list is his rather than the CLI's). `away_default` is the model a
//! turn on the away server runs on when the phone's rail names none; absent,
//! the server's `--model` (`NIGHTLOOM_SERVE_MODEL` on Fly) stands.
//!
//! One writer: the Mac (Settings → Subscription → Models). On the away
//! server the file is read from its own home first, then from the copy the
//! Mac's sync sends (`<home>/mirror/model-list.json`). No file, or one that
//! does not read, is the built-in list — a broken file costs the list, never
//! a turn.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The file's name under the Nightloom home (and under its `mirror/`).
pub const FILE: &str = "model-list.json";

/// The built-in list: the CLI's aliases, in its own order (the desktop's
/// `AGENT_MODELS` before item 272).
pub const BUILT_IN: &[&str] = &["fable", "opus", "sonnet", "haiku"];

/// What the file holds.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct ModelList {
    pub models: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub away_default: Option<String>,
}

impl Default for ModelList {
    fn default() -> Self {
        Self {
            models: BUILT_IN.iter().map(|s| s.to_string()).collect(),
            away_default: None,
        }
    }
}

impl ModelList {
    /// Trimmed, de-duplicated, empty entries dropped; an empty list is the
    /// built-in one (a picker with nothing in it offers only the CLI's
    /// default, which is never what an emptied file meant). An empty
    /// `away_default` is none.
    pub fn normalized(mut self) -> Self {
        let mut seen = Vec::new();
        for m in self.models.drain(..) {
            let m = m.trim().to_string();
            if !m.is_empty() && !seen.contains(&m) {
                seen.push(m);
            }
        }
        self.models = if seen.is_empty() {
            Self::default().models
        } else {
            seen
        };
        self.away_default = self
            .away_default
            .map(|d| d.trim().to_string())
            .filter(|d| !d.is_empty());
        self
    }

    /// The away server's model when the rail names none: this file's
    /// default, else `cli_model` (`--model`), else `None` (the CLI's own).
    pub fn default_or<'a>(&'a self, cli_model: Option<&'a str>) -> Option<&'a str> {
        self.away_default
            .as_deref()
            .or(cli_model.filter(|m| !m.trim().is_empty()))
    }
}

/// `<home>/model-list.json`.
pub fn path(home: &Path) -> PathBuf {
    home.join(FILE)
}

/// The mirrored copy on the away server: `<home>/mirror/model-list.json`.
pub fn mirror_path(home: &Path) -> PathBuf {
    home.join(crate::sync::MIRROR_DIR).join(FILE)
}

fn read(path: &Path) -> Option<ModelList> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<ModelList>(&text)
        .ok()
        .map(ModelList::normalized)
}

/// The list as the pickers read it: the home's file, else the mirrored
/// copy, else the built-in list.
pub fn load(home: &Path) -> ModelList {
    read(&path(home))
        .or_else(|| read(&mirror_path(home)))
        .unwrap_or_default()
}

/// Write the list (normalized) atomically to `<home>/model-list.json`.
pub fn save(home: &Path, list: &ModelList) -> Result<ModelList, String> {
    let list = list.clone().normalized();
    let path = path(home);
    std::fs::create_dir_all(home).map_err(|e| format!("cannot create {}: {e}", home.display()))?;
    let text = serde_json::to_string_pretty(&list)
        .map_err(|e| format!("cannot encode the model list: {e}"))?;
    let tmp = home.join(format!(".{FILE}.{}.tmp", uuid::Uuid::new_v4()));
    let written = std::fs::File::create(&tmp).and_then(|mut f| {
        f.write_all(text.as_bytes())?;
        f.write_all(b"\n")?;
        f.sync_all()
    });
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("cannot write {}: {e}", tmp.display()));
    }
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("cannot replace {}: {e}", path.display())
    })?;
    Ok(list)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("nightloom-model-list-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn no_file_is_the_built_in_list() {
        let home = scratch();
        let list = load(&home);
        assert_eq!(list.models, BUILT_IN);
        assert_eq!(list.away_default, None);
        assert_eq!(
            list.default_or(Some("claude-sonnet-5-5")),
            Some("claude-sonnet-5-5")
        );
    }

    #[test]
    fn a_model_added_to_the_file_is_offered_without_a_build() {
        let home = scratch();
        std::fs::write(
            path(&home),
            r#"{"models": ["sonnet", " claude-fake-9 ", "sonnet", ""], "away_default": "claude-fake-9"}"#,
        )
        .unwrap();
        let list = load(&home);
        assert_eq!(list.models, vec!["sonnet", "claude-fake-9"]);
        assert_eq!(
            list.default_or(Some("claude-sonnet-5-5")),
            Some("claude-fake-9")
        );
    }

    #[test]
    fn the_mirror_is_read_when_the_home_has_none_and_a_broken_file_is_the_built_in() {
        let home = scratch();
        std::fs::create_dir_all(home.join(crate::sync::MIRROR_DIR)).unwrap();
        std::fs::write(mirror_path(&home), r#"{"models": ["opus-from-the-mac"]}"#).unwrap();
        assert_eq!(load(&home).models, vec!["opus-from-the-mac"]);
        std::fs::write(path(&home), "{ not json").unwrap();
        // The home's own file wins when it reads; a broken one falls through.
        assert_eq!(load(&home).models, vec!["opus-from-the-mac"]);
    }

    #[test]
    fn save_round_trips_and_an_emptied_list_is_the_built_in() {
        let home = scratch();
        let saved = save(
            &home,
            &ModelList {
                models: vec!["haiku".into(), "claude-fake-9".into()],
                away_default: Some("  ".into()),
            },
        )
        .unwrap();
        assert_eq!(saved.away_default, None);
        assert_eq!(load(&home), saved);
        let emptied = save(
            &home,
            &ModelList {
                models: vec![],
                away_default: None,
            },
        )
        .unwrap();
        assert_eq!(emptied.models, BUILT_IN);
    }
}
