//! The knowledge vault: what the *user* knows, as against what a folder
//! contains.
//!
//! `~/.nightloom/AGENTS.md` is user memory — how you want the model to behave —
//! and this is its other half: what you know. The two sit together because
//! both are about the person rather than about a location on disk, and that is
//! precisely what the docspace at `<workspace>/.agents` cannot be. A note that
//! describes this codebase belongs with the codebase, where a teammate reads it
//! and a diff reviews it; a decision made two projects ago, a person, a
//! technique, a conclusion that stays true after this folder is closed has
//! nowhere to go — filed under `.agents` it is invisible from every other
//! project and gets committed to somebody's repository, and left in a chat it
//! is gone when the chat scrolls off.
//!
//! So: one vault, reachable from every project **and from a chat with no
//! project at all**, which is the case the docspace can never serve.
//!
//! ```text
//! ~/.nightloom/AGENTS.md       user memory   (how I want you to behave)
//! ~/.nightloom/knowledge/      the vault     (what I know)
//! ~/.nightloom/knowledge.json  where it is, when it is somewhere else
//! ```
//!
//! **Nothing here stores a note.** [`crate::project::list_notes`] and its
//! siblings already take the directory as a parameter, so the whole storage
//! layer — the walk, the summaries, the `Root`-based containment on a note
//! name — works on the vault unchanged. What this module adds is the two
//! things a vault has and a docspace does not: a location of its own, and
//! links between its notes.
//!
//! The location is a **separate file** rather than a field in `projects.json`,
//! because that file is a list of projects and a vault belongs to none of them.
//! Repointing it **moves nothing**: aiming at a folder is not a migration, and
//! silently relocating somebody's vault because they changed a setting would be
//! indefensible. Which is also what makes an existing Obsidian vault usable —
//! point at it and it is the vault, with its own files exactly where they were.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::project::{self, Note};

/// The vault's directory under the config dir, when it has not been repointed.
pub const VAULT_DIR: &str = "knowledge";
/// Where a repointed location is recorded, beside `projects.json`.
const LOCATION_FILE: &str = "knowledge.json";

/// Bytes read from one note when scanning it for links.
///
/// A vault is markdown, and something far past this is a file that was dropped
/// in the folder rather than written in it. Skipping it costs its links and
/// keeps a stray database dump from being parsed as prose.
const LINK_SCAN_LIMIT: u64 = 256 * 1024;

// ---- where the vault is ----

#[derive(Serialize, Deserialize)]
struct LocationFile {
    #[serde(default = "schema_version")]
    version: u32,
    /// Absent means the default. Recorded as the user typed it rather than
    /// canonicalized, so a path on a drive that is not mounted today survives
    /// being read and written back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dir: Option<PathBuf>,
}

fn schema_version() -> u32 {
    1
}

/// Where the vault is, or `None` when there is no user config dir at all —
/// a stripped environment with no `HOME`, which reads as "no vault" the same
/// way it reads as "no user memory".
pub fn vault_dir() -> Option<PathBuf> {
    project::config_dir().map(|config| vault_dir_in(&config))
}

/// The default location for a given config dir: `<config>/knowledge`.
pub fn default_vault_dir_in(config: &Path) -> PathBuf {
    config.join(VAULT_DIR)
}

/// The vault for a given config dir — the override if one is recorded, else
/// the default.
///
/// An unreadable or unparseable `knowledge.json` falls back to the default
/// rather than erroring, on [`crate::project::Registry`]'s argument: a
/// malformed settings file should cost the setting, not the feature.
pub fn vault_dir_in(config: &Path) -> PathBuf {
    read_location(config).unwrap_or_else(|| default_vault_dir_in(config))
}

/// Whether the vault is where it would be with nothing configured. The UI says
/// so, and it is what a "Reset to default" control switches off.
pub fn is_default_location_in(config: &Path) -> bool {
    read_location(config).is_none()
}

