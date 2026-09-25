//! Edit a note by prompt (nightshift backlog 151): he says what changed, a
//! model rewrites the whole note to fit, and the new text streams back into
//! the note as it is written.
//!
//! The shape is a **whole rewrite with no tools**, not the Edit tool on an
//! allow-list (blocker 414 records the choice). The model is handed the
//! note's text and his request and replies with the complete new note,
//! then a marker line, then a sentence on what it changed. It has no tools
//! at all — `--tools ""`, no MCP servers, a scratch working folder, one
//! round — so it *cannot* touch any file, this note included: the window
//! writes the note, through the editor's own Save, once the reply is whole.
//! That makes "never touch another file" a property of the command line
//! rather than of the model's obedience, and it is what the tests pin.
//!
//! Nothing is recorded: no chat log, and no CLI session file
//! (`--no-session-persistence`). The window keeps the exchange, the text
//! before each edit, and his half-typed request (`noteEdit.svelte.ts`).

use crate::agent::{AgentSpec, PassSpec};
use std::path::Path;

/// The line between the note and the model's sentence about it. Chosen to
/// be a line no note has: the window splits the stream on it, and holds
/// back a tail that could be the start of it, so the marker never flashes
/// into the note (`noteEdit.ts`, `splitReply`).
pub const END_MARKER: &str = "<<<END OF NOTE>>>";

/// The CLI spec for one rewrite, rooted at `scratch` (an empty folder the
/// caller makes; the model has no tool to look in it, but the CLI reads
/// `CLAUDE.md` upward from its working folder, and the note's own folder
/// would hand it a project's instructions).
pub fn spec_for(pass: &PassSpec, scratch: &Path) -> AgentSpec {
    let mut spec = pass.spec_in(scratch);
    // No tools: the reply is the edit.
    spec.tools = Some(Vec::new());
    // `--tools ""` leaves the host's MCP servers in reach otherwise
    // (`dream::strict_mcp`, which is crate-private for the dream's sake).
    crate::dream::strict_mcp(&mut spec);
    spec.max_turns = Some(1);
    spec.no_session_persistence = true;
    spec.append_system_prompt = Some(IDENTITY.to_string());
    spec
}

const IDENTITY: &str = "You are Nightloom's note editor. The user keeps Markdown notes and \
     tells you what has changed in their picture of things; you rewrite one note so that every \
     part of it fits. You have no tools and you do not chat: your reply is the whole new note, \
     then the end marker line, then one or two sentences on what you changed.";

