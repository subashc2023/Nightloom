import { invoke } from "@tauri-apps/api/core";
import type {
  ApprovalDecision,
  CompactResult,
  ConnectArgs,
  ConnectResult,
  DocumentInput,
  ImageInput,
  Note,
  ProjectInfo,
  ProviderInfo,
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
    workspace: args.workspace,
  });
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
export function pickFolder(): Promise<string | null> {
  return invoke("pick_folder");
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

// ---- the shared notes docspace ----

export function listNotes(): Promise<Note[]> {
  return invoke("list_notes");
}

export function readNote(name: string): Promise<string> {
  return invoke("read_note", { name });
}

/** Write a note. Also how one is created; an empty note is a real note. */
export function saveNote(name: string, content: string): Promise<Note> {
  return invoke("save_note", { name, content });
}

export function deleteNote(name: string): Promise<null> {
  return invoke("delete_note", { name });
}

/** Show a folder in the OS file manager; defaults to the docspace. */
export function reveal(path?: string): Promise<null> {
  return invoke("reveal", { path });
}