fn read_location(config: &Path) -> Option<PathBuf> {
    let text = fs::read_to_string(config.join(LOCATION_FILE)).ok()?;
    let parsed: LocationFile = serde_json::from_str(&text).ok()?;
    parsed.dir.filter(|d| !d.as_os_str().is_empty())
}

/// Point the vault at `dir`, or back at the default with `None`.
///
/// Writes only the location. The old directory and the new one are both left
/// exactly as they are — see the module note on why this is not a migration.
pub fn set_vault_dir(dir: Option<&Path>) -> Result<(), String> {
    let config = project::config_dir()
        .ok_or_else(|| "no user config directory to record it in".to_string())?;
    set_vault_dir_in(&config, dir)
}

pub fn set_vault_dir_in(config: &Path, dir: Option<&Path>) -> Result<(), String> {
    let path = config.join(LOCATION_FILE);
    // Back to the default is the absence of the file, not a file saying
    // "default" — one shape for one state, and nothing to migrate later.
    let Some(dir) = dir else {
        return match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("cannot clear {}: {e}", path.display())),
        };
    };
    if dir.as_os_str().is_empty() {
        return Err("the knowledge folder cannot be empty".to_string());
    }
    fs::create_dir_all(config).map_err(|e| format!("cannot create {}: {e}", config.display()))?;
    let file = LocationFile {
        version: schema_version(),
        dir: Some(project::normalize(dir)),
    };
    let text = serde_json::to_string_pretty(&file)
        .map_err(|e| format!("cannot encode the knowledge location: {e}"))?;
    fs::write(&path, text).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

// ---- links ----

/// One `[[wikilink]]` found in a note.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Link {
    /// What was written between the brackets, before any `|`, with a `#anchor`
    /// kept: it is part of what the user typed and the UI shows it.
    pub target: String,
    /// The display text after a `|`, when there was one.
    pub alias: Option<String>,
}

impl Link {
    /// The part of `target` that names a note, with any `#heading` dropped.
    pub fn note_target(&self) -> &str {
        match self.target.split_once('#') {
            Some((before, _)) if !before.is_empty() => before,
            _ => &self.target,
        }
    }
}

/// Every `[[link]]` in `text`, in the order they appear.
///
/// **Code is excluded**, both fenced blocks and inline spans, and that is not
/// tidiness: a vault of technical notes is full of code samples, and a snippet
/// containing `[[x]]` would otherwise put an edge in the graph that nobody
/// wrote. Embeds (`![[x]]`) are collected as ordinary links — an embed *is* a
/// reference, and treating it as one costs nothing and misses nothing.
///
/// The inline-code rule is the simple one: a run of backticks opens, a run of
/// the same length closes. Markdown's full rules are subtler than that, and
/// the residue is a note whose backticks are unbalanced on one line, which is
/// a typo rather than a case to model.
pub fn parse_links(text: &str) -> Vec<Link> {
    let mut out = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if let Some(marker) = trimmed.chars().next()
            && (marker == '`' || marker == '~')
        {
            let run = trimmed.chars().take_while(|&c| c == marker).count();
            if run >= 3 {
                match fence {
                    None => fence = Some((marker, run)),
                    Some((open, len)) if open == marker && run >= len => fence = None,
                    Some(_) => {}
                }
                continue;
            }
        }
        if fence.is_none() {
            scan_line(line, &mut out);
        }
    }
    out
}

fn scan_line(line: &str, out: &mut Vec<Link>) {
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    let mut code: Option<usize> = None;
    while i < chars.len() {
        if chars[i] == '`' {
            let run = chars[i..].iter().take_while(|&&c| c == '`').count();
            match code {
                None => code = Some(run),
                Some(open) if open == run => code = None,
                Some(_) => {}
            }
            i += run;
            continue;
        }
        if code.is_some() {
            i += 1;
            continue;
        }
        if chars[i] == '['
            && chars.get(i + 1) == Some(&'[')
            && let Some(end) = close_at(&chars, i + 2)
        {
            let inner: String = chars[i + 2..end].iter().collect();
            if let Some(link) = parse_inner(&inner) {
                out.push(link);
            }
            i = end + 2;
            continue;
        }
        i += 1;
    }
}

