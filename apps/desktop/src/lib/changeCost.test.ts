import { describe, expect, it } from "vitest";
import { cacheLoss, type PendingSettings } from "./cache";
import type { ChipRates } from "./cacheCost";
import {
  LAYER_HEAD,
  SAFE_MODE_HEAD,
  changePrice,
  layerChangeSinceCache,
  modelIdFor,
  nextSendModel,
  pendingChangeCost,
  priceLine,
  priceTitle,
  switchDetail,
  type PriceIn,
} from "./changeCost";
import type { CacheKey, SessionEvent, Usage } from "./types";

// Item 777: the pending change priced on the "cache will be lost" bar.

const AT = "2026-11-16T23:40:00Z";
const FABLE: ChipRates = { read: 0.2, write: 16, from: "fit" };
const OPUS: ChipRates = { read: 0.5, write: 10, from: "row" };
// A 200k-token chat: 199,000 prompt, 1,000 output.
const usage: Usage = { input_tokens: 199_000, output_tokens: 1_000, cache_read_tokens: 198_000, cache_write_tokens: 1_000 };
const key = (k: Partial<CacheKey> = {}): CacheKey => ({
  engine: "claude-code",
  model: "fable",
  tools: true,
  safe_mode: false,
  ask: false,
  plan: false,
  ...k,
});
const pending = (p: Partial<PendingSettings> = {}): PendingSettings => ({
  engine: "claude-code",
  agentModel: "fable",
  tools: true,
  agentSafeMode: false,
  approval: true,
  agentAsk: false,
  agentPlan: false,
  ...p,
});
const base = (p: Partial<PriceIn>): PriceIn => ({
  usage,
  changes: [],
  layers: null,
  built: FABLE,
  target: FABLE,
  warm: true,
  engine: "claude-code",
  ...p,
});
const near = (a: number | null, b: number) => expect(a).toBeCloseTo(b, 6);
// Without the change: 199k read at $0.20 + 1k written at $16 = $0.0558.
const WARM = (199_000 * 0.2 + 1_000 * 16) / 1e6;

function reply(k: CacheKey | null): SessionEvent {
  return {
    event: "assistant_message",
    model: "claude-fable-5-2",
    blocks: [],
    stop_reason: "end_turn",
    usage,
    sent_at: AT,
    cache_ttl: "1h",
    ...(k ? { cache_key: k } : {}),
    at: AT,
  } as SessionEvent;
}
const layers = (off: string[], edits: Record<string, string> = {}): SessionEvent =>
  ({ event: "prompt_layers", off, edits, at: AT }) as SessionEvent;

