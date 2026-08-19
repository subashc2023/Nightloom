//! Which servers to start, read from `mcp.json`.

use crate::McpError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// One server to reach, either by starting it or by calling it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ServerSpec {
    /// The binary to spawn, for a server that runs locally.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    /// Extra environment for the child. Added to the inherited environment
    /// rather than replacing it — a server that needs `PATH` should not have
    /// to be told what `PATH` is.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// Working directory for the child; defaults to the harness's own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// The endpoint, for a server that lives behind a URL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Headers to send with every request — in practice, an `Authorization`.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
    /// `"stdio"` or `"http"`, for the rare entry that carries both a command
    /// and a URL. Left out, the transport is inferred from which one is there.
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// Skip this server without deleting its entry.
    #[serde(default)]
    pub disabled: bool,
}

/// How to reach one server, with every `${VAR}` already resolved.
#[derive(Debug, Clone, PartialEq)]
pub enum Transport {
    Stdio {
        command: String,
        args: Vec<String>,
        env: Vec<(String, String)>,
        cwd: Option<String>,
    },
    Http {
        url: String,
        headers: Vec<(String, String)>,
    },
}

impl ServerSpec {
    /// Work out how to reach this server, expanding `${VAR}` as it goes.
    ///
    /// Both halves can fail, and both failures are worth one line each rather
    /// than a panic: an entry that names neither a command nor a URL is a
    /// typo, and a `${GITHUB_TOKEN}` that is not set is the ordinary Monday
    /// morning of anyone using a remote server.
    pub fn transport(&self) -> Result<Transport, McpError> {
        let http = || -> Result<Transport, McpError> {
            let url = self.url.as_deref().unwrap_or_default();
            Ok(Transport::Http {
                url: expand(url)?,
                headers: expand_pairs(&self.headers)?,
            })
        };
        let stdio = || -> Result<Transport, McpError> {
            Ok(Transport::Stdio {
                command: expand(self.command.as_deref().unwrap_or_default())?,
                args: self
                    .args
                    .iter()
                    .map(|a| expand(a))
                    .collect::<Result<_, _>>()?,
                env: expand_pairs(&self.env)?,
                cwd: self.cwd.as_deref().map(expand).transpose()?,
            })
        };
        match self.kind.as_deref() {
            Some("http" | "streamable-http") if self.url.is_some() => http(),
            Some("http" | "streamable-http") => Err(McpError::BadSpec(
                "type is \"http\" but no url was given".into(),
            )),
            Some("stdio") if self.command.is_some() => stdio(),
            Some("stdio") => Err(McpError::BadSpec(
                "type is \"stdio\" but no command was given".into(),
            )),
            // Worth naming rather than folding into "unknown": plenty of
            // existing configs say `"type": "sse"`, and the useful answer is
            // which transport to switch to, not that the word was unrecognised.
            Some("sse") => Err(McpError::BadSpec(
                "the deprecated HTTP+SSE transport is not supported; use \"http\" if the server \
                 offers a Streamable HTTP endpoint"
                    .into(),
            )),
            Some(other) => Err(McpError::BadSpec(format!(
                "unknown transport type {other:?}: expected \"stdio\" or \"http\""
            ))),
            None => match (&self.command, &self.url) {
                (None, Some(_)) => http(),
                (Some(_), None) => stdio(),
                (Some(_), Some(_)) => Err(McpError::BadSpec(
                    "has both a command and a url; add \"type\" to say which".into(),
                )),
                (None, None) => Err(McpError::BadSpec(
                    "needs either a command to run or a url to call".into(),
                )),
            },
        }
    }
}

