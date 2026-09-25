import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { app, backgroundTurnOf, cancelTurn, stopTarget } from "./state.svelte";

/**
 * The phone's Stop names the chat it shows (nightshift backlog 159, A3):
 * two chats may run at once, so a Stop for one chat must never stop the
 * chat on the Mac's screen in its place.
 */
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  cancel: vi.fn(async () => undefined),
}));

describe("a Stop that names its chat", () => {
  beforeEach(() => {
    vi.mocked(api.cancel).mockClear();
    app.parked = null;
    app.activeSessionId = "screen-chat";
    app.background = {};
  });

  it("stops nothing when the named chat has no turn here", async () => {
    await cancelTurn("some-idle-chat");
    expect(vi.mocked(api.cancel)).not.toHaveBeenCalled();
  });

  it("stops the chat on screen when it is the one named, by id or prefix", async () => {
    await cancelTurn("screen");
    expect(vi.mocked(api.cancel)).toHaveBeenCalledTimes(1);
  });

  it("stops the chat on screen when none is named, as before", async () => {
    await cancelTurn();
    expect(vi.mocked(api.cancel)).toHaveBeenCalledTimes(1);
  });

  it("names a parked turn's chat, not the screen's", async () => {
    app.parked = {
      session: "parked-chat",
      pendingMode: "normal",
      pendingKind: "build",
      events: [],
      live: null,
      liveUsage: null,
    };
    await cancelTurn("screen-chat");
    expect(vi.mocked(api.cancel)).not.toHaveBeenCalled();
    await cancelTurn("parked-chat");
    expect(vi.mocked(api.cancel)).toHaveBeenCalledTimes(1);
  });

  it("finds no background turn when none runs", () => {
    expect(backgroundTurnOf("a")).toBeNull();
  });
});

describe("what the screen's Stop names (found live, A3)", () => {
  it("names the turn key before the first event names the chat", () => {
    expect(stopTarget({ chat: null, key: "turn:k-1" })).toBe("turn:k-1");
  });
  it("names the chat once it is known", () => {
    expect(stopTarget({ chat: "abc", key: "turn:k-1" })).toBe("abc");
  });
  it("names nothing only when no Claude Code turn runs", () => {
    expect(stopTarget(null)).toBeNull();
  });
});
