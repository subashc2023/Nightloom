import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Save memory from this chat" (backlog 371): the capture command is asked
 * for that one chat, and a run that found something offers Dream in its
 * toast; one that found nothing offers nothing.
 */
const capture = vi.fn();
const dreamStatus = vi.fn(async () => 0);
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  capture: (...a: unknown[]) => capture(...a),
  captureStatus: vi.fn(async () => 0),
  dreamStatus: (...a: unknown[]) => dreamStatus(...(a as [])),
}));

import { app, saveMemoryFromChat } from "./state.svelte";

const report = (observations: number) => ({
  observations,
  logs_read: 1,
  skipped: 0,
  refused: 0,
  deferred: 0,
  remaining: 0,
  incognito: 0,
  per_project: [{ project: "unfiled", observations }],
  interrupted: false,
  cost_usd: null,
});

describe("save memory from this chat (backlog 371)", () => {
  beforeEach(() => {
    capture.mockReset();
    app.toasts = [];
    app.capturing = false;
    app.dreaming = false;
  });

  it("captures that one chat and offers Dream when it found something", async () => {
    capture.mockResolvedValue(report(3));
    await saveMemoryFromChat("chat-123");
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0][1]).toBe("chat-123");
    const t = app.toasts.at(-1)!;
    expect(t.text).toContain("saved 3 observations from this chat");
    expect(t.action?.label).toBe("Dream");
    expect(app.capturing).toBe(false);
  });

  it("offers no Dream when the chat held nothing worth keeping", async () => {
    capture.mockResolvedValue(report(0));
    await saveMemoryFromChat("chat-123");
    const t = app.toasts.at(-1)!;
    expect(t.text).toContain("saved 0 observations");
    expect(t.action).toBeUndefined();
  });

  it("says why when the backend refuses, and does not start while a pass runs", async () => {
    capture.mockRejectedValue("this chat is incognito — nothing it said is saved to memory");
    await saveMemoryFromChat("chat-123");
    expect(app.toasts.at(-1)!.text).toContain("incognito");
    capture.mockReset();
    app.dreaming = true;
    await saveMemoryFromChat("chat-123");
    expect(capture).not.toHaveBeenCalled();
  });
});
