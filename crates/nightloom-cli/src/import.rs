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

    /// Where to create one folder per project
    #[arg(long, default_value = "claude-projects", value_name = "DIR")]
    into: PathBuf,

    /// List what the export holds and write nothing
    #[arg(long)]
    list: bool,

    /// Import only projects whose name contains this (repeatable)
    #[arg(long, value_name = "NAME")]
    only: Vec<String>,

    /// Also import conversations that belong to no project
    #[arg(long)]
    unfiled: bool,

    /// Do not add the imported folders to the project list
    #[arg(long)]
    no_register: bool,
}

pub fn run(args: ImportArgs) -> Result<()> {
    let export = import::read_export(&args.export).map_err(|e| anyhow!(e))?;

    if args.list {
        return list(&export);
    }

    let mut opts = ImportOptions::new(&args.into);
    opts.unfiled = args.unfiled;
    opts.only = args.only.clone();

    let report = import::import(&export, &opts).map_err(|e| anyhow!(e))?;
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

    let mut registry = (!args.no_register).then(Registry::load);
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
        println!("  {DIM}{}{RESET}", project.root.display());
        println!("  {}", counts.join(", "));
        for warning in &project.warnings {
            println!("  {DIM}! {warning}{RESET}");
        }
        if let Some(registry) = registry.as_mut()
            && let Err(e) = registry.add(&project.root, Some(project.name.clone()))
        {
            println!("  {DIM}! not added to the project list: {e}{RESET}");
        }
    }

    println!();
    println!("{}", report.summary());
    if report.unfiled > 0 {
        println!(
            "{DIM}{} conversation(s) carry no project link and were left out; \
             --unfiled imports them into a folder of their own{RESET}",
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
