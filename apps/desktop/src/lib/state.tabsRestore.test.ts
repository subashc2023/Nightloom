import { describe, expect, it, vi } from "vitest";
import { app, asideStash, closeNewProject, closeTab, flushTabs, restoreTabs, showNewProject, type Aside } from "./state.svelte";
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

  it("the New project tab, while open, comes back first after a restore (backlog 394)", async () => {
    localStorage.clear();
    app.sessions = [{ id: "a" }, { id: "b" }] as typeof app.sessions;
    app.activeSessionId = null;
    app.view = "chat";
    app.tabs = tabs.emptyWorkspace();
    await restoreTabs({ show: false });
    showNewProject();
    expect(app.newProjectOpen).toBe(true);
    // A plain click on a chat lands after the form, not over it.
    tabs.land(app.tabs, tabs.focusedPane(app.tabs), { kind: "chat", session: "a" }, "replace");
    flushTabs();
    expect(localStorage.getItem(TABS_KEY)).not.toContain("new-project");

    // A switch: another project's strip (here, the same key rebuilt).
    app.view = "chat";
    app.tabs = tabs.emptyWorkspace();
    await restoreTabs({ show: false, newProjectFront: false });
    expect(contents()[0][0]).toEqual({ kind: "new-project" });
    expect(tabs.activeTab(tabs.focusedPane(app.tabs)).content).toEqual({ kind: "chat", session: "a" });

    // In front when it was in front.
    app.tabs = tabs.emptyWorkspace();
    await restoreTabs({ show: false, newProjectFront: true });
    expect(tabs.activeTab(tabs.focusedPane(app.tabs)).content).toEqual({ kind: "new-project" });

    // Its × closes it, and the next restore leaves it out.
    const np = tabs.findAnywhere(app.tabs, { kind: "new-project" });
    await closeTab(np!.id);
    expect(app.newProjectOpen).toBe(false);
    app.tabs = tabs.emptyWorkspace();
    await restoreTabs({ show: false });
    expect(tabs.findAnywhere(app.tabs, { kind: "new-project" })).toBeUndefined();

    // Cancel from a tab not in front closes it too.
    showNewProject();
    tabs.land(app.tabs, tabs.focusedPane(app.tabs), { kind: "chat", session: "b" }, "replace");
    closeNewProject();
    await Promise.resolve();
    expect(app.newProjectOpen).toBe(false);
    expect(tabs.findAnywhere(app.tabs, { kind: "new-project" })).toBeUndefined();
  });
});
