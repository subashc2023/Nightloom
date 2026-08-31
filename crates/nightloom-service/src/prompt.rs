//! Assembly of the static system prompt.
//!
//! Everything here is deliberately *time-invariant*. The system prompt is the
//! longest stable prefix of every request in a session, so it is the part
//! prompt caching pays for — and a cache entry only hits on an exact byte
//! match. One clock reading, one "files changed since last turn" line, and
//! every turn re-uploads the whole prefix at full price.
//!
//! So this module answers only questions whose answers hold for the life of a
//! `Chat`: who the assistant is, where it is running, what the project and the
//! user told it to always do. Anything that moves — the time, the todo list,
//! git status, recently touched files — belongs in the per-turn sidecar
//! attached to the last user message, not here.
//!
//! `nightloom-core` owns the [`SystemPrompt`] structure; this crate owns the
//! text, because composing it means touching the filesystem and the host
//! environment, which core knows nothing about.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use nightloom_core::{Segment, SegmentKind, SystemPrompt};

/// Built-in behavioural instructions, used unless a shell turns identity off.
///
/// # Telling the model it may issue independent calls together does nothing
///
/// A standing observation about this file is that nothing in it — nor in any
/// of the eleven tool descriptions — tells the model that calls which do not
/// depend on each other can go out in one round, which the engine goes to
/// real trouble to support (`turn.rs`'s `plan_round` / `execute` overlaps
/// adjacent read-only calls). A capability built, tested and unadvertised.
///
/// It was tried, as one sentence here: *"Calls that don't depend on each
/// other should go out together rather than one at a time — there is nothing
/// to wait for."* Worded to describe the situation and avoid the words
/// "parallel" and "batch", which `nightloom-evals`' `THREE_PARALLEL` records
/// as summoning `multi_tool_use.parallel` out of gpt-5-mini at 4x the cost.
///
/// Measured on the full suite, 3 targets x 7 tasks x 3 runs either side
/// (gpt-oss-120b via Groq, gemini-2.5-flash, gpt-5-mini). **The effect was
/// exactly zero.** `Trace::widest_round` stayed at 1.0 on every task but
/// `three-parallel` — across 54 attempts on the other six, not one model
/// grouped a call before the change or after it — and `three-parallel` was
/// already 3.0 on the two models that pass it. Pass rate went 54/63 to
/// 50/63, the whole drop on gpt-oss-120b and inside the noise a sample of
/// three per cell can produce.
///
/// The explanation is in `three-parallel` itself: gpt-oss-120b fails it 0/3
/// *with the task's own instruction asking for one batch*, while gemini and
/// gpt-5-mini pass it 3/3 and group nothing anywhere else. Grouping is a
/// post-training habit that the task instruction can reach and a preamble
/// cannot — so this is not an instruction-following gap with a sentence
/// missing from it, and there is no headroom here to win. Leaving the
/// sentence in would have cost ~32 tokens on every request in every session,
/// forever, for a measured effect of nothing.
///
/// Do not re-add it without a measurement that shows a different answer.
pub const DEFAULT_IDENTITY: &str = "You are Nightloom, a model-agnostic assistant running in a terminal or desktop harness.

Be direct and concrete. Answer what was asked, at the length the question deserves — no preamble, no restating the question back, no summary of what you just said.

When tools are available, use them to check rather than guessing, and say plainly when something is unverified. If a request is ambiguous in a way that changes the answer, ask; otherwise take the sensible reading and proceed.";

/// The instruction file honoured in every directory on the walk, and in the
/// user's config dir.
///
/// One name rather than a house-branded one beside it: `AGENTS.md` is the
/// name other harnesses already read, so a project that has written one gets
/// picked up here without being asked to duplicate it under a second name —
/// the same reasoning that makes `mcp.json` use the `mcpServers` key
/// everybody else uses.
const INSTRUCTION_FILE: &str = "AGENTS.md";

/// Per-file ceiling. A runaway instruction file should cost tokens, not the
/// whole context window.
const FILE_LIMIT: usize = 32 * 1024;

/// Which layers to assemble, and from where.
#[derive(Debug, Clone)]
pub struct PromptConfig {
    /// Include the built-in identity segment.
    pub identity: bool,
    /// Include the host/environment segment.
    pub environment: bool,
    /// Discover and include every `AGENTS.md` between the filesystem root
    /// and `cwd`.
    pub project_instructions: bool,
    /// Include the user's own `~/.nightloom/AGENTS.md`.
    pub user_memory: bool,
    /// The project this chat belongs to, if any: its name and the shared
    /// notes directory to index.
    ///
    /// One `Option` over a struct rather than a name field beside a path
    /// field, because neither half is useful alone — a notes index nobody can
    /// attribute to a project, or a project name with nowhere to write.
    pub project: Option<ProjectContext>,
    /// The user's knowledge vault, when this chat can reach one.
    ///
    /// A second `Option` rather than a field on [`ProjectContext`], because
    /// the vault is not the project's: it is the same vault in every project
    /// and in a chat with no project at all, which is the case it exists for.
    pub knowledge: Option<KnowledgeContext>,
    /// Directory the assembly is relative to.
    pub cwd: PathBuf,
    /// Shell-supplied text, appended last (CLI --system, desktop textarea).
    pub custom: Option<String>,
}

impl Default for PromptConfig {
    fn default() -> Self {
        Self {
            identity: true,
            environment: true,
            project_instructions: true,
            user_memory: true,
            project: None,
            knowledge: None,
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            custom: None,
        }
    }
}

/// What the prompt needs to know about the enclosing project.
#[derive(Debug, Clone)]
pub struct ProjectContext {
    /// What the user calls it. In the segment header so "which project am I
    /// in" is answerable without the model inferring it from a path.
    pub name: String,
    /// The shared notes directory. Indexed, never inlined.
    pub notes_dir: PathBuf,
}

