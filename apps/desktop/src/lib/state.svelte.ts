import { listen } from "@tauri-apps/api/event";
import * as api from "./api";
import {
  defaultDraft,
  isProviderVisible,
  loadLastConnection,
  loadPrefs,
  loadPrompts,
  modelsFor,
  newPromptId,
  sanitizeThinking,
  saveLastConnection,
  savePrefs,
  savePrompts,
  thinkingString,
  type CatalogPrefs,
  type Engine,
  type SavedPrompt,
} from "./catalog";
import type {
  AgentInfo,
  AgentTurnResult,
  ApprovalDecision,
  ApprovalRequest,
  DocumentInput,
  ImageInput,
  KnowledgeInfo,
  McpServerInfo,
  ReviewerInfo,
  Note,
  NoteScope,
  Price,
  ProjectInfo,
  ProviderInfo,
  SearchBackendInfo,
  SessionEvent,
  SessionMeta,
  TodoItem,
  TurnEvent,
  Usage,
} from "./types";

/**
 * Which project the app reopens at launch. A UI preference, not a source of
 * truth — the backend registry is that, and this only records where the user
 * left off.
 */
const LAST_PROJECT_KEY = "nightloom.last-project";

function loadLastProject(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
}

function saveLastProject(id: string | null): void {
  try {
    if (id) localStorage.setItem(LAST_PROJECT_KEY, id);
    else localStorage.removeItem(LAST_PROJECT_KEY);
  } catch {
    // best-effort
  }
}

/**
 * How the dream runs: whether a compaction triggers one, and on which model.
 * A UI preference like the last connection — the backend holds no opinion.
 */
const DREAM_PREFS_KEY = "nightloom.dream";

export interface DreamPrefs {
  /** Dream automatically after a compaction, when the inbox has entries. */
  auto: boolean;
  /** Provider that dreams; "" means whatever the rail is connected to. */
  provider: string;
  /** Model that dreams; "" means the provider's default. */
  model: string;
}

function loadDreamPrefs(): DreamPrefs {
  try {
    const raw = localStorage.getItem(DREAM_PREFS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<DreamPrefs>;
      return {
        auto: !!p.auto,
        provider: typeof p.provider === "string" ? p.provider : "",
        model: typeof p.model === "string" ? p.model : "",
      };
    }
  } catch {
    // A malformed preference costs the preference, not the feature.
  }
  return { auto: false, provider: "", model: "" };
}

export function saveDreamPrefs(): void {
  try {
    localStorage.setItem(DREAM_PREFS_KEY, JSON.stringify(app.dreamPrefs));
  } catch {
    // best-effort
  }
}

export interface ToolCallView {
  id: string;
  name: string;
  input: unknown;
  result: { content: string; is_error: boolean } | null;
  /** Refused at the approval gate: nothing ran, `result` holds the reason. */
  denied?: boolean;
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
  /** Per-MTok rates for the connected model; null when unpriced. */
  price: Price | null;
  /** MCP servers for this workspace, including ones that failed to start. */
  mcp: McpServerInfo[];
  /** The curated bench `review` can ask for a second opinion; empty when no
   *  other lineage is reachable, in which case the tool is not offered. */
  reviewers: ReviewerInfo[];
  /** Resolved workspace root the file tools operate in. */
  workspace: string;
  /** Which provider answers `web_search`, or null when no key is set and the
   *  tool is absent. `web_fetch` needs none and is always there. */
  search: string | null;
  /** The knowledge base the model can reach, or null when the switch is off
   *  (always null on the agent engine, which owns its own file access). */
  knowledge: KnowledgeInfo | null;
  /**
   * Which engine is running. Read from the backend's answer rather than from
   * the draft that asked, so the two cannot disagree about it — the same
   * reason `project` is read back.
   */
  engine: Engine;
  /** Present only on the agent engine. */
  agent: AgentInfo | null;
}

