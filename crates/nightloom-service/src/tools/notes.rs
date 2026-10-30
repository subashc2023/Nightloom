//! Organising the knowledge base (nightshift item 472; his words for item
//! 457: "could i ask claude to organize the notes that i'm adding in if
//! im' adding like a shit ton of files").
//!
//! Three tools over the vault, on both engines — `list_notes`,
//! `make_note_folder` and `move_notes` — so a chat can sort a heap of notes
//! into folders the way the Notes panel does it by hand (item 457), through
//! the very functions the panel calls (`project::list_note_tree`,
//! `make_note_folder`, `move_note`). Before them a chat on the Claude Code
//! engine could only move a note with a shell `mv`, and one on the API
//! engine not at all (its file tools write and edit; nothing moves).
//!
//! **Bounded to the notes root.** Every name is relative to the vault and
//! is resolved by `project`'s own `note_path` (`Root`): `..`, an absolute
//! path or a symlink out of the vault is refused. A hidden name — the
//! trash, `.obsidian` — is refused as a source and as a target, so a chat
//! never empties the trash back into the vault or files a note where the
//! panel cannot show it.
//!
//! **A move never writes over a note.** `move_note` refuses a taken target
//! on its own; `move_notes` checks the whole batch first — every source
//! there, every target free, no two moves to one name — and moves nothing
//! when any of it fails, so a model's sort of fifty notes does not stop
//! half done on the thirty-first. One call per batch also means one
//! approval on the API engine, not fifty.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use nightloom_core::ToolDef;
use nightloom_core::tool::{CancellationToken, Effect, Tool};
use serde_json::{Value, json};

use super::{VAULT_ALIAS, blocking};
use crate::project;

pub const LIST_NAME: &str = "list_notes";
pub const FOLDER_NAME: &str = "make_note_folder";
pub const MOVE_NAME: &str = "move_notes";

/// Most notes `list_notes` prints in one answer; past it, the folder
/// counts and a `folder` to list next.
pub const LIST_LIMIT: usize = 2000;
/// Most moves one `move_notes` call takes.
pub const MOVE_LIMIT: usize = 500;

/// The three tools for the vault at `dir`.
pub fn note_tools(dir: PathBuf) -> Vec<Box<dyn Tool>> {
    vec![
        Box::new(ListNotes { dir: dir.clone() }),
        Box::new(MakeNoteFolder { dir: dir.clone() }),
        Box::new(MoveNotes { dir }),
    ]
}

/// The prompt sentence that says the tools are there, with the names the
/// model calls them by (`mcp__nightloom__move_notes` on the Claude Code
/// engine, `move_notes` on the API engine).
pub fn prompt_sentence(name: impl Fn(&str) -> String) -> String {
    format!(
        "To organise the user's knowledge base — sort notes into folders, rename or regroup \
         them — use {list} to see every note and folder, {folder} to make a folder, and \
         {moves} to move or rename notes and folders, many in one call. Names are relative \
         to the knowledge base (people/alice.md, with or without the {VAULT_ALIAS}/ prefix); \
         a move never writes over a note, and a batch with any problem moves nothing. Use \
         these rather than a shell mv, and say what you moved.",
        list = name(LIST_NAME),
        folder = name(FOLDER_NAME),
        moves = name(MOVE_NAME),
    )
}

/// A name as the model may give it — `@kb/people/a.md`, `people/a.md`, or
/// the vault's own absolute path (the Claude Code engine's preamble names
/// it) — as a name relative to the vault. Anything else absolute is left
/// as it is, for `note_path` to refuse.
fn vault_name(dir: &Path, raw: &str) -> String {
    let t = raw.trim();
    let t = t
        .strip_prefix(VAULT_ALIAS)
        .map_or(t, |rest| rest.trim_start_matches('/'));
    let root = dir.to_string_lossy();
    let t = t
        .strip_prefix(root.as_ref())
        .filter(|rest| rest.is_empty() || rest.starts_with('/'))
        .map_or(t, |rest| rest.trim_start_matches('/'));
    t.trim_start_matches("./").to_string()
}

