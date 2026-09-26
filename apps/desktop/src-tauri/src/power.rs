//! Sleep-safe turns (2026-09-16, nightshift backlog 101).
//!
//! Two halves. [`Holder`] keeps the Mac awake while anything is running —
//! a chat turn on either engine, a dream, a capture, an aside — by holding
//! one `caffeinate` child for as long as at least one [`Guard`] is alive.
//! [`watch_wake`] notices the Mac coming back from sleep and tells the
//! window, which decides whether a turn was cut off by it and resumes it
//! (`sleep.ts`, `state.svelte.ts`).
//!
//! Why a child process and not IOKit: `IOPMAssertionCreateWithName` needs
//! `core-foundation`/`IOKit` bindings and unsafe FFI, and the bundle is not
//! sandboxed — nothing in `tauri.conf.json` or the signing script names an
//! entitlement, and `nightshift.rs` already spawns `caffeinate -i` for a
//! held launch from the signed app. The child is the precedent, and a
//! child that `caffeinate -w <our pid>` watches lets go by itself if this
//! process dies without dropping its guards.
//!
//! What `caffeinate` cannot do is keep a lid-closed MacBook on battery
//! awake — macOS forces that sleep — which is why the second half exists.

use serde::Deserialize;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// The Settings switches, as `sleep.ts` sends them through
/// `set_power_prefs`. Both on by default: the point of the item is that his
/// `caffeinate -dis` becomes automatic.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    /// Hold the assertion at all (`-i` and `-s`).
    pub keep_awake: bool,
    /// Also keep the display on (`-d`), the way his own habit does.
    pub keep_display_awake: bool,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            keep_awake: true,
            keep_display_awake: true,
        }
    }
}

impl Prefs {
    /// The flags the child is spawned with. `-i` (no idle sleep) and `-s`
    /// (no system sleep on mains) always, `-d` (no display sleep) by the
    /// switch: his `-dis`, with the display half optional.
    fn flags(&self) -> Vec<&'static str> {
        let mut f = vec!["-i", "-s"];
        if self.keep_display_awake {
            f.push("-d");
        }
        f
    }
}

struct Inner {
    prefs: Prefs,
    /// Live guards. The child exists exactly while this is non-zero and the
    /// switch is on.
    count: usize,
    child: Option<Child>,
}

/// One assertion for the whole app, reference-counted across whatever runs
/// at once. Managed by Tauri beside `AppState`.
pub struct Holder {
    inner: Mutex<Inner>,
}

impl Default for Holder {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner {
                prefs: Prefs::default(),
                count: 0,
                child: None,
            }),
        }
    }
}

impl Holder {
    /// Take the assertion for as long as the returned guard lives. Drop it
    /// — on success, on error, on cancel, by unwinding — and the count goes
    /// down; the last one out kills the child.
    pub fn acquire(&self) -> Guard<'_> {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.count += 1;
        if g.count == 1 {
            Self::apply(&mut g);
        }
        Guard(self)
    }

    fn release(&self) {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        g.count = g.count.saturating_sub(1);
        if g.count == 0 {
            Self::stop(&mut g);
        }
    }

    /// The switches changed. A child already running is restarted with the
    /// new flags, or stopped if the switch went off; none is started for a
    /// switch going on while nothing runs.
    pub fn set_prefs(&self, prefs: Prefs) {
        let mut g = self.inner.lock().unwrap_or_else(|p| p.into_inner());
        if g.prefs == prefs {
            return;
        }
        g.prefs = prefs;
        if g.count > 0 {
            Self::stop(&mut g);
            Self::apply(&mut g);
        }
    }

    /// Spawn per the prefs, if there is anything to spawn.
    fn apply(g: &mut Inner) {
        if g.prefs.keep_awake && g.child.is_none() {
            g.child = spawn_caffeinate(&g.prefs.flags());
        }
    }

    fn stop(g: &mut Inner) {
        if let Some(mut c) = g.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }

    /// How many guards are alive.
    #[cfg(test)]
    pub fn held(&self) -> usize {
        self.inner.lock().unwrap_or_else(|p| p.into_inner()).count
    }

    /// The child's pid while one runs — what `pmset -g assertions` lists it
    /// under.
    #[cfg(test)]
    pub fn child_pid(&self) -> Option<u32> {
        self.inner
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .child
            .as_ref()
            .map(Child::id)
    }
}

