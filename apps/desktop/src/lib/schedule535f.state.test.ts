import { beforeEach, describe, expect, it, vi } from "vitest";

// 535f, the review's 535-1 (his third report, 10 PM, 2026-11-09): Send now on
// a cold chat on screen reconnects first (seconds), and he switched projects
// in those seconds. Before this fix the message was then drawn on the other
// project's New chat page, that page's model recorded as the chat's, and the
// New chat's draft moved into the scheduled chat at the turn's end.
//
// Real `sendInChat` → `send` → `sendAgent` → `layersBeforeTurn` →
// `applyAgentDraft`, with the backend mocked and the connect held open.

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  sendAgent: vi.fn(),
  connectAgent: vi.fn(),
  promptPending: vi.fn(async () => ({ session: "4f207906-07fc-48af-870f-55f86ffa0cb7", layers: [] })),
  canSendInChat: vi.fn(async () => null),
  reserveChatAgent: vi.fn(async () => true),
  chatHome: vi.fn(async () => ({ found: true, project: "p-college", name: "College" })),
  armWake: vi.fn(async () => null),
  scheduleLog: vi.fn(async () => null),
  transcript: vi.fn(async () => []),
  listSessions: vi.fn(async () => []),
  openSession: vi.fn(async () => {
    throw new Error("delivery must not open a chat");
  }),
  newSession: vi.fn(async () => null),
  planUsage: vi.fn(async () => null),
  claudeAuthStatus: vi.fn(async () => null),
}));

const api = await import("./api");
const { app, chatRuns, chatChoice, resumeAfterLimit, limitWakeDue } = await import("./state.svelte");
const { drafts, readDraft, newDraftKey, setDraftText } = await import("./drafts.svelte");
const { scheduleSend, scheduledFor, sendScheduledNow, reloadScheduled, runScheduleTick, cancelScheduled } = await import(
  "./scheduled.svelte"
);
const { scheduleDeps } = await import("./scheduleRuntime");

const COLLEGE = { id: "p-college", name: "College" };
const VALUE = { id: "p-value", name: "Value generalization" };
const CHAT = "4f207906-07fc-48af-870f-55f86ffa0cb7";

const send = vi.mocked(api.sendAgent);
const connect = vi.mocked(api.connectAgent);
let finish: (r: unknown) => void = () => {};
let connected: (r: unknown) => void = () => {};

const deps = { ...scheduleDeps, limited: async () => false };
const DONE = { delivered: [], notices: [], is_error: false, refused: [] };
const CONNECTED = { provider: "claude-code", model: "opus", workspace: "/w", project: COLLEGE };

function look(chat: string | null, project: { id: string; name: string }) {
  app.activeSessionId = chat;
  app.project = project as never;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  reloadScheduled(null, 0);
  for (const k of Object.keys(drafts)) delete drafts[k];
  for (const k of Object.keys(app.background)) delete app.background[k];
  app.connection = { engine: "claude-code", contextLimit: 200_000 } as never;
  app.connecting = false;
  app.busy = false;
  app.parked = null;
  app.error = null;
  app.toasts = [];
  app.sessions = [];
  app.events = []; // cold: no cache line at all
  app.limitPause = null;
  app.limitResumeAt = null;
  // A connection built for this chat, so only coldness asks for the reconnect.
  app.promptPending = { session: CHAT, layers: [] } as never;
  send.mockReset();
  send.mockImplementation(() => new Promise((r) => (finish = r as never)) as never);
  connect.mockReset();
  connect.mockImplementation(() => new Promise((r) => (connected = r as never)) as never);
});

