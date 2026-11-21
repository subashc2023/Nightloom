//! Bakes the git commit into the binary as `NIGHTLOOM_GIT_SHA` (nightshift
//! item 805: feedback names the build that took it). No git, no value:
//! `feedback::BUILD` is then `None` and the item falls back to the
//! Nightshift repo's `state/installed.txt`.
use std::process::Command;

fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

fn main() {
    if let Some(sha) = git(&["rev-parse", "HEAD"]) {
        println!("cargo:rustc-env=NIGHTLOOM_GIT_SHA={sha}");
    }
    // A new commit moves the worktree's HEAD log; rerun then, not on every build.
    for p in ["HEAD", "logs/HEAD"] {
        if let Some(path) = git(&["rev-parse", "--git-path", p]) {
            println!("cargo:rerun-if-changed={path}");
        }
    }
}
