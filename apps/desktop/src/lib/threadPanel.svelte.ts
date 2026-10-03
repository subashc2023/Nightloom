/**
 * The thread view (nightshift backlog 292): a thread's name clicked in the
 * sidebar opens a panel that reads what the thread stores — `thread.md` a
 * section at a time (Start here first), `log.md` and `archive.md` whole.
 * Read-only: the files are read through the note commands
 * (`.agents/threads/<slug>/…` in the open project), and the one way to
 * change one is the note editor ("Edit thread.md"), which has its own
 * drafts. Panel rather than tab: blocker 1020.
 *
 * Also the project's thread listing the sidebar groups by, kept here with
 * the project it was read for, so a listing that lands after a project
 * switch is never shown under the wrong project.
 */
import * as api from "./api";
import { app, showNote } from "./state.svelte";
import { fileSections, openingSection, threadNoteName, type FileSection, type ThreadFile } from "./thread";
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

export interface ThreadViewState {
  project: string;
  slug: string;
  title: string;
  file: ThreadFile;
  /** The file's text; null while it loads or when it could not be read. */
  text: string | null;
  /** Why it could not be read (a missing log.md or archive.md is normal). */
  error: string | null;
  /** thread.md's sections, and the one shown. */
  sections: FileSection[];
  section: number;
}

export const threadView = $state<{ open: ThreadViewState | null }>({ open: null });

// A read that lands after the view moved on (another file, another thread,
// closed) is dropped.
let reading = 0;

/** Open the view on a thread, at thread.md's Start here. Needs a project. */
export async function openThreadView(slug: string, title: string = slug): Promise<void> {
  const project = app.project?.id;
  if (!project) return;
  threadView.open = { project, slug, title, file: "thread.md", text: null, error: null, sections: [], section: 0 };
  await showThreadFile("thread.md");
}

/** Switch the open view to one of the thread's files. */
export async function showThreadFile(file: ThreadFile): Promise<void> {
  const v = threadView.open;
  if (!v) return;
  const n = ++reading;
  v.file = file;
  v.text = null;
  v.error = null;
  v.sections = [];
  v.section = 0;
  let text: string;
  try {
    text = await api.readNote("project", threadNoteName(v.slug, file));
  } catch (e) {
    if (n !== reading || threadView.open !== v) return;
    v.error = String(e);
    return;
  }
  if (n !== reading || threadView.open !== v) return;
  v.text = text;
  if (file === "thread.md") {
    v.sections = fileSections(text);
    v.section = openingSection(v.sections);
  }
}

export function showThreadSection(i: number): void {
  const v = threadView.open;
  if (v && i >= 0 && i < v.sections.length) v.section = i;
}

export function closeThreadView(): void {
  reading++;
  threadView.open = null;
}

/** The existing edit path: the note editor on the file shown, as a tab. */
export function editThreadFile(): void {
  const v = threadView.open;
  if (!v) return;
  const name = threadNoteName(v.slug, v.file);
  closeThreadView();
  showNote("project", name);
}
