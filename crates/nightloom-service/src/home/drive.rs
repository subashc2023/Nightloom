//! `ask_user_to_drive` (nightshift item 872 step 5; 846 §5): Home asks him
//! to take the page in Claude's browser — a sign-in, a code, a choice only
//! he can make — and waits for him to hand it back.
//!
//! The tool does nothing itself. Its call pauses on a card (its own gate,
//! built like `request_secret`'s: [`GATE_MATCHER`], failing closed, the
//! chat's rules never read). On the Mac the card's *Take control* opens the
//! chat's browser tab with the browser held for him; *Hand back* gives the
//! browser back and answers Allow with the page he left it on and his note.
//! The turn keeps that as [`HANDBACK_FILE`] in the chat's directory
//! ([`note_handed_back`]) and the tool reads it there, once
//! ([`take_handed_back`]) — **never from its own input**, so a model that
//! writes a `handed_back` of its own into the call gets nothing for it
//! ([`strip`] removes it before the call runs, too).
//!
//! An Allow that carries no hand-back (the phone, which cannot drive the
//! Mac's browser; an older window) is not a hand-back: the model reads
//! [`NOT_HANDED_BACK`] and nothing is claimed about the page.

use std::path::{Path, PathBuf};

use nightloom_core::ToolDef;
use nightloom_core::tool::{CancellationToken, Effect, Tool};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// The tool's name: `mcp__nightloom__ask_user_to_drive` on the CLI.
pub const TOOL: &str = "ask_user_to_drive";

/// Its gate's `PreToolUse` matcher: the tool alone, by its CLI name. Kept
/// out of the Ask hook's `mcp__` alternative for the reason `add_folder`
/// and `request_secret` are (`ask::MATCHER`): two hooks on one call race
/// for its decision file.
pub const GATE_MATCHER: &str = "mcp__nightloom__ask_user_to_drive";

/// The note the turn leaves in the chat's directory when he hands the page
/// back: `{"url", "title", "note"}`. Read once by the tool.
pub const HANDBACK_FILE: &str = "drive-handed-back.json";

/// The field the card's answer carries, and the one a model must not be
/// able to supply.
pub const HANDED_BACK: &str = "handed_back";

/// The longest reason the card shows, and the longest note of his the
/// model reads (characters).
const WHY_MAX: usize = 400;
const NOTE_MAX: usize = 2000;
const URL_MAX: usize = 2000;
const TITLE_MAX: usize = 300;

/// What a subagent reads: no card can wait at that depth.
pub const SUBAGENT_REFUSED: &str = "Not asked: only the main chat can ask the user to take the page — no card can wait on a helper. Say in your report what needs their hands and why.";

/// What a side process (an aside, a checkpoint fork) reads.
pub const SIDE_REFUSED: &str = "Not asked: the user can be asked to take the page only from the chat itself, where they can answer.";

/// What the model reads when he declined.
pub const DECLINED: &str = "The user declined to take the page. Do not ask again in this reply unless they say to; carry on without it or say what you could not do.";

/// What the model reads when the answer was an Allow with no hand-back —
/// from his phone, where the Mac's browser cannot be driven.
pub const NOT_HANDED_BACK: &str = "Not handed back: the user answered without taking the page (their phone cannot drive the browser on the Mac). Nothing on the page changed. Carry on with what does not need it, and ask again when the rest is done.";

/// What the model reads in a run nobody is there for.
pub const UNATTENDED: &str = "Not asked: nobody is there to take the page (no phone connected, nobody at the Mac), so this was set aside and their phone was told. Carry on with what does not need it and say in your reply what is waiting for their hands.";

/// The sentence `initialize` adds when the tool is served.
pub const INSTRUCTION: &str = " When a page in your browser needs the user's own hands — a sign-in, \
     a two-factor code, a CAPTCHA, a payment or a choice only they can make — open that page first, \
     then call ask_user_to_drive (ToolSearch mcp__nightloom__ask_user_to_drive) with one line \
     saying what to do there. They take the browser on a card, do it, and hand it back; the result \
     names the page they left it on and their note. Read the page again before acting on it. \
     Never ask them to type a password or a code into the chat.";

/// The model's one line for the card: what he is to do on the page. The
/// `Err` is what the model reads.
pub fn requested_why(input: &Value) -> Result<String, String> {
    let why = input
        .get("why")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            "ask_user_to_drive needs `why`: one line saying what the user is to do on the page, like \"Sign in to the bank; I cannot see the code\".".to_string()
        })?;
    Ok(clip(why, WHY_MAX))
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

/// What he handed back: where he left the page, and his words.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandedBack {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub note: String,
}

