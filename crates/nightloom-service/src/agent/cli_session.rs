//! The CLI's own session file, edited by copy (nightshift backlog 062,
//! 2026-09-15).
//!
//! Claude Code keeps a conversation as
//! `~/.claude/projects/<cwd, every non-alphanumeric byte as '-'>/<session
//! id>.jsonl`: one JSON object per line, where the conversation is a tree
//! of `user` / `assistant` / `attachment` nodes chained by `uuid` →
//! `parentUuid` and `--resume <id>` continues from the tree's leaf. An
//! assistant reply is several `assistant` nodes, one per content block,
//! sharing a `message.id`. Around the nodes are bookkeeping lines with no
//! `uuid` — `queue-operation`, `file-history-snapshot`, `atis-latch`,
//! `last-prompt` (which names the leaf), `mode`. Every node and most of
//! the bookkeeping carry the `sessionId`.
//!
//! Nothing here writes into that file. An edit is a **copy under a fresh
//! id** with the change made in the copy, and the shell then resumes the
//! copy — which the CLI accepts, and which keeps the prompt cache for the
//! unchanged prefix (measured 2026-09-15, CLI 2.1.263, Haiku: three
//! shapes of edited copy, each resumed with a cache read of the whole
//! prefix; the numbers are in `docs/service-agent.md`). The original is
//! never modified or deleted; it stays where it was, and the persisted
//! tool outputs it names by absolute path stay readable from the copy.
//!
//! The format is the CLI's and undocumented, so this module is pinned to
//! the version it was measured against ([`MEASURED_VERSION`]) and
//! **refuses** a file whose major version differs or whose first node
//! lacks the fields the walk needs — an error the shell shows as a notice,
//! rather than a copy that reads back as something else. Everything below
//! is a pure function over the parsed lines; [`find`] and [`write_copy`]
//! are the two that touch the disk.
//!
//! Text in the file is the user's and the model's and is treated as data
//! throughout: matched, replaced, never interpreted.

use serde_json::{Value, json};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// The CLI version the file shape was measured on. A file written by a
/// CLI whose major version differs is refused.
pub const MEASURED_VERSION: &str = "2.1.263";

/// What the copy says in place of a turn the user removed but that could
/// not be dropped outright — an assistant reply whose tool calls have to
/// stay so their results keep a call to answer. The same sentence the API
/// engine's projection uses, so the model reads one thing on both.
pub const REMOVED_MARKER: &str = "[Content was removed from the context by the user to save space. It is still in the session log; ask if you need it.]";

#[derive(Debug, thiserror::Error)]
pub enum CliSessionError {
    /// The file is not the shape this build knows. The message is the
    /// notice the UI shows, whole.
    #[error(
        "this Claude Code version keeps sessions in a shape Nightloom does not know; the edit was not applied ({0})"
    )]
    Shape(String),
    /// The shape is right and the turn asked for is not in it.
    #[error("{0}")]
    Locate(String),
    #[error("{0}")]
    Io(#[from] io::Error),
}

/// Which node an edit is aimed at, counted from the newest turn.
///
/// From the newest rather than the oldest because that is the end the two
/// histories are guaranteed to share: Nightloom's log may hold turns from
/// before the chat came to this engine, and the CLI's file holds only the
/// turns since. `from_last == 0` is the newest user prompt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// The user prompt `from_last` turns before the newest, whose text
    /// (as the log projects it now) is `text` — checked before anything is
    /// changed, because a copy edited at the wrong node is worse than a
    /// refusal.
    User { from_last: usize, text: String },
    /// The assistant reply in that turn whose text reads `text`.
    Assistant { from_last: usize, text: String },
}

/// One block of an assistant reply, as the CLI's file holds it
/// (2026-09-15, nightshift backlog 066): the n-th text node of the reply,
/// or the `tool_use` node with this id. A text node is counted rather
/// than indexed because the two histories agree on the order of what was
/// said and not on how the file splits a reply into nodes; a call is
/// named by its id because the id is the one thing both histories carry
/// verbatim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Block {
    /// The `nth` text node of the reply, from 0.
    Text(usize),
    /// The call whose `id` this is, with the result that answers it.
    ToolUse(String),
}

/// One line of the file: the bytes as written, and the object they hold.
///
/// The bytes are kept so a line the edit does not touch is copied out
/// exactly as it came in (bar the id), rather than re-serialized with its
/// keys in whatever order this crate's JSON library prefers. A touched
/// line is re-serialized, which the CLI reads the same.
#[derive(Debug, Clone)]
struct Line {
    raw: String,
    json: Value,
    dirty: bool,
}

impl Line {
    fn uuid(&self) -> Option<&str> {
        self.json.get("uuid").and_then(Value::as_str)
    }
    fn parent(&self) -> Option<&str> {
        self.json.get("parentUuid").and_then(Value::as_str)
    }
    fn kind(&self) -> Option<&str> {
        self.json.get("type").and_then(Value::as_str)
    }
    fn is_node(&self) -> bool {
        self.uuid().is_some()
    }
    fn flag(&self, key: &str) -> bool {
        self.json.get(key).and_then(Value::as_bool).unwrap_or(false)
    }
    fn content(&self) -> Option<&Value> {
        self.json.get("message").and_then(|m| m.get("content"))
    }
    fn content_mut(&mut self) -> Option<&mut Value> {
        self.json
            .get_mut("message")
            .and_then(|m| m.get_mut("content"))
    }
    /// The `message.id` an assistant reply's nodes share.
    fn message_id(&self) -> Option<&str> {
        self.json
            .get("message")
            .and_then(|m| m.get("id"))
            .and_then(Value::as_str)
    }
    /// Whether this is a prompt the user typed: a `user` node on the main
    /// chain whose content is text — a string, or a block list with no
    /// `tool_result` — and not one of the CLI's own synthetic user turns.
    fn is_user_prompt(&self) -> bool {
        if self.kind() != Some("user")
            || self.flag("isSidechain")
            || self.flag("isMeta")
            || self.flag("isCompactSummary")
        {
            return false;
        }
        match self.content() {
            Some(Value::String(_)) => true,
            Some(Value::Array(blocks)) => !blocks
                .iter()
                .any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result")),
            _ => false,
        }
    }
    /// The block type of an assistant node's one content block.
    fn block_type(&self) -> Option<&str> {
        match self.content() {
            Some(Value::Array(blocks)) if blocks.len() == 1 => {
                blocks[0].get("type").and_then(Value::as_str)
            }
            _ => None,
        }
    }
    /// The text of every `text` block, joined.
    fn text(&self) -> String {
        match self.content() {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(blocks)) => blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(""),
            _ => String::new(),
        }
    }
    /// Put `text` where the text was: a string content becomes the text;
    /// in a block list the first `text` block takes it and any further
    /// `text` block goes, while images and documents keep their place.
    fn set_text(&mut self, text: &str) {
        let Some(content) = self.content_mut() else {
            return;
        };
        match content {
            Value::String(s) => *s = text.to_string(),
            Value::Array(blocks) => {
                let mut placed = false;
                blocks.retain_mut(|b| {
                    if b.get("type").and_then(Value::as_str) != Some("text") {
                        return true;
                    }
                    if placed {
                        return false;
                    }
                    placed = true;
                    if let Some(t) = b.get_mut("text") {
                        *t = Value::String(text.to_string());
                    }
                    true
                });
                if !placed {
                    blocks.push(json!({"type": "text", "text": text}));
                }
            }
            _ => {}
        }
        self.dirty = true;
    }
}

/// A parsed session file. Immutable; every edit returns a new one.
#[derive(Debug, Clone)]
pub struct CliSession {
    lines: Vec<Line>,
    /// The id every line carried when it was read.
    id: String,
}

/// The `version` of a node line as `(major, rest)`, or `None` when it is
/// not a dotted number.
fn major_of(version: &str) -> Option<&str> {
    let (major, _) = version.split_once('.')?;
    if major.is_empty() || !major.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some(major)
}