/// What the prompt needs to know about the knowledge vault.
#[derive(Debug, Clone)]
pub struct KnowledgeContext {
    /// Where the vault is. Named in the segment so a user who has repointed
    /// it can see which folder the model is reading — and so a vault that is
    /// somewhere unexpected is visible rather than mysterious.
    pub dir: PathBuf,
}

/// Assemble in fixed order: identity, environment, user memory, project
/// instructions, custom.
///
/// The order is a precedence ladder — later segments are read as refining
/// earlier ones — so the user's standing preferences sit under the project's
/// rules, and whatever the shell passed in wins over both.
pub fn assemble(config: &PromptConfig) -> SystemPrompt {
    let mut prompt = SystemPrompt::new();

    if config.identity {
        prompt.push(identity_segment());
    }
    if config.environment {
        prompt.push(environment_segment(&config.cwd));
    }
    if config.user_memory
        && let Some(seg) = user_memory_segment()
    {
        prompt.push(seg);
    }
    if config.project_instructions {
        for seg in project_instruction_segments(&config.cwd) {
            prompt.push(seg);
        }
    }
    if let Some(project) = &config.project {
        prompt.push(project_notes_segment(project));
    }
    // After the docspace, so that the sentence telling the two apart arrives
    // with both indexes already read.
    if let Some(knowledge) = &config.knowledge {
        prompt.push(knowledge_segment(knowledge));
    }
    if let Some(custom) = &config.custom {
        prompt.push(Segment::new(SegmentKind::Custom, "custom", custom.clone()));
    }

    anchor_last(prompt)
}

/// A single breakpoint at the end of the static prefix. Anchoring every
/// segment would burn Anthropic's four-breakpoint budget on boundaries that
/// only pay off when an inner layer changes — which, for a prompt built once
/// per `Chat`, never happens.
fn anchor_last(prompt: SystemPrompt) -> SystemPrompt {
    let mut segments = prompt.segments().to_vec();
    let Some(last) = segments.pop() else {
        return prompt;
    };
    let mut out = SystemPrompt::new();
    for seg in segments {
        out.push(seg);
    }
    out.push(last.anchored());
    out
}

pub fn identity_segment() -> Segment {
    Segment::new(SegmentKind::Identity, "identity", DEFAULT_IDENTITY)
}

/// Stable facts about the host.
///
/// NO CLOCK, NO DATE, NO TIME may ever be added here: this segment must be
/// byte-identical across every turn of a session or it defeats prompt
/// caching. That is the entire reason the environment is split between this
/// segment and the per-turn sidecar — time-varying context goes there.
pub fn environment_segment(cwd: &Path) -> Segment {
    let mut lines = vec![
        format!("cwd: {}", cwd.display()),
        format!("os: {} ({})", std::env::consts::OS, std::env::consts::ARCH),
    ];
    lines.push(format!("shell: {}", tool_shell()));
    if let Some(git) = find_git_repo(cwd) {
        lines.push(format!("git repo: {}", git.root.display()));
        if let Some(branch) = git.branch {
            lines.push(format!("git branch: {branch}"));
        }
    }

    let text = format!("<environment>\n{}\n</environment>", lines.join("\n"));
    Segment::new(SegmentKind::Environment, "environment", text)
}

/// The shell the `bash` tool runs a command in — deliberately **not** the one
/// the user launched from.
///
/// This read the launching terminal before, off `PSModulePath` on Windows and
/// `$SHELL` elsewhere, and that is a fact the model cannot act on: it never
/// touches the user's terminal, only the one `tools::shell` spawns. A live
/// session read `shell: powershell` here, opened with `Get-ChildItem`, and
/// spent two rounds discovering it had been handed cmd.exe — the environment
/// segment is the model's environment, and describing somebody else's is
/// worse than saying nothing. `$SHELL` was the same lie more quietly on Unix,
/// naming zsh or fish where `sh -c` is what runs.
///
/// It names the invocation as well as the binary, because "cmd.exe" alone
/// still leaves the quoting and builtin rules to be guessed at.
fn tool_shell() -> &'static str {
    if cfg!(windows) {
        "cmd.exe (your `bash` tool runs `cmd /C <command>`)"
    } else {
        "sh (your `bash` tool runs `sh -c <command>`)"
    }
}

struct GitInfo {
    root: PathBuf,
    /// `None` when the checkout is detached, or when `.git` is a worktree
    /// pointer file we deliberately don't chase.
    branch: Option<String>,
}

/// Locate the enclosing repository without shelling out to `git` — spawning a
/// process to read two files would be slower and could hang.
fn find_git_repo(cwd: &Path) -> Option<GitInfo> {
    for dir in cwd.ancestors() {
        let dot_git = dir.join(".git");
        if !dot_git.exists() {
            continue;
        }
        // In a linked worktree `.git` is a file holding `gitdir: <path>`.
        // Knowing we're in a repo is enough; the branch stays unknown.
        let branch = dot_git
            .is_dir()
            .then(|| std::fs::read_to_string(dot_git.join("HEAD")).ok())
            .flatten()
            .and_then(|head| parse_head(&head));
        return Some(GitInfo {
            root: dir.to_path_buf(),
            branch,
        });
    }
    None
}

/// `.git/HEAD` is either `ref: refs/heads/<branch>` or a bare sha (detached).
fn parse_head(head: &str) -> Option<String> {
    let head = head.trim();
    let reference = head.strip_prefix("ref:")?.trim();
    let branch = reference.strip_prefix("refs/heads/").unwrap_or(reference);
    (!branch.is_empty()).then(|| branch.to_string())
}

