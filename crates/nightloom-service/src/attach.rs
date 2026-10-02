//! Attachments past images and PDFs (nightshift item 277).
//!
//! His ask: a class `.pptx` said "not supported" in Nightloom and went
//! straight into claude.ai. Three layers, his "yes to your questions" on all
//! of them (2026-10-01):
//!
//! 1. **Text files** go in as text. The composer reads those itself; nothing
//!    here.
//! 2. **Office files** (`.pptx .docx .xlsx`, the legacy and OpenDocument
//!    formats where the converter reads them) become a **PDF** through
//!    LibreOffice when it is installed ([`find_soffice`], [`convert_to_pdf`]),
//!    so the model sees the slides as drawn; without it — and always on the
//!    away server, whose image has none — the **text** is pulled out of the
//!    OOXML/ODF zip ([`extract_text`]): slide text in order with slide
//!    numbers, speaker notes, tables, sheet cells. [`prepare_office`] picks.
//! 3. **Anything else, on the Claude Code engine**, is copied into the chat's
//!    own folder under the workspace ([`save_chat_files`]) and the message
//!    names the path ([`files_note`]), so the model opens it with its own
//!    tools.
//!
//! The conversion never touches his file: the composer hands over the bytes,
//! they are written into a fresh temporary folder, and the folder goes when
//! the conversion does.

use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use nightloom_core::DocumentInput;
use serde::Serialize;

/// How long one conversion may take before it is killed and the text path
/// taken instead. A 60-slide deck converts in seconds once LibreOffice is
/// warm; its first start on a fresh profile takes longer, and that is what
/// the margin is for.
pub const CONVERT_TIMEOUT: Duration = Duration::from_secs(60);

/// The most text an extraction returns, in bytes. Past ~150k tokens a file
/// would fill a model's window by itself; the text says it was cut.
pub const MAX_EXTRACTED_TEXT: usize = 600 * 1024;

/// The office formats, by extension. What each one can do without the
/// converter is [`OfficeFormat::extractable`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OfficeFormat {
    Pptx,
    Docx,
    Xlsx,
    Odp,
    Odt,
    Ods,
    /// `.ppt .doc .xls .key .rtf .pages .numbers`: binary or foreign formats only the
    /// converter reads.
    ConverterOnly,
}

impl OfficeFormat {
    pub fn of(name: &str) -> Option<Self> {
        let ext = Path::new(name)
            .extension()?
            .to_string_lossy()
            .to_ascii_lowercase();
        Some(match ext.as_str() {
            "pptx" | "ppsx" | "potx" | "pptm" => Self::Pptx,
            "docx" | "dotx" | "docm" => Self::Docx,
            "xlsx" | "xltx" | "xlsm" => Self::Xlsx,
            "odp" => Self::Odp,
            "odt" => Self::Odt,
            "ods" => Self::Ods,
            "ppt" | "pps" | "doc" | "xls" | "key" | "rtf" | "pages" | "numbers" => {
                Self::ConverterOnly
            }
            _ => return None,
        })
    }

    pub fn extractable(self) -> bool {
        self != Self::ConverterOnly
    }

    fn is_slides(self) -> bool {
        matches!(self, Self::Pptx | Self::Odp)
    }
}

/// LibreOffice's `soffice`, if this machine has it: `NIGHTLOOM_SOFFICE`
/// first (tests, and anyone with it somewhere odd), then the Homebrew cask's
/// app bundle, then `soffice` / `libreoffice` on `PATH`.
pub fn find_soffice() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("NIGHTLOOM_SOFFICE") {
        let p = PathBuf::from(p);
        return p.is_file().then_some(p);
    }
    let bundle = PathBuf::from("/Applications/LibreOffice.app/Contents/MacOS/soffice");
    if bundle.is_file() {
        return Some(bundle);
    }
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for name in ["soffice", "libreoffice"] {
            let p = dir.join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// One conversion at a time: they share a LibreOffice profile, and two
/// processes on one profile is the case where the second quietly writes
/// nothing.
static CONVERT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The bytes of an office file as a PDF, by `soffice --headless
/// --convert-to pdf` in a fresh temporary folder that is removed after.
///
/// Its own profile (`-env:UserInstallation`) rather than his: a LibreOffice
/// window he has open holds the default profile, and a headless run against
/// it hands the job to that instance and exits having written nothing.
pub async fn convert_to_pdf(
    soffice: &Path,
    name: &str,
    bytes: &[u8],
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    let ext = Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if ext.is_empty() || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(format!(
            "{name}: no extension to tell the converter what it is"
        ));
    }
    let _one = CONVERT_LOCK.lock().await;
    let base = std::env::temp_dir();
    let dir = base.join(format!("nightloom-convert-{}", uuid::Uuid::new_v4()));
    let out = dir.join("out");
    std::fs::create_dir_all(&out).map_err(|e| format!("temp folder: {e}"))?;
    let _cleanup = RemoveOnDrop(dir.clone());
    let input = dir.join(format!("input.{ext}"));
    std::fs::write(&input, bytes).map_err(|e| format!("temp file: {e}"))?;
    let profile = base.join("nightloom-soffice-profile");
    let profile_url = format!("file://{}", profile.display());
    let mut cmd = tokio::process::Command::new(soffice);
    cmd.arg(format!("-env:UserInstallation={profile_url}"))
        .args(["--headless", "--norestore", "--nologo", "--nolockcheck"])
        .args(["--convert-to", "pdf", "--outdir"])
        .arg(&out)
        .arg(&input)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let child = cmd
        .spawn()
        .map_err(|e| format!("could not start LibreOffice ({}): {e}", soffice.display()))?;
    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(format!("LibreOffice: {e}")),
        // The future owned the child; dropping it kills it (`kill_on_drop`).
        Err(_) => {
            return Err(format!(
                "LibreOffice did not finish converting {name} within {} s",
                timeout.as_secs_f64().round()
            ));
        }
    };
    let pdf = out.join("input.pdf");
    match std::fs::read(&pdf) {
        Ok(b) if !b.is_empty() => Ok(b),
        _ => {
            let err = String::from_utf8_lossy(&output.stderr);
            let err = err.trim();
            Err(format!(
                "LibreOffice wrote no PDF for {name} (exit {}){}",
                output
                    .status
                    .code()
                    .map_or("signal".into(), |c| c.to_string()),
                if err.is_empty() {
                    String::new()
                } else {
                    format!(": {}", err.lines().last().unwrap_or(err))
                }
            ))
        }
    }
}

