import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  app,
  asideInTab,
  asideOf,
  asideWaiting,
  asidesOf,
  askAside,
  deleteSession,
  dismissAside,
  draftAside,
  followUpAside,
  switchAside,
  unfoldAside,
  useProject,
} from "./state.svelte";
import * as api from "./api";

/**
 * The floating aside cards in the state. Backlog 141 held one card at a
 * time; since backlog 176 (2026-09-23) several are open at once — each
 * passage its own card, thread and anchor; closing one leaves the rest; a
 * cancel names its own exchange; and every open thread survives a chat
 * switch (137's FE4).
 */
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  askAside: vi.fn(async () => ({ answer: "because", cost: 0, cache_read: 10, is_error: false, notices: [] })),
  cancelAside: vi.fn(async () => null),
  // What a project switch and a delete call (backlog 203's tests).
  closeProject: vi.fn(async () => null),
  newSession: vi.fn(async () => ({ mode: "normal", kind: "build" })),
  listSessions: vi.fn(async () => []),
  deleteSession: vi.fn(async (id: string) => id),
}));

const quote = (n: number) => ({ text: `passage ${n}`, role: "assistant" as const, ordinal: n });
const anchor = (turn: number) => ({ turn, block: 0, start: 0, end: 9, side: "below" as const });

