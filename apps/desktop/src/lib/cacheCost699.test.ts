import { describe, expect, it } from "vitest";
import {
  isMiss,
  missToast,
  missToastFor,
  nextLine,
  nextSendCost,
  nextTitle,
  ratesFromPrice,
  ratesFromWire,
  turnRead,
  usd,
  cacheEstimate,
  turnMissToast,
  coldToast,
} from "./cacheCost";
import { pingMissToast } from "./keepWarm.svelte";
import type { CacheKey, SessionEvent, Usage } from "./types";

const at = "2026-11-15T20:00:00Z";
const key: CacheKey = { engine: "claude-code", model: "fable", tools: true, safe_mode: false, plan: false };
const user = (text = "q"): SessionEvent => ({ event: "user_message", text, at });
const reply = (usage: Usage, k: CacheKey | undefined = key): SessionEvent => ({
  event: "assistant_message",
  model: "claude-fable-5-2",
  blocks: [],
  stop_reason: "end_turn",
  usage,
  ...(k ? { cache_key: k } : {}),
  at,
});
const u = (input: number, read: number, write: number, output = 500): Usage => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_tokens: read,
  cache_write_tokens: write,
});

describe("item 699: the miss test (first round's read vs the context it resumed)", () => {
  it("79% read is a miss, 80% is not", () => {
    expect(isMiss(79_000, 100_000)).toBe(true);
    expect(isMiss(80_000, 100_000)).toBe(false);
    expect(isMiss(0, 0)).toBe(false);
  });

  const prior = [user(), reply(u(100_000, 99_000, 1_000))];
  it("a turn reading 79% of the previous prompt toasts; 80% does not", () => {
    const miss = turnRead([...prior, user(), reply(u(102_000, 79_000, 23_000))], 1)!;
    expect(miss).toMatchObject({ read: 79_000, write: 23_000, context: 100_000, rewound: false, chosen: false });
    expect(missToastFor({ what: "turn", read: miss.read, context: miss.context, written: miss.write, costUsd: 0.4, est: null })).not.toBeNull();
    const hit = turnRead([...prior, user(), reply(u(102_000, 80_000, 22_000))], 1)!;
    expect(missToastFor({ what: "turn", read: hit.read, context: hit.context, written: hit.write, costUsd: 0.4, est: null })).toBeNull();
  });

  it("reads the turn's first round, not a later one that read back what the first wrote", () => {
    const r = turnRead([...prior, user(), reply(u(102_000, 0, 102_000)), reply(u(103_000, 102_000, 1_000))], 1)!;
    expect(r.read).toBe(0);
  });

  it("the chat's first-ever turn has nothing to read: no toast", () => {
    expect(turnRead([user(), reply(u(20_000, 0, 20_000))], 0)).toBeNull();
  });

  it("the first turn after a rewind resumes the live reply before it", () => {
    const events: SessionEvent[] = [
      ...prior,
      user("b"),
      reply(u(150_000, 100_000, 50_000)),
      { event: "rewind", to: 2, at },
      user("c"),
      reply(u(101_000, 10_000, 91_000)),
    ];
    expect(turnRead(events, 2)).toMatchObject({ context: 100_000, read: 10_000, rewound: true, chosen: false });
  });

  it("a miss he chose (a history edit, a setting that loses the cache) is not toasted", () => {
    const edited = turnRead([...prior, { event: "edit", target: 0, text: "x", at }, user(), reply(u(100_000, 0, 100_000))], 1)!;
    expect(edited.chosen).toBe(true);
    expect(missToastFor({ what: "turn", read: 0, context: 100_000, written: 100_000, costUsd: 1, est: null }, edited.chosen)).toBeNull();
    const switched = turnRead([...prior, user(), reply(u(100_000, 0, 100_000), { ...key, model: "opus" })], 1)!;
    expect(switched.chosen).toBe(true);
  });
});

describe("item 699: the toast's words", () => {
  it("says what missed, the tokens re-written, the CLI's cost and the plan share", () => {
    expect(
      missToast({ what: "ping", chat: "Value-Generalization", read: 0, context: 269_843, written: 269_843, costUsd: 4.32, est: { five_hour: 6.5, seven_day: 0.9 } }),
    ).toBe("Cache missed on the keep-warm ping in “Value-Generalization” (read 0%) — re-wrote 270k · ≈ $4.32 API · ≈ 6.5% of 5 h");
    expect(missToast({ what: "turn", read: 5_000, context: 100_000, written: 95_000, costUsd: 1.5, est: null })).toBe(
      "Cache missed on this turn (read 5%) — re-wrote 95k · ≈ $1.50 API",
    );
    expect(missToast({ what: "aside", read: 0, context: 50_000, written: 50_000, costUsd: null, est: { five_hour: null, seven_day: 0.3 } })).toBe(
      "Cache missed on this aside (read 0%) — re-wrote 50k · ≈ 0.3% of the week",
    );
  });
});

