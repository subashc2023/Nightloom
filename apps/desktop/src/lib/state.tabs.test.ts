import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  activateTab,
  app,
  closeNote,
  closeTab,
  newTab,
  openSession,
  reflectTabs,
  showNote,
  stepTab,
} from "./state.svelte";
import * as tabs from "./tabs";

/**
 * The glue between the tab model and the one open chat (nightshift backlog
 * 099): reflection lands what the centre shows in a tab, activation opens
 * a tab's content. The backend is two commands: open a chat (its events),
 * and New chat.
 */
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  openSession: vi.fn(async (id: string) => [
    { event: "session_created", at: "2026-01-01T00:00:00Z", kind: "build", mode: "normal" },
    { event: "user_message", at: "2026-01-01T00:00:00Z", text: `hello from ${id}` },
  ]),
  newSession: vi.fn(async () => ({ mode: "normal", kind: "build" })),
  listSessions: vi.fn(async () => []),
  transcript: vi.fn(async () => []),
}));

const chats = (ws: tabs.Workspace) =>
  ws.panes.map((p) =>
    p.tabs.map((t) => (t.content.kind === "chat" ? (t.content.session ?? "new") : t.content.name)),
  );

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

  it("the graph and Nightshift are not tabs and change nothing", () => {
    app.view = "graph";
    reflectTabs();
    expect(chats(app.tabs)).toEqual([["new"]]);
  });
});

describe("activation", () => {
  it("opens the tab's chat, and refuses another chat while a turn runs", async () => {
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
    app.busy = true;
    await activateTab(tb.id);
    expect(app.activeSessionId).toBe("a");
    expect(app.toasts.at(-1)?.text).toMatch(/turn is running/);
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
