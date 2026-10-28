/**
 * The still-running line (nightshift backlog 357, 2026-10-13; built on
 * 329's `still_running` event): the main reply ended while its subagents
 * still run, and the turn waits for them — the CLI wakes the main agent as
 * each reports. ~~A notice worded as a question ("— wait for it, or stop
 * it?") with Stop only on a toast~~ — a status line of its own: what is
 * running, a Stop on the line, each subagent's name a way to its row in the
 * Running-tasks panel, and the line turning to done or stopped as they end.
 *
 * The pure part, for the suite: which subagent rows the event's task names
 * are, and what the line says for the rows as they stand now.
 */

/** The segment the transcript draws (see `Segment` in state.svelte.ts). */
export interface StillRunningSegment {
  kind: "still_running";
  /** The task descriptions the event named, in its order. */
  tasks: string[];
  /** Each task's subagent row (`tool_use_id`), or null when none matched. */
  ids: (string | null)[];
  /** The turn's key, for `api.stopSubagents`; absent off screen. */
  turn?: string;
  /** He pressed Stop on this line. */
  stopped?: boolean;
}

/** The fields of a subagent row the line reads. */
export interface StillRow {
  tool_use_id: string;
  description: string;
  status: string;
}

export type LineState = "running" | "done" | "stopped";
export type NameState = "running" | "done" | "failed" | "stopped";

/** Each task name's row: the first row with that description not already
 *  taken, a running one before a finished one. */
export function matchTasks(tasks: readonly string[], rows: readonly StillRow[]): (string | null)[] {
  const used = new Set<string>();
  return tasks.map((t) => {
    const same = rows.filter((r) => r.description === t && !used.has(r.tool_use_id));
    const r = same.find((x) => x.status === "running") ?? same[same.length - 1];
    if (!r) return null;
    used.add(r.tool_use_id);
    return r.tool_use_id;
  });
}

export interface LineView {
  state: LineState;
  /** "Still working:", "Done:", "Stopped:", "Ended:" (one failed). */
  head: string;
  /** "1 subagent", "2 subagents". */
  count: string;
  names: { label: string; id: string | null; state: NameState }[];
  /** After the names: what happens next, or nothing. */
  tail: string;
}

/** What the line says now. A name with no row reads as running until the
 *  line is stopped — there is nothing else to tell its end by. */
export function lineView(seg: StillRunningSegment, rows: readonly StillRow[]): LineView {
  const names = seg.tasks.map((label, i) => {
    const id = seg.ids[i] ?? null;
    const row = id ? rows.find((r) => r.tool_use_id === id) : undefined;
    let state: NameState =
      !row || row.status === "running"
        ? "running"
        : row.status === "completed"
          ? "done"
          : /stop|kill|cancel/i.test(row.status)
            ? "stopped"
            : "failed";
    if (seg.stopped && state !== "done") state = "stopped";
    return { label, id, state };
  });
  const n = names.length;
  const count = `${n} subagent${n === 1 ? "" : "s"}`;
  const running = names.some((x) => x.state === "running");
  if (running)
    return { state: "running", head: "Still working:", count, names, tail: `— the reply continues when ${n === 1 ? "it reports" : "they report"}` };
  if (seg.stopped || names.some((x) => x.state === "stopped"))
    return { state: "stopped", head: "Stopped:", count, names, tail: "" };
  if (names.every((x) => x.state === "done"))
    return { state: "done", head: "Done:", count, names, tail: n === 1 ? "— it reported" : "— they reported" };
  return { state: "done", head: "Ended:", count, names, tail: n === 1 ? "— it failed" : "— not every one reported" };
}

/** The line as plain text, for a copy of the reply and the off-screen toast. */
export function lineText(v: LineView): string {
  return `${v.head} ${v.count} (${v.names.map((x) => `“${x.label}”`).join(", ")})${v.tail ? ` ${v.tail}` : ""}`;
}
