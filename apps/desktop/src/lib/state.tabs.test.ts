import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateTab,
  app,
  asideInTab,
  closeNote,
  closeTab,
  dropContent,
  focusPane,
  newTab,
  openContent,
  openSession,
  reflectTabs,
  remoteSend,
  showGraph,
  showNightshift,
  showNote,
  splitTab,
  stepTab,
} from "./state.svelte";
import * as tabs from "./tabs";
import * as api from "./api";
import { drafts, readDraft } from "./drafts.svelte";

/**
 * The glue between the tab model and the one open chat (nightshift backlog
 * 099): reflection lands what the centre shows in a tab, activation opens
 * a tab's content. The backend is two commands: open a chat (its events),
 * and New chat.
 */
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  openSession: vi.fn(async (id: string) => [
    {
      event: "session_created",
      at: "2026-01-01T00:00:00Z",
      kind: "build",
      mode: "normal",
    },
    {
      event: "user_message",
      at: "2026-01-01T00:00:00Z",
      text: `hello from ${id}`,
    },
  ]),
  newSession: vi.fn(async () => ({ mode: "normal", kind: "build" })),
  peekSession: vi.fn(async (id: string) => [
    { event: "user_message", at: "2026-01-01T00:00:00Z", text: `peeked ${id}` },
  ]),
  listSessions: vi.fn(async () => []),
  transcript: vi.fn(async () => []),
}));

function label(c: tabs.TabContent): string {
  switch (c.kind) {
    case "chat":
      return c.session ?? "new";
    case "note":
      return c.name;
    case "project":
      return `project:${c.id}`;
    case "aside":
      return `aside:${c.session}`;
    default:
      return c.kind;
  }
}
const chats = (ws: tabs.Workspace) =>
  ws.panes.map((p) => p.tabs.map((t) => label(t.content)));
const front = () => label(tabs.activeTab(tabs.focusedPane(app.tabs)).content);

beforeEach(() => {
  app.tabs = tabs.emptyWorkspace();
  app.openNext = "replace";
  app.activeSessionId = null;
  app.events = [];
  app.view = "chat";
  app.openNote = null;
  app.busy = false;
  app.toasts = [];
});

