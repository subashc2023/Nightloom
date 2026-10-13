//! The runner's outputs the GUI only reads: morning pages, the `notes/`
//! tree, the jsonl streams under `state/` — and `schedule.json`, which the
//! GUI owns (§7).

use super::{confined, launch, read_text, rel_display, write_json_atomic};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

/// One file under `mornings/`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Morning {
    /// The file name, `2026-09-11.md` or `LATEST.md`.
    pub name: String,
    pub path: PathBuf,
    pub size: u64,
    /// RFC 3339, or empty when the OS does not say.
    pub modified: String,
}

fn modified(meta: &fs::Metadata) -> String {
    meta.modified()
        .ok()
        .map(|t| chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339())
        .unwrap_or_default()
}

/// Every `.md` under `mornings/`, dated pages newest first and `LATEST.md`
/// (the runner's copy of the newest) excluded — it is the same page twice.
pub fn list_mornings(root: &Path) -> Vec<Morning> {
    let Ok(entries) = fs::read_dir(root.join("mornings")) else {
        return Vec::new();
    };
    let mut out: Vec<Morning> = entries
        .filter_map(|e| e.ok())
        .filter(|e| {
            let n = e.file_name();
            let n = n.to_string_lossy();
            n.ends_with(".md") && n != "LATEST.md"
        })
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            meta.is_file().then(|| Morning {
                name: e.file_name().to_string_lossy().into_owned(),
                path: e.path(),
                size: meta.len(),
                modified: modified(&meta),
            })
        })
        .collect();
    out.sort_by(|a, b| b.name.cmp(&a.name));
    out
}

/// The newest page by name, which for the runner's `YYYY-MM-DD.md` naming
/// is the newest by date. `None` for a project with no page yet.
pub fn newest_morning(root: &Path) -> Option<Morning> {
    list_mornings(root).into_iter().next()
}

/// A page's text by file name (no directories: the name is a key, not a
/// path).
pub fn read_morning(root: &Path, name: &str) -> Result<String, String> {
    if name.is_empty() || name.contains(['/', '\\']) || name == ".." {
        return Err(format!("{name:?} is not a morning page name"));
    }
    read_text(&root.join("mornings").join(name))
}

/// One entry of the `notes/` tree.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NoteEntry {
    /// Root-relative with forward slashes, `notes/runner-design/x.md`.
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: String,
}

/// The `notes/` tree, depth-first in name order, hidden entries skipped.
/// Read as a whole rather than lazily because a research project's notes
/// are a few hundred files, and one listing is cheaper than a round trip
/// per folder the user opens.
pub fn notes_tree(root: &Path) -> Vec<NoteEntry> {
    let base = root.join("notes");
    let mut out = Vec::new();
    for entry in walkdir::WalkDir::new(&base)
        .min_depth(1)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|e| !e.file_name().to_string_lossy().starts_with('.'))
        .filter_map(|e| e.ok())
    {
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        out.push(NoteEntry {
            path: rel_display(root, entry.path()),
            name: entry.file_name().to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            modified: modified(&meta),
        });
    }
    out
}

/// Any text file inside the root by relative path — a note, a review, a
/// page `status.json` named. Confined lexically; the root is the user's own
/// project.
pub fn read_file(root: &Path, rel: &str) -> Result<String, String> {
    let path = confined(root, rel)?;
    if !path.is_file() {
        return Err(format!("{rel} is not a file in this project"));
    }
    read_text(&path)
}

/// The last `limit` rows of a jsonl stream under the root, oldest first.
/// A torn final line (no trailing newline — the runner is mid-append) is
/// left for the next read, and a line that is not JSON costs that line.
pub fn jsonl_tail(root: &Path, rel: &str, limit: usize) -> Result<Vec<serde_json::Value>, String> {
    let path = confined(root, rel)?;
    let bytes = match fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("could not read {}: {e}", path.display())),
    };
    let complete = match bytes.iter().rposition(|&b| b == b'\n') {
        Some(i) => &bytes[..=i],
        None => &bytes[..0],
    };
    let lines: Vec<&[u8]> = complete
        .split(|&b| b == b'\n')
        .filter(|l| !l.is_empty())
        .collect();
    let start = lines.len().saturating_sub(limit);
    Ok(lines[start..]
        .iter()
        .filter_map(|l| serde_json::from_slice(l).ok())
        .collect())
}

/// `schedule.json` (§7). `items` is `"global-order"` or a list of ids, kept
/// as JSON since the two shapes share nothing.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Schedule {
    pub id: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub days: Vec<String>,
    #[serde(default)]
    pub start: String,
    #[serde(default)]
    pub until: Option<String>,
    #[serde(default)]
    pub max_units: Option<u32>,
    #[serde(default)]
    pub budget_usd: Option<f64>,
    #[serde(default = "global_order")]
    pub items: serde_json::Value,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

