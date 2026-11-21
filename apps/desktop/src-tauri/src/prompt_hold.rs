//! A changed prompt layer reaches a running Claude Code chat at its first
//! cold moment, never by breaking a warm one (nightshift backlog 174).
//!
//! Each chat keeps a small file of the layer texts its CLI conversation
//! holds — what went out on `--append-system-prompt` the last time a layer
//! was taken — beside its log, under `prompt-held/<chat id>.json`. At every
//! connect the fresh prompt is laid against it, layer by layer (by
//! [`SegmentKind`]; the several `AGENTS.md` of a walk are one layer):
//!
//! - a layer whose text is the same goes out as it is;
//! - a layer whose file changed is **pending**: the held text goes out
//!   again, so the cached prefix stays byte-identical, and the Context page
//!   marks it *newer version exists*;
//! - a pending layer is **taken** — the new text goes out — when the shell
//!   asks for it by name (*Update now*), or when the chat's cache timer
//!   reads cold and the layer is scheduled (*Update at the next cold
//!   moment*) or the Settings default applies every change then. A kept
//!   layer (*Keep this version*) is never taken at cold.
//!
//! Why the flag alone is not enough, measured on CLI 2.1.280
//! (`notes/runner-design/174-report-2026-09-22.md`): the CLI records the
//! prompt on a conversation's first request and resends the record on
//! every resume, whatever the flag says — so a taken layer also turns the
//! record off for that chat from then on (`--system-prompt-snapshot off`,
//! blocker 320), and the held text is what keeps the prefix stable instead.
//!
//! The library prompt (`Custom`) is not held: it changes only by his click
//! on the rail, which is the click.
//!
//! **The subagent rules layer** (nightshift backlog 291 + 293, 2026-10-03)
//! is held like a file but has its own rule, his: a change is always taken
//! at the next cold moment (Keep and the Settings default do not apply —
//! the limits are enforced whatever the prompt says), and while the cache
//! is warm the chat's next message carries the new rules as an appended
//! note ([`Pending::take_rules_note`]) — once per change, recorded in the
//! hold as `rules_noted`. This is blocker 322's append route, built for
//! this layer only.
//!
//! **The volatile layers** (nightshift item 725, 2026-11-15) — the notes
//! index, the thread's Start here, the vault index — change with the
//! chat's own writes, so they are held like the rest, and each message
//! carries what moved in them since as a short note after it
//! ([`Pending::take_layer_note`], `nightloom_service::layer_note`), so the
//! model is not left reading a stale index. A connect also checks the
//! chat's own log before it believes the window's "cold"
//! ([`log_warm`]): measured that night, a connect at 11:28 PM took the
//! changed layers on a chat whose last reply was 13 minutes old under a
//! 1-hour cache, and the next turn read 17% of its history from cache.

use nightloom_core::{Segment, SegmentKind, SystemPrompt};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

/// One chat's hold, as its file stores it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Hold {
    /// The layer segments the CLI conversation holds, in the order sent.
    pub segments: Vec<Segment>,
    /// *Keep this version*: never taken at a cold moment.
    #[serde(default)]
    pub kept: BTreeSet<SegmentKind>,
    /// *Update at the next cold moment*, clicked while the Settings
    /// default waits for the click.
    #[serde(default)]
    pub scheduled: BTreeSet<SegmentKind>,
    /// The chat has taken a layer: the CLI's record is off for it.
    #[serde(default)]
    pub snapshot_off: bool,
    /// The subagent rules text (the layer's newer text) a warm message
    /// has already carried as a note (backlog 293): not carried again.
    /// Cleared when the layer is taken or the change is undone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rules_noted: Option<String>,
    /// A volatile layer's text a message has already told the model of
    /// (item 725): the next note tells only what moved after it. Dropped
    /// when the layer is taken or the file is back to the held text.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub noted: BTreeMap<SegmentKind, String>,
}

/// What a pending layer's mark offers, as the Context page shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Choice {
    /// Nothing clicked: the Settings default decides.
    Auto,
    /// *Update at the next cold moment*.
    Cold,
    /// *Keep this version*.
    Keep,
}

/// A layer whose file is newer than the text the chat holds.
#[derive(Debug, Clone, Serialize)]
pub struct PendingLayer {
    pub kind: SegmentKind,
    /// The text the chat holds and is still sent.
    pub held: String,
    /// The text the file has now; empty when the layer is gone.
    pub newer: String,
    pub choice: Choice,
}

/// The pending layers of the chat the live connection was built for.
#[derive(Debug, Clone, Default, Serialize)]
pub struct PendingView {
    /// That chat's id; `None` for a chat not yet created.
    pub session: Option<String>,
    pub layers: Vec<PendingLayer>,
    /// The note the chat's next message carries (backlog 293): the
    /// subagent rules changed while the cache is warm, and no message has
    /// carried them yet. `None` once one has.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rules_note: Option<String>,
}

/// Managed beside `AppState`: the last connect's [`PendingView`] and the
/// file it was read from.
#[derive(Default)]
pub struct Pending {
    pub view: tokio::sync::Mutex<PendingView>,
    pub file: tokio::sync::Mutex<Option<PathBuf>>,
    /// The hold of a connection built before its chat existed (New chat):
    /// what its first turn sends, kept until that turn creates the chat
    /// and [`Pending::bind_new_chat`] writes it under the chat's id.
    pub unsaved: tokio::sync::Mutex<Option<Hold>>,
    /// Where the connection's volatile layers are read from (item 725),
    /// for the note each message carries.
    pub sources: tokio::sync::Mutex<nightloom_service::layer_note::LayerSources>,
}

