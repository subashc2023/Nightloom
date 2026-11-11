import { describe, expect, it } from "vitest";
import {
  cacheBuiltWith,
  canRestore,
  kindAtCache,
  restoreEngine,
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

  // ~~"warns of nothing off the Claude Code engine (not measured, blocker
  // 1517)"~~ — superseded by item 601, 2026-11-10: an engine switch is
  // named either way, and the API engine compares its model.
});

// Item 601: one test per setting that changes (or was checked not to
// change) the cached prompt.
describe("cacheLoss, every setting (item 601)", () => {
  const api = (k: Partial<CacheKey> = {}) => key({ engine: "api", model: "claude-opus-5-5", ...k });

  it("names an engine switch from Claude Code to the API, alone", () => {
    expect(cacheLoss(key(), pending({ engine: "provider", agentModel: "opus" }))).toEqual([
      { what: "engine", text: "engine Claude Code → API", whole: true },
    ]);
  });

  it("names an engine switch from the API to Claude Code", () => {
    expect(cacheLoss(api(), pending())).toEqual([{ what: "engine", text: "engine API → Claude Code", whole: true }]);
  });

  it("on the API engine names a model change, read from the connection", () => {
    expect(cacheLoss(api(), pending({ engine: "provider" }), { apiModel: "claude-haiku-5-5" })).toEqual([
      { what: "model", text: "model claude-opus-5-5 → claude-haiku-5-5", whole: true },
    ]);
    expect(cacheLoss(api(), pending({ engine: "provider" }), { apiModel: "claude-opus-5-5" })).toEqual([]);
    // No connection yet: nothing to compare, nothing guessed.
    expect(cacheLoss(api(), pending({ engine: "provider" }))).toEqual([]);
  });

  it("names a Chat switched to Claude Code (its tools now declared), not restorable", () => {
    expect(cacheLoss(key(), pending(), { builtKind: "chat", kind: "build" })).toEqual([
      { what: "kind", text: "Chat → Claude Code", whole: true, restorable: false },
    ]);
    // Claude Code → Chat keeps the declaration, so the cache (backlog 144).
    expect(cacheLoss(key(), pending(), { builtKind: "build", kind: "build" })).toEqual([]);
    expect(cacheLoss(key(), pending(), { builtKind: "chat", kind: "chat" })).toEqual([]);
  });

  it("checks the browser, connectors, fork mode and effort and finds them kept (measured, 408)", () => {
    // None of these is a PendingSettings field the compare reads: adding
    // them to the draft leaves the answer empty.
    const d = { ...pending(), agentChrome: true, agentClaudeAi: true, agentForkMode: true, agentEffort: "max" };
    expect(cacheLoss(key(), d)).toEqual([]);
  });
});

describe("the chip with an unrestorable change (item 601)", () => {
  it("says what cannot go back, and that nothing is left to click when that is all", () => {
    const kind = cacheLoss(key(), pending(), { builtKind: "chat", kind: "build" });
    expect(canRestore(kind)).toBe(false);
    expect(cacheLossTitle(kind, 1000, 120_001 + 60_000)).toContain("Nothing to click");
    expect(cacheLossTitle(kind, 1000, 180_000)).toContain("cannot be put back");
    const both = cacheLoss(key(), pending({ tools: false }), { builtKind: "chat", kind: "build" });
    expect(canRestore(both)).toBe(true);
    expect(cacheLossTitle(both, 1000, 180_000)).toContain("Click to put it back");
  });

  it("restores the engine through the caller and the API model through the draft", () => {
    const d = pending({ engine: "provider" });
    const eng = cacheLoss(key(), d);
    expect(restoreEngine(key(), eng)).toBe("claude-code");
    restoreCacheSettings(key(), eng, d);
    expect(d.engine).toBe("provider"); // left to useEngine
    const k = key({ engine: "api", model: "claude-opus-5-5" });
    expect(restoreEngine(k, cacheLoss(k, pending()))).toBe("provider");
    const p = pending({ engine: "provider", model: "" });
    const m = cacheLoss(k, p, { apiModel: "claude-haiku-5-5" });
    expect(restoreEngine(k, m)).toBeNull();
    restoreCacheSettings(k, m, p);
    expect(p.model).toBe("claude-opus-5-5");
    expect(p.agentModel).toBe("haiku");
  });
});

