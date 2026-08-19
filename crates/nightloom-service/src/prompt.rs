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

use std::path::{Path, PathBuf};

use nightloom_core::{Segment, SegmentKind, SystemPrompt};

/// Built-in behavioural instructions, used unless a shell turns identity off.
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
    if let Some(shell) = host_shell() {
        lines.push(format!("shell: {shell}"));
    }
    if let Some(git) = find_git_repo(cwd) {
        lines.push(format!("git repo: {}", git.root.display()));
        if let Some(branch) = git.branch {
            lines.push(format!("git branch: {branch}"));
        }
    }

    let text = format!("<environment>\n{}\n</environment>", lines.join("\n"));
    Segment::new(SegmentKind::Environment, "environment", text)
}

fn host_shell() -> Option<String> {
    if cfg!(windows) {
        // `ComSpec` is pinned to cmd.exe on every Windows box regardless of
        // what the user actually runs, so it can't answer this on its own.
        // `PSModulePath` is set by PowerShell and not by cmd, which makes it
        // the better tell.
        if std::env::var_os("PSModulePath").is_some() {
            return Some("powershell".to_string());
        }
        std::env::var("ComSpec").ok().filter(|s| !s.is_empty())
    } else {
        std::env::var("SHELL").ok().filter(|s| !s.is_empty())
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
pub fn project_notes_segment(project: &ProjectContext) -> Segment {
    let notes = crate::project::list_notes(&project.notes_dir);
    let name = &project.name;
    let dir = project.notes_dir.display();

    let mut text = format!(
        "<project-notes project=\"{name}\" dir=\"{dir}\">
"
    );
    text.push_str(
        "Shared notes for this project. Every conversation in it sees this index,          and anything written here reaches later conversations — this is where to          leave something for your next self.

         Read one with read_file and add or revise one with write_file / edit_file,          using paths under the directory above. Only this index is loaded          automatically; the contents are not.

         Worth writing down: a task list that outlives one conversation, a decision          and why it was made, a map of something that took real work to figure out.          Not worth writing down: anything already obvious from the code, or a          summary of what you just said. Revise a stale note rather than adding a          second one beside it — a wrong note costs more than a missing one.
",
    );
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
