//! Backlog items — `backlog/<id>-<slug>.md`, one file per item (§4), and
//! `backlog/order.json`, the global priority.
//!
//! Ownership split: everything above `## Progress` and the `status` field is
//! the GUI's (via the interview agent or by hand), except that the runner may
//! set `status`; `## Progress` is the runner's. This module reads whole items
//! and writes only `order.json`. Item edits from the GUI are a later screen,
//! and they will go through the file tools rather than a structured writer,
//! because an item is prose with a frontmatter and not a form.

use super::frontmatter::{self, Split};
use super::{Config, launch, read_text, write_json_atomic};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

/// `^(\d{3,})-.*\.md$` — shiftctl's `item_files` and `blocker_files` share it.
pub(crate) static ID_FILE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(\d{3,})-.*\.md$").expect("id-file regex"));

/// One `## ` section of an item or blocker body.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Section {
    /// The heading text after `## `, verbatim (a migrated item's heading can
    /// carry a note after the title).
    pub title: String,
    /// The lines under it up to the next `## `, trimmed.
    pub text: String,
}

/// A backlog item as the UI shows it.
#[derive(Debug, Clone, Serialize)]
pub struct Item {
    pub id: String,
    /// `backlog/<file>`.
    pub file: String,
    pub path: PathBuf,
    pub title: String,
    /// Resolved: the item's own `kind`, else the project's.
    pub kind: String,
    /// `todo | in-progress | done | killed | deferred`; empty when unset.
    pub status: String,
    pub created: String,
    /// `interview | manual | migrated | followup:<blocker>`.
    pub source: String,
    /// Resolved: the item's own `max_passes`, else the project's.
    pub max_passes: u32,
    /// `model:` when the item names one (§12.4; honoured per shift in v1).
    pub model: Option<String>,
    /// Every frontmatter field, last value wins, for anything the UI wants
    /// that is not lifted above.
    pub fields: BTreeMap<String, String>,
    /// Body text before the first `## ` heading.
    pub preface: String,
    pub sections: Vec<Section>,
    /// The bullet lines under `## Progress`, one per pass the runner recorded.
    pub progress: Vec<String>,
    /// Where this item sits in `order.json`, or `None` when unlisted (those
    /// sort last, by id).
    pub order: Option<usize>,
}

/// id → path for every `backlog/<NNN>-*.md`, sorted by file name.
pub fn item_files(root: &Path) -> BTreeMap<String, PathBuf> {
    id_files(&root.join("backlog"))
}

pub(crate) fn id_files(dir: &Path) -> BTreeMap<String, PathBuf> {
    let mut out = BTreeMap::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return out;
    };
    let mut names: Vec<(String, PathBuf)> = entries
        .filter_map(|e| e.ok())
        .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
        .collect();
    names.sort();
    for (name, path) in names {
        if let Some(m) = ID_FILE.captures(&name) {
            out.insert(m[1].to_string(), path);
        }
    }
    out
}

