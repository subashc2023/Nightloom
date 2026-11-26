//! A card's action (nightshift item 993d): his click in an event's or an
//! email's card — answer the invitation, save the reply as a Gmail draft,
//! and (993e) send the reply or the forward — run as one connector call.
//!
//! **Only his click starts one.** [`mint`] is called by the window's
//! command for that click and by nothing else: no tool of Nightloom's
//! server reaches it, no message into a chat does, and a model's own call
//! to a send is refused or asked about wherever it is made
//! ([`crate::agent::send_guard`]; blocker 2304, his words: "no autonomous
//! decisions made on sending forwarding replying none of that").
//!
//! **How it runs** (blocker 2308's decision): a throwaway one-shot turn on
//! Haiku in its own CLI process — `inbox_sort`'s shape: no built-in tools,
//! no session file, an empty scratch folder — with his connectors on and
//! every MCP call sent to this module's hook ([`decide`]). The chat the
//! reply came from is never touched: nothing is added to its history and
//! its cache is not read.
//!
//! **The one-time pass.** The click writes a [`Pass`] into the action's own
//! fresh directory: the one tool, the call's arguments pinned key by key,
//! the SHA-256 of the words that go (the reply's body, the note), and a
//! time two minutes on. The hook lets a call through only when its tool is
//! that tool, its arguments are exactly those, its words hash to that
//! hash, and the pass is unspent and in time — and spends the pass first.
//! Any other MCP call in that process is refused, a read included. So the
//! model can make the call he approved or no call; it cannot change who
//! gets it or a word of what is sent.
//!
//! What comes back is read from the tool's own result ([`receipt`]), never
//! from the model's words about it.

use crate::agent::ask::HookReply;
use crate::agent::{AgentSpec, PassSpec, RefPassSpec, connectors};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::path::Path;

/// The hook's flag after the directory: [`decide`] answers.
pub const PASS_ARG: &str = "--ref-pass";

/// The pass hook's matcher: every MCP call of the one-shot process.
pub const PASS_MATCHER: &str = "^mcp__.*";

/// The pass, in the action's directory.
pub const PASS_FILE: &str = "ref-pass.json";

/// How long a pass lasts.
pub const PASS_SECS: i64 = 120;

/// The model an action runs on, whatever any chat's is.
pub const MODEL: &str = "haiku";

/// A note or a mail body, bounded.
pub const MAX_WORDS: usize = 20_000;

/// The item a card was opened on: the tag's own fields (`refTag.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Item {
    /// `event` | `email` | `doc`.
    pub kind: String,
    /// The connector's own id: an event's, a message's.
    pub id: String,
    /// The connector's server name, as Home's reach lists it
    /// (`claude.ai Gmail 2117773e`).
    pub src: String,
    /// An event's calendar, when the tag carried one.
    #[serde(default)]
    pub cal: Option<String>,
    /// The name the reply showed (a forward draft's subject).
    #[serde(default)]
    pub name: String,
}

/// What the click asks for — `refCard.ts`'s `RefAction`, the three that
/// reach a connector.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Act {
    Rsvp {
        answer: String,
        #[serde(default)]
        note: String,
    },
    SaveDraft {
        mode: String,
        #[serde(default)]
        to: String,
        body: String,
    },
    Send {
        mode: String,
        #[serde(default)]
        to: String,
        body: String,
    },
}

/// The one connector call an action is.
#[derive(Debug, Clone, PartialEq)]
pub struct Call {
    /// The tool as the CLI names it: `mcp__claude_ai_Gmail_2117773e__reply`.
    pub tool: String,
    /// The whole input.
    pub input: Value,
    /// The key of `input` holding his words, when the call carries any.
    pub words_key: Option<&'static str>,
    /// Whether the call reaches other people (an answer, a mail) — a
    /// [`crate::agent::send_guard`] send.
    pub sends: bool,
}

fn clean_id(what: &str, id: &str) -> Result<String, String> {
    let id = id.trim();
    if id.is_empty() || id.len() > 1024 || id.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(format!("this link came without a usable {what}"));
    }
    Ok(id.to_string())
}

fn words(text: &str) -> Result<&str, String> {
    if text.len() > MAX_WORDS {
        return Err(format!(
            "that is longer than a card sends ({MAX_WORDS} characters at most)"
        ));
    }
    Ok(text)
}

