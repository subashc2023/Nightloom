/**
 * Item 590: the newest live context reading per chat (`""` for a New chat's
 * first turn, before it has an id), from the turn's `context_live` events.
 * Read by the right column's dial while that chat's turn runs.
 */
import type { LiveContext } from "./liveContext";

export const liveContext = $state<{ byChat: Record<string, LiveContext> }>({ byChat: {} });

export function noteContextLive(
  chat: string | null,
  ev: { exact_tokens: number; estimate_tokens: number; rough: boolean; steps: number; writing_chars?: number },
  at: number = Date.now(),
): void {
  const was = liveContext.byChat[chat ?? ""];
  liveContext.byChat[chat ?? ""] = {
    exact: ev.exact_tokens,
    estimate: ev.estimate_tokens,
    rough: ev.rough,
    steps: ev.steps,
    at,
    writing: ev.writing_chars ?? 0,
    // Item 829: a new exact figure is a new round's start.
    roundAt: was && was.steps === ev.steps && was.roundAt != null && was.at <= at ? was.roundAt : at,
  };
}

/**
 * Item 829: when the chat's last tool call landed whole and its last result
 * came back (ms) — the working line's phase reads them with the reading.
 */
export const stepMarks = $state<{ byChat: Record<string, { callAt: number | null; resultAt: number | null }> }>({ byChat: {} });
export function noteStepMark(chat: string | null, kind: "call" | "result", at: number = Date.now()): void {
  const k = chat ?? "";
  const m = stepMarks.byChat[k] ?? { callAt: null, resultAt: null };
  stepMarks.byChat[k] = kind === "call" ? { ...m, callAt: at } : { ...m, resultAt: at };
}
export function stepMarksOf(chat: string | null): { callAt: number | null; resultAt: number | null } {
  return (chat != null ? stepMarks.byChat[chat] : undefined) ?? stepMarks.byChat[""] ?? { callAt: null, resultAt: null };
}

/** The chat's newest reading, or the New chat's while it has no id yet. */
export function liveContextOf(chat: string | null): LiveContext | null {
  return (chat != null ? liveContext.byChat[chat] : undefined) ?? liveContext.byChat[""] ?? null;
}