impl Drop for Holder {
    fn drop(&mut self) {
        if let Ok(g) = self.inner.get_mut() {
            Self::stop(g);
        }
    }
}

/// The assertion, held until dropped.
pub struct Guard<'a>(&'a Holder);

impl Drop for Guard<'_> {
    fn drop(&mut self) {
        self.0.release();
    }
}

/// `caffeinate <flags> -w <our pid>`: released with the child, or by the
/// child itself once this process is gone. macOS only — the binary exists
/// nowhere else, and the app on another OS simply does not hold one.
fn spawn_caffeinate(flags: &[&str]) -> Option<Child> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    Command::new("caffeinate")
        .args(flags)
        .arg("-w")
        .arg(std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .ok()
}

/// How often the wake watcher compares the two clocks.
pub const WAKE_POLL: Duration = Duration::from_secs(30);
/// How much further than the poll the wall clock must have moved for the
/// difference to be a sleep rather than a busy runtime.
pub const WAKE_GAP_MIN: Duration = Duration::from_secs(60);

/// The window event a wake is reported as: the wall-clock bounds of the
/// sleep, as well as a poll can know them. The Mac slept some time after
/// `slept_from_ms` (the tick before) and was awake by `woke_at_ms` (the
/// tick that noticed).
#[derive(serde::Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Woke {
    pub slept_from_ms: u64,
    pub woke_at_ms: u64,
}

/// A wake, if the wall clock moved further between two ticks than the poll
/// interval plus the allowed gap.
pub fn wake_between(prev_wall_ms: u64, now_wall_ms: u64) -> Option<Woke> {
    let limit = (WAKE_POLL + WAKE_GAP_MIN).as_millis() as u64;
    (now_wall_ms.saturating_sub(prev_wall_ms) > limit).then_some(Woke {
        slept_from_ms: prev_wall_ms,
        woke_at_ms: now_wall_ms,
    })
}

