import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  app,
  APPLY_DEBOUNCE_MS,
  chatChoice,
  scheduleApply,
  sendHeld,
  syncPromptLayers,
} from "./state.svelte";
import * as api from "./api";
import railSrc from "./ProviderRail.svelte?raw";
import composerSrc from "./Composer.svelte?raw";

/**
 * Item 222 (2026-09-25): every click in the model panel greyed the whole
 * rail for the length of a connect, so Subagent limits 6 → 2 took ~20 s of
 * waiting. The rail now stays live; clicks debounce into one connect, a
 * change made during a connect is kept and sent once when it settles, and
 * Send waits for it.
 */

type Settle = { resolve: () => void };
const inFlight: Settle[] = [];

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  // Each connect waits until the test settles it.
  connectAgent: vi.fn(
    () =>
      new Promise((resolve) => {
        inFlight.push({
          resolve: () =>
            resolve({
              provider: "claude-code",
              model: "sonnet",
              workspace: "/tmp",
            }),
        });
      }),
  ),
  promptPending: vi.fn(async () => null),
  planUsage: vi.fn(async () => {
    throw new Error("not in the test");
  }),
  // The layer pairs agree, so the sync after a connect has nothing to do.
  promptLayers: vi.fn(async () => ({ off: [], built: [], edits: {}, built_edits: {} })),
}));

const connects = () => vi.mocked(api.connectAgent).mock.calls;
const limitsSent = (i: number) => (connects()[i][0] as { limits: { concurrent: number } }).limits.concurrent;

/** The App effect re-runs `syncPromptLayers` when `connecting` flips. */
async function settle(): Promise<void> {
  inFlight.shift()!.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(app.connecting).toBe(false);
  // Not awaited: a follow-up connect waits for the test to settle it too.
  void syncPromptLayers();
  await vi.advanceTimersByTimeAsync(0);
}

describe("rail changes during a connect (item 222)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(api.connectAgent).mockClear();
    inFlight.length = 0;
    chatChoice.ready = true;
    chatChoice.reconnect = false;
    app.busy = false;
    app.connecting = false;
    app.applyPending = false;
    app.connectError = null;
    app.connection = null;
    app.activeSessionId = null;
    app.draft.engine = "claude-code";
    app.draft.agentLimits.concurrent = 6;
  });
  afterEach(() => {
    vi.useRealTimers();
    app.connecting = false;
    app.applyPending = false;
  });

  it("debounces a burst of clicks into one connect with the last value", async () => {
    for (const n of [5, 4, 3, 2]) {
      app.draft.agentLimits.concurrent = n;
      scheduleApply();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(connects()).toHaveLength(0);
    expect(sendHeld()).toBe(true);
    await vi.advanceTimersByTimeAsync(APPLY_DEBOUNCE_MS);
    expect(connects()).toHaveLength(1);
    expect(limitsSent(0)).toBe(2);
    await settle();
    expect(connects()).toHaveLength(1);
    expect(sendHeld()).toBe(false);
  });

  it("four changes during an in-flight connect make exactly one more, carrying the final value", async () => {
    scheduleApply();
    await vi.advanceTimersByTimeAsync(APPLY_DEBOUNCE_MS);
    expect(connects()).toHaveLength(1);
    expect(app.connecting).toBe(true);
    // Spaced past the debounce, so each one reaches `applyDraft` mid-connect.
    for (const n of [5, 4, 3, 2]) {
      app.draft.agentLimits.concurrent = n;
      scheduleApply();
      await vi.advanceTimersByTimeAsync(APPLY_DEBOUNCE_MS + 50);
    }
    expect(connects()).toHaveLength(1);
    expect(app.applyPending).toBe(true);
    expect(sendHeld()).toBe(true);
    await settle();
    expect(connects()).toHaveLength(2);
    expect(limitsSent(1)).toBe(2);
    expect(sendHeld()).toBe(true); // the second connect is in flight
    await settle();
    expect(connects()).toHaveLength(2);
    expect(app.applyPending).toBe(false);
    expect(sendHeld()).toBe(false);
  });

  it("a change put back as it was during a connect costs no second connect", async () => {
    scheduleApply();
    await vi.advanceTimersByTimeAsync(APPLY_DEBOUNCE_MS);
    app.draft.agentLimits.concurrent = 2;
    scheduleApply();
    await vi.advanceTimersByTimeAsync(APPLY_DEBOUNCE_MS + 50);
    app.draft.agentLimits.concurrent = 6;
    scheduleApply();
    await vi.advanceTimersByTimeAsync(APPLY_DEBOUNCE_MS + 50);
    await settle();
    expect(connects()).toHaveLength(1);
    expect(sendHeld()).toBe(false);
  });

  it("a failed connect still sends the change made during it", async () => {
    vi.mocked(api.connectAgent).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          inFlight.push({ resolve: () => reject("not found") });
        }),
    );
    scheduleApply();
    await vi.advanceTimersByTimeAsync(APPLY_DEBOUNCE_MS);
    app.draft.agentLimits.concurrent = 2;
    scheduleApply();
    await vi.advanceTimersByTimeAsync(APPLY_DEBOUNCE_MS + 50);
    await settle();
    expect(connects()).toHaveLength(2);
    expect(limitsSent(1)).toBe(2);
  });

  it("Send is not held by a running turn (backlog 214's queue still takes messages)", () => {
    app.busy = true;
    app.connecting = true;
    app.applyPending = true;
    expect(sendHeld()).toBe(false);
  });
});

describe("the rail and Send while connecting (item 222, source)", () => {
  it("the rail's controls lock on a turn only, not on a connect", () => {
    expect(railSrc).toMatch(/const locked = \$derived\(app\.busy\);/);
    expect(railSrc).toMatch(/const apply = \(\) => scheduleApply\(\);/);
    expect(railSrc).toMatch(/\{#if app\.applyPending\}[\s\S]{0,120}applying…/);
  });

  it("Send and the council are held while a connect is in flight or pending", () => {
    expect(composerSrc).toMatch(/disabled=\{!app\.connection \|\| sendHeld\(\) \|\|/);
    expect(composerSrc).toMatch(/if \(sendHeld\(\)\) return;/);
    const held = composerSrc.match(/sendHeld\(\)/g) ?? [];
    expect(held.length).toBeGreaterThanOrEqual(4);
  });
});
