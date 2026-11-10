import { describe, expect, it } from "vitest";
import remoteSrc from "./Remote.svelte?raw";
import { cacheLeft, contextLine, kTokens, loadLook, LOOK_KEY, saveLook } from "./look";
import type { SessionEvent } from "../lib/types";

function store(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    m,
  };
}

describe("the phone's look (item 572)", () => {
  it("is Filament IV unless Classic was chosen on this phone", () => {
    expect(loadLook(store())).toBe("filament");
    expect(loadLook(store({ [LOOK_KEY]: "classic" }))).toBe("classic");
    expect(loadLook(store({ [LOOK_KEY]: "junk" }))).toBe("filament");
    expect(loadLook(null)).toBe("filament");
  });
  it("keeps Classic and forgets the key for the default", () => {
    const s = store();
    saveLook("classic", s);
    expect(s.m.get(LOOK_KEY)).toBe("classic");
    saveLook("filament", s);
    expect(s.m.has(LOOK_KEY)).toBe(false);
  });
  it("survives a storage that throws", () => {
    const bad = { getItem: () => { throw new Error("no"); }, setItem: () => { throw new Error("no"); }, removeItem: () => { throw new Error("no"); } };
    expect(loadLook(bad)).toBe("filament");
    expect(() => saveLook("classic", bad)).not.toThrow();
  });
});

describe("the header's context line", () => {
  const ev = (o: object) => o as unknown as SessionEvent;
  const sent = "2026-11-10T12:00:00.000Z";
  const events = [
    ev({ event: "user_message", text: "hi", at: sent }),
    ev({ event: "assistant_message", at: sent, blocks: [], usage: { input_tokens: 1000, output_tokens: 10 } }),
    ev({ event: "user_message", text: "again", at: sent }),
    ev({ event: "assistant_message", at: sent, blocks: [], sent_at: sent, cache_ttl: "5m", usage: { input_tokens: 211400, output_tokens: 620 } }),
  ];
  it("reads the newest reply's input plus output, and the cache clock", () => {
    const c = contextLine(events, events.map(() => true));
    expect(c.used).toBe(212020);
    expect(c.warmUntil).toBe(Date.parse(sent) + 5 * 60_000);
  });
  it("skips a rewound reply and one with no usage", () => {
    const c = contextLine(events, [true, true, true, false]);
    expect(c.used).toBe(1010);
    expect(c.warmUntil).toBeNull();
    expect(contextLine([ev({ event: "assistant_message", at: sent, blocks: [] })], [true]).used).toBeNull();
  });
  it("words tokens and time left as the mockup does", () => {
    expect(kTokens(212020)).toBe("212k");
    expect(kTokens(1_000_000)).toBe("1M");
    expect(kTokens(950)).toBe("950");
    const t = Date.parse(sent);
    expect(cacheLeft(t + 250_500, t)).toBe("4:10");
    expect(cacheLeft(t, t)).toBeNull();
    expect(cacheLeft(null, t)).toBeNull();
    expect(cacheLeft(t + 40 * 60_000, t)).toBe("40 min");
  });
});

describe("Classic is untouched (item 542's rule)", () => {
  const src = remoteSrc;
  const style = src.slice(src.lastIndexOf("<style>"));
  const block = style.slice(style.indexOf("==== Filament IV on the phone"));
  it("gates every rule on a class the page had before behind the layout", () => {
    // Classes Filament IV added (drawn only when `fil`) need no gate; every
    // other selector in the block must carry it.
    const added = /^\s*(\.st\.run|\.hdr-dial|\.ctx-|\.reply-head|\.rh-|\.tools\.t4run|\.model-btn|\.aside-btn|\.hello4|\.h4-|button\.h4-|@media|@keyframes|to\b|\.rh-ring|:global\(:root)/;
    const selectors = [...block.matchAll(/^\s{2}([^\s{}@/*][^{]*)\{/gm)].map((m) => m[1].trim());
    expect(selectors.length).toBeGreaterThan(40);
    for (const sel of selectors) {
      if (added.test(sel)) continue;
      for (const part of sel.split(",")) expect(part.trim(), sel).toMatch(/^:global\(:where\(:root:not\(\[data-layout="classic"\]\)\)\)/);
    }
  });
  it("keeps the Filament tokens off Classic", () => {
    expect(block).toContain(':global(:root:not([data-layout="classic"]):not([data-scheme="light"]):not([data-palette]))');
  });
});
