//! Finding the CLI binary, its `PATH`, and stopping its process tree (moved from `agent/mod.rs`, item 981).

use super::*;

/// Where to look for the CLI when a bare name does not resolve on `PATH`.
///
/// Unix only, and that is the bug rather than a platform Nightloom cares
/// less about. A GUI process on macOS is started by launchd, which hands it
/// a minimal `PATH` — `/usr/bin:/bin:/usr/sbin:/sbin` — and never sources a
/// login shell, so `.zshrc` might as well not exist. Claude Code's own
/// installer puts the binary in `~/.local/bin`, which is in none of that, so
/// the desktop app failed to find a working `claude` for **every** macOS
/// user who installed it the documented way, while the same default worked
/// perfectly from a terminal. Linux launched from a `.desktop` entry is the
/// same story. Windows is not: a GUI process there inherits the machine and
/// user `PATH` out of the registry, so the case this exists for cannot
/// arise, and probing Unix directories on it would be theatre.
///
/// Resolving through a **login shell** is the general answer and is
/// deliberately not what this does. `$SHELL -lic 'command -v claude'` covers
/// version managers this list cannot, and it also runs the user's entire
/// startup configuration on the connect path, where it can be slow and can
/// hang outright on a broken rc file. That trades a reliable connect for
/// coverage of a case that already has a working answer — [`AgentSpec::binary`]
/// takes an absolute path, and both shells expose it.
#[cfg(unix)]
fn candidate_dirs() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut dirs = Vec::new();
    if let Some(h) = &home {
        // The native installer's location, and so the one that matters.
        dirs.push(h.join(".local/bin"));
    }
    // Apple silicon homebrew, then Intel homebrew and the usual npm prefix.
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    dirs.push(PathBuf::from("/usr/local/bin"));
    if let Some(h) = &home {
        dirs.push(h.join(".bun/bin"));
        dirs.push(h.join(".volta/bin"));
        dirs.push(h.join(".npm-global/bin"));
    }
    dirs
}

#[cfg(not(unix))]
fn candidate_dirs() -> Vec<PathBuf> {
    Vec::new()
}

/// Everywhere a bare binary name is looked for, for an error message.
///
/// A "not found" that does not say where it looked leaves the user with
/// nothing to check, which is most of why the original report had to be
/// diagnosed by hand.
pub fn searched_locations() -> Vec<String> {
    let mut out = vec!["PATH".to_string()];
    out.extend(candidate_dirs().iter().map(|d| d.display().to_string()));
    out
}

/// The path to actually spawn for a configured binary name.
///
/// `PATH` wins whenever it resolves, and that ordering is load-bearing
/// rather than tidiness: a user running the CLI through a version manager
/// has a `PATH` entry that is *correct* and may well also have a stale
/// `~/.local/bin/claude` from an install they replaced. Preferring the
/// candidate list would silently run the wrong one — a worse failure than
/// the one being fixed, because it succeeds.
///
/// A name carrying a separator is returned untouched: the user pointed
/// somewhere on purpose, and second-guessing that is not this function's
/// job. So is a name nothing resolves, so the error names what was asked
/// for rather than something invented here.
pub fn resolve_binary(binary: &str) -> String {
    if binary.chars().any(std::path::is_separator) {
        return binary.to_string();
    }
    if which_on_path(binary).is_some() {
        return binary.to_string();
    }
    for dir in candidate_dirs() {
        let candidate = dir.join(binary);
        if candidate.is_file() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    binary.to_string()
}

/// Whether a bare name resolves on `PATH`.
///
/// Hand-rolled for the same reason `project.rs` hand-rolls FNV-1a and
/// `prompt.rs` reads `.git/HEAD` rather than spawning git: it is a dozen
/// lines against a transitive dependency tree. Unix only, because the
/// fallback it guards is — on Windows nothing here is consulted and
/// `Command` does its own resolution, `PATHEXT` and all, exactly as before.
#[cfg(unix)]
fn which_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .filter(|d| !d.as_os_str().is_empty())
        .map(|d| d.join(name))
        .find(|p| p.is_file())
}

#[cfg(not(unix))]
fn which_on_path(_name: &str) -> Option<PathBuf> {
    // Never reached: `candidate_dirs` is empty off Unix, so `resolve_binary`
    // returns the name unchanged whatever this says.
    None
}

/// Where a Mac keeps the tools a chat runs (item 897): the CLI's own
/// installs, Homebrew (Apple silicon, then Intel), then the system's. The
/// jobs runner's launchd PATH is this list joined (`jobs_runner.rs`).
pub fn fallback_path_dirs(home: Option<&std::path::Path>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(h) = home {
        dirs.push(h.join(".local/bin"));
        dirs.push(h.join(".claude/local"));
    }
    for d in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        dirs.push(PathBuf::from(d));
    }
    dirs
}