impl CliSession {
    /// Parse the file's text, refusing a shape this build was not
    /// measured against. Blank lines are dropped; a line that is not JSON
    /// is a refusal, since a copy that omits it would not be a copy.
    pub fn parse(text: &str) -> Result<Self, CliSessionError> {
        let mut lines = Vec::new();
        for (n, raw) in text.lines().enumerate() {
            let raw = raw.trim_end_matches('\r');
            if raw.trim().is_empty() {
                continue;
            }
            let json: Value = serde_json::from_str(raw)
                .map_err(|e| CliSessionError::Shape(format!("line {} is not JSON: {e}", n + 1)))?;
            if !json.is_object() {
                return Err(CliSessionError::Shape(format!(
                    "line {} is not an object",
                    n + 1
                )));
            }
            lines.push(Line {
                raw: raw.to_string(),
                json,
                dirty: false,
            });
        }
        let first = lines
            .iter()
            .find(|l| l.is_node())
            .ok_or_else(|| CliSessionError::Shape("no message node in the file".into()))?;
        if first.kind().is_none() || first.json.get("parentUuid").is_none() {
            return Err(CliSessionError::Shape(
                "the first node lacks `type` or `parentUuid`".into(),
            ));
        }
        let version = first
            .json
            .get("version")
            .and_then(Value::as_str)
            .ok_or_else(|| CliSessionError::Shape("the first node names no `version`".into()))?;
        let measured = major_of(MEASURED_VERSION).expect("a dotted constant");
        if major_of(version) != Some(measured) {
            return Err(CliSessionError::Shape(format!(
                "written by Claude Code {version}, measured on {MEASURED_VERSION}"
            )));
        }
        let id = first
            .json
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| CliSessionError::Shape("the first node names no `sessionId`".into()))?
            .to_string();
        Ok(Self { lines, id })
    }

    /// The id the file was written under.
    pub fn id(&self) -> &str {
        &self.id
    }

    /// The file as text, one line per object, every `sessionId` set to
    /// `id`. Lines the edit did not touch go out as they came in, with
    /// the id swapped in place; touched lines are re-serialized.
    pub fn render_as(&self, id: &str) -> String {
        let from = format!("\"sessionId\":\"{}\"", self.id);
        let to = format!("\"sessionId\":\"{id}\"");
        let mut out = String::new();
        for line in &self.lines {
            if line.dirty || !line.raw.contains(&from) && line.json.get("sessionId").is_some() {
                let mut json = line.json.clone();
                if let Some(slot) = json.get_mut("sessionId") {
                    *slot = Value::String(id.to_string());
                }
                out.push_str(&serde_json::to_string(&json).expect("a Value serializes"));
            } else {
                out.push_str(&line.raw.replace(&from, &to));
            }
            out.push('\n');
        }
        out
    }

    /// The main chain — the leaf and its ancestors, root first. The leaf
    /// is the last node in the file that is not a subagent's, which is
    /// what `--resume` continues from; a parent that is missing ends the
    /// walk where it is.
    fn chain(&self) -> Vec<usize> {
        let leaf = self
            .lines
            .iter()
            .rposition(|l| l.is_node() && !l.flag("isSidechain"));
        let Some(mut at) = leaf else {
            return Vec::new();
        };
        let mut chain = vec![at];
        let mut seen = std::collections::HashSet::new();
        seen.insert(at);
        while let Some(parent) = self.lines[at].parent() {
            let Some(i) = self.lines.iter().position(|l| l.uuid() == Some(parent)) else {
                break;
            };
            if !seen.insert(i) {
                break;
            }
            chain.push(i);
            at = i;
        }
        chain.reverse();
        chain
    }

    /// Line indices of the user prompts on the main chain, oldest first.
    fn prompts(&self) -> Vec<usize> {
        self.chain()
            .into_iter()
            .filter(|&i| self.lines[i].is_user_prompt())
            .collect()
    }

    /// The uuid of the last node of the turn `from_last` turns before the
    /// newest — the leaf a checkpoint fork resumes at (nightshift backlog
    /// 104, pass 3): `--resume-session-at <uuid>` keeps everything through
    /// that node and nothing after, so a fork from it starts after that
    /// turn's reply (measured on 2.1.263, survey M3, at a reply's uuid).
    /// The node is the turn's last **assistant** node on the main chain
    /// before the next prompt — the reply's final text — not the last node
    /// of any kind: on 2.1.280 a `prompt_snapshot` attachment follows the
    /// reply (measured in the pass-3 report, the chat `db0e7666`), and the
    /// only form measured to resume is a reply's uuid. A turn with no reply
    /// yet gives its last node, the prompt or its attachments.
    pub fn turn_leaf_uuid(&self, from_last: usize) -> Result<String, CliSessionError> {
        let prompt = self.prompt_from_last(from_last)?;
        let chain = self.chain();
        let Some(start) = chain.iter().position(|&i| i == prompt) else {
            return Err(CliSessionError::Locate(
                "that turn's prompt is not on Claude Code's main chain".into(),
            ));
        };
        let mut last = prompt;
        let mut reply = None;
        for &i in &chain[start + 1..] {
            if self.lines[i].is_user_prompt() {
                break;
            }
            last = i;
            if self.lines[i].kind() == Some("assistant") {
                reply = Some(i);
            }
        }
        self.lines[reply.unwrap_or(last)]
            .uuid()
            .map(str::to_string)
            .ok_or_else(|| CliSessionError::Locate("the turn's last node has no uuid".into()))
    }

    /// How many prompts the user typed on the main chain.
    pub fn prompt_count(&self) -> usize {
        self.prompts().len()
    }

    /// The line index of the prompt `from_last` turns before the newest.
    fn prompt_from_last(&self, from_last: usize) -> Result<usize, CliSessionError> {
        let prompts = self.prompts();
        if from_last >= prompts.len() {
            return Err(CliSessionError::Locate(format!(
                "that turn is not in Claude Code's history: it has {} turn{}, and this one is {} before the newest — it was run on the other engine, or before this session began",
                prompts.len(),
                if prompts.len() == 1 { "" } else { "s" },
                from_last + 1
            )));
        }
        Ok(prompts[prompts.len() - 1 - from_last])
    }

    /// The assistant replies of the turn that starts at prompt line
    /// `prompt`: each a group of line indices sharing a `message.id`, in
    /// order, up to the next prompt.
    fn replies_after(&self, prompt: usize) -> Vec<Vec<usize>> {
        let chain = self.chain();
        let Some(start) = chain.iter().position(|&i| i == prompt) else {
            return Vec::new();
        };
        let mut groups: Vec<Vec<usize>> = Vec::new();
        for &i in &chain[start + 1..] {
            let line = &self.lines[i];
            if line.is_user_prompt() {
                break;
            }
            if line.kind() != Some("assistant") {
                continue;
            }
            match groups.last_mut() {
                Some(g)
                    if self.lines[g[0]].message_id().is_some()
                        && self.lines[g[0]].message_id() == line.message_id() =>
                {
                    g.push(i)
                }
                _ => groups.push(vec![i]),
            }
        }
        groups
    }

    /// Resolve a target to the line indices it names: one for a user
    /// prompt, the reply's nodes for an assistant reply. The text is
    /// checked against what the file holds.
    fn locate(&self, target: &Target) -> Result<Vec<usize>, CliSessionError> {
        match target {
            Target::User { from_last, text } => {
                let i = self.prompt_from_last(*from_last)?;
                if self.lines[i].text().trim() != text.trim() {
                    return Err(CliSessionError::Locate(
                        "that turn reads differently in Claude Code's history than in this chat's log; nothing was changed".into(),
                    ));
                }
                Ok(vec![i])
            }
            Target::Assistant { from_last, text } => {
                let prompt = self.prompt_from_last(*from_last)?;
                let wanted = text.trim();
                self.replies_after(prompt)
                    .into_iter()
                    .find(|g| {
                        g.iter()
                            .map(|&i| self.lines[i].text())
                            .collect::<String>()
                            .trim()
                            == wanted
                    })
                    .ok_or_else(|| {
                        CliSessionError::Locate(
                            "that reply is not in Claude Code's history as this chat's log has it; nothing was changed".into(),
                        )
                    })
            }
        }
    }

    /// A copy with the target's text replaced. A user prompt keeps its
    /// attachments; an assistant reply keeps its thinking (signed as it
    /// is, and about a text that is now different — which the API accepts
    /// on the models measured) and its first text node takes the new
    /// text, ~~any further text node going~~ — the other text nodes stay
    /// since 2026-09-15 (nightshift backlog 066), as the core's projection
    /// keeps them; [`rewrite_block`](Self::rewrite_block) takes any of
    /// them.
    pub fn rewrite(&self, target: &Target, text: &str) -> Result<Self, CliSessionError> {
        match target {
            Target::User { .. } => {
                let found = self.locate(target)?;
                let mut copy = self.clone();
                copy.lines[found[0]].set_text(text);
                Ok(copy)
            }
            Target::Assistant { .. } => self.rewrite_block(target, 0, text),
        }
    }

    /// The text nodes of a located reply, in order.
    fn text_nodes(&self, found: &[usize]) -> Vec<usize> {
        found
            .iter()
            .copied()
            .filter(|&i| self.lines[i].block_type() == Some("text"))
            .collect()
    }

    /// A copy with the `nth` text node of the reply at `target` replaced
    /// (2026-09-15, nightshift backlog 066): one paragraph reworded, the
    /// thinking, the calls and the other paragraphs left where they were,
    /// which is what the core's `edit_block` projects for the other
    /// engine. `nth` counts the reply's text nodes, not its blocks, since
    /// the two histories agree on the order of what was said and not on
    /// how the CLI splits it into nodes. A reply with no text node gives
    /// its last node the text rather than invent a node.
    pub fn rewrite_block(
        &self,
        target: &Target,
        nth: usize,
        text: &str,
    ) -> Result<Self, CliSessionError> {
        let found = self.locate(target)?;
        let mut copy = self.clone();
        let texts = self.text_nodes(&found);
        match texts.get(nth) {
            Some(&i) => copy.lines[i].set_text(text),
            None if texts.is_empty() && nth == 0 => {
                let last = *found.last().expect("a located reply has a node");
                copy.lines[last].set_text(text);
            }
            None => {
                return Err(CliSessionError::Locate(format!(
                    "that reply has {} text block{} in Claude Code's history, not {}; nothing was changed",
                    texts.len(),
                    if texts.len() == 1 { "" } else { "s" },
                    nth + 1
                )));
            }
        }
        Ok(copy)
    }

    /// The line index of the node holding the result that answers the
    /// call `tool_use_id`: a `user` node whose content lists a
    /// `tool_result` with that id.
    fn result_node(&self, tool_use_id: &str) -> Option<usize> {
        self.lines.iter().position(|l| {
            l.kind() == Some("user")
                && matches!(l.content(), Some(Value::Array(blocks)) if blocks.iter().any(|b| {
                    b.get("type").and_then(Value::as_str) == Some("tool_result")
                        && b.get("tool_use_id").and_then(Value::as_str) == Some(tool_use_id)
                }))
        })
    }

    /// The nodes [`remove_block`](Self::remove_block) drops for `block`
    /// of the reply at `found`, and — for a call whose result shares its
    /// node with other results — the node that keeps its place with the
    /// one result taken out of it.
    fn block_nodes(
        &self,
        found: &[usize],
        block: &Block,
    ) -> Result<(Vec<usize>, Option<usize>), CliSessionError> {
        match block {
            Block::Text(nth) => {
                let texts = self.text_nodes(found);
                texts.get(*nth).map(|&i| (vec![i], None)).ok_or_else(|| {
                    CliSessionError::Locate(format!(
                        "that reply has {} text block{} in Claude Code's history, not {}; nothing was changed",
                        texts.len(),
                        if texts.len() == 1 { "" } else { "s" },
                        nth + 1
                    ))
                })
            }
            Block::ToolUse(id) => {
                let call = found
                    .iter()
                    .copied()
                    .find(|&i| {
                        self.lines[i].block_type() == Some("tool_use")
                            && matches!(self.lines[i].content(), Some(Value::Array(b)) if b[0].get("id").and_then(Value::as_str) == Some(id))
                    })
                    .ok_or_else(|| {
                        CliSessionError::Locate(
                            "that tool call is not in Claude Code's history as this chat's log has it; nothing was changed".into(),
                        )
                    })?;
                let Some(result) = self.result_node(id) else {
                    return Ok((vec![call], None));
                };
                let alone =
                    matches!(self.lines[result].content(), Some(Value::Array(b)) if b.len() == 1);
                if alone {
                    Ok((vec![call, result], None))
                } else {
                    Ok((vec![call], Some(result)))
                }
            }
        }
    }

    /// A copy with one block of the reply at `target` removed (2026-09-15,
    /// nightshift backlog 066): a text node dropped and its children
    /// re-parented, or a `tool_use` node dropped **with the node holding
    /// its result** — the pair the core's `elide_block` removes together,
    /// so the copy's tree, like the projection, never has the half of a
    /// call every provider rejects. A result that shares its node with
    /// other results (parallel calls) is taken out of that node, which
    /// stays. Nothing here says a marker: the CLI's own "drop outright"
    /// shape was measured to resume.
    pub fn remove_block(&self, target: &Target, block: &Block) -> Result<Self, CliSessionError> {
        let found = self.locate(target)?;
        let (going, trimmed) = self.block_nodes(&found, block)?;
        let mut copy = self.clone();
        if let (Some(i), Block::ToolUse(id)) = (trimmed, block)
            && let Some(Value::Array(blocks)) = copy.lines[i].content_mut()
        {
            blocks.retain(|b| b.get("tool_use_id").and_then(Value::as_str) != Some(id));
            copy.lines[i].dirty = true;
        }
        copy.drop_nodes(&going);
        Ok(copy)
    }

    /// A copy with one block of the reply put back from `original`, on
    /// [`restore`](Self::restore)'s terms: the text node, or the call's
    /// node and its result's node, from the file the removal copied from.
    /// A result node that stayed (a shared one) takes its original line
    /// again, which puts the one result back among the others.
    pub fn restore_block(
        &self,
        original: &Self,
        target: &Target,
        block: &Block,
    ) -> Result<Self, CliSessionError> {
        let found = original.locate(target)?;
        let (mut nodes, trimmed) = original.block_nodes(&found, block)?;
        nodes.extend(trimmed);
        Ok(self.restore_nodes(original, &nodes))
    }

    /// A copy with the target removed. A user prompt, and an assistant
    /// reply that calls no tool, are dropped outright, their children
    /// re-parented — measured to resume (the orphaned reply reads as a
    /// second assistant message, which the API merges). A reply *with* a
    /// tool call keeps its `tool_use` nodes, so the results that follow
    /// still answer something, loses its thinking, and says
    /// [`REMOVED_MARKER`] where its text was — the same shape the API
    /// engine's elision projects.
    pub fn remove(&self, target: &Target) -> Result<Self, CliSessionError> {
        let found = self.locate(target)?;
        let mut copy = self.clone();
        let has_call = found
            .iter()
            .any(|&i| self.lines[i].block_type() == Some("tool_use"));
        if !has_call {
            copy.drop_nodes(&found);
            return Ok(copy);
        }
        let mut marked = false;
        let mut going = Vec::new();
        for &i in &found {
            match self.lines[i].block_type() {
                Some("text") if !marked => {
                    copy.lines[i].set_text(REMOVED_MARKER);
                    marked = true;
                }
                Some("tool_use") => {}
                _ => going.push(i),
            }
        }
        copy.drop_nodes(&going);
        Ok(copy)
    }

    /// A copy with the target put back from `original` — the file the
    /// turn was removed from, still on disk because nothing here deletes
    /// (2026-09-15, nightshift backlog 064; the Restore that nightshift
    /// blocker 067 said had to wait for the undo stack).
    ///
    /// The target is located in the *original*, by the same address the
    /// removal used, so the text check runs against the file that still
    /// has the text. Each of its nodes is then put back into this copy: one
    /// that is still here (the marked text node of a reply with a tool
    /// call) takes its original line again; one that was dropped (a prompt,
    /// a text reply, a thinking node) is inserted after its parent's line,
    /// a dropped prompt's `file-history-snapshot` with it. Then every node
    /// this copy shares with the original hangs from the parent it had
    /// there, where that parent is present — which undoes the re-parenting
    /// [`drop_nodes`](Self::drop_nodes) did and leaves alone an edge some
    /// other removal, still standing, moved. `last-prompt` lines are left
    /// as they are; a copy resumes from its last node, not from them.
    pub fn restore(&self, original: &Self, target: &Target) -> Result<Self, CliSessionError> {
        let found = original.locate(target)?;
        Ok(self.restore_nodes(original, &found))
    }

    /// [`restore`](Self::restore)'s body over the `original`'s line
    /// indices `found`, shared with [`restore_block`](Self::restore_block).
    fn restore_nodes(&self, original: &Self, found: &[usize]) -> Self {
        let mut copy = self.clone();
        for &i in found {
            let node = &original.lines[i];
            let Some(uuid) = node.uuid() else {
                continue;
            };
            // From the original's file, so it is re-serialized under this
            // copy's id rather than copied out with the original's.
            let mut line = node.clone();
            line.dirty = true;
            match copy.lines.iter().position(|l| l.uuid() == Some(uuid)) {
                Some(j) => copy.lines[j] = line,
                None => {
                    let at = node
                        .parent()
                        .and_then(|p| copy.lines.iter().position(|l| l.uuid() == Some(p)))
                        .map_or(copy.lines.len(), |p| p + 1);
                    copy.lines.insert(at, line);
                    let names = |l: &Line| {
                        l.kind() == Some("file-history-snapshot")
                            && l.json.get("messageId").and_then(Value::as_str) == Some(uuid)
                    };
                    if let Some(snapshot) = original.lines.iter().find(|l| names(l))
                        && !copy.lines.iter().any(names)
                    {
                        let mut snapshot = snapshot.clone();
                        snapshot.dirty = true;
                        copy.lines.insert(at + 1, snapshot);
                    }
                }
            }
        }
        for j in 0..copy.lines.len() {
            let Some(uuid) = copy.lines[j].uuid().map(str::to_string) else {
                continue;
            };
            let Some(parent) = original
                .lines
                .iter()
                .find(|l| l.uuid() == Some(&uuid))
                .and_then(Line::parent)
                .map(str::to_string)
            else {
                continue;
            };
            if copy.lines[j].parent() == Some(&parent)
                || !copy.lines.iter().any(|l| l.uuid() == Some(&parent))
            {
                continue;
            }
            copy.lines[j].json["parentUuid"] = Value::String(parent);
            copy.lines[j].dirty = true;
        }
        copy
    }

    /// A copy cut before the user prompt `from_last` turns before the
    /// newest: that node and everything descending from it go, with the
    /// bookkeeping that named them — `last-prompt` lines naming a dropped
    /// leaf, the prompt's `file-history-snapshot`, the `queue-operation`
    /// pair that preceded it, and every line after it that is not a
    /// surviving node. What is left ends at the turn before, which is
    /// what `--resume` then continues (measured).
    ///
    /// `Ok(None)` when the cut leaves no turn at all — at the oldest
    /// prompt, or before it, which is where a cut lands when the log's
    /// turn predates this CLI session. There is nothing to resume then;
    /// the shell starts the CLI's next turn fresh rather than resume a
    /// file with no conversation in it.
    pub fn truncate(&self, from_last: usize) -> Result<Option<Self>, CliSessionError> {
        if from_last + 1 >= self.prompt_count() {
            return Ok(None);
        }
        let target = self.prompt_from_last(from_last)?;
        let dropped = self.descendants(target);
        let last_kept = self.lines[..target]
            .iter()
            .rposition(|l| l.is_node() && !dropped.contains(l.uuid().unwrap_or("")));
        let mut lines = Vec::new();
        for (i, line) in self.lines.iter().enumerate() {
            let names_dropped = |key: &str| {
                line.json
                    .get(key)
                    .and_then(Value::as_str)
                    .is_some_and(|u| dropped.contains(u))
            };
            if line.uuid().is_some_and(|u| dropped.contains(u)) {
                continue;
            }
            if names_dropped("leafUuid") || names_dropped("messageId") {
                continue;
            }
            if line.kind() == Some("queue-operation")
                && last_kept.is_some_and(|k| i > k)
                && i < target
            {
                continue;
            }
            if i > target && !line.is_node() {
                continue;
            }
            lines.push(line.clone());
        }
        Ok(Some(Self {
            lines,
            id: self.id.clone(),
        }))
    }

    /// The uuids of node `i` and everything under it.
    fn descendants(&self, i: usize) -> std::collections::HashSet<String> {
        let mut out = std::collections::HashSet::new();
        if let Some(u) = self.lines[i].uuid() {
            out.insert(u.to_string());
        }
        loop {
            let before = out.len();
            for l in &self.lines {
                if let (Some(u), Some(p)) = (l.uuid(), l.parent())
                    && out.contains(p)
                {
                    out.insert(u.to_string());
                }
            }
            if out.len() == before {
                return out;
            }
        }
    }

    /// Take the nodes at `indices` out of the tree: each one's children
    /// hang from its nearest surviving ancestor, a `last-prompt` that
    /// named one as the leaf names that ancestor instead, and a dropped
    /// prompt's `file-history-snapshot` goes with it.
    fn drop_nodes(&mut self, indices: &[usize]) {
        let dropped: std::collections::HashMap<String, Option<String>> = indices
            .iter()
            .filter_map(|&i| {
                let l = &self.lines[i];
                l.uuid()
                    .map(|u| (u.to_string(), l.parent().map(str::to_string)))
            })
            .collect();
        // Nearest ancestor that survives, following the parent links
        // through the dropped set.
        let survivor = |mut u: Option<String>| -> Option<String> {
            let mut hops = 0;
            while let Some(p) = &u {
                match dropped.get(p) {
                    Some(next) if hops < dropped.len() + 1 => {
                        u = next.clone();
                        hops += 1;
                    }
                    Some(_) => return None,
                    None => return u,
                }
            }
            None
        };
        self.lines.retain(|l| {
            !l.uuid().is_some_and(|u| dropped.contains_key(u))
                && !(l.kind() == Some("file-history-snapshot")
                    && l.json
                        .get("messageId")
                        .and_then(Value::as_str)
                        .is_some_and(|m| dropped.contains_key(m)))
        });
        for l in &mut self.lines {
            for key in ["parentUuid", "leafUuid"] {
                let named = l.json.get(key).and_then(Value::as_str).map(str::to_string);
                if let Some(named) = named
                    && dropped.contains_key(&named)
                {
                    l.json[key] = match survivor(Some(named)) {
                        Some(p) => Value::String(p),
                        None => Value::Null,
                    };
                    l.dirty = true;
                }
            }
        }
    }
}

