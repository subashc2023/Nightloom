//! The phone's API beyond read-and-send (item 246, wave 1; the design is
//! `nightshift-code/notes/research/246-phone-parity-voice-design-2026-09-30.md`
//! §4, "the ONE API").
//!
//! Both hosts serve these shapes: the Mac's, which hands each call to its
//! window like a send, and the away server's headless host (item 268),
//! which adopts them one at a time. Every [`super::Host`] method behind
//! these routes has a default body that answers [`NOT_AVAILABLE`], which
//! the listener turns into a 501 with the sentence, and a host lists what
//! it does support in [`super::Host::features`] — `/api/state` carries that
//! list, so the phone greys out what this host lacks instead of offering a
//! button that fails.

use nightloom_core::SessionEvent;
use nightloom_core::context::WireView;
use nightloom_core::prompt::SegmentKind;
use serde::{Deserialize, Serialize};

use crate::council::{CouncilMode, Seat};
use crate::plan_usage::PlanUsage;

/// What a default-bodied [`super::Host`] method answers. The listener maps
/// exactly this sentence to 501, so a client can tell "this host has no
/// such thing" from "the host refused this time" (409).
pub const NOT_AVAILABLE: &str = "not available on this host";

/// The names `/api/state`'s `features` may carry — one per group of routes
/// below, so the phone can grey out a group a host does not serve.
pub mod feature {
    /// `POST /api/chats/{id}/act`.
    pub const ACT: &str = "act";
    /// `GET`/`POST /api/chats/{id}/context`.
    pub const CONTEXT: &str = "context";
    /// `POST /api/chats/{id}/layers`.
    pub const LAYERS: &str = "layers";
    /// `GET`/`POST /api/rail`.
    pub const RAIL: &str = "rail";
    /// `GET /api/running`.
    pub const RUNNING: &str = "running";
    /// `GET /api/usage`.
    pub const USAGE: &str = "usage";
    /// `GET /api/search`.
    pub const SEARCH: &str = "search";
    /// `POST /api/projects`, `…/open`, `…/rename`, `…/forget`.
    pub const PROJECTS: &str = "projects";
    /// `/api/notes…`.
    pub const NOTES: &str = "notes";
    /// The notes routes take `?project=` (item 300 B1): the phone names
    /// the project on its screen, never the host's open one by default.
    pub const NOTES_PROJECT: &str = "notes_project";
    /// A send may carry `project` (a chat in another project), `images`,
    /// `documents`, `council`, or `spoken` — one name each, so the phone
    /// can offer a photo where a council is not served (a plain text send
    /// is always there). The Mac's host (1B) lists all five.
    pub const SEND_PROJECT: &str = "send_project";
    pub const IMAGES: &str = "images";
    pub const DOCUMENTS: &str = "documents";
    pub const COUNCIL: &str = "council";
    pub const SPOKEN: &str = "spoken";
    /// `GET /api/voice` (wave 3).
    pub const VOICE: &str = "voice";
    /// `POST /api/chats/{id}/aside`, `…/aside/cancel`, `GET …/asides`
    /// (wave 2).
    pub const ASIDE: &str = "aside";
    /// `/api/nightshift/…` (wave 5, blocker 669's default): the queue, an
    /// item, a new item, open blockers and their answers, the mornings.
    /// The listener lists it itself, only while the host has a Nightshift
    /// project ([`super::Host::nightshift_roots`]); a host never names it.
    pub const NIGHTSHIFT: &str = "nightshift";
    /// `POST /api/dream`, `POST /api/capture` (wave 5).
    pub const DREAM: &str = "dream";
    pub const CAPTURE: &str = "capture";
    /// The `act` ops a host may lack while it has `act` (wave 5): one name
    /// each, so the phone can grey out Compact on the away server (Claude
    /// Code keeps its own history) and still offer Budget.
    pub const COMPACT: &str = "compact";
    pub const CHECKPOINT: &str = "checkpoint";
    pub const BUDGET: &str = "budget";
    pub const RESUME_LIMIT: &str = "resume_limit";
    /// Every name, for a host that serves the lot and for tests.
    pub const ALL: &[&str] = &[
        ACT,
        CONTEXT,
        LAYERS,
        RAIL,
        RUNNING,
        USAGE,
        SEARCH,
        PROJECTS,
        NOTES,
        NOTES_PROJECT,
        SEND_PROJECT,
        IMAGES,
        DOCUMENTS,
        COUNCIL,
        SPOKEN,
        VOICE,
        ASIDE,
        NIGHTSHIFT,
        DREAM,
        CAPTURE,
        COMPACT,
        CHECKPOINT,
        BUDGET,
        RESUME_LIMIT,
    ];
}