/// Every `AGENTS.md` from the filesystem root down to `cwd`, outermost-first.
///
/// The walk deliberately does **not** stop at the repository root. Stopping
/// there assumes the only instructions that can apply are ones committed to
/// this project, and that is the wrong assumption in the two places people
/// actually put them: a `~/dev/AGENTS.md` covering every checkout under it,
/// and a machine-wide file at the top of the drive. Those are not "some
/// unrelated tree the repo happens to sit in" — they are the layers a user
/// wrote precisely so they would not have to repeat themselves per repo.
///
/// Outermost-first because the order is a precedence ladder: each file reads
/// as refining the ones above it, so the closest to `cwd` — the most specific
/// — is the one the model sees last and weighs most.
///
/// Every level is a `stat` on a path that usually does not exist, which is
/// the cost of the whole walk; even a deeply nested path is a few dozen.
pub fn project_instruction_segments(cwd: &Path) -> Vec<Segment> {
    let mut found: Vec<Segment> = Vec::new();

    for dir in cwd.ancestors() {
        let path = dir.join(INSTRUCTION_FILE);
        let Some(content) = read_capped(&path) else {
            continue;
        };
        let display = path.display();
        let text = format!(
            "<project-instructions path=\"{display}\">\n{content}\n</project-instructions>"
        );
        found.push(Segment::new(
            SegmentKind::ProjectInstructions,
            display.to_string(),
            text,
        ));
    }

    // `ancestors()` walks innermost-first; the most specific file must land
    // last so it reads as refining the ones above it.
    found.reverse();
    found
}

/// The user's own `AGENTS.md`, from `~/.nightloom/`.
///
/// First in the ladder and outside the walk, because it is the one layer that
/// is about the *user* rather than about a location on disk: it applies
/// wherever they are working, including outside any tree they own. Everything
/// the directory walk finds is read as refining it.
pub fn user_memory_segment() -> Option<Segment> {
    let content = read_capped(&user_instruction_path()?)?;
    Some(Segment::new(
        SegmentKind::UserMemory,
        "user-memory",
        format!("<user-instructions>\n{content}\n</user-instructions>"),
    ))
}

/// Where [`user_memory_segment`] reads from, exposed so a shell can name the
/// file in a "nothing found" message rather than leaving the user guessing.
pub fn user_instruction_path() -> Option<PathBuf> {
    Some(crate::project::config_dir()?.join(INSTRUCTION_FILE))
}

/// An index of the project's shared notes — the state every conversation in
/// this project starts from.
///
/// **The index, not the contents.** Inlining the notes would put an unbounded
/// pile of text in the one place that must stay small, and would make the
/// facility worse the more it was used. An index plus the file tools costs one
/// `read_file` for the note that turns out to matter, and nothing for the ones
/// that don't.
///
/// It belongs here rather than in the sidecar because it is stable for the
/// life of a `Chat`: assembled once, cached once, read free on every later
/// turn. The consequence, and it is the right trade, is that a note the model
/// writes mid-session is not reflected in the index until the next `Chat` —
/// the model has just written it, and `list_dir` answers if it forgets.
///
/// Always a segment, never `None`, even for an empty docspace: a facility the
/// model is not told about is a facility nobody uses, and the empty case is
/// where saying what it is for matters most.
///
/// **What it says about the path is load-bearing, and it was wrong for
/// thirteen commits.** The docspace spent one commit at `~/.nightloom`, and
/// this segment told the model the directory was outside the workspace and to
/// give the absolute path. Moving it back to `<workspace>/.agents` left that
/// sentence behind, and nothing failed: the model does as it is told, an
/// absolute path inside the root resolves like any other, and every call
/// succeeds. What was lost is the reason the docspace sits inside the tree at
/// all — a model told the notes are somewhere else has no reason to
/// expect `grep` or `glob` to reach them, and will not look. A prompt that is
/// wrong in a direction nothing errors on is the expensive kind.
pub fn project_notes_segment(project: &ProjectContext) -> Segment {
    let notes = crate::project::list_notes(&project.notes_dir);
    let name = &project.name;
    let dir = project.notes_dir.display();
    // The path the model should actually type. The docspace is a directory
    // inside the workspace, so its final component *is* its path relative to
    // the root every file tool already resolves against.
    let rel = project
        .notes_dir
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| project.notes_dir.display().to_string());

    let mut text = format!(
        "<project-notes project=\"{name}\" dir=\"{dir}\">
"
    );
    text.push_str(&format!(
        "Shared notes for this project. Every conversation in it sees this index, and \
         anything written here reaches later conversations — this is where to leave \
         something for your next self.\n\n\
         Read one with read_file and add or revise one with write_file / edit_file. This \
         directory is inside the workspace, so a relative path reaches it ({rel}/<name>), \
         and grep and glob walk it like any other folder — a note can be found without \
         being read first. Only this index is loaded automatically; the contents are not.\n\n\
         Worth writing down: a task list that outlives one conversation, a decision and \
         why it was made, a map of something that took real work to figure out. Not worth \
         writing down: anything already obvious from the code, or a summary of what you \
         just said. Revise a stale note rather than adding a second one beside it — a \
         wrong note costs more than a missing one.\n"
    ));
    if notes.is_empty() {
        text.push_str(
            "
The notes directory is currently empty.
",
        );
    } else {
        text.push_str(
            "
Notes now:
",
        );
        for note in &notes {
            let size = human_bytes(note.bytes);
            match &note.summary {
                Some(summary) => text.push_str(&format!(
                    "  {} ({size}) — {summary}
",
                    note.name
                )),
                None => text.push_str(&format!(
                    "  {} ({size})
",
                    note.name
                )),
            }
        }
    }
    text.push_str("</project-notes>");

    Segment::new(SegmentKind::ProjectNotes, "project-notes", text)
}

/// How many bytes of *listing* the vault index may occupy.
///
/// The docspace has no such limit and does not need one: it is a handful of
/// files about one folder, and every one of them is relevant to the chat that
/// is open. A vault is neither. It is meant to grow for years, and an index
/// that grew with it would make the facility worse the more it was used —
/// paying more prompt on every turn of every chat to list notes that have
/// nothing to do with the question. So the listing is capped and the rest is
/// reachable by search, which is the trade the docspace makes about note
/// *contents* applied one level up.
const VAULT_INDEX_BUDGET: usize = 4 * 1024;

