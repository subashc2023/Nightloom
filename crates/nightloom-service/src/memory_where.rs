//! "Where in your memory does it say X?" (nightshift backlog 296,
//! 2026-10-04).
//!
//! His ask (2026-10-03): in any chat, ask where a belief lives — the models
//! kept raising terms he no longer cared about — and be pointed at the
//! file and line, to edit or strike it there. This module is the search and
//! the strike; `mcp_server` serves the search to the Claude Code engine as
//! `memory_where`, and the desktop draws each hit under the reply as a link
//! that opens the note editor at that line, with a *Strike* beside it.
//!
//! **Every layer a chat has**, each file marked by how it reaches the
//! model ([`Loading`]):
//!
//! | layer | files | reaches the model |
//! |---|---|---|
//! | User memory | `<config>/AGENTS.md`, `CHAT.md`, `models/*.md` | every chat (CHAT.md: every Chat; a model's file: chats on it) |
//! | Project instructions | every `AGENTS.md` from the workspace up to `/` | every chat in the project |
//! | Project memory | `<workspace>/.agents/memory/**` | on demand (only the index is loaded) |
//! | Thread | `<workspace>/.agents/threads/<slug>/*.md` | the bound thread's `## Start here`: every chat bound to it; the rest on demand |
//! | Project notes | the rest of `<workspace>/.agents/**` | on demand |
//! | Knowledge vault | the vault's notes | on demand |
//! | Claude Code memory | `~/.claude/CLAUDE.md`, every `CLAUDE.md` from the workspace up, `~/.claude/projects/<dir>/memory/` | CLAUDE.md and MEMORY.md: every Claude Code chat; the other memory files on demand |
//!
//! **Matching by meaning, step one (the spec's "start with words plus
//! synonyms the model supplies").** The model passes the user's phrase as
//! `query` and its own paraphrases and related terms as `synonyms` — it is
//! the part that knows "IP terms" and "licensing conditions" are the same
//! belief. Each becomes a *concept*; a line matches a concept when the
//! concept's words appear in it as a phrase, or all of them anywhere in the
//! line, after a light stemmer (`terms` ≈ `term`, `licensing` ≈ `license`).
//! A query of two or more content words also matches a line carrying most
//! of them. No embeddings: the meaning comes from the model's synonyms,
//! and the matcher is exact about words, so a hit is always explainable.
//! A struck line (`~~…~~`) is a superseded belief and is counted, not
//! listed.
//!
//! **The strike** ([`strike_line`]) supersedes, never deletes (practices
//! §1; the dream's rule): the line's text becomes `~~text~~ (struck
//! YYYY-MM-DD)`, its list or heading mark kept outside the strike, so the
//! tidy step (`tidy.rs`) ages it out to `archive/struck/` like any other
//! dated strike. It refuses when the line no longer reads as the hit did
//! (the file changed since the search), and it is allowed only on a file
//! the layer walk names ([`MemoryRoots::owns`]) — a strike is a write, and
//! the path comes from a tool result.
//!
//! Why this is not the retrieval layer `AGENTS.md` refuses: nothing here
//! feeds memory into a conversation. It answers *where*, for the user to
//! read and edit; the chat's own context is unchanged.

use chrono::NaiveDate;
use serde::Serialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::project::{AGENTS_DIR, MEMORY_DIR};
use crate::thread::{THREAD_FILE, THREADS_DIR};

/// The tool's name, and the suffix the desktop looks for in a call's name.
pub const TOOL_NAME: &str = "memory_where";
/// Hits listed at most; past this the reply says how many more matched.
pub const MAX_HITS: usize = 60;
/// Hits listed at most from one file.
pub const MAX_PER_FILE: usize = 12;
/// Files read at most across every layer.
const MAX_FILES: usize = 4_000;
/// A file larger than this is not a note.
const MAX_FILE_BYTES: u64 = 1024 * 1024;
/// How deep a folder walk goes.
const MAX_DEPTH: usize = 8;
/// Characters of a hit's line shown.
const LINE_CHARS: usize = 240;

/// The layers, in the order a reply lists them: what every chat reads
/// first, then what is read on demand.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Layer {
    UserMemory,
    ProjectInstructions,
    ClaudeCode,
    Thread,
    ProjectMemory,
    ProjectNotes,
    Knowledge,
}

impl Layer {
    pub fn label(self) -> &'static str {
        match self {
            Layer::UserMemory => "User memory",
            Layer::ProjectInstructions => "Project instructions",
            Layer::ClaudeCode => "Claude Code memory",
            Layer::Thread => "Thread",
            Layer::ProjectMemory => "Project memory",
            Layer::ProjectNotes => "Project notes",
            Layer::Knowledge => "Knowledge vault",
        }
    }
}

/// How a file — or one line of it — reaches the model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Loading {
    /// Read whole into the prompt of every chat it applies to.
    EveryChat,
    /// Only named in an index; the model reads it with a file tool.
    OnDemand,
}

impl Loading {
    pub fn label(self) -> &'static str {
        match self {
            Loading::EveryChat => "loaded into every chat",
            Loading::OnDemand => "read on demand",
        }
    }
}

/// One file the search reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryFile {
    pub layer: Layer,
    pub path: PathBuf,
    pub loading: Loading,
    /// When only some lines are loaded (a bound thread's Start here): the
    /// 1-based inclusive range, the rest of the file being on demand.
    pub loaded_lines: Option<(usize, usize)>,
    /// A qualifier on `loading`, when "every chat" is narrower than it
    /// sounds: "Chat-kind chats only", "chats on this model".
    pub scope_note: Option<String>,
}

