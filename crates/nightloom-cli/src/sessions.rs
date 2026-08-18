use anyhow::{Context, Result, bail};
use nightloom_core::SessionEvent;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(clap::Args)]
pub struct SessionsArgs {
    /// Directory for session logs
    #[arg(long, default_value = ".nightloom/sessions")]
    log_dir: PathBuf,
}

struct SessionSummary {
    id: String,
    modified: SystemTime,
    user_turns: usize,
    first_user: Option<String>,
}

fn log_files(log_dir: &Path) -> Result<Vec<PathBuf>> {
    let entries = fs::read_dir(log_dir)
        .with_context(|| format!("cannot read log dir {}", log_dir.display()))?;
    let mut paths = Vec::new();
    for entry in entries {
        let path = entry?.path();
        if path.extension().is_some_and(|e| e == "jsonl") {
            paths.push(path);
        }
    }
    Ok(paths)
}

/// Light-weight scan of one log: enough for a listing without reopening the
/// file for append the way `Session::load` does.
fn summarize(path: &Path) -> Result<SessionSummary> {
    let modified = fs::metadata(path)?.modified()?;
    let content = fs::read_to_string(path)?;
    let mut id = None;
    let mut user_turns = 0;
    let mut first_user = None;
    for line in content.lines().filter(|l| !l.trim().is_empty()) {
        // Unknown or malformed lines shouldn't sink the whole listing; future
        // SessionEvent variants will show up here before this crate learns them.
        let Ok(event) = serde_json::from_str::<SessionEvent>(line) else {
            continue;
        };
        match event {
            SessionEvent::SessionCreated { id: found, .. } => id = Some(found),
            SessionEvent::UserMessage { text, .. } => {
                if first_user.is_none() {
                    first_user = Some(text);
                }
                user_turns += 1;
            }
            _ => {}
        }
    }
    let id = id
        .or_else(|| path.file_stem().map(|s| s.to_string_lossy().into_owned()))
        .unwrap_or_default();
    Ok(SessionSummary {
        id,
        modified,
        user_turns,
        first_user,
    })
}

/// Resolve a session ID or unique ID prefix to its log file.
pub fn find_by_prefix(log_dir: &Path, prefix: &str) -> Result<PathBuf> {
    let mut matches: Vec<PathBuf> = log_files(log_dir)?
        .into_iter()
        .filter(|p| {
            p.file_stem()
                .and_then(|s| s.to_str())
                .is_some_and(|s| s.starts_with(prefix))
        })
        .collect();
    match matches.len() {
        0 => bail!(
            "no session matching {prefix:?} in {} (try `nightloom sessions`)",
            log_dir.display()
        ),
        1 => Ok(matches.remove(0)),
        _ => {
            matches.sort();
            let ids: Vec<String> = matches
                .iter()
                .filter_map(|p| p.file_stem().map(|s| s.to_string_lossy().into_owned()))
                .collect();
            bail!("session prefix {prefix:?} is ambiguous: {}", ids.join(", "))
        }
    }
}

/// The most recently modified session log in the dir.
pub fn latest(log_dir: &Path) -> Result<PathBuf> {
    let mut best: Option<(SystemTime, PathBuf)> = None;
    for path in log_files(log_dir)? {
        let modified = fs::metadata(&path)?.modified()?;
        if best.as_ref().is_none_or(|(t, _)| modified > *t) {
            best = Some((modified, path));
        }
    }
    let Some((_, path)) = best else {
        bail!("no session logs in {}", log_dir.display());
    };
    Ok(path)
}

/// Collapse text to a single line, truncated to at most `max` chars.
pub fn one_line(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        flat
    } else {
        let cut: String = flat.chars().take(max).collect();
        format!("{cut}…")
    }
}

pub fn run(args: SessionsArgs) -> Result<()> {
    if !args.log_dir.is_dir() {
        println!("no sessions in {}", args.log_dir.display());
        return Ok(());
    }
    let mut sessions = Vec::new();
    for path in log_files(&args.log_dir)? {
        sessions.push(
            summarize(&path)
                .with_context(|| format!("failed to read session log {}", path.display()))?,
        );
    }
    if sessions.is_empty() {
        println!("no sessions in {}", args.log_dir.display());
        return Ok(());
    }
    sessions.sort_by(|a, b| b.modified.cmp(&a.modified));

    println!(
        "{:<10} {:<17} {:>5}  first message",
        "id", "modified", "turns"
    );
    for s in &sessions {
        let short_id: String = s.id.chars().take(8).collect();
        let modified = chrono::DateTime::<chrono::Local>::from(s.modified).format("%Y-%m-%d %H:%M");
        println!(
            "{:<10} {:<17} {:>5}  {}",
            short_id,
            modified,
            s.user_turns,
            s.first_user
                .as_deref()
                .map(|t| one_line(t, 60))
                .unwrap_or_default(),
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir_with(names: &[&str]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nightloom-cli-test-{}", uuid_ish()));
        fs::create_dir_all(&dir).unwrap();
        for name in names {
            fs::write(dir.join(format!("{name}.jsonl")), "").unwrap();
        }
        dir
    }

    // The CLI crate doesn't depend on uuid; a nanosecond timestamp is unique
    // enough for a test dir name.
    fn uuid_ish() -> u128 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    }

    #[test]
    fn prefix_matching() {
        let dir = dir_with(&["aabbccdd-1111", "aabbeeff-2222", "99887766-3333"]);

        let found = find_by_prefix(&dir, "9988").unwrap();
        assert_eq!(found.file_stem().unwrap(), "99887766-3333");

        let full = find_by_prefix(&dir, "aabbccdd-1111").unwrap();
        assert_eq!(full.file_stem().unwrap(), "aabbccdd-1111");

        let ambiguous = find_by_prefix(&dir, "aabb").unwrap_err();
        assert!(ambiguous.to_string().contains("ambiguous"), "{ambiguous}");

        let missing = find_by_prefix(&dir, "zzzz").unwrap_err();
        assert!(
            missing.to_string().contains("no session matching"),
            "{missing}"
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn one_line_truncates_and_flattens() {
        assert_eq!(one_line("a\nb\tc", 60), "a b c");
        assert_eq!(one_line("abcdef", 3), "abc…");
    }
}
