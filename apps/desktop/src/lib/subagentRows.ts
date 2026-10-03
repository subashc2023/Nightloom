/**
 * The Running-tasks rows across chats (nightshift backlog 160, 2026-09-25).
 *
 * ~~One chat's rows, cleared on every chat switch~~ — until 160 the rows
 * (`app.subagents`) were the open chat's alone and were emptied whenever a
 * chat was opened, the same one included, and the top bar's chip read only
 * the current send's (`turnSeq`), so a finished agent left the chip at the
 * next send or the next open and left the panel with it. He saw the chip
 * "for a little bit, but then … it's gone". Now there is still **one store**
 * (backlog 160's Not-to-do), keyed by session and the spawning call's id:
 *
 * - every row names its chat (`session`), so opening another chat hides a
 *   row instead of dropping it, and a subagent tab of another chat still
 *   draws;
 * - the chip reads the open chat's **latest turn that had agents**, so it
 *   stays — `1 agent · done · 31k` — until a later turn spawns more;
 * - a chat opened from disk gets its rows back from the log's recorded
 *   `Agent` calls and `<subagent>` blocks (`rowsFromLog`), merged under any
 *   row the window still holds, which has the live figures.
 *
 * Pure: the state module holds the rows and calls these.
 */
import type { Segment, SubagentRow } from "./state.svelte";
import type { SessionEvent, Usage } from "./types";
import type { TabContent } from "./tabs";
import { parseSubagentBlock } from "./subagent";
import { fmtTokens } from "./tokens";

/** The call names that spawn a subagent: the CLI's `Agent` (`Task` in
 *  older builds). */
export function isAgentCall(name: string): boolean {
  return name === "Agent" || name === "Task";
}

/** What an `Agent` call's input says about the task. */
function taskOf(input: unknown): { description: string; subagent_type: string; prompt: string; model?: string } {
  const i = (input ?? {}) as Record<string, unknown>;
  const s = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : "");
  const model = s("model");
  return {
    description: s("description"),
    subagent_type: s("subagent_type"),
    prompt: s("prompt"),
    ...(model ? { model } : {}),
  };
}

/** The tab an `Agent` call's row opens (backlog 160): the subagent's
 *  transcript, the same descriptor the panel's *View transcript* makes. */
export function agentCallContent(
  session: string,
  call: { id: string; input: unknown },
): Extract<TabContent, { kind: "subagent" }> {
  const t = taskOf(call.input);
  return { kind: "subagent", session, toolUseId: call.id, name: t.description || t.subagent_type || "subagent" };
}

/** `claude-haiku-4-5-20251001` → `haiku 4.5`; an alias (`sonnet`) as it is. */
export function shortModel(m: string | undefined): string {
  if (!m) return "";
  const x = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(m);
  return x ? `${x[1]} ${x[2]}.${x[3]}` : m;
}

/** A row's state in a word, as the panel says it. */
export function stateWord(r: SubagentRow): string {
  if (r.status === "running") return "running";
  if (r.status === "completed") return "done";
  return r.status;
}

/** The Agent call's row in the transcript, once the panel knows its
 *  subagent (backlog 160): `sonnet · done · 31k · 6 calls`. */
export function agentRowLine(r: SubagentRow): string {
  const parts = [shortModel(r.model), stateWord(r)];
  if (r.tokens > 0) parts.push(fmtTokens(r.tokens));
  if (r.tool_uses > 0) parts.push(`${r.tool_uses} call${r.tool_uses === 1 ? "" : "s"}`);
  return parts.filter(Boolean).join(" · ");
}

/** A chat's rows, oldest first. */
export function rowsOf(rows: SubagentRow[], session: string | null): SubagentRow[] {
  return rows.filter((r) => r.session === session);
}

/**
 * The chip's rows (backlog 160): the chat's latest turn that spawned any,
 * with how many still run and the CLI's tokens summed. Stays after the
 * agents finish and after later turns that spawn none.
 */
