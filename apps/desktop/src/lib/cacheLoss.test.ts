import { describe, expect, it } from "vitest";
import {
  cacheBuiltWith,
  cacheLoss,
  cacheLossLine,
  cacheLossTitle,
  restoreCacheSettings,
  type PendingSettings,
} from "./cache";
import type { CacheKey, SessionEvent } from "./types";

// Backlog 408: the compare between what built the cache and the rail's
// pending settings, and the restore that puts them back.

const AT = "2026-10-24T18:00:00Z";
const key = (k: Partial<CacheKey> = {}): CacheKey => ({
  engine: "claude-code",
  model: "haiku",
  tools: true,
  safe_mode: false,
  ask: false,
  plan: false,
  ...k,
});
const pending = (p: Partial<PendingSettings> = {}): PendingSettings => ({
  engine: "claude-code",
  agentModel: "haiku",
  tools: true,
  agentSafeMode: false,
  approval: true,
  agentAsk: false,
  agentPlan: false,
  ...p,
});
function reply(k: CacheKey | null, read = 30_000, write = 8_395): SessionEvent {
  return {
    event: "assistant_message",
    model: "claude-haiku-5-5",
    blocks: [],
    stop_reason: "end_turn",
    usage: { input_tokens: read + write + 2, output_tokens: 3, cache_read_tokens: read, cache_write_tokens: write },
    sent_at: AT,
    cache_ttl: "5m",
    ...(k ? { cache_key: k } : {}),
    at: AT,
  };
}

describe("cacheBuiltWith", () => {
  it("reads the newest reply's settings and its cached prefix", () => {
    const events: SessionEvent[] = [{ event: "user_message", text: "q", at: AT }, reply(key({ model: "opus" }))];
    expect(cacheBuiltWith(events)).toEqual({ key: key({ model: "opus" }), cachedTokens: 38_395 });
  });

  it("is null for a reply logged without them — no guess", () => {
    const events: SessionEvent[] = [
      { event: "user_message", text: "q", at: AT },
      reply(key()),
      { event: "user_message", text: "q2", at: AT },
      reply(null),
    ];
    expect(cacheBuiltWith(events)).toBeNull();
  });

  it("skips a rewound reply for the live one before it", () => {
    const events: SessionEvent[] = [
      { event: "user_message", text: "q", at: AT },
      reply(key({ model: "sonnet" })),
      { event: "user_message", text: "q2", at: AT },
      reply(key({ model: "opus" })),
      { event: "rewind", to: 2, at: AT },
    ];
    expect(cacheBuiltWith(events)?.key.model).toBe("sonnet");
  });
});

describe("cacheLoss", () => {
  it("is empty when nothing measured changed — effort, Chrome and the like are not compared", () => {
    expect(cacheLoss(key(), pending())).toEqual([]);
  });

  it("names a model change, the CLI default included", () => {
    expect(cacheLoss(key(), pending({ agentModel: "opus" }))).toEqual([
      { what: "model", text: "model haiku → opus", whole: true },
    ]);
    expect(cacheLoss(key({ model: undefined }), pending({ agentModel: " " }))).toEqual([]);
    expect(cacheLoss(key({ model: undefined }), pending({ agentModel: "sonnet" }))[0].text).toBe(
      "model default → sonnet",
    );
  });

  it("names tools and safe mode, safe mode as a partial loss", () => {
    expect(cacheLoss(key(), pending({ tools: false, agentSafeMode: true }))).toEqual([
      { what: "tools", text: "tools off", whole: true },
      { what: "safe mode", text: "safe mode on", whole: false },
    ]);
  });

  it("names the Plan position on Haiku only (measured: it runs on Sonnet there; on Opus it kept)", () => {
    expect(cacheLoss(key(), pending({ agentAsk: true, agentPlan: true }))).toEqual([
      { what: "plan", text: "plan mode on", whole: true },
    ]);
    expect(cacheLoss(key({ model: "opus" }), pending({ agentModel: "opus", agentAsk: true, agentPlan: true }))).toEqual(
      [],
    );
    // Plan with approval off is the Off position, not Plan.
    expect(cacheLoss(key(), pending({ approval: false, agentPlan: true }))).toEqual([]);
  });

  it("warns of nothing off the Claude Code engine (not measured, blocker 1517)", () => {
    expect(cacheLoss(key(), pending({ engine: "provider", agentModel: "opus" }))).toEqual([]);
    expect(cacheLoss(key({ engine: "provider" }), pending({ agentModel: "opus" }))).toEqual([]);
  });
});

describe("the chip's words", () => {
  it("reads `cache will be lost · <what changed>`, the tooltip the cost", () => {
    const changes = cacheLoss(key(), pending({ agentModel: "opus", tools: false }));
    expect(cacheLossLine(changes)).toBe("cache will be lost · model haiku → opus, tools off");
    const title = cacheLossTitle(changes, 38_395, 4 * 60_000 + 5_000);
    expect(title).toContain("re-sends the 38,395 tokens");
    expect(title).toContain("Click to put them back (the cache is warm for 4 min)");
    expect(cacheLossTitle(cacheLoss(key(), pending({ agentSafeMode: true })), 38_395, 60_000)).toContain(
      "up to 38,395",
    );
  });
});

describe("restoreCacheSettings", () => {
  it("puts every changed setting back and nothing else", () => {
    const d = pending({ agentModel: "opus", tools: false, agentSafeMode: true });
    const k = key();
    restoreCacheSettings(k, cacheLoss(k, d), d);
    expect(d).toEqual(pending());
    expect(cacheLoss(k, d)).toEqual([]);
  });

  it("restores the CLI default model as the empty pick", () => {
    const d = pending({ agentModel: "opus" });
    const k = key({ model: undefined });
    restoreCacheSettings(k, cacheLoss(k, d), d);
    expect(d.agentModel).toBe("");
  });

  it("brings Plan back whole, and leaves it to the position the cache was built on", () => {
    const on = pending({ approval: false });
    const planKey = key({ ask: true, plan: true });
    restoreCacheSettings(planKey, cacheLoss(planKey, on), on);
    expect(on).toMatchObject({ approval: true, agentAsk: true, agentPlan: true });

    const off = pending({ agentAsk: true, agentPlan: true });
    const askKey = key({ ask: true });
    restoreCacheSettings(askKey, cacheLoss(askKey, off), off);
    expect(off).toMatchObject({ approval: true, agentAsk: true, agentPlan: false });
    expect(cacheLoss(askKey, off)).toEqual([]);
  });
});