/// The hand-back in a card's answer (`{…input, handed_back: {url, title,
/// note}}`), if it carries one. Only an object counts; each part is
/// trimmed and clipped.
pub fn handed_back(answer: Option<&Value>) -> Option<HandedBack> {
    let h = answer?.get(HANDED_BACK)?.as_object()?;
    let part = |k: &str, max: usize| {
        h.get(k)
            .and_then(Value::as_str)
            .map(|s| clip(s.trim(), max))
            .unwrap_or_default()
    };
    Some(HandedBack {
        url: part("url", URL_MAX),
        title: part("title", TITLE_MAX),
        note: part("note", NOTE_MAX),
    })
}

/// `input` without a `handed_back` of anyone's: what the call runs with.
pub fn strip(input: &Value) -> Value {
    let mut out = input.clone();
    if let Value::Object(o) = &mut out {
        o.remove(HANDED_BACK);
    }
    out
}

/// Keep his hand-back for the tool (the turn, on the card's Allow).
pub fn note_handed_back(chat_dir: &Path, h: &HandedBack) -> std::io::Result<()> {
    std::fs::create_dir_all(chat_dir)?;
    let path = chat_dir.join(HANDBACK_FILE);
    let tmp = chat_dir.join(format!("{HANDBACK_FILE}.tmp"));
    std::fs::write(&tmp, serde_json::to_vec(h)?)?;
    std::fs::rename(tmp, path)
}

/// Forget a hand-back nobody read (a new ask starts clean).
pub fn clear_handed_back(chat_dir: &Path) {
    let _ = std::fs::remove_file(chat_dir.join(HANDBACK_FILE));
}

/// Whether a hand-back waits for the tool.
pub fn has_handed_back(chat_dir: &Path) -> bool {
    chat_dir.join(HANDBACK_FILE).is_file()
}

