import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { readDraft } from "./drafts.svelte";
import { THEN_HIS_ASK, THEN_START_PROMPT, threadReadOrder } from "./handoff.svelte";
import { loadOpen, saveOpen, sidebarRows, toggled } from "./forkTree";
import { app, chatThread, moveChatToThread, newChatInThread } from "./state.svelte";
import { THREADS_CLOSED_KEY, newInThreadTip, threadGroups, threadKey } from "./thread";
import type { SessionMeta, ThreadInfo } from "./types";
// The components' source, for the wiring check (no DOM in this suite).
import chipSource from "./ThreadChip.svelte?raw";
import sidebarSource from "./Sidebar.svelte?raw";

// Nightshift backlog 288: threads in the sidebar (grouping, collapsed state,
// bind/unbind by drag and by the row menu — both call `moveChatToThread`)
// and *New chat in this thread* (one function behind the chip card, the
// group's + and New chat ▾). Fixtures only; the backend is a stub.

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  newSession: vi.fn(async () => ({ mode: "normal" })),
  setChatThread: vi.fn(async (thread: string | null) => [
    { event: "session_created", id: "c-new", at: "2026-10-02T20:00:00Z" },
    { event: "thread", ...(thread ? { thread } : {}), at: "2026-10-02T20:00:00Z" },
  ]),
  setSessionThread: vi.fn(async () => undefined),
  threadUpkeep: vi.fn(async (slug: string) => ({
    slug,
    flags: [],
    struck_moved: 0,
    struck_kept: 0,
    struck_undated: 0,
    merged: [],
    saved: 0,
    last_round: null,
  })),
  listSessions: vi.fn(async () => []),
  connect: vi.fn(async () => {
    throw new Error("not connected in tests");
  }),
}));

const when = (m: number) => new Date(Date.UTC(2026, 9, 2, 20, m)).toISOString();
const chat = (id: string, m: number, thread?: string, forkOf?: string): SessionMeta =>
  ({
    id,
    title: id,
    modified: when(m),
    mode: "normal",
    kind: "build",
    ...(thread ? { thread } : {}),
    ...(forkOf ? { forked_from: { session: forkOf, event: 1 } } : {}),
  }) as unknown as SessionMeta;
const thread = (slug: string, status: string): ThreadInfo => ({
  slug,
  title: slug === "stuart" ? "Stuart brainstorm" : slug,
  status,
  touched: "2026-10-02",
  start_here_words: 100,
  tokens: 200,
  flags: 0,
});

// Newest first, as the listing gives them.
const SESSIONS = [
  chat("s9", 9, "stuart"),
  chat("s8", 8),
  chat("s7", 7, "stuart"),
  chat("f7", 6, undefined, "s7"), // a fork of s7, unbound itself
  chat("s5", 5, "gone"),
  chat("s4", 4),
];
const THREADS = [thread("stuart", "As of 2026-10-02, 7:41 PM — proxy small"), thread("empty", "As of 2026-10-01, 9:00 AM — new")];

describe("threads in the sidebar: grouping (288)", () => {
  it("puts each thread's chats under it, newest first, unbound chats below", () => {
    const rows = sidebarRows(SESSIONS, new Set(["s7"]));
    const { groups, loose } = threadGroups(rows, THREADS, new Set(), "p1");
    expect(groups.map((g) => g.slug)).toEqual(["stuart", "empty", "gone"]);
    const stuart = groups[0]!;
    expect(stuart.rows.map((r) => r.meta.id)).toEqual(["s9", "s7", "f7"]);
    expect(stuart.chats).toBe(2);
    expect(stuart.status).toMatch(/^As of/);
    expect(stuart.title).toBe("Stuart brainstorm");
    expect(groups[1]!.rows).toEqual([]);
    expect(groups[1]!.missing).toBe(false);
    expect(groups[2]!.missing).toBe(true);
    expect(loose.map((r) => r.meta.id)).toEqual(["s8", "s4"]);
  });

  it("keeps a fork with its origin's group", () => {
    const rows = sidebarRows(SESSIONS, new Set(["s7"]));
    const { loose } = threadGroups(rows, THREADS, new Set(), "p1");
    expect(loose.some((r) => r.meta.id === "f7")).toBe(false);
  });

  it("closes a group by its per-project key, and opens it again for the open chat", () => {
    const rows = sidebarRows(SESSIONS, new Set());
    const closed = new Set([threadKey("p1", "stuart")]);
    expect(threadGroups(rows, THREADS, closed, "p1").groups[0]!.open).toBe(false);
    expect(threadGroups(rows, THREADS, closed, "p2").groups[0]!.open).toBe(true);
    expect(threadGroups(rows, THREADS, closed, "p1", "s7").groups[0]!.open).toBe(true);
  });

  it("remembers which groups are closed across launches", () => {
    let closed = loadOpen(THREADS_CLOSED_KEY);
    expect(closed.size).toBe(0);
    closed = toggled(closed, threadKey("p1", "stuart"));
    saveOpen(closed, THREADS_CLOSED_KEY);
    const back = loadOpen(THREADS_CLOSED_KEY);
    expect([...back]).toEqual(["p1/stuart"]);
    // The forks' own store is untouched.
    expect(loadOpen().size).toBe(0);
    saveOpen(toggled(back, "p1/stuart"), THREADS_CLOSED_KEY);
    expect(loadOpen(THREADS_CLOSED_KEY).size).toBe(0);
  });
});

