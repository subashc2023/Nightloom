//! The Ask position: real permission prompts, the model's questions and
//! plan approval on the Claude Code engine (2026-09-16, nightshift backlog
//! 084; blocker 071 chose the mechanism).
//!
//! Headless, the CLI has nobody to ask, so its `auto` classifier decides or
//! `bypassPermissions` asks nothing — and `AskUserQuestion`, the model's own
//! multiple-choice question, is not even offered. The way through is the
//! CLI's **defer hook** (`external`, code.claude.com/docs/en/hooks "Defer a
//! tool call for later"): a `PreToolUse` hook that answers `defer` makes the
//! `claude -p` process exit with the call pending — `stop_reason:
//! "tool_deferred"`, the call in `deferred_tool_use {id, name, input}` —
//! and a later `claude -p --resume <id>` asks the same hook about the same
//! call again. Nightloom shows the prompt in between and, on the resume,
//! the hook answers `allow` (with the answer in `updatedInput`) or `deny`.
//! Every step was measured on 2.1.263 before this was built (nightshift
//! `notes/runner-design/082-five-measurements-2026-09-16.md`, measurements
//! 4 and 5): the hook fires under safe mode when passed by `--settings`;
//! the exit shape is exactly the documented one; the resume runs the call
//! with the hook's `updatedInput`; and `AskUserQuestion`, `EnterPlanMode`
//! and `ExitPlanMode` appear in the offered tools only with a
//! `--permission-prompt-tool <name>` on the line — ~~a name that need not
//! resolve~~ (superseded the same night: it must resolve, see
//! [`PROMPT_TOOL`]) and one that is never called as long as the hook
//! answers first.
//!
//! **The hook is Nightloom's own binary with a flag** (`nightloom-desktop
//! --permission-hook <dir>`; [`run_hook`] is the whole of it), not a shipped
//! script — the same shape as `--mcp-serve`, which the CLI already spawns
//! by `current_exe()` from inside the signed `.app`, whereas a script would
//! need bundling as a resource and an executable bit codesigning keeps.
//!
//! **The protocol is two files in a per-chat directory**, and the hook
//! reads them in this order:
//!
//! 1. `rules.json` — `{"allow": ["Bash", …]}`, the tools "Allow for this
//!    chat" has granted. A match answers `allow` without pausing.
//! 2. `decision.json` — one answer, for one call: `{"tool_use_id": …,
//!    "decision": "allow" | "deny", "updated_input"?: …, "reason"?: …}`.
//!    Honoured only when its `tool_use_id` is the call the CLI is asking
//!    about, and **removed as it is read**, so an answer can never outlive
//!    the call it was written for and approve the next one by accident.
//! 3. Otherwise `defer`.
//!
//! Nightloom writes both from the shell's side of the same module
//! ([`AskDir`]): the decision just before the resume, the rule when the
//! answer was "for this chat". The directory is per chat rather than per
//! connection because a per-chat rule is the one the user can see and
//! revoke; the permanent kind belongs in the CLI's own settings.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// The rules file's name inside an ask directory.
pub const RULES_FILE: &str = "rules.json";
/// The one-shot decision file's name.
pub const DECISION_FILE: &str = "decision.json";

/// The name given to `--permission-prompt-tool`: Nightloom's own server's
/// [`PromptTool`], as the CLI spells it. It exists to make the CLI offer
/// `AskUserQuestion` and the plan tools, and it has to be real: measured
/// 2026-09-16 (`m084-1-defer.jsonl`), a name no server serves is accepted
/// for the offered-tools list and then fails the first call the hook does
/// not cover — a plain `Read` came back "MCP tool mcp__nightloom__ask
/// (passed via --permission-prompt-tool) not found" and the process exited
/// 1.
///
/// With a real tool the CLI validates it at the first permission check
/// and calls it only when it would actually prompt — `m084-2-tinyprompt.jsonl`
/// shows `initialize`, `tools/list` and nothing else across a read and a
/// deferred write.
pub const PROMPT_TOOL: &str = "mcp__nightloom__ask";
/// The tool's own name on the server.
pub const PROMPT_TOOL_NAME: &str = "ask";

