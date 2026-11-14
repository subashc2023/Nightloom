import { beforeEach, describe, expect, it, vi } from "vitest";

// Item 559 (blocker 1750, default applied): Edit and send forks the chat he
// edited, then sends. If he opened another chat in the fork call's round
// trip, the edited words went into "the open chat" — whichever it was by
// then. Now they go into the fork, off screen, and the fork opens only if he
// is still on the chat he edited.

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
const { drafts, readDraft } = await import("./drafts.svelte");

const P = { id: "p-1", name: "One" };
const A = "chat-a";
const B = "chat-b";
const FORK = "fork-of-a";
const B_LOG = [{ event: "session_created", id: B }] as never[];
const FORK_LOG = [{ event: "session_created", id: FORK }] as never[];
const DONE = { delivered: [], notices: [], is_error: false, refused: [] };

function deferred<T>() {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
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
  app.parked = null;
  app.error = null;
  app.toasts = [];
  app.project = P as never;
  app.activeSessionId = A;
  app.promptPending = null;
  app.events = [
    { event: "session_created", id: A },
    { event: "user_message", text: "old words", at: "2026-11-10T01:00:00Z" },
  ] as never[];
  vi.mocked(api.sendAgent).mockReset();
  vi.mocked(api.sendAgent).mockImplementation(() => new Promise((r) => (finish = r as never)) as never);
});

describe("559 — Edit and send, then another chat opened during the fork call", () => {
  it("the edited words run once in the fork, off screen; B stays on screen, untouched", async () => {
    const fork = deferred<unknown>();
    vi.mocked(api.editMessage).mockImplementation(() => fork.promise as never);
    const forked: string[] = [];
    const done = sendEdit(1, "new words", [], [], (_p, f) => forked.push(f));
    await settle();
    app.activeSessionId = B; // he opened B
    app.events = [...B_LOG];
    fork.resolve({ events: FORK_LOG, session: FORK, forked: true });
    expect(await done).toBe(true);
    await settle();
    const send = vi.mocked(api.sendAgent);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toBe("new words");
    expect(send.mock.calls[0]![7]).toEqual({ chat: FORK, project: "p-1" });
    expect(app.background[FORK]).toBeDefined();
    expect(app.activeSessionId).toBe(B);
    expect(app.events).toEqual(B_LOG);
    expect(app.busy).toBe(false);
    expect(forked).toEqual([]);
    finish(DONE);
    await settle();
  });

  it("refused off screen: the words wait at the head of the fork's queue, not lost", async () => {
    const fork = deferred<unknown>();
    vi.mocked(api.editMessage).mockImplementation(() => fork.promise as never);
    vi.mocked(api.sendAgent).mockImplementation(async () => {
      throw new Error("that chat is not loaded now — its message stays queued there");
    });
    const done = sendEdit(1, "new words", [], []);
    await settle();
    app.activeSessionId = B;
    app.events = [...B_LOG];
    fork.resolve({ events: FORK_LOG, session: FORK, forked: true });
    await done;
    await settle();
    expect(readDraft(FORK).queue.map((q) => q.text)).toEqual(["new words"]);
    expect(readDraft(B).queue).toEqual([]);
  });

  it("still on A: the fork opens and the send names the fork by id", async () => {
    vi.mocked(api.editMessage).mockResolvedValue({ events: FORK_LOG, session: FORK, forked: true } as never);
    const forked: string[] = [];
    await Promise.race([sendEdit(1, "new words", [], [], (_p, f) => forked.push(f)), settle()]);
    await settle();
    expect(forked).toEqual([FORK]);
    expect(app.activeSessionId).toBe(FORK);
    expect(vi.mocked(api.sendAgent).mock.calls[0]![7]).toEqual({ chat: FORK, project: "p-1" });
    expect(app.busy).toBe(true);
    finish(DONE);
    await settle();
  });
});
