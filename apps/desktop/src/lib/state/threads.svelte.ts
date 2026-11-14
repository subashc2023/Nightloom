// Moved out of state.svelte.ts by item 641 (pure move; state.svelte.ts re-exports every name it exported).
import { peekThreadHandoff, takeThreadHandoff } from "../threadHandoff.svelte";
import * as api from "../api";
import { noteThread, noteThreadFlags } from "../handoff.svelte";
import { boxForHandoff, replaceStartHere, threadOfEvents } from "../thread";
import { clearDraft, moveDraft, newDraftKey, readDraft, setDraftText, hasDraft } from "../drafts.svelte";
import { requestComposerFocus } from "../rewindDraft.svelte";
import { madeChatRow } from "../afterWrite";
import * as tabs from "../tabs";
import type { TabContent } from "../tabs";
import type { ChatKind, ChatMode, SessionEvent } from "../types";
import { showNote, noteDraftKey } from "./notes.svelte";
import { chatScope, pushUndo, contextUsed } from "./edits.svelte";
import { app, adoptChatRules, applyDraft, refreshSessions, newSession, addToast, liveFlags } from "../state.svelte";

/**
 * What the open chat was started as, projected from the log the way
 * `Session::mode()` projects it in the core: the first `session_created`
 * line's `mode`, `normal` when it carries none — and, when there is no
 * chat yet, the kind the next one will be (`app.pendingMode`), the same
 * fallback the backend's `session_mode` makes. A rewind cannot reach the
 * creation line, so this never reads the live flags.
 */
export function chatMode(events: SessionEvent[]): ChatMode {
  for (const e of events) {
    if (e.event === "session_created") return e.mode ?? "normal";
  }
  return app.pendingMode;
}

/**
 * What the open chat is for (nightshift backlog 102), projected from the
 * log: ~~the creation line's `kind`~~ — since backlog 144 (2026-09-17) the
 * latest live `kind` event, as `Session::kind()` reads it in the core, and
 * only where there is none the creation line's (`build` when it carries
 * none), and the pending kind while there is no chat yet. Live, like a
 * title: a rewind past a switch restores the kind before it.
 */
export function chatKind(events: SessionEvent[]): ChatKind {
  const live = liveFlags(events);
  for (let i = events.length - 1; i >= 0; i--) {
    if (!live[i]) continue;
    const e = events[i];
    if (e.event === "kind") return e.kind;
  }
  return bornKind(events);
}

/** What the chat was started as — the creation line, which a switch never
 *  rewrites — or the pending kind with no chat open. */
export function bornKind(events: SessionEvent[]): ChatKind {
  for (const e of events) {
    if (e.event === "session_created") return e.kind ?? "build";
  }
  return app.pendingKind;
}

/**
 * What the engine's request is *built* for (`Session::declared_kind`,
 * nightshift backlog 144): `build` once the chat was born one or has ever
 * been switched to one over the live events, else `chat`. A switch changes
 * the policy (`chatKind`) and leaves this alone, so the declared tools and
 * the system prompt — and with them the cached prefix — survive it; the
 * one switch that changes it is a chat born as a Chat becoming Claude
 * Code, which pays one re-warm (`kindSwitchCost`).
 */
export function declaredKind(events: SessionEvent[]): ChatKind {
  if (bornKind(events) === "build") return "build";
  const live = liveFlags(events);
  return events.some((e, i) => live[i] && e.event === "kind" && e.kind === "build")
    ? "build"
    : "chat";
}

/**
 * What switching the open chat to `kind` would cost on the next turn, in
 * tokens written to the cache — `contextUsed()` when the declaration
 * changes (a chat born as a Chat becoming Claude Code: the tools were
 * never declared), and nothing otherwise, since the switch is a policy
 * over an unchanged request. Null when nothing has been sent yet.
 */
export function kindSwitchCost(events: SessionEvent[], kind: ChatKind): number | null {
  if (kind === declaredKind(events)) return 0;
  if (kind === "chat") return 0;
  return contextUsed() ?? null;
}

/**
 * Make the open chat the other kind from the next turn on (nightshift
 * backlog 144; blocker 143 answered *switchable*). The same two steps as
 * a layer switch: the log first (creating the chat's log if the first
 * send has not yet), then the reconnect that reads it back — `connect` /
 * `connect_agent` build the declaration from `declaredKind` and enforce
 * `chatKind` over it. `workspace` is the folder for a switch to Claude
 * Code on a chat born as a Chat; the project's when omitted. Undoable,
 * scoped to the chat; a switch on a live turn is refused like a layer
 * change.
 */