/// The permission host the CLI is pointed at — and, on purpose, one that
/// refuses.
///
/// Every call a person should decide is caught earlier by the hook
/// ([`MATCHER`]) and deferred, so this is reached only for what the hook
/// does not cover and the CLI would still prompt about: a read outside
/// the working directories, a tool the matcher does not name. A prompt
/// tool that *waited* here would be blocker 071's mechanism 2 — the
/// process sitting open on a person — which is what the defer hook was
/// chosen instead of. So it answers `deny` at once, telling the model what
/// happened, in the shape the CLI reads from a prompt tool (`external`, the
/// Agent SDK's `canUseTool` contract, which this flag mirrors:
/// `{"behavior":"allow","updatedInput":…}` or `{"behavior":"deny",
/// "message":…}`). The description tells the model it is not a tool for it
/// to call; if it does anyway, the hook's `mcp__.*` match defers it like any
/// other and the user sees a prompt for a call that does nothing.
pub struct PromptTool;

#[async_trait::async_trait]
impl nightloom_core::tool::Tool for PromptTool {
    fn effect(&self) -> nightloom_core::tool::Effect {
        nightloom_core::tool::Effect::ReadOnly
    }

    fn def(&self) -> nightloom_core::ToolDef {
        nightloom_core::ToolDef {
            name: PROMPT_TOOL_NAME.into(),
            description: "Nightloom's permission host for Claude Code; not a tool for you to \
                 call. It answers permission checks the app could not pause for the user."
                .into(),
            input_schema: serde_json::json!({ "type": "object", "properties": {} }),
        }
    }

    async fn call(
        &self,
        _input: Value,
        _cancel: &nightloom_core::tool::CancellationToken,
    ) -> Result<String, String> {
        Ok(serde_json::json!({
            "behavior": "deny",
            "message": "Nightloom could not pause this call for the user to approve — it is \
                 outside what the app asks about. Do not retry it; say what you needed \
                 and let the user do it or grant it."
        })
        .to_string())
    }
}

/// The tools the hook is registered for: the ones a Manual-mode session
/// would prompt about. Not `.*` — a `Read` inside the working directory
/// never prompts, and pausing the turn for it would make Ask unusable.
/// `mcp__.*` covers Nightloom's own server too: `remember` writes, and the
/// CLI prompts for every MCP tool it has no rule for.
pub const MATCHER: &str = "Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|WebSearch|AskUserQuestion|ExitPlanMode|EnterWorktree|ExitWorktree|CronCreate|CronDelete|ScheduleWakeup|mcp__.*";

/// The call the CLI paused on, as `deferred_tool_use` reports it.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct DeferredCall {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub input: Value,
}

/// What the user decided about a deferred call.
#[derive(Debug, Clone, PartialEq)]
pub enum Answer {
    /// Run it. `updated_input` replaces the call's input when given — the
    /// whole object, which is how a question's answers or an approved
    /// plan travel back (`external`, the hooks doc: `updatedInput`
    /// "replaces the entire input object"; for `AskUserQuestion` and
    /// `ExitPlanMode` `allow` alone "is not sufficient").
    Allow { updated_input: Option<Value> },
    /// Run it, and every later call to the same tool in this chat.
    AllowForChat { updated_input: Option<Value> },
    /// Refuse it; the reason is what the model reads.
    Deny { reason: String },
}

/// The decision file, as written and as read.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
struct Decision {
    tool_use_id: String,
    decision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    updated_input: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

#[derive(Debug, Default, Clone, Deserialize, Serialize)]
struct Rules {
    #[serde(default)]
    allow: Vec<String>,
}

/// One chat's ask directory, from Nightloom's side.
#[derive(Debug, Clone)]
pub struct AskDir {
    dir: PathBuf,
}

impl AskDir {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self { dir: dir.into() }
    }

    pub fn path(&self) -> &Path {
        &self.dir
    }

