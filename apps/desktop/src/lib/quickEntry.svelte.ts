// Item 795: Quick Entry's main-window half. It hands his saved shortcut to
// the backend (`quick_entry.rs`), keeps the box's targets current in
// localStorage, and runs what the box sends — through the same functions a
// scheduled send, the phone and an aside use, so the turn runs in the
// background with the usual finish notice and the window stays behind.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import * as api from "./api";
import { chatName } from "./notify";
import { app, remoteNewChat, sendInChat } from "./state.svelte";
import { loadShortcut, readContext, restoreDraft, saveShortcut, writeContext, type QuickContext, type QuickSend } from "./quickEntry";

/** The shortcut held now, or why none is (Settings shows both). */
export const quickEntry = $state({ shortcut: null as string | null, error: null as string | null });

/** Hand a shortcut to the backend; saved only once it registered (or it is
 *  "off"), so a refused pick never sticks. A dev build refuses with its
 *  reason and keeps the pick, so Settings still shows it. */
export async function setQuickShortcut(s: string | null, save = true): Promise<boolean> {
  try {
    await invoke<string | null>("quick_entry_set_shortcut", { shortcut: s });
    quickEntry.shortcut = s;
    quickEntry.error = null;
    if (save) saveShortcut(localStorage, s);
    return true;
  } catch (e) {
    const why = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
    quickEntry.error = why;
    if (/dev build/.test(why)) {
      quickEntry.shortcut = s;
      if (save) saveShortcut(localStorage, s);
    }
    return false;
  }
}

/** The context the box reads: the chat he last used — the one on screen,
 *  or, while a new unsaved chat is, the one before — and the projects. */
export function contextNow(prev: QuickContext): QuickContext {
  const id = app.activeSessionId;
  const row = id ? app.sessions.find((x) => x.id === id) : undefined;
  const chat = id ? { id, title: row ? chatName(row.title, row.first_user) : "the last chat" } : prev.chat;
  const project = id ? (app.project ? { id: app.project.id, name: app.project.name } : null) : prev.project;
  return { chat, project, projects: app.projects.map((p) => ({ id: p.id, name: p.name })) };
}

function refused(text: string, why: string): void {
  restoreDraft(localStorage, text);
  void api.notify("Quick Entry: not sent", `${why}. Your words are back in the box.`).catch(() => {});
}

/** Run one send from the box; a refusal puts the words back in its draft
 *  and says why in a banner (the window stays behind). */
export async function runQuickSend(p: QuickSend): Promise<void> {
  try {
    if (p.target === "new") {
      await remoteNewChat(p.project, p.text);
      return;
    }
    if (!p.chat) throw new Error("no chat is on record");
    if (p.target === "last") {
      const project = app.projects.find((x) => x.id === p.project);
      sendInChat(p.chat, { id: p.project, name: project?.name ?? null }, p.text, [], (why) => refused(p.text, why));
      return;
    }
    const { runAsideOp } = await import("./remoteHandlers");
    await runAsideOp(p.chat, p.project, { text: p.text }, () => {});
  } catch (e) {
    refused(p.text, e instanceof Error ? e.message : String(e));
  }
}

/** Once, from `init`: the saved shortcut, the targets kept current, the
 *  box's sends heard. */
export async function installQuickEntry(): Promise<void> {
  const saved = loadShortcut(localStorage);
  if (saved) void setQuickShortcut(saved, false);
  $effect.root(() => {
    $effect(() => {
      // Read here so the effect follows them.
      void app.activeSessionId;
      void app.sessions;
      void app.project;
      void app.projects;
      writeContext(localStorage, contextNow(readContext(localStorage)));
    });
  });
  await listen<QuickSend>("quick-entry-send", (e) => void runQuickSend(e.payload));
}
