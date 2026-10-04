import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "svelte/server";
import * as api from "./api";
import { app, chatSelected, newChatSelected, newSession, openSession, reflectTabs, threadSelected } from "./state.svelte";
import * as tabs from "./tabs";
import { openThreadView, resetThreadViews, threadList } from "./threadPanel.svelte";
import Sidebar from "./Sidebar.svelte";
import type { SessionMeta, ThreadInfo } from "./types";

// Nightshift backlog 297, his words: "If I'm on the Stuart 10 page and then
// I click onto Stuart Brainstorm like the thread into like the Start Here
// section and then I try to click back into Stuart 10, it doesn't do
// anything. And even though the page itself is Stuart Brainstorm, the
// highlighted section in the left bar is still Stuart 10." A thread tab
// (like an aside, file, subagent or attachment tab) changes nothing global,
// so the chat behind it stays `app.activeSessionId` with the view "chat":
// the sidebar's click opened what it thought was already in front, nothing
// changed, the tab reflection never ran, and the row's highlight read
// `activeSessionId` rather than the tab in front. The suite has no DOM: the
// sidebar click is `openSession` (its onclick, plus the App effect's
// `reflectTabs` when the open changed anything), the highlight the
// server-rendered markup.

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  openSession: vi.fn(async (id: string) => [
    { event: "session_created", at: "2026-01-01T00:00:00Z", kind: "build", mode: "normal" },
    { event: "user_message", at: "2026-01-01T00:00:00Z", text: `hello from ${id}` },
  ]),
  newSession: vi.fn(async () => ({ mode: "normal", kind: "build" })),
  readNote: vi.fn(async () => "# Thread: Stuart brainstorm\n\n## Start here\nx\n"),
  listThreads: vi.fn(async () => []),
  listSessions: vi.fn(async () => []),
  transcript: vi.fn(async () => []),
}));
vi.mock("./markdown", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./markdown")>()),
  renderMarkdown: (src: string) => `<div data-md>${src}</div>`,
}));

const project = { id: "p1", name: "Value Generalization", root: "/tmp/vg" } as unknown as typeof app.project;
const when = (m: number) => new Date(Date.UTC(2026, 9, 3, 12, m)).toISOString();
const chat = (id: string, title: string, m: number, thread?: string): SessionMeta =>
  ({ id, title, modified: when(m), mode: "normal", kind: "build", ...(thread ? { thread } : {}) }) as unknown as SessionMeta;
const info: ThreadInfo = {
  slug: "stuart-brainstorm",
  title: "Stuart brainstorm",
  status: "As of 2026-10-03 — status",
  touched: "2026-10-03",
  start_here_words: 10,
  tokens: 20,
  flags: 0,
};

/** The front tab of the focused pane, as the strip draws it selected. */
const front = () => tabs.activeTab(tabs.focusedPane(app.tabs)).content;
const kinds = () => app.tabs.panes.map((p) => p.tabs.map((t) => (t.content.kind === "chat" ? t.content.session ?? "new" : t.content.kind)));

/** What the App effect watches (`App.svelte`): it runs the reflection only
 *  when one of these changed, never on a click that changed nothing. */
const watched = () => JSON.stringify([app.view, app.activeSessionId, app.openNote]);
async function effect(change: () => Promise<void>): Promise<void> {
  const before = watched();
  await change();
  if (watched() !== before) reflectTabs();
}

/** The sidebar click on a chat row: its onclick, then the App effect. */
async function clickChat(id: string, meta = false): Promise<void> {
  if (meta) app.openNext = "new";
  await effect(() => openSession(id));
}