export const app = $state({
  providers: [] as ProviderInfo[],
  /** Web-search backends and which one has a key (settings modal edits this). */
  searchBackends: [] as SearchBackendInfo[],
  /** Which providers/models the rail dropdowns offer (settings modal edits this). */
  prefs: loadPrefs() as CatalogPrefs,
  /** Every registered project, newest-opened first. */
  projects: [] as ProjectInfo[],
  /**
   * The open project, or null for an unfiled chat.
   *
   * Not derived from `draft.workspace`: an open project overrides it on the
   * backend, and two answers to "which folder is this" is one too many.
   */
  project: null as ProjectInfo | null,
  /** The open project's shared notes. Empty when nothing is open. */
  notes: [] as Note[],
  /**
   * The user's knowledge base. Listed whether or not a project is open, which
   * is the point of it — an unfiled chat has a vault.
   */
  vault: [] as Note[],
  /** Where the vault is; null on a machine with no user config directory. */
  knowledge: null as KnowledgeInfo | null,
  /**
   * What the centre pane shows. "note" is the note editor and "graph" the
   * vault's link graph, both of which replace the transcript rather than
   * floating over it — reading, writing and navigating notes is work, not a
   * dialog.
   */
  view: "chat" as "chat" | "note" | "graph",
  /**
   * The note open in the centre pane, when `view` is "note".
   *
   * Carries its scope: the two stores can hold a note of the same name, and a
   * bare string would make saving depend on which sidebar tab happened to be
   * showing.
   */
  openNote: null as { scope: NoteScope; name: string } | null,
  /** Which half of the left sidebar is showing. */
  leftTab: "chats" as "chats" | "notes",
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
   * Tool calls parked at the approval gate, oldest first. The turn is
   * blocked on each of these, so every path that ends a turn has to empty
   * this — a prompt left on screen after the turn is gone answers nothing.
   */
  pendingApprovals: [] as ApprovalRequest[],
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
  /** The user's saved system prompts, newest-written first. */
  prompts: loadPrompts() as SavedPrompt[],
  /** Prompt library modal; a string is the id it opens on. */
  showPrompts: false,
  /** Live model lists fetched from provider APIs, per provider kind. */
  modelLists: {} as Record<string, string[]>,
  /** Fetch status per provider kind (settings modal UI). */
  modelFetch: {} as Record<string, { loading: boolean; error: string | null }>,
  /**
   * What the last agent turn reported: the plan window it came out of, and
   * the CLI's estimate of what the same turn would have cost on the API.
   *
   * Kept apart from the cost readout in the top bar, which sums money that
   * was actually charged. Under a subscription none of this was, and showing
   * an estimate where a bill goes would be the one reading of the number
   * that is false.
   */
  agentTurn: null as AgentTurnResult | null,
  /** Observations awaiting the next dream — the badge on the Dream button. */
  dreamPending: 0,
  /** A dream is running; the button becomes its progress line. */
  dreaming: false,
  /** The dream's most recent tool call, for the running button's tooltip. */
  dreamActivity: "",
  /** Auto-dream and the dream model, Settings → Knowledge. */
  dreamPrefs: loadDreamPrefs(),
  toasts: [] as { id: number; text: string }[],
});

let initialized = false;

/**
 * A compaction landed during the in-flight turn (the model asked, the engine
 * honoured it at the boundary). Consumed by `send` once the transcript has
 * re-synced, which is where the auto-dream fires from.
 */
let compactedThisTurn = false;

/**
 * A click in the macOS menu bar (`mac_menu` in `main.rs`), which is where
 * that platform's window commands live because its frame is native and there
 * is no bar of ours to hang them on.
 *
 * Every id here names a flow that already exists and is reached some other
 * way as well — nothing is only in the menu, so a Windows user is missing no
 * capability. Unknown ids are ignored rather than logged: the OS performs its
 * own predefined items (quit, copy, minimize) and forwards them here anyway.
 *
 * Settings *opens* rather than toggles. A menu item reading "Settings…" that
 * closed the pane when it happened to be open would be answering a question
 * nobody asked.
 */
function runMenuCommand(id: string): void {
  switch (id) {
    case "settings":
      app.showSettings = true;
      break;
    case "new_chat":
      void newSession();
      break;
    case "add_project":
      void addProject();
      break;
    case "import_claude":
      void importFromClaude();
      break;
  }
}