struct RemoveOnDrop(PathBuf);
impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Pages in a PDF, counted from its page objects — what the end-to-end
/// check compares to the deck's slide count, and what the chip says.
pub fn pdf_page_count(pdf: &[u8]) -> usize {
    let needle = b"/Type";
    let mut n = 0;
    let mut i = 0;
    while i + needle.len() <= pdf.len() {
        if &pdf[i..i + needle.len()] == needle {
            let mut j = i + needle.len();
            while j < pdf.len() && pdf[j].is_ascii_whitespace() {
                j += 1;
            }
            if pdf[j..].starts_with(b"/Page") && !pdf[j..].starts_with(b"/Pages") {
                n += 1;
            }
            i = j;
        } else {
            i += 1;
        }
    }
    n
}

/// What an office file became, for the composer's chip and the wire.
#[derive(Debug, Clone, Serialize)]
pub struct Prepared {
    /// `application/pdf` (converted) or `text/plain` (extracted).
    pub media_type: String,
    pub name: String,
    /// Base64, no `data:` prefix — a [`DocumentInput`]'s `data`.
    pub data: String,
    /// `"pdf"` or `"text"`: what the chip says happened.
    pub via: &'static str,
    /// Pages of the PDF, or slides/sheets the text came from.
    pub count: Option<usize>,
    /// Why the text path was taken when a converter was there (a timeout,
    /// a failed conversion) — shown to him, never sent to the model.
    pub note: Option<String>,
}

/// An office file made sendable: a PDF when `soffice` is given and the
/// conversion works, else its text. The converter failing is not the end:
/// the text path runs and `note` says why it was taken. Only a file
/// neither path can read is an error.
pub async fn prepare_office(
    name: &str,
    bytes: &[u8],
    soffice: Option<&Path>,
    timeout: Duration,
) -> Result<Prepared, String> {
    let format = OfficeFormat::of(name).ok_or_else(|| format!("{name}: not an office file"))?;
    let mut note = None;
    if let Some(soffice) = soffice {
        match convert_to_pdf(soffice, name, bytes, timeout).await {
            Ok(pdf) => {
                return Ok(Prepared {
                    media_type: "application/pdf".into(),
                    name: name.to_string(),
                    count: Some(pdf_page_count(&pdf)),
                    data: base64::engine::general_purpose::STANDARD.encode(&pdf),
                    via: "pdf",
                    note: None,
                });
            }
            Err(e) => note = Some(e),
        }
    }
    if !format.extractable() {
        return Err(match note {
            Some(e) => format!(
                "{e} — and a {} file has no text Nightloom can read without it",
                ext_of(name)
            ),
            None => format!(
                "{name}: a {} file needs LibreOffice to read (brew install --cask libreoffice)",
                ext_of(name)
            ),
        });
    }
    let (text, count) = extract(name, format, bytes)?;
    Ok(Prepared {
        media_type: "text/plain".into(),
        name: name.to_string(),
        data: base64::engine::general_purpose::STANDARD.encode(text.as_bytes()),
        via: "text",
        count: Some(count),
        note,
    })
}

fn ext_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy().to_ascii_lowercase()))
        .unwrap_or_else(|| "this".into())
}

/// The text of an OOXML or OpenDocument file, with a first line telling the
/// model what it is reading and what it is not (pictures).
pub fn extract_text(name: &str, bytes: &[u8]) -> Result<String, String> {
    let format = OfficeFormat::of(name).ok_or_else(|| format!("{name}: not an office file"))?;
    extract(name, format, bytes).map(|(t, _)| t)
}

fn extract(name: &str, format: OfficeFormat, bytes: &[u8]) -> Result<(String, usize), String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| format!("{name}: not a readable {} file ({e})", ext_of(name)))?;
    let (body, count, unit) = match format {
        OfficeFormat::Pptx => {
            let (b, n) = pptx_text(&mut zip)?;
            (b, n, "slide")
        }
        OfficeFormat::Docx => {
            let xml = entry(&mut zip, "word/document.xml")?;
            (paragraphs(&xml, &WORD).join("\n"), 1, "document")
        }
        OfficeFormat::Xlsx => {
            let (b, n) = xlsx_text(&mut zip)?;
            (b, n, "sheet")
        }
        OfficeFormat::Odp | OfficeFormat::Odt | OfficeFormat::Ods => {
            let xml = entry(&mut zip, "content.xml")?;
            let (b, n) = odf_text(&xml, format);
            (
                b,
                n,
                if format.is_slides() {
                    "slide"
                } else if format == OfficeFormat::Ods {
                    "sheet"
                } else {
                    "document"
                },
            )
        }
        OfficeFormat::ConverterOnly => {
            return Err(format!("{name}: needs LibreOffice to read"));
        }
    };
    let what = if unit == "document" {
        String::new()
    } else {
        format!(", {count} {unit}{}", if count == 1 { "" } else { "s" })
    };
    let mut text = format!(
        "[Text extracted from {name}{what}. Pictures, charts and layout are not included — only the words.]\n\n{body}"
    );
    if text.len() > MAX_EXTRACTED_TEXT {
        let mut cut = MAX_EXTRACTED_TEXT;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str(
            "\n\n[… cut here: the rest of the file's text is past what one message should carry.]",
        );
    }
    Ok((text, count))
}

fn entry<R: std::io::Read + std::io::Seek>(
    zip: &mut zip::ZipArchive<R>,
    path: &str,
) -> Result<String, String> {
    let mut f = zip
        .by_name(path)
        .map_err(|_| format!("the file has no {path}"))?;
    let mut s = String::new();
    f.read_to_string(&mut s)
        .map_err(|e| format!("{path}: {e}"))?;
    Ok(s)
}

fn entry_opt<R: std::io::Read + std::io::Seek>(
    zip: &mut zip::ZipArchive<R>,
    path: &str,
) -> Option<String> {
    entry(zip, path).ok()
}

