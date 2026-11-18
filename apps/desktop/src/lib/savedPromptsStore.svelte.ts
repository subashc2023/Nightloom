/**
 * The Mac's saved message prompts (nightshift item 800): the list Settings
 * edits and every message box offers after a `/`, read from and written to
 * the host's `saved-prompts.json` (`commands/saved_prompts.rs`), which the
 * phone reads too. The rules of an edit are `savedPrompts.ts`'s.
 *
 * The first reading of a file that never existed writes the two prompts
 * the list starts with — his wrap-up message (Settings' own copy, else the
 * built-in) and the spec launch. A list he emptied stays empty.
 */
import { invoke } from "@tauri-apps/api/core";
import { defaultMessage } from "./handoff.svelte";
import {
  dateWord,
  fillAuto,
  move,
  nameProblem,
  restoreVersion,
  saveIn,
  seeds,
  trash,
  untrash,
  wantsClipboard,
  type MessagePrompt,
  type PromptDoc,
} from "./savedPrompts";
import { lastSelection } from "./selectionMemory";

export const saved = $state({
  list: [] as MessagePrompt[],
  loaded: false,
  /** The last read or write's refusal, said in Settings. */
  error: null as string | null,
  /**
   * The edit open in Settings, kept here rather than in the pane so
   * closing Settings — or leaving for another pane — offers it back
   * (practices §7: only Save or Discard drops it). `id` null is a new one.
   */
  draft: readDraft(),
});

type Draft = { id: string | null; name: string; body: string };
const DRAFT_KEY = "nightloom.saved-prompt-draft";

/** The edit open when the app last closed: a quit does not lose it either. */
function readDraft(): Draft | null {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null");
    if (d && typeof d.name === "string" && typeof d.body === "string") {
      return { id: typeof d.id === "string" ? d.id : null, name: d.name, body: d.body };
    }
  } catch {
    // no draft
  }
  return null;
}

function keepDraft(d: Draft | null): void {
  saved.draft = d;
  try {
    if (d) localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    // best-effort, like every preference here
  }
}

/** Change the open edit (each keystroke), kept as it is typed. */
export function setDraft(patch: Partial<Draft>): void {
  if (saved.draft) keepDraft({ ...saved.draft, ...patch });
}

let loading: Promise<void> | null = null;

function clean(p: Partial<MessagePrompt>): MessagePrompt | null {
  if (!p || typeof p.id !== "string" || typeof p.name !== "string") return null;
  return {
    id: p.id,
    name: p.name,
    body: typeof p.body === "string" ? p.body : "",
    updated: typeof p.updated === "number" ? p.updated : 0,
    versions: Array.isArray(p.versions) ? p.versions : [],
    deleted: typeof p.deleted === "number" ? p.deleted : null,
  };
}

/** Read the file (once; `force` reads again). */
export function loadSaved(force = false): Promise<void> {
  if (loading && !force) return loading;
  loading = (async () => {
    try {
      const r = await invoke<{ doc: PromptDoc; exists: boolean }>("saved_prompts_read");
      const list = (r.doc?.prompts ?? []).map(clean).filter((p): p is MessagePrompt => !!p);
      if (!r.exists) {
        const first = seeds(defaultMessage());
        await invoke("saved_prompts_write", { doc: { prompts: first } });
        saved.list = first;
      } else {
        saved.list = list;
      }
      saved.error = null;
    } catch (e) {
      saved.error = String(e);
    } finally {
      saved.loaded = true;
    }
  })();
  return loading;
}

/** Write `list` whole; on a refusal the list on screen stays as it was. */
export async function writeSaved(list: MessagePrompt[]): Promise<boolean> {
  try {
    await invoke("saved_prompts_write", { doc: { prompts: list } });
    saved.list = list;
    saved.error = null;
    return true;
  } catch (e) {
    saved.error = String(e);
    return false;
  }
}

/** The pasteboard's text, read natively (no Paste bubble); null when none. */
async function clipboard(): Promise<string | null> {
  try {
    return (await invoke<string | null>("clipboard_text")) ?? null;
  } catch {
    return null;
  }
}

/** A prompt's body with `{clipboard}`, `{date}` and `{selection}` filled. */
export async function filledBody(p: { body: string }): Promise<string> {
  return fillAuto(p.body, {
    clipboard: wantsClipboard(p.body) ? await clipboard() : null,
    selection: lastSelection(),
    date: dateWord(),
  });
}

/** Open the editor on `id` (null: a new prompt). An edit already open is
 *  kept — Settings asks before replacing it. */
export function startEdit(id: string | null): void {
  const p = id === null ? null : saved.list.find((x) => x.id === id);
  keepDraft({ id, name: p?.name ?? "", body: p?.body ?? "" });
}

/** Whether the open edit differs from what is saved. */
export function draftDirty(): boolean {
  const d = saved.draft;
  if (!d) return false;
  const p = d.id === null ? null : saved.list.find((x) => x.id === d.id);
  return p ? p.name !== d.name.trim() || p.body !== d.body : d.name.trim() !== "" || d.body !== "";
}

/** Why the open edit cannot be saved, or null. */
export function draftProblem(): string | null {
  const d = saved.draft;
  if (!d) return null;
  return nameProblem(saved.list, d.name, d.id) ?? (d.body.trim() ? null : "Write the prompt's text first.");
}

/** Save the open edit (its previous version kept); the editor closes. */
export async function saveDraft(): Promise<boolean> {
  const d = saved.draft;
  if (!d || draftProblem()) return false;
  const ok = await writeSaved(saveIn(saved.list, d.id, d.name, d.body));
  if (ok) keepDraft(null);
  return ok;
}

export function discardDraft(): void {
  keepDraft(null);
}

/** Delete to the trash (the pane confirms first). */
export async function trashPrompt(id: string): Promise<void> {
  // An edit open on it is kept (only Save or Discard drops a draft); the
  // pane offers Delete only on rows that are not being edited.
  await writeSaved(trash(saved.list, id));
}

/** Bring one back from the trash; false when its name is taken. */
export async function untrashPrompt(id: string): Promise<boolean> {
  const next = untrash(saved.list, id);
  if (!next) {
    saved.error = "A live prompt has that name now — rename it first, then restore this one.";
    return false;
  }
  return writeSaved(next);
}

/** Put version `index` of `id` back (the one it replaces is kept). */
export async function restorePromptVersion(id: string, index: number): Promise<void> {
  await writeSaved(restoreVersion(saved.list, id, index));
}

export async function movePrompt(id: string, by: -1 | 1): Promise<void> {
  await writeSaved(move(saved.list, id, by));
}
