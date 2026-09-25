/**
 * Edit a note by prompt (nightshift backlog 151) — the live part: every
 * note's side chat, kept in localStorage the way the drafts are, and the
 * rewrite itself. Here rather than in the panel so a rewrite finishes and
 * lands however the view is left: the panel closed, another note opened,
 * the note's pane gone.
 *
 * His text is never lost (practices §7):
 * - the half-typed request is the thread's `draft`, stored as he types, so
 *   closing the panel or the note keeps it;
 * - every exchange keeps the note as it was before (`before`), which is
 *   what Undo restores and what "Put back as a draft" offers;
 * - the note is written only from a whole reply; a reply with no end
 *   marker, or one for a note whose project changed meanwhile, becomes an
 *   unsaved draft instead (Revert drops it);
 * - Undo over text that differs from what the model left keeps that text
 *   as a `kept` entry first.
 */
import { listen } from "@tauri-apps/api/event";
import * as api from "./api";
import { app, addToast, noteDraftKey, saveNote } from "./state.svelte";
import type { NoteScope } from "./types";
import {
  STORE_KEY,
  changedLines,
  emptyThread,
  parseThreads,
  serializeThreads,
  splitReply,
  today,
  undoable,
  type NoteEditThread,
  type NoteEditTurn,
} from "./noteEdit";

function load(): Record<string, NoteEditThread> {
  try {
    return parseThreads(typeof localStorage === "undefined" ? null : localStorage.getItem(STORE_KEY));
  } catch {
    return {};
  }
}

/** Every note's side chat, by the note's draft key. */
export const noteEdits = $state<Record<string, NoteEditThread>>(load());

/** Whether the panel is open, shared by every note view so it stays open
 *  across notes (a view's own flag would reset on each switch). */
export const noteEditUi = $state({ open: false });

const SAVE_DELAY_MS = 400;
let timer: ReturnType<typeof setTimeout> | null = null;

export function flushNoteEdits(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  try {
    localStorage.setItem(STORE_KEY, serializeThreads(noteEdits));
  } catch {
    // Storage unavailable or full: the threads stay for the window.
  }
}

function schedule(): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(flushNoteEdits, SAVE_DELAY_MS);
}

if (typeof window !== "undefined") window.addEventListener("pagehide", flushNoteEdits);

/** The thread for `key`, made on first use. */
export function thread(key: string): NoteEditThread {
  if (!noteEdits[key]) noteEdits[key] = emptyThread();
  return noteEdits[key];
}

/** His typing in the request box — stored, so closing loses nothing. */
export function setRequestDraft(key: string, text: string): void {
  const t = thread(key);
  t.draft = text;
  t.touched = new Date().toISOString();
  schedule();
}

export function setStrike(key: string, strike: boolean): void {
  thread(key).strike = strike;
  schedule();
}

/** What a note view is told when its text changes under it. */
export interface Landed {
  text: string;
  /** Written to the file: the view's saved baseline moves too. */
  saved: boolean;
  /** Lines to mark for a moment, 0-based in `text`. */
  marks: number[];
}

type Listener = (l: Landed) => void;
const listeners = new Map<string, Set<Listener>>();

/** A note view's hook for its note; returns the unhook. */
export function onLanded(key: string, fn: Listener): () => void {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(fn);
  return () => set.delete(fn);
}

function land(key: string, l: Landed): void {
  for (const fn of listeners.get(key) ?? []) fn(l);
}

/** The exchange whose reply is streaming, by `seq`. */
const live = new Map<number, NoteEditTurn>();
let nextSeq = Date.now();
let listening = false;

/** The delta listener, once — from the panel's mount. */
export async function initNoteEditEvents(): Promise<void> {
  if (listening) return;
  listening = true;
  try {
    await listen<{ seq: number; text: string }>("note-edit-delta", (e) => {
      const t = live.get(e.payload.seq);
      if (t && t.status === "running") t.partial = (t.partial ?? "") + e.payload.text;
    });
  } catch {
    listening = false;
  }
}

/** The running exchange on `key`, if any. */
export function runningTurn(key: string): NoteEditTurn | null {
  const turns = noteEdits[key]?.turns ?? [];
  const last = turns[turns.length - 1];
  return last && last.status === "running" ? last : null;
}

/** The seq of the running exchange on `key`, for Stop. */
const seqOf = new Map<string, number>();

/**
 * Rewrite the note `scope:name`, whose text in the editor is `before`, to
 * fit the thread's request. The note is written through `saveNote` — the
 * editor's own Save — only when the reply is whole.
 */