/// `Target`s of a relationships file, by `Id`, resolved against `base`
/// (the folder of the part the rels belong to).
fn rels(xml: &str, base: &str) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    for ev in XmlEvents::new(xml) {
        if let Ev::Open { name, attrs, .. } = ev
            && local(name) == "Relationship"
        {
            let id = attr(attrs, "Id").unwrap_or_default();
            let ty = attr(attrs, "Type").unwrap_or_default();
            let target = attr(attrs, "Target").unwrap_or_default();
            out.push((id, ty, resolve(base, &target)));
        }
    }
    out
}

fn resolve(base: &str, target: &str) -> String {
    if let Some(abs) = target.strip_prefix('/') {
        return abs.to_string();
    }
    let mut parts: Vec<&str> = base.split('/').filter(|p| !p.is_empty()).collect();
    for seg in target.split('/') {
        match seg {
            ".." => {
                parts.pop();
            }
            "." | "" => {}
            s => parts.push(s),
        }
    }
    parts.join("/")
}

fn pptx_text<R: std::io::Read + std::io::Seek>(
    zip: &mut zip::ZipArchive<R>,
) -> Result<(String, usize), String> {
    // The deck's order is presentation.xml's list, not the part names: a
    // slide moved in PowerPoint keeps its file name.
    let mut slides: Vec<String> = Vec::new();
    if let (Some(pres), Some(prels)) = (
        entry_opt(zip, "ppt/presentation.xml"),
        entry_opt(zip, "ppt/_rels/presentation.xml.rels"),
    ) {
        let targets = rels(&prels, "ppt");
        for ev in XmlEvents::new(&pres) {
            if let Ev::Open { name, attrs, .. } = ev
                && name == "p:sldId"
                && let Some(rid) = attr(attrs, "r:id")
                && let Some((_, _, t)) = targets.iter().find(|(id, _, _)| *id == rid)
            {
                slides.push(t.clone());
            }
        }
    }
    if slides.is_empty() {
        let mut names: Vec<(u32, String)> = zip
            .file_names()
            .filter_map(|n| {
                let num = n.strip_prefix("ppt/slides/slide")?.strip_suffix(".xml")?;
                Some((num.parse().ok()?, n.to_string()))
            })
            .collect();
        names.sort();
        slides = names.into_iter().map(|(_, n)| n).collect();
    }
    let mut out = Vec::new();
    for (i, path) in slides.iter().enumerate() {
        let xml = entry(zip, path)?;
        let mut block = format!("--- Slide {} ---", i + 1);
        let lines = paragraphs(&xml, &DRAWING);
        if lines.is_empty() {
            block.push_str("\n(no text on this slide — pictures only)");
        } else {
            for l in lines {
                block.push('\n');
                block.push_str(&l);
            }
        }
        // Speaker notes: the slide's rels name its notes part; its text is
        // the body placeholder's (the slide image and number are not notes).
        let (folder, file) = path.rsplit_once('/').unwrap_or(("", path));
        let rels_path = format!("{folder}/_rels/{file}.rels");
        if let Some(r) = entry_opt(zip, &rels_path) {
            let notes = rels(&r, folder)
                .into_iter()
                .find(|(_, ty, _)| ty.ends_with("/notesSlide"))
                .and_then(|(_, _, t)| entry_opt(zip, &t));
            if let Some(nx) = notes {
                let text = notes_body(&nx);
                if !text.is_empty() {
                    block.push_str("\nSpeaker notes: ");
                    block.push_str(&text.join("\n"));
                }
            }
        }
        out.push(block);
    }
    Ok((out.join("\n\n"), slides.len()))
}

/// The paragraphs of a notes slide's body placeholder.
fn notes_body(xml: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut start = None;
    let mut body = false;
    // Find each top-level `p:sp`, decide by its placeholder, collect its text.
    let events: Vec<Ev> = XmlEvents::new(xml).collect();
    for (i, ev) in events.iter().enumerate() {
        match ev {
            Ev::Open {
                name: "p:sp",
                empty: false,
                ..
            } => {
                if depth == 0 {
                    start = Some(i);
                    body = false;
                }
                depth += 1;
            }
            Ev::Open {
                name: "p:ph",
                attrs,
                ..
            } if depth > 0 => {
                if attr(attrs, "type").as_deref() == Some("body") {
                    body = true;
                }
            }
            Ev::Close("p:sp") if depth > 0 => {
                depth -= 1;
                if depth == 0
                    && body
                    && let Some(s) = start
                {
                    out.extend(paragraphs_of(&events[s..=i], &DRAWING));
                }
            }
            _ => {}
        }
    }
    out
}