/// One plain address (`a@b.c`), or the reason it is not one. Never a name:
/// a forward goes only where he typed (the plan: "never a guessed address").
pub fn address(to: &str) -> Result<String, String> {
    let to = to.trim();
    let ok = to.len() <= 254
        && !to.chars().any(|c| {
            c.is_whitespace() || c.is_control() || matches!(c, ',' | ';' | '<' | '>' | '"')
        })
        && to.split_once('@').is_some_and(|(name, host)| {
            !name.is_empty()
                && !host.contains('@')
                && host.contains('.')
                && !host.starts_with('.')
                && !host.ends_with('.')
        });
    if ok {
        Ok(to.to_string())
    } else {
        Err("a forward needs one full address (name@example.com)".into())
    }
}

/// The tool on `src`'s server, as the CLI names it. `src` must be one of
/// his claude.ai connectors, by its own name.
fn tool_on(src: &str, tool: &str) -> Result<String, String> {
    let src = src.trim();
    if !connectors::is_connector(src) || src.len() <= connectors::SERVER_PREFIX.len() {
        return Err("this link does not name one of your connectors".into());
    }
    Ok(format!("{}__{tool}", connectors::server_rule(src)))
}

/// The call for `act` on `item`, or why there is none. The argument names
/// are the connectors' own (`external`: the Gmail and Calendar tool
/// schemas a Claude Code session lists, read 2026-11-26, not called):
/// `respond_to_event` takes `eventId`, `calendarId`, `responseStatus`,
/// `responseComment`; `create_draft` takes `replyToMessageId`, `to`,
/// `subject`, `body`.
pub fn call_for(item: &Item, act: &Act) -> Result<Call, String> {
    match act {
        Act::Rsvp { answer, note } => {
            if item.kind != "event" {
                return Err("only an event can be answered".into());
            }
            if !matches!(answer.as_str(), "accepted" | "tentative" | "declined") {
                return Err("an answer is accepted, tentative or declined".into());
            }
            let mut input = Map::new();
            input.insert("eventId".into(), clean_id("event id", &item.id)?.into());
            if let Some(cal) = item.cal.as_deref().filter(|c| !c.trim().is_empty()) {
                input.insert("calendarId".into(), clean_id("calendar", cal)?.into());
            }
            input.insert("responseStatus".into(), answer.clone().into());
            let note = words(note)?.trim();
            if !note.is_empty() {
                input.insert("responseComment".into(), note.into());
            }
            Ok(Call {
                tool: tool_on(&item.src, "respond_to_event")?,
                input: Value::Object(input),
                words_key: (!note.is_empty()).then_some("responseComment"),
                sends: true,
            })
        }
        Act::SaveDraft { mode, to, body } => {
            if item.kind != "email" {
                return Err("only an email has a reply to save".into());
            }
            let body = words(body)?;
            if body.trim().is_empty() {
                return Err("nothing is written yet".into());
            }
            let id = clean_id("message id", &item.id)?;
            let mut input = Map::new();
            match mode.as_str() {
                // Gmail threads the draft under the message; who it goes to
                // is his to check in Gmail before he sends it from there.
                "reply" | "replyAll" => {
                    input.insert("replyToMessageId".into(), id.into());
                }
                // A draft cannot carry the forwarded message (the connector
                // has no forward draft): his note, addressed, under "Fwd:".
                "forward" => {
                    if !to.trim().is_empty() {
                        input.insert("to".into(), json!([address(to)?]));
                    }
                    let name = item.name.trim();
                    let subject = if name.is_empty() {
                        "Fwd:".to_string()
                    } else {
                        format!("Fwd: {name}")
                    };
                    input.insert("subject".into(), subject.into());
                }
                _ => return Err("a draft is a reply, a reply to all or a forward".into()),
            }
            input.insert("body".into(), body.into());
            Ok(Call {
                tool: tool_on(&item.src, "create_draft")?,
                input: Value::Object(input),
                words_key: Some("body"),
                sends: false,
            })
        }
        Act::Send { .. } => Err(
            "sending mail from a card is not built yet (item 993e); Save as Gmail draft works"
                .into(),
        ),
    }
}

/// The one-time pass, as written and as read.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Pass {
    /// The one tool, whole.
    pub tool: String,
    /// The call's input without his words: every key the call must carry,
    /// each with its value, and no other.
    pub pinned: Value,
    /// The key his words ride under, when the call carries any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub words_key: Option<String>,
    /// SHA-256 of those words, hex; of nothing when there are none.
    pub words_sha256: String,
    /// When the pass stops being good.
    pub expires: DateTime<Utc>,
    /// This pass's own name: a pass is one click.
    pub nonce: String,
}

fn sha(text: &str) -> String {
    crate::sync::manifest::sha256_hex(text.as_bytes())
}

