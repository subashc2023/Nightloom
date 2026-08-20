use anyhow::Result;
use nightloom_service::project;
use nightloom_service::store::{self, SessionSummary};
use std::path::PathBuf;

#[derive(clap::Args)]
pub struct SessionsArgs {
    /// Show only sessions whose conversation mentions this text
    #[arg(value_name = "QUERY")]
    query: Option<String>,

    /// Directory for session logs. Defaults to this folder's store under
    /// ~/.nightloom (NIGHTLOOM_HOME overrides where that is).
    #[arg(long)]
    log_dir: Option<PathBuf>,

    /// Delete a session log by ID (full UUID or unambiguous prefix)
    #[arg(long, value_name = "SESSION")]
    delete: Option<String>,
}

/// Where to look, with `--log-dir` winning over this folder's store.
///
/// Migrating first is what stops a folder whose chats are still in
/// `.nightloom/` from listing none of them: this subcommand is often the
/// first thing run in a folder after an upgrade, and "no sessions" would be
/// the wrong answer to give about a directory full of them.
fn log_dir(args: &SessionsArgs) -> PathBuf {
    args.log_dir.clone().unwrap_or_else(|| {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        if let Some(line) = project::migrate(&cwd).summary() {
            eprintln!("nightloom: {line}");
        }
        project::store_for(&cwd).join(project::SESSIONS_DIR)
    })
}

pub fn run(args: SessionsArgs) -> Result<()> {
    let log_dir = log_dir(&args);
    if let Some(prefix) = &args.delete {
        let id = store::delete(&log_dir, prefix)?;
        println!("deleted session {id}");
        return Ok(());
    }
    if let Some(query) = args.query.as_deref() {
        return search(&args, query);
    }

    let sessions = store::list(&log_dir)?;
    if sessions.is_empty() {
        println!("no sessions in {}", log_dir.display());
        return Ok(());
    }
    println!("{:<10} {:<17} {:>5}  name", "id", "modified", "turns");
    for s in &sessions {
        println!("{}  {}", head(s, s.user_turns), s.label(60));
    }
    Ok(())
}

fn search(args: &SessionsArgs, query: &str) -> Result<()> {
    let log_dir = log_dir(args);
    let found = store::search(&log_dir, query)?;
    if found.is_empty() {
        println!("no session in {} mentions {query:?}", log_dir.display());
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
