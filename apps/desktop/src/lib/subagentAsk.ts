/**
 * Talking to a subagent directly (nightshift backlog 157, 2026-09-25) —
 * the pure half: what the adopted chat is sent, and how its first message
 * reads back.
 *
 * Measured first (report `c6-157-report-2026-09-25.md`): the CLI will not
 * resume a subagent's own session. `claude -p --resume <agent id>` is
 * refused ("not a UUID and does not match any session title"), and so is
 * the path of the child's `agent-<id>.jsonl` — a child's log is a
 * sidechain of the parent's session, not a session of its own. So this is
 * the item's option (2): the child's run is carried, as text, into a new
 * chat of the same project, in front of the first thing he asks it. From
 * then on that chat is an ordinary one: its CLI session holds the carried
 * run, and every later question resumes it. The parent's chat learns
 * nothing, which is the point.
 */
import type { Segment } from "./state.svelte";

/** The carried block's tags. The first user message of an adopted chat
 *  begins with the opening one; the transcript folds it (`splitAdopted`). */
export const ADOPT_OPEN = "<subagent-transcript";
export const ADOPT_CLOSE = "</subagent-transcript>";

/** How much of one tool result is carried, in characters. A child's reads
 *  can be whole files; the model gets the head and is told it was cut. */
export const RESULT_CARRY = 4000;
/** How much of the run is carried at most, in characters, keeping the
 *  task and the most recent part of the run — the same backstop size as
 *  an ephemeral chat's replay (`CARRY_LIMIT` in the service). */
export const RUN_CARRY = 200 * 1024;

/** What of a subagent's row the carry reads. */
export interface AdoptSource {
  tool_use_id: string;
  description: string;
  subagent_type: string;
  model?: string;
  prompt: string;
  segments: Segment[];
}

/** The key a subagent's notes, draft and adopted chat are kept under: the
 *  spawning call's id alone. It is unique across chats, and a New chat's
 *  row has no chat id until its first turn ends (`adoptPending`), so a key
 *  with the chat in it would orphan a note typed before then. */
export function agentKey(toolUseId: string): string {
  return toolUseId;
}

function attr(v: string): string {
  return v.replace(/[\r\n]+/g, " ").replace(/"/g, "'").slice(0, 200);
}

function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… [${(text.length - limit).toLocaleString("en-US")} more characters cut]`;
}

function runLines(segs: Segment[], depth: number, out: string[]): void {
  const pad = "  ".repeat(depth);
  for (const s of segs) {
    if (s.kind === "tool") {
      let input: string;
      try {
        input = JSON.stringify(s.call.input);
      } catch {
        input = String(s.call.input);
      }
      out.push(`${pad}[call ${s.call.name}] ${cut(input ?? "", RESULT_CARRY)}`);
      if (s.call.denied) {
        out.push(`${pad}[refused] ${s.call.result?.content ?? ""}`);
      } else if (s.call.result) {
        out.push(`${pad}[${s.call.result.is_error ? "error" : "result"}] ${cut(s.call.result.content, RESULT_CARRY)}`);
      } else {
        out.push(`${pad}[no result — the call was still open when the run ended]`);
      }
      if (s.call.children?.length) runLines(s.call.children, depth + 1, out);
    } else if (s.kind === "text") {
      if (s.text.trim()) out.push(`${pad}[said] ${s.text.trim()}`);
    } else if (s.kind === "notice") {
      out.push(`${pad}[notice] ${s.text}`);
    }
    // Thinking is left out: it is the model's scratch, and a replayed
    // thought would read as something the agent said.
  }
}

/**
 * The block an adopted chat's first message begins with: who the model
 * now is, the task it was given, and its run in order — each call with its
 * input and (cut) result, and its words. `parent` is the chat it ran in.
 */
export function carryOfSubagent(row: AdoptSource, parent: string | null): string {
  const lines: string[] = [];
  runLines(row.segments, 0, lines);
  let run = lines.join("\n");
  let cutNote = "";
  if (run.length > RUN_CARRY) {
    run = run.slice(run.length - RUN_CARRY);
    cutNote = " The earliest part of the run was cut to fit.";
  }
  // The spawning call first: it is what finds the chat again (`adoptedChatOf`).
  const head =
    `${ADOPT_OPEN} call="${attr(row.tool_use_id)}"` +
    ` agent="${attr(row.description || row.subagent_type || "subagent")}"` +
    ` type="${attr(row.subagent_type)}"` +
    (row.model ? ` model="${attr(row.model)}"` : "") +
    (parent ? ` parent_chat="${attr(parent)}"` : "") +
    ">";
  return [
    head,
    "You are continuing as the subagent whose whole run is below. Another chat (the parent) started it " +
      "with the task under Task; its calls, their results and its words follow in order. The parent is not " +
      "part of this conversation and will not see it. The person now talks to you directly: answer as that " +
      `agent, from what it did and found. Tool results longer than ${RESULT_CARRY.toLocaleString("en-US")} ` +
      `characters are cut.${cutNote} This is a replay, not a resume: your tools are this chat's, and the files ` +
      "may have changed since.",
    "",
    "## Task",
    row.prompt.trim() || "(the task was not recorded)",
    "",
    "## Run",
    run || "(it sent nothing back)",
    ADOPT_CLOSE,
  ].join("\n");
}

