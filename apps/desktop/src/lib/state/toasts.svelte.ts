// Moved out of state.svelte.ts by item 641 (pure move; state.svelte.ts re-exports every name it exported).
import { app } from "../state.svelte";

let toastSeq = 0;

/** How long a toast stays: five seconds, eight when it carries an action
 *  — his "an undo floating button for 8s" (backlog 066). */
export const TOAST_MS = 5000;
export const ACTION_TOAST_MS = 8000;

export function addToast(text: string, action?: { label: string; run: () => void }): void {
  const id = ++toastSeq;
  app.toasts.push(action ? { id, text, action } : { id, text });
  setTimeout(() => dismissToast(id), action ? ACTION_TOAST_MS : TOAST_MS);
}

export function dismissToast(id: number): void {
  const i = app.toasts.findIndex((t) => t.id === id);
  if (i >= 0) app.toasts.splice(i, 1);
}

/** A toast's action, run once: the toast goes with the click, so the
 *  same Undo cannot fire twice. */
export function runToastAction(id: number): void {
  const t = app.toasts.find((t) => t.id === id);
  if (!t?.action) return;
  dismissToast(id);
  t.action.run();
}
