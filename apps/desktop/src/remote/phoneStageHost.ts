/**
 * Home's stage on the phone (item 845, batch 3): the stage's host (`lib/homeStage/host.ts`) over the listener's HTTP
 * routes. The views are the Mac's own components; what they ask of the app comes from here:
 *   tasks — `GET /home/tasks`; his clicks — `POST /home/tasks/event` and `/home/tasks/{id}/close` (the Mac only: the
 *   away server says so, and the phone shows its sentence; the view keeps his click either way);
 *   the brief — the scan page the phone's Home already reads (`/home/scan`), cut into its sections;
 *   notes — Home's project's notes (`/notes`, the PUT the Notes sheet uses);
 *   Open chat — the page's own chat screen.
 * Home's steps are not drawn on the phone (the narrow stage has no wide column), so `events` is empty; there is no
 * live browser picture (the Mac's window owns it), so Browse draws the page Home reports.
 */
import type { StageHost } from "../lib/homeStage/host";
import { sectionsOf, type Brief } from "../lib/homeStage/brief";
import { ApiError, Unreachable, type Client, type HomeScanWire } from "./client";

export interface PhoneStageDeps {
  client: () => Client;
  home: () => { project: string | null; chat: string | null };
  scan: () => HomeScanWire | null;
  open: (chat: string, project: string | null) => void;
  note: (text: string) => void;
}

/** The phone's brief: the scan page, its sections as the Mac's Brief cuts them. Pure. */
export function phoneBrief(scan: HomeScanWire | null): Brief | null {
  if (!scan || !scan.text.trim()) return null;
  return { at: scan.ran_at ? new Date(scan.ran_at).toISOString() : `${scan.date}T08:00:00`, asked: "", sections: sectionsOf(scan.text), writing: false };
}

/** What the phone says when a click could not reach Home. Pure. */
export function clickNotSent(e: unknown): string {
  if (e instanceof Unreachable) return "The Mac is not answering — Home will not see that click yet. It is kept here.";
  if (e instanceof ApiError) return e.message;
  return "Could not tell Home — your click is kept here.";
}

export function phoneStageHost(d: PhoneStageDeps): StageHost {
  return {
    events: () => [],
    busy: () => false,
    brief: () => phoneBrief(d.scan()),
    scanWords: () => null,
    homeTasks: () => d.client().homeTasks(),
    taskEvent: async (task, view, line) => {
      try {
        await d.client().homeTaskEvent(task, view, line);
      } catch (e) {
        d.note(clickNotSent(e));
        throw e;
      }
    },
    taskClose: async (id) => {
      try {
        await d.client().homeTaskClose(id);
      } catch (e) {
        d.note(clickNotSent(e));
        throw e;
      }
    },
    focus: (view, task) => d.client().homeStageFocus(view, task),
    nudge: (text, fallback) => {
      // The short turn into Home's chat (846 §2, blocker 2143); a turn running there takes it as a queued message.
      // No Home chat yet, or the Mac not answering: the click is kept for Home's next look instead.
      const { chat, project } = d.home();
      if (!chat) return fallback();
      d.client()
        .send(chat, text, { project })
        .then(
          (st) => d.note(st === "queued" ? "Told Home — it reads it when the running turn ends" : "Told Home"),
          (e) => {
            d.note(clickNotSent(e));
            fallback();
          },
        );
    },
    noteNames: async () => {
      const p = d.home().project;
      return p ? (await d.client().notes("project", p).catch(() => [])).map((n) => n.name) : [];
    },
    saveNote: async (name, text) => {
      const p = d.home().project;
      if (!p) throw new Error("Home's project is not known on this host yet");
      await d.client().writeNote("project", name, text, p);
    },
    openChat: (chat, project) => d.open(chat, project),
    stopChat: async (chat) => {
      try {
        await d.client().cancel(chat);
      } catch (e) {
        d.note(e instanceof Unreachable ? "The Mac is not answering — the chat was not stopped." : clickNotSent(e));
        throw e;
      }
    },
    toast: (text) => d.note(text),
    liveBrowser: () => null,
    watchBrowser: () => {},
    BrowserView: null,
  };
}
