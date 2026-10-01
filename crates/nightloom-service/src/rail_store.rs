//! The away server's rail (nightshift item 246, wave 4 4A; item 268): the
//! engine and turn settings the phone's Rail sheet shows, kept as a JSON
//! file under the Nightloom home — `<home>/serve/rail.json` — since
//! `nightloom serve` has no window whose state could hold them.
//!
//! The file holds only the settings, never the connection's state
//! (`connected`, `deferred`, …): those are computed when the rail is read.
//! A missing file is the defaults; a file that cannot be read or parsed is
//! an error, and a patch is then refused rather than written over it (the
//! registry's rule, backlog 219: an empty reading is not what the file
//! holds). A save writes a temporary file beside it and renames it over, so
//! a crash mid-write leaves the old file whole.
//!
//! Blocker 666's default bounds what a patch may change: the engine and the
//! turn settings, yes; keys, folder pickers and the CLI update, no.
//! [`RailPatch`] cannot name the second group at all; [`check_patch_json`]
//! refuses a body that tries, with a sentence, for a listener that wants to
//! say why rather than drop the field silently. On this host the API engine
//! and fork mode are refused too — `serve` runs Claude Code only and has no
//! checkpoint helper (268 step 1).

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::agent::AgentSpec;
use crate::agent::brief::SubagentLimits;
use crate::model_list::{self, ModelList};
use crate::remote::api::{Rail, RailCouncil, RailPatch};

/// The folder under the home the away server keeps its own state in.
pub const SERVE_DIR: &str = "serve";
/// The rail's file in it.
pub const RAIL_FILE: &str = "rail.json";

/// The effort positions the Mac's rail offers (`remoteHandlers.ts`
/// `EFFORTS`); empty is the CLI's own.
pub const EFFORTS: &[&str] = &["", "low", "medium", "high", "xhigh", "max"];

/// A council's seat count, as the Mac's council sheet bounds it
/// (`council::MIN_SEATS`; the most is `council.ts`'s `MAX_SEATS`).
pub const MIN_SEATS: usize = crate::council::MIN_SEATS;
pub const MAX_SEATS: usize = 6;

/// The one engine this host runs.
pub const ENGINE: &str = "claude-code";

/// Fields a phone may never set (blocker 666's default): keys, folder
/// choices, the CLI update. Named so a body carrying one is refused with
/// a sentence instead of the field being dropped unseen.
const MAC_ONLY: &[&str] = &[
    "provider",
    "api_key",
    "api_keys",
    "key",
    "keys",
    "search_key",
    "workspace",
    "projects_folder",
    "knowledge_folder",
    "vault",
    "folder",
    "folders",
    "import",
    "cli_update",
    "update",
    "approval",
];

/// What `<home>/serve/rail.json` holds: the settings only.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct RailSettings {
    pub version: u32,
    pub engine: String,
    /// The CLI's model alias; empty is the server's `--model` (or the
    /// CLI's default when that is absent too).
    pub model: String,
    pub effort: String,
    pub fallback: String,
    /// The API engine's thinking mode — kept for the Mac's shape; it does
    /// nothing on Claude Code.
    pub thinking: String,
    /// The subagent limits, `None` until a patch names one: the turn then
    /// runs on [`SubagentLimits::default`], as it did before the file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limits: Option<serde_json::Value>,
    pub ask: bool,
    pub plan: bool,
    pub subagents_auto: bool,
    pub fork_mode: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub council: Option<RailCouncil>,
    /// The pickers' models and the away default (item 272), read from
    /// `model-list.json` when the rail is loaded — never written here.
    #[serde(skip)]
    pub model_list: ModelList,
}

impl Default for RailSettings {
    /// What `serve` did before the file existed: Claude Code, `--model`,
    /// the CLI's effort, the Ask position (when it has the hook), subagents
    /// on auto, no fork mode, no council.
    fn default() -> Self {
        Self {
            version: 1,
            engine: ENGINE.into(),
            model: String::new(),
            effort: String::new(),
            fallback: String::new(),
            thinking: String::new(),
            limits: None,
            ask: true,
            plan: false,
            subagents_auto: crate::agent::ask::SUBAGENTS_AUTO_DEFAULT,
            fork_mode: false,
            council: None,
            model_list: ModelList::default(),
        }
    }
}

