import { beforeEach, describe, expect, it, vi } from "vitest";
import composerSrc from "./Composer.svelte?raw";
import menuSrc from "./ScheduleMenu.svelte?raw";

// Item 527 (his report, 2026-11-09): Send later was greyed out in a New
// chat ("a new chat has no id to wait under"). A pick now makes the chat
// first, and the message waits under its id.

const order: string[] = [];
const MADE = [{ event: "session_created", id: "made", at: "2026-11-09T18:00:00Z" }];
let refuse = false;

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  startChat: vi.fn(async () => {
    order.push("start");
    if (refuse) throw new Error("no log dir");
    return MADE;
  }),
  setChatThread: vi.fn(async () => {
    order.push("bind");
    return [...MADE, { event: "thread", thread: "stuart", at: "2026-11-09T18:00:00Z" }];
  }),
  connectAgent: vi.fn(async () => ({ provider: "claude-code", model: "m", workspace: "/w" })),
  threadUpkeep: vi.fn(async (slug: string) => ({ slug, flags: [] })),
  peekThreadHandoff: vi.fn(async () => null),
  listSessions: vi.fn(async () => []),
  listThreads: vi.fn(async () => []),
  transcript: vi.fn(async () => MADE),
}));

const api = await import("./api");
const { drafts, newDraftKey, readDraft, setDraftText } = await import("./drafts.svelte");
const { app, startPendingChat } = await import("./state.svelte");
const { scheduled, scheduleSend, scheduledFor } = await import("./scheduled.svelte");

const NEW = newDraftKey("p1", "normal");

beforeEach(() => {
  order.length = 0;
  refuse = false;
  vi.clearAllMocks();
  for (const k of Object.keys(drafts)) delete drafts[k];
  for (const k of Object.keys(scheduled)) delete scheduled[k];
  app.project = { id: "p1", name: "P" } as unknown as typeof app.project;
  app.activeSessionId = null;
  app.events = [];
  app.busy = false;
  app.connecting = false;
  app.pendingThread = null;
  app.error = null;
  app.toasts = [];
  app.sessions = [];
  app.draft.engine = "claude-code";
});

describe("Send later from a New chat (527)", () => {
  it("makes the chat, moves the words to it, and the message waits under its id", async () => {
    setDraftText(NEW, "run the tests");
    const id = await startPendingChat();
    expect(id).toBe("made");
    expect(app.activeSessionId).toBe("made");
    expect(readDraft("made").text).toBe("run the tests");
    expect(scheduleSend(id as string, "run the tests", "five_hour", Date.now() + 60_000, true)).toBe(true);
    expect(scheduledFor("made")?.text).toBe("run the tests");
    expect(scheduledFor(NEW)).toBe(null);
    expect(api.listSessions).toHaveBeenCalled(); // the row appears
  });

  it("binds a waiting thread first, then makes nothing more", async () => {
    app.pendingThread = "stuart";
    expect(await startPendingChat()).toBe("made");
    expect(order).toEqual(["bind"]);
  });

  it("an open chat is returned as it is", async () => {
    app.activeSessionId = "open";
    expect(await startPendingChat()).toBe("open");
    expect(api.startChat).not.toHaveBeenCalled();
  });

  it("a refusal toasts, returns null and leaves the words in the New chat's box", async () => {
    refuse = true;
    setDraftText(NEW, "keep me");
    expect(await startPendingChat()).toBe(null);
    expect(app.toasts.length).toBe(1);
    expect(app.activeSessionId).toBe(null);
    expect(readDraft(NEW).text).toBe("keep me");
  });

  // ~~"attachments still do"~~ — 2026-11-09, item 531: attachments go with
  // the message now (schedule531.state.test.ts); only a converting chip waits.
  it("the composer no longer greys the menu for a New chat", () => {
    expect(composerSrc).not.toMatch(/no id to wait under/);
    expect(composerSrc).not.toMatch(/attachments cannot be scheduled yet/);
    expect(menuSrc).toMatch(/startPendingChat\(\)/);
  });
});
