use anyhow::{Result, anyhow};
use nightloom_service::import::{self, Export, ImportOptions};
use nightloom_service::project::Registry;
use std::path::PathBuf;

use crate::{DIM, RESET};

#[derive(clap::Args)]
pub struct ImportArgs {
    /// The export zip Anthropic emailed you, or a folder it was unpacked into
    #[arg(value_name = "EXPORT")]
    export: PathBuf,

    /// Also give each imported project a folder here. Omit it and the
    /// projects have no folder, which is what a claude.ai project is: some
    /// instructions, some documents and a pile of conversations, with no code
    /// anywhere. Pass it when you mean to keep code alongside them.
    #[arg(long, value_name = "DIR")]
    into: Option<PathBuf>,

    /// List what the export holds and write nothing
    #[arg(long)]
    list: bool,

    /// Import only projects whose name contains this (repeatable)
    #[arg(long, value_name = "NAME")]
    only: Vec<String>,

    /// Also import conversations that belong to no project
    #[arg(long)]
    unfiled: bool,

    /// Import without adding anything to the project list.
    ///
    /// Rarely what you want now that a project *is* the registry entry: with
    /// no folder there is nothing else pointing at what was written, so this
    /// leaves the chats on disk and nothing listing them.
    #[arg(long)]
    no_register: bool,
}

pub fn run(args: ImportArgs) -> Result<()> {
    let export = import::read_export(&args.export).map_err(|e| anyhow!(e))?;

    if args.list {
        return list(&export);
    }

    let mut opts = ImportOptions::new();
    opts.into = args.into.clone();
    opts.unfiled = args.unfiled;
    opts.only = args.only.clone();

    // The registry is not optional to the import itself — a project's id is
    // what decides where its chats are written, so nothing can be written
    // before the project exists. `--no-register` therefore throws the result
    // away afterwards rather than skipping it, which is why it is a poor
    // idea and says so.
    let mut registry = Registry::load();
    let report = import::import(&export, &opts, &mut registry).map_err(|e| anyhow!(e))?;
    if report.projects.is_empty() {
        println!("nothing to import");
        if !export.conversations.is_empty() {
            println!(
                "{DIM}{} conversation(s) carry no project link; --unfiled imports them{RESET}",
                export.conversations.len()
            );
        }
        return Ok(());
    }

    for project in &report.projects {
        let mut counts = vec![format!("{} chat(s)", project.imported)];
        if project.already > 0 {
            counts.push(format!("{} already there", project.already));
        }
        if project.notes > 0 {
            counts.push(format!("{} note(s)", project.notes));
        }
        if project.instructions {
            counts.push("AGENTS.md".to_string());
        }
        if project.superseded > 0 {
            counts.push(format!(
                "{} superseded message(s) left out",
                project.superseded
            ));
        }
        println!("{}", project.name);
        match &project.root {
            Some(root) => println!("  {DIM}{}{RESET}", root.display()),
            None => println!("  {DIM}no folder — chats and notes only{RESET}"),
        }
        println!("  {}", counts.join(", "));
        for warning in &project.warnings {
            println!("  {DIM}! {warning}{RESET}");
        }
    }

    if args.no_register {
        for project in &report.projects {
            let _ = registry.forget(&project.id);
        }
        println!();
        println!(
            "{DIM}--no-register: the projects were removed from the list. What was              written is still on disk, but nothing lists it.{RESET}"
        );
    }

    println!();
    println!("{}", report.summary());
    if report.unfiled > 0 {
        println!(
            "{DIM}{} conversation(s) carry no project link and were left out; \
             --unfiled imports them into a project of their own{RESET}",
            report.unfiled
        );
    }
    for warning in &report.warnings {
        println!("{DIM}! {warning}{RESET}");
    }
    Ok(())
}

fn list(export: &Export) -> Result<()> {
    if export.projects.is_empty() {
        println!("no projects in this export");
    } else {
        println!("{:>6}  {:>6}  name", "chats", "notes");
    }
    let mut filed = 0;
    for project in &export.projects {
        let chats = export
            .conversations
            .iter()
            .filter(|c| c.project_id() == Some(project.uuid.as_str()))
            .count();
        filed += chats;
        let name = if project.name.trim().is_empty() {
            "Untitled project"
        } else {
            project.name.trim()
        };
        // Counted the way the import writes them: exports repeat a
        // document when it was re-uploaded, and a listing that promised
        // three notes before writing two would read as a failure.
        let notes = project
            .docs
            .iter()
            .filter(|d| !d.content.is_empty())
            .map(|d| d.filename.trim())
            .collect::<std::collections::HashSet<_>>()
            .len();
        println!("{chats:>6}  {notes:>6}  {name}");
    }
    println!();
    println!(
        "{} conversation(s) in total, {} filed under a project, {} unfiled",
        export.conversations.len(),
        filed,
        export.conversations.len() - filed
    );
    // `--list` never reaches the import, so the observation it would make
    // about a link that is not in the archive has to be made again here —
    // this is the command someone runs *before* deciding, and "0 filed" on
    // its own reads as a bug in the reader that just found the projects.
    if !export.projects.is_empty() && filed == 0 && !export.conversations.is_empty() {
        println!(
            "{DIM}no conversation here records which project it belonged to — that link \
             is not in the archive, so these chats can only be imported unfiled \
             (--unfiled){RESET}"
        );
    }
    if export.unreadable > 0 {
        println!(
            "{DIM}{} record(s) could not be read{RESET}",
            export.unreadable
        );
    }
    for warning in &export.warnings {
        println!("{DIM}! {warning}{RESET}");
    }
    Ok(())
}
