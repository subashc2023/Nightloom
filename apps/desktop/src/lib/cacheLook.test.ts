import { describe, expect, it } from "vitest";
import { cacheFrame, parseCacheLook, warmth } from "./cacheLook.svelte";
import type { CacheState } from "./cache";

const state = (remainingMs: number, ttl: "5m" | "1h" = "1h"): CacheState => ({
  sentAt: 0,
  ttl,
  warmUntil: remainingMs,
  remainingMs,
  warm: remainingMs > 0,
});

describe("item 596: the cache on the box's frame", () => {
  it("is the share of the lifetime left, clamped, and 0 once cold", () => {
    expect(warmth(state(60 * 60_000))).toBe(1);
    expect(warmth(state(30 * 60_000))).toBeCloseTo(0.5);
    expect(warmth(state(150_000, "5m"))).toBeCloseTo(0.5);
    expect(warmth(state(0))).toBe(0);
    expect(warmth(state(-5000))).toBe(0);
    expect(warmth(state(2 * 60 * 60_000))).toBe(1);
  });

  it("stamps warm or cold and the warmth; nothing without a timer", () => {
    expect(cacheFrame(null)).toBeNull();
    expect(cacheFrame(state(45 * 60_000))).toEqual({ cache: "warm", style: "--cache-w: 75%; --cache-wn: 0.75;" });
    expect(cacheFrame(state(-1))).toEqual({ cache: "cold", style: "--cache-w: 0%; --cache-wn: 0;" });
  });

  it("reads an unknown stored look as the default", () => {
    expect(parseCacheLook(null)).toBe("tint");
    expect(parseCacheLook("bogus")).toBe("tint");
    expect(parseCacheLook("edge")).toBe("edge");
  });

  it("keeps every rule off Classic and eases only without Reduce motion", async () => {
    const fs = (await import(/* @vite-ignore */ "node:" + "fs")) as { readFileSync(u: URL, enc: string): string };
    // Read from disk: vitest hands a `.css?raw` import back empty.
    const css = fs.readFileSync(new URL("../cacheLook.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const selectors = css.match(/^[^@{}\s][^{}]*\{/gm) ?? [];
    expect(selectors.length).toBeGreaterThan(0);
    for (const s of selectors) expect(s).toContain('html:not([data-layout="classic"])');
    const media = css.indexOf("@media (prefers-reduced-motion: no-preference)");
    expect(media).toBeGreaterThan(0);
    expect(css.slice(0, media)).not.toMatch(/transition|animation/);
    expect(css).not.toMatch(/animation|@keyframes/);
  });
});
