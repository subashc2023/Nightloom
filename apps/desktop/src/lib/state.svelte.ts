import { listen } from "@tauri-apps/api/event";
import * as api from "./api";
import {
  defaultDraft,
  isProviderVisible,
  loadLastConnection,
  loadPrefs,
  modelsFor,
  sanitizeThinking,
  saveLastConnection,
  savePrefs,
  thinkingString,
  type CatalogPrefs,
} from "./catalog";
import type {
  ProviderInfo,
  SessionEvent,
  SessionMeta,
  TodoItem,
  TurnEvent,
  Usage,
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
  /** Context window of the connected model; null when unknown. */
  contextLimit: number | null;
  /** Resolved workspace root the file tools operate in. */
  workspace: string;
}

export const app = $state({
  providers: [] as ProviderInfo[],
  /** Which providers/models the rail dropdowns offer (settings modal edits this). */
  prefs: loadPrefs() as CatalogPrefs,
  /** The rail's connection settings; any change re-connects via applyDraft(). */
  draft: defaultDraft(),
  connection: null as Connection | null,
  connecting: false,
  /** Last connect failure, shown in the rail until the next attempt. */
  connectError: null as string | null,
  sessions: [] as SessionMeta[],
  activeSessionId: null as string | null,
  /** Source of truth for the transcript (re-synced from the backend after each turn). */
  events: [] as SessionEvent[],
  /** In-progress assistant turn built from turn-events; null when idle. */
  live: null as { segments: Segment[] } | null,
  /** Bumped on every turn-event so effects (auto-scroll) can depend on stream progress. */
  liveVersion: 0,
  /**
   * Newest per-round usage from the in-flight turn. Cleared when the turn
   * ends, at which point `contextUsed()` reads the same number back off the
   * trailing assistant message instead.
   */
  liveUsage: null as Usage | null,
  busy: false,
  /** Error banner shown in the transcript until the next send. */
  error: null as string | null,
  /** Settings modal (providers: API keys, model visibility). */
  showSettings: false,
  /** Live model lists fetched from provider APIs, per provider kind. */
  modelLists: {} as Record<string, string[]>,
  /** Fetch status per provider kind (settings modal UI). */
  modelFetch: {} as Record<string, { loading: boolean; error: string | null }>,
  toasts: [] as { id: number; text: string }[],
});

let initialized = false;

export async function init(): Promise<void> {
  if (initialized) return;
  initialized = true;
  await listen<TurnEvent>("turn-event", (e) => applyTurnEvent(e.payload));
  await listen<string>("turn-notice", (e) => addToast(e.payload));
  const last = loadLastConnection();
  if (last) {
    app.draft = last;
    sanitizeThinking(app.draft);
  }
  try {
    app.providers = await api.providers();
  } catch (e) {
    app.error = String(e);
  }
  await refreshSessions();
  await autoConnect();
}

/** A provider the backend can actually construct a client for right now. */
export function usable(p: ProviderInfo): boolean {
  // openai-chat can point at a local server without an API key.
  return p.available || (p.kind === "openai-chat" && app.draft.baseUrl.trim() !== "");
}

/** Connect on launch: last-used provider if still usable, else the first that is. */
async function autoConnect(): Promise<void> {
  let target = app.providers.find((p) => p.kind === app.draft.provider);
  if (!target || !usable(target)) {
    target =
      app.providers.find((p) => isProviderVisible(p.kind, app.prefs) && usable(p)) ??
      app.providers.find(usable);
    if (!target) return; // nothing usable — the rail shows why
    app.draft.provider = target.kind;
    app.draft.model = "";
  }
  if (!app.draft.model) {
    const models = modelsFor(target.kind, app.prefs, target.default_model);
    app.draft.model = target.default_model ?? models[0] ?? "";
  }
  if (!app.draft.model) return; // e.g. openai-chat before a model is chosen
  await applyDraft();
}

