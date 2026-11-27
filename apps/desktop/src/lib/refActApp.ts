/*
 * The app's own `act` for the typed link's card (item 993d): `refAct.ts`'s rule with the desktop's hands — the
 * browser, a web tab, the clipboard, and the one command that reaches a connector, on the rail's Claude Code
 * binary and safe mode (as the inbox sort's one-shot turn takes them).
 */
import * as api from "./api";
import { app } from "./state.svelte";
import { openWebTab } from "./webtabs.svelte";
import { makeRefAct, makeRefRead } from "./refAct";
import { addToast } from "./state/toasts.svelte";

const deps = {
  openUrl: api.openUrl,
  openTab: openWebTab,
  copy: (text: string) => navigator.clipboard.writeText(text),
  run: api.refAct,
  read: api.refRead,
  agent: () => ({ binary: app.draft.agentBinary.trim() || undefined, safeMode: app.draft.agentSafeMode }),
};
export const refAct = makeRefAct(deps);

/** The read of an email's own headers before its reply can go (993e review, finding 1). */
export const refRead = makeRefRead(deps);

/** Mails that were on their way when Nightloom last quit (993e review, finding 7). */
export const refUnfinished = api.refUnfinished;

/** Where the card's host offers the Undo of a changed answer: the app's toasts (12 s with an action). */
export const refToast = addToast;

/** Where a mail's hold shows once the card is closed (`refHoldToast.ts`). */
export { refHoldToast } from "./refHoldToast";
