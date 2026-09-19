//! The plan's own figures — how much of the subscription's five-hour and
//! seven-day windows is used — read from files Nightloom does not own
//! (nightshift backlog 073, 2026-09-16).
//!
//! ~~Nothing on the wire says this.~~ On CLI 2.1.263 the `rate_limit_event`
//! an OAuth run of `claude -p` emits *does* carry both windows' share used
//! (`unifiedWindows`; measured the same night, `docs/service-agent.md`), and
//! the desktop prefers that figure when a turn brings one. This module is
//! the reading for the moments the wire has nothing: before a chat's first
//! turn, and on a build that sends only the window's name, status and reset
//! time (the 2.1.237 line `translate.rs` was written against). The
//! percentages are server-computed and account-wide — they count the Claude
//! app and interactive Claude Code, not just this chat — and two local files
//! carry them, each written by something else:
//!
//! ```text
//! ~/Library/Application Support/Claude/plan-usage-history.json
//!     the Claude desktop app's own sample, ~every 15 min while it runs:
//!     {"samples": [{"t": <unix ms>, "u": {"fh": <5h %>, "sd": <7d %>}}, …]}
//! ~/.claude.json  →  cachedUsageUtilization
//!     the CLI's cache, refreshed only when the user runs /usage by hand:
//!     {"fetchedAtMs": …, "utilization": {"five_hour": {"utilization", "resets_at"},
//!                                        "seven_day": {…}, "limits": […]}}
//! ```
//!
//! **Neither is dependably fresher, so both are read and the more recent
//! sample wins.** This is `bin/usagectl.py`'s rule in the nightshift repo
//! (its `read()`), reproduced rather than re-derived: that script observed
//! (2026-09-07) the desktop file 46–61 minutes stale across a session while
//! the CLI cache, refreshed by an interactive `/usage`, was current — and the
//! reverse the rest of the time. A reading older than [`STALE_AFTER`] is
//! flagged `stale`, and the chip says so rather than showing an old number
//! as a current one: a frozen file and an idle account look identical.
//!
//! Percentages only. The denominator is never estimated here; the number
//! Anthropic reports is the number shown.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Past this age a sample says nothing about the present. `usagectl.py`'s
/// `STALE_AFTER_SECONDS`, the desktop app's cadence plus a margin.
pub const STALE_AFTER: std::time::Duration = std::time::Duration::from_secs(20 * 60);

/// The Claude desktop app's sample file, under the user's home.
pub const DESKTOP_SAMPLE: &str = "Library/Application Support/Claude/plan-usage-history.json";
/// The CLI's config-and-cache file, under the user's home.
pub const CLI_CACHE: &str = ".claude.json";

/// What the top bar shows. Every field optional but `stale` and `source`:
/// a machine with neither file reads as `source: "none"`, not as an error.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PlanUsage {
    /// Percent of the five-hour window used, as the server reports it.
    pub five_hour: Option<u8>,
    /// Percent of the seven-day window used.
    pub seven_day: Option<u8>,
    /// When the winning sample was taken, unix milliseconds.
    pub sampled_at_ms: Option<i64>,
    /// How old that sample was when read.
    pub age_seconds: Option<f64>,
    /// Older than [`STALE_AFTER`], or no sample at all.
    pub stale: bool,
    /// When the five-hour window rolls over, RFC 3339, from the CLI cache
    /// (the desktop sample carries no reset time).
    pub five_hour_resets_at: Option<String>,
    pub seven_day_resets_at: Option<String>,
    /// `desktop`, `cli-cache`, `cli-usage` (print-mode `/usage`, backlog
    /// 166) or `none`.
    pub source: String,
}

/// One source's reading, before the recency race.
#[derive(Debug, Clone, PartialEq)]
pub struct Sample {
    five_hour: Option<u8>,
    seven_day: Option<u8>,
    sampled_at_ms: i64,
    five_hour_resets_at: Option<String>,
    seven_day_resets_at: Option<String>,
    source: &'static str,
}

