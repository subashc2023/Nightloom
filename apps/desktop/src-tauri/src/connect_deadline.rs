//! A connect never hangs silently (nightshift item 220, agent H,
//! 2026-09-25).
//!
//! The installed app sat at "connecting…" for over forty minutes: the
//! window's `connect_agent` promise never settled, with no `claude` child,
//! no pipe and every runtime worker parked. Whatever it waited on, nothing
//! said so — the rail stayed locked and no log named the wait. So the
//! command runs under a deadline here: it records which step it is on
//! ([`Stage::set`] before each wait), and at [`CONNECT_TIMEOUT`] it gives
//! up with an error that names that step — shown on the rail — and appends
//! the same line to `<config dir>/logs/connect.log`, since the installed
//! app's stderr is `/dev/null`. Since item 222 every connect appends one
//! line there, on time or not: its total and the ms each step took.
//!
//! Dropping the connect at the deadline releases every lock it held (tokio
//! guards drop with the future). What it had already done stays done: the
//! prompt hold it saved, the pending view it set. The next connect writes
//! both again.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// How long a connect may take. A healthy one is well under a second plus
/// the `claude --version` probe (0.1 s measured); twenty seconds is long
/// enough for a cold disk and short enough that he is not left guessing.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// The step a connect is on, readable from outside the future, and when
/// each step began — the timing line (item 222) is built from these.
#[derive(Clone)]
pub struct Stage(Arc<Mutex<Vec<(&'static str, Instant)>>>);

impl Stage {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(vec![("starting", Instant::now())])))
    }

    /// Say what the next wait is for.
    pub fn set(&self, what: &'static str) {
        self.marks().push((what, Instant::now()));
    }

    pub fn get(&self) -> &'static str {
        self.marks().last().map(|m| m.0).unwrap_or("starting")
    }

    fn marks(&self) -> std::sync::MutexGuard<'_, Vec<(&'static str, Instant)>> {
        self.0.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Milliseconds spent on each step up to `end`, in the order each was
    /// first reached; a step reached twice is summed.
    pub fn durations(&self, end: Instant) -> Vec<(&'static str, u128)> {
        let marks = self.marks();
        let mut out: Vec<(&'static str, u128)> = Vec::new();
        for (i, (name, at)) in marks.iter().enumerate() {
            let until = marks.get(i + 1).map(|m| m.1).unwrap_or(end);
            let ms = until.saturating_duration_since(*at).as_millis();
            match out.iter_mut().find(|(n, _)| n == name) {
                Some(slot) => slot.1 += ms,
                None => out.push((name, ms)),
            }
        }
        out
    }
}

/// The one line every connect writes (item 222): its outcome, total ms and
/// ms per step, e.g. `ok total 412 ms; starting 0 ms, the open project … 3 ms`.
pub fn timing_line(stage: &Stage, started: Instant, end: Instant, outcome: &str) -> String {
    let stages = stage
        .durations(end)
        .iter()
        .map(|(name, ms)| format!("{name} {ms} ms"))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "{outcome} total {} ms; {stages}",
        end.saturating_duration_since(started).as_millis()
    )
}

/// Run `connect` under `limit`. On time, its result; past it, an error
/// naming the stage it was on, also written to the connect log.
pub async fn run<T>(
    stage: &Stage,
    limit: Duration,
    log: Option<&Path>,
    connect: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    let started = Instant::now();
    let (result, late) = match tokio::time::timeout(limit, connect).await {
        Ok(result) => (result, false),
        Err(_) => (Err(timed_out(stage.get(), limit)), true),
    };
    // One line per connect, whatever its outcome (item 222): the timeout's
    // message as before, and now the time each step took.
    let outcome = match &result {
        Ok(_) => "ok".to_string(),
        Err(e) if late => format!("{e} (elapsed {:.1} s)", started.elapsed().as_secs_f64()),
        Err(e) => format!("error: {e}"),
    };
    let line = format!(
        "{} connect_agent: {}",
        chrono::Utc::now().to_rfc3339(),
        timing_line(stage, started, Instant::now(), &outcome)
    );
    if result.is_err() {
        eprintln!("{line}");
    }
    if let Some(path) = log {
        append(path, &line);
    }
    result
}

