// Moved out of state.svelte.ts by item 641 (pure move; state.svelte.ts re-exports every name it exported).
import { viewRenameKeys } from "../viewState";
import * as api from "../api";
import { UNFILED } from "../drafts.svelte";
import { modelInstructionFile } from "../catalog";
import { refreshWithin, withNote, withoutNote } from "../afterWrite";
import { isMoveNotesTool, movesInAnswer } from "../notesMoved";
import * as tabs from "../tabs";
import type { Note, NoteScope, ProposalEntry, ProposalScope, TurnEvent } from "../types";
import { app, refreshProjects, refreshNotes, refreshProposals, applyDraft, reflectTabs, closeTab, dropNoteTabs, addToast } from "../state.svelte";

// ---- the docspace ----

export function showNote(scope: NoteScope, name: string): void {
  app.openNote = { scope, name };
  app.view = "note";
  // Opening a note is the editor, not the review; `reviewProposal` sets
  // the review back after calling this.
  app.proposalReview = null;
  // So the list highlighting the open note is the list on screen — this is
  // also reachable from the welcome page and from the graph, where the
  // sidebar may be on Chats.
  app.leftTab = "notes";
  // Landed here as well as by the effect (backlog 140): a ⌘-click on the
  // note already in front changes nothing the effect sees, and the
  // modifier must be consumed rather than left armed (review E's rule).
  reflectTabs();
}

export function showGraph(): void {
  app.view = "graph";
  app.openNote = null;
  app.leftTab = "notes";
  // The graph is a tab (backlog 140).
  reflectTabs();
}

/**
 * The note view's way out — ← Chat, Save from the rail or Settings,
 * Close for now on a proposal. With tabs (nightshift backlog 099) a note
 * is a tab, so this closes the focused pane's note tab and lands its
 * neighbour; `leaveNote` below is the view-level half, which the chat
 * openers call themselves (a chat opened from the sidebar *replaces* the
 * note tab rather than closing it, blocker 140).
 */
export function closeNote(): void {
  const front = tabs.activeTab(tabs.focusedPane(app.tabs));
  if (front.content.kind === "note") {
    void closeTab(front.id);
    return;
  }
  leaveNote();
}

export function leaveNote(): void {
  app.view = "chat";
  app.openNote = null;
  app.proposalReview = null;
  // Back to whoever opened it. One function for every way out — Save,
  // ← Chat — so no route can strand `noteFrom`.
  if (app.noteFrom === "rail") {
    app.railScrollTo = "model";
    app.showRail = true;
  } else if (app.noteFrom === "settings") {
    app.settingsOpenOn = "models";
    app.showSettings = true;
  }
  app.noteFrom = null;
}

/**
 * The model a chat is (or would be) on, for its instruction file: the id
 * the rail sends, or the one the connection resolved when the rail sent
 * none. On the Claude Code engine it is the alias — the file is named after
 * what the rail sends, since the CLI's resolved id arrives with the first
 * turn, after the prompt is built — and null on the CLI's own default,
 * which has no name to file under.
 */
export function currentModelId(): string | null {
  const d = app.draft;
  if (d.engine === "claude-code") return d.agentModel.trim() || null;
  return d.model.trim() || app.connection?.model || null;
}

/**
 * Open the editor on a model's instruction file, in place of the popover or
 * Settings; `closeNote` brings that surface back. The sidebar tab is left
 * where it was: the file is not in the Notes list, so switching to it would
 * show a list with nothing highlighted.
 */
export function openModelInstructions(model: string, from: "rail" | "settings"): void {
  const tab = app.leftTab;
  app.showRail = false;
  app.showSettings = false;
  app.noteFrom = from;
  showNote("models", modelInstructionFile(model));
  app.leftTab = tab;
}

/** The one file the Chat instructions layer reads (nightshift backlog 102). */
export const CHAT_INSTRUCTIONS_FILE = "CHAT.md";

