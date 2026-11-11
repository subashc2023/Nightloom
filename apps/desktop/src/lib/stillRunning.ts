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

/** A subagent row as the Stop note reads it (item 593): what it is, and
 *  what it had done — its calls, how long, its last steps. */
export interface NoteRow extends StillRow {
  task_id: string;
  tool_uses: number;
  startedAt: number;
  /** Its own steps, as the row keeps them; only the calls' names are read. */
  segments: readonly { kind: string; call?: { name: string } }[];
}

/**
 * Nightloom's note to the main agent when he presses Stop on the line
 * (nightshift item 593, his "sends a notice to the main agent so that it can
 * like figure out what to do next"): which helpers he stopped, by name and
 * agent id, what each had done (calls, minutes, its last few steps), that
 * its partial work is kept, and that the next move is the main agent's.
 * Null when no running helper is named (nothing to tell).
 */
export function stopNote(names: readonly { label: string; id: string | null; state: NameState }[], rows: readonly NoteRow[], now: number): string | null {
  const each = names
    .filter((n) => n.state === "running")
    .map((n) => {
      const r = n.id ? rows.find((x) => x.tool_use_id === n.id) : undefined;
      if (!r) return `\u201c${n.label}\u201d`;
      const calls = r.segments.filter((s) => s.kind === "tool" && s.call).map((s) => s.call!.name);
      const count = Math.max(r.tool_uses, calls.length);
      const ms = Math.max(0, now - r.startedAt);
      const last = calls.slice(-4);
      const did = `${count} tool call${count === 1 ? "" : "s"} over ${ms < 60_000 ? "under a minute" : `${Math.round(ms / 60_000)} min`}${last.length ? `, the last ${last.join(", ")}` : ""}`;
      return `\u201c${n.label}\u201d (agent id \`${r.task_id}\`) after ${did}`;
    });
  if (each.length === 0) return null;
  const one = each.length === 1;
  return (
    `[Nightloom, not from Swaraag: he pressed Stop on the still-working line, so Nightloom stopped ${one ? "your subagent" : "your subagents"} ${each.join("; ")}. ` +
    `${one ? "Its" : "Their"} work so far is kept — any files ${one ? "it" : "they"} wrote, and ${one ? "its" : "their"} transcript and output file. ` +
    `He stopped ${one ? "it" : "them"} on purpose: do not restart ${one ? "it" : "them"} unasked. Check what ${one ? "it" : "they"} finished, tell him in a line where things stand, and decide what to do next.]`
  );
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
  // His Stop (item 593): the line says the main agent was told.
  if (seg.stopped || names.some((x) => x.state === "stopped"))
    return { state: "stopped", head: "Stopped:", count, names, tail: seg.stopped ? "— the main agent is told" : "" };
  if (names.every((x) => x.state === "done"))
    return { state: "done", head: "Done:", count, names, tail: n === 1 ? "— it reported" : "— they reported" };
  return { state: "done", head: "Ended:", count, names, tail: n === 1 ? "— it failed" : "— not every one reported" };
}

/** The line as plain text, for a copy of the reply and the off-screen toast. */
export function lineText(v: LineView): string {
  return `${v.head} ${v.count} (${v.names.map((x) => `“${x.label}”`).join(", ")})${v.tail ? ` ${v.tail}` : ""}`;
}