/** The first message of an adopted chat: the carry, then his words. */
export function adoptedPrompt(carry: string, text: string): string {
  return `${carry}\n\n${text}`;
}

/** An adopted chat's first message, taken apart for the transcript: the
 *  carried block (folded), the agent's name, the spawning call, and what
 *  he typed. Null `carried` for every other message. */
export function splitAdopted(text: string): {
  carried: string | null;
  agent: string | null;
  call: string | null;
  said: string;
} {
  if (!text.startsWith(ADOPT_OPEN)) return { carried: null, agent: null, call: null, said: text };
  const end = text.indexOf(ADOPT_CLOSE);
  if (end < 0) return { carried: null, agent: null, call: null, said: text };
  const carried = text.slice(0, end + ADOPT_CLOSE.length);
  const headEnd = carried.indexOf(">");
  const head = headEnd > 0 ? carried.slice(0, headEnd) : "";
  const agent = /agent="([^"]*)"/.exec(head)?.[1] ?? null;
  const call = /call="([^"]*)"/.exec(head)?.[1] ?? null;
  return { carried, agent, call, said: text.slice(end + ADOPT_CLOSE.length).replace(/^\s+/, "") };
}

/** The chat an agent was adopted into, found by its first message in the
 *  chat list — for when the window's own record of it is gone. */
export function adoptedChatOf(
  sessions: ReadonlyArray<{ id: string; first_user?: string | null }>,
  toolUseId: string,
): string | null {
  const mark = `${ADOPT_OPEN} call="${attr(toolUseId)}"`;
  return sessions.find((s) => typeof s.first_user === "string" && s.first_user.startsWith(mark))?.id ?? null;
}

/** The adopted chat's name in the sidebar: "↳ agent: " and the first line
 *  of the agent's description (else its task), kept short. */
export function adoptedTitle(row: Pick<AdoptSource, "description" | "prompt" | "subagent_type">): string {
  const source = (row.description || row.prompt || row.subagent_type || "subagent").trim();
  const first = source.split("\n")[0].trim();
  const short = first.length > 60 ? `${first.slice(0, 59).trimEnd()}…` : first;
  return `↳ agent: ${short}`;
}

/** One exchange of the adopted chat, for the agent's tab. */
export interface FollowUp {
  asked: string;
  answer: string;
}

/**
 * The adopted chat's exchanges, from its log, for the agent's tab: each
 * of his messages (the first without its carried block) with the text of
 * the replies that followed it. Rewound turns are not filtered here — the
 * tab is a view, the chat itself is the record.
 */
export function followUpsOf(
  events: ReadonlyArray<{ event: string; text?: string; blocks?: ReadonlyArray<{ type: string; text?: string }> }>,
): FollowUp[] {
  const out: FollowUp[] = [];
  for (const e of events) {
    if (e.event === "user_message" && typeof e.text === "string") {
      out.push({ asked: splitAdopted(e.text).said, answer: "" });
    } else if (e.event === "assistant_message" && out.length > 0 && e.blocks) {
      const words = e.blocks
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => (b.text as string).trim())
        .filter((t) => t.length > 0)
        .join("\n\n");
      if (words) {
        const last = out[out.length - 1];
        last.answer = last.answer ? `${last.answer}\n\n${words}` : words;
      }
    }
  }
  return out;
}