/// Where the layers are. Built from the real locations by
/// [`MemoryRoots::discover`]; tests build one over a fixture.
#[derive(Debug, Clone, Default)]
pub struct MemoryRoots {
    /// Nightloom's config dir (`~/.nightloom`).
    pub config: Option<PathBuf>,
    /// The open project's workspace, if a project is open.
    pub workspace: Option<PathBuf>,
    /// The knowledge vault.
    pub vault: Option<PathBuf>,
    /// The Claude Code CLI's folder (`~/.claude`).
    pub claude: Option<PathBuf>,
    /// The CLI's auto-memory folder for the workspace
    /// (`~/.claude/projects/<dir>/memory`).
    pub claude_memory: Option<PathBuf>,
    /// The research thread the chat is bound to, by slug.
    pub thread: Option<String>,
}

impl MemoryRoots {
    /// The real locations for a config dir and an optional workspace.
    pub fn discover(config: &Path, workspace: Option<PathBuf>) -> Self {
        let claude_memory = workspace
            .as_deref()
            .and_then(crate::agent::cli_session::project_dir)
            .map(|d| d.join("memory"));
        Self {
            config: Some(config.to_path_buf()),
            vault: Some(crate::knowledge::vault_dir_in(config)),
            claude: crate::usage::claude_dir(),
            claude_memory,
            workspace,
            thread: None,
        }
    }

    pub fn with_thread(mut self, slug: Option<String>) -> Self {
        self.thread = slug.filter(|s| !s.trim().is_empty());
        self
    }

    /// Every memory file, layer by layer. Missing files and folders are
    /// skipped; the list says what exists.
    pub fn files(&self) -> Vec<MemoryFile> {
        let mut out: Vec<MemoryFile> = Vec::new();
        let push = |out: &mut Vec<MemoryFile>, f: MemoryFile| {
            if out.len() < MAX_FILES
                && is_note_file(&f.path)
                && !out.iter().any(|o| o.path == f.path)
            {
                out.push(f);
            }
        };
        let file = |layer, path: PathBuf, loading, note: Option<&str>| MemoryFile {
            layer,
            path,
            loading,
            loaded_lines: None,
            scope_note: note.map(str::to_string),
        };

        if let Some(config) = &self.config {
            push(
                &mut out,
                file(
                    Layer::UserMemory,
                    config.join("AGENTS.md"),
                    Loading::EveryChat,
                    None,
                ),
            );
            push(
                &mut out,
                file(
                    Layer::UserMemory,
                    config.join("CHAT.md"),
                    Loading::EveryChat,
                    Some("Chat-kind chats only"),
                ),
            );
            for p in walk(&config.join("models"), 1) {
                push(
                    &mut out,
                    file(
                        Layer::UserMemory,
                        p,
                        Loading::EveryChat,
                        Some("chats on that model only"),
                    ),
                );
            }
        }

        if let Some(ws) = &self.workspace {
            let mut agents: Vec<PathBuf> = ws.ancestors().map(|d| d.join("AGENTS.md")).collect();
            agents.reverse();
            for p in agents {
                push(
                    &mut out,
                    file(Layer::ProjectInstructions, p, Loading::EveryChat, None),
                );
            }
        }

        if let Some(claude) = &self.claude {
            push(
                &mut out,
                file(
                    Layer::ClaudeCode,
                    claude.join("CLAUDE.md"),
                    Loading::EveryChat,
                    Some("Claude Code chats"),
                ),
            );
        }
        if let Some(ws) = &self.workspace {
            let mut walk_up: Vec<PathBuf> = ws.ancestors().map(|d| d.join("CLAUDE.md")).collect();
            walk_up.reverse();
            for p in walk_up {
                push(
                    &mut out,
                    file(
                        Layer::ClaudeCode,
                        p,
                        Loading::EveryChat,
                        Some("Claude Code chats"),
                    ),
                );
            }
        }
        if let Some(mem) = &self.claude_memory {
            for p in walk(mem, 2) {
                let index = p.file_name().is_some_and(|n| n == "MEMORY.md");
                let (loading, note) = if index {
                    (Loading::EveryChat, Some("Claude Code chats"))
                } else {
                    (Loading::OnDemand, None)
                };
                push(&mut out, file(Layer::ClaudeCode, p, loading, note));
            }
        }

        if let Some(ws) = &self.workspace {
            let docspace = ws.join(AGENTS_DIR);
            let memory = docspace.join(MEMORY_DIR);
            let threads = docspace.join(THREADS_DIR);
            let mut thread_files: Vec<MemoryFile> = Vec::new();
            let mut memory_files: Vec<MemoryFile> = Vec::new();
            let mut notes: Vec<MemoryFile> = Vec::new();
            for p in walk(&docspace, MAX_DEPTH) {
                if p.starts_with(&threads) {
                    thread_files.push(self.thread_file(&threads, p));
                } else if p.starts_with(&memory) {
                    memory_files.push(file(Layer::ProjectMemory, p, Loading::OnDemand, None));
                } else {
                    notes.push(file(Layer::ProjectNotes, p, Loading::OnDemand, None));
                }
            }
            for f in thread_files.into_iter().chain(memory_files).chain(notes) {
                push(&mut out, f);
            }
        }

        if let Some(vault) = &self.vault {
            for p in walk(vault, MAX_DEPTH) {
                push(&mut out, file(Layer::Knowledge, p, Loading::OnDemand, None));
            }
        }

        out.sort_by_key(|f| f.layer);
        out
    }

