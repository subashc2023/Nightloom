import { invoke } from "@tauri-apps/api/core";
import type {
  AgentConnectArgs,
  AgentTurnResult,
  ApprovalDecision,
  Blocker,
  BlockerList,
  CompactResult,
  ConnectArgs,
  ConnectResult,
  DocumentInput,
  DreamReport,
  ImageInput,
  ImportSummary,
  Item,
  ItemList,
  KnowledgeInfo,
  LinkGraph,
  Morning,
  MorningPage,
  Note,
  NoteEntry,
  NoteScope,
  NightshiftRow,
  Plan,
  ProjectInfo,
  ProviderInfo,
  RevertPreview,
  Schedules,
  SearchBackendInfo,
  ShiftSummary,
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

// ---- Nightshift ----

/** Every registered project with whether it is a Nightshift project. */
export function nightshiftProjects(): Promise<NightshiftRow[]> {
  return invoke("nightshift_projects");
}

/** One row, fresh — what the surface re-reads on a change event. */
export function nightshiftProject(projectId: string): Promise<NightshiftRow> {
  return invoke("nightshift_project", { projectId });
}

/**
 * **Enable Nightshift** on a project: scaffold `<workspace>/nightshift/`.
 * `kind` defaults to `research`. Resolves with the row and the scaffold's
 * notes (what it could not do).
 */
export function nightshiftEnable(
  projectId: string,
  kind?: string,
  runner?: string,
): Promise<[NightshiftRow, string[]]> {
  return invoke("nightshift_enable", { projectId, kind, runner });
}

/**
 * **Disable Nightshift** on a project: rename `nightshift.json` to
 * `nightshift.json.disabled`. Deletes nothing; refused while a shift is
 * live. Only after the warning has been shown and confirmed.
 */
export function nightshiftDisable(projectId: string): Promise<NightshiftRow> {
  return invoke("nightshift_disable", { projectId });
}

/**
 * The one runner install a registered project shows — the nightshift repo
 * itself when it is a project here — or null. What the Enable form starts
 * with.
 */
export function nightshiftDefaultRunner(): Promise<string | null> {
  return invoke("nightshift_default_runner");
}

export function nightshiftItems(projectId: string): Promise<ItemList> {
  return invoke("nightshift_items", { projectId });
}

export function nightshiftItem(projectId: string, id: string): Promise<Item> {
  return invoke("nightshift_item", { projectId, id });
}

/** Rewrite `backlog/order.json`. Refused while a shift is live. */
export function nightshiftSetOrder(
  projectId: string,
  order: string[],
): Promise<string[]> {
  return invoke("nightshift_set_order", { projectId, order });
}

export function nightshiftBlockers(projectId: string): Promise<BlockerList> {
  return invoke("nightshift_blockers", { projectId });
}

/**
 * Write `## Answer` and flip `status` to `answered` — the two edits the
 * contract gives the GUI. Refused while a shift is live.
 */
export function nightshiftAnswerBlocker(
  projectId: string,
  id: string,
  answer: string,
): Promise<Blocker> {
  return invoke("nightshift_answer_blocker", { projectId, id, answer });
}

export function nightshiftShifts(projectId: string): Promise<ShiftSummary[]> {
  return invoke("nightshift_shifts", { projectId });
}

export function nightshiftShift(
  projectId: string,
  shiftId: string,
): Promise<ShiftSummary> {
  return invoke("nightshift_shift", { projectId, shiftId });
}

/** The last `maxBytes` of a shift's `run.log` (default 64 KiB). */
export function nightshiftShiftLog(
  projectId: string,
  shiftId: string,
  maxBytes?: number,
): Promise<string> {
  return invoke("nightshift_shift_log", { projectId, shiftId, maxBytes });
}

/**
 * A plan the way `shiftctl plan synth` would write it, with a fresh shift
 * id, for the plan form to start from. Writes nothing.
 */
export function nightshiftSynthPlan(
  projectId: string,
  maxUnits?: number,
  until?: string,
  budgetUsd?: number,
): Promise<Plan> {
  return invoke("nightshift_synth_plan", {
    projectId,
    maxUnits,
    until,
    budgetUsd,
  });
}

/**
 * Write `shifts/<id>/plan.json`. Resolves with its root-relative path — the
 * argument `nightshiftLaunch` takes. Refused while a shift is live and when
 * the plan exists.
 */
export function nightshiftWritePlan(
  projectId: string,
  plan: Plan,
): Promise<string> {
  return invoke("nightshift_write_plan", { projectId, plan });
}

/**
 * Launch the runner on a written plan, detached. macOS only; elsewhere it
 * rejects saying so. Resolves with the wrapper pid.
 */
export function nightshiftLaunch(
  projectId: string,
  planPath: string,
): Promise<number> {
  return invoke("nightshift_launch", { projectId, planPath });
}

export function nightshiftMornings(projectId: string): Promise<Morning[]> {
  return invoke("nightshift_mornings", { projectId });
}

/**
 * A morning page by name, or the newest when `name` is omitted. `null` for a
 * project with no page yet — an ordinary state, not an error.
 */
export function nightshiftMorning(
  projectId: string,
  name?: string,
): Promise<MorningPage | null> {
  return invoke("nightshift_morning", { projectId, name });
}

export function nightshiftNotes(projectId: string): Promise<NoteEntry[]> {
  return invoke("nightshift_notes", { projectId });
}

/** Any text file inside the contract root by relative path. */
export function nightshiftReadFile(
  projectId: string,
  path: string,
): Promise<string> {
  return invoke("nightshift_read_file", { projectId, path });
}

/**
 * The last `limit` rows (default 200) of a jsonl stream, by `stream` =
 * `spend` | `adherence` | `limits`.
 */
export function nightshiftStream(
  projectId: string,
  stream: string,
  limit?: number,
): Promise<unknown[]> {
  return invoke("nightshift_stream", { projectId, stream, limit });
}

export function nightshiftSchedule(projectId: string): Promise<Schedules> {
  return invoke("nightshift_schedule", { projectId });
}

export function nightshiftSetSchedule(
  projectId: string,
  schedules: Schedules,
): Promise<Schedules> {
  return invoke("nightshift_set_schedule", { projectId, schedules });
}

/** What one unit changed: the diff of its commit. */
export function nightshiftDiff(
  projectId: string,
  sha: string,
): Promise<string> {
  return invoke("nightshift_diff", { projectId, sha });
}

/** What a whole shift changed: `head_at_start..HEAD` from its `status.json`. */
export function nightshiftShiftDiff(
  projectId: string,
  shiftId: string,
): Promise<string> {
  return invoke("nightshift_shift_diff", { projectId, shiftId });
}

/**
 * The diff a revert of this shift would discard, and whether the tree is
 * clean enough to do it. Shown before `nightshiftRevert` is offered.
 */
export function nightshiftRevertPreview(
  projectId: string,
  shiftId: string,
): Promise<RevertPreview> {
  return invoke("nightshift_revert_preview", { projectId, shiftId });
}

/**
 * `git reset --hard <head_at_start>`. Only with `confirm`; the caller has
 * shown the preview and the user has said yes. Never automatic.
 */
export function nightshiftRevert(
  projectId: string,
  shiftId: string,
  confirm: boolean,
): Promise<RevertPreview> {
  return invoke("nightshift_revert", { projectId, shiftId, confirm });
}

/**
 * Watch a project's contract root; a change emits a `nightshift-change`
 * window event (`NightshiftChange`). Replaces an existing watch on the same
 * project.
 */
export function nightshiftWatch(projectId: string): Promise<null> {
  return invoke("nightshift_watch", { projectId });
}

export function nightshiftUnwatch(projectId: string): Promise<null> {
  return invoke("nightshift_unwatch", { projectId });
}