/// The CLI's project root: `$CLAUDE_CONFIG_DIR/projects` when that is set,
/// as the CLI honours it, else `~/.claude/projects`.
pub fn projects_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR")
        && !dir.trim().is_empty()
    {
        return Some(PathBuf::from(dir).join("projects"));
    }
    crate::usage::claude_dir().map(|d| d.join("projects"))
}

/// The folder name the CLI gives a working directory: every *character*
/// that is not ASCII alphanumeric becomes one `-` (measured: `/private/tmp`
/// → `-private-tmp`, `~/.claude-bridge` → `-Users-…--claude-bridge`,
/// `Application Support` → `Application-Support`).
///
/// This is the one encoding of that path in Nightloom, and it is the CLI's
/// own: the whole-project review of 2026-09-16 (F17) worried that a cwd
/// with a dot or a non-ASCII character might encode differently from what
/// the CLI's init line reports as `memory_paths.auto`, so it was measured
/// (2.1.263, nightshift `m117/`): a cwd ending `…/m117/é.dir_1 ü` got the
/// folder `…-m117---dir-1--` — `é` and `ü` one dash each (not one per
/// UTF-8 byte), `.`, `_` and the space one dash each — which is exactly
/// this function's output, and the folder exists on disk under that name.
/// Callers therefore build `projects_dir()/project_folder(cwd)` (see
/// [`project_dir`]) rather than carrying the init line's path around.
pub fn project_folder(cwd: &Path) -> String {
    cwd.to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// The CLI's folder for `cwd`: [`projects_dir`] joined with
/// [`project_folder`], or `None` when there is no home directory. The one
/// place the two halves meet, so a caller after the memory file or the
/// session files of a project asks for the folder and never re-encodes.
pub fn project_dir(cwd: &Path) -> Option<PathBuf> {
    projects_dir().map(|p| p.join(project_folder(cwd)))
}

/// Where the session `id` is kept under `projects` ([`projects_dir`]): the
/// folder for `cwd` first, and failing that every project folder, since
/// the cwd the CLI recorded can differ from the one the shell asked for
/// (a symlink, `/tmp` on macOS).
pub fn find(projects: &Path, cwd: &Path, id: &str) -> Result<PathBuf, CliSessionError> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err(CliSessionError::Locate(format!(
            "{id:?} is not a Claude Code session id"
        )));
    }
    let name = format!("{id}.jsonl");
    let direct = projects.join(project_folder(cwd)).join(&name);
    if direct.is_file() {
        return Ok(direct);
    }
    for entry in fs::read_dir(projects)?.flatten() {
        let candidate = entry.path().join(&name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(CliSessionError::Locate(format!(
        "Claude Code's file for session {id} is not under {}",
        projects.display()
    )))
}

/// Write `edited` beside `original` under a fresh id, and return the id.
/// `create_new`, so an id collision — or a second writer — fails rather
/// than overwrites; the original is not opened for writing at all.
pub fn write_copy(original: &Path, edited: &CliSession) -> Result<String, CliSessionError> {
    let id = uuid::Uuid::new_v4().to_string();
    let path = original.with_file_name(format!("{id}.jsonl"));
    let text = edited.render_as(&id);
    let mut file = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)?;
    use std::io::Write;
    file.write_all(text.as_bytes())?;
    file.flush()?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A session file built from the *shape* measured on 2.1.263 — the
    /// node types, the fields, the chaining, the bookkeeping lines — with
    /// dummy content. Never a copy of a real file: a real one carries the
    /// user's instructions files, e-mail and system prompt in its
    /// `attachment` nodes. Two turns: "first" answered "one" (thinking +
    /// text), then "second" answered by a tool call, its result, and
    /// "two".
    const SID: &str = "11111111-1111-1111-1111-111111111111";

    fn node(uuid: &str, parent: Option<&str>, kind: &str, extra: Value) -> String {
        let mut o = json!({
            "parentUuid": parent,
            "isSidechain": false,
            "type": kind,
            "uuid": uuid,
            "timestamp": "2026-09-15T22:00:00.000Z",
            "userType": "external",
            "cwd": "/private/tmp/x",
            "sessionId": SID,
            "version": MEASURED_VERSION,
            "gitBranch": "main"
        });
        for (k, v) in extra.as_object().unwrap() {
            o[k] = v.clone();
        }
        serde_json::to_string(&o).unwrap()
    }

    fn user(uuid: &str, parent: Option<&str>, content: Value) -> String {
        node(
            uuid,
            parent,
            "user",
            json!({"message": {"role": "user", "content": content}, "promptSource": "sdk"}),
        )
    }

    fn attachment(uuid: &str, parent: &str, kind: &str) -> String {
        node(
            uuid,
            Some(parent),
            "attachment",
            json!({"attachment": {"type": kind, "text": "dummy"}, "rendered": [{"content": "dummy"}]}),
        )
    }

    fn assistant(uuid: &str, parent: &str, msg: &str, block: Value) -> String {
        node(
            uuid,
            Some(parent),
            "assistant",
            json!({
                "message": {"model": "claude-haiku-4-5-20251001", "id": msg, "type": "message",
                            "role": "assistant", "content": [block], "stop_reason": "end_turn",
                            "usage": {"input_tokens": 10, "output_tokens": 5}},
                "apiBlockIndex": 0,
                "requestId": "req_x"
            }),
        )
    }

    fn fixture() -> String {
        let lines = vec![
            json!({"type": "queue-operation", "operation": "enqueue", "timestamp": "t", "sessionId": SID, "content": "first"}).to_string(),
            json!({"type": "queue-operation", "operation": "dequeue", "timestamp": "t", "sessionId": SID}).to_string(),
            user("u1", None, json!("first")),
            attachment("a1", "u1", "environment"),
            attachment("a2", "a1", "instructions"),
            json!({"type": "file-history-snapshot", "messageId": "u1", "snapshot": {"messageId": "u1", "trackedFileBackups": {}, "timestamp": "t"}, "isSnapshotUpdate": false}).to_string(),
            json!({"type": "atis-latch", "atis": "", "sessionId": SID}).to_string(),
            attachment("a3", "a2", "prompt_snapshot"),
            json!({"type": "last-prompt", "lastPrompt": "first", "leafUuid": "a3", "sessionId": SID}).to_string(),
            assistant("s1", "a3", "msg_1", json!({"type": "thinking", "thinking": "hm", "signature": "sig1"})),
            assistant("s2", "s1", "msg_1", json!({"type": "text", "text": "one"})),
            json!({"type": "last-prompt", "lastPrompt": "first", "leafUuid": "s2", "sessionId": SID}).to_string(),
            json!({"type": "queue-operation", "operation": "enqueue", "timestamp": "t", "sessionId": SID, "content": "second"}).to_string(),
            json!({"type": "queue-operation", "operation": "dequeue", "timestamp": "t", "sessionId": SID}).to_string(),
            user("u2", Some("s2"), json!("second")),
            attachment("a4", "u2", "total_tokens_reminder"),
            json!({"type": "file-history-snapshot", "messageId": "u2", "snapshot": {"messageId": "u2", "trackedFileBackups": {}, "timestamp": "t"}, "isSnapshotUpdate": false}).to_string(),
            assistant("s3", "a4", "msg_2", json!({"type": "thinking", "thinking": "look", "signature": "sig2"})),
            assistant("s4", "s3", "msg_2", json!({"type": "text", "text": "let me look"})),
            assistant("s5", "s4", "msg_2", json!({"type": "tool_use", "id": "toolu_1", "name": "Read", "input": {"file_path": "a.txt"}})),
            user("r1", Some("s5"), json!([{"type": "tool_result", "tool_use_id": "toolu_1", "content": "contents"}])),
            assistant("s6", "r1", "msg_3", json!({"type": "text", "text": "two"})),
            json!({"type": "last-prompt", "lastPrompt": "second", "leafUuid": "s6", "sessionId": SID}).to_string(),
            json!({"type": "mode", "mode": "normal", "sessionId": SID}).to_string(),
        ];
        lines.join("\n") + "\n"
    }

    fn parsed(text: &str) -> Vec<Value> {
        text.lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }

    fn uuids(text: &str) -> Vec<String> {
        parsed(text)
            .iter()
            .filter_map(|o| o.get("uuid").and_then(Value::as_str).map(str::to_string))
            .collect()
    }

    #[test]
    fn the_fixture_parses_and_counts_two_prompts() {
        let s = CliSession::parse(&fixture()).unwrap();
        assert_eq!(s.id(), SID);
        assert_eq!(s.prompt_count(), 2, "tool results are not prompts");
        assert_eq!(s.chain().len(), 13);
    }

    /// Every line that carried the id carries the new one, and nothing
    /// else about an untouched line changes.
    #[test]
    fn the_id_substitution_reaches_every_line() {
        let s = CliSession::parse(&fixture()).unwrap();
        let out = s.render_as("22222222-2222-2222-2222-222222222222");
        assert!(!out.contains(SID), "{out}");
        let n = out.matches("22222222-2222").count();
        let m = fixture().matches(SID).count();
        assert_eq!(n, m);
        // Untouched lines are byte-identical bar the id.
        let expected = fixture().replace(SID, "22222222-2222-2222-2222-222222222222");
        assert_eq!(out, expected);
    }

    /// The checkpoint's leaf (backlog 104, pass 3): the last node of the
    /// turn on the main chain — the first turn's reply text `s2`, the
    /// second's final text `s6` (past its tool call and result) — and a
    /// turn the file does not have is the usual refusal.
    #[test]
    fn a_turns_leaf_is_its_replys_last_node() {
        let s = CliSession::parse(&fixture()).unwrap();
        assert_eq!(s.turn_leaf_uuid(1).unwrap(), "s2");
        assert_eq!(s.turn_leaf_uuid(0).unwrap(), "s6");
        assert!(s.turn_leaf_uuid(2).is_err());
        // The shape 2.1.280 writes (measured): a `prompt_snapshot`
        // attachment after the reply, the next prompt hanging off it. The
        // leaf is still the reply, not the attachment; and a turn with no
        // reply yet gives its last node.
        let lines = [
            user("u1", None, json!("first")),
            attachment("a1", "u1", "prompt_snapshot"),
            assistant("s1", "a1", "msg_1", json!({"type": "text", "text": "one"})),
            attachment("a2", "s1", "prompt_snapshot"),
            user("u2", Some("a2"), json!("second")),
            attachment("a3", "u2", "total_tokens_reminder"),
        ];
        let s = CliSession::parse(&(lines.join("\n") + "\n")).unwrap();
        assert_eq!(s.turn_leaf_uuid(1).unwrap(), "s1");
        assert_eq!(s.turn_leaf_uuid(0).unwrap(), "a3");
    }

    #[test]
    fn a_user_edit_changes_that_prompt_and_nothing_else() {
        let s = CliSession::parse(&fixture()).unwrap();
        let target = Target::User {
            from_last: 1,
            text: "first".into(),
        };
        let out = s
            .rewrite(&target, "first, edited")
            .unwrap()
            .render_as("new");
        let lines = parsed(&out);
        let u1 = lines.iter().find(|o| o["uuid"] == "u1").unwrap();
        assert_eq!(u1["message"]["content"], "first, edited");
        assert_eq!(u1["sessionId"], "new");
        let u2 = lines.iter().find(|o| o["uuid"] == "u2").unwrap();
        assert_eq!(u2["message"]["content"], "second");
        assert_eq!(uuids(&out), uuids(&fixture()), "no node added or dropped");
        assert_eq!(lines.len(), fixture().lines().count());
    }

    /// An attachment turn keeps its image and swaps its caption.
    #[test]
    fn a_user_edit_keeps_attachments() {
        let text = fixture().replace(
            r#""content":"second""#,
            r#""content":[{"type":"text","text":"second"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}]"#,
        );
        let s = CliSession::parse(&text).unwrap();
        let target = Target::User {
            from_last: 0,
            text: "second".into(),
        };
        let out = s.rewrite(&target, "look at this").unwrap().render_as("new");
        let u2 = parsed(&out)
            .into_iter()
            .find(|o| o["uuid"] == "u2")
            .unwrap();
        let blocks = u2["message"]["content"].as_array().unwrap().clone();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["text"], "look at this");
        assert_eq!(blocks[1]["type"], "image");
    }

    #[test]
    fn an_assistant_edit_swaps_the_text_and_keeps_the_thinking() {
        let s = CliSession::parse(&fixture()).unwrap();
        let target = Target::Assistant {
            from_last: 1,
            text: "one".into(),
        };
        let out = s.rewrite(&target, "uno").unwrap().render_as("new");
        let lines = parsed(&out);
        let s1 = lines.iter().find(|o| o["uuid"] == "s1").unwrap();
        assert_eq!(s1["message"]["content"][0]["thinking"], "hm");
        assert_eq!(s1["message"]["content"][0]["signature"], "sig1");
        let s2 = lines.iter().find(|o| o["uuid"] == "s2").unwrap();
        assert_eq!(s2["message"]["content"][0]["text"], "uno");
        assert_eq!(uuids(&out), uuids(&fixture()));
    }

    /// A text-only reply is dropped outright and its child re-parented;
    /// a reply with a tool call keeps the call and says the marker.
    #[test]
    fn removal_drops_a_text_reply_and_marks_a_tool_reply() {
        let s = CliSession::parse(&fixture()).unwrap();
        let out = s
            .remove(&Target::Assistant {
                from_last: 1,
                text: "one".into(),
            })
            .unwrap()
            .render_as("new");
        let lines = parsed(&out);
        assert!(lines.iter().all(|o| o["uuid"] != "s1" && o["uuid"] != "s2"));
        let u2 = lines.iter().find(|o| o["uuid"] == "u2").unwrap();
        assert_eq!(u2["parentUuid"], "a3", "re-parented past the dropped reply");
        let leaf: Vec<&Value> = lines
            .iter()
            .filter(|o| o["type"] == "last-prompt")
            .collect();
        assert_eq!(leaf[1]["leafUuid"], "a3", "the leaf pointer follows");

        let out = s
            .remove(&Target::Assistant {
                from_last: 0,
                text: "let me look".into(),
            })
            .unwrap()
            .render_as("new");
        let lines = parsed(&out);
        assert!(lines.iter().all(|o| o["uuid"] != "s3"), "thinking dropped");
        let s4 = lines.iter().find(|o| o["uuid"] == "s4").unwrap();
        assert_eq!(s4["message"]["content"][0]["text"], REMOVED_MARKER);
        assert_eq!(s4["parentUuid"], "a4");
        let s5 = lines.iter().find(|o| o["uuid"] == "s5").unwrap();
        assert_eq!(
            s5["message"]["content"][0]["type"], "tool_use",
            "the call stays"
        );
        let r1 = lines.iter().find(|o| o["uuid"] == "r1").unwrap();
        assert_eq!(r1["parentUuid"], "s5", "the result still answers it");
    }

    #[test]
    fn removing_a_prompt_drops_it_and_its_snapshot() {
        let s = CliSession::parse(&fixture()).unwrap();
        let out = s
            .remove(&Target::User {
                from_last: 0,
                text: "second".into(),
            })
            .unwrap()
            .render_as("new");
        let lines = parsed(&out);
        assert!(lines.iter().all(|o| o["uuid"] != "u2"));
        assert!(lines.iter().all(|o| o["messageId"] != "u2"));
        let a4 = lines.iter().find(|o| o["uuid"] == "a4").unwrap();
        assert_eq!(a4["parentUuid"], "s2");
    }

    /// The main chain as uuids, with each node's message — what `--resume`
    /// reads; line order and bookkeeping are not part of it.
    fn shape(s: &CliSession) -> Vec<(String, Option<String>, Value)> {
        s.chain()
            .into_iter()
            .map(|i| {
                let l = &s.lines[i];
                (
                    l.uuid().unwrap().to_string(),
                    l.parent().map(str::to_string),
                    l.json.get("message").cloned().unwrap_or(Value::Null),
                )
            })
            .collect()
    }

    /// A restore from the original puts the removed turn back in both of
    /// removal's shapes: the dropped reply (and a dropped prompt) return
    /// with their edges, the marked reply gets its text and thinking
    /// back, and the tree reads as the original did.
    #[test]
    fn a_restore_from_the_original_undoes_both_shapes_of_removal() {
        let original = CliSession::parse(&fixture()).unwrap();
        let before = shape(&original);

        // The dropped text reply.
        let target = Target::Assistant {
            from_last: 1,
            text: "one".into(),
        };
        let removed = CliSession::parse(&original.remove(&target).unwrap().render_as("b")).unwrap();
        assert_eq!(removed.chain().len(), before.len() - 2);
        let restored = removed.restore(&original, &target).unwrap();
        assert_eq!(shape(&restored), before);
        let out = restored.render_as("c");
        assert!(
            !out.contains(SID) && !out.contains("\"sessionId\":\"b\""),
            "one id throughout"
        );

        // The marked tool reply: thinking back, marker gone, call untouched.
        let target = Target::Assistant {
            from_last: 0,
            text: "let me look".into(),
        };
        let removed = CliSession::parse(&original.remove(&target).unwrap().render_as("b")).unwrap();
        let restored = removed.restore(&original, &target).unwrap();
        assert_eq!(shape(&restored), before);
        assert!(!restored.render_as("c").contains(REMOVED_MARKER));

        // A dropped prompt, its snapshot with it.
        let target = Target::User {
            from_last: 0,
            text: "second".into(),
        };
        let removed = CliSession::parse(&original.remove(&target).unwrap().render_as("b")).unwrap();
        assert_eq!(removed.prompt_count(), 1);
        let restored = removed.restore(&original, &target).unwrap();
        assert_eq!(shape(&restored), before);
        assert_eq!(restored.prompt_count(), 2);
        let snapshots = parsed(&restored.render_as("c"))
            .into_iter()
            .filter(|o| o["type"] == "file-history-snapshot" && o["messageId"] == "u2")
            .count();
        assert_eq!(snapshots, 1);

        // A restore of a turn the original does not have is the same
        // refusal a removal of it would be.
        let err = removed
            .restore(
                &original,
                &Target::User {
                    from_last: 0,
                    text: "not this".into(),
                },
            )
            .unwrap_err();
        assert!(err.to_string().contains("reads differently"), "{err}");
    }

    // ---- One block of a reply (nightshift backlog 066, 2026-09-15) ----

    /// The fixture with the first reply split in two text nodes: "one"
    /// then "one more" (`s2b`, under `s2`), the second prompt hanging from
    /// the new node.
    fn fixture_two_texts() -> String {
        let extra = assistant(
            "s2b",
            "s2",
            "msg_1",
            json!({"type": "text", "text": "one more"}),
        );
        let mut lines: Vec<String> = fixture().lines().map(str::to_string).collect();
        let at = lines
            .iter()
            .position(|l| l.contains("\"uuid\":\"s2\""))
            .unwrap();
        lines.insert(at + 1, extra);
        for l in &mut lines {
            if l.contains("\"uuid\":\"u2\"") || l.contains("\"type\":\"last-prompt\"") {
                *l = l.replace("\"parentUuid\":\"s2\"", "\"parentUuid\":\"s2b\"");
                *l = l.replace("\"leafUuid\":\"s2\"", "\"leafUuid\":\"s2b\"");
            }
        }
        lines.join("\n") + "\n"
    }

    /// The n-th text node takes the text and the other text node, the
    /// thinking and the call stay; `rewrite` on a reply is its first text
    /// node and drops nothing now; a count past the reply's text nodes is
    /// a refusal that names the count.
    #[test]
    fn a_block_rewrite_changes_one_text_node_and_keeps_the_rest() {
        let s = CliSession::parse(&fixture_two_texts()).unwrap();
        let target = Target::Assistant {
            from_last: 1,
            text: "oneone more".into(),
        };
        let out = s
            .rewrite_block(&target, 1, "uno más")
            .unwrap()
            .render_as("new");
        let lines = parsed(&out);
        let s2 = lines.iter().find(|o| o["uuid"] == "s2").unwrap();
        assert_eq!(s2["message"]["content"][0]["text"], "one");
        let s2b = lines.iter().find(|o| o["uuid"] == "s2b").unwrap();
        assert_eq!(s2b["message"]["content"][0]["text"], "uno más");
        assert_eq!(
            uuids(&out),
            uuids(&fixture_two_texts()),
            "no node added or dropped"
        );

        let out = s.rewrite(&target, "uno").unwrap().render_as("new");
        let lines = parsed(&out);
        let s2 = lines.iter().find(|o| o["uuid"] == "s2").unwrap();
        assert_eq!(s2["message"]["content"][0]["text"], "uno");
        let s2b = lines.iter().find(|o| o["uuid"] == "s2b").unwrap();
        assert_eq!(
            s2b["message"]["content"][0]["text"], "one more",
            "the other text node stays"
        );
        assert_eq!(uuids(&out), uuids(&fixture_two_texts()));

        let err = s.rewrite_block(&target, 2, "x").unwrap_err();
        assert!(err.to_string().contains("has 2 text blocks"), "{err}");
    }

    /// A call goes with the node holding its result, the reply's text and
    /// thinking staying and the next reply re-parented past both; a text
    /// node goes alone; the restore from the original puts either back and
    /// the tree reads as it did; a shared result node keeps its place with
    /// the one result taken out, and gets it back.
    #[test]
    fn a_block_removal_drops_a_call_with_its_result_or_one_text_node() {
        let original = CliSession::parse(&fixture()).unwrap();
        let before = shape(&original);
        let target = Target::Assistant {
            from_last: 0,
            text: "let me look".into(),
        };
        let call = Block::ToolUse("toolu_1".into());
        let out = original
            .remove_block(&target, &call)
            .unwrap()
            .render_as("b");
        let lines = parsed(&out);
        assert!(lines.iter().all(|o| o["uuid"] != "s5"), "the call is gone");
        assert!(
            lines.iter().all(|o| o["uuid"] != "r1"),
            "its result with it"
        );
        let s4 = lines.iter().find(|o| o["uuid"] == "s4").unwrap();
        assert_eq!(s4["message"]["content"][0]["text"], "let me look");
        assert!(lines.iter().any(|o| o["uuid"] == "s3"), "thinking stays");
        let s6 = lines.iter().find(|o| o["uuid"] == "s6").unwrap();
        assert_eq!(s6["parentUuid"], "s4", "the next reply hangs from the text");
        let removed = CliSession::parse(&out).unwrap();
        let restored = removed.restore_block(&original, &target, &call).unwrap();
        assert_eq!(shape(&restored), before);

        // A text node alone.
        let text = Block::Text(0);
        let out = original
            .remove_block(&target, &text)
            .unwrap()
            .render_as("b");
        let lines = parsed(&out);
        assert!(lines.iter().all(|o| o["uuid"] != "s4"));
        let s5 = lines.iter().find(|o| o["uuid"] == "s5").unwrap();
        assert_eq!(s5["parentUuid"], "s3", "the call hangs from the thinking");
        let removed = CliSession::parse(&out).unwrap();
        let restored = removed.restore_block(&original, &target, &text).unwrap();
        assert_eq!(shape(&restored), before);

        // A result that shares its node: the node stays, one result out.
        let shared = fixture().replace(
            r#"[{"content":"contents","tool_use_id":"toolu_1","type":"tool_result"}]"#,
            r#"[{"content":"contents","tool_use_id":"toolu_1","type":"tool_result"},{"content":"other","tool_use_id":"toolu_2","type":"tool_result"}]"#,
        );
        assert_ne!(shared, fixture(), "the fixture's result line was found");
        let original = CliSession::parse(&shared).unwrap();
        let before = shape(&original);
        let out = original
            .remove_block(&target, &call)
            .unwrap()
            .render_as("b");
        let lines = parsed(&out);
        let r1 = lines.iter().find(|o| o["uuid"] == "r1").unwrap();
        let results = r1["message"]["content"].as_array().unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0]["tool_use_id"], "toolu_2");
        assert!(lines.iter().all(|o| o["uuid"] != "s5"));
        let removed = CliSession::parse(&out).unwrap();
        let restored = removed.restore_block(&original, &target, &call).unwrap();
        assert_eq!(shape(&restored), before);

        // A call the file does not have.
        let err = original
            .remove_block(&target, &Block::ToolUse("toolu_9".into()))
            .unwrap_err();
        assert!(
            err.to_string().contains("not in Claude Code's history"),
            "{err}"
        );
    }

    /// The cut drops the prompt, everything under it, and the bookkeeping
    /// that named any of it; what is left ends at the turn before.
    #[test]
    fn truncation_cuts_before_the_prompt_with_its_bookkeeping() {
        let s = CliSession::parse(&fixture()).unwrap();
        let out = s.truncate(0).unwrap().unwrap().render_as("new");
        let lines = parsed(&out);
        assert_eq!(uuids(&out), ["u1", "a1", "a2", "a3", "s1", "s2"]);
        assert!(lines.iter().all(|o| o["messageId"] != "u2"));
        assert!(lines.iter().all(|o| o["leafUuid"] != "s6"));
        assert!(
            lines.iter().all(|o| o["type"] != "mode"),
            "trailing bookkeeping goes"
        );
        let queued: Vec<&Value> = lines
            .iter()
            .filter(|o| o["type"] == "queue-operation")
            .collect();
        assert_eq!(
            queued.len(),
            2,
            "the second prompt's pair goes, the first's stays"
        );
        assert_eq!(queued[0]["content"], "first");
        assert_eq!(lines.last().unwrap()["leafUuid"], "s2");
        assert_eq!(s.truncate(0).unwrap().unwrap().prompt_count(), 1);
        // Cutting at the first prompt, or before the file's history
        // begins, leaves no conversation to resume.
        assert!(s.truncate(1).unwrap().is_none());
        assert!(s.truncate(2).unwrap().is_none());
    }

    #[test]
    fn refusals_name_the_reason() {
        // A version from another major.
        let text = fixture().replace(MEASURED_VERSION, "3.0.1");
        let err = CliSession::parse(&text).unwrap_err().to_string();
        assert!(err.contains("shape Nightloom does not know"), "{err}");
        assert!(err.contains("3.0.1"), "{err}");
        // A minor step is not a refusal.
        let text = fixture().replace(MEASURED_VERSION, "2.2.0");
        assert!(CliSession::parse(&text).is_ok());
        // The first node without a parent key.
        let text = fixture().replace(r#""parentUuid":null,"#, "");
        assert!(CliSession::parse(&text).is_err());
        // A line that is not JSON.
        assert!(CliSession::parse("{}\nnot json\n").is_err());
        // No nodes at all.
        assert!(CliSession::parse(r#"{"type":"mode","mode":"normal"}"#).is_err());

        // The right shape, the wrong turn.
        let s = CliSession::parse(&fixture()).unwrap();
        let err = s
            .rewrite(
                &Target::User {
                    from_last: 5,
                    text: "x".into(),
                },
                "y",
            )
            .unwrap_err()
            .to_string();
        assert!(err.contains("not in Claude Code's history"), "{err}");
        let err = s
            .rewrite(
                &Target::User {
                    from_last: 0,
                    text: "something else".into(),
                },
                "y",
            )
            .unwrap_err()
            .to_string();
        assert!(err.contains("reads differently"), "{err}");
        assert!(
            s.rewrite(
                &Target::Assistant {
                    from_last: 0,
                    text: "not said".into()
                },
                "y"
            )
            .is_err()
        );
    }

    #[test]
    fn the_project_folder_is_the_cwd_with_every_other_byte_dashed() {
        assert_eq!(project_folder(Path::new("/private/tmp")), "-private-tmp");
        assert_eq!(
            project_folder(Path::new("/Users/a/.claude-bridge workdir")),
            "-Users-a--claude-bridge-workdir"
        );
    }

    /// The measured pair from `m117/` (F17): a non-ASCII character is one
    /// dash, not one per byte, and a dot, an underscore and a space are one
    /// each — so the folder Nightloom computes is the one the CLI's init
    /// line names in `memory_paths.auto`.
    #[test]
    fn the_project_folder_matches_the_clis_own_encoding_on_a_dotted_non_ascii_cwd() {
        let cwd = "/private/tmp/claude-501/-Users-swaraagsistla-Documents-ComputerScience-Nightloom-nightshift-code/885ac8f6-2f89-4d49-9d63-0d1e84fd58d1/scratchpad/m117/é.dir_1 ü";
        let measured = "-private-tmp-claude-501--Users-swaraagsistla-Documents-ComputerScience-Nightloom-nightshift-code-885ac8f6-2f89-4d49-9d63-0d1e84fd58d1-scratchpad-m117---dir-1--";
        assert_eq!(project_folder(Path::new(cwd)), measured);
        let dir = project_dir(Path::new(cwd)).expect("a home directory");
        assert_eq!(dir.file_name().unwrap().to_string_lossy(), measured);
        assert_eq!(dir.parent(), projects_dir().as_deref());
    }

    #[test]
    fn a_copy_is_written_beside_the_original_and_the_original_is_untouched() {
        let dir = std::env::temp_dir().join(format!("nightloom-cli-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let original = dir.join(format!("{SID}.jsonl"));
        fs::write(&original, fixture()).unwrap();
        let before = fs::read(&original).unwrap();
        let s = CliSession::parse(&fixture()).unwrap();
        let edited = s
            .rewrite(
                &Target::User {
                    from_last: 0,
                    text: "second".into(),
                },
                "second, edited",
            )
            .unwrap();
        let id = write_copy(&original, &edited).unwrap();
        assert_ne!(id, SID);
        let copy = fs::read_to_string(dir.join(format!("{id}.jsonl"))).unwrap();
        assert!(copy.contains(&format!("\"sessionId\":\"{id}\"")));
        assert!(copy.contains("second, edited"));
        assert!(!copy.contains(SID));
        assert_eq!(fs::read(&original).unwrap(), before);
        // The copy parses back as a session of its own.
        assert_eq!(CliSession::parse(&copy).unwrap().id(), id);
        fs::remove_dir_all(&dir).ok();
    }

    /// The file is found under the cwd's own folder, and under any other
    /// project folder when the cwd the CLI recorded differs.
    #[test]
    fn a_session_file_is_found_by_its_cwd_or_by_a_scan() {
        let projects =
            std::env::temp_dir().join(format!("nightloom-projects-{}", uuid::Uuid::new_v4()));
        let cwd = Path::new("/private/tmp/work dir");
        let own = projects.join(project_folder(cwd));
        fs::create_dir_all(&own).unwrap();
        fs::write(own.join("aaaa-1.jsonl"), fixture()).unwrap();
        let other = projects.join("-elsewhere");
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("bbbb-2.jsonl"), fixture()).unwrap();

        assert_eq!(
            find(&projects, cwd, "aaaa-1").unwrap(),
            own.join("aaaa-1.jsonl")
        );
        assert_eq!(
            find(&projects, cwd, "bbbb-2").unwrap(),
            other.join("bbbb-2.jsonl")
        );
        assert!(find(&projects, cwd, "cccc-3").is_err());
        assert!(find(&projects, cwd, "../x").is_err(), "not a path");
        fs::remove_dir_all(&projects).ok();
    }
}
