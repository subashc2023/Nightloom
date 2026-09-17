/**
 * The phone page's pure half (nightshift backlog 091, Shape B): the token
 * from the QR's link, the API calls, the event stream's parser, the fold of
 * a live turn, the transcript's rows, and the queue for messages typed
 * while the Mac is unreachable. Nothing here touches the DOM, so all of it
 * is under `client.test.ts`; `Remote.svelte` is the screen over it.
 */
import type { ApprovalRequest, SessionEvent, TurnEvent } from "../lib/types";

export const TOKEN_KEY = "nightloom.remote.token";
export const QUEUE_KEY = "nightloom.remote.queue";

// ---- the token ----------------------------------------------------------

/**
 * The token the QR carries: `#token=<hex>` on the page's URL. A fragment
 * never leaves the browser — not in the request, not in Safari's history
 * sync, not in a referer — which is why it rides there and not in a query.
 */
export function tokenFromHash(hash: string): string | null {
  const m = /(?:^#|[#&])token=([0-9a-fA-F]{16,128})(?:&|$)/.exec(hash);
  return m ? m[1].toLowerCase() : null;
}

export function loadToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function saveToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private mode, or storage off: the token lives for this page load only.
  }
}

// ---- the API ------------------------------------------------------------

/** What `/api/state` answers — `RemoteState` in the service crate. */
export interface RemoteState {
  project: string | null;
  active_chat: string | null;
  busy: boolean;
  connected: boolean;
  engine: string | null;
  pending: ApprovalRequest[];
}

