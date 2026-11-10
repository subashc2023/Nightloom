import { beforeEach, describe, expect, it, vi } from "vitest";
import runtimeSrc from "./scheduleRuntime.ts?raw";
import scheduledSrc from "./scheduled.svelte.ts?raw";
import stateSrc from "./state.svelte.ts?raw";

// Item 535, the app's half (his third report, 10 PM, 2026-11-09): "I just
// clicked send now on that college transfer one and then went to the value
// generalization project … the message … just got sent into the value
// generalization thing … then switched back into the college transfer thing
// automatically and sent the exact same message a second time."
//
// Delivery through the real runtime hooks (`scheduleDeps`) and the real
// `sendInChat`, with only the backend mocked: what the backend is asked to
// run, in which chat and project, how many times, and what the view does.

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  sendAgent: vi.fn(),
  canSendInChat: vi.fn(async () => null),
  reserveChatAgent: vi.fn(async () => true),
  chatHome: vi.fn(async () => ({ found: true, project: "p-college", name: "College, Transfer Apps, Career" })),
  armWake: vi.fn(async () => null),
  scheduleLog: vi.fn(async () => null),
  transcript: vi.fn(async () => []),
  listSessions: vi.fn(async () => []),
  openSession: vi.fn(async () => {
    throw new Error("delivery must not open a chat");
  }),
  planUsage: vi.fn(async () => null),
}));

const api = await import("./api");
const { app, limitWakeDue, resumeAfterLimit } = await import("./state.svelte");
const { drafts, readDraft } = await import("./drafts.svelte");
const { scheduleSend, scheduledFor, sendScheduledNow, runScheduleTick, reloadScheduled } = await import(
  "./scheduled.svelte"
);
const { scheduleDeps, readyFor } = await import("./scheduleRuntime");
const { TICK_MS } = await import("./schedule");

const COLLEGE = { id: "p-college", name: "College, Transfer Apps, Career" };
const VALUE = { id: "p-value", name: "Value generalization" };
const CHAT = "4f207906-07fc-48af-870f-55f86ffa0cb7";
const OTHER = "chat-value";

const send = vi.mocked(api.sendAgent);
const can = vi.mocked(api.canSendInChat);
let finish: (r: unknown) => void = () => {};

/** The limit check answers "not limited" without the plan files. */
const deps = { ...scheduleDeps, limited: async () => false };

function look(chat: string | null, project: { id: string; name: string }) {
  app.activeSessionId = chat;
  app.project = project as never;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  reloadScheduled(null, 0);
  for (const k of Object.keys(drafts)) delete drafts[k];
  for (const k of Object.keys(app.background)) delete app.background[k];
  app.connection = { engine: "claude-code", contextLimit: 200_000 } as never;
  app.connecting = false;
  app.busy = false;
  app.error = null;
  app.toasts = [];
  app.sessions = [];
  app.events = [];
  app.limitPause = null;
  app.limitResumeAt = null;
  send.mockReset();
  send.mockImplementation(() => new Promise((r) => (finish = r as never)) as never);
  can.mockReset();
  can.mockImplementation(async () => null);
});

