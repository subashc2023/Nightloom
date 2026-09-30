import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app, canLeaveProject, liveChats, send, useProject } from "./state.svelte";
import { REFRESH_LIMIT_MS } from "./afterWrite";
import type { ProjectInfo } from "./types";

/**
 * Blocker 630, answered "allow" (backlog 159, A4): the project can be left
 * or switched while a chat runs off screen. The running chat keeps its
 * turn and its record, which names its project; only a New chat's first
 * turn — no chat id yet to keep it under — makes the switch wait.
 */
const { row } = vi.hoisted(() => ({
  row: (id: string, name = id.toUpperCase()): ProjectInfo =>
    ({ id, name, root: `/p/${id}`, notes_dir: `/p/${id}/n`, notes: 0, chats: 0, exists: true }) as ProjectInfo,
}));

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  listProjects: vi.fn(async () => [row("a"), row("b")]),
  listSessions: vi.fn(async () => []),
  listNotes: vi.fn(async () => []),
  projectsFolderInfo: vi.fn(async () => ({ dir: "/p", default: true })),
  openProject: vi.fn(async (id: string) => row(id)),
  closeProject: vi.fn(async () => null),
  newSession: vi.fn(async () => ({ mode: "normal", kind: "build" })),
  // A provider turn that runs until the test is done with it.
  send: vi.fn(() => new Promise<never>(() => {})),
  cancel: vi.fn(async () => null),
}));

describe("switching projects while a chat runs (blocker 630)", () => {
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

  // Order matters: a provider turn left running off screen by one case
  // would queue the next case's send (one provider turn at a time).
  it("waits for a New chat's first turn, which has no id to be kept under", async () => {
    app.activeSessionId = null;
    app.events = [];
    void send("hello");
    expect(canLeaveProject()).toBe(false);
    await useProject("b");
    expect(app.project?.id).toBe("a");
    expect(app.toasts.map((t) => t.text).join(" ")).toContain("first turn");
  });

  it("sends the running chat off screen, keeps its turn, and names its project", async () => {
    app.activeSessionId = "chat-1";
    app.events = [];
    void send("count to a thousand");
    expect(app.busy).toBe(true);
    expect(canLeaveProject()).toBe(true);
    const switched = useProject("b");
    await vi.advanceTimersByTimeAsync(REFRESH_LIMIT_MS + 50);
    await switched;
    expect(app.project?.id).toBe("b");
    // Still running, off screen, under its own project.
    expect(app.busy).toBe(false);
    expect(app.background["chat-1"]).toMatchObject({ project: "a", projectName: "A" });
    const [r] = liveChats();
    expect(r).toMatchObject({ session: "chat-1", onScreen: false });
    expect(r.name).toContain("in A");
    // One provider turn at a time (A4): a message in the new project's chat
    // queues with the notice naming where the turn runs, and is not sent.
    const sends = vi.mocked((await import("./api")).send).mock.calls.length;
    await send("and another");
    expect(vi.mocked((await import("./api")).send).mock.calls.length).toBe(sends);
    expect(app.toasts.map((t) => t.text).join(" ")).toContain("A turn is running in");
  });
});
