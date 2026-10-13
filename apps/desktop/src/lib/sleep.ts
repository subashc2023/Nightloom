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
import { installWebviewFit } from "./webviewFit";

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
  // The start-up call (no argument) also puts in the page's half of the
  // wake refit (backlog 324): the page drawn in a corner after a wake.
  if (!p) installWebviewFit();
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
  /** The chat the turn ran in (backlog 137): the resume goes there, not
   *  to whichever chat is open when the wake is noticed. Null for a
   *  chat that had no id — none is sent then. */
  chat: string | null;
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
 * The latest wake and the latest turn end **per chat**, matched whichever
 * arrives first. A match is reported once and that end is forgotten, so
 * the resumed turn cannot match the same wake again (it starts after the
 * wake, which `sleptThrough` refuses anyway).
 *
 * ~~One end at a time, and the wake forgotten at the first match~~ — since
 * backlog 159 A4 (2026-09-30) two chats may run at once, and a sleep cuts
 * both: each chat's end is kept and matched on its own, and the wake stays
 * for the other chat's end that may still be on its way.
 */
export class SleepWatch {
  private wake: Woke | null = null;
  /** The latest end per chat; `null` chats share one slot. */
  private ends = new Map<string | null, TurnEnd>();

  constructor(
    private readonly onInterrupted: (turn: TurnEnd, wake: Woke) => void,
  ) {}

  woke(w: Woke): void {
    this.wake = w;
    this.check();
  }

  turnEnded(t: TurnEnd): void {
    this.ends.delete(t.chat);
    this.ends.set(t.chat, t);
    // Bounded: only the newest few chats' ends can still match a wake.
    while (this.ends.size > 8) this.ends.delete(this.ends.keys().next().value as string | null);
    this.check();
  }

  private check(): void {
    const w = this.wake;
    if (!w) return;
    for (const [chat, t] of [...this.ends]) {
      if (!sleptThrough(t, w)) continue;
      this.ends.delete(chat);
      this.onInterrupted(t, w);
    }
  }
}
