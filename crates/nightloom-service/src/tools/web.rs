//! Reaching the network: fetching a URL, and searching the web.
//!
//! These are the first tools here that send bytes off the machine, and three
//! decisions follow from that.
//!
//! **Both are `Mutating`, and that is not a formality.** Reading a web page
//! feels like a read, and every other read here is `ReadOnly` — but the
//! reads that earned that classification are confined by a [`Root`], and
//! there is no [`Root`] for the network. The gap is not theoretical: a model
//! that has just read a file composes the URL itself, so a secret it saw two
//! rounds ago can leave in a query string, and `http://169.254.169.254/` is a
//! cloud metadata endpoint that a workspace confinement has nothing to say
//! about. `ReadOnly` would mean neither is ever shown to a user, and would
//! additionally let the call overlap its neighbours, so the classification
//! has to be the one that puts the URL in front of somebody before it is
//! sent. What that buys is exactly one thing — the user sees the URL — and
//! it is worth stating what it does not buy: with `--no-approval` there is no
//! gate at all, the same way there is none for `bash`, and no scheme or host
//! filter here is a sandbox either. `http`/`https` are the only schemes
//! accepted, which rules out `file://` reading the disk through the one tool
//! that has no root; loopback and private addresses are *not* blocked,
//! because "fetch what my dev server is rendering" is a real use and the gate
//! above is the honest place to make that judgement.
//!
//! **The HTML extractor is hand-rolled**, in the same spirit as the FNV-1a in
//! `project.rs` and reading `.git/HEAD` rather than spawning git. A real
//! parser is a large transitive tree for one tool whose output is read by a
//! model, not by a browser: what matters is that `<script>` bulk never
//! reaches the context, that structure survives as headings and list markers,
//! and that links keep their URLs so the next call has somewhere to go.
//! Where it gives up it says so — a page that extracts to nothing is almost
//! always rendered by JavaScript, and reporting that is the difference
//! between the model trying the site's API and the model trying the same URL
//! three more times.
//!
//! **Search is a curated table behind a key, and is simply absent without
//! one.** There is no vendor-neutral search API, so something has to be
//! chosen; the three here are chosen the way [`super::bench`] chooses
//! reviewers, and nothing is ever substituted. The alternative that was
//! considered and rejected is the providers' own server-side search
//! (Anthropic's `web_search`, Gemini grounding): those are *provider*
//! features, and a tool that vanishes when you change the model dropdown
//! would break the one promise the desktop makes loudest. Scraping a search
//! engine's HTML with no key was rejected for the reason nothing else here is
//! substituted either — a facility that silently degrades is worse than one
//! that is honestly missing.

use super::{READ_LIMIT, str_arg};
use nightloom_core::ToolDef;
use nightloom_core::tool::{CancellationToken, Effect, Tool};
use reqwest::{Client, Url};
use serde_json::{Value, json};
use std::time::Duration;

/// Long enough for a slow origin, short enough that a hung server does not
/// hold the whole turn open. Same argument as `bash`'s default timeout.
const TIMEOUT: Duration = Duration::from_secs(30);

/// Ceiling on what is pulled off the wire, before any extraction. Distinct
/// from [`READ_LIMIT`], which caps what the model is shown: a 40 MB page
/// still has to not be downloaded to be thrown away.
const MAX_DOWNLOAD: usize = 4 * 1024 * 1024;

const UA: &str = concat!("Nightloom/", env!("CARGO_PKG_VERSION"));

const ACCEPT: &str =
    "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5";

const FETCH_DESC: &str = "Fetch a URL over http or https and get back its text. HTML is \
     reduced to readable text with headings, list markers and links kept, so a link you want \
     to follow appears as [text](url) and can be fetched in turn. JSON and plain text come \
     back as sent. Use this to read documentation, an API response, a changelog, or a page \
     the user linked, and prefer it to running curl through bash: it handles redirects, \
     encodings and content types for you, and its output is shaped to be read. It cannot run \
     JavaScript, so a page assembled in the browser returns nothing useful — when that \
     happens look for the site's API or a direct link to the content rather than retrying. \
     Output is capped at 16 KiB; the reply tells you the full length and the offset to ask \
     for if you need the rest. This call leaves the machine: the URL is sent to whoever \
     serves it, so do not put anything from the workspace in a query string.";

const SEARCH_DESC_PREFIX: &str = "Search the web and get back a ranked list of results, each \
     with a title, a URL and a snippet. Use it when you need something you cannot know — \
     current documentation, a library's present API, whether a project is still maintained, \
     an error message nobody here has seen. Search finds candidates; it does not read them, \
     so follow a promising result with web_fetch to get the actual page. Prefer specific \
     queries with distinctive terms over questions in prose. This call leaves the machine: \
     the query is sent to a third-party search provider, so keep the workspace's contents \
     out of it. Queries here are answered by ";

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

pub struct Fetch {
    client: Client,
}

impl Default for Fetch {
    fn default() -> Self {
        Self::new()
    }
}

impl Fetch {
    pub fn new() -> Self {
        Self {
            client: http_client(),
        }
    }
}

#[async_trait::async_trait]
impl Tool for Fetch {
    /// Explicit rather than inherited from the default, because the first
    /// instinct on reading "fetch a page" is that it belongs with the other
    /// reads — see the module doc for why it does not.
    fn effect(&self) -> Effect {
        Effect::Mutating
    }

