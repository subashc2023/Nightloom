//! Which servers to start, read from `mcp.json`.

use crate::McpError;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// One server to launch.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerSpec {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Extra environment for the child. Added to the inherited environment
    /// rather than replacing it — a server that needs `PATH` should not have
    /// to be told what `PATH` is.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Working directory for the child; defaults to the harness's own.
    #[serde(default)]
    pub cwd: Option<String>,
    /// Skip this server without deleting its entry.
    #[serde(default)]
    pub disabled: bool,
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

    #[test]
    fn an_absent_file_is_not_an_error() {
        let dir = std::env::temp_dir().join("nightloom-mcp-absent");
        let config = McpConfig::discover(&dir);
        assert!(config.servers.is_empty());
    }
}
