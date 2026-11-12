// Moved out of state.svelte.ts by item 641 (pure move; state.svelte.ts re-exports every name it exported).
import * as api from "../api";
import { modelInstructionFile } from "../catalog";
import { EDITABLE_LAYERS, type NoteScope, type EditableLayer, type PromptLayer, type PromptLayerEdits, type SessionEvent } from "../types";
import { chatIsCold, reconnectBeforeTurn, saveLayerPrefs } from "../promptVersions";
import { showNote, currentModelId, noteDraftKey } from "./notes.svelte";
import { chatScope, pushUndo } from "./edits.svelte";
import { app, chatChoice, applyTimer, lastSent, sentKey, restoreChatChoice, applyDraft, applyAgentDraft, filesChangedGen, filesSeenGen, refreshSessions, pendingChatKey, adoptCreatedChat, writePendingThread, promoteThreadText, addToast, liveFlags } from "../state.svelte";

/**
 * Before an agent turn (nightshift backlog 174): reconnect when the engine
 * was built for another chat, or when this chat's cache is cold and a
 * *newer version exists* mark is taken then — never on a warm cache.
 */
export async function layersBeforeTurn(): Promise<void> {
  // A file kept in the project since the connect (item 306): a New chat's
  // first turn would go with the listing built before it, so it connects
  // again — nothing is cached yet, so it rewrites nothing.
  if (filesChangedGen !== filesSeenGen && app.activeSessionId === null && !app.busy && !app.connecting) {
    await applyAgentDraft();
    return;
  }
  // A New chat's first turn hands its connection to the chat it created
  // (`bind_new_chat` in Rust): read that back rather than reconnect for it.
  if (app.promptPending && app.promptPending.session === null && app.activeSessionId !== null) {
    app.promptPending = await api.promptPending().catch(() => app.promptPending);
  }
  const cold = chatIsCold(app.events, Date.now());
  if (!reconnectBeforeTurn(app.promptPending, app.activeSessionId, cold, app.layerPrefs.autoAtCold)) return;
  if (app.busy || app.connecting) return;
  await applyAgentDraft();
}

/**
 * Re-read which layers have a newer file (backlog 174; night batch F,
 * 2026-09-26, measured): the marks are computed at a connect, and a file
 * edited outside the app — his editor, the model's `remember`, another
 * chat's save — triggers none, so the Context page showed no mark for it.
 * Called when the Context page opens. A reconnect on a warm chat sends the
 * held text byte for byte (Rust `prompt_hold::resolve`), so it rewrites no
 * cache; ~~on a cold chat it takes what the choices allow, as the next turn
 * would~~ (struck 2026-09-26, review RF: under the Auto default that took
 * the newer file the moment he opened the page on a cold chat, before he
 * could see the mark and click *Keep this version* — the one place Keep
 * lives). It now only looks: the connect goes out as warm, so nothing is
 * taken here; the next cold turn takes what the choices then allow
 * (`reconnectBeforeTurn`). Never during a turn or a connect, never for
 * New chat.
 */
export async function refreshLayerVersions(): Promise<void> {
  if (app.busy || app.connecting || app.connection?.engine !== "claude-code") return;
  if (app.activeSessionId === null) return;
  await applyAgentDraft([], false);
}

/** *Update now* on a mark: the new text goes out with the next message,
 *  whatever the cache (its cost was shown on the button). */
export async function updateLayerNow(kind: PromptLayer): Promise<void> {
  if (app.busy || app.connecting || app.connection?.engine !== "claude-code") return;
  await applyAgentDraft([kind]);
}

/** *Update at the next cold moment* / *Keep this version* / the default. */
export async function chooseLayerVersion(kind: PromptLayer, choice: import("../types").LayerChoice): Promise<void> {
  // The chat whose Context page was clicked; Rust refuses it when the
  // connection belongs to another (batch review 2026-09-23, finding 3).
  const session = app.activeSessionId;
  if (session === null) return;
  try {
    app.promptPending = await api.setPromptLayerChoice(session, kind, choice);
  } catch (e) {
    addToast(String(e));
  }
}

