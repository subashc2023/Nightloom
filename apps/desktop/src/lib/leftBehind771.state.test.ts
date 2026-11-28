// Item 771: the "left it?" state — the marks the transcript writes, Left it with its Undo, Not now, and
// Home's chats left out — over a mocked every-project listing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { DAY_MS } from "./leftBehind";
import { leftBehind, noteFoot, noteLeft, noteOpened, refreshLeftBehind, resetLeftBehind, rowsNow, settleLeft, settledChat, snoozeLeft, undoSettle } from "./leftBehind.svelte";
import { app } from "./state.svelte";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  listEverySession: vi.fn(),
}));

const list = vi.mocked(api.listEverySession);
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const row = (id: string, replyAgo: number, project: { id: string; name: string } | null = null) =>
  ({ id, path: "", modified: ago(replyAgo), user_turns: 1, first_user: id, title: null, last_reply: ago(replyAgo), last_message: ago(replyAgo + 60_000), project }) as api.ProjectChat;

beforeEach(() => {
  resetLeftBehind(Date.now() - 30 * DAY_MS);
  app.toasts.length = 0;
  app.activeSessionId = null;
  app.projects = [];
});

describe("771: the state", () => {
  it("picks today's chats from every project, Home's left out", async () => {
    app.projects = [{ id: "home", name: "Home", source: "nightloom:home" } as never];
    list.mockResolvedValue([row("a", 3 * DAY_MS, { id: "p", name: "P" }), row("h", 3 * DAY_MS, { id: "home", name: "Home" })]);
    await refreshLeftBehind();
    expect(rowsNow().map((r) => r.chat.id)).toEqual(["a"]);
    expect(rowsNow()[0].level).toBe("high");
  });

  it("reading it to the end takes it off; opening only makes it low", async () => {
    list.mockResolvedValue([row("a", 5 * DAY_MS)]);
    await refreshLeftBehind();
    noteOpened("a");
    expect(rowsNow()[0].level).toBe("low");
    noteFoot("a");
    expect(rowsNow()).toEqual([]);
  });

  it("an aside's key or the pending chat's never writes a mark", () => {
    noteOpened("aside:a:1");
    noteOpened("new");
    noteLeft("aside:a:1", true, null);
    expect(leftBehind.store.marks).toEqual({});
  });

  it("leaving keeps where he stopped", () => {
    noteLeft("a", false, { top: 420.4, holds: [{ tag: "P", text: "line", top: 12 }] });
    expect(leftBehind.store.marks.a.top).toBe(420);
    expect(leftBehind.store.marks.a.holds).toHaveLength(1);
    expect(leftBehind.store.marks.a.foot).toBeUndefined();
  });

  it("Left it settles with a 10 s Undo, and Undo puts it back", async () => {
    list.mockResolvedValue([row("a", 3 * DAY_MS)]);
    await refreshLeftBehind();
    settleLeft("a", "a");
    expect(settledChat("a", ago(3 * DAY_MS))).toBe(true);
    expect(rowsNow()[0].done).toBe("settled");
    expect(app.toasts.at(-1)?.action?.label).toBe("Undo");
    undoSettle("a");
    expect(settledChat("a", null)).toBe(false);
    expect(rowsNow()[0].done).toBeNull();
  });

  it("Not now holds it a week", async () => {
    list.mockResolvedValue([row("a", 3 * DAY_MS)]);
    await refreshLeftBehind();
    snoozeLeft("a");
    expect(leftBehind.store.snoozed.a).toBeGreaterThan(Date.now() + 6.9 * DAY_MS);
    expect(rowsNow()[0].done).toBe("snoozed");
  });

  it("the chat in front never shows", async () => {
    list.mockResolvedValue([row("a", 3 * DAY_MS)]);
    await refreshLeftBehind();
    app.activeSessionId = "a";
    expect(rowsNow()).toEqual([]);
  });
});
