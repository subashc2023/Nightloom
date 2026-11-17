//! The automatic in-place hand-off (nightshift item 763, blocker 2021, his
//! "That sounds good as a default", 2026-11-17 ~2:25 AM).
//!
//! A talked-in chat that has grown past a soft mark (100k tokens; 200k
//! until item 792, blocker 2056) hands off **in the same chat** at the
//! cache edge — his first message after the chat's prompt cache has gone
//! cold, never mid-reply and never while the cache is warm — and past a
//! hard mark (~330k) at the next message whatever the moment. He sees a
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
//! ~~"Idle" here is measured on the log: the newest reply ended at least
//! [`IDLE_SECS`] before this message~~ (superseded 2026-11-17, item 792).
//! "Cold" is measured on the log and the keep-warm file: the newest reply's
//! cache entry (its `sent_at` plus its recorded lifetime, else
//! [`IDLE_SECS`]) and any keep-warm ping that read it since have all run
//! out ([`cold_at`]). Then his next message re-writes the whole prefix
//! anyway, so starting a fresh slice costs nothing he was using; while the
//! cache is warm, carrying on is the cheap read and nothing happens (785
//! report §3c: a cold 200k return ≈ $1.53, a fresh slice ≈ $0.26). The
//! brief is collected by code, so no warm wrap-up turn is needed first.
//!
//! **Loop guard (item 811, his "sounds good", 2026-11-17):** the soft mark
//! fires only once the chat has also grown [`GROWTH_TOKENS`] past its own
//! fresh start ([`fresh_start`]: the context of the first reply after its
//! last hand-off, or after its creation), so a chat whose fresh slice
//! already starts near the mark is never handed off again and again. The
//! start is read off the log, so it survives a relaunch. Each hand-off
//! appends its start, its size and its brief's size to
//! [`HAND_OFFS_FILE`] (items 810 and 811 read it).
//!
//! [`SessionEvent::AutoHandOff`]: nightloom_core::SessionEvent::AutoHandOff

use std::path::Path;

use chrono::{DateTime, Utc};
use nightloom_core::{ContentBlock, Session, SessionEvent};

/// The soft mark for a talked-in chat, tokens (item 792, blocker 2056's
/// default "100k"; it was 200k from item 763).
pub const SOFT_TOKENS: u64 = 100_000;
/// Soft marks an earlier build wrote to a chat's log; a chat carrying one
/// (with today's hard mark) moves to [`SOFT_TOKENS`] at its next message,
/// so a chat already past 100k when this ships follows the new mark
/// without waiting for the next scan to re-set it.
const EARLIER_SOFT: &[u64] = &[200_000];
/// The soft mark fires only this many tokens past the chat's fresh start
/// (item 811), so a hand-off can never loop.
pub const GROWTH_TOKENS: u64 = 50_000;
/// The hard mark, tokens.
pub const HARD_TOKENS: u64 = 330_000;
/// The shortest pause since the newest reply that can count as cold — the
/// lifetime used when the reply recorded none (the API's five minutes).
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
/// `context` tokens, ended at `last_at` and left a cache that goes cold at
/// `cold_at` ([`cold_at`]), hands off before a message sent at `now`: past
/// the hard mark always; past the soft one only once the cache is cold
/// (item 792) and the chat is [`GROWTH_TOKENS`] past its fresh `start`
/// ([`fresh_start`], item 811). Pure.
pub fn due(
    marks: (u64, u64),
    start: u64,
    context: u64,
    last_at: DateTime<Utc>,
    cold_at: DateTime<Utc>,
    now: DateTime<Utc>,
) -> Option<Reason> {
    let (soft, hard) = marks;
    if soft == 0 {
        return None;
    }
    if hard > 0 && context >= hard {
        return Some(Reason::Hard);
    }
    if context >= soft
        && context >= start.saturating_add(GROWTH_TOKENS)
        && (now - last_at).num_seconds() >= IDLE_SECS
        && now >= cold_at
    {
        return Some(Reason::Soft);
    }
    None
}

