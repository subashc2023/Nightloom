/**
 * The aside threads' keeper (nightshift backlog 137): watches the open
 * chat's card and writes every chat's thread to localStorage, debounced,
 * the way `drafts.svelte.ts` writes the drafts. `asides.ts` is the pure
 * part; `state.svelte.ts` holds the map (`asideStash`, loaded from the
 * store at launch) and the cards (~~`app.aside`~~ `app.asides`, a list
 * since backlog 176). Imported for its effect —
 * from `Transcript.svelte`, which every window loads.
 *
 * An incognito or ephemeral chat's threads are not written (blocker 217):
 * the open chat's mode is recorded while it is open (`markOpenChat`) and
 * every save skips a private chat, so one stored before the rule goes at
 * the next save. The stash itself keeps them for the window.
 */
import { untrack } from "svelte";
import { app, asideStash, chatMode } from "./state.svelte";
import { isPrivateChat, markChatMode, saveAsides } from "./asides";

/** Record the open chat's mode. Its log and its id change together in
 *  every opener, so the pair read here belongs to one chat. */
function markOpenChat(): void {
  const id = app.activeSessionId;
  if (id !== null) markChatMode(id, chatMode(app.events));
}

const SAVE_DELAY_MS = 400;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Every thread as it stands: the stash, with the open chat's cards over
 *  its entry (the cards are the live copies; none means all dismissed). */
export function flushAsides(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (typeof localStorage === "undefined") return;
  markOpenChat();
  const map = new Map(asideStash);
  const id = app.activeSessionId;
  if (id !== null) {
    if (app.asides.length > 0) map.set(id, app.asides);
    else map.delete(id);
  }
  saveAsides(map, localStorage, (chat) => isPrivateChat(chat, app.sessions));
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
      // The chat's mode is recorded while it is open (blocker 217), and a
      // listing refresh saves again so a private chat's old entry goes.
      void app.activeSessionId;
      void app.sessions;
      untrack(markOpenChat);
      for (const a of app.asides) {
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