/// `/api/state`'s body: the host's [`super::RemoteState`] with the feature
/// list beside it. A wrapper rather than a new field so a host that builds
/// `RemoteState` by literal compiles unchanged.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct StateReply {
    #[serde(flatten)]
    pub state: super::RemoteState,
    #[serde(default)]
    pub features: Vec<String>,
    /// Which host answered: `mac` or `serve` ([`super::Host::kind`]).
    #[serde(default = "mac")]
    pub host: String,
    /// The desktop's chosen colour palette (`A`–`D`, Settings →
    /// Appearance; blocker 577), for the page to follow. `None` on the
    /// away server, and from a Mac whose window has not said yet.
    #[serde(default)]
    pub palette: Option<String>,
    /// A turn paused by the plan's usage limit (backlog 164), the same
    /// shape from both hosts; `None` when nothing is paused.
    #[serde(default)]
    pub limit_pause: Option<LimitPause>,
}

/// A turn the plan's usage limit paused (nightshift backlog 164), as
/// `/api/state` carries it: the Mac's from its window's `app.limitPause`,
/// the away server's from its own last turn. Times are Unix seconds.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct LimitPause {
    /// The chat the turn ran in (`None`: the Mac's pending new chat).
    pub chat: Option<String>,
    /// When the window opens again, when the CLI said.
    pub resets_at: Option<i64>,
    /// `five_hour`, `seven_day`, when the CLI said.
    pub window: Option<String>,
    /// The CLI's own sentence.
    #[serde(default)]
    pub text: String,
    /// The spawning calls of the subagents that died on it.
    #[serde(default)]
    pub subagents: Vec<String>,
    /// A resume is scheduled for this time (the reset plus 30 s); `None`
    /// when none is.
    #[serde(default)]
    pub resume_at: Option<i64>,
}

fn mac() -> String {
    "mac".into()
}

/// Whether an edited message is only saved or saved and sent (the Mac's
/// two buttons under an edited message).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum EditMode {
    Save,
    Send,
}

/// One action on a chat's log, as the Mac's message and chat menus offer
/// them. `index` is the event's position in the chat's log (the transcript
/// the phone read); `block` a block within an assistant reply.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ChatAction {
    Edit {
        index: usize,
        text: String,
        mode: EditMode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        block: Option<usize>,
    },
    Remove {
        index: usize,
    },
    Restore {
        index: usize,
    },
    RemoveBlock {
        index: usize,
        block: usize,
    },
    RestoreBlock {
        index: usize,
        block: usize,
    },
    Rewind {
        to: usize,
    },
    Unrewind {
        of: usize,
    },
    Fork {
        upto: usize,
    },
    Continue,
    Compact,
    /// Moves the chat to the trash; `Undelete` brings it back.
    Delete,
    Undelete,
    /// `build` or `chat`.
    Kind {
        kind: String,
    },
    ResumeLimit,
    Budget {
        decision: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<String>,
    },
    Checkpoint {
        index: usize,
    },
}

