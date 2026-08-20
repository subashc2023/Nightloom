//! Finding files by name (`glob`) and by contents (`grep`).
//!
//! Both walk the tree with `walkdir` and share one skip list, which is the
//! reason the pattern matching uses `globset` rather than the `glob` crate:
//! `glob` does its own traversal, so it would happily descend into `.git`,
//! and `grep`'s `glob` filter would need a second, differently-behaved
//! matcher. `globset` is a matcher over paths we produce ourselves, so both
//! tools see exactly the same tree with exactly the same glob semantics.

use super::Root;
use globset::{GlobBuilder, GlobMatcher};
use nightloom_core::ToolDef;
use nightloom_core::tool::{Effect, Tool};
use regex::Regex;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use walkdir::{DirEntry, WalkDir};

/// Directories never descended into. Deliberately a short hardcoded list
/// rather than reading `.gitignore`: `.git` is enormous and never what is
/// being looked for, and build/vendor output drowns real matches at a ratio
/// that makes the tools useless. Anything else can be narrowed with the
/// pattern itself.
///
const SKIP_DIRS: [&str; 3] = [".git", "target", "node_modules"];

/// Run artifacts under `.nightloom`, skipped for a different reason than the
/// rest and by **position** rather than by name.
///
/// The reason: the session log holds the conversation, so anything the model
/// says is on disk one turn later and matches its own searches from then on -
/// a live run had `grep alpha` return the transcript of the turn that asked
/// for it. Left in, every search feeds the conversation back to itself and
/// grows the longer the session runs.
///
/// The position: `.nightloom` itself was on the blanket list, which was too
/// wide by exactly one directory. It took `.nightloom/notes` with it, so the
/// docspace -- the one place this project tells the model to leave something
/// for its next self -- was the one place it could not search for it, and the
/// claim that a note needs no retrieval layer because `grep` already reads
/// the folder was false the whole time. Matching on the name alone is too
/// wide the other way: `sessions` and `evals` are ordinary names for ordinary
/// directories in somebody else's repository.
const SKIP_UNDER_NIGHTLOOM: [&str; 3] = ["sessions", "probes", "evals"];

/// Result caps. A tool result is context the model pays for on every
/// subsequent turn, so an unbounded listing is worse than a truncated one.
const MAX_PATHS: usize = 200;
const MAX_MATCH_LINES: usize = 200;
/// Longest single matched line echoed back; minified files are one long line.
const MAX_LINE_CHARS: usize = 300;
/// Files above this are not searched by `grep`. Anything this large is data,
/// not source, and reading it would blow the turn's memory and time budget.
const GREP_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

const GLOB_DESC: &str = "Find files by name pattern, anywhere under a directory. Returns \
     matching file paths, sorted. Use this instead of shelling out to find or ls -R — it is \
     faster, it skips .git, target, node_modules and the session logs under .nightloom, and \
     its output is capped so it cannot flood the conversation. Patterns are glob syntax ('*.rs', 'src/**/test_*.py', \
     'Cargo.toml'); '*' crosses directory separators, so '*.rs' and '**/*.rs' both match at \
     any depth. Only files are returned, never directories.";

const GREP_DESC: &str = "Search file contents with a regular expression. Use this instead of \
     shelling out to grep or rg. Start with the default output_mode of files_with_matches to \
     find where something lives, then read those files or re-run with output_mode 'content' \
     for the matching lines with their line numbers. Narrow a wide search with the glob filter \
     ('*.rs') rather than by grepping the whole tree twice. Binary and non-UTF-8 files are \
     skipped, as are .git, target, node_modules and the session logs under .nightloom.";

fn skipped(entry: &DirEntry) -> bool {
    if entry.depth() == 0 || !entry.file_type().is_dir() {
        return false;
    }
    let Some(name) = entry.file_name().to_str() else {
        return false;
    };
    if SKIP_DIRS.contains(&name) {
        return true;
    }
    SKIP_UNDER_NIGHTLOOM.contains(&name)
        && entry
            .path()
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|parent| parent == ".nightloom")
}

/// Walk `dir`, yielding files only. Symlinks are not followed, which keeps
/// the walk inside the tree without a second containment check per entry.
fn walk_files(dir: &Path) -> impl Iterator<Item = PathBuf> {
    WalkDir::new(dir)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !skipped(e))
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
        .map(DirEntry::into_path)
}