/// Index of the `]` opening the `]]` that closes a link started before `from`,
/// or `None` when the line has no close — an unterminated `[[` is text.
fn close_at(chars: &[char], from: usize) -> Option<usize> {
    let mut i = from;
    while i + 1 < chars.len() {
        if chars[i] == ']' && chars[i + 1] == ']' {
            return Some(i);
        }
        // A `[` inside would be a nested link, which is not a thing; treating
        // it as a terminator keeps a stray bracket from swallowing the line.
        if chars[i] == '[' {
            return None;
        }
        i += 1;
    }
    None
}

fn parse_inner(inner: &str) -> Option<Link> {
    let (target, alias) = match inner.split_once('|') {
        Some((t, a)) => (
            t.trim(),
            Some(a.trim().to_string()).filter(|a| !a.is_empty()),
        ),
        None => (inner.trim(), None),
    };
    if target.is_empty() {
        return None;
    }
    Some(Link {
        target: target.to_string(),
        alias,
    })
}

/// What a link target turned out to name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Resolution {
    /// Index into the note list it was resolved against.
    Note { index: usize },
    /// Two or more notes share the basename. **Reported rather than picked**:
    /// choosing one silently would make a link mean different things as the
    /// vault grows, and the user is the only one who knows which was meant.
    Ambiguous { indexes: Vec<usize> },
    /// Nothing in the vault answers to it. A vault has broken links in it —
    /// writing `[[thing]]` before the note exists is how a note gets planned —
    /// so this is a state to display, not an error.
    Missing,
}

/// Resolve a link target against a note list.
///
/// Obsidian's rule, which is what a user coming from a vault expects: a full
/// relative path if it matches, otherwise a unique basename anywhere in the
/// tree. The extension is optional on both, `.md` being the convention.
pub fn resolve_link(target: &str, notes: &[Note]) -> Resolution {
    let wanted = normalize_target(target);
    if wanted.is_empty() {
        return Resolution::Missing;
    }
    let with_md = format!("{wanted}.md");
    if let Some(index) = notes
        .iter()
        .position(|n| n.name.eq_ignore_ascii_case(&wanted) || n.name.eq_ignore_ascii_case(&with_md))
    {
        return Resolution::Note { index };
    }
    let base = wanted.rsplit('/').next().unwrap_or(&wanted);
    let indexes: Vec<usize> = notes
        .iter()
        .enumerate()
        .filter(|(_, n)| stem(&n.name).eq_ignore_ascii_case(base))
        .map(|(i, _)| i)
        .collect();
    match indexes.len() {
        0 => Resolution::Missing,
        1 => Resolution::Note { index: indexes[0] },
        _ => Resolution::Ambiguous { indexes },
    }
}

fn normalize_target(target: &str) -> String {
    let t = target.replace('\\', "/");
    let t = t.split('#').next().unwrap_or(&t).trim();
    t.trim_start_matches("./").trim_matches('/').to_string()
}

/// A note's basename without its extension: `rust/async.md` -> `async`.
fn stem(name: &str) -> &str {
    let base = name.rsplit('/').next().unwrap_or(name);
    match base.rsplit_once('.') {
        Some((before, _)) if !before.is_empty() => before,
        _ => base,
    }
}

// ---- the graph ----

/// One resolved link between two notes, by index into [`LinkGraph::notes`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Edge {
    pub from: usize,
    pub to: usize,
}

/// A link that names no single note, kept with the note that wrote it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct BrokenLink {
    pub from: usize,
    pub target: String,
    pub resolution: Resolution,
}