    fn def(&self) -> ToolDef {
        ToolDef {
            name: "web_fetch".into(),
            description: FETCH_DESC.into(),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "Absolute http or https URL to fetch."
                    },
                    "offset": {
                        "type": "integer",
                        "description": "Characters into the extracted text to start from. Use it to continue past a truncated reply; defaults to 0."
                    }
                },
                "required": ["url"]
            }),
        }
    }

    async fn call(&self, input: Value, cancel: &CancellationToken) -> Result<String, String> {
        let raw = str_arg(&input, "url")?;
        let url = parse_url(&raw)?;
        let offset = input["offset"].as_u64().unwrap_or(0) as usize;

        let response = super::interruptible(
            cancel,
            self.client
                .get(url.clone())
                .header(reqwest::header::ACCEPT, ACCEPT)
                .send(),
        )
        .await?
        .map_err(|e| format!("cannot fetch {url}: {}", why(&e)))?;

        let status = response.status();
        let landed = response.url().clone();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        // The download is the long half of a fetch, not the handshake.
        let bytes = super::interruptible(cancel, capped_body(response)).await??;

        let kind = classify(&content_type, &bytes);

        // The body is read even on a failure, because for an API it *is* the
        // explanation — which field was wrong, which scope is missing — and
        // that is what the model needs to fix the call. It goes through the
        // same extraction as a success: a failing HTML page clipped raw is
        // 400 characters of doctype and stylesheet links, where its text
        // usually says something ("moved to /v2/…").
        if !status.is_success() {
            return Err(format!(
                "{landed} returned {status}{}",
                explain(kind, &bytes)
            ));
        }
        let body = match kind {
            Body::Binary => {
                let what = if content_type.is_empty() {
                    "binary data".to_string()
                } else {
                    content_type.clone()
                };
                return Err(format!(
                    "{landed} served {what} ({}), which has no text to read. If the \
                     user needs its contents, ask them to attach the file.",
                    size(bytes.len())
                ));
            }
            Body::Pdf => {
                return Err(format!(
                    "{landed} served a PDF ({}). This tool returns text and cannot read \
                     one, but a PDF can be attached to the conversation directly — ask the \
                     user to attach it and you will be able to read it in full.",
                    size(bytes.len())
                ));
            }
            Body::Html => {
                let html = String::from_utf8_lossy(&bytes);
                let text = html_to_text(&html, &landed);
                if text.trim().len() < 40 && bytes.len() > 2000 {
                    return Err(format!(
                        "{landed} returned {} of HTML with no readable text in it. The page \
                         is almost certainly assembled in the browser by JavaScript, which \
                         this tool does not run. Look for the site's API, a documentation \
                         mirror, or a direct link to the content instead of retrying this URL.",
                        size(bytes.len())
                    ));
                }
                text
            }
            Body::Text => String::from_utf8_lossy(&bytes).into_owned(),
        };

        let mut header = format!("fetched {landed} ({}", describe(kind, &content_type));
        if landed.as_str() != url.as_str() {
            header.push_str(&format!("; redirected from {url}"));
        }
        header.push(')');
        Ok(format!("{header}\n\n{}", window(&body, offset)?))
    }
}

/// The useful part of a failed response's body, or nothing.
///
/// Capped hard: an error is a prompt to try something else, and a page of it
/// crowds out the conversation that was interrupted.
fn explain(kind: Body, bytes: &[u8]) -> String {
    let text = match kind {
        Body::Pdf | Body::Binary => return String::new(),
        Body::Html => {
            let html = String::from_utf8_lossy(bytes);
            html_to_text(
                &html,
                &Url::parse("https://invalid.example/").expect("literal"),
            )
        }
        Body::Text => String::from_utf8_lossy(bytes).into_owned(),
    };
    let clip: String = text.chars().take(400).collect();
    let clip = clip.trim();
    if clip.is_empty() {
        String::new()
    } else {
        format!("\n{clip}")
    }
}

/// What a body is, once its content type and its first bytes agree.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Body {
    Html,
    Text,
    Pdf,
    Binary,
}

fn classify(content_type: &str, bytes: &[u8]) -> Body {
    let mime = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if mime == "application/pdf" || bytes.starts_with(b"%PDF-") {
        return Body::Pdf;
    }
    if mime == "text/html" || mime == "application/xhtml+xml" {
        return Body::Html;
    }
    let textual = mime.starts_with("text/")
        || mime.ends_with("+json")
        || mime.ends_with("+xml")
        || matches!(
            mime.as_str(),
            "application/json"
                | "application/xml"
                | "application/javascript"
                | "application/x-yaml"
                | "application/yaml"
                | "application/toml"
        );
    if textual {
        return Body::Text;
    }
    // No usable content type — a plain file server, or a header that says
    // `application/octet-stream` about a text file. Sniff instead of
    // guessing: a NUL byte in the first kilobyte is the one signal that is
    // never a false positive on real text.
    let head = &bytes[..bytes.len().min(1024)];
    if head.contains(&0) {
        return Body::Binary;
    }
    let start = String::from_utf8_lossy(head);
    let start = start.trim_start().to_ascii_lowercase();
    if start.starts_with("<!doctype html") || start.starts_with("<html") {
        Body::Html
    } else {
        Body::Text
    }
}

fn describe(kind: Body, content_type: &str) -> String {
    let mime = content_type.split(';').next().unwrap_or("").trim();
    if mime.is_empty() {
        match kind {
            Body::Html => "html".into(),
            _ => "text".into(),
        }
    } else {
        mime.to_string()
    }
}

/// Only `http` and `https`, and only with a host.
///
/// The refusals name the alternative rather than the rule: `file://` is the
/// disk, which the file tools reach with a root behind them, and this one has
/// none.
fn parse_url(raw: &str) -> Result<Url, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("url is empty".into());
    }
    let url = Url::parse(raw).map_err(|e| {
        if raw.contains("://") {
            format!("{raw} is not a valid URL: {e}")
        } else {
            format!(
                "{raw} is not a valid URL: {e}. URLs here must be absolute, including the \
                 scheme — try https://{raw}"
            )
        }
    })?;
    match url.scheme() {
        "http" | "https" => {}
        "file" => {
            return Err(
                "file:// URLs are not fetchable. Read local files with read_file, which \
                 resolves them against the workspace root."
                    .into(),
            );
        }
        other => {
            return Err(format!(
                "{other}:// is not fetchable; this tool speaks http and https only."
            ));
        }
    }
    if url.host().is_none() {
        return Err(format!("{url} has no host to connect to."));
    }
    Ok(url)
}

/// Drain the response, stopping at [`MAX_DOWNLOAD`].
///
/// Streamed rather than `.bytes()` so the ceiling is on what crosses the
/// wire and not merely on what is kept: a server that advertises no length,
/// or lies about it, would otherwise decide how much memory this costs.
async fn capped_body(response: reqwest::Response) -> Result<Vec<u8>, String> {
    use futures::StreamExt;
    let mut out = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("the response ended early: {}", why(&e)))?;
        out.extend_from_slice(&chunk);
        if out.len() >= MAX_DOWNLOAD {
            out.truncate(MAX_DOWNLOAD);
            break;
        }
    }
    Ok(out)
}

/// The window of `text` the model is shown, and how to ask for the next one.
///
/// A truncated page is unrecoverable without this — unlike `grep`, whose
/// advice is to narrow the pattern, there is nothing to narrow here, so the
/// notice carries the offset that continues rather than a suggestion.
fn window(text: &str, offset: usize) -> Result<String, String> {
    let total = text.chars().count();
    if offset > 0 && offset >= total {
        return Err(format!(
            "offset {offset} is past the end of the page, which is {total} characters long."
        ));
    }
    let start = text.char_indices().nth(offset).map(|(i, _)| i).unwrap_or(0);
    let rest = &text[start..];
    if rest.len() <= READ_LIMIT {
        return Ok(if offset == 0 {
            rest.to_string()
        } else {
            format!("(from character {offset} of {total})\n\n{rest}")
        });
    }
    let mut cut = READ_LIMIT;
    while !rest.is_char_boundary(cut) {
        cut -= 1;
    }
    let shown = &rest[..cut];
    let next = offset + shown.chars().count();
    Ok(format!(
        "{shown}\n\n… (showing characters {offset}–{next} of {total}; call web_fetch again \
         with offset={next} for the rest)"
    ))
}

