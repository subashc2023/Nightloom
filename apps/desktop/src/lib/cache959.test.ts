import { describe, expect, it } from "vitest";
import composerSrc from "./Composer.svelte?raw";
import railSrc from "./rightRail/logic.svelte.ts?raw";
import { newestReplySentAt, sideCacheFor } from "./cache";
import { cacheEstimate } from "./cacheCost";
import { pendingChangeCost, switchDetail } from "./changeCost";
import { asideFromStored, storedAsideOf } from "./asides";
import type { PendingSettings } from "./cache";
import type { SessionEvent } from "./types";

/**
 * Item 959 (933b's finding): an aside on model X of a cold chat writes
 * the chat's prefix on X (tether off, the chat's tool text there: the
 * backend's `marks_chat`), so switching the chat to X reads it back —
 * 96.3% (933b run C2) and 95.5% (959 run S2). The switch to X is priced
 * warm; a switch to any other model Y stays cold.
 */
const MIN = 60_000;
const T0 = Date.parse("2026-11-25T08:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const HAIKU = "claude-haiku-5-5";
const SONNET = "claude-sonnet-5-5";
const OPUS = "claude-opus-5-5";
/** Sonnet 5.5 at list prices as the CLI billed runs S1, S2, C1 and C2
 *  (fitted: $0.10 read, $4 1-hour write, per million tokens). */
const SONNET_RATES = { read: 0.1, write: 4, from: "959 fit" };

/** The chat of run S2: its last reply on Haiku, prompt 71,354, out 4. */
function chat(sent: number): SessionEvent[] {
  return [
    { event: "user_message", text: "q", at: iso(sent - 1000) },
    {
      event: "assistant_message",
      model: HAIKU,
      blocks: [],
      stop_reason: "end_turn",
      usage: { input_tokens: 71_354, output_tokens: 4, cache_read_tokens: 67_172, cache_write_tokens: 4_180 },
      sent_at: iso(sent),
      cache_ttl: "1h",
      cache_key: { engine: "claude-code", model: "haiku", tools: true, safe_mode: false, plan: false },
      at: iso(sent + 5_000),
    },
  ] as SessionEvent[];
}

const marked = (model: string, at: number, marksChat = true) => ({ turns: [{ readAt: at, roundRead: 27_014, model, marksChat }] });

describe("an aside's entry on its own model (959)", () => {
  // The chat went cold (its hour ran out), then a Sonnet aside at 90 min.
  const events = chat(T0);
  const reply = newestReplySentAt(events);
  const now = T0 + 95 * MIN;
  const asides = [marked(SONNET, T0 + 90 * MIN)];

  it("reads the newest reply's send", () => {
    expect(reply).toBe(T0);
  });

  it("is warm on the aside's model for its hour, and nowhere else", () => {
    const side = sideCacheFor(asides, SONNET, reply, now)!;
    expect(side.warm).toBe(true);
    expect(side.warmUntil).toBe(T0 + 150 * MIN);
    expect(side.sideModel).toBe(SONNET);
    expect(sideCacheFor(asides, `${SONNET}[1m]`, reply, now)?.warm).toBe(true);
    expect(sideCacheFor(asides, OPUS, reply, now)).toBeNull();
    expect(sideCacheFor(asides, SONNET, reply, T0 + 151 * MIN)).toBeNull();
  });

  it("claims nothing without the backend's mark, or before the newest reply", () => {
    expect(sideCacheFor([marked(SONNET, T0 + 90 * MIN, false)], SONNET, reply, now)).toBeNull();
    expect(sideCacheFor([marked(SONNET, T0 - MIN)], SONNET, reply, now)).toBeNull();
    expect(sideCacheFor([{ turns: [{ readAt: T0 + 90 * MIN, model: SONNET, marksChat: true, error: "x" }] }], SONNET, reply, now)).toBeNull();
    expect(sideCacheFor(asides, SONNET, null, now)).toBeNull();
  });

  it("a cold chat: the switch to the aside's model is priced warm, another model cold", () => {
    const usage = events[1].event === "assistant_message" ? events[1].usage : null;
    // Model menu rows: X warm, Y nothing (a cold chat's rows show no price).
    expect(switchDetail(usage, HAIKU, SONNET, SONNET_RATES, false, true)).toBe("warm · next ≈ $0.01");
    expect(switchDetail(usage, HAIKU, OPUS, SONNET_RATES, false, false)).toBe("");
    // The chip's next-send price at X: warm read vs cold write.
    const side = sideCacheFor(asides, SONNET, reply, now)!;
    const warm = cacheEstimate(events, SONNET_RATES, side.warm)!;
    const cold = cacheEstimate(events, SONNET_RATES, false)!;
    expect(warm.usd).toBeCloseTo((71_354 * 0.1 + 4 * 4) / 1e6, 9); // $0.0072
    expect(cold.usd).toBeCloseTo((71_358 * 4) / 1e6, 9); // $0.2854
    // Run S2 measured the switch's send: read 67,059, written 3,128 (the
    // probe's resumed CLI adds an environment message; his app's sends
    // write ~2 tokens, 11-20 9:51 PM), out 4 — $0.01926 billed. Without the
    // probe's 3,128 written: within 10% of the warm figure.
    const measuredRead = (67_059 * 0.1 + 4 * 10) / 1e6;
    expect(Math.abs(warm.usd - measuredRead) / measuredRead).toBeLessThan(0.1);
  });

  it("a warm chat: the switch onto the aside's entry loses nothing; onto another model it does", () => {
    const warmEvents = chat(now - 10 * MIN);
    const late = [marked(SONNET, now - 5 * MIN)];
    expect(sideCacheFor(late, SONNET, newestReplySentAt(warmEvents), now)?.warm).toBe(true);
    const draft: PendingSettings = { engine: "claude-code", agentModel: "sonnet", tools: true, agentSafeMode: false, approval: false, agentAsk: false, agentPlan: false };
    const args = {
      events: warmEvents,
      draft,
      connection: { engine: "claude-code" },
      seen: { sonnet: { id: SONNET, cliVersion: "2.1.332", seenAt: iso(now) } },
      warm: true,
      rates: () => SONNET_RATES,
    } as unknown as Parameters<typeof pendingChangeCost>[0];
    expect(pendingChangeCost({ ...args, sideWarm: true })).toBeNull();
    const lost = pendingChangeCost(args)!;
    expect(lost.changes.map((c) => c.what)).toEqual(["model"]);
    expect(lost.line.startsWith("next ≈ $0.29")).toBe(true);
  });

  it("the mark outlives a relaunch", () => {
    const stored = storedAsideOf({
      id: 1,
      model: SONNET,
      turns: [{ seq: 1, question: "q", answer: "a", partial: "", error: null, cancelled: false, readAt: T0, roundRead: 5, marksChat: true }],
    } as never);
    const back = asideFromStored(JSON.parse(JSON.stringify(stored)))!;
    expect(back.turns[0].marksChat).toBe(true);
  });

  it("the composer and the rail read the side entry", () => {
    expect(composerSrc).toContain("sideCacheFor(asidesOf(kwChat)");
    expect(composerSrc).toContain("sideWarm: !!sideCache");
    expect(railSrc).toContain("sideCacheFor(asidesOf(railChat)");
    expect(railSrc).toContain("sideWarm: !!sideCache");
  });
});
