//! `send_file` (nightshift backlog 343, 2026-10-12): the model hands the
//! user a file it made — a PDF, an image, a spreadsheet — and the reply
//! carries it as an attachment chip he can open, save or drag out, in the
//! window and on the phone page.
//!
//! A tool rather than a tag in the reply text (blocker 1386, his "whatever
//! you think is best"): a tool is listed on every request with a fixed
//! shape, and the path it names is one Nightloom checks; a text tag drifts
//! in a long chat and misfires when quoted.
//!
//! **The path rule.** The path resolves against the chat's folder — the
//! project's workspace, or the chat's own working folder for an unfiled one
//! — through the same [`Root`] every file tool is confined by, so `..`, an
//! absolute path elsewhere and a symlink pointing out of the folder are all
//! refused the same way. A file outside is refused with the step that fixes
//! it (copy it into the folder first), never sent: what leaves the folder
//! is something the user put there or let the model write there. Missing,
//! a folder, or over [`MAX_BYTES`] is refused too, each in words that say
//! what to do next.
//!
//! **The copy.** A sent file is **copied** into Nightloom's own store,
//! `<config>/sent-files/<id>/<name>` ([`store_in`]), so the chip still opens
//! after the model deletes or rewrites its file. A chat that writes nothing
//! (incognito, ephemeral) keeps its copies in the system's temporary folder
//! instead ([`scratch_store`]) — such a chat promised not to write into
//! Nightloom's own folder, and its log does not outlive it anyway.
//!
//! **The chip.** The result's last line is [`MARKER`] and a line of JSON
//! ([`SentFile`]); the window and the phone page read that line out of the
//! recorded `tool_result` — on either engine, under `send_file` or
//! `mcp__nightloom__send_file` — so the chip comes back on reload, after a
//! restart and in the history with nothing else stored.
//!
//! `Effect::Session`: it changes nothing of the user's — the file is read,
//! and the copy lands in Nightloom's store — so it needs no approval and an
//! incognito chat keeps it (`reads_only` in the desktop).

use std::path::{Path, PathBuf};

use nightloom_core::ToolDef;
use nightloom_core::tool::{CancellationToken, Effect, Tool};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::{Root, blocking, path_arg};

/// The tool's name on the API engine, and its middle on the CLI's:
/// `mcp__nightloom__send_file`.
pub const NAME: &str = "send_file";

/// The largest file sent, in bytes (the spec's default, 100 MB). Past it
/// the file is refused, not cut: a truncated PDF is not a PDF.
pub const MAX_BYTES: u64 = 100 * 1024 * 1024;

/// The store's folder under the config dir.
pub const SENT_DIR: &str = "sent-files";

/// The store's folder under the system's temporary folder, for a chat that
/// writes nothing.
pub const SCRATCH_DIR: &str = "nightloom-sent-files";

/// What the result's machine-read line starts with. One line of JSON
/// follows it.
pub const MARKER: &str = "nightloom-sent-file: ";

/// The store for a chat that writes into the config dir.
pub fn store_in(config: &Path) -> PathBuf {
    config.join(SENT_DIR)
}

/// The store for a chat that writes nothing.
pub fn scratch_store() -> PathBuf {
    std::env::temp_dir().join(SCRATCH_DIR)
}

/// One sent file, as the result's last line carries it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SentFile {
    /// The copy's folder in the store: a UUID, hex without dashes.
    pub id: String,
    /// The file's name, as it was in the chat's folder.
    pub name: String,
    pub size: u64,
    /// Where the copy is, absolute.
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
}

/// The [`SentFile`] a result carries, if it carries one.
/// Only the last non-empty line counts, as [`result_text`] writes it (343
/// review, 2026-10-12): a marker the model put in an argument and a
/// message quoted back mid-text is not a sent file.
pub fn parse_marker(text: &str) -> Option<SentFile> {
    text.lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .and_then(|l| l.strip_prefix(MARKER))
        .and_then(|json| serde_json::from_str(json).ok())
}

/// Whether `id` is one this module would have made: 32 hex digits. Checked
/// before it is joined to a path, so a request cannot walk out of a store.
fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Whether `name` is one plain file name: no separator, not `.` or `..`,
/// and no control or bidirectional-override character (343 review,
/// 2026-10-12) — a newline breaks the result's lines and a header, and a
/// right-to-left override makes `report\u{202e}fdp.exe` read as a PDF on
/// the chip.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && !name.chars().any(|c| {
            c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
}

/// The stores a copy may be in: the config dir's, then the scratch one.
fn stores() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(config) = crate::project::config_dir() {
        out.push(store_in(&config));
    }
    out.push(scratch_store());
    out
}

/// The copy named `id`/`name` in either store, when it is there — what the
/// phone page's route serves. `None` for anything malformed or missing.
pub fn locate(id: &str, name: &str) -> Option<PathBuf> {
    locate_in(&stores(), id, name)
}