/// The knowledge vault: an index of what the user knows.
///
/// The same shape as [`project_notes_segment`] and for the same reasons — the
/// index and never the contents, a segment rather than a sidecar part because
/// it is stable for the life of a `Chat` and so is written to the cache once
/// and read free afterwards, and emitted even when empty because a facility
/// the model was never told about is one nobody uses.
///
/// Three things it says earn their tokens:
///
/// * **`@kb/<name>` is the path.** The vault is outside the workspace, so
///   `Root` reaches it by alias; a model that does not know the alias has no
///   way to open a note it can see in the index.
/// * **`[[name]]` means `@kb/<name>.md`.** Links are the point of a vault, and
///   a model that reads one as decoration will not follow it.
/// * **What belongs here versus the docspace.** This is the sentence that
///   keeps the two stores from collapsing into one. Without it, "shared notes"
///   and "knowledge" are two folders with indistinguishable descriptions, and
///   the model will write to whichever it saw last — at which point neither is
///   trustworthy, because neither is reliably about what it claims.
///
/// **Grouped by folder, most recently edited first within each**, with an
/// exact count beside every folder — and this is the shape rather than one
/// flat recency list because a flat list stops being true at scale while a
/// map does not. Run the arithmetic: an entry is ~55 bytes, so 4 KiB lists
/// about 75 notes. Against a vault of 2,000 that is 4%, and there is no
/// version of "list more" that fixes it — the proposal to add a first-line
/// snippet to each entry takes it to ~130 bytes, so *four times* the budget
/// would list 6% instead of 4%. Both designs fail at that size; what separates
/// them is that a flat 4% still *reads* like a catalogue, and a model that
/// finds no hit in one concludes the vault does not cover the subject. A
/// folder line with a count cannot mislead that way however hard it is cut,
/// and grouping is not merely cheap but **negative** cost: the repeated path
/// prefix is factored out of every line beneath it.
///
/// Recency survives *within* a folder and is deliberately no longer the
/// top-level order. It is a good proxy for "what am I working on" and a poor
/// one for "what does a stranger need to see", and this index is read by a
/// stranger at the start of every chat: in a vault, unedited means **settled**
/// rather than stale, so a decision that is supposed to never change again
/// sorts below a typo fix in an archived note. The original objection to name
/// order was that it makes the end of the alphabet the part nobody sees — that
/// objection was about *hiding*, and an exact count per folder hides nothing.
/// Budget is handed out **round-robin across folders** for the same reason, so
/// every folder shows one note before any folder shows five.
///
/// Past the cap the index **leads with the fact that it is a sample** rather
/// than appending a footnote to a listing that already read as authoritative.
/// The count and the way to search were there before and were in the wrong
/// place: underneath ~75 plausible-looking entries, which is precisely where a
/// reader who has stopped looking will not reach.
///
/// Two limits sit under this and they are not the same one. The **byte
/// budget** decides how much of the listing survives, and is what round-robin
/// divides. [`crate::project::list_notes`]'s own cap decides how many notes
/// were ever materialized, stopping mid-walk in filesystem order — so past it
/// there are folders with nothing to list, whatever the budget says. That is
/// why the counts come from [`crate::project::note_counts`] and not from the
/// listing: the map stays true above both limits (`zzz/ (3 notes, 0 shown)`),
/// and only the sample beneath it thins out.
///
/// Deliberately **no link counts per note**, though the data is there — it
/// would mean reading every note in full at assembly, where listing costs a
/// stat and a 512-byte probe. Re-examined and kept: asked to justify the field,
/// a model instead recovered the entire link structure of a test vault with one
/// `grep` mid-conversation. That is the whole case — a per-turn cost paid by
/// the one chat that needs it beats a per-chat prompt cost paid by every chat
/// that does not.
pub fn knowledge_segment(knowledge: &KnowledgeContext) -> Segment {
    let mut notes = crate::project::list_notes(&knowledge.dir);
    notes.sort_by(|a, b| {
        b.modified
            .cmp(&a.modified)
            .then_with(|| a.name.cmp(&b.name))
    });
    let dir = knowledge.dir.display();
    let alias = crate::tools::VAULT_ALIAS;

    let mut text = format!("<knowledge dir=\"{dir}\">\n");
    text.push_str(&format!(
        "The user's own knowledge base — what *they* know, kept across every project and \
         available in every conversation, including ones with no project open. It is theirs \
         rather than yours: treat what is written here as something they rely on, revise \
         carefully, and say when you have changed something.\n\n\
         Reach a note at {alias}/<name> — the vault lives outside the workspace, and that \
         prefix is how the file tools address it. read_file to read one, write_file and \
         edit_file to add or revise one, and glob or grep with path \"{alias}\" to search the \
         whole vault. Only this index is loaded automatically; the contents are not.\n\n\
         Notes link to each other with [[name]], which means {alias}/<name>.md. Follow one by \
         reading that path. Writing [[name]] for a note that does not exist yet is normal — it \
         is how the user plans one.\n\n\
         What belongs here: something that stays true after this folder is closed — a decision \
         and why it was made, a person, a technique, a conclusion reached the hard way, a \
         standing preference. What does not: anything about the code in front of you, which \
         goes in the project's own notes instead. The distinction is the whole value of having \
         both, so put a note where it belongs rather than where it is convenient.\n"
    ));

    if notes.is_empty() {
        text.push_str("\nThe knowledge base is currently empty.\n");
    } else {
        // `BTreeMap` for the folder order, so the *shape* of the vault is
        // stable between chats and only the notes inside a folder reorder as
        // they are edited. The root's empty prefix sorts first for free.
        //
        // Seeded from `note_counts` rather than from the listing, so a folder
        // the listing never reached is still on the map with a true count.
        // `list_notes` stops mid-walk at its own cap, which makes its length
        // and its folder set both smaller than the vault's.
        let (counts, exhaustive) = crate::project::note_counts(&knowledge.dir);
        let mut by_folder: BTreeMap<&str, Vec<&crate::project::Note>> = BTreeMap::new();
        for prefix in counts.keys() {
            by_folder.entry(prefix.as_str()).or_default();
        }
        for note in &notes {
            let prefix = match note.name.rfind('/') {
                Some(cut) => &note.name[..=cut],
                None => "",
            };
            by_folder.entry(prefix).or_default().push(note);
        }
        let folders: Vec<(&str, Vec<&crate::project::Note>)> = by_folder.into_iter().collect();
        let held = |prefix: &str, listed: usize| counts.get(prefix).copied().unwrap_or(listed);
        let total: usize = counts.values().sum::<usize>().max(notes.len());

        // Folder headers are reserved before any note is listed: they are the
        // map, and a map with folders missing is the failure this shape exists
        // to avoid. Reserved at the *cut* spelling, which is the longer of the
        // two, so the budget can only be undershot.
        let mut used: usize = folders
            .iter()
            .filter(|(prefix, _)| !prefix.is_empty())
            .map(|(prefix, group)| folder_header(prefix, held(prefix, group.len()), 0).len())
            .sum();

        // Round-robin, so a folder late in the alphabet is not starved by one
        // early in it. A refused line is skipped rather than ending the walk,
        // since a shorter entry after it may still fit.
        let mut shown = vec![0usize; folders.len()];
        let mut total_shown = 0usize;
        loop {
            let mut progressed = false;
            for (i, (prefix, group)) in folders.iter().enumerate() {
                let Some(note) = group.get(shown[i]) else {
                    continue;
                };
                let line = note_entry(prefix, note);
                if used + line.len() > VAULT_INDEX_BUDGET && total_shown > 0 {
                    continue;
                }
                used += line.len();
                shown[i] += 1;
                total_shown += 1;
                progressed = true;
            }
            if !progressed {
                break;
            }
        }

        if total_shown < total {
            // "over N" rather than a bare number when the counting walk hit
            // its own ceiling: a floor stated as a floor is usable, and the
            // one thing this sentence must never do is understate the vault
            // while sounding exact.
            let scale = if exhaustive {
                format!("{total} notes")
            } else {
                format!("over {total} notes")
            };
            text.push_str(&format!(
                "\nThe vault holds {scale}. What follows is a sample of {total_shown} of them \
                 and not the whole vault: the count beside each folder is exact, the listing \
                 under it is not. To reach anything not listed, glob \"{alias}/**\" or grep \
                 with path \"{alias}\" — do that before concluding the vault is silent on \
                 something.\n\n"
            ));
        } else {
            text.push_str("\nNotes, by folder, most recently edited first within each:\n");
        }
        // Said rather than left to convention. The folder prefix is factored
        // out of the lines beneath it, which is where the grouping pays for
        // itself, and the cost of that is one composition step the model has
        // to make: `async.md` under `rust/` is a note whose name is
        // `rust/async.md`. Ten words is cheap against a wrong path.
        if folders.iter().any(|(prefix, _)| !prefix.is_empty()) {
            text.push_str(&format!(
                "A note's name is its folder plus the line beneath it — async.md listed under \
                 rust/ is {alias}/rust/async.md.\n"
            ));
        }

        for (i, (prefix, group)) in folders.iter().enumerate() {
            let in_folder = held(prefix, group.len());
            if !prefix.is_empty() {
                text.push_str(&folder_header(prefix, in_folder, shown[i]));
            }
            for note in group.iter().take(shown[i]) {
                text.push_str(&note_entry(prefix, note));
            }
            // The root has no header to carry its count, so a cut there would
            // otherwise be the one omission this format does not admit to.
            if prefix.is_empty() && shown[i] < in_folder {
                text.push_str(&format!(
                    "  … {} more at the vault root, not listed\n",
                    in_folder - shown[i]
                ));
            }
        }
    }
    text.push_str("</knowledge>");

    Segment::new(SegmentKind::Knowledge, "knowledge", text)
}