impl Pending {
    /// The connection was built for no chat and a turn has just created
    /// one (`send_agent`): from now on it is that chat's connection. Its
    /// hold — exactly the layer texts the first turn sends, which the CLI
    /// records as the chat's snapshot — is written under the chat's id
    /// (`file` is `None` for an ephemeral chat, which keeps nothing).
    ///
    /// Without this the chat had no hold file until its next connect, which
    /// adopted the file's text *then* as "held" — a layer changed between
    /// the two turns was never marked (batch review 2026-09-23, finding 2).
    /// Nothing happens when the connection already belongs to a chat.
    pub async fn bind_new_chat(&self, session: &str, file: Option<PathBuf>) {
        let mut view = self.view.lock().await;
        if view.session.is_some() {
            return;
        }
        let hold = self.unsaved.lock().await.take();
        if let (Some(f), Some(h)) = (&file, &hold)
            && let Err(e) = save(f, h)
        {
            eprintln!("prompt hold not saved at {}: {e}", f.display());
        }
        view.session = Some(session.to_string());
        *self.file.lock().await = file;
    }

    /// The subagent rules note for this message of `session` (backlog
    /// 293), taken once: the view forgets it and the chat's hold records
    /// which text was carried, so the next message does not repeat it.
    /// `None` when the connection is another chat's or nothing changed.
    pub async fn take_rules_note(&self, session: &str) -> Option<String> {
        let mut view = self.view.lock().await;
        if view.session.as_deref() != Some(session) {
            return None;
        }
        let note = view.rules_note.take()?;
        let newer = view
            .layers
            .iter()
            .find(|l| l.kind == SegmentKind::SubagentRules)
            .map(|l| l.newer.clone());
        if let (Some(file), Some(newer)) = (self.file.lock().await.clone(), newer) {
            let mut hold = load(&file).unwrap_or_default();
            hold.rules_noted = Some(newer);
            if let Err(e) = save(&file, &hold) {
                eprintln!("prompt hold not saved at {}: {e}", file.display());
            }
        }
        Some(note)
    }

    /// What moved in the volatile layers since `session`'s held text (or
    /// the last note), for this message (item 725); recorded in the hold so
    /// the next message does not repeat it. `None` when the connection is
    /// another chat's, the chat has no hold, or nothing moved.
    pub async fn take_layer_note(&self, session: &str) -> Option<String> {
        let view = self.view.lock().await;
        if view.session.as_deref() != Some(session) {
            return None;
        }
        let file = self.file.lock().await.clone()?;
        let sources = self.sources.lock().await.clone();
        drop(view);
        tokio::task::spawn_blocking(move || {
            let mut hold = load(&file)?;
            let mut held: BTreeMap<SegmentKind, String> = BTreeMap::new();
            for kind in nightloom_service::layer_note::VOLATILE {
                let g = group(&hold.segments, kind);
                if !g.is_empty() {
                    held.insert(kind, text_of(&g));
                }
            }
            let before = hold.noted.clone();
            let note = nightloom_service::layer_note::update_note(
                &held,
                &mut hold.noted,
                &sources.fresh(),
            );
            if hold.noted != before
                && let Err(e) = save(&file, &hold)
            {
                eprintln!("prompt hold not saved at {}: {e}", file.display());
            }
            note
        })
        .await
        .ok()
        .flatten()
    }

    /// A click on a mark of `session`'s layer `kind`, written to that
    /// chat's hold file. Refused when the live connection was built for
    /// another chat: its hold file is not this chat's, and the mark he
    /// clicked described the other chat's text (batch review 2026-09-23,
    /// finding 3).
    pub async fn choose_for(
        &self,
        session: &str,
        kind: SegmentKind,
        choice: Choice,
    ) -> Result<PendingView, String> {
        let mut view = self.view.lock().await;
        if view.session.as_deref() != Some(session) {
            return Err("the marks shown were another chat's — reopen the Context page".into());
        }
        let Some(file) = self.file.lock().await.clone() else {
            return Err("this chat has no held prompt to choose for".into());
        };
        let mut hold = load(&file).unwrap_or_default();
        choose(&mut hold, kind, choice);
        save(&file, &hold).map_err(|e| e.to_string())?;
        for layer in view.layers.iter_mut().filter(|l| l.kind == kind) {
            layer.choice = choice;
        }
        Ok(view.clone())
    }
}

/// What the shell asked for at this connect.
#[derive(Debug, Clone, Default)]
pub struct Ask {
    /// The chat's cache timer reads cold (no cached turn counts as cold,
    /// as `cliUpdate`'s rule has it).
    pub cold: bool,
    /// The Settings default: every change is taken at the next cold moment.
    pub auto: bool,
    /// *Update now*, by layer.
    pub now: Vec<SegmentKind>,
}

/// The result of laying a fresh prompt against a hold.
#[derive(Debug, Clone)]
pub struct Resolved {
    /// What goes on the flag.
    pub prompt: SystemPrompt,
    /// The hold to write back.
    pub hold: Hold,
    pub pending: Vec<PendingLayer>,
    /// The note the next message carries (backlog 293), if any.
    pub rules_note: Option<String>,
}

/// Where a chat's hold lives.
pub fn file_for(log_dir: &Path, session: &str) -> PathBuf {
    log_dir.join("prompt-held").join(format!("{session}.json"))
}

