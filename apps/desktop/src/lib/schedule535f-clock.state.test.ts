import { describe, expect, it, vi } from "vitest";
import appSrc from "../App.svelte?raw";
import composerSrc from "./Composer.svelte?raw";

// 535f, the review's 535-3: the schedule's clock and the backend's wake
// listeners started only when a chat composer mounted. Launched onto a note,
// the Nightshift page or a web tab, nothing ticked and no wake was heard, so
// a due message went only when he opened a chat. Now they start at app start.

const handlers: Record<string, (e: { payload: unknown }) => void> = {};
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, fn: (e: { payload: unknown }) => void) => {
    handlers[name] = fn;
    return () => {};
  }),
  emit: vi.fn(async () => {}),
}));

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  sendAgent: vi.fn(() => new Promise(() => {})),
  canSendInChat: vi.fn(async () => null),
  reserveChatAgent: vi.fn(async () => true),
  chatHome: vi.fn(async () => ({ found: true, project: "p-college", name: "College" })),
  armWake: vi.fn(async () => null),
  scheduleLog: vi.fn(async () => null),
  transcript: vi.fn(async () => []),
  listSessions: vi.fn(async () => []),
  planUsage: vi.fn(async () => null),
  scheduledFiles: vi.fn(async () => []),
}));

const api = await import("./api");
const { app } = await import("./state.svelte");
const { scheduleSend, reloadScheduled } = await import("./scheduled.svelte");
const { startScheduleRuntime } = await import("./scheduleRuntime");

const COLLEGE = { id: "p-college", name: "College" };

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

describe("535f — the schedule's clock runs from app start, not from a composer", () => {
  it("App starts it in onMount, after init; the composer is no longer the only starter", () => {
    expect(appSrc).toMatch(/import \{ startScheduleRuntime \} from "\.\/lib\/scheduleRuntime"/);
    expect(appSrc).toMatch(/onMount\(\(\) => \{[\s\S]*\.finally\(\(\) => startScheduleRuntime\(\)\)/);
    expect(composerSrc).toMatch(/registerScheduleDrain\(/);
  });

  it("launched onto a note tab (no composer mounted): a due entry is delivered, and the wakes are heard", async () => {
    reloadScheduled(null, 0);
    app.connection = { engine: "claude-code", contextLimit: 200_000 } as never;
    app.connecting = false;
    app.busy = false;
    app.activeSessionId = null;
    app.project = { id: "p-notes", name: "Notes" } as never;
    scheduleSend("chat-a", "due at launch", "time", Date.now() - 1000, true, [], COLLEGE);
    startScheduleRuntime();
    // Not a real plan read: the tick's limit check reads files.
    await settle();
    await new Promise((r) => setTimeout(r, 20));
    await settle();
    expect(vi.mocked(api.sendAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.sendAgent).mock.calls[0]![0]).toBe("due at launch");
    expect(Object.keys(handlers).sort()).toEqual(["system-woke", "wake-due"]);
    expect(vi.mocked(api.armWake)).toHaveBeenCalled();
  });
});
