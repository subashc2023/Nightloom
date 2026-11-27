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

/// Where an expired pass is moved, so "never let through" stays told apart
/// from "spent" (993e review, finding 6).
pub const EXPIRED_FILE: &str = "ref-pass.expired";

/// How long a pass lasts.
pub const PASS_SECS: i64 = 120;

/// How long the action's process may run before it is stopped: the pass's
/// life and a little over. Past the pass nothing more can be let through,
/// so a turn still going is only spending (measured 2026-11-26, 993d
/// review: a turn with no tool to call ran 389 s and wrote 128k tokens).
pub const TURN_SECS: u64 = PASS_SECS as u64 + 15;

/// Why a click does not run under the rail's safe mode: safe mode's
/// `--strict-mcp-config` leaves his claude.ai connectors out of the
/// process, so the one call has no tool to reach (measured 2026-11-26,
/// 993d review: no call made).
pub const SAFE_MODE: &str = "Safe mode is on, so your connectors do not load in the process that would make this call; nothing was sent. Turn safe mode off on the rail to use the card's actions.";

/// The rail's safe mode, before anything is minted: refused with
/// [`SAFE_MODE`], so no pass exists and no process starts.
pub fn refuse_under_safe_mode(safe_mode: bool) -> Result<(), String> {
    if safe_mode {
        Err(SAFE_MODE.into())
    } else {
        Ok(())
    }
}

/// Cancel `cancel` once [`TURN_SECS`] have gone by (the action's
/// deadline); abort the handle when the turn ends first.
pub fn stop_at_deadline(
    cancel: &tokio_util::sync::CancellationToken,
) -> tokio::task::JoinHandle<()> {
    let cancel = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(TURN_SECS)).await;
        cancel.cancel();
    })
}

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
        /// A forward's one address, as he typed it. For a reply, display only.
        #[serde(default)]
        to: String,
        body: String,
        /// Who a reply or a reply to all goes to, as read from the message
        /// itself just before ([`read_call`], [`heads_of`]) and shown on the
        /// confirm — never the reply's tag (993e review, finding 1). Pinned
        /// in the pass, so the mail goes to exactly these.
        #[serde(default)]
        recipients: Option<Recipients>,
    },
}

/// A mail's addressees: plain addresses, as the message's own headers gave them.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize, Serialize)]
pub struct Recipients {
    #[serde(default)]
    pub to: Vec<String>,
    #[serde(default)]
    pub cc: Vec<String>,
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
/// `subject`, `body`; `reply` takes `messageId`, `body`, `replyAll`;
/// `forward` takes `messageId`, `to` (a list), `forwardText` (read
/// 2026-11-27 for 993e, not called).
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
        // Item 993e: the reply or the forward, sent. Only his click on "Send
        // to …" reaches here (after the card's hold, which his Undo stops
        // before this command is ever called), and the body is the words
        // that were on screen: the pass pins its hash, so a body that
        // differs by one character is refused and the pass stays unspent.
        Act::Send {
            mode,
            to,
            body,
            recipients,
        } => {
            if item.kind != "email" {
                return Err("only an email can be replied to or forwarded".into());
            }
            let body = words(body)?;
            if body.trim().is_empty() {
                return Err("nothing is written yet".into());
            }
            let id = clean_id("message id", &item.id)?;
            let mut input = Map::new();
            input.insert("messageId".into(), id.into());
            let (tool, words_key) = match mode.as_str() {
                // To exactly the people the confirm showed, read from the
                // message itself: pinned, so Gmail's own choice (or a model's
                // word) cannot change who gets it.
                "reply" | "replyAll" => {
                    let r = recipients.as_ref().ok_or(
                        "who this goes to was not read from the message, so it cannot be sent",
                    )?;
                    let to: Vec<String> =
                        r.to.iter()
                            .map(String::as_str)
                            .map(address)
                            .collect::<Result<_, _>>()?;
                    let cc: Vec<String> =
                        r.cc.iter()
                            .map(String::as_str)
                            .map(address)
                            .collect::<Result<_, _>>()?;
                    if to.is_empty() {
                        return Err("the message names no one to reply to".into());
                    }
                    if mode == "reply" && (to.len() != 1 || !cc.is_empty()) {
                        return Err("a reply goes to one person; use Reply all for more".into());
                    }
                    // Always `replyAll: false`, Reply all included (993e
                    // re-review, N1): with it on, an unset `cc` leaves
                    // Gmail's own reply-all CC list in force, so a Cc the
                    // read missed would get the mail unshown. Off, Gmail
                    // adds no one: the mail goes to exactly the `to` and
                    // `cc` below, the people the card showed.
                    input.insert("replyAll".into(), false.into());
                    input.insert("to".into(), json!(to));
                    if !cc.is_empty() {
                        input.insert("cc".into(), json!(cc));
                    }
                    input.insert("body".into(), body.into());
                    ("reply", "body")
                }
                // A forward goes only to the one address he typed.
                "forward" => {
                    if to.trim().is_empty() {
                        return Err("say who gets the forward first".into());
                    }
                    input.insert("to".into(), json!([address(to)?]));
                    input.insert("forwardText".into(), body.into());
                    ("forward", "forwardText")
                }
                _ => return Err("a mail is a reply, a reply to all or a forward".into()),
            };
            Ok(Call {
                tool: tool_on(&item.src, tool)?,
                input: Value::Object(input),
                words_key: Some(words_key),
                sends: true,
            })
        }
    }
}

