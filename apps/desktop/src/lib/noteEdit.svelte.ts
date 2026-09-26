/**
 * Edit a note by prompt (nightshift backlog 151) — the live part: every
 * note's side chat, kept in localStorage the way the drafts are, and the
 * edit turn itself. Here rather than in the panel so a turn finishes and
 * lands however the view is left: the panel closed, another note opened,
 * the note's pane gone.
 *
 * Pass 2 (blocker 414): the model edits the note's file with the Edit tool,
 * on that one path; each Edit that lands arrives as `note-edit-landed` with
 * the file's text, and the note's views show it with the changed lines
 * marked. The window writes the file only for Undo and for the buffer he
 * sends from (the command writes that, so the model edits what he sees).
 *
 * His text is never lost (practices §7):
 * - the half-typed request is the thread's `draft`, stored as he types, so
 *   closing the panel or the note keeps it;
 * - every exchange keeps the note as it was before the turn (`before`),
 *   which is what Undo restores and what "Earlier text as a draft" offers;
 * - an unsaved draft he sends from goes to the file first; the saved text
 *   it replaced is kept as a `kept` entry;
 * - while a turn runs, every view of the note shows it read-only (the
 *   editor is swapped out), so nothing can be typed into the note for an
 *   Edit to land over; the request box stays his;
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

/** The exchange whose turn is running, by `seq`. */
const live = new Map<number, NoteEditTurn>();
let nextSeq = Date.now();
let listening = false;

/** The model's text streaming in, for the panel. */
export function onNoteEditDelta(seq: number, text: string): void {
  const t = live.get(seq);
  if (t && t.status === "running") t.partial = (t.partial ?? "") + text;
}

/** One Edit landed: the file now reads `text`. Every view of the note
 *  shows it (they read `current` while the turn runs). */
export function onNoteEditLanded(seq: number, text: string, edits: number): void {
  const t = live.get(seq);
  if (!t || t.status !== "running") return;
  t.current = text;
  t.edits = edits;
}

/** The two listeners, once — from the panel's mount. */
export async function initNoteEditEvents(): Promise<void> {
  if (listening) return;
  listening = true;
  try {
    await listen<{ seq: number; text: string }>("note-edit-delta", (e) =>
      onNoteEditDelta(e.payload.seq, e.payload.text),
    );
    await listen<{ seq: number; text: string; edits: number }>("note-edit-landed", (e) =>
      onNoteEditLanded(e.payload.seq, e.payload.text, e.payload.edits),
    );
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
 * Edit the note `scope:name`, whose text in the editor is `before`, to fit
 * the thread's request. The model edits the file; this records the turn
 * and hands each view the final text.
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
    edits: 0,
  };
  t.turns.push(turn);
  // The proxy, so the listeners' writes are seen by the views.
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
      scope,
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
    finish(key, t, row, r);
  } catch (e) {
    // Refused before the model ran (no project open, a bad name): the
    // note is as it was.
    row.status = "failed";
    row.error = String(e);
  } finally {
    live.delete(seq);
    seqOf.delete(key);
    row.partial = undefined;
    row.current = undefined;
    t.touched = new Date().toISOString();
    flushNoteEdits();
  }
}

function finish(key: string, t: NoteEditThread, row: NoteEditTurn, r: api.NoteEditResult): void {
  if (r.was_on_disk !== null && r.was_on_disk !== row.before) {
    // His unsaved draft went to the file so the model would edit what he
    // saw; the text it replaced is kept, just before this exchange.
    t.turns.splice(t.turns.indexOf(row), 0, {
      id: nextSeq++,
      request: "",
      strike: t.strike,
      at: row.at,
      status: "kept",
      before: r.was_on_disk,
      summary: "The file as it was saved before your unsaved text went in, kept here.",
    });
  }
  // The buffer he sent from is in the file now; a draft that held it is
  // no longer a draft (and would otherwise come back over the model's
  // edits the next time the note opens).
  if (app.noteDrafts[key] === row.before) delete app.noteDrafts[key];
  row.summary = r.summary;
  row.edits = r.edits;
  const after = r.text;
  if (after === row.before) {
    row.status = r.interrupted ? "stopped" : r.error ? "failed" : "unchanged";
    if (r.error) row.error = r.error;
    return;
  }
  row.after = after;
  row.status = "applied";
  if (r.interrupted) row.error = `stopped after ${r.edits} edit${r.edits === 1 ? "" : "s"} — they stay; Undo puts the note back`;
  else if (r.error) row.error = `${r.error} — the edits that landed stay; Undo puts the note back`;
  land(key, { text: after, saved: true, marks: changedLines(row.before, after) });
}

/** Stop the running turn on `key`. Edits that landed stay; Undo puts the
 *  note back. */
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
 * Undo the newest edit: the note goes back to its text before that turn,
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
