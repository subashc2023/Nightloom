// Moved out of state.svelte.ts by item 641 (pure move; state.svelte.ts re-exports every name it exported).
import * as api from "../api";
import { enqueueMessage, moveDraft, nextAttachmentId } from "../drafts.svelte";
import { noteMade, type ChatChoice } from "../chatChoice";
import { LIST_SCOPE } from "../undo";
import type { CouncilRequest } from "../council";
import { settlePlan } from "../browse";
import * as tabs from "../tabs";
import { chipsFromInputs } from "../midTurn";
import { adoptPending, mergeRows, rowsFromLog } from "../subagentRows";
import { releaseStop } from "../stopState";
import { UNFILED_TABS, carryTabsTo } from "../tabsStore";
import type { ChatKind, ChatMode, DocumentInput, ImageInput, SessionEvent } from "../types";
import { switchAside } from "./asides.svelte";
import { leaveNote } from "./notes.svelte";
import { frontOpenChat, dropChatTabs } from "./tabs.svelte";
import { pushUndo } from "./edits.svelte";
import { maybeAutoDream } from "./passes.svelte";
import { readCheckpoint } from "./usage.svelte";
import { refreshProjects, useProject } from "./projects.svelte";
import { clearPendingThread, bindPendingThread, defaultKind, firstTurnChat } from "./threads.svelte";
import { chatChoice, saveChatChoices, adoptChatRules } from "./connection.svelte";
import { canDeleteChat, keepPaneLog, refreshPaneLog, providerElsewhere } from "./running.svelte";
import { injectIntoTurn, openChatKey } from "./queue.svelte";
import { app, sendUntyped, refreshSessions, newSession, park, unpark, detach, attach, stopClock, addToast } from "../state.svelte";

/**
 * Another chat on screen while a turn runs (backlog 159, pass 1): its log
 * read from disk, the running chat parked; the running chat asked for
 * again comes back with its stream.
 *
 * ~~`peek_session`, a reader that opens nothing~~ — since pass 2 step A1
 * (2026-09-24) the backend holds each chat behind its own lock and
 * `open_session` is a focus that answers during the turn, so the chat on
 * screen is the backend's open chat too: the prompt layers, the context
 * page and the other commands of the open chat act on it at once.
 */
async function peekSession(id: string): Promise<void> {
  if (app.background[id]) {
    await attach(id);
    return;
  }
  // The running chat to the background, and the chat opens as it would
  // with nothing running (backlog 159, A2).
  if (id !== app.activeSessionId && detach()) {
    await openSession(id);
    return;
  }
  if (id === app.activeSessionId) {
    if (app.view !== "chat") leaveNote();
    else frontOpenChat();
    app.openNext = "replace";
    return;
  }
  if (app.parked && id === app.parked.session) {
    await unpark();
    return;
  }
  try {
    const events = await api.openSession(id);
    park();
    switchAside(id);
    app.activeSessionId = id;
    app.events = events;
    // Its recorded agents, as `openSession` (backlog 160).
    app.subagents = mergeRows(app.subagents, rowsFromLog(events, id));
    app.error = null;
    app.suggestion = null;
    leaveNote();
  } catch (e) {
    app.error = String(e);
    app.openNext = "replace";
  }
}

/** New chat on screen while a turn runs: refused only while the running
 *  turn is the pending chat's own first (one pending slot per project
 *  and kind — see `browse.ts`). */
export async function peekNew(mode?: ChatMode, kind?: ChatKind): Promise<void> {
  // As `peekSession` (backlog 159, A2): the running chat to the
  // background, New chat as with nothing running.
  if (detach()) {
    await newSession(mode, kind);
    return;
  }
  const running = app.parked ? app.parked.session : app.activeSessionId;
  if (running === null) {
    if (app.parked) {
      await unpark();
      return;
    }
    addToast("This chat is having its first turn — New chat opens when it ends");
    app.openNext = "replace";
    return;
  }
  park();
  switchAside(null);
  app.activeSessionId = null;
  clearPendingThread();
  app.events = [];
  app.pendingMode = mode ?? "normal";
  app.pendingKind = kind ?? defaultKind();
  app.error = null;
  app.suggestion = null;
  leaveNote();
  // The backend's open chat is New chat too (backlog 159, A1): it answers
  // during the turn now, and the kind asked for is the one its first
  // message makes. Best-effort: the turn's end re-aligns (`settleTurnView`).
  try {
    await api.newSession(app.pendingMode, app.pendingKind);
  } catch {
    // re-aligned at the turn's end
  }
}

