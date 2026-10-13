//! Set a rewound turn's files aside (nightshift item 259).
//!
//! A rewind takes a turn out of the conversation but leaves what it wrote
//! on disk, and the next run reads it as real (Stuart 9, 2026-09-28). The
//! window lists those files (`rewoundFiles.ts`); the ones he ticks come
//! here and are **moved, never deleted**, into one dated folder outside the
//! project — outside, so the agent's next run cannot find them — keeping
//! each file's path under the project, with a `MANIFEST.md` saying where
//! each came from so any of them can be put back by hand.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;

/// One file moved: from where, to where.
#[derive(Debug, Serialize, PartialEq)]
pub struct Moved {
    pub from: String,
    pub to: String,
}

/// One file not moved, and why.
#[derive(Debug, Serialize, PartialEq)]
pub struct Skipped {
    pub path: String,
    pub why: String,
}

#[derive(Debug, Serialize)]
pub struct SetAside {
    /// The folder the files went to; `None` when nothing moved.
    pub folder: Option<String>,
    pub moved: Vec<Moved>,
    pub skipped: Vec<Skipped>,
}

/// Where a file lands under `folder`: its path under `workspace` when it
/// is inside it, else `outside/<its absolute path>`.
fn landing(folder: &Path, workspace: Option<&Path>, file: &Path) -> PathBuf {
    if let Some(rel) = workspace.and_then(|w| file.strip_prefix(w).ok()) {
        return folder.join(rel);
    }
    let rest: PathBuf = file
        .components()
        .filter(|c| matches!(c, Component::Normal(_)))
        .collect();
    folder.join("outside").join(rest)
}

/// A path the tools named, made absolute against the chat's folder.
fn resolve(workspace: Option<&Path>, raw: &str) -> Option<PathBuf> {
    let p = PathBuf::from(raw.trim());
    if p.as_os_str().is_empty() {
        return None;
    }
    if p.is_absolute() {
        return Some(p);
    }
    workspace.map(|w| w.join(p))
}

/// Move a file, across volumes too (copy, then remove the original only
/// once the copy is complete and the same length).
fn move_file(from: &Path, to: &Path) -> std::io::Result<()> {
    if let Some(dir) = to.parent() {
        std::fs::create_dir_all(dir)?;
    }
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    let n = std::fs::copy(from, to)?;
    if std::fs::metadata(from)?.len() != n {
        return Err(std::io::Error::other(
            "the copy came out short; original left in place",
        ));
    }
    std::fs::remove_file(from)
}

/// Move `paths` (as the tools named them, relative to `workspace` when not
/// absolute) into `root/<stamp>/`. Only regular files move: a folder, a
/// missing file, or a path that would land on an existing file is skipped
/// with its reason, never overwritten.
pub fn set_aside(root: &Path, stamp: &str, workspace: Option<&Path>, paths: &[String]) -> SetAside {
    let folder = root.join(stamp);
    let mut moved = Vec::new();
    let mut skipped = Vec::new();
    for raw in paths {
        let skip = |why: &str| Skipped {
            path: raw.clone(),
            why: why.into(),
        };
        let Some(file) = resolve(workspace, raw) else {
            skipped.push(skip("a relative path with no chat folder to read it from"));
            continue;
        };
        match std::fs::symlink_metadata(&file) {
            Ok(m) if m.is_file() => {}
            Ok(_) => {
                skipped.push(skip("not a plain file"));
                continue;
            }
            Err(_) => {
                skipped.push(skip("not there any more"));
                continue;
            }
        }
        let to = landing(&folder, workspace, &file);
        if to.exists() {
            skipped.push(skip("a file of that name is already set aside"));
            continue;
        }
        match move_file(&file, &to) {
            Ok(()) => moved.push(Moved {
                from: file.to_string_lossy().into_owned(),
                to: to.to_string_lossy().into_owned(),
            }),
            Err(e) => skipped.push(skip(&format!("could not move it: {e}"))),
        }
    }
    if moved.is_empty() {
        return SetAside {
            folder: None,
            moved,
            skipped,
        };
    }
    let mut manifest = format!(
        "# Set aside after a rewind, {stamp}\n\nMoved here by Nightloom (item 259) so the next run \
         does not read them as real. To put one back, move it to the path on its left.\n\n"
    );
    for m in &moved {
        manifest.push_str(&format!("- `{}` → `{}`\n", m.from, m.to));
    }
    let _ = std::fs::write(folder.join("MANIFEST.md"), manifest);
    SetAside {
        folder: Some(folder.to_string_lossy().into_owned()),
        moved,
        skipped,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("nightloom-aside-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn files_move_under_a_dated_folder_keeping_their_path_and_nothing_is_deleted() {
        let base = tmp("move");
        let ws = base.join("project");
        std::fs::create_dir_all(ws.join(".agents")).unwrap();
        std::fs::write(ws.join(".agents/brainstorm.md"), "notes").unwrap();
        std::fs::write(ws.join("HANDOFF.md"), "handoff").unwrap();
        let outside = base.join("elsewhere.md");
        std::fs::write(&outside, "o").unwrap();
        let root = base.join("rewound");
        let paths = vec![
            ".agents/brainstorm.md".to_string(),
            ws.join("HANDOFF.md").to_string_lossy().into_owned(),
            outside.to_string_lossy().into_owned(),
            "missing.md".to_string(),
            ".agents".to_string(),
        ];
        let out = set_aside(&root, "2026-09-29-1200", Some(&ws), &paths);
        let folder = root.join("2026-09-29-1200");
        assert_eq!(
            out.folder.as_deref(),
            Some(folder.to_string_lossy().as_ref())
        );
        assert_eq!(out.moved.len(), 3);
        assert!(!ws.join(".agents/brainstorm.md").exists());
        assert_eq!(
            std::fs::read_to_string(folder.join(".agents/brainstorm.md")).unwrap(),
            "notes"
        );
        assert_eq!(
            std::fs::read_to_string(folder.join("HANDOFF.md")).unwrap(),
            "handoff"
        );
        let rest: PathBuf = outside
            .components()
            .filter(|c| matches!(c, Component::Normal(_)))
            .collect();
        assert!(folder.join("outside").join(rest).is_file());
        assert_eq!(
            out.skipped
                .iter()
                .map(|s| s.why.as_str())
                .collect::<Vec<_>>(),
            vec!["not there any more", "not a plain file"]
        );
        assert!(
            std::fs::read_to_string(folder.join("MANIFEST.md"))
                .unwrap()
                .contains("HANDOFF.md")
        );
        // The folder it lived in stays.
        assert!(ws.join(".agents").is_dir());
    }

    #[test]
    fn nothing_is_overwritten_and_nothing_moved_makes_no_folder() {
        let base = tmp("clash");
        let ws = base.join("p");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::write(ws.join("a.md"), "new").unwrap();
        let root = base.join("rewound");
        std::fs::create_dir_all(root.join("s")).unwrap();
        std::fs::write(root.join("s/a.md"), "old").unwrap();
        let out = set_aside(&root, "s", Some(&ws), &["a.md".into()]);
        assert!(out.moved.is_empty());
        assert!(out.folder.is_none());
        assert_eq!(std::fs::read_to_string(ws.join("a.md")).unwrap(), "new");
        assert_eq!(std::fs::read_to_string(root.join("s/a.md")).unwrap(), "old");
        let none = set_aside(&base.join("r2"), "t", None, &["rel.md".into()]);
        assert!(none.folder.is_none());
        assert!(!base.join("r2").exists());
    }
}
