// Moved out of state.svelte.ts by item 641 (pure move; state.svelte.ts re-exports every name it exported).
import { app } from "../state.svelte";

let toastSeq = 0;

/**
 * How long a toast stays (item 923, his "i can't screenshot them in time"). Before: 5 s, 8 s with an action
 * (backlog 066). Now: 8 s; 12 s with an action (an Undo needs the longer look); 20 s when it is an error or
 * says something important (a refusal, a failure, a thing not done) — and hovering holds any of them.
 */
export const TOAST_MS = 8000;
export const ACTION_TOAST_MS = 12000;
export const IMPORTANT_TOAST_MS = 20000;
/** After the pointer leaves, a toast stays at least this long again. */
export const TOAST_RESUME_MS = 3000;

/** Whether a toast's words are an error or an important notice (they stay longest). */
export function isImportantToast(text: string): boolean {
  return /\b(not sent|not taken|not filed|not saved|not done|failed|failure|error|could not|couldn't|cannot|can't|unable|refused|denied|blocked|did not|didn't|wasn't|won't|no longer|lost|missing|invalid|expired|timed out|rate limit|limit reached)\b/i.test(text);
}

/** How long a toast with this text and action stays. */
export function toastMs(text: string, action?: unknown): number {
  if (isImportantToast(text)) return IMPORTANT_TOAST_MS;
  return action ? ACTION_TOAST_MS : TOAST_MS;
}

const timers = new Map<number, { timer: ReturnType<typeof setTimeout>; left: number; since: number }>();

function arm(id: number, ms: number): void {
  timers.set(id, { timer: setTimeout(() => dismissToast(id), ms), left: ms, since: Date.now() });
}

export function addToast(text: string, action?: { label: string; run: () => void }): void {
  const id = ++toastSeq;
  app.toasts.push(action ? { id, text, action } : { id, text });
  arm(id, toastMs(text, action));
}

/** The pointer is on a toast: its timer stops (the time left is kept). */
export function holdToast(id: number): void {
  const t = timers.get(id);
  if (!t) return;
  clearTimeout(t.timer);
  timers.set(id, { ...t, timer: t.timer, left: Math.max(0, t.left - (Date.now() - t.since)), since: 0 });
}

/** The pointer left: the toast stays for what was left of it, and at least `TOAST_RESUME_MS`. */
export function releaseToast(id: number): void {
  const t = timers.get(id);
  if (!t || t.since !== 0) return;
  arm(id, Math.max(t.left, TOAST_RESUME_MS));
}

/** A click on a toast's words copies them (the text, and the action's label when it has one is not part). */
export async function copyToast(id: number): Promise<boolean> {
  const t = app.toasts.find((x) => x.id === id);
  if (!t) return false;
  try {
    await navigator.clipboard.writeText(t.text);
  } catch {
    return false;
  }
  const row = app.toasts.find((x) => x.id === id);
  if (row) row.copied = true;
  return true;
}

export function dismissToast(id: number): void {
  const i = app.toasts.findIndex((t) => t.id === id);
  if (i >= 0) app.toasts.splice(i, 1);
  const t = timers.get(id);
  if (t) clearTimeout(t.timer);
  timers.delete(id);
}

/** A toast's action, run once: the toast goes with the click, so the
 *  same Undo cannot fire twice. */
export function runToastAction(id: number): void {
  const t = app.toasts.find((t) => t.id === id);
  if (!t?.action) return;
  dismissToast(id);
  t.action.run();
}