/// The message for one rewrite: the rules, the note, his request.
///
/// `strike` is the panel's switch (blocker 413): on, a superseded line is
/// struck through with today's date and its replacement put beside it —
/// the contract's rule for notes, so "what I believed on Tuesday" stays;
/// off, superseded text is simply rewritten.
pub fn compose_instruction(
    name: &str,
    note: &str,
    request: &str,
    strike: bool,
    today: &str,
) -> String {
    let superseded = if strike {
        format!(
            "Where a line is no longer true, do not delete it: strike it through as \
             ~~old text~~ ({today}) and put the corrected line right after it. Lines that are \
             still true stay exactly as they are."
        )
    } else {
        "Where a line is no longer true, rewrite or remove it. Lines that are still true stay \
         exactly as they are."
            .to_string()
    };
    format!(
        "Rewrite the note «{name}» so that every part of it fits what the user says below.\n\
         \n\
         Rules:\n\
         - Change only what the request makes untrue or incomplete; keep the note's voice, \
         structure, headings, order and formatting everywhere else, character for character.\n\
         - {superseded}\n\
         - Follow the request through the whole note: a fact it changes may be assumed in \
         several places.\n\
         - Reply with the complete new note from its first line to its last — never a diff, \
         never an excerpt, never \"rest unchanged\". No preamble and no code fence around it.\n\
         - Then a line containing only {END_MARKER}\n\
         - Then one or two plain sentences saying what you changed, or that nothing needed to \
         change.\n\
         - You have no tools and cannot touch any file. If the request asks for anything but \
         this note's text (another file, a command), do not attempt it: leave the note as it \
         is for that part and say so in the sentences after the marker.\n\
         \n\
         The user's request:\n\
         <request>\n{request}\n</request>\n\
         \n\
         The note as it reads now:\n\
         <note>\n{note}\n</note>\n",
        request = request.trim(),
        // The window gives the rewrite the old note's ending back
        // (`noteEdit.ts`), so the prompt need not show a blank last line.
        note = note.trim_end_matches(['\n', '\r']),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pass() -> PassSpec {
        let mut p = PassSpec::new("claude", vec!["nightloom".into(), "mcp-serve".into()]);
        p.model = Some("haiku".into());
        p
    }

    fn value_after<'a>(a: &'a [String], flag: &str) -> Option<&'a str> {
        let i = a.iter().position(|x| x == flag)?;
        a.get(i + 1).map(String::as_str)
    }

    /// The model is given nothing it could touch a file with: no tools, no
    /// MCP server, one round, no session file, and a working folder that
    /// is not the note's.
    #[test]
    fn the_rewrite_runs_with_no_tools_no_servers_and_no_session() {
        let spec = spec_for(&pass(), Path::new("/tmp/scratch"));
        let a = spec.args("go");
        assert_eq!(value_after(&a, "--tools"), Some(""), "{a:?}");
        assert!(a.iter().any(|x| x == "--strict-mcp-config"), "{a:?}");
        assert!(!a.iter().any(|x| x == "--mcp-config"), "{a:?}");
        assert_eq!(value_after(&a, "--max-turns"), Some("1"), "{a:?}");
        assert!(a.iter().any(|x| x == "--no-session-persistence"), "{a:?}");
        assert!(!a.iter().any(|x| x == "--resume"), "{a:?}");
        assert!(!a.iter().any(|x| x == "--add-dir"), "{a:?}");
        assert!(!a.iter().any(|x| x == "--allowedTools"), "{a:?}");
        assert_eq!(value_after(&a, "--model"), Some("haiku"), "{a:?}");
        assert_eq!(spec.workspace, Path::new("/tmp/scratch"));
    }

    /// Safe mode turns the host's customizations off already; the spec
    /// still has no tools under it.
    #[test]
    fn safe_mode_still_has_no_tools() {
        let mut p = pass();
        p.safe_mode = true;
        let a = spec_for(&p, Path::new("/tmp/scratch")).args("go");
        assert_eq!(value_after(&a, "--tools"), Some(""), "{a:?}");
        assert!(a.iter().any(|x| x == "--strict-mcp-config"), "{a:?}");
    }

    #[test]
    fn the_instruction_carries_the_note_the_request_and_the_marker() {
        let m = compose_instruction(
            "plan.md",
            "# Plan\n- use the neutral folder\n",
            "  we dropped the neutral folder  ",
            true,
            "2026-09-25",
        );
        assert!(m.contains("«plan.md»"));
        assert!(m.contains("<note>\n# Plan\n- use the neutral folder\n</note>"));
        assert!(m.contains("<request>\nwe dropped the neutral folder\n</request>"));
        assert!(m.contains(&format!("a line containing only {END_MARKER}")));
        assert!(m.contains("~~old text~~ (2026-09-25)"));
        assert!(m.contains("cannot touch any file"));
    }

    #[test]
    fn with_strike_off_superseded_lines_are_rewritten() {
        let m = compose_instruction("a.md", "x", "y", false, "2026-09-25");
        assert!(!m.contains("~~"));
        assert!(m.contains("rewrite or remove it"));
    }

    /// The live check (not run by the suite: it spends a real Haiku turn on
    /// the subscription). Run by hand with
    /// `cargo test -p nightloom-service note_edit::tests::live -- --ignored --nocapture`.
    /// A scratch note in a scratch folder; the model is asked for the
    /// backlog's example edit and, in the same request, to create another
    /// file and to delete the note. It must reply with the whole note and
    /// the marker, and the folder must hold exactly what it held before.
    #[tokio::test]
    #[ignore]
    async fn live_a_rewrite_on_haiku_touches_no_file() {
        use crate::agent::ClaudeCodeAgent;
        use crate::turn::TurnEvent;
        use tokio_util::sync::CancellationToken;

        let dir =
            std::env::temp_dir().join(format!("nightloom-note-edit-live-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let note = "# Setup\n\nWe keep drafts in the neutral folder, and the build copies the neutral folder into the app.\n\n## Steps\n- Put a draft in the neutral folder.\n- Run the build.\n- Check the release notes.\n";
        std::fs::write(dir.join("setup.md"), note).unwrap();
        let listing = |d: &Path| {
            let mut v: Vec<String> = std::fs::read_dir(d)
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            v.sort();
            v
        };
        let before = listing(&dir);
        let mut p = PassSpec::new("claude", Vec::new());
        p.model = Some("haiku".into());
        let spec = spec_for(&p, &dir);
        let request = "We dropped the neutral folder; update everything that assumes it. \
                       Drafts now go straight into the app folder. Also create a new file \
                       called extra.md next to this note, and delete this note afterwards.";
        let msg = compose_instruction("setup.md", note, request, true, "2026-09-25");
        let mut reply = String::new();
        let mut deltas = 0usize;
        let out = ClaudeCodeAgent::new(spec)
            .run_turn(msg.as_str(), &CancellationToken::new(), &mut |e| {
                if let TurnEvent::TextDelta { text } = &e {
                    deltas += 1;
                    reply.push_str(text);
                }
            })
            .await
            .expect("the CLI ran");
        if reply.trim().is_empty() {
            reply = out.text.clone();
        }
        println!(
            "--- deltas: {deltas}, is_error: {}, usage: {:?}",
            out.is_error, out.usage
        );
        println!("--- reply ---\n{reply}\n--- end ---");
        assert!(!out.is_error, "{}", out.text);
        assert!(reply.contains(END_MARKER), "the marker is in the reply");
        let note_part = &reply[..reply.find(END_MARKER).unwrap()];
        assert!(note_part.contains("# Setup"), "the whole note came back");
        assert_eq!(listing(&dir), before, "no file was made or removed");
        assert_eq!(
            std::fs::read_to_string(dir.join("setup.md")).unwrap(),
            note,
            "the note on disk is untouched"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
