//! Read-only Notion for the Claude Code engine (nightshift backlog 319,
//! 2026-10-06): three tools in Nightloom's own MCP server — search, read a
//! page, list a page's sub-pages — and **no code that writes**.
//!
//! His words decided the shape: Notion must not see anything he did not
//! give it, and Claude must not be able to write. Notion's hosted MCP can
//! reach everything his account can, and write, so it was removed. What
//! is left is an *internal integration* (Notion's name for a token made in
//! its developer settings) with only the "Read content" capability, shared
//! on one root page — which, in Notion's model, gives that page and every
//! page beneath it, and nothing else. A page outside that tree answers 404
//! to the integration itself; these tools say "not found" and stop.
//!
//! Read-only twice over: the integration has no write capability, and this
//! module has no write request in it. Every request goes through
//! [`Notion::get`] (a GET) or [`Notion::search`] (the one POST Notion's
//! read API needs, `/v1/search`, which reads); nothing else sends. A test
//! reads this file's source and fails on any other HTTP method.
//!
//! The token is read from the keychain (service `nightloom`, account
//! `notion:token`) or `NIGHTLOOM_NOTION_TOKEN`
//! ([`crate::credentials::notion_token`]), only when a call needs it, and
//! goes nowhere but the `Authorization` header: never into a reply, an
//! error, a log line or `Debug`.

use std::sync::Arc;

use nightloom_core::ToolDef;
use nightloom_core::tool::{CancellationToken, Effect, Tool};
use serde_json::{Value, json};

/// Notion's API.
pub const NOTION_API: &str = "https://api.notion.com";
/// The API version every request names (`Notion-Version`). The pages,
/// blocks and search shapes read here are this version's.
pub const NOTION_VERSION: &str = "2022-06-28";

/// The most a page read returns at once; `offset` reads on.
const READ_MAX: usize = 30_000;
/// The most blocks one read walks, and how deep into nested blocks.
const BLOCK_CAP: usize = 2_000;
const DEPTH_CAP: usize = 4;
/// The most pages of children (100 each) one listing asks for.
const PAGE_CAP: usize = 20;

const NOT_SET_UP: &str = "Notion is not set up: no token in the keychain (service \"nightloom\", \
     account \"notion:token\") or in NIGHTLOOM_NOTION_TOKEN. Tell the user; do not ask them to \
     paste the token into the chat.";

const NOT_FOUND: &str = "not found — it does not exist, or it is outside the pages Nightloom's \
     Notion connection was given (only the shared root page and its sub-pages can be read)";

type TokenSource = Arc<dyn Fn() -> Option<String> + Send + Sync>;

/// The client: where Notion is, and how to get the token.
#[derive(Clone)]
pub struct Notion {
    base: String,
    token: TokenSource,
    http: reqwest::Client,
}

impl std::fmt::Debug for Notion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Notion")
            .field("base", &self.base)
            .field("token", &"<not shown>")
            .finish()
    }
}

impl Notion {
    /// The real API, the token from the keychain or the environment.
    pub fn from_store() -> Self {
        Self::with(NOTION_API, Arc::new(crate::credentials::notion_token))
    }

    /// Any base URL and token source (tests: a local stand-in for Notion).
    pub fn with(base: &str, token: TokenSource) -> Self {
        Self {
            base: base.trim_end_matches('/').to_string(),
            token,
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_default(),
        }
    }

    /// A GET. One of the module's two senders.
    async fn get(&self, path: &str, query: &[(&str, String)]) -> Result<Value, String> {
        let token = (self.token)().ok_or_else(|| NOT_SET_UP.to_string())?;
        let req = self
            .http
            .get(format!("{}{path}", self.base))
            .query(query)
            .bearer_auth(token)
            .header("Notion-Version", NOTION_VERSION);
        Self::answer(req.send().await).await
    }

    /// `POST /v1/search` — a read; the other sender, and the only POST.
    async fn search(&self, body: Value) -> Result<Value, String> {
        let token = (self.token)().ok_or_else(|| NOT_SET_UP.to_string())?;
        let req = self
            .http
            .post(format!("{}/v1/search", self.base))
            .json(&body)
            .bearer_auth(token)
            .header("Notion-Version", NOTION_VERSION);
        Self::answer(req.send().await).await
    }

