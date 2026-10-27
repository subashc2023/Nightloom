import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { app } from "./state.svelte";
import * as tabs from "./tabs";
import { loadThreadOrder, orderedThreads, reordered, saveThreadOrder, THREAD_ORDER_KEY } from "./thread";
import { deleteThread, openThreadAs, renameThread, resetThreadViews, threadList } from "./threadPanel.svelte";
import type { SessionMeta, ThreadInfo } from "./types";

// Items 424 (a right-click menu for threads: open three ways, rename the
// title only, delete to the project's trash with its chats unbound) and
// 426 (drag threads to reorder; his order kept per project).

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  setSessionThread: vi.fn(async () => undefined),
  deleteThread: vi.fn(async (slug: string) => `/p/.agents/.trash/threads/${slug}-2026-10-27-101500`),
  renameThread: vi.fn(async (slug: string, name: string) => info(slug, name)),
  listThreads: vi.fn(async () => []),
  listSessions: vi.fn(async () => []),
}));

function info(slug: string, title = slug): ThreadInfo {
  return { slug, title, status: "", touched: "2026-10-27", start_here_words: 0, tokens: 0, flags: 0 };
}
const chat = (id: string, thread?: string): SessionMeta =>
  ({ id, title: id, modified: "2026-10-27T00:00:00Z", mode: "normal", kind: "build", ...(thread ? { thread } : {}) }) as unknown as SessionMeta;
const project = { id: "p1", name: "Stuart", root: "/p" } as unknown as typeof app.project;

describe("his order of the threads (426)", () => {
  const ts = ["a", "b", "c"].map((s) => info(s));
  it("is the backend's until he drags, then his, new threads first", () => {
    expect(orderedThreads(ts, undefined).map((t) => t.slug)).toEqual(["a", "b", "c"]);
    expect(orderedThreads(ts, []).map((t) => t.slug)).toEqual(["a", "b", "c"]);
    expect(orderedThreads(ts, ["c", "a", "b"]).map((t) => t.slug)).toEqual(["c", "a", "b"]);
    // "d" is new since his drag; "gone" was deleted.
    expect(orderedThreads([info("d"), ...ts], ["gone", "c", "a", "b"]).map((t) => t.slug)).toEqual(["d", "c", "a", "b"]);
  });
  it("moves one slug before another, or to the end", () => {
    expect(reordered(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(reordered(["a", "b", "c"], "a", "c")).toEqual(["b", "a", "c"]);
    expect(reordered(["a", "b", "c"], "a", null)).toEqual(["b", "c", "a"]);
    expect(reordered(["a", "b", "c"], "b", "b")).toEqual(["a", "b", "c"]);
    expect(reordered(["a", "b", "c"], "b", "c")).toEqual(["a", "b", "c"]);
  });
  it("is kept per project across launches", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    expect(loadThreadOrder("p1")).toBeUndefined();
    saveThreadOrder("p1", ["c", "a"]);
    saveThreadOrder("p2", ["x"]);
    expect(loadThreadOrder("p1")).toEqual(["c", "a"]);
    expect(loadThreadOrder("p2")).toEqual(["x"]);
    expect(JSON.parse(store.get(THREAD_ORDER_KEY)!)).toEqual({ p1: ["c", "a"], p2: ["x"] });
    store.set(THREAD_ORDER_KEY, "not json");
    expect(loadThreadOrder("p1")).toBeUndefined();
    vi.unstubAllGlobals();
  });
});

describe("the thread menu's actions (424)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetThreadViews();
    app.project = project;
    app.activeSessionId = null;
    app.events = [];
    app.busy = false;
    app.sessions = [chat("c1", "alpha"), chat("c2", "alpha"), chat("c3", "beta"), chat("c4")];
    app.tabs = tabs.emptyWorkspace();
    threadList.project = "p1";
    threadList.list = [info("alpha", "Alpha"), info("beta", "Beta")];
    // The re-read after an action answers what the backend now holds.
    vi.mocked(api.listThreads).mockImplementation(async () => [...threadList.list]);
  });
  afterEach(() => {
    app.project = null;
  });

  it("delete unbinds every bound chat first, then moves the folder, and closes its tab", async () => {
    await openThreadAs("alpha", "Alpha", "new");
    expect(tabs.allTabs(app.tabs).some((t) => t.content.kind === "thread" && t.content.slug === "alpha")).toBe(true);
    const order: string[] = [];
    vi.mocked(api.setSessionThread).mockImplementation(async (id, to) => void order.push(`unbind ${id} ${to}`));
    vi.mocked(api.deleteThread).mockImplementation(async (slug) => (order.push(`trash ${slug}`), "/p/.agents/.trash/threads/alpha-x"));
    expect(await deleteThread("alpha")).toBe(true);
    expect(order).toEqual(["unbind c1 null", "unbind c2 null", "trash alpha"]);
    // c3 (beta) and c4 (no thread) were never touched: the order above is every call.
    expect(threadList.list.map((t) => t.slug)).toEqual(["beta"]);
    expect(tabs.allTabs(app.tabs).some((t) => t.content.kind === "thread" && t.content.slug === "alpha")).toBe(false);
  });

  it("delete moves nothing when a bound chat cannot be unbound", async () => {
    vi.mocked(api.setSessionThread).mockRejectedValueOnce("that chat is running a turn — move it when the turn ends");
    expect(await deleteThread("alpha")).toBe(false);
    expect(api.deleteThread).not.toHaveBeenCalled();
    expect(threadList.list.map((t) => t.slug)).toEqual(["alpha", "beta"]);
  });

  it("rename changes the title in the list and the open tab; the slug stays", async () => {
    await openThreadAs("beta", "Beta", "new");
    expect(await renameThread("beta", "Beta, renamed")).toBe(true);
    expect(api.renameThread).toHaveBeenCalledWith("beta", "Beta, renamed");
    expect(threadList.list.find((t) => t.slug === "beta")?.title).toBe("Beta, renamed");
    const tab = tabs.allTabs(app.tabs).find((t) => t.content.kind === "thread" && t.content.slug === "beta");
    expect(tab?.content).toEqual({ kind: "thread", slug: "beta", title: "Beta, renamed" });
    expect(api.setSessionThread).not.toHaveBeenCalled();
  });

  it("open beside puts the thread in a second pane", async () => {
    const before = app.tabs.panes.length;
    await openThreadAs("beta", "Beta", "beside");
    expect(app.tabs.panes.length).toBe(Math.max(2, before));
    const pane = tabs.focusedPane(app.tabs);
    expect(tabs.activeTab(pane).content).toEqual({ kind: "thread", slug: "beta", title: "Beta" });
  });
});
