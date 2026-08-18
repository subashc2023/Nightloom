use anyhow::Result;
use nightloom_service::store;
use std::path::PathBuf;

#[derive(clap::Args)]
pub struct SessionsArgs {
    /// Directory for session logs
    #[arg(long, default_value = ".nightloom/sessions")]
    log_dir: PathBuf,
}

pub fn run(args: SessionsArgs) -> Result<()> {
    let sessions = store::list(&args.log_dir)?;
    if sessions.is_empty() {
        println!("no sessions in {}", args.log_dir.display());
        return Ok(());
    }

    println!(
        "{:<10} {:<17} {:>5}  first message",
        "id", "modified", "turns"
    );
    for s in &sessions {
        let short_id: String = s.id.chars().take(8).collect();
        let modified = s
            .modified
            .with_timezone(&chrono::Local)
            .format("%Y-%m-%d %H:%M");
        println!(
            "{:<10} {:<17} {:>5}  {}",
            short_id,
            modified,
            s.user_turns,
            s.first_user
                .as_deref()
                .map(|t| store::one_line(t, 60))
                .unwrap_or_default(),
        );
    }
    Ok(())
}