/** The rows the server-rendered sidebar draws selected. */
function highlighted(): { chats: string[]; threads: string[] } {
  const html = render(Sidebar).body.replace(/<!--[^>]*-->/g, "");
  const chats = [...html.matchAll(/<div class="session-item[^"]*\bactive\b[^"]*"[^>]*>[\s\S]*?<span class="snippet[^"]*">([^<]*)/g)].map((m) => m[1].trim());
  const threads = [...html.matchAll(/<div class="tg-head[^"]*\bactive\b[^"]*"[^>]*>[\s\S]*?tg-name[^"]*"><span[^>]*>◇<\/span> ([^<]*)/g)].map((m) => m[1].trim());
  return { chats, threads };
}

beforeEach(() => {
  resetThreadViews();
  localStorage.clear();
  app.tabs = tabs.emptyWorkspace();
  app.openNext = "replace";
  app.project = project;
  app.view = "chat";
  app.leftTab = "chats";
  app.openNote = null;
  app.busy = false;
  app.connecting = false;
  app.activeSessionId = null;
  app.events = [];
  app.background = {};
  app.parked = null;
  app.sessions = [chat("s10", "Stuart 10", 9, "stuart-brainstorm"), chat("s9", "Stuart 9", 8)];
  threadList.project = "p1";
  threadList.list = [info];
});

describe("backlog 297: a thread tab in front, then the chat behind it in the sidebar", () => {
  it("his sequence: Stuart 10, the thread's Start here, Stuart 10 again — the chat comes forward", async () => {
    await clickChat("s10");
    expect(front()).toEqual({ kind: "chat", session: "s10" });
    await openThreadView("stuart-brainstorm", "Stuart brainstorm");
    expect(front().kind).toBe("thread");
    // The highlight follows the tab in front: the thread's row, not Stuart 10.
    expect(chatSelected("s10")).toBe(false);
    expect(threadSelected("stuart-brainstorm")).toBe(true);
    expect(highlighted()).toEqual({ chats: [], threads: ["Stuart brainstorm"] });

    await clickChat("s10");
    expect(front()).toEqual({ kind: "chat", session: "s10" });
    // The chat's own tab came forward; the thread's tab stays open beside it.
    expect(kinds()).toEqual([["s10", "thread"]]);
    expect(chatSelected("s10")).toBe(true);
    expect(threadSelected("stuart-brainstorm")).toBe(false);
    expect(highlighted()).toEqual({ chats: ["Stuart 10"], threads: [] });
    expect(app.openNext).toBe("replace");
  });

  it("the chat's tab in the other pane is focused there, as the thread's own tab is", async () => {
    await clickChat("s10");
    await openThreadView("stuart-brainstorm", "Stuart brainstorm");
    const thread = tabs.activeTab(tabs.focusedPane(app.tabs));
    expect(tabs.split(app.tabs, thread.id, "right")).toBe(true);
    expect(kinds()).toEqual([["s10"], ["thread"]]);
    expect(tabs.focusedPane(app.tabs).active).toBe(thread.id);
    await clickChat("s10");
    expect(kinds()).toEqual([["s10"], ["thread"]]);
    expect(front()).toEqual({ kind: "chat", session: "s10" });
    expect(tabs.focusedPane(app.tabs)).toBe(app.tabs.panes[0]);
  });

  it("with no tab of the chat left, a click lands one (⌘ beside, else in place)", async () => {
    await clickChat("s10");
    await openThreadView("stuart-brainstorm", "Stuart brainstorm");
    const pane = tabs.focusedPane(app.tabs);
    pane.tabs = pane.tabs.filter((t) => t.content.kind === "thread");
    pane.active = pane.tabs[0].id;
    await clickChat("s10", true);
    expect(kinds()).toEqual([["thread", "s10"]]);
    expect(front()).toEqual({ kind: "chat", session: "s10" });
    expect(app.openNext).toBe("replace");
  });

  it("another chat from the thread tab still opens as before", async () => {
    await clickChat("s10");
    await openThreadView("stuart-brainstorm", "Stuart brainstorm");
    await clickChat("s9");
    expect(front()).toEqual({ kind: "chat", session: "s9" });
    expect(highlighted().chats).toEqual(["Stuart 9"]);
  });

  it("while a turn runs (the peek path), the chat behind the thread tab comes forward too", async () => {
    await clickChat("s10");
    await openThreadView("stuart-brainstorm", "Stuart brainstorm");
    app.busy = true;
    await clickChat("s10");
    expect(front()).toEqual({ kind: "chat", session: "s10" });
    app.busy = false;
  });

  it("New chat behind a thread tab: the button selected only when its tab is in front, and a click brings it forward", async () => {
    await effect(() => newSession());
    expect(newChatSelected()).toBe(true);
    await openThreadView("stuart-brainstorm", "Stuart brainstorm");
    expect(newChatSelected()).toBe(false);
    await effect(() => newSession());
    expect(front()).toEqual({ kind: "chat", session: null });
    expect(newChatSelected()).toBe(true);
  });

  it("any tab kind that changes nothing global behaves the same (a file tab)", async () => {
    await clickChat("s10");
    const pane = tabs.focusedPane(app.tabs);
    const file = tabs.makeTab({ kind: "file", path: "/tmp/vg/a.md" });
    pane.tabs.push(file);
    pane.active = file.id;
    expect(chatSelected("s10")).toBe(false);
    await clickChat("s10");
    expect(front()).toEqual({ kind: "chat", session: "s10" });
    expect(vi.mocked(api.openSession)).toHaveBeenCalled();
  });
});