fn matcher(pattern: &str) -> Result<GlobMatcher, String> {
    GlobBuilder::new(pattern)
        // `*` spans separators: a model that writes "*.rs" means "any .rs
        // file", and failing that expectation silently returns nothing.
        .literal_separator(false)
        .build()
        .map(|g| g.compile_matcher())
        .map_err(|e| {
            format!("\"{pattern}\" is not a valid glob pattern: {e}. Use shell glob syntax such as \"*.rs\" or \"src/**/*.ts\".")
        })
}

/// The path a matcher and the model both see: relative to the search root,
/// forward slashes on every platform.
fn relative(base: &Path, path: &Path) -> String {
    path.strip_prefix(base)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

pub struct Glob {
    root: Root,
}

impl Glob {
    pub fn new(root: Root) -> Self {
        Self { root }
    }
}

#[async_trait::async_trait]
impl Tool for Glob {
    fn effect(&self) -> Effect {
        Effect::ReadOnly
    }

    fn def(&self) -> ToolDef {
        ToolDef {
            name: "glob".into(),
            description: GLOB_DESC.into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Glob pattern to match against paths relative to the search directory, e.g. \"**/*.rs\"."
                    },
                    "path": {
                        "type": "string",
                        "description": "Directory to search under, relative to the workspace root. Defaults to the root."
                    }
                },
                "required": ["pattern"]
            }),
        }
    }

    async fn call(&self, input: Value) -> Result<String, String> {
        let pattern = input["pattern"]
            .as_str()
            .ok_or_else(|| "missing required argument: pattern".to_string())?;
        let matcher = matcher(pattern)?;
        let base = self.root.resolve(input["path"].as_str().unwrap_or("."))?;
        if !base.is_dir() {
            return Err(format!("{} is not a directory", self.root.show(&base)));
        }

        let mut hits: Vec<String> = walk_files(&base)
            .map(|p| relative(&base, &p))
            .filter(|rel| matcher.is_match(rel))
            .collect();
        hits.sort();

        if hits.is_empty() {
            return Ok(format!(
                "no files match \"{pattern}\" under {}",
                self.root.show(&base)
            ));
        }
        let total = hits.len();
        hits.truncate(MAX_PATHS);
        let mut out = hits.join("\n");
        if total > MAX_PATHS {
            out.push_str(&format!(
                "\n… {total} files matched; showing the first {MAX_PATHS}. Narrow the pattern."
            ));
        }
        Ok(out)
    }
}

pub struct Grep {
    root: Root,
}

impl Grep {
    pub fn new(root: Root) -> Self {
        Self { root }
    }
}

enum Mode {
    Files,
    Content,
    Count,
}

impl Mode {
    fn parse(raw: Option<&str>) -> Result<Self, String> {
        match raw.unwrap_or("files_with_matches") {
            "files_with_matches" => Ok(Mode::Files),
            "content" => Ok(Mode::Content),
            "count" => Ok(Mode::Count),
            other => Err(format!(
                "output_mode must be \"files_with_matches\", \"content\", or \"count\" (got \"{other}\")"
            )),
        }
    }
}

#[async_trait::async_trait]
impl Tool for Grep {
    fn effect(&self) -> Effect {
        Effect::ReadOnly
    }