fn locate_in(stores: &[PathBuf], id: &str, name: &str) -> Option<PathBuf> {
    if !valid_id(id) || !valid_name(name) {
        return None;
    }
    stores
        .iter()
        .map(|s| s.join(id).join(name))
        .find(|p| p.symlink_metadata().is_ok_and(|m| m.is_file()))
}

/// Whether `path` is a copy in one of the stores — the window's Save and
/// drag-out take a path from the transcript and serve nothing else.
pub fn is_stored(path: &Path) -> bool {
    is_stored_in(&stores(), path)
}

fn is_stored_in(stores: &[PathBuf], path: &Path) -> bool {
    let Ok(real) = path.canonicalize() else {
        return false;
    };
    if !real.is_file() {
        return false;
    }
    stores
        .iter()
        .filter_map(|s| s.canonicalize().ok())
        .any(|s| real.starts_with(&s))
}

/// The media type the phone page's route serves a copy under, by
/// extension: what a browser needs to show a PDF or an image in place.
/// Anything unlisted is a download (`application/octet-stream`).
pub fn media_type(name: &str) -> &'static str {
    let ext = Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "svg" => "image/svg+xml",
        "txt" | "log" => "text/plain; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "json" => "application/json",
        "html" | "htm" => "text/html; charset=utf-8",
        "zip" => "application/zip",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        _ => "application/octet-stream",
    }
}

/// A size for the model and the chip: `812 B`, `14 KB`, `1.2 MB`.
pub fn human_size(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    let b = bytes as f64;
    if b < KB {
        format!("{bytes} B")
    } else if b < KB * KB {
        format!("{:.0} KB", b / KB)
    } else if b < KB * KB * KB {
        format!("{:.1} MB", b / (KB * KB))
    } else {
        format!("{:.1} GB", b / (KB * KB * KB))
    }
}

/// The tool. One per chat: `root` is the chat's folder, `store` where its
/// copies go.
pub struct SendFile {
    root: PathBuf,
    store: PathBuf,
}

impl SendFile {
    pub fn new(root: impl Into<PathBuf>, store: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            store: store.into(),
        }
    }
}

/// Send one file: the whole rule, synchronous, for the tool's blocking
/// thread and for tests.
pub fn deliver(
    root: &Path,
    store: &Path,
    arg: &str,
    caption: Option<String>,
) -> Result<SentFile, String> {
    let outside = || {
        format!(
            "\"{arg}\" is outside this chat's folder ({}), and send_file only sends files \
             inside it. Copy the file into the folder first (for example with cp), then call \
             send_file with the copy's path.",
            root.display()
        )
    };
    let path = Root::new(root.to_path_buf())
        .resolve(arg)
        .map_err(|_| outside())?;
    let meta = std::fs::metadata(&path).map_err(|_| {
        format!(
            "there is no file at \"{arg}\" in this chat's folder ({}). Write the file first, \
             or check the path with list_dir or ls.",
            root.display()
        )
    })?;
    if meta.is_dir() {
        return Err(format!(
            "\"{arg}\" is a folder; send_file sends one file. Zip the folder first if they \
             need all of it, then send the zip."
        ));
    }
    if !meta.is_file() {
        return Err(format!(
            "\"{arg}\" is not a regular file, so it cannot be sent."
        ));
    }
    // The second, real check: the file itself, symlinks followed, must be
    // inside the folder's real path. `Root::resolve` already canonicalizes
    // the deepest existing ancestor — the file — so this is belt and braces
    // for the one call that copies a file out of the user's tree.
    let real = path.canonicalize().map_err(|e| e.to_string())?;
    let real_root = root.canonicalize().map_err(|_| outside())?;
    if !real.starts_with(&real_root) {
        return Err(outside());
    }
    if meta.len() > MAX_BYTES {
        return Err(format!(
            "\"{arg}\" is {}, over send_file's limit of {}. Compress it or send a smaller \
             version.",
            human_size(meta.len()),
            human_size(MAX_BYTES)
        ));
    }
    // The name the model gave, not the link's target's.
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|n| valid_name(n))
        .ok_or_else(|| {
            format!(
                "\"{arg}\" has no file name it can be sent under: a name with a control \
                 character (such as a newline) or a text-direction character is refused. \
                 Rename or copy it to a plain name first."
            )
        })?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let dir = store.join(&id);
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("could not make Nightloom's copy of the file: {e}"))?;
    let dest = dir.join(&name);
    let size = std::fs::copy(&real, &dest)
        .map_err(|e| format!("could not make Nightloom's copy of the file: {e}"))?;
    let caption = caption
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty());
    Ok(SentFile {
        id,
        name,
        size,
        path: dest.to_string_lossy().into_owned(),
        caption,
    })
}