/// `inherited` with every fallback dir that `exists` and is missing
/// appended (item 897). An app opened from the Dock inherits launchd's
/// `/usr/bin:/bin:/usr/sbin:/sbin`, so a chat's `pdftotext` (and the CLI's
/// own `pdftoppm` for a PDF Read) was "not found" though Homebrew has it.
/// Inherited entries keep their order and priority; nothing is repeated.
pub fn widened_path(
    inherited: Option<&std::ffi::OsStr>,
    home: Option<&std::path::Path>,
    exists: impl Fn(&std::path::Path) -> bool,
) -> std::ffi::OsString {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(p) = inherited {
        for d in std::env::split_paths(p) {
            if !d.as_os_str().is_empty() && !dirs.contains(&d) {
                dirs.push(d);
            }
        }
    }
    for d in fallback_path_dirs(home) {
        if !dirs.contains(&d) && exists(&d) {
            dirs.push(d);
        }
    }
    std::env::join_paths(dirs).unwrap_or_else(|_| inherited.map(Into::into).unwrap_or_default())
}

/// The PATH every process Nightloom spawns for a chat gets: this process's
/// own, widened ([`widened_path`]). The desktop app also sets it on itself
/// at start, so children spawned anywhere else inherit it.
pub fn child_path() -> std::ffi::OsString {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    widened_path(std::env::var_os("PATH").as_deref(), home.as_deref(), |d| {
        d.is_dir()
    })
}

/// Ask the CLI to stop the way Ctrl-C does, and say whether it was asked.
///
/// `kill -INT <pid>` rather than `libc::kill`: the crate has no `libc`
/// dependency, and `/bin/kill` is on every Unix this runs on — the same
/// trade `kill_tree` makes with `taskkill`. `false` on Windows, where a
/// detached child has no console to receive a Ctrl-C event and the item
/// asks for no change to that platform's semantics: the caller goes
/// straight to the kill.
pub(super) async fn interrupt(child: &tokio::process::Child) -> bool {
    #[cfg(unix)]
    {
        let Some(pid) = child.id() else {
            return false;
        };
        Command::new("kill")
            .args(["-INT", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await
            .is_ok_and(|s| s.success())
    }
    #[cfg(not(unix))]
    {
        let _ = child;
        false
    }
}

/// A stopped turn's process, let go of (item 466): it gets [`EXIT_GRACE`]
/// to exit, then the kill; its stderr reader is dropped once it has, since a
/// stop shows no stderr and a grandchild may hold the pipe for ever.
pub(super) fn wind_down(mut child: tokio::process::Child, stderr: tokio::task::JoinHandle<String>) {
    tokio::spawn(async move {
        if tokio::time::timeout(EXIT_GRACE, child.wait())
            .await
            .is_err()
        {
            kill_tree(&mut child).await;
            let _ = child.wait().await;
        }
        stderr.abort();
    });
}

/// Kill the child and anything it started.
///
/// A copy of `tools::shell::kill_tree`'s Windows half, and kept here rather
/// than shared because the two will drift: that one is killing a shell,
/// this one a supervisor that may be holding a `bash` of its own.
pub(super) async fn kill_tree(child: &mut tokio::process::Child) {
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
    let _ = child.kill().await;
}

/// A turn of a stand-in CLI in `dir` that answers and ends on the EOF after
/// its `result` — the shape of an ordinary turn, for tests outside this
/// module (item 430: a preview outlives one).
#[cfg(all(test, unix))]
pub(crate) async fn run_stand_in_turn(dir: &std::path::Path) {
    let path = dir.join("claude-stand-in-turn");
    std::fs::write(
        &path,
        r#"#!/bin/sh
printf '%s\n' '{"type":"system","subtype":"init","cwd":"x","tools":[],"mcp_servers":[],"model":"claude-haiku-4-5","permissionMode":"default","session_id":"t-430"}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"num_turns":1,"result":"ok","session_id":"t-430","stop_reason":"end_turn","usage":{"input_tokens":1,"output_tokens":1}}'
cat >/dev/null
"#,
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut s = AgentSpec::new(dir);
    s.binary = path.to_string_lossy().into_owned();
    let agent = ClaudeCodeAgent::new(s);
    let cancel = CancellationToken::new();
    let mut on_event = |_e: TurnEvent| {};
    tokio::time::timeout(
        Duration::from_secs(10),
        agent.run_turn("hi", &cancel, &mut on_event),
    )
    .await
    .expect("the stand-in turn ended")
    .expect("the stand-in turn ran");
}
