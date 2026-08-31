import { invoke } from "@tauri-apps/api/core";
import type {
  AgentConnectArgs,
  AgentTurnResult,
  ApprovalDecision,
  CompactResult,
  ConnectArgs,
  ConnectResult,
  DocumentInput,
  DreamReport,
  ImageInput,
  ImportSummary,
  KnowledgeInfo,
  LinkGraph,
  Note,
  NoteScope,
  ProjectInfo,
  ProviderInfo,
  SearchBackendInfo,
  ContextEdit,
  SessionEvent,
  SessionMeta,
  SessionHit,
  TurnResult,
  WireView,
} from "./types";

// All backend errors reject with a plain string.

export function providers(): Promise<ProviderInfo[]> {
  return invoke("providers");
}

/** Store an API key in the OS credential store (empty key clears it). */
export function setApiKey(provider: string, key: string): Promise<null> {
  return invoke("set_api_key", { provider, key });
}

export function clearApiKey(provider: string): Promise<null> {
  return invoke("clear_api_key", { provider });
}

/** Model ids the provider's API currently offers. */
export function listModels(
  provider: string,
  baseUrl?: string,
): Promise<string[]> {
  return invoke("list_models", { provider, baseUrl });
}

/** Rewind to the turn at log index `to`; resolves with the new transcript. */
export function rewind(to: number): Promise<SessionEvent[]> {
  return invoke("rewind", { to });
}

export function connect(args: ConnectArgs): Promise<ConnectResult> {
  return invoke("connect", {
    provider: args.provider,
    model: args.model,
    baseUrl: args.baseUrl,
    thinking: args.thinking,
    system: args.system,
    tools: args.tools,
    preamble: args.preamble,
    sidecar: args.sidecar,
    approval: args.approval,
    web: args.web,
    selfCompact: args.selfCompact,
    knowledge: args.knowledge,
    workspace: args.workspace,
  });
}

/**
 * Connect the Claude Code engine. Rejects if the binary will not run, which
 * is where that failure belongs: the alternative is a turn that dies with a
 * process error the first time the user sends anything.
 */
export function connectAgent(args: AgentConnectArgs): Promise<ConnectResult> {
  return invoke("connect_agent", {
    binary: args.binary,
    model: args.model,
    workspace: args.workspace,
    tools: args.tools,
    approval: args.approval,
    safeMode: args.safeMode,
    budget: args.budget,
    system: args.system,
  });
}

/**
 * Run one turn on the agent engine. Streams the same `turn-event`s the
 * provider path does, which is what lets the transcript render both without
 * knowing which produced a turn.
 */
export function sendAgent(text: string): Promise<AgentTurnResult> {
  return invoke("send_agent", { text });
}

/** The search backends, with which has a key and which one answers. */
export function searchBackends(): Promise<SearchBackendInfo[]> {
  return invoke("search_backends");
}

/**
 * Store a search backend's key, or remove it when `key` is empty. Write-only
 * from here, exactly like a provider key: the UI only ever learns whether one
 * is set, never what it is.
 */
export function setSearchKey(backend: string, key: string): Promise<null> {
  return invoke("set_search_key", { backend, key });
}

/**
 * Answer one `tool-approval` prompt. `reason` is handed to the model
 * verbatim on a denial, which is what lets it try something else instead of
 * repeating the call; it is ignored for the other decisions.
 */
export function approveCall(
  id: string,
  name: string,
  decision: ApprovalDecision,
  reason?: string,
): Promise<null> {
  return invoke("approve_call", { id, name, decision, reason });
}

export function listSessions(): Promise<SessionMeta[]> {
  return invoke("list_sessions");
}

export function searchSessions(query: string): Promise<SessionHit[]> {
  return invoke("search_sessions", { query });
}

export function renameSession(id: string, title: string): Promise<void> {
  return invoke("rename_session", { id, title });
}

export function newSession(): Promise<{ id: string }> {
  return invoke("new_session");
}

export function openSession(id: string): Promise<SessionEvent[]> {
  return invoke("open_session", { id });
}

export function transcript(): Promise<SessionEvent[]> {
  return invoke("transcript");
}

export function send(
  text: string,
  images?: ImageInput[],
  documents?: DocumentInput[],
): Promise<TurnResult> {
  return invoke("send", { text, images, documents });
}

export function cancel(): Promise<null> {
  return invoke("cancel");
}

/** Compact the active session (earlier turns superseded by a summary). */
export function compact(): Promise<CompactResult> {
  return invoke("compact");
}

/** Delete a session log; returns the deleted session's full id. */
export function deleteSession(id: string): Promise<string> {
  return invoke("delete_session", { id });
}

/** Itemize the request the active chat would send right now. */
export function contextView(): Promise<WireView> {
  return invoke("context_view");
}

