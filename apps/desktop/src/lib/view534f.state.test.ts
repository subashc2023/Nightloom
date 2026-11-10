import { beforeEach, describe, expect, it, vi } from "vitest";
import remoteSrc from "./remoteHandlers.ts?raw";

// 535f, the review's 534-1: a chat's events read after an await were adopted
// as the view under whichever chat was open by then. A turn ends in chat A;
// within the log's round trip he clicks chat B; A's log was drawn under B's
// id (and 534 then stored A's size under B). Same shape: rewind, edit,
// remove, restore, and the phone's unrewind.

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  sendAgent: vi.fn(),
  transcript: vi.fn(),
  rewind: vi.fn(),
  unrewind: vi.fn(),
  removeTurn: vi.fn(),
  listSessions: vi.fn(async () => []),
  planUsage: vi.fn(async () => null),
  turnBudget: vi.fn(async () => null),
  checkpoints: vi.fn(async () => []),
}));

const api = await import("./api");
const { app, send, rewindTo } = await import("./state.svelte");
const { drafts, readDraft, draftKey } = await import("./drafts.svelte");

const P = { id: "p-1", name: "One" };
const A = "chat-a";
const B = "chat-b";
const A_LOG = [
  { event: "session_created", id: A },
  { event: "user_message", text: "in A", at: "2026-11-10T01:00:00Z" },
  { event: "assistant_message", blocks: [{ type: "text", text: "reply in A" }] },
] as never[];
const B_LOG = [
  { event: "session_created", id: B },
  { event: "user_message", text: "in B", at: "2026-11-10T00:00:00Z" },
] as never[];

function deferred<T>() {
  let resolve: (v: T) => void = () => {};
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

/** What `openSession(B)` leaves on screen (its own run is synchronous after its await). */
function openB() {
  app.activeSessionId = B;
  app.events = [...B_LOG];
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(drafts)) delete drafts[k];
  for (const k of Object.keys(app.background)) delete app.background[k];
  app.connection = { engine: "claude-code", contextLimit: 200_000 } as never;
  app.connecting = false;
  app.busy = false;
  app.parked = null;
  app.error = null;
  app.project = P as never;
  app.activeSessionId = A;
  app.events = [...A_LOG.slice(0, 2)];
  app.promptPending = null;
});

describe("535f / 534-1 — a turn's end does not adopt its chat's log after he opened another", () => {
  it("turn in A ends, he opens B during the log's read: B stays on screen with B's events", async () => {
    vi.mocked(api.sendAgent).mockResolvedValue({ delivered: [], notices: [], is_error: false, refused: [] } as never);
    const log = deferred<never[]>();
    vi.mocked(api.transcript).mockImplementation(() => log.promise as never);
    const turn = send("hello");
    await settle();
    // The turn returned; `busy` is false; the transcript round trip is open.
    expect(app.busy).toBe(false);
    openB();
    log.resolve([...A_LOG]);
    await turn;
    await settle();
    expect(app.activeSessionId).toBe(B);
    expect(app.events).toEqual(B_LOG);
  });

  it("no switch: the turn's end adopts the re-synced log as before", async () => {
    vi.mocked(api.sendAgent).mockResolvedValue({ delivered: [], notices: [], is_error: false, refused: [] } as never);
    vi.mocked(api.transcript).mockResolvedValue([...A_LOG] as never);
    await send("hello");
    await settle();
    expect(app.activeSessionId).toBe(A);
    expect(app.events).toEqual(A_LOG);
  });
});

describe("535f / 534-1 — rewind in A, then B opened during its round trip", () => {
  it("B's view and B's box are untouched; A's message goes back in A's own box", async () => {
    app.events = [...A_LOG];
    const r = deferred<never[]>();
    vi.mocked(api.rewind).mockImplementation(() => r.promise as never);
    const done = rewindTo(1, true);
    await settle();
    openB();
    r.resolve([A_LOG[0]] as never[]);
    await done;
    expect(app.activeSessionId).toBe(B);
    expect(app.events).toEqual(B_LOG);
    expect(readDraft(draftKey(B, P.id, app.pendingMode, app.pendingThread)).text).toBe("");
    expect(readDraft(draftKey(A, P.id, app.pendingMode, app.pendingThread)).text).toBe("in A");
  });

  it("the phone's unrewind adopts only for the chat still on screen", () => {
    expect(remoteSrc).toMatch(/await adoptOpen\(\(\) => api\.unrewind\(action\.of\)\)/);
    expect(remoteSrc).not.toMatch(/app\.events = await api\.unrewind/);
  });
});