/// The vault as notes and the links between them.
///
/// Built by reading every note, which is what a link graph costs and why there
/// is no cheaper version of it. There is deliberately **no cache**: the walk is
/// already bounded by the docspace's own limits, a vault is markdown rather
/// than a repository, and a cache keyed on mtimes would be complexity bought
/// against a cost nobody has measured. If a large vault makes the graph view
/// slow, that measurement is the thing to take before adding one.
#[derive(Debug, Clone, Serialize)]
pub struct LinkGraph {
    pub notes: Vec<Note>,
    /// Deduplicated: a note linking another three times is one edge, because
    /// what a graph draws is whether they are connected. Self-links are
    /// dropped for the same reason.
    pub edges: Vec<Edge>,
    pub broken: Vec<BrokenLink>,
}

impl LinkGraph {
    /// Read `dir` and resolve every link in it.
    pub fn build(dir: &Path) -> Self {
        let notes = project::list_notes(dir);
        let mut edges = Vec::new();
        let mut broken = Vec::new();
        let mut seen: HashSet<(usize, usize)> = HashSet::new();

        for (from, note) in notes.iter().enumerate() {
            if note.bytes > LINK_SCAN_LIMIT {
                continue;
            }
            // A note that is not UTF-8 text has no links; it is still listed,
            // for the reason `list_notes` lists it — something the user put in
            // the folder is theirs to see.
            let Ok(text) = fs::read_to_string(dir.join(&note.name)) else {
                continue;
            };
            for link in parse_links(&text) {
                match resolve_link(link.note_target(), &notes) {
                    Resolution::Note { index } if index != from => {
                        if seen.insert((from, index)) {
                            edges.push(Edge { from, to: index });
                        }
                    }
                    Resolution::Note { .. } => {}
                    other => broken.push(BrokenLink {
                        from,
                        target: link.target.clone(),
                        resolution: other,
                    }),
                }
            }
        }
        Self {
            notes,
            edges,
            broken,
        }
    }

    pub fn index_of(&self, name: &str) -> Option<usize> {
        self.notes.iter().position(|n| n.name == name)
    }

    /// Notes this one links to.
    pub fn outbound(&self, index: usize) -> Vec<usize> {
        self.edges
            .iter()
            .filter(|e| e.from == index)
            .map(|e| e.to)
            .collect()
    }

    /// Notes that link to this one — the half a file listing cannot show you,
    /// and most of why a vault is worth more than a folder.
    pub fn backlinks(&self, index: usize) -> Vec<usize> {
        self.edges
            .iter()
            .filter(|e| e.to == index)
            .map(|e| e.from)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    fn temp_dir(label: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "nightloom-vault-{label}-{}-{n}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(dir: &Path, name: &str, body: &str) {
        let path = dir.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    #[test]
    fn parses_plain_links_and_aliases() {
        let found = parse_links("See [[tool-effects]] and [[engine/round-loop|the loop]].");
        assert_eq!(
            found,
            vec![
                Link {
                    target: "tool-effects".into(),
                    alias: None
                },
                Link {
                    target: "engine/round-loop".into(),
                    alias: Some("the loop".into())
                },
            ]
        );
    }

    /// The rule that keeps a vault of technical notes from growing edges
    /// nobody wrote.
    #[test]
    fn code_is_not_scanned_for_links() {
        let text = "real [[one]]\n\n```rust\nlet x = v[[0]];\n```\n\ninline `[[two]]` stays text\n";
        let found = parse_links(text);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].target, "one");
    }

    #[test]
    fn an_unterminated_link_is_ordinary_text() {
        assert!(parse_links("a [[dangling reference").is_empty());
        assert!(parse_links("[[]]").is_empty());
    }