    /// The body, or a sentence for the model. Built from the status and
    /// Notion's own `message`, never from the request.
    async fn answer(sent: Result<reqwest::Response, reqwest::Error>) -> Result<Value, String> {
        let resp = sent.map_err(|e| {
            format!(
                "could not reach Notion: {}",
                e.without_url()
                    .to_string()
                    .chars()
                    .take(200)
                    .collect::<String>()
            )
        })?;
        let status = resp.status().as_u16();
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        if (200..300).contains(&status) {
            return Ok(body);
        }
        let said: String = body["message"]
            .as_str()
            .unwrap_or("")
            .chars()
            .take(300)
            .collect();
        Err(match status {
            404 => NOT_FOUND.to_string(),
            400 if body["code"] == "validation_error" && said.contains("is a database") => {
                format!("that id is a database, not a page: {said}")
            }
            401 => "Notion refused the token (401): it was revoked or mistyped — the user \
                    stores a new one"
                .to_string(),
            403 => "Notion refused (403): the integration may read only what it was \
                    given"
                .to_string(),
            429 => "Notion is rate-limiting (429); wait a little and try again".to_string(),
            _ => format!("Notion answered {status}: {said}"),
        })
    }

    /// Every child block of `id`, page by page.
    async fn children(&self, id: &str) -> Result<Vec<Value>, String> {
        let mut out = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..PAGE_CAP {
            let mut q = vec![("page_size", "100".to_string())];
            if let Some(c) = &cursor {
                q.push(("start_cursor", c.clone()));
            }
            let page = self.get(&format!("/v1/blocks/{id}/children"), &q).await?;
            out.extend(page["results"].as_array().cloned().unwrap_or_default());
            match (page["has_more"].as_bool(), page["next_cursor"].as_str()) {
                (Some(true), Some(next)) => cursor = Some(next.to_string()),
                _ => break,
            }
        }
        Ok(out)
    }
}

/// A page id from what the model passes: the id with or without dashes, or
/// a notion.so link. The last run of 32 hex digits, dashed 8-4-4-4-12; it
/// goes into a URL path, so nothing else is let through.
pub fn page_id(given: &str) -> Result<String, String> {
    let path = given.split(['?', '#']).next().unwrap_or("");
    let hex: Vec<char> = path.chars().filter(|c| *c != '-').collect();
    let mut run = 0usize;
    let mut end = None;
    for (i, c) in hex.iter().enumerate() {
        if c.is_ascii_hexdigit() {
            run += 1;
            if run >= 32 {
                end = Some(i + 1);
            }
        } else {
            run = 0;
        }
    }
    let Some(end) = end else {
        return Err(format!(
            "{given:?} is not a Notion page id or link (32 hex digits)"
        ));
    };
    let id: String = hex[end - 32..end].iter().collect::<String>().to_lowercase();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &id[0..8],
        &id[8..12],
        &id[12..16],
        &id[16..20],
        &id[20..32]
    ))
}

/// Rich text as plain text.
fn plain(rich: &Value) -> String {
    rich.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|t| t["plain_text"].as_str())
                .collect::<String>()
        })
        .unwrap_or_default()
}

/// A page's or a database's title.
fn title_of(obj: &Value) -> String {
    let t = if obj["object"] == "database" {
        plain(&obj["title"])
    } else {
        obj["properties"]
            .as_object()
            .and_then(|props| props.values().find(|p| p["type"] == "title"))
            .map(|p| plain(&p["title"]))
            .unwrap_or_default()
    };
    if t.trim().is_empty() {
        "(untitled)".to_string()
    } else {
        t
    }
}

