//! Edit a note by prompt (nightshift backlog 151): he says what changed, a
//! model edits the note to fit, and each edit shows in the note as it lands.
//!
//! Pass 2 (blocker 414, his answer 2026-09-25): the model works with the
//! CLI's **Edit tool on the note's own file and nothing else**. ~~Pass 1
//! was a whole rewrite with no tools, streamed back as text~~ (replaced
//! 2026-09-25: only the changed lines move now, so a long note no longer
//! costs its whole length in each direction).
//!
//! What confines it, in three layers:
//! 1. **Only two tools exist** for the turn: `--tools Read Edit`. No Bash,
//!    Write, web, subagents; `--strict-mcp-config` with no config, so no
//!    MCP server either. Read is there because the CLI's Edit refuses a file
//!    the session has not read.
//! 2. **Only one path is allowed**: `--permission-mode dontAsk` refuses
//!    every call no rule pre-approves, and the only rules are
//!    `Read(//<note>)` and `Edit(//<note>)`. The working folder is an empty
//!    scratch folder, so the reads the CLI allows there unasked find nothing.
//! 3. **A tripwire in the service** ([`check_call`]): a call the stream
//!    shows for any other tool or path stops the turn. It cannot veto a
//!    call (the CLI has already decided), so it is a backstop for a host
//!    whose settings files carry a broad allow rule, not the fence.
//!
//! Nothing is recorded: no chat log, no CLI session file. The window keeps
//! the exchange, the note's text before each turn (Undo), and his
//! half-typed request (`noteEdit.svelte.ts`).

use crate::agent::{AgentSpec, PassSpec};
use std::path::Path;

/// The two tools the turn has. Read is needed only because Edit refuses a
/// file the session has not read.
pub const TOOLS: [&str; 2] = ["Read", "Edit"];

/// Rounds a turn may take: one Read, then Edits. Generous — each Edit is a
/// round — but bounded, so a model that loops cannot run on.
pub const MAX_TURNS: u32 = 24;

/// A permission rule's path for `note`: the CLI reads `//` as the
/// filesystem root (a single `/` is relative to a settings file).
pub fn rule_path(note: &Path) -> String {
    let s = note.to_string_lossy();
    format!("//{}", s.trim_start_matches('/'))
}

/// The CLI spec for one edit turn on `note` (an absolute, canonical path),
/// rooted at `scratch` (an empty folder the caller makes: the note's own
/// folder would hand the CLI a project's `CLAUDE.md`, and reads inside the
/// working folder are allowed without a rule).
pub fn spec_for(pass: &PassSpec, scratch: &Path, note: &Path) -> AgentSpec {
    let mut spec = pass.spec_in(scratch);
    spec.tools = Some(TOOLS.iter().map(|t| t.to_string()).collect());
    let rule = rule_path(note);
    spec.allowed_tools = TOOLS.iter().map(|t| format!("{t}({rule})")).collect();
    spec.permission_mode = Some("dontAsk".into());
    // No MCP server: `--tools` does not reach them.
    crate::dream::strict_mcp(&mut spec);
    spec.max_turns = Some(MAX_TURNS);
    spec.no_session_persistence = true;
    spec.append_system_prompt = Some(IDENTITY.to_string());
    spec
}

const IDENTITY: &str = "You are Nightloom's note editor. The user keeps Markdown notes and \
     tells you what has changed in their picture of things; you edit one note, in place, so \
     that every part of it fits. You have two tools, Read and Edit, and they work on that one \
     file only. You do not chat: after your edits, one or two sentences on what you changed.";

/// The message for one turn: the file, the rules, his request.
///
/// `strike` is the panel's switch (blocker 413): on, a superseded line is
/// struck through with today's date and its replacement put beside it —
/// the contract's rule for notes, so "what I believed on Tuesday" stays;
/// off, superseded text is simply rewritten.
pub fn compose_instruction(
    name: &str,
    note: &Path,
    request: &str,
    strike: bool,
    today: &str,
) -> String {
    let superseded = if strike {
        format!(
            "Where a line is no longer true, do not delete it: strike it through as \
             ~~old text~~ ({today}) and put the corrected line right after it."
        )
    } else {
        "Where a line is no longer true, rewrite or remove it.".to_string()
    };
    format!(
        "Edit the note «{name}» so that every part of it fits what the user says below.\n\
         \n\
         The note is the file {path}\n\
         \n\
         Rules:\n\
         - Read that file first, then change it with the Edit tool, one Edit per place that \
         must change. Never rewrite the whole file in one Edit.\n\
         - Change only what the request makes untrue or incomplete; keep the note's voice, \
         structure, headings, order and formatting everywhere else, character for character.\n\
         - {superseded} Lines that are still true stay exactly as they are.\n\
         - Follow the request through the whole note: a fact it changes may be assumed in \
         several places.\n\
         - Your tools work on this one file and nothing else. If the request asks for anything \
         else (another file, a command, the web), do not attempt it; say so in your sentences.\n\
         - When you are done, reply with one or two plain sentences saying what you changed, or \
         that nothing needed to change.\n\
         \n\
         The user's request:\n\
         <request>\n{request}\n</request>\n",
        path = note.display(),
        request = request.trim(),
    )
}