export async function init(): Promise<void> {
  if (initialized) return;
  initialized = true;
  await listen<TurnEvent>("turn-event", (e) => applyTurnEvent(e.payload));
  await listen<string>("turn-notice", (e) => addToast(e.payload));
  // The dream's own channel: a running chat and a running dream must not
  // interleave in the transcript, so its events never reach applyTurnEvent.
  // All the panel wants from them is a sign of life.
  await listen<TurnEvent>("dream-event", (e) => {
    if (e.payload.type === "tool_call") app.dreamActivity = e.payload.name;
  });
  await listen<ApprovalRequest>("tool-approval", (e) =>
    app.pendingApprovals.push(e.payload),
  );
  await listen<string>("menu", (e) => runMenuCommand(e.payload));
  // A folder coming back is something that happens outside this window, so
  // nothing in here would otherwise notice it. Re-reading on focus is what
  // makes the missing-folder warning's "until it comes back" a promise the UI
  // can keep: the user leaves to put the folder back and it has cleared by
  // the time they return. Cheap enough to leave unconditional — one command
  // that stats a handful of paths, and only when the window is activated —
  // where a poll would be a filesystem check every few seconds forever.
  window.addEventListener("focus", () => void refreshProjects());
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
  await refreshProjects();
  // Reopen where the user left off *before* connecting: the project decides
  // the workspace, so connecting first would root the tools at the previous
  // folder and then immediately re-connect to correct it.
  const lastProject = loadLastProject();
  if (lastProject && app.projects.some((p) => p.id === lastProject)) {
    try {
      app.project = await api.openProject(lastProject);
      // Opening bumps last-opened on the backend, so the list read a
      // moment ago is already stale in its ordering.
      await refreshProjects();
    } catch {
      // A project whose folder vanished must not stop the app launching.
      saveLastProject(null);
    }
  }
  await refreshSessions();
  await refreshKnowledge();
  await refreshNotes();
  await refreshDreamStatus();
  await autoConnect();
}

// ---- projects ----

export async function refreshProjects(): Promise<void> {
  try {
    app.projects = await api.listProjects();
  } catch (e) {
    addToast(String(e));
    return;
  }
  // Keep the open project in step with the list it is a row of. `app.project`
  // is otherwise a snapshot taken at open/connect/rename, and `exists` is a
  // fact about the disk that changes underneath it — so the Welcome pane went
  // on saying the folder was gone after it came back, while the project menu,
  // reading this same list, said it was fine. Two answers to one question,
  // and the warning's own "until it comes back" was the one that was wrong.
  //
  // Only a matching row updates it. A project missing from the list has been
  // forgotten, and closing it is `forgetProject`'s job — doing it here would
  // put a second, silent close in the one function everything else calls to
  // refresh.
  const open = app.project;
  if (open) {
    const fresh = app.projects.find((p) => p.id === open.id);
    if (fresh) app.project = fresh;
  }
}

/**
 * Re-read both note stores.
 *
 * Called after every turn, which is the visible half of shared knowledge: a
 * note the model just left appears in the sidebar without a reload. Both are
 * refreshed together because the model can write to either.
 */
export async function refreshNotes(): Promise<void> {
  if (app.project) {
    try {
      app.notes = await api.listNotes("project");
    } catch {
      // A store that cannot be listed shows as empty; the failure surfaces
      // when something is actually read or written.
      app.notes = [];
    }
  } else {
    app.notes = [];
  }
  try {
    app.vault = await api.listNotes("knowledge");
  } catch {
    app.vault = [];
  }
}

/** Where the vault is. Read on launch and after Settings repoints it. */
export async function refreshKnowledge(): Promise<void> {
  try {
    app.knowledge = await api.knowledgeInfo();
  } catch {
    app.knowledge = null;
  }
}

/** Re-count the memory inbox. Cheap: one file read on the backend. */
export async function refreshDreamStatus(): Promise<void> {
  try {
    app.dreamPending = await api.dreamStatus();
  } catch {
    // No config dir reads as zero on the backend; anything else is not
    // worth a toast for a badge.
  }
}

/**
 * Run one dream with the rail's current provider settings.
 *
 * The connection travels as arguments rather than reusing the window's chat:
 * a dream is its own job with its own prompt and tool set, and it works the
 * same whichever engine the window is on — except that the agent engine has
 * no provider to lend it, which gets a sentence instead of a guess.
 */
export async function runDream(): Promise<void> {
  if (app.dreaming) return;
  const d = app.draft;
  const prefs = app.dreamPrefs;
  // A dream model set in Settings wins over the rail — one knob answers
  // "which model dreams" for the button and the auto-trigger alike, and it
  // is also what lets the agent engine dream at all, having no provider of
  // its own to lend.
  let target: { provider: string; model?: string; baseUrl?: string; thinking?: string };
  if (prefs.provider) {
    target = { provider: prefs.provider, model: prefs.model.trim() || undefined };
  } else if (d.engine === "claude-code") {
    addToast(
      "dreaming runs on a provider API — set a dream model in Settings → Knowledge, or pick a provider in the rail",
    );
    return;
  } else {
    target = {
      provider: d.provider,
      model: d.model || undefined,
      baseUrl: d.baseUrl.trim() || undefined,
      thinking: thinkingString(d),
    };
  }
  app.dreaming = true;
  app.dreamActivity = "";
  try {
    const r = await api.dream(target);
    addToast(
      r.interrupted
        ? "dream interrupted — nothing consumed; the same batch is offered next time"
        : `dream: consolidated ${r.consolidated} observation${r.consolidated === 1 ? "" : "s"}` +
            (r.remaining > 0 ? `, ${r.remaining} left for the next run` : "") +
            ` — ${r.git}` +
            (r.cost_usd != null ? ` ($${r.cost_usd.toFixed(4)})` : ""),
    );
  } catch (e) {
    addToast(`dream failed: ${String(e)}`);
  } finally {
    app.dreaming = false;
    app.dreamActivity = "";
  }
  // The pass writes notes and consumes the inbox; both surfaces follow.
  await refreshNotes();
  await refreshDreamStatus();
}

