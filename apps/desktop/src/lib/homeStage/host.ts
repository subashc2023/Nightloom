/**
 * The stage's host (item 845, batch 3): what a view asks of the app it is drawn in. The Mac's window (`desktopHost.ts`,
 * Tauri commands and the app's own state) and the phone's Home page (`src/remote/phoneStageHost.ts`, the listener's
 * HTTP routes) each set one, so the same view components — Timeline, To-do, Triage, Browse, Run, Research, Brief —
 * draw on both without the phone's page pulling in the window's store. Nothing here calls a model.
 */
import type { Component } from "svelte";
import type { Brief } from "./brief";
import type { Ev } from "./steps";

/** One task on Home's stage, as Home's `update_task` wrote it (`data` is the view's own payload). */
export interface HomeTask {
  id: string;
  view: string;
  name: string;
  doing: string;
  step: number;
  of: number;
  state: "live" | "done" | string;
  needs: number;
  why: string;
  data: unknown;
  started_at: string;
  updated_at: string;
}

export interface StageHost {
  /** The Home chat's events, for Home's steps (read inside a derived, so a reactive store re-runs it). */
  events(): readonly Ev[];
  /** Home is running a turn now. */
  busy(): boolean;
  /** The newest morning brief, or null when there is none. */
  brief(): Brief | null;
  /** When the morning scan runs, in words ("Every day at 8:00 AM"), when known. */
  scanWords(): string | null;
  /** Item 947: today's scan was skipped (the feed row's reason and time); null when it ran or has not come. */
  skippedScan(): { why: string; at: string } | null;
  /** The tasks on the stage, oldest first. */
  homeTasks(): Promise<HomeTask[]>;
  /** One click of his Home reads at its next look (kind B). */
  taskEvent(task: string, view: string, line: string): Promise<unknown>;
  /** His × on a task's tab: the tab goes, the work is not stopped. */
  taskClose(id: string): Promise<unknown>;
  /** The view in focus, for the header on his next message to Home (846 §7 step 3). Best-effort. */
  focus(view: string, task: string): Promise<unknown>;
  /**
   * The short turn (846 §2, blocker 2143): send `text` into Home's chat now, as a message of his. When it cannot go
   * (no Home chat here, a turn running, no engine, the host not answering) `fallback` runs — the click is then kept
   * for Home's next look instead. Never both.
   */
  nudge(text: string, fallback: () => void): void;
  /** The names of Home's notes (so a kept page never takes one of his). */
  noteNames(): Promise<string[]>;
  /** Write a new note in Home's notes. */
  saveNote(name: string, text: string): Promise<unknown>;
  /** Open a chat (Run's Open chat). */
  openChat(chat: string, project: string | null): void;
  /** Stop the turn running in a chat now (Run's Stop now, item 872); what already landed stays. */
  stopChat(chat: string): Promise<unknown>;
  /** The chats a route of Home's is running now (the routes reply's `running`): Stop now stops only one of these. */
  routedRunning(): Promise<string[]>;
  /** A short notice. */
  toast(text: string): void;
  /** The chat whose app-owned browser is live now, or null (Browse's live picture; the Mac only). */
  liveBrowser(): string | null;
  /** Read the browser's status for the live check (called from an effect). */
  watchBrowser(): void;
  /** The live picture's component, where the host has one. */
  BrowserView: Component<{ session: string }> | null;
}

const none: StageHost = {
  events: () => [],
  busy: () => false,
  brief: () => null,
  scanWords: () => null,
  skippedScan: () => null,
  homeTasks: async () => [],
  taskEvent: async () => null,
  taskClose: async () => null,
  focus: async () => null,
  nudge: (_text, fallback) => fallback(),
  noteNames: async () => [],
  saveNote: async () => {
    throw new Error("Notes are not reachable here");
  },
  openChat: () => {},
  stopChat: async () => {
    throw new Error("Chats cannot be stopped from here");
  },
  routedRunning: async () => [],
  toast: () => {},
  liveBrowser: () => null,
  watchBrowser: () => {},
  BrowserView: null,
};

/** The host the views read; the Mac's Stage or the phone's Home page sets it before a view draws. */
export const stageHost: { now: StageHost } = { now: none };

export function setStageHost(h: StageHost): void {
  stageHost.now = h;
}