describe("535 — a due message goes into its own project's chat, the view untouched", () => {
  it("another project is open at its time: the backend is told the chat and its project; nothing is opened", async () => {
    look(CHAT, COLLEGE);
    scheduleSend(CHAT, "Alright, next", "time", Date.now() - 1000, true, [], COLLEGE);
    look(OTHER, VALUE); // he went to the other project
    await runScheduleTick(deps);
    await settle();
    expect(can).toHaveBeenCalledWith(CHAT, "p-college");
    expect(send).toHaveBeenCalledTimes(1);
    const args = send.mock.calls[0]!;
    expect(args[0]).toBe("Alright, next");
    expect(args[7]).toEqual({ chat: CHAT, project: "p-college" });
    // He stays where he is; it runs as that chat's own background turn.
    expect([app.activeSessionId, app.project?.id]).toEqual([OTHER, "p-value"]);
    expect(app.background[CHAT]?.project).toBe("p-college");
    expect(api.openSession).not.toHaveBeenCalled();
    expect(app.error).toBeNull();
    expect(scheduledFor(CHAT)).toBeNull();
    expect(readDraft(OTHER).queue).toEqual([]);
    finish({ delivered: [], notices: [], is_error: false, refused: [] });
    await settle();
  });

  it("its project is not open and no spec is kept (after a relaunch): the row names the project; no error in the chat on screen", async () => {
    look(OTHER, VALUE);
    scheduleSend(CHAT, "Alright, next", "time", Date.now() - 1000, true, [], COLLEGE);
    can.mockImplementation(async () => {
      throw new Error("its project is not open");
    });
    await runScheduleTick(deps);
    const s = scheduledFor(CHAT)!;
    expect(s.note).toBe("waiting — open the project “College, Transfer Apps, Career” and it sends by itself");
    expect(s.state).toBe("waiting");
    expect(send).not.toHaveBeenCalled();
    expect(app.error).toBeNull();
    expect(app.toasts).toEqual([]);
    expect([app.activeSessionId, app.project?.id]).toEqual([OTHER, "p-value"]);
    // He opens the project (any chat in it): the next tick sends it, off screen.
    look("some-other-college-chat", COLLEGE);
    can.mockImplementation(async () => null);
    s.nextTryAt = Date.now() - 1;
    await runScheduleTick(deps);
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![7]).toEqual({ chat: CHAT, project: "p-college" });
    expect(app.activeSessionId).toBe("some-other-college-chat");
  });

  it("a chat moved to another project since: its new home is found and used", async () => {
    look(OTHER, VALUE);
    scheduleSend(CHAT, "x", "time", Date.now() - 1000, true, [], { id: "p-old", name: "Old" });
    can.mockImplementation(async (_c, p) => {
      if (p === "p-old") throw new Error("its chat's log could not be read");
      return null;
    });
    await runScheduleTick(deps);
    expect(scheduledFor(CHAT)!.project).toEqual(COLLEGE);
    scheduledFor(CHAT)!.nextTryAt = Date.now() - 1;
    await runScheduleTick(deps);
    await settle();
    expect(send.mock.calls[0]![7]).toEqual({ chat: CHAT, project: "p-college" });
  });

  it("refused by the backend after the hand-off: back as a waiting message with the reason — not queued, not lost, no error on screen", async () => {
    look(OTHER, VALUE);
    scheduleSend(CHAT, "Alright, next", "time", Date.now() - 1000, true, [], COLLEGE);
    send.mockImplementation(async () => {
      throw new Error("that chat is not loaded now — its message stays queued there");
    });
    await runScheduleTick(deps);
    await settle();
    const s = scheduledFor(CHAT)!;
    expect(s.text).toBe("Alright, next");
    expect(s.note).toMatch(/^waiting — .*not loaded now/);
    expect(s.nextTryAt).toBeGreaterThan(Date.now() + TICK_MS - 2000);
    expect(app.background[CHAT]).toBeUndefined();
    expect(app.error).toBeNull();
  });

  it("its chat is the one on screen: it runs there, and the backend is still told the chat by id", async () => {
    look(CHAT, COLLEGE);
    scheduleSend(CHAT, "on screen", "time", Date.now() - 1000, true, [], COLLEGE);
    await runScheduleTick(deps);
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe("on screen");
    expect(send.mock.calls[0]![7]).toEqual({ chat: CHAT, project: "p-college" });
    expect(app.busy).toBe(true); // the turn is this chat's, on screen
    expect(app.background[CHAT]).toBeUndefined();
    expect(scheduledFor(CHAT)).toBeNull();
    finish({ delivered: [], notices: [], is_error: false, refused: [] });
    await settle();
  });

  it("no engine connected: it waits and says so", async () => {
    app.connection = null;
    scheduleSend(CHAT, "x", "time", Date.now() - 1000, true, [], COLLEGE);
    expect(await readyFor(scheduledFor(CHAT)!)).toEqual({ ok: false, why: "waiting — no engine is connected" });
  });
});