describe("reflection", () => {
  it("a chat opened plainly replaces the active tab", async () => {
    await openSession("a");
    reflectTabs();
    expect(chats(app.tabs)).toEqual([["a"]]);
    await openSession("b");
    reflectTabs();
    expect(chats(app.tabs)).toEqual([["b"]]);
  });

  it("⌘-click opens a new tab beside the active one, once", async () => {
    await openSession("a");
    reflectTabs();
    app.openNext = "new";
    await openSession("b");
    reflectTabs();
    expect(chats(app.tabs)).toEqual([["a", "b"]]);
    expect(app.openNext).toBe("replace");
    await openSession("c");
    reflectTabs();
    expect(chats(app.tabs)).toEqual([["a", "c"]]);
  });

  it("a note shown lands as a note tab; the chat stays open underneath", async () => {
    await openSession("a");
    reflectTabs();
    app.openNext = "new";
    showNote("project", "plan.md");
    reflectTabs();
    expect(chats(app.tabs)).toEqual([["a", "plan.md"]]);
    expect(app.activeSessionId).toBe("a");
    expect(app.view).toBe("note");
  });

  // Review E, 2026-09-17: the reflection runs only on a change, so an open
  // that changes nothing must hand the modifier back itself, or the next
  // plain click opens a tab it was not asked for.
  it("⌘-click on the chat in front, or a failed open, hands the modifier back", async () => {
    await openSession("a");
    reflectTabs();
    app.openNext = "new";
    await openSession("a");
    expect(app.openNext).toBe("replace");
    await openSession("b");
    reflectTabs();
    expect(chats(app.tabs)).toEqual([["b"]]);

    app.openNext = "new";
    vi.mocked(api.openSession).mockRejectedValueOnce(new Error("no such chat"));
    await openSession("c");
    expect(app.error).toContain("no such chat");
    expect(app.openNext).toBe("replace");
    app.error = null;
    await openSession("d");
    reflectTabs();
    expect(chats(app.tabs)).toEqual([["d"]]);
  });

  // ~~the graph and Nightshift are not tabs and change nothing~~ —
  // backlog 140 (2026-09-17): tabs sit above everything.
  it("the graph, Nightshift and the New project form are tabs; a plain click replaces", async () => {
    await openSession("a");
    reflectTabs();
    showGraph();
    expect(chats(app.tabs)).toEqual([["graph"]]);
    app.openNext = "new";
    showNightshift();
    expect(chats(app.tabs)).toEqual([["graph", "nightshift"]]);
    expect(front()).toBe("nightshift");
    // The chat row again: replaces the Nightshift tab, the graph stays.
    await openSession("a");
    reflectTabs();
    expect(chats(app.tabs)).toEqual([["graph", "a"]]);
  });

  it("one Nightshift tab at most: a second click focuses it, in the other pane too", async () => {
    await openSession("a");
    reflectTabs();
    app.openNext = "new";
    showNightshift();
    app.openNext = "new";
    await openSession("b");
    reflectTabs();
    expect(chats(app.tabs)).toEqual([["a", "nightshift", "b"]]);
    await splitTab(app.tabs.panes[0].tabs[2].id, "right");
    expect(chats(app.tabs)).toEqual([["a", "nightshift"], ["b"]]);
    expect(app.tabs.focused).toBe(app.tabs.panes[1].id);
    // From the right pane, the sidebar's Nightshift: the left pane's tab.
    showNightshift();
    expect(chats(app.tabs)).toEqual([["a", "nightshift"], ["b"]]);
    expect(app.tabs.focused).toBe(app.tabs.panes[0].id);
    expect(front()).toBe("nightshift");
    // And again, with the view already Nightshift but the right pane
    // focused (a mousedown there): the click still lands — dead before.
    focusPane(app.tabs.panes[1].id);
    expect(app.view).toBe("chat");
    app.view = "nightshift";
    showNightshift();
    expect(app.tabs.focused).toBe(app.tabs.panes[0].id);
    expect(chats(app.tabs)).toEqual([["a", "nightshift"], ["b"]]);
  });
});

describe("activation", () => {
  it("opens the tab's chat, and another chat while a turn runs as a view with the running chat parked", async () => {
    await openSession("a");
    reflectTabs();
    app.openNext = "new";
    await openSession("b");
    reflectTabs();
    const [ta] = app.tabs.panes[0].tabs;
    await activateTab(ta.id);
    expect(app.activeSessionId).toBe("a");
    expect(app.tabs.panes[0].active).toBe(ta.id);
    const tb = app.tabs.panes[0].tabs[1];
    // ~~refused with the toast~~ — since backlog 159 the chat opens as a
    // view read from disk and the running chat ("a") is parked.
    app.busy = true;
    await activateTab(tb.id);
    expect(app.activeSessionId).toBe("b");
    expect(app.parked?.session).toBe("a");
    expect(app.tabs.panes[0].active).toBe(tb.id);
    // New chat during the pending chat's own first turn is the one refusal.
    app.parked = null;
    app.activeSessionId = null;
    await newTab();
    expect(app.toasts.at(-1)?.text).toMatch(/first turn/);
    app.busy = false;
  });

  it("steps across the strip, wrapping", async () => {
    await openSession("a");
    reflectTabs();
    app.openNext = "new";
    await openSession("b");
    reflectTabs();
    await stepTab(1);
    expect(app.activeSessionId).toBe("a");
    await stepTab(1);
    expect(app.activeSessionId).toBe("b");
    await stepTab(-1);
    expect(app.activeSessionId).toBe("a");
  });
});