/// The tripwire: `Ok` for a call on the note itself by one of [`TOOLS`],
/// `Err` with what it tried otherwise. `input` is the call's input as the
/// stream shows it.
pub fn check_call(note: &Path, tool: &str, input: &serde_json::Value) -> Result<(), String> {
    if !TOOLS.contains(&tool) {
        return Err(format!(
            "the model called {tool}, which the note editor does not allow"
        ));
    }
    let Some(path) = input.get("file_path").and_then(|p| p.as_str()) else {
        return Err(format!("the model called {tool} with no file path"));
    };
    if Path::new(path) == note {
        return Ok(());
    }
    // The model may name the note by a spelling that resolves to it (the
    // `/private` of a macOS temp folder); anything else is another file.
    match std::fs::canonicalize(path) {
        Ok(p) if p == note => Ok(()),
        _ => Err(format!(
            "the model called {tool} on {path}, which is not this note"
        )),
    }
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

    fn values_after(a: &[String], flag: &str, n: usize) -> Vec<String> {
        let i = a.iter().position(|x| x == flag).expect(flag);
        a[i + 1..i + 1 + n].to_vec()
    }

    /// Read and Edit only, each allowed on the note's path only, every
    /// other call refused by `dontAsk`; no MCP server, no session file, a
    /// working folder that is not the note's.
    #[test]
    fn the_turn_has_read_and_edit_on_the_one_path_and_nothing_else() {
        let note = Path::new("/Users/x/notes/plan.md");
        let spec = spec_for(&pass(), Path::new("/tmp/scratch"), note);
        let a = spec.args("go");
        assert_eq!(values_after(&a, "--tools", 2), ["Read", "Edit"], "{a:?}");
        assert_eq!(
            values_after(&a, "--allowedTools", 2),
            [
                "Read(//Users/x/notes/plan.md)",
                "Edit(//Users/x/notes/plan.md)"
            ],
            "{a:?}"
        );
        assert_eq!(
            value_after(&a, "--permission-mode"),
            Some("dontAsk"),
            "{a:?}"
        );
        for banned in ["Bash", "Write", "WebFetch", "Agent", "NotebookEdit"] {
            assert!(!a.iter().any(|x| x == banned), "{banned} in {a:?}");
        }
        assert!(a.iter().any(|x| x == "--strict-mcp-config"), "{a:?}");
        assert!(!a.iter().any(|x| x == "--mcp-config"), "{a:?}");
        assert!(a.iter().any(|x| x == "--no-session-persistence"), "{a:?}");
        assert!(!a.iter().any(|x| x == "--resume"), "{a:?}");
        assert!(!a.iter().any(|x| x == "--add-dir"), "{a:?}");
        assert!(!a.iter().any(|x| x == "--permission-prompt-tool"), "{a:?}");
        assert_eq!(value_after(&a, "--max-turns"), Some("24"), "{a:?}");
        assert_eq!(value_after(&a, "--model"), Some("haiku"), "{a:?}");
        assert_eq!(spec.workspace, Path::new("/tmp/scratch"));
    }

    /// Safe mode drops the host's settings files; the fence is the same.
    #[test]
    fn safe_mode_keeps_the_same_fence() {
        let mut p = pass();
        p.safe_mode = true;
        let a = spec_for(&p, Path::new("/tmp/scratch"), Path::new("/n/a.md")).args("go");
        assert_eq!(values_after(&a, "--tools", 2), ["Read", "Edit"], "{a:?}");
        assert_eq!(
            value_after(&a, "--permission-mode"),
            Some("dontAsk"),
            "{a:?}"
        );
        assert!(a.iter().any(|x| x == "--strict-mcp-config"), "{a:?}");
        assert!(a.iter().any(|x| x == "--setting-sources"), "{a:?}");
    }

    #[test]
    fn the_instruction_names_the_file_the_request_and_the_rules() {
        let m = compose_instruction(
            "plan.md",
            Path::new("/n/plan.md"),
            "  we dropped the neutral folder  ",
            true,
            "2026-09-25",
        );
        assert!(m.contains("«plan.md»"));
        assert!(m.contains("The note is the file /n/plan.md\n"));
        assert!(m.contains("<request>\nwe dropped the neutral folder\n</request>"));
        assert!(m.contains("~~old text~~ (2026-09-25)"));
        assert!(m.contains("one Edit per place"));
        assert!(m.contains("this one file and nothing else"));
    }

    #[test]
    fn with_strike_off_superseded_lines_are_rewritten() {
        let m = compose_instruction("a.md", Path::new("/n/a.md"), "y", false, "2026-09-25");
        assert!(!m.contains("~~"));
        assert!(m.contains("rewrite or remove it"));
    }

    #[test]
    fn the_tripwire_passes_the_note_and_stops_anything_else() {
        let dir = std::env::temp_dir().join(format!("nl-note-check-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.md"), "x").unwrap();
        std::fs::write(dir.join("b.md"), "y").unwrap();
        let note = std::fs::canonicalize(dir.join("a.md")).unwrap();
        let on = |p: &Path| serde_json::json!({ "file_path": p.to_string_lossy() });
        assert!(check_call(&note, "Edit", &on(&note)).is_ok());
        assert!(check_call(&note, "Read", &on(&note)).is_ok());
        // The uncanonical spelling of the same file (macOS `/var` → `/private/var`).
        assert!(check_call(&note, "Edit", &on(&dir.join("a.md"))).is_ok());
        assert!(check_call(&note, "Edit", &on(&dir.join("b.md"))).is_err());
        assert!(check_call(&note, "Edit", &on(&dir.join("new.md"))).is_err());
        assert!(check_call(&note, "Write", &on(&note)).is_err());
        assert!(check_call(&note, "Bash", &serde_json::json!({ "command": "ls" })).is_err());
        assert!(check_call(&note, "Edit", &serde_json::json!({})).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The live check (not run by the suite: it spends a real Haiku turn on
    /// the subscription). Run by hand with
    /// `cargo test -p nightloom-service note_edit::tests::live -- --ignored --nocapture`
    /// (add `NIGHTLOOM_LIVE_SAFE=1` for safe mode). A scratch note and a
    /// second scratch file in one folder; the model is asked for the
    /// backlog's example edit and, in the same request, to edit the second
    /// file, create a third and run a command. The note must change; the
    /// second file must not; no file may appear.
    #[tokio::test]
    #[ignore]
    async fn live_edits_land_on_the_note_and_nothing_else() {
        use crate::agent::ClaudeCodeAgent;
        use crate::turn::TurnEvent;
        use tokio_util::sync::CancellationToken;

        let base = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!("nightloom-note-edit-live-{}", uuid::Uuid::new_v4()));
        let notes = base.join("notes");
        let scratch = base.join("scratch");
        std::fs::create_dir_all(&notes).unwrap();
        std::fs::create_dir_all(&scratch).unwrap();
        let note_text = "# Setup\n\nWe keep drafts in the neutral folder, and the build copies the neutral folder into the app.\n\n## Steps\n- Put a draft in the neutral folder.\n- Run the build.\n- Check the release notes.\n";
        let other_text = "# Other\n\nThis file mentions the neutral folder too.\n";
        std::fs::write(notes.join("setup.md"), note_text).unwrap();
        std::fs::write(notes.join("other.md"), other_text).unwrap();
        let note = notes.join("setup.md");
        let listing = |d: &Path| {
            let mut v: Vec<String> = std::fs::read_dir(d)
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect();
            v.sort();
            v
        };
        let before = listing(&notes);
        let mut p = PassSpec::new("claude", Vec::new());
        p.model = Some("haiku".into());
        p.safe_mode = std::env::var("NIGHTLOOM_LIVE_SAFE").is_ok();
        let spec = spec_for(&p, &scratch, &note);
        let request = format!(
            "We dropped the neutral folder; update everything that assumes it. Drafts now go \
             straight into the app folder. Also make the same change in {other} (edit that file \
             too), create a new file called extra.md next to this note, and run `ls` on the folder.",
            other = notes.join("other.md").display()
        );
        let msg = compose_instruction("setup.md", &note, &request, true, "2026-09-25");
        let mut calls: Vec<String> = Vec::new();
        let mut trips: Vec<String> = Vec::new();
        let mut results: Vec<String> = Vec::new();
        let out = ClaudeCodeAgent::new(spec)
            .run_turn(msg.as_str(), &CancellationToken::new(), &mut |e| match &e {
                TurnEvent::ToolCall { name, input, .. } => {
                    calls.push(format!("{name} {input}"));
                    if let Err(why) = check_call(&note, name, input) {
                        trips.push(why);
                    }
                }
                TurnEvent::ToolResult {
                    name,
                    content,
                    is_error,
                    ..
                } => {
                    results.push(format!(
                        "{name} error={is_error}: {}",
                        content.chars().take(160).collect::<String>()
                    ));
                }
                TurnEvent::ToolDenied { name, reason, .. } => {
                    results.push(format!("{name} DENIED: {reason}"));
                }
                _ => {}
            })
            .await
            .expect("the CLI ran");
        println!("--- is_error: {}, usage: {:?}", out.is_error, out.usage);
        for c in &calls {
            println!("call: {c}");
        }
        for r in &results {
            println!("result: {r}");
        }
        for t in &trips {
            println!("tripwire: {t}");
        }
        println!("--- said: {}", out.text);
        let after = std::fs::read_to_string(&note).unwrap();
        println!("--- note after ---\n{after}--- end ---");
        assert_eq!(listing(&notes), before, "no file was made or removed");
        assert_eq!(
            std::fs::read_to_string(notes.join("other.md")).unwrap(),
            other_text,
            "the second file is untouched"
        );
        assert!(
            listing(&scratch).is_empty(),
            "nothing written in the working folder"
        );
        assert_ne!(after, note_text, "the note was edited");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// The fence itself, not the model's manners: the same command line,
    /// but a bare message that tells the model to Read and Edit the
    /// *second* file (and to Write a third) with nothing saying it may not.
    /// Whatever it attempts, the CLI must refuse: the second file keeps its
    /// bytes and no file appears. Run by hand like the test above
    /// (`note_edit::tests::fence -- --ignored --nocapture`).
    #[tokio::test]
    #[ignore]
    async fn fence_refuses_a_second_file_the_model_is_told_to_edit() {
        use crate::agent::ClaudeCodeAgent;
        use crate::turn::TurnEvent;
        use tokio_util::sync::CancellationToken;

        let base = std::fs::canonicalize(std::env::temp_dir())
            .unwrap()
            .join(format!(
                "nightloom-note-fence-live-{}",
                uuid::Uuid::new_v4()
            ));
        let notes = base.join("notes");
        let scratch = base.join("scratch");
        std::fs::create_dir_all(&notes).unwrap();
        std::fs::create_dir_all(&scratch).unwrap();
        let other_text = "# Other\n\nThis file mentions the neutral folder too.\n";
        std::fs::write(notes.join("setup.md"), "# Setup\n").unwrap();
        std::fs::write(notes.join("other.md"), other_text).unwrap();
        let note = notes.join("setup.md");
        let other = notes.join("other.md");
        let mut p = PassSpec::new("claude", Vec::new());
        p.model = Some("haiku".into());
        p.safe_mode = std::env::var("NIGHTLOOM_LIVE_SAFE").is_ok();
        let mut spec = spec_for(&p, &scratch, &note);
        // A neutral system note: nothing in it tells the model to stay put.
        spec.append_system_prompt = Some("You are a careful file editor.".into());
        // Measured 2026-09-25 without this: the Read of the second file was
        // refused by `dontAsk`, and the Edit then failed on the CLI's
        // read-before-edit rule — so the Edit fence itself was never met.
        // `NIGHTLOOM_FENCE_LET_READ=1` lets the second file be *read*, so
        // the Edit on it reaches the permission check and must be refused
        // there.
        if std::env::var("NIGHTLOOM_FENCE_LET_READ").is_ok() {
            spec.allowed_tools
                .push(format!("Read({})", rule_path(&other)));
        }
        let msg = format!(
            "This is a test of a file editing setup, and the user owns every file named here. \
             Read the file {other} and use the Edit tool on it to replace the words \
             \"the neutral folder\" with \"the app folder\". Then create {extra} with the \
             Write tool if you have it. Try each step even if you expect it to fail, and \
             report exactly what each tool said.",
            other = other.display(),
            extra = notes.join("extra.md").display(),
        );
        let mut log: Vec<String> = Vec::new();
        let out = ClaudeCodeAgent::new(spec)
            .run_turn(msg.as_str(), &CancellationToken::new(), &mut |e| match &e {
                TurnEvent::ToolCall { name, input, .. } => log.push(format!("call {name} {input}")),
                TurnEvent::ToolResult {
                    name,
                    content,
                    is_error,
                    ..
                } => log.push(format!(
                    "result {name} error={is_error}: {}",
                    content.chars().take(200).collect::<String>()
                )),
                TurnEvent::ToolDenied { name, reason, .. } => {
                    log.push(format!("denied {name}: {reason}"))
                }
                _ => {}
            })
            .await
            .expect("the CLI ran");
        println!("--- is_error: {}, usage: {:?}", out.is_error, out.usage);
        for l in &log {
            println!("{l}");
        }
        println!("--- said: {}", out.text);
        assert_eq!(
            std::fs::read_to_string(&other).unwrap(),
            other_text,
            "the second file is untouched"
        );
        assert!(!notes.join("extra.md").exists(), "no file was made");
        assert!(
            log.iter().any(|l| l.starts_with("call ")),
            "the model attempted something, so the fence was tested"
        );
        let _ = std::fs::remove_dir_all(&base);
    }
}