/// `{"order": [...]}`; empty when the file is missing or unreadable, which is
/// what shiftctl does too.
pub fn load_order(root: &Path) -> Vec<String> {
    let path = root.join("backlog").join("order.json");
    let Ok(text) = fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Vec::new();
    };
    v.get("order")
        .and_then(|o| o.as_array())
        .map(|a| {
            a.iter()
                .map(|x| match x {
                    serde_json::Value::String(s) => s.clone(),
                    other => other.to_string(),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Rewrite `order.json`. Ids that name no item are kept — the runner keeps
/// them too, and dropping an id because its file is momentarily missing
/// would be a silent reorder. Refused while a shift is live.
pub fn save_order(root: &Path, order: &[String]) -> Result<Vec<String>, String> {
    launch::ensure_not_live(root)?;
    let path = root.join("backlog").join("order.json");
    fs::create_dir_all(root.join("backlog")).map_err(|e| e.to_string())?;
    write_json_atomic(&path, &serde_json::json!({ "order": order }))?;
    Ok(load_order(root))
}

/// A new backlog item: `backlog/<id>-<slug>.md` with the frontmatter and the
/// section headings the contract names (§4), appended to `order.json`.
/// The id is one past the highest existing. `kind` is `research` or
/// `build`; the body is left for the person (or, later, the interview
/// agent — item 005). Refused while a shift is live.
pub fn new_item(root: &Path, title: &str, kind: &str) -> Result<String, String> {
    new_item_with_body(
        root,
        title,
        kind,
        "## What Swaraag said\n\n\n## What the agent inferred\n\n\n## Definition of done\n\n\n## Pointers\n\n\n## Not to do\n\n\n",
    )
}

/// The scaffold above with a written body — the interview's exit
/// (`interview.rs`). `body` is everything between the frontmatter and
/// `## Progress`, which the runner owns and is always appended last.
pub fn new_item_with_body(root: &Path, title: &str, kind: &str, body: &str) -> Result<String, String> {
    launch::ensure_not_live(root)?;
    let title = title.trim();
    if title.is_empty() {
        return Err("an item needs a title".into());
    }
    if kind != "research" && kind != "build" {
        return Err(format!("kind must be research or build, not {kind}"));
    }
    // One past the highest id anywhere — files or `order.json` entries.
    // shiftctl looks at files only; an id that is listed but has no file
    // would put the new item in that slot's position, so both count here.
    let files = item_files(root);
    let next = files
        .keys()
        .chain(load_order(root).iter())
        .filter_map(|k| k.parse::<u32>().ok())
        .max()
        .unwrap_or(0)
        + 1;
    let id = format!("{next:03}");
    let slug: String = title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|p| !p.is_empty())
        .take(8)
        .collect::<Vec<_>>()
        .join("-");
    let slug = if slug.is_empty() {
        "item".to_string()
    } else {
        slug
    };
    let dir = root.join("backlog");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{id}-{slug}.md"));
    let today = chrono_date();
    let quoted = title.replace('"', "\\\"");
    let body = body.trim_end();
    let text = format!(
        "---\nid: \"{id}\"\ntitle: \"{quoted}\"\nkind: {kind}\nstatus: todo\ncreated: {today}\nsource: manual\nmax_passes: 3\n---\n\n{body}\n\n\n## Progress\n"
    );
    super::write_atomic(&path, &text)?;
    let mut order = load_order(root);
    if !order.contains(&id) {
        order.push(id.clone());
        save_order(root, &order)?;
    }
    Ok(id)
}

/// Replace an item's whole text — the GUI's Edit. The file is the one the
/// id names; the text is taken as typed (an item is prose with a
/// frontmatter, not a form). Refused while a shift is live.
pub fn write_item(root: &Path, id: &str, text: &str) -> Result<(), String> {
    launch::ensure_not_live(root)?;
    let files = item_files(root);
    let path = files
        .get(id)
        .ok_or_else(|| format!("no backlog item with id {id}"))?;
    super::write_atomic(path, text)
}

/// Today as `YYYY-MM-DD`, local time — the `created` field's shape.
fn chrono_date() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// Global order, then any item not listed, ascending by id — shiftctl's
/// `ordered_items`.
pub fn ordered_ids(root: &Path) -> Vec<String> {
    let files = item_files(root);
    let mut order: Vec<String> = load_order(root)
        .into_iter()
        .filter(|i| files.contains_key(i))
        .collect();
    let mut rest: Vec<String> = files
        .keys()
        .filter(|i| !order.contains(i))
        .cloned()
        .collect();
    rest.sort();
    order.append(&mut rest);
    order
}

/// Every item, in [`ordered_ids`] order. One unreadable file costs that
/// item, reported in `errors`, not the list.
pub fn list_items(root: &Path, config: &Config) -> (Vec<Item>, Vec<String>) {
    let files = item_files(root);
    let order = load_order(root);
    let mut items = Vec::new();
    let mut errors = Vec::new();
    for id in ordered_ids(root) {
        let path = &files[&id];
        match read_item_at(path, &id, config, &order) {
            Ok(item) => items.push(item),
            Err(e) => errors.push(e),
        }
    }
    (items, errors)
}

/// One item by id.
pub fn read_item(root: &Path, config: &Config, id: &str) -> Result<Item, String> {
    let files = item_files(root);
    let path = files
        .get(id)
        .ok_or_else(|| format!("no backlog item with id {id}"))?;
    read_item_at(path, id, config, &load_order(root))
}

fn read_item_at(path: &Path, id: &str, config: &Config, order: &[String]) -> Result<Item, String> {
    let text = read_text(path)?;
    let split = frontmatter::split(&text);
    let (preface, sections) = parse_sections(&split.body);
    let progress = sections
        .iter()
        .find(|s| s.title.starts_with("Progress"))
        .map(|s| {
            s.text
                .lines()
                .map(str::trim)
                .filter(|l| l.starts_with("- "))
                .map(|l| l[2..].to_string())
                .collect()
        })
        .unwrap_or_default();
    let max_passes = split
        .get_nonempty("max_passes")
        .and_then(|v| v.parse().ok())
        .unwrap_or(config.max_passes);
    Ok(Item {
        id: id.to_string(),
        file: path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: path.to_path_buf(),
        title: split.get("title").unwrap_or("").to_string(),
        kind: split
            .get_nonempty("kind")
            .unwrap_or(&config.kind)
            .to_string(),
        status: split.get("status").unwrap_or("").to_string(),
        created: split.get("created").unwrap_or("").to_string(),
        source: split.get("source").unwrap_or("").to_string(),
        max_passes,
        model: split.get_nonempty("model").map(str::to_string),
        fields: fields_map(&split),
        preface,
        sections,
        progress,
        order: order.iter().position(|o| o == id),
    })
}

pub(crate) fn fields_map(split: &Split) -> BTreeMap<String, String> {
    let mut m = BTreeMap::new();
    for (k, v) in &split.fields {
        m.insert(k.clone(), v.clone());
    }
    m
}

/// Split a body at its `## ` headings. `###` and deeper stay inside the
/// section they are under, which is how `frontmatter::section` reads too.
pub(crate) fn parse_sections(body: &str) -> (String, Vec<Section>) {
    let mut preface = String::new();
    let mut sections: Vec<Section> = Vec::new();
    let mut current: Option<(String, String)> = None;
    for line in body.split('\n') {
        if let Some(title) = line.strip_prefix("## ") {
            if let Some((t, text)) = current.take() {
                sections.push(Section {
                    title: t,
                    text: text.trim().to_string(),
                });
            }
            current = Some((title.trim().to_string(), String::new()));
        } else if let Some((_, text)) = current.as_mut() {
            text.push_str(line);
            text.push('\n');
        } else {
            preface.push_str(line);
            preface.push('\n');
        }
    }
    if let Some((t, text)) = current.take() {
        sections.push(Section {
            title: t,
            text: text.trim().to_string(),
        });
    }
    (preface.trim().to_string(), sections)
}

/// The next free id: max existing + 1, zero-padded to three.
pub fn next_item_id(root: &Path) -> String {
    let n = item_files(root)
        .keys()
        .filter_map(|k| k.parse::<u64>().ok())
        .max()
        .unwrap_or(0)
        + 1;
    format!("{n:03}")
}

/// One entry of a plan's item list, kept here because synthesising a plan
/// is a walk over items.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlanItem {
    pub id: String,
    pub selected: bool,
}

#[cfg(test)]
mod tests {
    use super::super::testutil::{fixture, scratch};
    use super::*;

    fn config() -> Config {
        super::super::detect(&fixture()).unwrap().config
    }

    #[test]
    fn the_migrated_item_reads_with_its_quoted_id_and_its_progress_line() {
        let item = read_item(&fixture(), &config(), "017").unwrap();
        assert_eq!(item.id, "017");
        assert!(item.file.starts_with("017-"));
        assert_eq!(item.kind, "research");
        assert_eq!(item.status, "in-progress");
        assert_eq!(item.source, "migrated");
        assert_eq!(item.max_passes, 3);
        assert!(item.title.contains("Stuart Armstrong"));
        assert_eq!(item.order, Some(0));
        assert!(!item.sections.is_empty());
        assert!(
            item.sections
                .iter()
                .any(|s| s.title.starts_with("Progress"))
        );
        assert_eq!(item.progress.len(), 1, "{:?}", item.progress);
        assert!(item.progress[0].contains("shift 2026-09-11T02-16-40"));
        assert!(item.progress[0].contains("commit "));
        assert_eq!(item.fields.get("id").map(String::as_str), Some("017"));
    }

    #[test]
    fn new_item_scaffolds_and_appends_to_order_and_write_item_replaces() {
        let ws = scratch();
        fs::write(
            ws.join("backlog/002-b.md"),
            "---\nid: 002\ntitle: b\nkind: build\nstatus: todo\n---\n",
        )
        .unwrap();
        let top = load_order(&ws)
            .iter()
            .chain(item_files(&ws).keys())
            .filter_map(|k| k.parse::<u32>().ok())
            .max()
            .unwrap();
        let id = new_item(&ws, "Idea intake: an interview", "build").unwrap();
        assert_eq!(id, format!("{:03}", top + 1));
        let files = item_files(&ws);
        let path = files.get(&id).expect("file named by id");
        assert!(
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(&format!("{id}-idea-intake-an-interview"))
        );
        let text = fs::read_to_string(path).unwrap();
        assert!(text.starts_with(&format!(
            "---\nid: \"{id}\"\ntitle: \"Idea intake: an interview\"\nkind: build\nstatus: todo\n"
        )));
        assert!(text.contains("## Definition of done"));
        assert!(text.ends_with("## Progress\n"));
        assert_eq!(load_order(&ws).last(), Some(&id));
        assert!(new_item(&ws, "  ", "build").is_err());
        assert!(new_item(&ws, "x", "other").is_err());

        write_item(&ws, &id, "---\nid: \"x\"\ntitle: \"renamed\"\n---\n").unwrap();
        assert!(fs::read_to_string(path).unwrap().contains("renamed"));
        assert!(write_item(&ws, "999", "x").is_err());
    }

    #[test]
    fn listing_follows_order_json_then_unlisted_ids_ascending() {
        let ws = scratch();
        let b = ws.join("backlog");
        fs::write(
            b.join("003-c.md"),
            "---\nid: 003\ntitle: c\nstatus: todo\n---\n\n## What Swaraag said\nc\n",
        )
        .unwrap();
        fs::write(b.join("002-b.md"), "---\nid: 002\ntitle: b\n---\nbody\n").unwrap();
        fs::write(b.join("readme.md"), "not an item").unwrap();
        assert_eq!(ordered_ids(&ws), vec!["017", "002", "003"]);
        let (items, errors) = list_items(&ws, &config());
        assert!(errors.is_empty(), "{errors:?}");
        let ids: Vec<_> = items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, vec!["017", "002", "003"]);
        // 002 is in the fixture's order.json (unfiled there); 003 is not.
        assert_eq!(items[1].order, Some(2));
        assert_eq!(items[2].order, None);
        assert_eq!(items[1].kind, "research", "kind defaults from the project");
        assert_eq!(items[1].max_passes, 3);
        assert_eq!(next_item_id(&ws), "018");
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn save_order_rewrites_the_file_the_runner_reads() {
        let ws = scratch();
        let out = save_order(&ws, &["002".into(), "017".into()]).unwrap();
        assert_eq!(out, vec!["002", "017"]);
        assert_eq!(
            fs::read_to_string(ws.join("backlog/order.json")).unwrap(),
            "{\n  \"order\": [\n    \"002\",\n    \"017\"\n  ]\n}\n"
        );
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn a_live_lock_refuses_the_write() {
        let ws = scratch();
        fs::create_dir_all(ws.join("state")).unwrap();
        fs::write(
            ws.join("state/run.lock"),
            format!("{}\n", std::process::id()),
        )
        .unwrap();
        let err = save_order(&ws, &[]).unwrap_err();
        assert!(err.contains("live"), "{err}");
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn sections_split_at_h2_only_and_keep_the_preface() {
        let (pre, secs) = parse_sections("intro\n\n## A\none\n### A.1\ntwo\n\n## B — note\n- x\n");
        assert_eq!(pre, "intro");
        assert_eq!(secs.len(), 2);
        assert_eq!(secs[0].title, "A");
        assert_eq!(secs[0].text, "one\n### A.1\ntwo");
        assert_eq!(secs[1].title, "B — note");
        assert_eq!(secs[1].text, "- x");
    }
}