pub fn load(path: &Path) -> Option<Hold> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn save(path: &Path, hold: &Hold) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let text = serde_json::to_string_pretty(hold).map_err(std::io::Error::other)?;
    std::fs::write(path, text)
}

/// The ladder rank the composed prompt is ordered by; `Custom` last.
fn rank(kind: SegmentKind) -> usize {
    SegmentKind::LAYERS
        .iter()
        .position(|k| *k == kind)
        .unwrap_or(SegmentKind::LAYERS.len())
}

fn group(segments: &[Segment], kind: SegmentKind) -> Vec<Segment> {
    segments
        .iter()
        .filter(|s| s.kind == kind)
        .cloned()
        .collect()
}

fn text_of(segments: &[Segment]) -> String {
    segments
        .iter()
        .map(|s| s.text.as_str())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Lay `fresh` against the chat's hold.
///
/// `hold` is `None` for a chat with no hold yet, and `has_cli` says whether
/// the chat has a Claude Code conversation to protect at all: with none,
/// nothing is cached and the fresh prompt is taken whole and becomes the
/// hold. A chat from before this build (a conversation and no file) adopts
/// its fresh prompt the same way — what its CLI recorded is not known here.
pub fn resolve(fresh: &SystemPrompt, hold: Option<&Hold>, has_cli: bool, ask: &Ask) -> Resolved {
    let layers: Vec<Segment> = fresh
        .segments()
        .iter()
        .filter(|s| s.kind != SegmentKind::Custom)
        .cloned()
        .collect();
    let (Some(hold), true) = (hold, has_cli) else {
        return Resolved {
            prompt: fresh.clone(),
            hold: Hold {
                segments: layers,
                // A conversation with no hold on file (a chat begun before
                // item 174, or one whose hold was lost): what its CLI
                // recorded on its first turn is unknown, so the snapshot
                // goes off and the CLI renders the prompt from the flag —
                // with it on, the fresh text never reached the resumed
                // chat (measured, nightshift `535m-report-2026-11-10.md`:
                // a thread bound to such a chat never reached it). A chat
                // with no conversation yet records this prompt itself.
                snapshot_off: hold.is_none() && has_cli,
                ..Hold::default()
            },
            pending: Vec::new(),
            rules_note: None,
        };
    };

    // Every layer kind either side has: the fresh prompt's order, so a
    // chat with nothing pending sends exactly the fresh bytes; a kind only
    // the hold has goes where the ladder puts it.
    let mut kinds: Vec<SegmentKind> = Vec::new();
    for s in &layers {
        if !kinds.contains(&s.kind) {
            kinds.push(s.kind);
        }
    }
    for s in &hold.segments {
        if !kinds.contains(&s.kind) {
            let at = kinds
                .iter()
                .position(|k| rank(*k) > rank(s.kind))
                .unwrap_or(kinds.len());
            kinds.insert(at, s.kind);
        }
    }

    let mut next = Hold {
        segments: Vec::new(),
        kept: BTreeSet::new(),
        scheduled: BTreeSet::new(),
        snapshot_off: hold.snapshot_off,
        rules_noted: None,
        noted: BTreeMap::new(),
    };
    let mut pending = Vec::new();
    let mut rules_note = None;
    for kind in kinds {
        let new_group = group(&layers, kind);
        let held_group = group(&hold.segments, kind);
        if text_of(&new_group) == text_of(&held_group) {
            next.segments.extend(new_group);
            continue;
        }
        // The subagent rules (backlog 293): always at the cold moment;
        // warm, held, with a note for the next message once per change.
        if kind == SegmentKind::SubagentRules {
            let newer = text_of(&new_group);
            if ask.now.contains(&kind) || ask.cold {
                next.segments.extend(new_group);
                next.snapshot_off = true;
                continue;
            }
            if hold.rules_noted.as_deref() != Some(newer.as_str()) && !newer.is_empty() {
                rules_note = Some(nightloom_service::subagent_rules_update_note(&newer));
            }
            next.rules_noted = hold.rules_noted.clone();
            pending.push(PendingLayer {
                kind,
                held: text_of(&held_group),
                newer,
                choice: Choice::Auto,
            });
            next.segments.extend(held_group);
            continue;
        }
        let kept = hold.kept.contains(&kind);
        let scheduled = hold.scheduled.contains(&kind);
        let take = ask.now.contains(&kind) || (!kept && ask.cold && (scheduled || ask.auto));
        if take {
            next.segments.extend(new_group);
            next.snapshot_off = true;
        } else {
            let choice = if kept {
                next.kept.insert(kind);
                Choice::Keep
            } else if scheduled {
                next.scheduled.insert(kind);
                Choice::Cold
            } else {
                Choice::Auto
            };
            pending.push(PendingLayer {
                kind,
                held: text_of(&held_group),
                newer: text_of(&new_group),
                choice,
            });
            // What a message already told of this layer still stands.
            if let Some(n) = hold.noted.get(&kind) {
                next.noted.insert(kind, n.clone());
            }
            next.segments.extend(held_group);
        }
    }

    // The flag: the composed layers, then the fresh prompt's own text.
    let mut prompt = SystemPrompt::new();
    for s in next.segments.iter().cloned() {
        prompt.push(s);
    }
    for s in fresh
        .segments()
        .iter()
        .filter(|s| s.kind == SegmentKind::Custom)
    {
        prompt.push(s.clone());
    }
    Resolved {
        prompt,
        hold: next,
        pending,
        rules_note,
    }
}

/// The newest live reply that went to the cache: its send, the lifetime it
/// recorded, and its context. A reply with no send time, no lifetime or no
/// usage — a turn stopped before its answer, or cut by a quit (item 893:
/// the 4:12 PM install cut one, and the connect after it read the chat as
/// cold under a 1-hour cache 16 minutes old) — is passed over for the one
/// before it, which is a lower bound: whatever the cut request did to the
/// cache only kept it warmer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CachedReply {
    pub sent_ms: i64,
    pub ttl_ms: i64,
    pub context: u64,
}

