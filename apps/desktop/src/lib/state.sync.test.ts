import { beforeEach, describe, expect, it, vi } from "vitest";
import { app, syncPromptLayers } from "./state.svelte";
import * as api from "./api";

/**
 * The prompt-layer sync after a failed provider connect (nightshift
 * backlog 137, review E's FE8): the backend keeps the built set on a
 * failure, so the pairs keep disagreeing, and the effect that re-runs the
 * sync on every `connecting` flip reconnected again at once — a loop
 * bounded only by the connect's own latency. The one pair that failed is
 * not retried; a rail change (which clears the error) tries afresh.
 */
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  promptLayers: vi.fn(async () => ({
    off: ["identity"],
    built: [],
    edits: {},
    built_edits: {},
    mode: "normal",
    built_mode: "normal",
    kind: "build",
    built_kind: "build",
  })),
  connect: vi.fn(async () => {
    throw new Error("the key was revoked");
  }),
  listSessions: vi.fn(async () => []),
  transcript: vi.fn(async () => []),
}));

describe("syncPromptLayers after a failed connect", () => {
  beforeEach(() => {
    vi.mocked(api.connect).mockClear();
    app.busy = false;
    app.connecting = false;
    app.connectError = null;
    app.draft.engine = "provider";
    app.draft.provider = "anthropic";
    app.draft.model = "claude-sonnet-4-5";
    app.activeSessionId = "chat-b";
    app.connection = {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      thinking: "off",
      tools: false,
      contextLimit: null,
      price: null,
      mcp: [],
      reviewers: [],
      workspace: "/tmp",
      search: null,
      knowledge: null,
      engine: "provider",
      agent: null,
    };
  });

  it("does not reconnect the same pair again while the error stands, and does after a rail change", async () => {
    await syncPromptLayers();
    expect(api.connect).toHaveBeenCalledTimes(1);
    expect(app.connectError).toContain("revoked");
    // The effect's re-run on the `connecting` flip: the same pair, still failed.
    await syncPromptLayers();
    await syncPromptLayers();
    expect(api.connect).toHaveBeenCalledTimes(1);
    // Another chat wants the same set: its own try.
    app.activeSessionId = "chat-c";
    await syncPromptLayers();
    expect(api.connect).toHaveBeenCalledTimes(2);
    await syncPromptLayers();
    expect(api.connect).toHaveBeenCalledTimes(2);
    // A rail Apply clears the error on its way in; the next sync tries afresh.
    app.connectError = null;
    await syncPromptLayers();
    expect(api.connect).toHaveBeenCalledTimes(3);
  });
});