fn xlsx_text<R: std::io::Read + std::io::Seek>(
    zip: &mut zip::ZipArchive<R>,
) -> Result<(String, usize), String> {
    let shared: Vec<String> = entry_opt(zip, "xl/sharedStrings.xml")
        .map(|xml| {
            let mut out = Vec::new();
            let mut cur: Option<String> = None;
            let mut in_t = false;
            for ev in XmlEvents::new(&xml) {
                match ev {
                    Ev::Open {
                        name: "si", empty, ..
                    } => {
                        if empty {
                            out.push(String::new());
                        } else {
                            cur = Some(String::new());
                        }
                    }
                    Ev::Close("si") => out.push(cur.take().unwrap_or_default()),
                    Ev::Open {
                        name: "t",
                        empty: false,
                        ..
                    } => in_t = true,
                    Ev::Close("t") => in_t = false,
                    Ev::Text(t) if in_t => {
                        if let Some(c) = cur.as_mut() {
                            c.push_str(&t);
                        }
                    }
                    _ => {}
                }
            }
            out
        })
        .unwrap_or_default();
    let wb = entry(zip, "xl/workbook.xml")?;
    let wrels = entry_opt(zip, "xl/_rels/workbook.xml.rels")
        .map(|r| rels(&r, "xl"))
        .unwrap_or_default();
    let mut sheets: Vec<(String, String)> = Vec::new();
    for ev in XmlEvents::new(&wb) {
        if let Ev::Open { name, attrs, .. } = ev
            && local(name) == "sheet"
        {
            let sname = attr(attrs, "name").unwrap_or_else(|| "Sheet".into());
            if let Some(rid) = attr(attrs, "r:id")
                && let Some((_, _, t)) = wrels.iter().find(|(id, _, _)| *id == rid)
            {
                sheets.push((sname, t.clone()));
            }
        }
    }
    let mut out = Vec::new();
    for (sname, path) in &sheets {
        let Some(xml) = entry_opt(zip, path) else {
            continue;
        };
        let mut block = format!("--- Sheet: {sname} ---");
        let mut rows = 0usize;
        let mut row: Vec<(usize, String)> = Vec::new();
        let mut cell: Option<(usize, String, String)> = None; // col, type, value
        let mut in_value = false;
        for ev in XmlEvents::new(&xml) {
            match ev {
                Ev::Open {
                    name: "row",
                    empty: false,
                    ..
                } => row.clear(),
                Ev::Close("row") => {
                    if !row.is_empty() {
                        let width = row.iter().map(|(c, _)| *c).max().unwrap_or(0) + 1;
                        let mut cols = vec![String::new(); width];
                        for (c, v) in row.drain(..) {
                            cols[c] = v;
                        }
                        block.push('\n');
                        block.push_str(&cols.join("\t"));
                        rows += 1;
                    }
                }
                Ev::Open {
                    name: "c",
                    attrs,
                    empty,
                } => {
                    let col = attr(attrs, "r")
                        .map(|r| column_index(&r))
                        .unwrap_or(row.len());
                    let ty = attr(attrs, "t").unwrap_or_default();
                    if !empty {
                        cell = Some((col, ty, String::new()));
                    }
                }
                Ev::Close("c") => {
                    if let Some((col, ty, v)) = cell.take() {
                        let v = match ty.as_str() {
                            "s" => v
                                .trim()
                                .parse::<usize>()
                                .ok()
                                .and_then(|i| shared.get(i).cloned())
                                .unwrap_or_default(),
                            "b" => {
                                if v.trim() == "1" {
                                    "TRUE".into()
                                } else {
                                    "FALSE".into()
                                }
                            }
                            _ => v,
                        };
                        if !v.is_empty() {
                            row.push((col, v.replace(['\t', '\n'], " ")));
                        }
                    }
                }
                Ev::Open {
                    name: "v" | "t",
                    empty: false,
                    ..
                } => in_value = true,
                Ev::Close("v" | "t") => in_value = false,
                Ev::Text(t) if in_value => {
                    if let Some((_, _, v)) = cell.as_mut() {
                        v.push_str(&t);
                    }
                }
                _ => {}
            }
        }
        if rows == 0 {
            block.push_str("\n(empty)");
        }
        out.push(block);
    }
    Ok((out.join("\n\n"), sheets.len()))
}

/// `"C12"` → 2.
fn column_index(r: &str) -> usize {
    let mut n = 0usize;
    for c in r.chars().take_while(|c| c.is_ascii_alphabetic()) {
        n = n * 26 + (c.to_ascii_uppercase() as usize - 'A' as usize + 1);
    }
    n.saturating_sub(1)
}

fn odf_text(xml: &str, format: OfficeFormat) -> (String, usize) {
    // Pages (slides, sheets) are split first so each gets its heading; a
    // text document is one page.
    let events: Vec<Ev> = XmlEvents::new(xml).collect();
    let page_tag = match format {
        OfficeFormat::Odp => Some("draw:page"),
        OfficeFormat::Ods => Some("table:table"),
        _ => None,
    };
    let Some(tag) = page_tag else {
        return (paragraphs_of(&events, &ODF).join("\n"), 1);
    };
    let mut out = Vec::new();
    let mut start = None;
    let mut label = String::new();
    let mut depth = 0usize;
    for (i, ev) in events.iter().enumerate() {
        match ev {
            Ev::Open {
                name,
                attrs,
                empty: false,
            } if *name == tag => {
                if depth == 0 {
                    start = Some(i);
                    label = attr(attrs, "table:name").unwrap_or_default();
                }
                depth += 1;
            }
            Ev::Close(name) if *name == tag && depth > 0 => {
                depth -= 1;
                if depth == 0
                    && let Some(s) = start
                {
                    let n = out.len() + 1;
                    let page = &events[s..=i];
                    let mut block = if format == OfficeFormat::Odp {
                        format!("--- Slide {n} ---")
                    } else {
                        format!("--- Sheet: {label} ---")
                    };
                    // Notes ride inside the page as `presentation:notes`.
                    let (body, notes) = split_notes(page);
                    let lines = paragraphs_of(&body, &ODF);
                    if lines.is_empty() {
                        block.push_str(if format == OfficeFormat::Odp {
                            "\n(no text on this slide — pictures only)"
                        } else {
                            "\n(empty)"
                        });
                    }
                    for l in lines {
                        block.push('\n');
                        block.push_str(&l);
                    }
                    let notes = paragraphs_of(&notes, &ODF);
                    if !notes.is_empty() {
                        block.push_str("\nSpeaker notes: ");
                        block.push_str(&notes.join("\n"));
                    }
                    out.push(block);
                }
            }
            _ => {}
        }
    }
    let n = out.len();
    (out.join("\n\n"), n)
}

fn split_notes<'a>(page: &[Ev<'a>]) -> (Vec<Ev<'a>>, Vec<Ev<'a>>) {
    let mut body = Vec::new();
    let mut notes = Vec::new();
    let mut depth = 0usize;
    for ev in page {
        let into_notes = depth > 0;
        match ev {
            Ev::Open {
                name: "presentation:notes",
                empty: false,
                ..
            } => {
                depth += 1;
                continue;
            }
            Ev::Close("presentation:notes") if depth > 0 => {
                depth -= 1;
                continue;
            }
            _ => {}
        }
        if into_notes {
            notes.push(ev.clone());
        } else {
            body.push(ev.clone());
        }
    }
    (body, notes)
}

/// The tag names one family of formats uses for the shapes of text.
struct Dialect {
    para: &'static [&'static str],
    /// Text counts only inside one of these; empty means anywhere in a
    /// paragraph (OpenDocument puts text straight into `text:p`).
    run: &'static [&'static str],
    row: &'static str,
    cell: &'static str,
    tab: &'static [&'static str],
    brk: &'static [&'static str],
}

