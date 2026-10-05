//! "Keep in project" (nightshift item 306): an attachment copied into the
//! project's files folder, so any later chat in the project finds it in its
//! system prompt's file listing and reads it — or just the pages it needs —
//! without his attaching it again.
//!
//! His words (2026-10-04): "there should be an option that you can just
//! like keep it in the project". What is kept is what the model was sent:
//! an office file as the PDF item 277 already made (or its text, when the
//! converter was missing), an image, a PDF or text as is, a file for Claude
//! Code from the chat's own folder. Nothing is converted a second time.
//!
//! Never an overwrite: a name already taken by other bytes gets ` (2)`,
//! ` (3)`…; the same bytes already in the folder, under any name, are not
//! copied twice, so a second press — or a press after a restart,
//! when the chip has forgotten — answers "kept" with the file that is there.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::attach::OfficeFormat;

/// The folder inside the docspace (`<workspace>/.agents`) kept files land
/// in. The name he already used by hand in ICS 51.
pub const KEPT_DIR: &str = "files";

/// Where a kept file went.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Kept {
    /// The file's full path.
    pub path: PathBuf,
    /// Its path inside the docspace, as the system prompt lists it:
    /// `files/deck.pdf`.
    pub rel: String,
    /// True when these bytes were already there and nothing was written.
    pub already: bool,
}

/// The name a kept attachment is written under. `media_type` is what the
/// bytes are now, which for an office file is not what the name says: a
/// `.pptx` that went as its PDF is kept as `.pdf`, one that went as text
/// (no LibreOffice) as `.txt`, a notebook sent as its cells as `.txt`. An
/// image with no extension gets one from its type. A path in `name` is
/// dropped to its last part, and a leading dot is dropped so the file is
/// not hidden from the listing.
pub fn kept_name(name: &str, media_type: &str) -> String {
    let leaf = Path::new(name)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let leaf = leaf.trim_start_matches('.').trim().to_string();
    let leaf = if leaf.is_empty() {
        "attachment".to_string()
    } else {
        leaf
    };
    let (stem, ext) = split_ext(&leaf);
    let ext_lc = ext.to_ascii_lowercase();
    if media_type == "application/pdf" && ext_lc != "pdf" {
        return format!("{stem}.pdf");
    }
    if media_type.starts_with("text/") && (OfficeFormat::of(&leaf).is_some() || ext_lc == "ipynb") {
        return format!("{stem}.txt");
    }
    if ext.is_empty()
        && let Some(e) = image_ext(media_type)
    {
        return format!("{stem}.{e}");
    }
    leaf
}

fn split_ext(leaf: &str) -> (&str, &str) {
    match leaf.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s, e),
        _ => (leaf, ""),
    }
}