fn hidden(name: &str) -> bool {
    name.split(['/', '\\'])
        .any(|p| p.starts_with('.') && p != "." && p != "..")
}

pub struct ListNotes {
    dir: PathBuf,
}

#[async_trait::async_trait]
impl Tool for ListNotes {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: LIST_NAME.into(),
            description: "List the user's knowledge base: every folder (empty ones too) and every \
                 note, with its size, as the Notes panel shows it. Optionally only what is under \
                 one folder. Read this before sorting notes into folders."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "folder": {
                        "type": "string",
                        "description": "Only list under this folder, e.g. people. Omit for all."
                    }
                }
            }),
        }
    }

    fn effect(&self) -> Effect {
        Effect::ReadOnly
    }

    async fn call(&self, input: Value, _cancel: &CancellationToken) -> Result<String, String> {
        let dir = self.dir.clone();
        let folder = input["folder"]
            .as_str()
            .map(|f| vault_name(&dir, f))
            .unwrap_or_default();
        let folder = folder.trim_end_matches('/').to_string();
        blocking(move || Ok(list(&dir, &folder))).await
    }
}

/// The listing's text: folders, then notes, under `folder` ("" for all).
pub fn list(dir: &Path, folder: &str) -> String {
    let tree = project::list_note_tree(dir);
    let under = |n: &str| folder.is_empty() || n.starts_with(&format!("{folder}/"));
    let folders: Vec<&String> = tree.folders.iter().filter(|f| under(f)).collect();
    let notes: Vec<&project::Note> = tree.notes.iter().filter(|n| under(&n.name)).collect();
    let mut out = String::new();
    let place = if folder.is_empty() {
        "the knowledge base".to_string()
    } else {
        format!("{folder}/")
    };
    out.push_str(&format!(
        "{} folders and {} notes in {place}.\n",
        folders.len(),
        notes.len()
    ));
    if !folders.is_empty() {
        out.push_str("\nFolders:\n");
        for f in &folders {
            out.push_str(&format!("{f}/\n"));
        }
    }
    if !notes.is_empty() {
        out.push_str("\nNotes:\n");
        for n in notes.iter().take(LIST_LIMIT) {
            out.push_str(&format!("{} ({} bytes)\n", n.name, n.bytes));
        }
        if notes.len() > LIST_LIMIT {
            out.push_str(&format!(
                "… and {} more; list one folder at a time with folder.\n",
                notes.len() - LIST_LIMIT
            ));
        }
    }
    if !tree.complete {
        out.push_str("\nThe listing stopped at its bound; some notes are not shown.\n");
    }
    out
}

pub struct MakeNoteFolder {
    dir: PathBuf,
}

#[async_trait::async_trait]
impl Tool for MakeNoteFolder {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: FOLDER_NAME.into(),
            description: "Make a folder in the user's knowledge base (and any folders above it). \
                 An existing folder is fine. move_notes makes a target's folders on its own, so \
                 this is for a folder that should exist before anything is in it."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "The folder, relative to the knowledge base, e.g. projects/2026."
                    }
                },
                "required": ["name"]
            }),
        }
    }

    fn effect(&self) -> Effect {
        Effect::Mutating
    }

    async fn call(&self, input: Value, _cancel: &CancellationToken) -> Result<String, String> {
        let dir = self.dir.clone();
        let name = input["name"]
            .as_str()
            .map(|n| vault_name(&dir, n))
            .ok_or_else(|| format!("{FOLDER_NAME} needs name"))?;
        blocking(move || {
            if hidden(&name) {
                return Err(format!(
                    "{name} is a hidden name — the Notes panel would not show it"
                ));
            }
            project::make_note_folder(&dir, &name).map(|made| format!("made {made}/"))
        })
        .await
    }
}

pub struct MoveNotes {
    dir: PathBuf,
}

