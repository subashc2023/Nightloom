//! Bridging a server's tools into [`nightloom_core::Tool`].

use crate::{Client, McpConfig, McpError};
use nightloom_core::ToolDef;
use nightloom_core::tool::{CancellationToken, Effect, Tool};
use serde_json::{Value, json};
use std::path::Path;
use std::sync::Arc;

/// Longest tool name a provider will accept. Anthropic and OpenAI both cap at
/// 64 characters over `[a-zA-Z0-9_-]`, and a name that violates it is a 400
/// on every request for the whole session rather than a failure of that one
/// tool.
const MAX_NAME: usize = 64;

/// One tool on one server, wearing the harness's `Tool` clothes.
pub struct McpTool {
    client: Arc<Client>,
    /// What the model calls it: the server name, then the tool's own.
    exposed_name: String,
    /// What the server calls it, which is what goes back over the wire.
    remote_name: String,
    description: String,
    input_schema: Value,
}

impl McpTool {
    pub fn exposed_name(&self) -> &str {
        &self.exposed_name
    }

    pub fn remote_name(&self) -> &str {
        &self.remote_name
    }
}

#[async_trait::async_trait]
impl Tool for McpTool {
    /// Always [`Effect::Mutating`], and not because nobody got around to
    /// classifying it.
    ///
    /// The harness has no way to know what a tool on another machine does.
    /// Its name and description are strings the server chose, and a server
    /// that wanted to bypass an approval gate would only have to call its tool
    /// `read_something`. So there is no honest classification available here
    /// and the trait's default is the right answer — this override exists to
    /// say so out loud, since a reader who found no `effect` here would
    /// reasonably wonder whether it was an oversight.
    fn effect(&self) -> Effect {
        Effect::Mutating
    }

    fn def(&self) -> ToolDef {
        ToolDef {
            name: self.exposed_name.clone(),
            description: self.description.clone(),
            input_schema: self.input_schema.clone(),
        }
    }

    async fn call(&self, input: Value, cancel: &CancellationToken) -> Result<String, String> {
        match self
            .client
            .call_tool(&self.remote_name, input, cancel)
            .await
        {
            // A tool that ran and failed: the model gets the server's own
            // words, which is what it needs to try something else.
            Ok(out) if out.is_error => Err(if out.text.is_empty() {
                "the tool reported an error with no message".to_string()
            } else {
                out.text
            }),
            Ok(out) => Ok(out.text),
            // The server itself is broken or gone. Still an error result
            // rather than an aborted turn — the model can carry on without
            // this server, and the turn holds work worth keeping.
            Err(e) => Err(format!("MCP server '{}': {e}", self.client.name())),
        }
    }
}

/// Start every enabled server in `config` and collect their tools.
///
/// Returns the tools alongside one report per server, because a shell has to
/// be able to say what happened: a server that failed to start is worth a line
/// on stderr, and it must not take the session down with it. The alternative —
/// failing the whole connection because one of five servers is misconfigured —
/// makes MCP too brittle to leave switched on.
pub async fn connect_all(config: &McpConfig, workspace: &Path) -> Vec<ServerReport> {
    let mut reports = Vec::new();
    for (name, spec) in &config.servers {
        if spec.disabled {
            continue;
        }
        reports.push(connect_one(name, spec, workspace).await);
    }
    reports
}

/// What happened with one server.
pub struct ServerReport {
    pub name: String,
    pub outcome: Result<Vec<Box<dyn Tool>>, McpError>,
}

impl ServerReport {
    /// The tools, or none — for a caller that only wants what worked.
    pub fn tools(self) -> Vec<Box<dyn Tool>> {
        self.outcome.unwrap_or_default()
    }
}