/// The read a mail's confirm makes before Send can be pressed (993e review,
/// finding 1): the message's own headers, through the connector's
/// read-only `get_message` (`MINIMAL`: subject, sender, recipients, no
/// body), run like any action — one pinned call in its own process.
pub fn read_call(item: &Item) -> Result<Call, String> {
    if item.kind != "email" {
        return Err("only an email has recipients to read".into());
    }
    let id = clean_id("message id", &item.id)?;
    Ok(Call {
        tool: tool_on(&item.src, "get_message")?,
        input: json!({ "messageId": id, "messageFormat": "MINIMAL" }),
        words_key: None,
        sends: false,
    })
}

/// A message's own headers, as the card shows them.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
pub struct Heads {
    /// The sender's address.
    pub from: String,
    /// The sender's name, when the message gave one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_name: Option<String>,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    /// Display names by address (lower case), when the message gave them.
    pub names: std::collections::BTreeMap<String, String>,
}

/// Every plain address in `text` (`"Priya S." <p@x.io>, q@y.io`).
pub fn addresses_in(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for part in text.split([',', ';']) {
        let part = part.trim();
        let inner = match (part.rfind('<'), part.rfind('>')) {
            (Some(a), Some(b)) if a < b => &part[a + 1..b],
            _ => part,
        };
        if let Ok(a) = address(inner) {
            out.push(a);
        }
    }
    out
}

fn name_in(text: &str) -> Option<String> {
    let a = text.rfind('<')?;
    let n = text[..a].trim().trim_matches('"').trim();
    (!n.is_empty()).then(|| n.to_string())
}

/// `get_message`'s message object, from the result's documented places only
/// (993e re-review, N4): the result itself when it is the message (it has
/// `sender`), or the `text` of an MCP `text` block holding it — a bare list
/// of blocks, or a result's `content` list — or `structuredContent`. Never
/// from inside another field: a message's own `snippet`, `subject` or body
/// is the sender's text, and JSON written there is not the headers.
fn result_object(content: &str) -> Option<Map<String, Value>> {
    fn message(v: &Value) -> Option<Map<String, Value>> {
        match v {
            Value::Object(m) if m.contains_key("sender") => Some(m.clone()),
            _ => None,
        }
    }
    fn in_blocks(v: &Value) -> Option<Map<String, Value>> {
        v.as_array()?.iter().find_map(|b| {
            if b.get("type").and_then(Value::as_str) != Some("text") {
                return None;
            }
            let t = b.get("text")?.as_str()?;
            message(&serde_json::from_str::<Value>(t.trim()).ok()?)
        })
    }
    let v = serde_json::from_str::<Value>(content.trim()).ok()?;
    message(&v)
        .or_else(|| in_blocks(&v))
        .or_else(|| v.get("content").and_then(in_blocks))
        .or_else(|| v.get("structuredContent").and_then(message))
}