fn image_ext(media_type: &str) -> Option<&'static str> {
    match media_type {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

/// Write `bytes` into `<docspace>/files/` under [`kept_name`]. A name
/// already taken by different bytes gets ` (2)`, ` (3)`…; the same bytes
/// already in the folder, under any name, come back as `already` with
/// nothing written.
pub fn keep_in_project(
    docspace: &Path,
    name: &str,
    media_type: &str,
    bytes: &[u8],
) -> Result<Kept, String> {
    let dir = docspace.join(KEPT_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let leaf = kept_name(name, media_type);
    // The same bytes under any name in the folder are that file: a sent
    // image is named `image-1.png` where the composer had its real name,
    // and pressing Keep on both must not make two copies.
    if let Some(file) = same_bytes_in(&dir, bytes) {
        return Ok(Kept {
            path: dir.join(&file),
            rel: format!("{KEPT_DIR}/{file}"),
            already: true,
        });
    }
    let (stem, ext) = split_ext(&leaf);
    let dot_ext = if ext.is_empty() {
        String::new()
    } else {
        format!(".{ext}")
    };
    let mut n = 1;
    loop {
        let file = if n == 1 {
            leaf.clone()
        } else {
            format!("{stem} ({n}){dot_ext}")
        };
        let path = dir.join(&file);
        let rel = format!("{KEPT_DIR}/{file}");
        match std::fs::metadata(&path) {
            Ok(meta) => {
                if meta.len() == bytes.len() as u64
                    && std::fs::read(&path).is_ok_and(|have| have == bytes)
                {
                    return Ok(Kept {
                        path,
                        rel,
                        already: true,
                    });
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                // `create_new`: a file that appeared since the check is
                // not overwritten; the next name is tried instead.
                match std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&path)
                {
                    Ok(mut f) => {
                        use std::io::Write as _;
                        f.write_all(bytes)
                            .map_err(|e| format!("{}: {e}", path.display()))?;
                        return Ok(Kept {
                            path,
                            rel,
                            already: false,
                        });
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(e) => return Err(format!("{}: {e}", path.display())),
                }
            }
            Err(e) => return Err(format!("{}: {e}", path.display())),
        }
        n += 1;
        if n > 10_000 {
            return Err(format!("{}: too many files named {leaf}", dir.display()));
        }
    }
}

/// A file directly in `dir` holding exactly `bytes`: sizes compared first,
/// so only a same-sized file is read.
fn same_bytes_in(dir: &Path, bytes: &[u8]) -> Option<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| {
            e.metadata()
                .is_ok_and(|m| m.is_file() && m.len() == bytes.len() as u64)
        })
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
        .into_iter()
        .find(|n| std::fs::read(dir.join(n)).is_ok_and(|have| have == bytes))
}

/// Keep a file the Claude Code engine saved in a chat's folder
/// ([`crate::attach::save_chat_files`]) — a sent message names it by path.
/// Only a file under `<workspace>/.nightloom/attachments/` is taken: the
/// path came from a message's text, and a copy out of anywhere else is not
/// what Keep means.
pub fn keep_chat_file(workspace: &Path, docspace: &Path, path: &Path) -> Result<Kept, String> {
    let root = workspace
        .join(crate::project::DOT_DIR)
        .join("attachments")
        .canonicalize()
        .map_err(|_| format!("{}: this project has no saved chat files", path.display()))?;
    let real = path
        .canonicalize()
        .map_err(|e| format!("{}: {e}", path.display()))?;
    if !real.starts_with(&root) || !real.is_file() {
        return Err(format!(
            "{} is not a file this project's chats saved, so Nightloom will not copy it",
            path.display()
        ));
    }
    let bytes = std::fs::read(&real).map_err(|e| format!("{}: {e}", real.display()))?;
    let name = real
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    keep_in_project(docspace, &name, "application/octet-stream", &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nightloom-keep-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_kept_file_is_named_for_what_its_bytes_are() {
        assert_eq!(
            kept_name("1.3-assembly.pptx", "application/pdf"),
            "1.3-assembly.pdf"
        );
        assert_eq!(kept_name("report.docx", "text/plain"), "report.txt");
        assert_eq!(kept_name("lab.ipynb", "text/plain"), "lab.txt");
        assert_eq!(kept_name("notes.PDF", "application/pdf"), "notes.PDF");
        assert_eq!(kept_name("main.rs", "text/plain"), "main.rs");
        assert_eq!(kept_name("shot.png", "image/png"), "shot.png");
        assert_eq!(kept_name("pasted image", "image/jpeg"), "pasted image.jpg");
        assert_eq!(kept_name("../../etc/passwd", "text/plain"), "passwd");
        assert_eq!(kept_name(".env", "text/plain"), "env");
        assert_eq!(kept_name("", "application/octet-stream"), "attachment");
        assert_eq!(
            kept_name("bundle.zip", "application/octet-stream"),
            "bundle.zip"
        );
    }

    #[test]
    fn keeping_never_overwrites_and_never_copies_the_same_bytes_twice() {
        let docs = scratch("clash");
        let a = keep_in_project(&docs, "deck.pptx", "application/pdf", b"%PDF-one").unwrap();
        assert_eq!(a.rel, "files/deck.pdf");
        assert!(!a.already);
        // The same bytes again: the file that is there, nothing written.
        let again = keep_in_project(&docs, "deck.pptx", "application/pdf", b"%PDF-one").unwrap();
        assert_eq!(again.path, a.path);
        assert!(again.already);
        // Other bytes under the same name: a suffix, the first untouched.
        let b = keep_in_project(&docs, "deck.pdf", "application/pdf", b"%PDF-two").unwrap();
        assert_eq!(b.rel, "files/deck (2).pdf");
        assert_eq!(std::fs::read(&a.path).unwrap(), b"%PDF-one");
        assert_eq!(std::fs::read(&b.path).unwrap(), b"%PDF-two");
        // The suffixed copy is found again too.
        let b2 = keep_in_project(&docs, "deck.pdf", "application/pdf", b"%PDF-two").unwrap();
        assert_eq!(b2.rel, "files/deck (2).pdf");
        assert!(b2.already);
        let c = keep_in_project(&docs, "deck.pdf", "application/pdf", b"%PDF-three").unwrap();
        assert_eq!(c.rel, "files/deck (3).pdf");
        // The same bytes under another name: still that one file.
        let renamed = keep_in_project(&docs, "image-1.png", "image/png", b"%PDF-three").unwrap();
        assert_eq!(renamed.rel, "files/deck (3).pdf");
        assert!(renamed.already);
        assert_eq!(std::fs::read_dir(docs.join("files")).unwrap().count(), 3);
        let _ = std::fs::remove_dir_all(docs);
    }

    /// The point of keeping: the next chat in the project lists it, by kind,
    /// with the page-range hint 307 added for a file that is not text.
    #[test]
    fn a_kept_pdf_is_listed_in_the_next_chats_prompt() {
        let ws = scratch("listed");
        let docs = ws.join(".agents");
        keep_in_project(
            &docs,
            "1.3-assembly.pptx",
            "application/pdf",
            b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n",
        )
        .unwrap();
        let seg = crate::prompt::project_notes_segment(&crate::prompt::ProjectContext {
            name: "ICS 51".into(),
            notes_dir: docs.clone(),
        });
        let text = format!("{seg:?}");
        assert!(text.contains("files/1.3-assembly.pdf (PDF, "), "{text}");
        assert!(text.contains("page range"), "{text}");
        let _ = std::fs::remove_dir_all(ws);
    }

    #[test]
    fn a_chat_file_is_kept_only_from_the_chats_folder() {
        let ws = scratch("chatfile");
        let docs = ws.join(".agents");
        let saved = crate::attach::save_chat_files(
            &ws,
            "c1",
            &[crate::attach::FileInput {
                name: "data.parquet".into(),
                data: "AAEC".into(),
            }],
        )
        .unwrap();
        let kept = keep_chat_file(&ws, &docs, &saved[0]).unwrap();
        assert_eq!(kept.rel, "files/data.parquet");
        assert_eq!(std::fs::read(&kept.path).unwrap(), vec![0u8, 1, 2]);
        // Anything outside the chats' folder is refused, a `..` way out too.
        let outside = ws.join("secret.txt");
        std::fs::write(&outside, "no").unwrap();
        assert!(keep_chat_file(&ws, &docs, &outside).is_err());
        let sneaky = ws.join(".nightloom/attachments/c1/../../../secret.txt");
        assert!(keep_chat_file(&ws, &docs, &sneaky).is_err());
        let _ = std::fs::remove_dir_all(ws);
    }
}