impl Pass {
    /// The pass for `call`, good for [`PASS_SECS`] from `now`.
    pub fn of(call: &Call, now: DateTime<Utc>) -> Self {
        let mut pinned = call.input.clone();
        let mut said = String::new();
        if let (Some(key), Value::Object(map)) = (call.words_key, &mut pinned)
            && let Some(Value::String(s)) = map.remove(key)
        {
            said = s;
        }
        Self {
            tool: call.tool.clone(),
            pinned,
            words_key: call.words_key.map(str::to_string),
            words_sha256: sha(&said),
            expires: now + chrono::Duration::seconds(PASS_SECS),
            nonce: uuid::Uuid::new_v4().to_string(),
        }
    }

    /// Whether `tool` with `input` is exactly the call this pass is for.
    pub fn covers(&self, tool: &str, input: &Value) -> bool {
        if tool != self.tool {
            return false;
        }
        let Value::Object(input) = input else {
            return false;
        };
        let mut rest = input.clone();
        let said = match &self.words_key {
            Some(key) => match rest.remove(key) {
                Some(Value::String(s)) => s,
                _ => return false,
            },
            None => String::new(),
        };
        Value::Object(rest) == self.pinned && sha(&said) == self.words_sha256
    }
}

/// His click: write the pass for `call` into `dir` (made if need be; the
/// action's own, fresh). **Called only by the window's command for a click
/// in a card** — see the module's first rule.
pub fn mint(dir: &Path, call: &Call, now: DateTime<Utc>) -> Result<Pass, String> {
    let pass = Pass::of(call, now);
    std::fs::create_dir_all(dir).map_err(|e| format!("could not make the action's folder: {e}"))?;
    let bytes = serde_json::to_vec(&pass).map_err(|e| e.to_string())?;
    let path = dir.join(PASS_FILE);
    let tmp = dir.join(format!("{PASS_FILE}.tmp"));
    std::fs::write(&tmp, bytes)
        .and_then(|()| std::fs::rename(&tmp, &path))
        .map_err(|e| format!("could not write the pass: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(pass)
}

/// What the model reads when its call is not the one he approved. No pass
/// is spent by a refusal.
pub const NOT_THE_CALL: &str = "Refused: this is not exactly the call he approved. Make the one call you were given, with exactly the arguments you were given, character for character, and no other call.";

/// What it reads when there is no pass to spend (none minted, spent
/// already, or out of time).
pub const NO_PASS: &str =
    "Refused: nothing here is approved to run. Make no further calls; say that nothing was sent.";

#[derive(Deserialize)]
struct HookCall {
    #[serde(default)]
    tool_name: String,
    #[serde(default)]
    agent_id: Option<String>,
    #[serde(default)]
    tool_input: Value,
}

/// The pass hook's verdict on one MCP call of the one-shot process: allow
/// exactly the call the pass covers — spending the pass first, so it can
/// never run twice — and refuse every other call, a subagent's included.
/// Unreadable input, a missing, unreadable, spent or late pass: refused.
pub fn decide(dir: &Path, stdin_json: &str, now: DateTime<Utc>) -> HookReply {
    let Ok(call) = serde_json::from_str::<HookCall>(stdin_json) else {
        return HookReply::deny(NO_PASS.into());
    };
    if call.agent_id.as_deref().is_some_and(|id| !id.is_empty()) {
        return HookReply::deny(NO_PASS.into());
    }
    let path = dir.join(PASS_FILE);
    let Some(pass) = std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Pass>(&b).ok())
    else {
        return HookReply::deny(NO_PASS.into());
    };
    if now >= pass.expires {
        let _ = std::fs::remove_file(&path);
        return HookReply::deny(NO_PASS.into());
    }
    if !pass.covers(&call.tool_name, &call.tool_input) {
        return HookReply::deny(NOT_THE_CALL.into());
    }
    // Spent before the answer: if the file cannot be removed the call does
    // not run, so one pass is never two calls.
    if std::fs::remove_file(&path).is_err() {
        return HookReply::deny(NO_PASS.into());
    }
    HookReply::allow(None)
}

const IDENTITY: &str = "You are Nightloom's action runner. The user clicked a button; you make the one tool call the message gives you, with exactly the arguments it gives, and nothing else. You do not chat, plan, read or look anything up. After the call returns, reply with one word: done or failed.";

/// The one message of the action's turn: the call, whole.
pub fn message(call: &Call) -> String {
    format!(
        "Call the tool `{}` exactly once, with exactly this JSON as its input — every key and value as written, character for character, no key added or left out:\n\n{}\n\nMake no other tool call. Then reply with one word: done or failed.",
        call.tool,
        serde_json::to_string_pretty(&call.input).unwrap_or_default()
    )
}

/// The CLI spec for one action, rooted at `scratch` (an empty folder, so
/// no project's `CLAUDE.md` is read): Haiku, no built-in tools, his
/// connectors on less `blocked` (every other one, to keep the tool list
/// short), `dontAsk` so nothing prompts, and the pass hook in `dir` on
/// every MCP call.
pub fn spec_for(
    pass: &PassSpec,
    scratch: &Path,
    hook: Vec<String>,
    dir: &Path,
    blocked: Vec<String>,
) -> AgentSpec {
    let mut spec = pass.spec_in(scratch);
    spec.model = Some(MODEL.to_string());
    spec.tools = Some(Vec::new());
    spec.permission_mode = Some("dontAsk".into());
    // The call, one retry if its arguments came out wrong, and the word.
    spec.max_turns = Some(4);
    spec.no_session_persistence = true;
    spec.fork_mode = false;
    spec.append_system_prompt = Some(IDENTITY.to_string());
    spec.claude_ai_connectors = true;
    spec.claude_ai_blocked = blocked;
    spec.ref_pass = Some(RefPassSpec {
        hook,
        dir: dir.to_path_buf(),
    });
    spec
}

/// What the tool said, for the card.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Receipt {
    /// `done` | `not_found` | `error`.
    pub outcome: &'static str,
    /// One line for the card.
    pub text: String,
}

