/**
 * Where a prompt link goes (nightshift item 976; the reading is
 * `promptLinks.ts`): its project opened, a New chat there, the prompt in
 * that New chat's box — never sent. A project no one has → a toast naming
 * it, and the prompt still goes in a New chat where he is, so nothing in
 * the link is lost. Words he had typed in that New chat stay: the prompt
 * goes after them. The backend keeps what arrived until the page takes it
 * (`prompt_links.rs`), so a link that launched the app opens once the
 * launch is done.
 */
import { listen } from "@tauri-apps/api/event";
import * as api from "./api";
import { app, newSession, useProject } from "./state.svelte";
import { addToast } from "./state/toasts.svelte";
import { draftKey, readDraft, setDraftText } from "./drafts.svelte";
import { parsePromptLink, projectNamed, withPrompt } from "./promptLinks";
import type { ProjectInfo } from "./types";

/** What opening a link needs — the app's own, or a test's. */
export interface LinkDeps {
  projects: () => readonly ProjectInfo[];
  current: () => string | null;
  useProject: (id: string) => Promise<void>;
  showChat: () => void;
  newChat: () => Promise<void>;
  /** The New chat's box key, once it is open. */
  boxKey: () => string;
  readBox: (key: string) => string;
  writeBox: (key: string, text: string) => void;
  toast: (text: string) => void;
}

const appDeps: LinkDeps = {
  projects: () => app.projects,
  current: () => app.project?.id ?? null,
  useProject,
  showChat: () => {
    app.showNeeds = false;
    app.showSettings = false;
    if (app.view !== "chat") app.view = "chat";
  },
  newChat: () => newSession(),
  boxKey: () => draftKey(app.activeSessionId, app.project?.id, app.pendingMode, app.pendingThread),
  readBox: (key) => readDraft(key).text,
  writeBox: setDraftText,
  toast: addToast,
};

/** Open one link. Returns where its prompt went (the box's key), or null when it was no prompt link. */
export async function openPromptLink(raw: string, deps: LinkDeps = appDeps): Promise<string | null> {
  const link = parsePromptLink(raw);
  if (!link) {
    deps.toast("That nightloom:// link has no prompt Nightloom can open");
    return null;
  }
  const notes: string[] = [];
  if (link.project) {
    const p = projectNamed(deps.projects(), link.project);
    if (!p) notes.push(`No project is named “${link.project}” — the prompt is in a New chat here instead`);
    else if (deps.current() !== p.id) await deps.useProject(p.id);
  }
  deps.showChat();
  await deps.newChat();
  const key = deps.boxKey();
  deps.writeBox(key, withPrompt(deps.readBox(key), link.prompt));
  if (link.removed > 0) notes.push(`${link.removed} hidden character${link.removed === 1 ? " was" : "s were"} removed from the prompt`);
  deps.toast(notes.length ? notes.join(". ") : "The link's prompt is in the message box — nothing was sent");
  return key;
}

let installed = false;
let draining: Promise<void> = Promise.resolve();

function drain(): Promise<void> {
  // One at a time: a second link waits for the first's New chat.
  draining = draining.then(async () => {
    let links: string[];
    try {
      links = await api.takePromptLinks();
    } catch {
      return;
    }
    for (const l of links) await openPromptLink(l).catch((e) => addToast(String(e)));
  });
  return draining;
}

/** Listen for links, then take any that arrived first; every call after the first is a no-op. */
export async function installPromptLinks(): Promise<void> {
  if (installed) return;
  installed = true;
  await listen("prompt-links", () => void drain());
  await drain();
}