/**
 * Remove (`remove: true`) or restore the content of log events.
 *
 * Resolves with the new view *and* the new transcript: an elision changes
 * every projection off the log, so the UI re-syncs from the backend rather
 * than patching its own copy — the same contract `rewind` uses.
 */
export function editContext(
  targets: number[],
  remove: boolean,
): Promise<ContextEdit> {
  return invoke("edit_context", { targets, remove });
}

// ---- projects ----

/**
 * Ask the OS for a folder; null when the user cancelled.
 *
 * The native dialog is driven from the Rust side, so the webview never gets
 * filesystem access of its own — it can ask, and it gets back a path the user
 * chose themselves.
 */
export function pickFolder(title?: string, startAt?: string): Promise<string | null> {
  return invoke("pick_folder", { title, startAt });
}

/** Ask the OS for the claude.ai export zip; null when the user cancelled. */
export function pickExport(): Promise<string | null> {
  return invoke("pick_export");
}

/**
 * Import a claude.ai export as projects, and register them so the list shows
 * them.
 *
 * `into` is optional and normally omitted: an imported project is
 * instructions, documents and conversations with no code anywhere, so there
 * is no folder to make. Pass one only when the user means to keep code
 * alongside them.
 */
export function importClaude(
  exportPath: string,
  unfiled: boolean,
  into?: string,
): Promise<ImportSummary> {
  return invoke("import_claude", { export: exportPath, into, unfiled });
}

export function listProjects(): Promise<ProjectInfo[]> {
  return invoke("list_projects");
}

export function activeProject(): Promise<ProjectInfo | null> {
  return invoke("active_project");
}

/** Register a folder. Idempotent — the same folder is the same project. */
export function createProject(
  path: string,
  name?: string,
): Promise<ProjectInfo> {
  return invoke("create_project", { path, name });
}

/**
 * Open a project: its chats become the listing and its folder the workspace.
 * Drops the active session, and does *not* re-connect — the caller does that
 * with the settings it already holds.
 */
export function openProject(id: string): Promise<ProjectInfo> {
  return invoke("open_project", { id });
}

export function closeProject(): Promise<null> {
  return invoke("close_project");
}

export function renameProject(id: string, name: string): Promise<ProjectInfo> {
  return invoke("rename_project", { id, name });
}

/** Remove a project from the list. Forgets; deletes nothing on disk. */
export function forgetProject(id: string): Promise<null> {
  return invoke("forget_project", { id });
}

// ---- notes: the project docspace and the knowledge base ----
//
// One `scope` argument rather than a second set of four calls: the operations
// are identical and only the folder differs.

export function listNotes(scope: NoteScope): Promise<Note[]> {
  return invoke("list_notes", { scope });
}

export function readNote(scope: NoteScope, name: string): Promise<string> {
  return invoke("read_note", { scope, name });
}

/** Write a note. Also how one is created; an empty note is a real note. */
export function saveNote(scope: NoteScope, name: string, content: string): Promise<Note> {
  return invoke("save_note", { scope, name, content });
}

export function deleteNote(scope: NoteScope, name: string): Promise<null> {
  return invoke("delete_note", { scope, name });
}

/** Show a folder in the OS file manager; defaults to the docspace. */
export function reveal(path?: string): Promise<null> {
  return invoke("reveal", { path });
}

// ---- the knowledge base ----

/** Where the vault is; null on a machine with no user config directory. */
export function knowledgeInfo(): Promise<KnowledgeInfo | null> {
  return invoke("knowledge_info");
}

/**
 * Point the vault at a folder, or back at the default with `null`.
 *
 * Moves nothing — both folders are left as they are, which is what makes an
 * existing Obsidian vault usable as-is.
 */
export function setKnowledgeDir(dir: string | null): Promise<KnowledgeInfo | null> {
  return invoke("set_knowledge_dir", { dir });
}

/** The vault as notes and the links between them. */
export function knowledgeGraph(): Promise<LinkGraph> {
  return invoke("knowledge_graph");
}

/** Observations awaiting the next dream. */
export function dreamStatus(): Promise<number> {
  return invoke("dream_status");
}

/**
 * Run one consolidation pass over the observation log. Streams
 * `dream-event`s (the `TurnEvent` shape, on its own channel) while it works,
 * and resolves with what the pass did.
 */
export function dream(args: {
  provider: string;
  model?: string;
  baseUrl?: string;
  thinking?: string;
}): Promise<DreamReport> {
  return invoke("dream", {
    provider: args.provider,
    model: args.model,
    baseUrl: args.baseUrl,
    thinking: args.thinking,
  });
}

/** Interrupt the in-flight dream; nothing is consumed. */
export function cancelDream(): Promise<null> {
  return invoke("cancel_dream");
}