describe("535 — Send now, then a project switch mid-flight (his third report)", () => {
  it("is sent exactly once, into the chat it belongs to, and never switches him back", async () => {
    look(CHAT, COLLEGE);
    scheduleSend(CHAT, "Alright, next", "time", Date.now() + 3600_000, true, [], COLLEGE);
    // The backend's answer is in flight when he leaves for the other project.
    let answer: (v: null) => void = () => {};
    can.mockImplementation(() => new Promise((r) => (answer = r)));
    const now = sendScheduledNow(CHAT, deps);
    await settle();
    look(OTHER, VALUE);
    // A tick lands in the middle (the 15 s clock, a window refocus).
    await runScheduleTick(deps);
    answer(null);
    expect(await now).toEqual({ ok: true });
    await settle();
    // And ticks after it.
    await runScheduleTick(deps);
    await runScheduleTick(deps);
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe("Alright, next");
    expect(send.mock.calls[0]![7]).toEqual({ chat: CHAT, project: "p-college" });
    expect([app.activeSessionId, app.project?.id]).toEqual([OTHER, "p-value"]);
    expect(api.openSession).not.toHaveBeenCalled();
    expect(scheduledFor(CHAT)).toBeNull();
    expect(readDraft(OTHER).queue).toEqual([]);
    expect(readDraft(CHAT).queue).toEqual([]);
  });

  it("Send now racing a tick on a due message: one send", async () => {
    look(OTHER, VALUE);
    scheduleSend(CHAT, "once", "time", Date.now() - 1000, true, [], COLLEGE);
    let answer: (v: null) => void = () => {};
    can.mockImplementation(() => new Promise((r) => (answer = r)));
    const ticking = runScheduleTick(deps);
    await settle();
    expect(await sendScheduledNow(CHAT, deps)).toBeNull();
    answer(null);
    await ticking;
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("its chat is running a turn off screen: into that chat's own queue, not the open chat's", async () => {
    look(OTHER, VALUE);
    app.background[CHAT] = { session: CHAT, project: "p-college" } as never;
    scheduleSend(CHAT, "after its turn", "time", Date.now() - 1000, true, [], COLLEGE);
    await runScheduleTick(deps);
    expect(send).not.toHaveBeenCalled();
    expect(readDraft(CHAT).queue.map((r) => r.text)).toEqual(["after its turn"]);
    expect(readDraft(OTHER).queue).toEqual([]);
  });
});

describe("535 — the pieces that keep it that way", () => {
  it("the runtime never opens a chat or reads the newest composer for the Claude Code engine", () => {
    expect(runtimeSrc).not.toMatch(/openSession\(|openSession,/);
    expect(runtimeSrc).not.toMatch(/useProject/);
    expect(runtimeSrc).toMatch(/sendInChat\(/);
    expect(runtimeSrc).toMatch(/listen<string>\("wake-due"/);
    expect(runtimeSrc).toMatch(/listen\("system-woke"/);
  });

  it("the on-screen send names its chat to the backend too", () => {
    expect(stateSrc).toMatch(/turnTarget = \{ chat: id, project: project\.id \}/);
    expect(stateSrc).toMatch(/target \?\? undefined,\n\s*\);/);
  });

  it("the store tells the backend's clock after every change", () => {
    expect(scheduledSrc.match(/rearm\(/g)!.length).toBeGreaterThanOrEqual(7);
  });
});

describe("535 — the limit card's resume rides the backend's clock, and goes into the paused chat", () => {
  const RESETS = Date.now() + 3600_000;

  function pause() {
    app.limitPause = { session: CHAT, resetsAtMs: RESETS, window: "five_hour", subagents: [] } as never;
  }

  it("arms the backend's `limit` wake for the reset plus the margin, and keeps the chat's spec", () => {
    look(CHAT, COLLEGE);
    pause();
    resumeAfterLimit();
    expect(app.limitResumeAt).not.toBeNull();
    expect(api.armWake).toHaveBeenCalledWith("limit", app.limitResumeAt);
    expect(app.limitResumeAt!).toBeGreaterThan(RESETS);
    expect(api.reserveChatAgent).toHaveBeenCalledWith(CHAT, true);
    // A wake before its time does nothing; a second click cancels.
    limitWakeDue();
    expect(send).not.toHaveBeenCalled();
    resumeAfterLimit();
    expect(app.limitResumeAt).toBeNull();
    expect(api.armWake).toHaveBeenLastCalledWith("limit", null);
  });

  it("at the wake, with another project on screen, the resume goes into the paused chat off screen — once", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      look(CHAT, COLLEGE);
      pause();
      resumeAfterLimit();
      look(OTHER, VALUE);
      vi.setSystemTime(app.limitResumeAt! + 5);
      limitWakeDue(); // the backend's event
      limitWakeDue(); // and its repeat
      vi.advanceTimersByTime(3600_000 + 120_000); // and the page's own timer, late
      await settle();
      expect(can).toHaveBeenCalledWith(CHAT, "p-college");
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]![0]).toMatch(/^The last turn was paused by the plan's usage limit/);
      expect(send.mock.calls[0]![7]).toEqual({ chat: CHAT, project: "p-college" });
      expect([app.activeSessionId, app.project?.id]).toEqual([OTHER, "p-value"]);
      expect(app.limitResumeAt).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
