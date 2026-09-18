import { invoke } from "@tauri-apps/api/core";
import type {
  AsideResult,
  AgentConnectArgs,
  AgentTurnResult,
  ApprovalDecision,
  Blocker,
  BlockerList,
  CaptureReport,
  ChatKind,
  ChatMode,
  CompactResult,
  ConnectArgs,
  CouncilTurnRow,
  ProviderCredit,
  ConnectResult,
  DocumentInput,
  DreamReport,
  FolderGrant,
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
  PendingLaunch,
  NightshiftUsage,
  InterviewView,
  InterviewWritten,
  ProjectInfo,
  ProjectsFolderInfo,
  NewProjectPath,
  UsageSummary,
  PlanUsage,
  CliMemoryFile,
  CliPromptSnapshot,
  EditableLayer,
  PromptLayer,
  PromptLayersInfo,
  Proposal,
  ProposalEntry,
  ProposalNotice,
  ProposalScope,
  ProviderInfo,
  DreamCommit,
  BuildStamp,
  TidyOutcome,
  RevertPreview,
  Schedules,
  SearchBackendInfo,
  ShiftSummary,
  ContextEdit,
  MessageEdit,
  RemoteStatus,
  SessionEvent,
  SessionMeta,
  SessionHit,
  SearchResult,
  SearchScope,
  TurnResult,
  WireView,
} from "./types";
import type { CouncilRequest } from "./council";

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

/** Context windows for `models` on `provider`, null where the table is silent. */
export function contextLimits(
  provider: string,
  models: string[],
): Promise<(number | null)[]> {
  return invoke("context_limits", { provider, models });
}

/** Rewind to the turn at log index `to`; resolves with the new transcript. */
export function rewind(to: number): Promise<SessionEvent[]> {
  return invoke("rewind", { to });
}

/**
 * Lift the rewind recorded at log index `of` — the undo of a rewind
 * (nightshift backlog 064); resolves with the new transcript. On Claude
 * Code the chat goes back to resuming the CLI file the rewind was cut
 * from, which is still on disk.
 */
export function unrewind(of: number): Promise<SessionEvent[]> {
  return invoke("unrewind", { of });
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
    preamble: args.preamble,
    ask: args.ask,
    plan: args.plan,
    promptSuggestions: args.promptSuggestions,
    effort: args.effort,
    fallbackModel: args.fallbackModel,
    subagentsAuto: args.subagentsAuto,
    limits: args.limits,
  });
}

/**
 * Run one turn on the agent engine. Streams the same `turn-event`s the
 * provider path does, which is what lets the transcript render both without
 * knowing which produced a turn. Attachments take the same shape `send`
 * takes; the backend hands them to the CLI on stdin rather than argv.
 */
export function sendAgent(
  text: string,
  images?: ImageInput[],
  documents?: DocumentInput[],
  council?: CouncilRequest,
): Promise<AgentTurnResult> {
  return invoke("send_agent", { text, images, documents, council });
}

/**
 * The recent council turns across the chats of the open project
 * (nightshift backlog 149): each chat's `<council>` records, newest first,
 * for Settings → Council's table.
 */
export function councilTurns(limit = 30): Promise<CouncilTurnRow[]> {
  return invoke("council_turns", { limit });
}

/**
 * What each provider says is left on its key (backlog 149, blocker 244):
 * OpenRouter's credits endpoint where a key is stored; the others say
 * `not exposed`.
 */
export function providerCredits(): Promise<ProviderCredit[]> {
  return invoke("provider_credits");
}

/**
 * A side question on the open chat's warm cache, kept out of it (nightshift
 * backlog 081): the CLI's `/btw`, done as a throwaway fork. Rejects with a
 * sentence when the chat has no Claude Code session yet. `seq` is the
 * card's number, echoed on each `aside-delta` event while the answer
 * streams (nightshift backlog 128).
 */
export function askAside(text: string, seq: number): Promise<AsideResult> {
  return invoke("ask_aside", { text, seq });
}

/**
 * Interrupt the aside, if any (review F13, 2026-09-16): the × on the aside
 * card. Reaches an aside still waiting behind a running turn as well as one
 * that is running, and leaves the turn alone; `askAside` then rejects with
 * "the aside was cancelled" or resolves with an interrupted answer.
 */