/** The chat and project on screen (535f, the review's 534-1), taken
 *  before an await whose answer is "the open chat's events". */
export function viewMark(): { chat: string | null; project: string | null } {
  return { chat: app.activeSessionId, project: app.project?.id ?? null };
}

/** Whether the screen still shows the chat `mark` was taken on. */
export function sameView(mark: { chat: string | null; project: string | null }): boolean {
  return app.activeSessionId === mark.chat && (app.project?.id ?? null) === mark.project;
}

/** `call`'s events adopted as the view only while the chat it was made on
 *  is still on screen (534-1's class: rewind, edit, restore, remove and
 *  their undo/redo; the phone's unrewind): he may open another chat in
 *  the round trip, and that chat's view and size are its own. The change
 *  itself is on disk either way. `true` when adopted. */
export async function adoptOpen(call: () => Promise<SessionEvent[]>): Promise<boolean> {
  const mark = viewMark();
  const events = await call();
  if (!sameView(mark)) return false;
  app.events = events;
  return true;
}

/**
 * The turn's end, for the view (backlog 065, 159): the log re-synced and
 * the pending chat's draft moved to the chat it made — or, when he
 * browsed away, the running chat's record left on disk and the backend
 * re-opened on the chat on screen, so what the composer drains next goes
 * where he is looking. The plan is `settlePlan`'s, which the suite pins.
 */
export async function settleTurnView(
  pendingKey: string | null,
  chat: string | null = null,
  choice: ChatChoice | null = null,
): Promise<void> {
  const parked = app.parked;
  // A pane showing the parked chat reads its reply from its log (piece 5).
  if (parked?.session) refreshPaneLog(parked.session, parked.events);
  app.parked = null;
  // 535f (the review's 534-1): the chat on screen before the read — he
  // may click another in the round trip (busy is already false).
  const mark = viewMark();
  try {
    // The chat the turn ran in, whichever is open now (backlog 159, A1:
    // the backend's open chat follows the screen during the turn) — by
    // its id when known (A2: two turns may have run; "the latest" may be
    // the other's).
    const events = chat ? await api.transcript(false, chat) : await api.transcript(true);
    const first = events[0];
    const made = first && first.event === "session_created" ? first.id : null;
    // Left during the read: treated as browsed — its log stays on disk
    // and the chat he opened keeps its own (`openSession` aligned the
    // backend), but a New chat's draft still follows the chat it made.
    const left = !parked && !sameView(mark);
    const plan = left
      ? {
          adopt: false,
          activeSessionId: undefined,
          moveDraft: made !== null && pendingKey !== null && mark.chat === null ? ([pendingKey, made] as [string, string]) : null,
          realign: null,
        }
      : settlePlan({ parked, viewed: app.activeSessionId, made, pendingKey });
    // A New chat's agents, made before its id was known (backlog 160).
    if (made) adoptPending(app.subagents, made);
    // And the model and engine its first turn ran on (backlog 205), before
    // the view moves to it and the choice is read back.
    if (made && choice) {
      noteMade(chatChoice.choices, made, choice);
      saveChatChoices();
    }
    // And the subagent rules typed in its box (backlog 291).
    if (made) adoptChatRules(made);
    if (plan.moveDraft) moveDraft(plan.moveDraft[0], plan.moveDraft[1]);
    if (plan.adopt) app.events = events;
    if (plan.activeSessionId !== undefined) app.activeSessionId = plan.activeSessionId;
    if (plan.realign?.kind === "open") app.events = await api.openSession(plan.realign.id);
    else if (plan.realign?.kind === "new") await api.newSession(app.pendingMode, app.pendingKind);
  } catch {
    // keep the locally-built view if re-sync fails
  } finally {
    // Item 615: the open chat now names it (or he left); the stand-in goes.
    firstTurnChat.chat = null;
  }
}

