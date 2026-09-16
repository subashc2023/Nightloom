/**
 * Sleep-safe turns (nightshift backlog 101): the switches, and the rule
 * that says a turn was cut off by the Mac sleeping.
 *
 * The keep-awake half lives in Rust (`power.rs` holds a `caffeinate` child
 * while anything runs); this file only carries its two switches there
 * through `set_power_prefs`, the way `notify.ts` keeps the banner switches
 * in localStorage and decides for the backend.
 *
 * The resume half is decided here and acted on in `state.svelte.ts`. What
 * Rust reports is a wake — `system-woke`, the wall-clock bounds of the
 * sleep as a 30 s poll can know them. What the window knows is when each
 * turn started and how it ended. A turn that was in flight when the Mac
 * slept and then ended in an error shortly after it woke is the one sleep
 * killed: the `claude -p` process (or the provider stream) is frozen, not
 * ended, during sleep, so its error surfaces only *after* the wake, once
 * the dead socket is noticed — never inside the gap. The two reports can
 * arrive in either order (the error can land before the poll's next tick),
 * so `SleepWatch` keeps the latest of each and decides when it has both.
 * Everything below `SleepWatch` is pure so the suite can pin the rule.
 */
import * as api from "./api";

export interface SleepPrefs {
  /** Hold a power assertion while a turn, dream, capture or aside runs. */
  keepAwake: boolean;
  /** Keep the display on too (`caffeinate -d`), his own habit. */
  keepDisplayAwake: boolean;
  /** Send "continue" to a turn that sleep cut off. */
  resumeAfterSleep: boolean;
  /** Ask first (a toast with Resume) instead of resuming outright. */
  resumeAsks: boolean;
}

export const SLEEP_PREFS_KEY = "nightloom.sleep";

const DEFAULTS: SleepPrefs = {
  keepAwake: true,
  keepDisplayAwake: true,
  resumeAfterSleep: true,
  resumeAsks: false,
};

/** The stored preference read back, or the defaults when absent or malformed. */
export function parseSleepPrefs(raw: string | null): SleepPrefs {
  try {
    if (raw) {
      const p = JSON.parse(raw) as Partial<SleepPrefs>;
      const bool = (k: keyof SleepPrefs) =>
        typeof p[k] === "boolean" ? (p[k] as boolean) : DEFAULTS[k];
      return {
        keepAwake: bool("keepAwake"),
        keepDisplayAwake: bool("keepDisplayAwake"),
        resumeAfterSleep: bool("resumeAfterSleep"),
        resumeAsks: bool("resumeAsks"),
      };
    }
  } catch {
    // A malformed preference costs the preference, not the feature.
  }
  return { ...DEFAULTS };
}

export function loadSleepPrefs(): SleepPrefs {
  try {
    return parseSleepPrefs(localStorage.getItem(SLEEP_PREFS_KEY));
  } catch {
    return parseSleepPrefs(null);
  }
}

/** Store the switches and tell Rust the two it acts on. */
export function saveSleepPrefs(p: SleepPrefs): void {
  try {
    localStorage.setItem(SLEEP_PREFS_KEY, JSON.stringify(p));
  } catch {
    // best-effort
  }
  void pushPowerPrefs(p);
}

/**
 * Hand the keep-awake switches to `power.rs`. Called at start-up (the
 * holder defaults to both on, so a fresh install needs nothing) and on
 * every change; a change while a turn runs restarts the child with the
 * new flags.
 */
export async function pushPowerPrefs(p?: SleepPrefs): Promise<void> {
  const prefs = p ?? loadSleepPrefs();
  try {
    await api.setPowerPrefs({
      keepAwake: prefs.keepAwake,
      keepDisplayAwake: prefs.keepDisplayAwake,
    });
  } catch {
    // A holder that could not be told keeps its last setting.
  }
}

/** The bounds of a sleep as `system-woke` reports them (`power::Woke`). */
export interface Woke {
  /** The poll's tick before the sleep: the Mac was awake at this moment. */
  slept_from_ms: number;
  /** The tick that noticed: the Mac was awake again by this moment. */
  woke_at_ms: number;
}

/** A turn as the rule sees it. */
export interface TurnEnd {
  startedAtMs: number;
  endedAtMs: number;
  /** Ended in an error — a rejected send, or the CLI's `is_error` result. */
  errored: boolean;
  /** He pressed Stop; not sleep's doing whatever the timing. */
  stopped: boolean;
}

/** The poll interval `power.rs` ticks at: the slack on each bound. */
export const WAKE_POLL_MS = 30 * 1000;
/** How long after the wake an error still counts as sleep's. The CLI
 *  retries a dead connection before it gives up, and that takes minutes. */
export const RESUME_GRACE_MS = 5 * 60 * 1000;

/** What the resumed turn says — the transcript line and the instruction in one. */
export const RESUME_TEXT =
  "continue — the previous turn was cut off while the Mac was asleep; pick up where it stopped.";

/**
 * Whether `turn` is the one sleep cut off. It must have started before the
 * Mac slept (before the tick after `slept_from_ms` could have fired), and
 * ended in an error after the Mac woke (no earlier than one poll before the
 * tick that noticed) and within the grace.
 */
export function sleptThrough(turn: TurnEnd, wake: Woke): boolean {
  if (!turn.errored || turn.stopped) return false;
  if (turn.startedAtMs > wake.slept_from_ms + WAKE_POLL_MS) return false;
  if (turn.endedAtMs < wake.woke_at_ms - WAKE_POLL_MS) return false;
  return turn.endedAtMs <= wake.woke_at_ms + RESUME_GRACE_MS;
}

/**
 * The latest wake and the latest turn end, matched whichever arrives
 * first. A match is reported once and both halves are forgotten, so the
 * resumed turn cannot match the same wake again.
 */
export class SleepWatch {
  private wake: Woke | null = null;
  private end: TurnEnd | null = null;

  constructor(
    private readonly onInterrupted: (turn: TurnEnd, wake: Woke) => void,
  ) {}

  woke(w: Woke): void {
    this.wake = w;
    this.check();
  }

  turnEnded(t: TurnEnd): void {
    this.end = t;
    this.check();
  }

  private check(): void {
    if (!this.wake || !this.end || !sleptThrough(this.end, this.wake)) return;
    const [t, w] = [this.end, this.wake];
    this.end = null;
    this.wake = null;
    this.onInterrupted(t, w);
  }
}