describe("several aside cards at once (backlog 176)", () => {
  beforeEach(() => {
    app.activeSessionId = "chat-a";
    app.asides = [];
    app.aside = null;
    app.asidePanel = null;
    app.asidePanelThread = null;
    app.connection = {
      provider: "claude-code",
      model: "default",
      thinking: "off",
      tools: false,
      contextLimit: null,
      price: null,
      mcp: [],
      reviewers: [],
      workspace: "/tmp",
      search: null,
      knowledge: null,
      engine: "claude-code",
      agent: null,
    };
    vi.mocked(api.cancelAside).mockClear();
    vi.mocked(api.askAside).mockClear();
  });

  it("a second passage opens a second card; the first keeps its thread and anchor", async () => {
    const first = draftAside(quote(2), anchor(3))!;
    await askAside("why?", quote(2), first);
    const second = draftAside(quote(5), anchor(9))!;
    expect(app.asides.map((a) => a.id)).toEqual([first.id, second.id]);
    expect(first.id).not.toBe(second.id);
    expect(app.asides[0]!.anchor).toEqual(anchor(3));
    expect(app.asides[0]!.turns.map((t) => [t.question, t.answer])).toEqual([["why?", "because"]]);
    expect(app.asides[1]!.draft).toBe(true);
    expect(app.asides[1]!.anchor).toEqual(anchor(9));
    // Nothing was replaced, so nothing was cancelled.
    expect(api.cancelAside).not.toHaveBeenCalled();
    // The front thread (what still reads one card) is the newest.
    expect(app.aside?.id).toBe(second.id);
    // The new draft's box takes the caret.
    expect(app.asideFocus).toBe(second.id);
  });

  it("the ask keeps the draft's anchor and asks in place, so the answer lands under the passage", async () => {
    const d = draftAside(quote(2), anchor(3))!;
    await askAside("why?", quote(2), d);
    expect(app.asides.length).toBe(1);
    expect(app.asides[0]!.draft).toBe(false);
    expect(app.asides[0]!.anchor).toEqual(anchor(3));
  });

  it("a follow-up goes to the card it was typed in", async () => {
    const a = draftAside(quote(2), anchor(3))!;
    await askAside("why?", quote(2), a);
    const b = draftAside(quote(5), anchor(9))!;
    await askAside("how?", quote(5), b);
    await followUpAside("and then?", app.asides[0]!);
    expect(app.asides[0]!.turns.map((t) => t.question)).toEqual(["why?", "and then?"]);
    expect(app.asides[1]!.turns.map((t) => t.question)).toEqual(["how?"]);
  });

  it("a composer aside has no anchor; a second composer question continues it (blocker 319)", async () => {
    await askAside("what now?");
    expect(app.asides[0]!.anchor).toBeNull();
    expect(app.asides[0]!.quote).toBeNull();
    await askAside("and after?");
    expect(app.asides.length).toBe(1);
    expect(app.asides[0]!.turns.map((t) => t.question)).toEqual(["what now?", "and after?"]);
  });

  it("× closes that card and leaves the rest", () => {
    const a = draftAside(quote(2), anchor(3))!;
    const b = draftAside(quote(5), anchor(9))!;
    dismissAside(app.asides[0]!);
    expect(app.asides.map((x) => x.id)).toEqual([b.id]);
    expect(a.id).not.toBe(b.id);
  });

  it("× mid-answer cancels that exchange by its own number, and no other", async () => {
    let release: (v: unknown) => void = () => {};
    vi.mocked(api.askAside).mockImplementation(() => new Promise((r) => (release = r as (v: unknown) => void)) as never);
    const a = draftAside(quote(2), anchor(3))!;
    void askAside("why?", quote(2), a);
    const b = draftAside(quote(5), anchor(9))!;
    void askAside("how?", quote(5), b);
    const [first, second] = app.asides;
    // The second waits for the first (blocker 317: one asks at a time).
    expect(asideWaiting(second!)).toBe(true);
    expect(asideWaiting(first!)).toBe(false);
    const seqOfSecond = second!.turns[0]!.seq;
    dismissAside(second!);
    expect(api.cancelAside).toHaveBeenCalledTimes(1);
    expect(api.cancelAside).toHaveBeenCalledWith(seqOfSecond);
    expect(app.asides.length).toBe(1);
    expect(app.asides[0]!.turns[0]!.cancelled).toBe(false);
    release({ answer: "done", cache_read: 0, is_error: false, notices: [] });
    vi.mocked(api.askAside).mockImplementation(async () => ({ answer: "because", cost_usd: null, cache_read: 10, is_error: false, notices: [] }));
  });

  it("past three open cards the oldest folds, and opening it folds the next oldest (blocker 318)", () => {
    const ids = [1, 2, 3, 4].map((n) => draftAside(quote(n), anchor(n))!.id);
    expect(app.asides.map((a) => a.folded === true)).toEqual([true, false, false, false]);
    unfoldAside(app.asides[0]!);
    expect(app.asides.map((a) => a.folded === true)).toEqual([false, true, false, false]);
    expect(app.asides.map((a) => a.id)).toEqual(ids);
  });

  it("each tab and the panel name their thread; the card hides only for its own", () => {
    const a = draftAside(quote(2), anchor(3))!;
    const b = draftAside(quote(5), anchor(9))!;
    expect(asideInTab("chat-a", a.id)).toBe(false);
    app.asidePanel = "chat-a";
    app.asidePanelThread = a.id;
    expect(asideInTab("chat-a", a.id)).toBe(true);
    expect(asideInTab("chat-a", b.id)).toBe(false);
    expect(asideInTab("chat-a")).toBe(true);
    expect(asideInTab("chat-b")).toBe(false);
    expect(asideOf("chat-a", a.id)?.id).toBe(a.id);
    expect(asideOf("chat-a")?.id).toBe(b.id);
    app.asidePanel = null;
    expect(asideInTab("chat-a", a.id)).toBe(false);
  });

  it("switching chats and back brings every open thread back (137's FE4)", async () => {
    const a = draftAside(quote(2), anchor(3))!;
    await askAside("why?", quote(2), a);
    const b = draftAside(quote(5), anchor(9))!;
    switchAside("chat-b");
    app.activeSessionId = "chat-b";
    expect(app.asides).toEqual([]);
    expect(app.aside).toBeNull();
    expect(asideOf("chat-a", a.id)?.turns[0]?.answer).toBe("because");
    switchAside("chat-a");
    app.activeSessionId = "chat-a";
    expect(app.asides.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(app.aside?.id).toBe(b.id);
  });
});

/**
 * An aside belongs to its chat (backlog 203, 2026-09-25). The app walk saw
 * two cards of his Stuart 9 chat at the foot of a new chat after a project
 * switch: `useProject` cleared the open chat without handing its cards
 * back, so the pending chat kept them, and its first send (which only sets
 * the new id) carried them into the new chat and saved them there.
 */
describe("an aside belongs to its chat (backlog 203)", () => {
  beforeEach(() => {
    app.busy = false;
    app.activeSessionId = "chat-a";
    app.asides = [];
    app.aside = null;
    app.asidePanel = null;
    app.asidePanelThread = null;
    app.connection = {
      provider: "claude-code",
      model: "default",
      thinking: "off",
      tools: false,
      contextLimit: null,
      price: null,
      mcp: [],
      reviewers: [],
      workspace: "/tmp",
      search: null,
      knowledge: null,
      engine: "claude-code",
      agent: null,
    };
  });

  it("a project switch leaves the chat's asides with it; the new chat's first send shows none", async () => {
    const a = draftAside(quote(2), anchor(3))!;
    await askAside("why?", quote(2), a);
    await useProject(null);
    expect(app.activeSessionId).toBeNull();
    expect(app.asides).toEqual([]);
    // The first send names the new chat (`session_created`), nothing more.
    app.activeSessionId = "chat-new";
    expect(app.asides).toEqual([]);
    expect(asidesOf("chat-new")).toEqual([]);
    // The thread is still its own chat's.
    expect(asidesOf("chat-a").map((x) => x.id)).toEqual([a.id]);
  });

  it("deleting the open chat leaves the next new chat with no asides", async () => {
    const a = draftAside(quote(2), anchor(3))!;
    await deleteSession("chat-a");
    expect(app.activeSessionId).toBeNull();
    expect(app.asides).toEqual([]);
    expect(asidesOf("chat-a").map((x) => x.id)).toEqual([a.id]);
  });
});
