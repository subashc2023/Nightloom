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

/// Instruction files honoured in every directory on the walk, in the order
/// they are read within a directory.
const INSTRUCTION_FILES: [&str; 2] = ["NIGHTLOOM.md", "AGENTS.md"];

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
    /// Discover and include NIGHTLOOM.md / AGENTS.md up the tree.
    pub project_instructions: bool,
    /// Include the user's standing preferences file.
    pub user_memory: bool,
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
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            custom: None,
        }
    }
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

/// Outermost-first.
///
/// The walk stops at the repository root when there is one: instruction files
/// above it belong to whatever unrelated tree the repo happens to be checked
/// out into, not to this project.
pub fn project_instruction_segments(cwd: &Path) -> Vec<Segment> {
    let stop_at = find_git_repo(cwd).map(|g| g.root);
    let mut by_dir: Vec<Vec<Segment>> = Vec::new();

    for dir in cwd.ancestors() {
        let mut here = Vec::new();
        for name in INSTRUCTION_FILES {
            let path = dir.join(name);
            let Some(content) = read_capped(&path) else {
                continue;
            };
            let display = path.display();
            let text = format!(
                "<project-instructions path=\"{display}\">\n{content}\n</project-instructions>"
            );
            here.push(Segment::new(
                SegmentKind::ProjectInstructions,
                display.to_string(),
                text,
            ));
        }
        by_dir.push(here);
        if stop_at.as_deref() == Some(dir) {
            break;
        }
    }

    // Directories were visited innermost-first; the most specific ones must
    // land last so they read as refining the ones above. Within a directory
    // the declared file order stands.
    by_dir.into_iter().rev().flatten().collect()
}

pub fn user_memory_segment() -> Option<Segment> {
    let home = std::env::var("HOME")
        .ok()
        .filter(|h| !h.is_empty())
        .or_else(|| std::env::var("USERPROFILE").ok().filter(|h| !h.is_empty()))?;
    let content = read_capped(&Path::new(&home).join(".nightloom").join("NIGHTLOOM.md"))?;
    Some(Segment::new(
        SegmentKind::UserMemory,
        "user-memory",
        format!("<user-instructions>\n{content}\n</user-instructions>"),
    ))
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
            cwd,
            custom: None,
        }
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

    #[test]
    fn instructions_are_outermost_first_and_stop_at_the_repo_root() {
        let root = temp_dir("walk");
        let repo = root.join("repo");
        let sub = repo.join("sub");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(root.join("NIGHTLOOM.md"), "above the repo").unwrap();
        std::fs::write(repo.join("NIGHTLOOM.md"), "repo rules").unwrap();
        std::fs::write(sub.join("AGENTS.md"), "sub rules").unwrap();

        let segs = project_instruction_segments(&sub);
        assert_eq!(segs.len(), 2, "found: {:?}", segs);
        assert!(segs[0].text.contains("repo rules"));
        assert!(segs[1].text.contains("sub rules"));
        assert!(segs[1].text.contains("<project-instructions path=\""));
        assert!(segs.iter().all(|s| !s.text.contains("above the repo")));
        assert!(
            segs.iter()
                .all(|s| s.kind == SegmentKind::ProjectInstructions)
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn both_instruction_files_in_one_directory_are_read() {
        let root = temp_dir("both");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join("NIGHTLOOM.md"), "primary").unwrap();
        std::fs::write(root.join("AGENTS.md"), "secondary").unwrap();

        let segs = project_instruction_segments(&root);
        assert_eq!(segs.len(), 2);
        assert!(segs[0].text.contains("primary"));
        assert!(segs[1].text.contains("secondary"));

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
        std::fs::write(root.join("NIGHTLOOM.md"), "é".repeat(FILE_LIMIT)).unwrap();

        let segs = project_instruction_segments(&root);
        assert_eq!(segs.len(), 1);
        assert!(segs[0].text.contains("… (truncated)"));
        // The cap is on the file, not the wrapper; a multi-byte cut must land
        // on a char boundary rather than panicking.
        assert!(segs[0].text.len() < FILE_LIMIT * 2);

        std::fs::remove_dir_all(&root).ok();
    }
}
