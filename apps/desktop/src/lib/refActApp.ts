/*
 * The app's own `act` for the typed link's card (item 993d): `refAct.ts`'s rule with the desktop's hands — the
 * browser, a web tab, the clipboard, and the one command that reaches a connector, on the rail's Claude Code
 * binary and safe mode (as the inbox sort's one-shot turn takes them).
 */
import * as api from "./api";
import { app } from "./state.svelte";
import { openWebTab } from "./webtabs.svelte";
import { makeRefAct } from "./refAct";
import { addToast, progressToast, settleToast, updateToast } from "./state/toasts.svelte";
import type { HoldToast } from "./mailHold";

export const refAct = makeRefAct({
  openUrl: api.openUrl,
  openTab: openWebTab,
  copy: (text) => navigator.clipboard.writeText(text),
  run: api.refAct,
  agent: () => ({ binary: app.draft.agentBinary.trim() || undefined, safeMode: app.draft.agentSafeMode }),
});

/** Where the card's host offers the Undo of a changed answer: the app's toasts (12 s with an action). */
export const refToast = addToast;

/** Where a mail's hold shows once the card is closed (993e): a toast with Undo that counts down, then says what
 *  came of it — sent to whom, undone, or why not — and the Undo goes with it. */
export const refHoldToast: HoldToast = {
  start: (text, undo) => {
    const id = progressToast(text, { label: "Undo", run: undo });
    // The words count down; a clock counting up beside them would contradict them.
    const t = app.toasts.find((x) => x.id === id);
    if (t) delete t.since;
    return id;
  },
  update: updateToast,
  settle: (id, text) => void settleToast(id, text),
};