describe("changePrice — each change kind", () => {
  it("a model switch re-writes everything at the new model's write rate", () => {
    const changes = cacheLoss(key(), pending({ agentModel: "claude-opus-5-5" }));
    const c = changePrice(base({ changes, target: OPUS }));
    expect(c.read).toBe(0);
    expect(c.rewrite).toBe(200_000);
    near(c.with, 2.0); // 200k × $10
    near(c.without, WARM);
    expect(priceLine(c)).toBe("next ≈ $2.00 (vs $0.06 warm)");
  });

  it("tools on/off re-writes everything (tools come first)", () => {
    const changes = cacheLoss(key(), pending({ tools: false }));
    const c = changePrice(base({ changes }));
    expect(c.read).toBe(0);
    near(c.with, 3.2); // 200k × $16
  });

  it("safe mode re-writes after the measured 31k head", () => {
    const changes = cacheLoss(key(), pending({ agentSafeMode: true }));
    const c = changePrice(base({ changes }));
    expect(c.read).toBe(SAFE_MODE_HEAD);
    expect(c.rewrite).toBe(200_000 - SAFE_MODE_HEAD);
    near(c.with, (SAFE_MODE_HEAD * 0.2 + (200_000 - SAFE_MODE_HEAD) * 16) / 1e6);
  });

  it("a prompt-layer change re-writes from the system block on, at the new size", () => {
    const c = changePrice(base({ layers: { text: "practices edited", addedTokens: 3_000 } }));
    expect(c.read).toBe(LAYER_HEAD);
    expect(c.rewrite).toBe(203_000 - LAYER_HEAD);
    near(c.with, (LAYER_HEAD * 0.2 + (203_000 - LAYER_HEAD) * 16) / 1e6);
  });

  it("a prompt-layer change on the API engine counts nothing read (tools size unknown)", () => {
    const c = changePrice(base({ layers: { text: "notes off", addedTokens: 0 }, engine: "api" }));
    expect(c.read).toBe(0);
  });

  it("thinking on the API engine re-writes everything", () => {
    const changes = cacheLoss(key({ engine: "api", model: "m", thinking: "default" }), pending({ engine: "provider", thinkingMode: "effort-high" }));
    expect(changes.map((c) => c.what)).toEqual(["thinking"]);
    expect(changePrice(base({ changes })).read).toBe(0);
  });

  it("effort on Claude Code is no change (measured to keep the cache, 408)", () => {
    expect(cacheLoss(key(), pending({ thinkingMode: "effort-high" }))).toEqual([]);
  });

  it("several at once: the earliest changed block wins — a whole change beats safe mode and layers", () => {
    const changes = cacheLoss(key(), pending({ agentModel: "claude-opus-5-5", agentSafeMode: true }));
    const c = changePrice(base({ changes, layers: { text: "notes off", addedTokens: 0 }, target: OPUS }));
    expect(c.read).toBe(0);
    near(c.with, 2.0);
  });

  it("safe mode and a layer: the layer's earlier head wins", () => {
    const changes = cacheLoss(key(), pending({ agentSafeMode: true }));
    expect(changePrice(base({ changes, layers: { text: "x", addedTokens: 0 } })).read).toBe(LAYER_HEAD);
  });

  it("a cold cache: the change costs nothing extra", () => {
    const changes = cacheLoss(key(), pending({ agentModel: "claude-opus-5-5" }));
    const c = changePrice(base({ changes, target: OPUS, warm: false }));
    expect(c.cold).toBe(true);
    expect(c.with).toBe(c.without);
    expect(priceLine(c)).toBe("no extra, cache cold · next ≈ $2.00");
  });

  it("no rates for the new model: the tokens, never a guessed price", () => {
    const changes = cacheLoss(key(), pending({ agentModel: "claude-new-9" }));
    const c = changePrice(base({ changes, target: null }));
    expect(c.with).toBeNull();
    expect(priceLine(c)).toBe("re-writes 200k · no price for the new model");
  });

  it("no rates for the built model: the price without the 'vs'", () => {
    const changes = cacheLoss(key(), pending({ tools: false }));
    expect(priceLine(changePrice(base({ changes, built: null })))).toBe("next ≈ $3.20");
  });

  it("the tooltip is one short line, numbers first", () => {
    const changes = cacheLoss(key(), pending({ agentSafeMode: true }));
    const t = priceTitle(changePrice(base({ changes })), FABLE);
    expect(t).toBe("169k re-written, 31k still read"); // item 776 rule at the merge: no rate, no caveat
    expect(t.split("\n")).toHaveLength(1);
  });
});

describe("layerChangeSinceCache", () => {
  const q: SessionEvent = { event: "user_message", text: "q", at: AT } as SessionEvent;

  it("names a layer switched off after the cache's reply", () => {
    const c = layerChangeSinceCache([q, reply(key()), layers(["project_notes"])]);
    expect(c?.text).toBe("project notes off");
  });

  it("change then restore is no change", () => {
    expect(layerChangeSinceCache([q, reply(key()), layers(["practices"]), layers([])])).toBeNull();
  });

  it("a change logged before the cache's reply is already in the cache", () => {
    expect(layerChangeSinceCache([q, layers(["practices"]), reply(key())])).toBeNull();
  });

  it("an edit replacing an edit counts its added tokens (~4 chars/token)", () => {
    const c = layerChangeSinceCache([
      layers([], { user_memory: "a".repeat(400) }),
      q,
      reply(key()),
      layers([], { user_memory: "a".repeat(4_400) }),
    ]);
    expect(c).toEqual({ text: "user memory edited", addedTokens: 1_000 });
  });

  it("a reply with no recorded key is not judged", () => {
    expect(layerChangeSinceCache([q, reply(null), layers(["practices"])])).toBeNull();
  });
});

