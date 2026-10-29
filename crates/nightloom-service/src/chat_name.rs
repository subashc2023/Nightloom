//! Chats name themselves (nightshift backlog 209): after the first reply a
//! one-shot Haiku turn on the Claude Code engine gives the chat a short
//! title in place of its first line, and after the fourth reply it names it
//! once more from the exchanges so far; then never again.
//!
//! **A name he gave is never touched.** Every rename he makes records its
//! title `by: user` ([`nightloom_core::TitleBy`]); a title from before that
//! flag existed is read as his too ([`Session::named_by_user`]). The naming
//! turn runs after the chat's turn has ended and off its path, so he can
//! rename while it runs: the result is recorded only if the chat's title is
//! still the one it started from and still not his ([`may_record`]).
//!
//! The turn itself is note_edit's shape (backlog 151): `--tools ""`, no MCP
//! servers, one round, no session file, an empty scratch folder — so the
//! model can do nothing but answer.
//!
//! What this module does not decide is the name's *shape* beyond "a few
//! words": backlog 093 (naming schemes, `<prefix> <n> (<desc>)`) would feed
//! its description rule through here — [`compose`] is the one place the
//! prompt is written.

use crate::agent::{AgentSpec, PassSpec};
use nightloom_core::{ChatMode, ContentBlock, Session, SessionEvent, TitleBy};
use std::path::Path;

/// The model a naming turn runs on, whatever the chat's own model is.
pub const NAMING_MODEL: &str = "haiku";

/// The reply count at which the name is refined, once.
pub const REFINE_AT: usize = 4;

/// A name, not a sentence — and a column in a sidebar.
pub const MAX_CHARS: usize = 60;

/// The prompt asks for 3–7; one word of slack before cutting.
pub const MAX_WORDS: usize = 8;

/// How much of each side of an exchange the namer sees: more of the one
/// exchange on the first pass, less of each of four on the refinement.
const FIRST_CLIP: usize = 600;
const REFINE_CLIP: usize = 300;

/// Which of the two namings is due.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NamingPass {
    /// From the first exchange, replacing the first-line default.
    First,
    /// From the exchanges so far, once, at [`REFINE_AT`] replies.
    Refine,
}

/// What the chat's title is now, as the rule reads it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TitleState {
    /// No title: the sidebar shows the first line.
    Default,
    /// A naming pass wrote it.
    Model,
    /// He named it (or it predates the flag) — never touched.
    His,
}

pub fn title_state(session: &Session) -> TitleState {
    if session.title().is_none() || carried_title(session) {
        TitleState::Default
    } else if session.named_by_user() {
        TitleState::His
    } else {
        TitleState::Model
    }
}

/// A title that stands in for the first line rather than naming the chat
/// (item 462): one recorded before the chat's first message, which only a
/// fork carries (`chat_ops::keep_the_name`, item 363). Since 462 that
/// carry is written `by: model` and is renamed by the first naming like
/// any first-line default. Forks made before 462 wrote it `by: user` as the
/// parent's whole first message — his first message, never a name he
/// typed; such a title (not [`is_name_like`]: a second line, or longer than
/// a name) is read as the default too, so those chats are named at their
/// next reply. A short one-line carry is the name he sent (363) and stays.
pub fn carried_title(session: &Session) -> bool {
    let live = session.live_events();
    let first_user = live
        .iter()
        .position(|(_, e)| matches!(e, SessionEvent::UserMessage { .. }));
    let Some(at) = live
        .iter()
        .rposition(|(_, e)| matches!(e, SessionEvent::Title { .. }))
    else {
        return false;
    };
    if first_user.is_some_and(|u| u < at) {
        return false;
    }
    match live[at].1 {
        SessionEvent::Title { text, by, .. } => *by == Some(TitleBy::Model) || !is_name_like(text),
        _ => false,
    }
}

/// Whether a first message reads as a name he sent (item 363's "send a
/// first chat just to name it"): one line, no longer than a name.
pub fn is_name_like(text: &str) -> bool {
    let t = text.trim();
    !t.contains('\n') && t.chars().count() <= MAX_CHARS
}

/// A message's first line as a stand-in title (item 462): one line, at most
/// [`MAX_CHARS`] characters, an ellipsis where it was cut.
pub fn first_line_title(text: &str) -> String {
    let line = text.trim().lines().next().unwrap_or("").trim();
    if line.chars().count() <= MAX_CHARS {
        return line.to_string();
    }
    let cut: String = line.chars().take(MAX_CHARS - 1).collect();
    format!("{}…", cut.trim_end())
}

