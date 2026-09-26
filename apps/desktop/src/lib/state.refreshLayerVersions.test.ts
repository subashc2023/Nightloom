import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app, applyDraft, chatChoice, refreshLayerVersions } from "./state.svelte";
import * as api from "./api";
import type { SessionEvent } from "./types";

/**
 * Review RF (2026-09-26) of night batch F's 174 fix: opening the Context
 * page reconnects so a file edited on disk gets its *newer version exists*
 * mark. That reconnect sent the chat's real cache state, so on a cold chat
 * under the Auto default it took the newer file the moment the page opened
 * — before he could see the mark and click *Keep this version*, which lives
 * only on that page. The page's reconnect now only looks (cold: false);
 * every other connect still says what the timer says.
 */
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  connectAgent: vi.fn(async () => ({ provider: "claude-code", model: "haiku", workspace: "/tmp" })),
  promptPending: vi.fn(async () => null),
  planUsage: vi.fn(async () => {
    throw new Error("not in the test");
  }),
}));

/** One turn sent two hours ago on a 1 h cache: cold now. */
function coldChat(): SessionEvent[] {
  const sent = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  return [
    { event: "user_message", text: "q", at: sent },
    {
      event: "assistant_message",
      model: "haiku",
      blocks: [],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
      sent_at: sent,
      cache_ttl: "1h",
      at: sent,
    },
  ] as SessionEvent[];
}

const coldSent = (i: number) => (vi.mocked(api.connectAgent).mock.calls[i][0] as { cold: boolean }).cold;

describe("the Context page's reconnect only looks (review RF, backlog 174)", () => {
  beforeEach(() => {
    vi.mocked(api.connectAgent).mockClear();
    chatChoice.ready = true;
    app.busy = false;
    app.connecting = false;
    app.connectError = null;
    app.draft.engine = "claude-code";
    app.activeSessionId = "a";
    app.events = coldChat();
    app.connection = { engine: "claude-code" } as typeof app.connection;
  });
  afterEach(() => {
    app.activeSessionId = null;
    app.events = [];
    app.connection = null;
  });

  it("never asks the connect to take a mark, even on a cold chat", async () => {
    await refreshLayerVersions();
    expect(vi.mocked(api.connectAgent)).toHaveBeenCalledTimes(1);
    expect(coldSent(0)).toBe(false);
  });

  it("while any other connect on the same cold chat still says cold", async () => {
    await applyDraft();
    expect(vi.mocked(api.connectAgent)).toHaveBeenCalledTimes(1);
    expect(coldSent(0)).toBe(true);
  });
});