fn pct(v: &Value) -> Option<u8> {
    v.as_u64()
        .or_else(|| v.as_f64().map(|f| f.round() as u64))
        .map(|n| n.min(100) as u8)
}

/// The newest sample of the desktop app's history, or `None` for a missing,
/// malformed or empty file — and for a sample with no five-hour figure,
/// which is what the app writes before it has one.
fn desktop(path: &Path) -> Option<Sample> {
    let text = std::fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let last = v.get("samples")?.as_array()?.last()?;
    let t = last.get("t")?.as_i64()?;
    let u = last.get("u")?;
    let five_hour = pct(u.get("fh")?)?;
    Some(Sample {
        five_hour: Some(five_hour),
        seven_day: u.get("sd").and_then(pct),
        sampled_at_ms: t,
        five_hour_resets_at: None,
        seven_day_resets_at: None,
        source: "desktop",
    })
}

/// The CLI's cached reading, or `None` when the file has none. A record
/// with a null five-hour figure still counts if it has a fetch time — the
/// reset times outlive the percentages (usagectl's `_cli_resets_at`).
fn cli_cache(path: &Path) -> Option<Sample> {
    let text = std::fs::read_to_string(path).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    let cached = v.get("cachedUsageUtilization")?;
    let fetched = cached.get("fetchedAtMs")?.as_i64()?;
    let util = cached.get("utilization")?;
    let block = |name: &str| -> (Option<u8>, Option<String>) {
        let b = util.get(name);
        (
            b.and_then(|b| b.get("utilization")).and_then(pct),
            b.and_then(|b| b.get("resets_at"))
                .and_then(Value::as_str)
                .map(str::to_string),
        )
    };
    let (five_hour, five_hour_resets_at) = block("five_hour");
    let (seven_day, seven_day_resets_at) = block("seven_day");
    Some(Sample {
        five_hour,
        seven_day,
        sampled_at_ms: fetched,
        five_hour_resets_at,
        seven_day_resets_at,
        source: "cli-cache",
    })
}

/// Both sources against a clock, the more recent one with a percentage
/// winning; the CLI cache's reset times are borrowed whichever wins, since
/// the desktop sample never carries them. Pure over its paths so a test can
/// drive it from fixtures.
pub fn read_from(desktop_path: &Path, cli_path: &Path, now_ms: i64) -> PlanUsage {
    let d = desktop(desktop_path);
    let c = cli_cache(cli_path);
    let resets = c
        .as_ref()
        .map(|c| (c.five_hour_resets_at.clone(), c.seven_day_resets_at.clone()));
    let with_pct = |s: &Option<Sample>| s.as_ref().filter(|s| s.five_hour.is_some()).cloned();
    let winner = match (with_pct(&d), with_pct(&c)) {
        (Some(d), Some(c)) => Some(if c.sampled_at_ms > d.sampled_at_ms {
            c
        } else {
            d
        }),
        (Some(d), None) => Some(d),
        (None, Some(c)) => Some(c),
        (None, None) => None,
    };
    let Some(w) = winner else {
        return PlanUsage {
            five_hour_resets_at: resets.as_ref().and_then(|r| r.0.clone()),
            seven_day_resets_at: resets.and_then(|r| r.1),
            stale: true,
            source: "none".into(),
            ..PlanUsage::default()
        };
    };
    let age_ms = (now_ms - w.sampled_at_ms).max(0);
    PlanUsage {
        five_hour: w.five_hour,
        seven_day: w.seven_day,
        sampled_at_ms: Some(w.sampled_at_ms),
        age_seconds: Some(age_ms as f64 / 1000.0),
        stale: age_ms as u128 > STALE_AFTER.as_millis(),
        five_hour_resets_at: w
            .five_hour_resets_at
            .or_else(|| resets.as_ref().and_then(|r| r.0.clone())),
        seven_day_resets_at: w.seven_day_resets_at.or_else(|| resets.and_then(|r| r.1)),
        source: w.source.into(),
    }
}

