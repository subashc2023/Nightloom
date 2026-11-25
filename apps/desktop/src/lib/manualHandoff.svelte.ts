/**
 * Item 915 (his 2026-11-23: "a way to handoff anyway, to have that wrap up
 * msg sent whenever i want"): the one path every hand-off-now control runs —
 * the composer's *Wrap up now*, the right panel's *Hand off now*, and a lone
 * `/handoff` sent from the main chat's box. Moved here from Composer's
 * `sendWrapUpNow` so none of them copies it.
 *
 * Not for asides: an aside has no hand-off of its own, so no control calls
 * this from one (the rail button hides in an aside; the composer ignores the
 * slash there).
 */
import { app, addToast, send } from "./state.svelte";
import { abortWrapUp, beginWrapUp, message, noteActivity, wrapUpToSend } from "./handoff.svelte";
import { requestWrapUp } from "./wrapAsides.svelte";
import { launch } from "./sendMotion";

/** `/handoff`, alone in the box (spaces around it are fine). */
export function isHandoffCommand(text: string): boolean {
  return /^\s*\/handoff\s*$/i.test(text);
}

/** Why the control is off right now, or null when a hand-off can go. */
export function handOffBlock(): string | null {
  if (app.busy) return "A reply is running. Hand off when it ends.";
  if (!app.connection) return "No engine connected.";
  return null;
}

/**
 * Send the wrap-up now, as a turn of its own. `dispatch` is how the caller
 * sends (the composer's own, which also drains its queue and restores a
 * failed send); the default is a plain send that puts a failed wrap-up back.
 * `from` is where the words leave from, for the send motion (item 926).
 */
export async function handOffNow(dispatch?: (text: string) => Promise<void>, from?: Element | null): Promise<void> {
  const wrapUpText = message(app.activeSessionId);
  if (app.busy || !app.connection || !wrapUpText.trim()) return;
  noteActivity();
  const chat = app.activeSessionId;
  // Item 285: with open asides, their picker first; each ticked aside's
  // summary rides in (log.md for a bound chat, the message otherwise).
  // Item 747: with the fixed sections and his goal, as the notice shows.
  const text = wrapUpToSend(chat, wrapUpText);
  await requestWrapUp(chat, async (extra) => {
    if (app.busy || !app.connection || app.activeSessionId !== chat) {
      addToast("The wrap-up did not go — the chat was busy or no longer open; press Wrap up now again");
      return;
    }
    beginWrapUp(chat);
    // Item 926: the wrap-up flies into the thread as a typed send does
    // (backlog 194) — from the control that sent it (`from`: the button, or
    // the box for `/handoff`), measured now, after any aside picker.
    if (from?.isConnected) launch("chat", from);
    const out = extra ? `${text}\n\n${extra}` : text;
    if (dispatch) {
      await dispatch(out);
      return;
    }
    await send(out);
    if (app.error) abortWrapUp(chat);
  });
}