    /// A file under `threads/`: the bound thread's `thread.md` has its Start
    /// here loaded into every chat bound to it; everything else is on demand.
    fn thread_file(&self, threads: &Path, p: PathBuf) -> MemoryFile {
        let slug = p
            .strip_prefix(threads)
            .ok()
            .and_then(|r| r.components().next())
            .map(|c| c.as_os_str().to_string_lossy().into_owned());
        let bound = slug.is_some() && slug == self.thread;
        let is_thread_md = p.file_name().is_some_and(|n| n == THREAD_FILE);
        let loaded_lines = if bound && is_thread_md {
            std::fs::read_to_string(&p)
                .ok()
                .and_then(|t| start_here_range(&t))
        } else {
            None
        };
        MemoryFile {
            layer: Layer::Thread,
            loading: Loading::OnDemand,
            loaded_lines,
            scope_note: loaded_lines.map(|_| "chats bound to this thread".to_string()),
            path: p,
        }
    }

    /// Whether `path` is one of the memory files — the strike's guard.
    pub fn owns(&self, path: &Path) -> bool {
        let Ok(want) = std::fs::canonicalize(path) else {
            return false;
        };
        self.files()
            .iter()
            .any(|f| std::fs::canonicalize(&f.path).is_ok_and(|p| p == want))
    }
}

/// A markdown or text file that exists.
fn is_note_file(p: &Path) -> bool {
    let ext_ok = p
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "md" | "markdown" | "txt"));
    ext_ok && std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.len() <= MAX_FILE_BYTES)
}

/// The note files under `dir`, sorted, `depth` levels deep, skipping hidden
/// folders (`.git`, `.obsidian`) and the tidy step's `archive/` — struck
/// lines moved there are history, not beliefs.
fn walk(dir: &Path, depth: usize) -> Vec<PathBuf> {
    let mut out = Vec::new();
    walk_into(dir, depth, &mut out);
    out.sort();
    out
}

fn walk_into(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth == 0 || out.len() >= MAX_FILES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let name = e.file_name().to_string_lossy().into_owned();
        let Ok(kind) = e.file_type() else { continue };
        if kind.is_dir() {
            if name.starts_with('.') || name == "archive" || name == "node_modules" {
                continue;
            }
            walk_into(&e.path(), depth - 1, out);
        } else if kind.is_file() && is_note_file(&e.path()) {
            out.push(e.path());
        }
    }
}

/// The 1-based inclusive line range of a `## Start here` section.
fn start_here_range(text: &str) -> Option<(usize, usize)> {
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.iter().position(|l| {
        l.trim_start().starts_with("## ") && l.to_lowercase().contains("start here")
    })?;
    let end = lines[start + 1..]
        .iter()
        .position(|l| l.trim_start().starts_with("## "))
        .map(|i| start + i)
        .unwrap_or(lines.len() - 1);
    Some((start + 1, end + 1))
}

// ---- matching ----------------------------------------------------------

const STOPWORDS: &[&str] = &[
    "a", "an", "and", "are", "as", "at", "be", "by", "do", "does", "for", "from", "has", "have",
    "he", "his", "i", "in", "is", "it", "its", "me", "my", "of", "on", "or", "say", "says", "said",
    "she", "that", "the", "their", "them", "there", "this", "to", "was", "we", "what", "where",
    "which", "who", "with", "you", "your", "memory",
];

/// A light stemmer: enough that `terms`/`term`, `licensing`/`license`,
/// `studies`/`study` meet; not a linguistic one.
pub fn stem(word: &str) -> String {
    let w = word.to_lowercase();
    let w = w.trim_end_matches("'s").trim_end_matches('\'').to_string();
    let n = w.chars().count();
    if n <= 3 {
        return w;
    }
    for (suffix, with) in [
        ("ies", "y"),
        ("ing", ""),
        ("ed", ""),
        ("es", ""),
        ("ly", ""),
        ("s", ""),
    ] {
        if let Some(base) = w.strip_suffix(suffix)
            && base.chars().count() >= 3
            && !(suffix == "s" && base.ends_with('s'))
        {
            let mut b = format!("{base}{with}");
            // `licens(ing)` / `licens(ed)` → `licens`; `license` → `licens`.
            if b.ends_with('e') && b.chars().count() > 3 {
                b.pop();
            }
            return b;
        }
    }
    let mut b = w;
    if b.ends_with('e') && n > 3 {
        b.pop();
    }
    b
}

/// The words of a text, lowercased, unstemmed.
fn words(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_alphanumeric() && c != '\'')
        .map(|w| w.trim_matches('\'').to_lowercase())
        .filter(|w| !w.is_empty())
        .collect()
}

/// One phrase to look for: the user's, or one of the model's synonyms.
#[derive(Debug, Clone)]
struct Concept {
    text: String,
    /// The phrase's words, stemmed, stopwords kept (for the phrase test).
    sequence: Vec<String>,
    /// Its content words, stemmed.
    content: Vec<String>,
    from_query: bool,
}

impl Concept {
    fn new(text: &str, from_query: bool) -> Option<Self> {
        let ws = words(text);
        let sequence: Vec<String> = ws.iter().map(|w| stem(w)).collect();
        let content: Vec<String> = ws
            .iter()
            .filter(|w| !STOPWORDS.contains(&w.as_str()))
            .map(|w| stem(w))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        if sequence.is_empty() {
            return None;
        }
        Some(Self {
            text: text.trim().to_string(),
            sequence,
            content,
            from_query,
        })
    }

