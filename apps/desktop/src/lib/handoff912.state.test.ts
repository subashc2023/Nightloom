import { beforeEach, describe, expect, it, vi } from "vitest";

// Item 912 (his bug, 2026-11-23 3:25 PM: the card waited 1.5 h while he was
// away and nothing happened; his words: "if i like dont touch my mac for
// like 10min … nightloom should hold a caffeinate -dis during that period").
// The real `state.svelte.ts` with only the backend scripted, as
// `resume543.state.test.ts` does: a card waiting in an idle chat is wrapped
// up once the Mac has been left for ten minutes, the chain runs on with no
// click, the Mac is held awake from the wrap-up to the next chat's first
// reply, and a usage limit at each step waits for the reset and resumes.

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  sendAgent: vi.fn(),
  canSendInChat: vi.fn(async () => null),
  reserveChatAgent: vi.fn(async () => true),
  armWake: vi.fn(async () => null),
  scheduleLog: vi.fn(async () => null),
  transcript: vi.fn(async () => []),
  listSessions: vi.fn(async () => []),
  openSession: vi.fn(async () => {
    throw new Error("the chain must not open a chat");
  }),
  planUsage: vi.fn(async () => null),
  notify: vi.fn(async () => null),
  continueChat: vi.fn(async () => "chat-next"),
  continueSession: vi.fn(async () => ({ session: "chat-next", events: [], forked: true })),
  idleSeconds: vi.fn(async () => 0),
  powerHold: vi.fn(async () => null),
}));

const api = await import("./api");
const { app, clearResumes, historyFrom, limitWakeDue, resumes, switchAside } = await import("./state.svelte");
const { armAwayCheck, awayChains, checkAwayHandoffs, AWAY_CHECK_MS } = await import("./state/resumes.svelte");
const { RESUME_MARGIN_MS } = await import("./limit");
const { handoff, markAttended, markUnattended, noteActivity, noteAgentTurnEnd, resetHandoff, setMarkAt, NEVER, withHistory, wrapUpToSend } = await import(
  "./handoff.svelte"
);
const composerSrc = (await import("./Composer.svelte?raw")).default;

const COLLEGE = { id: "p-college", name: "College" };
const VALUE = { id: "p-value", name: "Value generalization" };
const A = "chat-a";
const OTHER = "chat-on-screen";
const LIMIT = 200_000;
const PAST = 150_000; // past the 70% mark of 200k
const HANDOFF = "HANDOFF.md is written.\n\n<handoff>\nRead HANDOFF.md, then run wave B.\n</handoff>\n";

const send = vi.mocked(api.sendAgent);
const hold = vi.mocked(api.powerHold);
const turns = new Map<string, (r: unknown) => void>();

function look(chat: string | null, project: { id: string; name: string }) {
  app.activeSessionId = chat;
  app.project = project as never;
}
async function settle(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}
function says(chat: string, text: string) {
  app.background[chat]!.live = { segments: [{ kind: "text", text }] } as never;
}
const ok = { delivered: [], notices: [], is_error: false, refused: [], limit: null };
const limited = (resetsAtMs: number) => ({
  ...ok,
  limit: { resets_at: resetsAtMs / 1000, window: "five_hour", text: "You've hit your session limit", subagents: [] },
});
/** He has left the Mac: nothing typed for 10 min, no input for 15. */
function leave() {
  noteActivity(Date.now() - 600_000);
  vi.mocked(api.idleSeconds).mockImplementation(async () => 900);
}
/** The hold's last word: true while held. */
const held = () => hold.mock.calls.at(-1)?.[1] ?? false;

/** Chat A's card is up while he is present; then he moves to another chat,
 *  leaving A as Nightloom last drove it (unattended) — an off-screen card. */