/**
 * The auto-dream trigger: a compaction just landed, which is the moment the
 * evidence supports — the conversation's detail is already being traded for
 * a summary, so a background consolidation interrupts nothing the user was
 * still watching. Opt-in (Settings → Knowledge) because it spends a
 * provider turn unattended; an empty inbox spends nothing and says nothing.
 */
async function maybeAutoDream(): Promise<void> {
  if (!app.dreamPrefs.auto || app.dreaming) return;
  await refreshDreamStatus();
  if (app.dreamPending === 0) return;
  addToast("auto-dream: consolidating the memory inbox");
  await runDream();
}

/** Interrupt the in-flight dream. Nothing is consumed; the batch returns. */
export async function stopDream(): Promise<void> {
  try {
    await api.cancelDream();
  } catch (e) {
    addToast(String(e));
  }
}

/**
 * Point the knowledge base at a folder, or back at the default with null.
 *
 * Re-connects afterwards, because the vault is part of what `connect` roots
 * the file tools at and indexes into the preamble — leaving it would have the
 * sidebar showing one folder and the model reading another.
 */
export async function useKnowledgeDir(dir: string | null): Promise<void> {
  try {
    app.knowledge = await api.setKnowledgeDir(dir);
  } catch (e) {
    addToast(String(e));
    return;
  }
  // The open note may not exist in the new vault.
  if (app.openNote?.scope === "knowledge") closeNote();
  await refreshNotes();
  await applyDraft();
}

/**
 * Open a project (or, with null, leave the one that is open) and re-point
 * everything at it.
 *
 * One function rather than a handful the callers compose, because the order
 * matters and getting it wrong is silent: the backend has to know the project
 * before `connect` reads it — the project decides the workspace — and the
 * chat list has to be re-read after, since it comes from the project folder.
 */
export async function useProject(id: string | null): Promise<void> {
  if (app.busy) return;
  try {
    if (id) {
      app.project = await api.openProject(id);
    } else {
      await api.closeProject();
      app.project = null;
    }
  } catch (e) {
    addToast(String(e));
    return;
  }
  saveLastProject(app.project?.id ?? null);
  app.activeSessionId = null;
  app.events = [];
  app.error = null;
  app.view = "chat";
  app.openNote = null;
  await applyDraft();
  await refreshProjects();
  await refreshSessions();
  await refreshNotes();
}

/**
 * Pick a folder and open it as a project.
 *
 * `createProject` is idempotent on the path, so choosing a folder that is
 * already a project opens it rather than erroring — which is what someone who
 * navigated back to it meant.
 */
export async function addProject(): Promise<void> {
  let path: string | null = null;
  try {
    path = await api.pickFolder();
  } catch (e) {
    addToast(String(e));
    return;
  }
  if (!path) return; // cancelled
  try {
    const project = await api.createProject(path);
    await refreshProjects();
    await useProject(project.id);
  } catch (e) {
    addToast(String(e));
  }
}

/**
 * Import a claude.ai export: pick the archive, pick where the projects go,
 * write them, then show the list.
 *
 * One dialog, for the archive. There used to be a second asking where the
 * projects should be created, which stopped being a question worth asking
 * once a project stopped being a folder: an imported one is instructions,
 * documents and conversations, and the folder it was made to live in only
 * ever existed to give it an identity.
 */
export async function importFromClaude(): Promise<void> {
  let archive: string | null = null;
  try {
    archive = await api.pickExport();
  } catch (e) {
    addToast(String(e));
    return;
  }
  if (!archive) return; // cancelled

  addToast("Importing…");
  try {
    const result = await api.importClaude(archive, true);
    await refreshProjects();
    addToast(`Imported ${result.summary}`);
    for (const warning of result.warnings.slice(0, 3)) addToast(warning);
  } catch (e) {
    addToast(String(e));
  }
}