/// One block as a line (or a few), `indent` deep.
fn render_block(b: &Value, indent: usize) -> String {
    let kind = b["type"].as_str().unwrap_or("");
    let body = &b[kind];
    let text = plain(&body["rich_text"]);
    let pad = "  ".repeat(indent);
    let line = match kind {
        "paragraph" => text,
        "heading_1" => format!("# {text}"),
        "heading_2" => format!("## {text}"),
        "heading_3" => format!("### {text}"),
        "bulleted_list_item" => format!("- {text}"),
        "numbered_list_item" => format!("1. {text}"),
        "to_do" => format!(
            "- [{}] {text}",
            if body["checked"].as_bool() == Some(true) {
                "x"
            } else {
                " "
            }
        ),
        "toggle" => format!("▸ {text}"),
        "quote" | "callout" => format!("> {text}"),
        "code" => format!(
            "```{}\n{text}\n```",
            body["language"].as_str().unwrap_or("")
        ),
        "equation" => format!("$${}$$", body["expression"].as_str().unwrap_or("")),
        "divider" => "---".to_string(),
        "child_page" => format!(
            "[sub-page: {} — {}]",
            body["title"].as_str().unwrap_or("(untitled)"),
            b["id"].as_str().unwrap_or("")
        ),
        "child_database" => format!(
            "[database: {} — {}]",
            body["title"].as_str().unwrap_or("(untitled)"),
            b["id"].as_str().unwrap_or("")
        ),
        "bookmark" | "embed" | "link_preview" => {
            format!("[link: {}]", body["url"].as_str().unwrap_or(""))
        }
        "image" | "file" | "pdf" | "video" | "audio" => {
            let caption = plain(&body["caption"]);
            if caption.is_empty() {
                format!("[{kind}]")
            } else {
                format!("[{kind}: {caption}]")
            }
        }
        "table_row" => body["cells"]
            .as_array()
            .map(|cells| cells.iter().map(plain).collect::<Vec<_>>().join(" | "))
            .unwrap_or_default(),
        "table" | "column_list" | "column" | "synced_block" => String::new(),
        "" => String::new(),
        other => format!("[{other}]"),
    };
    if line.is_empty() {
        return String::new();
    }
    line.lines()
        .map(|l| format!("{pad}{l}"))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Search: pages and databases the integration was given, newest edit first.
pub struct NotionSearch(pub Notion);
/// One page's text, nested blocks included, sub-pages named not opened.
pub struct NotionReadPage(pub Notion);
/// A page's sub-pages and databases.
pub struct NotionListChildren(pub Notion);

/// The three, as `tools_in` serves them.
pub fn tools(notion: Notion) -> Vec<Box<dyn Tool>> {
    vec![
        Box::new(NotionSearch(notion.clone())),
        Box::new(NotionReadPage(notion.clone())),
        Box::new(NotionListChildren(notion)),
    ]
}

/// The read-only note every description ends with.
const SCOPE: &str = " Read-only: only the user's chosen Notion root page and its sub-pages are \
     visible; nothing can be created, edited or deleted.";

#[async_trait::async_trait]
impl Tool for NotionSearch {
    /// Reads his own pages through his own integration; the query goes to
    /// Notion and nowhere else, and nothing changes.
    fn effect(&self) -> Effect {
        Effect::ReadOnly
    }

    fn def(&self) -> ToolDef {
        ToolDef {
            name: "notion_search".into(),
            description: format!(
                "Search the user's Notion pages by title. Returns each match's title, id, \
                 last edit and link; read one with notion_read_page.{SCOPE}"
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Words in the title; empty lists recent pages"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 50, "description": "Default 20"}
                },
                "required": ["query"]
            }),
        }
    }

    async fn call(&self, input: Value, _cancel: &CancellationToken) -> Result<String, String> {
        let query = input["query"].as_str().unwrap_or("").trim().to_string();
        let limit = input["limit"].as_u64().unwrap_or(20).clamp(1, 50);
        let found = self
            .0
            .search(json!({
                "query": query,
                "page_size": limit,
                "sort": {"direction": "descending", "timestamp": "last_edited_time"},
            }))
            .await?;
        let results = found["results"].as_array().cloned().unwrap_or_default();
        if results.is_empty() {
            return Ok(format!(
                "nothing found for {query:?} among the Notion pages Nightloom was given"
            ));
        }
        let mut out = String::new();
        for r in &results {
            out.push_str(&format!(
                "- {} — {} {} · edited {} · {}\n",
                title_of(r),
                r["object"].as_str().unwrap_or("page"),
                r["id"].as_str().unwrap_or(""),
                r["last_edited_time"].as_str().unwrap_or("?"),
                r["url"].as_str().unwrap_or("")
            ));
        }
        if found["has_more"].as_bool() == Some(true) {
            out.push_str("(more matches; narrow the query)\n");
        }
        Ok(out)
    }
}

#[async_trait::async_trait]
impl Tool for NotionReadPage {
    fn effect(&self) -> Effect {
        Effect::ReadOnly
    }