function cardOffScreen() {
  look(A, COLLEGE);
  switchAside(A); // what opening a chat does: this launch knows where it lives
  noteAgentTurnEnd(A, PAST, LIMIT, [], true);
  expect([handoff.chat, handoff.stage, handoff.queuedId]).toEqual([A, "due", 0]);
  markUnattended(A);
  look(OTHER, VALUE);
  noteAgentTurnEnd(OTHER, 10_000, LIMIT, [], true);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearResumes();
  resetHandoff();
  turns.clear();
  for (const k of Object.keys(app.background)) delete app.background[k];
  for (const c of [A, OTHER, "chat-next"]) {
    markAttended(c);
    setMarkAt("chat", c, null);
  }
  app.connection = { engine: "claude-code", contextLimit: LIMIT } as never;
  app.connecting = false;
  app.busy = false;
  app.error = null;
  app.toasts = [];
  app.sessions = [];
  app.events = [];
  app.limitPause = null;
  app.limitResumeAt = null;
  noteActivity(Date.now());
  vi.mocked(api.idleSeconds).mockImplementation(async () => 0);
  send.mockReset();
  send.mockImplementation(((...args: unknown[]) => {
    const target = args[7] as { chat: string } | undefined;
    return new Promise((r) => turns.set(target?.chat ?? "screen", r));
  }) as never);
});