export async function runNoteEdit(scope: NoteScope, name: string, before: string): Promise<void> {
  const key = noteDraftKey(scope, name);
  const t = thread(key);
  const request = t.draft.trim();
  if (!request || runningTurn(key)) return;
  const seq = nextSeq++;
  const turn: NoteEditTurn = {
    id: seq,
    request,
    strike: t.strike,
    at: new Date().toISOString(),
    status: "running",
    before,
    partial: "",
  };
  t.turns.push(turn);
  // The proxy, so the delta listener's writes are seen by the views.
  const row = t.turns[t.turns.length - 1];
  live.set(seq, row);
  seqOf.set(key, seq);
  // The request moves into the thread; the box empties.
  t.draft = "";
  t.touched = row.at;
  flushNoteEdits();
  const d = app.draft;
  try {
    const r = await api.editNoteByPrompt({
      name,
      text: before,
      request,
      strike: row.strike,
      today: today(),
      seq,
      binary: d.agentBinary.trim() || undefined,
      model: d.agentModel.trim() || undefined,
      safeMode: d.agentSafeMode,
    });
    for (const n of r.notices) addToast(n);
    await finish(scope, name, key, row, r);
  } catch (e) {
    row.status = "failed";
    row.error = String(e);
  } finally {
    live.delete(seq);
    seqOf.delete(key);
    row.partial = undefined;
    t.touched = new Date().toISOString();
    flushNoteEdits();
  }
}

async function finish(
  scope: NoteScope,
  name: string,
  key: string,
  row: NoteEditTurn,
  r: api.NoteEditResult,
): Promise<void> {
  if (r.interrupted) {
    row.status = "stopped";
    return;
  }
  const split = splitReply(r.reply, row.before);
  row.summary = split.summary;
  const after = split.note;
  if (after.trim() === "" && row.before.trim() !== "") {
    row.status = "failed";
    row.error = "the model returned an empty note — nothing was changed";
    return;
  }
  row.after = after;
  if (after === row.before) {
    row.status = "unchanged";
    return;
  }
  const marks = changedLines(row.before, after);
  // Another project took the app meanwhile: `saveNote` would write this
  // name in *that* project. The result waits as this note's draft.
  const sameProject = noteDraftKey(scope, name) === key;
  if (!split.complete || !sameProject) {
    app.noteDrafts[key] = after;
    row.status = "draft";
    row.error = !split.complete
      ? "the reply had no end marker, so it may be cut off — it is in the editor unsaved; Save keeps it, Revert drops it"
      : "the project changed while this ran — the result is this note's unsaved draft";
    land(key, { text: after, saved: false, marks });
    return;
  }
  if (await saveNote(scope, name, after)) {
    delete app.noteDrafts[key];
    row.status = "applied";
    land(key, { text: after, saved: true, marks });
  } else {
    app.noteDrafts[key] = after;
    row.status = "draft";
    row.error = "the save failed — the result is in the editor unsaved";
    land(key, { text: after, saved: false, marks });
  }
}

/** Stop the running rewrite on `key`. The note is untouched. */
export async function stopNoteEdit(key: string): Promise<void> {
  const seq = seqOf.get(key);
  if (seq === undefined) return;
  try {
    await api.cancelNoteEdit(seq);
  } catch (e) {
    addToast(String(e));
  }
}

/**
 * Undo the newest applied edit: the note goes back to its text before it,
 * saved, in one step. `current` is the editor's text; when it is not what
 * the model left (he typed since), it is kept as an entry first.
 */
export async function undoNoteEdit(scope: NoteScope, name: string, current: string): Promise<void> {
  const key = noteDraftKey(scope, name);
  const t = thread(key);
  const turn = undoable(t.turns);
  if (!turn || runningTurn(key)) return;
  if (current !== turn.after && current !== turn.before) {
    t.turns.push({
      id: nextSeq++,
      request: "",
      strike: t.strike,
      at: new Date().toISOString(),
      status: "kept",
      before: current,
      summary: "Your text as it read before Undo, kept here.",
    });
  }
  const back = turn.before;
  if (await saveNote(scope, name, back)) {
    delete app.noteDrafts[key];
    turn.status = "undone";
    land(key, { text: back, saved: true, marks: changedLines(current, back) });
  }
  t.touched = new Date().toISOString();
  flushNoteEdits();
}

/** Put an exchange's earlier text back in the editor as an unsaved draft. */
export function restoreAsDraft(key: string, text: string): void {
  app.noteDrafts[key] = text;
  land(key, { text, saved: false, marks: [] });
}
