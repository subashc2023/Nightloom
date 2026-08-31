//! `nightloom knowledge` — where the vault is, and where it should be.
//!
//! Here for the reason `keys.rs` is here: the desktop has a Settings pane for
//! this and a terminal user has nothing, so without a command the vault could
//! only ever be the default for anyone who never opens the app. It is the same
//! store either way, so a folder chosen here is the folder the desktop reads.

use anyhow::{Context, Result};
use nightloom_service::{knowledge, project};
use std::path::PathBuf;

use crate::{DIM, RESET};

#[derive(clap::Args)]
pub struct KnowledgeArgs {
    /// Point the knowledge base at this folder. Nothing is moved or copied —
    /// an existing vault stays exactly where it is, and this is what makes an
    /// Obsidian vault usable as-is.
    #[arg(long, value_name = "DIR", conflicts_with = "reset")]
    set: Option<PathBuf>,

    /// Put it back at ~/.nightloom/knowledge.
    #[arg(long)]
    reset: bool,
}

pub fn run(args: KnowledgeArgs) -> Result<()> {
    let config = project::config_dir().context(
        "no user config directory — set HOME (or NIGHTLOOM_HOME) to give the vault a home",
    )?;

    if args.reset {
        knowledge::set_vault_dir_in(&config, None).map_err(anyhow::Error::msg)?;
    } else if let Some(dir) = &args.set {
        // Created here rather than on first write, because a path typed into
        // a terminal is worth confirming: a folder that appears is a folder
        // the user can see they picked the right one.
        std::fs::create_dir_all(dir).with_context(|| format!("cannot create {}", dir.display()))?;
        knowledge::set_vault_dir_in(&config, Some(dir)).map_err(anyhow::Error::msg)?;
    }

    let dir = knowledge::vault_dir_in(&config);
    let default = knowledge::is_default_location_in(&config);
    println!("{}", dir.display());
    let notes = project::list_notes(&dir);
    println!(
        "{DIM}{} note{}, {}{RESET}",
        notes.len(),
        if notes.len() == 1 { "" } else { "s" },
        if default {
            "the default location".to_string()
        } else {
            format!(
                "set here, not the default ({})",
                knowledge::default_vault_dir_in(&config).display()
            )
        }
    );
    if !dir.is_dir() {
        // Not an error: the vault is created on first write, exactly as the
        // docspace is, so "not there yet" is the ordinary state of a new one.
        println!("{DIM}not created yet — it appears when the first note is written{RESET}");
    }
    println!("{DIM}the model reaches it as @kb/<name> when --tools is on{RESET}");
    Ok(())
}