/// The third source (nightshift backlog 166, blocker 264, 2026-09-18):
/// the CLI's own `/usage` command in print mode. `claude -p "/usage"` runs
/// the command locally — no model call (`num_turns: 0`, every counter
/// zero; measured on 2.1.263 three times), one GET of the plan's figure —
/// and prints the exact percentages as text. It also rewrites the CLI
/// cache, but only when the last write is five minutes old or more, so
/// the text is the reading and the file is the fallback. The trailing
/// flags are a cap: a future CLI that stops handling `/usage` locally
/// costs one ~30-token Haiku turn, not a full one.
pub const USAGE_ARGS: [&str; 10] = [
    "-p",
    "/usage",
    "--max-turns",
    "1",
    "--tools",
    "",
    "--model",
    "haiku",
    "--system-prompt",
    "Reply with one word.",
];

/// Refreshes are collapsed to one per [`REFRESH_MIN_GAP`] across the
/// process: the hook runs once per subagent call and a fan-out is many.
pub const REFRESH_MIN_GAP: std::time::Duration = std::time::Duration::from_secs(60);
static LAST_REFRESH: std::sync::Mutex<Option<(std::time::Instant, Option<Sample>)>> =
    std::sync::Mutex::new(None);

/// `Current session: 26% used · resets Sep 18 at 5am (…)` and
/// `Current week (all models): 58% used · …` → a sample stamped `now`.
/// The reset times in the text are not machine-shaped; `read_from` fills
/// them from the CLI cache, which the same run rewrites.
pub fn parse_usage_text(text: &str, now_ms: i64) -> Option<Sample> {
    fn pct_after(line: &str) -> Option<u8> {
        let (_, rest) = line.split_once(':')?;
        let n: String = rest
            .trim()
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        n.parse().ok()
    }
    let mut five = None;
    let mut week = None;
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with("Current session") {
            five = pct_after(l);
        } else if l.starts_with("Current week (all models)") {
            week = pct_after(l);
        }
    }
    Some(Sample {
        five_hour: Some(five?),
        seven_day: week,
        sampled_at_ms: now_ms,
        five_hour_resets_at: None,
        seven_day_resets_at: None,
        source: "cli-usage",
    })
}

/// Run the CLI's print-mode `/usage` from a scratch directory (so it scans
/// no project and trips on no `.mcp.json`) and parse its text. `None` when
/// the binary is missing, exits non-zero, prints no figure, or runs past
/// 90 s. Blocking; ~12 s warm, up to two minutes cold.
fn run_usage_command(now_ms: i64) -> Option<Sample> {
    use std::process::{Command, Stdio};
    let dir = std::env::temp_dir().join(format!("nightloom-usage-{}", std::process::id()));
    std::fs::create_dir_all(&dir).ok()?;
    let mut child = Command::new("claude")
        .args(USAGE_ARGS)
        .current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut out = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        std::io::Read::read_to_string(&mut out, &mut s).ok();
        s
    });
    let start = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) if start.elapsed() < std::time::Duration::from_secs(90) => {
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let text = reader.join().ok()?;
    let _ = std::fs::remove_dir_all(&dir);
    if !status?.success() {
        return None;
    }
    parse_usage_text(&text, now_ms)
}