fn strings(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::String(s)) => vec![s.clone()],
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|x| match x {
                Value::String(s) => Some(s.clone()),
                Value::Object(o) => o
                    .get("email")
                    .or_else(|| o.get("address"))
                    .or_else(|| o.get("emailAddress"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                _ => None,
            })
            .collect(),
        Some(Value::Object(o)) => o
            .get("email")
            .or_else(|| o.get("address"))
            .or_else(|| o.get("emailAddress"))
            .and_then(Value::as_str)
            .map(|s| vec![s.to_string()])
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// The headers in `get_message`'s result (`external`: its schema names
/// `sender`, `toRecipients`, `ccRecipients`, `addressDisplayNames`,
/// `subject`; the exact JSON shape is **not measured** — read defensively:
/// strings or lists, `"Name" <addr>` or bare; only those documented names,
/// never `from`/`to`/`cc` or any other field (993e re-review, N4)).
/// No sender address → an error: Send stays off.
pub fn heads_of(content: &str) -> Result<Heads, String> {
    let m = result_object(content)
        .ok_or("the message could not be read (no sender in what came back)")?;
    let raw_from = strings(m.get("sender"));
    let from_text = raw_from.first().cloned().unwrap_or_default();
    let from = addresses_in(&from_text)
        .into_iter()
        .next()
        .ok_or("the message's sender has no address that can be replied to")?;
    let list = |keys: &[&str]| -> Vec<String> {
        keys.iter()
            .find_map(|k| m.get(*k))
            .map(|v| {
                strings(Some(v))
                    .iter()
                    .flat_map(|s| addresses_in(s))
                    .collect()
            })
            .unwrap_or_default()
    };
    let mut names = std::collections::BTreeMap::new();
    match m.get("addressDisplayNames") {
        Some(Value::Object(o)) => {
            for (k, v) in o {
                if let Some(n) = v.as_str().filter(|n| !n.trim().is_empty()) {
                    names.insert(k.to_ascii_lowercase(), n.trim().to_string());
                }
            }
        }
        Some(Value::Array(a)) => {
            for x in a {
                if let Value::Object(o) = x {
                    let addr = o
                        .get("email")
                        .or_else(|| o.get("address"))
                        .and_then(Value::as_str);
                    let name = o
                        .get("displayName")
                        .or_else(|| o.get("name"))
                        .and_then(Value::as_str);
                    if let (Some(a), Some(n)) = (addr, name) {
                        names.insert(a.to_ascii_lowercase(), n.trim().to_string());
                    }
                }
            }
        }
        _ => {}
    }
    for s in strings(m.get("toRecipients"))
        .iter()
        .chain(strings(m.get("ccRecipients")).iter())
        .chain(std::iter::once(&from_text))
    {
        if let (Some(n), Some(a)) = (name_in(s), addresses_in(s).into_iter().next()) {
            names.entry(a.to_ascii_lowercase()).or_insert(n);
        }
    }
    let from_name = names.get(&from.to_ascii_lowercase()).cloned();
    Ok(Heads {
        from_name,
        to: list(&["toRecipients"]),
        cc: list(&["ccRecipients"]),
        subject: m
            .get("subject")
            .and_then(Value::as_str)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty()),
        names,
        from,
    })
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
        if std::fs::rename(&path, dir.join(EXPIRED_FILE)).is_err() {
            let _ = std::fs::remove_file(&path);
        }
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
    !dir.join(PASS_FILE).exists() && !expired(dir)
}

/// Whether the pass in `dir` ran out of time unused.
pub fn expired(dir: &Path) -> bool {
    dir.join(EXPIRED_FILE).exists()
}

/// What an expired, never-used pass came to.
pub const EXPIRED: &str = "Not sent (the approval expired). Nothing went; try again.";

/// The receipt for the action in `dir`: [`receipt`], except that a pass
/// that ran out of time unused says so ([`EXPIRED`]) rather than "may or
/// may not have gone through".
pub fn settle(act: &Act, seen: &[Seen], dir: &Path) -> Receipt {
    let ran = seen.iter().any(|s| matches!(s, Seen::Result { .. }));
    if expired(dir) && !ran {
        return Receipt {
            outcome: "error",
            text: EXPIRED.into(),
        };
    }
    receipt(act, seen, spent(dir))
}

/// What a mail whose fate is unknown says (993e review, finding 4).
pub const MAYBE_SENT: &str = "It may have gone. Check Sent in Gmail before sending again.";

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
    let r = receipt_of(act, seen, spent);
    // A mail let through whose answer is not a success may still have gone
    // (a timeout after Gmail took it): said as unknown, and the card holds
    // Send for that item until he has checked (993e review, finding 4).
    if matches!(act, Act::Send { .. }) && spent && r.outcome == "error" {
        return Receipt {
            outcome: "unknown",
            text: format!("{MAYBE_SENT} ({})", r.text),
        };
    }
    r
}