/// The when-to-name rule, pure. `replies` is the number of answered
/// exchanges after the turn that just ended.
///
/// - never on an ephemeral chat (no log, no list: a name for nothing), and
///   never on a chat he named;
/// - the first naming after reply 1, and again after replies 2 and 3 only
///   if it has not landed yet (a failed naming is retried next reply, not
///   lost);
/// - the refinement after reply [`REFINE_AT`], exactly once;
/// - nothing after — and so nothing on an old chat past four replies.
pub fn naming_due(replies: usize, state: TitleState, mode: ChatMode) -> Option<NamingPass> {
    if mode == ChatMode::Ephemeral || state == TitleState::His {
        return None;
    }
    match replies {
        REFINE_AT => Some(NamingPass::Refine),
        1..REFINE_AT if state == TitleState::Default => Some(NamingPass::First),
        _ => None,
    }
}

/// One exchange as the namer reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Exchange {
    pub asked: String,
    pub replied: String,
    pub answered: bool,
}

/// The live exchanges: each user message with the text of every assistant
/// message after it, up to the next. Tool rounds carry no text blocks
/// worth naming from and are skipped.
pub fn exchanges(session: &Session) -> Vec<Exchange> {
    let mut out: Vec<Exchange> = Vec::new();
    for (_, e) in session.live_events() {
        match e {
            SessionEvent::UserMessage { text, .. } => out.push(Exchange {
                asked: text.clone(),
                replied: String::new(),
                answered: false,
            }),
            SessionEvent::AssistantMessage { blocks, .. } => {
                if let Some(last) = out.last_mut() {
                    last.answered = true;
                    for b in blocks {
                        if let ContentBlock::Text { text } = b {
                            if !last.replied.is_empty() {
                                last.replied.push('\n');
                            }
                            last.replied.push_str(text);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// A naming the caller should run: the message to send, and the title the
/// chat had when it was planned, for [`may_record`] to compare against.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NamingJob {
    pub pass: NamingPass,
    pub message: String,
    pub expected: Option<String>,
}

/// Whether a naming is due for `session` now, and what to send.
pub fn plan(session: &Session) -> Option<NamingJob> {
    let ex = exchanges(session);
    let replies = ex.iter().filter(|e| e.answered).count();
    let pass = naming_due(replies, title_state(session), session.mode())?;
    Some(NamingJob {
        pass,
        message: compose(pass, &ex),
        expected: session.title().map(String::from),
    })
}

/// Whether a finished naming may be recorded: the chat is still not his,
/// and its title is still the one the naming started from — so a title he
/// typed while it ran is never overwritten, nor a newer model title by an
/// older one.
pub fn may_record(session: &Session, expected: Option<&str>) -> bool {
    // `title_state`, not `named_by_user`: a carried title (item 462) may be
    // written `by: user` and is still the default.
    session.mode() != ChatMode::Ephemeral
        && title_state(session) != TitleState::His
        && session.title() == expected
}

/// The message for one naming.
pub fn compose(pass: NamingPass, exchanges: &[Exchange]) -> String {
    let (take, clip_at, lead) = match pass {
        NamingPass::First => (
            1,
            FIRST_CLIP,
            "Name the conversation below for a list of saved chats.",
        ),
        NamingPass::Refine => (
            REFINE_AT,
            REFINE_CLIP,
            "Name the conversation below for a list of saved chats, from all of it: \
             say what it has turned out to be about, not only how it started.",
        ),
    };
    let mut body = String::new();
    for e in exchanges.iter().filter(|e| e.answered).take(take) {
        body.push_str(&format!(
            "User: {}\n\nAssistant: {}\n\n",
            clip(&e.asked, clip_at),
            clip(&e.replied, clip_at)
        ));
    }
    format!(
        "{lead} Use 3 to 7 words. Say what it is about, using the user's own words for it \
         where they gave any, and prefer the specific noun to the general one. Reply with the \
         title by itself: no quotes, no trailing period, no preamble.\n\n\
         <conversation>\n{}</conversation>\n",
        body
    )
}

/// Trim a model's answer down to a name: the first non-empty line, a
/// `Title:` label, wrapping quotes, bold or heading marks and a trailing
/// period taken off, whitespace collapsed, at most [`MAX_WORDS`] words and
/// [`MAX_CHARS`] characters (cut at a word). Empty means unusable.
pub fn clean_title(raw: &str) -> String {
    let line = raw.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
    let mut s = line.trim();
    for label in ["title:", "chat title:", "name:"] {
        if s.len() >= label.len() && s[..label.len()].eq_ignore_ascii_case(label) {
            s = s[label.len()..].trim();
        }
    }
    let wrap = |c: char| {
        matches!(
            c,
            '"' | '\'' | '\u{201c}' | '\u{201d}' | '\u{2018}' | '\u{2019}' | '*' | '#' | '`' | '_'
        )
    };
    let s = s
        .trim_matches(wrap)
        .trim()
        .trim_end_matches(['.', ':', ';', ','])
        .trim_matches(wrap)
        .trim();
    let mut out = String::new();
    for word in s.split_whitespace().take(MAX_WORDS) {
        let next = if out.is_empty() {
            word.chars().count()
        } else {
            out.chars().count() + 1 + word.chars().count()
        };
        if next > MAX_CHARS {
            if out.is_empty() {
                out = word.chars().take(MAX_CHARS).collect();
            }
            break;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    out.trim_end_matches(['.', ':', ';', ',']).to_string()
}

/// Collapse whitespace and clip to `max` characters, with an ellipsis.
fn clip(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        flat
    } else {
        let mut s: String = flat.chars().take(max).collect();
        s.push('…');
        s
    }
}

/// The CLI spec for one naming, rooted at `scratch` (an empty folder the
/// caller makes, so the CLI reads no project's `CLAUDE.md`). The model is
/// [`NAMING_MODEL`] whatever the pass carries.
pub fn spec_for(pass: &PassSpec, scratch: &Path) -> AgentSpec {
    let mut spec = pass.spec_in(scratch);
    spec.model = Some(NAMING_MODEL.to_string());
    spec.tools = Some(Vec::new());
    crate::dream::strict_mcp(&mut spec);
    spec.max_turns = Some(1);
    spec.no_session_persistence = true;
    spec.append_system_prompt = Some(IDENTITY.to_string());
    spec
}

const IDENTITY: &str = "You are Nightloom's chat namer. You have no tools and you do not \
     chat: your whole reply is one short title for the conversation you are shown.";

#[cfg(test)]
mod tests {
    use super::*;
    use nightloom_core::{TitleBy, Usage};

    fn reply(s: &mut Session, asked: &str, said: &str) {
        s.record_user(asked);
        s.record_assistant(
            "haiku",
            vec![ContentBlock::Text { text: said.into() }],
            Some("end_turn".into()),
            Usage::default(),
        );
    }

    /// Item 462, his chat: an edit of the first message forked an untitled
    /// chat, and the fork carried his whole first message as a title "by
    /// user" — so no naming ever ran, after several replies.
    #[test]
    fn a_fork_carrying_his_whole_first_message_is_still_named() {
        let long = "Alright so I've got a midterm for this class on Friday. This is midterm 2.\n\
                    Funny story, I didn't even go to class for midterm 1.";
        let mut old = Session::new();
        old.record_title_by(long, TitleBy::User); // what forks wrote before 462
        reply(&mut old, long, "Let's plan the week.");
        assert_eq!(title_state(&old), TitleState::Default);
        let job = plan(&old).expect("a naming is due after the first reply");
        assert_eq!(job.pass, NamingPass::First);
        assert!(may_record(&old, job.expected.as_deref()));
        reply(&mut old, "and the practice exam?", "Here is a schedule.");
        assert!(
            plan(&old).is_some(),
            "still due at the second reply if the first failed"
        );

        // Since 462 the carry is the model's, one line, cut to a name.
        let mut new = Session::new();
        new.record_title_by(first_line_title(long), TitleBy::Model);
        assert!(new.title().unwrap().chars().count() <= MAX_CHARS);
        assert!(!new.title().unwrap().contains('\n'));
        reply(&mut new, long, "Let's plan the week.");
        assert_eq!(title_state(&new), TitleState::Default);
        assert_eq!(plan(&new).map(|j| j.pass), Some(NamingPass::First));
    }

    #[test]
    fn a_short_carried_name_stays_his_and_a_later_rename_is_never_touched() {
        // Item 363: a short first message sent to name the chat, then edited.
        let mut sent = Session::new();
        sent.record_title_by("Lecture 4 & 5", TitleBy::User);
        reply(&mut sent, "Lecture 4 & 5 — notes attached", "Got them.");
        assert_eq!(title_state(&sent), TitleState::His);
        assert!(plan(&sent).is_none());
        // A rename after the chat began is his whatever its length.
        let mut renamed = Session::new();
        reply(&mut renamed, "hi", "hello");
        renamed.record_title_by("x".repeat(200), TitleBy::User);
        assert_eq!(title_state(&renamed), TitleState::His);
    }

    #[test]
    fn first_line_title_is_one_line_cut_with_an_ellipsis() {
        assert_eq!(first_line_title("  Short one  \nsecond"), "Short one");
        let cut = first_line_title(&"word ".repeat(40));
        assert_eq!(cut.chars().count(), MAX_CHARS);
        assert!(cut.ends_with('…'));
        assert!(is_name_like("Lecture 4 & 5"));
        assert!(!is_name_like("two\nlines"));
    }

    #[test]
    fn the_rule_names_after_the_first_reply_and_refines_after_the_fourth_then_never() {
        use NamingPass::*;
        use TitleState::*;
        let n = ChatMode::Normal;
        assert_eq!(naming_due(0, Default, n), None);
        assert_eq!(naming_due(1, Default, n), Some(First));
        // Retried while the first has not landed; not repeated once it has.
        assert_eq!(naming_due(2, Default, n), Some(First));
        assert_eq!(naming_due(3, Default, n), Some(First));
        assert_eq!(naming_due(2, Model, n), None);
        assert_eq!(naming_due(4, Model, n), Some(Refine));
        assert_eq!(naming_due(4, Default, n), Some(Refine));
        assert_eq!(naming_due(5, Model, n), None);
        assert_eq!(naming_due(40, Default, n), None);
    }

    #[test]
    fn the_rule_never_touches_his_name_or_an_ephemeral_chat() {
        for r in 0..10 {
            assert_eq!(naming_due(r, TitleState::His, ChatMode::Normal), None);
            assert_eq!(
                naming_due(r, TitleState::Default, ChatMode::Ephemeral),
                None
            );
        }
        // Incognito is named (blocker 434's default).
        assert_eq!(
            naming_due(1, TitleState::Default, ChatMode::Incognito),
            Some(NamingPass::First)
        );
    }

    #[test]
    fn a_plan_follows_the_session() {
        let mut s = Session::new();
        s.record_user("unanswered");
        assert_eq!(plan(&s), None, "no reply yet");
        s.record_assistant(
            "haiku",
            vec![ContentBlock::Text {
                text: "Sourdough needs a starter".into(),
            }],
            Some("end_turn".into()),
            Usage::default(),
        );
        let job = plan(&s).expect("due after the first reply");
        assert_eq!(job.pass, NamingPass::First);
        assert_eq!(job.expected, None);
        assert!(job.message.contains("User: unanswered"));
        assert!(job.message.contains("Assistant: Sourdough needs a starter"));

        s.record_title_by("Sourdough starter basics", TitleBy::Model);
        reply(&mut s, "two", "b");
        reply(&mut s, "three", "c");
        assert_eq!(plan(&s), None);
        reply(&mut s, "four", "d");
        let job = plan(&s).expect("the refinement");
        assert_eq!(job.pass, NamingPass::Refine);
        assert_eq!(job.expected.as_deref(), Some("Sourdough starter basics"));
        assert!(job.message.contains("User: four"));
        reply(&mut s, "five", "e");
        assert_eq!(plan(&s), None);

        // His rename stops it for good.
        let mut his = Session::new();
        reply(&mut his, "one", "a");
        his.record_title_by("My name", TitleBy::User);
        for _ in 0..4 {
            assert_eq!(plan(&his), None);
            reply(&mut his, "more", "x");
        }
    }

    #[test]
    fn a_title_he_typed_while_the_naming_ran_is_kept() {
        let mut s = Session::new();
        reply(&mut s, "one", "a");
        let job = plan(&s).unwrap();
        assert!(may_record(&s, job.expected.as_deref()));
        s.record_title_by("Typed meanwhile", TitleBy::User);
        assert!(!may_record(&s, job.expected.as_deref()));

        // A newer model title is not overwritten by an older naming either.
        let mut t = Session::new();
        reply(&mut t, "one", "a");
        let stale = plan(&t).unwrap();
        t.record_title_by("Newer", TitleBy::Model);
        assert!(!may_record(&t, stale.expected.as_deref()));
        assert!(may_record(&t, Some("Newer")));
    }

    #[test]
    fn a_title_is_stripped_of_its_packaging() {
        assert_eq!(
            clean_title("Sourdough starter basics"),
            "Sourdough starter basics"
        );
        assert_eq!(
            clean_title("  \"Sourdough starter basics.\"  "),
            "Sourdough starter basics"
        );
        assert_eq!(
            clean_title("**Sourdough starter basics**"),
            "Sourdough starter basics"
        );
        assert_eq!(
            clean_title("\u{201c}Sourdough starter basics\u{201d}"),
            "Sourdough starter basics"
        );
        assert_eq!(
            clean_title("Title: Sourdough starter basics"),
            "Sourdough starter basics"
        );
        assert_eq!(clean_title("'Fixing the build'."), "Fixing the build");
        assert_eq!(
            clean_title("\n\nSourdough starter basics\n\nI kept it short."),
            "Sourdough starter basics"
        );
        assert_eq!(clean_title("\n \n"), "");
        assert_eq!(clean_title("\"\""), "");
    }

    #[test]
    fn a_title_is_capped_in_words_and_characters() {
        let long = "one two three four five six seven eight nine ten";
        assert_eq!(clean_title(long), "one two three four five six seven eight");
        let wide = "Supercalifragilistic expialidocious antidisestablishmentarianism \
                    floccinaucinihilipilification words";
        let t = clean_title(wide);
        assert!(t.chars().count() <= MAX_CHARS, "{t}");
        assert!(wide.starts_with(&t), "cut at a word: {t}");
        let one = "x".repeat(200);
        assert_eq!(clean_title(&one).chars().count(), MAX_CHARS);
    }

    #[test]
    fn the_refinement_shows_four_exchanges_clipped() {
        let ex: Vec<Exchange> = (1..=6)
            .map(|i| Exchange {
                asked: format!("q{i} {}", "word ".repeat(200)),
                replied: format!("a{i}"),
                answered: true,
            })
            .collect();
        let m = compose(NamingPass::Refine, &ex);
        assert!(m.contains("User: q4"));
        assert!(!m.contains("User: q5"));
        assert!(m.contains('…'));
        let f = compose(NamingPass::First, &ex);
        assert!(f.contains("User: q1"));
        assert!(!f.contains("User: q2"));
        assert!(f.contains("3 to 7 words"));
    }

    fn value_after<'a>(a: &'a [String], flag: &str) -> Option<&'a str> {
        let i = a.iter().position(|x| x == flag)?;
        a.get(i + 1).map(String::as_str)
    }

    #[test]
    fn the_naming_turn_is_haiku_with_no_tools_no_servers_and_no_session() {
        let mut p = PassSpec::new("claude", Vec::new());
        p.model = Some("opus".into());
        let spec = spec_for(&p, Path::new("/tmp/scratch"));
        let a = spec.args("go");
        assert_eq!(value_after(&a, "--model"), Some("haiku"), "{a:?}");
        assert_eq!(value_after(&a, "--tools"), Some(""), "{a:?}");
        assert!(a.iter().any(|x| x == "--strict-mcp-config"), "{a:?}");
        assert!(!a.iter().any(|x| x == "--mcp-config"), "{a:?}");
        assert_eq!(value_after(&a, "--max-turns"), Some("1"), "{a:?}");
        assert!(a.iter().any(|x| x == "--no-session-persistence"), "{a:?}");
        assert!(!a.iter().any(|x| x == "--resume"), "{a:?}");
        assert_eq!(spec.workspace, Path::new("/tmp/scratch"));
    }

    /// The live check (not run by the suite: one real Haiku turn on the
    /// subscription). `cargo test -p nightloom-service chat_name::tests::live
    /// -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live_a_naming_turn_on_haiku_returns_a_short_title() {
        use crate::agent::ClaudeCodeAgent;
        use tokio_util::sync::CancellationToken;
        let dir =
            std::env::temp_dir().join(format!("nightloom-chat-name-live-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut s = Session::new();
        reply(
            &mut s,
            "How do I keep a sourdough starter alive while I travel for two weeks?",
            "Feed it, let it rise for an hour, then refrigerate it; it will keep for two weeks. \
             When you return, discard half and feed it twice a day until it doubles again.",
        );
        let job = plan(&s).unwrap();
        let spec = spec_for(&PassSpec::new("claude", Vec::new()), &dir);
        let out = ClaudeCodeAgent::new(spec)
            .run_turn(job.message.as_str(), &CancellationToken::new(), &mut |_| {})
            .await
            .expect("the CLI ran");
        let title = clean_title(&out.text);
        println!("--- raw: {:?}\n--- title: {title:?}", out.text);
        assert!(!out.is_error, "{}", out.text);
        assert!(!title.is_empty());
        assert!(title.split_whitespace().count() <= MAX_WORDS);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
