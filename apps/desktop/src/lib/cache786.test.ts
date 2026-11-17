import { beforeEach, describe, expect, it, vi } from "vitest";
import composerSrc from "./Composer.svelte?raw";
import railSrc from "./RightRail.svelte?raw";
import { asideSinceCold, cacheState, chipFace, ownModelCache, stoppedUnsure } from "./cache";
import { app, askAside, asideReads, draftAside, stopAside } from "./state.svelte";
import { stoppedRead } from "./state/asides.svelte";
import { ASIDE_HIDDEN, ASIDE_KEPT } from "./asideControls";
import "./asides.svelte";
import * as api from "./api";
import type { SessionEvent } from "./types";

/**
 * Item 786 (2026-11-17, his "we have none of the cash information on this
 * … I don't know if that means … the cash is still warm, or … just cold"):
 * an aside's box shows the chat's cache chip, a stopped aside's read moves
 * the chat's countdown, and a stop that logged no reply reads "unknown".
 */
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  askAside: vi.fn(),
  cancelAside: vi.fn(async () => null),
}));

const MIN = 60_000;
const T0 = Date.parse("2026-11-17T08:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** A chat whose reply (100k context) went out at `sent` on the 1-hour cache. */
function chat(sent: number): SessionEvent[] {
  return [
    { event: "user_message", text: "q", at: iso(sent - 1000) },
    {
      event: "assistant_message",
      model: "m",
      blocks: [],
      stop_reason: "end_turn",
      usage: { input_tokens: 99_000, output_tokens: 1_000, cache_read_tokens: 90_000 },
      sent_at: iso(sent),
      cache_ttl: "1h",
      at: iso(sent + 30_000),
    },
  ] as SessionEvent[];
}

const quote = { text: "passage", role: "assistant" as const, ordinal: 1 };

describe("a stopped aside's read moves the chat's countdown (786)", () => {
  beforeEach(() => {
    app.activeSessionId = "chat-786";
    app.asides = [];
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
    vi.mocked(api.askAside).mockReset();
  });

  it("after a stopped aside whose usage arrived, the chat's chip is warm with a reset countdown", async () => {
    let release: (v: unknown) => void = () => {};
    vi.mocked(api.askAside).mockImplementationOnce(() => new Promise((r) => (release = r)) as never);
    const d = draftAside(quote, { turn: 1, block: 0, start: 0, end: 7, side: "below" })!;
    const p = askAside("slow", d.quote, d);
    d.turns[0]!.partial = "half";
    stopAside(d);
    // The CLI's interrupt reports the round (measured on 2.1.326): it read
    // the whole prefix, 50 min after the reply.
    release({ answer: "half", cache_read: 99_000, is_error: false, notices: [], sent_ms: T0 + 50 * MIN, round_read: 99_000, first_read: 99_000, first_write: 300, context_tokens: 99_400 });
    await p;
    expect(d.turns[0]!.cancelled).toBe(true);
    expect(d.turns[0]!.partial).toBe("half");
    const reads = asideReads("chat-786");
    expect(reads).toEqual([{ at: T0 + 50 * MIN, read: 99_000 }]);
    // Before: the reply's own hour would be cold at T0 + 70 min.
    expect(cacheState(chat(T0), T0 + 70 * MIN)!.warm).toBe(false);
    const s = cacheState(chat(T0), T0 + 70 * MIN, null, reads)!;
    expect(s.warm).toBe(true);
    expect(s.warmUntil).toBe(T0 + 110 * MIN);
    expect(s.remainingMs).toBe(40 * MIN);
    expect(chipFace(s, false)).toBe("warm");
  });

  it("a stop with no read reported claims nothing", () => {
    const t = { seq: 1, question: "q", partial: "", answer: null, error: null, cancelled: true, cacheRead: 0 } as Parameters<typeof stoppedRead>[0];
    stoppedRead(t, { is_error: false, cost_usd: null, cache_read: 0, sent_ms: T0, round_read: 0, first_read: null });
    expect(t.readAt).toBeUndefined();
    stoppedRead(t, { is_error: false, cost_usd: null, cache_read: 5, sent_ms: T0, round_read: 5, first_read: 5 });
    expect(t.readAt).toBe(T0);
    expect(t.roundRead).toBe(5);
  });
});

describe("what the chip can know after a stop or an aside (786)", () => {
  it("a stop that logged no reply reads unknown, not cold", () => {
    const evs = [...chat(T0), { event: "user_message", text: "stopped before a word", at: iso(T0 + 90 * MIN) } as SessionEvent];
    expect(stoppedUnsure(evs, false)).toBe(true);
    expect(stoppedUnsure(evs, true)).toBe(false);
    expect(stoppedUnsure(chat(T0), false)).toBe(false);
    const s = cacheState(evs, T0 + 91 * MIN);
    expect(chipFace(s, stoppedUnsure(evs, false))).toBe("unknown");
    // Warm stays warm: the entry before it holds at least that long.
    expect(chipFace(cacheState(evs, T0 + 30 * MIN), true)).toBe("warm");
    expect(chipFace(null, true)).toBe(null);
  });

  it("an aside after the cache went cold is named, not counted (it warms only its own copy)", () => {
    const cold = cacheState(chat(T0), T0 + 80 * MIN)!;
    expect(asideSinceCold(cold, [{ at: T0 + 75 * MIN, read: 27_000 }])).toBe(true);
    expect(asideSinceCold(cold, [{ at: T0 + 10 * MIN, read: 27_000 }])).toBe(false);
    expect(asideSinceCold(cacheState(chat(T0), T0 + 10 * MIN), [{ at: T0 + 5 * MIN, read: 0 }])).toBe(false);
    // And it does not warm the chat: a read under half the context moves nothing.
    expect(cacheState(chat(T0), T0 + 80 * MIN, null, [{ at: T0 + 75 * MIN, read: 27_000 }])!.warm).toBe(false);
  });

  it("an aside on its own model times its own answers' hour", () => {
    expect(ownModelCache([], T0).warm).toBe(false);
    const s = ownModelCache([{ readAt: T0 - 10 * MIN }, { readAt: T0 - 20 * MIN }, {}], T0);
    expect(s.warm).toBe(true);
    expect(s.remainingMs).toBe(50 * MIN);
  });
});

describe("the aside's box and column draw the chat's cache (786)", () => {
  it("the cache chip and keep-warm switch are kept in an aside, not hidden", () => {
    expect("cacheChip" in ASIDE_HIDDEN).toBe(false);
    expect(ASIDE_KEPT).toContain("cacheChip");
    expect(ASIDE_KEPT).toContain("keepWarm");
  });

  it("one snippet draws the chips in the chat's row and the aside's", () => {
    expect(composerSrc).toContain("{#snippet cacheChips()}");
    expect(composerSrc.split("{@render cacheChips()}").length - 1).toBe(2);
    const asideRow = composerSrc.slice(composerSrc.indexOf('<div class="bottom-row aside-row">'), composerSrc.indexOf("{:else if !floating}"));
    expect(asideRow).toContain("{@render cacheChips()}");
  });

  it("the aside's column times its chat's cache", () => {
    expect(railSrc).toContain("aside ? (asideChat === app.activeSessionId ? asideChat : null) : app.activeSessionId");
    expect(railSrc).not.toContain("column && !aside ? cacheState");
  });
});

describe("the phone times the desktop's cache (786)", () => {
  it("reads the desktop's cache word and ignores anything else", async () => {
    const { parseCacheEvent, parseAsideEvent } = await import("../remote/client");
    const word = JSON.stringify({ kind: "cache", chat: "c", warm_until: T0 });
    expect(parseCacheEvent(word)).toEqual({ chat: "c", warmUntil: T0 });
    expect(parseCacheEvent(JSON.stringify({ kind: "cache", chat: "c", warm_until: null }))).toEqual({ chat: "c", warmUntil: null });
    expect(parseCacheEvent(JSON.stringify({ kind: "delta", seq: 1, text: "x" }))).toBe(null);
    // An older phone page's parser drops it (no `seq`).
    expect(parseAsideEvent(word)).toBe(null);
  });
});
