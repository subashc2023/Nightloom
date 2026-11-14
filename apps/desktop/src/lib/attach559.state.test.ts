import { beforeEach, describe, expect, it, vi } from "vitest";

// Item 559, the review's 535-5 second half: a turn started off screen (a
// scheduled message, a queued send, an edit's fork) recorded the New-chat
// mode and kind of whatever page was on screen at that moment; opening the
// chat (`attach`) put them on screen, so the project's New chat changed kind.
// Only a record made as the chat left the screen (`detach`, `park`) carries
// its own.

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  sendAgent: vi.fn(() => new Promise(() => {})),
  transcript: vi.fn(async () => []),
  openSession: vi.fn(async () => []),
  turnSession: vi.fn(async () => null),
  listSessions: vi.fn(async () => []),
  planUsage: vi.fn(async () => null),
  turnBudget: vi.fn(async () => null),
}));

const { app, sendInChat, openSession } = await import("./state.svelte");

const COLLEGE = { id: "p-college", name: "College" };
const CHAT = "chat-college";

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

beforeEach(() => {
  for (const k of Object.keys(app.background)) delete app.background[k];
  app.connection = { engine: "claude-code", contextLimit: 200_000 } as never;
  app.busy = false;
  app.parked = null;
  app.error = null;
  app.promptPending = null;
});

describe("559 — opening a chat whose turn began off screen keeps the screen's New-chat kind and mode", () => {
  it("sent off screen while a Chat-kind page was open; opened in its project (Build, plan mode): stays Build, plan", async () => {
    // On screen at the send: another project's New chat, kind chat.
    app.project = { id: "p-notes", name: "Notes" } as never;
    app.activeSessionId = null;
    app.pendingKind = "chat";
    app.pendingMode = "normal";
    sendInChat(CHAT, COLLEGE, "x", [], () => {});
    await settle();
    expect(app.background[CHAT]).toBeDefined();
    // He goes to College, whose New chat is Build in plan mode, and opens the chat.
    app.project = COLLEGE as never;
    app.activeSessionId = "another-college-chat";
    app.pendingKind = "build";
    app.pendingMode = "plan" as never;
    await openSession(CHAT);
    expect(app.activeSessionId).toBe(CHAT);
    expect(app.busy).toBe(true);
    expect(app.pendingKind).toBe("build");
    expect(app.pendingMode).toBe("plan");
  });
});