/**
 * Open the editor on the Chat instructions — `~/.nightloom/CHAT.md`, how
 * a Chat talks (nightshift backlog 102) — the way `openModelInstructions`
 * opens a model's file; `closeNote` brings Settings back to the pane the
 * card sits on.
 */
export function openChatInstructions(from: "rail" | "settings"): void {
  const tab = app.leftTab;
  app.showRail = false;
  app.showSettings = false;
  app.noteFrom = from;
  showNote("chat", CHAT_INSTRUCTIONS_FILE);
  app.leftTab = tab;
}

export async function saveNote(
  scope: NoteScope,
  name: string,
  content: string,
): Promise<boolean> {
  let written: Note;
  try {
    written = await api.saveNote(scope, name, content);
  } catch (e) {
    addToast(String(e));
    return false;
  }
  // The list shows the note now, from the write's own answer (backlog 211);
  // the re-read below confirms it in the background.
  if (written && scope === "project") app.notes = withNote(app.notes, written);
  else if (written && scope === "knowledge") app.vault = withNote(app.vault, written);
  // The draft that was saved came from a proposal: record it as applied,
  // with the text that was actually saved. After the save and never
  // instead of it — the file was written by the editor's own path above,
  // which is the whole design of proposals.
  const staged = app.stagedProposal;
  if (staged && staged.key === noteDraftKey(scope, name)) {
    app.stagedProposal = null;
    try {
      await api.markApplied(staged.scope, staged.id, content);
    } catch (e) {
      addToast(`saved, but could not file the proposal as applied: ${String(e)}`);
    }
  }
  // ~~`await refreshNotes(); await refreshProjects();`~~ — in the background
  // since backlog 211: a listing hung on iCloud held Saved, the draft and
  // the way back to Settings behind it, though the file was written.
  void refreshWithin("saving " + name, [refreshNotes, refreshProjects]);
  // The always-loaded files are read once, when the connection's preamble
  // is assembled — so a saved edit would otherwise sit unread until the
  // next connect. Re-connect the live connection, the same rule as editing
  // the active prompt-library entry. Nothing is done when there is no
  // connection to refresh. A model's file is one of them: saved for the
  // model the chat is on it takes effect now, and for another model the
  // re-connect is a no-op on the prompt, which is cheaper than working out
  // which it was.
  if (
    (scope === "instructions" || scope === "memory" || scope === "models" || scope === "chat") &&
    app.connection
  ) {
    // Not awaited (backlog 211): a reconnect spawns the CLI, and Save is
    // done when the file is written. During a turn it waits for the turn's
    // end (backlog 214's deferral in `applyDraft`).
    void applyDraft();
  }
  return true;
}

export async function deleteNote(
  scope: NoteScope,
  name: string,
  /** As `moveNoteTo`'s (item 471): a running edit-by-prompt turn on the
   *  note refuses the delete — its writes would bring the file back. */
  busy: (key: string) => boolean = () => false,
): Promise<void> {
  if (busy(noteDraftKey(scope, name))) {
    addToast(`${name} is being edited by a prompt right now — delete it when that turn ends`);
    return;
  }
  let trashed: string;
  try {
    trashed = await api.deleteNote(scope, name);
  } catch (e) {
    addToast(String(e));
    return;
  }
  // Item 471: its unsaved draft goes to the trash beside it, not left
  // under a name no note has.
  draftsToTrash(scope, [name], name, trashed);
  if (app.openNote?.scope === scope && app.openNote.name === name) leaveNote();
  dropNoteTabs(scope, name);
  // As `saveNote` (backlog 211): off the list now, re-read in the background.
  if (scope === "project") app.notes = withoutNote(app.notes, name);
  else if (scope === "knowledge") app.vault = withoutNote(app.vault, name);
  void refreshWithin("deleting " + name, [refreshNotes, refreshProjects]);
}

