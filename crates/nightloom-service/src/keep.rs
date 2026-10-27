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
    keep_in_project_at(docspace, "", name, media_type, bytes)
}

/// [`keep_in_project`] into a folder under `files/` — `sub` is `bundle` or
/// `bundle/src`, the place an entry of a dropped zip goes (item 414). A
/// `sub` that is absolute, climbs out (`..`) or names a hidden folder is
/// refused: it came over the bridge, and only [`unpack_zip`]'s safe paths
/// are meant.
pub fn keep_in_project_at(
    docspace: &Path,
    sub: &str,
    name: &str,
    media_type: &str,
    bytes: &[u8],
) -> Result<Kept, String> {
    let sub = if sub.is_empty() {
        String::new()
    } else {
        match safe_entry_path(&format!("{sub}/x")) {
            EntryPath::Keep(p) => p.trim_end_matches("/x").to_string(),
            _ => return Err(format!("{sub}: not a folder Nightloom will keep files in")),
        }
    };
    let (dir, prefix) = if sub.is_empty() {
        (docspace.join(KEPT_DIR), format!("{KEPT_DIR}/"))
    } else {
        (
            docspace.join(KEPT_DIR).join(&sub),
            format!("{KEPT_DIR}/{sub}/"),
        )
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let leaf = kept_name(name, media_type);
    // The same bytes under any name in the folder are that file: a sent
    // image is named `image-1.png` where the composer had its real name,
    // and pressing Keep on both must not make two copies.
    if let Some(file) = same_bytes_in(&dir, bytes) {
        return Ok(Kept {
            path: dir.join(&file),
            rel: format!("{prefix}{file}"),
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
        let rel = format!("{prefix}{file}");
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

// ---- a dropped zip (item 414) ----
//
// His words (2026-10-26): "Why cant i drop a zip file into the notes
// section... bro". A chat cannot read inside a .zip, so a zip dropped on
// the Notes panel is unpacked into `files/<zip name>/` (blocker 1526). This
// half reads the archive and says which entries are safe to keep; the
// window then puts each through the same rules a dropped file meets (caps,
// office → PDF, refusals) and keeps it with [`keep_in_project_at`].

/// More files than this in one zip are not kept (the Notes list shows 200).
pub const ZIP_MAX_FILES: usize = 500;
/// An entry bigger than this, unpacked, is skipped — the cap a dropped file
/// meets on the Claude Code engine (`MAX_FILE_BYTES` in `attachKinds.ts`).
pub const ZIP_MAX_ENTRY: u64 = 50 * 1024 * 1024;
/// All entries together, unpacked: past this the rest are skipped, so a
/// small zip that inflates to gigabytes (a "zip bomb") stops here.
pub const ZIP_MAX_TOTAL: u64 = 200 * 1024 * 1024;

/// One file out of a zip: its path under the zip's folder (`src/main.rs`,
/// always `/`-separated) and its bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ZipFileOut {
    pub path: String,
    pub bytes: Vec<u8>,
}

/// An entry not kept, and why, in a few words.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ZipSkip {
    pub name: String,
    pub why: String,
}

/// What a zip holds that may be kept, and the folder it goes in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unpacked {
    /// The folder under `files/`: the zip's name without `.zip`, or that
    /// name with ` (2)`, ` (3)`… when a file or folder already has it.
    pub folder: String,
    pub files: Vec<ZipFileOut>,
    pub skipped: Vec<ZipSkip>,
}

/// What an entry's path in a zip means for keeping it.
#[derive(Debug, PartialEq, Eq)]
enum EntryPath {
    /// A safe relative path, `/`-separated, no empty or `.` parts.
    Keep(String),
    /// macOS's `__MACOSX/` resource forks, `.DS_Store`, any dot-file or
    /// file in a dot-folder: left out, counted as a system file.
    System,
    /// Absolute, a drive letter, or a `..` part: it would land outside the
    /// folder (a "zip slip"), so it is refused.
    Escapes,
}

fn safe_entry_path(raw: &str) -> EntryPath {
    let raw = raw.replace('\\', "/");
    if raw.starts_with('/') {
        return EntryPath::Escapes;
    }
    let mut parts = Vec::new();
    for part in raw.split('/') {
        let part = part.trim();
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." || part.contains(':') || part.contains('\0') {
            return EntryPath::Escapes;
        }
        parts.push(part);
    }
    if parts.is_empty() {
        return EntryPath::Escapes;
    }
    if parts[0] == "__MACOSX" || parts.iter().any(|p| p.starts_with('.')) {
        return EntryPath::System;
    }
    EntryPath::Keep(parts.join("/"))
}

/// The folder a zip unpacks into: its name, `.zip` dropped (a leading dot
/// too, so it is not hidden), with ` (2)`, ` (3)`… while `files/` already
/// has something by that name. Nothing is ever unpacked over what is there.
pub fn zip_folder(docspace: &Path, zip_name: &str) -> String {
    let leaf = Path::new(zip_name)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let leaf = leaf.trim();
    // `get`, not slicing: a name ending in "é" has no char boundary there.
    let cut = leaf.len().saturating_sub(4);
    let stem = match (leaf.get(cut..), leaf.get(..cut)) {
        (Some(ext), Some(s)) if ext.eq_ignore_ascii_case(".zip") => s,
        _ => leaf,
    };
    let stem = stem.trim_start_matches('.').trim();
    let stem = if stem.is_empty() { "archive" } else { stem };
    let dir = docspace.join(KEPT_DIR);
    let mut n = 1;
    loop {
        let name = if n == 1 {
            stem.to_string()
        } else {
            format!("{stem} ({n})")
        };
        if std::fs::symlink_metadata(dir.join(&name)).is_err() {
            return name;
        }
        n += 1;
    }
}

/// Read a dropped zip: every entry safe to keep, with its bytes, and every
/// one left out with why. A file that is not a readable zip is an error
/// whose words say so. Nothing is written here.
pub fn unpack_zip(docspace: &Path, zip_name: &str, bytes: &[u8]) -> Result<Unpacked, String> {
    use std::io::Read as _;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| format!("{zip_name} is not a readable zip ({e})"))?;
    let mut files = Vec::new();
    let mut skipped = Vec::new();
    let mut total: u64 = 0;
    let mut skip = |name: &str, why: &str| {
        skipped.push(ZipSkip {
            name: name.to_string(),
            why: why.to_string(),
        })
    };
    for i in 0..zip.len() {
        let name = zip
            .name_for_index(i)
            .map(str::to_string)
            .unwrap_or_else(|| format!("entry {}", i + 1));
        let mut entry = match zip.by_index(i) {
            Ok(e) => e,
            Err(e) => {
                skip(&name, &format!("could not be read ({e})"));
                continue;
            }
        };
        let raw = entry.name().to_string();
        if entry.is_dir() {
            continue;
        }
        let path = match safe_entry_path(&raw) {
            EntryPath::Keep(p) => p,
            EntryPath::System => {
                skip(&raw, "system file");
                continue;
            }
            EntryPath::Escapes => {
                skip(&raw, "path leads outside the folder");
                continue;
            }
        };
        // A symlink entry: its "bytes" are a path somewhere else.
        if entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) {
            skip(&raw, "symlink");
            continue;
        }
        if files.len() >= ZIP_MAX_FILES {
            skip(&raw, &format!("over {ZIP_MAX_FILES} files"));
            continue;
        }
        if entry.size() > ZIP_MAX_ENTRY {
            skip(&raw, "too large");
            continue;
        }
        // Read at most one byte past the cap: the size in the header may lie.
        let mut out = Vec::new();
        let read = (&mut entry).take(ZIP_MAX_ENTRY + 1).read_to_end(&mut out);
        if let Err(e) = read {
            skip(&raw, &format!("could not be read ({e})"));
            continue;
        }
        if out.len() as u64 > ZIP_MAX_ENTRY {
            skip(&raw, "too large");
            continue;
        }
        if total + out.len() as u64 > ZIP_MAX_TOTAL {
            skip(&raw, "zip too large unpacked");
            continue;
        }
        total += out.len() as u64;
        files.push(ZipFileOut { path, bytes: out });
    }
    Ok(Unpacked {
        folder: zip_folder(docspace, zip_name),
        files,
        skipped,
    })
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
        // The path to type, said outright (a live Haiku turn missed `.agents/`).
        assert!(
            text.contains("here, .agents/files/1.3-assembly.pdf."),
            "{text}"
        );
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

    /// A zip of `(name, bytes)` entries; a name ending in `/` is a folder.
    fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
        use std::io::Write as _;
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            let o = zip::write::SimpleFileOptions::default();
            for (name, bytes) in entries {
                if name.ends_with('/') {
                    z.add_directory(*name, o).unwrap();
                } else {
                    z.start_file(*name, o).unwrap();
                    z.write_all(bytes).unwrap();
                }
            }
            z.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn a_zip_unpacks_its_files_and_keeps_nested_folders_as_folders() {
        let docs = scratch("zip-nested");
        let bytes = zip_of(&[
            ("a.txt", b"one"),
            ("sub/", b""),
            ("sub/b.md", b"# two"),
            ("sub/deeper/c.pdf", b"%PDF-three"),
            ("./d.txt", b"four"),
        ]);
        let u = unpack_zip(&docs, "Bundle.zip", &bytes).unwrap();
        assert_eq!(u.folder, "Bundle");
        let paths: Vec<_> = u.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["a.txt", "sub/b.md", "sub/deeper/c.pdf", "d.txt"]);
        assert_eq!(u.files[2].bytes, b"%PDF-three");
        assert!(u.skipped.is_empty(), "{:?}", u.skipped);
        // Kept where its path says, under the zip's folder.
        let k = keep_in_project_at(
            &docs,
            "Bundle/sub/deeper",
            "c.pdf",
            "application/pdf",
            &u.files[2].bytes,
        )
        .unwrap();
        assert_eq!(k.rel, "files/Bundle/sub/deeper/c.pdf");
        assert_eq!(
            std::fs::read(docs.join("files/Bundle/sub/deeper/c.pdf")).unwrap(),
            b"%PDF-three"
        );
        let _ = std::fs::remove_dir_all(docs);
    }

    #[test]
    fn a_zip_entry_that_climbs_out_is_refused_and_nothing_lands_outside() {
        let docs = scratch("zip-slip");
        let bytes = zip_of(&[
            ("../evil.txt", b"x"),
            ("ok/../../evil2.txt", b"x"),
            ("/etc/evil3", b"x"),
            ("C:/evil4.txt", b"x"),
            ("..\\evil5.txt", b"x"),
            ("fine.txt", b"y"),
        ]);
        let u = unpack_zip(&docs, "slip.zip", &bytes).unwrap();
        assert_eq!(u.files.len(), 1);
        assert_eq!(u.files[0].path, "fine.txt");
        assert_eq!(u.skipped.len(), 5, "{:?}", u.skipped);
        assert!(
            u.skipped
                .iter()
                .all(|s| s.why == "path leads outside the folder")
        );
        // The keep refuses such a folder too, whoever asks.
        for sub in ["..", "a/../..", "/abs", "a/.hidden"] {
            assert!(
                keep_in_project_at(&docs, sub, "x.txt", "text/plain", b"x").is_err(),
                "{sub}"
            );
        }
        assert!(!docs.parent().unwrap().join("evil.txt").exists());
        let _ = std::fs::remove_dir_all(docs);
    }

    #[test]
    fn mac_system_files_and_dot_files_in_a_zip_are_left_out() {
        let docs = scratch("zip-macosx");
        let bytes = zip_of(&[
            ("notes/a.txt", b"a"),
            ("__MACOSX/notes/._a.txt", b"fork"),
            ("notes/.DS_Store", b"ds"),
            (".env", b"SECRET"),
            (".git/config", b"cfg"),
        ]);
        let u = unpack_zip(&docs, "notes.zip", &bytes).unwrap();
        let paths: Vec<_> = u.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["notes/a.txt"]);
        assert_eq!(u.skipped.len(), 4);
        assert!(u.skipped.iter().all(|s| s.why == "system file"));
        let _ = std::fs::remove_dir_all(docs);
    }

    #[test]
    fn a_zip_whose_name_is_taken_unpacks_into_a_numbered_sibling() {
        let docs = scratch("zip-clash");
        let bytes = zip_of(&[("a.txt", b"one")]);
        std::fs::create_dir_all(docs.join("files/report")).unwrap();
        std::fs::write(docs.join("files/report/a.txt"), b"mine").unwrap();
        // A plain file of that name counts too.
        std::fs::write(docs.join("files/report (2)"), b"file").unwrap();
        let u = unpack_zip(&docs, "report.ZIP", &bytes).unwrap();
        assert_eq!(u.folder, "report (3)");
        keep_in_project_at(&docs, &u.folder, "a.txt", "text/plain", b"one").unwrap();
        assert_eq!(
            std::fs::read(docs.join("files/report/a.txt")).unwrap(),
            b"mine"
        );
        assert_eq!(
            std::fs::read(docs.join("files/report (3)/a.txt")).unwrap(),
            b"one"
        );
        assert_eq!(zip_folder(&docs, ".zip"), "archive");
        assert_eq!(zip_folder(&docs, "../x/data.tar.zip"), "data.tar");
        assert_eq!(zip_folder(&docs, "résumé"), "résumé");
        assert_eq!(zip_folder(&docs, "Lecture é.zip"), "Lecture é");
        let _ = std::fs::remove_dir_all(docs);
    }

    #[test]
    fn an_empty_zip_unpacks_to_nothing_and_a_corrupt_one_says_so() {
        let docs = scratch("zip-empty");
        let u = unpack_zip(&docs, "empty.zip", &zip_of(&[])).unwrap();
        assert!(u.files.is_empty() && u.skipped.is_empty());
        let only_folders =
            unpack_zip(&docs, "f.zip", &zip_of(&[("a/", b""), ("a/b/", b"")])).unwrap();
        assert!(only_folders.files.is_empty() && only_folders.skipped.is_empty());
        let e = unpack_zip(&docs, "broken.zip", b"PK\x03\x04 not really a zip").unwrap_err();
        assert!(e.starts_with("broken.zip is not a readable zip"), "{e}");
        let mut cut = zip_of(&[("a.txt", b"hello world")]);
        cut.truncate(cut.len() / 2);
        assert!(unpack_zip(&docs, "cut.zip", &cut).is_err());
        // Nothing was written for any of them.
        assert!(!docs.join("files").exists());
        let _ = std::fs::remove_dir_all(docs);
    }
}