describe("bind and unbind from the sidebar (drag and row menu) (288)", () => {
  beforeEach(() => {
    vi.mocked(api.setSessionThread).mockReset();
    vi.mocked(api.setSessionThread).mockResolvedValue(undefined);
    vi.mocked(api.setChatThread).mockClear();
    // The listing re-read after a move: what the logs now say.
    vi.mocked(api.listSessions).mockImplementation(async () => app.sessions.map((s) => ({ ...s })));
    app.project = { id: "p1", name: "Value Generalization" } as unknown as typeof app.project;
    app.sessions = SESSIONS.map((s) => ({ ...s }));
    app.activeSessionId = "s9";
    app.events = [
      { event: "session_created", id: "s9", at: when(9) },
      { event: "thread", thread: "stuart", at: when(9) },
    ] as unknown as typeof app.events;
    app.busy = false;
    app.connecting = false;
    app.toasts = [];
  });

  it("binds another chat with the same thread line, and its row moves at once", async () => {
    expect(await moveChatToThread("s8", "stuart")).toBe(true);
    expect(api.setSessionThread).toHaveBeenCalledWith("s8", "stuart");
    expect(app.sessions.find((s) => s.id === "s8")!.thread).toBe("stuart");
    const { groups } = threadGroups(sidebarRows(app.sessions, new Set()), THREADS, new Set(), "p1");
    expect(groups[0]!.rows.map((r) => r.meta.id)).toContain("s8");
  });

  it("unbinds (dropped on Not in a thread, or Remove from thread)", async () => {
    expect(await moveChatToThread("s7", null)).toBe(true);
    expect(api.setSessionThread).toHaveBeenCalledWith("s7", null);
    expect(app.sessions.find((s) => s.id === "s7")!.thread).toBeUndefined();
  });

  it("does nothing when dropped on the group it is already in", async () => {
    expect(await moveChatToThread("s7", "stuart")).toBe(true);
    expect(api.setSessionThread).not.toHaveBeenCalled();
  });

  it("never drops a chat: a refused move leaves the row where it was and says why", async () => {
    vi.mocked(api.setSessionThread).mockRejectedValueOnce("that chat is running a turn — move it when the turn ends");
    expect(await moveChatToThread("s8", "stuart")).toBe(false);
    const row = app.sessions.find((s) => s.id === "s8")!;
    expect(row.thread).toBeUndefined();
    expect(app.sessions).toHaveLength(SESSIONS.length);
    expect(app.toasts.some((t) => t.text.includes("running a turn"))).toBe(true);
  });

  it("moves the open chat the picker's way (reconnect, thread layer)", async () => {
    expect(await moveChatToThread("s9", null)).toBe(true);
    expect(api.setChatThread).toHaveBeenCalledWith(null);
    expect(api.setSessionThread).not.toHaveBeenCalled();
  });

  it("refuses to move the open chat while its turn runs", async () => {
    app.busy = true;
    expect(await moveChatToThread("s9", null)).toBe(false);
    expect(api.setChatThread).not.toHaveBeenCalled();
    app.busy = false;
  });
});

describe("New chat in this thread (288)", () => {
  beforeEach(() => {
    vi.mocked(api.newSession).mockClear();
    vi.mocked(api.setChatThread).mockClear();
    app.project = { id: "p1", name: "Value Generalization" } as unknown as typeof app.project;
    app.activeSessionId = "s9";
    app.busy = false;
    app.connecting = false;
    app.toasts = [];
  });

  it("opens a new chat already bound, with the thread's read order in the box, unsent", async () => {
    expect(await newChatInThread("stuart")).toBe(true);
    expect(api.newSession).toHaveBeenCalledTimes(1);
    expect(api.setChatThread).toHaveBeenCalledWith("stuart");
    expect(app.activeSessionId).toBe("c-new");
    expect(chatThread(app.events)).toBe("stuart");
    const box = readDraft("c-new").text;
    expect(box).toBe(threadReadOrder("stuart", THEN_HIS_ASK));
    expect(box).toContain(".agents/threads/stuart/");
    expect(box).toContain("do what I ask below");
    // Light: no start prompt is promised and no wrap-up was asked for.
    expect(box).not.toContain("start prompt");
    expect(box).not.toContain("hand off");
    // Unsent: nothing is in the log but the creation and the binding.
    expect(app.events.map((e) => e.event)).toEqual(["session_created", "thread"]);
  });

  it("is refused while a turn runs, starting nothing", async () => {
    app.busy = true;
    expect(await newChatInThread("stuart")).toBe(false);
    expect(api.newSession).not.toHaveBeenCalled();
    expect(app.toasts.length).toBe(1);
    app.busy = false;
  });

  it("needs a project", async () => {
    app.project = null;
    expect(await newChatInThread("stuart")).toBe(false);
    expect(api.newSession).not.toHaveBeenCalled();
  });

  it("is wired from all three places: the chip's card, the group's +, New chat ▾", () => {
    const chip = chipSource;
    const side = sidebarSource;
    expect(chip).toMatch(/New chat in this thread/);
    expect(chip).toMatch(/newChatInThread\(slug\)/);
    // The group's + and the New chat ▾ rows.
    expect(side).toMatch(/class="tg-new"[\s\S]{0,400}newChatInThread\(g\.slug\)/);
    expect(side).toMatch(/New chat in a thread[\s\S]{0,800}startInThread\(t\.slug\)/);
    expect(side).toMatch(/function startInThread[\s\S]{0,120}newChatInThread\(slug\)/);
  });

  it("says the two weights apart in its tooltip", () => {
    const tip = newInThreadTip("stuart");
    expect(tip).toContain("No wrap-up runs");
    expect(tip).toContain("Wrap up → Continue");
  });

  it("leaves Continue's read order as it was", () => {
    expect(threadReadOrder("stuart")).toMatch(new RegExp(`${THEN_START_PROMPT.replace(/\./g, "\\.")}$`));
  });
});