describe("kindAtCache (item 601)", () => {
  it("reads the declared kind the cache's reply was built under", () => {
    const born = (kind: "chat" | "build"): SessionEvent => ({ event: "session_created", id: "s", at: AT, kind });
    const events: SessionEvent[] = [born("chat"), { event: "user_message", text: "q", at: AT }, reply(key())];
    expect(kindAtCache(events)).toBe("chat");
    const switched = [...events, { event: "kind", kind: "build", at: AT } as SessionEvent];
    expect(kindAtCache(switched)).toBe("chat");
    expect(kindAtCache([born("build"), reply(key())])).toBe("build");
    expect(kindAtCache([born("chat"), reply(null)])).toBeNull();
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

describe("cacheLoss, the API engine's Tools and thinking (item 635)", () => {
  const api = (k: Partial<CacheKey> = {}) =>
    key({ engine: "api", model: "claude-opus-5-5", tools_switch: true, thinking: "default", ...k });
  const onApi = (p: Partial<PendingSettings> = {}) =>
    pending({ engine: "provider", thinkingMode: "default", budget: 8000, ...p });

  it("names the Tools switch turned off or on", () => {
    expect(cacheLoss(api(), onApi({ tools: false }))).toEqual([{ what: "tools", text: "tools off", whole: true }]);
    expect(cacheLoss(api({ tools_switch: false }), onApi())).toEqual([{ what: "tools", text: "tools on", whole: true }]);
    expect(cacheLoss(api(), onApi())).toEqual([]);
  });

  it("names a thinking change, in words", () => {
    expect(cacheLoss(api(), onApi({ thinkingMode: "effort-high" }))).toEqual([
      { what: "thinking", text: "thinking default → high effort", whole: true },
    ]);
    expect(cacheLoss(api({ thinking: "budget=8000" }), onApi({ thinkingMode: "budget", budget: 4000 }))[0].text).toBe(
      "thinking budget 8000 → budget 4000",
    );
    expect(cacheLoss(api({ thinking: "budget=8000" }), onApi({ thinkingMode: "budget", budget: 8000 }))).toEqual([]);
  });

  it("names both, beside a model change", () => {
    const got = cacheLoss(api(), onApi({ tools: false, thinkingMode: "effort-low" }), { apiModel: "claude-haiku-5-5" });
    expect(got.map((c) => c.what)).toEqual(["model"]);
    const both = cacheLoss(api(), onApi({ tools: false, thinkingMode: "effort-low" }));
    expect(both.map((c) => c.text)).toEqual(["tools off", "thinking default → low effort"]);
    expect(cacheLossLine(both)).toBe("cache will be lost · tools off, thinking default → low effort");
  });

  it("warns of neither on a key logged before the fields", () => {
    const old = key({ engine: "api", model: "claude-opus-5-5" });
    expect(cacheLoss(old, onApi({ tools: false, thinkingMode: "effort-high" }))).toEqual([]);
  });

  it("does not compare thinking when the draft carries none", () => {
    expect(cacheLoss(api({ thinking: "effort=high" }), pending({ engine: "provider" }))).toEqual([]);
  });

  it("puts both back with the chip", () => {
    const k = api({ tools_switch: true, thinking: "budget=12000" });
    const d = onApi({ tools: false, thinkingMode: "effort-high" });
    restoreCacheSettings(k, cacheLoss(k, d), d);
    expect(d).toMatchObject({ tools: true, thinkingMode: "budget", budget: 12000 });
    expect(cacheLoss(k, d)).toEqual([]);
    const e = api({ thinking: "effort=medium" });
    const d2 = onApi({ thinkingMode: "default" });
    restoreCacheSettings(e, cacheLoss(e, d2), d2);
    expect(d2.thinkingMode).toBe("effort-medium");
  });
});