/// The chat's fresh start: the context (input + output tokens) of the
/// first live reply after its newest live in-place hand-off, or after its
/// creation when it has none; `None` before that reply. Read off the log,
/// so a relaunch reads the same (item 811). Pure.
pub fn fresh_start(session: &Session) -> Option<u64> {
    let live = session.live_events();
    let since = live
        .iter()
        .rposition(|(_, e)| matches!(e, SessionEvent::HandOff { .. }))
        .map_or(0, |i| i + 1);
    live[since..].iter().find_map(|(_, e)| match e {
        SessionEvent::AssistantMessage { usage, .. } => {
            Some(usage.input_tokens + usage.output_tokens)
        }
        _ => None,
    })
}

/// Every hand-off's sizes, one JSON line each, in the chat's `ask/<id>`
/// folder (item 811; item 810 and 811's measuring half read it).
pub const HAND_OFFS_FILE: &str = "hand-offs.jsonl";

/// One hand-off's sizes, tokens: the fresh start it grew from, the context
/// at the hand-off and the brief (≈ 4 chars a token).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct HandOffLine {
    pub at_ms: i64,
    pub reason: String,
    pub start: u64,
    pub context: u64,
    pub brief_tokens: u64,
}

/// Append `line` to `dir`'s [`HAND_OFFS_FILE`]. Best effort: a failed write
/// loses the measurement, never the hand-off.
pub fn note_hand_off(dir: &Path, line: &HandOffLine) {
    use std::io::Write;
    let _ = std::fs::create_dir_all(dir);
    if let (Ok(text), Ok(mut f)) = (
        serde_json::to_string(line),
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join(HAND_OFFS_FILE)),
    ) {
        let _ = writeln!(f, "{text}");
    }
}

/// The lines [`note_hand_off`] wrote in `dir`, oldest first; unreadable
/// lines are skipped.
pub fn read_hand_offs(dir: &Path) -> Vec<HandOffLine> {
    std::fs::read_to_string(dir.join(HAND_OFFS_FILE))
        .map(|t| {
            t.lines()
                .filter_map(|l| serde_json::from_str(l).ok())
                .collect()
        })
        .unwrap_or_default()
}

/// When the newest live reply's prompt cache goes cold: its `sent_at` (else
/// its `at`) plus the lifetime it recorded (else [`IDLE_SECS`]), or later
/// when a keep-warm ping ([`crate::keep_warm`]) read it since — that ping's
/// send plus the hour. `pings` is the chat's keep-warm folder; `None` when
/// the chat has no reply. An aside that read it since ([`ASIDE_READ_FILE`],
/// the keep-warm hit rule: at least half the reply's context) moves the
/// edge to its send plus the reply's lifetime, as it moves the cache's.
/// Pure over the log and the files.
pub fn cold_at(session: &Session, pings: Option<&Path>) -> Option<DateTime<Utc>> {
    let live = session.live_events();
    let (sent, ttl, context) = live.iter().rev().find_map(|(_, e)| match e {
        SessionEvent::AssistantMessage {
            sent_at,
            cache_ttl,
            at,
            usage,
            ..
        } => Some((
            sent_at.unwrap_or(*at),
            cache_ttl.map_or(IDLE_SECS * 1000, |t| t.duration().as_millis() as i64),
            usage.input_tokens + usage.output_tokens,
        )),
        _ => None,
    })?;
    let sent_ms = sent.timestamp_millis();
    let mut cold = sent_ms + ttl;
    if let Some(dir) = pings {
        for p in crate::keep_warm::read_pings(dir) {
            if p.hit && p.sent_ms > sent_ms {
                cold = cold.max(p.sent_ms + crate::keep_warm::TTL_MS);
            }
        }
        if let Some(a) = last_aside_read(dir)
            && a.sent_ms > sent_ms
            && a.cache_read.saturating_mul(2) >= context
        {
            cold = cold.max(a.sent_ms + ttl);
        }
    }
    DateTime::from_timestamp_millis(cold)
}

