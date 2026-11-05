/**
 * The agent's commands as a terminal's text (nightshift item 503, 2026-11-04):
 * a chat's recorded shell calls, in call order, on either engine. Built from
 * the log, so an old chat has them and a relaunch rebuilds them, and from the
 * live turn's segments, so a running turn is followed. Neither engine hands
 * Nightloom a command's output before it ends (503 report): a running command
 * shows as running, and its output lands whole.
 */
import type { Segment } from "./state.svelte";
import type { SessionEvent } from "./types";
import { shortToolName } from "./activity";
import { parseSubagentBlock } from "./subagent";
import { stripAnsi } from "./shellRun";

/** The calls that run a command: Claude Code's, the API engine's `bash`. */
const SHELL_TOOLS = new Set(["Bash", "bash", "PowerShell"]);
/** The calls that read or end a background command (Claude Code's). */
const BG_TOOLS = new Set(["BashOutput", "TaskOutput", "KillShell", "KillBash"]);

/** Whether a call belongs in the view: its transcript row offers the way in. */
export function isShellCall(name: string): boolean {
  const n = shortToolName(name);
  return SHELL_TOOLS.has(n) || BG_TOOLS.has(n);
}

export interface AgentCommand {
  id: string;
  command: string;
  /** Null while it runs. */
  output: string | null;
  error: boolean;
  /** The subagent that ran it. */
  agent: string | null;
  /** Its background id, when the call left it running. */
  background: string | null;
  /** Output read later by id, under this command. */
  later: { output: string; error: boolean }[];
  /** A recorded subagent's row keeps a first line only (`agent/record.rs`). */
  firstLineOnly?: boolean;
}

interface Call {
  id: string;
  name: string;
  input: unknown;
  result: { content: string; is_error: boolean } | null;
}

function field(input: unknown, keys: string[]): string | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  for (const k of keys) if (typeof o[k] === "string" && o[k]) return o[k] as string;
  return null;
}

/** The id a result says its command went on under, on any CLI so far. */
function backgroundId(input: unknown, content: string | undefined): string | null {
  if (!input || typeof input !== "object" || !(input as { run_in_background?: unknown }).run_in_background) return null;
  return /\bID:?\s*([\w-]+)/i.exec(content ?? "")?.[1] ?? null;
}

class Rows {
  rows: AgentCommand[] = [];
  private byId = new Map<string, AgentCommand>();
  private bg = new Map<string, AgentCommand>();

  call(c: Call, agent: string | null): void {
    const name = shortToolName(c.name);
    const known = this.byId.get(c.id);
    if (known) {
      // The live turn repeats a call the log has reached: it may know more.
      if (c.result && known.output === null) this.settle(known, c);
      return;
    }
    if (SHELL_TOOLS.has(name)) {
      const row: AgentCommand = {
        id: c.id,
        command: field(c.input, ["command", "cmd"]) ?? "(no command recorded)",
        output: null,
        error: false,
        agent,
        background: null,
        later: [],
      };
      this.byId.set(c.id, row);
      this.rows.push(row);
      if (c.result) this.settle(row, c);
      return;
    }
    if (!BG_TOOLS.has(name)) return;
    const bgId = field(c.input, ["bash_id", "task_id", "shell_id"]);
    const owner = bgId ? this.bg.get(bgId) : undefined;
    const content = c.result?.content ?? "";
    if (owner) {
      if (c.result) owner.later.push({ output: content, error: c.result.is_error });
      this.byId.set(c.id, owner);
      return;
    }
    const row: AgentCommand = {
      id: c.id,
      command: `(${name}${bgId ? ` ${bgId}` : ""})`,
      output: c.result ? content : null,
      error: !!c.result?.is_error,
      agent,
      background: null,
      later: [],
    };
    this.byId.set(c.id, row);
    this.rows.push(row);
  }

  private settle(row: AgentCommand, c: Call): void {
    row.output = c.result?.content ?? "";
    row.error = !!c.result?.is_error;
    row.background = backgroundId(c.input, c.result?.content);
    if (row.background) this.bg.set(row.background, row);
  }