fn size(bytes: usize) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

/// Transport failures, said in a way the model can act on.
///
/// `reqwest`'s own `Display` is a chain of source errors that reads as
/// noise; the three cases worth separating are a server that never answered,
/// a host that could not be reached at all, and everything else.
fn why(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        format!("no response within {}s", TIMEOUT.as_secs())
    } else if e.is_connect() {
        format!("could not connect ({e})")
    } else {
        e.to_string()
    }
}

fn http_client() -> Client {
    Client::builder()
        .timeout(TIMEOUT)
        .user_agent(UA)
        .build()
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// html
// ---------------------------------------------------------------------------

/// Elements whose contents are never text: dropped wholesale, tags and all.
const SKIPPED: [&str; 7] = [
    "script", "style", "noscript", "svg", "template", "iframe", "canvas",
];

/// Elements that end the current line.
const BLOCK: [&str; 26] = [
    "p",
    "div",
    "section",
    "article",
    "header",
    "footer",
    "main",
    "aside",
    "nav",
    "blockquote",
    "form",
    "ul",
    "ol",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "figure",
    "figcaption",
    "dl",
    "dt",
    "dd",
    "title",
    "fieldset",
    "details",
];

/// HTML reduced to text a model can read.
///
/// Not a parser: a scanner that knows which tags mean "new line", which mean
/// "drop everything inside", and how to keep a link's URL attached to its
/// text. `base` is the URL the document was *served from* after redirects,
/// so relative links resolve to something fetchable rather than to something
/// that has to be reassembled by hand.
fn html_to_text(html: &str, base: &Url) -> String {
    let b = html.as_bytes();
    let mut out = String::with_capacity(html.len() / 4);
    let mut i = 0usize;
    let mut pre = 0usize;
    // Where the current <a>'s text started in `out`, and where it points.
    let mut link: Option<(usize, String)> = None;

    while i < b.len() {
        if b[i] != b'<' {
            let start = i;
            while i < b.len() && b[i] != b'<' {
                i += 1;
            }
            push_text(&mut out, &html[start..i], pre > 0);
            continue;
        }

        if html[i..].starts_with("<!--") {
            i = html[i..].find("-->").map(|p| i + p + 3).unwrap_or(b.len());
            continue;
        }
        if b.get(i + 1) == Some(&b'!') || b.get(i + 1) == Some(&b'?') {
            i = html[i..].find('>').map(|p| i + p + 1).unwrap_or(b.len());
            continue;
        }
        let Some(end) = html[i..].find('>').map(|p| i + p) else {
            break;
        };
        let inner = &html[i + 1..end];
        let closing = inner.starts_with('/');
        let name = tag_name(inner, closing);
        let attrs = &inner[name.len() + usize::from(closing)..];
        i = end + 1;

        if name.is_empty() {
            continue;
        }
        if !closing && SKIPPED.contains(&name.as_str()) {
            i = skip_element(html, &name, i);
            continue;
        }

        match name.as_str() {
            "br" => out.push('\n'),
            "hr" => {
                newline(&mut out);
                out.push_str("---");
                out.push('\n');
            }
            "pre" => {
                if closing {
                    pre = pre.saturating_sub(1);
                } else {
                    pre += 1;
                }
                newline(&mut out);
            }
            "li" if !closing => {
                newline(&mut out);
                out.push_str("- ");
            }
            "td" | "th" if closing => out.push_str(" | "),
            "img" if !closing => {
                if let Some(alt) = attribute(attrs, "alt") {
                    let alt = alt.trim();
                    if !alt.is_empty() {
                        out.push_str(&format!("[image: {alt}]"));
                    }
                }
            }
            "a" => {
                if closing {
                    close_link(&mut out, link.take());
                } else {
                    close_link(&mut out, link.take());
                    link = attribute(attrs, "href")
                        .and_then(|href| resolve(base, &href))
                        .map(|href| (out.len(), href));
                }
            }
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                newline(&mut out);
                if !closing {
                    let level = name[1..].parse::<usize>().unwrap_or(1);
                    out.push_str(&"#".repeat(level));
                    out.push(' ');
                }
            }
            _ if BLOCK.contains(&name.as_str()) => newline(&mut out),
            _ => {}
        }
    }
    close_link(&mut out, link.take());
    tidy(&out)
}

