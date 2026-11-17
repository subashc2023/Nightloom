//! The automatic in-place hand-off (nightshift item 763, blocker 2021, his
//! "That sounds good as a default", 2026-11-17 ~2:25 AM).
//!
//! A talked-in chat that has grown past a soft mark (~200k tokens) hands
//! off **in the same chat** at an idle moment — never mid-reply — and past
//! a hard mark (~330k) at the next message whatever the moment. He sees a
//! divider; the model's next request starts a fresh session whose first
//! message carries a brief collected by code: the files the chat touched
//! and **his own words verbatim**, newest first up to [`WORDS_CAP_TOKENS`].
//! No model writes the brief, so nothing he said passes through a summary.
//!
//! General: any chat whose log carries [`SessionEvent::AutoHandOff`] uses
//! it; today only Home's chat is switched on (`home`). The decision is
//! [`due`] (pure), the brief is [`brief`] (pure), and the turn engine calls
//! [`hand_off_if_due`] before it records his message.
//!
//! "Idle" here is measured on the log: the newest reply ended at least
//! [`IDLE_SECS`] before this message — he stepped away, so the prefix the
//! next request would re-read is cooling anyway, and the hand-off costs no
//! warm cache he was using.
//!
//! [`SessionEvent::AutoHandOff`]: nightloom_core::SessionEvent::AutoHandOff

use chrono::{DateTime, Utc};
use nightloom_core::{ContentBlock, Session, SessionEvent};

/// The soft mark for a talked-in chat, tokens.
pub const SOFT_TOKENS: u64 = 200_000;
/// The hard mark, tokens.
pub const HARD_TOKENS: u64 = 330_000;
/// A pause this long since the newest reply makes the moment idle.
pub const IDLE_SECS: i64 = 5 * 60;
/// His words carried verbatim, at most this many tokens (≈ 4 chars each).
pub const WORDS_CAP_TOKENS: usize = 15_000;
/// The most files the brief names.
const FILES_MAX: usize = 60;

/// Why a chat hands off now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    Soft,
    Hard,
}

impl Reason {
    pub fn word(self) -> &'static str {
        match self {
            Reason::Soft => "soft",
            Reason::Hard => "hard",
        }
    }
}