/// `<home>/serve/rail.json`.
pub fn path(home: &Path) -> PathBuf {
    home.join(SERVE_DIR).join(RAIL_FILE)
}

/// The saved settings: the defaults when there is no file; an error with
/// the file's path when there is one that does not read.
pub fn load(home: &Path) -> Result<RailSettings, String> {
    let path = path(home);
    match std::fs::read_to_string(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(RailSettings::default()),
        Err(e) => Err(format!(
            "the away server's rail ({}) could not be read: {e}",
            path.display()
        )),
        Ok(text) => serde_json::from_str(&text).map_err(|e| {
            format!(
                "the away server's rail ({}) did not read ({e}); it is left as it is",
                path.display()
            )
        }),
    }
    .map(|mut s: RailSettings| {
        s.model_list = model_list::load(home);
        s
    })
}

/// The saved settings, or the defaults when the file does not read — what
/// a turn runs on: a broken settings file costs the settings, not the turn.
pub fn load_or_default(home: &Path) -> RailSettings {
    load(home).unwrap_or_else(|_| RailSettings {
        model_list: model_list::load(home),
        ..RailSettings::default()
    })
}

/// Write `settings` atomically: a temporary file beside the real one, then
/// a rename over it.
pub fn save(home: &Path, settings: &RailSettings) -> Result<(), String> {
    let path = path(home);
    let dir = path.parent().unwrap_or(home);
    std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let text = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("cannot encode the rail: {e}"))?;
    let tmp = dir.join(format!(".{RAIL_FILE}.{}.tmp", uuid::Uuid::new_v4()));
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
    })
}

/// Refuse a raw `POST /api/rail` body that names a Mac-only setting
/// (blocker 666). For a listener that reads the body as JSON before it
/// becomes a [`RailPatch`] (which would drop such a field unseen).
pub fn check_patch_json(body: &serde_json::Value) -> Result<(), String> {
    let Some(map) = body.as_object() else {
        return Err("a rail change is a JSON object of the settings to change".into());
    };
    if let Some(k) = map.keys().find(|k| MAC_ONLY.contains(&k.as_str())) {
        return Err(format!(
            "`{k}` is changed on the Mac only — keys, folders and the CLI update never \
             come from the phone"
        ));
    }
    Ok(())
}

/// Check `patch` whole before any of it lands (the Mac's `checkRail`), so
/// a bad field changes nothing.
pub fn check(patch: &RailPatch) -> Result<(), String> {
    if let Some(engine) = &patch.engine {
        match engine.as_str() {
            ENGINE => {}
            "provider" => {
                return Err("the away server runs Claude Code only; the API engine is \
                            chosen on the Mac"
                    .into());
            }
            other => return Err(format!("no engine {other}")),
        }
    }
    if let Some(effort) = &patch.effort
        && !EFFORTS.contains(&effort.as_str())
    {
        return Err(format!("no effort level {effort}"));
    }
    if patch.fork_mode == Some(true) {
        return Err(
            "fork mode needs the checkpoint helper, which the away server does not have".into(),
        );
    }
    if let Some(council) = &patch.council {
        let n = council.seats.len();
        if !(MIN_SEATS..=MAX_SEATS).contains(&n) {
            return Err(format!("a council has {MIN_SEATS} to {MAX_SEATS} seats"));
        }
        if council.seats.iter().any(|s| s.model.trim().is_empty()) {
            return Err("every council seat needs a model".into());
        }
    }
    if let Some(limits) = &patch.limits {
        let Some(map) = limits.as_object() else {
            return Err("the limits are an object of the limits to change".into());
        };
        for (k, v) in map {
            if k == "off" || k == "model" {
                continue;
            }
            if !v.as_f64().is_some_and(|n| n.is_finite() && n >= 0.0) {
                return Err(format!("the limit {k} must be a number from 0"));
            }
        }
    }
    Ok(())
}