fn tag_name(inner: &str, closing: bool) -> String {
    inner[usize::from(closing)..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_ascii_lowercase()
}

/// Everything up to the matching close tag, gone.
///
/// Matched case-insensitively and by name, so `</SCRIPT>` closes `<script>`;
/// an unclosed one swallows the rest of the document, which is the safe
/// direction — the alternative is emitting a minified bundle as prose.
fn skip_element(html: &str, name: &str, from: usize) -> usize {
    let needle = format!("</{name}");
    let hay = html[from..].to_ascii_lowercase();
    match hay.find(&needle) {
        Some(p) => html[from + p..]
            .find('>')
            .map(|q| from + p + q + 1)
            .unwrap_or(html.len()),
        None => html.len(),
    }
}

/// One attribute's value, quoted or bare.
fn attribute(attrs: &str, name: &str) -> Option<String> {
    let lower = attrs.to_ascii_lowercase();
    let mut from = 0usize;
    while let Some(p) = lower[from..].find(name) {
        let at = from + p;
        // A real attribute starts at a word boundary and is followed by `=`.
        let before_ok = at == 0
            || !lower.as_bytes()[at - 1].is_ascii_alphanumeric()
                && lower.as_bytes()[at - 1] != b'-';
        let rest = &attrs[at + name.len()..];
        let trimmed = rest.trim_start();
        if before_ok && trimmed.starts_with('=') {
            let value = trimmed[1..].trim_start();
            let mut chars = value.chars();
            return Some(match chars.next() {
                Some(q @ ('"' | '\'')) => value[1..].split(q).next().unwrap_or("").to_string(),
                Some(_) => value
                    .split(|c: char| c.is_whitespace())
                    .next()
                    .unwrap_or("")
                    .to_string(),
                None => String::new(),
            });
        }
        from = at + name.len();
    }
    None
}

/// A link's href, resolved against the page it was found on.
///
/// In-page anchors and `javascript:` are dropped rather than emitted: they
/// cannot be fetched, and a URL in the output is a promise that it can be.
fn resolve(base: &Url, href: &str) -> Option<String> {
    let href = decode_entities(href.trim());
    if href.is_empty() || href.starts_with('#') {
        return None;
    }
    let lower = href.to_ascii_lowercase();
    if lower.starts_with("javascript:") || lower.starts_with("data:") {
        return None;
    }
    base.join(&href).ok().map(String::from)
}

/// Wrap the text accumulated since `<a>` into `[text](url)`.
///
/// Multi-line link text is left alone: a link wrapping a whole card of markup
/// is a layout, and rendering it as one bracketed run would destroy the
/// structure to add a URL nobody asked for.
fn close_link(out: &mut String, link: Option<(usize, String)>) {
    let Some((start, href)) = link else { return };
    if start > out.len() {
        return;
    }
    let captured = out[start..].to_string();
    let text = captured.trim();
    if text.is_empty() || text.contains('\n') || text.chars().count() > 120 {
        return;
    }
    // Whitespace either side of the link text belongs to the sentence, not
    // to the link: rewriting the span without putting it back runs the
    // bracket into the previous word.
    let lead = captured.len() - captured.trim_start().len();
    let trailing = captured.ends_with(char::is_whitespace);
    out.truncate(start + lead);
    out.push_str(&format!("[{text}]({href})"));
    if trailing {
        out.push(' ');
    }
}

/// A line break, unless the output already ends in one.
fn newline(out: &mut String) {
    if out.is_empty() {
        return;
    }
    if !out.ends_with('\n') {
        out.push('\n');
    }
}

/// Text between tags: entity-decoded, and whitespace-collapsed unless we are
/// inside a `<pre>`, where the whitespace *is* the content.
fn push_text(out: &mut String, raw: &str, verbatim: bool) {
    let decoded = decode_entities(raw);
    if verbatim {
        out.push_str(&decoded);
        return;
    }
    // Whether two runs are separated is decided by the *source*, never by
    // the fact that a tag stood between them. Both directions are wrong in
    // a way that is invisible in the markup: inserting a space unasked
    // turns "…(url)." into "…(url) .", and dropping one the source had runs
    // "the <b>fast</b> cat" together.
    let gap = |out: &String| !out.is_empty() && !out.ends_with(char::is_whitespace);
    if decoded.starts_with(char::is_whitespace) && gap(out) {
        out.push(' ');
    }
    for (n, part) in decoded.split_whitespace().enumerate() {
        if n > 0 {
            out.push(' ');
        }
        out.push_str(part);
    }
    if decoded.ends_with(char::is_whitespace) && gap(out) {
        out.push(' ');
    }
}

const NAMED: [(&str, &str); 20] = [
    ("amp", "&"),
    ("lt", "<"),
    ("gt", ">"),
    ("quot", "\""),
    ("apos", "'"),
    ("nbsp", " "),
    ("ndash", "–"),
    ("mdash", "—"),
    ("hellip", "…"),
    ("lsquo", "‘"),
    ("rsquo", "’"),
    ("ldquo", "“"),
    ("rdquo", "”"),
    ("bull", "•"),
    ("middot", "·"),
    ("copy", "©"),
    ("reg", "®"),
    ("trade", "™"),
    ("times", "×"),
    ("deg", "°"),
];

/// The entities that actually occur in prose, plus every numeric one.
///
/// An unknown entity is emitted as it was written rather than dropped: a
/// literal `&thinsp;` in the output is a curiosity, where a silently missing
/// character can change what a sentence says.
fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let end = rest[1..]
            .char_indices()
            .take(12)
            .find(|(_, c)| *c == ';')
            .map(|(i, _)| i + 1);
        let Some(end) = end else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let body = &rest[1..end];
        let decoded = if let Some(hex) = body.strip_prefix("#x").or(body.strip_prefix("#X")) {
            u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
        } else if let Some(dec) = body.strip_prefix('#') {
            dec.parse::<u32>().ok().and_then(char::from_u32)
        } else {
            None
        };
        match decoded {
            Some(c) => out.push(c),
            None => match NAMED.iter().find(|(name, _)| *name == body) {
                Some((_, text)) => out.push_str(text),
                None => out.push_str(&rest[..=end]),
            },
        }
        rest = &rest[end + 1..];
    }
    out.push_str(rest);
    out
}

/// Trailing spaces gone, runs of blank lines down to one.
fn tidy(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut blanks = 0usize;
    for line in text.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            blanks += 1;
            if blanks > 1 || out.is_empty() {
                continue;
            }
        } else {
            blanks = 0;
        }
        out.push_str(line);
        out.push('\n');
    }
    out.trim_end().to_string()
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

/// A search API this workspace knows how to speak to.
///
/// Curated, in the order they are preferred, and the order is one question:
/// how often does a search end the round without a second call? Tavily
/// returns extracted page content rather than an index snippet, so it often
/// does; Brave is a general web index with the broadest coverage of the
/// three; Exa retrieves by meaning, which is the right tool when you know
/// what you want and not what it is called, and the wrong one for a literal
/// error message.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SearchBackend {
    Tavily,
    Brave,
    Exa,
}

impl SearchBackend {
    pub const ALL: [SearchBackend; 3] = [Self::Tavily, Self::Brave, Self::Exa];

    /// The name a person uses, and the one the tool description carries so a
    /// user can see where their queries are going.
    pub fn label(self) -> &'static str {
        match self {
            Self::Tavily => "Tavily",
            Self::Brave => "Brave Search",
            Self::Exa => "Exa",
        }
    }

    pub fn env_key(self) -> &'static str {
        match self {
            Self::Tavily => "TAVILY_API_KEY",
            Self::Brave => "BRAVE_API_KEY",
            Self::Exa => "EXA_API_KEY",
        }
    }

    /// Parsed from the label the shells use, which is the lowercased first
    /// word — `tavily`, `brave`, `exa`.
    pub fn from_name(name: &str) -> Option<Self> {
        match name.trim().to_ascii_lowercase().as_str() {
            "tavily" => Some(Self::Tavily),
            "brave" => Some(Self::Brave),
            "exa" => Some(Self::Exa),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Tavily => "tavily",
            Self::Brave => "brave",
            Self::Exa => "exa",
        }
    }

    fn request(
        self,
        client: &Client,
        key: &str,
        query: &str,
        count: usize,
    ) -> reqwest::RequestBuilder {
        match self {
            Self::Tavily => client
                .post("https://api.tavily.com/search")
                .bearer_auth(key)
                .json(&json!({
                    "query": query,
                    "max_results": count,
                    "search_depth": "basic",
                })),
            Self::Brave => client
                .get("https://api.search.brave.com/res/v1/web/search")
                .query(&[("q", query), ("count", &count.to_string())])
                .header("X-Subscription-Token", key)
                .header(reqwest::header::ACCEPT, "application/json"),
            Self::Exa => client
                .post("https://api.exa.ai/search")
                .header("x-api-key", key)
                .json(&json!({
                    "query": query,
                    "numResults": count,
                    "contents": { "text": { "maxCharacters": 800 } },
                })),
        }
    }

    /// One vendor's response shape, flattened to the three fields every one
    /// of them has under a different name.
    fn parse(self, body: &str) -> Result<Vec<Hit>, String> {
        let value: Value = serde_json::from_str(body)
            .map_err(|e| format!("{} returned something that is not JSON: {e}", self.label()))?;
        let (list, snippet_field) = match self {
            Self::Tavily => (&value["results"], "content"),
            Self::Brave => (&value["web"]["results"], "description"),
            Self::Exa => (&value["results"], "text"),
        };
        let Some(list) = list.as_array() else {
            return Ok(Vec::new());
        };
        Ok(list
            .iter()
            .filter_map(|hit| {
                let url = hit["url"].as_str()?.to_string();
                Some(Hit {
                    title: hit["title"].as_str().unwrap_or("").trim().to_string(),
                    url,
                    snippet: clean_snippet(hit[snippet_field].as_str().unwrap_or("")),
                })
            })
            .collect())
    }
}