const DRAWING: Dialect = Dialect {
    para: &["a:p"],
    run: &["a:t"],
    row: "a:tr",
    cell: "a:tc",
    tab: &[],
    brk: &["a:br"],
};
const WORD: Dialect = Dialect {
    para: &["w:p"],
    run: &["w:t"],
    row: "w:tr",
    cell: "w:tc",
    tab: &["w:tab"],
    brk: &["w:br", "w:cr"],
};
const ODF: Dialect = Dialect {
    para: &["text:p", "text:h"],
    run: &[],
    row: "table:table-row",
    cell: "table:table-cell",
    tab: &["text:tab"],
    brk: &["text:line-break"],
};

fn paragraphs(xml: &str, d: &Dialect) -> Vec<String> {
    let events: Vec<Ev> = XmlEvents::new(xml).collect();
    paragraphs_of(&events, d)
}

/// Lines of text: one per paragraph outside a table, one per table row
/// (`cell | cell | cell`) inside one.
fn paragraphs_of(events: &[Ev], d: &Dialect) -> Vec<String> {
    let mut out = Vec::new();
    let mut para: Option<String> = None;
    let mut run_depth = 0usize;
    let mut row: Option<Vec<String>> = None;
    let mut cell: Option<String> = None;
    let mut table_depth = 0usize;
    for ev in events {
        match ev {
            Ev::Open {
                name, empty: false, ..
            } if *name == d.row => {
                table_depth += 1;
                row = Some(Vec::new());
            }
            Ev::Close(name) if *name == d.row && table_depth > 0 => {
                table_depth -= 1;
                if let Some(r) = row.take() {
                    let r: Vec<String> = r.into_iter().map(|c| c.trim().to_string()).collect();
                    if r.iter().any(|c| !c.is_empty()) {
                        out.push(r.join(" | "));
                    }
                }
            }
            Ev::Open { name, empty, .. } if *name == d.cell => {
                if *empty {
                    if let Some(r) = row.as_mut() {
                        r.push(String::new());
                    }
                } else {
                    cell = Some(String::new());
                }
            }
            Ev::Close(name) if *name == d.cell => {
                if let (Some(r), Some(c)) = (row.as_mut(), cell.take()) {
                    r.push(c);
                }
            }
            Ev::Open {
                name, empty: false, ..
            } if d.para.contains(name) => {
                para = Some(String::new());
            }
            Ev::Close(name) if d.para.contains(name) => {
                if let Some(p) = para.take() {
                    if let Some(c) = cell.as_mut() {
                        if !c.is_empty() && !p.is_empty() {
                            c.push(' ');
                        }
                        c.push_str(&p);
                    } else {
                        let p = p.trim_end().to_string();
                        if !p.trim().is_empty() {
                            out.push(p);
                        }
                    }
                }
            }
            Ev::Open {
                name, empty: false, ..
            } if d.run.contains(name) => run_depth += 1,
            Ev::Close(name) if d.run.contains(name) => run_depth = run_depth.saturating_sub(1),
            Ev::Open { name, .. } if d.tab.contains(name) => {
                if let Some(p) = para.as_mut() {
                    p.push('\t');
                }
            }
            Ev::Open { name, .. } if d.brk.contains(name) => {
                if let Some(p) = para.as_mut() {
                    p.push(' ');
                }
            }
            Ev::Text(t) if para.is_some() && (d.run.is_empty() || run_depth > 0) => {
                if let Some(p) = para.as_mut() {
                    p.push_str(t);
                }
            }
            _ => {}
        }
    }
    out
}

/// A minimal XML event reader: enough for the text of office parts, which
/// are machine-written, namespace-prefixed and entity-light. Comments,
/// processing instructions and CDATA are skipped (CDATA's text kept).
#[derive(Debug, Clone, PartialEq)]
enum Ev<'a> {
    Open {
        name: &'a str,
        attrs: &'a str,
        empty: bool,
    },
    Close(&'a str),
    Text(String),
}

struct XmlEvents<'a> {
    s: &'a str,
    i: usize,
}

impl<'a> XmlEvents<'a> {
    fn new(s: &'a str) -> Self {
        Self { s, i: 0 }
    }
}

impl<'a> Iterator for XmlEvents<'a> {
    type Item = Ev<'a>;
    fn next(&mut self) -> Option<Ev<'a>> {
        loop {
            let rest = &self.s[self.i..];
            if rest.is_empty() {
                return None;
            }
            if !rest.starts_with('<') {
                let end = rest.find('<').unwrap_or(rest.len());
                self.i += end;
                return Some(Ev::Text(unescape(&rest[..end])));
            }
            if let Some(body) = rest.strip_prefix("<![CDATA[") {
                let end = body.find("]]>").unwrap_or(body.len());
                self.i += 9 + end + 3.min(body.len() - end);
                return Some(Ev::Text(body[..end].to_string()));
            }
            if rest.starts_with("<!--") {
                let end = rest.find("-->").map(|e| e + 3).unwrap_or(rest.len());
                self.i += end;
                continue;
            }
            if rest.starts_with("<?") || rest.starts_with("<!") {
                let end = rest.find('>').map(|e| e + 1).unwrap_or(rest.len());
                self.i += end;
                continue;
            }
            let Some(end) = tag_end(rest) else {
                self.i = self.s.len();
                return None;
            };
            let inner = &rest[1..end];
            self.i += end + 1;
            if let Some(name) = inner.strip_prefix('/') {
                return Some(Ev::Close(name.trim()));
            }
            let (inner, empty) = match inner.strip_suffix('/') {
                Some(i) => (i, true),
                None => (inner, false),
            };
            let split = inner
                .find(|c: char| c.is_ascii_whitespace())
                .unwrap_or(inner.len());
            return Some(Ev::Open {
                name: &inner[..split],
                attrs: &inner[split..],
                empty,
            });
        }
    }
}

