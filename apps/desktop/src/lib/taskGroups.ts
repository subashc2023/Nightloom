/**
 * The Running tasks page's grouping (nightshift backlog 267, 2026-09-30).
 *
 * ~~One table, every send's agents newest first, headed `18 agents · 3
 * running · 18 of 6`~~ — the header counted every send's agents while the
 * top bar's chip counted the latest send's (`6 agents · done`), and the cap
 * (`of 6`) is per send, so the page read "6 done" over 18 rows with no
 * division between running and finished. Now the rows are split into
 * groups whose counts add up to the header's:
 *
 * - **Running** — every agent still running, whichever send spawned it;
 * - **Finished, latest send** — the rest of the chip's send (the chat's
 *   latest send that spawned any), so this group and Running together are
 *   the chip's `N agents`;
 * - **Earlier sends** — every older send's agents, one block per send,
 *   newest send first.
 *
 * A failed agent stays in its send's group and is counted as failed in the
 * header. Pure: `RunningTasks.svelte` reads the store and calls these.
 */
import type { SubagentRow } from "./state.svelte";

/** A row's state as the page draws it. */
export type RowState = "running" | "done" | "failed";

export function rowState(r: Pick<SubagentRow, "status">): RowState {
  if (r.status === "running") return "running";
  if (r.status === "completed") return "done";
  return "failed";
}

/** The word under a row's dot: the CLI's own word for anything else
 *  (`failed`, `no result`, `launched`). */
export function stateLabel(r: Pick<SubagentRow, "status">): string {
  const s = rowState(r);
  return s === "failed" ? r.status || "failed" : s;
}

export interface SendBlock<R> {
  turn: number;
  rows: R[];
}

export interface AgentGroups<R> {
  running: R[];
  /** The latest send's finished agents; `turn` null when there are none. */
  latest: SendBlock<R> & { total: number };
  /** Older sends, newest first; within each, newest agent first. */
  earlier: SendBlock<R>[];
  counts: { total: number; running: number; finished: number; failed: number; earlier: number };
}

type Row = Pick<SubagentRow, "status" | "turn" | "startedAt">;

/** Newest first: later send, then later start; ties keep store order
 *  reversed (the store is oldest first). */
function newestFirst<R extends Row>(rows: R[]): R[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.turn - a.r.turn || b.r.startedAt - a.r.startedAt || b.i - a.i)
    .map((x) => x.r);
}

/** One chat's rows (oldest first, as the store keeps them) into the page's
 *  groups. Every row lands in exactly one group. */
export function groupAgents<R extends Row>(rows: R[]): AgentGroups<R> {
  const sorted = newestFirst(rows);
  const latestTurn = rows.length ? Math.max(...rows.map((r) => r.turn)) : null;
  const running = sorted.filter((r) => rowState(r) === "running");
  const idle = sorted.filter((r) => rowState(r) !== "running");
  const latestRows = idle.filter((r) => r.turn === latestTurn);
  const earlier: SendBlock<R>[] = [];
  for (const r of idle) {
    if (r.turn === latestTurn) continue;
    const last = earlier[earlier.length - 1];
    if (last && last.turn === r.turn) last.rows.push(r);
    else earlier.push({ turn: r.turn, rows: [r] });
  }
  const earlierCount = earlier.reduce((n, b) => n + b.rows.length, 0);
  return {
    running,
    latest: {
      turn: latestTurn,
      rows: latestRows,
      total: latestTurn === null ? 0 : rows.filter((r) => r.turn === latestTurn).length,
    } as SendBlock<R> & { total: number },
    earlier,
    counts: {
      total: rows.length,
      running: running.length,
      finished: idle.length,
      failed: idle.filter((r) => rowState(r) === "failed").length,
      earlier: earlierCount,
    },
  };
}

/** The header's summary: the same numbers the groups show, so the parts
 *  add up — `18 agents · 3 running · 15 finished (1 failed)`. */
export function summaryLine(c: AgentGroups<unknown>["counts"], chats: number): string {
  const parts: string[] = [];
  if (chats > 0) parts.push(`${chats} chat${chats === 1 ? "" : "s"} running`);
  if (c.total === 0) {
    parts.push("no subagents in this chat yet");
    return parts.join(" · ");
  }
  parts.push(`${c.total} agent${c.total === 1 ? "" : "s"}`);
  parts.push(c.running > 0 ? `${c.running} running` : "none running");
  if (c.finished > 0) parts.push(`${c.finished} finished${c.failed > 0 ? ` (${c.failed} failed)` : ""}`);
  return parts.join(" · ");
}

/** Elapsed, short and never wrapping: `12s`, `4m 02s`, `1h 03m`. */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s - m * 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m - h * 60).padStart(2, "0")}m`;
}

/** A row's elapsed time: the CLI's `duration_ms` once reported, else the
 *  window's clock — to `now` while it runs, to its last event once not. */
export function rowElapsedMs(r: Pick<SubagentRow, "status" | "duration_ms" | "startedAt" | "updatedAt">, now: number): number {
  if (r.duration_ms > 0) return r.duration_ms;
  return Math.max(0, (rowState(r) === "running" ? now : r.updatedAt) - r.startedAt);
}

/** The caps line under the title (backlog 165, 253): the current send's
 *  spawns against the per-send cap — ~~every send's rows against it~~
 *  (267: `18 of 6`) — the window, and the budget meter's chip. */
export function capsLine(
  limits: { per_turn: number; slow_at: number; slow_to: number; stop_at: number; off: { per_turn?: boolean; slow?: boolean; stop_at?: boolean } },
  windowPct: number | null,
  spawnsThisSend: number,
  budget: string | null,
): string {
  const slowOn = !limits.off.slow && windowPct !== null && windowPct >= limits.slow_at;
  const stopOn = !limits.off.stop_at && windowPct !== null && windowPct >= limits.stop_at;
  const cap = limits.off.per_turn ? (slowOn ? limits.slow_to : null) : slowOn ? Math.min(limits.per_turn, limits.slow_to) : limits.per_turn;
  const parts = [cap === null ? `this send spawned ${spawnsThisSend}` : `this send ${spawnsThisSend} of ${cap} spawns`];
  if (windowPct !== null) parts.push(`window ${windowPct}%${stopOn ? " · spawns refused" : slowOn ? " · slowed" : ""}`);
  if (budget) parts.push(budget);
  return parts.join(" · ");
}