/**
 * Move or rename a note, or a folder of notes (item 457), and carry
 * everything that names it along: its tabs, the open note, and — the
 * never-lose-work rule — an unsaved draft, which moves to the new name's
 * key so the editor reopens on it. Refused while an edit-by-prompt turn is
 * running on a note it would move (that turn writes to the old path).
 * The new name, or null when nothing moved.
 */
export async function moveNoteTo(
  scope: "project" | "knowledge",
  from: string,
  to: string,
  /** Whether a draft key has an edit-by-prompt turn running (the caller
   *  passes `noteEdit.svelte`'s `runningTurn`; that module imports this one). */
  busy: (key: string) => boolean = () => false,
): Promise<string | null> {
  const list = scope === "project" ? app.notes : app.vault;
  const touched = list.filter((n) => movedNameOf(n.name, from, to) !== null);
  if (touched.some((n) => busy(noteDraftKey(scope, n.name)))) {
    addToast(`${from} is being edited by a prompt right now — move it when that turn ends`);
    return null;
  }
  let landed: string;
  try {
    landed = await api.moveNote(scope, from, to);
  } catch (e) {
    addToast(String(e));
    return null;
  }
  if (landed === from) return landed;
  followNoteMove(scope, from, landed);
  return landed;
}

/**
 * Everything that names `from` follows it to `landed`, after the file has
 * moved on disk — by `moveNoteTo`, or by the note editor's `rename_note`
 * tool (item 460), which renames in the backend and reports it here.
 */
export function followNoteMove(
  scope: "project" | "knowledge",
  from: string,
  landed: string,
  /** False for all but the last of a batch (item 483): one re-read. */
  refresh = true,
): void {
  const list = scope === "project" ? app.notes : app.vault;
  const touched = list.filter((n) => movedNameOf(n.name, from, landed) !== null);
  // The open note may not be in the list yet (a note just made).
  if (!touched.some((n) => n.name === from)) touched.push({ name: from, bytes: 0, modified: "", summary: null });
  // Drafts first, then the names that point at them: the editor reloads
  // when its tab's name changes, and must find the draft already there.
  for (const n of touched) {
    const next = movedNameOf(n.name, from, landed);
    if (next === null) continue;
    const oldKey = noteDraftKey(scope, n.name);
    const draft = app.noteDrafts[oldKey];
    if (draft !== undefined) {
      const newKey = noteDraftKey(scope, next);
      // Item 471: a draft already under the new name (a note of that name
      // is gone — the backend refuses a taken target) is never written
      // over: it is kept aside and sent to the trash.
      const older = app.noteDrafts[newKey];
      if (older !== undefined && older !== draft) parkOlderDraft(scope, next, older);
      app.noteDrafts[newKey] = draft;
      delete app.noteDrafts[oldKey];
    }
  }
  // Item 483: stores this module cannot import (it is imported by them —
  // the note editor's threads, with his half-typed request) follow too.
  for (const fn of noteMoveListeners) fn(scope, from, landed);
  for (const t of tabs.allTabs(app.tabs)) {
    if (t.content.kind !== "note" || t.content.scope !== scope) continue;
    const next = movedNameOf(t.content.name, from, landed);
    if (next !== null) t.content = { ...t.content, name: next };
  }
  if (app.openNote?.scope === scope) {
    const next = movedNameOf(app.openNote.name, from, landed);
    if (next !== null) app.openNote = { scope, name: next };
  }
  // The list now, from the move's own answer; re-read in the background.
  const renamed = list.map((n) => {
    const next = movedNameOf(n.name, from, landed);
    return next === null ? n : { ...n, name: next };
  });
  if (scope === "project") app.notes = renamed;
  else app.vault = renamed;
  app.noteFolders[scope] = app.noteFolders[scope].map((f) => movedNameOf(f, from, landed) ?? f);
  if (refresh) void refreshWithin("moving " + from, [refreshNotes, refreshProjects]);
}

