import { describe, expect, it } from "vitest";
import { cacheEstimate, type ChipRates } from "./cacheCost";
import { modelSwitchPending, nextSendModel } from "./changeCost";
import { chipCosts, coldButtons, coldTitle, warmDetail, warmTitle } from "./warmWrap";
import type { CacheKey, SessionEvent, Usage } from "./types";

// Item 902 (his bug, 2026-11-23): a cold 244k chat built on Opus 5.5; he
// picks Fable 5.2 and every figure must re-price to Fable 5.2's rates.
// Rates per MTok, 1-hour write = 2 × input: Opus 5.5 $4 in → write $8,
// read $0.20; Fable 5.2 $8 in → write $16, read $0.20.
const AT = "2026-11-23T20:00:00Z";
const OPUS55: ChipRates = { read: 0.2, write: 8, from: "row" };
const FABLE52: ChipRates = { read: 0.2, write: 16, from: "row" };
const usage: Usage = { input_tokens: 243_000, output_tokens: 1_000, cache_read_tokens: 242_000, cache_write_tokens: 1_000 };
const key: CacheKey = { engine: "claude-code", model: "", tools: true, safe_mode: false, ask: false, plan: false };
const q = { event: "user_message", text: "q", at: AT } as SessionEvent;
const reply = {
  event: "assistant_message",
  model: "claude-opus-5-5",
  blocks: [],
  stop_reason: "end_turn",
  usage,
  sent_at: AT,
  cache_ttl: "1h",
  cache_key: key,
  at: AT,
} as SessionEvent;
const events = [q, reply];
const seen = { "": { id: "claude-opus-5-5", cliVersion: null, seenAt: AT } };
const rates = (m: string | null) => (m === "claude-opus-5-5" ? OPUS55 : m === "claude-fable-5-2" ? FABLE52 : null);

describe("item 902 — the figures follow the model the next send goes to", () => {
  it("names the switch: another model, not the same model by another name", () => {
    expect(modelSwitchPending(events, "claude-fable-5-2", seen)).toBe(true);
    expect(modelSwitchPending(events, "", seen)).toBe(false);
    expect(modelSwitchPending(events, "claude-opus-5-5", seen)).toBe(false);
    expect(modelSwitchPending(events, "claude-opus-5-5[1m]", seen)).toBe(false);
    // An alias not resolved yet: a switch with no rates, never the old price.
    expect(modelSwitchPending(events, "haiku", seen)).toBe(true);
  });

  it("the cold banner's buttons: $1.95 on Opus 5.5, $3.90 once Fable 5.2 is picked", () => {
    const before = coldButtons(chipCosts(usage, rates(nextSendModel(events, "", seen)), false));
    expect(before).toEqual({ handoff: "Hand off (≈ $1.95)", keep: "Keep (re-writes 244k ≈ $1.95)" });
    const to = nextSendModel(events, "claude-fable-5-2", seen);
    expect(to).toBe("claude-fable-5-2");
    const after = coldButtons(chipCosts(usage, rates(to), true));
    expect(after).toEqual({ handoff: "Hand off (≈ $3.90)", keep: "Keep (re-writes 244k ≈ $3.90)" });
  });

  it("a model with no rates shows no figure, not the old model's", () => {
    const to = nextSendModel(events, "haiku", seen);
    expect(coldButtons(chipCosts(usage, rates(to), true))).toEqual({ handoff: "Hand off", keep: "Keep" });
  });

  it("the banner says the new model has no cache of it", () => {
    expect(coldTitle(244_000)).toBe("Cache cold — this chat is 244k");
    expect(coldTitle(244_000, "Fable 5.2")).toBe("Cache cold — this chat is 244k · Fable 5.2 has no cache of it");
    expect(warmTitle(4 * 60_000, 244_000, "Fable 5.2")).toBe("Cache cold in 4 min — this chat is 244k · Fable 5.2 has no cache of it");
  });

  it("warm, a switch writes everything: the wrap-up now costs the cold price", () => {
    // Opus 5.5 warm: 243k read at $0.20 + 1k written at $8 = $0.0566.
    expect(warmDetail(chipCosts(usage, OPUS55, false))).toBe("wrap up now ≈ $0.06 · after it lapses ≈ $1.95");
    expect(warmDetail(chipCosts(usage, FABLE52, true))).toBe("wrap up now ≈ $3.90 · after it lapses ≈ $3.90");
  });

  it("the chip: cold ≈ $1.95 → $3.90; warm with a switch prices the full write", () => {
    expect(cacheEstimate(events, OPUS55, false)?.line).toBe("next ≈ $1.95");
    expect(cacheEstimate(events, FABLE52, false)?.line).toBe("next ≈ $3.90");
    // The composer passes warm && !switch.
    expect(cacheEstimate(events, FABLE52, true && !modelSwitchPending(events, "claude-fable-5-2", seen))?.line).toBe("next ≈ $3.90");
  });

  it("his chat: the newest reply (2026-10-07) has no cache key — the pick still re-prices", () => {
    const old = { ...(reply as object), cache_key: undefined } as SessionEvent;
    const ev = [q, old];
    expect(nextSendModel(ev, "claude-fable-5-2", seen)).toBe("claude-fable-5-2");
    expect(modelSwitchPending(ev, "claude-fable-5-2", seen)).toBe(true);
    expect(cacheEstimate(ev, rates(nextSendModel(ev, "claude-fable-5-2", seen)), false)?.line).toBe("next ≈ $3.90");
    // The default pick, resolved or not, is the reply's model.
    expect(nextSendModel(ev, "", seen)).toBe("claude-opus-5-5");
    expect(nextSendModel(ev, "", {})).toBe("claude-opus-5-5");
    expect(modelSwitchPending(ev, "", {})).toBe(false);
    // An unresolved alias: no rates, so no figure.
    expect(nextSendModel(ev, "haiku", seen)).toBeNull();
  });
});
