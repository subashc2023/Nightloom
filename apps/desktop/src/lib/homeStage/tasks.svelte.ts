/**
 * Home's tasks on the stage (item 845): what Home's `update_task` wrote (`home_tasks`, a file read, no model), his
 * clicks Home should know (`tell` → `home_task_event`, kind B), and his × on a tab (`home_task_close`) — through the
 * stage's host (`host.ts`: the window's commands on the Mac, the listener's routes on the phone). Nothing here calls a model.
 */
import { stageHost, type HomeTask } from "./host";

export type { HomeTask };

export const tasks = $state({ rows: [] as HomeTask[], loaded: false, problem: null as string | null });

let reading = false;
let again = false;
/** Re-read the stage's tasks. A backend without them leaves the list empty, quietly. */
export async function refreshTasks(): Promise<void> {
  if (reading) {
    again = true;
    return;
  }
  reading = true;
  try {
    const rows = await stageHost.now.homeTasks();
    tasks.rows = Array.isArray(rows) ? rows.filter((t) => t && typeof t.id === "string" && typeof t.view === "string") : [];
    tasks.problem = null;
  } catch (e) {
    tasks.problem = String(e);
  } finally {
    tasks.loaded = true;
    reading = false;
    if (again) {
      again = false;
      void refreshTasks();
    }
  }
}

/** Kind B: one line of what he did, for Home's next look ("you skipped moving Design review"). Best-effort. */
export async function tell(task: HomeTask, line: string): Promise<void> {
  try {
    await stageHost.now.taskEvent(task.name, task.view, line);
  } catch {
    // best-effort, like the feed: his click is kept in the view's own state either way
  }
}

/** His × on a task's tab: the tab goes; Home's work is not stopped. */
export async function closeTask(id: string): Promise<void> {
  try {
    await stageHost.now.taskClose(id);
  } finally {
    tasks.rows = tasks.rows.filter((t) => t.id !== id);
    void refreshTasks();
  }
}