export async function renameProject(id: string, name: string): Promise<void> {
  try {
    const project = await api.renameProject(id, name);
    if (app.project?.id === id) app.project = project;
    await refreshProjects();
  } catch (e) {
    addToast(String(e));
  }
}

/**
 * Drop a project from the list. Nothing on disk is touched, and the toast
 * says so — a "remove" next to a folder full of work has to be unambiguous.
 */
export async function forgetProject(id: string): Promise<void> {
  const wasOpen = app.project?.id === id;
  try {
    await api.forgetProject(id);
  } catch (e) {
    addToast(String(e));
    return;
  }
  addToast(
    "Removed from the list — the folder, its notes and its chats are untouched on disk.",
  );
  await refreshProjects();
  if (wasOpen) await useProject(null);
}

export async function revealFolder(path?: string): Promise<void> {
  try {
    await api.reveal(path);
  } catch (e) {
    addToast(String(e));
  }
}

// ---- the docspace ----

export function showNote(scope: NoteScope, name: string): void {
  app.openNote = { scope, name };
  app.view = "note";
  // So the list highlighting the open note is the list on screen — this is
  // also reachable from the welcome page and from the graph, where the
  // sidebar may be on Chats.
  app.leftTab = "notes";
}

export function showGraph(): void {
  app.view = "graph";
  app.openNote = null;
  app.leftTab = "notes";
}

export function closeNote(): void {
  app.view = "chat";
  app.openNote = null;
}

export async function saveNote(
  scope: NoteScope,
  name: string,
  content: string,
): Promise<boolean> {
  try {
    await api.saveNote(scope, name, content);
  } catch (e) {
    addToast(String(e));
    return false;
  }
  await refreshNotes();
  await refreshProjects();
  return true;
}

export async function deleteNote(scope: NoteScope, name: string): Promise<void> {
  try {
    await api.deleteNote(scope, name);
  } catch (e) {
    addToast(String(e));
    return;
  }
  if (app.openNote?.scope === scope && app.openNote.name === name) closeNote();
  await refreshNotes();
  await refreshProjects();
}

/** A provider the backend can actually construct a client for right now. */
export function usable(p: ProviderInfo): boolean {
  // openai-chat can point at a local server without an API key.
  return p.available || (p.kind === "openai-chat" && app.draft.baseUrl.trim() !== "");
}

/** Connect on launch: last-used provider if still usable, else the first that is. */
async function autoConnect(): Promise<void> {
  // The agent engine has no key to check and no model list to fall back
  // through — the binary either runs or the rail says why not.
  if (app.draft.engine === "claude-code") {
    await applyDraft();
    return;
  }
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
  if (app.busy || app.connecting) return;
  if (d.engine === "claude-code") return applyAgentDraft();
  if (!d.provider) return;
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
      approval: d.approval,
      web: d.web,
      selfCompact: d.selfCompact,
      knowledge: d.knowledge,
      workspace: d.workspace.trim() || undefined,
    });
    app.connection = {
      provider: res.provider,
      model: res.model,
      thinking: thinkingString(d),
      tools: d.tools,
      contextLimit: res.context_limit ?? null,
      price: res.price ?? null,
      mcp: res.mcp ?? [],
      reviewers: res.reviewers ?? [],
      workspace: res.workspace,
      search: res.search ?? null,
      knowledge: res.knowledge ?? null,
      engine: "provider",
      agent: null,
    };
    // The backend is the authority on which project a connection is filed
    // under: an open project overrides the workspace the rail saved, so
    // reading it back is what keeps the two from disagreeing.
    app.project = res.project ?? null;
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

/**
 * Connect the agent engine with the rail's current settings.
 *
 * Its own function rather than a branch inside `applyDraft` because almost
 * nothing in that call survives the crossing: no thinking mode, no base URL,
 * no preamble or sidecar, no MCP or reviewers. What it shares is the shape —
 * one connect per rail change, the backend's answer read back rather than the
 * draft echoed — and that is what `Connection` is.
 */