/** One row of `/api/chats` — `ChatRow` in the service crate. */
export interface ChatRow {
  id: string;
  label: string;
  modified: string;
  user_turns: number;
  kind: string;
  mode: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Thrown when the Mac could not be reached at all — the queue's cue. */
export class Unreachable extends Error {}

export class Client {
  constructor(public token: string) {}

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    let r: Response;
    try {
      r = await fetch(`/api${path}`, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          Authorization: `Bearer ${this.token}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
        cache: "no-store",
      });
    } catch (e) {
      throw new Unreachable(String(e));
    }
    if (!r.ok) throw new ApiError(r.status, (await r.text()) || r.statusText);
    return r;
  }

  async state(): Promise<RemoteState> {
    return (await this.call("/state")).json();
  }

  async chats(): Promise<ChatRow[]> {
    return (await this.call("/chats")).json();
  }

  async transcript(id: string): Promise<SessionEvent[]> {
    return (await this.call(`/chats/${encodeURIComponent(id)}/transcript`)).json();
  }

  /** 202: the turn runs on the Mac — or, `"queued"`, waits behind the one
   *  running in that chat and goes when it ends (backlog 132). A 409 is
   *  the desktop's sentence for not taking it, and the text is ours to
   *  keep. */
  async send(chat: string | null, text: string): Promise<"sent" | "queued"> {
    const path = chat ? `/chats/${encodeURIComponent(chat)}/send` : "/send";
    const r = await this.call(path, { method: "POST", body: JSON.stringify({ text }) });
    return parseSendReply(await r.text());
  }

  async approve(req: {
    id: string;
    name: string;
    decision: "allow" | "always" | "deny";
    reason?: string;
    answer?: unknown;
    then?: "ask" | "auto";
  }): Promise<void> {
    await this.call("/approve", { method: "POST", body: JSON.stringify(req) });
  }

  async cancel(): Promise<void> {
    await this.call("/cancel", { method: "POST" });
  }

  /**
   * The event stream, read with `fetch` rather than `EventSource` because
   * the latter cannot send a header and the token must not go in the URL.
   * Resolves when the stream ends (the listener went off, or the network
   * dropped); the caller reconnects.
   */
  async events(onEvent: (name: string, data: string) => void, signal?: AbortSignal): Promise<void> {
    const r = await this.call("/events", { headers: { Accept: "text/event-stream" }, signal });
    if (!r.body) throw new Unreachable("no stream body");
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    const parser = new SseParser();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const ev of parser.push(decoder.decode(value, { stream: true }))) onEvent(ev.name, ev.data);
    }
  }
}

// ---- the stream's parser -------------------------------------------------

export interface SseEvent {
  name: string;
  data: string;
}

/**
 * Server-sent events, the wire format only: `event:` and `data:` lines,
 * a blank line ends one event, `:` lines are comments (the keep-alive).
 * Several `data:` lines join with newlines, as the spec says.
 */
export class SseParser {
  private buf = "";

  push(chunk: string): SseEvent[] {
    this.buf += chunk;
    const out: SseEvent[] = [];
    for (;;) {
      const at = this.buf.search(/\r?\n\r?\n/);
      if (at < 0) break;
      const block = this.buf.slice(0, at);
      this.buf = this.buf.slice(at).replace(/^\r?\n\r?\n/, "");
      let name = "message";
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (!line || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        let value = colon < 0 ? "" : line.slice(colon + 1);
        if (value.startsWith(" ")) value = value.slice(1);
        if (field === "event") name = value;
        else if (field === "data") data.push(value);
      }
      if (data.length > 0 || name !== "message") out.push({ name, data: data.join("\n") });
    }
    return out;
  }
}

// ---- the live turn --------------------------------------------------------

export interface ToolRow {
  id: string;
  name: string;
  /** One line of the call's input: a command, a path, a query. */
  summary: string;
  /** `null` while running; then whether it succeeded. */
  ok: boolean | null;
  /** Rows of a subagent's own turn, under the `Agent` call that spawned it. */
  children: ToolRow[];
}

/** The reply as it streams: text so far and the calls made, in order. */
export interface LiveTurn {
  text: string;
  tools: ToolRow[];
  /** The model compacted mid-turn; the transcript re-reads at the end. */
  compacted: boolean;
}

export function emptyTurn(): LiveTurn {
  return { text: "", tools: [], compacted: false };
}

/** One line of a tool call's input, the way the desktop's row reads it. */
export function toolSummary(name: string, input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return "";
  };
  let s = "";
  switch (name) {
    case "Bash":
      s = pick("command");
      break;
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      s = pick("file_path", "path", "notebook_path");
      break;
    case "Grep":
    case "Glob":
      s = pick("pattern");
      break;
    case "WebFetch":
      s = pick("url");
      break;
    case "WebSearch":
      s = pick("query");
      break;
    case "Agent":
    case "Task":
      s = pick("description", "prompt");
      break;
    default:
      s = pick("command", "path", "file_path", "pattern", "query", "url", "description", "prompt");
  }
  s = s.replace(/\s+/g, " ");
  return s.length > 120 ? s.slice(0, 117) + "…" : s;
}

function findTool(rows: ToolRow[], id: string): ToolRow | null {
  for (const r of rows) {
    if (r.id === id) return r;
    const c = findTool(r.children, id);
    if (c) return c;
  }
  return null;
}

/**
 * Fold one `turn-event` into the live turn. Returns a new object so a
 * Svelte state assignment sees the change. Events the phone does not draw
 * (thinking, usage, the CLI's init line, the prompt suggestion) leave it
 * as it was.
 */
export function foldTurnEvent(live: LiveTurn, ev: TurnEvent): LiveTurn {
  switch (ev.type) {
    case "text_delta":
      return { ...live, text: live.text + ev.text };
    case "tool_call":
      return {
        ...live,
        tools: [...live.tools, { id: ev.id, name: ev.name, summary: toolSummary(ev.name, ev.input), ok: null, children: [] }],
      };
    case "tool_result": {
      const tools = structuredClone(live.tools);
      const row = findTool(tools, ev.tool_use_id);
      if (row) row.ok = !ev.is_error;
      return { ...live, tools };
    }
    case "tool_denied": {
      const tools = structuredClone(live.tools);
      const row = findTool(tools, ev.tool_use_id);
      if (row) row.ok = false;
      return { ...live, tools };
    }
    case "compacted":
      return { ...live, compacted: true };
    case "subagent": {
      const tools = structuredClone(live.tools);
      const parent = findTool(tools, ev.parent_tool_use_id);
      if (!parent) return live;
      const inner = foldTurnEvent({ text: "", tools: parent.children, compacted: false }, ev.event);
      parent.children = inner.tools;
      return { ...live, tools };
    }
    default:
      return live;
  }
}

// ---- the transcript ---------------------------------------------------------

export type Row =
  | { kind: "user"; text: string; at: string }
  | { kind: "assistant"; model: string; text: string; tools: ToolRow[]; at: string }
  | { kind: "note"; text: string; at: string };

/**
 * Which events are live after the log's rewind markers: a `rewind` at
 * index `i` with `to` supersedes `[to, i)`; an `unrewind` of `i` lifts it.
 * The desktop's `liveFlags` in full; this is its shape without the elide
 * and edit markers, which the phone draws through.
 */
export function liveFlags(events: SessionEvent[]): boolean[] {
  const live = events.map(() => true);
  const rewinds: { at: number; to: number }[] = [];
  events.forEach((e, i) => {
    if (e.event === "rewind") {
      rewinds.push({ at: i, to: e.to });
      for (let k = e.to; k < i; k++) live[k] = false;
      live[i] = false;
    } else if (e.event === "unrewind") {
      const r = rewinds.find((x) => x.at === e.of);
      if (r) for (let k = r.to; k < r.at; k++) live[k] = true;
      live[i] = false;
    }
  });
  return live;
}

/** The transcript as the phone draws it: one row per turn, tool calls as
 *  lines under the reply that made them, results matched by id. */
export function transcriptRows(events: SessionEvent[]): Row[] {
  const live = liveFlags(events);
  const rows: Row[] = [];
  const byTool = new Map<string, ToolRow>();
  events.forEach((e, i) => {
    if (!live[i]) return;
    switch (e.event) {
      case "user_message":
        rows.push({ kind: "user", text: e.text, at: e.at });
        break;
      case "assistant_message": {
        const texts: string[] = [];
        const tools: ToolRow[] = [];
        for (const b of e.blocks) {
          if (b.type === "text") texts.push(b.text);
          else if (b.type === "tool_use") {
            const row: ToolRow = { id: b.id, name: b.name, summary: toolSummary(b.name, b.input), ok: null, children: [] };
            tools.push(row);
            byTool.set(b.id, row);
          }
        }
        // Consecutive replies with no user turn between draw as one (the
        // desktop's backlog 121): the blocks join the row above.
        const last = rows[rows.length - 1];
        if (last && last.kind === "assistant") {
          last.text = [last.text, ...texts].filter(Boolean).join("\n\n");
          last.tools.push(...tools);
          last.at = e.at;
        } else {
          rows.push({ kind: "assistant", model: e.model, text: texts.join("\n\n"), tools, at: e.at });
        }
        break;
      }
      case "tool_result": {
        const row = byTool.get(e.tool_use_id);
        if (row) row.ok = !e.is_error;
        break;
      }
      case "compaction":
        rows.push({ kind: "note", text: "compacted — earlier turns are summarised for the model", at: e.at });
        break;
      default:
        break;
    }
  });
  return rows;
}

// ---- the queue ------------------------------------------------------------

/** A message typed while the Mac was unreachable or busy, waiting. */
export interface Queued {
  id: string;
  chat: string | null;
  text: string;
  at: string;
}

export function loadQueue(): Queued[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (q): q is Queued =>
        q !== null &&
        typeof q === "object" &&
        typeof (q as Queued).id === "string" &&
        typeof (q as Queued).text === "string" &&
        (q as Queued).text.trim() !== "",
    );
  } catch {
    return [];
  }
}

export function saveQueue(queue: Queued[]): void {
  try {
    if (queue.length === 0) localStorage.removeItem(QUEUE_KEY);
    else localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Storage off: the queue lives for this page load only.
  }
}

let seq = 0;
export function newQueued(chat: string | null, text: string, now = new Date()): Queued {
  seq += 1;
  return { id: `${now.getTime().toString(36)}-${seq}`, chat, text, at: now.toISOString() };
}

// ---- the cards --------------------------------------------------------------

/** The card a prompt draws, by the tool the CLI paused on. */
export function cardKind(req: ApprovalRequest): "question" | "plan" | "call" {
  if (req.name === "AskUserQuestion") return "question";
  if (req.name === "ExitPlanMode") return "plan";
  return "call";
}

/**
 * The question form's answer: the input plus `answers`, question text →
 * the chosen labels joined with ", " and "Other" as typed — the shape
 * `ApprovalPrompt.svelte`'s `answerQuestions` sends.
 */
export function questionAnswer(
  input: unknown,
  picks: Record<number, string[]>,
  others: Record<number, string>,
): unknown {
  const qs = (input as { questions?: { question: string }[] } | null)?.questions ?? [];
  const answers: Record<string, string> = {};
  qs.forEach((q, i) => {
    const chosen = [...(picks[i] ?? [])];
    const other = (others[i] ?? "").trim();
    if (other) chosen.push(other);
    answers[q.question] = chosen.join(", ");
  });
  return { ...(input as object), answers };
}

/** The plan card's "keep planning" reason, the desktop's own words. */
export const KEEP_PLANNING = "keep planning: the user wants changes to the plan";

/** The reconnect wait after `n` failures: 1 s, 2 s, 4 s, … capped at 15 s. */
export function backoffMs(n: number): number {
  return Math.min(15000, 1000 * 2 ** Math.max(0, Math.min(n, 4)));
}

/** The 202's body: `{"status":"queued"}` or `{"status":"sent"}`; a bare or
 *  unreadable body (a listener from before backlog 132) reads as sent. */
export function parseSendReply(body: string): "sent" | "queued" {
  try {
    const v = JSON.parse(body) as { status?: unknown };
    return v && v.status === "queued" ? "queued" : "sent";
  } catch {
    return "sent";
  }
}
