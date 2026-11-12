// Moved out of state.svelte.ts by item 641 (pure move; state.svelte.ts re-exports every name it exported).
import * as api from "../api";
import { isMac } from "../platform";
import { hasUsage } from "../replyFooter";
import { enqueueMessage, nextQueueId, nextAttachmentId } from "../drafts.svelte";
import { contextOf } from "../chatContext.svelte";
import { aimOf, indexOfAim, type Aim } from "../aim";
import { LIST_SCOPE, NEW_CHAT_SCOPE, UndoHistory } from "../undo";
import { chipsFromInputs } from "../midTurn";
import type { Attachment, DocumentInput, FileInput, EditedAttachments, ImageInput, Price, ContextEdit, Usage } from "../types";
import { app, refreshSessions, runInChat, viewMark, sameView, adoptOpen, addToast, liveFlags } from "../state.svelte";

// ---- Undo and redo (nightshift backlog 064, 2026-09-15) ---------------
//
// The stack is `undo.ts`; this is where it meets the app. Each operation
// below pushes its inverse after it succeeds — `rewindTo`, `saveEdit`,
// `removeTurn`, `editContextItems`, `renameSession`, `deleteSession`,
// `setPromptLayer`, `setPromptLayerText` — and `send` clears the chat's
// stack, since a turn the model has answered is not undoable and nothing
// under it is either. Not on the stack, and the doc says so: a send, a
// fork (edit-and-send; undo is to trash the fork), a compaction, a dream,
// a capture, a project forget.

/** The stack. Not reactive; `app.undoTick` is bumped on every change. */
export const history = new UndoHistory(() => app.busy);

/** The open chat's scope: its id, or the pending New chat's key. */
export function chatScope(): string {
  return app.activeSessionId ?? NEW_CHAT_SCOPE;
}

/** What ⌘Z looks at: the open chat's stack and the list's. */
function undoScopes(): string[] {
  return [chatScope(), LIST_SCOPE];
}

export function pushUndo(scope: string, entry: { label: string; undo: () => Promise<void>; redo: () => Promise<void> }): number {
  const handle = history.push(scope, entry);
  app.undoTick++;
  return handle;
}

/**
 * The toast a removal or a rewind raises (backlog 066): "Removed from
 * context · Undo", eight seconds, the Undo reversing *that* entry and
 * nothing else — `undoIf` refuses once something newer is on the stack,
 * and says so, since an Undo that lifted a later edit would be worse than
 * one that did nothing.
 */
export function undoToast(text: string, handle: number): void {
  addToast(text, {
    label: "Undo",
    run: () => {
      void (async () => {
        try {
          const step = await history.undoIf(undoScopes(), handle);
          if (!step) addToast("Something was done since; use ⌘Z to undo in order");
        } catch (e) {
          addToast(`Could not undo: ${String(e)}`);
        } finally {
          app.undoTick++;
        }
      })();
    },
  });
}

/** "rewind" or null: what Undo would reverse right now. Reactive through
 *  the tick and the open chat. */
export function undoLabel(): string | null {
  void app.undoTick;
  return history.undoLabel(undoScopes());
}

export function redoLabel(): string | null {
  void app.undoTick;
  return history.redoLabel(undoScopes());
}

/**
 * Reverse the newest operation on the open chat or the list. A toast names
 * it, since the change may be off screen (a rename in the sidebar, a layer
 * in a closed panel). A refusal is a toast too, and the stack is left as
 * it was so the entry can be tried again.
 */
export async function undo(): Promise<void> {
  try {
    const step = await history.undo(undoScopes());
    if (step) addToast(`Undid ${step.label}`);
  } catch (e) {
    addToast(`Could not undo: ${String(e)}`);
  } finally {
    app.undoTick++;
  }
}

export async function redo(): Promise<void> {
  try {
    const step = await history.redo(undoScopes());
    if (step) addToast(`Redid ${step.label}`);
  } catch (e) {
    addToast(`Could not redo: ${String(e)}`);
  } finally {
    app.undoTick++;
  }
}

/**
 * Whether the keyboard focus is in something with a history of its own — a
 * text box or a contenteditable — where ⌘Z belongs to the typing and not
 * to the app. Read at the moment of the key or the menu click.
 */