    fn def(&self) -> ToolDef {
        ToolDef {
            name: "notion_read_page".into(),
            description: format!(
                "Read one Notion page as text: headings, lists, to-dos, code, nested \
                 blocks; sub-pages are named with their ids, not opened. Takes a page id or \
                 a notion.so link. Long pages come {READ_MAX} characters at a time — pass \
                 `offset` to read on.{SCOPE}"
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "page": {"type": "string", "description": "Page id or notion.so link"},
                    "offset": {"type": "integer", "minimum": 0, "description": "Character to start at"}
                },
                "required": ["page"]
            }),
        }
    }

    async fn call(&self, input: Value, _cancel: &CancellationToken) -> Result<String, String> {
        let id = page_id(input["page"].as_str().unwrap_or(""))?;
        let offset = input["offset"].as_u64().unwrap_or(0) as usize;
        let page = self.0.get(&format!("/v1/pages/{id}"), &[]).await?;
        let mut text = String::new();
        let mut walked = 0usize;
        // Depth-first, in page order: each level's blocks reversed onto a
        // stack so the first is taken first.
        let mut todo: Vec<(Value, usize)> = self
            .0
            .children(&id)
            .await?
            .into_iter()
            .rev()
            .map(|b| (b, 0))
            .collect();
        let mut cut = false;
        while let Some((b, depth)) = todo.pop() {
            walked += 1;
            if walked > BLOCK_CAP {
                cut = true;
                break;
            }
            let line = render_block(&b, depth);
            if !line.is_empty() {
                text.push_str(&line);
                text.push('\n');
            }
            let kind = b["type"].as_str().unwrap_or("");
            if b["has_children"].as_bool() == Some(true)
                && kind != "child_page"
                && kind != "child_database"
                && depth + 1 < DEPTH_CAP
                && let Some(child) = b["id"].as_str()
            {
                let kids = self.0.children(child).await?;
                todo.extend(kids.into_iter().rev().map(|k| (k, depth + 1)));
            }
        }
        let total = text.chars().count();
        let window: String = text.chars().skip(offset).take(READ_MAX).collect();
        let mut out = format!(
            "{} — {}\n{}\n\n{window}",
            title_of(&page),
            page["url"].as_str().unwrap_or(""),
            "=".repeat(8)
        );
        if offset + READ_MAX < total {
            out.push_str(&format!(
                "\n(characters {offset}–{} of {total}; read on with offset {})",
                offset + READ_MAX,
                offset + READ_MAX
            ));
        }
        if cut {
            out.push_str(&format!(
                "\n(stopped after {BLOCK_CAP} blocks; the rest of the page is not shown)"
            ));
        }
        Ok(out)
    }
}

#[async_trait::async_trait]
impl Tool for NotionListChildren {
    fn effect(&self) -> Effect {
        Effect::ReadOnly
    }