async function applyAgentDraft(): Promise<void> {
  const d = app.draft;
  app.connecting = true;
  app.connectError = null;
  try {
    const res = await api.connectAgent({
      binary: d.agentBinary.trim() || undefined,
      model: d.agentModel.trim() || undefined,
      workspace: d.workspace.trim() || undefined,
      tools: d.tools,
      approval: d.approval,
      safeMode: d.agentSafeMode,
      budget: d.agentBudget > 0 ? d.agentBudget : undefined,
      system: d.system.trim() || undefined,
    });
    app.connection = {
      provider: res.provider,
      model: res.model,
      // Claude Code decides its own reasoning; there is no knob here to
      // report, and "default" is the honest thing for the annotation to say.
      thinking: "default",
      tools: d.tools,
      contextLimit: res.context_limit ?? null,
      price: res.price ?? null,
      mcp: res.mcp ?? [],
      reviewers: res.reviewers ?? [],
      workspace: res.workspace,
      search: res.search ?? null,
      knowledge: res.knowledge ?? null,
      engine: "claude-code",
      agent: res.agent ?? null,
    };
    app.project = res.project ?? null;
    saveLastConnection({ ...d });
  } catch (e) {
    // A failure here is usually the binary: not installed, or not on the
    // PATH this process inherited. The rail shows the message, which names
    // both possibilities.
    app.connectError = String(e);
    app.connection = null;
  } finally {
    app.connecting = false;
  }
}

/** Switch engines and re-connect. */
export async function useEngine(engine: Engine): Promise<void> {
  if (app.draft.engine === engine || app.busy || app.connecting) return;
  app.draft.engine = engine;
  // The previous engine's connection is not this engine's, and leaving it up
  // while the new connect runs would show a provider chip over an agent
  // chat. A failed connect leaves it null, which reads as "not connected"
  // beside the error — which is what happened.
  app.connection = null;
  app.agentTurn = null;
  await applyDraft();
}

// ---- saved system prompts ----

/**
 * Put a saved prompt on the draft and re-connect. `null` clears it.
 *
 * The text is *copied* onto the draft rather than referenced, so the chat's
 * prompt is whatever was applied — editing the library entry afterwards does
 * not silently change the prompt a running chat was connected with.
 */
export async function usePrompt(id: string | null): Promise<void> {
  const p = id ? app.prompts.find((x) => x.id === id) : null;
  app.draft.promptId = p?.id ?? null;
  app.draft.system = p?.text ?? "";
  await applyDraft();
}

/**
 * Write a prompt into the library. Passing an `id` updates that entry (a
 * rename included), otherwise a new one is added and returned.
 */
export function storePrompt(
  name: string,
  text: string,
  id?: string | null,
): string {
  const now = Date.now();
  const trimmed = name.trim() || "Untitled";
  const existing = id ? app.prompts.find((p) => p.id === id) : undefined;
  if (existing) {
    existing.name = trimmed;
    existing.text = text;
    existing.updated = now;
  } else {
    id = newPromptId();
    app.prompts.unshift({ id, name: trimmed, text, updated: now });
  }
  app.prompts.sort((a, b) => b.updated - a.updated);
  savePrompts([...app.prompts]);
  return id!;
}

/**
 * Remove a prompt. A chat connected with it keeps its text — the draft holds
 * a copy — but loses the pointer, so the rail stops naming a prompt that is
 * no longer in the library.
 */
