/**
 * Research threads, the pure half (nightshift backlog 271, step 1): the
 * picker's options, slugs, and the Start-here splice *Make this the file*
 * uses. The Rust twin of the slug rules is `thread.rs` (`valid_slug`,
 * `slug_from`); the two must agree, and the tests pin both to the same
 * cases.
 */
import type { ChatMode, SessionEvent, ThreadInfo } from "./types";
import type { SidebarRow } from "./forkTree";

/** A slug names a folder: lowercase letters, digits, `-` and `_`, starting
 *  with a letter or digit, at most 64 characters. Never a path. */
export function validSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(slug);
}

/** A slug from a name: lowercase, runs of anything else become one `-`. */
export function slugFrom(name: string): string {
  let out = "";
  for (const c of name.trim()) {
    if (/[A-Za-z0-9]/.test(c)) out += c.toLowerCase();
    else if (out !== "" && !out.endsWith("-")) out += "-";
  }
  return out.replace(/-+$/, "").slice(0, 64);
}

/** One row of the picker: a thread, "none", or "New thread…". */
export interface PickerOption {
  value: string;
  label: string;
  /** The line under the label: status and last touched. */
  detail: string;
}

/** The value "New thread…" carries; never a slug (slugs have no `:`). */
export const NEW_THREAD = ":new";
/** The value "No thread" carries. */
export const NO_THREAD = "";

/**
 * The picker's rows: none first, then the project's threads most recently
 * touched first (the backend's order), then *New thread…*. A bound slug
 * the project no longer has stays listed, marked, so the picker never
 * shows a binding it cannot name.
 */
export function pickerOptions(threads: ThreadInfo[], bound: string | null): PickerOption[] {
  const rows: PickerOption[] = [{ value: NO_THREAD, label: "No thread", detail: "wrap-up writes HANDOFF.md" }];
  for (const t of threads) {
    const when = t.touched ? `touched ${t.touched}` : "";
    const flags = t.flags > 0 ? `${t.flags} upkeep flag${t.flags === 1 ? "" : "s"}` : "";
    rows.push({
      value: t.slug,
      label: t.title === t.slug ? t.slug : `${t.title} (${t.slug})`,
      detail: [t.status, when, flags].filter((x) => x).join(" · "),
    });
  }
  if (bound && !threads.some((t) => t.slug === bound)) {
    rows.push({ value: bound, label: `${bound} (missing)`, detail: "no thread.md in this project" });
  }
  rows.push({ value: NEW_THREAD, label: "New thread…", detail: "from the project's template" });
  return rows;
}

/** The chat's thread, projected from the log: the latest live `thread`
 *  event, or null. `live` is the log's liveness flags (rewinds). */
export function threadOfEvents(events: SessionEvent[], live: boolean[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (!live[i]) continue;
    const e = events[i];
    if (e.event === "thread") return e.thread ?? null;
  }
  return null;
}

/**
 * `thread.md` with its `## Start here` body replaced by `body` — what
 * *Make this the file* puts in the editor as a draft (never a write). The
 * rest of the file is untouched; a file with no such section gets one at
 * its end. `## ` lines inside fences are not headings.
 */
export function replaceStartHere(file: string, body: string): string {
  const lines = file.split("\n");
  let fence = false;
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimStart();
    if (t.startsWith("```")) {
      fence = !fence;
      continue;
    }
    if (fence || !lines[i].startsWith("## ")) continue;
    if (start >= 0) {
      end = i;
      break;
    }
    if (lines[i].slice(3).trim().toLowerCase() === "start here") start = i + 1;
  }
  const block = body.trim().split("\n");
  if (start < 0) {
    return [...lines, "", "## Start here", ...block, ""].join("\n");
  }
  return [...lines.slice(0, start), ...block, "", ...lines.slice(end)].join("\n");
}

/**
 * The thread chip in the chat's top bar (nightshift backlog 281): what it
 * reads, or null when it is not drawn. Threads live in a project, so a
 * chat with no project open has no chip; an ephemeral chat has no log to
 * bind in. Bound, "◇ <slug>"; unbound, a dim "Thread".
 */
export interface ThreadChip {
  label: string;
  bound: boolean;
}
export function threadChip(bound: string | null, hasProject: boolean, mode: ChatMode): ThreadChip | null {
  if (!hasProject || mode === "ephemeral") return null;
  return bound ? { label: `◇ ${bound}`, bound: true } : { label: "Thread", bound: false };
}

// ---- threads in the sidebar (nightshift backlog 288) ----

/** One thread's group in the sidebar: its row, and the chats bound to it. */
export interface ThreadGroup {
  slug: string;
  /** The thread's name, the slug when it has none. */
  title: string;
  /** Its Start-here status line ("As of …"), empty when it has none. */
  status: string;
  /** A slug chats are bound to that the project has no thread.md for. */
  missing: boolean;
  /** Its chats' rows, in the list's order (newest first), forks under their origin. */
  rows: SidebarRow[];
  /** How many chats are bound to it (top-level rows). */
  chats: number;
  /** Its chats are shown. */
  open: boolean;
}

