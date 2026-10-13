import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  answerAsideDiscard,
  app,
  askAside,
  draftAside,
  requestDismissAside,
  setAsideUnsent,
  switchAside,
} from "./state.svelte";

/**
 * Unsent aside text lives in app state (backlog 228, practices §7): a
 * card's box is drawn from `aside.unsent`, so the card unmounting — a
 * chat switch, a closed tab — does not take the text; and a close with
 * text in the box asks before it drops it.
 */
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  askAside: vi.fn(async () => ({ answer: "because", cost: 0, cache_read: 10, is_error: false, notices: [] })),
  cancelAside: vi.fn(async () => null),
}));

const quote = (n: number) => ({ text: `passage ${n}`, role: "assistant" as const, ordinal: n });
const anchor = (turn: number) => ({ turn, block: 0, start: 0, end: 9, side: "below" as const });

describe("unsent aside text in app state (backlog 228)", () => {
  beforeEach(() => {
    app.activeSessionId = "chat-a";
    app.asides = [];
    app.aside = null;
    app.asideDiscard = null;
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

  it("a typed question and a typed follow-up survive the card's unmount (a chat switch away and back)", async () => {
    const d = draftAside(quote(2), anchor(3))!;
    setAsideUnsent(d, "what is this?");
    const t = draftAside(quote(5), anchor(9))!;
    await askAside("why?", quote(5), t);
    setAsideUnsent(app.asides[1]!, "and then?");
    switchAside("chat-b");
    app.activeSessionId = "chat-b";
    expect(app.asides).toEqual([]);
    switchAside("chat-a");
    app.activeSessionId = "chat-a";
    expect(app.asides.map((a) => [a.draft, a.unsent])).toEqual([
      [true, "what is this?"],
      [false, "and then?"],
    ]);
  });

  it("closing a card with text asks first; Keep leaves it, Discard closes it", () => {
    const d = draftAside(quote(2), anchor(3))!;
    setAsideUnsent(d, "half a question");
    requestDismissAside(app.asides[0]!);
    expect(app.asides.length).toBe(1);
    expect(app.asideDiscard?.id).toBe(d.id);
    answerAsideDiscard(false);
    expect(app.asideDiscard).toBeNull();
    expect(app.asides[0]!.unsent).toBe("half a question");
    requestDismissAside(app.asides[0]!);
    answerAsideDiscard(true);
    expect(app.asides).toEqual([]);
    expect(app.asideDiscard).toBeNull();
  });

  it("closing a card with an empty or blank box closes at once, as before", () => {
    draftAside(quote(2), anchor(3));
    const b = draftAside(quote(5), anchor(9))!;
    setAsideUnsent(b, "  \n ");
    requestDismissAside(app.asides[0]!);
    requestDismissAside(app.asides[0]!);
    expect(app.asides).toEqual([]);
    expect(app.asideDiscard).toBeNull();
  });
});
