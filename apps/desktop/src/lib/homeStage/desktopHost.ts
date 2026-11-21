/**
 * The stage's host in the Mac's window (item 845, batch 3; `host.ts`): Tauri commands and the app's own state.
 * Stage.svelte sets it; the phone's page never imports this file.
 */
import * as api from "../api";
import { app, addToast, openRun, sendInChat, chatRuns } from "../state.svelte";
import { home, homeProject } from "../home.svelte";
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
  // A click that could not be kept for Home says so (845 review, (c)): the view still shows it, Home would not.
  taskEvent: (task, view, line) =>
    api.homeTaskEvent(task, view, line).catch((e) => {
      addToast(`Home will not see that click — ${String(e)}`);
      throw e;
    }),
  taskClose: (id) => api.homeTaskClose(id),
  focus: (view, task) => api.homeStageFocus(view, task),
  nudge: (text, fallback) => {
    // Home's chat on screen (the stage only draws in Home's project), idle, with an engine: the short turn runs
    // there as a typed one would (`sendInChat`); anything else keeps the click for Home's next look.
    const chat = app.activeSessionId;
    const p = homeProject();
    if (!chat || !p || (app.project?.id ?? null) !== p.id || !app.connection || app.busy || chatRuns(chat)) return fallback();
    sendInChat(chat, { id: p.id, name: p.name }, text, [], () => fallback());
  },
  noteNames: async () => (await api.listNotes("project").catch(() => [])).map((n) => n.name),
  saveNote: (name, text) => api.saveNote("project", name, text),
  openChat: (chat, project) => void openRun({ session: chat, project, onScreen: false }),
  stopChat: (chat) => api.cancel(chat),
  routedRunning: async () => (await api.homeRoutes()).running ?? [],
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