/** Settings: take every changed layer at the next cold moment, or wait for the click. */
export function setAutoLayers(on: boolean): void {
  app.layerPrefs.autoAtCold = on;
  saveLayerPrefs(app.layerPrefs);
}

/**
 * The prompt layers the open chat has switched off, projected from the log
 * the way `Session::prompt_layers_off()` projects it in the core: the latest
 * live `prompt_layers` event wins, a compaction leaves it alone (the chat is
 * the same chat), and none means every layer is on.
 */
export function promptLayersOff(events: SessionEvent[]): PromptLayer[] {
  const live = liveFlags(events);
  for (let i = events.length - 1; i >= 0; i--) {
    if (!live[i]) continue;
    const e = events[i];
    if (e.event === "prompt_layers") return e.off;
  }
  return [];
}

/** The same set, as the backend normalizes it: ladder order, no repeats. */
const LAYER_ORDER: PromptLayer[] = [
  "identity",
  "environment",
  "user_memory",
  "model_instructions",
  "project_instructions",
  "project_notes",
  "thread",
  "knowledge",
  "engine_note",
  "pacing",
  "subagents",
  "subagent_rules",
];

/** Whether two layer sets are the same set, whatever order they came in. */
export function sameLayers(a: PromptLayer[], b: PromptLayer[]): boolean {
  const key = (xs: PromptLayer[]) =>
    LAYER_ORDER.filter((l) => xs.includes(l)).join(",");
  return key(a) === key(b);
}

/**
 * Switch one prompt layer off or on for the open chat.
 *
 * Two steps, in the order that keeps the log ahead of the wire: the event
 * is recorded first (creating the chat's log if the first send has not yet),
 * then the engine reconnects exactly as a rail knob would, and `connect` /
 * `connect_agent` read the new set back off the log. The transcript comes
 * back from the same call the way it does from `rewind`, so the popover's
 * switches — which project the log — flip when the log does and not before.
 */
export async function setPromptLayer(layer: PromptLayer, on: boolean): Promise<void> {
  if (app.busy || app.connecting) return;
  const current = promptLayersOff(app.events);
  const off = on ? current.filter((l) => l !== layer) : [...current, layer];
  if (sameLayers(off, current)) return;
  if (!(await applyLayers(off))) return;
  // The inverse is the set as it was; scoped to the chat the call may
  // just have created, which is why the scope is read after it.
  pushUndo(chatScope(), {
    label: `${layer.replace(/_/g, " ")} ${on ? "on" : "off"}`,
    undo: async () => {
      await applyLayers(current);
    },
    redo: async () => {
      await applyLayers(off);
    },
  });
}

/** The two steps of a layer change: the log, then the reconnect that
 *  reads it back. False on a refusal, toasted. */
async function applyLayers(off: PromptLayer[]): Promise<boolean> {
  const pending = pendingChatKey();
  try {
    await writePendingThread();
    app.events = await api.setPromptLayers(off);
    // A chat whose log was just created by this call: pick up its id the way
    // `send` does, so the sidebar and the next open agree on which chat this is.
    adoptCreatedChat(pending);
    app.error = null;
  } catch (e) {
    addToast(String(e));
    return false;
  }
  await applyDraft();
  void refreshSessions();
  return true;
}

/**
 * The open chat's own text per layer, projected from the log the way
 * `Session::prompt_layer_edits()` projects it in the core: the same event
 * as the off set, so the same latest-wins, the same survival of a
 * compaction, the same reversal by a rewind. A line written before the
 * field existed carries none, which reads as no override.
 */