describe("modelIdFor", () => {
  const seen = { fable: { id: "claude-fable-5-2", cliVersion: "2.1.325", seenAt: AT } };
  it("a full id is itself; an alias what it resolved to; else null", () => {
    expect(modelIdFor("claude-opus-5-5", {})).toBe("claude-opus-5-5");
    expect(modelIdFor("fable", seen as never)).toBe("claude-fable-5-2");
    expect(modelIdFor("haiku", seen as never)).toBeNull();
  });
});

describe("switchDetail — the model menu's price before he picks", () => {
  it("prices another model's row while warm", () => {
    expect(switchDetail(usage, "claude-fable-5-2", "claude-opus-5-5", OPUS, true)).toBe("next ≈ $2.00");
  });
  it("nothing on the cache's own model, or cold", () => {
    expect(switchDetail(usage, "claude-fable-5-2", "claude-fable-5-2", FABLE, true)).toBe("");
    expect(switchDetail(usage, "claude-fable-5-2", "claude-opus-5-5", OPUS, false)).toBe("");
  });
  it("tokens when the row's model has no rates", () => {
    expect(switchDetail(usage, "claude-fable-5-2", "claude-opus-5-5", null, true)).toBe("re-writes 200k");
  });
});

describe("pendingChangeCost — the one rule the bar and the rail share", () => {
  const q: SessionEvent = { event: "user_message", text: "q", at: AT } as SessionEvent;
  const rates = (m: string | null) => (m === "claude-opus-5-5" ? OPUS : m === "claude-fable-5-2" ? FABLE : null);
  const cc = { engine: "claude-code", model: "claude-fable-5-2" };
  it("a model switch: the new model's rates against the built one's", () => {
    const r = pendingChangeCost({ events: [q, reply(key())], draft: pending({ agentModel: "claude-opus-5-5" }), connection: cc, seen: {}, warm: true, rates });
    expect(r?.line).toBe("next ≈ $2.00 (vs $0.06 warm)");
  });
  it("an alias resolves through what it last ran as", () => {
    const seen = { opus: { id: "claude-opus-5-5", cliVersion: null, seenAt: AT } };
    const r = pendingChangeCost({ events: [q, reply(key())], draft: pending({ agentModel: "opus" }), connection: cc, seen: seen as never, warm: true, rates });
    expect(r?.price.with).toBeCloseTo(2.0, 6);
  });
  it("no change, or a cold cache: null", () => {
    expect(pendingChangeCost({ events: [q, reply(key())], draft: pending(), connection: cc, seen: {}, warm: true, rates })).toBeNull();
    expect(pendingChangeCost({ events: [q, reply(key())], draft: pending({ tools: false }), connection: cc, seen: {}, warm: false, rates })).toBeNull();
  });
  it("a layer change alone is priced", () => {
    const r = pendingChangeCost({ events: [q, reply(key()), layers(["practices"])], draft: pending(), connection: cc, seen: {}, warm: true, rates });
    expect(r?.price.read).toBe(LAYER_HEAD);
  });
});

describe("nextSendModel — the cold chip and the rail price the model the send goes to", () => {
  const q: SessionEvent = { event: "user_message", text: "q", at: AT } as SessionEvent;
  it("the draft's when it differs from what built the cache, else the reply's", () => {
    expect(nextSendModel([q, reply(key())], "claude-opus-5-5", {})).toBe("claude-opus-5-5");
    expect(nextSendModel([q, reply(key())], "fable", {})).toBe("claude-fable-5-2");
    expect(nextSendModel([q, reply(key())], "haiku", {})).toBeNull();
  });
});
