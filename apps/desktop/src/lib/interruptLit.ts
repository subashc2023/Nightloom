/**
 * When *Interrupt and send* is the better option (nightshift item 720,
 * 2026-11-16; his words: "the default should be slip … make the stop and
 * send option always there (but dimmed or something) and then its like
 * more bright or obvious … when its actually the better option").
 *
 * A message he sends while a turn runs **slips in**: Claude reads it at
 * the turn's next gap — after the tool call it is in. That works while
 * calls are running. It does not when no gap is coming: the model is
 * writing its answer (the turn then ends before it reads anything), or
 * one long step runs. Then the interrupt is lit.
 *
 * Measured on CLI 2.1.325 (nightshift
 * `notes/runner-design/720-measurements/`): a user line with `priority:
 * "now"` cuts a long text answer within ~10 ms, keeps what was written,
 * keeps the process (the next `init` 143 ms later, no new start-up) and
 * leaves a background agent running; the `interrupt` control request does
 * the same but **stops** background agents, so it is not used.
 */

/** A row handed in this long with no gap is past waiting for one. */
export const NO_GAP_MS = 20_000;

/** What the main thread is doing, from the live reply's last segment. */
export type MainNow = "writing" | "calling" | "thinking" | "idle";

export function mainNow(segments: readonly { kind: string; call?: { result: unknown } }[] | null | undefined): MainNow {
  const last = segments?.[segments.length - 1];
  if (!last) return "idle";
  if (last.kind === "text") return "writing";
  if (last.kind === "thinking") return "thinking";
  if (last.kind === "tool") return last.call && last.call.result === null ? "calling" : "idle";
  return "idle";
}

/**
 * Why the interrupt is lit, or `null` while slipping in is the better
 * way: `writing` (the answer is being written — no gap before the turn
 * ends), `long` (the row has waited {@link NO_GAP_MS} with no gap).
 */
export function interruptLit(main: MainNow, waitedMs: number): "writing" | "long" | null {
  if (main === "writing") return "writing";
  return waitedMs >= NO_GAP_MS ? "long" : null;
}