describe("closing", () => {
  it("⌘W lands the neighbour and opens it; the last tab becomes New chat", async () => {
    await openSession("a");
    reflectTabs();
    app.openNext = "new";
    await openSession("b");
    reflectTabs();
    await closeTab();
    expect(chats(app.tabs)).toEqual([["a"]]);
    expect(app.activeSessionId).toBe("a");
    await closeTab();
    expect(chats(app.tabs)).toEqual([["new"]]);
    expect(app.activeSessionId).toBeNull();
    expect(app.tabs.panes).toHaveLength(1);
  });

  it("the live tab under a running turn stays; a background tab closes", async () => {
    await openSession("a");
    reflectTabs();
    app.openNext = "new";
    await openSession("b");
    reflectTabs();
    app.busy = true;
    await closeTab();
    expect(chats(app.tabs)).toEqual([["a", "b"]]);
    await closeTab(app.tabs.panes[0].tabs[0].id);
    expect(chats(app.tabs)).toEqual([["b"]]);
  });

  // Backlog 140: the × he found dead was the sole New chat tab's — the
  // model swapped it for an identical one and nothing showed.
  it("× on the sole New chat tab says so; on a sole chat it leaves the new-chat page", async () => {
    await closeTab();
    expect(chats(app.tabs)).toEqual([["new"]]);
    expect(app.toasts.at(-1)?.text).toMatch(/last tab/);
    app.toasts = [];
    await openSession("a");
    reflectTabs();
    await closeTab();
    expect(chats(app.tabs)).toEqual([["new"]]);
    expect(app.activeSessionId).toBeNull();
    expect(app.view).toBe("chat");
    expect(app.toasts).toHaveLength(0);
  });

  it("the note view's ← Chat closes the note tab and lands the chat", async () => {
    await openSession("a");
    reflectTabs();
    app.openNext = "new";
    showNote("project", "plan.md");
    reflectTabs();
    closeNote();
    expect(chats(app.tabs)).toEqual([["a"]]);
    expect(app.view).toBe("chat");
    expect(app.openNote).toBeNull();
  });
});

// The phone's message (backlog 091) under blocker 182's one-live-chat rule
// (review E, 2026-09-17): a chat the desktop cannot open right now — a turn
// runs in another — holds the words under its own key, never the open chat's.
describe("remote-send", () => {
  it("refuses a message for a chat it cannot open, and never queues it under the open chat", async () => {
    // ~~held under that chat's key~~ — since backlog 132 the phone is told
    // (a 409) and keeps the text itself; nothing lands in y, nothing waits
    // in x's queue unseen.
    for (const k of Object.keys(drafts)) delete drafts[k];
    await openSession("y");
    reflectTabs();
    app.busy = true;
    await expect(remoteSend("x", "for x")).rejects.toThrow(/busy in another chat/);
    expect(app.activeSessionId).toBe("y");
    expect(readDraft("x").queue).toEqual([]);
    expect(readDraft("y").queue).toEqual([]);
    // For the open chat itself, a running turn queues as the composer
    // would, and says so.
    await expect(remoteSend("y", "for y")).resolves.toBe("queued");
    expect(readDraft("y").queue.map((q) => q.text)).toEqual(["for y"]);
    app.busy = false;
    // Idle, a chat that will not open is refused with the reason.
    vi.mocked(api.openSession).mockRejectedValueOnce("no such chat");
    await expect(remoteSend("zz", "for zz")).rejects.toThrow(/could not open that chat/);
    expect(readDraft("zz").queue).toEqual([]);
  });
});

describe("⌘T", () => {
  it("opens a new-chat tab beside the active one, and only one", async () => {
    await openSession("a");
    reflectTabs();
    await newTab();
    reflectTabs();
    expect(chats(app.tabs)).toEqual([["a", "new"]]);
    expect(app.activeSessionId).toBeNull();
    await newTab();
    reflectTabs();
    expect(chats(app.tabs)).toEqual([["a", "new"]]);
  });
});

