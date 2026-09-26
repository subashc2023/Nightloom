/**
 * The aside tab's composer (nightshift backlog 238, 2026-09-26): what it
 * shows and whether Send works, as a pure function so the suite can walk
 * every state the tab can be in.
 *
 * The old Follow-up box was drawn only while the tab's chat was the open
 * one and no answer was running (`open && last && !asking`). Activating
 * an aside tab does not open its chat (`activateTab` leaves the chat as
 * it was for an aside), so a tab clicked into from another chat had no
 * box — until he clicked the chat and came back, when it appeared. The
 * composer is now there whenever the thread is; only Send waits.
 */
import type { Aside } from "./state.svelte";

export type ComposerNote = "not-open" | "answering" | "engine" | null;

export interface ComposerState {
  /** The composer is drawn (always, while the thread exists). */
  shown: boolean;
  /** Send would send now. */
  canSend: boolean;
  /** Why Send waits, when it does for a reason other than an empty box. */
  note: ComposerNote;
}

export function asideComposer(
  aside: Aside | null,
  opts: { open: boolean; asking: boolean; claudeCode: boolean; text: string },
): ComposerState {
  if (!aside) return { shown: false, canSend: false, note: null };
  const note: ComposerNote = !opts.open ? "not-open" : opts.asking ? "answering" : !opts.claudeCode ? "engine" : null;
  return { shown: true, canSend: note === null && opts.text.trim().length > 0, note };
}
