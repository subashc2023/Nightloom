//! Saved message prompts with blanks (nightshift item 800, from 793 #7).
//!
//! A saved prompt is a message he types often — a wrap-up, a spec launch —
//! kept under a short name so `/name` in any message box puts it in, with
//! `{blanks}` to step through by Tab. They are **message text only**: they
//! are not the system-prompt library (`PromptLibrary.svelte`, kept in the
//! Mac's local storage) and nothing here ever reaches a system prompt.
//!
//! They live on the host, as one JSON file `<config>/saved-prompts.json`,
//! because the phone's boxes use them too and the phone cannot read the
//! Mac's window storage. The Mac's Settings is the only editor; the phone
//! reads them through `GET /api/saved-prompts`. What a save does to the
//! list — the previous version kept, a delete moved to the trash — is the
//! Mac's (`savedPrompts.ts`); this file only reads and writes the document
//! whole, and keeps a reading it cannot parse from being written over (the
//! registry's rule, backlog 219: an unreadable file is not an empty one).
//! A save writes a temporary file beside it and renames it over, so a crash
//! mid-write leaves the old file whole.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The file under the config directory.
pub const FILE: &str = "saved-prompts.json";

/// One earlier version of a prompt, kept when an edit replaced it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Version {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub body: String,
    /// Epoch ms when this version was replaced.
    #[serde(default)]
    pub at: i64,
}

/// One saved prompt.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Prompt {
    pub id: String,
    /// What follows the slash: `wrapup` for `/wrapup`.
    pub name: String,
    /// The text put into the box; `{word}` is a blank.
    #[serde(default)]
    pub body: String,
    /// Epoch ms of the last write.
    #[serde(default)]
    pub updated: i64,
    /// Earlier versions, newest first.
    #[serde(default)]
    pub versions: Vec<Version>,
    /// Epoch ms it was deleted; a deleted prompt sits in the trash until
    /// restored and is never offered by `/`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted: Option<i64>,
}

/// The whole file.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Doc {
    #[serde(default)]
    pub prompts: Vec<Prompt>,
}

/// A reading: the document, and whether the file existed (the Mac seeds
/// the first two prompts only into a file that never existed, so a list he
/// emptied stays empty).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Reading {
    pub doc: Doc,
    pub exists: bool,
}

/// What the phone is shown: the live prompts, name and body.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Offered {
    pub name: String,
    pub body: String,
}

pub fn path_in(dir: &Path) -> PathBuf {
    dir.join(FILE)
}

/// Read the file under `dir`. Missing is an empty document that does not
/// exist; unreadable or unparsable is an error.
pub fn read(dir: &Path) -> Result<Reading, String> {
    let path = path_in(dir);
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str::<Doc>(&s)
            .map(|doc| Reading { doc, exists: true })
            .map_err(|e| format!("{} could not be read: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Reading::default()),
        Err(e) => Err(format!("{} could not be read: {e}", path.display())),
    }
}

/// Write `doc` whole, refusing when the file on disk cannot be parsed (it
/// would be lost) and when two live prompts share a name (`/name` would be
/// ambiguous).
pub fn write(dir: &Path, doc: &Doc) -> Result<(), String> {
    if let Err(e) = read(dir) {
        return Err(format!("Not saved: {e}"));
    }
    let mut seen = std::collections::HashSet::new();
    for p in doc.prompts.iter().filter(|p| p.deleted.is_none()) {
        let name = p.name.trim().to_lowercase();
        if name.is_empty() {
            return Err("Not saved: a prompt has no name.".into());
        }
        if !seen.insert(name) {
            return Err(format!(
                "Not saved: two prompts are called /{}.",
                p.name.trim()
            ));
        }
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = path_in(dir);
    let tmp = dir.join(format!("{FILE}.tmp"));
    let body = serde_json::to_string_pretty(doc).map_err(|e| e.to_string())?;
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(body.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// The live prompts the phone offers, in the file's order.
pub fn offered(dir: &Path) -> Result<Vec<Offered>, String> {
    Ok(read(dir)?
        .doc
        .prompts
        .into_iter()
        .filter(|p| p.deleted.is_none())
        .map(|p| Offered {
            name: p.name,
            body: p.body,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(PathBuf);
    impl Scratch {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn scratch() -> Scratch {
        let d =
            std::env::temp_dir().join(format!("nightloom-saved-prompts-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        Scratch(d)
    }

    fn prompt(id: &str, name: &str) -> Prompt {
        Prompt {
            id: id.into(),
            name: name.into(),
            body: format!("body of {name} {{blank}}"),
            updated: 1,
            versions: vec![],
            deleted: None,
        }
    }

    #[test]
    fn a_missing_file_is_empty_and_not_there() {
        let dir = scratch();
        let r = read(dir.path()).unwrap();
        assert!(!r.exists);
        assert!(r.doc.prompts.is_empty());
    }

    #[test]
    fn a_write_reads_back_whole_with_its_versions() {
        let dir = scratch();
        let mut p = prompt("a", "wrapup");
        p.versions.push(Version {
            name: "wrapup".into(),
            body: "old".into(),
            at: 5,
        });
        let doc = Doc { prompts: vec![p] };
        write(dir.path(), &doc).unwrap();
        let r = read(dir.path()).unwrap();
        assert!(r.exists);
        assert_eq!(r.doc, doc);
    }

    #[test]
    fn an_unparsable_file_is_never_written_over() {
        let dir = scratch();
        std::fs::write(path_in(dir.path()), "{ not json").unwrap();
        assert!(read(dir.path()).is_err());
        let e = write(dir.path(), &Doc::default()).unwrap_err();
        assert!(e.starts_with("Not saved"), "{e}");
        assert_eq!(
            std::fs::read_to_string(path_in(dir.path())).unwrap(),
            "{ not json"
        );
    }

    #[test]
    fn two_live_prompts_with_one_name_are_refused_but_a_trashed_one_is_not() {
        let dir = scratch();
        let doc = Doc {
            prompts: vec![prompt("a", "spec"), prompt("b", "Spec")],
        };
        assert!(write(dir.path(), &doc).unwrap_err().contains("/Spec"));
        let mut trashed = prompt("b", "spec");
        trashed.deleted = Some(9);
        let doc = Doc {
            prompts: vec![prompt("a", "spec"), trashed],
        };
        write(dir.path(), &doc).unwrap();
    }

    #[test]
    fn the_phone_is_offered_only_live_prompts() {
        let dir = scratch();
        let mut gone = prompt("b", "gone");
        gone.deleted = Some(3);
        write(
            dir.path(),
            &Doc {
                prompts: vec![prompt("a", "wrapup"), gone],
            },
        )
        .unwrap();
        let o = offered(dir.path()).unwrap();
        assert_eq!(o.len(), 1);
        assert_eq!(o[0].name, "wrapup");
    }
}