/// Whether a chat with marks `(soft, hard)`, whose newest reply had
/// `context` tokens and ended at `last_at`, hands off before a message sent
/// at `now`. Pure.
pub fn due(
    marks: (u64, u64),
    context: u64,
    last_at: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Option<Reason> {
    let (soft, hard) = marks;
    if soft == 0 {
        return None;
    }
    if hard > 0 && context >= hard {
        return Some(Reason::Hard);
    }
    if context >= soft && (now - last_at).num_seconds() >= IDLE_SECS {
        return Some(Reason::Soft);
    }
    None
}

/// The paths a chat's tool calls named (`file_path`, `path`,
/// `notebook_path`), newest first, each once. Pure.
fn files_of(events: &[(usize, &SessionEvent)]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for (_, e) in events.iter().rev() {
        let SessionEvent::AssistantMessage { blocks, .. } = e else {
            continue;
        };
        for b in blocks.iter().rev() {
            let ContentBlock::ToolUse { input, .. } = b else {
                continue;
            };
            for key in ["file_path", "path", "notebook_path"] {
                if let Some(p) = input.get(key).and_then(|v| v.as_str())
                    && !p.trim().is_empty()
                    && !out.iter().any(|o| o == p)
                {
                    out.push(p.to_string());
                }
            }
        }
        if out.len() >= FILES_MAX {
            break;
        }
    }
    out.truncate(FILES_MAX);
    out
}

/// The hand-off brief for `session`, from its live events since its last
/// in-place hand-off (that one's brief is carried forward whole, so a
/// standing instruction survives every hand-off). `skip_prefix` drops
/// messages that are not his typing (the morning scan's facts). Pure over
/// the log.
pub fn brief(session: &Session, skip_prefix: Option<&str>) -> String {
    let live = session.live_events();
    // Everything since the last hand-off, and that one's brief.
    let since = live
        .iter()
        .rposition(|(_, e)| matches!(e, SessionEvent::HandOff { .. }));
    let earlier = since.and_then(|i| match live[i].1 {
        SessionEvent::HandOff { brief, .. } => Some(brief.clone()),
        _ => None,
    });
    let tail = &live[since.map_or(0, |i| i + 1)..];
    let mut words: Vec<String> = Vec::new();
    let mut budget = WORDS_CAP_TOKENS * 4;
    let mut dropped = 0usize;
    for (_, e) in tail.iter().rev() {
        let SessionEvent::UserMessage { text, at, .. } = e else {
            continue;
        };
        if skip_prefix.is_some_and(|p| text.trim_start().starts_with(p)) {
            continue;
        }
        let line = format!("- {} — {}", at.format("%Y-%m-%d %H:%M UTC"), text.trim());
        if line.len() > budget {
            dropped += 1;
            continue;
        }
        budget -= line.len();
        words.push(line);
    }
    words.reverse();
    let files = files_of(tail);
    let mut out = String::from(
        "## Hand-off (in place)\n\nThis chat handed off in place: the conversation above this point is \
         not in your context. What follows was collected by code, not summarised. The full history is \
         in this chat's log — search it (`search_chats`, this chat) before guessing.\n",
    );
    out.push_str("\n## His words since the last hand-off, verbatim (oldest first)\n\n");
    if words.is_empty() {
        out.push_str("(none)\n");
    } else {
        out.push_str(&words.join("\n"));
        out.push('\n');
    }
    if dropped > 0 {
        out.push_str(&format!(
            "\n({dropped} older message(s) of his are past the {WORDS_CAP_TOKENS}-token cap — search the chat for them.)\n"
        ));
    }
    out.push_str("\n## Files this chat touched (newest first)\n\n");
    if files.is_empty() {
        out.push_str("(none)\n");
    } else {
        for f in &files {
            out.push_str(&format!("- {f}\n"));
        }
    }
    if let Some(prev) = earlier {
        out.push_str("\n## The hand-off before this one\n\n");
        // Its own words section is what carries standing instructions;
        // cut it to the cap so briefs never grow without bound.
        let cap = WORDS_CAP_TOKENS * 4 / 2;
        let prev: String = prev.chars().take(cap).collect();
        out.push_str(&prev);
        out.push('\n');
    }
    out
}

/// Hand `session` off in place when its marks say it is due before a
/// message sent at `now`. The reason when it did.
pub fn hand_off_if_due(
    session: &mut Session,
    now: DateTime<Utc>,
    skip_prefix: Option<&str>,
) -> Option<Reason> {
    let marks = session.auto_hand_off()?;
    if session.pending_hand_off().is_some() {
        return None;
    }
    let (context, last_at) = session.last_reply_context()?;
    let reason = due(marks, context, last_at, now)?;
    let text = brief(session, skip_prefix);
    session.record_hand_off(text, context, reason.word());
    Some(reason)
}

/// The wire form of a message that follows an in-place hand-off: the brief,
/// then his message.
pub fn wire_with(brief: &str, text: &str) -> String {
    format!("{brief}\n---\n\n{text}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;
    use nightloom_core::{ChatKind, ChatMode, Usage};

    fn scratch() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("nightloom-handoff-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn t0() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-11-17T08:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn due_follows_the_marks_and_the_pause() {
        let m = (SOFT_TOKENS, HARD_TOKENS);
        let now = t0();
        let recent = now - Duration::seconds(30);
        let idle = now - Duration::seconds(IDLE_SECS + 1);
        assert_eq!(due(m, 150_000, idle, now), None, "under soft");
        assert_eq!(due(m, 210_000, recent, now), None, "soft but not idle");
        assert_eq!(due(m, 210_000, idle, now), Some(Reason::Soft));
        assert_eq!(due(m, 340_000, recent, now), Some(Reason::Hard));
        assert_eq!(due((0, 0), 900_000, idle, now), None, "off");
    }

    fn reply(session: &mut Session, text: &str, tokens: u64, tool_path: Option<&str>) {
        let mut blocks = vec![ContentBlock::Text { text: text.into() }];
        if let Some(p) = tool_path {
            blocks.push(ContentBlock::ToolUse {
                id: format!("t-{p}"),
                name: "Read".into(),
                input: serde_json::json!({ "file_path": p }),
                signature: None,
            });
        }
        session.record_assistant(
            "claude-opus-5-5",
            blocks,
            Some("end_turn".into()),
            Usage {
                input_tokens: tokens,
                output_tokens: 100,
                ..Usage::default()
            },
        );
    }

    #[test]
    fn hands_off_in_place_with_his_words_and_files_and_drops_the_resume() {
        let dir = scratch();
        let mut s = Session::start(&dir, ChatMode::Normal, ChatKind::Build).unwrap();
        s.record_agent_session("claude-code", "s-1");
        s.record_user_message("Morning scan — facts", vec![], vec![], false);
        reply(&mut s, "scan page", 30_000, None);
        s.record_user_message("always cite the feed", vec![], vec![], false);
        reply(&mut s, "ok", 250_000, Some("/x/HANDOFF.md"));
        // Off: nothing happens.
        assert_eq!(hand_off_if_due(&mut s, Utc::now(), None), None);
        s.set_auto_hand_off(SOFT_TOKENS, HARD_TOKENS);
        // Soft, not idle yet.
        assert_eq!(hand_off_if_due(&mut s, Utc::now(), None), None);
        let later = Utc::now() + Duration::seconds(IDLE_SECS + 5);
        assert_eq!(
            hand_off_if_due(&mut s, later, Some("Morning scan")),
            Some(Reason::Soft)
        );
        assert_eq!(s.agent_session(), None, "the next turn starts fresh");
        let b = s.pending_hand_off().unwrap().to_string();
        assert!(b.contains("always cite the feed"), "{b}");
        assert!(
            !b.contains("Morning scan"),
            "the scan's facts are not his words"
        );
        assert!(b.contains("/x/HANDOFF.md"), "{b}");
        // Twice in a row it does not hand off again.
        assert_eq!(hand_off_if_due(&mut s, later, None), None);
        // His next message takes it; a new agent session is then current.
        s.record_user_message("and the CI?", vec![], vec![], false);
        assert_eq!(s.pending_hand_off(), None);
        s.record_agent_session("claude-code", "s-2");
        assert_eq!(s.agent_session(), Some(("claude-code", "s-2")));
        // Reloads the same from disk.
        let back = Session::load(s.log_path().unwrap()).unwrap();
        assert_eq!(back.auto_hand_off(), Some((SOFT_TOKENS, HARD_TOKENS)));
        assert_eq!(back.agent_session(), Some(("claude-code", "s-2")));
    }

    #[test]
    fn the_words_cap_keeps_the_newest_and_says_what_it_dropped() {
        let dir = scratch();
        let mut s = Session::start(&dir, ChatMode::Normal, ChatKind::Build).unwrap();
        let big = "x".repeat(WORDS_CAP_TOKENS * 4 / 3);
        for i in 0..5 {
            s.record_user_message(format!("m{i} {big}"), vec![], vec![], false);
        }
        let b = brief(&s, None);
        assert!(b.contains("m4 ") && b.contains("m3 "), "newest kept");
        assert!(!b.contains("m0 "), "oldest dropped");
        assert!(b.contains("past the 15000-token cap"));
        assert!(b.len() < WORDS_CAP_TOKENS * 4 + 2_000);
    }

    #[test]
    fn a_second_hand_off_carries_the_first() {
        let dir = scratch();
        let mut s = Session::start(&dir, ChatMode::Normal, ChatKind::Build).unwrap();
        s.record_user_message("never push on Fridays", vec![], vec![], false);
        s.record_hand_off(brief(&s, None), 1, "hard");
        s.record_user_message("next", vec![], vec![], false);
        let b = brief(&s, None);
        assert!(b.contains("never push on Fridays") && b.contains("The hand-off before"));
    }
}