    fn def(&self) -> ToolDef {
        ToolDef {
            name: "notion_list_children".into(),
            description: format!(
                "List a Notion page's sub-pages and databases (title and id), to walk the \
                 tree under the root page. Takes a page id or notion.so link.{SCOPE}"
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "page": {"type": "string", "description": "Page id or notion.so link"}
                },
                "required": ["page"]
            }),
        }
    }

    async fn call(&self, input: Value, _cancel: &CancellationToken) -> Result<String, String> {
        let id = page_id(input["page"].as_str().unwrap_or(""))?;
        let kids = self.0.children(&id).await?;
        let lines: Vec<String> = kids
            .iter()
            .filter(|b| b["type"] == "child_page" || b["type"] == "child_database")
            .map(|b| render_block(b, 0))
            .collect();
        if lines.is_empty() {
            return Ok("no sub-pages or databases on that page".to_string());
        }
        Ok(lines.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Bytes;
    use axum::extract::State;
    use axum::http::{HeaderMap, Method, StatusCode, Uri};
    use axum::response::IntoResponse;
    use std::sync::Mutex;

    const TOKEN: &str = "secret_test_token_abc123";
    const ROOT: &str = "11111111-1111-1111-1111-111111111111";
    const CHILD: &str = "22222222-2222-2222-2222-222222222222";
    const TOGGLE: &str = "33333333-3333-3333-3333-333333333333";
    const OUTSIDE: &str = "99999999-9999-9999-9999-999999999999";

    /// Every request the stand-in saw: method and path.
    type Seen = Arc<Mutex<Vec<(String, String)>>>;

    fn page(id: &str, title: &str) -> Value {
        json!({"object": "page", "id": id, "url": format!("https://www.notion.so/{}", id.replace('-', "")),
            "last_edited_time": "2026-10-01T10:00:00.000Z",
            "properties": {"Name": {"type": "title", "title": [{"plain_text": title}]}}})
    }

    fn para(text: &str) -> Value {
        json!({"object": "block", "type": "paragraph", "has_children": false,
            "paragraph": {"rich_text": [{"plain_text": text}]}})
    }

    /// Notion as the integration sees it: ROOT and CHILD shared, OUTSIDE
    /// not (a 404, as Notion answers), and only GET and the search POST
    /// served — anything else is a 405 and recorded.
    async fn notion(
        State(seen): State<Seen>,
        method: Method,
        uri: Uri,
        headers: HeaderMap,
        _body: Bytes,
    ) -> axum::response::Response {
        let path = uri.path().to_string();
        seen.lock()
            .unwrap()
            .push((method.to_string(), path.clone()));
        if headers.get("authorization").and_then(|v| v.to_str().ok())
            != Some(&format!("Bearer {TOKEN}"))
            || headers.get("notion-version").is_none()
        {
            return (
                StatusCode::UNAUTHORIZED,
                axum::Json(json!({"message": "API token is invalid."})),
            )
                .into_response();
        }
        let missing = || {
            (
                StatusCode::NOT_FOUND,
                axum::Json(json!({"object": "error", "status": 404, "code": "object_not_found",
                    "message": "Could not find page. Make sure the relevant pages and databases are shared with your integration."})),
            )
                .into_response()
        };
        let ok = |v: Value| axum::Json(v).into_response();
        match (method.as_str(), path.as_str()) {
            ("POST", "/v1/search") => ok(
                json!({"results": [page(ROOT, "Root"), page(CHILD, "Child notes")], "has_more": false}),
            ),
            ("GET", p) if p == format!("/v1/pages/{ROOT}") => ok(page(ROOT, "Root")),
            ("GET", p) if p == format!("/v1/pages/{CHILD}") => ok(page(CHILD, "Child notes")),
            ("GET", p) if p == format!("/v1/blocks/{ROOT}/children") => ok(json!({"results": [
                {"object": "block", "type": "heading_1", "has_children": false, "heading_1": {"rich_text": [{"plain_text": "Plans"}]}},
                para("The root page."),
                {"object": "block", "id": TOGGLE, "type": "toggle", "has_children": true, "toggle": {"rich_text": [{"plain_text": "More"}]}},
                {"object": "block", "id": CHILD, "type": "child_page", "has_children": true, "child_page": {"title": "Child notes"}},
                {"object": "block", "type": "to_do", "has_children": false, "to_do": {"rich_text": [{"plain_text": "ship it"}], "checked": true}}
            ], "has_more": false})),
            ("GET", p) if p == format!("/v1/blocks/{TOGGLE}/children") => {
                ok(json!({"results": [para("inside the toggle")], "has_more": false}))
            }
            ("GET", p) if p == format!("/v1/blocks/{CHILD}/children") => {
                ok(json!({"results": [para("child text")], "has_more": false}))
            }
            ("GET", _) => missing(),
            _ => StatusCode::METHOD_NOT_ALLOWED.into_response(),
        }
    }

    async fn stand_in() -> (String, Seen) {
        let seen: Seen = Arc::default();
        let app = axum::Router::new()
            .fallback(notion)
            .with_state(seen.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await });
        (format!("http://{addr}"), seen)
    }

    fn client(base: &str) -> Notion {
        Notion::with(base, Arc::new(|| Some(TOKEN.to_string())))
    }

    async fn run(tool: &dyn Tool, input: Value) -> Result<String, String> {
        tool.call(input, &CancellationToken::new()).await
    }

    #[tokio::test]
    async fn search_reads_and_lists_the_shared_tree() {
        let (base, seen) = stand_in().await;
        let n = client(&base);
        let found = run(&NotionSearch(n.clone()), json!({"query": "notes"}))
            .await
            .unwrap();
        assert!(found.contains("- Root — page 1111"), "{found}");
        assert!(found.contains("Child notes"), "{found}");

        // By a link, dashes gone and a query string on.
        let link = format!("https://www.notion.so/Root-{}?pvs=4", ROOT.replace('-', ""));
        let text = run(&NotionReadPage(n.clone()), json!({"page": link}))
            .await
            .unwrap();
        assert!(text.starts_with("Root — https://www.notion.so/"), "{text}");
        for want in [
            "# Plans",
            "The root page.",
            "▸ More",
            "  inside the toggle",
            &format!("[sub-page: Child notes — {CHILD}]"),
            "- [x] ship it",
        ] {
            assert!(text.contains(want), "{want:?} missing from {text}");
        }
        // A sub-page is named, not opened.
        assert!(!text.contains("child text"), "{text}");

        let kids = run(&NotionListChildren(n.clone()), json!({"page": ROOT}))
            .await
            .unwrap();
        assert_eq!(kids, format!("[sub-page: Child notes — {CHILD}]"));

        let child = run(&NotionReadPage(n), json!({"page": CHILD}))
            .await
            .unwrap();
        assert!(child.contains("child text"), "{child}");

        let methods: Vec<(String, String)> = seen.lock().unwrap().clone();
        assert!(
            methods
                .iter()
                .all(|(m, p)| m == "GET" || (m == "POST" && p == "/v1/search")),
            "a request that is not a read: {methods:?}"
        );
    }

    #[tokio::test]
    async fn a_page_outside_the_tree_is_not_found() {
        let (base, _) = stand_in().await;
        let n = client(&base);
        let err = run(&NotionReadPage(n.clone()), json!({"page": OUTSIDE}))
            .await
            .unwrap_err();
        assert!(err.starts_with("not found"), "{err}");
        let err = run(&NotionListChildren(n), json!({"page": OUTSIDE}))
            .await
            .unwrap_err();
        assert!(err.starts_with("not found"), "{err}");
    }

    /// The token is never in a reply, an error or `Debug`; a wrong one is a
    /// sentence, and with none at all nothing is sent.
    #[tokio::test]
    async fn the_token_is_never_shown_and_its_absence_sends_nothing() {
        let (base, seen) = stand_in().await;
        let n = client(&base);
        assert!(!format!("{n:?}").contains(TOKEN));
        let mut said = vec![
            run(&NotionSearch(n.clone()), json!({"query": ""}))
                .await
                .unwrap(),
            run(&NotionReadPage(n.clone()), json!({"page": ROOT}))
                .await
                .unwrap(),
            run(&NotionReadPage(n), json!({"page": OUTSIDE}))
                .await
                .unwrap_err(),
        ];
        let wrong = Notion::with(&base, Arc::new(|| Some("secret_wrong_token".into())));
        let err = run(&NotionSearch(wrong), json!({"query": "x"}))
            .await
            .unwrap_err();
        assert!(err.contains("401"), "{err}");
        assert!(!err.contains("secret_wrong_token"), "{err}");
        said.push(err);
        for s in &said {
            assert!(!s.contains(TOKEN), "{s}");
        }

        let before = seen.lock().unwrap().len();
        let none = Notion::with(&base, Arc::new(|| None));
        let err = run(&NotionReadPage(none), json!({"page": ROOT}))
            .await
            .unwrap_err();
        assert!(err.contains("not set up"), "{err}");
        assert_eq!(seen.lock().unwrap().len(), before, "a request went out");
    }

    #[test]
    fn page_ids_are_32_hex_digits_and_nothing_else() {
        let want = "0123abcd-0123-abcd-0123-abcdef012345";
        for given in [
            "0123abcd0123abcd0123abcdef012345",
            want,
            "https://www.notion.so/My-Page-0123abcd0123abcd0123abcdef012345",
            "https://www.notion.so/ws/0123ABCD0123ABCD0123ABCDEF012345?v=1#x",
        ] {
            assert_eq!(page_id(given).unwrap(), want, "{given}");
        }
        for bad in ["", "../v1/users", "0123abcd", "https://evil.example/x"] {
            assert!(page_id(bad).is_err(), "{bad}");
        }
    }

    /// No write path exists: the tools are the three readers, and this
    /// file names no HTTP method but GET and the search's POST. (The
    /// strings are assembled here so the test does not trip itself.)
    #[test]
    fn there_is_no_write_code() {
        let names: Vec<String> = tools(client("http://127.0.0.1:9"))
            .iter()
            .map(|t| t.def().name)
            .collect();
        assert_eq!(
            names,
            ["notion_search", "notion_read_page", "notion_list_children"]
        );
        for t in tools(client("http://127.0.0.1:9")) {
            assert_eq!(t.effect(), Effect::ReadOnly);
        }
        let src = include_str!("notion.rs");
        let body = src.split("#[cfg(test)]").next().unwrap();
        for m in ["patch", "put", "delete"] {
            assert!(!body.contains(&format!(".{m}(")), ".{m}( in notion.rs");
            let upper = m.to_uppercase();
            assert!(
                !body.contains(&format!("Method::{upper}")),
                "Method::{upper} in notion.rs"
            );
        }
        assert_eq!(body.matches(".post(").count(), 1, "one POST: the search");
        assert!(body.contains(".post(format!(\"{}/v1/search\""));
    }
}
