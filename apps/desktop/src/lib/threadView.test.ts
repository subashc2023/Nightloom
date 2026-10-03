import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "svelte/server";
import * as api from "./api";
import { app } from "./state.svelte";
import { THREADS_CLOSED_KEY, fileSections, openingSection, threadNoteName } from "./thread";
import {
  closeThreadView,
  editThreadFile,
  openThreadView,
  showThreadFile,
  showThreadSection,
  threadList,
  threadView,
} from "./threadPanel.svelte";
import Sidebar from "./Sidebar.svelte";
import ThreadView from "./ThreadView.svelte";
import type { SessionMeta, ThreadInfo } from "./types";
import sidebarSource from "./Sidebar.svelte?raw";

// Nightshift backlog 292: "Threads" over the thread groups and "Not in a
// thread" over the rest; the thread's name opens a view of what it stores
// (thread.md by section, log.md and archive.md whole); the chevron still
// folds. The suite has no DOM: the sidebar and the view are rendered with
// Svelte's server renderer (markup, no clicks), the click paths are the
// store's functions, and the wiring between them is a source check. Real
// clicks are in the WebKit harness (`harness/threads292.ts`).

const THREAD_MD = `# Thread: Stuart brainstorm

Pointer form: \`<chat id> ev <n> ¶<k>\` = chat, event index, paragraph.

## Start here
As of 2026-10-03, 11:40 AM — proxy stays small.

## Queue
| id | Item | Status | Pointer |
|---|---|---|---|
| Q-1 | Size the replay set | live | c1 ev 4 |

## Claims
\`\`\`
## not a heading
\`\`\`

## His view

## How to edit
- One writer.
`;

const files: Record<string, string> = {
  "threads/stuart/thread.md": THREAD_MD,
  "threads/stuart/log.md": "# Log: Stuart\n\n2026-10-02 — round one.\n\n2026-10-03 — round two.\n",
};

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  readNote: vi.fn(async (_scope: string, name: string) => {
    if (name in files) return files[name];
    throw new Error(`cannot read ${name}: No such file or directory`);
  }),
  listThreads: vi.fn(async () => []),
}));
// DOMPurify needs a window; the markup around the markdown is what is tested.
vi.mock("./markdown", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./markdown")>()),
  renderMarkdown: (src: string) => `<div data-md>${src}</div>`,
}));

const project = { id: "p1", name: "Value Generalization", root: "/tmp/vg" } as unknown as typeof app.project;
const when = (m: number) => new Date(Date.UTC(2026, 9, 3, 12, m)).toISOString();
const chat = (id: string, m: number, thread?: string): SessionMeta =>
  ({ id, title: `chat ${id}`, modified: when(m), mode: "normal", kind: "build", ...(thread ? { thread } : {}) }) as unknown as SessionMeta;
const info = (slug: string, title: string): ThreadInfo => ({
  slug,
  title,
  status: `As of 2026-10-03 — ${slug} status`,
  touched: "2026-10-03",
  start_here_words: 10,
  tokens: 20,
  flags: 0,
});

beforeEach(() => {
  closeThreadView();
  localStorage.clear();
  app.project = project;
  app.view = "chat";
  app.leftTab = "chats";
  app.openNote = null;
  app.busy = false;
  app.connecting = false;
  app.activeSessionId = null;
  app.sessions = [chat("s1", 9, "stuart"), chat("l1", 8), chat("a1", 7, "ace")];
  threadList.project = "p1";
  threadList.list = [info("stuart", "Stuart brainstorm"), info("ace", "ACE extrapolation")];
  vi.mocked(api.readNote).mockClear();
});