/// Merge `limits` into `base` key by key (`off` merged one level down),
/// then check the result reads as the turn's [`SubagentLimits`].
fn merge_limits(
    base: Option<&serde_json::Value>,
    patch: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut out = match base {
        Some(v) if v.is_object() => v.clone(),
        _ => serde_json::to_value(SubagentLimits::default()).map_err(|e| e.to_string())?,
    };
    let (Some(out_map), Some(patch_map)) = (out.as_object_mut(), patch.as_object()) else {
        return Err("the limits are an object of the limits to change".into());
    };
    for (k, v) in patch_map {
        match (k.as_str(), out_map.get_mut(k), v.as_object()) {
            ("off", Some(serde_json::Value::Object(old)), Some(new)) => {
                for (ok, ov) in new {
                    old.insert(ok.clone(), ov.clone());
                }
            }
            _ => {
                out_map.insert(k.clone(), v.clone());
            }
        }
    }
    serde_json::from_value::<SubagentLimits>(out.clone())
        .map_err(|e| format!("the limits did not read: {e}"))?;
    Ok(out)
}

impl RailSettings {
    /// Merge `patch` into these settings (checked first; nothing changes on
    /// a refusal).
    pub fn merged(&self, patch: &RailPatch) -> Result<Self, String> {
        check(patch)?;
        let mut out = self.clone();
        if let Some(v) = &patch.engine {
            out.engine = v.clone();
        }
        if let Some(v) = &patch.model {
            out.model = v.trim().to_string();
        }
        if let Some(v) = &patch.effort {
            out.effort = v.clone();
        }
        if let Some(v) = &patch.fallback {
            out.fallback = v.trim().to_string();
        }
        if let Some(v) = &patch.thinking {
            out.thinking = v.clone();
        }
        if let Some(v) = &patch.limits {
            out.limits = Some(merge_limits(self.limits.as_ref(), v)?);
        }
        if let Some(v) = patch.ask {
            out.ask = v;
        }
        if let Some(v) = patch.plan {
            out.plan = v;
        }
        if let Some(v) = patch.subagents_auto {
            out.subagents_auto = v;
        }
        if let Some(v) = patch.fork_mode {
            out.fork_mode = v;
        }
        if let Some(v) = &patch.council {
            out.council = Some(v.clone());
        }
        Ok(out)
    }

    /// The rail as the phone reads it. `cli_model` is the server's
    /// `--model`, shown when no model is saved and `model-list.json` names
    /// no away default (item 272); `busy` says a turn is
    /// running, which keeps its settings — a change applies from the next
    /// turn (`deferred`, as on the Mac).
    pub fn to_rail(&self, cli_model: Option<&str>, busy: bool) -> Rail {
        Rail {
            engine: self.engine.clone(),
            provider: String::new(),
            model: if self.model.is_empty() {
                self.model_list
                    .default_or(cli_model)
                    .unwrap_or_default()
                    .to_string()
            } else {
                self.model.clone()
            },
            models: self.model_list.models.clone(),
            effort: self.effort.clone(),
            fallback: self.fallback.clone(),
            thinking: self.thinking.clone(),
            limits: self.limits.clone().unwrap_or_else(|| {
                serde_json::to_value(SubagentLimits::default()).unwrap_or_default()
            }),
            approval: true,
            ask: self.ask,
            plan: self.plan,
            subagents_auto: self.subagents_auto,
            fork_mode: self.fork_mode,
            council: self.council.clone(),
            // No connection to hold: every turn starts its own CLI.
            connected: true,
            connecting: false,
            deferred: busy,
            error: None,
            extra: serde_json::Map::new(),
        }
    }