export function cancelAside(): Promise<null> {
  return invoke("cancel_aside");
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
 * repeating the call; it is ignored for the other decisions. `answer` is the
 * replacement input a deferred call runs with on the Claude Code engine — a
 * question's answers, an approved plan — and is ignored elsewhere.
 */
export function approveCall(
  id: string,
  name: string,
  decision: ApprovalDecision,
  reason?: string,
  answer?: unknown,
  then?: "ask" | "auto",
  grant?: FolderGrant,
): Promise<null> {
  return invoke("approve_call", {
    id,
    name,
    decision,
    reason,
    answer,
    then,
    grantDir: grant?.dir,
    grantScope: grant?.scope,
  });
}

export function listSessions(): Promise<SessionMeta[]> {
  return invoke("list_sessions");
}

export function searchSessions(query: string): Promise<SessionHit[]> {
  return invoke("search_sessions", { query });
}

/** The search-everywhere panel's query (nightshift backlog 117): results
 *  per message grouped by chat, or per line grouped by note. */
export function searchEverywhere(
  query: string,
  scope: SearchScope,
): Promise<SearchResult> {
  return invoke("search_everywhere", { query, scope });
}

/** `active` is the open chat's id (backlog 136): with a turn running, the
 *  backend refuses to touch that chat and acts on any other at once
 *  instead of waiting the turn out. */
export function renameSession(id: string, title: string, active: string | null = null): Promise<void> {
  return invoke("rename_session", { id, title, active });
}

/**
 * Retitle and enable the macOS Edit menu's Undo and Redo (nightshift
 * backlog 064): the operation each would reverse, or null for nothing;
 * `textField` when the focus is in a text box, which keeps the plain
 * items enabled for the box's own history. A no-op elsewhere.
 */
export function setUndoMenu(
  undo: string | null,
  redo: string | null,
  textField: boolean,
): Promise<void> {
  return invoke("set_undo_menu", { undo, redo, textField });
}

/**
 * New chat: leave the open one and say what kind the next one will be;
 * `mode` absent is an ordinary one (see `ChatMode`). Nothing is created —
 * the first message creates the log in that kind — so what comes back is
 * the kind, not an id (nightshift backlog 061, 2026-09-15).
 */
/**
 * Leave the open chat and say what the next one will be: its privacy
 * (`mode`) and what it is for (`kind`, nightshift backlog 102). Nothing is
 * created; the first message makes the log in that mode and kind.
 */
export function newSession(
  mode?: ChatMode,
  kind?: ChatKind,
): Promise<{ mode: ChatMode; kind: ChatKind }> {
  return invoke("new_session", { mode, kind });
}

export function openSession(id: string): Promise<SessionEvent[]> {
  return invoke("open_session", { id });
}

/** A chat's log read from disk without opening it (backlog 159): the view
 *  while a turn runs elsewhere. */
export function peekSession(id: string): Promise<SessionEvent[]> {
  return invoke("peek_session", { id });
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
export function deleteSession(id: string, active: string | null = null): Promise<string> {
  return invoke("delete_session", { id, active });
}

/** Put a deleted session back from the trash (nightshift backlog 064). */
export function restoreSession(id: string): Promise<string> {
  return invoke("restore_session", { id });
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

/**
 * Reword the turn at `index` (nightshift backlog 062). `save` records an
 * `edit` marker on this chat; `send` forks the chat before the turn and
 * makes the fork the open chat, after which the caller sends the text as
 * an ordinary turn. On Claude Code both also rewrite the CLI's history by
 * copy, and a refusal there is the error, with nothing recorded.
 */
export function editMessage(
  index: number,
  text: string,
  mode: "save" | "send",
): Promise<MessageEdit> {
  return invoke("edit_message", { index, text, mode });
}

/**
 * Reword one text block of the reply at `index` (nightshift backlog 066):
 * `edit_message` with `block`, an index into the reply's `blocks`; the
 * calls and the other text blocks around it stay where they were.
 */
export function editBlock(index: number, block: number, text: string): Promise<MessageEdit> {
  return invoke("edit_message", { index, text, mode: "save", block });
}

/** Remove the turn at `index` from the context: the `elide` marker, from the transcript. */
export function removeMessage(index: number): Promise<MessageEdit> {
  return invoke("remove_message", { index });
}

/**
 * Remove one block of the reply at `index` from the context (nightshift
 * backlog 066): a text block, or a tool call with its result — the pair
 * leaves together. On Claude Code the CLI's copy drops the nodes.
 */
export function removeBlock(index: number, block: number): Promise<MessageEdit> {
  return invoke("remove_block", { index, block });
}

/** Put back a block `removeBlock` took out. */
export function restoreBlock(index: number, block: number): Promise<MessageEdit> {
  return invoke("restore_block", { index, block });
}

/**
 * Put back the turn `removeMessage` took out (nightshift backlog 064): the
 * `unelide` marker; on Claude Code a third copy of the CLI's file with the
 * turn's nodes back from the original, recorded and resumed.
 */
export function restoreMessage(index: number): Promise<MessageEdit> {
  return invoke("restore_message", { index });
}

/** Fork the open chat before the user turn at `upto`; the fork becomes the open chat. */
export function forkSession(upto: number): Promise<MessageEdit> {
  return invoke("fork_session", { upto });
}

/** A fresh chat that continues the open one after a hand-off (nightshift
 *  backlog 086): empty, same folder, linked with `reason: "handoff"`. */
export function continueSession(): Promise<MessageEdit> {
  return invoke("continue_session");
}

/** The open chat's switched-off prompt layers, and what the engine was built with. */
export function promptLayers(): Promise<PromptLayersInfo> {
  return invoke("prompt_layers");
}

/**
 * Record which prompt layers the open chat excludes. Resolves with the new
 * transcript — the event lands in the log — and changes nothing on the wire
 * until the caller reconnects, which `setPromptLayers` in state.svelte.ts
 * does.
 */
export function setPromptLayers(off: PromptLayer[]): Promise<SessionEvent[]> {
  return invoke("set_prompt_layers", { off });
}

/**
 * Make the open chat the other kind from the next turn on (nightshift
 * backlog 144). Resolves with the new transcript — a `kind` event lands in
 * the log — and changes nothing on the wire until the caller reconnects,
 * which `switchChatKind` in state.svelte.ts does. `workspace` is the
 * folder for a switch to Claude Code on a chat born as a Chat; the
 * project's when omitted. Refused when the folder does not exist.
 */
export function setChatKind(kind: ChatKind, workspace?: string): Promise<SessionEvent[]> {
  return invoke("set_chat_kind", { kind, workspace });
}

/**
 * Set the extra folders the open chat may see (nightshift backlog 143) —
 * the whole list. Resolves with the new transcript; the caller reconnects
 * (`setChatFolders` in state.svelte.ts does). Refused on a missing folder.
 */
export function setChatFolders(folders: string[]): Promise<SessionEvent[]> {
  return invoke("set_chat_folders", { folders });
}

/**
 * Set a project's extra folders (backlog 143) — the whole list; applies to
 * its chats at their next connect. Resolves with the project as shown.
 */
export function setProjectFolders(id: string, folders: string[]): Promise<ProjectInfo> {
  return invoke("set_project_folders", { id, folders });
}

/**
 * Record the open chat's own text for one layer — the file's body as this
 * chat should read it — or drop it with `text` null. Resolves with the new
 * transcript, like `setPromptLayers`, and changes nothing on the wire until
 * the caller reconnects (`setPromptLayerText` in state.svelte.ts does).
 */
export function setPromptLayerText(
  kind: EditableLayer,
  text: string | null,
): Promise<SessionEvent[]> {
  return invoke("set_prompt_layer_text", { kind, text });
}

/**
 * What an editable layer reads from disk right now, as the body a user
 * could edit: the seed for *Edit for this chat*. Null when nothing is on
 * disk. For the project walk, the files joined with a blank line, outermost
 * first.
 */
export function promptLayerFile(kind: EditableLayer): Promise<string | null> {
  return invoke("prompt_layer_file", { kind });
}

/** Claude Code's auto memory for the built cwd, for the Context page's
 *  card (nightshift backlog 088). Read-only. */
export function cliMemoryFile(): Promise<CliMemoryFile> {
  return invoke("cli_memory_file");
}

/** Claude Code's own system prompt for the open chat, from the CLI's
 *  session file (nightshift backlog 077). Read-only; null before the first
 *  turn, for an ephemeral chat, and on the other engine. */
export function cliPromptSnapshot(): Promise<CliPromptSnapshot | null> {
  return invoke("cli_prompt_snapshot");
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

/** Where new projects go; null on a machine with no user config directory. */
export function projectsFolderInfo(): Promise<ProjectsFolderInfo | null> {
  return invoke("projects_folder_info");
}

/**
 * Point new projects at a folder, or back at the default with `null`.
 * Moves nothing — the projects already made stay where they are.
 */
export function setProjectsFolder(dir: string | null): Promise<ProjectsFolderInfo | null> {
  return invoke("set_projects_folder", { dir });
}

/**
 * What Claude Code has cost, from the ledger under `~/.claude`. Never
 * rejects for a missing ledger — that comes back as `available: false`
 * with the reason, so Settings can open on a machine with no collector.
 */
export function usageLedger(): Promise<UsageSummary> {
  return invoke("usage_ledger");
}

/** Run the collector now and return the fresh summary; a few seconds. */
export function refreshUsageLedger(): Promise<UsageSummary> {
  return invoke("refresh_usage_ledger");
}

/**
 * The plan's five-hour and seven-day percentages for the top bar
 * (nightshift backlog 073). Two local files, the fresher sample wins;
 * never rejects for a machine with neither — that is `source: "none"`.
 */
export function planUsage(): Promise<PlanUsage> {
  return invoke("plan_usage");
}

/** The figure refreshed through the CLI's print-mode `/usage` when the
 *  files are over a minute old (backlog 166, blocker 264): exact, zero
 *  tokens, ~12 s on the backend. */
export function planUsageRefresh(): Promise<PlanUsage> {
  return invoke("plan_usage_refresh");
}

/** The folder a name would get, for the form's live path row. */
export function resolveNewProjectPath(name: string): Promise<NewProjectPath> {
  return invoke("resolve_new_project_path", { name });
}

/**
 * The New project form's Create: makes the folder (`path` when the user
 * picked one, else `<projects folder>/<slug>`), writes `AGENTS.md` when
 * instructions were given, registers under the typed name. Never idempotent
 * and never a picker — that is `createProject` from `pickFolder`.
 */
export function newProject(
  name: string,
  path: string | null,
  instructions: string,
): Promise<ProjectInfo> {
  return invoke("new_project", { name, path, instructions });
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

// ---- proposals: the dream's suggested edits to the two fixed files ----
//
// Listed, read, dismissed, marked applied — never written to the file from
// here. Applying is the editor's ordinary `saveNote` of a draft; `markApplied`
// only records afterwards what was saved.

/** Pending proposals for a fixed file, newest first. */
export function listProposals(scope: ProposalScope): Promise<ProposalEntry[]> {
  return invoke("list_proposals", { scope });
}

export function readProposal(scope: ProposalScope, id: string): Promise<Proposal> {
  return invoke("read_proposal", { scope, id });
}

/** Move a proposal aside as turned down; it is kept under `dismissed/`. */
export function dismissProposal(scope: ProposalScope, id: string): Promise<null> {
  return invoke("dismiss_proposal", { scope, id });
}

/** Record that the draft made from a proposal was saved, with the saved text. */
export function markApplied(scope: ProposalScope, id: string, text: string): Promise<null> {
  return invoke("mark_applied", { scope, id, text });
}

/** Show a folder in the OS file manager; defaults to the docspace. */
export function reveal(path?: string): Promise<null> {
  return invoke("reveal", { path });
}

/** A file a reply named that exists, for the card under the reply
 *  (nightshift backlog 078). */
export interface NamedFile {
  path: string;
  size: number;
}

/** Which of these paths are real files: one answer per path, in order,
 *  null for anything that is not an existing regular file. */
export function namedFiles(paths: string[]): Promise<(NamedFile | null)[]> {
  return invoke("named_files", { paths });
}

/** Show one file in the OS file manager, selected. Creates nothing. */
export function revealFile(path: string): Promise<null> {
  return invoke("reveal_file", { path });
}

/** Open a file in the application the OS pairs it with. */
export function openFile(path: string): Promise<null> {
  return invoke("open_file", { path });
}

/** Open an `https://` link in the browser. */
export function openUrl(url: string): Promise<null> {
  return invoke("open_url", { url });
}

/** Post a banner through the OS notification centre (nightshift backlog
 *  079). Whether to — the window's focus, the setting — is decided here in
 *  `notify.ts`; the backend only posts. */
export function notify(title: string, body: string): Promise<null> {
  return invoke("notify", { title, body });
}

/** The Refresh-now banner (backlog 116): its click comes back as the
 *  `usage-banner-clicked` event. */
export function notifyUsageRefreshed(title: string, body: string): Promise<null> {
  return invoke("notify_usage_refreshed", { title, body });
}

/** The keep-awake switches (nightshift backlog 101), for the holder in
 *  `power.rs`; `sleep.ts` keeps them and sends them at start-up and on
 *  each change. */
export function setPowerPrefs(prefs: { keepAwake: boolean; keepDisplayAwake: boolean }): Promise<null> {
  return invoke("set_power_prefs", { prefs });
}

/** Whole-app zoom (nightshift backlog 108): the webview's page zoom, 1 is
 *  Actual Size. `zoom.ts` keeps the factor; Rust only sets it. */
export function setZoom(factor: number): Promise<null> {
  return invoke("set_zoom", { factor });
}

/** The terminal pane's shells (nightshift backlog 113; `terminal.rs`). A
 *  shell is a pty in `cwd` running the login shell; its output arrives as
 *  `terminal-data` events (base64), its end as `terminal-exit`, and the
 *  foreground command's name as `terminal-title`. */
export interface ShellInfo {
  id: number;
  pid: number | null;
  shell: string;
  cwd: string;
}
export function terminalOpen(cwd: string, cols: number, rows: number): Promise<ShellInfo> {
  return invoke("terminal_open", { cwd, cols, rows });
}
export function terminalWrite(id: number, data: string): Promise<null> {
  return invoke("terminal_write", { id, data });
}
export function terminalResize(id: number, cols: number, rows: number): Promise<null> {
  return invoke("terminal_resize", { id, cols, rows });
}
export function terminalClose(id: number): Promise<null> {
  return invoke("terminal_close", { id });
}
/** xterm.js has drawn `bytes` more of a shell's output (backlog 135's
 *  flow control): past 256 KB unacknowledged the shell's output waits. */
export function terminalAck(id: number, bytes: number): Promise<null> {
  return invoke("terminal_ack", { id, bytes });
}

/** Where the per-model instruction files live (`~/.nightloom/models`);
 *  null on a machine with no user config directory. */
export function modelInstructionsDir(): Promise<string | null> {
  return invoke("model_instructions_dir");
}

/** Where the Chat instructions live (`~/.nightloom/CHAT.md`, nightshift
 *  backlog 102); null on a machine with no user config directory. */
export function chatInstructionsPath(): Promise<string | null> {
  return invoke("chat_instructions_path");
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
export function dream(args: PassArgs): Promise<DreamReport> {
  return invoke("dream", {
    provider: args.provider,
    model: args.model,
    baseUrl: args.baseUrl,
    thinking: args.thinking,
    binary: args.binary,
    safeMode: args.safeMode,
  });
}

/**
 * What a background pass runs on. `provider` is a provider kind, or
 * `"claude-code"` for the Claude Code engine (2026-09-16), in which case
 * `model` is a CLI alias and `binary` / `safeMode` are the rail's agent
 * settings; `baseUrl` and `thinking` are the provider's alone.
 */
export interface PassArgs {
  provider: string;
  model?: string;
  baseUrl?: string;
  thinking?: string;
  binary?: string;
  safeMode?: boolean;
}

/** Interrupt the in-flight dream; nothing is consumed. */
export function cancelDream(): Promise<null> {
  return invoke("cancel_dream");
}

/** Session logs with bytes past their capture watermark. */
export function captureStatus(): Promise<number> {
  return invoke("capture_status");
}

/**
 * Run one capture pass over the session logs. Streams `capture-event`s (the
 * `TurnEvent` shape, on its own channel) while it works, and resolves with
 * what the pass did.
 */
export function capture(args: PassArgs): Promise<CaptureReport> {
  return invoke("capture", {
    provider: args.provider,
    model: args.model,
    baseUrl: args.baseUrl,
    thinking: args.thinking,
    binary: args.binary,
    safeMode: args.safeMode,
  });
}

/** Interrupt the in-flight capture; the chat it stopped in is re-read next time. */
export function cancelCapture(): Promise<null> {
  return invoke("cancel_capture");
}

// ---- the notification centre and the daily pass (nightshift backlog 069) ----

/** Every pending proposal, the user's and every project's. */
export function centreProposals(): Promise<ProposalNotice[]> {
  return invoke("centre_proposals");
}

/** The newest dream commits per folder, with the files each touched. */
export function centreDreamCommits(limit?: number): Promise<DreamCommit[]> {
  return invoke("centre_dream_commits", { limit });
}

/** One dream commit's patch, whole or for one file. */
export function centreDreamDiff(repo: string, hash: string, file?: string): Promise<string> {
  return invoke("centre_dream_diff", { repo, hash, file });
}

/** Put one file back as it was before the dream's commit, committed; the
 *  sentence returned is the toast. */
export function centreRevertFile(repo: string, hash: string, file: string): Promise<string> {
  return invoke("centre_revert_file", { repo, hash, file });
}

/** The running build's version and binary stamp. */
export function buildStamp(): Promise<BuildStamp> {
  return invoke("build_stamp");
}

/** The tidy step over the vault and every project's memory folder: a dry
 *  run with `apply` false, a move (committed) with it true. */
export function tidyMemory(apply: boolean, days?: number): Promise<TidyOutcome[]> {
  return invoke("tidy_memory", { apply, days });
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

/** Scaffold a backlog item; returns the new id. */
export function nightshiftNewItem(projectId: string, title: string, kind: string): Promise<string> {
  return invoke("nightshift_new_item", { projectId, title, kind });
}

/** Move an item to backlog/trash/ and drop it from the order; returns where it went. */
export function nightshiftDeleteItem(projectId: string, id: string): Promise<string> {
  return invoke("nightshift_delete_item", { projectId, id });
}

/** Replace an item's whole text (the Edit screen's Save). */
export function nightshiftWriteItem(projectId: string, id: string, text: string): Promise<null> {
  return invoke("nightshift_write_item", { projectId, id, text });
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

/**
 * Hold a plan and launch it at `fireAtMs` (epoch milliseconds): the backend
 * writes `plan.json` — with the id re-minted to the launch moment — and
 * starts the runner, then emits `nightshift-launched`. Replaces a pending
 * launch on the same project; refused while a shift is live.
 */
export function nightshiftScheduleLaunch(
  projectId: string,
  plan: Plan,
  fireAtMs: number,
): Promise<PendingLaunch> {
  return invoke("nightshift_schedule_launch", { projectId, plan, fireAtMs });
}

export function nightshiftCancelLaunch(projectId: string): Promise<null> {
  return invoke("nightshift_cancel_launch", { projectId });
}

export function nightshiftPendingLaunch(
  projectId: string,
): Promise<PendingLaunch | null> {
  return invoke("nightshift_pending_launch", { projectId });
}

/** The runner's own usage probe (`bin/usagectl.py --json`), for the Start
 *  field's "when usage resets". Rejects when the probe is missing or unreadable. */
export function nightshiftUsage(projectId: string): Promise<NightshiftUsage> {
  return invoke("nightshift_usage", { projectId });
}

export function nightshiftInterviewStart(projectId: string, idea: string, model?: string): Promise<InterviewView> {
  return invoke("nightshift_interview_start", { projectId, idea, model: model ?? null });
}
export function nightshiftInterviewSend(projectId: string, text: string): Promise<InterviewView> {
  return invoke("nightshift_interview_send", { projectId, text });
}
export function nightshiftInterviewState(projectId: string): Promise<InterviewView | null> {
  return invoke("nightshift_interview_state", { projectId });
}
export function nightshiftInterviewCancel(projectId: string): Promise<null> {
  return invoke("nightshift_interview_cancel", { projectId });
}
export function nightshiftInterviewWrite(projectId: string): Promise<InterviewWritten> {
  return invoke("nightshift_interview_write", { projectId });
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

// ---- the phone page over the tailnet (nightshift backlog 091, Shape B) ----
// The listener's switch and its token; `remote.rs`. Off by default; every
// call answers with the card's whole state.

export function remoteStatus(): Promise<RemoteStatus> {
  return invoke("remote_status");
}

/** Bind the Mac's tailnet address at `port` (the last one when omitted);
 *  refused with a sentence naming Tailscale when there is none. */
export function remoteStart(port?: number): Promise<RemoteStatus> {
  return invoke("remote_start", { port: port ?? null });
}

export function remoteStop(): Promise<RemoteStatus> {
  return invoke("remote_stop");
}

export function remoteSetKeepAwake(on: boolean): Promise<RemoteStatus> {
  return invoke("remote_set_keep_awake", { on });
}

/** The token, made if there is none; `regenerate` replaces it, and every
 *  phone must scan again. */
export function remoteToken(regenerate: boolean): Promise<RemoteStatus> {
  return invoke("remote_token", { regenerate });
}

/** The window's answer to a phone's `remote-send` (backlog 132): the
 *  listener is waiting on it to answer the phone — sent, queued behind
 *  the chat's turn, or not taken and why. */
export function remoteSent(id: number, queued: boolean, error: string | null): Promise<null> {
  return invoke("remote_sent", { id, queued, error });
}