describe("912 — a card that waits is wrapped up once he has left the Mac", () => {
  it("on screen: present, nothing; ten minutes without input, the wrap-up goes into the chat and the Mac is held; never twice", async () => {
    look(A, COLLEGE);
    noteAgentTurnEnd(A, PAST, LIMIT, [], true);
    expect(handoff.stage).toBe("due");
    // The check is armed on the backend's clock while the card waits.
    armAwayCheck();
    expect(api.armWake).toHaveBeenLastCalledWith("handoff-away", expect.any(Number));
    await checkAwayHandoffs();
    expect(send).not.toHaveBeenCalled();
    leave();
    await checkAwayHandoffs();
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe(wrapUpToSend(A));
    expect(handoff.stage).toBe("wrapping");
    expect(hold).toHaveBeenCalledWith("handoff", true);
    expect(awayChains()).toEqual({ [A]: null });
    // A second check while it runs, and after: no second wrap-up.
    await checkAwayHandoffs();
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("a card he only had up while present stays put: typed a moment ago, or the Mac touched under ten minutes ago", async () => {
    look(A, COLLEGE);
    noteAgentTurnEnd(A, PAST, LIMIT, [], true);
    vi.mocked(api.idleSeconds).mockImplementation(async () => 900);
    noteActivity(Date.now() - 1000);
    await checkAwayHandoffs();
    noteActivity(Date.now() - 600_000);
    vi.mocked(api.idleSeconds).mockImplementation(async () => 300);
    await checkAwayHandoffs();
    await settle();
    expect(send).not.toHaveBeenCalled();
    expect(hold).not.toHaveBeenCalled();
  });

  it("left alone: a Stay here, a never mark (545), and a background chat he was driving", async () => {
    look(A, COLLEGE);
    noteAgentTurnEnd(A, PAST, LIMIT, [], true);
    armAwayCheck();
    expect(api.armWake).toHaveBeenLastCalledWith("handoff-away", expect.any(Number));
    setMarkAt("chat", A, NEVER);
    leave();
    await checkAwayHandoffs();
    setMarkAt("chat", A, null);
    // A chat he drove, past its mark, then left for another chat.
    look(OTHER, VALUE);
    noteAgentTurnEnd(OTHER, 10_000, LIMIT, [], true);
    await checkAwayHandoffs();
    await settle();
    expect(send).not.toHaveBeenCalled();
    // And with nothing waiting the backend's check is cleared.
    armAwayCheck();
    expect(api.armWake).toHaveBeenLastCalledWith("handoff-away", null);
  });

  it("off screen: the whole chain with no click — wrap-up, next chat started, its first reply ends the hold", async () => {
    cardOffScreen();
    leave();
    await checkAwayHandoffs();
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe(wrapUpToSend(A));
    expect(send.mock.calls[0]![7]).toEqual({ chat: A, project: "p-college" });
    expect(held()).toBe(true);
    says(A, HANDOFF);
    turns.get(A)!(ok);
    await settle();
    expect(api.continueChat).toHaveBeenCalledWith(A, "p-college");
    // Item 1025: the history pointer goes under the prompt.
    expect(send.mock.calls[1]![0]).toBe(withHistory("Read HANDOFF.md, then run wave B.", historyFrom(A)));
    expect(send.mock.calls[1]![7]).toEqual({ chat: "chat-next", project: "p-college" });
    expect(awayChains()).toEqual({ [A]: "chat-next" });
    expect(held()).toBe(true);
    turns.get("chat-next")!(ok);
    await settle();
    expect(awayChains()).toEqual({});
    expect(held()).toBe(false);
    expect([app.activeSessionId, app.project?.id]).toEqual([OTHER, "p-value"]);
  });

  it("coming back mid-chain stops nothing already sent and starts no second chain", async () => {
    cardOffScreen();
    leave();
    await checkAwayHandoffs();
    await settle();
    // He is back and typing while the wrap-up runs.
    noteActivity(Date.now());
    vi.mocked(api.idleSeconds).mockImplementation(async () => 0);
    says(A, HANDOFF);
    turns.get(A)!(ok);
    await settle();
    // The wrap-up finished; the next chat waits for his click (544's rule).
    expect(api.continueChat).not.toHaveBeenCalled();
    expect(held()).toBe(false);
    // He leaves again: the same card is not wrapped up a second time.
    leave();
    await checkAwayHandoffs();
    await settle();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("912 — a usage limit anywhere in the chain waits for the reset and resumes", () => {
  it("in the wrap-up turn itself: resumed at the reset, the wrap-up's reply hands off, the hold kept throughout", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const reset = Date.now() + 3600_000;
      cardOffScreen();
      leave();
      await checkAwayHandoffs();
      await settle();
      turns.get(A)!(limited(reset));
      await settle();
      expect(resumes[A]?.at).toBe(reset + RESUME_MARGIN_MS);
      expect(held()).toBe(true);
      vi.setSystemTime(reset + RESUME_MARGIN_MS + 5);
      leave();
      limitWakeDue();
      await settle();
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1]![0]).toMatch(/^The last turn was paused by the plan's usage limit/);
      expect(send.mock.calls[1]![7]).toEqual({ chat: A, project: "p-college" });
      says(A, HANDOFF);
      turns.get(A)!(ok);
      await settle();
      expect(send.mock.calls[2]![7]).toEqual({ chat: "chat-next", project: "p-college" });
      expect(held()).toBe(true);
      turns.get("chat-next")!(ok);
      await settle();
      expect(held()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("between the wrap-up and the next chat: the window ran out as it ended, the next chat's first message is refused by the limit at once and goes at the reset", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const reset = Date.now() + 3600_000;
      cardOffScreen();
      leave();
      await checkAwayHandoffs();
      await settle();
      says(A, HANDOFF);
      turns.get(A)!(ok);
      await settle();
      // No word written: the limit at the first request.
      turns.get("chat-next")!(limited(reset));
      await settle();
      expect(resumes["chat-next"]?.at).toBe(reset + RESUME_MARGIN_MS);
      expect(held()).toBe(true);
      vi.setSystemTime(reset + RESUME_MARGIN_MS + 5);
      limitWakeDue();
      await settle();
      expect(send).toHaveBeenCalledTimes(3);
      expect(send.mock.calls[2]![7]).toEqual({ chat: "chat-next", project: "p-college" });
      turns.get("chat-next")!(ok);
      await settle();
      expect(held()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("in the next chat's first turn, mid-reply: resumed at the reset, the hold kept until that resumed reply ends", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    try {
      const reset = Date.now() + 3600_000;
      cardOffScreen();
      leave();
      await checkAwayHandoffs();
      await settle();
      says(A, HANDOFF);
      turns.get(A)!(ok);
      await settle();
      says("chat-next", "Reading HANDOFF.md. Wave B starts with");
      turns.get("chat-next")!(limited(reset));
      await settle();
      expect(resumes["chat-next"]?.at).toBe(reset + RESUME_MARGIN_MS);
      expect(held()).toBe(true);
      // Before the reset nothing goes.
      limitWakeDue();
      await settle();
      expect(send).toHaveBeenCalledTimes(2);
      vi.setSystemTime(reset + RESUME_MARGIN_MS + 5);
      limitWakeDue();
      await settle();
      expect(send).toHaveBeenCalledTimes(3);
      expect(send.mock.calls[2]![0]).toMatch(/^The last turn was paused by the plan's usage limit/);
      turns.get("chat-next")!(ok);
      await settle();
      expect(held()).toBe(false);
      expect(awayChains()).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("912 — wiring", () => {
  it("the check runs every minute on the backend's clock, and the chat's composer arms it when the card comes up", () => {
    expect(AWAY_CHECK_MS).toBe(60_000);
    expect(composerSrc).toContain("void handoffCardUp;");
    expect(composerSrc).toContain("untrack(() => armAwayCheck());");
  });
});