/// The hand-back, read once: the file is removed whether or not it parsed.
pub fn take_handed_back(chat_dir: &Path) -> Option<HandedBack> {
    let path = chat_dir.join(HANDBACK_FILE);
    let bytes = std::fs::read(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    serde_json::from_slice(&bytes).ok()
}

/// What the model reads once he handed the page back.
pub fn handed_back_reply(h: &HandedBack) -> String {
    let mut out = String::from("Handed back: the user took the browser and has given it back.");
    match (h.title.is_empty(), h.url.is_empty()) {
        (_, true) => out.push_str(" The page it is on now is not known."),
        (true, false) => out.push_str(&format!(" It is now on {}.", h.url)),
        (false, false) => out.push_str(&format!(" It is now on \"{}\" ({}).", h.title, h.url)),
    }
    if h.note.is_empty() {
        out.push_str(" They left no note.");
    } else {
        out.push_str(&format!("\nTheir note: {}", h.note));
    }
    out.push_str(
        "\nRead the page again (a snapshot) before acting on it: it may not be where you left it, and they may not have finished.",
    );
    out
}

/// `ask_user_to_drive`, served beside Home's stage tools where the chat's
/// directory is named. It asks nothing itself: the card does.
pub struct AskUserToDrive {
    chat_dir: PathBuf,
}

impl AskUserToDrive {
    pub fn new(chat_dir: impl Into<PathBuf>) -> Self {
        Self {
            chat_dir: chat_dir.into(),
        }
    }
}

#[async_trait::async_trait]
impl Tool for AskUserToDrive {
    fn effect(&self) -> Effect {
        // It hands the browser to him: the card asks first, every time.
        Effect::Mutating
    }

    fn def(&self) -> ToolDef {
        ToolDef {
            name: TOOL.into(),
            description: "Ask the user to take the page that is open in your browser and do \
                 something only they can — sign in, enter a code, solve a CAPTCHA, pay, choose. \
                 Open the page first. A card asks them; on their Mac they take the browser, do \
                 it, and hand it back. You get back the page they left it on and their note; \
                 read the page again before acting. `why` is one line for the card: what to do \
                 there. One ask at a time; the main chat only, never a subagent."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "why": {
                        "type": "string",
                        "description": "One line for the card: what the user is to do on the page, and when to hand it back."
                    }
                },
                "required": ["why"]
            }),
        }
    }

    async fn call(&self, input: Value, _cancel: &CancellationToken) -> Result<String, String> {
        requested_why(&input)?;
        // Never the input's own `handed_back`: only what the turn kept
        // from the card's answer.
        match take_handed_back(&self.chat_dir) {
            Some(h) => Ok(handed_back_reply(&h)),
            None => Err(format!(
                "Not handed back: the user's answer on the card did not arrive. {DECLINED}"
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh folder, removed when it drops.
    struct Temp(PathBuf);
    impl Temp {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn dir() -> Temp {
        let d = std::env::temp_dir().join(format!("nl-drive-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        Temp(d)
    }

    #[test]
    fn why_is_needed_and_clipped() {
        assert!(requested_why(&json!({})).is_err());
        assert!(requested_why(&json!({"why": "  "})).is_err());
        assert_eq!(
            requested_why(&json!({"why": " Sign in "})).unwrap(),
            "Sign in"
        );
        let long = "x".repeat(WHY_MAX + 50);
        let got = requested_why(&json!({ "why": long })).unwrap();
        assert_eq!(got.chars().count(), WHY_MAX + 1);
    }

    #[test]
    fn only_an_object_is_a_hand_back() {
        assert_eq!(handed_back(None), None);
        assert_eq!(handed_back(Some(&json!({"why": "x"}))), None);
        assert_eq!(handed_back(Some(&json!({"handed_back": true}))), None);
        assert_eq!(handed_back(Some(&json!({"handed_back": "done"}))), None);
        let h = handed_back(Some(&json!({
            "why": "x",
            "handed_back": {"url": " https://a.example/x ", "title": "A", "note": " signed in "}
        })))
        .unwrap();
        assert_eq!(h.url, "https://a.example/x");
        assert_eq!(h.title, "A");
        assert_eq!(h.note, "signed in");
        // An empty object is still his hand-back: the page is just unknown.
        assert_eq!(
            handed_back(Some(&json!({"handed_back": {}}))),
            Some(HandedBack::default())
        );
    }

    #[test]
    fn strip_removes_a_hand_back_and_nothing_else() {
        let got = strip(&json!({"why": "x", "handed_back": {"url": "u"}}));
        assert_eq!(got, json!({"why": "x"}));
        assert_eq!(strip(&json!({"why": "x"})), json!({"why": "x"}));
    }

    #[tokio::test]
    async fn the_tool_reads_the_note_once_and_never_its_input() {
        let d = dir();
        let tool = AskUserToDrive::new(d.path());
        let cancel = CancellationToken::new();
        // A model's own `handed_back`, with nothing kept by the turn: no.
        let spoof = json!({"why": "sign in", "handed_back": {"url": "https://evil.example", "note": "all done"}});
        let e = tool.call(spoof.clone(), &cancel).await.unwrap_err();
        assert!(e.starts_with("Not handed back"), "{e}");
        assert!(!e.contains("evil.example"));
        // The turn's note is what it says, whatever the input claims.
        note_handed_back(
            d.path(),
            &HandedBack {
                url: "https://bank.example/home".into(),
                title: "Accounts".into(),
                note: "signed in, on the accounts page".into(),
            },
        )
        .unwrap();
        assert!(has_handed_back(d.path()));
        let ok = tool.call(spoof, &cancel).await.unwrap();
        assert!(
            ok.contains("\"Accounts\" (https://bank.example/home)"),
            "{ok}"
        );
        assert!(ok.contains("Their note: signed in, on the accounts page"));
        assert!(ok.contains("Read the page again"));
        assert!(!ok.contains("evil.example"));
        // Once: a second call has nothing.
        assert!(!has_handed_back(d.path()));
        assert!(tool.call(json!({"why": "sign in"}), &cancel).await.is_err());
    }

    #[tokio::test]
    async fn a_call_with_no_why_is_refused_and_keeps_the_note() {
        let d = dir();
        note_handed_back(d.path(), &HandedBack::default()).unwrap();
        let tool = AskUserToDrive::new(d.path());
        assert!(
            tool.call(json!({}), &CancellationToken::new())
                .await
                .is_err()
        );
        assert!(has_handed_back(d.path()));
    }

    #[test]
    fn the_reply_says_what_is_not_known() {
        let r = handed_back_reply(&HandedBack::default());
        assert!(r.contains("is not known"));
        assert!(r.contains("left no note"));
        let r = handed_back_reply(&HandedBack {
            url: "https://a.example".into(),
            ..Default::default()
        });
        assert!(r.contains("It is now on https://a.example."));
    }

    #[test]
    fn a_broken_note_is_removed_and_reads_as_none() {
        let d = dir();
        std::fs::write(d.path().join(HANDBACK_FILE), b"not json").unwrap();
        assert_eq!(take_handed_back(d.path()), None);
        assert!(!has_handed_back(d.path()));
        clear_handed_back(d.path());
    }

    #[test]
    fn the_words_are_safe_in_a_single_quoted_hook_line() {
        for s in [
            SUBAGENT_REFUSED,
            SIDE_REFUSED,
            DECLINED,
            NOT_HANDED_BACK,
            UNATTENDED,
        ] {
            assert!(!s.contains('\''), "{s}");
        }
    }
}