/// What the rail shows when a connect ran out of time.
pub fn timed_out(stage: &str, limit: Duration) -> String {
    format!(
        "Connecting gave up after {} s, still waiting on {stage}. Nothing was changed; \
         try again, and if it happens again the wait is recorded in ~/.nightloom/logs/connect.log.",
        limit.as_secs()
    )
}

/// `<config dir>/logs/connect.log`, or `None` with no config dir.
pub fn log_path() -> Option<PathBuf> {
    nightloom_service::project::config_dir().map(|c| c.join("logs").join("connect.log"))
}

fn append(path: &Path, line: &str) {
    use std::io::Write;
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(f, "{line}");
    }
}

// ---------------------------------------------------------------------------
// The `--version` probe, kept (nightshift item 231, 2026-09-29).
//
// ~~A healthy probe takes 0.1 s~~ — measured 2026-09-29 (W3): the probe was
// the whole of the slow connects in connect.log (7.4 s, 15.0 s, 3.0 s), and
// the time is macOS's, not Nightloom's: the CLI is one 226 MB executable, and
// the first run of a fresh copy of it took 2.4–2.6 s with 0.00 s of user CPU
// while every run after took 0.01 s; the installed one went slow again
// (2.1 s, 4.3 s) after some minutes unused while builds ran. So a connect no
// longer waits for it when it need not: a probe that answered is remembered
// with the identity of the file that answered (its real path, size and
// modified time), and a connect to that same file takes the answer on hand
// and probes again behind itself — which also pays the OS's cost before the
// first turn spawns the CLI. A changed or missing file is probed on the spot,
// as before, so a broken binary still fails at connect. At launch the app
// probes the default binary once in the background ([`warm`]), so even the
// first connect after an update finds the OS's work under way.
// ---------------------------------------------------------------------------

/// What `agent_version` returns: the path it spawned and its `--version`.
pub type Probed = (String, Option<String>);

/// One remembered probe: the file that answered and what it said.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub struct ProbeRecord {
    /// The binary as the rail names it (`claude`, or a path).
    pub binary: String,
    /// The file it resolved to, symlinks followed.
    pub file: String,
    pub len: u64,
    pub modified_ns: u128,
    /// What the probe returned, as `agent_version` returns it.
    pub resolved: String,
    pub version: Option<String>,
}

/// `<config dir>/logs/claude-probe.json`, beside the connect log.
pub fn probe_cache_path() -> Option<PathBuf> {
    nightloom_service::project::config_dir().map(|c| c.join("logs").join("claude-probe.json"))
}

/// The file a resolved binary runs: a path as given, a bare name the first
/// match on `PATH` (as `resolve_binary` finds it), symlinks followed; with
/// its size and modified time. `None` when there is no such file.
fn identity(resolved: &str) -> Option<(String, u64, u128)> {
    let path = if resolved.chars().any(std::path::is_separator) {
        PathBuf::from(resolved)
    } else {
        let paths = std::env::var_os("PATH")?;
        std::env::split_paths(&paths)
            .filter(|d| !d.as_os_str().is_empty())
            .map(|d| d.join(resolved))
            .find(|p| p.is_file())?
    };
    let real = std::fs::canonicalize(&path).ok()?;
    let meta = std::fs::metadata(&real).ok()?;
    let modified = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some((real.to_string_lossy().into_owned(), meta.len(), modified))
}

/// The remembered answer for `binary`, when the file it resolves to now is
/// the one that gave it. Pure over the record and the file's identity.
fn recalled(record: Option<&ProbeRecord>, binary: &str, resolved: &str) -> Option<Probed> {
    let r = record?;
    let (file, len, modified_ns) = identity(resolved)?;
    (r.binary == binary && r.file == file && r.len == len && r.modified_ns == modified_ns)
        .then(|| (r.resolved.clone(), r.version.clone()))
}

fn read_record(cache: &Path) -> Option<ProbeRecord> {
    serde_json::from_str(&std::fs::read_to_string(cache).ok()?).ok()
}