    /// How strongly a line's stemmed words carry this concept: 3 for the
    /// phrase itself, 2 for all its content words anywhere, 1 for most of a
    /// longer query's, 0 for none.
    fn score(&self, line: &[String]) -> u32 {
        let n = self.sequence.len();
        if n > 0 && line.windows(n).any(|w| w == self.sequence.as_slice()) {
            return if self.from_query { 4 } else { 3 };
        }
        if self.content.is_empty() {
            return 0;
        }
        let have = self.content.iter().filter(|c| line.contains(c)).count();
        if have == self.content.len() {
            return if self.from_query { 3 } else { 2 };
        }
        if self.from_query && self.content.len() >= 3 && have * 3 >= self.content.len() * 2 {
            return 1;
        }
        0
    }
}

/// The query plus the model's synonyms, as concepts.
#[derive(Debug, Clone)]
pub struct Matcher {
    concepts: Vec<Concept>,
}

impl Matcher {
    pub fn new(query: &str, synonyms: &[String]) -> Result<Self, String> {
        let mut concepts: Vec<Concept> = Vec::new();
        if let Some(c) = Concept::new(query, true) {
            concepts.push(c);
        }
        for s in synonyms {
            if let Some(c) = Concept::new(s, false)
                && !concepts.iter().any(|o| o.sequence == c.sequence)
            {
                concepts.push(c);
            }
        }
        if concepts.is_empty() {
            return Err("give a query: the belief to look for, in a few words".into());
        }
        Ok(Self { concepts })
    }

    /// A line's score and the concepts it matched, or `None`.
    pub fn score(&self, line: &str) -> Option<(u32, Vec<String>)> {
        let stems: Vec<String> = words(line).iter().map(|w| stem(w)).collect();
        if stems.is_empty() {
            return None;
        }
        let mut total = 0;
        let mut matched = Vec::new();
        for c in &self.concepts {
            let s = c.score(&stems);
            if s > 0 {
                total += s;
                matched.push(c.text.clone());
            }
        }
        (total > 0).then_some((total, matched))
    }

    /// The synonyms, for the reply's header.
    fn synonyms(&self) -> Vec<&str> {
        self.concepts
            .iter()
            .filter(|c| !c.from_query)
            .map(|c| c.text.as_str())
            .collect()
    }
}

/// Whether a line is wholly struck: its text, past any list or heading
/// mark, is one `~~…~~` span (a date or note may follow it).
pub fn is_struck(line: &str) -> bool {
    let (_, body) = split_mark(line);
    let body = body.trim();
    body.starts_with("~~") && body[2..].contains("~~")
}

// ---- searching ---------------------------------------------------------

/// One place a belief lives.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Hit {
    pub layer: Layer,
    pub path: PathBuf,
    /// 1-based.
    pub line: usize,
    pub text: String,
    pub loading: Loading,
    pub scope_note: Option<String>,
    pub score: u32,
}

/// What a search found.
#[derive(Debug, Clone, Default)]
pub struct Found {
    pub hits: Vec<Hit>,
    /// Matches past the caps, not listed.
    pub more: usize,
    /// Struck lines that matched, not listed.
    pub struck: usize,
    /// Files read, by layer.
    pub files: Vec<(Layer, usize)>,
}

