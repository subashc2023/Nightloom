import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXACT_DELAY_MS, exactCounter, wantsExactCount, type ExactResult } from "./draftCount";
import { EXACT_TOKENS_FROM, draftExact, draftExactTitle, draftEstimateTitle } from "./tokens";

// Nightshift backlog 155, second half: the exact count's hook-up and threshold.
// The counter is a fake; no real API is called.

const api = { engine: "provider", provider: "anthropic", model: "claude-sonnet-5" };
const long = "x".repeat(EXACT_TOKENS_FROM * 4);
const short = "x".repeat(EXACT_TOKENS_FROM * 4 - 4);

describe("wantsExactCount", () => {
  it("asks from ~500 estimated tokens on the provider engine", () => {
    expect(wantsExactCount(long, api)).toBe(true);
    expect(wantsExactCount(short, api)).toBe(false);
  });
  it("never on the Claude Code engine, however long", () => {
    expect(wantsExactCount(long + long, { ...api, engine: "claude-code" })).toBe(false);
  });
  it("not before a connection exists", () => {
    expect(wantsExactCount(long, { engine: undefined, provider: undefined, model: undefined })).toBe(false);
  });
});

describe("exactCounter", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(answer: (text: string) => Promise<number | null> = async () => 777) {
    const count = vi.fn((_p: string, _m: string | undefined, text: string) => answer(text));
    const results: (ExactResult | null)[] = [];
    const c = exactCounter(count, (r) => results.push(r));
    return { count, results, c };
  }

  it("counts once after a pause, not per keystroke", async () => {
    const { count, results, c } = setup();
    for (let i = 0; i < 20; i++) {
      c.update(long + "y".repeat(i), api);
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(count).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(EXACT_DELAY_MS);
    expect(count).toHaveBeenCalledTimes(1);
    expect(count).toHaveBeenCalledWith("anthropic", "claude-sonnet-5", long + "y".repeat(19));
    expect(results.at(-1)).toEqual({ text: long + "y".repeat(19), tokens: 777, model: "claude-sonnet-5" });
  });

  it("lands within a second of the pause (delay under 1000 ms)", () => {
    expect(EXACT_DELAY_MS).toBeLessThan(1000);
  });

  it("does not ask under the threshold or on the Claude Code engine, and clears a stale figure", async () => {
    const { count, results, c } = setup();
    c.update(short, api);
    c.update(long, { ...api, engine: "claude-code" });
    await vi.advanceTimersByTimeAsync(EXACT_DELAY_MS * 3);
    expect(count).not.toHaveBeenCalled();
    expect(results).toEqual([null, null]);
  });

  it("drops an answer that arrives after the text changed", async () => {
    let release!: (n: number) => void;
    const { results, c } = setup(() => new Promise((r) => (release = r)));
    c.update(long, api);
    await vi.advanceTimersByTimeAsync(EXACT_DELAY_MS);
    c.update(long + "more", api); // typing resumed while the request was out
    release(500);
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toEqual([]);
  });

  it("a failed count leaves the estimate standing", async () => {
    const { results, c } = setup(() => Promise.reject(new Error("no key")));
    c.update(long, api);
    await vi.advanceTimersByTimeAsync(EXACT_DELAY_MS);
    expect(results.at(-1)).toEqual({ text: long, tokens: null, model: "claude-sonnet-5" });
  });

  it("dispose cancels a pending count", async () => {
    const { count, c } = setup();
    c.update(long, api);
    c.dispose();
    await vi.advanceTimersByTimeAsync(EXACT_DELAY_MS * 2);
    expect(count).not.toHaveBeenCalled();
  });
});

describe("the figure and its hover", () => {
  it("an exact figure has no ~ and says exact", () => {
    expect(draftExact(1240)).toEqual({ tokens: 1240, long: "1,240 tokens", short: "1.2k" });
    expect(draftExactTitle(1240, "claude-sonnet-5")).toMatch(/exact/);
  });
  it("an estimate's hover can say why it is not exact", () => {
    const t = draftEstimateTitle(1240, "The Claude Code engine has no count endpoint, so it stays an estimate.");
    expect(t).toMatch(/estimate/);
    expect(t).toMatch(/no count endpoint/);
  });
});
