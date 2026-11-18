import { beforeEach, describe, expect, it, vi } from "vitest";
import menuSrc from "./ScheduleMenu.svelte?raw";
import hudSrc from "./hudMenu.ts?raw";
import threadsSrc from "./state/threads.svelte.ts?raw";

// Item 840 (his report, 2026-11-18): Send later → "At the weekly reset" on
// the new-chat page split the tab in two — the page squashed above a "Not
// the open chat" card, the menu stuck open — and froze the window. Making
// the chat moved the open chat off its tab for one step; the page began to
// leave and came straight back, and Svelte's reversed exit of the open
// menu (a function-form `out:` transition) threw on its missing animation.

const MADE = [{ event: "session_created", id: "made", at: "2026-11-18T09:40:00Z" }];

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  startChat: vi.fn(async () => MADE),
  setChatThread: vi.fn(async () => [...MADE, { event: "thread", thread: "t", at: "2026-11-18T09:40:00Z" }]),
  setChatKind: vi.fn(async () => MADE),
  connectAgent: vi.fn(async () => ({ provider: "claude-code", model: "m", workspace: "/w" })),
  threadUpkeep: vi.fn(async (slug: string) => ({ slug, flags: [] })),
  peekThreadHandoff: vi.fn(async () => null),
  listSessions: vi.fn(async () => []),
  listThreads: vi.fn(async () => []),
  transcript: vi.fn(async () => MADE),
}));

const tabs = await import("./tabs");
const { app, startPendingChat, adoptCreatedChat } = await import("./state.svelte");

/** What the pane draws for its active tab: the open chat, or a card. */
const drawsLive = () => tabs.liveTab(app.tabs, app.activeSessionId)?.id === tabs.activeTab(tabs.focusedPane(app.tabs)).id;

beforeEach(() => {
  vi.clearAllMocks();
  app.project = { id: "p1", name: "P" } as unknown as typeof app.project;
  app.activeSessionId = null;
  app.events = [];
  app.busy = false;
  app.connecting = false;
  app.pendingThread = null;
  app.view = "chat";
  app.openNext = "replace";
  app.tabs = tabs.emptyWorkspace();
});

describe("a New chat made without sending keeps its tab (840)", () => {
  it("Send later's start: the tab holds the new id the moment the id is the open chat's", async () => {
    expect(drawsLive()).toBe(true);
    // No App here, so no reflection effect: the retarget is the call's own.
    const id = await startPendingChat();
    expect(id).toBe("made");
    expect(drawsLive()).toBe(true);
    expect(tabs.allTabs(app.tabs).map((t) => t.content)).toEqual([{ kind: "chat", session: "made" }]);
  });

  it("the whole class: every call that adopts a made chat (thread, kind, folders, layers) retargets the tab in the same step", () => {
    app.events = MADE as never;
    adoptCreatedChat(null);
    expect(app.activeSessionId).toBe("made");
    expect(drawsLive()).toBe(true);
    // The one place every such call adopts the id does the retarget.
    const adopt = threadsSrc.slice(threadsSrc.indexOf("export function adoptCreatedChat"));
    expect(adopt.slice(0, adopt.indexOf("\n}\n"))).toContain("front.content = { kind: \"chat\", session: first.id };");
  });
});

describe("the retarget is narrow (840)", () => {
  it("leaves app.openNext for the reflection effect", () => {
    app.events = MADE as never;
    app.openNext = "beside";
    adoptCreatedChat(null);
    expect(app.openNext).toBe("beside");
    expect(tabs.allTabs(app.tabs).map((t) => t.content)).toEqual([{ kind: "chat", session: "made" }]);
  });

  it("touches no front tab that is not a New chat", () => {
    const front = tabs.activeTab(tabs.focusedPane(app.tabs));
    front.content = { kind: "chat", session: "older" };
    app.events = MADE as never;
    adoptCreatedChat(null);
    expect(app.activeSessionId).toBe("made");
    expect(tabs.allTabs(app.tabs).map((t) => t.content)).toEqual([{ kind: "chat", session: "older" }]);
  });
});

describe("the menu's close cannot freeze the window (840)", () => {
  it("hudOut returns a config, not a function Svelte defers behind a stand-in", () => {
    const fn = hudSrc.slice(hudSrc.indexOf("export function hudOut"));
    const head = fn.slice(0, fn.indexOf("\n", fn.indexOf("{")) + 40);
    expect(head).not.toMatch(/return \(\) =>/);
  });
});

describe("Send later says what it did (840)", () => {
  it("a toast names the time it sends, and a time gone by sends now", () => {
    expect(menuSrc).toContain("addToast(`Scheduled for ${clockText(due)}`)");
    expect(menuSrc).toContain("void sendScheduledNow(to)");
    expect(menuSrc).toContain("open = false;");
  });
  it("a reset already gone by is greyed with that reason, not 'unknown'", () => {
    expect(menuSrc).toContain("the reset has passed — waiting for a new usage reading");
  });
});