pub fn cached_reply(session: &nightloom_core::Session) -> Option<CachedReply> {
    session
        .live_events()
        .iter()
        .rev()
        .find_map(|(_, e)| match e {
            nightloom_core::SessionEvent::AssistantMessage {
                sent_at: Some(sent),
                cache_ttl: Some(ttl),
                usage,
                ..
            } if usage.input_tokens + usage.output_tokens > 0 => Some(CachedReply {
                sent_ms: sent.timestamp_millis(),
                ttl_ms: i64::try_from(ttl.duration().as_millis()).unwrap_or(i64::MAX),
                context: usage.input_tokens + usage.output_tokens,
            }),
            _ => None,
        })
}

/// Whether `session`'s own log says its cache is still warm at `now_ms`
/// (item 725): its newest live reply that went to the cache
/// ([`cached_reply`]) recorded when it was sent and the lifetime it left,
/// and that lifetime has not run out. A lower bound — a keep-warm ping or
/// an aside only lengthens it ([`touched_warm`] reads those) — so a
/// connect that believes it over the window's "cold" never takes a layer
/// on a warm cache, and one that does not still takes on a truly cold one.
pub fn log_warm(session: &nightloom_core::Session, now_ms: i64) -> bool {
    cached_reply(session).is_some_and(|r| r.sent_ms.saturating_add(r.ttl_ms) > now_ms)
}

/// Whether the chat's keep-warm pings or its newest aside kept `reply`'s
/// cache warm to `now_ms` (item 893): the chat's `ask/<id>` folder, read
/// by the rule `hand_off::cold_at` uses — a ping that hit holds it an hour
/// from its send; an aside that read at least half the reply's context,
/// the reply's lifetime from its send. Measured: the ICS 51 chat's 2:36 PM
/// ping held its cache, its last reply was 1:41 PM, and the 2:46 PM
/// connect took the changed file list as if cold — 13,136 of 167,028 read.
pub fn touched_warm(reply: &CachedReply, ask_dir: &Path, now_ms: i64) -> bool {
    let mut cold = reply.sent_ms.saturating_add(reply.ttl_ms);
    for p in nightloom_service::keep_warm::read_pings(ask_dir) {
        if p.hit && p.sent_ms > reply.sent_ms {
            cold = cold.max(p.sent_ms + nightloom_service::keep_warm::TTL_MS);
        }
    }
    if let Some(a) = nightloom_service::hand_off::last_aside_read(ask_dir)
        && a.sent_ms > reply.sent_ms
        && a.cache_read.saturating_mul(2) >= reply.context
    {
        cold = cold.max(a.sent_ms.saturating_add(reply.ttl_ms));
    }
    cold > now_ms
}