export function inTextField(): boolean {
  if (typeof document === "undefined") return false;
  const el = document.activeElement;
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    return !["button", "checkbox", "radio", "range", "submit", "reset", "color", "file"].includes(el.type);
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

/**
 * Keep the macOS Edit menu's Undo and Redo in step with the stack and the
 * focus: retitled with the operation, disabled when there is nothing to
 * reverse and no text box to hand the key to. Memoized on what was last
 * sent, since focus moves often and the menu rarely changes. A no-op off
 * macOS, where App.svelte binds the keys itself.
 */
let undoMenuSent = "";
export async function syncUndoMenu(): Promise<void> {
  if (!isMac) return;
  const undo = undoLabel();
  const redo = redoLabel();
  const textField = inTextField();
  const key = `${undo}|${redo}|${textField}`;
  if (key === undoMenuSent) return;
  undoMenuSent = key;
  try {
    await api.setUndoMenu(undo, redo, textField);
  } catch {
    // A missing menu (a test, a window without one) is not worth a toast.
  }
}

/** The text the turn at `index` says now: its latest live edit, else its
 *  own — what an undo of an edit puts back. For a reply, its first text
 *  block, which is what `saveEdit` on a reply rewords (backlog 066: the
 *  transcript's reply editor goes block by block through `saveReplyEdit`
 *  instead). */
function currentText(index: number): string {
  const e = app.events[index];
  if (!e) return "";
  if (e.event === "user_message") {
    const live = liveFlags(app.events);
    for (let i = app.events.length - 1; i > index; i--) {
      const m = app.events[i];
      if (live[i] && m.event === "edit" && m.target === index) return m.text;
    }
    return e.text;
  }
  if (e.event === "assistant_message") {
    const first = e.blocks.findIndex((b) => b.type === "text");
    const b = e.blocks[first];
    const own = b?.type === "text" ? b.text : "";
    return blockEditsOf(index).get(first >= 0 ? first : e.blocks.length) ?? own;
  }
  return "";
}

/**
 * Edit and save (nightshift backlog 062): the turn at `index` says `text`
 * from here on, in this chat. The transcript re-syncs from the log, which
 * now carries the marker; on Claude Code the backend has also rewritten
 * the CLI's history by copy, or refused with a notice and recorded
 * nothing. Refused mid-turn on `rewindTo`'s reasoning.
 */
export async function saveEdit(
  index: number,
  text: string,
  /** Item 336: the user message's whole set of attachments from here on —
   *  the edit box's chips, passed only when they changed. */
  attachments: EditedAttachments | null = null,
  /** Backlog 364: the phone's aim (`null`: none, bare); absent, the window's own. */
  aim?: Aim | null,
): Promise<boolean> {
  if (app.busy) return false;
  const meant = aimFor(index, aim);
  // 364 review: what the turn said before, read where the aimed edit lands
  // in this window's list (`here`) — for the phone, not at its index.
  const here = localIndex(index, aim);
  const previous = here === null ? null : currentText(here);
  const previousSet = attachments && here !== null ? currentAttachments(here) : null;
  try {
    // Another chat opened in the round trip (535f, 534-1): saved on disk,
    // no undo on the chat now open.
    if (!(await adoptOpen(async () => (await editSaved(index, text, attachments, meant)).events))) return true;
    app.error = null;
  } catch (e) {
    addToast(String(e));
    return false;
  }
  // The turn is not in this window's list: what it said before is unknown,
  // so no undo rather than one that writes another turn's words into it.
  if (previous === null) return true;
  // An edit is undone by an edit back to what the turn said before: the
  // same marker, the same CLI copy on Claude Code, the original kept — and,
  // when the attachments changed, back to the set it carried (item 336).
  const editTo = async (t: string, set: EditedAttachments | null) => {
    await adoptOpen(async () => (await editSaved(index, t, set, meant)).events);
  };
  pushUndo(chatScope(), {
    label: "edit",
    undo: () => editTo(previous, previousSet),
    redo: () => editTo(text, attachments),
  });
  return true;
}

/** `edit_message` "save", with the attachments only when there are some
 *  to set — a text-only Save is the call it always was; aimed (backlog
 *  364) when the turn has an aim. */
function editSaved(index: number, text: string, set: EditedAttachments | null, aim: Aim | null = null) {
  if (aim) return api.editMessage(index, text, "save", set, aim.at, aim.nth ?? null);
  return set ? api.editMessage(index, text, "save", set) : api.editMessage(index, text, "save");
}

/**
 * Backlog 364: the turn the caller means, beside its index — the send time
 * of the message that opened its exchange, and for a reply its place among
 * that exchange's replies (`aim.ts`). The window's own list gives it unless
 * the caller brought one: the phone's, from its own list, or `null` (an
 * older phone that sent none), which goes bare as before. Read once, before
 * the change, so its undo and redo name the same turn.
 */
function aimFor(index: number, aim: Aim | null | undefined): Aim | null {
  return aim === undefined ? aimOf(app.events, index) : aim;
}

/** 364 review: where the turn a caller's aim names is in this window's own
 *  list — `index` itself for the window (no aim brought) and for a bare
 *  call; for the phone's aim, that turn found by it (`indexOfAim`), or null
 *  when this list does not have it. */
function localIndex(index: number, aim: Aim | null | undefined): number | null {
  return aim ? indexOfAim(app.events, aim, index) : index;
}

/** The message calls, aimed when there is an aim, the bare call otherwise. */
const removeCall = (index: number, aim: Aim | null) =>
  aim ? api.removeMessage(index, aim) : api.removeMessage(index);
const restoreCall = (index: number, aim: Aim | null) =>
  aim ? api.restoreMessage(index, aim) : api.restoreMessage(index);
const removeBlockCall = (index: number, block: number, aim: Aim | null) =>
  aim ? api.removeBlock(index, block, aim) : api.removeBlock(index, block);
const restoreBlockCall = (index: number, block: number, aim: Aim | null) =>
  aim ? api.restoreBlock(index, block, aim) : api.restoreBlock(index, block);
const editBlockCall = (index: number, block: number, text: string, aim: Aim | null) =>
  aim ? api.editBlock(index, block, text, aim) : api.editBlock(index, block, text);

/** What the user turn at `index` carries now (item 336): the latest live
 *  edit's set, else its own images and documents — what an undo of an
 *  attachment edit puts back. `editAttachments` in edit.ts, inline here
 *  as `currentText` is. */
function currentAttachments(index: number): EditedAttachments {
  const e = app.events[index];
  if (e?.event !== "user_message") return { images: [], documents: [] };
  const live = liveFlags(app.events);
  for (let i = app.events.length - 1; i > index; i--) {
    const m = app.events[i];
    if (live[i] && m.event === "edit" && m.target === index && m.attachments) return m.attachments;
  }
  return { images: e.images ?? [], documents: e.documents ?? [] };
}

/** An edit's images, documents and files as a queued message's attachments. */
export function editAttachments(images: ImageInput[], documents: DocumentInput[], files: FileInput[]): Attachment[] {
  return [
    ...chipsFromInputs(images, documents, nextAttachmentId),
    // `runInChat` sends a `file` chip's name and data back as a file (277).
    ...files.map((f) => ({ id: nextAttachmentId(), kind: "file" as const, media_type: "application/octet-stream", name: f.name, data: f.data })),
  ];
}

/** The edited message sent in its fork off screen (559): on Claude Code as
 *  that chat's own background turn (`runInChat`; a refusal puts it at the
 *  head of the fork's queue); on the API engine, which runs one chat at a
 *  time, queued in the fork, sent when he opens it. */
export function sendInFork(
  fork: string,
  project: string | null,
  text: string,
  images: ImageInput[],
  documents: DocumentInput[],
  files: FileInput[],
): void {
  const attachments = editAttachments(images, documents, files);
  if (app.connection?.engine !== "claude-code") {
    enqueueMessage(fork, text, attachments);
    addToast("Your edit is queued in its new branch — open it from the sidebar to send it");
    return;
  }
  void runInChat(
    fork,
    { id: nextQueueId(), text, attachments },
    { pendingMode: "normal", pendingKind: app.pendingKind, project, projectName: null, name: null },
    { contextLimit: contextOf(fork)?.limit || null },
  );
  addToast("Your edit was sent in its new branch, off screen — it is in the sidebar");
}

/**
 * Remove the turn at `index` from the context. A marker, asked about
 * nothing: the transcript shows the placeholder greyed with the original
 * a click away, and the context panel's Restore (or backlog 064's undo)
 * brings it back.
 */
export async function removeTurn(index: number, aim?: Aim | null): Promise<void> {
  if (app.busy) return;
  const meant = aimFor(index, aim);
  try {
    // Another chat opened in the round trip (535f): done on disk, no undo here.
    if (!(await adoptOpen(async () => (await removeCall(index, meant)).events))) return;
    app.error = null;
  } catch (e) {
    addToast(String(e));
    return;
  }
  const handle = pushUndo(chatScope(), {
    label: "remove",
    undo: async () => {
      await adoptOpen(async () => (await restoreCall(index, meant)).events);
    },
    redo: async () => {
      await adoptOpen(async () => (await removeCall(index, meant)).events);
    },
  });
  undoToast("Removed from context", handle);
}

/**
 * The Restore on a removed turn's placeholder (backlog 066): the same
 * restore an undo of the removal runs — `unelide`; on Claude Code the
 * turn's nodes back from the original — with its own inverse on the
 * stack, so a restore is itself undoable.
 */
export async function restoreTurn(index: number, aim?: Aim | null): Promise<void> {
  if (app.busy) return;
  const meant = aimFor(index, aim);
  try {
    // Another chat opened in the round trip (535f): done on disk, no undo here.
    if (!(await adoptOpen(async () => (await restoreCall(index, meant)).events))) return;
    app.error = null;
  } catch (e) {
    addToast(String(e));
    return;
  }
  pushUndo(chatScope(), {
    label: "restore",
    undo: async () => {
      await adoptOpen(async () => (await removeCall(index, meant)).events);
    },
    redo: async () => {
      await adoptOpen(async () => (await restoreCall(index, meant)).events);
    },
  });
}

/**
 * Remove one block of a reply from the context (backlog 066): a tool call
 * with its result, from the hover on the call; or a text block, which is
 * what a Save with that block's text deleted does. The inverse is the
 * block's restore; the toast offers it for eight seconds.
 */
export async function removeBlock(index: number, block: number, toast = true, aim?: Aim | null): Promise<boolean> {
  if (app.busy) return false;
  const meant = aimFor(index, aim);
  try {
    // Another chat opened in the round trip (535f): done on disk, no undo here.
    if (!(await adoptOpen(async () => (await removeBlockCall(index, block, meant)).events))) return true;
    app.error = null;
  } catch (e) {
    addToast(String(e));
    return false;
  }
  const handle = pushUndo(chatScope(), {
    label: "remove",
    undo: async () => {
      await adoptOpen(async () => (await restoreBlockCall(index, block, meant)).events);
    },
    redo: async () => {
      await adoptOpen(async () => (await removeBlockCall(index, block, meant)).events);
    },
  });
  if (toast) undoToast("Removed from context", handle);
  return true;
}

/** The Restore on a removed block's placeholder, on `restoreTurn`'s terms. */
export async function restoreBlock(index: number, block: number, aim?: Aim | null): Promise<void> {
  if (app.busy) return;
  const meant = aimFor(index, aim);
  try {
    // Another chat opened in the round trip (535f): done on disk, no undo here.
    if (!(await adoptOpen(async () => (await restoreBlockCall(index, block, meant)).events))) return;
    app.error = null;
  } catch (e) {
    addToast(String(e));
    return;
  }
  pushUndo(chatScope(), {
    label: "restore",
    undo: async () => {
      await adoptOpen(async () => (await removeBlockCall(index, block, meant)).events);
    },
    redo: async () => {
      await adoptOpen(async () => (await restoreBlockCall(index, block, meant)).events);
    },
  });
}

/**
 * Save a reply's editor (backlog 066): each changed text block reworded
 * (`editBlock`), each emptied one removed (`removeBlock`), in order, as
 * one entry on the stack — one Save, one undo — whose inverse puts every
 * block back to what it said: an edit back for an edit, a restore for a
 * removal. On Claude Code each step is its own copy of the CLI's file;
 * a step that is refused stops the sequence, with what landed before it
 * kept and undoable.
 */
export async function saveReplyEdit(
  index: number,
  changes: { block: number; text: string }[],
  /** Backlog 364: as `saveEdit`'s. */
  aim?: Aim | null,
): Promise<boolean> {
  if (app.busy || changes.length === 0) return false;
  // 364 review: the reply and its previous block texts read where the aimed
  // edit lands in this window's list; not there, refused as before.
  const here = localIndex(index, aim);
  const e = here === null ? undefined : app.events[here];
  if (here === null || e?.event !== "assistant_message") return false;
  const meant = aimFor(index, aim);
  const edits = blockEditsOf(here);
  const done: { block: number; text: string; previous: string }[] = [];
  // 535f (534-1): each step acts on the backend's open chat, so the
  // sequence stops when he opens another chat between two steps; what
  // landed stays on disk, and the stack is this chat's.
  const mark = viewMark();
  const scope = chatScope();
  for (const c of changes) {
    if (!sameView(mark)) break;
    const b = e.blocks[c.block];
    const previous = edits.get(c.block) ?? (b?.type === "text" ? b.text : "");
    try {
      const adopted = await adoptOpen(async () =>
        (c.text.length === 0
          ? await removeBlockCall(index, c.block, meant)
          : await editBlockCall(index, c.block, c.text, meant)
        ).events,
      );
      if (adopted) app.error = null;
    } catch (err) {
      addToast(String(err));
      break;
    }
    done.push({ block: c.block, text: c.text, previous });
  }
  if (done.length === 0) return false;
  if (!sameView(mark)) return done.length === changes.length;
  const apply = async (forward: boolean) => {
    for (const d of forward ? done : [...done].reverse()) {
      const text = forward ? d.text : d.previous;
      const adopted = await adoptOpen(async () =>
        (forward && d.text.length === 0
          ? await removeBlockCall(index, d.block, meant)
          : !forward && d.text.length === 0
            ? await restoreBlockCall(index, d.block, meant)
            : await editBlockCall(index, d.block, text, meant)
        ).events,
      );
      if (!adopted) return;
    }
  };
  pushUndo(scope, {
    label: "edit",
    undo: () => apply(false),
    redo: () => apply(true),
  });
  return done.length === changes.length;
}

/** The reply at `index`'s live block edits, without importing the whole
 *  of edit.ts into this module's cycle. */
function blockEditsOf(index: number): Map<number, string> {
  const live = liveFlags(app.events);
  const out = new Map<number, string>();
  const e = app.events[index];
  if (e?.event !== "assistant_message") return out;
  app.events.forEach((m, i) => {
    if (!live[i] || m.event !== "edit" || m.target !== index) return;
    let block = m.block;
    if (block == null) {
      const first = e.blocks.findIndex((b) => b.type === "text");
      block = first >= 0 ? first : e.blocks.length;
    }
    out.set(block, m.text);
  });
  return out;
}

/**
 * The context panel's Remove and Restore (`edit_context`), with the
 * inverse on the stack: a removal is undone by a restore of the same
 * items and the other way round. Resolves with the panel's new view, or
 * null on a refusal (toasted here). The API engine only, as the command
 * is; the transcript's own controls go through `removeTurn`.
 */
export async function editContextItems(
  targets: number[],
  remove: boolean,
): Promise<ContextEdit | null> {
  let result: ContextEdit;
  try {
    result = await api.editContext(targets, remove);
    app.events = result.events;
  } catch (e) {
    addToast(String(e));
    return null;
  }
  const apply = async (rm: boolean) => {
    app.events = (await api.editContext(targets, rm)).events;
  };
  pushUndo(chatScope(), {
    label: remove ? "remove" : "restore",
    undo: () => apply(!remove),
    redo: () => apply(remove),
  });
  return result;
}

/**
 * Rename a chat, the old name kept for the undo. A chat that was never
 * named shows its first message, and that is what the undo names it —
 * the log's `Title` cannot be un-recorded, only superseded — so the row
 * reads as it did, now by a title. On the list's stack, since the chat
 * renamed need not be the open one.
 */
export async function renameSession(id: string, title: string): Promise<void> {
  const row = app.sessions.find((s) => s.id === id);
  const previous = row?.title ?? row?.first_user ?? null;
  try {
    // The open chat named (backlog 136): mid-turn, another chat's rename
    // lands at once and the running one is refused, not waited on.
    await api.renameSession(id, title, app.activeSessionId);
  } catch (e) {
    addToast(String(e));
    return;
  }
  await refreshSessions();
  if (previous === null) return;
  const nameIt = async (t: string) => {
    await api.renameSession(id, t, app.activeSessionId);
    await refreshSessions();
  };
  pushUndo(LIST_SCOPE, {
    label: "rename",
    undo: () => nameIt(previous),
    redo: () => nameIt(title),
  });
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

/**
 * Mirrors `Price::cost` on the backend: three disjoint input slices.
 *
 * Exported only so the suite can pin it against its Rust counterpart; nothing
 * outside this module calls it.
 */
export function roundCost(u: Usage, p: Price): number {
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
    // A reply with no usage (stopped or failed before a word, backlog
    // 361; cut off, 332) says nothing about the prefix: read past it.
    if (e.event === "assistant_message" && hasUsage(e.usage)) return e.usage;
  }
  return null;
}