/// `  people/ (34 notes, 6 shown)` — exact whatever the budget did to the
/// listing beneath it, which is the whole reason a folder line is worth more
/// than the six entries it displaces.
fn folder_header(prefix: &str, total: usize, shown: usize) -> String {
    let notes = if total == 1 { "note" } else { "notes" };
    if shown < total {
        format!("  {prefix} ({total} {notes}, {shown} shown)\n")
    } else {
        format!("  {prefix} ({total} {notes})\n")
    }
}

/// One note, with its folder factored out — `people/rowan-vasquez.md` under
/// `people/` is listed as `rowan-vasquez.md`. The saving is why grouping costs
/// less than the flat list it replaces rather than more.
fn note_entry(prefix: &str, note: &crate::project::Note) -> String {
    let base = &note.name[prefix.len()..];
    let size = human_bytes(note.bytes);
    let indent = if prefix.is_empty() { "  " } else { "    " };
    match &note.summary {
        Some(summary) => format!("{indent}{base} ({size}) — {summary}\n"),
        None => format!("{indent}{base} ({size})\n"),
    }
}

fn human_bytes(bytes: u64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else if bytes >= 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{bytes} B")
    }
}

/// A missing, unreadable, or non-UTF-8 instruction file is the normal case,
/// not an error — the walk visits far more directories than have one.
fn read_capped(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let text = String::from_utf8(bytes).ok()?;
    let text = truncate(text);
    (!text.trim().is_empty()).then_some(text)
}

