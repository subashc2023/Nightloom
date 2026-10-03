/**
 * The app's side of scheduled send (nightshift backlog 224): what a tick
 * reads and does, from the live state. Kept apart from `schedule.ts` and
 * `scheduled.svelte.ts` so those run in the suite without the backend.
 *
 * Each mounted composer registers its drain — the one path that sends a
 * queued message and gives the words back to the box on a failure — and
 * the newest one mounted is used (the Welcome page's composer gives way to
 * the chat's when a chat opens). With none mounted, a due message waits in
 * its chat's queue, visible, for *Send next*.
 */
import { tick } from "svelte";
import { app, openSession, refreshPlanUsage } from "./state.svelte";
import { enqueueMessage } from "./drafts.svelte";
import { deliverTo, isLimited, type TickDeps } from "./schedule";
import { startScheduleClock } from "./scheduled.svelte";

const drains: Array<() => Promise<void>> = [];

async function drain(): Promise<void> {
  // A chat just opened mounts its composer on the next flush.
  await tick();
  await drains.at(-1)?.();
}

export const scheduleDeps: TickDeps = {
  now: () => Date.now(),
  async limited() {
    // File reads only (no model call): the reading the top bar shows.
    await refreshPlanUsage(false);
    return isLimited(app.planUsage, Date.now());
  },
  deliver: (s) =>
    deliverTo(s, {
      connected: () => !!app.connection,
      activeKey: () => app.activeSessionId,
      busy: () => app.busy,
      open: (key) => openSession(key),
      enqueue: (key, text) => void enqueueMessage(key, text, []),
      drain,
    }),
};

/** A composer's drain, newest first; starts the clock. Returns the undo. */
export function registerScheduleDrain(fn: () => Promise<void>): () => void {
  drains.push(fn);
  startScheduleClock(scheduleDeps);
  return () => {
    const i = drains.lastIndexOf(fn);
    if (i >= 0) drains.splice(i, 1);
  };
}