export function deletePrompt(id: string): void {
  const i = app.prompts.findIndex((p) => p.id === id);
  if (i < 0) return;
  app.prompts.splice(i, 1);
  savePrompts([...app.prompts]);
  if (app.draft.promptId === id) {
    app.draft.promptId = null;
    saveLastConnection({ ...app.draft });
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

/** Re-query which search backends have a key (after storing/clearing one). */
export async function refreshSearchBackends(): Promise<void> {
  try {
    app.searchBackends = await api.searchBackends();
  } catch {
    // same: the rail degrades to "no search key" rather than failing
  }
}

/** Fetch a provider's live model list (cached until `force`). */
export async function fetchModels(kind: string, force = false): Promise<void> {
  if (!force && app.modelLists[kind]) return;
  // Every write goes through `app.modelFetch[kind]` rather than through a
  // local alias: `??=` evaluates to the *raw* right-hand object, not the
  // deep-`$state` proxy the store wrapped it in, so mutating the alias
  // updated the target while the UI kept reading a stale signal — which is
  // what left the button saying "fetching…" forever once a fetch finished.
  app.modelFetch[kind] ??= { loading: false, error: null };
  if (app.modelFetch[kind].loading) return;
  app.modelFetch[kind].loading = true;
  app.modelFetch[kind].error = null;
  try {
    const baseUrl =
      kind === "openai-chat" ? app.draft.baseUrl.trim() || undefined : undefined;
    app.modelLists[kind] = await api.listModels(kind, baseUrl);
  } catch (e) {
    app.modelFetch[kind].error = String(e);
  } finally {
    app.modelFetch[kind].loading = false;
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
    app.agentTurn = null;
    closeNote();
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
    // The plan window and estimate belong to the chat you just left.
    app.agentTurn = null;
    closeNote();
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
      void maybeAutoDream();
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

export async function send(
  text: string,
  images: ImageInput[] = [],
  documents: DocumentInput[] = [],
): Promise<void> {
  if (!app.connection || app.busy) return;
  if (app.connection.engine === "claude-code") {
    // Claude Code takes a prompt on argv and reads no attachments from us.
    // Refusing loudly rather than sending the caption alone: a question
    // about an image the model never received gets a confident answer about
    // nothing, which is the failure mode worth spending a toast on.
    if (images.length > 0 || documents.length > 0) {
      addToast("Claude Code takes text only — attachments are not sent on this engine");
      return;
    }
    return sendAgent(text);
  }
  app.error = null;
  app.events.push({
    event: "user_message",
    text,
    // Mirror the backend's omission rather than logging an empty array, so the
    // optimistic entry and the re-synced one project identically.
    ...(images.length > 0 ? { images } : {}),
    ...(documents.length > 0 ? { documents } : {}),
    at: new Date().toISOString(),
  });
  app.live = { segments: [] };
  app.liveUsage = null;
  app.busy = true;
  try {
    await api.send(
      text,
      images.length > 0 ? images : undefined,
      documents.length > 0 ? documents : undefined,
    );
  } catch (e) {
    app.error = String(e);
  } finally {
    app.live = null;
    // The trailing assistant message now carries the same reading.
    app.liveUsage = null;
    // The turn is over: anything still parked was answered by the backend
    // (or died with the turn), so the prompts can no longer decide anything.
    app.pendingApprovals = [];
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
    // The turn may have written to the docspace, and the sidebar showing a
    // note the model just left is the visible half of "shared knowledge".
    void refreshNotes();
    // And it may have remembered something; the Dream badge follows.
    void refreshDreamStatus();
    if (compactedThisTurn) {
      compactedThisTurn = false;
      void maybeAutoDream();
    }
  }
}

/**
 * One turn on the agent engine.
 *
 * The same shape as `send` down to the re-sync, and deliberately so: the
 * transcript is a projection of the log either way, and the backend records
 * an agent turn in the same events a provider turn writes. What differs is
 * what comes back — a plan window and an estimate instead of a stop reason
 * and a bill — and that the window's own approval prompts never fire, since
 * the gate belongs to whoever owns the loop.
 */
async function sendAgent(text: string): Promise<void> {
  app.error = null;
  app.events.push({ event: "user_message", text, at: new Date().toISOString() });
  app.live = { segments: [] };
  app.liveUsage = null;
  app.busy = true;
  try {
    const res = await api.sendAgent(text);
    app.agentTurn = res;
    // The CLI resolves an alias to a real model id, which is the first
    // moment a context window can be looked up at all: `sonnet` is in no
    // limits table and a guessed denominator would promise headroom nobody
    // verified.
    if (app.connection && res.context_limit != null) {
      app.connection.contextLimit = res.context_limit;
    }
    if (app.connection && res.model) app.connection.model = res.model;
    for (const notice of res.notices) addToast(notice);
  } catch (e) {
    app.error = String(e);
  } finally {
    app.live = null;
    app.liveUsage = null;
    app.busy = false;
    try {
      app.events = await api.transcript();
      const first = app.events[0];
      if (first && first.event === "session_created") {
        app.activeSessionId = first.id;
      }
    } catch {
      // keep the locally-built view if re-sync fails
    }
    void refreshSessions();
    void refreshNotes();
  }
}

export async function cancelTurn(): Promise<void> {
  try {
    await api.cancel();
    // Cancelling refuses every parked prompt on the backend, so they stop
    // being answerable — but only once the call actually lands. Clearing
    // them before that could strand a still-running turn with no prompt.
    app.pendingApprovals = [];
  } catch (e) {
    addToast(String(e));
  }
}

/**
 * Answer one approval prompt. Dropping it from the list before the call
 * makes a double-click a no-op instead of a second, unanswerable decision.
 */
export async function resolveApproval(
  id: string,
  name: string,
  decision: ApprovalDecision,
  reason?: string,
): Promise<void> {
  const i = app.pendingApprovals.findIndex((r) => r.id === id);
  if (i < 0) return;
  app.pendingApprovals.splice(i, 1);
  try {
    await api.approveCall(id, name, decision, reason);
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
  if (ev.type === "compacted") {
    // The Compaction event itself arrives with the post-turn transcript
    // re-sync and renders there; this only makes the moment visible, matching
    // what the manual compact button reports.
    addToast("context compacted by the model");
    // Noted here, acted on when `send` settles: a dream that started while
    // the turn was still re-syncing would race the transcript for nothing.
    compactedThisTurn = true;
    if (app.live) {
      closeThinking(app.live.segments);
      app.live.segments.push({
        kind: "notice",
        text: "context compacted — earlier turns replaced by a summary",
      });
      app.liveVersion++;
    }
    return;
  }
  if (ev.type === "tool_denied" || ev.type === "tool_result") {
    // The gate answered this one, whoever decided it — a prompt still on
    // screen for it (cancellation denies server-side) can no longer be used.
    const i = app.pendingApprovals.findIndex((r) => r.id === ev.tool_use_id);
    if (i >= 0) app.pendingApprovals.splice(i, 1);
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

/**
 * Which events still count, after every `rewind` marker in the log.
 *
 * Mirrors `Session::live_flags` exactly, and has to: the backend projects the
 * model's view from its copy and the transcript is projected from this one,
 * so the two disagreeing means the user is reading a conversation the model
 * is not having. Returned as flags over the full array rather than a filtered
 * list because the superseded events are still rendered — greyed out, which
 * is the entire reason a rewind supersedes instead of deleting.
 */
export function liveFlags(events: SessionEvent[]): boolean[] {
  const live = events.map(() => true);
  events.forEach((e, i) => {
    if (e.event !== "rewind") return;
    live[i] = false; // the marker is not part of the conversation
    for (let j = e.to; j < i; j++) live[j] = false;
  });
  return live;
}

/**
 * Rewind to the turn at log index `to`.
 *
 * Refused mid-turn: the running turn holds the session and would record its
 * reply after the rewind landed, stitching the turn being undone onto the
 * history it was removed from.
 */
export async function rewindTo(to: number): Promise<void> {
  if (app.busy) return;
  try {
    app.events = await api.rewind(to);
    app.error = null;
  } catch (e) {
    app.error = String(e);
  }
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

/**
 * What this session has cost so far, in USD.
 *
 * Completed exchanges are read back from the log, where the backend recorded
 * each one at the price in force when it ran — re-pricing them here would
 * restate history whenever a vendor changes a rate, and the log is the source
 * of truth for the same reason the transcript is. The in-flight round is the
 * exception: it has no log entry yet, so it is priced live from the
 * connection's rates and added on, which is the same live-then-log shape the
 * context gauge uses.
 *
 * `complete` is false when some exchange had no price, making `usd` a floor.
 * A session run entirely on an unpriced model is 0, and rendering that as
 * "$0.00" would claim it was free.
 */
export function sessionCost(): { usd: number; complete: boolean } | null {
  let usd = 0;
  let complete = true;
  let any = false;
  for (const e of app.events) {
    if (e.event !== "assistant_message") continue;
    any = true;
    if (typeof e.cost === "number") usd += e.cost;
    else complete = false;
  }
  const live = app.liveUsage;
  const price = app.connection?.price ?? null;
  if (live) {
    any = true;
    if (price) usd += roundCost(live, price);
    else complete = false;
  }
  return any ? { usd, complete } : null;
}

/** Mirrors `Price::cost` on the backend: three disjoint input slices. */
function roundCost(u: Usage, p: Price): number {
  const read = u.cache_read_tokens ?? 0;
  const write = u.cache_write_tokens ?? 0;
  const fresh = Math.max(0, u.input_tokens - read - write);
  const at = (tokens: number, rate: number) => (tokens * rate) / 1e6;
  return (
    at(fresh, p.input) +
    at(read, p.cache_read ?? p.input) +
    at(write, p.cache_write ?? p.input) +
    at(u.output_tokens, p.output)
  );
}

/**
 * Share of the newest round's prompt that was served from cache, or null on a
 * host that reports no caching. Between turns it reads the trailing assistant
 * message, exactly as the context gauge does.
 */
export function cacheHitRate(): number | null {
  const u = app.liveUsage ?? lastAssistantUsage();
  if (!u || u.cache_read_tokens == null || u.input_tokens === 0) return null;
  return u.cache_read_tokens / u.input_tokens;
}

function lastAssistantUsage(): Usage | null {
  // Live events only: the gauge describes the prefix the *next* request will
  // carry, and a rewound turn is not in it. Cost is the deliberate opposite —
  // it sums everything, because rewinding does not refund.
  const live = liveFlags(app.events);
  for (let i = app.events.length - 1; i >= 0; i--) {
    if (!live[i]) continue;
    const e = app.events[i];
    if (e.event === "assistant_message") return e.usage;
  }
  return null;
}