fn truncate(text: String) -> String {
    if text.len() <= FILE_LIMIT {
        return text;
    }
    let mut cut = FILE_LIMIT;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}… (truncated)", &text[..cut])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// `uuid` isn't a dependency here, so name temp dirs by pid + counter.
    fn temp_dir(label: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("nightloom-test-{label}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn bare(cwd: PathBuf) -> PromptConfig {
        PromptConfig {
            identity: false,
            environment: false,
            project_instructions: false,
            user_memory: false,
            project: None,
            knowledge: None,
            cwd,
            custom: None,
        }
    }

    #[test]
    fn the_notes_layer_indexes_names_and_summaries_but_never_contents() {
        let dir = temp_dir("notes-index");
        let notes = dir.join("notes");
        crate::project::write_note(
            &notes,
            "TASKS.md",
            "# Auth rewrite
the body text",
        )
        .unwrap();

        let mut cfg = bare(dir.clone());
        cfg.project = Some(ProjectContext {
            name: "Nightloom".into(),
            notes_dir: notes,
        });

        let segs = assemble(&cfg).segments().to_vec();
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].kind, SegmentKind::ProjectNotes);
        let text = &segs[0].text;
        assert!(text.contains("project=\"Nightloom\""), "{text}");
        assert!(text.contains("TASKS.md"), "{text}");
        assert!(text.contains("Auth rewrite"), "{text}");
        // The index is an index. A note's body reaching the prompt would make
        // the facility cost more the more it was used.
        assert!(!text.contains("the body text"), "{text}");
    }

    #[test]
    fn an_empty_docspace_still_tells_the_model_it_exists() {
        let dir = temp_dir("notes-empty");
        let mut cfg = bare(dir.clone());
        cfg.project = Some(ProjectContext {
            name: "Fresh".into(),
            notes_dir: dir.join("notes"),
        });

        let segs = assemble(&cfg).segments().to_vec();
        assert_eq!(segs.len(), 1);
        assert!(segs[0].text.contains("currently empty"), "{}", segs[0].text);
    }

    /// The segment tells the model how to reach a note; `Root` is what
    /// decides whether that is true. It said "outside the workspace, give the
    /// full path" for thirteen commits after the docspace moved back inside
    /// one, and no call ever failed over it — an absolute path resolves too.
    /// So the claim went untested while being wrong. This is that test: the
    /// path the segment names, resolved the way every file tool resolves a
    /// path argument, is the note on disk.
    #[test]
    fn the_notes_segment_names_a_path_the_file_tools_resolve() {
        let dir = temp_dir("notes-reachable");
        let notes = dir.join(crate::project::AGENTS_DIR);
        crate::project::write_note(&notes, "plan.md", "# Plan").unwrap();

        let mut cfg = bare(dir.clone());
        cfg.project = Some(ProjectContext {
            name: "Reach".into(),
            notes_dir: notes,
        });
        let text = assemble(&cfg).segments()[0].text.clone();

        assert!(text.contains(".agents/<name>"), "{text}");
        assert!(!text.contains("outside the workspace"), "{text}");

        let resolved = crate::tools::Root::new(&dir)
            .resolve(".agents/plan.md")
            .expect("the relative path the segment names must resolve");
        assert!(resolved.is_file(), "{resolved:?}");
    }

    /// The same test the docspace segment gets, and for the same reason: the
    /// segment tells the model how to reach a note, and `Root` is what decides
    /// whether that is true. Here it matters more, not less — the vault really
    /// *is* outside the workspace, so the alias is the only way in and a wrong
    /// sentence would not merely lose an affordance, it would lose the vault.
    #[test]
    fn the_knowledge_segment_names_a_path_the_file_tools_resolve() {
        let dir = temp_dir("vault-reachable");
        let vault = dir.join("vault");
        crate::project::write_note(&vault, "rust/async.md", "# Cancellation is a parameter")
            .unwrap();

        let mut cfg = bare(dir.clone());
        cfg.knowledge = Some(KnowledgeContext { dir: vault.clone() });

        let segs = assemble(&cfg).segments().to_vec();
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].kind, SegmentKind::Knowledge);
        let text = &segs[0].text;
        assert!(text.contains("@kb/<name>"), "{text}");
        // The folder is factored out of the entry, so the name the model has
        // to build is the header plus the line under it. Both halves have to
        // be there, and the composition has to be stated rather than assumed.
        assert!(text.contains("rust/ (1 note)"), "{text}");
        assert!(text.contains("    async.md"), "{text}");
        assert!(text.contains("folder plus the line beneath it"), "{text}");
        assert!(text.contains("Cancellation is a parameter"), "{text}");

        let resolved = crate::tools::Root::new(&dir)
            .with_vault(&vault)
            .resolve("@kb/rust/async.md")
            .expect("the aliased path the segment names must resolve");
        assert!(resolved.is_file(), "{resolved:?}");
    }

    /// The sentence that stops the two stores collapsing into one. If it goes
    /// missing, both indexes describe "shared notes" and the model writes to
    /// whichever it read last.
    #[test]
    fn the_knowledge_segment_says_what_belongs_in_it_rather_than_the_docspace() {
        let dir = temp_dir("vault-distinct");
        let mut cfg = bare(dir.clone());
        cfg.knowledge = Some(KnowledgeContext {
            dir: dir.join("vault"),
        });
        let text = assemble(&cfg).segments()[0].text.clone();

        assert!(text.contains("currently empty"), "{text}");
        assert!(text.contains("after this folder is closed"), "{text}");
        assert!(text.contains("project's own notes"), "{text}");
        // And the link syntax, which is the other thing only this segment says.
        assert!(text.contains("[[name]]"), "{text}");
    }

    /// A vault is meant to grow for years, so the listing is capped. What has
    /// to be true is that the cut *says so* — a listing that stops silently
    /// reads as a vault that ends there, and a model that believes it has seen
    /// everything will not search for the rest.
    #[test]
    fn a_large_vault_is_cut_and_says_how_much_it_did_not_list() {
        let dir = temp_dir("vault-budget");
        let vault = dir.join("vault");
        for i in 0..150 {
            crate::project::write_note(
                &vault,
                &format!("note-{i:03}-with-a-reasonably-long-name.md"),
                &format!("# Heading {i} on a note whose summary line is deliberately wordy"),
            )
            .unwrap();
        }

        let mut cfg = bare(dir.clone());
        cfg.knowledge = Some(KnowledgeContext { dir: vault });
        let text = assemble(&cfg).segments()[0].text.clone();

        // Leading with the sample, not appending a footnote to a listing that
        // already read as authoritative: the exact total, an explicit "not the
        // whole vault", and the way to reach the rest — all above the entries
        // rather than under seventy of them.
        assert!(text.contains("The vault holds 150 notes"), "{text}");
        assert!(text.contains("not the whole vault"), "{text}");
        assert!(text.contains("grep with path \"@kb\""), "{text}");
        assert!(
            text.contains("more at the vault root, not listed"),
            "{text}"
        );
        let (lead, listing) = text.split_once("note-").expect("some note is listed");
        assert!(lead.contains("not the whole vault"), "the warning leads");
        assert!(
            !listing.contains("not the whole vault"),
            "and is not repeated"
        );
        // The cap is on the listing, and the prose above it is not a licence
        // to blow the budget many times over.
        assert!(text.len() < 3 * VAULT_INDEX_BUDGET, "{} bytes", text.len());
    }

    /// No folder may go unmentioned, and no count may be a guess — even when
    /// the note *listing* never reached the folder at all.
    ///
    /// This is the property that makes a cut index a map rather than a
    /// truncated catalogue, and it cannot come from the listing: `list_notes`
    /// stops at its own cap mid-walk, in filesystem order, so on this fixture
    /// it returns two hundred notes all from `aaa/` and has never heard of
    /// `zzz/`. Seeded from the listing, the index would have said the vault
    /// holds 200 notes in one folder. It holds 204 in three.
    #[test]
    fn a_folder_the_listing_never_reached_is_still_on_the_map() {
        let dir = temp_dir("vault-folders");
        let vault = dir.join("vault");
        crate::project::write_note(&vault, "at-the-root.md", "# At the root").unwrap();
        for i in 0..200 {
            crate::project::write_note(
                &vault,
                &format!("aaa/crowded-{i:03}-with-a-long-name.md"),
                &format!("# Crowded note {i} with a deliberately wordy summary line"),
            )
            .unwrap();
        }
        for i in 0..3 {
            crate::project::write_note(
                &vault,
                &format!("zzz/rare-{i}.md"),
                &format!("# Rare note {i}"),
            )
            .unwrap();
        }
        // The premise: the listing really is blind to `zzz/`, so the map is
        // not merely duplicating what it could have read off `notes`.
        let listed = crate::project::list_notes(&vault);
        assert_eq!(listed.len(), 200);
        assert!(!listed.iter().any(|n| n.name.starts_with("zzz/")));

        let mut cfg = bare(dir.clone());
        cfg.knowledge = Some(KnowledgeContext { dir: vault });
        let text = assemble(&cfg).segments()[0].text.clone();

        assert!(text.contains("The vault holds 204 notes"), "{text}");
        assert!(text.contains("  aaa/ (200 notes,"), "{text}");
        // Named, counted truthfully, and honest that it showed nothing.
        assert!(text.contains("  zzz/ (3 notes, 0 shown)"), "{text}");
        assert!(text.len() < 3 * VAULT_INDEX_BUDGET, "{} bytes", text.len());
    }

    /// Budget is shared across folders rather than spent front-to-back, so a
    /// folder late in the alphabet still shows something.
    ///
    /// Kept under `list_notes`'s own cap deliberately: this is a claim about
    /// how the *byte budget* is divided, and above that cap the listing is
    /// already short of notes to divide. The two limits are separate and only
    /// this one is round-robin's to answer.
    #[test]
    fn the_budget_is_shared_across_folders_rather_than_first_come() {
        let dir = temp_dir("vault-fair");
        let vault = dir.join("vault");
        for i in 0..150 {
            crate::project::write_note(
                &vault,
                &format!("aaa/crowded-{i:03}-with-a-deliberately-long-name.md"),
                &format!("# Crowded note {i} with a summary line that is also wordy"),
            )
            .unwrap();
        }
        for i in 0..3 {
            crate::project::write_note(
                &vault,
                &format!("zzz/rare-{i}.md"),
                &format!("# Rare note {i}"),
            )
            .unwrap();
        }

        let mut cfg = bare(dir.clone());
        cfg.knowledge = Some(KnowledgeContext { dir: vault });
        let text = assemble(&cfg).segments()[0].text.clone();

        // `aaa/` is cut by the budget, and `zzz/` — which front-to-back would
        // never have been reached — is listed whole.
        assert!(text.contains("  aaa/ (150 notes,"), "{text}");
        assert!(text.contains("  zzz/ (3 notes)"), "{text}");
        assert!(text.contains("rare-0.md"), "{text}");
        assert!(text.contains("rare-2.md"), "{text}");
        assert!(text.len() < 3 * VAULT_INDEX_BUDGET, "{} bytes", text.len());
    }

    /// Two stores, two segments, in a fixed order — so a reader of the context
    /// panel can tell what each cost, and neither can be mistaken for the
    /// other.
    #[test]
    fn the_docspace_and_the_vault_are_separate_segments() {
        let dir = temp_dir("vault-and-docspace");
        crate::project::write_note(&dir.join(".agents"), "plan.md", "# Plan").unwrap();
        crate::project::write_note(&dir.join("vault"), "ada.md", "# Ada").unwrap();

        let mut cfg = bare(dir.clone());
        cfg.project = Some(ProjectContext {
            name: "Both".into(),
            notes_dir: dir.join(".agents"),
        });
        cfg.knowledge = Some(KnowledgeContext {
            dir: dir.join("vault"),
        });

        let segs = assemble(&cfg).segments().to_vec();
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].kind, SegmentKind::ProjectNotes);
        assert_eq!(segs[1].kind, SegmentKind::Knowledge);
        assert!(segs[0].text.contains("plan.md"), "{}", segs[0].text);
        assert!(!segs[0].text.contains("ada.md"), "{}", segs[0].text);
        assert!(segs[1].text.contains("ada.md"), "{}", segs[1].text);
        assert!(!segs[1].text.contains("plan.md"), "{}", segs[1].text);
    }

    #[test]
    fn custom_only_yields_one_anchored_segment() {
        let mut cfg = bare(PathBuf::from("."));
        cfg.custom = Some("hi".into());

        let prompt = assemble(&cfg);
        let segs = prompt.segments();
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].kind, SegmentKind::Custom);
        assert_eq!(segs[0].text, "hi");
        assert!(segs[0].cache_anchor);
        assert_eq!(prompt.cache_anchors(4), vec![0]);
    }

    #[test]
    fn defaults_lead_with_identity_and_anchor_only_the_end() {
        let dir = temp_dir("defaults");
        let cfg = PromptConfig {
            cwd: dir.clone(),
            ..PromptConfig::default()
        };

        let prompt = assemble(&cfg);
        let segs = prompt.segments();
        assert_eq!(segs[0].kind, SegmentKind::Identity);
        assert_eq!(segs[0].text, DEFAULT_IDENTITY);
        assert!(segs.len() >= 2, "identity + environment at minimum");
        assert_eq!(prompt.cache_anchors(4), vec![segs.len() - 1]);
        assert!(segs[..segs.len() - 1].iter().all(|s| !s.cache_anchor));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn environment_is_free_of_the_clock() {
        let seg = environment_segment(Path::new("/some/where"));
        assert_eq!(seg.kind, SegmentKind::Environment);
        assert!(seg.text.starts_with("<environment>"));
        assert!(seg.text.ends_with("</environment>"));
        assert!(seg.text.contains("os: "));
        for banned in ["time:", "date:", "now:", "today"] {
            assert!(
                !seg.text.contains(banned),
                "{banned} leaked into {}",
                seg.text
            );
        }
    }

    #[test]
    fn head_parses_branches_and_detached_shas() {
        assert_eq!(
            parse_head("ref: refs/heads/feature/x\n").as_deref(),
            Some("feature/x")
        );
        assert_eq!(parse_head("ref: refs/heads/main").as_deref(), Some("main"));
        assert_eq!(
            parse_head("9f0a1b2c3d4e5f60718293a4b5c6d7e8f9012345\n"),
            None
        );
    }

    /// Only the segments this test planted. The walk now runs all the way to
    /// the filesystem root, so whatever the machine happens to have above the
    /// temp directory is legitimately included — and an assertion on the
    /// total count would fail on any box that has one.
    fn planted_in(root: &Path, cwd: &Path) -> Vec<Segment> {
        let prefix = root.display().to_string();
        project_instruction_segments(cwd)
            .into_iter()
            .filter(|s| s.name.starts_with(&prefix))
            .collect()
    }

    #[test]
    fn instructions_are_outermost_first_and_do_not_stop_at_the_repo_root() {
        let root = temp_dir("walk");
        let repo = root.join("repo");
        let sub = repo.join("sub");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(root.join("AGENTS.md"), "above the repo").unwrap();
        std::fs::write(repo.join("AGENTS.md"), "repo rules").unwrap();
        std::fs::write(sub.join("AGENTS.md"), "sub rules").unwrap();

        let segs = planted_in(&root, &sub);
        assert_eq!(segs.len(), 3, "found: {segs:?}");
        // Outermost first, most specific last.
        assert!(segs[0].text.contains("above the repo"));
        assert!(segs[1].text.contains("repo rules"));
        assert!(segs[2].text.contains("sub rules"));
        assert!(segs[2].text.contains("<project-instructions path=\""));
        assert!(
            segs.iter()
                .all(|s| s.kind == SegmentKind::ProjectInstructions)
        );

        std::fs::remove_dir_all(&root).ok();
    }

    /// A directory with no `AGENTS.md` is skipped rather than ending the
    /// walk — the file two levels up still applies.
    #[test]
    fn gaps_in_the_tree_do_not_end_the_walk() {
        let root = temp_dir("gaps");
        let deep = root.join("a").join("b").join("c");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(root.join("AGENTS.md"), "top").unwrap();
        std::fs::write(deep.join("AGENTS.md"), "bottom").unwrap();

        let segs = planted_in(&root, &deep);
        assert_eq!(segs.len(), 2, "found: {segs:?}");
        assert!(segs[0].text.contains("top"));
        assert!(segs[1].text.contains("bottom"));

        std::fs::remove_dir_all(&root).ok();
    }

    /// The old second name is no longer read. Left as a test rather than a
    /// deletion because it is the whole of the migration: a project carrying
    /// only `NIGHTLOOM.md` now silently contributes nothing.
    #[test]
    fn the_old_nightloom_md_name_is_not_read() {
        let root = temp_dir("legacy");
        std::fs::write(root.join("NIGHTLOOM.md"), "legacy rules").unwrap();

        assert!(planted_in(&root, &root).is_empty());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_git_file_worktree_pointer_is_a_root_without_a_branch() {
        let root = temp_dir("worktree");
        std::fs::write(root.join(".git"), "gitdir: /elsewhere/.git/worktrees/w\n").unwrap();

        let info = find_git_repo(&root).expect("repo found");
        assert_eq!(info.root, root);
        assert!(info.branch.is_none());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn oversized_files_are_capped() {
        let root = temp_dir("cap");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join("AGENTS.md"), "é".repeat(FILE_LIMIT)).unwrap();

        let segs = planted_in(&root, &root);
        assert_eq!(segs.len(), 1);
        assert!(segs[0].text.contains("… (truncated)"));
        // The cap is on the file, not the wrapper; a multi-byte cut must land
        // on a char boundary rather than panicking.
        assert!(segs[0].text.len() < FILE_LIMIT * 2);

        std::fs::remove_dir_all(&root).ok();
    }
}