type NoteMoveListener = (scope: "project" | "knowledge", from: string, landed: string) => void;
const noteMoveListeners: NoteMoveListener[] = [];

/** Item 483: be told of every followed move (`followNoteMove`), after the
 *  drafts moved and before the tabs do; the unsubscribe. */
export function onNoteMove(fn: NoteMoveListener): () => void {
  noteMoveListeners.push(fn);
  return () => {
    const i = noteMoveListeners.indexOf(fn);
    if (i >= 0) noteMoveListeners.splice(i, 1);
  };
}

/** `name` once `from` moved to `landed`, or null — for the listeners. */
export function movedNoteName(name: string, from: string, landed: string): string | null {
  return movedNameOf(name, from, landed);
}
// Item 495: a note's kept view switches follow it when it moves (483's listener).
onNoteMove((_scope, from, landed) => viewRenameKeys("noteMedia.full:", (name) => movedNoteName(name, from, landed)));

/**
 * Item 483: a chat's `move_notes` (item 472) moved notes in the vault on
 * the backend; its answer names each move that landed — a part-way
 * failure's too — and each is followed as the panel's own move is, in
 * order, so a tab, the open note and an unsaved draft go to the new name.
 * Any chat's result (on screen, in the background, a subagent's or an
 * aside's), the live event only — a transcript re-read never replays it.
 */
export function followToolMoves(ev: TurnEvent): void {
  const r = ev.type === "subagent" ? ev.event : ev;
  if (r.type !== "tool_result" || !isMoveNotesTool(r.name)) return;
  const moves = movesInAnswer(r.content);
  moves.forEach(([from, landed], i) => followNoteMove("knowledge", from, landed, i === moves.length - 1));
}

/**
 * Item 471 (practices §7, no UI mechanic loses his work): the unsaved
 * drafts of deleted notes go to the notes trash beside them, as
 * `<stem> (unsaved draft).md`, and a toast says where. `names` are the
 * deleted notes, `from` what was deleted (a note or a folder) and
 * `trashed` where it went inside the trash. A draft stays in app state
 * until the write lands, and stays there if it fails.
 */
function draftsToTrash(scope: NoteScope, names: string[], from: string, trashed: string): void {
  const entries: { key: string; at: string; text: string }[] = [];
  for (const n of new Set(names)) {
    const key = noteDraftKey(scope, n);
    const text = app.noteDrafts[key];
    if (text === undefined) continue;
    entries.push({ key, at: (trashed && movedNameOf(n, from, trashed)) || n, text });
  }
  void sendDraftsToTrash(scope, entries);
}

/** A draft that would have been written over (item 471): parked under a
 *  key no note has, so it survives a failed write, then sent to the trash. */
function parkOlderDraft(scope: NoteScope, name: string, text: string): void {
  let i = 1;
  let key = noteDraftKey(scope, `${name} (older draft)`);
  while (app.noteDrafts[key] !== undefined) key = noteDraftKey(scope, `${name} (older draft ${++i})`);
  app.noteDrafts[key] = text;
  void sendDraftsToTrash(scope, [{ key, at: name, text }]);
}

async function sendDraftsToTrash(scope: NoteScope, entries: { key: string; at: string; text: string }[]): Promise<void> {
  if (entries.length === 0) return;
  let written: string[];
  try {
    written = await api.trashNoteDrafts(
      scope,
      entries.map((e) => [e.at, e.text]),
    );
  } catch (e) {
    addToast(`Kept ${entries.length === 1 ? "an unsaved draft" : `${entries.length} unsaved drafts`} in the app — could not write to the trash: ${String(e)}`);
    return;
  }
  for (const e of entries) if (app.noteDrafts[e.key] === e.text) delete app.noteDrafts[e.key];
  addToast(
    written.length === 1
      ? `Its unsaved draft is in the notes trash: .trash/notes/${written[0]}`
      : `${written.length} unsaved drafts are in the notes trash, beside their notes (.trash/notes/)`,
  );
}

