/**
 * The stage's host in the Mac's window (item 845, batch 3; `host.ts`): Tauri commands and the app's own state.
 * Stage.svelte sets it; the phone's page never imports this file.
 */
import * as api from "../api";
import { app, addToast, openRun } from "../state.svelte";
import { home } from "../home.svelte";
import { isScanMessage } from "../home";
import { phase, readStatus, startBrowsers } from "../claudeBrowser.svelte";
import ClaudeBrowserView from "../ClaudeBrowserView.svelte";
import { briefOf } from "./brief";
import type { StageHost } from "./host";
import type { Ev } from "./steps";

export const desktopHost: StageHost = {
  events: () => app.events as unknown as Ev[],
  busy: () => app.busy,
  brief: () => briefOf(app.events as unknown as Ev[], isScanMessage, app.busy),
  scanWords: () => home.info?.scan_words ?? null,
  homeTasks: () => api.homeTasks(),
  taskEvent: (task, view, line) => api.homeTaskEvent(task, view, line),
  taskClose: (id) => api.homeTaskClose(id),
  noteNames: async () => (await api.listNotes("project").catch(() => [])).map((n) => n.name),
  saveNote: (name, text) => api.saveNote("project", name, text),
  openChat: (chat, project) => void openRun({ session: chat, project, onScreen: false }),
  toast: (text) => addToast(text),
  liveBrowser: () => {
    const s = app.activeSessionId;
    return s && phase(s) !== "none" ? s : null;
  },
  watchBrowser: () => {
    const s = app.activeSessionId;
    void app.busy;
    if (!s) return;
    void startBrowsers();
    void readStatus(s);
  },
  BrowserView: ClaudeBrowserView as unknown as StageHost["BrowserView"],
};