export function latestAgents(
  rows: SubagentRow[],
  session: string | null,
): { rows: SubagentRow[]; running: number; tokens: number } {
  const mine = rowsOf(rows, session);
  if (mine.length === 0) return { rows: [], running: 0, tokens: 0 };
  const turn = Math.max(...mine.map((r) => r.turn));
  const latest = mine.filter((r) => r.turn === turn);
  return {
    rows: latest,
    running: latest.filter((r) => r.status === "running").length,
    tokens: latest.reduce((n, r) => n + r.tokens, 0),
  };
}

/**
 * The `turn` a row rebuilt from the log carries: its send's place in the
 * log, far below any live `turnSeq` (which counts up from 0 in this
 * window), so the log's turns order among themselves and every live turn
 * is later than all of them.
 */
export const LOG_TURN_BASE = -1_000_000;

/** The figures the CLI appends to an `Agent` result, when it did. */
function figuresOf(result: string): { tokens: number; tool_uses: number; duration_ms: number } {
  const n = (re: RegExp) => {
    const m = re.exec(result);
    return m ? Number(m[1]) : 0;
  };
  return {
    tokens: n(/total_tokens:\s*(\d+)/),
    tool_uses: n(/tool_uses:\s*(\d+)/),
    duration_ms: n(/duration_ms:\s*(\d+)/),
  };
}

const NO_USAGE: Usage = { input_tokens: 0, output_tokens: 0 };

/**
 * A chat's subagents as its log records them (backlog 160, the 152
 * report's "left"): one row per `Agent` call, its task from the call's
 * input, its state from the call's result, its figures from what the CLI
 * appended to the result when it did (else 0 — a floor, not a claim), and
 * its transcript the recorder's narrative (`<subagent>` block) as one text
 * segment, as the transcript draws it. Marked `restored`.
 */
export function rowsFromLog(events: SessionEvent[], session: string): SubagentRow[] {
  const results = new Map<string, { content: string; is_error: boolean }>();
  const narratives = new Map<string, string>();
  for (const e of events) {
    if (e.event === "tool_result") results.set(e.tool_use_id, { content: e.content, is_error: e.is_error ?? false });
    if (e.event === "assistant_message") {
      for (const b of e.blocks) {
        if (b.type !== "text") continue;
        const sub = parseSubagentBlock(b.text);
        if (sub) narratives.set(sub.parent, sub.body);
      }
    }
  }
  const out: SubagentRow[] = [];
  let sends = 0;
  for (const e of events) {
    if (e.event === "user_message") sends += 1;
    if (e.event !== "assistant_message") continue;
    const at = Date.parse(e.at) || 0;
    for (const b of e.blocks) {
      if (b.type !== "tool_use" || !isAgentCall(b.name)) continue;
      if (out.some((r) => r.tool_use_id === b.id)) continue;
      const task = taskOf(b.input);
      const result = results.get(b.id);
      const story = narratives.get(b.id);
      const launched = !!result && /launched/i.test(result.content) && !story;
      const status = !result ? "no result" : result.is_error ? "failed" : launched ? "launched" : "completed";
      const figures = result ? figuresOf(result.content) : { tokens: 0, tool_uses: 0, duration_ms: 0 };
      const segments: Segment[] = story ? [{ kind: "text", text: story }] : [];
      out.push({
        tool_use_id: b.id,
        task_id: "",
        ...task,
        status,
        background: launched,
        ...figures,
        usage: NO_USAGE,
        rounds: 0,
        session,
        turn: LOG_TURN_BASE + sends,
        startedAt: at,
        updatedAt: at,
        segments,
        restored: true,
      });
    }
  }
  return out;
}

/** The rows with a chat's log rows added: a row the window holds wins —
 *  it has the live figures — and a log row joins only when none does. */
export function mergeRows(rows: SubagentRow[], fromLog: SubagentRow[]): SubagentRow[] {
  const have = new Set(rows.map((r) => r.tool_use_id));
  const add = fromLog.filter((r) => !have.has(r.tool_use_id));
  return add.length === 0 ? rows : [...rows, ...add];
}

/** A New chat's rows, made before its id was known, given the id its
 *  first turn made. */
export function adoptPending(rows: SubagentRow[], session: string): void {
  for (const r of rows) if (r.session === null) r.session = session;
}