#[async_trait::async_trait]
impl Tool for MoveNotes {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: MOVE_NAME.into(),
            description:
                "Move or rename notes or folders in the user's knowledge base, many in one \
                 call: each move is a from and a to, both relative to the knowledge base. A to \
                 ending in / is a folder: the note keeps its name inside it (people/ puts \
                 alice.md at people/alice.md). Folders on the way are made. Never writes over a \
                 note: if any source is missing, any target is taken, or two moves share a \
                 target, nothing moves and the problems are listed — fix them and call again."
                    .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "moves": {
                        "type": "array",
                        "description": "The moves, done in order.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "from": { "type": "string", "description": "A note or folder, e.g. alice.md." },
                                "to": { "type": "string", "description": "Its new path, e.g. people/alice.md, or a folder ending in /." }
                            },
                            "required": ["from", "to"]
                        }
                    }
                },
                "required": ["moves"]
            }),
        }
    }

    fn effect(&self) -> Effect {
        Effect::Mutating
    }

    async fn call(&self, input: Value, _cancel: &CancellationToken) -> Result<String, String> {
        let dir = self.dir.clone();
        let moves: Vec<(String, String)> = input["moves"]
            .as_array()
            .ok_or_else(|| format!("{MOVE_NAME} needs moves, a list of {{from, to}}"))?
            .iter()
            .map(|m| {
                let from = m["from"].as_str().map(|f| vault_name(&dir, f));
                let to = m["to"].as_str().map(|t| vault_name(&dir, t));
                from.zip(to)
                    .ok_or_else(|| "each move needs a from and a to".to_string())
            })
            .collect::<Result<_, _>>()?;
        blocking(move || move_notes(&dir, &moves)).await
    }
}

