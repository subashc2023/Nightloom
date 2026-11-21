//! The Mac's background jobs runner (nightshift item 781): this binary as
//! `nightloom-desktop --jobs-runner`, started by a launchd agent every
//! minute, runs the jobs that are due while the app is quit
//! (`nightloom_service::jobs::runner`). Here: the runner's start, the
//! agent's install at the app's launch, and the app's wait for a runner
//! that is mid-run when he opens it.
//!
//! The install asks nothing of him: a plist in `~/Library/LaunchAgents`
//! and `launchctl bootstrap` into his own session. macOS may show its
//! "Background Items Added" notice once (a notice, not a question).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use nightloom_service::jobs::runner;
use nightloom_service::project::{self, Registry};
use nightloom_service::serve::{ServeConfig, ServeHost};

/// `nightloom-desktop --jobs-runner`: one start of the runner. Nothing on
/// stdout unless a job ran (launchd keeps it in `logs/jobs-runner.log`).
pub fn run_from_launchd() {
    let Some(config) = project::config_dir() else {
        return;
    };
    let Ok(rt) = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
    else {
        return;
    };
    let exe = std::env::current_exe().ok();
    let home = config.clone();
    let ran = rt.block_on(runner::run(
        &config,
        move || {
            let mut cfg = ServeConfig::for_home(&home);
            cfg.binary = nightloom_service::resolve_binary("claude");
            cfg.hook_exe = exe;
            ServeHost::new_mac_runner(cfg, Registry::load())
                as Arc<dyn nightloom_service::remote::Host>
        },
        chrono::Utc::now,
        std::time::Duration::from_secs(5),
    ));
    if let runner::Ran::Ticked(n) = ran {
        println!(
            "{} jobs runner: {n} tick(s), then let the home go",
            chrono::Local::now().format("%Y-%m-%d %-I:%M:%S %p")
        );
    }
}

/// The PATH the runner's turns see: where `claude` is installed, then the
/// system's.
fn runner_path(user_home: &Path) -> String {
    // The shared list (item 897), joined in its order: the plist text is
    // unchanged, so an installed runner is not rewritten.
    nightloom_service::fallback_path_dirs(Some(user_home))
        .iter()
        .map(|d| d.display().to_string())
        .collect::<Vec<_>>()
        .join(":")
}

/// At the app's launch, off the main thread: put the agent in place (or
/// refresh it when the app moved), never from a dev build or another home.
pub fn install_in_background() {
    std::thread::spawn(|| {
        if let Err(e) = install() {
            eprintln!("jobs runner: not installed: {e}");
        }
    });
}

fn install() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    if !runner::installs_from(&exe, std::env::var_os("NIGHTLOOM_HOME").is_some()) {
        return Ok(());
    }
    let config = project::config_dir().ok_or("no Nightloom home")?;
    let user_home = PathBuf::from(std::env::var_os("HOME").ok_or("no HOME")?);
    let text = runner::plist(&exe, &config, &runner_path(&user_home));
    let path = runner::plist_path(&user_home);
    let same = std::fs::read_to_string(&path).is_ok_and(|t| t == text);
    let uid = String::from_utf8_lossy(
        &std::process::Command::new("/usr/bin/id")
            .arg("-u")
            .output()
            .map_err(|e| e.to_string())?
            .stdout,
    )
    .trim()
    .to_string();
    let domain = format!("gui/{uid}");
    let target = format!("{domain}/{}", runner::LABEL);
    let loaded = std::process::Command::new("/bin/launchctl")
        .args(["print", &target])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    if same && loaded {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::create_dir_all(config.join("logs"));
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    if loaded {
        let _ = std::process::Command::new("/bin/launchctl")
            .args(["bootout", &target])
            .status();
    }
    // Straight after a bootout launchd can refuse the bootstrap for a
    // moment (item 803): tried again, a little later each time.
    let ok = runner::bootstrap_retrying(
        || {
            std::process::Command::new("/bin/launchctl")
                .args(["bootstrap", &domain, &path.to_string_lossy()])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        },
        |n| std::thread::sleep(std::time::Duration::from_millis(500 * u64::from(n))),
    );
    if ok {
        Ok(())
    } else {
        Err("launchctl bootstrap failed".into())
    }
}

/// The longest the app waits for a runner mid-run before it gives up and
/// says why it cannot open.
const WAIT_FOR_RUNNER: std::time::Duration = std::time::Duration::from_secs(30 * 60);

/// He opened the app while the runner holds the home: ask it to finish up,
/// say so in a note that closes itself, and take the lock once it lets go.
/// `None` when the holder is not the runner, or it did not let go in time.
pub fn wait_for_runner(config: &Path, who: &str) -> Option<nightloom_service::serve::HomeLock> {
    if !runner::runner_holds(config) {
        return None;
    }
    runner::ask_to_yield(config);
    #[cfg(target_os = "macos")]
    {
        // Not waited on, and gone by itself after 20 s.
        let _ = std::process::Command::new("osascript")
            .args([
                "-e",
                "display alert \"Nightloom is finishing a job\" message \"A job that started while Nightloom was closed is still running. Nightloom opens by itself when it ends.\" giving up after 20",
            ])
            .spawn();
    }
    let start = std::time::Instant::now();
    while start.elapsed() < WAIT_FOR_RUNNER {
        std::thread::sleep(std::time::Duration::from_secs(1));
        if let Ok(lock) = nightloom_service::serve::HomeLock::take(config, who) {
            runner::clear_yield(config);
            return Some(lock);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_runners_path_finds_claude_where_it_is_installed() {
        let p = runner_path(Path::new("/Users/x"));
        assert!(p.starts_with("/Users/x/.local/bin:"));
        assert!(p.contains("/opt/homebrew/bin"));
        assert!(p.ends_with("/usr/sbin:/sbin"));
    }
}