describe("535f — Send now on a cold chat on screen, then a project switch during its reconnect", () => {
  it("runs once in its own chat, off screen; nothing drawn in the other project, no draft moved, no model recorded", async () => {
    look(CHAT, COLLEGE);
    scheduleSend(CHAT, "Alright, next", "time", Date.now() + 3600_000, true, [], COLLEGE);
    expect(await sendScheduledNow(CHAT, deps)).toEqual({ ok: true });
    await settle();
    // The cold chat's reconnect is in flight; the chat already counts as running.
    expect(connect).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(chatRuns(CHAT)).toBe(true);
    // He leaves for the other project, whose New chat has words in its box.
    look(null, VALUE);
    const valueNew = newDraftKey(VALUE.id, app.pendingMode, app.pendingThread);
    setDraftText(valueNew, "half-typed in Value");
    const choicesBefore = JSON.stringify(chatChoice.choices);
    connected(CONNECTED);
    await settle();
    // Sent once, to the chat by id, as that chat's off-screen turn.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe("Alright, next");
    expect(send.mock.calls[0]![7]).toEqual({ chat: CHAT, project: "p-college" });
    expect(app.background[CHAT]?.project).toBe("p-college");
    expect(chatRuns(CHAT)).toBe(true);
    // The window: still Value's New chat, empty, idle; the stale connect's
    // project did not flip it back.
    expect(app.events.some((e) => e.event === "user_message")).toBe(false);
    expect(app.busy).toBe(false);
    expect([app.activeSessionId, app.project?.id]).toEqual([null, "p-value"]);
    finish(DONE);
    await settle();
    expect(readDraft(valueNew).text).toBe("half-typed in Value");
    expect(readDraft(CHAT).text).toBe("");
    expect(JSON.stringify(chatChoice.choices)).toBe(choicesBefore);
    expect([app.activeSessionId, app.project?.id]).toEqual([null, "p-value"]);
    expect(scheduledFor(CHAT)).toBeNull();
  });

  it("still on screen and idle after the reconnect: it runs there, on screen", async () => {
    look(CHAT, COLLEGE);
    scheduleSend(CHAT, "here", "time", Date.now() + 3600_000, true, [], COLLEGE);
    await sendScheduledNow(CHAT, deps);
    await settle();
    connected(CONNECTED);
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(app.busy).toBe(true);
    expect(app.background[CHAT]).toBeUndefined();
    expect(chatRuns(CHAT)).toBe(true);
    finish(DONE);
    await settle();
    expect(chatRuns(CHAT)).toBe(false);
  });
});

describe("535f — the limit resume and a reset-timed message in one chat at the same moment", () => {
  it("one turn after the other: the second waits while the first reconnects; the window's turn state is the first's", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      look(CHAT, COLLEGE);
      const RESETS = Date.now() + 3600_000;
      app.limitPause = { session: CHAT, resetsAtMs: RESETS, window: "five_hour", subagents: [] } as never;
      resumeAfterLimit();
      const at = app.limitResumeAt!;
      scheduleSend(CHAT, "after the reset", "time", at - 1, true, [], COLLEGE);
      vi.setSystemTime(at + 5);
      limitWakeDue(); // the `limit` wake…
      await settle();
      expect(connect).toHaveBeenCalledTimes(1); // the resume's cold reconnect
      await runScheduleTick(deps); // …and the `scheduled` one, same poll
      await settle();
      expect(send).not.toHaveBeenCalled();
      // The scheduled message waits behind it, in the chat's own queue
      // (sent at that turn's end), not beside it; not lost, not twice.
      expect(scheduledFor(CHAT)).toBeNull();
      expect(readDraft(CHAT).queue.map((r) => r.text)).toEqual(["after the reset"]);
      connected(CONNECTED);
      await settle();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]![0]).toMatch(/^The last turn was paused by the plan's usage limit/);
      expect(app.busy).toBe(true);
      // A tick while the resume runs: still nothing beside it.
      await runScheduleTick(deps);
      await settle();
      expect(send).toHaveBeenCalledTimes(1);
      finish(DONE);
      await settle();
      expect(app.busy).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("535f — 535-4: a chat's kept agent spec goes when its message leaves", () => {
  const reserve = vi.mocked(api.reserveChatAgent);

  it("sent off screen: released once the backend has run it", async () => {
    look("chat-value", VALUE);
    app.promptPending = null;
    scheduleSend(CHAT, "x", "time", Date.now() - 1000, true, [], COLLEGE);
    await runScheduleTick(deps);
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(reserve).not.toHaveBeenCalledWith(CHAT, false); // not before the backend used it
    finish(DONE);
    await settle();
    expect(reserve).toHaveBeenCalledWith(CHAT, false);
  });

  it("refused before anything was sent: kept for the retry", async () => {
    look("chat-value", VALUE);
    app.promptPending = null;
    send.mockImplementation(async () => {
      throw new Error("that chat is not loaded now — its message stays queued there");
    });
    scheduleSend(CHAT, "x", "time", Date.now() - 1000, true, [], COLLEGE);
    await runScheduleTick(deps);
    await settle();
    expect(scheduledFor(CHAT)?.state).toBe("waiting");
    expect(reserve).not.toHaveBeenCalledWith(CHAT, false);
  });

  it("cancelled: released — unless the chat's limit resume waits on it", () => {
    look(CHAT, COLLEGE);
    scheduleSend(CHAT, "x", "time", Date.now() + 3600_000, true, [], COLLEGE);
    cancelScheduled(CHAT);
    expect(reserve).toHaveBeenCalledWith(CHAT, false);
    reserve.mockClear();
    app.limitPause = { session: CHAT, resetsAtMs: Date.now() + 3600_000, window: "five_hour", subagents: [] } as never;
    resumeAfterLimit();
    scheduleSend(CHAT, "y", "time", Date.now() + 3600_000, true, [], COLLEGE);
    cancelScheduled(CHAT);
    expect(reserve).not.toHaveBeenCalledWith(CHAT, false);
    resumeAfterLimit(); // its second click cancels the wait
  });
});
