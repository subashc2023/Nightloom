/**
 * What an aside's running exchange is waiting on (item 404, 2026-10-20).
 *
 * He sent an aside with a pasted screenshot and it sat on the moon and
 * three dots "for a while", with nothing on screen to say whether it was
 * queued, thinking or stuck. An aside runs on the chat's agent and waits
 * for the chat's own running turn to end (`ask_aside` in the desktop's
 * `main.rs`); the backend now says so (`aside-phase`), and a running
 * exchange that has been silent for `ASIDE_STALL_MS` is called stalled, with
 * Ask again and Stop beside the words.
 *
 * Pure, for the suite: `AsideThread.svelte` asks it once a second.
 */

/** Silence past this, from a running exchange, is drawn as stalled. An
 *  aside's first event comes in seconds (the CLI's start-up plus the
 *  model's first token, ~2–10 s on the chat's warm cache) and a thinking
 *  model streams its thinking as it goes, so a minute and a half of
 *  nothing is not a slow answer. */
export const ASIDE_STALL_MS = 90_000;

export type AsideWaitKind = "queued" | "running" | "stalled";

export interface AsideWaitTurn {
  phase?: "queued" | "running";
  heardAt?: number;
  startedAt?: number;
}

export interface AsideWait {
  kind: AsideWaitKind;
  /** How long nothing has arrived (ms), counted from the last event, or
   *  from the start when nothing has. */
  quietMs: number;
}

/**
 * Where a running exchange stands at `now`. Queued is never stalled: the
 * chat's own turn is what it waits for, and the chat shows that turn. An
 * exchange with no phase yet (the backend's first word is a beat away, or
 * an older backend) counts from when it was asked.
 */
export function asideWait(t: AsideWaitTurn, now: number, stallMs = ASIDE_STALL_MS): AsideWait {
  const from = t.heardAt ?? t.startedAt ?? now;
  const quietMs = Math.max(0, now - from);
  if (t.phase === "queued") return { kind: "queued", quietMs };
  return { kind: quietMs >= stallMs ? "stalled" : "running", quietMs };
}

/** "1 min 30 s", "45 s": the silence, in the stalled notice's words. */
export function quietLabel(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} min ${r} s` : `${m} min`;
}