    /// Write the answer for `call` so the resume's hook finds it. An
    /// "allow for this chat" also lands in the rules, first, so that the
    /// decision file's removal cannot lose the standing grant.
    pub fn write(&self, call: &DeferredCall, answer: &Answer) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let decision = match answer {
            Answer::Allow { updated_input } => Decision {
                tool_use_id: call.id.clone(),
                decision: "allow".into(),
                updated_input: updated_input.clone(),
                reason: None,
            },
            Answer::AllowForChat { updated_input } => {
                self.allow_tool(&call.name)?;
                Decision {
                    tool_use_id: call.id.clone(),
                    decision: "allow".into(),
                    updated_input: updated_input.clone(),
                    reason: None,
                }
            }
            Answer::Deny { reason } => Decision {
                tool_use_id: call.id.clone(),
                decision: "deny".into(),
                updated_input: None,
                reason: Some(reason.clone()),
            },
        };
        write_atomic(
            &self.dir.join(DECISION_FILE),
            &serde_json::to_vec(&decision)?,
        )
    }

    /// Add `name` to the chat's standing allow list.
    pub fn allow_tool(&self, name: &str) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.dir)?;
        let mut rules = read_rules(&self.dir);
        if !rules.allow.iter().any(|n| n == name) {
            rules.allow.push(name.to_string());
        }
        write_atomic(&self.dir.join(RULES_FILE), &serde_json::to_vec(&rules)?)
    }

    /// The tools this chat has granted.
    pub fn allowed(&self) -> Vec<String> {
        read_rules(&self.dir).allow
    }

    /// Drop a decision nobody resumed with — a Stop while the prompt was
    /// up — so it cannot answer a later call that happens to reuse nothing.
    /// (Ids never repeat, so this is tidiness; the one-shot read is the
    /// guarantee.)
    pub fn clear_decision(&self) {
        let _ = std::fs::remove_file(self.dir.join(DECISION_FILE));
    }
}

fn read_rules(dir: &Path) -> Rules {
    std::fs::read(dir.join(RULES_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Write via a sibling and rename: the hook may be reading at the same
/// moment, and a half-written JSON file reads as "no decision" rather than
/// as the wrong one — but it should not read as either.
fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

/// What the CLI hands a `PreToolUse` hook on stdin — the fields read here.
#[derive(Debug, Deserialize)]
struct HookInput {
    #[serde(default)]
    tool_name: String,
    #[serde(default)]
    tool_use_id: String,
}

/// The hook's reply, as the CLI reads it.
#[derive(Debug, PartialEq, Serialize)]
pub struct HookReply {
    #[serde(rename = "hookSpecificOutput")]
    pub hook_specific_output: HookOutput,
}

#[derive(Debug, PartialEq, Serialize)]
pub struct HookOutput {
    #[serde(rename = "hookEventName")]
    pub hook_event_name: String,
    #[serde(rename = "permissionDecision")]
    pub permission_decision: String,
    #[serde(
        rename = "permissionDecisionReason",
        skip_serializing_if = "Option::is_none"
    )]
    pub permission_decision_reason: Option<String>,
    #[serde(rename = "updatedInput", skip_serializing_if = "Option::is_none")]
    pub updated_input: Option<Value>,
}

impl HookReply {
    fn new(decision: &str) -> Self {
        Self {
            hook_specific_output: HookOutput {
                hook_event_name: "PreToolUse".into(),
                permission_decision: decision.into(),
                permission_decision_reason: None,
                updated_input: None,
            },
        }
    }

    pub fn defer() -> Self {
        Self::new("defer")
    }

    pub fn allow(updated_input: Option<Value>) -> Self {
        let mut r = Self::new("allow");
        r.hook_specific_output.updated_input = updated_input;
        r
    }

    pub fn deny(reason: String) -> Self {
        let mut r = Self::new("deny");
        r.hook_specific_output.permission_decision_reason = Some(reason);
        r
    }

    pub fn decision(&self) -> &str {
        &self.hook_specific_output.permission_decision
    }
}

/// The hook's whole decision, pure: the CLI's stdin line and the directory
/// in, the reply out. Order: a standing rule, then the one-shot decision
/// for this very call (consumed), then defer.
pub fn decide(dir: &Path, stdin_json: &str) -> HookReply {
    let input: HookInput = match serde_json::from_str(stdin_json) {
        Ok(i) => i,
        // Unreadable input is not a call anyone can answer; deferring it
        // would park the turn on a prompt that names nothing. Letting the
        // CLI's own flow decide is the conservative reading.
        Err(_) => return HookReply::new("ask"),
    };
    if read_rules(dir).allow.contains(&input.tool_name) {
        return HookReply::allow(None);
    }
    let path = dir.join(DECISION_FILE);
    let decision: Option<Decision> = std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok());
    match decision {
        Some(d) if d.tool_use_id == input.tool_use_id => {
            let _ = std::fs::remove_file(&path);
            if d.decision == "allow" {
                HookReply::allow(d.updated_input)
            } else {
                HookReply::deny(
                    d.reason
                        .filter(|r| !r.trim().is_empty())
                        .unwrap_or_else(|| "the user declined this call".into()),
                )
            }
        }
        _ => HookReply::defer(),
    }
}