impl ChatAction {
    /// The listener's own check before the host sees the action: what no
    /// host could do anything with. `Err` is the 400's sentence.
    pub fn check(&self) -> Result<(), String> {
        match self {
            Self::Edit { text, .. } if text.trim().is_empty() => {
                Err("an edited message cannot be empty — remove it instead".into())
            }
            Self::Kind { kind } if kind != "build" && kind != "chat" => {
                Err(format!("a chat is `build` or `chat`, not `{kind}`"))
            }
            Self::Budget { decision, .. } if decision.trim().is_empty() => {
                Err("a budget answer needs a decision".into())
            }
            _ => Ok(()),
        }
    }
}

/// What an action left: the chat now showing (a fork's new id; otherwise
/// the chat acted on) and its log, so the phone redraws without a re-read.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActReply {
    pub chat: String,
    pub events: Vec<SessionEvent>,
    /// A sentence for the phone when the action did something other than
    /// change the log now (wave 5): a resume after the limit "scheduled for
    /// 3:42 PM", or "already scheduled". Absent otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// The 202's body for a dream or a capture started (wave 5): it runs on
/// the host, and says how it went as the host's own notices.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PassStarted {
    /// `started`.
    pub status: String,
}

/// A chat's Context page: the request it would send now, itemised; its
/// prompt layers (the Mac's `prompt_layers` reply, passed through); and any
/// layer change held for a choice (the Mac's pending view, passed through).
/// The last two are JSON because their types are the desktop's own.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextReply {
    pub view: WireView,
    #[serde(default)]
    pub layers: serde_json::Value,
    #[serde(default)]
    pub pending: serde_json::Value,
}

/// `POST /api/chats/{id}/context`: hide (`remove: true`) or show again the
/// items at `targets` in the view.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContextEditRequest {
    pub targets: Vec<usize>,
    pub remove: bool,
}

/// `POST /api/chats/{id}/layers`, one of three bodies: the set of layers
/// switched off; a layer's own text (`null` puts the default back); or the
/// answer to a held change (the Mac's `prompt_hold::Choice`, passed
/// through).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum LayerChange {
    Off {
        off: Vec<SegmentKind>,
    },
    Choice {
        kind: SegmentKind,
        choice: serde_json::Value,
    },
    Text {
        kind: SegmentKind,
        text: Option<String>,
    },
}

/// The engine and turn settings the Mac's rail shows (blocker 666's
/// default: these, and never keys or folder choices), with the connection's
/// state after the last change. Field names are the Mac's host's (1B,
/// `remoteHandlers.ts` `railOf`); empty strings are the rail's "default"
/// positions, as on the Mac. A field this struct does not name is kept in
/// `extra`, so a host that says more loses nothing on the way through.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct Rail {
    /// `claude-code` or `provider`.
    pub engine: String,
    /// The API engine's provider (read only from the phone).
    pub provider: String,
    /// The engine's model: the agent's alias on `claude-code`, the
    /// provider's model id otherwise.
    pub model: String,
    /// The models the picker offers on `claude-code`, in order (item 272:
    /// `model-list.json`, which he edits without a build). Empty from a
    /// host that predates it; the phone then offers its built-in aliases.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<String>,
    /// `low` … `max`, or empty for the CLI's own.
    pub effort: String,
    pub fallback: String,
    /// The API engine's thinking mode (`default`, `effort-low`, …).
    pub thinking: String,
    /// The subagent limits, as the Mac's `agentLimits` has them.
    pub limits: serde_json::Value,
    /// Whether approvals are on at all (read only from the phone).
    pub approval: bool,
    pub ask: bool,
    pub plan: bool,
    pub subagents_auto: bool,
    pub fork_mode: bool,
    /// The council for the chat on the Mac's screen.
    pub council: Option<RailCouncil>,
    /// An engine is connected / connecting now.
    pub connected: bool,
    pub connecting: bool,
    /// The change waits for the running turn to end, then connects (the
    /// Mac's rail does the same, backlog 214).
    pub deferred: bool,
    /// The last connect's error, if it failed.
    pub error: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// A council's seats and mode, as the Mac keeps them per chat.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RailCouncil {
    pub seats: Vec<Seat>,
    #[serde(default)]
    pub mode: CouncilMode,
}

