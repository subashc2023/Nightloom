import { describe, expect, it } from "vitest";
import composerSrc from "./Composer.svelte?raw";
import { ASIDE_COLD_TIP, asideSinceCold, cacheState, chatAsideReads, chipFace, coldEitherWay } from "./cache";
import { cacheEstimate } from "./cacheCost";
import { changePrice, priceLine } from "./changeCost";
import { app, asideReads } from "./state.svelte";
import "./asides.svelte";
import type { SessionEvent } from "./types";

/**
 * Item 933 (2026-11-24, his "though the cache shows warm there it says the
 * cache will be lost from switching to opus 5.5"): a Fable chat gone cold,
 * then an aside on Opus. The aside's second answer reads its own Opus copy
 * whole; counted as the chat's read it painted the chat warm. Only asides
 * on the chat's model touch the chat's cache (806's measured 97.3% stays).
 */
const MIN = 60_000;
const T0 = Date.parse("2026-11-24T08:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const FABLE = "claude-fable-5-2";
const OPUS = "claude-opus-5-5";
const RATES = { read: 1, write: 10, from: "test" };

function chat(sent: number): SessionEvent[] {
  return [
    { event: "user_message", text: "q", at: iso(sent - 1000) },
    {
      event: "assistant_message",
      model: FABLE,
      blocks: [],
      stop_reason: "end_turn",
      usage: { input_tokens: 99_000, output_tokens: 1_000, cache_read_tokens: 90_000 },
      sent_at: iso(sent),
      cache_ttl: "1h",
      at: iso(sent + 30_000),
    },
  ] as SessionEvent[];
}

/** An aside thread on `model` (null: the chat's), answered at 75 and 80 min:
 *  the first wrote its copy, the second read it whole. */
const thread = (model: string | null, answered: string) => ({
  model,
  turns: [
    { readAt: T0 + 75 * MIN, roundRead: 27_000, model: answered },
    { readAt: T0 + 80 * MIN, roundRead: 99_500, model: answered },
  ],
});

describe("an aside on a cold chat leaves the main chip cold (933)", () => {
  const events = chat(T0);
  const now = T0 + 85 * MIN;

  it("another model's aside: chip cold, price the cold one", () => {
    const reads = chatAsideReads([thread(OPUS, OPUS)], FABLE);
    expect(reads).toEqual([]);
    const cache = cacheState(events, now, null, reads)!;
    expect(cache.warm).toBe(false);
    expect(chipFace(cache, false)).toBe("cold");
    const est = cacheEstimate(events, RATES, cache.warm)!;
    expect(est.usd).toBe(est.cold);
    expect(est.line).toBe(`next ≈ $${est.cold.toFixed(2)}`);
    // Before 933 every aside's read counted, and the chip read warm.
    const all = chatAsideReads([thread(OPUS, OPUS)], null);
    expect(cacheState(events, now, null, all)!.warm).toBe(true);
  });

  it("by the thread's pick when the turn records no model", () => {
    const t = { model: OPUS, turns: [{ readAt: T0 + 80 * MIN, roundRead: 99_500 }] };
    expect(chatAsideReads([t], FABLE)).toEqual([]);
  });

  it("the chat's own model still warms it (806, measured 97.3%)", () => {
    const reads = chatAsideReads([thread(null, FABLE)], FABLE);
    expect(reads).toHaveLength(2);
    expect(cacheState(events, now, null, reads)!.warm).toBe(true);
  });

  it("errors and turns without a read give none", () => {
    const t = { turns: [{ readAt: T0, roundRead: 5, error: "x" }, { readAt: T0 }] };
    expect(chatAsideReads([t], FABLE)).toEqual([]);
  });

  it("asideReads filters the open chat's asides by its model", () => {
    app.activeSessionId = "chat-933";
    app.asides = [thread(OPUS, OPUS) as never, thread(null, FABLE) as never];
    expect(asideReads("chat-933", FABLE)).toHaveLength(2);
    expect(asideReads("chat-933")).toHaveLength(4);
    app.asides = [];
  });

  it("the tooltip says the aside kept its own cache", () => {
    const cache = cacheState(events, now, null, [])!;
    expect(asideSinceCold(cache, chatAsideReads([thread(OPUS, OPUS)], null))).toBe(true);
    expect(ASIDE_COLD_TIP).toBe("Cold · an aside keeps its own cache; it did not warm this chat");
    expect(ASIDE_COLD_TIP.length).toBeLessThanOrEqual(64);
    expect(composerSrc).toContain("return `${ASIDE_COLD_TIP}\\n${nextEst?.title");
    expect(composerSrc).not.toContain("warmed only its own copy\\n");
  });

  it("the composer's chip and ticker pass the chat's model", () => {
    expect(composerSrc).toContain("asideReads(kwChat, lastReply(app.events)?.model)),");
    expect(composerSrc).toContain("asideReads(kwChat, lastReply(app.events)?.model))?.warmUntil");
  });
});

describe("a model switch on a cold chat: cold either way (933)", () => {
  it("the chip's line", () => {
    expect(coldEitherWay("next ≈ $2.15")).toBe("cold either way ≈ $2.15");
    expect(coldEitherWay("re-writes 100k")).toBe("re-writes 100k · cold either way");
    expect(composerSrc).toContain("line: coldEitherWay(est.line)");
    expect(composerSrc).not.toContain("the change costs no extra");
  });

  it("the bar's and the rail's price: no 'lost', no warm comparison", () => {
    const c = changePrice({
      usage: { input_tokens: 99_000, output_tokens: 1_000 },
      changes: [],
      layers: null,
      built: RATES,
      target: { ...RATES, write: 21.5 },
      warm: false,
      engine: "claude-code",
    });
    const line = priceLine(c);
    expect(line).toBe("cold either way ≈ $2.15");
    expect(line).not.toMatch(/lost|warm/);
  });
});