/// The process entry: `<binary> --permission-hook <dir>`. Reads stdin to
/// EOF, prints one JSON line, exits 0. Never exits non-zero on purpose —
/// exit 2 is the CLI's "block", and a hook that failed to read is not a
/// hook that decided to refuse.
pub fn run_hook(args: &[String]) -> std::io::Result<()> {
    let dir = args.first().map(PathBuf::from).ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "--permission-hook needs the ask directory",
        )
    })?;
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let reply = decide(&dir, &input);
    let mut out = std::io::stdout().lock();
    out.write_all(serde_json::to_string(&reply)?.as_bytes())?;
    out.write_all(b"\n")?;
    out.flush()
}

/// The `--settings` value that registers the hook: `command` is the hook
/// program and its arguments joined for the shell the CLI runs hooks
/// through, each word single-quoted, so a bundle path with a space in it
/// survives.
pub fn settings_json(hook: &[String], dir: &Path) -> String {
    let mut words: Vec<String> = hook.iter().map(|w| shell_quote(w)).collect();
    words.push(shell_quote(&dir.to_string_lossy()));
    serde_json::json!({
        "hooks": {
            "PreToolUse": [{
                "matcher": MATCHER,
                "hooks": [{ "type": "command", "command": words.join(" ") }]
            }]
        }
    })
    .to_string()
}

fn shell_quote(word: &str) -> String {
    format!("'{}'", word.replace('\'', "'\\''"))
}

/// The in-process half: where a turn waits for the answer.
///
/// The turn's task parks on a oneshot keyed by the call id; the shell's
/// answer command completes it. Cancelling is the caller's race (it holds
/// the turn's token), so a Stop while a prompt is up ends the wait rather
/// than the app. The same shape as the desktop's `WindowApprover`, kept
/// apart from it because the answers differ: a deferred call carries a
/// payload back (`updated_input`), and the engine's `Decision` does not.
#[derive(Debug, Default)]
pub struct AskGate {
    pending: std::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<Answer>>>,
}

