/**
 * A subagent's recorded turn (nightshift backlog 075, 2026-09-16).
 *
 * On the Claude Code engine the recorder keeps a subagent's calls and words
 * as one text block against the id of the `Agent` call that spawned it —
 * `<subagent parent="toolu_…">\n…\n</subagent>` (`agent/record.rs`,
 * `subagent_block`) — so the log stays valid on a provider replay and the
 * transcript can nest the block under the parent's row. This is the reader.
 */

import type { Segment, ToolCallView } from "./state.svelte";

const OPEN = '<subagent parent="';
const CLOSE = "</subagent>";

export interface SubagentBlock {
  /** The `tool_use_id` of the call that spawned the subagent. */
  parent: string;
  /** The narrative: one line per call and result, the child's words as
   *  they were. */
  body: string;
}

/** The block a recorded text is, or null for ordinary prose. */
export function parseSubagentBlock(text: string): SubagentBlock | null {
  if (!text.startsWith(OPEN)) return null;
  const q = text.indexOf('">', OPEN.length);
  if (q < 0) return null;
  const parent = text.slice(OPEN.length, q);
  if (!parent) return null;
  let body = text.slice(q + 2);
  if (body.endsWith(CLOSE)) body = body.slice(0, -CLOSE.length);
  return { parent, body: body.replace(/^\n/, "").replace(/\n$/, "") };
}

/** The fold line's count: rows of the narrative that are calls (`▸`). */
export function subagentCalls(body: string): number {
  return body.split("\n").filter((l) => l.startsWith("▸ ")).length;
}

/** The tool call with `id` among `segs`, nested subagents' calls included. */
export function findCallIn(segs: Segment[], id: string): ToolCallView | null {
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i];
    if (seg.kind !== "tool" && seg.kind !== "removed_tool") continue;
    if (seg.call.id === id) return seg.call;
    if (seg.call.children) {
      const inner = findCallIn(seg.call.children, id);
      if (inner) return inner;
    }
  }
  return null;
}

/** The task a box with no spawning call in the log is drawn under. */
export const UNKNOWN_PARENT_TASK = "subagent started by another subagent";

/**
 * Place a recorded subagent block (backlog 330): under the call that spawned
 * it — in this reply, or in any earlier reply of the chat (a background
 * agent's block lands replies later, past his next message) — or, when no
 * call in the log has its id (a subagent's own `Agent` call is not a main-
 * thread block), in an agent box of its own. Never as the reply's prose: it
 * used to fall through to a text segment, the step log (`▸ WebSearch …`,
 * `↳ …`, SubagentHandback) drawn as one run-together wall after the reply.
 * `earlier` is the chat's earlier replies' segments, newest first.
 */
export function placeSubagentBlock(sub: SubagentBlock, segs: Segment[], earlier: Segment[][]): void {
  let parent = findCallIn(segs, sub.parent);
  for (const prior of earlier) {
    if (parent) break;
    parent = findCallIn(prior, sub.parent);
  }
  const child: Segment = { kind: "text", text: sub.body };
  if (parent) {
    parent.children ??= [];
    parent.children.push(child);
    return;
  }
  segs.push({
    kind: "tool",
    call: {
      id: sub.parent,
      name: "Agent",
      input: { description: UNKNOWN_PARENT_TASK },
      result: { content: "", is_error: false },
      children: [child],
    },
  });
}