/// Check a batch whole, then move it (see the module note). The answer
/// lists each move done; an error lists every problem and moved nothing.
pub fn move_notes(dir: &Path, moves: &[(String, String)]) -> Result<String, String> {
    if moves.is_empty() {
        return Err("no moves given".to_string());
    }
    if moves.len() > MOVE_LIMIT {
        return Err(format!(
            "{} moves in one call; at most {MOVE_LIMIT} — split them",
            moves.len()
        ));
    }
    let mut planned: Vec<(String, String)> = Vec::with_capacity(moves.len());
    let mut problems = Vec::new();
    let mut targets: HashSet<String> = HashSet::new();
    let mut sources: HashSet<String> = HashSet::new();
    for (from, to) in moves {
        let from = from.trim_end_matches('/').to_string();
        let to = match to.strip_suffix('/') {
            // A folder: the source keeps its own name inside it.
            Some(folder) => {
                let base = from.rsplit('/').next().unwrap_or(&from);
                if folder.is_empty() {
                    base.to_string()
                } else {
                    format!("{folder}/{base}")
                }
            }
            None => to.clone(),
        };
        if from.is_empty() || to.is_empty() {
            problems.push("a move with an empty from or to".to_string());
            continue;
        }
        if hidden(&from) || hidden(&to) {
            problems.push(format!(
                "{from} → {to}: a hidden name (the trash, a dot-folder) is not moved from or to"
            ));
            continue;
        }
        let (src, dst) = match (project::note_file(dir, &from), project::note_file(dir, &to)) {
            (Ok(s), Ok(d)) => (s, d),
            (Err(e), _) | (_, Err(e)) => {
                problems.push(format!("{from} → {to}: {e}"));
                continue;
            }
        };
        // Earlier moves in the batch change what is there: a source an
        // earlier move takes away, or a target an earlier one fills.
        let moved_away = sources
            .iter()
            .any(|s| from == *s || from.starts_with(&format!("{s}/")));
        if !src.exists() || moved_away {
            problems.push(format!("{from}: there is no such note or folder"));
        }
        if from == to {
            continue;
        }
        if dst.exists() || !targets.insert(to.clone()) {
            problems.push(format!("{to} is taken — a move never writes over a note"));
        }
        if to.starts_with(&format!("{from}/")) {
            problems.push(format!("cannot move {from} into itself"));
        }
        sources.insert(from.clone());
        planned.push((from, to));
    }
    if !problems.is_empty() {
        return Err(format!(
            "nothing was moved:\n{}",
            problems
                .iter()
                .map(|p| format!("- {p}"))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    let mut done = Vec::with_capacity(planned.len());
    for (from, to) in &planned {
        match project::move_note(dir, from, to) {
            Ok(landed) => done.push(format!("{from} → {landed}")),
            Err(e) => {
                return Err(format!(
                    "stopped at {from}: {e}\nmoved before it:\n{}",
                    if done.is_empty() {
                        "(none)".to_string()
                    } else {
                        done.join("\n")
                    }
                ));
            }
        }
    }
    Ok(format!("moved {}:\n{}", done.len(), done.join("\n")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static N: AtomicUsize = AtomicUsize::new(0);

    /// A fixture vault in the temp folder — never the user's.
    fn vault(names: &[&str]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nightloom-notes-tools-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        for n in names {
            let p = dir.join(n);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, format!("# {n}\n")).unwrap();
        }
        dir
    }

    fn call(tool: &dyn Tool, input: Value) -> Result<String, String> {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(tool.call(input, &CancellationToken::new()))
    }

    /// The harness item 472 asks for: a scripted tool run — what a model
    /// would send — that sorts ten fixture notes into three folders, read
    /// back from disk.
    #[test]
    fn a_scripted_run_sorts_ten_notes_into_three_folders() {
        let names = [
            "alice.md",
            "bob.md",
            "carol.md",
            "rust-traits.md",
            "tokio.md",
            "serde.md",
            "trip-japan.md",
            "trip-peru.md",
            "trip-iceland.md",
            "todo.md",
        ];
        let dir = vault(&names);
        let tools = note_tools(dir.clone());
        let (list_t, folder_t, move_t) = (&*tools[0], &*tools[1], &*tools[2]);

        let before = call(list_t, json!({})).unwrap();
        assert!(before.starts_with("0 folders and 10 notes"), "{before}");

        assert_eq!(
            call(folder_t, json!({"name": "people"})).unwrap(),
            "made people/"
        );
        let moved = call(
            move_t,
            json!({"moves": [
                {"from": "alice.md", "to": "people/"},
                {"from": "@kb/bob.md", "to": "people/bob.md"},
                {"from": "carol.md", "to": "@kb/people/"},
                {"from": "rust-traits.md", "to": "code/rust/traits.md"},
                {"from": "tokio.md", "to": "code/rust/"},
                {"from": "serde.md", "to": "code/rust/"},
                {"from": "trip-japan.md", "to": "travel/japan.md"},
                {"from": "trip-peru.md", "to": "travel/peru.md"},
                {"from": "trip-iceland.md", "to": "travel/iceland.md"}
            ]}),
        )
        .unwrap();
        assert!(moved.starts_with("moved 9:"), "{moved}");

        let tree = project::list_note_tree(&dir);
        let mut got: Vec<&str> = tree.notes.iter().map(|n| n.name.as_str()).collect();
        got.sort();
        assert_eq!(
            got,
            [
                "code/rust/serde.md",
                "code/rust/tokio.md",
                "code/rust/traits.md",
                "people/alice.md",
                "people/bob.md",
                "people/carol.md",
                "todo.md",
                "travel/iceland.md",
                "travel/japan.md",
                "travel/peru.md",
            ]
        );
        let after = call(list_t, json!({"folder": "people"})).unwrap();
        assert!(
            after.starts_with("0 folders and 3 notes in people/"),
            "{after}"
        );
        // The text came along untouched.
        assert_eq!(
            fs::read_to_string(dir.join("travel/peru.md")).unwrap(),
            "# trip-peru.md\n"
        );
    }

    /// The vault's absolute spelling (the Claude Code preamble names it)
    /// is the same note.
    #[test]
    fn the_vaults_absolute_path_names_the_same_note() {
        let dir = vault(&["todo.md"]);
        let abs = format!("{}/todo.md", dir.display());
        let r = call(
            &MoveNotes { dir: dir.clone() },
            json!({"moves": [{"from": abs, "to": "inbox/"}]}),
        )
        .unwrap();
        assert_eq!(r, "moved 1:\ntodo.md → inbox/todo.md");
    }

    #[test]
    fn a_batch_with_any_problem_moves_nothing() {
        let dir = vault(&["a.md", "b.md", "people/a.md"]);
        let err = move_notes(
            &dir,
            &[
                ("b.md".into(), "people/b.md".into()),
                ("a.md".into(), "people/".into()),
                ("gone.md".into(), "x.md".into()),
            ],
        )
        .unwrap_err();
        assert!(err.starts_with("nothing was moved"), "{err}");
        assert!(err.contains("people/a.md is taken"), "{err}");
        assert!(err.contains("gone.md: there is no such note"), "{err}");
        assert!(
            dir.join("b.md").exists(),
            "the good move did not run either"
        );
        assert_eq!(
            fs::read_to_string(dir.join("people/a.md")).unwrap(),
            "# people/a.md\n"
        );
    }

    #[test]
    fn two_moves_to_one_name_are_refused() {
        let dir = vault(&["a.md", "x/a.md"]);
        let err = move_notes(
            &dir,
            &[("a.md".into(), "y/".into()), ("x/a.md".into(), "y/".into())],
        )
        .unwrap_err();
        assert!(err.contains("y/a.md is taken"), "{err}");
        assert!(dir.join("a.md").exists() && dir.join("x/a.md").exists());
    }

    #[test]
    fn paths_out_of_the_vault_and_hidden_names_are_refused() {
        let dir = vault(&["a.md", ".trash/notes/old.md"]);
        let outside = dir.with_file_name(format!(
            "{}-outside.md",
            dir.file_name().unwrap().to_string_lossy()
        ));
        for (from, to) in [
            ("a.md", "../outside.md"),
            ("../../etc/hosts", "hosts.md"),
            ("a.md", "/tmp/a.md"),
            (".trash/notes/old.md", "old.md"),
            ("a.md", ".hidden/a.md"),
        ] {
            let r = move_notes(&dir, &[(from.into(), to.into())]);
            assert!(r.is_err(), "{from} → {to} should be refused: {r:?}");
        }
        assert!(dir.join("a.md").exists());
        assert!(!outside.exists());
        assert!(
            call(
                &MakeNoteFolder { dir: dir.clone() },
                json!({"name": "../up"})
            )
            .is_err()
        );
        assert!(
            call(
                &MakeNoteFolder { dir: dir.clone() },
                json!({"name": ".obsidian"})
            )
            .is_err()
        );
    }

    #[test]
    fn a_folder_moves_whole_and_not_into_itself() {
        let dir = vault(&["people/a.md", "people/eng/b.md"]);
        assert!(move_notes(&dir, &[("people".into(), "people/sub".into())]).is_err());
        move_notes(&dir, &[("people".into(), "crm".into())]).unwrap();
        assert!(dir.join("crm/eng/b.md").exists());
        assert!(!dir.join("people").exists());
    }

    #[test]
    fn a_source_an_earlier_move_took_is_a_problem() {
        let dir = vault(&["a.md"]);
        let err = move_notes(
            &dir,
            &[
                ("a.md".into(), "b.md".into()),
                ("a.md".into(), "c.md".into()),
            ],
        )
        .unwrap_err();
        assert!(err.contains("a.md: there is no such note"), "{err}");
        assert!(dir.join("a.md").exists());
    }

    #[test]
    fn effects_are_read_only_for_the_list_and_mutating_for_the_writers() {
        let tools = note_tools(vault(&[]));
        let effects: Vec<(String, Effect)> =
            tools.iter().map(|t| (t.def().name, t.effect())).collect();
        assert_eq!(
            effects,
            [
                (LIST_NAME.to_string(), Effect::ReadOnly),
                (FOLDER_NAME.to_string(), Effect::Mutating),
                (MOVE_NAME.to_string(), Effect::Mutating),
            ]
        );
    }
}