/// The `>` that closes a tag starting at `s[0]`, skipping quoted values.
fn tag_end(s: &str) -> Option<usize> {
    let mut quote: Option<char> = None;
    for (i, c) in s.char_indices().skip(1) {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (None, '"' | '\'') => quote = Some(c),
            (None, '>') => return Some(i),
            _ => {}
        }
    }
    None
}

fn local(name: &str) -> &str {
    name.rsplit_once(':').map_or(name, |(_, l)| l)
}

/// One attribute's value, unescaped. `key` is matched whole, so `id` does
/// not find `r:id`.
fn attr(attrs: &str, key: &str) -> Option<String> {
    let mut rest = attrs;
    loop {
        rest = rest.trim_start();
        let eq = rest.find('=')?;
        let k = rest[..eq].trim();
        let after = rest[eq + 1..].trim_start();
        let q = after.chars().next()?;
        if q != '"' && q != '\'' {
            return None;
        }
        let close = after[1..].find(q)? + 1;
        let v = &after[1..close];
        if k == key {
            return Some(unescape(v));
        }
        rest = &after[close + 1..];
    }
}

fn unescape(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let Some(semi) = rest.find(';').filter(|&j| j <= 10) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let ent = &rest[1..semi];
        let ch = match ent {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => ent
                .strip_prefix("#x")
                .or_else(|| ent.strip_prefix("#X"))
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| ent.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &rest[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// The away server's half (the phone, item 277): a document that is neither
/// a PDF nor text is an office file the phone sent as it was, and the server
/// has no converter (none is added to the Fly image) — so its text goes in
/// its place. A file nothing can read becomes a text note naming it, the
/// [`nightloom_core::undeliverable_document`] rule: never a silent drop.
pub fn normalize_documents(docs: &mut [DocumentInput]) {
    for doc in docs.iter_mut() {
        if doc.media_type == "application/pdf" || doc.is_text() {
            continue;
        }
        let text = match base64::engine::general_purpose::STANDARD.decode(doc.data.trim()) {
            Ok(bytes) => match OfficeFormat::of(&doc.name)
                .filter(|f| f.extractable())
                .map(|f| extract(&doc.name, f, &bytes))
            {
                Some(Ok((t, _))) => t,
                Some(Err(e)) => format!("[{} could not be read: {e}]", doc.name),
                None => format!(
                    "[The user attached {} ({}), which Nightloom's server cannot read; say so rather than answering from the name.]",
                    doc.name, doc.media_type
                ),
            },
            Err(_) => format!("[{} arrived damaged and could not be read]", doc.name),
        };
        doc.media_type = "text/plain".into();
        doc.data = base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
    }
}

/// The chat's own attachments folder: `<workspace>/.nightloom/attachments/
/// <chat id>/`. Inside the working directory, so the CLI reads it without a
/// grant or a prompt; under `.nightloom`, which the sync and the docspace
/// skip (a dot folder), with a `.gitignore` of `*` so a committed workspace
/// does not take his files along.
pub fn chat_files_dir(workspace: &Path, chat_id: &str) -> PathBuf {
    let safe: String = chat_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    workspace.join(".nightloom").join("attachments").join(safe)
}

/// A file for the Claude Code engine: its name and base64 bytes.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct FileInput {
    pub name: String,
    pub data: String,
}

/// Copy `files` into the chat's folder; the paths written, in order. A name
/// already there gets ` (2)`, ` (3)`… rather than overwriting an earlier
/// turn's file the model may still be reading.
pub fn save_chat_files(
    workspace: &Path,
    chat_id: &str,
    files: &[FileInput],
) -> Result<Vec<PathBuf>, String> {
    let dir = chat_files_dir(workspace, chat_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    if let Some(root) = dir.parent() {
        let ignore = root.join(".gitignore");
        if !ignore.exists() {
            let _ = std::fs::write(&ignore, "*\n");
        }
    }
    let mut out = Vec::new();
    for f in files {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(f.data.trim())
            .map_err(|e| format!("{}: {e}", f.name))?;
        let leaf = Path::new(&f.name)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .filter(|n| !n.is_empty() && n != "." && n != "..")
            .unwrap_or_else(|| "attachment".into());
        let mut path = dir.join(&leaf);
        let (stem, ext) = match leaf.rsplit_once('.') {
            Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
            _ => (leaf.clone(), String::new()),
        };
        let mut n = 2;
        while path.exists() {
            path = dir.join(format!("{stem} ({n}){ext}"));
            n += 1;
        }
        std::fs::write(&path, &bytes).map_err(|e| format!("{}: {e}", path.display()))?;
        out.push(path);
    }
    Ok(out)
}

/// The line the message carries for files saved for the model: where each
/// is, and that it is the model's to open.
pub fn files_note(paths: &[PathBuf]) -> String {
    let list: Vec<String> = paths.iter().map(|p| format!("- {}", p.display())).collect();
    format!(
        "[Attached {} — saved for you to open with your tools:\n{}]",
        if paths.len() == 1 { "a file" } else { "files" },
        list.join("\n")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn fixture(name: &str) -> Vec<u8> {
        let p = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/attach")
            .join(name);
        std::fs::read(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()))
    }

    fn b64(s: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(s.as_bytes())
    }

    #[test]
    fn a_deck_reads_as_its_slides_in_order_with_notes_and_tables() {
        let t = extract_text("lecture.pptx", &fixture("lecture.pptx")).unwrap();
        assert!(
            t.starts_with("[Text extracted from lecture.pptx, 3 slides."),
            "{t}"
        );
        let s1 = t.find("--- Slide 1 ---").unwrap();
        let s2 = t.find("--- Slide 2 ---").unwrap();
        let s3 = t.find("--- Slide 3 ---").unwrap();
        assert!(s1 < s2 && s2 < s3);
        assert!(t[s1..s2].contains("Lecture 7: Photosynthesis"));
        assert!(t[s1..s2].contains(
            "Speaker notes: Speaker note: the secret word for this lecture is MARMALADE."
        ));
        assert!(t[s2..s3].contains("Crop | 2024 | 2025"));
        assert!(t[s2..s3].contains("Barley | 2.2 | 2.9"));
        assert!(t[s3..].contains("(no text on this slide — pictures only)"));
        // The slide-number placeholder of the notes page is not a note.
        assert_eq!(t.matches("Speaker notes:").count(), 1);
    }

    #[test]
    fn a_word_file_reads_as_paragraphs_and_table_rows() {
        let t = extract_text("report.docx", &fixture("report.docx")).unwrap();
        assert!(t.contains("Lab report"));
        assert!(t.contains("The measured boiling point was 78.4 degrees Celsius."));
        assert!(t.contains("Sample | Mass (g)"));
        assert!(t.contains("A | 12.5"));
    }

    #[test]
    fn a_workbook_reads_as_its_sheets_cell_by_cell() {
        let t = extract_text("grades.xlsx", &fixture("grades.xlsx")).unwrap();
        assert!(t.contains(", 2 sheets."), "{t}");
        assert!(
            t.contains("--- Sheet: Grades ---\nStudent\tMidterm\tFinal\nAda\t91\t95\nLin\t84\t88"),
            "{t}"
        );
        assert!(t.contains("--- Sheet: Notes ---\nCurve applied: +3"), "{t}");
    }

    #[test]
    fn shared_strings_and_gaps_land_in_their_columns() {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            let o = zip::write::SimpleFileOptions::default();
            z.start_file("xl/workbook.xml", o).unwrap();
            z.write_all(br#"<workbook><sheets><sheet name="S &amp; P" sheetId="1" r:id="rId1"/></sheets></workbook>"#).unwrap();
            z.start_file("xl/_rels/workbook.xml.rels", o).unwrap();
            z.write_all(br#"<Relationships><Relationship Id="rId1" Type="x/worksheet" Target="/xl/worksheets/sheet1.xml"/></Relationships>"#).unwrap();
            z.start_file("xl/sharedStrings.xml", o).unwrap();
            z.write_all(
                b"<sst><si><t>alpha</t></si><si><r><t>be</t></r><r><t>ta</t></r></si></sst>",
            )
            .unwrap();
            z.start_file("xl/worksheets/sheet1.xml", o).unwrap();
            z.write_all(br#"<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>1</v></c><c r="C1" t="s"><v>0</v></c><c r="D1" t="b"><v>1</v></c></row></sheetData></worksheet>"#).unwrap();
            z.finish().unwrap();
        }
        let t = extract_text("s.xlsx", buf.get_ref()).unwrap();
        assert!(
            t.contains("--- Sheet: S & P ---\nbeta\t\talpha\tTRUE"),
            "{t}"
        );
    }

    #[test]
    fn a_legacy_file_without_the_converter_says_what_it_needs() {
        let e = futures::executor::block_on(prepare_office(
            "old.ppt",
            b"\xd0\xcf\x11\xe0",
            None,
            CONVERT_TIMEOUT,
        ))
        .unwrap_err();
        assert!(e.contains("needs LibreOffice"), "{e}");
    }

    #[test]
    fn without_a_converter_a_deck_goes_as_its_text() {
        let p = futures::executor::block_on(prepare_office(
            "lecture.pptx",
            &fixture("lecture.pptx"),
            None,
            CONVERT_TIMEOUT,
        ))
        .unwrap();
        assert_eq!(p.via, "text");
        assert_eq!(p.media_type, "text/plain");
        assert_eq!(p.count, Some(3));
        assert!(p.note.is_none());
        let doc = DocumentInput {
            media_type: p.media_type,
            name: p.name,
            data: p.data,
        };
        assert!(doc.decoded_text().contains("MARMALADE"));
    }

    #[cfg(unix)]
    fn fake_soffice(dir: &Path, script: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt as _;
        let p = dir.join("soffice");
        std::fs::write(&p, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "nightloom-attach-test-{tag}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_converter_that_hangs_is_killed_at_the_timeout_and_the_text_goes_instead() {
        let d = scratch("hang");
        let soffice = fake_soffice(&d, "sleep 30");
        let started = std::time::Instant::now();
        let p = prepare_office(
            "lecture.pptx",
            &fixture("lecture.pptx"),
            Some(&soffice),
            Duration::from_millis(400),
        )
        .await
        .unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
        assert_eq!(p.via, "text");
        let note = p.note.unwrap();
        assert!(
            note.contains("did not finish converting lecture.pptx"),
            "{note}"
        );
        let _ = std::fs::remove_dir_all(d);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_converter_that_writes_nothing_falls_back_with_its_reason() {
        let d = scratch("empty");
        let soffice = fake_soffice(
            &d,
            "echo 'Error: source file could not be loaded' >&2; exit 1",
        );
        let p = prepare_office(
            "report.docx",
            &fixture("report.docx"),
            Some(&soffice),
            CONVERT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_eq!(p.via, "text");
        let note = p.note.unwrap();
        assert!(
            note.contains("wrote no PDF") && note.contains("could not be loaded"),
            "{note}"
        );
        let _ = std::fs::remove_dir_all(d);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_converted_pdf_comes_back_and_the_temp_folder_goes() {
        let d = scratch("ok");
        // A stand-in that does what soffice does: writes <outdir>/input.pdf.
        let soffice = fake_soffice(
            &d,
            r#"while [ "$1" != "--outdir" ]; do shift; done; out="$2"; printf '%%PDF-1.4\n1 0 obj << /Type /Pages >> endobj\n2 0 obj << /Type /Page >> endobj\n3 0 obj << /Type/Page >> endobj\n' > "$out/input.pdf""#,
        );
        // Counted under the conversion lock: a folder exists only while
        // a conversion holds it, so other tests' runs are not counted.
        let before: usize = {
            let _one = CONVERT_LOCK.lock().await;
            count_convert_dirs()
        };
        let p = prepare_office(
            "lecture.pptx",
            &fixture("lecture.pptx"),
            Some(&soffice),
            CONVERT_TIMEOUT,
        )
        .await
        .unwrap();
        assert_eq!(p.via, "pdf");
        assert_eq!(p.media_type, "application/pdf");
        assert_eq!(p.count, Some(2));
        let _one = CONVERT_LOCK.lock().await;
        assert!(count_convert_dirs() <= before);
        let _ = std::fs::remove_dir_all(d);
    }

    fn count_convert_dirs() -> usize {
        std::fs::read_dir(std::env::temp_dir())
            .map(|r| {
                r.filter_map(|e| e.ok())
                    .filter(|e| {
                        e.file_name()
                            .to_string_lossy()
                            .starts_with("nightloom-convert-")
                    })
                    .count()
            })
            .unwrap_or(0)
    }

    /// The real LibreOffice, when this machine has it: one PDF page per
    /// slide. Ignored by default (CI has no LibreOffice); run with
    /// `cargo test -p nightloom-service attach -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn libreoffice_renders_one_page_per_slide() {
        let soffice = find_soffice().expect("LibreOffice is not installed");
        let pdf = convert_to_pdf(
            &soffice,
            "lecture.pptx",
            &fixture("lecture.pptx"),
            CONVERT_TIMEOUT,
        )
        .await
        .unwrap();
        assert!(pdf.starts_with(b"%PDF"));
        assert_eq!(pdf_page_count(&pdf), 3);
        if let Ok(dir) = std::env::var("NIGHTLOOM_ATTACH_OUT") {
            std::fs::write(Path::new(&dir).join("lecture.pdf"), &pdf).unwrap();
        }
        for (name, pages) in [("report.docx", 1), ("grades.xlsx", 0)] {
            let pdf = convert_to_pdf(&soffice, name, &fixture(name), CONVERT_TIMEOUT)
                .await
                .unwrap();
            assert!(pdf.starts_with(b"%PDF"), "{name}");
            assert!(pdf_page_count(&pdf) >= pages.max(1), "{name}");
            if let Ok(dir) = std::env::var("NIGHTLOOM_ATTACH_OUT") {
                std::fs::write(Path::new(&dir).join(format!("{name}.pdf")), &pdf).unwrap();
            }
        }
        // And the deck's text path, as the model reads it: the block the
        // log projects (`DocumentInput::to_block`), for the end-to-end send.
        if let Ok(dir) = std::env::var("NIGHTLOOM_ATTACH_OUT") {
            let p = prepare_office(
                "lecture.pptx",
                &fixture("lecture.pptx"),
                None,
                CONVERT_TIMEOUT,
            )
            .await
            .unwrap();
            let doc = DocumentInput {
                media_type: p.media_type,
                name: p.name,
                data: p.data,
            };
            let nightloom_core::ContentBlock::Text { text } = doc.to_block() else {
                panic!("a text attachment projects to text");
            };
            std::fs::write(Path::new(&dir).join("lecture-text-block.txt"), text).unwrap();
        }
    }

    #[test]
    fn the_server_puts_text_where_an_office_file_was_and_a_note_where_nothing_reads() {
        use base64::Engine as _;
        let deck = base64::engine::general_purpose::STANDARD.encode(fixture("lecture.pptx"));
        let mut docs = vec![
            DocumentInput {
                media_type:
                    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
                        .into(),
                name: "lecture.pptx".into(),
                data: deck,
            },
            DocumentInput {
                media_type: "application/zip".into(),
                name: "bundle.zip".into(),
                data: b64("PK"),
            },
            DocumentInput {
                media_type: "application/pdf".into(),
                name: "a.pdf".into(),
                data: "JVBERg==".into(),
            },
            DocumentInput {
                media_type: "text/csv".into(),
                name: "d.csv".into(),
                data: b64("a,b"),
            },
        ];
        normalize_documents(&mut docs);
        assert_eq!(docs[0].media_type, "text/plain");
        assert!(docs[0].decoded_text().contains("MARMALADE"));
        assert_eq!(docs[1].media_type, "text/plain");
        assert!(docs[1].decoded_text().contains("cannot read"));
        assert_eq!(docs[2].media_type, "application/pdf");
        assert_eq!(docs[3].media_type, "text/csv");
    }

    #[test]
    fn files_land_in_the_chats_folder_and_never_overwrite() {
        let ws = scratch("ws");
        let files = vec![
            FileInput {
                name: "bundle.zip".into(),
                data: b64("one"),
            },
            FileInput {
                name: "../../escape.zip".into(),
                data: b64("two"),
            },
            FileInput {
                name: "bundle.zip".into(),
                data: b64("three"),
            },
        ];
        let paths = save_chat_files(&ws, "chat/1", &files).unwrap();
        let dir = ws.join(".nightloom/attachments/chat_1");
        assert_eq!(
            paths,
            vec![
                dir.join("bundle.zip"),
                dir.join("escape.zip"),
                dir.join("bundle (2).zip")
            ]
        );
        assert_eq!(std::fs::read_to_string(&paths[2]).unwrap(), "three");
        assert_eq!(
            std::fs::read_to_string(ws.join(".nightloom/attachments/.gitignore")).unwrap(),
            "*\n"
        );
        let note = files_note(&paths);
        assert!(note.contains(&paths[0].display().to_string()));
        assert!(note.starts_with("[Attached files"));
        let _ = std::fs::remove_dir_all(ws);
    }

    #[test]
    fn the_reader_handles_entities_cdata_and_quoted_angles() {
        let evs: Vec<Ev> = XmlEvents::new(r#"<?xml?><a x="1>2" r:id='q'>&lt;b&gt; &amp;&#x41;&#66;<![CDATA[<raw>]]><!-- c --><e/></a>"#).collect();
        assert_eq!(
            evs[0],
            Ev::Open {
                name: "a",
                attrs: r#" x="1>2" r:id='q'"#,
                empty: false
            }
        );
        assert_eq!(evs[1], Ev::Text("<b> &AB".into()));
        assert_eq!(evs[2], Ev::Text("<raw>".into()));
        assert_eq!(
            evs[3],
            Ev::Open {
                name: "e",
                attrs: "",
                empty: true
            }
        );
        assert_eq!(evs[4], Ev::Close("a"));
        assert_eq!(
            attr(r#" id="7" r:id="rId3""#, "r:id").as_deref(),
            Some("rId3")
        );
        assert_eq!(attr(r#" r:id="rId3" id="7""#, "id").as_deref(), Some("7"));
        assert_eq!(column_index("AB12"), 27);
        assert_eq!(
            resolve("ppt/slides", "../notesSlides/n1.xml"),
            "ppt/notesSlides/n1.xml"
        );
    }
}