export async function switchChatKind(kind: ChatKind, workspace?: string): Promise<void> {
  if (app.busy || app.connecting) return;
  const current = chatKind(app.events);
  const before = kindWorkspace(app.events);
  if (kind === current && (workspace ?? null) === before) return;
  if (!(await applyKind(kind, workspace))) return;
  pushUndo(chatScope(), {
    label: `kind → ${kind === "chat" ? "Chat" : "Claude Code"}`,
    undo: async () => {
      await applyKind(current, before ?? undefined);
    },
    redo: async () => {
      await applyKind(kind, workspace);
    },
  });
}

/** The folder the latest live switch to Claude Code named, if any. */
export function kindWorkspace(events: SessionEvent[]): string | null {
  const live = liveFlags(events);
  for (let i = events.length - 1; i >= 0; i--) {
    if (!live[i]) continue;
    const e = events[i];
    if (e.event === "kind") return e.kind === "build" ? (e.workspace ?? null) : null;
  }
  return null;
}

/**
 * The pending chat's draft key while no chat is open, else null — taken
 * before a setting's call that may create the chat's log (nightshift
 * backlog 420).
 */
export function pendingChatKey(): string | null {
  return app.activeSessionId === null ? newDraftKey(app.project?.id, app.pendingMode, app.pendingThread) : null;
}

/**
 * Pick up the id of a chat whose log a setting's call just created (the
 * thread, the kind, the folders, the prompt layers), the way `send` does,
 * so the sidebar and the next open agree on which chat this is — and,
 * when the call was made on the pending New chat (`pending`, from
 * `pendingChatKey`), carry what its box held over to that chat: the
 * pending chat became this one. Before backlog 420 (2026-10-27) the words
 * stayed under the pending key, so binding a draft New chat to a thread
 * showed the bound chat with an empty box and the draft back on a second
 * New chat.
 */
export function adoptCreatedChat(pending: string | null): void {
  const first = app.events[0];
  if (!first || first.event !== "session_created") return;
  app.activeSessionId = first.id;
  if (pending !== null && pending !== first.id) moveDraft(pending, first.id);
}

/** The two steps of a kind switch: the log, then the reconnect that reads
 *  it back. False on a refusal, toasted. */