/// Record a click on a pending layer's mark in `hold`. `Auto` clears both.
pub fn choose(hold: &mut Hold, kind: SegmentKind, choice: Choice) {
    hold.kept.remove(&kind);
    hold.scheduled.remove(&kind);
    match choice {
        Choice::Auto => {}
        Choice::Cold => {
            hold.scheduled.insert(kind);
        }
        Choice::Keep => {
            hold.kept.insert(kind);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prompt(memory: &str) -> SystemPrompt {
        let mut p = SystemPrompt::new();
        p.push(Segment::new(SegmentKind::UserMemory, "memory", memory));
        p.push(Segment::new(
            SegmentKind::ProjectInstructions,
            "AGENTS.md",
            "rules",
        ));
        p.push(Segment::new(SegmentKind::EngineNote, "engine-note", "note"));
        p.push(Segment::new(SegmentKind::Custom, "library", "library"));
        p
    }

    /// The hold a chat's first turn wrote: connected on New chat, no
    /// conversation yet (~~`has_cli: true`~~ — since 543's check 6 that
    /// case turns the snapshot off, and is tested on its own below).
    fn held(memory: &str) -> Hold {
        resolve(&prompt(memory), None, false, &Ask::default()).hold
    }

    /// 543's check 6, the case measured in `535m-report-2026-11-10.md`: a
    /// chat with a CLI conversation and no hold on file takes the fresh
    /// prompt whole — and now with the snapshot off, so it reaches the CLI.
    #[test]
    fn a_conversation_with_no_hold_takes_the_fresh_prompt_with_the_snapshot_off() {
        let mut fresh = prompt("m");
        fresh.push(Segment::new(
            SegmentKind::Thread,
            "alpha",
            "THREAD alpha: start here",
        ));
        let r = resolve(&fresh, None, true, &Ask::default());
        assert!(flat(&r).contains("THREAD alpha: start here"));
        assert!(r.hold.snapshot_off);
        assert!(r.pending.is_empty());
        // It stays off on the next connect, when the hold is on file.
        let again = resolve(&fresh, Some(&r.hold), true, &Ask::default());
        assert!(again.hold.snapshot_off);
        // A New chat (no conversation yet) records the prompt itself.
        assert!(
            !resolve(&fresh, None, false, &Ask::default())
                .hold
                .snapshot_off
        );
    }

    fn json(h: &Hold) -> serde_json::Value {
        serde_json::to_value(h).unwrap()
    }

    fn flat(r: &Resolved) -> String {
        r.prompt.render_flat().unwrap()
    }

    #[test]
    fn a_chat_with_no_conversation_takes_the_fresh_prompt_whole() {
        let r = resolve(&prompt("new"), Some(&held("old")), false, &Ask::default());
        assert_eq!(flat(&r), prompt("new").render_flat().unwrap());
        assert!(r.pending.is_empty());
        assert!(!r.hold.snapshot_off);
        assert!(
            r.hold
                .segments
                .iter()
                .all(|s| s.kind != SegmentKind::Custom)
        );
    }

    /// Warm: the changed file is pending and the flag is byte-identical to
    /// what the chat holds — the cached prefix is untouched.
    #[test]
    fn a_warm_chat_keeps_the_held_text_and_marks_the_layer() {
        let hold = held("old");
        let ask = Ask {
            cold: false,
            auto: true,
            now: vec![],
        };
        let r = resolve(&prompt("new"), Some(&hold), true, &ask);
        assert_eq!(flat(&r), prompt("old").render_flat().unwrap());
        assert_eq!(r.pending.len(), 1);
        assert_eq!(r.pending[0].kind, SegmentKind::UserMemory);
        assert_eq!(r.pending[0].held, "old");
        assert_eq!(r.pending[0].newer, "new");
        assert_eq!(r.pending[0].choice, Choice::Auto);
        assert!(!r.hold.snapshot_off);
        assert_eq!(json(&r.hold), json(&hold));
    }

    #[test]
    fn a_cold_chat_takes_the_new_text_under_the_default() {
        let ask = Ask {
            cold: true,
            auto: true,
            now: vec![],
        };
        let r = resolve(&prompt("new"), Some(&held("old")), true, &ask);
        assert_eq!(flat(&r), prompt("new").render_flat().unwrap());
        assert!(r.pending.is_empty());
        assert!(
            r.hold.snapshot_off,
            "the record goes off once a layer is taken"
        );
    }

    #[test]
    fn with_the_default_off_only_a_scheduled_layer_is_taken_at_cold() {
        let ask = Ask {
            cold: true,
            auto: false,
            now: vec![],
        };
        let hold = held("old");
        let r = resolve(&prompt("new"), Some(&hold), true, &ask);
        assert_eq!(r.pending.len(), 1, "waits for the click");
        let mut clicked = hold.clone();
        choose(&mut clicked, SegmentKind::UserMemory, Choice::Cold);
        let warm = resolve(
            &prompt("new"),
            Some(&clicked),
            true,
            &Ask {
                cold: false,
                ..ask.clone()
            },
        );
        assert_eq!(
            warm.pending[0].choice,
            Choice::Cold,
            "scheduled, still warm"
        );
        let r = resolve(&prompt("new"), Some(&warm.hold), true, &ask);
        assert!(r.pending.is_empty());
        assert_eq!(flat(&r), prompt("new").render_flat().unwrap());
    }

    /// Keep holds across any number of reconnects, cold or not; Update now
    /// still takes it.
    #[test]
    fn a_kept_layer_survives_cold_reconnects_until_update_now() {
        let mut hold = held("old");
        choose(&mut hold, SegmentKind::UserMemory, Choice::Keep);
        let cold = Ask {
            cold: true,
            auto: true,
            now: vec![],
        };
        let mut h = hold;
        for _ in 0..3 {
            let r = resolve(&prompt("new"), Some(&h), true, &cold);
            assert_eq!(flat(&r), prompt("old").render_flat().unwrap());
            assert_eq!(r.pending[0].choice, Choice::Keep);
            h = r.hold;
        }
        let now = Ask {
            cold: false,
            auto: true,
            now: vec![SegmentKind::UserMemory],
        };
        let r = resolve(&prompt("new"), Some(&h), true, &now);
        assert_eq!(flat(&r), prompt("new").render_flat().unwrap());
        assert!(r.pending.is_empty());
        assert!(r.hold.kept.is_empty());
    }

    /// A layer that appears (a new file) or goes (a deleted one) is a
    /// change like any other: held out, or held in, until taken.
    #[test]
    fn a_new_or_removed_layer_is_pending_too() {
        let mut more = prompt("old");
        more.push(Segment::new(SegmentKind::Knowledge, "vault", "index"));
        let warm = Ask::default();
        let r = resolve(&more, Some(&held("old")), true, &warm);
        assert_eq!(r.pending.len(), 1);
        assert_eq!(r.pending[0].kind, SegmentKind::Knowledge);
        assert_eq!(r.pending[0].held, "");
        assert!(!flat(&r).contains("index"));

        let base = resolve(&more, None, true, &warm).hold;
        let r = resolve(&prompt("old"), Some(&base), true, &warm);
        assert_eq!(r.pending[0].newer, "");
        assert!(flat(&r).contains("index"), "still sent while warm");
        // In ladder order: before the engine note.
        assert!(flat(&r).find("index").unwrap() < flat(&r).find("note").unwrap());
    }

    #[test]
    fn a_file_that_goes_back_to_the_held_text_clears_the_mark_and_the_choice() {
        let mut hold = held("old");
        choose(&mut hold, SegmentKind::UserMemory, Choice::Keep);
        let r = resolve(&prompt("old"), Some(&hold), true, &Ask::default());
        assert!(r.pending.is_empty());
        assert!(r.hold.kept.is_empty());
    }

    /// Item 543's check 6 (his question, 2026-11-10 ~1:15 AM: does a chat
    /// added to a thread mid-chat know it?). The chat ran unbound, so its
    /// hold names no thread; `set_chat_thread` writes the binding and the
    /// reconnect builds a prompt with the thread's layer. `main.rs`
    /// `thread_rebound` sees the names differ and asks for the Thread layer
    /// now — warm cache or not — and taking it turns the CLI's prompt
    /// snapshot off, without which a resumed chat keeps the prompt it
    /// recorded on its first turn (item 174). The args half is
    /// `a_thread_bound_mid_chat_reaches_the_resumed_cli` in the service.
    #[test]
    fn a_thread_bound_mid_chat_is_taken_now_and_turns_the_snapshot_off() {
        let hold = held("m");
        assert!(!hold.snapshot_off);
        let mut fresh = prompt("m");
        fresh.push(Segment::new(
            SegmentKind::Thread,
            "alpha",
            "THREAD alpha: start here",
        ));
        let name = |segs: &[Segment]| {
            segs.iter()
                .find(|s| s.kind == SegmentKind::Thread)
                .map(|s| s.name.clone())
        };
        // `thread_rebound`'s rule, on the same inputs.
        assert_ne!(name(&hold.segments), name(fresh.segments()));
        let warm = Ask {
            cold: false,
            auto: true,
            now: vec![SegmentKind::Thread],
        };
        let r = resolve(&fresh, Some(&hold), true, &warm);
        assert!(flat(&r).contains("THREAD alpha: start here"));
        assert!(r.hold.snapshot_off);
        assert!(r.pending.is_empty());
        // Without the ask (the rebound not noticed) a warm chat would hold it back.
        let quiet = Ask {
            cold: false,
            auto: true,
            now: Vec::new(),
        };
        let r = resolve(&fresh, Some(&hold), true, &quiet);
        assert!(!flat(&r).contains("THREAD alpha: start here"));
    }

    #[test]
    fn the_hold_round_trips_through_its_file() {
        let dir = std::env::temp_dir().join(format!("nightloom-hold-{}", std::process::id()));
        let path = file_for(&dir, "chat-1");
        let mut hold = held("old");
        choose(&mut hold, SegmentKind::UserMemory, Choice::Cold);
        hold.snapshot_off = true;
        save(&path, &hold).unwrap();
        assert_eq!(json(&load(&path).unwrap()), json(&hold));
        std::fs::remove_dir_all(&dir).ok();
    }

    fn scratch(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("nightloom-hold-{name}-{}", std::process::id()))
    }

    /// Batch review 2026-09-23, finding 2: the first turn of a new chat
    /// writes the hold it sent under the new chat's id, so the next connect
    /// marks a layer changed in between instead of adopting it silently.
    #[tokio::test]
    async fn a_new_chat_keeps_what_its_first_turn_sent() {
        let dir = scratch("bind");
        let holds = Pending::default();
        // Connected on New chat: no chat, the fresh prompt whole.
        let first = resolve(&prompt("v1"), None, false, &Ask::default());
        *holds.unsaved.lock().await = Some(first.hold.clone());
        let path = file_for(&dir, "new-chat");
        holds.bind_new_chat("new-chat", Some(path.clone())).await;
        assert_eq!(holds.view.lock().await.session.as_deref(), Some("new-chat"));
        assert_eq!(holds.file.lock().await.as_deref(), Some(path.as_path()));
        let saved = load(&path).expect("the first turn's hold is on disk");
        assert_eq!(json(&saved), json(&first.hold));
        // The file changes before the second turn, cache warm: marked, and
        // the flag still carries what the CLI recorded.
        let r = resolve(&prompt("v2"), Some(&saved), true, &Ask::default());
        assert_eq!(r.pending.len(), 1);
        assert_eq!(flat(&r), prompt("v1").render_flat().unwrap());

        // A connection that already belongs to a chat is left alone.
        let other = file_for(&dir, "other");
        holds.bind_new_chat("other", Some(other.clone())).await;
        assert_eq!(holds.view.lock().await.session.as_deref(), Some("new-chat"));
        assert!(load(&other).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// [`prompt`] with a subagent rules layer before the library prompt.
    fn with_rules(rules: &str) -> SystemPrompt {
        let base = prompt("memory");
        let mut out = SystemPrompt::new();
        for s in base
            .segments()
            .iter()
            .filter(|s| s.kind != SegmentKind::Custom)
        {
            out.push(s.clone());
        }
        out.push(Segment::new(
            SegmentKind::SubagentRules,
            "subagent-rules",
            format!("<subagent-rules>\n{rules}\n</subagent-rules>"),
        ));
        out.push(Segment::new(SegmentKind::Custom, "library", "library"));
        out
    }

    /// Backlog 293, cold: a changed subagent rules layer is rewritten in
    /// place before the turn — even under a Keep, and with the Settings
    /// default off — and no note rides the message.
    #[test]
    fn cold_rules_are_rewritten_in_place_whatever_the_marks_say() {
        let mut hold = resolve(&with_rules("old rules"), None, true, &Ask::default()).hold;
        choose(&mut hold, SegmentKind::SubagentRules, Choice::Keep);
        let ask = Ask {
            cold: true,
            auto: false,
            now: vec![],
        };
        let r = resolve(&with_rules("new rules"), Some(&hold), true, &ask);
        assert_eq!(flat(&r), with_rules("new rules").render_flat().unwrap());
        assert!(r.pending.is_empty());
        assert!(r.rules_note.is_none());
        assert!(r.hold.snapshot_off);
        assert!(r.hold.rules_noted.is_none());
    }

    /// Backlog 293, warm: the held layer goes out byte for byte (the cache
    /// holds), the next message carries the note once, and the cold moment
    /// after rewrites the layer.
    #[tokio::test]
    async fn warm_rules_ride_the_next_message_once_then_land_at_cold() {
        let dir = scratch("rules-warm");
        let path = file_for(&dir, "a");
        let hold = resolve(&with_rules("old rules"), None, true, &Ask::default()).hold;
        save(&path, &hold).unwrap();
        let warm = Ask {
            cold: false,
            auto: true,
            now: vec![],
        };
        let r = resolve(&with_rules("new rules"), Some(&hold), true, &warm);
        assert_eq!(flat(&r), with_rules("old rules").render_flat().unwrap());
        assert_eq!(r.pending.len(), 1);
        assert_eq!(r.pending[0].kind, SegmentKind::SubagentRules);
        let note = r.rules_note.clone().expect("a note for the next message");
        assert!(
            note.contains("new rules") && note.contains("These are the new rules"),
            "{note}"
        );
        assert!(note.contains("either way"), "{note}");
        save(&path, &r.hold).unwrap();

        // The send takes it once, for this chat only.
        let holds = Pending::default();
        *holds.view.lock().await = PendingView {
            session: Some("a".into()),
            layers: r.pending.clone(),
            rules_note: r.rules_note.clone(),
        };
        *holds.file.lock().await = Some(path.clone());
        assert!(holds.take_rules_note("b").await.is_none());
        assert_eq!(
            holds.take_rules_note("a").await.as_deref(),
            Some(note.as_str())
        );
        assert!(holds.take_rules_note("a").await.is_none());
        let after = load(&path).unwrap();
        assert_eq!(
            after.rules_noted.as_deref(),
            Some(r.pending[0].newer.as_str())
        );

        // A later warm connect with the same change: no second note.
        let again = resolve(&with_rules("new rules"), Some(&after), true, &warm);
        assert!(again.rules_note.is_none());
        assert_eq!(flat(&again), with_rules("old rules").render_flat().unwrap());
        // Changed again while warm: a new note.
        let third = resolve(&with_rules("newest rules"), Some(&again.hold), true, &warm);
        assert!(third.rules_note.unwrap().contains("newest rules"));

        // The cold moment: the layer is rewritten, the record cleared.
        let cold = Ask {
            cold: true,
            auto: true,
            now: vec![],
        };
        let landed = resolve(&with_rules("new rules"), Some(&again.hold), true, &cold);
        assert_eq!(
            flat(&landed),
            with_rules("new rules").render_flat().unwrap()
        );
        assert!(landed.pending.is_empty() && landed.rules_note.is_none());
        assert!(landed.hold.rules_noted.is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Batch review 2026-09-23, finding 3: a click on another chat's mark
    /// is refused and its hold file untouched.
    #[tokio::test]
    async fn a_choice_lands_only_on_the_chat_the_connection_holds() {
        let dir = scratch("choose");
        let path = file_for(&dir, "a");
        save(&path, &held("old")).unwrap();
        let holds = Pending::default();
        *holds.view.lock().await = PendingView {
            session: Some("a".into()),
            layers: resolve(&prompt("new"), Some(&held("old")), true, &Ask::default()).pending,
            rules_note: None,
        };
        *holds.file.lock().await = Some(path.clone());

        let refused = holds
            .choose_for("b", SegmentKind::UserMemory, Choice::Keep)
            .await;
        assert!(refused.is_err());
        assert!(load(&path).unwrap().kept.is_empty(), "a's file untouched");

        let view = holds
            .choose_for("a", SegmentKind::UserMemory, Choice::Keep)
            .await
            .unwrap();
        assert_eq!(view.layers[0].choice, Choice::Keep);
        assert!(load(&path).unwrap().kept.contains(&SegmentKind::UserMemory));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Item 725: a warm chat whose notes index and Start here moved sends
    /// the held text byte for byte, keeps what a note already told, and
    /// takes the new text only at a cold moment.
    #[test]
    fn a_warm_chat_holds_the_volatile_layers_and_keeps_its_notes() {
        let layers = |notes: &str, thread: &str| {
            let mut p = SystemPrompt::new();
            p.push(Segment::new(
                SegmentKind::ProjectNotes,
                "project-notes",
                notes,
            ));
            p.push(Segment::new(SegmentKind::Thread, "thread/t", thread));
            p
        };
        let before = layers("thread.md (69.2 KB)", "1. Q-29: open");
        let mut hold = Hold {
            segments: before.segments().to_vec(),
            ..Hold::default()
        };
        hold.noted
            .insert(SegmentKind::Thread, "1. Q-30: told already".into());
        let after = layers("thread.md (70.3 KB)", "1. Q-30: told already");
        let warm = Ask {
            cold: false,
            auto: true,
            now: Vec::new(),
        };
        let r = resolve(&after, Some(&hold), true, &warm);
        assert_eq!(flat(&r), before.render_flat().unwrap());
        assert_eq!(r.pending.len(), 2);
        assert_eq!(
            r.hold.noted.get(&SegmentKind::Thread).map(String::as_str),
            Some("1. Q-30: told already")
        );
        let cold = Ask { cold: true, ..warm };
        let r = resolve(&after, Some(&hold), true, &cold);
        assert_eq!(flat(&r), after.render_flat().unwrap());
        assert!(
            r.hold.noted.is_empty(),
            "a taken layer has nothing left to tell"
        );
    }

    /// Item 725: the chat's own log decides warmth when it can — a reply
    /// 13 minutes old under a 1-hour cache is warm, one past its hour is
    /// not, and one that recorded no lifetime claims nothing.
    #[test]
    fn the_log_says_warm_only_within_its_reply_lifetime() {
        use nightloom_core::{CacheTtl, Session, Usage};
        let usage = Usage {
            input_tokens: 70_000,
            output_tokens: 500,
            cache_read_tokens: Some(60_000),
            ..Usage::default()
        };
        let sent = chrono::Utc::now() - chrono::Duration::minutes(13);
        let mut s = Session::new();
        s.record_user("hi");
        s.record_assistant_timed(
            "m",
            Vec::new(),
            None,
            usage,
            None,
            sent,
            Some(CacheTtl::OneHour),
        );
        let now = chrono::Utc::now().timestamp_millis();
        assert!(log_warm(&s, now));
        assert!(!log_warm(&s, now + 50 * 60_000));
        let mut five = Session::new();
        five.record_user("hi");
        five.record_assistant_timed(
            "m",
            Vec::new(),
            None,
            usage,
            None,
            sent,
            Some(CacheTtl::FiveMinutes),
        );
        assert!(!log_warm(&five, now));
        let mut none = Session::new();
        none.record_user("hi");
        none.record_assistant_timed(
            "m",
            Vec::new(),
            None,
            Usage::default(),
            None,
            sent,
            Some(CacheTtl::OneHour),
        );
        assert!(!log_warm(&none, now));
        assert!(!log_warm(&Session::new(), now));
    }

    /// Item 893, the 4:13 PM miss: an install quit the app mid-turn, the
    /// cut reply recorded no usage, and the connect after it read the
    /// chat as cold under a 1-hour cache 16 minutes old. The cut reply is
    /// passed over for the one before it.
    #[test]
    fn a_cut_reply_does_not_make_a_warm_chat_read_cold() {
        use nightloom_core::{CacheTtl, Session, Usage};
        let usage = Usage {
            input_tokens: 170_000,
            output_tokens: 500,
            cache_read_tokens: Some(160_000),
            ..Usage::default()
        };
        let now = chrono::Utc::now();
        let mut s = Session::new();
        s.record_user("hi");
        s.record_assistant_timed(
            "m",
            Vec::new(),
            None,
            usage,
            None,
            now - chrono::Duration::minutes(16),
            Some(CacheTtl::OneHour),
        );
        s.record_user("again");
        s.record_assistant_timed(
            "m",
            Vec::new(),
            Some("stopped".into()),
            Usage::default(),
            None,
            now - chrono::Duration::minutes(1),
            Some(CacheTtl::OneHour),
        );
        let ms = now.timestamp_millis();
        assert!(log_warm(&s, ms));
        assert!(!log_warm(&s, ms + 45 * 60_000));
    }

    /// Item 893, the 2:46 PM miss: the last reply was 65 minutes old, but
    /// the chat's keep-warm ping 10 minutes before had read its cache —
    /// warm for the hour after the ping. An aside that read at least half
    /// the context counts the same way; one that read less, or a ping that
    /// missed, does not.
    #[test]
    fn a_ping_or_an_aside_since_the_reply_keeps_the_chat_warm() {
        let dir = std::env::temp_dir().join(format!(
            "nightloom-893-touch-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let min = 60_000;
        let now = 1_795_128_389_220_i64;
        let reply = CachedReply {
            sent_ms: now - 65 * min,
            ttl_ms: 60 * min,
            context: 167_000,
        };
        assert!(!touched_warm(&reply, &dir, now), "no ping, no aside");
        let ping = |sent: i64, hit: bool| {
            format!(
                "{{\"sent_ms\":{sent},\"cache_read\":167026,\"cache_write\":0,\"input\":4,\"output\":4,\"context\":168993,\"hit\":{hit}}}\n"
            )
        };
        let pings = dir.join(nightloom_service::keep_warm::PINGS_FILE);
        std::fs::write(&pings, ping(now - 10 * min, false)).unwrap();
        assert!(!touched_warm(&reply, &dir, now), "a missed ping");
        std::fs::write(&pings, ping(now - 10 * min, true)).unwrap();
        assert!(touched_warm(&reply, &dir, now), "the 2:36 PM ping");
        assert!(
            !touched_warm(&reply, &dir, now + 51 * min),
            "its hour ran out"
        );
        std::fs::remove_file(&pings).unwrap();
        nightloom_service::hand_off::note_aside_read(&dir, now - 5 * min, 50_000);
        assert!(
            !touched_warm(&reply, &dir, now),
            "an aside that read little"
        );
        nightloom_service::hand_off::note_aside_read(&dir, now - 4 * min, 160_000);
        assert!(touched_warm(&reply, &dir, now), "an aside that read it");
        std::fs::remove_dir_all(&dir).ok();
    }
}

/// Item 727's "fixed by 725" cases, through the hold (their own file).
#[cfg(test)]
#[path = "prompt_hold_727_tests.rs"]
mod cache_hold_727_tests;
