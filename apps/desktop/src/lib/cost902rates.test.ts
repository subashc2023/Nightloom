import { describe, expect, it, vi } from "vitest";

// Item 902: the edit line's cold price and the cold toast follow the pick.
vi.mock("./api", () => ({
  cacheRates: async (model: string) =>
    model === "claude-opus-5-5"
      ? { model, read: 0.2, write_1h: 8, write_5m: 5, source: "rates", pings: 0 }
      : model === "claude-fable-5-2"
        ? { model, read: 0.2, write_1h: 16, write_5m: 10, source: "pings_ratio", pings: 18, ratio_from: "claude-fable-5-1" }
        : null,
}));

import { coldUsdFor, loadCacheRates, nextSendRates } from "./cacheRates.svelte";
import { coldToast } from "./cacheCost";
import type { SessionEvent } from "./types";

const AT = "2026-11-23T20:00:00Z";
const events = [
  { event: "user_message", text: "q", at: AT },
  {
    event: "assistant_message",
    model: "claude-opus-5-5",
    blocks: [],
    stop_reason: "end_turn",
    usage: { input_tokens: 243_000, output_tokens: 1_000 },
    sent_at: AT,
    at: AT,
  },
] as SessionEvent[];
const cc = { engine: "claude-code" };
const seen = {};

describe("item 902 — edit line and cold toast at the picked model", () => {
  it("$1.95 on Opus 5.5; $3.90 once Fable 5.2 is picked", async () => {
    await loadCacheRates("claude-opus-5-5");
    await loadCacheRates("claude-fable-5-2");
    expect(coldUsdFor(events, cc)).toBeCloseTo(1.952, 6);
    expect(coldUsdFor(events, cc, { draftModel: "", seen })).toBeCloseTo(1.952, 6);
    expect(coldUsdFor(events, cc, { draftModel: "claude-fable-5-2", seen })).toBeCloseTo(3.904, 6);
    expect(coldToast(events, nextSendRates(events, cc, { draftModel: "claude-fable-5-2", seen }))).toContain("re-writes 244k ≈ $3.90 API");
  });
});
