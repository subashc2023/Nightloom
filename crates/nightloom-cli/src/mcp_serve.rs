//! `nightloom mcp-serve` — Nightloom's tools as an MCP server on stdio, for
//! the Claude Code engine.
//!
//! Not a command a person runs: `claude -p` runs it, from the `--mcp-config`
//! the desktop hands over, and talks JSON-RPC on its stdin and stdout until
//! it closes them. Everything — the four tools, the framing, the errors —
//! lives in `nightloom_service::mcp_server`; this is the config dir and the
//! streams. Hidden from `--help` for the same reason: listed beside `dream`
//! and `capture` it would read as something to try, and trying it prints
//! nothing and waits.

use anyhow::{Result, bail};
use nightloom_service::{mcp_server, project};

#[derive(clap::Args)]
pub struct McpServeArgs {
    /// The open project's id: its chats are the default search scope and
    /// its name is what `remember` files an observation under. Without it,
    /// the unfiled chats.
    #[arg(long)]
    project: Option<String>,
    /// Serve without `remember`: the server for an incognito or ephemeral
    /// chat, which must not be able to write to memory (2026-09-15).
    #[arg(long)]
    no_remember: bool,
    /// A dream's server (2026-09-16): the JSON `dream::run_on_agent` builds,
    /// and `propose_instructions` is the one tool served. Needs no config
    /// dir.
    #[arg(long)]
    dream: Option<String>,
    /// Serve `ask`, the permission host a chat in the desktop's Ask
    /// position names with `--permission-prompt-tool` (2026-09-16).
    #[arg(long)]
    ask: bool,
}

pub async fn run(args: McpServeArgs) -> Result<()> {
    let dream = args
        .dream
        .as_deref()
        .map(mcp_server::DreamServe::parse)
        .transpose()
        .map_err(anyhow::Error::msg)?;
    let config = match project::config_dir() {
        Some(config) => config,
        None if dream.is_some() => std::path::PathBuf::new(),
        None => bail!("no user config directory — there are no chats to serve"),
    };
    let serve_args = match dream {
        Some(dream) => mcp_server::ServeArgs::for_dream(dream),
        None => mcp_server::ServeArgs {
            project: args.project,
            remember: !args.no_remember,
            dream: None,
            ask: args.ask,
        },
    };
    mcp_server::serve(config, serve_args, tokio::io::stdin(), tokio::io::stdout())
        .await
        .map_err(anyhow::Error::msg)
}