async fn connect_one(name: &str, spec: &crate::ServerSpec, workspace: &Path) -> ServerReport {
    let outcome = async {
        let client = match spec.transport()? {
            crate::Transport::Stdio {
                command,
                args,
                env,
                cwd,
            } => {
                let cwd = cwd.as_deref().map(Path::new).unwrap_or(workspace);
                Client::stdio(name, &command, &args, &env, Some(cwd)).await?
            }
            crate::Transport::Http { url, headers } => Client::http(name, &url, &headers)?,
        };
        client.initialize().await?;
        let client = Arc::new(client);
        let listed = client.list_tools().await?;
        let mut tools: Vec<Box<dyn Tool>> = Vec::new();
        for t in listed {
            let Some(remote_name) = t["name"].as_str() else {
                continue;
            };
            tools.push(Box::new(McpTool {
                client: Arc::clone(&client),
                exposed_name: exposed_name(name, remote_name),
                remote_name: remote_name.to_string(),
                description: t["description"].as_str().unwrap_or_default().to_string(),
                // A tool with no schema still has to present one: providers
                // reject a tool declaration without an input schema, and an
                // empty object is the honest "takes nothing in particular".
                input_schema: match t.get("inputSchema") {
                    Some(s) if s.is_object() => s.clone(),
                    _ => json!({ "type": "object", "properties": {} }),
                },
            }));
        }
        Ok(tools)
    }
    .await;
    ServerReport {
        name: name.to_string(),
        outcome,
    }
}

/// `server__tool`, sanitized to what providers accept.
///
/// Prefixed rather than passed through, for two reasons that point the same
/// way. Two servers may each offer a `search`, and the model needs to be able
/// to name one of them. And an MCP `read_file` must not be confusable with the
/// built-in `read_file`, which is rooted in the workspace and classified
/// `ReadOnly` — the built-in's guarantees are not the server's to inherit.
fn exposed_name(server: &str, tool: &str) -> String {
    let clean = |s: &str| -> String {
        s.chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .collect()
    };
    let mut name = format!("{}__{}", clean(server), clean(tool));
    if name.len() > MAX_NAME {
        // Truncate the *front*, keeping the tool's own name intact: the tail
        // is what tells the model what the tool does, and two tools from the
        // same over-long server name would otherwise collide.
        let keep = name.len() - MAX_NAME;
        name = name[keep..].to_string();
    }
    name
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_prefixed_and_sanitized() {
        assert_eq!(exposed_name("files", "read_file"), "files__read_file");
        // A server named after a scoped npm package, or a tool with a dot in
        // it, would otherwise be a 400 on every request in the session.
        assert_eq!(
            exposed_name("@acme/tools", "get.thing"),
            "_acme_tools__get_thing"
        );
    }

    #[test]
    fn an_over_long_name_keeps_the_tool_end() {
        let name = exposed_name(&"s".repeat(80), "search");
        assert_eq!(name.len(), MAX_NAME);
        assert!(name.ends_with("__search"), "{name}");
    }

    #[test]
    fn a_prefixed_name_cannot_shadow_a_builtin() {
        // The built-in `read_file` is rooted in the workspace and classified
        // ReadOnly; a server's version is neither, and must not be able to
        // take its place at the point where the model chooses.
        assert_ne!(exposed_name("anything", "read_file"), "read_file");
    }

    #[tokio::test]
    async fn every_mcp_tool_is_mutating_however_harmless_it_looks() {
        let (a, _b) = tokio::io::duplex(64);
        let (r, w) = tokio::io::split(a);
        let tool = McpTool {
            client: Arc::new(Client::from_streams("s", r, w, None, None)),
            exposed_name: "s__look".into(),
            remote_name: "look".into(),
            // A server can describe its tool however it likes. Believing the
            // description is exactly the mistake this guards against: the
            // effect classification is what routes a call to the approval
            // gate, and nothing here has vouched for what the tool does.
            description: "Read-only. Simply observes. Completely safe.".into(),
            input_schema: json!({}),
        };
        assert_eq!(tool.effect(), Effect::Mutating);
    }
}