  /** A recorded subagent's narrative: `▸ Bash <input>`, then `  ↳ <first line>`. */
  narrative(body: string, agent: string): void {
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const m = /^▸ (\S+) (.*)$/.exec(lines[i]);
      if (!m || !SHELL_TOOLS.has(shortToolName(m[1]))) continue;
      const next = /^ {2}↳ (error: )?(.*)$/.exec(lines[i + 1] ?? "");
      // The recorder joins an input's fields with ` · `: the command, its description.
      const cut = m[2].lastIndexOf(" · ");
      this.rows.push({
        id: `${agent}:${i}:${m[2]}`,
        command: cut > 0 ? m[2].slice(0, cut) : m[2],
        output: next ? next[2] : "",
        error: !!next?.[1],
        agent,
        background: null,
        later: [],
        firstLineOnly: true,
      });
    }
  }
}

function agentLabel(input: unknown): string {
  return field(input, ["subagent_type", "description"]) ?? "subagent";
}

function walkLive(segs: readonly Segment[], rows: Rows, agent: string | null): void {
  for (const s of segs) {
    if (s.kind !== "tool") continue;
    rows.call(s.call, agent);
    if (s.call.children) walkLive(s.call.children, rows, agentLabel(s.call.input));
  }
}

/** Every shell call of a chat, in call order. */
export function commandsOf(events: readonly SessionEvent[], live: readonly Segment[] | null = null): AgentCommand[] {
  const results = new Map<string, { content: string; is_error: boolean }>();
  const agents = new Map<string, string>();
  for (const e of events) {
    if (e.event === "tool_result") results.set(e.tool_use_id, { content: e.content, is_error: !!e.is_error });
  }
  const rows = new Rows();
  for (const e of events) {
    if (e.event !== "assistant_message") continue;
    for (const b of e.blocks) {
      if (b.type === "tool_use") {
        if (b.name === "Agent" || b.name === "Task") agents.set(b.id, agentLabel(b.input));
        rows.call({ id: b.id, name: b.name, input: b.input, result: results.get(b.id) ?? null }, null);
      } else if (b.type === "text") {
        const sub = parseSubagentBlock(b.text);
        if (sub) rows.narrative(sub.body, agents.get(sub.parent) ?? "subagent");
      }
    }
  }
  if (live) walkLive(live, rows, null);
  return rows.rows;
}

/** The commands still running. */
export function runningOf(rows: readonly AgentCommand[]): AgentCommand[] {
  return rows.filter((r) => r.output === null);
}

const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const OFF = "\x1b[0m";

/**
 * The text the view-only xterm shows, append-only as far as it can be: a
 * command's lines go in when it and every command before it have ended, so a
 * running command never has to be taken back out of the grid and his
 * selection and scroll stay put. What is running is said over the grid
 * (`runningOf`). With no turn running, a call that never got a result says so.
 */
export function commandsText(rows: readonly AgentCommand[], turnRunning: boolean): string {
  const out: string[] = [];
  for (const r of rows) {
    if (r.output === null && turnRunning) break;
    const label = r.agent ? `${DIM}[${r.agent}]${OFF} ` : "";
    const cmd = r.command.split("\n").join(`\n${BOLD}> ${OFF}`);
    out.push(`${label}${BOLD}$ ${cmd}${OFF}\n`);
    if (r.output === null) {
      out.push(`${DIM}[no result recorded: the call was open when the run ended]${OFF}\n\n`);
      continue;
    }
    const text = stripAnsi(r.output).trimEnd();
    if (text) out.push(`${r.error ? RED : ""}${text}${r.error ? OFF : ""}\n`);
    if (r.firstLineOnly) out.push(`${DIM}[first line only: a subagent's output is not kept whole]${OFF}\n`);
    if (r.error) out.push(`${RED}✗ failed${OFF}\n`);
    if (r.background) out.push(`${DIM}[left running in the background: ${r.background}]${OFF}\n`);
    for (const l of r.later) {
      out.push(`${DIM}── later output ──${OFF}\n`);
      const more = stripAnsi(l.output).trimEnd();
      if (more) out.push(`${l.error ? RED : ""}${more}${l.error ? OFF : ""}\n`);
    }
    out.push("\n");
  }
  return out.join("");
}