fn global_order() -> serde_json::Value {
    serde_json::Value::String("global-order".into())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Schedules {
    #[serde(default)]
    pub schedules: Vec<Schedule>,
}

/// Empty when the file is missing; an error when it exists and does not
/// parse, because silently offering an empty form over a broken file is
/// how a schedule gets overwritten.
pub fn read_schedules(root: &Path) -> Result<Schedules, String> {
    let path = root.join("schedule.json");
    match fs::read_to_string(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Schedules::default()),
        Err(e) => Err(format!("could not read {}: {e}", path.display())),
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display())),
    }
}

pub fn write_schedules(root: &Path, schedules: &Schedules) -> Result<Schedules, String> {
    launch::ensure_not_live(root)?;
    let mut seen = std::collections::HashSet::new();
    for s in &schedules.schedules {
        if s.id.is_empty() {
            return Err("every schedule needs an id".into());
        }
        if !seen.insert(&s.id) {
            return Err(format!("two schedules share the id {:?}", s.id));
        }
    }
    write_json_atomic(&root.join("schedule.json"), schedules)?;
    read_schedules(root)
}

#[cfg(test)]
mod tests {
    use super::super::testutil::{fixture, scratch};
    use super::*;

    #[test]
    fn mornings_list_newest_first_without_latest_and_read_by_name() {
        let ws = scratch();
        fs::write(ws.join("mornings/2026-09-10.md"), "# older\n").unwrap();
        let list = list_mornings(&ws);
        let names: Vec<_> = list.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, vec!["2026-09-11.md", "2026-09-10.md"]);
        assert_eq!(newest_morning(&ws).unwrap().name, "2026-09-11.md");
        assert!(
            read_morning(&ws, "2026-09-11.md")
                .unwrap()
                .starts_with("# Morning page")
        );
        assert!(read_morning(&ws, "../nightshift.json").is_err());
        assert!(read_morning(&ws, "nope.md").is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn a_project_with_no_pages_has_no_newest() {
        let ws = scratch();
        fs::remove_dir_all(ws.join("mornings")).unwrap();
        assert!(list_mornings(&ws).is_empty());
        assert!(newest_morning(&ws).is_none());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn the_notes_tree_is_root_relative_with_forward_slashes() {
        let tree = notes_tree(&fixture());
        let paths: Vec<_> = tree.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(
            paths,
            vec!["notes/runner-design", "notes/runner-design/a-note.md"]
        );
        assert!(tree[0].is_dir && !tree[1].is_dir);
        assert!(
            read_file(&fixture(), "notes/runner-design/a-note.md")
                .unwrap()
                .contains("Fixture")
        );
        assert!(read_file(&fixture(), "notes/runner-design").is_err());
        assert!(read_file(&fixture(), "../../Cargo.toml").is_err());
    }

    #[test]
    fn jsonl_tail_skips_the_torn_line_and_bad_rows_and_bounds_the_count() {
        let ws = scratch();
        let all = jsonl_tail(&ws, "state/spend.jsonl", 100).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(
            jsonl_tail(&ws, "state/spend.jsonl", 2).unwrap(),
            all[1..].to_vec()
        );
        fs::write(
            ws.join("state/adherence.jsonl"),
            "{\"a\":1}\nnot json\n{\"a\":2}\n{\"a\":3",
        )
        .unwrap();
        let rows = jsonl_tail(&ws, "state/adherence.jsonl", 10).unwrap();
        assert_eq!(
            rows,
            vec![serde_json::json!({"a":1}), serde_json::json!({"a":2})]
        );
        assert!(
            jsonl_tail(&ws, "state/missing.jsonl", 10)
                .unwrap()
                .is_empty()
        );
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn schedules_read_the_fixture_and_write_back_the_same_shape() {
        let ws = scratch();
        let s = read_schedules(&ws).unwrap();
        assert_eq!(s.schedules.len(), 1);
        assert_eq!(s.schedules[0].id, "nightly");
        assert!(!s.schedules[0].enabled);
        assert_eq!(s.schedules[0].items, serde_json::json!("global-order"));
        let mut edited = s.clone();
        edited.schedules[0].enabled = true;
        edited.schedules[0].items = serde_json::json!(["017"]);
        let back = write_schedules(&ws, &edited).unwrap();
        assert_eq!(back, edited);
        let text = fs::read_to_string(ws.join("schedule.json")).unwrap();
        assert!(text.starts_with("{\n  \"schedules\": ["));
        edited.schedules.push(edited.schedules[0].clone());
        assert!(
            write_schedules(&ws, &edited)
                .unwrap_err()
                .contains("share the id")
        );
        fs::remove_file(ws.join("schedule.json")).unwrap();
        assert_eq!(read_schedules(&ws).unwrap(), Schedules::default());
        fs::write(ws.join("schedule.json"), "{").unwrap();
        assert!(read_schedules(&ws).is_err());
        let _ = fs::remove_dir_all(&ws);
    }
}