/// Remember a probe that answered. Best-effort, written whole by rename.
fn remember(cache: &Path, binary: &str, probed: &Probed) {
    let Some((file, len, modified_ns)) = identity(&probed.0) else {
        return;
    };
    let record = ProbeRecord {
        binary: binary.to_string(),
        file,
        len,
        modified_ns,
        resolved: probed.0.clone(),
        version: probed.1.clone(),
    };
    if let Some(dir) = cache.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = cache.with_extension("json.tmp");
    if std::fs::write(&tmp, serde_json::to_string(&record).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, cache);
    }
}

/// The probe for a connect. `resolved` is `resolve_binary(binary)`; `run`
/// is the real probe (`agent_version`). The same file as the last probe
/// that answered: that answer at once, and `run` again in the background
/// to refresh it. Anything else: `run` now, under the stage it always had.
pub async fn probe<F, Fut>(
    stage: &Stage,
    cache: Option<&Path>,
    binary: &str,
    resolved: &str,
    run: F,
) -> Result<Probed, String>
where
    F: FnOnce(String) -> Fut,
    Fut: Future<Output = Result<Probed, String>> + Send + 'static,
{
    stage.set("the Claude Code binary's identity (the probe's cache)");
    let on_hand = cache.and_then(|c| recalled(read_record(c).as_ref(), binary, resolved));
    if let (Some(probed), Some(cache)) = (on_hand, cache) {
        let (cache, binary) = (cache.to_path_buf(), binary.to_string());
        let fresh = run(binary.clone());
        tokio::spawn(async move {
            if let Ok(p) = fresh.await {
                remember(&cache, &binary, &p);
            }
        });
        return Ok(probed);
    }
    stage.set("the Claude Code binary's `--version` probe");
    let probed = run(binary.to_string()).await?;
    if let Some(cache) = cache {
        remember(cache, binary, &probed);
    }
    Ok(probed)
}

/// At launch: probe `binary` once in the background and remember the
/// answer, so the OS's first-run cost is paid before the window connects.
pub async fn warm<Fut>(cache: Option<PathBuf>, binary: String, run: impl FnOnce(String) -> Fut)
where
    Fut: Future<Output = Result<Probed, String>>,
{
    let started = Instant::now();
    let outcome = run(binary.clone()).await;
    if let (Ok(p), Some(c)) = (&outcome, &cache) {
        remember(c, &binary, p);
    }
    if let Some(log) = log_path() {
        let line = format!(
            "{} warm_probe: {} total {} ms",
            chrono::Utc::now().to_rfc3339(),
            if outcome.is_ok() { "ok" } else { "error" },
            started.elapsed().as_millis()
        );
        append(&log, &line);
    }
}