/// `POST /api/rail`: the fields to change; the host merges them into its
/// rail and reconnects once, then answers with the whole [`Rail`]. `limits`
/// is partial (only the limits named change).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct RailPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limits: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ask: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subagents_auto: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fork_mode: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub council: Option<RailCouncil>,
}

impl RailPatch {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// A chat whose turn is running now, for the phone's Running sheet (the
/// Mac's `liveChats`, as 1B sends it).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunningChat {
    /// The chat's id; `None` for a new chat not yet written to disk.
    pub chat: Option<String>,
    /// The project it runs in, when the host knows it.
    #[serde(default)]
    pub project: Option<String>,
    pub title: String,
    /// When its turn started, unix milliseconds.
    #[serde(default)]
    pub since: Option<i64>,
    /// The chat on the host's screen.
    #[serde(default)]
    pub on_screen: bool,
    /// Its unanswered approval prompts.
    #[serde(default)]
    pub waiting: usize,
}

/// `GET /api/running`: the chats running now, and beside them what the
/// host knows of the rest — the open chat's subagents and its turn budget
/// (the Mac's own shapes, passed through); asides, a dream and a capture
/// when a host reports them (the Mac does not yet: empty / `null`).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct Running {
    pub chats: Vec<RunningChat>,
    pub subagents: serde_json::Value,
    pub budget: serde_json::Value,
    pub asides: Vec<serde_json::Value>,
    pub dream: Option<serde_json::Value>,
    pub capture: Option<serde_json::Value>,
}

/// The drawer's usage line: the plan's windows and the ledger's summary
/// (the host's own shape, passed through).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct UsageReply {
    pub plan: PlanUsage,
    #[serde(default)]
    pub ledger: serde_json::Value,
}

/// `GET /api/search?q=&scope=`: this chat's project, every project, or
/// the notes — the Mac's search-everywhere scopes.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SearchScope {
    This,
    #[default]
    All,
    Notes,
}

impl SearchScope {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "this" => Some(Self::This),
            "all" | "" => Some(Self::All),
            "notes" => Some(Self::Notes),
            _ => None,
        }
    }
}

/// `POST /api/projects`: a new project by name, in the host's projects
/// folder (choosing another folder is a Mac-only picker, blocker 666).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewProjectRequest {
    pub name: String,
    #[serde(default)]
    pub instructions: Option<String>,
}

/// `POST /api/projects/{id}/rename`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectRenameRequest {
    pub name: String,
}

/// A note's text, both ways: `GET /api/notes/{scope}/{name}` answers it and
/// `PUT` sends it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NoteText {
    pub text: String,
}

/// The note scopes the Mac's editor reaches (its `NoteScope`, snake case).
pub const NOTE_SCOPES: &[&str] = &[
    "project",
    "knowledge",
    "instructions",
    "memory",
    "models",
    "chat",
];

/// Decode a query string's value (`+` is a space, `%XX` a byte). Hand-rolled
/// because the crate builds axum without its `query` feature; a malformed
/// escape is kept as written rather than refused.
pub fn query_param(query: Option<&str>, key: &str) -> Option<String> {
    let query = query?;
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        if decode(k) == key {
            return Some(decode(v));
        }
    }
    None
}

fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3])
                    .ok()
                    .and_then(|h| u8::from_str_radix(h, 16).ok());
                match hex {
                    Some(b) => {
                        out.push(b);
                        i += 2;
                    }
                    None => out.push(b'%'),
                }
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `POST /api/chats/{id}/aside`'s body (item 246, wave 2; the shape 2C's
/// page sends): a side question of the chat that adds nothing to it.
/// `thread` names an open thread to follow up in; without it a question
/// goes as the Mac's composer sends one (it continues the newest answered
/// thread, else opens a new one).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct AsideRequest {
    pub text: String,
    #[serde(default)]
    pub thread: Option<u64>,
}