/// The newest aside's cache read, per chat, in its keep-warm folder: an
/// aside forks the chat on its cache, so one that read it keeps it warm
/// (item 677), and [`cold_at`] must see that even with keep-warm off.
pub const ASIDE_READ_FILE: &str = "aside-read.json";

/// One aside's read of the chat's cache: when it was sent, unix ms, and
/// what its newest round read from cache.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct AsideRead {
    pub sent_ms: i64,
    pub cache_read: u64,
}

/// Record an aside's read in `dir` (the chat's `ask/<id>` folder), unless a
/// later one is already there. Best effort: a failed write only means the
/// edge is judged from the reply and the pings.
pub fn note_aside_read(dir: &Path, sent_ms: i64, cache_read: u64) {
    if last_aside_read(dir).is_some_and(|a| a.sent_ms >= sent_ms) {
        return;
    }
    let _ = std::fs::create_dir_all(dir);
    if let Ok(text) = serde_json::to_string(&AsideRead {
        sent_ms,
        cache_read,
    }) {
        let _ = std::fs::write(dir.join(ASIDE_READ_FILE), text);
    }
}

/// The aside read [`note_aside_read`] kept in `dir`, when there is one.
pub fn last_aside_read(dir: &Path) -> Option<AsideRead> {
    let text = std::fs::read_to_string(dir.join(ASIDE_READ_FILE)).ok()?;
    serde_json::from_str(&text).ok()
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
    brief_in(session, skip_prefix, None)
}

/// [`brief`], with the chat's chain (items 789 and 791, [`crate::chain`])
/// in `logs` (the chat's log dir): its state file as it is now — frozen for the slice that
/// starts — and the newest three run-log entries (807). A chat with
/// no chain gets the plain brief.
pub fn brief_in(session: &Session, skip_prefix: Option<&str>, logs: Option<&Path>) -> String {
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
    // The chain's state file and run log, read now (items 789, 791): the
    // entries are carried as written, so run 1's exact values survive
    // every later hand-off while it is among the newest three (807).
    if let Some(section) = logs.and_then(|l| crate::chain::brief_section(l, &session.id)) {
        out.push_str(&section);
    }
    if let Some(prev) = earlier {
        out.push_str("\n## The hand-off before this one\n\n");
        // Its own words section is what carries standing instructions;
        // cut it to the cap so briefs never grow without bound. Its state
        // file and run log are not carried twice: the ones above are newer.
        let cap = WORDS_CAP_TOKENS * 4 / 2;
        let prev = without_chain(&prev);
        let prev: String = prev.chars().take(cap).collect();
        out.push_str(&prev);
        out.push('\n');
    }
    out
}