/// The result the model reads: what happened in a sentence, then the line
/// the chip is drawn from.
pub fn result_text(sent: &SentFile) -> String {
    format!(
        "Sent \"{}\" ({}) to the user: it is attached to your reply, where they can open it, \
         save it or drag it out. Nightloom kept its own copy, so changing or deleting your file \
         now does not change what they received. Mention it in a sentence; do not paste its \
         contents.\n{MARKER}{}",
        sent.name,
        human_size(sent.size),
        serde_json::to_string(sent).expect("plain fields serialize")
    )
}

#[async_trait::async_trait]
impl Tool for SendFile {
    fn def(&self) -> ToolDef {
        ToolDef {
            name: NAME.into(),
            description: "Hand the user a file — a PDF, an image, a spreadsheet, a document you \
                 made or found in this chat's folder. The file appears as an attachment on your \
                 reply that they can open, save or drag out, on their computer and their phone. \
                 Use it whenever they ask for a file or a file is the natural answer (\"make me a \
                 PDF of…\"); saying where the file is on disk is not handing it to them. The path \
                 is relative to this chat's folder, and only files inside the folder can be sent: \
                 write or copy the file into the folder first. One file per call, up to 100 MB."
                .into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "The file to send, relative to this chat's folder (or absolute inside it)."
                    },
                    "caption": {
                        "type": "string",
                        "description": "Optional: a few words shown under the file, such as what it is."
                    }
                },
                "required": ["path"]
            }),
        }
    }

    fn effect(&self) -> Effect {
        Effect::Session
    }

    async fn call(&self, input: Value, _cancel: &CancellationToken) -> Result<String, String> {
        let arg = path_arg(&input)?;
        let caption = input["caption"].as_str().map(String::from);
        let (root, store) = (self.root.clone(), self.store.clone());
        blocking(move || deliver(&root, &store, &arg, caption).map(|s| result_text(&s))).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::test_dir;

    fn setup(name: &str) -> (PathBuf, PathBuf) {
        let base = test_dir(&format!("send-file-{name}"));
        let root = base.join("chat");
        let store = base.join("store");
        std::fs::create_dir_all(&root).unwrap();
        (root, store)
    }

    #[test]
    fn a_file_inside_the_folder_is_copied_into_the_store() {
        let (root, store) = setup("inside");
        std::fs::create_dir_all(root.join("out")).unwrap();
        std::fs::write(root.join("out/report.pdf"), b"%PDF-1.4 hello").unwrap();
        let sent = deliver(&root, &store, "out/report.pdf", Some(" the report ".into())).unwrap();
        assert_eq!(sent.name, "report.pdf");
        assert_eq!(sent.size, 14);
        assert_eq!(sent.caption.as_deref(), Some("the report"));
        assert!(valid_id(&sent.id));
        let copy = PathBuf::from(&sent.path);
        assert_eq!(copy, store.join(&sent.id).join("report.pdf"));
        // The copy survives the model deleting its own file.
        std::fs::remove_file(root.join("out/report.pdf")).unwrap();
        assert_eq!(std::fs::read(&copy).unwrap(), b"%PDF-1.4 hello");
        // And an absolute path inside the folder is the same file.
        std::fs::write(root.join("a.txt"), b"a").unwrap();
        let abs = root.join("a.txt").to_string_lossy().into_owned();
        assert_eq!(deliver(&root, &store, &abs, None).unwrap().name, "a.txt");
    }

    #[test]
    fn the_result_carries_the_line_the_chip_is_drawn_from() {
        let (root, store) = setup("marker");
        std::fs::write(root.join("x.csv"), b"a,b\n").unwrap();
        let sent = deliver(&root, &store, "x.csv", None).unwrap();
        let text = result_text(&sent);
        assert!(text.starts_with("Sent \"x.csv\" (4 B) to the user"));
        assert_eq!(parse_marker(&text), Some(sent));
        assert_eq!(parse_marker("no marker here"), None);
    }

    #[test]
    fn a_path_outside_the_folder_is_refused_with_the_fix() {
        let (root, store) = setup("outside");
        let base = root.parent().unwrap().to_path_buf();
        std::fs::write(base.join("secret.txt"), b"s").unwrap();
        for arg in [
            "../secret.txt".to_string(),
            base.join("secret.txt").to_string_lossy().into_owned(),
            "/etc/hosts".to_string(),
        ] {
            let err = deliver(&root, &store, &arg, None).unwrap_err();
            assert!(err.contains("outside this chat's folder"), "{arg}: {err}");
            assert!(err.contains("Copy the file into the folder first"), "{err}");
        }
        assert!(!store.exists(), "nothing was copied");
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_out_of_the_folder_is_refused() {
        let (root, store) = setup("symlink");
        let base = root.parent().unwrap().to_path_buf();
        std::fs::write(base.join("secret.txt"), b"s").unwrap();
        std::os::unix::fs::symlink(base.join("secret.txt"), root.join("link.txt")).unwrap();
        std::fs::create_dir_all(base.join("elsewhere")).unwrap();
        std::fs::write(base.join("elsewhere/f.txt"), b"f").unwrap();
        std::os::unix::fs::symlink(base.join("elsewhere"), root.join("dirlink")).unwrap();
        for arg in ["link.txt", "dirlink/f.txt"] {
            let err = deliver(&root, &store, arg, None).unwrap_err();
            assert!(err.contains("outside this chat's folder"), "{arg}: {err}");
        }
        // A symlink that stays inside is fine.
        std::fs::write(root.join("real.txt"), b"r").unwrap();
        std::os::unix::fs::symlink(root.join("real.txt"), root.join("inner.txt")).unwrap();
        assert_eq!(
            deliver(&root, &store, "inner.txt", None).unwrap().name,
            "inner.txt"
        );
    }

    /// 343 review: a name that would break the result's lines or disguise
    /// its extension is refused before anything is copied, and the marker
    /// is read from the last line only.
    #[test]
    fn a_name_with_a_newline_or_a_direction_override_is_refused() {
        let (root, store) = setup("names");
        for name in ["a\nb.pdf", "report\u{202e}fdp.exe", "tab\t.txt"] {
            std::fs::write(root.join(name), b"x").unwrap();
            let err = deliver(&root, &store, name, None).unwrap_err();
            assert!(err.contains("plain name"), "{name:?}: {err}");
        }
        assert!(!store.exists(), "nothing was copied");
        assert_eq!(
            locate_in(std::slice::from_ref(&store), &"a".repeat(32), "a\nb"),
            None
        );
        std::fs::write(root.join("ok.pdf"), b"x").unwrap();
        let text = result_text(&deliver(&root, &store, "ok.pdf", None).unwrap());
        assert!(parse_marker(&format!("{text}\n\n")).is_some());
        assert_eq!(parse_marker(&format!("{text}\nthen more")), None);
    }

    #[test]
    fn missing_folders_and_oversize_files_are_refused() {
        let (root, store) = setup("refusals");
        let err = deliver(&root, &store, "nope.pdf", None).unwrap_err();
        assert!(err.contains("there is no file at"), "{err}");
        std::fs::create_dir_all(root.join("dir")).unwrap();
        let err = deliver(&root, &store, "dir", None).unwrap_err();
        assert!(err.contains("is a folder"), "{err}");
        let f = std::fs::File::create(root.join("big.bin")).unwrap();
        f.set_len(MAX_BYTES + 1).unwrap();
        let err = deliver(&root, &store, "big.bin", None).unwrap_err();
        assert!(err.contains("over send_file's limit of 100.0 MB"), "{err}");
        assert!(!store.exists(), "nothing was copied");
    }

    #[test]
    fn locate_and_is_stored_serve_only_copies_in_a_store() {
        let (root, store) = setup("locate");
        std::fs::write(root.join("r.pdf"), b"x").unwrap();
        let sent = deliver(&root, &store, "r.pdf", None).unwrap();
        let stores = vec![store.clone()];
        assert_eq!(
            locate_in(&stores, &sent.id, "r.pdf"),
            Some(PathBuf::from(&sent.path))
        );
        assert_eq!(locate_in(&stores, &sent.id, "../r.pdf"), None);
        assert_eq!(locate_in(&stores, "..", "r.pdf"), None);
        assert_eq!(locate_in(&stores, &sent.id, "other.pdf"), None);
        assert!(is_stored_in(&stores, Path::new(&sent.path)));
        assert!(!is_stored_in(&stores, &root.join("r.pdf")));
        assert!(!is_stored_in(
            &stores,
            &store
                .join(&sent.id)
                .join("..")
                .join("..")
                .join("chat")
                .join("r.pdf")
        ));
    }

    #[tokio::test]
    async fn the_tool_answers_in_text_and_refuses_as_an_error() {
        let (root, store) = setup("tool");
        std::fs::write(root.join("a.txt"), b"a").unwrap();
        let tool = SendFile::new(&root, &store);
        assert_eq!(tool.effect(), Effect::Session);
        let ok = tool
            .call(json!({"path": "a.txt"}), &CancellationToken::new())
            .await
            .unwrap();
        assert!(parse_marker(&ok).is_some());
        let err = tool
            .call(json!({"path": "../a.txt"}), &CancellationToken::new())
            .await
            .unwrap_err();
        assert!(err.contains("outside"));
        let err = tool
            .call(json!({}), &CancellationToken::new())
            .await
            .unwrap_err();
        assert!(err.contains("missing required argument: path"));
    }
}