    fn def(&self) -> ToolDef {
        ToolDef {
            name: "grep".into(),
            description: GREP_DESC.into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Regular expression to search for."
                    },
                    "path": {
                        "type": "string",
                        "description": "File or directory to search, relative to the workspace root. Defaults to the root."
                    },
                    "glob": {
                        "type": "string",
                        "description": "Only search files whose path matches this glob, e.g. \"*.rs\"."
                    },
                    "output_mode": {
                        "type": "string",
                        "enum": ["files_with_matches", "content", "count"],
                        "description": "files_with_matches (default) lists paths, content lists path:line:text, count lists path:matches."
                    }
                },
                "required": ["pattern"]
            }),
        }
    }

    async fn call(&self, input: Value) -> Result<String, String> {
        let pattern = input["pattern"]
            .as_str()
            .ok_or_else(|| "missing required argument: pattern".to_string())?;
        let regex = Regex::new(pattern).map_err(|e| {
            format!(
                "\"{pattern}\" is not a valid regular expression: {e}. Escape regex \
                 metacharacters such as ( ) [ ] . * + ? | to search for them literally."
            )
        })?;
        let mode = Mode::parse(input["output_mode"].as_str())?;
        let filter = match input["glob"].as_str() {
            Some(g) => Some(matcher(g)?),
            None => None,
        };
        let target = self.root.resolve(input["path"].as_str().unwrap_or("."))?;

        // A single file target is searched directly; the walk's base is then
        // its parent so relative paths still read sensibly.
        let (base, files): (PathBuf, Vec<PathBuf>) = if target.is_file() {
            let parent = target.parent().unwrap_or(&target).to_path_buf();
            (parent, vec![target.clone()])
        } else {
            (target.clone(), walk_files(&target).collect())
        };

        let mut paths: Vec<String> = Vec::new();
        let mut counts: Vec<(String, usize)> = Vec::new();
        let mut lines: Vec<String> = Vec::new();
        let mut truncated_lines = false;

        let mut files = files;
        files.sort();
        for file in files {
            let shown = relative(&base, &file);
            if let Some(filter) = &filter
                && !filter.is_match(&shown)
            {
                continue;
            }
            if std::fs::metadata(&file).map(|m| m.len()).unwrap_or(0) > GREP_MAX_FILE_BYTES {
                continue;
            }
            // Binary / non-UTF-8 files are skipped rather than erroring: a
            // tree always has some, and failing the whole search over one is
            // useless behaviour.
            let Ok(text) = std::fs::read_to_string(&file) else {
                continue;
            };

            let mut count = 0usize;
            for (n, line) in text.lines().enumerate() {
                if !regex.is_match(line) {
                    continue;
                }
                count += 1;
                if matches!(mode, Mode::Content) {
                    if lines.len() < MAX_MATCH_LINES {
                        lines.push(format!("{shown}:{}:{}", n + 1, clip(line)));
                    } else {
                        truncated_lines = true;
                    }
                }
            }
            if count > 0 {
                paths.push(shown.clone());
                counts.push((shown, count));
            }
        }

        if paths.is_empty() {
            return Ok(format!("no matches for \"{pattern}\""));
        }

        Ok(match mode {
            Mode::Files => {
                let total = paths.len();
                paths.truncate(MAX_PATHS);
                let mut out = paths.join("\n");
                if total > MAX_PATHS {
                    out.push_str(&format!(
                        "\n… {total} files matched; showing the first {MAX_PATHS}."
                    ));
                }
                out
            }
            Mode::Count => {
                let total = counts.len();
                counts.truncate(MAX_PATHS);
                let mut out = counts
                    .iter()
                    .map(|(p, c)| format!("{p}:{c}"))
                    .collect::<Vec<_>>()
                    .join("\n");
                if total > MAX_PATHS {
                    out.push_str(&format!(
                        "\n… {total} files matched; showing the first {MAX_PATHS}."
                    ));
                }
                out
            }
            Mode::Content => {
                let mut out = lines.join("\n");
                if truncated_lines {
                    out.push_str(&format!(
                        "\n… more than {MAX_MATCH_LINES} matching lines; narrow the pattern or \
                         the path."
                    ));
                }
                out
            }
        })
    }
}

