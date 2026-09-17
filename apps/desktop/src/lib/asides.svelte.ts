/**
 * The aside threads' keeper (nightshift backlog 137): watches the open
 * chat's card and writes every chat's thread to localStorage, debounced,
 * the way `drafts.svelte.ts` writes the drafts. `asides.ts` is the pure
 * part; `state.svelte.ts` holds the map (`asideStash`, loaded from the
 * store at launch) and the card (`app.aside`). Imported for its effect —
 * from `Transcript.svelte`, which every window loads.
 */
import { untrack } from "svelte";
import { app, asideStash } from "./state.svelte";
import { saveAsides } from "./asides";

const SAVE_DELAY_MS = 400;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Every thread as it stands: the stash, with the open chat's card over
 *  its entry (the card is the live copy; null means dismissed). */
export function flushAsides(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (typeof localStorage === "undefined") return;
  const map = new Map(asideStash);
  const id = app.activeSessionId;
  if (id !== null) {
    if (app.aside) map.set(id, app.aside);
    else map.delete(id);
  }
  saveAsides(map, localStorage);
}

function schedule(): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(flushAsides, SAVE_DELAY_MS);
}

if (typeof window !== "undefined") {
  $effect.root(() => {
    $effect(() => {
      // Read what a save depends on, so a delta, an answer landing, a
      // cancel, a dismiss and a chat switch each schedule one.
      void app.activeSessionId;
      const a = app.aside;
      if (a) {
        void a.draft;
        for (const t of a.turns) {
          void t.partial;
          void t.answer;
          void t.error;
          void t.cancelled;
        }
      }
      untrack(schedule);
    });
  });
  window.addEventListener("pagehide", flushAsides);
}