fn wall_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Notice the Mac coming back from sleep and emit `system-woke`.
///
/// Tauri 2 has no wake event and an `NSWorkspaceDidWakeNotification`
/// observer would be a new `objc2` dependency plus unsafe code, so this is
/// the clock-gap poll: tokio's timer runs on a monotonic clock that macOS
/// does not advance during system sleep (the fact `nightshift.rs`'s
/// `TIMER_SLICE_MS` rests on), so a tick that finds the wall clock more
/// than a minute past where the poll should have left it was slept
/// through. The first tick after a wake fires within one poll of it.
pub fn watch_wake(app: tauri::AppHandle) {
    use tauri::Emitter;
    tauri::async_runtime::spawn(async move {
        let mut prev = wall_ms();
        loop {
            tokio::time::sleep(WAKE_POLL).await;
            let now = wall_ms();
            if let Some(woke) = wake_between(prev, now) {
                let _ = app.emit("system-woke", woke);
            }
            prev = now;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caffeinate_present() -> bool {
        cfg!(target_os = "macos") && std::path::Path::new("/usr/bin/caffeinate").exists()
    }

    #[test]
    fn counts_guards_and_lets_go_with_the_last() {
        let h = Holder::default();
        assert_eq!(h.held(), 0);
        let a = h.acquire();
        let b = h.acquire();
        assert_eq!(h.held(), 2);
        if caffeinate_present() {
            assert!(h.child_pid().is_some(), "the first guard spawns the child");
        }
        let pid = h.child_pid();
        drop(a);
        assert_eq!(h.held(), 1);
        assert_eq!(h.child_pid(), pid, "one guard left keeps the same child");
        drop(b);
        assert_eq!(h.held(), 0);
        assert!(h.child_pid().is_none(), "the last guard kills it");
    }

    #[test]
    fn a_switch_off_holds_nothing_and_on_again_spawns_under_a_live_guard() {
        let h = Holder::default();
        h.set_prefs(Prefs {
            keep_awake: false,
            keep_display_awake: true,
        });
        let g = h.acquire();
        assert_eq!(h.held(), 1);
        assert!(h.child_pid().is_none());
        h.set_prefs(Prefs::default());
        if caffeinate_present() {
            assert!(
                h.child_pid().is_some(),
                "switched on under a guard: spawned now"
            );
        }
        h.set_prefs(Prefs {
            keep_awake: false,
            keep_display_awake: false,
        });
        assert!(
            h.child_pid().is_none(),
            "switched off under a guard: killed now"
        );
        drop(g);
        assert_eq!(h.held(), 0);
    }

    #[test]
    fn the_display_switch_restarts_the_child_with_new_flags() {
        if !caffeinate_present() {
            return;
        }
        let h = Holder::default();
        let _g = h.acquire();
        let first = h.child_pid();
        assert!(first.is_some());
        h.set_prefs(Prefs {
            keep_awake: true,
            keep_display_awake: false,
        });
        let second = h.child_pid();
        assert!(second.is_some());
        assert_ne!(first, second, "a changed flag is a new child");
    }

    #[test]
    fn flags_follow_the_prefs() {
        assert_eq!(Prefs::default().flags(), vec!["-i", "-s", "-d"]);
        assert_eq!(
            Prefs {
                keep_awake: true,
                keep_display_awake: false
            }
            .flags(),
            vec!["-i", "-s"]
        );
    }

    #[test]
    fn prefs_deserialize_camel_case_with_defaults() {
        let p: Prefs = serde_json::from_str(r#"{"keepAwake":false}"#).unwrap();
        assert!(!p.keep_awake);
        assert!(p.keep_display_awake);
        let p: Prefs = serde_json::from_str("{}").unwrap();
        assert_eq!(p, Prefs::default());
    }

    /// `pmset -g assertions` lists the child while a guard is held, and not
    /// after. Skipped where there is no `caffeinate` (Linux and Windows
    /// CI) — the holder there is a counter and nothing else.
    #[test]
    fn pmset_lists_the_child_while_held() {
        if !caffeinate_present() {
            return;
        }
        let h = Holder::default();
        let g = h.acquire();
        let pid = h.child_pid().expect("spawned");
        let needle = format!("pid {pid}(caffeinate)");
        // The child registers its assertion a moment after it starts.
        let mut listed = false;
        for _ in 0..40 {
            if pmset_assertions().contains(&needle) {
                listed = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(listed, "pmset should list {needle}");
        drop(g);
        let mut gone = false;
        for _ in 0..40 {
            if !pmset_assertions().contains(&needle) {
                gone = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(gone, "pmset should no longer list {needle}");
    }

    fn pmset_assertions() -> String {
        Command::new("pmset")
            .args(["-g", "assertions"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default()
    }

    #[test]
    fn a_wake_is_a_wall_clock_gap_past_the_poll() {
        let t = 1_700_000_000_000u64;
        let poll = WAKE_POLL.as_millis() as u64;
        let gap = WAKE_GAP_MIN.as_millis() as u64;
        assert_eq!(wake_between(t, t + poll), None, "an ordinary tick");
        assert_eq!(
            wake_between(t, t + poll + gap),
            None,
            "at the limit is not past it"
        );
        assert_eq!(
            wake_between(t, t + poll + gap + 1),
            Some(Woke {
                slept_from_ms: t,
                woke_at_ms: t + poll + gap + 1
            })
        );
        assert_eq!(
            wake_between(t, t - 5),
            None,
            "a clock set back is not a wake"
        );
    }
}
