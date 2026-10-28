/**
 * The subagent the Running-tasks panel opens on (nightshift backlog 357):
 * a name on the transcript's still-running line opens the panel — the one
 * the top bar's agents chip opens (backlog 152/267) — with that agent's row
 * marked and scrolled into view. Cleared when the panel closes.
 */
import { app } from "./state.svelte";

export const tasksFocus = $state<{ id: string | null }>({ id: null });

/** Open the Running-tasks panel on one subagent's row. */
export function openTasksOn(id: string | null): void {
  tasksFocus.id = id;
  app.showTasks = true;
}
