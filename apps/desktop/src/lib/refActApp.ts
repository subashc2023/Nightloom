/*
 * The app's own `act` for the typed link's card (item 993d): `refAct.ts`'s rule with the desktop's hands — the
 * browser, a web tab, the clipboard, and the one command that reaches a connector, on the rail's Claude Code
 * binary and safe mode (as the inbox sort's one-shot turn takes them).
 */
import * as api from "./api";
import { app } from "./state.svelte";
import { openWebTab } from "./webtabs.svelte";
import { makeRefAct } from "./refAct";
import { addToast } from "./state/toasts.svelte";

export const refAct = makeRefAct({
  openUrl: api.openUrl,
  openTab: openWebTab,
  copy: (text) => navigator.clipboard.writeText(text),
  run: api.refAct,
  agent: () => ({ binary: app.draft.agentBinary.trim() || undefined, safeMode: app.draft.agentSafeMode }),
});

/** Where the card's host offers the Undo of a changed answer: the app's toasts (12 s with an action). */
export const refToast = addToast;
