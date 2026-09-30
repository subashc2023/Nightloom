import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app, send, useProject } from "./state.svelte";
import { REFRESH_LIMIT_MS } from "./afterWrite";
import type { ProjectInfo } from "./types";

/**
 * A4 review (2026-09-29): a provider (API key) turn that ends off screen
 * does what the screen's provider end does, and not the Claude Code
 * engine's wrap-up bookkeeping, which could queue a wrap-up message into
 * a provider chat.
 */
const { row, turn } = vi.hoisted(() => {
  let resolve: (v: unknown) => void = () => {};
  return {
    row: (id: string, name = id.toUpperCase()): ProjectInfo =>
      ({ id, name, root: `/p/${id}`, notes_dir: `/p/${id}/n`, notes: 0, chats: 0, exists: true }) as ProjectInfo,
    turn: {
      promise: () => new Promise((r) => (resolve = r)),
      end: (v: unknown) => resolve(v),
    },
  };
});

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  listProjects: vi.fn(async () => [row("a"), row("b")]),
  listSessions: vi.fn(async () => []),
  listNotes: vi.fn(async () => []),
  projectsFolderInfo: vi.fn(async () => ({ dir: "/p", default: true })),
  openProject: vi.fn(async (id: string) => row(id)),
  closeProject: vi.fn(async () => null),
  newSession: vi.fn(async () => ({ mode: "normal", kind: "build" })),
  send: vi.fn(() => turn.promise()),
  cancel: vi.fn(async () => null),
}));

vi.mock("./handoff.svelte", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./handoff.svelte")>()),
  noteAgentTurnEnd: vi.fn(),
}));

describe("a provider turn's end off screen (A4 review)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    app.busy = false;
    app.parked = null;
    app.connecting = false;
    app.background = {};
    app.draft.engine = "provider";
    app.draft.provider = "";
    app.connection = { engine: "anthropic", model: "m" } as unknown as typeof app.connection;
    app.projects = [row("a"), row("b")];
    app.project = row("a");
    app.sessions = [];
    app.view = "chat";
    app.toasts = [];
  });
  afterEach(() => vi.useRealTimers());

  it("ends in its record, with a toast, and never feeds the Claude Code wrap-up", async () => {
    app.activeSessionId = "chat-1";
    app.events = [];
    const running = send("count to ten");
    const switched = useProject("b");
    await vi.advanceTimersByTimeAsync(REFRESH_LIMIT_MS + 50);
    await switched;
    expect(app.background["chat-1"]).toBeDefined();
    turn.end({ usage: { input_tokens: 1, output_tokens: 1 } });
    await running;
    expect(app.background["chat-1"]).toBeUndefined();
    expect(app.busy).toBe(false);
    const { noteAgentTurnEnd } = await import("./handoff.svelte");
    expect(vi.mocked(noteAgentTurnEnd)).not.toHaveBeenCalled();
    expect(app.toasts.length).toBeGreaterThan(0);
  });
});