pub fn search(roots: &MemoryRoots, matcher: &Matcher) -> Found {
    let files = roots.files();
    let mut found = Found::default();
    for f in &files {
        match found.files.iter_mut().find(|(l, _)| *l == f.layer) {
            Some((_, n)) => *n += 1,
            None => found.files.push((f.layer, 1)),
        }
    }
    let mut all: Vec<Hit> = Vec::new();
    for f in &files {
        let Ok(text) = std::fs::read_to_string(&f.path) else {
            continue;
        };
        let mut in_file: Vec<Hit> = Vec::new();
        let mut fence = false;
        for (i, line) in text.lines().enumerate() {
            let t = line.trim_start();
            if t.starts_with("```") {
                fence = !fence;
            }
            let Some((score, _)) = matcher.score(line) else {
                continue;
            };
            if !fence && is_struck(line) {
                found.struck += 1;
                continue;
            }
            let n = i + 1;
            let loading = match f.loaded_lines {
                Some((a, b)) if n >= a && n <= b => Loading::EveryChat,
                _ => f.loading,
            };
            in_file.push(Hit {
                layer: f.layer,
                path: f.path.clone(),
                line: n,
                text: clip(line.trim(), LINE_CHARS),
                loading,
                scope_note: if loading == Loading::EveryChat {
                    f.scope_note.clone()
                } else {
                    None
                },
                score,
            });
        }
        in_file.sort_by(|a, b| b.score.cmp(&a.score).then(a.line.cmp(&b.line)));
        if in_file.len() > MAX_PER_FILE {
            found.more += in_file.len() - MAX_PER_FILE;
            in_file.truncate(MAX_PER_FILE);
        }
        in_file.sort_by_key(|h| h.line);
        all.extend(in_file);
    }
    // Keep the strongest across files when over the cap, then list by layer.
    if all.len() > MAX_HITS {
        let mut ranked: Vec<usize> = (0..all.len()).collect();
        ranked.sort_by(|a, b| all[*b].score.cmp(&all[*a].score).then(a.cmp(b)));
        let keep: BTreeSet<usize> = ranked.into_iter().take(MAX_HITS).collect();
        found.more += all.len() - MAX_HITS;
        all = all
            .into_iter()
            .enumerate()
            .filter(|(i, _)| keep.contains(i))
            .map(|(_, h)| h)
            .collect();
    }
    found.hits = all;
    found
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

/// The reply the model reads. Grouped by layer, every hit on its own line
/// as `<path>:<line>: <text>` — the shape the desktop parses
/// ([`parse_reply`]'s twin in `memoryHits.ts`), so keep the two in step.
pub fn render(query: &str, matcher: &Matcher, found: &Found) -> String {
    let mut out = String::new();
    let syn = matcher.synonyms();
    let also = if syn.is_empty() {
        " (no synonyms given — pass `synonyms` to match by meaning, not only these words)"
            .to_string()
    } else {
        format!(" (also searched: {})", syn.join("; "))
    };
    let searched: Vec<String> = found
        .files
        .iter()
        .map(|(l, n)| format!("{} ({n} file{})", l.label(), if *n == 1 { "" } else { "s" }))
        .collect();
    let scope = if searched.is_empty() {
        "no memory files exist for this chat".to_string()
    } else {
        format!("searched {}", searched.join(", "))
    };
    if found.hits.is_empty() {
        out.push_str(&format!(
            "No line in memory matches \"{}\"{also}; {scope}.",
            query.trim()
        ));
        if found.struck > 0 {
            out.push_str(&format!(
                " {} struck (superseded) line{} matched and {} not listed.",
                found.struck,
                if found.struck == 1 { "" } else { "s" },
                if found.struck == 1 { "is" } else { "are" }
            ));
        }
        out.push_str(
            " If the belief came from somewhere else — this conversation, a file you read, \
             or your own training — say so rather than pointing at memory.",
        );
        return out;
    }
    let n = found.hits.len();
    out.push_str(&format!(
        "{n} place{} in memory match \"{}\"{also}; {scope}.",
        if n == 1 { "" } else { "s" },
        query.trim()
    ));
    if found.more > 0 {
        out.push_str(&format!(
            " {} weaker match{} not listed; narrow the query to see them.",
            found.more,
            if found.more == 1 { "" } else { "es" }
        ));
    }
    if found.struck > 0 {
        out.push_str(&format!(
            " {} already-struck line{} also matched (not listed).",
            found.struck,
            if found.struck == 1 { "" } else { "s" }
        ));
    }
    out.push_str(
        "\nIn your reply, name each place you mean as its path:line exactly as written below. \
         The user sees every hit as a link that opens the file at that line, with a Strike \
         action; do not edit or strike memory yourself unless asked.\n",
    );
    // Grouped by layer and by how the lines reach the model; a qualifier on
    // "every chat" goes in the heading, so a hit line is only the line.
    let mut last: Option<(Layer, Loading, Option<String>)> = None;
    let mut hits: Vec<&Hit> = found.hits.iter().collect();
    hits.sort_by_key(|h| {
        (
            h.layer,
            h.loading != Loading::EveryChat,
            h.scope_note.clone(),
        )
    });
    for h in hits {
        let key = (h.layer, h.loading, h.scope_note.clone());
        if last.as_ref() != Some(&key) {
            let note = h
                .scope_note
                .as_deref()
                .map(|s| format!(" ({s})"))
                .unwrap_or_default();
            out.push_str(&format!(
                "\n## {} — {}{note}\n",
                h.layer.label(),
                h.loading.label()
            ));
            last = Some(key);
        }
        out.push_str(&format!("{}:{}: {}\n", h.path.display(), h.line, h.text));
    }
    out
}

/// Read a hit line back out of a reply: `(path, line, text)`. The twin of
/// the desktop's parser, kept here so a test pins the shape both read.
pub fn parse_hit_line(line: &str) -> Option<(String, usize, String)> {
    let re = regex::Regex::new(r"^(.+?):(\d+): (.*)$").ok()?;
    let c = re.captures(line)?;
    let path = c.get(1)?.as_str();
    if !(path.starts_with('/') || path.chars().nth(1) == Some(':')) {
        return None;
    }
    Some((
        path.to_string(),
        c.get(2)?.as_str().parse().ok()?,
        c.get(3)?.as_str().to_string(),
    ))
}

// ---- the strike --------------------------------------------------------

/// A line's leading mark — indentation, list bullet, checkbox, number,
/// heading hashes, quote — and the rest.
fn split_mark(line: &str) -> (&str, &str) {
    let re = mark_re();
    let end = re.find(line).map(|m| m.end()).unwrap_or(0);
    line.split_at(end)
}

fn mark_re() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(
            r"^\s*(?:(?:[-*+]\s+(?:\[[ xX]\]\s+)?)|(?:\d+[.)]\s+)|(?:#{1,6}\s+)|(?:>\s*))*",
        )
        .expect("valid regex")
    })
}

/// The struck form of one line: `- ~~text~~ (struck 2026-10-04)`.
pub fn struck_text(line: &str, date: NaiveDate) -> Result<String, String> {
    let (mark, body) = split_mark(line);
    let body = body.trim_end();
    if body.trim().is_empty() {
        return Err("that line is blank; there is nothing to strike".into());
    }
    if is_struck(line) {
        return Err("that line is already struck".into());
    }
    if body.contains("~~") {
        return Err(
            "that line already has a strike inside it; open it in the editor and strike the part you mean"
                .into(),
        );
    }
    Ok(format!(
        "{mark}~~{body}~~ (struck {})",
        date.format("%Y-%m-%d")
    ))
}

