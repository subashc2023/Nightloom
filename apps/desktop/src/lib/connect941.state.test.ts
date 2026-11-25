import { beforeEach, describe, expect, it, vi } from "vitest";

// Item 941 (his bug, 3:41 PM 2026-11-24): a connect made while a turn ran
// failed after 20 s, and the chat read "not connected" though its turn and
// engine were alive; Retry during the turn did nothing at all. Real
// `applyAgentDraft`, `syncPromptLayers` and `retryConnect`, backend mocked.

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  connectAgent: vi.fn(),
  connect: vi.fn(async () => ({ provider: "anthropic", model: "m", workspace: "/w", project: null })),
  promptPending: vi.fn(async () => null),
  promptLayers: vi.fn(async () => ({ off: [], built: [], edits: {}, built_edits: {} })),
  planUsage: vi.fn(async () => null),
  claudeAuthStatus: vi.fn(async () => null),
}));

const api = await import("./api");
const { app, applyAgentDraft, syncPromptLayers, retryConnect } = await import("./state.svelte");
const { connectRetry } = await import("./state/layers.svelte");

const connect = vi.mocked(api.connectAgent);
const connectProvider = vi.mocked(api.connect);
const OK = { provider: "claude-code", model: "opus", workspace: "/w", project: null } as never;
const CHAT = "9d1c2a44-0000-4000-8000-000000000941";
const WORKING = { engine: "claude-code", provider: "claude-code", model: "opus", contextLimit: 200_000 } as never;
const GAVE_UP =
  "Connecting gave up after 20 s, still waiting on the Claude Code binary's identity (the probe's cache).";

/** Read through a function: TS narrows `app.connection` to null after the assignments above. */
function engineOf(): string | undefined {
  return app.connection?.engine;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
  connect.mockReset();
  connectRetry.reset();
  app.activeSessionId = CHAT;
  app.draft.engine = "claude-code";
  app.connecting = false;
  app.busy = false;
  app.connectError = null;
  app.retryAfterTurn = false;
  app.events = [];
});

describe("941 — a connect that fails while a turn runs", () => {
  it("keeps the working connection: no 'not connected' for a live engine", async () => {
    app.connection = WORKING;
    app.busy = true;
    connect.mockRejectedValueOnce(GAVE_UP);
    await applyAgentDraft();
    expect(app.connection).toBe(WORKING);
    expect(app.connectError).toContain("gave up after 20 s");
    expect(app.connecting).toBe(false);
  });

  it("a first connect that fails still reads as not connected", async () => {
    app.connection = null;
    connect.mockRejectedValueOnce("could not start claude: not found");
    await applyAgentDraft();
    expect(app.connection).toBeNull();
    expect(app.connectError).toContain("not found");
  });

  it("agent engine: Retry during the turn connects now, past the turn deferral", async () => {
    app.connection = null;
    connect.mockRejectedValueOnce(GAVE_UP);
    await applyAgentDraft();
    app.busy = true;
    connect.mockResolvedValueOnce(OK);
    await retryConnect();
    await settle();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(app.retryAfterTurn).toBe(false);
    expect(engineOf()).toBe("claude-code");
  });

  it("provider engine: Retry during the turn is owed, said on the card, and connects when the turn ends despite the chat's last failure", async () => {
    app.draft.engine = "provider" as never;
    app.draft.provider = "anthropic" as never;
    app.connection = null;
    app.connectError = GAVE_UP;
    app.busy = true;
    await retryConnect();
    expect(connectProvider).not.toHaveBeenCalled();
    expect(app.retryAfterTurn).toBe(true);
    await syncPromptLayers();
    expect(connectProvider).not.toHaveBeenCalled();
    app.busy = false;
    await syncPromptLayers();
    await settle();
    expect(connectProvider).toHaveBeenCalledTimes(1);
    expect(app.retryAfterTurn).toBe(false);
  });

  it("3:42 PM's dead path: a connect failed during a turn, the turn ends, and a connect runs by itself within the retry waits; Retry after the turn connects too", async () => {
    vi.useFakeTimers();
    try {
      app.connection = null;
      app.busy = true;
      // The failure lands while busy (the effect's run returns early).
      connect.mockRejectedValueOnce(GAVE_UP);
      await applyAgentDraft();
      await syncPromptLayers();
      expect(connect).toHaveBeenCalledTimes(1);
      // The turn ends, and nothing else touches the effect.
      app.busy = false;
      connect.mockRejectedValueOnce("still slow");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(connect).toHaveBeenCalledTimes(2);
      // The chain re-arms itself after that failure: the next wait runs one more.
      connect.mockResolvedValueOnce(OK);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(connect).toHaveBeenCalledTimes(3);
      expect(engineOf()).toBe("claude-code");
      // Connected: nothing more runs.
      await syncPromptLayers();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(connect).toHaveBeenCalledTimes(3);
      // Retry by hand after a turn: connects at once.
      app.connection = null;
      app.connectError = GAVE_UP;
      connect.mockResolvedValueOnce(OK);
      await retryConnect();
      expect(connect).toHaveBeenCalledTimes(4);
      expect(engineOf()).toBe("claude-code");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a firing that comes during a provider turn is not dropped: it waits and runs after", async () => {
    vi.useFakeTimers();
    try {
      app.draft.engine = "provider" as never;
      app.draft.provider = "anthropic" as never;
      app.connection = null;
      app.connectError = GAVE_UP;
      app.busy = true;
      await syncPromptLayers(); // arms despite busy
      await vi.advanceTimersByTimeAsync(5_000); // not due: re-armed
      expect(connectProvider).not.toHaveBeenCalled();
      app.busy = false;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(connectProvider).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("without the owed Retry, the same chat's failure is not retried at once (item 888's timer owns it)", async () => {
    app.connection = null;
    connect.mockRejectedValueOnce(GAVE_UP);
    await applyAgentDraft();
    await syncPromptLayers();
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