fn clip(line: &str) -> String {
    if line.chars().count() <= MAX_LINE_CHARS {
        return line.to_string();
    }
    let clipped: String = line.chars().take(MAX_LINE_CHARS).collect();
    format!("{clipped}…")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::test_dir;
    use std::fs;

    fn fixture(name: &str) -> PathBuf {
        let dir = test_dir(name);
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join("src/main.rs"), "fn main() {}\n// TODO: ship\n").unwrap();
        fs::write(dir.join("src/lib.rs"), "// TODO: one\n// TODO: two\n").unwrap();
        fs::write(dir.join("notes.md"), "nothing here\n").unwrap();
        fs::write(dir.join(".git/config"), "// TODO: must not appear\n").unwrap();
        fs::write(dir.join("blob.bin"), [0xff, 0xfe, 0x00, 0x80]).unwrap();
        dir
    }

    #[tokio::test]
    async fn glob_matches_at_any_depth_and_skips_dot_git() {
        let dir = fixture("search-glob");
        let tool = Glob::new(Root::new(&dir));
        let out = tool.call(json!({ "pattern": "*.rs" })).await.unwrap();
        assert_eq!(out, "src/lib.rs\nsrc/main.rs");

        let scoped = tool
            .call(json!({ "pattern": "**/*.md", "path": "." }))
            .await
            .unwrap();
        assert_eq!(scoped, "notes.md");

        let none = tool.call(json!({ "pattern": "*.toml" })).await.unwrap();
        assert!(none.starts_with("no files match"), "{none}");

        let config = tool.call(json!({ "pattern": "config" })).await.unwrap();
        assert!(config.starts_with("no files match"), ".git must be skipped");
        fs::remove_dir_all(&dir).ok();
    }

    /// The docspace is meant to be searchable. `.nightloom` was on the skip
    /// list wholesale, which took `.nightloom/notes` with it — so the one
    /// directory the project tells the model to leave things in was the one
    /// directory it could not search for them in.
    #[tokio::test]
    async fn the_docspace_is_searchable_but_the_session_logs_are_not() {
        let dir = test_dir("search-docspace");
        fs::create_dir_all(dir.join(".nightloom/notes")).unwrap();
        fs::create_dir_all(dir.join(".nightloom/sessions")).unwrap();
        fs::write(
            dir.join(".nightloom/notes/decisions.md"),
            "codeword alpaca\n",
        )
        .unwrap();
        fs::write(dir.join(".nightloom/sessions/a.jsonl"), "codeword alpaca\n").unwrap();

        let found = Grep::new(Root::new(&dir))
            .call(json!({ "pattern": "alpaca" }))
            .await
            .unwrap();
        assert_eq!(found, ".nightloom/notes/decisions.md");

        let listed = Glob::new(Root::new(&dir))
            .call(json!({ "pattern": "*.md" }))
            .await
            .unwrap();
        assert_eq!(listed, ".nightloom/notes/decisions.md");
        fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn glob_rejects_a_bad_pattern_and_an_escaping_path() {
        let dir = fixture("search-glob-err");
        let tool = Glob::new(Root::new(&dir));
        let err = tool.call(json!({ "pattern": "[" })).await.unwrap_err();
        assert!(err.contains("not a valid glob pattern"), "{err}");
        let escape = tool
            .call(json!({ "pattern": "*", "path": "../.." }))
            .await
            .unwrap_err();
        assert!(escape.contains("outside the workspace root"), "{escape}");
        fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn grep_files_with_matches_is_the_default_mode() {
        let dir = fixture("search-grep-files");
        let tool = Grep::new(Root::new(&dir));
        let out = tool.call(json!({ "pattern": "TODO" })).await.unwrap();
        assert_eq!(out, "src/lib.rs\nsrc/main.rs");
        fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn grep_content_mode_reports_path_line_and_text() {
        let dir = fixture("search-grep-content");
        let tool = Grep::new(Root::new(&dir));
        let out = tool
            .call(json!({ "pattern": "TODO: (one|ship)", "output_mode": "content" }))
            .await
            .unwrap();
        assert_eq!(
            out,
            "src/lib.rs:1:// TODO: one\nsrc/main.rs:2:// TODO: ship"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn grep_count_mode_and_glob_filter() {
        let dir = fixture("search-grep-count");
        let tool = Grep::new(Root::new(&dir));
        let out = tool
            .call(json!({ "pattern": "TODO", "output_mode": "count" }))
            .await
            .unwrap();
        assert_eq!(out, "src/lib.rs:2\nsrc/main.rs:1");

        let filtered = tool
            .call(json!({ "pattern": "TODO", "glob": "*main*", "output_mode": "count" }))
            .await
            .unwrap();
        assert_eq!(filtered, "src/main.rs:1");
        fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn grep_skips_binaries_and_reports_no_matches_plainly() {
        let dir = fixture("search-grep-binary");
        let tool = Grep::new(Root::new(&dir));
        // The binary fixture contains 0xfe, which would match as a byte but
        // must never be read as text.
        let out = tool.call(json!({ "pattern": "nowhere" })).await.unwrap();
        assert_eq!(out, "no matches for \"nowhere\"");

        let single = tool
            .call(json!({ "pattern": "TODO", "path": "src/lib.rs", "output_mode": "count" }))
            .await
            .unwrap();
        assert_eq!(single, "lib.rs:2");
        fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn grep_rejects_a_bad_regex_and_a_bad_output_mode() {
        let dir = fixture("search-grep-err");
        let tool = Grep::new(Root::new(&dir));
        let bad_regex = tool.call(json!({ "pattern": "(" })).await.unwrap_err();
        assert!(
            bad_regex.contains("not a valid regular expression"),
            "{bad_regex}"
        );
        let bad_mode = tool
            .call(json!({ "pattern": "x", "output_mode": "lines" }))
            .await
            .unwrap_err();
        assert!(bad_mode.contains("output_mode must be"), "{bad_mode}");
        fs::remove_dir_all(&dir).ok();
    }
}