describe("fileSections", () => {
  it("splits thread.md at its ## headings, in order, fences kept whole", () => {
    const s = fileSections(THREAD_MD);
    expect(s.map((x) => x.heading)).toEqual(["About", "Start here", "Queue", "Claims", "His view", "How to edit"]);
    expect(s[0].body).toMatch(/^Pointer form/);
    expect(s[0].body).not.toMatch(/# Thread/);
    expect(s[1].body).toBe("As of 2026-10-03, 11:40 AM — proxy stays small.");
    expect(s[3].body).toContain("## not a heading");
    expect(s[4].body).toBe("");
    expect(openingSection(s)).toBe(1);
  });
  it("a file with no headings is one section; one with no Start here opens on its first", () => {
    expect(fileSections("# Log\n\nentry one\n")).toEqual([{ heading: "Whole file", body: "entry one" }]);
    expect(fileSections("## Queue\nx\n").map((x) => x.heading)).toEqual(["Queue"]);
    expect(openingSection(fileSections("## Queue\nx\n"))).toBe(0);
    expect(threadNoteName("stuart", "log.md")).toBe("threads/stuart/log.md");
  });
});

describe("the thread view's store", () => {
  it("opens on thread.md's Start here, read through the project's notes", async () => {
    await openThreadView("stuart", "Stuart brainstorm");
    expect(api.readNote).toHaveBeenCalledWith("project", "threads/stuart/thread.md");
    const v = threadView.open!;
    expect(v.title).toBe("Stuart brainstorm");
    expect(v.file).toBe("thread.md");
    expect(v.sections[v.section].heading).toBe("Start here");
    showThreadSection(2);
    expect(threadView.open!.sections[threadView.open!.section].heading).toBe("Queue");
    showThreadSection(99);
    expect(threadView.open!.section).toBe(2);
  });
  it("log.md is shown whole; a missing archive.md is a sentence, not a throw", async () => {
    await openThreadView("stuart");
    await showThreadFile("log.md");
    expect(threadView.open!.text).toContain("round two");
    expect(threadView.open!.sections).toEqual([]);
    await showThreadFile("archive.md");
    expect(threadView.open!.text).toBeNull();
    expect(threadView.open!.error).toMatch(/cannot read threads\/stuart\/archive\.md/);
  });
  it("a read that lands after the view closed is dropped", async () => {
    const p = openThreadView("stuart");
    closeThreadView();
    await p;
    expect(threadView.open).toBeNull();
  });
  it("needs a project", async () => {
    app.project = null;
    await openThreadView("stuart");
    expect(threadView.open).toBeNull();
    expect(api.readNote).not.toHaveBeenCalled();
  });
  it("Open in the editor is the note editor on the file shown, and closes the view", async () => {
    await openThreadView("stuart");
    editThreadFile();
    expect(threadView.open).toBeNull();
    expect(app.view).toBe("note");
    expect(app.openNote).toEqual({ scope: "project", name: "threads/stuart/thread.md" });
  });
});

describe("the sidebar's sections (server-rendered)", () => {
  const text = (html: string) => html.replace(/<!--[^>]*-->/g, "");
  it("a 'Threads' heading over the groups and a 'Not in a thread' heading over the rest", () => {
    const html = text(render(Sidebar).body);
    const threads = html.indexOf(">Threads<");
    const firstGroup = html.indexOf('aria-label="Thread Stuart brainstorm"');
    const notIn = html.indexOf(">Not in a thread<");
    const loose = html.indexOf("chat l1");
    expect(threads).toBeGreaterThan(-1);
    expect(threads).toBeLessThan(firstGroup);
    expect(firstGroup).toBeLessThan(notIn);
    expect(notIn).toBeLessThan(loose);
    expect(html).toMatch(/role="heading" aria-level="3"[^>]*>Threads</);
    // Every thread chat is under its group, before the heading.
    expect(html.indexOf("chat s1")).toBeLessThan(notIn);
    expect(html.indexOf("chat a1")).toBeLessThan(notIn);
  });
  it("with every chat in a thread, the heading stays and says where to drop", () => {
    app.sessions = [chat("s1", 9, "stuart")];
    const html = text(render(Sidebar).body);
    expect(html).toContain(">Not in a thread<");
    expect(html).toContain("Drop a chat here to take it out of its thread");
  });
  it("no headings when the project has no threads and no bound chats, or there is no project", () => {
    app.sessions = [chat("l1", 8)];
    threadList.list = [];
    expect(text(render(Sidebar).body)).not.toContain(">Threads<");
    app.project = null;
    expect(text(render(Sidebar).body)).not.toContain("Not in a thread");
  });
  it("a listing read for another project is not shown", () => {
    app.sessions = [chat("l1", 8)];
    threadList.project = "p2";
    expect(text(render(Sidebar).body)).not.toContain(">Threads<");
  });
  it("the chevron and the name are two buttons; the name button holds no chevron", () => {
    const html = text(render(Sidebar).body);
    const head = html.slice(html.indexOf('class="tg-head'), html.indexOf('class="tg-rows'));
    const toggle = head.match(/<button[^>]*class="tg-toggle[^"]*"[^>]*>([\s\S]*?)<\/button>/)!;
    const open = head.match(/<button[^>]*class="tg-open[^"]*"[^>]*>([\s\S]*?)<\/button>/)!;
    expect(toggle[0]).toContain('aria-expanded="true"');
    expect(toggle[1]).toContain("tg-chev");
    expect(toggle[1]).not.toContain("Stuart brainstorm");
    expect(open[1]).toContain("Stuart brainstorm");
    expect(open[1]).not.toContain("tg-chev");
  });
  it("a folded group (the chevron's state) hides its chats and keeps the other open", () => {
    localStorage.setItem(THREADS_CLOSED_KEY, JSON.stringify(["p1/stuart"]));
    const html = text(render(Sidebar).body);
    expect(html).not.toContain("chat s1");
    expect(html).toContain("chat a1");
    expect(html).toMatch(/class="tg-toggle[^"]*"[^>]*aria-expanded="false"/);
  });
  it("wiring: the chevron folds (toggleThread), the name opens the view (openThreadView)", () => {
    expect(sidebarSource).toMatch(/class="tg-toggle"[\s\S]{0,400}onclick=\{\(\) => toggleThread\(g\.slug\)\}/);
    expect(sidebarSource).toMatch(/class="tg-open"[\s\S]{0,500}openThreadView\(g\.slug, g\.title\)/);
    expect(sidebarSource).toContain("<ThreadView />");
  });
});

describe("the thread view (server-rendered)", () => {
  it("shows the section list and Start here, with the files' switch", async () => {
    await openThreadView("stuart", "Stuart brainstorm");
    const html = render(ThreadView).body;
    expect(html).toContain("Stuart brainstorm");
    expect(html).toContain(".agents/threads/stuart/");
    for (const f of ["thread.md", "log.md", "archive.md"]) expect(html).toContain(`>${f}</button>`);
    for (const h of ["Start here", "Queue", "Claims", "His view", "How to edit"]) expect(html).toContain(h);
    expect(html).toContain("proxy stays small");
    expect(html).not.toContain("Size the replay set"); // the Queue is one click away, not shown
    expect(html).toContain("read-only");
    expect(html).toContain("Open in the editor");
  });
  it("a missing archive.md says so", async () => {
    await openThreadView("stuart");
    await showThreadFile("archive.md");
    expect(render(ThreadView).body).toContain("No archive.md yet");
  });
  it("draws nothing when closed", () => {
    expect(render(ThreadView).body.replace(/<!--[^>]*-->/g, "").trim()).toBe("");
  });
});