/// At launch (nightshift item 256): run the binary Nightloom hands the CLI
/// as its MCP server and hooks — this app's own executable — once, the
/// way the CLI will, so a first-run cost the OS charges a new executable
/// (11.2 s measured for a fresh build's `--subagent-hook`, 2026-09-30;
/// 13–15 ms after) is not paid inside his first message's tool call or
/// MCP start. `--subagent-hook` with no directory exits at once with a
/// usage error, touching nothing. The time goes on connect.log beside
/// `warm_probe`'s, so the installed app says whether its own launch had
/// already paid it.
pub async fn warm_hook(exe: PathBuf, log: Option<PathBuf>) {
    let started = Instant::now();
    let status = tokio::process::Command::new(&exe)
        .arg("--subagent-hook")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .status()
        .await;
    if let Some(log) = log {
        let line = format!(
            "{} warm_hook: {} total {} ms",
            chrono::Utc::now().to_rfc3339(),
            if status.is_ok() { "ran" } else { "error" },
            started.elapsed().as_millis()
        );
        append(&log, &line);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chats::Chats;
    use nightloom_core::{ChatKind, ChatMode};

    /// Short, so the tests run in real time without a paused clock.
    const SHORT: Duration = Duration::from_millis(100);

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nightloom-connect-deadline-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn a_connect_that_never_finishes_fails_at_the_deadline_naming_its_wait() {
        let log = scratch("never").join("logs").join("connect.log");
        let stage = Stage::new();
        let s = stage.clone();
        let err = run(&stage, SHORT, Some(&log), async move {
            s.set("the open chat's lock");
            std::future::pending::<Result<(), String>>().await
        })
        .await
        .unwrap_err();
        assert!(err.contains("the open chat's lock"), "{err}");
        let written = std::fs::read_to_string(&log).unwrap();
        assert!(written.contains("the open chat's lock"), "{written}");
        assert!(timed_out("x", CONNECT_TIMEOUT).contains("after 20 s"));
    }

    #[tokio::test]
    async fn a_connect_on_time_passes_its_result_through_and_logs_one_timing_line() {
        // ~~logs nothing~~ — since item 222 (2026-09-25) every connect
        // writes one line: its outcome, total ms and ms per step.
        let log = scratch("ontime").join("connect.log");
        let stage = Stage::new();
        let s = stage.clone();
        let ok = run(&stage, SHORT, Some(&log), async move {
            s.set("the open project (the workspaces lock)");
            tokio::time::sleep(Duration::from_millis(5)).await;
            Ok::<_, String>(7)
        })
        .await;
        assert_eq!(ok, Ok(7));
        let err = run(&Stage::new(), SHORT, Some(&log), async {
            Err::<(), _>("not found".to_string())
        })
        .await;
        assert_eq!(err, Err("not found".to_string()));
        let written = std::fs::read_to_string(&log).unwrap();
        let lines: Vec<&str> = written.lines().collect();
        assert_eq!(lines.len(), 2, "{written}");
        assert!(
            lines[0].contains("connect_agent: ok total "),
            "{}",
            lines[0]
        );
        assert!(lines[0].contains("; starting "), "{}", lines[0]);
        assert!(
            lines[0].contains("the open project (the workspaces lock) "),
            "{}",
            lines[0]
        );
        assert!(
            lines[1].contains("connect_agent: error: not found total "),
            "{}",
            lines[1]
        );
    }

    #[test]
    fn a_step_reached_twice_is_summed_and_kept_in_first_order() {
        let stage = Stage::new();
        let t0 = Instant::now();
        {
            let mut m = stage.marks();
            m.clear();
            m.push(("a", t0));
            m.push(("b", t0 + Duration::from_millis(10)));
            m.push(("a", t0 + Duration::from_millis(30)));
        }
        let d = stage.durations(t0 + Duration::from_millis(35));
        assert_eq!(d, vec![("a", 15), ("b", 20)]);
        assert_eq!(
            timing_line(&stage, t0, t0 + Duration::from_millis(35), "ok"),
            "ok total 35 ms; a 15 ms, b 20 ms"
        );
    }

    /// The shape of the item-136 family: a turn holds the open chat's log,
    /// and a connect needs it. Before this module the connect waited as long
    /// as the holder did — forever, if the holder never finished; now it
    /// comes back at the deadline, and the holder's lock is untouched.
    #[tokio::test]
    async fn a_connect_behind_a_held_chat_lock_comes_back_and_leaves_the_holder_alone() {
        let dir = scratch("held");
        let chats = Chats::default();
        let (held, _) = chats
            .lock_or_start(ChatMode::Normal, ChatKind::Build, &dir)
            .await
            .unwrap();
        let stage = Stage::new();
        let s = stage.clone();
        let err = run(&stage, SHORT, None, async {
            s.set("the open chat's lock");
            let open = chats.lock_focused().await;
            Ok::<_, String>(open.as_ref().is_some())
        })
        .await
        .unwrap_err();
        assert!(err.contains("the open chat's lock"), "{err}");
        drop(held);
        // Released by its holder, the chat is lockable at once.
        assert!(chats.try_lock_focused().is_ok());
    }

    /// Item 231: the first probe of a file is waited for and remembered;
    /// a connect to the same file takes the answer at once — even when the
    /// probe would take seconds — and refreshes it behind itself; a changed
    /// file is probed on the spot again, and a failing probe still fails.
    #[tokio::test]
    async fn a_probe_that_answered_is_not_waited_for_again_until_the_file_changes() {
        let dir = scratch("probe");
        let bin = dir.join("claude");
        std::fs::write(&bin, "v1").unwrap();
        let bin_s = bin.to_string_lossy().into_owned();
        let cache = dir.join("logs").join("claude-probe.json");
        let calls = Arc::new(Mutex::new(0u32));
        let slow = |calls: Arc<Mutex<u32>>, ms: u64, answer: &'static str| {
            move |b: String| async move {
                tokio::time::sleep(Duration::from_millis(ms)).await;
                *calls.lock().unwrap() += 1;
                Ok::<Probed, String>((b, Some(answer.to_string())))
            }
        };
        // First connect: nothing on hand, the probe is waited for.
        let stage = Stage::new();
        let got = probe(
            &stage,
            Some(&cache),
            &bin_s,
            &bin_s,
            slow(calls.clone(), 1, "1.0"),
        )
        .await
        .unwrap();
        assert_eq!(got, (bin_s.clone(), Some("1.0".into())));
        assert_eq!(stage.get(), "the Claude Code binary's `--version` probe");
        assert_eq!(*calls.lock().unwrap(), 1);
        // Same file: answered from the record without waiting on a probe
        // that takes 3 s; that probe runs behind and refreshes the record.
        let stage = Stage::new();
        let t = Instant::now();
        let got = probe(
            &stage,
            Some(&cache),
            &bin_s,
            &bin_s,
            slow(calls.clone(), 3000, "1.1"),
        )
        .await
        .unwrap();
        assert!(
            t.elapsed() < Duration::from_millis(1500),
            "{:?}",
            t.elapsed()
        );
        assert_eq!(got, (bin_s.clone(), Some("1.0".into())));
        assert_ne!(stage.get(), "the Claude Code binary's `--version` probe");
        let until = Instant::now() + Duration::from_secs(20);
        while *calls.lock().unwrap() < 2 && Instant::now() < until {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let refreshed = until_record(&cache, "1.1").await;
        assert_eq!(refreshed.version.as_deref(), Some("1.1"));
        // A changed file (an update): probed on the spot again.
        std::fs::write(&bin, "v2, longer").unwrap();
        let stage = Stage::new();
        let got = probe(
            &stage,
            Some(&cache),
            &bin_s,
            &bin_s,
            slow(calls.clone(), 1, "2.0"),
        )
        .await
        .unwrap();
        assert_eq!(got.1.as_deref(), Some("2.0"));
        assert_eq!(stage.get(), "the Claude Code binary's `--version` probe");
        // Another binary name on the rail never takes this one's answer.
        assert!(recalled(read_record(&cache).as_ref(), "other", &bin_s).is_none());
        // A missing file: probed, and its failure is the connect's.
        std::fs::remove_file(&bin).unwrap();
        let err = probe(
            &Stage::new(),
            Some(&cache),
            &bin_s,
            &bin_s,
            |_b: String| async { Err::<Probed, _>("could not start it".to_string()) },
        )
        .await
        .unwrap_err();
        assert_eq!(err, "could not start it");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Wait (bounded) for the record to say `version`.
    async fn until_record(cache: &Path, version: &str) -> ProbeRecord {
        let until = Instant::now() + Duration::from_secs(20);
        loop {
            let r = read_record(cache).unwrap();
            if r.version.as_deref() == Some(version) || Instant::now() >= until {
                return r;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// Item 256: the hook warm-up runs the binary once and says how long
    /// it took on the log, whatever the binary answered.
    #[tokio::test]
    async fn the_hook_warm_up_runs_the_binary_once_and_logs_its_time() {
        let dir = scratch("warm-hook");
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("connect.log");
        warm_hook(PathBuf::from("/usr/bin/false"), Some(log.clone())).await;
        warm_hook(dir.join("no-such-binary"), Some(log.clone())).await;
        let text = std::fs::read_to_string(&log).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2, "{text}");
        assert!(lines[0].contains("warm_hook: ran total "), "{text}");
        assert!(lines[1].contains("warm_hook: error total "), "{text}");
    }
}