// The + chooser (backlog 140 pass 1) and the drops from outside (pass 2).
describe("openContent and dropContent", () => {
  it("the chooser opens a new tab of what he picks; a project is a card, an aside a view", async () => {
    await openSession("a");
    reflectTabs();
    await openContent({ kind: "graph" });
    expect(chats(app.tabs)).toEqual([["a", "graph"]]);
    expect(app.view).toBe("graph");
    await openContent({ kind: "note", scope: "project", name: "plan.md" });
    expect(chats(app.tabs)).toEqual([["a", "graph", "plan.md"]]);
    expect(app.openNext).toBe("replace");
    await openContent({ kind: "project", id: "p1" });
    expect(chats(app.tabs)).toEqual([["a", "graph", "plan.md", "project:p1"]]);
    // A card changes nothing global: the note is still the open one.
    expect(app.view).toBe("note");
    await openContent({ kind: "aside", session: "a" });
    expect(front()).toBe("aside:a");
    expect(asideInTab("a")).toBe(true);
    expect(asideInTab("b")).toBe(false);
    // New chat from the chooser: a new-chat tab, and one only.
    await openContent({ kind: "chat", session: null });
    expect(chats(app.tabs)).toEqual([
      ["a", "graph", "plan.md", "project:p1", "aside:a", "new"],
    ]);
    expect(app.activeSessionId).toBeNull();
    await openContent({ kind: "chat", session: null });
    expect(chats(app.tabs)[0]).toHaveLength(6);
    expect(app.openNext).toBe("replace");
  });

  it("a drop on a strip is a new tab at the index; on a half, a second pane", async () => {
    await openSession("a");
    reflectTabs();
    const pane = app.tabs.panes[0].id;
    await dropContent({ kind: "chat", session: "b" }, { pane, index: 0 });
    expect(chats(app.tabs)).toEqual([["b", "a"]]);
    expect(app.activeSessionId).toBe("b");
    await dropContent(
      { kind: "note", scope: "project", name: "x.md" },
      { pane, side: "right" },
    );
    expect(chats(app.tabs)).toEqual([["b", "a"], ["x.md"]]);
    expect(app.view).toBe("note");
    expect(app.tabs.focused).toBe(app.tabs.panes[1].id);
    // Two panes: a drop on the left pane's half lands there.
    await dropContent({ kind: "nightshift" }, { pane, side: "left" });
    expect(chats(app.tabs)).toEqual([["b", "a", "nightshift"], ["x.md"]]);
    // A singleton dropped again, on the other pane: no second tab.
    await dropContent(
      { kind: "nightshift" },
      { pane: app.tabs.panes[1].id, index: 0 },
    );
    expect(chats(app.tabs)).toEqual([["b", "a", "nightshift"], ["x.md"]]);
    // ~~Another chat under a running turn is refused with the toast.~~
    // Since backlog 159 (2026-09-18) it opens as a view of its log read
    // from disk, the running chat parked with its stream; the tab lands.
    app.busy = true;
    app.live = { segments: [] };
    const running = app.activeSessionId;
    await dropContent({ kind: "chat", session: "c" }, { pane, index: 0 });
    expect(chats(app.tabs)).toEqual([["c", "b", "a", "nightshift"], ["x.md"]]);
    expect(app.activeSessionId).toBe("c");
    // ~~read from disk (`peekSession`)~~ — since pass 2 step A1
    // (2026-09-24) opened on the backend too (`openSession` is a focus that
    // answers during the turn), so the chat on screen is the open chat.
    expect(app.events.map((e) => (e.event === "user_message" ? e.text : e.event))).toEqual([
      "session_created",
      "hello from c",
    ]);
    expect(vi.mocked(api.openSession)).toHaveBeenLastCalledWith("c");
    expect(app.parked?.session).toBe(running);
    expect(app.parked?.live).toEqual({ segments: [] });
    expect(app.live).toBeNull();
    // Back to the running chat: its stream comes back and its parked log
    // stays the view; the backend's focus follows it (A1), nothing peeked.
    const peeks = vi.mocked(api.peekSession).mock.calls.length;
    const parkedEvents = app.parked?.events;
    await openContent({ kind: "chat", session: running }, "replace");
    expect(app.parked).toBeNull();
    expect(app.activeSessionId).toBe(running);
    expect(app.live).toEqual({ segments: [] });
    expect(app.events).toBe(parkedEvents);
    expect(vi.mocked(api.openSession)).toHaveBeenLastCalledWith(running);
    expect(vi.mocked(api.peekSession).mock.calls.length).toBe(peeks);
    app.busy = false;
    app.live = null;
  });
});
