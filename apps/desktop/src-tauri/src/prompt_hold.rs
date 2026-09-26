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

use nightloom_core::{Segment, SegmentKind, SystemPrompt};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
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
                ..Hold::default()
            },
            pending: Vec::new(),
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
    };
    let mut pending = Vec::new();
    for kind in kinds {
        let new_group = group(&layers, kind);
        let held_group = group(&hold.segments, kind);
        if text_of(&new_group) == text_of(&held_group) {
            next.segments.extend(new_group);
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
    }
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

    fn held(memory: &str) -> Hold {
        resolve(&prompt(memory), None, true, &Ask::default()).hold
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
}
