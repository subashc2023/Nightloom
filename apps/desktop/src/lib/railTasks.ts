/**
 * The right column's Tasks (nightshift item 600, his "what's the tasks page
 * for … its jus empty saying no tasks", 2026-11-10). It listed Claude Code's
 * to-do list alone, which most turns never write, so most chats read "No tasks
 * yet". Now it also lists this chat's helpers — its subagents (background ones
 * marked), council seats and asides — from the same rows the Running tasks
 * panel and the still-working line read: every one still running, then the
 * latest send's finished ones. With nothing at all it says in one line what
 * the section shows, rather than hiding (a section that comes and goes would
 * move the column under his eye, and an empty one now explains itself).
 *
 * Pure: `TaskPanel.svelte` reads the store and calls this.
 */
import { groupAgents, rowState, type RowState } from "./taskGroups";

export interface HelperRow {
  /** The subagent's `tool_use_id` (opens the Running tasks panel on it), or the run's id. */
  id: string;
  label: string;
  /** "background", the agent type, "aside", "council seat". */
  kind: string;
  state: RowState;
  /** A subagent row the Running tasks panel can open on. */
  focus: string | null;
}

interface SubRow {
  tool_use_id: string;
  description: string;
  subagent_type: string;
  status: string;
  background: boolean;
  turn: number;
  startedAt: number;
}

interface Run {
  id: string;
  kind: string;
  session: string | null;
  doing: string;
}

/** At most this many finished rows from the latest send; the rest are counted. */
export const FINISHED_SHOWN = 4;

export function helperRows(
  subs: readonly SubRow[],
  runs: readonly Run[],
  session: string | null,
): { rows: HelperRow[]; running: number; more: number } {
  const g = groupAgents([...subs]);
  const sub = (r: SubRow): HelperRow => ({
    id: r.tool_use_id,
    label: r.description || r.subagent_type || "subagent",
    kind: r.subagent_type === "council seat" ? "council seat" : r.background ? "background" : r.subagent_type || "subagent",
    state: rowState(r),
    focus: r.tool_use_id,
  });
  // Asides run beside the chat with no subagent row (the Running tasks panel's own rows).
  const asides: HelperRow[] = session
    ? runs
        .filter((r) => r.session === session && r.kind === "aside")
        .map((r) => ({ id: r.id, label: r.doing || "aside", kind: "aside", state: "running" as const, focus: null }))
    : [];
  const running = [...g.running.map(sub), ...asides];
  const finished = g.latest.rows.map(sub);
  const shown = finished.slice(0, FINISHED_SHOWN);
  return { rows: [...running, ...shown], running: running.length, more: finished.length - shown.length };
}