/// A brief without its chain sections (`## State file …`, `## Run log …`),
/// each up to the next `## ` heading. Pure.
fn without_chain(brief: &str) -> String {
    let mut out = String::new();
    let mut skipping = false;
    for line in brief.lines() {
        if line.starts_with("## ") {
            skipping = line.starts_with("## State file") || line.starts_with("## Run log");
        }
        if !skipping {
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

/// Hand `session` off in place when its marks say it is due before a
/// message sent at `now` (a chat still on an earlier build's soft mark is
/// moved to today's first). The reason when it did. The keep-warm folder
/// read for [`cold_at`] is the chat's `ask/<id>` beside its log. `logs` is the chat's log
/// dir, where its chain lives ([`crate::chain`]); `None` leaves it out.
pub fn hand_off_if_due(
    session: &mut Session,
    now: DateTime<Utc>,
    skip_prefix: Option<&str>,
    logs: Option<&Path>,
) -> Option<Reason> {
    let mut marks = session.auto_hand_off()?;
    if EARLIER_SOFT.contains(&marks.0) && marks.1 == HARD_TOKENS {
        session.set_auto_hand_off(SOFT_TOKENS, HARD_TOKENS);
        marks = (SOFT_TOKENS, HARD_TOKENS);
    }
    if session.pending_hand_off().is_some() {
        return None;
    }
    let (context, last_at) = session.last_reply_context()?;
    let pings = crate::cache_miss::ask_dir_of(session);
    let cold = cold_at(session, pings.as_deref()).unwrap_or(last_at);
    let start = fresh_start(session).unwrap_or(0);
    let reason = due(marks, start, context, last_at, cold, now)?;
    let text = brief_in(session, skip_prefix, logs);
    if let Some(dir) = &pings {
        note_hand_off(
            dir,
            &HandOffLine {
                at_ms: now.timestamp_millis(),
                reason: reason.word().to_string(),
                start,
                context,
                brief_tokens: (text.len() / 4) as u64,
            },
        );
    }
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
    fn due_follows_the_marks_and_the_cache_edge() {
        let m = (SOFT_TOKENS, HARD_TOKENS);
        let now = t0();
        let recent = now - Duration::seconds(30);
        let idle = now - Duration::seconds(IDLE_SECS + 1);
        let warm = now + Duration::minutes(20);
        let cold = now - Duration::seconds(1);
        assert_eq!(due(m, 0, 90_000, idle, cold, now), None, "under soft");
        assert_eq!(
            due(m, 0, 150_000, recent, cold, now),
            None,
            "soft but not idle"
        );
        assert_eq!(
            due(m, 0, 150_000, idle, warm, now),
            None,
            "soft, idle, still warm"
        );
        assert_eq!(due(m, 0, 150_000, idle, cold, now), Some(Reason::Soft));
        assert_eq!(due(m, 0, 340_000, recent, warm, now), Some(Reason::Hard));
        assert_eq!(due((0, 0), 0, 900_000, idle, cold, now), None, "off");
    }

    /// A reply on the Claude Code engine's one-hour cache, `tokens` of
    /// context, sent at `sent`.
    fn timed_reply(session: &mut Session, tokens: u64, sent: DateTime<Utc>) {
        session.record_assistant_timed(
            "claude-opus-5-5",
            vec![ContentBlock::Text { text: "ok".into() }],
            Some("end_turn".into()),
            Usage {
                input_tokens: tokens,
                output_tokens: 100,
                cache_read_tokens: Some(tokens - 2_000),
                cache_write_tokens: Some(2_000),
                cache_write_1h_tokens: Some(2_000),
                ..Usage::default()
            },
            None,
            sent,
            Some(nightloom_core::CacheTtl::OneHour),
        );
    }

    /// Item 792's check: a warm chat at 150k is not handed off; the same
    /// chat gone cold is. A keep-warm ping that read the cache pushes the
    /// edge out by its hour; a 90k chat gone cold stays as it is.
    #[test]
    fn a_warm_chat_at_150k_carries_on_and_the_same_chat_gone_cold_hands_off() {
        let dir = scratch();
        let mut s = Session::start(&dir, ChatMode::Normal, ChatKind::Build).unwrap();
        s.set_auto_hand_off(SOFT_TOKENS, HARD_TOKENS);
        s.record_user_message("look at the build", vec![], vec![], false);
        let sent = Utc::now();
        timed_reply(&mut s, 20_000, sent - Duration::minutes(1));
        timed_reply(&mut s, 150_000, sent);
        assert_eq!(
            cold_at(&s, None).map(|t| t.timestamp_millis()),
            Some((sent + Duration::hours(1)).timestamp_millis())
        );
        // Back after 20 minutes: the hour's cache is warm, nothing happens.
        let warm = sent + Duration::minutes(20);
        assert_eq!(hand_off_if_due(&mut s, warm, None, None), None, "warm");
        assert!(s.pending_hand_off().is_none());
        // A keep-warm ping read it at 55 minutes: still warm at 61.
        let pings = crate::cache_miss::ask_dir_of(&s).unwrap();
        std::fs::create_dir_all(&pings).unwrap();
        let ping = crate::keep_warm::PingLine {
            sent_ms: (sent + Duration::minutes(55)).timestamp_millis(),
            cache_read: 150_000,
            cache_write: 0,
            input: 3,
            output: 1,
            cost_usd: None,
            model: None,
            context: 150_100,
            hit: true,
            error: None,
        };
        std::fs::write(
            pings.join(crate::keep_warm::PINGS_FILE),
            serde_json::to_string(&ping).unwrap() + "\n",
        )
        .unwrap();
        let after_hour = sent + Duration::minutes(61);
        assert_eq!(
            hand_off_if_due(&mut s, after_hour, None, None),
            None,
            "kept warm"
        );
        // Gone cold (the ping's hour ran out too): it hands off.
        let cold = sent + Duration::minutes(55 + 61);
        assert_eq!(
            hand_off_if_due(&mut s, cold, None, None),
            Some(Reason::Soft)
        );
        assert!(s.pending_hand_off().is_some());

        // A 90k chat gone cold is under the mark.
        let mut small = Session::start(&dir, ChatMode::Normal, ChatKind::Build).unwrap();
        small.set_auto_hand_off(SOFT_TOKENS, HARD_TOKENS);
        timed_reply(&mut small, 90_000, sent);
        assert_eq!(
            hand_off_if_due(&mut small, sent + Duration::hours(3), None, None),
            None
        );
    }

    /// Merge round R: an aside that read the cache keeps it warm (item
    /// 677), keep-warm on or off, so a chat he asked beside at 50 minutes
    /// is not handed off at 70; one that read under half is no read; past
    /// the aside's own hour the chat hands off.
    #[test]
    fn an_aside_that_read_the_cache_keeps_the_chat_from_a_warm_hand_off() {
        let dir = scratch();
        let mut s = Session::start(&dir, ChatMode::Normal, ChatKind::Build).unwrap();
        s.set_auto_hand_off(SOFT_TOKENS, HARD_TOKENS);
        s.record_user_message("look at the build", vec![], vec![], false);
        let sent = Utc::now();
        timed_reply(&mut s, 20_000, sent - Duration::minutes(1));
        timed_reply(&mut s, 150_000, sent);
        let ask = crate::cache_miss::ask_dir_of(&s).unwrap();
        // Under half the context: the head of the prefix only, no read.
        note_aside_read(
            &ask,
            (sent + Duration::minutes(40)).timestamp_millis(),
            60_000,
        );
        assert_eq!(
            cold_at(&s, Some(&ask)).map(|t| t.timestamp_millis()),
            Some((sent + Duration::hours(1)).timestamp_millis())
        );
        let aside = sent + Duration::minutes(50);
        note_aside_read(&ask, aside.timestamp_millis(), 149_000);
        // An older aside never replaces a newer one.
        note_aside_read(
            &ask,
            (sent + Duration::minutes(45)).timestamp_millis(),
            149_000,
        );
        assert_eq!(
            last_aside_read(&ask).map(|a| a.sent_ms),
            Some(aside.timestamp_millis())
        );
        assert_eq!(
            hand_off_if_due(&mut s, sent + Duration::minutes(70), None, None),
            None,
            "warm from the aside"
        );
        assert_eq!(
            hand_off_if_due(&mut s, aside + Duration::minutes(61), None, None),
            Some(Reason::Soft)
        );
    }

    /// A chat already on the earlier build's 200k mark moves to 100k at its
    /// next message, so a Home chat at 150k does not wait for the next scan.
    #[test]
    fn a_chat_on_the_old_200k_mark_moves_to_100k() {
        let dir = scratch();
        let mut s = Session::start(&dir, ChatMode::Normal, ChatKind::Build).unwrap();
        s.set_auto_hand_off(200_000, HARD_TOKENS);
        let sent = Utc::now();
        timed_reply(&mut s, 20_000, sent - Duration::minutes(1));
        timed_reply(&mut s, 150_000, sent);
        assert_eq!(
            hand_off_if_due(&mut s, sent + Duration::minutes(10), None, None),
            None
        );
        assert_eq!(s.auto_hand_off(), Some((SOFT_TOKENS, HARD_TOKENS)));
        assert_eq!(
            hand_off_if_due(&mut s, sent + Duration::minutes(70), None, None),
            Some(Reason::Soft)
        );
        // A mark he or another build set otherwise is left alone.
        let mut other = Session::start(&dir, ChatMode::Normal, ChatKind::Build).unwrap();
        other.set_auto_hand_off(50_000, 80_000);
        timed_reply(&mut other, 40_000, sent);
        hand_off_if_due(&mut other, sent + Duration::minutes(10), None, None);
        assert_eq!(other.auto_hand_off(), Some((50_000, 80_000)));
    }

    /// Item 811's check: a chat whose fresh slice starts at 80k is not
    /// handed off at 110k (cold, past the 100k mark, only 30k grown), and is
    /// at 135k (cold, 55k grown); the hand-off logs its sizes.
    #[test]
    fn a_chat_that_starts_at_80k_carries_on_at_110k_and_hands_off_at_135k() {
        let dir = scratch();
        let mut s = Session::start(&dir, ChatMode::Normal, ChatKind::Build).unwrap();
        s.set_auto_hand_off(SOFT_TOKENS, HARD_TOKENS);
        let sent = Utc::now();
        s.record_user_message("Morning scan — facts", vec![], vec![], false);
        timed_reply(&mut s, 80_000, sent - Duration::minutes(10));
        s.record_user_message("what's on today", vec![], vec![], false);
        timed_reply(&mut s, 110_000, sent);
        assert_eq!(fresh_start(&s), Some(80_100));
        let cold = sent + Duration::hours(2);
        assert_eq!(hand_off_if_due(&mut s, cold, None, None), None, "110k");
        assert!(s.pending_hand_off().is_none());
        s.record_user_message("and the mail", vec![], vec![], false);
        timed_reply(&mut s, 135_000, cold);
        let colder = cold + Duration::hours(2);
        assert_eq!(
            hand_off_if_due(&mut s, colder, None, None),
            Some(Reason::Soft),
            "135k"
        );
        let ask = crate::cache_miss::ask_dir_of(&s).unwrap();
        let lines = read_hand_offs(&ask);
        assert_eq!(lines.len(), 1);
        let l = &lines[0];
        assert_eq!(
            (l.start, l.context, l.reason.as_str()),
            (80_100, 135_100, "soft")
        );
        assert_eq!(l.at_ms, colder.timestamp_millis());
        let brief = s.pending_hand_off().unwrap();
        assert_eq!(l.brief_tokens, (brief.len() / 4) as u64);

        // The new slice's first reply is its fresh start: a brief that
        // lands it at 105k is not handed off again at 105k or 140k.
        s.record_agent_session("claude-code", "s-2");
        s.record_user_message("next", vec![], vec![], false);
        timed_reply(&mut s, 105_000, colder);
        assert_eq!(fresh_start(&s), Some(105_100));
        let later = colder + Duration::hours(2);
        assert_eq!(hand_off_if_due(&mut s, later, None, None), None, "no loop");
        timed_reply(&mut s, 140_000, later);
        assert_eq!(
            hand_off_if_due(&mut s, later + Duration::hours(2), None, None),
            None,
            "35k grown"
        );
        // The hard mark is not guarded: past it the chat hands off.
        timed_reply(&mut s, HARD_TOKENS, later);
        assert_eq!(
            hand_off_if_due(&mut s, later + Duration::minutes(1), None, None),
            Some(Reason::Hard)
        );
        assert_eq!(read_hand_offs(&ask).len(), 2);
    }

    /// Item 811: the fresh start is read off the log, so a relaunch (the
    /// log loaded again) reads the same start and makes the same call.
    #[test]
    fn the_fresh_start_survives_a_relaunch() {
        let dir = scratch();
        let mut s = Session::start(&dir, ChatMode::Normal, ChatKind::Build).unwrap();
        s.set_auto_hand_off(SOFT_TOKENS, HARD_TOKENS);
        let sent = Utc::now();
        s.record_user_message("go", vec![], vec![], false);
        timed_reply(&mut s, 30_000, sent - Duration::hours(1));
        s.record_hand_off("brief".into(), 120_000, "soft");
        s.record_agent_session("claude-code", "s-2");
        s.record_user_message("next", vec![], vec![], false);
        timed_reply(&mut s, 80_000, sent - Duration::minutes(5));
        timed_reply(&mut s, 110_000, sent);
        assert_eq!(fresh_start(&s), Some(80_100));
        let mut back = Session::load(s.log_path().unwrap()).unwrap();
        assert_eq!(fresh_start(&back), Some(80_100), "after a relaunch");
        let cold = sent + Duration::hours(2);
        assert_eq!(hand_off_if_due(&mut back, cold, None, None), None);
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
        assert_eq!(hand_off_if_due(&mut s, Utc::now(), None, None), None);
        s.set_auto_hand_off(SOFT_TOKENS, HARD_TOKENS);
        // Soft, not idle yet.
        assert_eq!(hand_off_if_due(&mut s, Utc::now(), None, None), None);
        let later = Utc::now() + Duration::seconds(IDLE_SECS + 5);
        assert_eq!(
            hand_off_if_due(&mut s, later, Some("Morning scan"), None),
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
        assert_eq!(hand_off_if_due(&mut s, later, None, None), None);
        // His next message carries it until the new agent session starts
        // (a turn that failed before it leaves the brief for the next).
        s.record_user_message("and the CI?", vec![], vec![], false);
        assert!(s.pending_hand_off().is_some(), "a failed turn keeps it");
        assert_eq!(
            hand_off_if_due(&mut s, later, None, None),
            None,
            "never twice"
        );
        s.record_agent_session("claude-code", "s-2");
        assert_eq!(s.pending_hand_off(), None);
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

    /// Item 789's done-when: a job's third hand-off still carries run 1's
    /// exact finding — the run log's entry, as written, not a summary of a
    /// summary — and the brief does not grow with every hand-off.
    #[test]
    fn a_jobs_third_hand_off_still_carries_run_ones_exact_finding() {
        use crate::chain;
        let dir = scratch();
        let mut s = Session::start(&dir, ChatMode::Normal, ChatKind::Build).unwrap();
        let logs = s.log_path().unwrap().parent().unwrap().to_path_buf();
        s.set_auto_hand_off(SOFT_TOKENS, HARD_TOKENS);
        chain::ensure(&logs, &s.id).unwrap();
        let run1 = "Checked the signup flow: p95 412.7 ms on /api/signup (was 388.1); \
                    the 500s come from `auth.rs:214` — \"token expired 2026-11-17T08:01:09Z\".";
        let mut now = t0();
        let mut sizes = Vec::new();
        for run in 1..=3 {
            s.record_user_message("Morning job: check the signup flow", vec![], vec![], false);
            reply(&mut s, &format!("run {run} done"), HARD_TOKENS + 1, None);
            let text = if run == 1 {
                run1.to_string()
            } else {
                format!("Run {run}: nothing new; p95 {}.0 ms", 400 + run)
            };
            chain::append(&logs, &s.id, chain::Kind::Run, now, &text).unwrap();
            now += chrono::Duration::days(1);
            assert_eq!(
                hand_off_if_due(&mut s, now, Some("Morning job"), Some(&logs)),
                Some(Reason::Hard),
                "hand-off {run}"
            );
            let b = s.pending_hand_off().unwrap().to_string();
            assert!(
                b.contains(run1),
                "hand-off {run} carries run 1 exactly:\n{b}"
            );
            assert_eq!(
                b.matches(run1).count(),
                1,
                "carried once, not once per hand-off"
            );
            sizes.push(b.len());
            // The next run starts the new slice.
            s.record_agent_session("claude-code", format!("s-{run}"));
        }
        assert!(
            sizes[2] < sizes[0] + 2_000,
            "the brief does not snowball: {sizes:?}"
        );
    }

    /// Item 807's done-when: a fourth hand-off's brief carries exactly the
    /// newest three run-log entries, each as written, and says the oldest
    /// is in the file — in a job's chat and a talked one alike.
    #[test]
    fn a_fourth_hand_off_carries_exactly_the_newest_three_run_log_entries() {
        use crate::chain;
        for talked in [false, true] {
            let dir = scratch();
            let mut s = Session::start(&dir, ChatMode::Normal, ChatKind::Build).unwrap();
            let logs = s.log_path().unwrap().parent().unwrap().to_path_buf();
            s.set_auto_hand_off(SOFT_TOKENS, HARD_TOKENS);
            chain::ensure(&logs, &s.id).unwrap();
            let entry = |run: u32| format!("Run {run}: p95 {}.{run} ms on /api/signup", 400 + run);
            let mut now = t0();
            for run in 1..=4 {
                let msg = if talked {
                    format!("look at the signup flow, round {run}")
                } else {
                    "Morning job: check the signup flow".to_string()
                };
                s.record_user_message(msg, vec![], vec![], false);
                reply(&mut s, &format!("run {run} done"), HARD_TOKENS + 1, None);
                chain::append(&logs, &s.id, chain::Kind::Run, now, &entry(run)).unwrap();
                now += chrono::Duration::days(1);
                assert_eq!(
                    hand_off_if_due(&mut s, now, Some("Morning job"), Some(&logs)),
                    Some(Reason::Hard),
                    "hand-off {run}"
                );
                if run < 4 {
                    s.record_agent_session("claude-code", format!("s-{run}"));
                }
            }
            let b = s.pending_hand_off().unwrap().to_string();
            assert_eq!(
                b.contains("look at the signup flow, round 4"),
                talked,
                "the right kind of chat"
            );
            let carried: Vec<u32> = (1..=4).filter(|r| b.contains(&entry(*r))).collect();
            assert_eq!(carried, [2, 3, 4], "exactly the newest three:\n{b}");
            for r in 2..=4 {
                assert_eq!(b.matches(&entry(r)).count(), 1, "run {r} once");
            }
            assert!(b.contains("Run log (newest 3 of 4;"), "{b}");
            assert!(b.contains("1 older entry is not carried"), "{b}");
        }
    }

    /// Item 791: the state file is frozen per slice — a write after the
    /// hand-off lands on disk, and only the next hand-off carries it.
    #[test]
    fn the_state_file_is_frozen_for_the_slice_and_the_next_hand_off_carries_the_write() {
        use crate::chain;
        let dir = scratch();
        let mut s = Session::start(&dir, ChatMode::Normal, ChatKind::Build).unwrap();
        let logs = s.log_path().unwrap().parent().unwrap().to_path_buf();
        s.set_auto_hand_off(SOFT_TOKENS, HARD_TOKENS);
        chain::ensure(&logs, &s.id).unwrap();
        chain::write_state(&logs, &s.id, "- open: the flaky upload test\n").unwrap();
        s.record_user_message("go", vec![], vec![], false);
        reply(&mut s, "ok", HARD_TOKENS + 1, None);
        hand_off_if_due(&mut s, t0(), None, Some(&logs)).unwrap();
        let first = s.pending_hand_off().unwrap().to_string();
        assert!(first.contains("the flaky upload test"));
        // Mid-slice: the write lands, the slice's brief does not change.
        chain::write_state(&logs, &s.id, "- closed: upload test fixed in 4c95c5f2\n").unwrap();
        assert_eq!(s.pending_hand_off().unwrap(), first);
        s.record_agent_session("claude-code", "s-2");
        s.record_user_message("next", vec![], vec![], false);
        reply(&mut s, "ok", HARD_TOKENS + 1, None);
        hand_off_if_due(&mut s, t0(), None, Some(&logs)).unwrap();
        let second = s.pending_hand_off().unwrap().to_string();
        let (now_part, before) = second.split_once("## The hand-off before").unwrap();
        assert!(now_part.contains("upload test fixed in 4c95c5f2"));
        assert!(!now_part.contains("the flaky upload test"));
        assert!(
            !before.contains("## State file"),
            "the old copy is not carried twice"
        );
    }
}
