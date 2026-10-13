import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "svelte/server";
import * as api from "./api";
import { app, closeTab } from "./state.svelte";
import * as tabs from "./tabs";
import { parseSaved, rebuild, snapshot } from "./tabsStore";
import { THREADS_CLOSED_KEY, fileSections, openingSection, threadNoteName } from "./thread";
import {
  editThreadFile,
  openThreadView,
  readThreadFile,
  resetThreadViews,
  setThreadPlace,
  threadList,
  threadPlace,
  threadRead,
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
  resetThreadViews();
  app.tabs = tabs.emptyWorkspace();
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

const threadTabs = () => tabs.allTabs(app.tabs).filter((t) => t.content.kind === "thread");

describe("the thread tab (blocker 1020: a tab, not a panel)", () => {
  it("the name opens a tab for the thread beside the front tab, focused", async () => {
    await openThreadView("stuart", "Stuart brainstorm");
    const pane = tabs.focusedPane(app.tabs);
    expect(pane.tabs.length).toBe(2);
    expect(tabs.activeTab(pane).content).toEqual({ kind: "thread", slug: "stuart", title: "Stuart brainstorm" });
    expect(tabs.tabTitle(tabs.activeTab(pane).content, [], [])).toBe("◇ Stuart brainstorm");
    expect(tabs.tabGlyph(tabs.activeTab(pane).content)).toBe("branch");
  });
  it("a second click focuses the open tab, in whichever pane, rather than opening another", async () => {
    await openThreadView("stuart", "Stuart brainstorm");
    const t = threadTabs()[0];
    expect(tabs.split(app.tabs, t.id, "right")).toBe(true);
    // Focus back on the chat's pane, then click the name again.
    const chatPane = app.tabs.panes.find((p) => !p.tabs.some((x) => x.id === t.id))!;
    app.tabs.focused = chatPane.id;
    await openThreadView("stuart", "Stuart brainstorm");
    expect(threadTabs().length).toBe(1);
    expect(tabs.focusedPane(app.tabs).active).toBe(t.id);
    await openThreadView("ace");
    expect(threadTabs().length).toBe(2);
  });
  it("is saved and restored with the layout (a split beside the chat survives)", async () => {
    await openThreadView("stuart", "Stuart brainstorm");
    tabs.split(app.tabs, threadTabs()[0].id, "right");
    const saved = parseSaved(JSON.parse(JSON.stringify(snapshot(app.tabs))))!;
    const back = rebuild(saved, (c) => c)!;
    const kinds = back.ws.panes.map((p) => p.tabs.map((t) => t.content.kind));
    expect(kinds).toEqual([["chat"], ["thread"]]);
    expect(tabs.parseContentDrag(JSON.stringify({ kind: "thread", slug: "../etc" }))).toBeNull();
    expect(tabs.sameContent({ kind: "thread", slug: "a", title: "A" }, { kind: "thread", slug: "a" })).toBe(true);
  });
  it("closes like any tab (⌘W is closeTab on the front tab)", async () => {
    await openThreadView("stuart");
    await closeTab();
    expect(threadTabs().length).toBe(0);
  });
  it("needs a project", async () => {
    app.project = null;
    await openThreadView("stuart");
    expect(threadTabs().length).toBe(0);
  });
});

describe("the thread view's store", () => {
  it("reads through the project's notes and keeps the last read", async () => {
    expect(threadRead("stuart", "thread.md")).toBeNull();
    await readThreadFile("stuart", "thread.md");
    expect(api.readNote).toHaveBeenCalledWith("project", "threads/stuart/thread.md");
    expect(threadRead("stuart", "thread.md")).toEqual({ text: THREAD_MD });
  });
  it("a missing archive.md is a sentence, not a throw", async () => {
    const r = await readThreadFile("stuart", "archive.md");
    expect(r).toEqual({ error: expect.stringMatching(/cannot read threads\/stuart\/archive\.md/) });
  });
  it("remembers the file and section per thread, Start here until chosen", () => {
    expect(threadPlace("stuart")).toEqual({ file: "thread.md", section: -1 });
    setThreadPlace("stuart", { section: 2 });
    setThreadPlace("stuart", { file: "log.md" });
    expect(threadPlace("stuart")).toEqual({ file: "log.md", section: 2 });
    expect(threadPlace("ace")).toEqual({ file: "thread.md", section: -1 });
  });
  it("Open in the editor is the note editor on the file shown", () => {
    editThreadFile("stuart", "thread.md");
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
  });
});

describe("the thread view (server-rendered)", () => {
  const view = (title?: string) =>
    render(ThreadView, { props: { content: title ? { kind: "thread", slug: "stuart", title } : { kind: "thread", slug: "stuart" } } }).body;
  it("thread.md opens on Start here: the section list, the files' switch, the actions", async () => {
    await readThreadFile("stuart", "thread.md");
    const html = view("Stuart brainstorm");
    expect(html).toContain("Stuart brainstorm");
    expect(html).toContain(".agents/threads/stuart/");
    for (const f of ["thread.md", "log.md", "archive.md"]) expect(html).toContain(`>${f}</button>`);
    for (const h of ["Start here", "Queue", "Claims", "His view", "How to edit"]) expect(html).toContain(h);
    expect(html).toContain("proxy stays small");
    expect(html).not.toContain("Size the replay set"); // the Queue is one click away, not shown
    expect(html).toContain("read-only");
    expect(html).toContain("Open in the editor");
    expect(html).toContain("+ New chat in this thread");
  });
  it("a chosen section is shown; log.md whole; a missing archive.md says so", async () => {
    await readThreadFile("stuart", "thread.md");
    setThreadPlace("stuart", { section: 2 });
    expect(view()).toContain("Size the replay set");
    await readThreadFile("stuart", "log.md");
    setThreadPlace("stuart", { file: "log.md" });
    expect(view()).toContain("round two");
    await readThreadFile("stuart", "archive.md");
    setThreadPlace("stuart", { file: "archive.md" });
    expect(view()).toContain("No archive.md yet");
  });
  it("before the first read lands it says it is reading", () => {
    expect(view()).toContain("Reading thread.md");
  });
});
