use anyhow::Result;
use nightloom_service::store::{self, SessionSummary};
use std::path::PathBuf;

#[derive(clap::Args)]
pub struct SessionsArgs {
    /// Show only sessions whose conversation mentions this text
    #[arg(value_name = "QUERY")]
    query: Option<String>,

    /// Directory for session logs
    #[arg(long, default_value = ".nightloom/sessions")]
    log_dir: PathBuf,

    /// Delete a session log by ID (full UUID or unambiguous prefix)
    #[arg(long, value_name = "SESSION")]
    delete: Option<String>,
}

pub fn run(args: SessionsArgs) -> Result<()> {
    if let Some(prefix) = &args.delete {
        let id = store::delete(&args.log_dir, prefix)?;
        println!("deleted session {id}");
        return Ok(());
    }
    if let Some(query) = args.query.as_deref() {
        return search(&args, query);
    }

    let sessions = store::list(&args.log_dir)?;
    if sessions.is_empty() {
        println!("no sessions in {}", args.log_dir.display());
        return Ok(());
    }
    println!("{:<10} {:<17} {:>5}  name", "id", "modified", "turns");
    for s in &sessions {
        println!("{}  {}", head(s, s.user_turns), s.label(60));
    }
    Ok(())
}

fn search(args: &SessionsArgs, query: &str) -> Result<()> {
    let found = store::search(&args.log_dir, query)?;
    if found.is_empty() {
        println!(
            "no session in {} mentions {query:?}",
            args.log_dir.display()
        );
        return Ok(());
    }
    // Hits rather than turns in this column: which of two matches is the
    // conversation that was *about* the thing is the question a search
    // result has to help with, and the turn count does not answer it.
    println!("{:<10} {:<17} {:>5}  name", "id", "modified", "hits");
    for m in &found {
        println!("{}  {}", head(&m.summary, m.hits), m.summary.label(60));
        // Under the row, indented to it: an excerpt that does not show why
        // the session matched leaves the reader to open it and find out.
        println!("{:<36}{}", "", m.excerpt);
    }
    Ok(())
}

/// The columns every listing shares: short id, local time, and one count.
fn head(s: &SessionSummary, count: usize) -> String {
    let short_id: String = s.id.chars().take(8).collect();
    let modified = s
        .modified
        .with_timezone(&chrono::Local)
        .format("%Y-%m-%d %H:%M");
    format!("{short_id:<10} {modified:<17} {count:>5}")
}
