mod chat;
mod probe;

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
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Some(Command::Probe(args)) => probe::run(args).await,
        None => chat::run(cli.chat).await,
    }
}