/// Strike line `line` (1-based) of `path`, provided it still reads as
/// `expected` (trimmed) — the file may have changed since the search.
/// Every other byte of the file is kept, line endings included. Returns the
/// new line.
pub fn strike_line(
    path: &Path,
    line: usize,
    expected: &str,
    date: NaiveDate,
) -> Result<String, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let mut parts: Vec<&str> = text.split_inclusive('\n').collect();
    if line == 0 || line > parts.len() {
        return Err(format!(
            "{} has {} lines, not {line}; search again",
            path.display(),
            parts.len()
        ));
    }
    let raw = parts[line - 1];
    let ending = if raw.ends_with("\r\n") {
        "\r\n"
    } else if raw.ends_with('\n') {
        "\n"
    } else {
        ""
    };
    let current = &raw[..raw.len() - ending.len()];
    let want = expected.trim().trim_end_matches('…');
    if !current.trim().starts_with(want) || want.is_empty() {
        return Err(format!(
            "line {line} of {} no longer reads as it did when searched; search again",
            path.display()
        ));
    }
    let new = struck_text(current, date)?;
    let replaced = format!("{new}{ending}");
    parts[line - 1] = &replaced;
    let out: String = parts.concat();
    std::fs::write(path, out).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    Ok(new)
}

// ---- the editor a hit opens in -----------------------------------------

/// The note editor's scope and name for a memory file — the desktop's
/// `NoteScope` spelling — or `None` for a file the editor does not reach
/// (an `AGENTS.md` above the workspace, Claude Code's files), which the
/// desktop opens as a file instead.
pub fn note_for(
    path: &Path,
    config: Option<&Path>,
    workspace: Option<&Path>,
    vault: Option<&Path>,
) -> Option<(&'static str, String)> {
    let canon = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let path = canon(path);
    let rel = |dir: &Path| -> Option<String> {
        let r = path.strip_prefix(canon(dir)).ok()?;
        let s = r.to_string_lossy().replace('\\', "/");
        (!s.is_empty()).then_some(s)
    };
    if let Some(config) = config {
        if path == canon(&config.join("AGENTS.md")) {
            return Some(("memory", "AGENTS.md".into()));
        }
        if path == canon(&config.join("CHAT.md")) {
            return Some(("chat", "CHAT.md".into()));
        }
        if let Some(name) = rel(&config.join("models"))
            && !name.contains('/')
        {
            return Some(("models", name));
        }
    }
    if let Some(ws) = workspace {
        if path == canon(&ws.join("AGENTS.md")) {
            return Some(("instructions", "AGENTS.md".into()));
        }
        if let Some(name) = rel(&ws.join(AGENTS_DIR)) {
            return Some(("project", name));
        }
    }
    if let Some(vault) = vault
        && let Some(name) = rel(vault)
    {
        return Some(("knowledge", name));
    }
    None
}

// ---- the tool ----------------------------------------------------------

/// `memory_where`, for the MCP server.
pub struct MemoryWhere {
    roots: MemoryRoots,
}

impl MemoryWhere {
    pub fn new(roots: MemoryRoots) -> Self {
        Self { roots }
    }
}

#[async_trait::async_trait]
impl nightloom_core::tool::Tool for MemoryWhere {
    fn effect(&self) -> nightloom_core::tool::Effect {
        nightloom_core::tool::Effect::ReadOnly
    }