/// What one call of the turn came to, as the turn's events told it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Seen {
    /// The tool ran and answered.
    Result { content: String, is_error: bool },
    /// The hook (or the CLI) refused it.
    Denied { reason: String },
}

impl Seen {
    /// One result event of the approved tool. A call the pass hook refused
    /// reaches the turn as a failed result carrying the hook's own words;
    /// that is a refusal, not the connector's answer.
    pub fn of_result(content: &str, is_error: bool) -> Self {
        if is_error && (content.contains(NOT_THE_CALL) || content.contains(NO_PASS)) {
            Self::Denied {
                reason: content.to_string(),
            }
        } else {
            Self::Result {
                content: content.to_string(),
                is_error,
            }
        }
    }
}

/// Whether the pass in `dir` was spent: the hook let the call through.
pub fn spent(dir: &Path) -> bool {
    !dir.join(PASS_FILE).exists()
}

fn one_line(s: &str, max: usize) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() > max {
        format!("{}…", flat.chars().take(max).collect::<String>())
    } else {
        flat
    }
}

/// Whether a failed result says the item is not there any more.
fn gone(content: &str) -> bool {
    let c = content.to_ascii_lowercase();
    [
        "not found",
        "not_found",
        "notfound",
        "404",
        "has been deleted",
        "no longer exists",
    ]
    .iter()
    .any(|w| c.contains(w))
}

/// The receipt, from what the one call came to (`seen`: every result or
/// refusal of the approved tool this turn, in order) and whether the pass
/// was spent. Only a result that is not an error is `done`.
pub fn receipt(act: &Act, seen: &[Seen], spent: bool) -> Receipt {
    let ran = seen.iter().rev().find_map(|s| match s {
        Seen::Result { content, is_error } => Some((content, *is_error)),
        Seen::Denied { .. } => None,
    });
    match ran {
        Some((_, false)) if spent => Receipt {
            outcome: "done",
            text: match act {
                Act::Rsvp { answer, .. } => match answer.as_str() {
                    "accepted" => "Accepted".into(),
                    "tentative" => "Answered maybe".into(),
                    _ => "Declined".into(),
                },
                Act::SaveDraft { mode, .. } if mode == "forward" => {
                    "Note saved as a draft · message not attached".into()
                }
                Act::SaveDraft { .. } => "Draft saved in Gmail".into(),
                Act::Send { .. } => "Sent".into(),
            },
        },
        Some((content, true)) if gone(content) => Receipt {
            outcome: "not_found",
            text: "It is not there any more (deleted or cancelled). Nothing was sent.".into(),
        },
        Some((content, true)) => Receipt {
            outcome: "error",
            text: format!("the connector said: {}", one_line(content, 200)),
        },
        // A result with the pass unspent is not the approved call's.
        Some((_, false)) => Receipt {
            outcome: "error",
            text: "the call was not made, so nothing was sent. Try again.".into(),
        },
        None if spent => Receipt {
            outcome: "error",
            text: "the call started and nothing came back, so it may or may not have gone through — check before trying again".into(),
        },
        None => Receipt {
            outcome: "error",
            text: match seen.last() {
                Some(Seen::Denied { .. }) => "the call did not match what you approved, so nothing was sent. Try again.".into(),
                _ => "the call was not made, so nothing was sent. Try again.".into(),
            },
        },
    }
}

#[cfg(test)]
mod tests;