    #[test]
    fn embeds_count_as_links() {
        let found = parse_links("![[diagram.png]]");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].target, "diagram.png");
    }

    #[test]
    fn a_heading_anchor_is_kept_but_not_part_of_the_note_name() {
        let found = parse_links("[[decisions#why]]");
        assert_eq!(found[0].target, "decisions#why");
        assert_eq!(found[0].note_target(), "decisions");
    }

    #[test]
    fn resolves_by_path_then_by_unique_basename() {
        let dir = temp_dir("resolve");
        write(&dir, "rust/async.md", "");
        write(&dir, "people/ada.md", "");
        let notes = project::list_notes(&dir);

        assert!(matches!(
            resolve_link("rust/async", &notes),
            Resolution::Note { .. }
        ));
        assert!(matches!(
            resolve_link("rust/async.md", &notes),
            Resolution::Note { .. }
        ));
        // Bare basename, unique in the vault.
        assert!(matches!(
            resolve_link("ada", &notes),
            Resolution::Note { .. }
        ));
        assert_eq!(resolve_link("nothing-here", &notes), Resolution::Missing);
        fs::remove_dir_all(&dir).ok();
    }

    /// Picking one silently would make a link mean different things as the
    /// vault grows, which is the failure the user cannot see.
    #[test]
    fn two_notes_sharing_a_basename_are_reported_rather_than_picked() {
        let dir = temp_dir("ambiguous");
        write(&dir, "a/notes.md", "");
        write(&dir, "b/notes.md", "");
        let notes = project::list_notes(&dir);

        match resolve_link("notes", &notes) {
            Resolution::Ambiguous { indexes } => assert_eq!(indexes.len(), 2),
            other => panic!("{other:?}"),
        }
        // The full path is still unambiguous.
        assert!(matches!(
            resolve_link("a/notes", &notes),
            Resolution::Note { .. }
        ));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_graph_carries_edges_backlinks_and_breakage() {
        let dir = temp_dir("graph");
        write(
            &dir,
            "a.md",
            "# A\nlinks to [[b]] and [[b]] again, plus [[ghost]]\n",
        );
        write(&dir, "b.md", "# B\nback to [[a]]\n");
        write(&dir, "c.md", "# C\nalone\n");
        let graph = LinkGraph::build(&dir);

        let a = graph.index_of("a.md").unwrap();
        let b = graph.index_of("b.md").unwrap();
        let c = graph.index_of("c.md").unwrap();

        // Deduplicated: two `[[b]]` are one edge.
        assert_eq!(graph.outbound(a), vec![b]);
        assert_eq!(graph.backlinks(b), vec![a]);
        assert_eq!(graph.backlinks(a), vec![b]);
        assert!(graph.backlinks(c).is_empty());

        assert_eq!(graph.broken.len(), 1);
        assert_eq!(graph.broken[0].target, "ghost");
        assert_eq!(graph.broken[0].resolution, Resolution::Missing);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_note_linking_itself_is_not_an_edge() {
        let dir = temp_dir("self");
        write(&dir, "a.md", "[[a]]");
        let graph = LinkGraph::build(&dir);
        assert!(graph.edges.is_empty());
        assert!(graph.broken.is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_location_defaults_and_is_repointed_by_a_file_of_its_own() {
        let config = temp_dir("location");
        assert!(is_default_location_in(&config));
        assert_eq!(vault_dir_in(&config), config.join(VAULT_DIR));

        let elsewhere = temp_dir("location-target");
        set_vault_dir_in(&config, Some(&elsewhere)).unwrap();
        assert_eq!(vault_dir_in(&config), project::normalize(&elsewhere));
        assert!(!is_default_location_in(&config));

        // Repointing moves nothing: the file is the whole of the change.
        assert!(elsewhere.is_dir());

        set_vault_dir_in(&config, None).unwrap();
        assert!(is_default_location_in(&config));
        assert_eq!(vault_dir_in(&config), config.join(VAULT_DIR));
        // Clearing twice is not an error.
        set_vault_dir_in(&config, None).unwrap();

        fs::remove_dir_all(&config).ok();
        fs::remove_dir_all(&elsewhere).ok();
    }

    /// A settings file that cannot be read costs the setting, not the feature.
    #[test]
    fn a_corrupt_location_file_falls_back_to_the_default() {
        let config = temp_dir("location-corrupt");
        fs::write(config.join(LOCATION_FILE), "{ not json").unwrap();
        assert_eq!(vault_dir_in(&config), config.join(VAULT_DIR));
        fs::remove_dir_all(&config).ok();
    }
}