/// The live reading, refreshed through the CLI when the files' newest
/// sample is older than `max_age` — at most once a minute process-wide.
/// The files are re-read after the run (it rewrites the CLI cache with
/// the reset times); if the run's figure is newer than what they hold,
/// the run's figure wins with source `cli-usage`.
pub fn read_fresh(max_age: std::time::Duration) -> PlanUsage {
    let first = read();
    let fresh_enough = first
        .age_seconds
        .map(|a| a <= max_age.as_secs_f64())
        .unwrap_or(false);
    if fresh_enough {
        return first;
    }
    let now_ms = chrono::Utc::now().timestamp_millis();
    let sample = {
        let mut last = LAST_REFRESH.lock().unwrap_or_else(|e| e.into_inner());
        match &*last {
            Some((at, s)) if at.elapsed() < REFRESH_MIN_GAP => s.clone(),
            _ => {
                let s = run_usage_command(now_ms);
                *last = Some((std::time::Instant::now(), s.clone()));
                s
            }
        }
    };
    let after = read();
    match sample {
        Some(s)
            if after
                .sampled_at_ms
                .map(|t| s.sampled_at_ms > t)
                .unwrap_or(true) =>
        {
            PlanUsage {
                five_hour: s.five_hour,
                seven_day: s.seven_day.or(after.seven_day),
                sampled_at_ms: Some(s.sampled_at_ms),
                age_seconds: Some(0.0),
                stale: false,
                five_hour_resets_at: after.five_hour_resets_at,
                seven_day_resets_at: after.seven_day_resets_at,
                source: "cli-usage".into(),
            }
        }
        _ => after,
    }
}

fn home() -> Option<PathBuf> {
    std::env::var("HOME")
        .ok()
        .filter(|h| !h.is_empty())
        .or_else(|| std::env::var("USERPROFILE").ok().filter(|h| !h.is_empty()))
        .map(PathBuf::from)
}

/// The live reading. A machine with no home directory reads as `none`.
pub fn read() -> PlanUsage {
    let now_ms = chrono::Utc::now().timestamp_millis();
    match home() {
        Some(h) => read_from(&h.join(DESKTOP_SAMPLE), &h.join(CLI_CACHE), now_ms),
        None => read_from(Path::new("/nonexistent"), Path::new("/nonexistent"), now_ms),
    }
}

#[cfg(test)]
mod tests {
    /// Runs the real CLI (zero tokens, ~12 s): `cargo test -- --ignored live_usage`.
    #[test]
    #[ignore]
    fn live_usage_command_reads_the_plan_for_zero_tokens() {
        let u = super::read_fresh(std::time::Duration::ZERO);
        // The run rewrites the CLI cache when it is 5+ minutes old, and
        // that file (with the reset times) then wins as the newer sample;
        // within the 5-minute gate the parsed text wins. Either is fresh.
        assert!(
            matches!(u.source.as_str(), "cli-usage" | "cli-cache"),
            "{u:?}"
        );
        assert!(u.age_seconds.unwrap_or(f64::MAX) < 60.0, "{u:?}");
        assert!(u.five_hour.is_some());
    }

    #[test]
    fn the_usage_commands_text_parses_to_both_windows() {
        let text = "You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 26% used · resets Sep 18 at 5am (America/Los_Angeles)\nCurrent week (all models): 58% used · resets Sep 23 at 3am (America/Los_Angeles)\nCurrent week (Fable): 24% used · resets Sep 23 at 3am (America/Los_Angeles)\n";
        let s = super::parse_usage_text(text, 1_000).expect("parses");
        assert_eq!(s.five_hour, Some(26));
        assert_eq!(s.seven_day, Some(58));
        assert_eq!(s.sampled_at_ms, 1_000);
        assert_eq!(s.source, "cli-usage");
        assert!(super::parse_usage_text("Reply with one word.\nOK", 0).is_none());
        assert!(super::USAGE_ARGS.contains(&"--max-turns"));
    }

    use super::*;
    use std::fs;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "nightloom-plan-usage-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn desktop_file(d: &Path, t: i64, fh: u64, sd: u64) -> PathBuf {
        let p = d.join("plan-usage-history.json");
        fs::write(
            &p,
            format!(r#"{{"version":1,"samples":[{{"t":1,"u":{{"fh":1,"sd":1}}}},{{"t":{t},"org":"x","u":{{"fh":{fh},"sd":{sd}}}}}]}}"#),
        )
        .unwrap();
        p
    }