fn receipt_of(act: &Act, seen: &[Seen], spent: bool) -> Receipt {
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
                // Who it went to: the addresses the call carried (read from
                // the message, or his typed forward address) — never the
                // reply's tag (993e review, finding 2).
                Act::Send {
                    mode,
                    to,
                    recipients,
                    ..
                } => {
                    let who: Vec<String> = if mode == "forward" {
                        address(to).into_iter().collect()
                    } else {
                        recipients
                            .iter()
                            .flat_map(|r| r.to.iter().chain(r.cc.iter()).cloned())
                            .collect()
                    };
                    let what = if mode == "forward" { "Forwarded" } else { "Sent" };
                    if who.is_empty() {
                        what.into()
                    } else {
                        format!("{what} to {}", one_line(&who.join(", "), 160))
                    }
                }
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

/// An action that was on its way when an earlier run quit or died, as the
/// window is told of it (993e review 7; verify: quit mid-send locks the item).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Unfinished {
    /// The item's key as the window keys it (`refKey`: `kind:src:id`), so a
    /// mail's Send can stay locked for that item; empty in an older entry.
    #[serde(default)]
    pub key: String,
    /// What was going, in words that do not say it went: "a reply to a@x".
    pub what: String,
    /// The item's name as the reply showed it.
    #[serde(default)]
    pub item: String,
    /// A mail (reply, reply to all, forward) — not an RSVP.
    #[serde(default)]
    pub mail: bool,
}

/// The window's key for an item (`refTag.ts` `refKey`).
pub fn item_key(item: &Item) -> String {
    format!("{}:{}:{}", item.kind, item.src, item.id)
}

/// What a journal entry says was going (re-review N6): never "Sent", since
/// it may not have gone; an RSVP is an answer, not a mail.
pub fn going_words(act: &Act) -> (String, bool) {
    match act {
        Act::Send {
            mode,
            to,
            recipients,
            ..
        } => {
            if mode == "forward" {
                let who = address(to).unwrap_or_default();
                (
                    if who.is_empty() {
                        "a forward".into()
                    } else {
                        format!("a forward to {who}")
                    },
                    true,
                )
            } else {
                let who: Vec<String> = recipients
                    .iter()
                    .flat_map(|r| r.to.iter().chain(r.cc.iter()).cloned())
                    .collect();
                (
                    if who.is_empty() {
                        "a reply".into()
                    } else {
                        format!("a reply to {}", one_line(&who.join(", "), 160))
                    },
                    true,
                )
            }
        }
        Act::Rsvp { .. } => ("your answer to the invitation".into(), false),
        Act::SaveDraft { .. } => ("a Gmail draft".into(), false),
    }
}

/// The journal of actions on their way (993e review, finding 7): an entry
/// is written before a sending call and removed when that call has ended,
/// so one left over means Nightloom quit or died mid-call. `launch` names
/// this run of the app (pid and start time); every entry starts with it.
/// Returns the entry's path, for [`journal_end`].
pub fn journal_begin(
    dir: &Path,
    launch: &str,
    entry: &Unfinished,
    now: DateTime<Utc>,
) -> Result<std::path::PathBuf, String> {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    std::fs::create_dir_all(dir).map_err(|e| format!("could not make the journal folder: {e}"))?;
    let path = dir.join(format!(
        "{launch}-{}-{}.json",
        now.timestamp_nanos_opt().unwrap_or_default(),
        SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let mut v = serde_json::to_value(entry).map_err(|e| e.to_string())?;
    v["at"] = json!(now);
    std::fs::write(&path, v.to_string())
        .map_err(|e| format!("could not write the journal entry: {e}"))?;
    Ok(path)
}

/// The sending call ended (whatever came of it): its entry goes.
pub fn journal_end(path: &Path) {
    let _ = std::fs::remove_file(path);
}

/// The entries an earlier run left (it quit or died mid-call), read once
/// and cleared. This run's own entries are left alone (993e re-review,
/// N5): they belong to calls still going — a webview reload re-reads the
/// journal while the send runs on in Rust, and only that send's end
/// removes its entry.
pub fn journal_take(dir: &Path, launch: &str) -> Vec<Unfinished> {
    let mine = format!("{launch}-");
    let mut out = Vec::new();
    let mut entries: Vec<_> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .collect();
    entries.sort();
    for path in entries {
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        if name.starts_with(&mine) || !name.ends_with(".json") {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(&path)
            && let Ok(v) = serde_json::from_str::<Value>(&text)
        {
            let s = |k: &str| v[k].as_str().unwrap_or_default().to_string();
            let what = s("what");
            out.push(Unfinished {
                key: s("key"),
                // An entry from before this build: its words may say "Sent".
                what: if what.is_empty() {
                    "a mail".into()
                } else {
                    what
                },
                item: s("item"),
                // Older entries carried no kind; they were written for mail.
                mail: v["mail"].as_bool().unwrap_or(true),
            });
        }
        let _ = std::fs::remove_file(&path);
    }
    out
}

#[cfg(test)]
mod tests;