async function applyKind(kind: ChatKind, workspace?: string): Promise<boolean> {
  const pending = pendingChatKey();
  try {
    await writePendingThread();
    app.events = await api.setChatKind(kind, workspace);
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
 * The extra folders the open chat has granted itself (nightshift backlog
 * 143), projected from the log as `Session::folders()` projects them: the
 * latest live `folders` event, or none. The project's own are on
 * `app.project.extra_folders`; the connection's `folders` is the union
 * the backend granted, with each one's source and alias.
 */
export function chatFolders(events: SessionEvent[]): string[] {
  const live = liveFlags(events);
  for (let i = events.length - 1; i >= 0; i--) {
    if (!live[i]) continue;
    const e = events[i];
    if (e.event === "folders") return e.folders;
  }
  return [];
}

/**
 * Set the open chat's extra folders — the whole list (backlog 143). The
 * same two steps as a layer switch: the log first, creating the chat's
 * log if the first send has not yet, then the reconnect that grants each
 * folder on the engine in use. Undoable, scoped to the chat.
 */
export async function setChatFolders(folders: string[]): Promise<void> {
  if (app.busy || app.connecting) return;
  const current = chatFolders(app.events);
  const wanted = folders.filter((f, i) => f.trim() !== "" && folders.indexOf(f) === i);
  if (wanted.join("\n") === current.join("\n")) return;
  if (!(await applyFolders(wanted))) return;
  pushUndo(chatScope(), {
    label: wanted.length > current.length ? "add a folder" : "remove a folder",
    undo: async () => {
      await applyFolders(current);
    },
    redo: async () => {
      await applyFolders(wanted);
    },
  });
}

/**
 * The open chat's research thread (nightshift backlog 271), projected
 * from the log like the folders: the latest live `thread` event, or null;
 * and, when there is no chat yet, the thread the next one will be in
 * (`app.pendingThread`, item 510), as `chatMode` falls back on its pending
 * kind, so the chip, the picker and the hand-off all see it.
 */
export function chatThread(events: SessionEvent[]): string | null {
  return threadOfEvents(events, liveFlags(events)) ?? (app.activeSessionId === null ? app.pendingThread : null);
}

/**
 * Bind the open chat to a research thread, or unbind it (null) — the same
 * two steps as the folders: the log first, then the reconnect that builds
 * the thread layer. Undoable, scoped to the chat. The binding is noted for
 * the hand-off at once, so the wrap-up and the read order follow it without
 * a reload. On the new-chat screen nothing is written (item 510): the pick
 * waits in `app.pendingThread` for the first send, and the box's words go
 * with it, as a binding has carried them since backlog 420.
 */
export async function setChatThread(slug: string | null): Promise<boolean> {
  if (app.busy || app.connecting) return false;
  const current = chatThread(app.events);
  const wanted = slug || null;
  if (wanted === current) return true;
  if (app.activeSessionId === null) {
    moveToPendingThread(wanted);
    pushUndo(chatScope(), {
      label: wanted ? `bind thread ${wanted}` : "unbind thread",
      undo: async () => moveToPendingThread(current),
      redo: async () => moveToPendingThread(wanted),
    });
    return true;
  }
  if (!(await applyThread(wanted))) return false;
  pushUndo(chatScope(), {
    label: wanted ? `bind thread ${wanted}` : "unbind thread",
    undo: async () => {
      await applyThread(current);
    },
    redo: async () => {
      await applyThread(wanted);
    },
  });
  return true;
}

/**
 * Make the New chat on screen a chat now, without sending, and return its
 * id (nightshift backlog 527: Send later from a New chat needs an id to
 * wait under). The shape of `applyThread`: a waiting thread is bound
 * first, the box's words follow the chat (`adoptCreatedChat`), and the
 * sidebar shows the row. An open chat's id comes back unchanged; null on
 * a refusal, toasted.
 */
export async function startPendingChat(): Promise<string | null> {
  if (app.activeSessionId !== null) return app.activeSessionId;
  const pending = pendingChatKey();
  try {
    await writePendingThread();
    if (app.activeSessionId === null) {
      app.events = await api.startChat();
      adoptCreatedChat(pending);
    }
    app.error = null;
  } catch (e) {
    addToast(String(e));
    return null;
  }
  await applyDraft();
  void refreshSessions();
  return app.activeSessionId;
}

async function applyThread(slug: string | null): Promise<boolean> {
  const pending = pendingChatKey();
  try {
    app.events = await api.setChatThread(slug);
    adoptCreatedChat(pending);
    app.error = null;
    noteThread(app.activeSessionId, slug);
    if (slug) void refreshThreadFlags(slug);
  } catch (e) {
    addToast(String(e));
    return false;
  }
  await applyDraft();
  void refreshSessions();
  return true;
}

/**
 * Move a listed chat into a thread, or out of its thread (null) — the
 * sidebar's drag and its row menu's *Move to thread ▸* / *Remove from
 * thread* (nightshift backlog 288). The open chat goes the picker's way
 * (`setChatThread`: the reconnect that loads the thread layer, undoable);
 * any other chat gets the same `thread` line on its log through the
 * backend, and its row moves at once. Only a log line is written, so a
 * failed or refused move leaves the chat where it was — never dropped.
 */
export async function moveChatToThread(id: string, slug: string | null): Promise<boolean> {
  const wanted = slug || null;
  if (id === app.activeSessionId) {
    if (chatThread(app.events) === wanted) return true;
    if (app.busy || app.connecting) {
      addToast("This chat is running a turn — move it when the turn ends");
      return false;
    }
    return setChatThread(wanted);
  }
  const row = app.sessions.find((s) => s.id === id);
  if (row && (row.thread ?? null) === wanted) return true;
  try {
    await api.setSessionThread(id, wanted);
  } catch (e) {
    addToast(String(e));
    return false;
  }
  if (row) row.thread = wanted ?? undefined;
  noteThread(id, wanted);
  void refreshSessions();
  return true;
}

/** The first send's take of the saved hand-off (item 510): only a screen a
 *  thread's + opened; a thread picked on the chip never took one. */
let pendingFromPlus = false;
/** What a + put in each pending box, so that a later + can tell it from
 *  what he typed, and nothing but his words follows him. */
const prefilled = new Map<string, string>();

export function clearPendingThread(): void {
  app.pendingThread = null;
  pendingFromPlus = false;
}

/** The New chat tab brought back: as `newSession`, and the screen's thread
 *  with it (a view keeps its state; only an explicit New chat leaves it). */
export async function backToNewChat(): Promise<void> {
  const [thread, plus] = [app.pendingThread, pendingFromPlus];
  await newSession();
  if (app.activeSessionId !== null || (app.busy && !app.parked)) return;
  app.pendingThread = thread;
  pendingFromPlus = plus;
}

/**
 * The new-chat screen's thread changed by the chip (item 510): nothing is
 * written, and the box follows the binding, unless all it holds is the
 * hand-off a + put there, which stays with its thread.
 */
function moveToPendingThread(slug: string | null): void {
  const from = pendingChatKey();
  clearPendingThread();
  app.pendingThread = slug;
  const to = pendingChatKey();
  if (!from || !to || from === to) return;
  const d = readDraft(from);
  if (d.attachments.length === 0 && d.queue.length === 0 && d.text === prefilled.get(from)) return;
  moveDraft(from, to);
}

/** A thread went to the trash (item 510): its screen closes and what was
 *  typed under its + goes to the plain New chat, never with it; an unedited
 *  hand-off went with the thread's own file. */
export function pendingThreadDeleted(slug: string): void {
  if (app.pendingThread === slug) clearPendingThread();
  const project = app.project?.id;
  for (const mode of ["normal", "incognito"] as const) {
    const from = newDraftKey(project, mode, slug);
    if (!hasDraft(from)) continue;
    if (readDraft(from).text === prefilled.get(from)) clearDraft(from);
    else moveDraft(from, newDraftKey(project, mode));
    prefilled.delete(from);
  }
}

/**
 * The binding on the log, on the chat this makes, when the new-chat screen
 * has one waiting (item 510): the one place `pendingThread` reaches the
 * disk. False with nothing waiting; throws when the log was not written, and
 * nothing has moved then. A hand-off a + showed is taken here. Every call
 * that can make the chat's log writes this first, so a setting changed on
 * the screen cannot lose the thread.
 */
export async function writePendingThread(): Promise<boolean> {
  const slug = app.activeSessionId === null ? app.pendingThread : null;
  if (!slug) return false;
  const [pending, plus] = [pendingChatKey(), pendingFromPlus];
  const events = await api.setChatThread(slug);
  if (app.activeSessionId !== null || app.pendingThread !== slug) {
    throw new Error("The new chat was left before its thread was bound; nothing was sent");
  }
  app.events = events;
  adoptCreatedChat(pending);
  const id = app.activeSessionId as string | null;
  clearPendingThread();
  if (pending) prefilled.delete(pending);
  noteThread(id, slug);
  if (id) adoptChatRules(id);
  void refreshThreadFlags(slug);
  if (plus && id) await takeThreadHandoff(slug, id);
  return true;
}

let binding: Promise<boolean> | null = null;

/**
 * Before the first turn (item 510): the waiting thread on the log, then the
 * reconnect that loads its layer, since the thread must be on the chat before
 * the model's first word. False, with `app.error` saying why, when the turn
 * must not go: the caller keeps the words. Two sends at once share one bind.
 */
export function bindPendingThread(): Promise<boolean> {
  if (app.activeSessionId !== null || !app.pendingThread) return Promise.resolve(true);
  binding ??= runBind().finally(() => (binding = null));
  return binding;
}

async function runBind(): Promise<boolean> {
  // A connect in flight would swallow the one below (`applyDraft` defers),
  // and the turn would go without the thread's layer.
  if (app.connecting) {
    app.error = "Still connecting; nothing was sent. Send again in a moment";
    return false;
  }
  try {
    await writePendingThread();
  } catch (e) {
    app.error = String(e);
    return false;
  }
  await applyDraft();
  if (app.connectError || !app.connection) {
    app.error = app.connectError ?? "No engine is connected; nothing was sent";
    return false;
  }
  return true;
}

/** The bound chat's row, from what was sent (backlog 211's `showMadeChat`,
 *  in its thread): the list's re-read at the turn's end replaces it. */
export function showBoundChat(slug: string, sent: string): void {
  const id = app.activeSessionId;
  const row = id ? madeChatRow(app.sessions, id, sent || null, app.pendingMode, app.pendingKind) : null;
  if (row) app.sessions = [{ ...row, thread: slug }, ...app.sessions];
}

/**
 * *New chat in this thread* (nightshift backlog 288; item 510, his report
 * 2026-11-05) — the light hand-off: exactly the plain New chat, with the
 * screen bound to `slug`. Nothing is created until he sends: `pendingThread`
 * holds the thread, the first send binds it (`bindPendingThread`) so the
 * connect loads the thread layer, and the box has its own draft
 * (`newDraftKey`), so a plain New chat's words stay under theirs and the same
 * + finds these. ~~Bound at once, its log made here~~: that left an empty
 * session in the list on every click. The chat he was in is left as it is —
 * no wrap-up turn, no upkeep (a chat bound to the thread may still be
 * writing it). While a turn runs it opens as New chat does (`peekNew`).
 */
export async function newChatInThread(slug: string): Promise<boolean> {
  if (!app.project) return false;
  await newSession();
  // Refused as New chat is: the pending chat's own first turn is on screen.
  if (app.activeSessionId !== null || (app.busy && !app.parked)) return false;
  app.pendingThread = slug;
  pendingFromPlus = true;
  // Item 464 (his report, 2026-10-28): the box holds the thread's saved
  // hand-off — the last `<handoff>` prompt a reply in it wrote — when no
  // child chat has started from it yet, else nothing. ~~`setDraftText(id,
  // threadReadOrder(slug, THEN_HIS_ASK))`~~: a canned "start this new chat"
  // text beside the model's own prompt was two sources of truth. Read, not
  // taken (item 510): the first send takes it, so a second + shows it again.
  const key = pendingChatKey();
  const handed = await peekThreadHandoff(slug);
  if (key && pendingChatKey() === key) {
    const box = boxForHandoff(readDraft(key).text, handed, prefilled.get(key) ?? null);
    if (box !== null) setDraftText(key, box);
    if (handed) prefilled.set(key, handed);
    else prefilled.delete(key);
  }
  requestComposerFocus();
  return true;
}

/** Start a thread from the project's template and bind the open chat to it. */
export async function createThread(name: string, slug: string): Promise<boolean> {
  try {
    await api.newThread(slug, name);
  } catch (e) {
    addToast(String(e));
    return false;
  }
  return setChatThread(slug);
}

/** A dry-run upkeep of a thread, for its wrap-up's flags. Best-effort. */
export async function refreshThreadFlags(slug: string): Promise<void> {
  try {
    const up = await api.threadUpkeep(slug, false);
    noteThreadFlags(slug, up.flags);
  } catch {
    // No project open, or the thread is gone: the wrap-up goes without flags.
  }
}

/**
 * *Make this the file* for the thread layer: the chat's text spliced into
 * `thread.md`'s `## Start here`, put in the editor as a draft — never a
 * write; Save is his. The rest of the file is what is on disk now.
 */
export async function promoteThreadText(text: string): Promise<void> {
  const slug = chatThread(app.events);
  if (!slug || !app.project) {
    addToast("This chat is not bound to a thread in an open project");
    return;
  }
  const name = `threads/${slug}/thread.md`;
  try {
    const file = await api.readNote("project", name);
    app.noteDrafts[noteDraftKey("project", name)] = replaceStartHere(file, text);
    app.showContext = false;
    showNote("project", name);
  } catch (e) {
    addToast(String(e));
  }
}

async function applyFolders(folders: string[]): Promise<boolean> {
  const pending = pendingChatKey();
  try {
    await writePendingThread();
    app.events = await api.setChatFolders(folders);
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
 * Set the open project's extra folders — the whole list (backlog 143);
 * the registry is written, `app.project` picks the new shape up, and the
 * open chat reconnects so the grant reaches it now rather than at its
 * next open. Nothing to do without a project.
 */
export async function setProjectFolders(folders: string[]): Promise<void> {
  const project = app.project;
  if (!project || app.busy || app.connecting) return;
  try {
    const updated = await api.setProjectFolders(project.id, folders);
    app.project = updated;
    app.error = null;
  } catch (e) {
    addToast(String(e));
    return;
  }
  await applyDraft();
}

/**
 * The kind a New chat makes when nothing said otherwise (backlog 102's
 * definition of done): Claude Code in a project with a folder of its own,
 * Chat unfiled or in a project that has none — a folderless project is
 * notes and chats only, which is what a Chat is for. The import's
 * "Unfiled chats" holder counts as unfiled though the consolidation (114)
 * gave it a folder — the walk of 2026-09-25 found Claude Code the default
 * there.
 */
export function defaultKind(): ChatKind {
  return app.project?.root && !app.project.unfiled ? "build" : "chat";
}

/**
 * What a kind is called on screen, per engine (his naming, 2026-09-16):
 * on the subscription engine the build kind *is* Claude Code and the other
 * is Chat; on the provider engine (blocker 139's default: the dial on
 * both) the pair reads Build · Chat. `engine` is the connection's
 * `engine` field, or the draft's when nothing is connected yet.
 */
export function kindLabel(kind: ChatKind, engine: string | null | undefined): string {
  if (kind === "chat") return "Chat";
  return engine === "claude-code" ? "Claude Code" : "Build";
}

/** One line on what a kind means, for the places that offer it. */
export const KIND_LINES: Record<ChatKind, string> = {
  build: "the project folder · all tools · Ask / Auto · plans",
  chat: "reads only · Nightloom's tools · the web · no folder",
};

/**
 * The sidebar's New chat button is the selected item while no chat is open
 * — it is the "tab" being pressed until the first message lands a row —
 * and it carries the pending kind's glyph when that is not the ordinary
 * one. Two small projections rather than template expressions, so the
 * suite can pin them without a DOM.
 */
export function newChatSelected(): boolean {
  return chatSelected(null) && !app.pendingThread;
}

/** Whether the new-chat screen in front is thread `slug`'s (item 510): the
 *  plain New chat is not lit then, the thread's + is. */
export function threadPlusSelected(slug: string): boolean {
  return chatSelected(null) && app.pendingThread === slug;
}

/**
 * Whether the sidebar draws chat `id`'s row selected (null: New chat) —
 * ~~whenever it is the open chat~~ (backlog 297, 2026-10-04: a thread,
 * file, aside… tab in front leaves the chat behind it open, and the row
 * stayed lit while the page shown was the thread): only when the focused
 * pane's front tab is that chat (and it is the open chat). With no tab
 * yet, the open chat.
 *
 * Item 615 (his bug, 2026-11-11: "if i create new chat it doesn't
 * hihglight that chat as if i'm on it"): a New chat's first turn runs with
 * `activeSessionId` still null — the id arrives with the turn's first event
 * and becomes the open chat only at the turn's end (`settleTurnView`) — so
 * its row, listed meanwhile, was never lit and New chat stayed lit. The
 * chat on screen is now that made chat (`screenChat`): its row lights, New
 * chat does not, while its front tab is still the new-chat one.
 */
export function chatSelected(id: string | null): boolean {
  if (screenChat() !== id) return false;
  const c = frontContent();
  return !c || (c.kind === "chat" && c.session === app.activeSessionId);
}

/**
 * The chat a New chat's first turn made, from its first event until the
 * turn's view settles (item 615). Set only while that turn is the screen's
 * (not parked); cleared at every turn's start, when it goes to the
 * background (`detach`, which makes it the open chat) and at the end of
 * `settleTurnView` (which does too).
 */
export const firstTurnChat = $state<{ chat: string | null }>({ chat: null });

/** The chat on screen for the sidebar's mark (item 615): the open chat, or
 *  while a New chat's first turn runs on screen, the chat it made. */
function screenChat(): string | null {
  if (app.activeSessionId !== null) return app.activeSessionId;
  if (app.parked) return null;
  return firstTurnChat.chat;
}

/** Whether the sidebar draws the thread `slug`'s name selected: its tab is
 *  the focused pane's front one (backlog 297). */
export function threadSelected(slug: string): boolean {
  const c = frontContent();
  return c?.kind === "thread" && c.slug === slug;
}

/** The focused pane's front tab's content, or null while it has none. */
function frontContent(): TabContent | null {
  return tabs.activeTab(tabs.focusedPane(app.tabs))?.content ?? null;
}

export function newChatLabel(): string {
  const glyph = MODE_GLYPH[app.pendingMode];
  return glyph ? `New chat ${glyph}` : "New chat";
}

/** One line on what a mode means, for the places that offer it. */
export const MODE_LINES: Record<ChatMode, string> = {
  normal: "kept, indexed, remembered",
  incognito: "kept and marked; knows nothing about you, writes nothing, unread by other chats",
  ephemeral: "nothing is kept; gone when you close it",
};

/** The glyph a mark carries: half-shaded for kept-but-hidden, a dotted ring
 *  for there-and-not-there. Text, so it renders in a mono meta line and the
 *  top bar alike. Empty for a normal chat, which is not marked. */
export const MODE_GLYPH: Record<ChatMode, string> = {
  normal: "",
  incognito: "◐",
  ephemeral: "◌",
};
