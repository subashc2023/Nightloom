/**
 * New or continued helper, on a reply's trace rows (nightshift item 718, his
 * "maybe a visual indicator when a agent in the thinking block is new versus
 * reusing a previous? in theme w the jarvis?").
 *
 * An `Agent` call always starts a fresh helper: its row is marked **new**.
 * A `SendMessage` call continues one this chat already has — the CLI
 * resumes a finished helper with its whole earlier context (backlog 406),
 * or passes the message to a running one at its next tool round (339) — so
 * its row is marked **continued**, and its hover names the helper and the
 * size it had before the message.
 *
 * That earlier size is the helper's row as it stood when the SendMessage
 * row was first drawn (`rememberEarlier`), before the resumed run reports
 * anything. A reply read back from the log after a relaunch has no such
 * moment, so its hover says the size now, and says so.
 */
import type { SubagentRow } from "./state.svelte";
import { isAgentCall, shortModel } from "./subagentRows";
import { fmtTokens } from "./tokens";

export interface HelperMark {
  kind: "new" | "continued";
  /** The mark's own text. */
  label: string;
  title: string;
}

/** What a SendMessage call names as its recipient: an agent id or a name. */
export function sendTarget(input: unknown): string | null {
  const i = (input ?? {}) as Record<string, unknown>;
  for (const k of ["to", "recipient", "agent_id", "agentId"]) {
    const v = i[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

/** The helper row a SendMessage reaches: by its agent id, else its name. */
export function targetRow(rows: readonly SubagentRow[], session: string | null, to: string): SubagentRow | null {
  const mine = rows.filter((r) => r.session === session);
  return (
    mine.find((r) => r.task_id === to) ??
    [...mine].reverse().find((r) => r.description === to || r.subagent_type === to) ??
    null
  );
}

/** The size and state a helper had when a message to it was first seen. */
export interface Earlier {
  tokens: number;
  calls: number;
  running: boolean;
}

/** Keyed by the SendMessage call's id; not reactive and not saved. */
const earlier = new Map<string, Earlier>();

/** The helper as it stood the first time `callId` was drawn, recorded then. */
export function rememberEarlier(callId: string, row: SubagentRow | null): Earlier | null {
  const had = earlier.get(callId);
  if (had) return had;
  if (!row) return null;
  const e = { tokens: row.tokens, calls: row.tool_uses, running: row.status === "running" };
  earlier.set(callId, e);
  return e;
}

/** For the suite. */
export function forgetEarlier(): void {
  earlier.clear();
}

const who = (r: SubagentRow) => {
  const kind = [r.subagent_type, shortModel(r.model)].filter(Boolean).join(", ");
  return `“${r.description || r.subagent_type || "helper"}”${kind ? ` (${kind})` : ""}`;
};

const size = (tokens: number, calls: number) =>
  tokens > 0 ? `${fmtTokens(tokens)}${calls > 0 ? `, ${calls} call${calls === 1 ? "" : "s"}` : ""}` : "no size reported";

/**
 * The mark for a trace row's call, or null for any call that is not about a
 * helper. `live` is true while the reply streams: only then is the helper's
 * size before the message read and kept.
 */
export function helperMark(
  call: { id: string; name: string; input: unknown },
  rows: readonly SubagentRow[],
  session: string | null,
  live: boolean,
): HelperMark | null {
  if (isAgentCall(call.name)) {
    return { kind: "new", label: "new", title: "A new helper: a fresh context, nothing carried over from earlier helpers" };
  }
  if (call.name !== "SendMessage") return null;
  const to = sendTarget(call.input);
  const row = to ? targetRow(rows, session, to) : null;
  if (!row) {
    return {
      kind: "continued",
      label: "cont",
      title: `Continues an earlier helper${to ? ` (${to})` : ""}, keeping its context; this chat has no row for it`,
    };
  }
  const e = live ? rememberEarlier(call.id, row) : (earlier.get(call.id) ?? null);
  const how = !e ? "" : e.running ? " It was still running: the message reaches it at its next tool round." : " It had finished: the CLI resumes it with everything it knew.";
  const sized = e ? `It held ${size(e.tokens, e.calls)} before this message.` : `Its size before this message was not recorded; now ${size(row.tokens, row.tool_uses)}.`;
  return { kind: "continued", label: "cont", title: `Continues helper ${who(row)}, keeping its context. ${sized}${how}` };
}