/// Substitute `${VAR}` from the environment.
///
/// An unset variable is an error rather than an empty string, and that is the
/// whole point of the feature. The alternative to writing `${GITHUB_TOKEN}` in
/// a config file is writing the token itself, which is how tokens end up in
/// git; and silently expanding a missing one to nothing would send an
/// `Authorization: Bearer ` and turn a plain "you forgot to export it" into a
/// 401 from someone else's server.
fn expand(s: &str) -> Result<String, McpError> {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let tail = &rest[start + 2..];
        let Some(end) = tail.find('}') else {
            // An unterminated `${` is a literal, not an error: it may well be
            // a shell snippet the server itself is meant to see.
            out.push_str(&rest[start..]);
            return Ok(out);
        };
        let name = &tail[..end];
        let value = std::env::var(name).map_err(|_| McpError::MissingEnv(name.to_string()))?;
        out.push_str(&value);
        rest = &tail[end + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

fn expand_pairs(map: &BTreeMap<String, String>) -> Result<Vec<(String, String)>, McpError> {
    map.iter()
        .map(|(k, v)| Ok((k.clone(), expand(v)?)))
        .collect()
}

/// The parsed `mcp.json`.
///
/// The `mcpServers` key matches the shape every other MCP host uses. That is
/// worth more than a name of our own choosing: it means an existing config
/// can be copied across unchanged, and copying is how anyone actually gets a
/// server running the first time.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct McpConfig {
    #[serde(default, rename = "mcpServers")]
    pub servers: BTreeMap<String, ServerSpec>,
}

impl McpConfig {
    pub fn is_empty(&self) -> bool {
        self.servers.values().all(|s| s.disabled)
    }

    pub fn load(path: impl AsRef<Path>) -> Result<Self, McpError> {
        let path = path.as_ref();
        let text = std::fs::read_to_string(path).map_err(|source| McpError::Config {
            path: path.display().to_string(),
            source,
        })?;
        serde_json::from_str(&text).map_err(|e| McpError::Config {
            path: path.display().to_string(),
            source: std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()),
        })
    }

    /// Load whichever of the standard locations exist, merging them.
    ///
    /// Project config wins over user config on a name collision, matching how
    /// project instructions override user memory in the preamble: the more
    /// specific file is the one that knows about this repository.
    ///
    /// A missing file is not an error — most workspaces have no MCP servers,
    /// and demanding a file be created to say "none" is noise.
    pub fn discover(workspace: &Path) -> Self {
        let mut merged = Self::default();
        for path in Self::locations(workspace) {
            if let Ok(config) = Self::load(&path) {
                merged.servers.extend(config.servers);
            }
        }
        merged
    }

    /// Where `discover` looks, least specific first.
    pub fn locations(workspace: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        if let Some(home) = home_dir() {
            out.push(home.join(".nightloom").join("mcp.json"));
        }
        out.push(workspace.join(".nightloom").join("mcp.json"));
        out
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_shape_other_hosts_use() {
        let config: McpConfig = serde_json::from_str(
            r#"{
                "mcpServers": {
                    "files": {
                        "command": "npx",
                        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
                        "env": { "LOG": "debug" }
                    },
                    "off": { "command": "x", "disabled": true }
                }
            }"#,
        )
        .unwrap();
        assert_eq!(config.servers.len(), 2);
        assert_eq!(config.servers["files"].args.len(), 3);
        assert_eq!(config.servers["files"].env["LOG"], "debug");
        assert!(config.servers["off"].disabled);
        assert!(!config.is_empty());
    }

    #[test]
    fn a_config_of_only_disabled_servers_is_empty() {
        let config: McpConfig =
            serde_json::from_str(r#"{"mcpServers": {"a": {"command": "x", "disabled": true}}}"#)
                .unwrap();
        assert!(config.is_empty());
    }

    fn spec(json: &str) -> ServerSpec {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn a_url_means_http_and_a_command_means_stdio() {
        assert!(matches!(
            spec(r#"{"url": "https://example.test/mcp"}"#)
                .transport()
                .unwrap(),
            Transport::Http { .. }
        ));
        assert!(matches!(
            spec(r#"{"command": "npx", "args": ["-y", "srv"]}"#)
                .transport()
                .unwrap(),
            Transport::Stdio { .. }
        ));
    }

    #[test]
    fn an_entry_that_names_neither_says_so_rather_than_guessing() {
        let err = spec(r#"{"args": ["-y"]}"#).transport().unwrap_err();
        assert!(err.to_string().contains("command"), "{err}");
        assert!(err.to_string().contains("url"), "{err}");
    }

    #[test]
    fn both_a_command_and_a_url_is_ambiguous_until_type_says() {
        let both = r#"{"command": "npx", "url": "https://example.test/mcp"}"#;
        assert!(spec(both).transport().is_err());
        let mut chosen = spec(both);
        chosen.kind = Some("http".into());
        assert!(matches!(
            chosen.transport().unwrap(),
            Transport::Http { .. }
        ));
    }

    #[test]
    fn the_deprecated_sse_transport_is_named_rather_than_called_unknown() {
        // `"type": "sse"` is all over existing configs, and the useful answer
        // is which transport to switch to.
        let mut s = spec(r#"{"url": "https://example.test/sse"}"#);
        s.kind = Some("sse".into());
        let err = s.transport().unwrap_err().to_string();
        assert!(err.contains("deprecated"), "{err}");
        assert!(err.contains("\"http\""), "{err}");
    }

    #[test]
    fn a_header_can_reference_the_environment_instead_of_holding_a_token() {
        // SAFETY: single-threaded test process section; the var is read back
        // immediately below.
        unsafe { std::env::set_var("NIGHTLOOM_TEST_TOKEN", "s3cret") };
        let s = spec(
            r#"{"url": "https://example.test/mcp",
                "headers": {"Authorization": "Bearer ${NIGHTLOOM_TEST_TOKEN}"}}"#,
        );
        let Transport::Http { headers, .. } = s.transport().unwrap() else {
            panic!("expected http");
        };
        assert_eq!(headers[0].1, "Bearer s3cret");
    }

    #[test]
    fn an_unset_variable_fails_the_server_rather_than_sending_an_empty_token() {
        let s = spec(
            r#"{"url": "https://example.test/mcp",
                "headers": {"Authorization": "Bearer ${NIGHTLOOM_TEST_UNSET}"}}"#,
        );
        let err = s.transport().unwrap_err();
        // The alternative — expanding to nothing — turns "you forgot to export
        // it" into a 401 from somebody else's server.
        assert!(matches!(err, McpError::MissingEnv(ref v) if v == "NIGHTLOOM_TEST_UNSET"));
    }

    #[test]
    fn an_unterminated_placeholder_is_left_alone() {
        // It may well be something the server is meant to see itself.
        assert_eq!(expand("echo ${not closed").unwrap(), "echo ${not closed");
    }

    #[test]
    fn an_absent_file_is_not_an_error() {
        let dir = std::env::temp_dir().join("nightloom-mcp-absent");
        let config = McpConfig::discover(&dir);
        assert!(config.servers.is_empty());
    }
}
