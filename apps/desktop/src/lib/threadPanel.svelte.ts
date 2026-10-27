/**
 * The thread view (nightshift backlog 292): a thread's name clicked in the
 * sidebar opens a tab that reads what the thread stores — `thread.md` a
 * section at a time (Start here first), `log.md` and `archive.md` whole.
 * ~~A panel over the window~~ (2026-10-03: a tab, his answer to blocker
 * 1020 — so it can sit in a pane beside the chat). Read-only: the files
 * are read through the note commands (`.agents/threads/<slug>/…` in the
 * open project), and the one way to change one is the note editor ("Open
 * in the editor"), which has its own drafts.
 *
 * Also the project's thread listing the sidebar groups by, kept here with
 * the project it was read for, so a listing that lands after a project
 * switch is never shown under the wrong project.
 */
import * as api from "./api";
import * as tabs from "./tabs";
import { activateTab, addToast, app, chatThread, moveChatToThread, openContent, showNote } from "./state.svelte";
import { threadNoteName, type ThreadFile } from "./thread";
import type { ThreadInfo } from "./types";

/** The open project's threads, most recently touched first, and which project they are. */
export const threadList = $state<{ project: string; list: ThreadInfo[] }>({ project: "", list: [] });

/** Re-read the open project's threads into `threadList`. Best-effort. */
export async function refreshThreadList(): Promise<void> {
  const project = app.project?.id ?? "";
  if (!project) return;
  try {
    const list = await api.listThreads();
    if ((app.project?.id ?? "") !== project) return;
    threadList.project = project;
    threadList.list = list;
  } catch {
    // No threads folder, or the project closed meanwhile: the groups stay as they were.
  }
}

/** Where a thread's tab was left — which file, which thread.md section —
 *  so switching tabs (which remounts the view) comes back to it. Per
 *  project and slug; a section of -1 means "not chosen": Start here. */
export interface ThreadPlace {
  file: ThreadFile;
  section: number;
}
const places = $state<Record<string, ThreadPlace>>({});

function placeKey(slug: string): string {
  return `${app.project?.id ?? ""}/${slug}`;
}

export function threadPlace(slug: string): ThreadPlace {
  return places[placeKey(slug)] ?? { file: "thread.md", section: -1 };
}

export function setThreadPlace(slug: string, place: Partial<ThreadPlace>): void {
  const k = placeKey(slug);
  places[k] = { ...(places[k] ?? { file: "thread.md", section: -1 }), ...place };
}

/** One file of a thread, as text, or why it could not be read (a missing
 *  log.md or archive.md is normal). */
export type ThreadRead = { text: string } | { error: string };

// The last read of each file, per project, slug and file: what a tab shows
// at once when it is brought back (a tab switch remounts the view), while
// the read it starts brings it up to date.
const reads = $state<Record<string, ThreadRead>>({});

function readKey(slug: string, file: ThreadFile): string {
  return `${placeKey(slug)}/${file}`;
}

/** The last read of a thread's file, or null before the first lands. */
export function threadRead(slug: string, file: ThreadFile): ThreadRead | null {
  return reads[readKey(slug, file)] ?? null;
}

/** Read a thread's file now (through the project notes) and keep the answer. */
export async function readThreadFile(slug: string, file: ThreadFile): Promise<ThreadRead> {
  const key = readKey(slug, file);
  let r: ThreadRead;
  try {
    r = { text: await api.readNote("project", threadNoteName(slug, file)) };
  } catch (e) {
    r = { error: String(e) };
  }
  reads[key] = r;
  return r;
}

/**
 * Open the thread's tab: the one already open for it, in whichever pane,
 * is brought forward; otherwise a new tab beside the focused pane's front
 * one. Needs a project (threads live in one).
 */
export async function openThreadView(slug: string, title: string = slug): Promise<void> {
  if (!app.project) return;
  const content: tabs.TabContent = title && title !== slug ? { kind: "thread", slug, title } : { kind: "thread", slug };
  const open = tabs.findAnywhere(app.tabs, content);
  if (open) {
    await activateTab(open.id);
    return;
  }
  await openContent(content, "new");
}

