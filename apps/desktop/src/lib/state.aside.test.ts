import { beforeEach, describe, expect, it, vi } from "vitest";
import { app, asideInTab, askAside, dismissAside, draftAside } from "./state.svelte";
import * as api from "./api";

/**
 * The floating aside card's one rule in the state (nightshift backlog
 * 141): one card at a time — a second passage replaces the first's card,
 * and the anchor the card opens under is the passage the thread is about,
 * kept from the draft through the ask.
 */
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  askAside: vi.fn(async () => ({ answer: "because", cost: 0, cache_read: 10, is_error: false, notices: [] })),
  cancelAside: vi.fn(async () => null),
}));

const quote = (n: number) => ({ text: `passage ${n}`, role: "assistant" as const, ordinal: n });
const anchor = (turn: number) => ({ turn, block: 0, start: 0, end: 9, side: "below" as const });

describe("one floating card at a time (backlog 141)", () => {
  beforeEach(() => {
    app.activeSessionId = "chat-a";
    app.aside = null;
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
  });

  it("a second passage replaces the first's card, anchor and all", () => {
    draftAside(quote(2), anchor(3));
    expect(app.aside?.anchor?.turn).toBe(3);
    draftAside(quote(5), anchor(9));
    expect(app.aside?.draft).toBe(true);
    expect(app.aside?.quote).toEqual(quote(5));
    expect(app.aside?.anchor).toEqual(anchor(9));
    expect(app.aside?.turns).toEqual([]);
  });

  it("the ask keeps the draft's anchor, so the answer lands under the passage", async () => {
    draftAside(quote(2), anchor(3));
    await askAside("why?", quote(2));
    expect(app.aside?.draft).toBe(false);
    expect(app.aside?.anchor).toEqual(anchor(3));
    expect(app.aside?.turns.map((t) => [t.question, t.answer])).toEqual([["why?", "because"]]);
  });

  it("a composer aside has no anchor: its card sits above the composer (blocker 225)", async () => {
    await askAside("what now?");
    expect(app.aside?.anchor).toBeNull();
    expect(app.aside?.quote).toBeNull();
  });

  it("× ends the card and the anchor with it", () => {
    draftAside(quote(2), anchor(3));
    dismissAside();
    expect(app.aside).toBeNull();
  });

  it("the side panel hides the card as a tab does (pass 2, blocker 194's rule extended)", () => {
    draftAside(quote(2), anchor(3));
    expect(asideInTab("chat-a")).toBe(false);
    app.asidePanel = "chat-a";
    expect(asideInTab("chat-a")).toBe(true);
    expect(asideInTab("chat-b")).toBe(false);
    app.asidePanel = null;
    expect(asideInTab("chat-a")).toBe(false);
  });
});