    /// The model, effort, fallback and limits a turn runs on: the saved
    /// model, else `model-list.json`'s away default (item 272), else
    /// `cli_model` (`--model`), else the CLI's default. Call
    /// where `spec.model` is set, before the preamble reads it.
    pub fn apply_model(&self, spec: &mut AgentSpec, cli_model: Option<&str>) {
        spec.model = Some(self.model.as_str())
            .filter(|m| !m.is_empty())
            .or(self.model_list.default_or(cli_model))
            .map(str::to_string);
        spec.effort = Some(self.effort.clone()).filter(|e| !e.is_empty());
        spec.fallback_model = Some(self.fallback.clone()).filter(|f| !f.is_empty());
        if let Some(limits) = &self.limits
            && let Ok(parsed) = serde_json::from_value::<SubagentLimits>(limits.clone())
        {
            spec.subagent_limits = Some(parsed);
        }
    }

    /// The Ask / Plan position and *subagents on auto*, on a spec whose Ask
    /// hook is already set (the desktop's mapping: Plan only with Ask; Ask
    /// off is no hook, the CLI's `auto`, and the MCP server without
    /// `--ask`). Nothing to do on a spec with no hook — this binary could
    /// not be the hook, so nothing was ever asked.
    pub fn apply_ask(&self, spec: &mut AgentSpec) {
        if !self.ask {
            if spec.ask.take().is_some() {
                spec.mcp_config = spec.mcp_config.take().map(|c| without_ask_flag(&c));
            }
            return;
        }
        if let Some(ask) = spec.ask.as_mut() {
            ask.mode = if self.plan {
                crate::agent::AskMode::Plan
            } else {
                crate::agent::AskMode::Ask
            };
            ask.subagents_auto = self.subagents_auto;
        }
    }
}

/// `mcp_config` with `--ask` taken out of Nightloom's server's arguments
/// (the desktop passes it only when the Ask hook is on). Unchanged when it
/// does not parse.
fn without_ask_flag(config: &str) -> String {
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(config) else {
        return config.to_string();
    };
    if let Some(args) = v
        .pointer_mut(&format!(
            "/mcpServers/{}/args",
            crate::mcp_server::SERVER_NAME
        ))
        .and_then(serde_json::Value::as_array_mut)
    {
        args.retain(|a| a.as_str() != Some("--ask"));
    }
    v.to_string()
}

/// Load, merge `patch`, save — the whole of `POST /api/rail` on this host.
/// A file that does not read is not written over.
pub fn apply(home: &Path, patch: &RailPatch) -> Result<RailSettings, String> {
    if patch.is_empty() {
        return Err("nothing to change".into());
    }
    let next = load(home)?.merged(patch)?;
    save(home, &next)?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("nightloom-rail-models-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Item 272's Definition of done, on the away server: an id added to
    /// the file the list reads is offered on the phone's rail and becomes
    /// the turn's model, with no build in between.
    #[test]
    fn a_model_added_to_the_list_file_is_offered_and_is_the_away_default() {
        let home = scratch();
        let before = load_or_default(&home);
        assert_eq!(
            before.to_rail(Some("claude-sonnet-5-5"), false).model,
            "claude-sonnet-5-5"
        );
        assert!(
            !before
                .to_rail(None, false)
                .models
                .contains(&"claude-fake-9".to_string())
        );

        std::fs::write(
            model_list::path(&home),
            r#"{"models": ["sonnet", "claude-fake-9"], "away_default": "claude-fake-9"}"#,
        )
        .unwrap();
        let after = load_or_default(&home);
        let rail = after.to_rail(Some("claude-sonnet-5-5"), false);
        assert_eq!(rail.models, vec!["sonnet", "claude-fake-9"]);
        assert_eq!(rail.model, "claude-fake-9");
        let mut spec = AgentSpec::new(&home);
        after.apply_model(&mut spec, Some("claude-sonnet-5-5"));
        assert_eq!(spec.model.as_deref(), Some("claude-fake-9"));

        // A model the phone chose still wins over the default.
        let chosen = RailSettings {
            model: "opus".into(),
            ..after
        };
        chosen.apply_model(&mut spec, Some("claude-sonnet-5-5"));
        assert_eq!(spec.model.as_deref(), Some("opus"));
        let _ = std::fs::remove_dir_all(&home);
    }
}
