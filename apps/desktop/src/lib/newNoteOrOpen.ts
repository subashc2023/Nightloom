/**
 * Item 967's `/note <title>`: the Notes panel's New note (`create` and
 * review fix 457's `openIfTaken` in `NotesPanel.svelte`, same rules): a
 * name already there — in the list in any case, or on disk past a stale
 * list — opens that note instead of writing an empty file over it.
 *
 * Item 1018 (his blocker 2343, "open new"): either way the note opens in a
 * NEW tab and the chat's tab stays; a tab already showing it is focused
 * instead (`land` finds it before it makes one).
 */
import * as api from "./api";
import { readSaysTaken } from "./notesTree";
import { addToast, app, saveNote, showNote } from "./state.svelte";

export async function newNoteOrOpen(scope: "project" | "knowledge", name: string): Promise<void> {
  const lower = name.toLowerCase();
  const listed = (scope === "project" ? app.notes : app.vault).find((n) => n.name.toLowerCase() === lower);
  let taken = listed !== undefined;
  if (!taken) {
    try {
      await api.readNote(scope, name);
      taken = true;
    } catch (e) {
      const read = readSaysTaken(e);
      if (read === "folder") {
        addToast(`${name} is a folder already`);
        return;
      }
      taken = read === "taken";
    }
  }
  if (taken) {
    addToast(`${name} already exists — opened it rather than writing over it`);
    openInNewTab(scope, listed?.name ?? name);
    return;
  }
  if (await saveNote(scope, name, "")) openInNewTab(scope, name);
}

function openInNewTab(scope: "project" | "knowledge", name: string): void {
  app.openNext = "new";
  showNote(scope, name);
  // Showing the note already in front changes nothing the reflection sees; the modifier must not stay armed.
  app.openNext = "replace";
}