/// Brave's descriptions carry `<strong>` around the matched terms, and
/// Tavily's extracted content carries whatever whitespace the page had.
fn clean_snippet(raw: &str) -> String {
    let stripped = if raw.contains('<') {
        let mut out = String::with_capacity(raw.len());
        let mut in_tag = false;
        for c in raw.chars() {
            match c {
                '<' => in_tag = true,
                '>' => in_tag = false,
                _ if !in_tag => out.push(c),
                _ => {}
            }
        }
        out
    } else {
        raw.to_string()
    };
    decode_entities(&stripped)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// What the model should do about a failed search, which is never "try the
/// same query again".
///
/// A bad key is a user problem and not a query problem, and left unsaid the
/// model rephrases and retries until the round limit. The status alone does
/// not identify one: verified live, Brave answers an invalid subscription
/// token with **422**, where Tavily and Exa answer 401 — so the body is
/// consulted too, which also covers the next vendor with its own opinion
/// about which code means "who are you".
fn advice(backend: SearchBackend, status: u16, body: &str) -> String {
    let auth = matches!(status, 401 | 403) || {
        let body = body.to_ascii_lowercase();
        ["api key", "token", "unauthor", "subscription", "credential"]
            .iter()
            .any(|s| body.contains(s))
    };
    if auth {
        format!(
            " The {} API key looks wrong or expired; tell the user rather than retrying \
             the search.",
            backend.label()
        )
    } else if status == 429 {
        " Rate limited. Do not retry immediately; tell the user if you need this now.".into()
    } else if (400..500).contains(&status) {
        " The request itself was rejected, so the same query will fail again — say what \
         happened rather than retrying."
            .into()
    } else {
        // A 5xx is theirs and may well be transient.
        String::new()
    }
}

struct Hit {
    title: String,
    url: String,
    snippet: String,
}

const DEFAULT_RESULTS: usize = 5;
const MAX_RESULTS: usize = 10;
/// Enough to tell whether a result is worth fetching, and no more: the point
/// of a search result is the decision to open it.
const SNIPPET_LIMIT: usize = 500;

pub struct WebSearch {
    backend: SearchBackend,
    key: String,
    client: Client,
}

impl WebSearch {
    pub fn new(backend: SearchBackend, key: impl Into<String>) -> Self {
        Self {
            backend,
            key: key.into(),
            client: http_client(),
        }
    }
}

#[async_trait::async_trait]
impl Tool for WebSearch {
    /// `Mutating` for the same reason `web_fetch` is: the query is composed
    /// by the model out of whatever it has read, and it leaves the machine.
    fn effect(&self) -> Effect {
        Effect::Mutating
    }

    fn def(&self) -> ToolDef {
        ToolDef {
            name: "web_search".into(),
            description: format!("{SEARCH_DESC_PREFIX}{}.", self.backend.label()),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "What to search for. Keywords beat prose."
                    },
                    "max_results": {
                        "type": "integer",
                        "description": "How many results to return, 1 to 10. Defaults to 5."
                    }
                },
                "required": ["query"]
            }),
        }
    }

    async fn call(&self, input: Value, cancel: &CancellationToken) -> Result<String, String> {
        let query = str_arg(&input, "query")?;
        if query.trim().is_empty() {
            return Err("query is empty".into());
        }
        let count = input["max_results"]
            .as_u64()
            .map(|n| n as usize)
            .unwrap_or(DEFAULT_RESULTS)
            .clamp(1, MAX_RESULTS);

        let response = super::interruptible(
            cancel,
            self.backend
                .request(&self.client, &self.key, &query, count)
                .send(),
        )
        .await?
        .map_err(|e| format!("cannot reach {}: {}", self.backend.label(), why(&e)))?;

        let status = response.status();
        let body = super::interruptible(cancel, response.text())
            .await?
            .unwrap_or_default();
        if !status.is_success() {
            return Err(format!(
                "{} returned {status}.{}\n{}",
                self.backend.label(),
                advice(self.backend, status.as_u16(), &body),
                body.chars().take(300).collect::<String>().trim()
            ));
        }

        let hits = self.backend.parse(&body)?;
        if hits.is_empty() {
            return Err(format!(
                "no results for {query:?}. Try fewer or more distinctive terms; a question in \
                 prose usually matches less than the words that would appear on the page."
            ));
        }
        Ok(render(&query, self.backend, &hits))
    }
}

