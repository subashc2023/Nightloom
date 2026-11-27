/*
 * The app's toast for a mail's hold (993e): a progress toast with Undo that counts down, then says what came of
 * it — sent to whom, undone, or why not — and the Undo goes with it. While the hold runs its X is the Undo
 * (blocker 2355): closing it must not leave a mail going with no Undo on screen.
 */
import { app } from "./state.svelte";
import { progressToast, settleToast, updateToast } from "./state/toasts.svelte";
import { makeHoldToast } from "./mailHold";

export const refHoldToast = makeHoldToast({
  progress: progressToast,
  find: (id) => app.toasts.find((x) => x.id === id),
  update: updateToast,
  settle: (id, text) => void settleToast(id, text),
});