/** The key a thread's collapsed state is kept under: per project. */
export function threadKey(project: string, slug: string): string {
  return `${project}/${slug}`;
}

/** Where the sidebar keeps which thread groups are closed, across launches. */
export const THREADS_CLOSED_KEY = "nightloom.threadsClosed";

/**
 * The sidebar's rows split by thread: a group per thread of the project
 * (the backend's order, most recently touched first — empty ones too, so a
 * thread can be dropped onto and started from), then a group per slug a
 * chat is bound to that the project no longer has (marked missing, so a
 * binding never hides), and the unbound chats as before. A chat's forks
 * stay under it, in its group, whatever their own binding. A closed group
 * holding the open chat shows open, as a closed fork group does.
 */
export function threadGroups(
  rows: SidebarRow[],
  threads: ThreadInfo[],
  closed: ReadonlySet<string>,
  project: string,
  active: string | null = null,
): { groups: ThreadGroup[]; loose: SidebarRow[] } {
  const groups = new Map<string, ThreadGroup>();
  const group = (slug: string, info?: ThreadInfo): ThreadGroup => {
    let g = groups.get(slug);
    if (!g) {
      g = {
        slug,
        title: info?.title || slug,
        status: info?.status ?? "",
        missing: !info,
        rows: [],
        chats: 0,
        open: !closed.has(threadKey(project, slug)),
      };
      groups.set(slug, g);
    }
    return g;
  };
  for (const t of threads) group(t.slug, t);
  const loose: SidebarRow[] = [];
  let into: SidebarRow[] = loose;
  for (const r of rows) {
    if (r.depth === 0) {
      const slug = r.meta.thread;
      if (slug) {
        const g = group(slug, threads.find((t) => t.slug === slug));
        g.chats++;
        into = g.rows;
      } else {
        into = loose;
      }
    }
    into.push(r);
  }
  for (const g of groups.values()) {
    if (!g.open && active && g.rows.some((r) => r.meta.id === active)) g.open = true;
  }
  return { groups: [...groups.values()], loose };
}

/** The tooltip that says the two weights apart (backlog 288): this one is light. */
export function newInThreadTip(slug: string): string {
  return (
    `A new chat bound to ◇ ${slug}: its Start here loaded, the thread's read order in the box, unsent. ` +
    "No wrap-up runs — the chat you are in stays as it is. " +
    "To hand this chat's work over first, use Wrap up → Continue: a wrap-up turn updates the thread's files, then the next chat opens."
  );
}

// ---- what a thread stores, read in the sidebar's thread view (nightshift backlog 292) ----

/** The three files of a thread folder the view can show, in its switch's order. */
export const THREAD_FILES = ["thread.md", "log.md", "archive.md"] as const;
export type ThreadFile = (typeof THREAD_FILES)[number];

/** A thread file's path as a project note name (under `<project>/.agents/`). */
export function threadNoteName(slug: string, file: ThreadFile): string {
  return `threads/${slug}/${file}`;
}

/** One `## ` section of a file: its heading and the markdown under it. */
export interface FileSection {
  heading: string;
  body: string;
}

/**
 * A file split at its `## ` headings, in the file's order, for reading
 * one section at a time. What comes before the first heading (the
 * `# Thread: …` title and the pointer-form line) is a section headed
 * "About" when anything but the title is in it; the `# ` title line itself
 * is dropped, the view says the name. `## ` lines inside fences are not
 * headings (as `replaceStartHere`). A file with no headings is one
 * section, "Whole file". Empty sections are kept: an empty Queue is
 * information.
 */
export function fileSections(text: string): FileSection[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: FileSection[] = [];
  let heading: string | null = null;
  let body: string[] = [];
  let fence = false;
  const flush = () => {
    if (heading === null) {
      const pre = body.filter((l) => !/^# /.test(l)).join("\n").trim();
      if (pre) out.push({ heading: "About", body: pre });
    } else {
      out.push({ heading, body: body.join("\n").trim() });
    }
  };
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) fence = !fence;
    if (!fence && line.startsWith("## ")) {
      flush();
      heading = line.slice(3).trim();
      body = [];
      continue;
    }
    body.push(line);
  }
  flush();
  if (out.length === 1 && out[0].heading === "About") return [{ heading: "Whole file", body: out[0].body }];
  return out;
}

/** Which section thread.md opens on: Start here (the status), else the first.
 *  log.md and archive.md are not split: both are appended to, so the view
 *  shows each whole, scrolled to its newest end. */
export function openingSection(sections: FileSection[]): number {
  const i = sections.findIndex((s) => s.heading.toLowerCase() === "start here");
  return i >= 0 ? i : 0;
}
