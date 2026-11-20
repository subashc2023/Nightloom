import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeConnectRetry, retryDelay } from "./connectRetry";
import { app, syncPromptLayers } from "./state.svelte";
import { connectRetry } from "./state/layers.svelte";
import * as api from "./api";

/**
 * Item 888: a failed connect left `app.connection` null — the composer's +,
 * model and effort dimmed, Ask aside and Council gone — and the same chat
 * was never tried again on its own. Now it is, after 5 s, 15 s, 30 s, then
 * each minute, until a connect succeeds.
 */
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  connect: vi.fn(),
  promptLayers: vi.fn(async () => ({ off: [], built: [], edits: {}, built_edits: {} })),
  listSessions: vi.fn(async () => []),
  transcript: vi.fn(async () => []),
}));

describe("retryDelay", () => {
  it("grows 5 s, 15 s, 30 s, then stays at a minute", () => {
    expect([0, 1, 2, 3, 4, 50].map(retryDelay)).toEqual([5_000, 15_000, 30_000, 60_000, 60_000, 60_000]);
  });
});

describe("makeConnectRetry", () => {
  it("keeps one timer pending, runs only when due, and starts over on reset", () => {
    const timers: Array<{ f: () => void; ms: number }> = [];
    let due = true;
    const run = vi.fn();
    const r = makeConnectRetry({ due: () => due, run, setTimer: (f, ms) => timers.push({ f, ms }), clearTimer: () => {} });
    r.arm();
    r.arm();
    expect(timers.map((t) => t.ms)).toEqual([5_000]);
    timers[0].f();
    expect(run).toHaveBeenCalledTimes(1);
    r.arm();
    expect(timers[1].ms).toBe(15_000);
    due = false;
    timers[1].f();
    expect(run).toHaveBeenCalledTimes(1);
    r.reset();
    r.arm();
    expect(timers[2].ms).toBe(5_000);
  });
});

describe("a failed connect is retried in the same chat (item 888)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    connectRetry.reset();
    vi.mocked(api.connect).mockReset();
    app.busy = false;
    app.connecting = false;
    app.connection = null;
    app.draft.engine = "provider";
    app.draft.provider = "anthropic";
    app.draft.model = "claude-sonnet-4-5";
    app.activeSessionId = "chat-888";
  });
  afterEach(() => {
    connectRetry.reset();
    vi.useRealTimers();
  });

  it("connects again after 5 s without a chat switch, and the buttons' connection comes back", async () => {
    vi.mocked(api.connect)
      .mockRejectedValueOnce(new Error("Connecting gave up after 20 s, still waiting on the chat's folders on disk"))
      .mockResolvedValueOnce({ provider: "anthropic", model: "claude-sonnet-4-5", workspace: "/tmp" } as never);
    // The launch's connect, which fails.
    const { applyDraft } = await import("./state.svelte");
    await applyDraft();
    expect(app.connection).toBeNull();
    expect(app.connectError).toContain("gave up");
    // The effect's sync after it: the same chat, so no immediate retry —
    // before 888, nothing more ever happened here.
    await syncPromptLayers();
    expect(api.connect).toHaveBeenCalledTimes(1);
    expect(connectRetry.pending).toBe(true);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(api.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.connect).toHaveBeenCalledTimes(2);
    expect(app.connection).not.toBeNull();
    expect(app.connectError).toBeNull();
    // Connected: the next sync drops the retry and starts the waits over.
    await syncPromptLayers();
    expect(connectRetry.pending).toBe(false);
    expect(connectRetry.attempts).toBe(0);
  });

  it("keeps trying while the connect keeps failing, waits growing", async () => {
    vi.mocked(api.connect).mockRejectedValue(new Error("Connecting gave up after 20 s"));
    const { applyDraft } = await import("./state.svelte");
    await applyDraft();
    await syncPromptLayers();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.connect).toHaveBeenCalledTimes(2);
    await syncPromptLayers(); // the effect re-runs when `connecting` flips back
    await vi.advanceTimersByTimeAsync(14_999);
    expect(api.connect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.connect).toHaveBeenCalledTimes(3);
    expect(app.connection).toBeNull();
  });

  it("does not retry while a turn runs", async () => {
    vi.mocked(api.connect).mockRejectedValue(new Error("gave up"));
    const { applyDraft } = await import("./state.svelte");
    await applyDraft();
    await syncPromptLayers();
    app.busy = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.connect).toHaveBeenCalledTimes(1);
    app.busy = false;
  });
});
