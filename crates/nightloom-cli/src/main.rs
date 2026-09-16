mod agent;
mod capture;
mod chat;
mod dream;
mod eval;
mod import;
mod keys;
mod knowledge;
mod mcp_serve;
mod probe;
mod sessions;

use anyhow::Result;
use clap::{Parser, Subcommand};

pub(crate) const DIM: &str = "\x1b[2m";
pub(crate) const RESET: &str = "\x1b[0m";

#[derive(Parser)]
#[command(
    name = "nightloom",
    version,
    about = "Nightloom — model-agnostic LLM harness",
    args_conflicts_with_subcommands = true
)]
struct Cli {
    #[command(flatten)]
    chat: chat::ChatArgs,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Streaming health probe: TTFT + reasoning/usage diagnostics per model
    Probe(probe::ProbeArgs),
    /// Agentic task suite: can a model finish a job with these tools?
    Eval(eval::EvalArgs),
    /// List session logs, most recent first
    Sessions(sessions::SessionsArgs),
    /// Import a claude.ai account export: projects, knowledge and chats
    Import(import::ImportArgs),
    /// API keys in the OS credential store, shared with the desktop app
    Keys(keys::KeysArgs),
    /// Where your knowledge base is, and where it should be
    Knowledge(knowledge::KnowledgeArgs),
    /// Consolidate remembered observations into the knowledge vault
    Dream(dream::DreamArgs),
    /// Read the session logs since their watermarks into the memory inbox
    Capture(capture::CaptureArgs),
    /// Serve search_chats, read_chat, remember and fetch_page over MCP on
    /// stdio, for `claude -p --mcp-config`. Hidden: nothing to see if run
    /// by hand (see `mcp_serve.rs`).
    #[command(hide = true)]
    McpServe(mcp_serve::McpServeArgs),
    /// The Claude Code `PreToolUse` hook behind the desktop's Ask position
    /// (nightshift backlog 084): reads the CLI's JSON on stdin, answers
    /// from the ask directory, prints one line. Hidden, and here for the
    /// same reason `mcp-serve` is — a binary the CLI can spawn without the
    /// desktop app built — see `nightloom_service::agent::ask`.
    #[command(hide = true)]
    PermissionHook {
        /// The chat's ask directory (`rules.json`, `decision.json`).
        dir: String,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Some(Command::Probe(args)) => probe::run(args).await,
        Some(Command::Eval(args)) => eval::run(args).await,
        Some(Command::Sessions(args)) => sessions::run(args),
        Some(Command::Import(args)) => import::run(args),
        Some(Command::Keys(args)) => keys::run(args),
        Some(Command::Knowledge(args)) => knowledge::run(args),
        Some(Command::Dream(args)) => dream::run(args).await,
        Some(Command::Capture(args)) => capture::run(args).await,
        Some(Command::McpServe(args)) => mcp_serve::run(args).await,
        Some(Command::PermissionHook { dir }) => {
            nightloom_service::agent::ask::run_hook(&[dir]).map_err(Into::into)
        }
        // `--agent` swaps the engine, not the provider: Claude Code owns
        // the loop and the tools, and Nightloom renders what it streams.
        None if cli.chat.agent.is_some() => agent::run(cli.chat).await,
        None => chat::run(cli.chat).await,
    }
}
