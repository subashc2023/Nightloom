import { listen } from "@tauri-apps/api/event";
import * as api from "./api";
import type {
  ConnectArgs,
  ProviderInfo,
  SessionEvent,
  SessionMeta,
  TurnEvent,
} from "./types";

export interface ToolCallView {
  id: string;
  name: string;
  input: unknown;
  result: { content: string; is_error: boolean } | null;
}

/**
 * Normalized assistant-message segment, used both for the live streaming
 * message and for completed messages projected from SessionEvents.
 */
export type Segment =
  | { kind: "thinking"; text: string; done: boolean }
  | { kind: "redacted" }
  | { kind: "text"; text: string }
  | { kind: "tool"; call: ToolCallView }
  | { kind: "notice"; text: string };

export interface Connection {
  provider: string;
  model: string;
  thinking: string;
  tools: boolean;
}

export const app = $state({
  providers: [] as ProviderInfo[],
  connection: null as Connection | null,
  sessions: [] as SessionMeta[],
  activeSessionId: null as string | null,
  /** Source of truth for the transcript (re-synced from the backend after each turn). */
  events: [] as SessionEvent[],
  /** In-progress assistant turn built from turn-events; null when idle. */
  live: null as { segments: Segment[] } | null,
  /** Bumped on every turn-event so effects (auto-scroll) can depend on stream progress. */
  liveVersion: 0,
  busy: false,
  /** Error banner shown in the transcript until the next send. */
  error: null as string | null,
  showSettings: true,
  toasts: [] as { id: number; text: string }[],
});

let initialized = false;

export async function init(): Promise<void> {
  if (initialized) return;
  initialized = true;
  await listen<TurnEvent>("turn-event", (e) => applyTurnEvent(e.payload));
  await listen<string>("turn-notice", (e) => addToast(e.payload));
  try {
    app.providers = await api.providers();
  } catch (e) {
    app.error = String(e);
  }
  await refreshSessions();
}

export async function refreshSessions(): Promise<void> {
  try {
    app.sessions = await api.listSessions();
  } catch {
    // sidebar refresh is best-effort
  }
}

export async function connect(args: ConnectArgs): Promise<void> {
  const res = await api.connect(args);
  app.connection = {
    provider: res.provider,
    model: res.model,
    thinking: args.thinking ?? "default",
    tools: args.tools,
  };
  app.showSettings = false;
  if (app.events.length === 0) {
    try {
      app.events = await api.transcript();
    } catch {
      // no active session yet
    }
  }
}

export async function newSession(): Promise<void> {
  if (app.busy) return;
  try {
    const { id } = await api.newSession();
    app.activeSessionId = id;
    app.events = [];
    app.error = null;
    await refreshSessions();
  } catch (e) {
    app.error = String(e);
  }
}

export async function openSession(id: string): Promise<void> {
  if (app.busy) return;
  try {
    app.events = await api.openSession(id);
    app.activeSessionId = id;
    app.error = null;
  } catch (e) {
    app.error = String(e);
  }
}

export async function send(text: string): Promise<void> {
  if (!app.connection || app.busy) return;
  app.error = null;
  app.events.push({
    event: "user_message",
    text,
    at: new Date().toISOString(),
  });
  app.live = { segments: [] };
  app.busy = true;
  try {
    await api.send(text);
  } catch (e) {
    app.error = String(e);
  } finally {
    app.live = null;
    app.busy = false;
    try {
      app.events = await api.transcript();
    } catch {
      // keep the locally-built view if re-sync fails
    }
    void refreshSessions();
  }
}

export async function cancelTurn(): Promise<void> {
  try {
    await api.cancel();
  } catch (e) {
    addToast(String(e));
  }
}

let toastSeq = 0;

export function addToast(text: string): void {
  const id = ++toastSeq;
  app.toasts.push({ id, text });
  setTimeout(() => {
    const i = app.toasts.findIndex((t) => t.id === id);
    if (i >= 0) app.toasts.splice(i, 1);
  }, 5000);
}

/** Mark a trailing in-progress thinking segment as complete (collapses its pill). */
function closeThinking(segments: Segment[]): void {
  const last = segments[segments.length - 1];
  if (last && last.kind === "thinking") last.done = true;
}

function applyTurnEvent(ev: TurnEvent): void {
  if (!app.live) return;
  const segments = app.live.segments;
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
        segments.push({ kind: "thinking", text: ev.text, done: false });
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
    case "round_limit":
      closeThinking(segments);
      segments.push({
        kind: "notice",
        text: `tool round limit reached (${ev.rounds} rounds)`,
      });
      break;
    default:
      // Unknown turn-event types are ignored by contract.
      break;
  }
  app.liveVersion++;
}