fn render(query: &str, backend: SearchBackend, hits: &[Hit]) -> String {
    let mut out = format!(
        "{} results for {query:?} from {}\n",
        hits.len(),
        backend.label()
    );
    for (n, hit) in hits.iter().enumerate() {
        let title = if hit.title.is_empty() {
            "(untitled)"
        } else {
            &hit.title
        };
        out.push_str(&format!("\n{}. {title}\n{}\n", n + 1, hit.url));
        if !hit.snippet.is_empty() {
            let snippet: String = hit.snippet.chars().take(SNIPPET_LIMIT).collect();
            let ellipsis = if hit.snippet.chars().count() > SNIPPET_LIMIT {
                "…"
            } else {
                ""
            };
            out.push_str(&format!("{snippet}{ellipsis}\n"));
        }
    }
    out.push_str("\nUse web_fetch on a result's URL to read the page itself.");
    out
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------

/// The web tools available in this environment.
///
/// `web_fetch` always; `web_search` only when a backend has a key, and then
/// only the first one in [`SearchBackend::ALL`] that does. The alternative —
/// advertising `web_search` and failing every call with "no key" — spends
/// prompt on a tool the model cannot use and buys a round trip to find that
/// out, which is the same argument [`super::bench`] makes for an empty
/// reviewer list meaning no `review` tool at all.
///
/// `key` is supplied by the shell because the two shells answer it
/// differently: the CLI reads the environment, and the desktop reads its
/// credential store first — a GUI process inherits whatever environment its
/// launcher had, which on Windows is usually none at all.
pub fn web_tools(key: impl Fn(SearchBackend) -> Option<String>) -> Vec<Box<dyn Tool>> {
    let mut tools: Vec<Box<dyn Tool>> = vec![Box::new(Fetch::new())];
    if let Some(backend) = search_backend(&key)
        && let Some(k) = key(backend)
    {
        tools.push(Box::new(WebSearch::new(backend, k)));
    }
    tools
}

/// Which backend will answer, if any.
///
/// Separate from [`web_tools`] so a shell can *say* which one without
/// re-deriving the choice — a startup line naming Brave while the tool
/// queried Tavily would be worse than no line at all. It is also the answer
/// to the question a user actually has when search never happens, which is
/// not "is it broken" but "did you find my key".
pub fn search_backend(key: impl Fn(SearchBackend) -> Option<String>) -> Option<SearchBackend> {
    SearchBackend::ALL.into_iter().find(|b| key(*b).is_some())
}

/// The environment-variable lookup, which is the whole of the CLI's answer
/// and the fallback half of the desktop's.
pub fn env_search_key(backend: SearchBackend) -> Option<String> {
    std::env::var(backend.env_key())
        .ok()
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Url {
        Url::parse("https://example.com/docs/guide").unwrap()
    }

    fn extract(html: &str) -> String {
        html_to_text(html, &base())
    }

    // --- URLs --------------------------------------------------------------

    /// The one containment this tool has. `file://` is the interesting
    /// refusal: it is the scheme that would reach the disk through the only
    /// tool here with no [`Root`] behind it.
    #[test]
    fn only_http_and_https_are_fetchable() {
        assert!(parse_url("https://example.com").is_ok());
        assert!(parse_url("http://localhost:5173/").is_ok());

        let file = parse_url("file:///etc/passwd").unwrap_err();
        assert!(file.contains("read_file"), "{file}");

        let ftp = parse_url("ftp://example.com/x").unwrap_err();
        assert!(ftp.contains("http and https only"), "{ftp}");

        let data = parse_url("data:text/html,<b>hi</b>").unwrap_err();
        assert!(!data.is_empty());
    }

    /// A bare hostname is the commonest malformed argument, and the message
    /// is prompt text: it shows the fixed URL rather than describing the rule.
    #[test]
    fn a_schemeless_url_is_told_what_to_write_instead() {
        let e = parse_url("example.com/docs").unwrap_err();
        assert!(e.contains("https://example.com/docs"), "{e}");
    }

    // --- content types -----------------------------------------------------

    #[test]
    fn content_types_are_classified_by_header_then_by_content() {
        assert_eq!(classify("text/html; charset=utf-8", b"<html>"), Body::Html);
        assert_eq!(classify("application/json", b"{}"), Body::Text);
        assert_eq!(classify("application/ld+json", b"{}"), Body::Text);
        assert_eq!(classify("text/markdown", b"# hi"), Body::Text);
        assert_eq!(classify("application/pdf", b"%PDF-1.7"), Body::Pdf);
        // A server that says nothing useful is sniffed, not guessed at.
        assert_eq!(classify("", b"  <!DOCTYPE html><html>"), Body::Html);
        assert_eq!(
            classify("application/octet-stream", b"plain words"),
            Body::Text
        );
        assert_eq!(
            classify("application/octet-stream", b"\x00\x01binary"),
            Body::Binary
        );
        // A PDF is a PDF whatever the header says — it is the one type with
        // a real alternative to offer, so recognising it matters.
        assert_eq!(classify("application/octet-stream", b"%PDF-1.4"), Body::Pdf);
    }

    /// A failing API says which field was wrong, and that is the whole
    /// reason to read a body nobody asked for. A failing *page* says it in
    /// markup, so it goes through the same extraction rather than being
    /// clipped raw into 400 characters of stylesheet links.
    #[test]
    fn a_failure_carries_the_readable_part_of_its_body() {
        let api = explain(Body::Text, br#"{"error":"scope 'repo' required"}"#);
        assert_eq!(api.trim(), r#"{"error":"scope 'repo' required"}"#);

        let page = explain(
            Body::Html,
            b"<html><head><link rel=stylesheet href=a.css><style>b{}</style></head>\
              <body><h1>Not found</h1><p>Try /v2/users.</p></body></html>",
        );
        assert_eq!(page.trim(), "# Not found\nTry /v2/users.");

        // Nothing to read, and nothing said about it.
        assert_eq!(explain(Body::Binary, b"\x00\x01"), "");
        assert_eq!(explain(Body::Text, b"   "), "");
    }

    // --- html --------------------------------------------------------------

    /// The whole reason not to hand a page to the model raw: a modern page
    /// is mostly script and style, and those bytes are pure cost.
    #[test]
    fn script_and_style_never_reach_the_output() {
        let html = "<html><head><style>body{color:red}</style>\
            <script>var secret = 'do not read me';</script></head>\
            <body><p>Real text.</p><noscript>enable js</noscript></body></html>";
        let text = extract(html);
        assert_eq!(text, "Real text.");
    }

    /// `</SCRIPT>` closes `<script>`, and an unclosed one takes the rest of
    /// the document with it rather than emitting a minified bundle as prose.
    #[test]
    fn a_skipped_element_ends_case_insensitively() {
        assert_eq!(extract("<p>a</p><SCRIPT>x=1</SCRIPT><p>b</p>"), "a\nb");
        assert_eq!(extract("<p>a</p><script>x=1"), "a");
    }

    /// Structure is what makes the text readable rather than a wall.
    #[test]
    fn headings_and_lists_survive_as_markers() {
        let html = "<h1>Title</h1><h2>Part</h2><ul><li>one</li><li>two</li></ul>";
        assert_eq!(extract(html), "# Title\n## Part\n- one\n- two");
    }

    /// A link's URL is the only way the next call knows where to go, and a
    /// relative one has to resolve against where the page was actually
    /// served from.
    #[test]
    fn links_keep_their_urls_resolved_against_the_page() {
        let html = r#"<p>See <a href="../api/index.html">the API</a> and
            <a href="https://other.example/x">elsewhere</a>.</p>"#;
        assert_eq!(
            extract(html),
            "See [the API](https://example.com/api/index.html) and \
             [elsewhere](https://other.example/x)."
        );
    }

    /// A URL in the output is a promise that it can be fetched, so the two
    /// kinds that cannot are dropped back to plain text.
    #[test]
    fn unfetchable_links_keep_their_text_and_lose_their_href() {
        assert_eq!(
            extract(r##"<a href="#top">Back to top</a>"##),
            "Back to top"
        );
        assert_eq!(extract(r#"<a href="javascript:void(0)">Menu</a>"#), "Menu");
    }

    /// A link around a whole card of markup is a layout, not a citation.
    #[test]
    fn a_multi_line_link_is_left_as_structure() {
        let text = extract(r#"<a href="/post"><h2>Headline</h2><p>Body</p></a>"#);
        assert_eq!(text, "## Headline\nBody");
    }

    #[test]
    fn entities_are_decoded_and_unknown_ones_are_left_alone() {
        assert_eq!(extract("<p>a &amp; b &lt; c</p>"), "a & b < c");
        assert_eq!(extract("<p>caf&#233; &#x2014; nice</p>"), "café — nice");
        assert_eq!(extract("<p>&mdash;&nbsp;end</p>"), "— end");
        // Not dropped: a missing character can change what a sentence says.
        assert_eq!(extract("<p>x &thinsp; y</p>"), "x &thinsp; y");
        // A bare ampersand is not an entity and must survive.
        assert_eq!(extract("<p>Tom & Jerry</p>"), "Tom & Jerry");
    }

    /// Inside `<pre>` the whitespace is the content — this is what makes a
    /// fetched code sample usable.
    #[test]
    fn pre_keeps_its_whitespace_and_the_rest_is_collapsed() {
        let html = "<p>a\n\n   b</p><pre>fn main() {\n    println!(\"hi\");\n}</pre>";
        let text = extract(html);
        assert!(text.starts_with("a b"), "{text}");
        assert!(
            text.contains("fn main() {\n    println!(\"hi\");\n}"),
            "{text}"
        );
    }

    /// Dropping a boundary space runs two inline elements together, which is
    /// invisible in the markup and very visible in the output.
    #[test]
    fn inline_elements_keep_the_space_between_them() {
        assert_eq!(extract("<p>the <b>fast</b> cat</p>"), "the fast cat");
        // Adjacent with nothing between them: two runs of one word, not two
        // words. Inserting a space here is how "Rust" and "aceans" become
        // separate words in the model's reading of a styled heading.
        assert_eq!(extract("<p><b>a</b><i>b</i></p>"), "ab");
        // Whitespace between the tags is the separator, wherever it sits.
        assert_eq!(extract("<p><b>a</b> <i>b</i></p>"), "a b");
        assert_eq!(extract("<p><b>a </b><i>b</i></p>"), "a b");
    }

    /// Punctuation after a link is part of the sentence, and the rewrite
    /// that puts the URL in has to leave the sentence intact on both sides.
    #[test]
    fn a_link_does_not_disturb_the_text_around_it() {
        assert_eq!(
            extract(r#"<p>See<a href="/a"> the API</a>, then stop.</p>"#),
            "See [the API](https://example.com/a), then stop."
        );
    }

    #[test]
    fn comments_and_doctypes_are_not_text() {
        assert_eq!(
            extract("<!DOCTYPE html><!-- <p>hidden</p> --><p>shown</p>"),
            "shown"
        );
    }

    #[test]
    fn blank_lines_collapse_and_the_output_is_trimmed() {
        let text = extract("<div></div><div></div><p>one</p><div></div><div></div><p>two</p>");
        assert_eq!(text, "one\ntwo");
    }

    #[test]
    fn an_image_contributes_its_alt_text_only_when_it_has_some() {
        assert_eq!(
            extract(r#"<p><img src="a.png" alt="A chart"> after</p>"#),
            "[image: A chart] after"
        );
        assert_eq!(
            extract(r#"<p><img src="spacer.gif" alt=""> after</p>"#),
            "after"
        );
    }

    /// `data-href` is not `href`, and an attribute scanner that matches on a
    /// substring would take it.
    #[test]
    fn attributes_match_whole_names() {
        assert_eq!(
            attribute(r#" data-href="x" href="y""#, "href").as_deref(),
            Some("y")
        );
        assert_eq!(
            attribute(r#" href=bare rel=next"#, "href").as_deref(),
            Some("bare")
        );
        assert_eq!(attribute(r#" rel="next""#, "href"), None);
    }

    // --- paging ------------------------------------------------------------

    /// Unlike a `grep` that matched too much, a truncated page has nothing
    /// to narrow — so the notice has to carry the offset that continues it.
    #[test]
    fn a_long_page_says_how_to_read_the_rest() {
        let long = "x".repeat(READ_LIMIT + 500);
        let out = window(&long, 0).unwrap();
        assert!(
            out.contains(&format!("offset={READ_LIMIT}")),
            "{}",
            &out[out.len() - 200..]
        );

        let rest = window(&long, READ_LIMIT).unwrap();
        assert!(rest.starts_with(&format!("(from character {READ_LIMIT} of {})", long.len())));
        assert!(!rest.contains("call web_fetch again"));
    }

    #[test]
    fn an_offset_past_the_end_says_how_long_the_page_was() {
        let e = window("short", 99).unwrap_err();
        assert!(e.contains("5 characters long"), "{e}");
    }

    /// The window is cut on a character boundary, not a byte one.
    #[test]
    fn paging_does_not_split_a_character() {
        let text = "é".repeat(READ_LIMIT);
        let out = window(&text, 0).unwrap();
        assert!(out.starts_with('é'));
    }

    // --- search ------------------------------------------------------------

    /// Each vendor's response, parsed from a canned body — the same shape as
    /// the provider adapters' tests, and for the same reason: the wire is
    /// what changes under us, and it can be pinned without a network.
    #[test]
    fn every_backend_flattens_to_the_same_three_fields() {
        let tavily = SearchBackend::Tavily
            .parse(r#"{"results":[{"title":"T","url":"https://a","content":"body text"}]}"#)
            .unwrap();
        assert_eq!(tavily[0].title, "T");
        assert_eq!(tavily[0].url, "https://a");
        assert_eq!(tavily[0].snippet, "body text");

        let brave = SearchBackend::Brave
            .parse(r#"{"web":{"results":[{"title":"B","url":"https://b","description":"desc"}]}}"#)
            .unwrap();
        assert_eq!(brave[0].url, "https://b");
        assert_eq!(brave[0].snippet, "desc");

        let exa = SearchBackend::Exa
            .parse(r#"{"results":[{"title":"E","url":"https://c","text":"extracted"}]}"#)
            .unwrap();
        assert_eq!(exa[0].url, "https://c");
        assert_eq!(exa[0].snippet, "extracted");
    }

    /// Brave marks the matched terms with `<strong>`, which is markup in a
    /// field the model reads as prose.
    #[test]
    fn a_snippet_is_stripped_of_markup_and_entities() {
        let hits = SearchBackend::Brave
            .parse(
                r#"{"web":{"results":[{"title":"x","url":"https://a",
                   "description":"the <strong>fast</strong> cat &amp;   dog"}]}}"#,
            )
            .unwrap();
        assert_eq!(hits[0].snippet, "the fast cat & dog");
    }

    /// A result with no URL is a result that cannot be followed, and the
    /// whole point of a hit is the decision to open it.
    #[test]
    fn a_result_without_a_url_is_dropped_rather_than_rendered() {
        let hits = SearchBackend::Tavily
            .parse(r#"{"results":[{"title":"no link"},{"title":"ok","url":"https://a"}]}"#)
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].url, "https://a");
    }

    #[test]
    fn an_unexpected_shape_is_no_results_rather_than_an_error() {
        assert!(
            SearchBackend::Brave
                .parse(r#"{"error":"nope"}"#)
                .unwrap()
                .is_empty()
        );
        assert!(SearchBackend::Tavily.parse("not json").is_err());
    }

    /// The key never appears in a query string, where it would be logged by
    /// every proxy on the way — each vendor's documented header or body slot
    /// is the one used.
    #[test]
    fn each_backend_sends_its_key_the_way_that_vendor_asks() {
        let client = Client::new();
        let built = |b: SearchBackend| {
            b.request(&client, "SEKRET", "rust async", 5)
                .build()
                .unwrap()
        };

        let tavily = built(SearchBackend::Tavily);
        assert_eq!(tavily.url().as_str(), "https://api.tavily.com/search");
        assert_eq!(
            tavily.headers()[reqwest::header::AUTHORIZATION],
            "Bearer SEKRET"
        );

        let brave = built(SearchBackend::Brave);
        assert!(
            brave
                .url()
                .as_str()
                .starts_with("https://api.search.brave.com/res/v1/web/search?q=rust+async&count=5")
        );
        assert_eq!(brave.headers()["x-subscription-token"], "SEKRET");

        let exa = built(SearchBackend::Exa);
        assert_eq!(exa.headers()["x-api-key"], "SEKRET");

        for b in SearchBackend::ALL {
            assert!(
                !built(b).url().as_str().contains("SEKRET"),
                "{} put the key in the URL",
                b.label()
            );
        }
    }

    /// A rejected key must not read as a bad query, or the model rephrases
    /// and retries until the round limit. The status alone does not say
    /// which it is — this is the live 422 Brave answers an invalid
    /// subscription token with, which no reasonable reading of the code
    /// would have caught.
    #[test]
    fn a_rejected_key_is_named_as_one_whatever_status_it_arrives_with() {
        let brave = advice(
            SearchBackend::Brave,
            422,
            r#"{"error":{"code":"SUBSCRIPTION_TOKEN_INVALID","detail":"The provided
               subscription token is invalid."}}"#,
        );
        assert!(brave.contains("key looks wrong"), "{brave}");

        let exa = advice(SearchBackend::Exa, 401, r#"{"error":"Invalid API key"}"#);
        assert!(exa.contains("key looks wrong"), "{exa}");

        // Not everything with a 4xx is an auth failure, and the advice for
        // the rest is still "not this query again".
        let bad = advice(
            SearchBackend::Tavily,
            400,
            r#"{"error":"max_results too large"}"#,
        );
        assert!(bad.contains("same query will fail again"), "{bad}");

        assert!(advice(SearchBackend::Tavily, 429, "").contains("Rate limited"));
        // Theirs, and possibly transient: no instruction offered.
        assert_eq!(advice(SearchBackend::Tavily, 503, "gateway"), "");
    }

    #[test]
    fn results_render_with_somewhere_to_go_next() {
        let hits = vec![Hit {
            title: "Async Rust".into(),
            url: "https://a/b".into(),
            snippet: "words".into(),
        }];
        let out = render("async rust", SearchBackend::Brave, &hits);
        assert!(out.contains("1. Async Rust\nhttps://a/b\nwords"), "{out}");
        assert!(out.contains("Brave Search"), "{out}");
        assert!(out.ends_with("Use web_fetch on a result's URL to read the page itself."));
    }

    // --- wiring ------------------------------------------------------------

    /// Fetch needs nothing; search needs a key, and without one the tool is
    /// absent rather than present-and-failing.
    #[test]
    fn search_is_offered_only_when_a_backend_has_a_key() {
        let names = |tools: Vec<Box<dyn Tool>>| -> Vec<String> {
            tools.iter().map(|t| t.def().name).collect()
        };
        assert_eq!(names(web_tools(|_| None)), ["web_fetch"]);
        assert_eq!(
            names(web_tools(
                |b| (b == SearchBackend::Exa).then(|| "k".to_string())
            )),
            ["web_fetch", "web_search"]
        );
    }

    /// One backend, not a fallback chain at call time: the first with a key
    /// wins, in the documented preference order, and the description names
    /// it so the user can see where their queries go.
    /// The line a shell prints and the tool a model calls have to name the
    /// same backend, so they are not allowed to be two decisions.
    #[test]
    fn the_backend_a_shell_reports_is_the_one_that_answers() {
        let keyed = |b: SearchBackend| (b != SearchBackend::Tavily).then(|| "k".to_string());
        let named = search_backend(keyed).unwrap();
        let tools = web_tools(keyed);
        assert!(tools[1].def().description.contains(named.label()));
        assert_eq!(search_backend(|_| None), None);
    }

    #[test]
    fn the_first_backend_with_a_key_is_the_one_used() {
        let both = web_tools(|b| (b != SearchBackend::Tavily).then(|| "k".to_string()));
        assert_eq!(both.len(), 2);
        assert!(both[1].def().description.contains("Brave Search"));

        let all = web_tools(|_| Some("k".into()));
        assert!(all[1].def().description.contains("Tavily"));
    }

    /// Both tools reach the network, and neither is confined by a `Root`.
    /// The pinning test in `tools/mod.rs` covers the built-in set; this one
    /// covers the two that are added separately, and it is the reverse risk
    /// that matters — a later reading of "fetching is a read" talking either
    /// down to `ReadOnly`, after which no user is ever shown a URL again.
    #[test]
    fn nothing_that_leaves_the_machine_is_read_only() {
        for tool in web_tools(|_| Some("k".into())) {
            assert_eq!(
                tool.effect(),
                Effect::Mutating,
                "{} is not gated",
                tool.def().name
            );
        }
    }

    #[test]
    fn a_backend_round_trips_through_its_name() {
        for b in SearchBackend::ALL {
            assert_eq!(SearchBackend::from_name(b.name()), Some(b));
            assert_eq!(SearchBackend::from_name(&b.name().to_uppercase()), Some(b));
        }
        assert_eq!(SearchBackend::from_name("google"), None);
    }
}