/** `name` once `from` moved to `to`, or null (`notesTree.movedName`). */
function movedNameOf(name: string, from: string, to: string): string | null {
  if (name === from) return to;
  if (name.startsWith(`${from}/`)) return to + name.slice(from.length);
  return null;
}

/** Make a folder among the notes (item 457); its name, or null. */
export async function newNoteFolder(scope: "project" | "knowledge", name: string): Promise<string | null> {
  let made: string;
  try {
    made = await api.newNoteFolder(scope, name);
  } catch (e) {
    addToast(String(e));
    return null;
  }
  if (!app.noteFolders[scope].includes(made)) app.noteFolders[scope] = [...app.noteFolders[scope], made];
  void refreshWithin("making " + made, [refreshNotes]);
  return made;
}

/**
 * Delete a folder of notes (item 457): to the docspace's trash, whole, as
 * a note's Delete is. Its notes' tabs close, as a deleted note's do.
 */
export async function deleteNoteFolder(
  scope: "project" | "knowledge",
  folder: string,
  /** As `moveNoteTo`'s (item 471): refused while an edit-by-prompt turn
   *  runs on a note inside — its writes would recreate the old path. */
  busy: (key: string) => boolean = () => false,
): Promise<void> {
  const inside = (n: string) => n.startsWith(`${folder}/`);
  const listed = scope === "project" ? app.notes : app.vault;
  // The open note may not be in the list yet (a note just made).
  const names = listed.filter((n) => inside(n.name)).map((n) => n.name);
  if (app.openNote?.scope === scope && inside(app.openNote.name)) names.push(app.openNote.name);
  for (const k of Object.keys(app.noteDrafts)) {
    const prefix = noteDraftKey(scope, `${folder}/`);
    if (k.startsWith(prefix)) names.push(`${folder}/${k.slice(prefix.length)}`);
  }
  if (names.some((n) => busy(noteDraftKey(scope, n)))) {
    addToast(`A note in ${folder} is being edited by a prompt right now — delete the folder when that turn ends`);
    return;
  }
  let trashed: string;
  try {
    trashed = await api.deleteNote(scope, folder);
  } catch (e) {
    addToast(String(e));
    return;
  }
  // Item 471: the folder's unsaved drafts go to the trash beside its notes.
  draftsToTrash(scope, names, folder, trashed);
  const list = scope === "project" ? app.notes : app.vault;
  for (const n of list.filter((n) => inside(n.name))) {
    if (app.openNote?.scope === scope && app.openNote.name === n.name) leaveNote();
    dropNoteTabs(scope, n.name);
  }
  if (scope === "project") app.notes = list.filter((n) => !inside(n.name));
  else app.vault = list.filter((n) => !inside(n.name));
  app.noteFolders[scope] = app.noteFolders[scope].filter((f) => f !== folder && !inside(f));
  void refreshWithin("deleting " + folder, [refreshNotes, refreshProjects]);
}

// ---- proposals: the dream's suggested edits to the fixed files ----

/** The one file each proposal scope names. */
export const AGENTS_MD = "AGENTS.md";

/**
 * Open `NoteView` on a fixed file in proposal mode: the newest pending
 * proposal for that scope as a diff against the file, with Load into
 * editor, Dismiss and Keep for later. Nothing happens to the file or the
 * buffer until Load is pressed.
 */
export function reviewProposal(scope: ProposalScope, id?: string): void {
  const list = app.proposals[scope];
  const entry = (id ? list.find((e) => e.id === id) : undefined) ?? list[0];
  if (!entry) return;
  showNote(scope, AGENTS_MD);
  app.proposalReview = { scope, entry };
}

/**
 * The draft-mirror rule the editor applies on every keystroke: the buffer
 * is a draft while it differs from the saved text, and no draft once it
 * matches again — so a Revert (buffer back to saved) leaves nothing behind.
 * A function rather than an effect body so the rule can be tested: it is
 * what makes a loaded proposal a draft and not a save.
 */
