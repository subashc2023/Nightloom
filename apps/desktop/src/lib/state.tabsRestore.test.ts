import { describe, expect, it, vi } from "vitest";
import { app, asideStash, flushTabs, restoreTabs, type Aside } from "./state.svelte";
import * as tabs from "./tabs";
import type { TabContent } from "./tabs";
import { TABS_KEY } from "./tabsStore";

/**
 * The workspace across a quit, through the app's own save and restore
 * (nightshift backlog 201): an aside tab comes back on its thread though
 * thread ids are renumbered at every launch, a deleted chat's tab does
 * not, and a broken store opens the ordinary launch.
 */
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  openSession: vi.fn(async () => []),
  newSession: vi.fn(async () => ({ mode: "normal", kind: "build" })),
  listSessions: vi.fn(async () => []),
  transcript: vi.fn(async () => []),
}));

function thread(id: number, q: string): Aside {
  return {
    id,
    quote: null,
    draft: false,
    anchor: null,
    turns: [{ seq: -id, question: q, partial: "ok", answer: "ok", error: null, cancelled: false, cacheRead: 0 }],
  } as Aside;
}

function contents(): TabContent[][] {
  return app.tabs.panes.map((p) => p.tabs.map((t) => t.content));
}

describe("restoreTabs / flushTabs", () => {
  it("round-trips a split with an aside tab, mapping the thread across a relaunch", async () => {
    app.sessions = [{ id: "a" }, { id: "b" }] as typeof app.sessions;
    app.activeSessionId = null;
    asideStash.set("a", [thread(101, "first"), thread(102, "second")]);
    // Launch with nothing stored: the workspace stays, and is now owned.
    await restoreTabs({ show: false });

    const left = tabs.makePane([
      tabs.makeTab({ kind: "chat", session: "a" }),
      tabs.makeTab({ kind: "aside", session: "a", thread: 102 }),
    ]);
    left.active = left.tabs[1].id;
    const right = tabs.makePane([tabs.makeTab({ kind: "chat", session: "b" })]);
    app.tabs = { panes: [left, right], focused: left.id };
    flushTabs();
    expect(localStorage.getItem(TABS_KEY)).toContain('"thread":1');

    // The relaunch: the threads come back numbered afresh, and chat b was
    // deleted while the app was closed.
    asideStash.set("a", [thread(201, "first"), thread(202, "second")]);
    app.sessions = [{ id: "a" }] as typeof app.sessions;
    app.tabs = tabs.emptyWorkspace();
    await restoreTabs();

    expect(contents()).toEqual([[{ kind: "chat", session: "a" }, { kind: "aside", session: "a", thread: 202 }]]);
    const front = tabs.activeTab(tabs.focusedPane(app.tabs));
    expect(front.content).toEqual({ kind: "aside", session: "a", thread: 202 });
  });

  it("a malformed store costs the layout, never the launch", async () => {
    localStorage.setItem(TABS_KEY, "{not json");
    app.tabs = tabs.emptyWorkspace();
    await expect(restoreTabs()).resolves.toBeUndefined();
    expect(contents()).toEqual([[{ kind: "chat", session: null }]]);
  });
});