/** (Re)connect with the rail's current settings. Called on every rail change. */
export async function applyDraft(): Promise<void> {
  const d = app.draft;
  if (!d.provider || app.busy || app.connecting) return;
  sanitizeThinking(d); // a saved draft may hold a mode this target rejects
  app.connecting = true;
  app.connectError = null;
  try {
    const res = await api.connect({
      provider: d.provider,
      model: d.model.trim() || undefined,
      baseUrl: d.baseUrl.trim() || undefined,
      thinking: thinkingString(d),
      system: d.system.trim() || undefined,
      tools: d.tools,
      preamble: d.preamble,
      sidecar: d.sidecar,
      workspace: d.workspace.trim() || undefined,
    });
    app.connection = {
      provider: res.provider,
      model: res.model,
      thinking: thinkingString(d),
      tools: d.tools,
      contextLimit: res.context_limit ?? null,
      workspace: res.workspace,
    };
    if (!d.model.trim()) d.model = res.model; // backend resolved the default
    saveLastConnection({ ...d });
  } catch (e) {
    // The backend keeps the previous Chat on failure, so app.connection
    // (if any) is still accurate — just surface the error.
    app.connectError = String(e);
  } finally {
    app.connecting = false;
  }
}

/** Re-query provider availability (after storing/clearing an API key). */
export async function refreshProviders(): Promise<void> {
  try {
    app.providers = await api.providers();
  } catch {
    // availability refresh is best-effort
  }
}

/** Fetch a provider's live model list (cached until `force`). */
export async function fetchModels(kind: string, force = false): Promise<void> {
  if (!force && app.modelLists[kind]) return;
  const status = (app.modelFetch[kind] ??= { loading: false, error: null });
  if (status.loading) return;
  status.loading = true;
  status.error = null;
  try {
    const baseUrl =
      kind === "openai-chat" ? app.draft.baseUrl.trim() || undefined : undefined;
    app.modelLists[kind] = await api.listModels(kind, baseUrl);
  } catch (e) {
    status.error = String(e);
  } finally {
    status.loading = false;
  }
}

/** Mutate catalog prefs and persist them. */
export function setPrefs(mutate: (p: CatalogPrefs) => void): void {
  mutate(app.prefs);
  savePrefs(JSON.parse(JSON.stringify(app.prefs)) as CatalogPrefs);
}

export async function refreshSessions(): Promise<void> {
  try {
    app.sessions = await api.listSessions();
  } catch {
    // sidebar refresh is best-effort
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

/** Compact the active session: earlier turns collapse into a summary. */
export async function compactSession(): Promise<void> {
  if (!app.connection || app.busy) return;
  app.busy = true;
  app.error = null;
  try {
    const res = await api.compact();
    if (res.interrupted) {
      addToast("compaction cancelled — session unchanged");
    } else {
      addToast("session compacted");
      app.events = await api.transcript();
    }
  } catch (e) {
    app.error = String(e);
  } finally {
    app.busy = false;
    void refreshSessions();
  }
}

export async function deleteSession(id: string): Promise<void> {
  if (app.busy) return;
  try {
    await api.deleteSession(id);
    if (id === app.activeSessionId) {
      app.activeSessionId = null;
      app.events = [];
    }
  } catch (e) {
    addToast(String(e));
  }
  await refreshSessions();
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
  app.liveUsage = null;
  app.busy = true;
  try {
    await api.send(text);
  } catch (e) {
    app.error = String(e);
  } finally {
    app.live = null;
    // The trailing assistant message now carries the same reading.
    app.liveUsage = null;
    app.busy = false;
    try {
      app.events = await api.transcript();
      // Sessions are created lazily on first send; pick up the id.
      const first = app.events[0];
      if (first && first.event === "session_created") {
        app.activeSessionId = first.id;
      }
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
  if (ev.type === "usage") {
    app.liveUsage = ev.usage;
    return;
  }
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

/**
 * The model's current task list, projected from the log exactly the way
 * `Session::todos()` projects it in the core: latest snapshot wins, and a
 * compaction clears it — the summary supersedes the plan that produced it,
 * so a stale list must not outlive the work it described.
 */
export function currentTodos(): TodoItem[] {
  for (let i = app.events.length - 1; i >= 0; i--) {
    const e = app.events[i];
    if (e.event === "todo_state") return e.todos;
    if (e.event === "compaction") return [];
  }
  return [];
}

/**
 * Tokens the next request will carry as its prefix: the newest round's
 * input plus output. Deliberately not the running total, which counts the
 * prefix once per round and would race past the window while the real
 * context sat half empty.
 */
export function contextUsed(): number | null {
  const u = app.liveUsage ?? lastAssistantUsage();
  return u ? u.input_tokens + u.output_tokens : null;
}

function lastAssistantUsage(): Usage | null {
  for (let i = app.events.length - 1; i >= 0; i--) {
    const e = app.events[i];
    if (e.event === "assistant_message") return e.usage;
  }
  return null;
}