export function mirrorDraft(key: string, text: string, saved: string): void {
  if (text !== saved) app.noteDrafts[key] = text;
  else delete app.noteDrafts[key];
}

/**
 * The key a note's draft and a staged proposal live under. `scope:name`
 * — and, for the scopes that are one file *per project* (the project's
 * notes and its `AGENTS.md`), the project's id in front (backlog 133,
 * review B's FB8): with one key for every project's `AGENTS.md`, a
 * proposal loaded into project A's editor and left unsaved came back as
 * B's unsaved draft after a switch from the bell, and a Save wrote A's
 * instructions over B's file. The vault's, the models' and the unfiled
 * chats' files are one each, so their keys carry no project.
 */
export function noteDraftKey(scope: NoteScope, name: string, projectId: string | null = app.project?.id ?? null): string {
  return scope === "project" || scope === "instructions"
    ? `${projectId ?? UNFILED}:${scope}:${name}`
    : `${scope}:${name}`;
}

/**
 * Put a proposal's text in the editor as a draft. The file is untouched:
 * `noteDrafts` is where unsaved text lives, the ● draft marker and Revert
 * follow from it, and the only way the text reaches the file is the same
 * Save any edit takes — which, seeing `stagedProposal`, records the
 * proposal as applied afterwards.
 */
export function stageProposal(
  scope: ProposalScope,
  entry: ProposalEntry,
  saved: string,
  // The proposed side as the card shows it — his edits on the card
  // included (backlog 184); the dream's text when there are none.
  text: string = entry.proposal.text,
): void {
  const key = noteDraftKey(scope, AGENTS_MD);
  mirrorDraft(key, text, saved);
  app.stagedProposal = { key, scope, id: entry.id };
  app.proposalReview = null;
}

/**
 * Accept on the proposal card (nightshift backlog 184): save the proposed
 * side — the dream's text, or his edit of it — to the file in one click,
 * through the same `saveNote` the header's Save takes, so the proposal is
 * filed as applied with the text actually saved and the open chat is
 * re-connected. A draft typed in the editor is not touched; a different
 * proposal staged there stays staged.
 */
export async function acceptProposal(scope: ProposalScope, entry: ProposalEntry, text: string): Promise<boolean> {
  const key = noteDraftKey(scope, AGENTS_MD);
  const before = app.stagedProposal;
  app.stagedProposal = { key, scope, id: entry.id };
  const ok = await saveNote(scope, AGENTS_MD, text);
  if (!ok) {
    app.stagedProposal = before;
    return false;
  }
  if (before && before.id !== entry.id) app.stagedProposal = before;
  delete app.proposalEdits[entry.id];
  if (app.proposalReview?.entry.id === entry.id) app.proposalReview = null;
  return true;
}

/** The buffer went back to the saved text: the proposal is no longer what
 *  a Save would apply. The proposal itself stays pending. */
export function unstageProposal(key: string): void {
  if (app.stagedProposal?.key === key) app.stagedProposal = null;
}

/** Turn a proposal down. Confirmed by the caller first; the backend moves
 *  the file aside rather than deleting it. */
export async function dismissProposal(scope: ProposalScope, id: string): Promise<boolean> {
  try {
    await api.dismissProposal(scope, id);
  } catch (e) {
    addToast(String(e));
    return false;
  }
  if (app.proposalReview?.entry.id === id) app.proposalReview = null;
  delete app.proposalEdits[id];
  // The key `stageProposal` used (nightshift backlog 185): a hand-built
  // `${scope}:AGENTS.md` missed the project's own key, so a later Save tried
  // to mark a dismissed proposal applied.
  unstageProposal(noteDraftKey(scope, AGENTS_MD));
  await refreshProposals();
  return true;
}