export function promptLayerEdits(events: SessionEvent[]): PromptLayerEdits {
  const live = liveFlags(events);
  for (let i = events.length - 1; i >= 0; i--) {
    if (!live[i]) continue;
    const e = events[i];
    if (e.event === "prompt_layers") return e.edits ?? {};
  }
  return {};
}

/** Whether two edit maps say the same thing: same kinds, same text. */
export function sameEdits(a: PromptLayerEdits, b: PromptLayerEdits): boolean {
  const key = (m: PromptLayerEdits) =>
    JSON.stringify(EDITABLE_LAYERS.map((l) => [l, m[l] ?? null]));
  return key(a) === key(b);
}

/**
 * Give the open chat its own text for one layer, or take it back with
 * `text` null (*Revert to the file*). The same two steps as `setPromptLayer`
 * and for the same reason: the log first, then the reconnect that reads it
 * back. A body that trims to nothing is recorded as no override — the
 * backend normalizes it so — since "send nothing" is what the switch is for.
 */
export async function setPromptLayerText(
  layer: EditableLayer,
  text: string | null,
): Promise<boolean> {
  if (app.busy || app.connecting) return false;
  const current = promptLayerEdits(app.events);
  const wanted = text?.trim() || null;
  const previous = current[layer] ?? null;
  if (previous === wanted) return true;
  if (!(await applyLayerText(layer, wanted))) return false;
  pushUndo(chatScope(), {
    label: `${layer.replace(/_/g, " ")} text`,
    undo: async () => {
      await applyLayerText(layer, previous);
    },
    redo: async () => {
      await applyLayerText(layer, wanted);
    },
  });
  return true;
}

/** `applyLayers` for one layer's own text. */
async function applyLayerText(layer: EditableLayer, text: string | null): Promise<boolean> {
  const pending = pendingChatKey();
  try {
    await writePendingThread();
    app.events = await api.setPromptLayerText(layer, text);
    adoptCreatedChat(pending);
    app.error = null;
  } catch (e) {
    addToast(String(e));
    return false;
  }
  await applyDraft();
  void refreshSessions();
  return true;
}

/**
 * *Make this the file*: open the store editor on the file a layer reads,
 * with the chat's text in the buffer as a draft — never a write. The draft
 * goes through `noteDrafts`, so the ● marker, Revert and the same Save any
 * edit takes all apply; the override stays on the chat until it is reverted
 * here, so nothing is lost if the editor is closed without saving.
 *
 * Which file: memory is `~/.nightloom/AGENTS.md`; project instructions are
 * the workspace's `AGENTS.md` (the innermost file of the walk, the one the
 * Notes panel edits — an override that replaced several files lands in the
 * one a save can reach, and the editor shows the difference); the model's
 * is its file under `~/.nightloom/models/` by the id the chat is on. False
 * when there is no such file to open — no project for the instructions, no
 * model id for the model's — with the reason as a toast.
 */
export function promoteLayerText(layer: EditableLayer, text: string): boolean {
  let scope: NoteScope;
  let name: string;
  if (layer === "thread") {
    void promoteThreadText(text);
    return true;
  }
  if (layer === "user_memory") {
    scope = "memory";
    name = "AGENTS.md";
  } else if (layer === "project_instructions") {
    if (!app.project) {
      addToast("Open a project first — the instructions file is the project's");
      return false;
    }
    scope = "instructions";
    name = "AGENTS.md";
  } else {
    const model = currentModelId();
    if (!model) {
      addToast("This chat is on the engine's default model, which has no file to edit");
      return false;
    }
    scope = "models";
    name = modelInstructionFile(model);
  }
  const key = noteDraftKey(scope, name);
  app.noteDrafts[key] = text;
  app.showContext = false;
  const tab = app.leftTab;
  showNote(scope, name);
  // The model's file is not in the Notes list, so the tab stays where it
  // was, as `openModelInstructions` leaves it.
  if (scope === "models") app.leftTab = tab;
  return true;
}