export async function openSession(id: string): Promise<void> {
  if (app.background[id]) {
    await attach(id);
    return;
  }
  if (app.busy) {
    await peekSession(id);
    return;
  }
  // A ⌘-click's "open in a new tab" (`app.openNext`, backlog 099) is
  // consumed by the tab reflection, which runs only when the open changes
  // the view or the chat. Opening the chat already in front changes
  // neither, and a failed open changes nothing — so the modifier would
  // stay armed and the *next* plain click would open a tab (review E,
  // 2026-09-17). Both paths hand it back here; `newTab` does the same.
  const inFront = id === app.activeSessionId && app.view === "chat";
  // The chat being left, for the other pane when it shows it (piece 5).
  const leaving = app.activeSessionId;
  const leavingEvents = app.events;
  try {
    app.events = await api.openSession(id);
    // The aside thread stays with the chat being left and the opened
    // chat's comes back (backlog 130).
    switchAside(id);
    app.activeSessionId = id;
    if (leaving && leaving !== id) keepPaneLog(leaving, leavingEvents);
    app.error = null;
    // The chat's checkpoint, for the transcript's marker (backlog 104).
    void readCheckpoint(id);
    // The plan window and estimate belong to the chat you just left.
    app.agentTurn = null;
    app.agentInit = null;
    // ~~`app.subagents = []`~~ (backlog 160): the rows stay, keyed by
    // chat, and this chat's recorded agents join them from its log.
    app.subagents = mergeRows(app.subagents, rowsFromLog(app.events, id));
    app.suggestion = null;
    leaveNote();
    // Backlog 297: in front as the open chat, but maybe behind a tab that
    // changes nothing global (a thread's) — its tab comes forward.
    if (inFront) frontOpenChat();
    if (inFront) app.openNext = "replace";
  } catch (e) {
    app.error = String(e);
    app.openNext = "replace";
  }
}

/** Compact the active session: earlier turns collapse into a summary. */
export async function compactSession(): Promise<void> {
  if (!app.connection || app.busy) return;
  releaseStop(stopClock);
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
  // ~~`if (app.busy) return;`~~ — A4: a running chat is refused in words,
  // another chat is deleted while a turn runs (the backend refuses only the
  // running one, since A1).
  if (!canDeleteChat(id)) {
    addToast("That chat is running a turn — delete it when the turn ends");
    return;
  }
  let full: string;
  try {
    full = await api.deleteSession(id, app.activeSessionId);
    if (id === app.activeSessionId || full === app.activeSessionId) {
      switchAside(null); // its asides stay its own (backlog 203), for the undo
      app.activeSessionId = null;
      clearPendingThread();
      app.events = [];
    }
    dropChatTabs(full);
  } catch (e) {
    addToast(String(e));
    await refreshSessions();
    return;
  }
  await refreshSessions();
  // A delete is a move to the trash, so its undo is the move back — and,
  // when nothing is open, the chat reopened, since that is where the user
  // was. On the list's stack: after the delete there is no chat to hold it.
  pushUndo(LIST_SCOPE, {
    label: "delete",
    undo: async () => {
      await api.restoreSession(full);
      await refreshSessions();
      if (app.activeSessionId === null) await openSession(full);
    },
    redo: async () => {
      await api.deleteSession(full, app.activeSessionId);
      if (full === app.activeSessionId) {
        switchAside(null);
        app.activeSessionId = null;
        clearPendingThread();
        app.events = [];
      }
      await refreshSessions();
    },
  });
}

/**
 * *Move to project…* (nightshift backlog 370): the chat leaves this
 * project's list for project `to`'s (null: the unfiled chats), while the
 * app runs. Refused in words while its turn runs, like a delete. Its id
 * does not change, so its draft and queued rows (keyed by the id, backlog
 * 375) go with it untouched; its chat tab goes to the other project's
 * stored workspace (`carryTabsTo`), the rest of its tabs close here.
 * No undo: the chat is no longer in this list to move back from — it is
 * moved back from the other project's list the same way.
 */
export async function moveSession(id: string, to: string | null): Promise<boolean> {
  if (!canDeleteChat(id)) {
    addToast("That chat is running a turn — move it when the turn ends");
    return false;
  }
  const carried = tabs
    .allTabs(app.tabs)
    .filter((t) => t.content.kind === "chat" && t.content.session === id)
    .map((t) => t.content);
  let full: string;
  try {
    full = await api.moveSession(id, to);
  } catch (e) {
    addToast(String(e));
    await refreshSessions();
    return false;
  }
  if (id === app.activeSessionId || full === app.activeSessionId) {
    switchAside(null);
    app.activeSessionId = null;
    clearPendingThread();
    app.events = [];
  }
  dropChatTabs(full);
  if (typeof localStorage !== "undefined") carryTabsTo(localStorage, to ?? UNFILED_TABS, carried);
  await refreshSessions();
  const where = to === null ? "No project (unfiled chats)" : (app.projects.find((p) => p.id === to)?.name ?? "the other project");
  addToast(`Moved to ${where}`);
  void refreshProjects();
  return true;
}