impl AskGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register `id` and get the receiver its answer will arrive on.
    pub fn wait(&self, id: &str) -> tokio::sync::oneshot::Receiver<Answer> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.pending.lock().unwrap().insert(id.to_string(), tx);
        rx
    }

    /// Whether `id` is a deferred call still waiting.
    pub fn has(&self, id: &str) -> bool {
        self.pending.lock().unwrap().contains_key(id)
    }

    /// Deliver the answer. `false` when nothing was waiting on `id` — a
    /// double click, or an answer after the turn was stopped — which is a
    /// race the UI cannot avoid rather than an error.
    pub fn answer(&self, id: &str, answer: Answer) -> bool {
        match self.pending.lock().unwrap().remove(id) {
            Some(tx) => tx.send(answer).is_ok(),
            None => false,
        }
    }

    /// Forget every waiting call. The receivers see a closed channel,
    /// which the turn reads as "no answer": it ends without resuming.
    pub fn abandon_all(&self) {
        self.pending.lock().unwrap().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nightloom-ask-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn call() -> DeferredCall {
        DeferredCall {
            id: "toolu_0183kRSEVfCJqZ7Xkb2qtMU8".into(),
            name: "Write".into(),
            input: json!({"file_path": "/tmp/b.txt", "content": "hello"}),
        }
    }

    /// The CLI's stdin line, verbatim from the 2026-09-16 measurement
    /// (`hook-defer-input.log`), trimmed of fields nothing here reads.
    const STDIN: &str = r#"{"session_id":"37d58676-f0f2-489b-8d59-f73106054e94","cwd":"/tmp","hook_event_name":"PreToolUse","tool_name":"Write","tool_input":{"file_path":"/tmp/b.txt","content":"hello"},"tool_use_id":"toolu_0183kRSEVfCJqZ7Xkb2qtMU8","permission_mode":"acceptEdits"}"#;

    /// With nothing written, the hook defers — the exit that makes the
    /// prompt possible. An empty directory and a missing one read alike.
    #[test]
    fn an_unanswered_call_is_deferred() {
        let dir = scratch();
        assert_eq!(decide(&dir, STDIN), HookReply::defer());
        assert_eq!(decide(&dir.join("missing"), STDIN), HookReply::defer());
        let json = serde_json::to_string(&HookReply::defer()).unwrap();
        // The documented shape, key for key.
        assert_eq!(
            json,
            r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"defer"}}"#
        );
    }

    /// The round trip: Nightloom writes the answer, the hook reads it once
    /// and the file is gone, so the same file cannot answer twice.
    #[test]
    fn a_written_decision_is_read_once_with_its_payload() {
        let dir = scratch();
        let ask = AskDir::new(&dir);
        let updated = json!({"file_path": "/tmp/b.txt", "content": "hello hook-updated"});
        ask.write(
            &call(),
            &Answer::Allow {
                updated_input: Some(updated.clone()),
            },
        )
        .unwrap();
        assert!(dir.join(DECISION_FILE).exists());
        let reply = decide(&dir, STDIN);
        assert_eq!(reply.decision(), "allow");
        assert_eq!(reply.hook_specific_output.updated_input, Some(updated));
        assert!(!dir.join(DECISION_FILE).exists(), "consumed on read");
        assert_eq!(
            decide(&dir, STDIN),
            HookReply::defer(),
            "a second ask defers again"
        );
        let json = serde_json::to_string(&reply).unwrap();
        assert!(json.contains(r#""permissionDecision":"allow""#), "{json}");
        assert!(json.contains(r#""updatedInput":{"#), "{json}");
        assert!(!json.contains("permissionDecisionReason"), "{json}");
    }

    /// An answer for another call is not this call's answer. The id is
    /// what ties them; a stale file for a call that was stopped must not
    /// approve the next one the model makes.
    #[test]
    fn a_decision_for_a_different_call_is_ignored_and_kept() {
        let dir = scratch();
        let mut other = call();
        other.id = "toolu_other".into();
        AskDir::new(&dir)
            .write(
                &other,
                &Answer::Allow {
                    updated_input: None,
                },
            )
            .unwrap();
        assert_eq!(decide(&dir, STDIN), HookReply::defer());
        assert!(
            dir.join(DECISION_FILE).exists(),
            "not this call's to consume"
        );
    }

    #[test]
    fn a_denial_carries_its_reason_and_a_blank_one_gets_the_default() {
        let dir = scratch();
        let ask = AskDir::new(&dir);
        ask.write(
            &call(),
            &Answer::Deny {
                reason: "not that file".into(),
            },
        )
        .unwrap();
        let reply = decide(&dir, STDIN);
        assert_eq!(reply.decision(), "deny");
        assert_eq!(
            reply
                .hook_specific_output
                .permission_decision_reason
                .as_deref(),
            Some("not that file")
        );
        ask.write(
            &call(),
            &Answer::Deny {
                reason: "  ".into(),
            },
        )
        .unwrap();
        let reply = decide(&dir, STDIN);
        assert_eq!(
            reply
                .hook_specific_output
                .permission_decision_reason
                .as_deref(),
            Some("the user declined this call")
        );
    }

    /// "Allow for this chat" is a rule that outlives the decision: the
    /// next call to the same tool is allowed without a pause, a different
    /// tool still defers, and the rule is there before the decision is
    /// consumed.
    #[test]
    fn allow_for_this_chat_becomes_a_standing_rule() {
        let dir = scratch();
        let ask = AskDir::new(&dir);
        ask.write(
            &call(),
            &Answer::AllowForChat {
                updated_input: None,
            },
        )
        .unwrap();
        assert_eq!(ask.allowed(), vec!["Write".to_string()]);
        assert_eq!(decide(&dir, STDIN).decision(), "allow");
        // A later Write, new id, no decision file: the rule answers.
        let later = STDIN.replace("toolu_0183kRSEVfCJqZ7Xkb2qtMU8", "toolu_later");
        assert_eq!(decide(&dir, &later).decision(), "allow");
        let bash = later.replace(r#""tool_name":"Write""#, r#""tool_name":"Bash""#);
        assert_eq!(decide(&dir, &bash), HookReply::defer());
        // Granting twice keeps one entry.
        ask.allow_tool("Write").unwrap();
        assert_eq!(ask.allowed().len(), 1);
    }

    /// Torn input is handed back to the CLI's own flow rather than parked
    /// on a prompt with nothing in it.
    #[test]
    fn unreadable_input_is_ask_not_defer() {
        let dir = scratch();
        assert_eq!(decide(&dir, "{not json").decision(), "ask");
    }

    /// The registration the CLI is given: one PreToolUse entry, the
    /// matcher naming the prompting tools, the command quoted word by
    /// word so a path with a space survives the shell.
    #[test]
    fn settings_json_registers_the_hook_command_quoted() {
        let s = settings_json(
            &[
                "/Applications/Night loom.app/Contents/MacOS/nightloom-desktop".into(),
                "--permission-hook".into(),
            ],
            Path::new("/tmp/ask/chat-1"),
        );
        let v: Value = serde_json::from_str(&s).unwrap();
        let entry = &v["hooks"]["PreToolUse"][0];
        assert_eq!(entry["matcher"], MATCHER);
        assert_eq!(
            entry["hooks"][0]["command"],
            "'/Applications/Night loom.app/Contents/MacOS/nightloom-desktop' '--permission-hook' '/tmp/ask/chat-1'"
        );
        assert_eq!(entry["hooks"][0]["type"], "command");
        assert!(MATCHER.contains("AskUserQuestion") && MATCHER.contains("ExitPlanMode"));
        assert!(
            !MATCHER.split('|').any(|t| t == "Read"),
            "a read never pauses the turn"
        );
    }

    /// The prompt tool's answer is the CLI's shape, and it refuses: the
    /// hook is the path that asks, and this is the path that must not
    /// hold the process open.
    #[tokio::test]
    async fn the_prompt_tool_denies_in_the_clis_shape() {
        use nightloom_core::tool::Tool;
        let tool = PromptTool;
        assert_eq!(tool.def().name, PROMPT_TOOL_NAME);
        assert_eq!(PROMPT_TOOL, format!("mcp__nightloom__{PROMPT_TOOL_NAME}"));
        let out = tool
            .call(
                json!({"tool_name": "Read", "input": {}}),
                &Default::default(),
            )
            .await
            .unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["behavior"], "deny");
        assert!(v["message"].as_str().unwrap().contains("Nightloom"));
    }

    #[tokio::test]
    async fn the_gate_delivers_one_answer_and_forgets_the_rest() {
        let gate = AskGate::new();
        let rx = gate.wait("toolu_1");
        assert!(gate.has("toolu_1"));
        assert!(!gate.answer(
            "toolu_9",
            Answer::Allow {
                updated_input: None
            }
        ));
        assert!(gate.answer(
            "toolu_1",
            Answer::Deny {
                reason: "no".into()
            }
        ));
        assert!(!gate.has("toolu_1"));
        assert_eq!(
            rx.await.unwrap(),
            Answer::Deny {
                reason: "no".into()
            }
        );
        // Abandoned: the receiver sees the channel close, not an answer.
        let rx = gate.wait("toolu_2");
        gate.abandon_all();
        assert!(rx.await.is_err());
    }
}