    fn cli_file(d: &Path, fetched: i64, fh: &str, sd: &str) -> PathBuf {
        let p = d.join(".claude.json");
        fs::write(
            &p,
            format!(
                r#"{{"other":1,"cachedUsageUtilization":{{"fetchedAtMs":{fetched},"utilization":{{"five_hour":{{"utilization":{fh},"resets_at":"2026-09-15T03:40:00+00:00"}},"seven_day":{{"utilization":{sd},"resets_at":"2026-09-16T10:00:00+00:00"}},"limits":[]}}}}}}"#
            ),
        )
        .unwrap();
        p
    }

    /// The desktop sample is newer: its figures win, the CLI's reset times
    /// come along, and a 22-minute-old sample is stale.
    #[test]
    fn newer_desktop_sample_wins_and_borrows_the_reset_times() {
        let d = dir("desktop-wins");
        let now = 1_789_544_000_000;
        let desk = desktop_file(&d, now - 22 * 60 * 1000, 42, 82);
        let cli = cli_file(&d, now - 30 * 60 * 60 * 1000, "52", "67");
        let u = read_from(&desk, &cli, now);
        assert_eq!(u.source, "desktop");
        assert_eq!(u.five_hour, Some(42));
        assert_eq!(u.seven_day, Some(82));
        assert!(u.stale, "22 minutes is past the 20-minute line");
        assert_eq!(u.age_seconds, Some(22.0 * 60.0));
        assert_eq!(
            u.five_hour_resets_at.as_deref(),
            Some("2026-09-15T03:40:00+00:00")
        );
        assert_eq!(
            u.seven_day_resets_at.as_deref(),
            Some("2026-09-16T10:00:00+00:00")
        );
    }

    /// The CLI cache is newer (a `/usage` just ran): it wins, and a
    /// five-minute-old reading is not stale.
    #[test]
    fn newer_cli_cache_wins() {
        let d = dir("cli-wins");
        let now = 1_789_544_000_000;
        let desk = desktop_file(&d, now - 40 * 60 * 1000, 42, 82);
        let cli = cli_file(&d, now - 5 * 60 * 1000, "52", "67");
        let u = read_from(&desk, &cli, now);
        assert_eq!(u.source, "cli-cache");
        assert_eq!(u.five_hour, Some(52));
        assert_eq!(u.seven_day, Some(67));
        assert!(!u.stale);
    }

    /// A CLI record with a null five-hour figure does not win on recency
    /// alone; its reset time is still borrowed.
    #[test]
    fn a_cli_record_without_a_percentage_yields_to_the_desktop_sample() {
        let d = dir("cli-null");
        let now = 1_789_544_000_000;
        let desk = desktop_file(&d, now - 60 * 1000, 42, 82);
        let cli = cli_file(&d, now, "null", "null");
        let u = read_from(&desk, &cli, now);
        assert_eq!(u.source, "desktop");
        assert_eq!(u.five_hour, Some(42));
        assert_eq!(
            u.five_hour_resets_at.as_deref(),
            Some("2026-09-15T03:40:00+00:00")
        );
    }

    /// Neither file: `none`, stale, no figures, no error.
    #[test]
    fn no_files_reads_as_none() {
        let d = dir("none");
        let u = read_from(&d.join("missing.json"), &d.join("missing2.json"), 0);
        assert_eq!(u.source, "none");
        assert!(u.stale);
        assert_eq!(u.five_hour, None);
        assert_eq!(u.age_seconds, None);
    }

    /// A malformed desktop file costs that source, not the reading.
    #[test]
    fn a_broken_desktop_file_falls_back_to_the_cache() {
        let d = dir("broken");
        let desk = d.join("plan-usage-history.json");
        fs::write(&desk, "{not json").unwrap();
        let now = 1_789_544_000_000;
        let cli = cli_file(&d, now - 60 * 1000, "12", "34");
        let u = read_from(&desk, &cli, now);
        assert_eq!(u.source, "cli-cache");
        assert_eq!(u.five_hour, Some(12));
    }
}