impl AsideRequest {
    /// A question with no words is refused before any host sees it.
    pub fn check(&self) -> Result<(), String> {
        if self.text.trim().is_empty() {
            return Err("an aside needs a question".into());
        }
        Ok(())
    }
}

/// `POST /api/chats/{id}/aside/cancel`'s body: the exchange to stop.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AsideCancel {
    pub seq: u64,
}

/// The 202's body: the chat (its full id), the thread asked in, and the
/// exchange's number — which the `aside-event`s on the stream carry.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct AsideStarted {
    pub chat: String,
    pub thread: u64,
    pub seq: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn actions_read_as_the_design_spells_them() {
        let a: ChatAction =
            serde_json::from_value(json!({"op": "edit", "index": 3, "text": "hi", "mode": "send"}))
                .unwrap();
        assert_eq!(
            a,
            ChatAction::Edit {
                index: 3,
                text: "hi".into(),
                mode: EditMode::Send,
                block: None
            }
        );
        for (v, want) in [
            (
                json!({"op": "remove_block", "index": 1, "block": 2}),
                ChatAction::RemoveBlock { index: 1, block: 2 },
            ),
            (
                json!({"op": "rewind", "to": 4}),
                ChatAction::Rewind { to: 4 },
            ),
            (
                json!({"op": "unrewind", "of": 4}),
                ChatAction::Unrewind { of: 4 },
            ),
            (
                json!({"op": "fork", "upto": 5}),
                ChatAction::Fork { upto: 5 },
            ),
            (json!({"op": "continue"}), ChatAction::Continue),
            (json!({"op": "resume_limit"}), ChatAction::ResumeLimit),
            (json!({"op": "delete"}), ChatAction::Delete),
            (
                json!({"op": "budget", "decision": "raise"}),
                ChatAction::Budget {
                    decision: "raise".into(),
                    text: None,
                },
            ),
        ] {
            assert_eq!(
                serde_json::from_value::<ChatAction>(v.clone()).unwrap(),
                want,
                "{v}"
            );
            assert_eq!(serde_json::to_value(&want).unwrap(), v);
        }
        assert!(serde_json::from_value::<ChatAction>(json!({"op": "explode"})).is_err());
    }

    #[test]
    fn the_listener_refuses_what_no_host_could_use() {
        let empty = ChatAction::Edit {
            index: 0,
            text: "  ".into(),
            mode: EditMode::Save,
            block: None,
        };
        assert!(empty.check().is_err());
        assert!(ChatAction::Kind { kind: "x".into() }.check().is_err());
        assert!(
            ChatAction::Kind {
                kind: "chat".into()
            }
            .check()
            .is_ok()
        );
        assert!(ChatAction::Rewind { to: 0 }.check().is_ok());
    }

    #[test]
    fn a_layer_change_is_told_apart_by_its_fields() {
        let off: LayerChange = serde_json::from_value(json!({"off": ["identity"]})).unwrap();
        assert_eq!(
            off,
            LayerChange::Off {
                off: vec![SegmentKind::Identity]
            }
        );
        let text: LayerChange =
            serde_json::from_value(json!({"kind": "identity", "text": null})).unwrap();
        assert_eq!(
            text,
            LayerChange::Text {
                kind: SegmentKind::Identity,
                text: None
            }
        );
        let choice: LayerChange =
            serde_json::from_value(json!({"kind": "identity", "choice": "now"})).unwrap();
        assert!(matches!(choice, LayerChange::Choice { .. }));
    }

    #[test]
    fn state_reply_flattens_the_state_beside_the_features() {
        let r = StateReply {
            state: super::super::RemoteState {
                busy: true,
                ..Default::default()
            },
            features: vec![feature::ACT.into()],
            host: "serve".into(),
            palette: Some("B".into()),
            limit_pause: Some(LimitPause {
                chat: Some("c1".into()),
                resets_at: Some(1_789_714_200),
                window: Some("five_hour".into()),
                ..Default::default()
            }),
        };
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["busy"], true);
        assert_eq!(v["features"], json!(["act"]));
        assert_eq!(v["host"], "serve");
        assert_eq!(v["palette"], "B");
        assert_eq!(v["limit_pause"]["chat"], "c1");
        assert_eq!(v["limit_pause"]["resets_at"], 1_789_714_200);
        assert_eq!(v["limit_pause"]["window"], "five_hour");
        assert_eq!(v["limit_pause"]["resume_at"], serde_json::Value::Null);
        // An old host's reply, with no list, still reads.
        let old: StateReply = serde_json::from_value(json!({
            "project": null, "active_chat": null, "busy": false, "connected": false,
            "engine": null, "pending": []
        }))
        .unwrap();
        assert!(old.features.is_empty());
        // A host from before `host` was there is the Mac's.
        assert_eq!(old.host, "mac");
        assert!(old.palette.is_none() && old.limit_pause.is_none());
    }

    #[test]
    fn query_values_are_decoded() {
        assert_eq!(
            query_param(Some("q=hello+there%21&scope=notes"), "q").as_deref(),
            Some("hello there!")
        );
        assert_eq!(
            query_param(Some("q=a&scope=notes"), "scope").as_deref(),
            Some("notes")
        );
        assert_eq!(query_param(Some("q=%E2%9C%93"), "q").as_deref(), Some("✓"));
        assert_eq!(query_param(Some("q=100%"), "q").as_deref(), Some("100%"));
        assert_eq!(query_param(Some("q=%zz"), "q").as_deref(), Some("%zz"));
        assert_eq!(query_param(None, "q"), None);
        assert_eq!(query_param(Some("x=1"), "q"), None);
    }

    /// The Mac's host (1B) answers with `railOf()` and `runningNow()`
    /// built in the window; those JSON shapes read into these types
    /// whole, and a field the types do not name survives the trip.
    #[test]
    fn the_mac_hosts_rail_and_running_read_whole() {
        let rail = json!({
            "engine": "claude-code", "provider": "anthropic", "model": "opus",
            "effort": "", "fallback": "", "thinking": "default",
            "limits": {"perTurn": 6, "off": {"perDay": true}},
            "approval": true, "ask": true, "plan": false, "subagents_auto": true,
            "fork_mode": true,
            "council": {"seats": [{"model": "opus", "engine": "subscription"}, {"model": "fable", "engine": "subscription"}], "mode": "answer"},
            "connected": true, "connecting": false, "deferred": false, "error": null,
            "something_new": 3
        });
        let r: Rail = serde_json::from_value(rail.clone()).unwrap();
        assert_eq!(r.model, "opus");
        assert_eq!(r.council.as_ref().unwrap().seats.len(), 2);
        assert_eq!(r.extra["something_new"], 3);
        assert_eq!(serde_json::to_value(&r).unwrap(), rail);

        let patch: RailPatch =
            serde_json::from_value(json!({"effort": "high", "limits": {"off": {"perDay": false}}}))
                .unwrap();
        assert!(!patch.is_empty());
        assert_eq!(
            serde_json::to_value(&patch).unwrap(),
            json!({"effort": "high", "limits": {"off": {"perDay": false}}}),
            "a patch names only what it changes"
        );
        assert!(
            serde_json::from_value::<RailPatch>(json!({}))
                .unwrap()
                .is_empty()
        );

        let running: Running = serde_json::from_value(json!({
            "chats": [{"chat": null, "title": "New chat", "on_screen": true, "since": null, "waiting": 1}],
            "subagents": [], "budget": null
        }))
        .unwrap();
        assert_eq!(running.chats[0].waiting, 1);
        assert!(running.asides.is_empty() && running.dream.is_none());
    }
}