/**
 * The thread menu's three opens (nightshift backlog 424), as a chat row's:
 * `replace` is the name's click (the tab already open for it, else a new
 * one); `new` a tab after the focused pane's front one (the one already in
 * that pane comes forward); `beside` the other pane, made when there is one.
 */
export async function openThreadAs(slug: string, title: string, how: "replace" | "new" | "beside"): Promise<void> {
  if (!app.project) return;
  if (how === "replace") return openThreadView(slug, title);
  const content: tabs.TabContent = title && title !== slug ? { kind: "thread", slug, title } : { kind: "thread", slug };
  const t = how === "beside" ? tabs.openBeside(app.tabs, content, "new") : tabs.land(app.tabs, tabs.focusedPane(app.tabs), content, "new");
  await activateTab(t.id);
}

/**
 * Rename a thread (backlog 424; his go 2026-10-27: the title only). The
 * heading in its `thread.md` changes; the slug and folder stay, so the
 * chats bound to it still find it. The listing and the thread's open tabs
 * take the new name at once. False, with a toast, when refused.
 */
export async function renameThread(slug: string, name: string): Promise<boolean> {
  let info: ThreadInfo;
  try {
    info = await api.renameThread(slug, name);
  } catch (e) {
    addToast(String(e));
    return false;
  }
  const i = threadList.list.findIndex((t) => t.slug === slug);
  if (i >= 0) threadList.list[i] = info;
  for (const t of tabs.allTabs(app.tabs)) {
    if (t.content.kind === "thread" && t.content.slug === slug) t.content = { kind: "thread", slug, title: info.title };
  }
  void refreshThreadList();
  return true;
}

/**
 * Delete a thread (backlog 424). Its chats are unbound first — each becomes
 * "Not in a thread", its messages untouched (the same `thread` line the
 * picker writes); if one cannot be (it is running a turn), nothing is
 * deleted and the toast says why. Then the folder moves to the project's
 * `.agents/.trash/threads/`, never unlinked, and the thread's tabs close.
 */
export async function deleteThread(slug: string): Promise<boolean> {
  const bound = app.sessions.filter((s) => s.thread === slug).map((s) => s.id);
  if (app.activeSessionId && !bound.includes(app.activeSessionId) && chatThread(app.events) === slug) {
    bound.push(app.activeSessionId);
  }
  for (const id of bound) {
    if (!(await moveChatToThread(id, null))) return false;
  }
  let where: string;
  try {
    where = await api.deleteThread(slug);
  } catch (e) {
    addToast(String(e));
    return false;
  }
  for (const t of tabs.allTabs(app.tabs).filter((t) => t.content.kind === "thread" && t.content.slug === slug)) {
    const r = tabs.close(app.tabs, t.id);
    if (r.show) void activateTab(r.show.id);
  }
  threadList.list = threadList.list.filter((t) => t.slug !== slug);
  void refreshThreadList();
  const n = bound.length;
  addToast(`Deleted the thread ${slug}${n ? ` — ${n} chat${n === 1 ? "" : "s"} now in no thread` : ""}; its folder is in ${where}`);
  return true;
}

/** Show the thread's folder in Finder, selected (backlog 424). */
export async function revealThread(slug: string): Promise<void> {
  try {
    await api.revealThread(slug);
  } catch (e) {
    addToast(String(e));
  }
}

/** The existing edit path: the note editor on one of the thread's files, as a note tab. */
export function editThreadFile(slug: string, file: ThreadFile): void {
  showNote("project", threadNoteName(slug, file));
}

/** Forget every remembered place and read — for the suite, between tests. */
export function resetThreadViews(): void {
  for (const k of Object.keys(places)) delete places[k];
  for (const k of Object.keys(reads)) delete reads[k];
}