    fn def(&self) -> nightloom_core::ToolDef {
        nightloom_core::ToolDef {
            name: TOOL_NAME.into(),
            description: "Find where in the user's memory a belief or instruction lives — use it \
                 when the user asks where memory says something, why you keep raising something, \
                 or which file a rule comes from. Searches every memory layer this chat has \
                 (user memory, project AGENTS.md files, Claude Code's CLAUDE.md and memory, \
                 the project's .agents/memory and notes, research threads, the knowledge vault) \
                 and returns path:line hits grouped by layer, each marked loaded into every chat \
                 or read on demand. Matching is by words: put the user's phrase in `query` and \
                 your own paraphrases and related terms in `synonyms` so lines that say the same \
                 thing in other words are found. Quote hits as path:line; the user can open and \
                 strike them from your reply."
                .into(),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "The belief to look for, in the user's words." },
                    "synonyms": {
                        "type": "array", "items": { "type": "string" },
                        "description": "Paraphrases and related terms (3–8 short phrases): other ways a note might say the same thing."
                    },
                    "thread": { "type": "string", "description": "The slug of the research thread this chat is bound to, if any (from the <thread slug=…> tag), so its Start here is marked as loaded." }
                },
                "required": ["query"]
            }),
        }
    }

    async fn call(
        &self,
        input: serde_json::Value,
        _cancel: &nightloom_core::tool::CancellationToken,
    ) -> Result<String, String> {
        let query = input["query"].as_str().unwrap_or("").to_string();
        let synonyms: Vec<String> = input["synonyms"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let thread = input["thread"].as_str().map(str::to_string);
        let matcher = Matcher::new(&query, &synonyms)?;
        let roots = self.roots.clone().with_thread(thread);
        // A walk of a few thousand small files: off the async thread.
        let found = tokio::task::spawn_blocking(move || {
            let f = search(&roots, &matcher);
            (f, matcher)
        })
        .await
        .map_err(|e| e.to_string())?;
        Ok(render(&query, &found.1, &found.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nightloom_core::tool::Tool;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nightloom-memwhere-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(p: &Path, text: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    /// A fixture with one file in every layer; never the real home.
    fn fixture() -> (PathBuf, MemoryRoots) {
        let root = scratch();
        let config = root.join("config");
        let ws = root.join("work/proj");
        let vault = root.join("vault");
        let claude = root.join("claude");
        let claude_memory = claude.join("projects/-work-proj/memory");
        write(
            &config.join("AGENTS.md"),
            "# Me\n- Always mention Stuart's IP terms when discussing the paper.\n- Be terse.\n",
        );
        write(&config.join("models/opus.md"), "Prefer tables.\n");
        write(
            &ws.join("AGENTS.md"),
            "Project rules.\nLicensing conditions from Stuart apply to every release.\n",
        );
        write(
            &ws.join(".agents/memory/stuart.md"),
            "Stuart's intellectual property terms: shared rights.\n~~Stuart IP terms bind the code~~ (struck 2026-09-01)\n",
        );
        write(&ws.join(".agents/notes.md"), "Nothing about it here.\n");
        write(
            &ws.join(".agents/threads/ace/thread.md"),
            "# ACE\n## Start here\nThe IP terms matter for ACE.\n## Queue\n- check IP terms again\n",
        );
        write(
            &ws.join(".agents/threads/other/thread.md"),
            "## Start here\nIP terms elsewhere.\n",
        );
        write(
            &vault.join("people/stuart.md"),
            "Stuart: advisor. IP terms negotiated in May.\n",
        );
        write(&vault.join("archive/struck/old.md"), "IP terms old.\n");
        write(&claude.join("CLAUDE.md"), "Mind the IP terms.\n");
        write(&claude_memory.join("MEMORY.md"), "- [ip](ip.md) IP terms\n");
        write(&claude_memory.join("ip.md"), "Stuart IP terms detail.\n");
        let roots = MemoryRoots {
            config: Some(config),
            workspace: Some(ws),
            vault: Some(vault),
            claude: Some(claude),
            claude_memory: Some(claude_memory),
            thread: Some("ace".into()),
        };
        (root, roots)
    }

    #[test]
    fn stems_meet_across_inflections() {
        assert_eq!(stem("terms"), stem("term"));
        assert_eq!(stem("licensing"), stem("license"));
        assert_eq!(stem("licensed"), stem("license"));
        assert_eq!(stem("studies"), stem("study"));
        assert_eq!(stem("ip"), "ip");
        assert_eq!(stem("Stuart's"), "stuart");
    }

    #[test]
    fn words_match_as_words_not_substrings() {
        let m = Matcher::new("IP", &[]).unwrap();
        assert!(m.score("zip the file").is_none());
        assert!(m.score("the IP terms").is_some());
    }

    #[test]
    fn synonyms_find_a_line_in_other_words() {
        let m = Matcher::new("Stuart IP terms", &[]).unwrap();
        assert!(m.score("Licensing conditions from Stuart apply").is_none());
        let m = Matcher::new("Stuart IP terms", &["licensing conditions".into()]).unwrap();
        assert!(m.score("Licensing conditions from Stuart apply").is_some());
    }

    #[test]
    fn every_layer_is_searched_and_marked() {
        let (_root, roots) = fixture();
        let m = Matcher::new(
            "Stuart IP terms",
            &[
                "intellectual property".into(),
                "licensing conditions".into(),
            ],
        )
        .unwrap();
        let found = search(&roots, &m);
        let layers: BTreeSet<Layer> = found.hits.iter().map(|h| h.layer).collect();
        for l in [
            Layer::UserMemory,
            Layer::ProjectInstructions,
            Layer::ClaudeCode,
            Layer::Thread,
            Layer::ProjectMemory,
            Layer::Knowledge,
        ] {
            assert!(layers.contains(&l), "{l:?} missing from {:?}", found.hits);
        }
        let user = found
            .hits
            .iter()
            .find(|h| h.layer == Layer::UserMemory)
            .unwrap();
        assert_eq!(user.loading, Loading::EveryChat);
        assert_eq!(user.line, 2);
        let mem = found
            .hits
            .iter()
            .find(|h| h.layer == Layer::ProjectMemory)
            .unwrap();
        assert_eq!(mem.loading, Loading::OnDemand);
        // The struck line is counted, not listed; the archive is not read.
        assert_eq!(found.struck, 1);
        assert!(
            !found
                .hits
                .iter()
                .any(|h| h.path.to_string_lossy().contains("archive"))
        );
        // Bound thread: Start here loaded, Queue on demand; the other thread on demand.
        let ace: Vec<&Hit> = found
            .hits
            .iter()
            .filter(|h| h.path.to_string_lossy().contains("threads/ace"))
            .collect();
        assert_eq!(ace.len(), 2);
        assert_eq!(ace[0].loading, Loading::EveryChat);
        assert_eq!(ace[1].loading, Loading::OnDemand);
        let other = found
            .hits
            .iter()
            .find(|h| h.path.to_string_lossy().contains("threads/other"))
            .unwrap();
        assert_eq!(other.loading, Loading::OnDemand);
        // Claude Code: MEMORY.md loaded, the detail file on demand.
        let idx = found
            .hits
            .iter()
            .find(|h| h.path.ends_with("MEMORY.md"))
            .unwrap();
        assert_eq!(idx.loading, Loading::EveryChat);
        let detail = found
            .hits
            .iter()
            .find(|h| h.path.ends_with("ip.md"))
            .unwrap();
        assert_eq!(detail.loading, Loading::OnDemand);
    }

    #[test]
    fn the_reply_groups_by_layer_and_parses_back() {
        let (_root, roots) = fixture();
        let m = Matcher::new("Stuart IP terms", &["intellectual property".into()]).unwrap();
        let found = search(&roots, &m);
        let text = render("Stuart IP terms", &m, &found);
        assert!(text.contains("## User memory — loaded into every chat"));
        assert!(text.contains("## Project memory — read on demand"));
        assert!(text.contains("also searched: intellectual property"));
        let parsed: Vec<_> = text.lines().filter_map(parse_hit_line).collect();
        assert_eq!(parsed.len(), found.hits.len());
        for (path, line, text) in &parsed {
            assert!(
                found
                    .hits
                    .iter()
                    .any(|h| h.path.display().to_string() == *path
                        && h.line == *line
                        && h.text == *text),
                "{path}:{line} not a hit"
            );
        }
    }

    #[test]
    fn an_empty_result_names_its_scope() {
        let (_root, roots) = fixture();
        let m = Matcher::new("quantum gravity", &[]).unwrap();
        let text = render("quantum gravity", &m, &search(&roots, &m));
        assert!(text.starts_with("No line in memory matches"));
        assert!(text.contains("User memory (2 files)"), "{text}");
        assert!(text.contains("pass `synonyms`"));
    }

    #[test]
    fn strike_supersedes_with_a_date_and_keeps_the_mark() {
        let d = NaiveDate::from_ymd_opt(2026, 10, 4).unwrap();
        assert_eq!(
            struck_text("- Always mention IP terms.", d).unwrap(),
            "- ~~Always mention IP terms.~~ (struck 2026-10-04)"
        );
        assert_eq!(
            struck_text("  - [ ] todo item", d).unwrap(),
            "  - [ ] ~~todo item~~ (struck 2026-10-04)"
        );
        assert_eq!(
            struck_text("## A heading", d).unwrap(),
            "## ~~A heading~~ (struck 2026-10-04)"
        );
        assert_eq!(
            struck_text("plain", d).unwrap(),
            "~~plain~~ (struck 2026-10-04)"
        );
        assert!(struck_text("   ", d).is_err());
        assert!(struck_text("- ~~old~~ (struck 2026-01-01)", d).is_err());
        assert!(struck_text("half ~~struck~~ line", d).is_err());
    }

    #[test]
    fn strike_line_changes_one_line_and_nothing_else() {
        let root = scratch();
        let p = root.join("AGENTS.md");
        std::fs::write(&p, "# Me\r\n- Always mention IP terms.\r\n- Be terse.").unwrap();
        let d = NaiveDate::from_ymd_opt(2026, 10, 4).unwrap();
        let new = strike_line(&p, 2, "- Always mention IP terms.", d).unwrap();
        assert_eq!(new, "- ~~Always mention IP terms.~~ (struck 2026-10-04)");
        assert_eq!(
            std::fs::read_to_string(&p).unwrap(),
            "# Me\r\n- ~~Always mention IP terms.~~ (struck 2026-10-04)\r\n- Be terse."
        );
        // The last line, no newline after it.
        strike_line(&p, 3, "- Be terse.", d).unwrap();
        assert!(
            std::fs::read_to_string(&p)
                .unwrap()
                .ends_with("(struck 2026-10-04)")
        );
        // A line that moved is refused, and the file is untouched.
        let before = std::fs::read_to_string(&p).unwrap();
        assert!(strike_line(&p, 1, "- Always mention IP terms.", d).is_err());
        assert!(strike_line(&p, 9, "x", d).is_err());
        assert_eq!(std::fs::read_to_string(&p).unwrap(), before);
    }

    #[test]
    fn a_clipped_hit_still_strikes() {
        let root = scratch();
        let p = root.join("n.md");
        let long = "word ".repeat(80);
        std::fs::write(&p, format!("{long}\n")).unwrap();
        let shown = clip(long.trim(), LINE_CHARS);
        assert!(shown.ends_with('…'));
        let d = NaiveDate::from_ymd_opt(2026, 10, 4).unwrap();
        assert!(strike_line(&p, 1, &shown, d).is_ok());
    }

    #[test]
    fn owns_only_the_layer_files() {
        let (root, roots) = fixture();
        assert!(roots.owns(&roots.config.clone().unwrap().join("AGENTS.md")));
        assert!(
            roots.owns(
                &roots
                    .workspace
                    .clone()
                    .unwrap()
                    .join(".agents/memory/stuart.md")
            )
        );
        let outside = root.join("elsewhere.md");
        write(&outside, "IP terms\n");
        assert!(!roots.owns(&outside));
        assert!(!roots.owns(&root.join("missing.md")));
    }

    #[test]
    fn a_hit_opens_in_the_note_editor_where_it_can() {
        let (_root, roots) = fixture();
        let config = roots.config.clone().unwrap();
        let ws = roots.workspace.clone().unwrap();
        let vault = roots.vault.clone().unwrap();
        let at = |p: PathBuf| note_for(&p, Some(&config), Some(&ws), Some(&vault));
        assert_eq!(
            at(config.join("AGENTS.md")),
            Some(("memory", "AGENTS.md".into()))
        );
        assert_eq!(
            at(config.join("models/opus.md")),
            Some(("models", "opus.md".into()))
        );
        assert_eq!(
            at(ws.join("AGENTS.md")),
            Some(("instructions", "AGENTS.md".into()))
        );
        assert_eq!(
            at(ws.join(".agents/memory/stuart.md")),
            Some(("project", "memory/stuart.md".into()))
        );
        assert_eq!(
            at(vault.join("people/stuart.md")),
            Some(("knowledge", "people/stuart.md".into()))
        );
        assert_eq!(at(roots.claude.clone().unwrap().join("CLAUDE.md")), None);
    }

    #[tokio::test]
    async fn the_tool_answers_through_its_schema() {
        let (_root, roots) = fixture();
        let tool = MemoryWhere::new(roots);
        assert_eq!(tool.def().name, TOOL_NAME);
        let out = tool
            .call(
                serde_json::json!({ "query": "IP terms", "synonyms": ["intellectual property"], "thread": "ace" }),
                &nightloom_core::tool::CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(out.contains("## Thread — loaded into every chat"), "{out}");
        assert!(
            tool.call(
                serde_json::json!({}),
                &nightloom_core::tool::CancellationToken::new()
            )
            .await
            .is_err()
        );
    }
}
