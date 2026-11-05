/**
 * The Stop button's pressed state (item 466, 2026-10-29). His words: a
 * Stop on bad internet took "a good like five seconds for it to do
 * anything", and the button looked as if nothing had happened. So from
 * the click until the turn has ended the button is a pressed "Stopping…"
 * — deflated, dimmed, a small spinner — and ignores repeat clicks; past
 * `SLOW_STOP_MS` a quiet line says what it is waiting on.
 *
 * Where the seconds went, measured with stand-ins (nightshift
 * `notes/runner-design/466-report-2026-10-29.md`): the Claude Code engine
 * waited for the CLI's process to exit after it had already closed the
 * turn, and the provider engine did not hear a Stop while its request was
 * still opening. Both are cut in the service; what is left — a CLI that
 * takes its time to answer the interrupt — is what this state covers.
 */

/** When the quiet "why" line appears, in ms after the press. */
export const SLOW_STOP_MS = 3000;

/**
 * `idle`: no turn. `running`: a turn, Stop not pressed. `stopping`: pressed,
 * the turn not yet ended. `slow`: the same, past `SLOW_STOP_MS`.
 */
export type StopPhase = "idle" | "running" | "stopping" | "slow";

/** When the Stop on screen was pressed (`performance.now()` ms), or null. */
export interface StopClock {
  since: number | null;
}

export function stopPhase(busy: boolean, clock: StopClock, now: number, slowMs: number = SLOW_STOP_MS): StopPhase {
  if (!busy) return "idle";
  if (clock.since === null) return "running";
  return now - clock.since >= slowMs ? "slow" : "stopping";
}

/**
 * A press of the Stop at `now`: whether it is the one that asks (the first
 * of this turn). A repeat press while it is stopping asks nothing again.
 */
export function pressStop(clock: StopClock, now: number): boolean {
  if (clock.since !== null) return false;
  clock.since = now;
  return true;
}

/** The turn has ended, or the Stop's own call failed: the button is a Stop again. */
export function releaseStop(clock: StopClock): void {
  clock.since = null;
}

/** ms until the press turns `slow`, for the one timer that redraws it; null when none is due. */
export function slowDueIn(clock: StopClock, now: number, slowMs: number = SLOW_STOP_MS): number | null {
  if (clock.since === null) return null;
  return Math.max(0, clock.since + slowMs - now);
}

/** The quiet line under a slow Stop, by engine. */
export function slowStopLine(engine: string | null | undefined): string {
  return engine === "claude-code"
    ? "waiting for Claude Code to stop — the connection is slow"
    : "waiting for the running step to stop — the connection is slow";
}