/**
 * A message from the phone (backlog 091): for the open chat, or for one
 * that is opened first. `openSession` refuses while a turn runs (blocker
 * 182) and can fail; either way the chat asked for is not the one open,
 * and the words must be held under *its* key — before review E
 * (2026-09-17) they were queued under the open chat's and went into it
 * at that turn's end. ~~Held this way they show in the asked-for chat's
 * queue when it is opened, and go with its next send or *Send next*.~~
 * Since backlog 132 (2026-09-17) the phone is told instead: the answer
 * is `"sent"` (the turn starts), `"queued"` (the open chat is running a
 * turn; the message is in its composer queue and goes when that turn
 * ends), or a thrown sentence — the chat asked for could not be opened
 * (busy in another chat, a bad id), or no engine is connected — and the
 * listener turns that into a 409, so the phone keeps the text in its own
 * queue and tries again when the Mac is idle. Nothing is held here for a
 * chat that is not open: that queue drained only when he opened the chat
 * and pressed Send next, which the phone could not see.
 */
export async function remoteSend(
  chat: string | null,
  text: string,
  images: ImageInput[] = [],
  documents: DocumentInput[] = [],
  council: CouncilRequest | null = null,
  spoken = false,
): Promise<"sent" | "queued"> {
  if (chat && chat !== app.activeSessionId) {
    if (app.busy) throw new Error("the desktop is busy in another chat — held on the phone until it is free");
    await openSession(chat);
    if (chat !== app.activeSessionId) {
      throw new Error(app.error ? `the desktop could not open that chat: ${app.error}` : "the desktop could not open that chat");
    }
  }
  if (app.busy || providerElsewhere()) {
    // ~~The Mac's queue holds `Attachment`s, not the phone's `ImageInput`s:
    // a message with files or a council stays on the phone until the turn ends.~~
    // Backlog 339: into the running turn at its next step, as a typed
    // one goes — files too, as queue chips. A council, or files while the
    // engine is busy in another chat, still wait on the phone.
    const chips = chipsFromInputs(images, documents, nextAttachmentId);
    if (council !== null || (chips.length > 0 && (!app.busy || app.parked)))
      throw new Error("this chat is running a turn on the Mac — the message and its files are held on the phone until it ends");
    const key = openChatKey();
    const row = enqueueMessage(key, text, chips);
    if (app.busy && !app.parked) void injectIntoTurn(key, row);
    return "queued";
  }
  if (!app.connection) throw new Error("no engine is connected on the desktop — connect one there first");
  // The Mac's new-chat screen in a thread (item 510): bound before the phone
  // hears the message was taken, so a refusal leaves it held there.
  if (!(await bindPendingThread())) throw new Error(app.error ?? "the desktop could not bind the new chat's thread");
  // Answered before the turn, not after: `send` resolves at the turn's
  // end, and the phone is waiting to hear the message was taken. A queued
  // message (above) goes later as a typed one — spoken or not, the words
  // are kept; only the "for the ear" note is lost.
  void sendUntyped(text, images, documents, council, spoken);
  return "sent";
}

/**
 * A new chat from the phone (item 246): in `project` when it names one
 * that is not open (the window switches to it, as the project menu does),
 * then the New chat state, then the message — which creates the log, as a
 * first message typed here does. Refused, never queued, while a turn runs:
 * leaving the running chat's project mid-turn is not the phone's call.
 */
export async function remoteNewChat(project: string | null, text: string): Promise<"sent" | "queued"> {
  if (app.busy) throw new Error("the desktop is running a turn — start the new chat when it ends");
  if (project && project !== app.project?.id) {
    await useProject(project);
    if (app.project?.id !== project) throw new Error("the desktop could not open that project");
  }
  await newSession();
  if (app.activeSessionId !== null) throw new Error(app.error ? `the desktop could not start a chat: ${app.error}` : "the desktop could not start a chat");
  if (!app.connection) throw new Error("no engine is connected on the desktop — connect one there first");
  void sendUntyped(text);
  return "sent";
}
