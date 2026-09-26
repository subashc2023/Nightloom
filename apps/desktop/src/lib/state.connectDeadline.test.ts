import { afterEach, describe, expect, it, vi } from "vitest";
import { app, applyDraft, chatChoice } from "./state.svelte";
import { CONNECT_DEADLINE_MS, withDeadline } from "./deadline";
import * as api from "./api";

/**
 * Item 220 (2026-09-25): the installed app sat at "connecting…" for forty
 * minutes because the `connect_agent` promise never settled, and the rail
 * is locked for as long as `app.connecting` is true. A connect that never
 * answers now ends at the window's deadline with the reason on the rail.
 */
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  // The hang: a promise that never settles.
  connectAgent: vi.fn(() => new Promise(() => {})),
  promptPending: vi.fn(async () => null),
  planUsage: vi.fn(async () => {
    throw new Error("not in the test");
  }),
}));

describe("a connect that never answers (item 220)", () => {
  afterEach(() => {
    vi.useRealTimers();
    app.connecting = false;
    app.connectError = null;
  });

  it("unlocks the rail at the deadline and says why", async () => {
    vi.useFakeTimers();
    chatChoice.ready = true;
    app.busy = false;
    app.connecting = false;
    app.connectError = null;
    app.connection = null;
    app.draft.engine = "claude-code";
    const done = applyDraft();
    expect(app.connecting).toBe(true);
    await vi.advanceTimersByTimeAsync(CONNECT_DEADLINE_MS - 1);
    expect(app.connecting).toBe(true);
    await vi.advanceTimersByTimeAsync(2);
    await done;
    expect(vi.mocked(api.connectAgent)).toHaveBeenCalledTimes(1);
    expect(app.connecting).toBe(false);
    expect(app.connectError).toContain("got no answer in 25 s");
    expect(app.connection).toBeNull();
  });

  it("passes an answer or a refusal through untouched", async () => {
    await expect(withDeadline(Promise.resolve(3), 10, "x")).resolves.toBe(3);
    await expect(withDeadline(Promise.reject("not found"), 10, "x")).rejects.toBe("not found");
  });
});
