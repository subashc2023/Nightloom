/**
 * A subagent's recorded turn (nightshift backlog 075, 2026-09-16).
 *
 * On the Claude Code engine the recorder keeps a subagent's calls and words
 * as one text block against the id of the `Agent` call that spawned it —
 * `<subagent parent="toolu_…">\n…\n</subagent>` (`agent/record.rs`,
 * `subagent_block`) — so the log stays valid on a provider replay and the
 * transcript can nest the block under the parent's row. This is the reader.
 */

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