/**
 * Reconnect if the open chat's layer set or its own texts are not the ones
 * the engine was built with — which is the case after opening another chat,
 * or a new one, since the engine is built once per rail change and not per
 * chat. Cheap when the pairs agree, which is every other time it runs; a
 * no-op while a turn or a connect is in flight, and the caller's effect
 * re-runs it when either ends.
 */
export async function syncPromptLayers(): Promise<void> {
  // The open chat's own model and engine first (backlog 205): shown at
  // once, and a chat switch that changes them reconnects — which also
  // builds the layers. The reconnect waits while a turn or a connect is
  // in flight, so a running turn keeps the model it started with.
  if (restoreChatChoice()) chatChoice.reconnect = true;
  if (app.busy || app.connecting) return;
  if (chatChoice.reconnect) {
    chatChoice.reconnect = false;
    // Only when the draft moved on from what the last connect sent (item
    // 222): four picks held behind one connect go out as one, and a pick
    // put back as it was costs nothing. A chat switch changes the key.
    if (sentKey() !== lastSent) {
      await applyDraft();
      return;
    }
    app.applyPending = applyTimer !== null;
  }
  if (!app.connection) {
    // Item 261: a connect that failed left every chat "not connected", and
    // opening another chat never tried again — only a relaunch did. Now
    // opening another chat (or New chat) retries once for it; the chat
    // whose connect just failed is not retried in a loop (the transcript's
    // Retry is the way to try it again).
    const key = sentKey();
    if (app.connectError && key !== lastSent && key !== lastAutoRetry) {
      lastAutoRetry = key;
      await applyDraft();
    }
    return;
  }
  try {
    const { off, built, edits, built_edits, mode, built_mode, kind, built_kind, thread, built_thread } =
      await api.promptLayers();
    // The mode is the third pair (2026-09-15): an incognito chat's engine
    // was built with no writers, and the ordinary chat opened after it
    // needs them back — and the other way round. The kind is the fourth
    // (nightshift backlog 102): a Chat's engine has no folder and the
    // read-only tools, and the Claude Code chat opened after it needs
    // both back.
    if (
      !sameLayers(off, built) ||
      !sameEdits(edits ?? {}, built_edits ?? {}) ||
      (mode ?? "normal") !== (built_mode ?? "normal") ||
      (kind ?? "build") !== (built_kind ?? "build") ||
      // The fifth pair (backlog 271): the chat's research thread.
      (thread ?? null) !== (built_thread ?? null)
    ) {
      // A provider connect that fails leaves the built set as it was, so
      // the pairs still disagree, `connecting` flips, the effect re-runs
      // and this would reconnect again at once, forever (backlog 137,
      // review E's FE8). The one pair that just failed is not retried;
      // another chat, another set, or a rail change (which clears
      // `connectError`) tries afresh.
      const pair = JSON.stringify([
        app.activeSessionId,
        off,
        edits ?? {},
        mode ?? "normal",
        kind ?? "build",
        thread ?? null,
      ]);
      if (lastFailedSync === pair && app.connectError) return;
      await applyDraft();
      lastFailedSync = app.connectError ? pair : null;
    }
  } catch {
    // Best-effort: the next rail change reconnects with the right set anyway.
  }
}
/** The (chat, wanted set) whose sync last failed to connect; see above. */
let lastFailedSync: string | null = null;
/** The (chat, draft) a failed connect was last retried for on its own
 *  (item 261), so a retry that fails too is not repeated forever. */
let lastAutoRetry: string | null = null;

/**
 * Try the connection again after it failed (item 261): the Retry on the
 * "not connected" card. The rail's settings as they are, for the open
 * chat; a turn or a connect in flight defers it as any rail change is.
 */
export async function retryConnect(): Promise<void> {
  if (app.connecting) return;
  app.connectError = null;
  lastFailedSync = null;
  lastAutoRetry = null;
  await applyDraft();
}
