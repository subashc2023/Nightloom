// Moved out of state.svelte.ts by item 641 (pure move; state.svelte.ts re-exports every name it exported).
import { latestAgents, rowsOf } from "../subagentRows";
import type { TodoItem, TurnEvent } from "../types";
import { type ToolCallView, type SubagentRow, type Segment, app, closeThinking, liveFlags } from "../state.svelte";

/** The Running-tasks row for the `Agent` call `id`, if the CLI has
 *  announced it (backlog 152). */
export function subagentRow(id: string): SubagentRow | null {
  return app.subagents.find((r) => r.tool_use_id === id) ?? null;
}

/**
 * The translator's whole row each time (backlog 152): replace the figures,
 * keep what the window holds beside them. `session` is the chat it runs in
 * (backlog 160); a row rebuilt from the log is live again once the CLI
 * speaks of it.
 */
export function upsertSubagentRow(ev: Extract<TurnEvent, { type: "subagent_status" }>, session: string | null): void {
  const { type: _type, chat: _chat, ...status } = ev as typeof ev & { chat?: string };
  const row = subagentRow(status.tool_use_id);
  const now = Date.now();
  if (row) {
    Object.assign(row, status, { updatedAt: now, restored: false });
    row.session ??= session;
  } else {
    app.subagents.push({
      ...status,
      session,
      turn: app.turnSeq,
      startedAt: now,
      updatedAt: now,
      segments: [],
    });
  }
}

/** The open chat's rows (backlog 160), for the Running-tasks panel. */
export function openChatSubagents(): SubagentRow[] {
  return rowsOf(app.subagents, app.activeSessionId);
}

/** The chip's rows (backlog 160): the open chat's latest turn that had
 *  agents, kept after they finish. */
export function latestSubagents(): { rows: SubagentRow[]; running: number; tokens: number } {
  return latestAgents(app.subagents, app.activeSessionId);
}

/** Whether a subagent is still running (backlog 152). */
export function subagentRunning(r: SubagentRow): boolean {
  return r.status === "running";
}

/**
 * The latest turn's subagents and their tokens (backlog 152), for the
 * top bar's chip and the gauge's "+ subagents" line: the CLI's figure per
 * agent — the latest round's whole request and response, what the Claude
 * app's panel shows — summed. Not in the window figure, which is the
 * main thread's alone; said beside it rather than added to it, since a
 * child's context is its own and not the next request's.
 */
export function subagentsOfTurn(): { rows: SubagentRow[]; running: number; tokens: number } {
  // The open chat's alone since rows are kept per chat (backlog 160).
  const rows = app.subagents.filter((r) => r.turn === app.turnSeq && r.session === app.activeSessionId);
  return {
    rows,
    running: rows.filter(subagentRunning).length,
    tokens: rows.reduce((n, r) => n + r.tokens, 0),
  };
}

/** The tool call with `id` among `segments`, or under any call's subagent. */
export function findCall(segments: Segment[], id: string): ToolCallView | null {
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i];
    if (seg.kind !== "tool") continue;
    if (seg.call.id === id) return seg.call;
    if (seg.call.children) {
      const inner = findCall(seg.call.children, id);
      if (inner) return inner;
    }
  }
  return null;
}

/**
 * Apply one content event to a list of segments — the live reply's, or a
 * subagent's under its parent call (backlog 075). One function for both
 * so a child's text, thinking and calls accumulate exactly as the main
 * thread's do.
 */
export function applyToSegments(segments: Segment[], ev: TurnEvent): void {
  const last = segments[segments.length - 1];
  switch (ev.type) {
    case "text_delta":
      if (last && last.kind === "text") {
        last.text += ev.text;
      } else {
        closeThinking(segments);
        segments.push({ kind: "text", text: ev.text });
      }
      break;
    case "thinking_delta":
      if (last && last.kind === "thinking" && !last.done) {
        last.text += ev.text;
      } else {
        segments.push({ kind: "thinking", text: ev.text, done: false, at: Date.now() });
      }
      break;
    case "redacted_thinking":
      closeThinking(segments);
      segments.push({ kind: "redacted" });
      break;
    case "tool_call":
      closeThinking(segments);
      segments.push({
        kind: "tool",
        call: { id: ev.id, name: ev.name, input: ev.input, result: null },
      });
      break;
    case "tool_result":
      for (let i = segments.length - 1; i >= 0; i--) {
        const seg = segments[i];
        if (seg.kind === "tool" && seg.call.id === ev.tool_use_id) {
          seg.call.result = { content: ev.content, is_error: ev.is_error };
          break;
        }
      }
      break;
    case "tool_denied":
      // No tool_result follows a denial, so the call would otherwise render
      // as in-flight until the post-turn re-sync replaced the whole message.
      for (let i = segments.length - 1; i >= 0; i--) {
        const seg = segments[i];
        if (seg.kind === "tool" && seg.call.id === ev.tool_use_id) {
          seg.call.denied = true;
          seg.call.result = { content: ev.reason, is_error: true };
          break;
        }
      }
      break;
    default:
      break;
  }
}

const DENIAL_PREFIX = "The user refused permission to run ";
const DENIAL_REASON = "They said: ";

/**
 * Recognize a refused call in a re-synced `tool_result`, returning its
 * reason ("" when none was given) or null if it is an ordinary failure.
 *
 * A denial is logged as a plain error result because that is what the model
 * must read it as, so the message itself is the only marker. Reading it back
 * is what keeps "you said no" from rendering as "the tool crashed" once the
 * live buffer is replaced; a message that doesn't match still renders as the
 * error it already was.
 */
export function denialReason(content: string, isError: boolean): string | null {
  if (!isError || !content.startsWith(DENIAL_PREFIX)) return null;
  const line = content.split("\n").find((l) => l.startsWith(DENIAL_REASON));
  return line ? line.slice(DENIAL_REASON.length) : "";
}

/**
 * The model's current task list, projected from the log exactly the way
 * `Session::todos()` projects it in the core: latest snapshot wins, and a
 * compaction clears it — the summary supersedes the plan that produced it,
 * so a stale list must not outlive the work it described.
 */
export function currentTodos(): TodoItem[] {
  const live = liveFlags(app.events);
  for (let i = app.events.length - 1; i >= 0; i--) {
    if (!live[i]) continue;
    const e = app.events[i];
    if (e.event === "todo_state") return e.todos;
    if (e.event === "compaction") return [];
  }
  return [];
}
