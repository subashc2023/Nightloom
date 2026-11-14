import { beforeEach, describe, expect, it, vi } from "vitest";

// Item 691: he sends a chat's first message from the new chat page, stops
// the reply, edits that message and sends. The fork of "before message 1"
// has no message at all, and the Claude Code send drew the edited message
// only after its first await (`layersBeforeTurn`), so for that gap the chat
// was blank by App.svelte's test and the pane flashed to the new chat page
// and back. Now the fork opens with the edited message already in place.

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  editMessage: vi.fn(),
  sendAgent: vi.fn(),
  transcript: vi.fn(async () => []),
  listSessions: vi.fn(async () => []),
  planUsage: vi.fn(async () => null),
}));

const api = await import("./api");
const { app, sendEdit } = await import("./state.svelte");
const { drafts } = await import("./drafts.svelte");

const P = { id: "p-1", name: "One" };
const A = "chat-a";
const FORK = "fork-of-a";
const DONE = { delivered: [], notices: [], is_error: false, refused: [] };

/** App.svelte's `blank`: the test that draws the new chat page. */
function blank(): boolean {
  return (
    !app.live &&
    !app.events.some(
      (e) =>
        e.event === "user_message" ||
        e.event === "assistant_message" ||
        e.event === "compaction",
    )
  );
}
function users(): string[] {
  return app.events
    .filter((e) => e.event === "user_message")
    .map((e) => (e as { text: string }).text);
}
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

let finish: (r: unknown) => void = () => {};
beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(drafts)) delete drafts[k];
  for (const k of Object.keys(app.background)) delete app.background[k];
  app.connection = { engine: "claude-code", contextLimit: 200_000 } as never;
  app.connecting = false;
  app.busy = false;
  app.live = null;
  app.parked = null;
  app.error = null;
  app.toasts = [];
  app.project = P as never;
  app.activeSessionId = A;
  app.promptPending = null;
  // A first message, stopped before any reply.
  app.events = [
    { event: "session_created", id: A },
    { event: "user_message", text: "first words", at: "2026-11-13T01:00:00Z" },
  ] as never[];
  vi.mocked(api.sendAgent).mockReset();
  vi.mocked(api.sendAgent).mockImplementation(
    () => new Promise((r) => (finish = r as never)) as never,
  );
});

describe("691 — editing a chat's first message never draws the new chat page", () => {
  it("the fork opens with the edited message in place, before the send's first await", async () => {
    vi.mocked(api.editMessage).mockResolvedValue({
      events: [{ event: "session_created", id: FORK }],
      session: FORK,
      forked: true,
    } as never);
    // What the pane draws the moment the fork is the open chat — the send
    // has not reached its first await (`layersBeforeTurn`, a reconnect on
    // a cold chat: seconds) — and is drawn until the send's own push.
    const seen: { blank: boolean; users: string[] }[] = [];
    const done = sendEdit(1, "edited words", [], [], () =>
      seen.push({ blank: blank(), users: users() }),
    );
    expect(app.activeSessionId).toBe(A);
    await settle();
    expect(app.activeSessionId).toBe(FORK);
    expect(seen).toEqual([{ blank: false, users: ["edited words"] }]);
    // The send drew it once — the echo was taken in place, not doubled.
    expect(users()).toEqual(["edited words"]);
    expect(app.busy).toBe(true);
    expect(vi.mocked(api.sendAgent).mock.calls[0]![0]).toBe("edited words");
    finish(DONE);
    await done;
  });

  it("a later message's edit keeps the turns before it and the edited one, once", async () => {
    app.events = [
      { event: "session_created", id: A },
      { event: "user_message", text: "one", at: "2026-11-13T01:00:00Z" },
      { event: "assistant_message", text: "reply" },
      { event: "user_message", text: "two", at: "2026-11-13T01:01:00Z" },
    ] as never[];
    vi.mocked(api.editMessage).mockResolvedValue({
      events: app.events.slice(0, 3),
      session: FORK,
      forked: true,
    } as never);
    const seen: string[][] = [];
    const done = sendEdit(3, "two, edited", [], [], () => seen.push(users()));
    await settle();
    expect(seen).toEqual([["one", "two, edited"]]);
    expect(users()).toEqual(["one", "two, edited"]);
    expect(app.events[3]).toMatchObject({
      event: "user_message",
      text: "two, edited",
    });
    expect(app.busy).toBe(true);
    finish(DONE);
    await done;
  });

  it("a send that never starts takes the echo back: no message the model never got", async () => {
    vi.mocked(api.editMessage).mockResolvedValue({
      events: [{ event: "session_created", id: FORK }],
      session: FORK,
      forked: true,
    } as never);
    // The connection drops as the fork opens: `send` returns at its guard.
    await sendEdit(1, "edited words", [], [], () => {
      app.connection = null;
    });
    expect(app.activeSessionId).toBe(FORK);
    expect(vi.mocked(api.sendAgent)).not.toHaveBeenCalled();
    expect(users()).toEqual([]);
  });

  it("the fork refused: nothing changes on screen and the edit is the caller's to restore", async () => {
    vi.mocked(api.editMessage).mockRejectedValue(new Error("no such message"));
    expect(await sendEdit(1, "edited words", [], [])).toBe(false);
    expect(app.activeSessionId).toBe(A);
    expect(users()).toEqual(["first words"]);
  });
});