describe("item 699: the next send's estimate", () => {
  const rates = ratesFromWire({ model: "claude-fable-5-2", read: 0.2, write_1h: 16, write_5m: 10, source: "pings", pings: 12 })!;
  const last = u(250_000, 249_000, 1_000, 20_000);
  it("cold: the whole context written at the write rate", () => {
    expect(nextSendCost(last, rates).cold).toBeCloseTo((270_000 * 16) / 1e6, 9); // $4.32
    expect(nextLine(nextSendCost(last, rates).cold)).toBe("next ≈ $4.32");
  });
  it("warm: the history read back, the last reply's output written", () => {
    expect(nextSendCost(last, rates).warm).toBeCloseTo((250_000 * 0.2 + 20_000 * 16) / 1e6, 9); // $0.37
    expect(usd(nextSendCost(last, rates).warm)).toBe("$0.37");
  });
  it("the tooltip gives both prices and says it is an estimate, not a bill", () => {
    const t = nextTitle(last, rates, true);
    expect(t).toContain("≈ $0.37 while the cache is warm");
    expect(t).toContain("≈ $4.32 once it is cold");
    expect(t).toContain("not a bill");
    expect(t).toContain("12 keep-warm pings");
  });
  it("the API engine's price, a missing cache rate read as the input rate", () => {
    expect(ratesFromPrice({ input: 3, cache_read: null, cache_write: 3.75 })).toMatchObject({ read: 3, write: 3.75 });
  });
  it("the chip's line: warm and cold, and none without rates", () => {
    const events = [user(), reply(last)];
    expect(cacheEstimate(events, rates, true)?.line).toBe("next ≈ $0.37");
    expect(cacheEstimate(events, rates, false)?.line).toBe("next ≈ $4.32");
    expect(cacheEstimate(events, null, false)).toBeNull();
  });
});

describe("item 699: each event's toast", () => {
  const prior = [user(), reply(u(100_000, 99_000, 1_000))];
  it("a turn: the result's cost and plan share; a rewind says so", () => {
    expect(turnMissToast([...prior, user(), reply(u(101_000, 0, 101_000))], 1, 1.62, { five_hour: 2.4, seven_day: 0.3 })).toBe(
      "Cache missed on this turn (read 0%) — re-wrote 101k · ≈ $1.62 API · ≈ 2.4% of 5 h",
    );
    expect(turnMissToast([...prior, user(), reply(u(101_000, 99_000, 2_000))], 1, 0.1, null)).toBeNull();
  });
  it("a ping: 79% of its context toasts, 80% does not", () => {
    const p = { chat: "c1", sent_ms: 0, context: 100_000, cache_read: 79_000, cache_write: 21_000, cost_usd: 0.35, plan_est: null, model: "m" };
    expect(pingMissToast(p, "Notes")).toBe("Cache missed on the keep-warm ping in “Notes” (read 79%) — re-wrote 21k · ≈ $0.35 API");
    expect(pingMissToast({ ...p, cache_read: 80_000 }, "Notes")).toBeNull();
  });
});

describe("item 699 price fix (2026-11-16): the price shows wherever the cache does", () => {
  const rates = { read: 0.2, write: 16, from: "test" };
  it("the cold toast says what the next send now costs", () => {
    const evs = [user(), reply(u(269_343, 0, 269_343))];
    expect(coldToast(evs, rates)).toBe(
      "Prompt cache cold — edits to the history now cost nothing extra · the next send re-writes 270k ≈ $4.32 API",
    );
    // No rates (a harness, a failed read): the old words, never a guess.
    expect(coldToast(evs, null)).toBe("Prompt cache cold — edits to the history now cost nothing extra");
  });
  it("a one-rate fit's rates still give the chip a figure, and say where the ratio came from", () => {
    const r = ratesFromWire({
      model: "claude-fable-5-2",
      read: 0.2,
      write_1h: 16,
      write_5m: 10,
      source: "pings_ratio",
      pings: 2,
      ratio_from: "claude-fable-5-1",
    });
    expect(r).not.toBeNull();
    expect(r!.from).toContain("2 keep-warm pings on claude-fable-5-2");
    expect(r!.from).toContain("read : write ratio of claude-fable-5-1");
    const est = cacheEstimate([user(), reply(u(269_343, 0, 269_343))], r, false);
    expect(est?.line).toBe("next ≈ $4.32");
  });
});
